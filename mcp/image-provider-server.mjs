import { resolve } from 'node:path';
import { Readable } from 'node:stream';

import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import {
  IMAGE_PROVIDERS,
  IdeogramClient,
  buildLeonardoProxyRequest,
  imageProviderFromEndpointPath,
} from './image-provider-core.mjs';

const MAX_TOOL_TEXT = 200_000;
const MAX_PROXY_BODY_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function toolText(value) {
  const text =
    typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length <= MAX_TOOL_TEXT) return text;
  return `${text.slice(0, MAX_TOOL_TEXT)}\n...[truncated by image-provider-mcp]`;
}

function textResult(value, extra = {}) {
  return {
    content: [{ type: 'text', text: toolText(value) }],
    ...extra,
  };
}

function errorResult(providerId, error) {
  const message = error instanceof Error ? error.message : String(error);
  return textResult(
    `${IMAGE_PROVIDERS[providerId].name} MCP error: ${message}`,
    { isError: true },
  );
}

function ideogramClientFromEnv() {
  return new IdeogramClient({
    apiKey: process.env.IDEOGRAM_API_KEY || '',
  });
}

async function fetchImageBlock(url, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') return null;

  const parsed = new URL(String(url || ''));
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  const response = await fetchImpl(parsed.toString(), {
    method: 'GET',
    headers: { accept: 'image/*' },
    redirect: 'follow',
  });
  if (!response.ok) return null;

  const mimeType = String(
    response.headers?.get?.('content-type') || 'image/png',
  )
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (!mimeType.startsWith('image/')) return null;

  const declaredLength = Number(response.headers?.get?.('content-length') || 0);
  if (declaredLength > MAX_IMAGE_BYTES) return null;

  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;

  return {
    type: 'image',
    data: bytes.toString('base64'),
    mimeType,
  };
}

export function buildIdeogramMcpServer({
  getClient = ideogramClientFromEnv,
  fetchImpl = globalThis.fetch,
} = {}) {
  const server = new McpServer({
    name: 'ideogram-image-provider',
    version: '0.1.0',
  });

  server.registerTool(
    'ideogram_status',
    {
      description:
        'Check whether the private Ideogram API bridge is configured. Never returns the API key.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return textResult(getClient().status());
      } catch (error) {
        return errorResult('ideogram', error);
      }
    },
  );

  server.registerTool(
    'ideogram_generate',
    {
      description:
        'Generate an image with Ideogram v4 using the server-side API key. Returns provider metadata, image URL, and an inline image when the generated asset can be fetched safely.',
      inputSchema: z.object({
        prompt: z.string().min(1).max(50_000),
        resolution: z.string().min(3).max(50).optional(),
        renderingSpeed: z
          .enum(['TURBO', 'DEFAULT', 'QUALITY'])
          .optional(),
        negativePrompt: z.string().max(50_000).optional(),
        seed: z.number().int().min(0).max(2_147_483_647).optional(),
      }),
    },
    async (args) => {
      try {
        const result = await getClient().generate(args);
        const content = [{ type: 'text', text: toolText(result) }];
        const firstUrl = result?.images?.[0]?.url;
        if (firstUrl) {
          try {
            const image = await fetchImageBlock(firstUrl, fetchImpl);
            if (image) content.push(image);
          } catch {
            // Keep the generation result usable through its URL.
          }
        }
        return { content };
      } catch (error) {
        return errorResult('ideogram', error);
      }
    },
  );

  return server;
}

export function createIdeogramNodeHandler(options = {}) {
  const handler = createMcpHandler(
    () => buildIdeogramMcpServer(options),
    {
      onerror: (error) => {
        console.error('[image-provider-mcp:ideogram]', error.message);
      },
    },
  );
  return toNodeHandler(handler);
}

function readProxyBody(req, maxBytes = MAX_PROXY_BODY_BYTES) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        rejectBody(new Error('MCP request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', rejectBody);
  });
}

const LEONARDO_RESPONSE_HEADERS = new Set([
  'content-type',
  'cache-control',
  'mcp-session-id',
  'retry-after',
]);

export async function proxyLeonardoMcpRequest(
  req,
  res,
  {
    apiKey = process.env.LEONARDO_API_KEY || '',
    fetchImpl = globalThis.fetch,
  } = {},
) {
  try {
    const method = String(req.method || 'POST').toUpperCase();
    const body =
      method === 'GET' || method === 'HEAD'
        ? undefined
        : await readProxyBody(req);

    const proxy = buildLeonardoProxyRequest({
      requestUrl: req.url || '/leonardo/mcp',
      method,
      headers: req.headers || {},
      body,
      apiKey,
    });

    const upstream = await fetchImpl(proxy.url, proxy.init);
    res.statusCode = upstream.status;
    if (upstream.statusText) res.statusMessage = upstream.statusText;

    for (const [name, value] of upstream.headers || []) {
      const lower = String(name).toLowerCase();
      if (LEONARDO_RESPONSE_HEADERS.has(lower)) {
        res.setHeader(lower, value);
      }
    }

    if (method === 'HEAD' || !upstream.body) {
      res.end();
      return;
    }

    await new Promise((resolvePipe, rejectPipe) => {
      const stream = Readable.fromWeb(upstream.body);
      stream.on('error', rejectPipe);
      res.on('error', rejectPipe);
      res.on('finish', resolvePipe);
      stream.pipe(res);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      res.statusCode = message.includes('LEONARDO_API_KEY')
        ? 503
        : message.includes('too large')
          ? 413
          : 502;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
    }
    if (!res.writableEnded) {
      res.end(JSON.stringify({ ok: false, error: message }));
    }
  }
}

export {
  IMAGE_PROVIDERS,
  IdeogramClient,
  buildLeonardoProxyRequest,
  imageProviderFromEndpointPath,
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const thisPath = resolve(new URL(import.meta.url).pathname);
if (invokedPath === thisPath) {
  console.error(
    '[image-provider-mcp] This module is mounted by sillytavern-server.mjs.',
  );
}
