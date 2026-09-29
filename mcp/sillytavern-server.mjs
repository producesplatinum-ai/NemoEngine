import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';

import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import {
  buildProviderMcpServer,
  providerFromEndpointPath,
} from './ai-provider-server.mjs';

import {
  classifyMobileRestRequest,
  deriveMobileRestBasePath,
  executeMobileRestRoute,
} from './sillytavern-mobile-rest.mjs';

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

export function sanitizeNemoClientRuntimeReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('Invalid Nemo client runtime report.');
  }

  const {
    ok = false,
    bootstrapVersion = '',
    preset = '',
    importedAt = '',
    transform = null,
    preflight = null,
    recipe = null,
    cold = null,
    vex = null,
    rendering = null,
    persistence = null,
  } = report;

  return {
    ok: Boolean(ok),
    bootstrapVersion,
    preset,
    importedAt,
    transform,
    preflight,
    recipe,
    cold,
    vex,
    rendering,
    persistence,
  };
}

export function sanitizeNemoClientGenerationReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('Invalid Nemo client generation report.');
  }

  const {
    ok = false,
    requestId = '',
    generatedAt = '',
    preset = '',
    avatarUrl = '',
    fileName = '',
    marker = '',
    beforeCount = 0,
    afterCount = 0,
    assistantMessagePresent = false,
    generatedNewAssistant = false,
    outcome = '',
    bootstrapImportedAt = '',
    error = '',
  } = report;

  return {
    ok: Boolean(ok),
    requestId,
    generatedAt,
    preset,
    avatarUrl,
    fileName,
    marker,
    beforeCount,
    afterCount,
    assistantMessagePresent: Boolean(assistantMessagePresent),
    generatedNewAssistant: Boolean(generatedNewAssistant),
    outcome,
    bootstrapImportedAt,
    error,
  };
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

  async listOpenAiPresets() {
    const settings = await this.post('/api/settings/get', {});
    return Array.isArray(settings?.openai_setting_names)
      ? settings.openai_setting_names
      : [];
  }

  async saveOpenAiPreset({ name, preset }) {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) throw new Error('Preset name is required.');
    if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
      throw new Error('Preset must be an object.');
    }
    const result = await this.post('/api/presets/save', {
      apiId: 'openai',
      name: normalizedName,
      preset,
    });
    return {
      ok: true,
      name: String(result?.name || normalizedName),
    };
  }

  getCharacter(avatarUrl) {
    return this.post('/api/characters/get', { avatar_url: avatarUrl });
  }

  async createCharacter({ card, fileName = '' }) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) {
      throw new Error('Character card must be an object.');
    }

    const data =
      card?.data && typeof card.data === 'object' && !Array.isArray(card.data)
        ? card.data
        : {};
    const extensions =
      data?.extensions &&
      typeof data.extensions === 'object' &&
      !Array.isArray(data.extensions)
        ? data.extensions
        : {};
    const name = String(data.name || card.name || '').trim();
    if (!name) throw new Error('Character card name is required.');

    const payload = {
      ch_name: name,
      description: data.description ?? card.description ?? '',
      personality: data.personality ?? card.personality ?? '',
      scenario: data.scenario ?? card.scenario ?? '',
      first_mes: data.first_mes ?? card.first_mes ?? '',
      mes_example: data.mes_example ?? card.mes_example ?? '',
      creator_notes:
        data.creator_notes ?? card.creator_notes ?? card.creatorcomment ?? '',
      system_prompt: data.system_prompt ?? '',
      post_history_instructions: data.post_history_instructions ?? '',
      tags: data.tags ?? card.tags ?? [],
      creator: data.creator ?? card.creator ?? '',
      character_version:
        data.character_version ?? card.character_version ?? '',
      alternate_greetings:
        data.alternate_greetings ?? card.alternate_greetings ?? [],
      talkativeness:
        extensions.talkativeness ?? card.talkativeness ?? 0.5,
      json_data: JSON.stringify(card),
    };

    const normalizedFileName = String(fileName || '').trim();
    if (normalizedFileName) payload.file_name = normalizedFileName;

    const avatarUrl = String(
      await this.post('/api/characters/create', payload),
    ).trim();
    if (!avatarUrl) {
      throw new Error('SillyTavern character create returned no avatar filename.');
    }

    return {
      ok: true,
      avatarUrl,
      characterName: name,
    };
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

  async appendUserMessage({ avatarUrl, fileName, userText }) {
    const character = await this.getCharacter(avatarUrl);
    const fallbackName = String(avatarUrl).replace(/\.png$/i, '');
    const characterName = String(
      character?.name || character?.data?.name || fallbackName || 'Assistant',
    ).trim();

    const existing = await this.getChat({ avatarUrl, fileName });
    const chat = Array.isArray(existing) ? existing.slice() : [];
    const first = chat[0];
    const hasHeader =
      first &&
      typeof first === 'object' &&
      !Array.isArray(first) &&
      (
        Object.hasOwn(first, 'chat_metadata') ||
        Object.hasOwn(first, 'user_name') ||
        Object.hasOwn(first, 'character_name')
      );

    if (!hasHeader) {
      chat.unshift({
        user_name: 'You',
        character_name: characterName,
        create_date: new Date().toISOString(),
        chat_metadata: {},
      });
    }

    chat.push({
      name: 'You',
      is_user: true,
      is_system: false,
      send_date: new Date().toISOString(),
      mes: String(userText),
      extra: {},
    });

    await this.post('/api/chats/save', {
      ch_name: characterName,
      file_name: fileName,
      chat,
      avatar_url: avatarUrl,
    });

    return {
      ok: true,
      saved: true,
      avatarUrl,
      fileName,
      characterName,
      messageCount: chat.length,
    };
  }

  async generateAssistantMessage({ avatarUrl, fileName, source, model }) {
    const character = await this.getCharacter(avatarUrl);
    const fallbackName = String(avatarUrl).replace(/\\.png$/i, '');
    const characterName = String(
      character?.name || character?.data?.name || fallbackName || 'Assistant',
    ).trim();

    const existing = await this.getChat({ avatarUrl, fileName });
    const chat = Array.isArray(existing) ? existing.slice() : [];
    const conversation = chat.filter(
      (entry) => entry && typeof entry === 'object' && typeof entry.mes === 'string' && entry.mes.trim(),
    );
    if (!conversation.some((entry) => entry.is_user === true)) {
      throw new Error('Chat must contain a user message before generation.');
    }

    const data = character?.data && typeof character.data === 'object' ? character.data : {};
    const systemParts = [
      `You are ${characterName}. Reply as this character and do not speak for the user.`,
      character?.description || data.description || '',
      character?.personality || data.personality || '',
      character?.scenario || data.scenario || '',
    ].map((value) => String(value || '').trim()).filter(Boolean);

    const messages = [];
    if (systemParts.length) {
      messages.push({ role: 'system', content: systemParts.join('\\n\\n') });
    }
    for (const entry of conversation) {
      messages.push({
        role: entry.is_system ? 'system' : entry.is_user ? 'user' : 'assistant',
        content: String(entry.mes),
      });
    }

    const payload = await this.post('/api/backends/chat-completions/generate', {
      chat_completion_source: source,
      messages,
      model,
      temperature: 0.7,
      max_tokens: 512,
      stream: false,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
      stop: [],
      seed: 0,
      logprobs: 0,
      include_reasoning: false,
    });

    const message = String(
      payload?.choices?.[0]?.message?.content ||
      payload?.choices?.[0]?.text ||
      '',
    ).trim();
    if (!message) {
      throw new Error(`SillyTavern ${source} generation returned no message content.`);
    }

    chat.push({
      name: characterName,
      is_user: false,
      is_system: false,
      send_date: new Date().toISOString(),
      mes: message,
      extra: {},
    });

    await this.post('/api/chats/save', {
      ch_name: characterName,
      file_name: fileName,
      chat,
      avatar_url: avatarUrl,
    });

    return {
      ok: true,
      saved: true,
      avatarUrl,
      fileName,
      characterName,
      source,
      model,
      message,
      messageCount: chat.length,
    };
  }

  async generateChatCompletion({ source, model, expected }) {
    const payload = await this.post('/api/backends/chat-completions/generate', {
      chat_completion_source: source,
      messages: [{ role: 'user', content: `Reply exactly: ${expected}` }],
      model,
      temperature: 0,
      max_tokens: 128,
      stream: false,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
      stop: [],
      seed: 0,
      logprobs: 0,
      include_reasoning: false,
    });

    const response = String(payload?.choices?.[0]?.message?.content || '').trim();
    if (!response) {
      throw new Error(`SillyTavern ${source} smoke test returned no message content.`);
    }

    return {
      source,
      model,
      ok: response.includes(expected),
      response: response.slice(0, 200),
    };
  }

  async getNemoClientRuntimeStatus() {
    const reportPath = '/user/files/nemo-client-runtime-report.json';
    const publicPath = '/files/nemo-client-runtime-report.json';
    let fileError = null;
    try {
      const report = await this.getJson(reportPath);
      const sanitized = sanitizeNemoClientRuntimeReport(report);
      if (!sanitized.persistence?.ok) {
        sanitized.persistence = { ok: true, path: publicPath };
      }
      return sanitized;
    } catch (error) {
      fileError = error;
    }

    try {
      const settings = await this.post('/api/settings/get', {});
      const report = settings?.extension_settings?.NemoFullBootstrap;
      if (report && typeof report === 'object' && !Array.isArray(report)) {
        return sanitizeNemoClientRuntimeReport(report);
      }
    } catch {
      // Prefer the original file error below so diagnostics point to the primary source.
    }

    const message = fileError instanceof Error ? fileError.message : String(fileError || '');
    if (
      message.includes(reportPath) &&
      message.includes('HTTP 404')
    ) {
      return null;
    }
    throw fileError;
  }

  async getNemoClientGenerationStatus(expectedMarker = '') {
    const reportPath = '/user/files/nemo-client-generation-report.json';
    try {
      const report = await this.getJson(reportPath);
      const sanitized = sanitizeNemoClientGenerationReport(report);
      const marker = String(expectedMarker || '').trim();
      if (marker && sanitized.marker !== marker) {
        return {
          available: false,
          stale: true,
          expectedMarker: marker,
          reportMarker: sanitized.marker,
        };
      }
      return {
        available: true,
        ...sanitized,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(reportPath) && message.includes('HTTP 404')) {
        return { available: false };
      }
      throw error;
    }
  }

  async getNemoFullStatus() {
    const server = await this.getNemoRuntimeStatus();
    const clientReport = await this.getNemoClientRuntimeStatus();
    const client = clientReport
      ? { available: true, ...clientReport }
      : { available: false };

    return {
      ok: Boolean(server?.ok) && (!client.available || client.ok !== false),
      server,
      client,
    };
  }

  async getNemoRuntimeStatus() {
    try {
      const report = await this.getJson('/user/files/nemo-runtime-report.json');
      return sanitizeNemoRuntimeReport(report);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('/user/files/nemo-runtime-report.json') || !message.includes('HTTP 404')) {
        throw error;
      }

      const settings = await this.post('/api/settings/get', {});
      const report = settings?.extension_settings?.NemoFullRuntime;
      if (!report || typeof report !== 'object' || Array.isArray(report)) {
        throw new Error('Nemo runtime report is unavailable in both user files and settings.');
      }
      return sanitizeNemoRuntimeReport(report);
    }
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

export const MOBILE_REST_BASE_PATH =
  deriveMobileRestBasePath(MCP_ENDPOINT_PATH);

const BOOTSTRAP_PROXY_COOKIE = 'st_bootstrap_proxy';

function bootstrapProxyToken(mcpPath) {
  return createHash('sha256')
    .update(`sillytavern-bootstrap-proxy-v1\0${normalizeEndpointPath(mcpPath)}`)
    .digest('base64url');
}

export function createBootstrapProxyCookie(mcpPath) {
  return [
    `${BOOTSTRAP_PROXY_COOKIE}=${bootstrapProxyToken(mcpPath)}`,
    'Path=/',
    'Max-Age=300',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
  ].join('; ');
}

export function hasBootstrapProxyCookie(cookieHeader, mcpPath) {
  const expected = `${BOOTSTRAP_PROXY_COOKIE}=${bootstrapProxyToken(mcpPath)}`;
  return String(cookieHeader || '')
    .split(';')
    .some((part) => part.trim() === expected);
}

function bootstrapProxyHeaders(requestHeaders, env = process.env) {
  const headers = new Headers();
  const blocked = new Set([
    'host',
    'connection',
    'content-length',
    'transfer-encoding',
    'accept-encoding',
    'authorization',
  ]);

  for (const [name, value] of Object.entries(requestHeaders || {})) {
    if (blocked.has(name.toLowerCase()) || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
  }

  headers.set('accept-encoding', 'identity');

  const username = env.SILLYTAVERN_BASIC_AUTH_USERNAME || '';
  const password = env.SILLYTAVERN_BASIC_AUTH_PASSWORD || '';
  if ((username && !password) || (!username && password)) {
    throw new Error('SillyTavern Basic Auth proxy credentials are incomplete.');
  }
  if (username && password) {
    headers.set(
      'authorization',
      'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64'),
    );
  }

  return headers;
}

export async function proxyBootstrapBrowserRequest(
  req,
  res,
  {
    fetchImpl = globalThis.fetch,
    env = process.env,
  } = {},
) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required for bootstrap proxying.');
  }

  const upstreamBase = resolveSillyTavernBaseUrl(env);
  const requestTarget = req.url || '/';
  const method = String(req.method || 'GET').toUpperCase();
  const init = {
    method,
    headers: bootstrapProxyHeaders(req.headers, env),
    redirect: 'manual',
  };

  if (method !== 'GET' && method !== 'HEAD') {
    init.body = req;
    init.duplex = 'half';
  }

  const upstream = await fetchImpl(`${upstreamBase}${requestTarget}`, init);
  res.statusCode = upstream.status;
  if (upstream.statusText) res.statusMessage = upstream.statusText;

  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();
    if (
      lower === 'set-cookie' ||
      lower === 'content-length' ||
      lower === 'content-encoding' ||
      lower === 'transfer-encoding'
    ) {
      continue;
    }

    if (lower === 'location') {
      try {
        const location = new URL(value, upstreamBase);
        const upstreamUrl = new URL(upstreamBase);
        if (location.origin === upstreamUrl.origin) {
          res.setHeader(
            name,
            `${location.pathname}${location.search}${location.hash}`,
          );
          continue;
        }
      } catch {
        // Preserve non-URL Location values below.
      }
    }

    res.setHeader(name, value);
  }

  const setCookies =
    typeof upstream.headers?.getSetCookie === 'function'
      ? upstream.headers.getSetCookie()
      : [];
  for (const cookie of setCookies) {
    res.appendHeader('set-cookie', cookie);
  }

  if (method === 'HEAD' || !upstream.body) {
    res.end();
    return;
  }

  await new Promise((resolvePipe, rejectPipe) => {
    const body = Readable.fromWeb(upstream.body);
    body.on('error', rejectPipe);
    res.on('error', rejectPipe);
    res.on('finish', resolvePipe);
    body.pipe(res);
  });
}


export function classifyRequestPath(
  pathname,
  {
    sillyPath = MCP_ENDPOINT_PATH,
    aiPrefix = process.env.AI_MCP_PREFIX || '',
  } = {},
) {
  if (pathname === '/healthz') return { kind: 'health' };
  if (pathname === '/nemo-runtime-status') return { kind: 'nemo_status' };
  if (pathname === '/nemo-full-status') return { kind: 'nemo_full_status' };
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

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export function parseMobileWriteBody(contentType, text) {
  const normalizedType = String(contentType || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  const bodyText = String(text || '').trim();

  if (!bodyText) return {};

  if (normalizedType === 'application/json') {
    try {
      const value = JSON.parse(bodyText);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid JSON body.');
      }
      return value;
    } catch {
      throw new Error('Invalid JSON body.');
    }
  }

  if (normalizedType === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams(bodyText);
    const parsed = {
      avatarUrl: params.get('avatarUrl') || '',
      fileName: params.get('fileName') || '',
      userText: params.get('userText') || '',
    };
    if (params.has('source')) parsed.source = params.get('source') || '';
    if (params.has('model')) parsed.model = params.get('model') || '';
    if (params.has('marker')) parsed.marker = params.get('marker') || '';
    if (params.has('cardJson')) parsed.cardJson = params.get('cardJson') || '';
    if (params.has('name')) parsed.name = params.get('name') || '';
    if (params.has('presetJson')) parsed.presetJson = params.get('presetJson') || '';
    return parsed;
  }

  throw new Error('Unsupported content type.');
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function mobilePresetSaveFormHtml(actionPath) {
  const action = escapeHtmlAttribute(actionPath);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SillyTavern Mobile Preset Save</title>
</head>
<body>
<form method="post" action="${action}">
<label>name <input name="name" autocomplete="off" required></label>
<label>presetJson <textarea name="presetJson" required></textarea></label>
<button type="submit">Save preset</button>
</form>
</body>
</html>`;
}

export function mobileCharacterCreateFormHtml(actionPath) {
  const action = escapeHtmlAttribute(actionPath);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SillyTavern Mobile Character Create</title>
</head>
<body>
<form method="post" action="${action}">
<label>fileName <input name="fileName" autocomplete="off"></label>
<label>cardJson <textarea name="cardJson" required></textarea></label>
<button type="submit">Create character</button>
</form>
</body>
</html>`;
}

export function mobileTurnFormHtml(actionPath) {
  const action = escapeHtmlAttribute(actionPath);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SillyTavern Mobile Turn</title>
</head>
<body>
<form method="post" action="${action}">
<label>avatarUrl <input name="avatarUrl" autocomplete="off" required></label>
<label>fileName <input name="fileName" autocomplete="off" required></label>
<label>userText <textarea name="userText" required></textarea></label>
<button type="submit">Send one turn</button>
</form>
</body>
</html>`;
}

export function mobileClientGenerateFormHtml(actionPath) {
  const action = escapeHtmlAttribute(actionPath);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SillyTavern Nemo Client Generate</title>
</head>
<body>
<form method="post" action="${action}">
<label>avatarUrl <input name="avatarUrl" autocomplete="off" required></label>
<label>fileName <input name="fileName" autocomplete="off" required></label>
<label>marker <input name="marker" autocomplete="off" required></label>
<button type="submit">Run one Nemo client generation</button>
</form>
</body>
</html>`;
}

export function buildClientGenerateRedirect({
  avatarUrl,
  fileName,
  marker,
  requestId,
}) {
  const values = [avatarUrl, fileName, marker, requestId]
    .map((value) => String(value || '').trim());
  if (values.some((value) => !value)) {
    throw new Error('avatarUrl, fileName, marker, and requestId are required.');
  }

  const params = new URLSearchParams({
    nemoClientGenerate: '1',
    avatarUrl: values[0],
    fileName: values[1],
    marker: values[2],
    requestId: values[3],
  });
  return `/?${params.toString()}`;
}

export function mobileGenerateFormHtml(actionPath) {
  const action = escapeHtmlAttribute(actionPath);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SillyTavern Mobile Generate</title>
</head>
<body>
<form method="post" action="${action}">
<label>avatarUrl <input name="avatarUrl" autocomplete="off" required></label>
<label>fileName <input name="fileName" autocomplete="off" required></label>
<label>source <select name="source" required><option value="deepseek">deepseek</option><option value="groq">groq</option><option value="openrouter">openrouter</option></select></label>
<label>model <input name="model" value="deepseek-flash" autocomplete="off" required></label>
<button type="submit">Generate one reply</button>
</form>
</body>
</html>`;
}

function readMobileWriteRequestBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (tooLarge) {
        rejectBody(new Error('Request body too large.'));
        return;
      }

      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolveBody(
          parseMobileWriteBody(req.headers?.['content-type'] || '', text),
        );
      } catch (error) {
        rejectBody(error);
      }
    });

    req.on('error', rejectBody);
  });
}

export async function runProviderSmoke({
  getClient = clientFromEnv,
  retryDelayMs = 2_000,
  maxReadinessAttempts = 20,
} = {}) {
  const client = getClient();
  let ready = false;
  let lastError = null;

  for (let attempt = 0; attempt < maxReadinessAttempts; attempt += 1) {
    try {
      const status = await client.status();
      if (status?.ok) {
        ready = true;
        break;
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt + 1 < maxReadinessAttempts && retryDelayMs > 0) {
      await delay(retryDelayMs);
    }
  }

  if (!ready) {
    const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
    throw new Error(`SillyTavern was not ready for provider smoke test${detail}`);
  }

  const checks = [
    { source: 'deepseek', model: 'deepseek-flash', expected: 'DEEPSEEK_OK' },
    { source: 'groq', model: 'openai/gpt-oss-120b', expected: 'GROQ_OK' },
    { source: 'openrouter', model: 'openrouter/auto', expected: 'OPENROUTER_OK' },
  ];

  const providers = [];
  for (const check of checks) {
    const result = await client.generateChatCompletion(check);
    providers.push(result);
  }

  return {
    ok: providers.every((item) => item.ok),
    providers,
  };
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
    'sillytavern_nemo_full_status',
    {
      description:
        'Read the combined NemoEngine server runtime verification and optional client-side preflight report. Read-only and sanitized.',
      inputSchema: noInput,
    },
    async () => {
      try {
        return textResult(await getClient().getNemoFullStatus());
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
    const requestTarget = req.url || '/';
    const pathname = requestTarget.split('?', 1)[0];
    const bootstrapPath = `${MOBILE_REST_BASE_PATH}/client-bootstrap`;
    const clientGeneratePath = `${MOBILE_REST_BASE_PATH}/client-generate`;

    if (pathname === bootstrapPath) {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('allow', 'GET');
        res.end('GET required.');
        return;
      }
      res.statusCode = 302;
      res.setHeader('cache-control', 'no-store');
      res.setHeader('set-cookie', createBootstrapProxyCookie(MCP_ENDPOINT_PATH));
      res.setHeader('location', '/');
      res.end();
      return;
    }

    if (pathname === clientGeneratePath) {
      if (req.method === 'GET') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.setHeader('referrer-policy', 'no-referrer');
        res.setHeader(
          'content-security-policy',
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
        );
        res.end(mobileClientGenerateFormHtml(clientGeneratePath));
        return;
      }

      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('allow', 'GET, POST');
        res.end('GET or POST required.');
        return;
      }

      void readMobileWriteRequestBody(req)
        .then((body) => {
          const target = buildClientGenerateRedirect({
            avatarUrl: body?.avatarUrl,
            fileName: body?.fileName,
            marker: body?.marker,
            requestId: randomUUID(),
          });
          res.statusCode = 303;
          res.setHeader('cache-control', 'no-store');
          res.setHeader('referrer-policy', 'no-referrer');
          res.setHeader('set-cookie', createBootstrapProxyCookie(MCP_ENDPOINT_PATH));
          res.setHeader('location', target);
          res.end();
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          const badRequest =
            message.includes(' are required.') ||
            message === 'Invalid JSON body.' ||
            message === 'Unsupported content type.' ||
            message === 'Request body too large.';
          res.statusCode = badRequest ? 400 : 503;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('cache-control', 'no-store');
          res.end(JSON.stringify({ ok: false, error: message }));
        });
      return;
    }

    if (hasBootstrapProxyCookie(req.headers?.cookie || '', MCP_ENDPOINT_PATH)) {
      void proxyBootstrapBrowserRequest(req, res).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[sillytavern-mcp:bootstrap-proxy]', message);
        if (!res.headersSent) {
          res.statusCode = 502;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
        }
        if (!res.writableEnded) res.end('Bootstrap proxy failed.');
      });
      return;
    }

    const route = classifyRequestPath(pathname, {
      sillyPath: MCP_ENDPOINT_PATH,
      aiPrefix,
    });
    const mobileRoute = classifyMobileRestRequest(
      requestTarget,
      MOBILE_REST_BASE_PATH,
    );

    if (mobileRoute.kind !== 'not_found') {
      const mobileWriteRoute =
        mobileRoute.kind === 'turn' ||
        mobileRoute.kind === 'generate' ||
        mobileRoute.kind === 'character_create' ||
        mobileRoute.kind === 'preset_save';

      if (mobileWriteRoute && req.method === 'GET') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.setHeader(
          'content-security-policy',
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
        );
        res.end(
          mobileRoute.kind === 'turn'
            ? mobileTurnFormHtml(`${MOBILE_REST_BASE_PATH}/turn`)
            : mobileRoute.kind === 'character_create'
              ? mobileCharacterCreateFormHtml(
                  `${MOBILE_REST_BASE_PATH}/character-create`,
                )
              : mobileRoute.kind === 'preset_save'
                ? mobilePresetSaveFormHtml(
                    `${MOBILE_REST_BASE_PATH}/preset-save`,
                  )
                : mobileGenerateFormHtml(
                    `${MOBILE_REST_BASE_PATH}/generate`,
                  ),
        );
        return;
      }

      const expectedMethod = mobileWriteRoute ? 'POST' : 'GET';
      if (req.method !== expectedMethod) {
        res.statusCode = 405;
        res.setHeader('allow', mobileWriteRoute ? 'GET, POST' : expectedMethod);
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
          ok: false,
          error: mobileWriteRoute ? 'GET or POST required.' : `${expectedMethod} required.`,
        }));
        return;
      }

      const runMobileRoute = async () => {
        const body =
          expectedMethod === 'POST'
            ? await readMobileWriteRequestBody(req)
            : {};
        return executeMobileRestRoute(mobileRoute, getClient(), body);
      };

      void runMobileRoute()
        .then((result) => {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('cache-control', 'no-store');
          res.end(JSON.stringify(result));
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          const badRequest =
            message.includes(' is required.') ||
            message.includes(' are required.') ||
            message.includes('must not be empty.') ||
            message === 'cardJson must be valid JSON.' ||
            message === 'presetJson must be valid JSON.' ||
            message === 'Unsupported generation source.' ||
            message === 'Invalid JSON body.' ||
            message === 'Unsupported content type.' ||
            message === 'Request body too large.';
          res.statusCode = badRequest ? 400 : 503;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('cache-control', 'no-store');
          res.end(JSON.stringify({ ok: false, error: message }));
        });
      return;
    }

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

    if (route.kind === 'nemo_full_status') {
      void getClient().getNemoFullStatus()
        .then((result) => {
          res.statusCode = result.ok ? 200 : 503;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(result));
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[sillytavern-mcp:nemo-full-status]', message);
          res.statusCode = 503;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: false, error: message }));
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
          const message = error instanceof Error ? error.message : String(error);
          console.error('[sillytavern-mcp:nemo-runtime-status]', message);
          res.statusCode = 503;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({
            ok: false,
            error: message,
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

    if (process.env.RUN_PROVIDER_SMOKE === '1') {
      void runProviderSmoke({ getClient })
        .then((result) => {
          console.error('[sillytavern-mcp:provider-smoke]', JSON.stringify(result));
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(
            '[sillytavern-mcp:provider-smoke]',
            JSON.stringify({ ok: false, error: message }),
          );
        });
    }
  });

  return httpServer;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const thisPath = resolve(new URL(import.meta.url).pathname);
if (invokedPath === thisPath) {
  startHttpServer();
}
