import { createServer } from 'node:http';
import { resolve } from 'node:path';

import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import {
  buildProviderMcpServer,
  providerFromEndpointPath,
} from './ai-provider-server.mjs';

const DEFAULT_PORT = 8790;
const MAX_TOOL_TEXT = 200_000;

export function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('SILLYTAVERN_URL is required.');
  }

  const parsed = new URL(value.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('SILLYTAVERN_URL must use http or https.');
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';

  return parsed.toString().replace(/\/+$/, '');
}

export function resolveSillyTavernBaseUrl(env = process.env) {
  if (env?.RAILWAY_ENVIRONMENT_ID) {
    return 'http://sillytavern.railway.internal:8000';
  }
  return normalizeBaseUrl(env?.SILLYTAVERN_URL || '');
}

export function sanitizeNemoRuntimeReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('Invalid Nemo runtime report.');
  }

  const {
    ok = false,
    preset = '',
    promptCount = 0,
    regexCount = 0,
    recipe = null,
    vex = null,
    cold = null,
    sidecars = null,
    rendering = null,
  } = report;

  return {
    ok: Boolean(ok),
    preset,
    promptCount,
    regexCount,
    recipe,
    vex,
    cold,
    sidecars,
    rendering,
  };
}

function cookieHeaderFromResponse(headers) {
  let setCookies = [];
  if (typeof headers?.getSetCookie === 'function') {
    setCookies = headers.getSetCookie();
  } else {
    const single = headers?.get?.('set-cookie');
    if (single) setCookies = [single];
  }

  return setCookies
    .map((value) => String(value).split(';', 1)[0].trim())
    .filter(Boolean)
    .join('; ');
}

function safeErrorBody(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 1_000);
}

export class SillyTavernClient {
  constructor({
    baseUrl,
    username = '',
    password = '',
    fetchImpl = globalThis.fetch,
  }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.username = username;
    this.password = password;
    this.fetchImpl = fetchImpl;
    this.csrfToken = '';
    this.cookie = '';

    if (typeof fetchImpl !== 'function') {
      throw new Error('A fetch implementation is required.');
    }

    if ((username && !password) || (!username && password)) {
      throw new Error(
        'SILLYTAVERN_BASIC_AUTH_USERNAME and SILLYTAVERN_BASIC_AUTH_PASSWORD must be provided together.',
      );
    }
  }

  authHeaders() {
    if (!this.username && !this.password) return {};
    return {
      authorization:
        'Basic ' +
        Buffer.from(`${this.username}:${this.password}`, 'utf8').toString('base64'),
    };
  }


  async bootstrapSession() {
    if (this.csrfToken) return;

    const response = await this.fetchImpl(`${this.baseUrl}/csrf-token`, {
      method: 'GET',
      headers: {
        ...this.authHeaders(),
        accept: 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `SillyTavern CSRF bootstrap failed with HTTP ${response.status}: ${safeErrorBody(body)}`,
      );
    }

    const payload = await response.json();
    if (!payload?.token || typeof payload.token !== 'string') {
      throw new Error('SillyTavern /csrf-token did not return a token.');
    }

    this.csrfToken = payload.token;
    this.cookie = cookieHeaderFromResponse(response.headers);
  }

  async getJson(pathname) {
    await this.bootstrapSession();

    const headers = {
      ...this.authHeaders(),
      accept: 'application/json',
    };
    if (this.cookie) headers.cookie = this.cookie;

    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(
        `SillyTavern ${pathname} failed with HTTP ${response.status}: ${safeErrorBody(bodyText)}`,
      );
    }

    const contentType = response.headers?.get?.('content-type') || '';
    if (contentType.includes('application/json')) {
      return response.json();
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`SillyTavern ${pathname} did not return JSON.`);
    }
  }

  async post(pathname, body = {}) {
    await this.bootstrapSession();

    const headers = {
      ...this.authHeaders(),
      accept: 'application/json',
      'content-type': 'application/json',
      'x-csrf-token': this.csrfToken,
    };
    if (this.cookie) headers.cookie = this.cookie;

    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(
        `SillyTavern ${pathname} failed with HTTP ${response.status}: ${safeErrorBody(bodyText)}`,
      );
    }

    const contentType = response.headers?.get?.('content-type') || '';
    if (contentType.includes('application/json')) {
      return response.json();
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async status() {
    await this.bootstrapSession();
    return {
      ok: true,
      baseUrl: this.baseUrl,
      csrfSessionReady: Boolean(this.csrfToken),
      basicAuthConfigured: Boolean(this.username && this.password),
    };
  }

  listCharacters() {
    return this.post('/api/characters/all', {});
  }

  getCharacter(avatarUrl) {
    return this.post('/api/characters/get', { avatar_url: avatarUrl });
  }

  listWorldInfo() {
    return this.post('/api/worldinfo/list', {});
  }

  getWorldInfo(name) {
    return this.post('/api/worldinfo/get', { name });
  }

  recentChats() {
    return this.post('/api/chats/recent', {});
  }

  getChat({ avatarUrl, fileName }) {
    return this.post('/api/chats/get', {
      avatar_url: avatarUrl,
      file_name: fileName,
    });
  }

  async getNemoRuntimeStatus() {
    const report = await this.getJson('/user/files/nemo-runtime-report.json');
    return sanitizeNemoRuntimeReport(report);
  }
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

function normalizeEndpointPath(value = '/mcp') {
  const trimmed = String(value).trim();
  if (!trimmed.startsWith('/') || trimmed.includes('?') || trimmed.includes('#')) {
    throw new Error('SILLYTAVERN_MCP_ENDPOINT_PATH must be an absolute URL path.');
  }
  const normalized = trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
  if (!normalized.endsWith('/mcp')) {
    throw new Error('SILLYTAVERN_MCP_ENDPOINT_PATH must end with /mcp.');
  }
  return normalized;
}

export const MCP_ENDPOINT_PATH = normalizeEndpointPath(
  process.env.SILLYTAVERN_MCP_ENDPOINT_PATH || '/mcp',
);


export function classifyRequestPath(
  pathname,
  {
    sillyPath = MCP_ENDPOINT_PATH,
    aiPrefix = process.env.AI_MCP_PREFIX || '',
  } = {},
) {
  if (pathname === '/healthz') return { kind: 'health' };
  if (pathname === '/nemo-runtime-status') return { kind: 'nemo_status' };
  if (pathname === sillyPath) return { kind: 'sillytavern' };

  const providerId = providerFromEndpointPath(pathname, aiPrefix);
  if (providerId) return { kind: 'provider', providerId };

  return { kind: 'not_found' };
}

function clientFromEnv() {
  return new SillyTavernClient({
    baseUrl: resolveSillyTavernBaseUrl(process.env),
    username: process.env.SILLYTAVERN_BASIC_AUTH_USERNAME || '',
    password: process.env.SILLYTAVERN_BASIC_AUTH_PASSWORD || '',
  });
}

export async function checkReadiness(getClient = clientFromEnv) {
  try {
    const client = getClient();
    const status = await client.status();
    const characters = await client.listCharacters();

    return {
      ok: true,
      service: 'sillytavern-mcp',
      upstream: {
        ok: Boolean(status?.ok),
        csrfSessionReady: Boolean(status?.csrfSessionReady),
        basicAuthConfigured: Boolean(status?.basicAuthConfigured),
        charactersReadable: Array.isArray(characters),
        characterCount: Array.isArray(characters) ? characters.length : 0,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      service: 'sillytavern-mcp',
      error: message,
    };
  }
}

function toolText(value) {
  const text =
    typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length <= MAX_TOOL_TEXT) return text;
  return `${text.slice(0, MAX_TOOL_TEXT)}\n...[truncated by sillytavern-mcp]`;
}

function textResult(value, extra = {}) {
  return {
    content: [{ type: 'text', text: toolText(value) }],
    ...extra,
  };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return textResult(`SillyTavern MCP error: ${message}`, { isError: true });
}

export function buildMcpServer({ getClient = clientFromEnv } = {}) {
  const server = new McpServer({
    name: 'sillytavern',
    version: '0.1.0',
  });

  const noInput = z.object({});

  server.registerTool(
    'sillytavern_status',
    {
      description:
        'Check whether the configured SillyTavern endpoint is reachable and a CSRF session can be established. Does not expose credentials.',
      inputSchema: noInput,
    },
    async () => {
      try {
        return textResult(await getClient().status());
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'sillytavern_list_characters',
    {
      description:
        'Read the current SillyTavern character list. This tool is read-only.',
      inputSchema: noInput,
    },
    async () => {
      try {
        return textResult(await getClient().listCharacters());
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'sillytavern_get_character',
    {
      description:
        'Read one SillyTavern character card by its avatar filename, for example Darya.png. This tool is read-only.',
      inputSchema: z.object({
        avatarUrl: z.string().min(1).max(500),
      }),
    },
    async ({ avatarUrl }) => {
      try {
        return textResult(await getClient().getCharacter(avatarUrl));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'sillytavern_list_world_info',
    {
      description:
        'List SillyTavern World Info / lorebook files. This tool is read-only.',
      inputSchema: noInput,
    },
    async () => {
      try {
        return textResult(await getClient().listWorldInfo());
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'sillytavern_get_world_info',
    {
      description:
        'Read one SillyTavern World Info / lorebook file by name. This tool is read-only.',
      inputSchema: z.object({
        name: z.string().min(1).max(500),
      }),
    },
    async ({ name }) => {
      try {
        return textResult(await getClient().getWorldInfo(name));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'sillytavern_nemo_runtime_status',
    {
      description:
        'Read the persisted NemoEngine runtime verification report. Returns only sanitized runtime status fields and never secrets or sidecar contents.',
      inputSchema: noInput,
    },
    async () => {
      try {
        return textResult(await getClient().getNemoRuntimeStatus());
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'sillytavern_recent_chats',
    {
      description:
        'Read SillyTavern recent chat metadata. This tool is read-only.',
      inputSchema: noInput,
    },
    async () => {
      try {
        return textResult(await getClient().recentChats());
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'sillytavern_get_chat',
    {
      description:
        'Read one SillyTavern character chat using the character avatar filename and chat file name. This tool never writes the chat.',
      inputSchema: z.object({
        avatarUrl: z.string().min(1).max(500),
        fileName: z.string().min(1).max(1_000),
      }),
    },
    async ({ avatarUrl, fileName }) => {
      try {
        return textResult(await getClient().getChat({ avatarUrl, fileName }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

export function startHttpServer({
  port = parsePort(process.env.PORT || String(DEFAULT_PORT)),
  host = process.env.HOST || '0.0.0.0',
  getClient = clientFromEnv,
  aiPrefix = process.env.AI_MCP_PREFIX || '',
} = {}) {
  const handler = createMcpHandler(() => buildMcpServer({ getClient }), {
    onerror: (error) => {
      console.error('[sillytavern-mcp]', error.message);
    },
  });
  const nodeHandler = toNodeHandler(handler);

  const providerHandlers = Object.fromEntries(
    ['groq', 'openrouter', 'deepseek'].map((providerId) => {
      const providerHandler = createMcpHandler(
        () => buildProviderMcpServer(providerId),
        {
          onerror: (error) => {
            console.error(`[sillytavern-mcp:${providerId}]`, error.message);
          },
        },
      );
      return [providerId, toNodeHandler(providerHandler)];
    }),
  );

  const httpServer = createServer((req, res) => {
    const pathname = (req.url || '/').split('?', 1)[0];
    const route = classifyRequestPath(pathname, {
      sillyPath: MCP_ENDPOINT_PATH,
      aiPrefix,
    });

    if (route.kind === 'health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          ok: true,
          service: 'sillytavern-mcp',
          mobileProviders: ['groq', 'openrouter', 'deepseek'],
        }),
      );
      return;
    }

    if (pathname === '/readyz') {
      void checkReadiness(getClient).then((result) => {
        res.statusCode = result.ok ? 200 : 503;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(result));
      });
      return;
    }

    if (route.kind === 'nemo_status') {
      void getClient().getNemoRuntimeStatus()
        .then((result) => {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(result));
        })
        .catch((error) => {
          res.statusCode = 503;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }));
        });
      return;
    }

    if (route.kind === 'sillytavern') {
      void nodeHandler(req, res);
      return;
    }

    if (route.kind === 'provider') {
      void providerHandlers[route.providerId](req, res);
      return;
    }

    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Not found');
  });

  httpServer.listen(port, host, () => {
    console.error(
      `[sillytavern-mcp] listening on http://${host}:${port}${MCP_ENDPOINT_PATH} with mobile AI provider routes`,
    );
  });

  return httpServer;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const thisPath = resolve(new URL(import.meta.url).pathname);
if (invokedPath === thisPath) {
  startHttpServer();
}
