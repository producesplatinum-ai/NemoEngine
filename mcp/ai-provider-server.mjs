import { createServer } from 'node:http';
import { resolve } from 'node:path';

import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const DEFAULT_PORT = 8791;
const MAX_TOOL_TEXT = 200_000;

export const PROVIDERS = Object.freeze({
  groq: Object.freeze({
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    defaultModel: 'openai/gpt-oss-120b',
  }),
  openrouter: Object.freeze({
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    defaultModel: 'openrouter/free',
  }),
  deepseek: Object.freeze({
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    envKey: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-flash',
  }),
});

function safeErrorBody(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 2_000);
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

function normalizePrefix(value = '') {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (!trimmed.startsWith('/') || trimmed.includes('?') || trimmed.includes('#')) {
    throw new Error('AI_MCP_PREFIX must be an absolute URL path prefix.');
  }
  return trimmed.replace(/\/+$/, '');
}

export function providerFromEndpointPath(pathname, prefix = '') {
  const normalizedPrefix = normalizePrefix(prefix);
  for (const providerId of Object.keys(PROVIDERS)) {
    if (pathname === `${normalizedPrefix}/${providerId}/mcp`) {
      return providerId;
    }
  }
  return null;
}

export function extractResponseText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text) {
    return payload.output_text;
  }

  const parts = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (
        (content?.type === 'output_text' || content?.type === 'text') &&
        typeof content.text === 'string'
      ) {
        parts.push(content.text);
      }
    }
  }
  return parts.join('');
}

export class ProviderClient {
  constructor({
    providerId,
    apiKey = '',
    fetchImpl = globalThis.fetch,
  }) {
    const config = PROVIDERS[providerId];
    if (!config) throw new Error(`Unsupported provider: ${providerId}`);
    if (typeof fetchImpl !== 'function') {
      throw new Error('A fetch implementation is required.');
    }

    this.providerId = providerId;
    this.config = config;
    this.apiKey = String(apiKey || '').trim();
    this.fetchImpl = fetchImpl;
  }

  status() {
    return {
      ok: true,
      provider: this.providerId,
      providerName: this.config.name,
      configured: Boolean(this.apiKey),
      envKey: this.config.envKey,
      defaultModel: this.config.defaultModel,
      baseUrl: this.config.baseUrl,
    };
  }

  async generate({
    input,
    instructions = '',
    model = '',
    maxOutputTokens,
  }) {
    if (!this.apiKey) {
      throw new Error(`${this.config.envKey} is not configured.`);
    }

    const normalizedInput = String(input || '').trim();
    if (!normalizedInput) throw new Error('input is required.');

    const selectedModel = String(model || '').trim() || this.config.defaultModel;
    const body = {
      model: selectedModel,
      input: normalizedInput,
    };

    const normalizedInstructions = String(instructions || '').trim();
    if (normalizedInstructions) body.instructions = normalizedInstructions;

    if (maxOutputTokens !== undefined && maxOutputTokens !== null) {
      const amount = Number(maxOutputTokens);
      if (!Number.isInteger(amount) || amount < 1 || amount > 65_536) {
        throw new Error('maxOutputTokens must be an integer between 1 and 65536.');
      }
      body.max_output_tokens = amount;
    }

    const response = await this.fetchImpl(`${this.config.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `${this.config.name} Responses API failed with HTTP ${response.status}: ${safeErrorBody(errorBody)}`,
      );
    }

    const payload = await response.json();
    const text = extractResponseText(payload);
    if (!text) {
      throw new Error(`${this.config.name} returned no text output.`);
    }

    return {
      provider: this.providerId,
      model: selectedModel,
      text,
      responseId:
        typeof payload?.id === 'string' && payload.id ? payload.id : undefined,
    };
  }
}

function clientFromEnv(providerId) {
  const config = PROVIDERS[providerId];
  return new ProviderClient({
    providerId,
    apiKey: process.env[config.envKey] || '',
  });
}

function toolText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length <= MAX_TOOL_TEXT) return text;
  return `${text.slice(0, MAX_TOOL_TEXT)}\n...[truncated by ai-provider-mcp]`;
}

function textResult(value, extra = {}) {
  return {
    content: [{ type: 'text', text: toolText(value) }],
    ...extra,
  };
}

function errorResult(providerId, error) {
  const message = error instanceof Error ? error.message : String(error);
  return textResult(`${PROVIDERS[providerId].name} MCP error: ${message}`, {
    isError: true,
  });
}

export function buildProviderMcpServer(
  providerId,
  { getClient = () => clientFromEnv(providerId) } = {},
) {
  const config = PROVIDERS[providerId];
  if (!config) throw new Error(`Unsupported provider: ${providerId}`);

  const server = new McpServer({
    name: `${providerId}-mobile-provider`,
    version: '0.1.0',
  });

  server.registerTool(
    `${providerId}_status`,
    {
      description:
        `Check whether ${config.name} is configured for this private mobile plugin. Never returns the API key.`,
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return textResult(getClient().status());
      } catch (error) {
        return errorResult(providerId, error);
      }
    },
  );

  server.registerTool(
    `${providerId}_generate`,
    {
      description:
        `Generate a response with ${config.name} using the user's server-side API key. Use for model-backed analysis, drafting, coding, or other text tasks when the user explicitly wants this provider.`,
      inputSchema: z.object({
        input: z.string().min(1).max(200_000),
        instructions: z.string().max(50_000).optional(),
        model: z.string().min(1).max(500).optional(),
        maxOutputTokens: z.number().int().min(1).max(65_536).optional(),
      }),
    },
    async (args) => {
      try {
        return textResult(await getClient().generate(args));
      } catch (error) {
        return errorResult(providerId, error);
      }
    },
  );

  return server;
}

export function startHttpServer({
  port = parsePort(process.env.PORT || String(DEFAULT_PORT)),
  host = process.env.HOST || '0.0.0.0',
  prefix = process.env.AI_MCP_PREFIX || '',
  getClientForProvider = (providerId) => clientFromEnv(providerId),
} = {}) {
  const normalizedPrefix = normalizePrefix(prefix);
  const handlers = Object.fromEntries(
    Object.keys(PROVIDERS).map((providerId) => {
      const handler = createMcpHandler(
        () =>
          buildProviderMcpServer(providerId, {
            getClient: () => getClientForProvider(providerId),
          }),
        {
          onerror: (error) => {
            console.error(`[ai-provider-mcp:${providerId}]`, error.message);
          },
        },
      );
      return [providerId, toNodeHandler(handler)];
    }),
  );

  const httpServer = createServer((req, res) => {
    const pathname = (req.url || '/').split('?', 1)[0];

    if (pathname === '/healthz') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          ok: true,
          service: 'ai-provider-mcp',
          providers: Object.fromEntries(
            Object.entries(PROVIDERS).map(([providerId, config]) => [
              providerId,
              Boolean(process.env[config.envKey]),
            ]),
          ),
        }),
      );
      return;
    }

    const providerId = providerFromEndpointPath(pathname, normalizedPrefix);
    if (!providerId) {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('Not found');
      return;
    }

    void handlers[providerId](req, res);
  });

  httpServer.listen(port, host, () => {
    console.error(
      `[ai-provider-mcp] listening on http://${host}:${port}${normalizedPrefix}/{groq|openrouter|deepseek}/mcp`,
    );
  });

  return httpServer;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const thisPath = resolve(new URL(import.meta.url).pathname);
if (invokedPath === thisPath) {
  startHttpServer();
}
