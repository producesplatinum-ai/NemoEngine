import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
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
  createIdeogramNodeHandler,
  imageProviderFromEndpointPath,
  proxyLeonardoMcpRequest,
} from './image-provider-server.mjs';

import {
  classifyMobileRestRequest,
  deriveMobileRestBasePath,
  executeMobileRestRoute,
  isMobileRestWriteRoute,
  isMobileRestPostOnlyRoute,
} from './sillytavern-mobile-rest.mjs';

import {
  buildExactNemoPreset,
  listExactNemoCatalog,
  semanticSha256,
} from './nemo-exact-catalog.mjs';

import {
  applyOpenAiPresetToSettings,
} from './openai-preset-activation.mjs';

import {
  buildNemoPortableContext,
  compileNemoInstructions,
  sanitizeNemoOutput,
} from './nemo-mobile-generation.mjs';

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

export function buildCharacterGenerationMessages({
  character,
  characterName = '',
  conversation = [],
  linkedWorldInfo = null,
} = {}) {
  const data =
    character?.data && typeof character.data === 'object' && !Array.isArray(character.data)
      ? character.data
      : {};
  const extensions =
    data?.extensions && typeof data.extensions === 'object' && !Array.isArray(data.extensions)
      ? data.extensions
      : {};
  const resolvedName = String(
    characterName || data.name || character?.name || 'Assistant',
  ).trim() || 'Assistant';

  const normalizedConversation = Array.isArray(conversation)
    ? conversation.filter(
        (entry) =>
          entry &&
          typeof entry === 'object' &&
          typeof entry.mes === 'string' &&
          entry.mes.trim(),
      )
    : [];
  const transcript = normalizedConversation.map(entry => String(entry.mes)).join('\n');
  const transcriptLower = transcript.toLocaleLowerCase('ru-RU');

  const normalizeEntries = (book) => {
    const entries = book?.entries;
    if (Array.isArray(entries)) return entries;
    if (entries && typeof entries === 'object') return Object.values(entries);
    return [];
  };

  const books = [];
  if (data.character_book && typeof data.character_book === 'object') {
    books.push(data.character_book);
  }
  if (linkedWorldInfo && typeof linkedWorldInfo === 'object') {
    books.push(linkedWorldInfo);
  }

  const loreContents = [];
  const seenLore = new Set();
  for (const book of books) {
    for (const entry of normalizeEntries(book)) {
      if (!entry || typeof entry !== 'object' || entry.enabled === false) continue;
      const content = String(entry.content || '').trim();
      if (!content || seenLore.has(content)) continue;

      let active = entry.constant === true;
      if (!active) {
        const keys = Array.isArray(entry.keys)
          ? entry.keys
          : Array.isArray(entry.key)
            ? entry.key
            : [];
        active = keys
          .map(value => String(value || '').trim())
          .filter(Boolean)
          .some((key) => {
            if (entry.use_regex === true) {
              try {
                return new RegExp(key, 'iu').test(transcript);
              } catch {
                // Fall back to literal matching.
              }
            }
            return transcriptLower.includes(key.toLocaleLowerCase('ru-RU'));
          });
      }

      if (!active) continue;
      seenLore.add(content);
      loreContents.push(content);
    }
  }

  const systemParts = [
    `You are ${resolvedName}. Reply as this character and do not speak for the user.`,
    data.system_prompt || '',
    character?.description || data.description || '',
    character?.personality || data.personality || '',
    character?.scenario || data.scenario || '',
    data.mes_example
      ? `Character dialogue examples:\n${String(data.mes_example).trim()}`
      : '',
    loreContents.length
      ? `Active character lore:\n${loreContents.join('\n\n')}`
      : '',
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean);

  const messages = [];
  if (systemParts.length) {
    messages.push({ role: 'system', content: systemParts.join('\n\n') });
  }

  for (const entry of normalizedConversation) {
    messages.push({
      role: entry.is_system ? 'system' : entry.is_user ? 'user' : 'assistant',
      content: String(entry.mes),
    });
  }

  const depthPrompt =
    extensions?.depth_prompt &&
    typeof extensions.depth_prompt === 'object' &&
    !Array.isArray(extensions.depth_prompt)
      ? extensions.depth_prompt
      : null;
  const depthContent = String(depthPrompt?.prompt || '').trim();
  if (depthContent) {
    const requestedRole = String(depthPrompt?.role || 'system').trim().toLowerCase();
    const role = ['system', 'user', 'assistant'].includes(requestedRole)
      ? requestedRole
      : 'system';
    const rawDepth = Number.parseInt(depthPrompt?.depth, 10);
    const depth = Number.isFinite(rawDepth) && rawDepth >= 0 ? rawDepth : 0;
    const floor = systemParts.length ? 1 : 0;
    const insertAt = Math.max(floor, messages.length - depth);
    messages.splice(insertAt, 0, { role, content: depthContent });
  }

  const postHistory = String(data.post_history_instructions || '').trim();
  if (postHistory) {
    messages.push({ role: 'system', content: postHistory });
  }

  return messages;
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

function isAmbiguousTransportFailure(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /fetch failed|ECONNRESET|ECONNREFUSED|socket|UND_ERR/i.test(message);
}

export function createSerialTaskQueue() {
  let tail = Promise.resolve();

  return function enqueue(task) {
    if (typeof task !== 'function') {
      throw new TypeError('Queued task must be a function.');
    }

    const run = tail.then(() => task());
    tail = run.catch(() => undefined);
    return run;
  };
}

export function isDaryaImportAuthorized(suppliedToken, expectedToken) {
  const supplied = String(suppliedToken || '').trim();
  const expected = String(expectedToken || '').trim();
  if (supplied.length < 16 || expected.length < 16) return false;
  const a = createHash('sha256').update(supplied, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function characterCardSemanticCore(card) {
  const data =
    card?.data && typeof card.data === 'object' && !Array.isArray(card.data)
      ? card.data
      : {};
  return {
    spec: card?.spec ?? '',
    spec_version: card?.spec_version ?? '',
    data,
  };
}

function sameCharacterCardData(left, right) {
  return (
    semanticSha256(characterCardSemanticCore(left)) ===
    semanticSha256(characterCardSemanticCore(right))
  );
}

function isCharacterGetNotFound(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('/api/characters/get') && message.includes('HTTP 404');
}

export class SillyTavernClient {
  constructor({
    baseUrl,
    username = '',
    password = '',
    fetchImpl = globalThis.fetch,
    nemoCompiler = compileNemoInstructions,
    nemoOutputSanitizer = sanitizeNemoOutput,
  }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.username = username;
    this.password = password;
    this.fetchImpl = fetchImpl;
    this.nemoCompiler = nemoCompiler;
    this.nemoOutputSanitizer = nemoOutputSanitizer;
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

  async getBuffer(pathname) {
    await this.bootstrapSession();

    const headers = {
      ...this.authHeaders(),
      accept: '*/*',
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

    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers?.get?.('content-type') || 'application/octet-stream',
    };
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

  async postRaw(pathname, body, extraHeaders = {}) {
    await this.bootstrapSession();

    if (!Buffer.isBuffer(body)) {
      throw new Error('Raw request body must be a Buffer.');
    }

    const headers = {
      ...this.authHeaders(),
      accept: 'application/json',
      'content-type': 'application/octet-stream',
      'x-csrf-token': this.csrfToken,
      ...extraHeaders,
    };
    if (this.cookie) headers.cookie = this.cookie;

    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method: 'POST',
      headers,
      body,
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

  async postForm(pathname, form) {
    await this.bootstrapSession();

    if (!(form instanceof FormData)) {
      throw new Error('FormData body is required.');
    }

    const headers = {
      ...this.authHeaders(),
      accept: 'application/json',
      'x-csrf-token': this.csrfToken,
    };
    if (this.cookie) headers.cookie = this.cookie;

    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method: 'POST',
      headers,
      body: form,
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

  async importDaryaSourceFile({ relativePath, sha256, body, token }) {
    const normalizedPath = String(relativePath || '').trim();
    const normalizedSha = String(sha256 || '').trim().toLowerCase();
    const normalizedToken = String(token || '').trim();

    if (!normalizedPath) throw new Error('relativePath is required.');
    if (!/^[0-9a-f]{64}$/.test(normalizedSha)) {
      throw new Error('sha256 must be a 64-character hex digest.');
    }
    if (!Buffer.isBuffer(body)) throw new Error('body must be a Buffer.');
    if (normalizedToken.length < 16) throw new Error('Darya import token is unavailable.');

    return this.postRaw(
      '/api/plugins/darya-source-import/file',
      body,
      {
        'x-darya-import-token': normalizedToken,
        'x-darya-path': normalizedPath,
        'x-darya-sha256': normalizedSha,
      },
    );
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

  // Native SillyTavern user persona: avatar + settings-backed descriptor.
  async createPersona({ avatarId, personaName, description = '' }) {
    const normalizedAvatarId = String(avatarId || '').trim();
    const normalizedPersonaName = String(personaName || '').trim();
    const normalizedDescription = description == null ? '' : String(description);

    if (!normalizedAvatarId) throw new Error('avatarId is required.');
    if (!normalizedPersonaName) throw new Error('personaName is required.');

    const bundle = await this.post('/api/settings/get', {});
    const rawSettings = bundle?.settings;
    const settings =
      typeof rawSettings === 'string'
        ? JSON.parse(rawSettings)
        : rawSettings && typeof rawSettings === 'object'
          ? structuredClone(rawSettings)
          : {};

    const nextSettings = structuredClone(settings);
    if (!nextSettings.power_user || typeof nextSettings.power_user !== 'object' || Array.isArray(nextSettings.power_user)) {
      nextSettings.power_user = {};
    }
    if (!nextSettings.power_user.personas || typeof nextSettings.power_user.personas !== 'object' || Array.isArray(nextSettings.power_user.personas)) {
      nextSettings.power_user.personas = {};
    }
    if (!nextSettings.power_user.persona_descriptions || typeof nextSettings.power_user.persona_descriptions !== 'object' || Array.isArray(nextSettings.power_user.persona_descriptions)) {
      nextSettings.power_user.persona_descriptions = {};
    }

    const descriptor = {
      description: normalizedDescription,
      position: 0,
      depth: 2,
      role: 0,
      lorebook: '',
      title: '',
    };
    const existingName = nextSettings.power_user.personas[normalizedAvatarId];
    const existingDescriptor = nextSettings.power_user.persona_descriptions[normalizedAvatarId];

    if (existingName != null) {
      if (
        existingName !== normalizedPersonaName ||
        JSON.stringify(existingDescriptor || {}) !== JSON.stringify(descriptor)
      ) {
        throw new Error(`Persona ${normalizedAvatarId} already exists with different data.`);
      }

      if (
        nextSettings.user_avatar === normalizedAvatarId &&
        nextSettings.power_user.default_persona === normalizedAvatarId
      ) {
        return {
          ok: true,
          avatarId: normalizedAvatarId,
          personaName: normalizedPersonaName,
          active: true,
          defaultPersona: true,
          deduplicated: true,
        };
      }

      nextSettings.user_avatar = normalizedAvatarId;
      nextSettings.power_user.default_persona = normalizedAvatarId;
      await this.post('/api/settings/save', nextSettings);
      return {
        ok: true,
        avatarId: normalizedAvatarId,
        personaName: normalizedPersonaName,
        active: true,
        defaultPersona: true,
        deduplicated: false,
      };
    }

    const sourceAvatar = String(nextSettings.user_avatar || 'user-default.png').trim() || 'user-default.png';
    const sourcePath = `/User Avatars/${encodeURIComponent(sourceAvatar)}`;
    const avatar = await this.getBuffer(sourcePath);
    const form = new FormData();
    form.append(
      'avatar',
      new Blob([avatar.buffer], { type: avatar.contentType || 'image/png' }),
      'avatar.png',
    );
    form.append('overwrite_name', normalizedAvatarId);
    const uploadResult = await this.postForm('/api/avatars/upload', form);
    if (uploadResult?.path && String(uploadResult.path) !== normalizedAvatarId) {
      throw new Error('SillyTavern avatar upload returned an unexpected persona path.');
    }

    nextSettings.power_user.personas[normalizedAvatarId] = normalizedPersonaName;
    nextSettings.power_user.persona_descriptions[normalizedAvatarId] = descriptor;
    nextSettings.user_avatar = normalizedAvatarId;
    nextSettings.power_user.default_persona = normalizedAvatarId;

    await this.post('/api/settings/save', nextSettings);

    return {
      ok: true,
      avatarId: normalizedAvatarId,
      personaName: normalizedPersonaName,
      active: true,
      defaultPersona: true,
      deduplicated: false,
    };
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

  async deleteOpenAiPreset({ name, fallbackName = '' }) {
    const normalizedName = String(name || '').trim();
    const normalizedFallback = String(fallbackName || '').trim();
    if (!normalizedName) throw new Error('Preset name is required.');

    const bundle = await this.post('/api/settings/get', {});
    const rawSettings = bundle?.settings;
    const settings =
      typeof rawSettings === 'string'
        ? JSON.parse(rawSettings)
        : rawSettings && typeof rawSettings === 'object'
          ? rawSettings
          : {};

    const activeName = String(
      settings?.oai_settings?.preset_settings_openai || '',
    ).trim();

    let fallbackApplied = '';
    if (activeName === normalizedName) {
      if (!normalizedFallback) {
        throw new Error('fallbackName is required when deleting the active preset.');
      }

      const names = Array.isArray(bundle?.openai_setting_names)
        ? bundle.openai_setting_names
        : [];
      const values = Array.isArray(bundle?.openai_settings)
        ? bundle.openai_settings
        : [];
      const index = names.indexOf(normalizedFallback);
      if (index < 0 || index >= values.length) {
        throw new Error('Fallback preset was not found.');
      }

      const rawPreset = values[index];
      let preset = rawPreset;
      if (typeof rawPreset === 'string') {
        preset = JSON.parse(rawPreset);
      }
      if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
        throw new Error('Fallback preset is invalid.');
      }

      const nextSettings = applyOpenAiPresetToSettings(
        settings,
        preset,
        normalizedFallback,
      );
      await this.post('/api/settings/save', nextSettings);
      fallbackApplied = normalizedFallback;
    }

    await this.post('/api/presets/delete', {
      apiId: 'openai',
      name: normalizedName,
    });

    return {
      ok: true,
      deleted: normalizedName,
      fallbackApplied,
    };
  }

  listExactNemoCatalog() {
    return listExactNemoCatalog();
  }

  async installExactNemoCatalogEntry(entryId) {
    const built = await buildExactNemoPreset(entryId);
    const saved = await this.saveOpenAiPreset({
      name: built.entry.name,
      preset: built.preset,
    });
    return {
      ok: true,
      entryId,
      kind: built.entry.kind,
      family: built.entry.family,
      name: saved.name,
      identifier: built.entry.identifier || '',
      group: built.entry.group || '',
      sourceRawSha256: built.sourceRawSha256,
      sourceSemanticSha256: built.sourceSemanticSha256,
      presetSemanticSha256: built.presetSemanticSha256,
      semanticExact:
        built.entry.kind === 'canonical'
          ? built.sourceSemanticSha256 === built.presetSemanticSha256
          : true,
      activePrompts: Array.isArray(built.preset?.prompt_order?.[0]?.order)
        ? built.preset.prompt_order[0].order.filter((entry) => entry.enabled).length
        : null,
    };
  }

  async installAllExactNemoCatalog() {
    const catalog = listExactNemoCatalog();
    const results = [];
    for (const entry of catalog) {
      results.push(await this.installExactNemoCatalogEntry(entry.id));
    }
    return {
      ok: true,
      installed: results.length,
      verified: results.filter((item) => item.semanticExact).length,
      semanticManifestSha256: semanticSha256(
        results.map((item) => ({
          entryId: item.entryId,
          name: item.name,
          presetSemanticSha256: item.presetSemanticSha256,
        })),
      ),
      profiles: results,
    };
  }

  async activateExactNemoCatalogEntry(entryId) {
    const built = await buildExactNemoPreset(entryId);
    const slotName = 'Nemo Exact Active';

    const saved = await this.saveOpenAiPreset({
      name: slotName,
      preset: built.preset,
    });

    const beforeBundle = await this.post('/api/settings/get', {});
    const rawSettings = beforeBundle?.settings;
    const currentSettings =
      typeof rawSettings === 'string'
        ? JSON.parse(rawSettings)
        : rawSettings && typeof rawSettings === 'object'
          ? rawSettings
          : {};
    const nextSettings = applyOpenAiPresetToSettings(
      currentSettings,
      built.preset,
      saved.name || slotName,
    );

    let recoveredAfterRestart = false;
    let afterBundle = null;
    try {
      await this.post('/api/settings/save', nextSettings);
      afterBundle = await this.post('/api/settings/get', {});
    } catch (error) {
      if (!isAmbiguousTransportFailure(error)) throw error;

      // The settings mutation may have completed before SillyTavern restarted.
      // Never resend the mutation. Re-bootstrap and verify with read-only calls.
      recoveredAfterRestart = true;
      let lastError = error;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        this.csrfToken = '';
        this.cookie = '';
        try {
          afterBundle = await this.post('/api/settings/get', {});
          break;
        } catch (readError) {
          lastError = readError;
          if (attempt < 19) await delay(500);
        }
      }
      if (!afterBundle) throw lastError;
    }
    const afterRaw = afterBundle?.settings;
    const afterSettings =
      typeof afterRaw === 'string'
        ? JSON.parse(afterRaw)
        : afterRaw && typeof afterRaw === 'object'
          ? afterRaw
          : {};

    const names = Array.isArray(afterBundle?.openai_setting_names)
      ? afterBundle.openai_setting_names
      : [];
    const values = Array.isArray(afterBundle?.openai_settings)
      ? afterBundle.openai_settings
      : [];
    const presetIndex = names.indexOf(saved.name || slotName);
    let storedPreset = null;
    if (presetIndex >= 0 && presetIndex < values.length) {
      const value = values[presetIndex];
      if (typeof value === 'string') {
        try {
          storedPreset = JSON.parse(value);
        } catch {
          storedPreset = null;
        }
      } else if (value && typeof value === 'object') {
        storedPreset = value;
      }
    }

    const expectedSettings = applyOpenAiPresetToSettings(
      currentSettings,
      built.preset,
      saved.name || slotName,
    );
    const storedPresetExact =
      Boolean(storedPreset) &&
      semanticSha256(storedPreset) === built.presetSemanticSha256;
    const activeSettingsExact =
      Boolean(afterSettings?.oai_settings) &&
      semanticSha256(afterSettings.oai_settings) ===
        semanticSha256(expectedSettings.oai_settings);

    if (!storedPresetExact || !activeSettingsExact) {
      throw new Error('Exact Nemo active-slot verification failed.');
    }

    return {
      ok: true,
      entryId,
      kind: built.entry.kind,
      family: built.entry.family,
      identifier: built.entry.identifier || '',
      group: built.entry.group || '',
      slotName: saved.name || slotName,
      sourceRawSha256: built.sourceRawSha256,
      sourceSemanticSha256: built.sourceSemanticSha256,
      presetSemanticSha256: built.presetSemanticSha256,
      storedPresetExact,
      activeSettingsExact,
      recoveredAfterRestart,
      activePrompts: Array.isArray(built.preset?.prompt_order?.[0]?.order)
        ? built.preset.prompt_order[0].order.filter((entry) => entry.enabled).length
        : null,
    };
  }

  getCharacter(avatarUrl) {
    return this.post('/api/characters/get', { avatar_url: avatarUrl });
  }

  async exportCharacterJson(avatarUrl) {
    const normalizedAvatarUrl = String(avatarUrl || '').trim();
    if (!normalizedAvatarUrl) throw new Error('avatarUrl is required.');
    return this.post('/api/characters/export', {
      format: 'json',
      avatar_url: normalizedAvatarUrl,
    });
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

    const normalizedFileName = String(fileName || '')
      .trim()
      .replace(/\.png$/i, '');
    if (normalizedFileName) {
      const candidateAvatarUrl = `${normalizedFileName}.png`;
      let existing = null;
      try {
        existing = await this.getCharacter(candidateAvatarUrl);
      } catch (error) {
        if (!isCharacterGetNotFound(error)) throw error;
      }

      if (existing) {
        if (sameCharacterCardData(existing, card)) {
          return {
            ok: true,
            avatarUrl: candidateAvatarUrl,
            characterName: name,
            deduplicated: true,
          };
        }
        throw new Error(
          `Character file ${candidateAvatarUrl} already exists with different data. Use character_update.`,
        );
      }
    }

    const depthPrompt =
      extensions?.depth_prompt &&
      typeof extensions.depth_prompt === 'object' &&
      !Array.isArray(extensions.depth_prompt)
        ? extensions.depth_prompt
        : {};

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
      fav: String(Boolean(extensions.fav ?? card.fav ?? false)),
      world: String(extensions.world ?? card.world ?? ''),
      depth_prompt_prompt: String(depthPrompt.prompt ?? ''),
      depth_prompt_depth: Number.isFinite(Number(depthPrompt.depth))
        ? Number(depthPrompt.depth)
        : 4,
      depth_prompt_role: String(depthPrompt.role ?? 'system'),
      extensions: JSON.stringify(extensions),
      json_data: JSON.stringify(card),
    };

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

  async importCharacterJson({ card, fileName = '' }) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) {
      throw new Error('Character card must be an object.');
    }

    const created = await this.createCharacter({ card, fileName });
    return {
      ...created,
      imported: true,
    };
  }

  async updateCharacter({ avatarUrl, card }) {
    const normalizedAvatarUrl = String(avatarUrl || '').trim();
    if (!normalizedAvatarUrl) throw new Error('avatarUrl is required.');
    if (!card || typeof card !== 'object' || Array.isArray(card)) {
      throw new Error('Character card must be an object.');
    }

    const existing = await this.getCharacter(normalizedAvatarUrl);
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

    if (sameCharacterCardData(existing, card)) {
      return {
        ok: true,
        avatarUrl: normalizedAvatarUrl,
        characterName: name,
        deduplicated: true,
      };
    }

    const depthPrompt =
      extensions?.depth_prompt &&
      typeof extensions.depth_prompt === 'object' &&
      !Array.isArray(extensions.depth_prompt)
        ? extensions.depth_prompt
        : {};

    const payload = {
      avatar_url: normalizedAvatarUrl,
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
      fav: String(Boolean(extensions.fav ?? card.fav ?? false)),
      world: String(extensions.world ?? card.world ?? ''),
      depth_prompt_prompt: String(depthPrompt.prompt ?? ''),
      depth_prompt_depth: Number.isFinite(Number(depthPrompt.depth))
        ? Number(depthPrompt.depth)
        : 4,
      depth_prompt_role: String(depthPrompt.role ?? 'system'),
      extensions: JSON.stringify(extensions),
      json_data: JSON.stringify(card),
      chat: existing?.chat ?? '',
      create_date: existing?.create_date ?? '',
    };

    await this.post('/api/characters/edit', payload);
    return {
      ok: true,
      avatarUrl: normalizedAvatarUrl,
      characterName: name,
    };
  }

  async patchCharacter({ avatarUrl, patch }) {
    const normalizedAvatarUrl = String(avatarUrl || '').trim();
    if (!normalizedAvatarUrl) throw new Error('avatarUrl is required.');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('Character patch must be an object.');
    }

    const existing = await this.getCharacter(normalizedAvatarUrl);
    const next = JSON.parse(JSON.stringify(existing || {}));
    for (const key of [
      'avatar',
      'chat',
      'create_date',
      'date_added',
      'chat_size',
      'date_last_chat',
      'data_size',
    ]) {
      delete next[key];
    }

    if (!next?.data || typeof next.data !== 'object' || Array.isArray(next.data)) {
      throw new Error('Character card data is unavailable.');
    }

    const dataPatch =
      patch?.data && typeof patch.data === 'object' && !Array.isArray(patch.data)
        ? patch.data
        : {};
    const allowedDataKeys = new Set([
      'description',
      'creator_notes',
      'character_version',
      'extensions',
    ]);
    for (const key of Object.keys(dataPatch)) {
      if (!allowedDataKeys.has(key)) {
        throw new Error(`Unsupported character patch data field: ${key}`);
      }
    }

    for (const key of ['description', 'creator_notes', 'character_version']) {
      if (Object.prototype.hasOwnProperty.call(dataPatch, key)) {
        if (typeof dataPatch[key] !== 'string') {
          throw new Error(`Character patch data.${key} must be a string.`);
        }
        next.data[key] = dataPatch[key];
      }
    }

    if (Object.prototype.hasOwnProperty.call(dataPatch, 'extensions')) {
      const extensionPatch = dataPatch.extensions;
      if (
        !extensionPatch ||
        typeof extensionPatch !== 'object' ||
        Array.isArray(extensionPatch)
      ) {
        throw new Error('Character patch data.extensions must be an object.');
      }
      if (
        !next.data.extensions ||
        typeof next.data.extensions !== 'object' ||
        Array.isArray(next.data.extensions)
      ) {
        next.data.extensions = {};
      }
      Object.assign(next.data.extensions, extensionPatch);
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'characterBookEntries')) {
      if (!Array.isArray(patch.characterBookEntries)) {
        throw new Error('characterBookEntries must be an array.');
      }
      const entries = next.data?.character_book?.entries;
      if (!entries || (typeof entries !== 'object' && !Array.isArray(entries))) {
        throw new Error('Character card has no patchable character book entries.');
      }

      const availableEntries = Array.isArray(entries)
        ? entries
        : Object.values(entries);
      for (const entryPatch of patch.characterBookEntries) {
        if (
          !entryPatch ||
          typeof entryPatch !== 'object' ||
          Array.isArray(entryPatch) ||
          !Number.isInteger(entryPatch.id) ||
          entryPatch.id < 0
        ) {
          throw new Error('Each characterBookEntries patch requires a non-negative integer id.');
        }
        const unsupportedKeys = Object.keys(entryPatch).filter(
          (key) => key !== 'id' && key !== 'content',
        );
        if (unsupportedKeys.length) {
          throw new Error(
            `Unsupported character book patch field: ${unsupportedKeys[0]}`,
          );
        }
        if (typeof entryPatch.content !== 'string') {
          throw new Error('Character book patch content must be a string.');
        }
        const target = availableEntries.find(
          (entry) => Number(entry?.id ?? entry?.uid) === entryPatch.id,
        );
        if (!target) {
          throw new Error(`Character book entry ${entryPatch.id} does not exist.`);
        }
        target.content = entryPatch.content;
      }
    }

    return this.updateCharacter({
      avatarUrl: normalizedAvatarUrl,
      card: next,
    });
  }

  async bindCharacterWorld({ avatarUrl, name }) {
    const normalizedAvatarUrl = String(avatarUrl || '').trim();
    const worldName = String(name || '').trim();
    if (!normalizedAvatarUrl) throw new Error('avatarUrl is required.');
    if (!worldName) throw new Error('name is required.');

    if (!(await this.worldInfoExists(worldName))) {
      throw new Error(`World info ${worldName} does not exist.`);
    }

    const existing = await this.getCharacter(normalizedAvatarUrl);
    const next = JSON.parse(JSON.stringify(existing || {}));
    for (const key of [
      'avatar',
      'chat',
      'create_date',
      'date_added',
      'chat_size',
      'date_last_chat',
      'data_size',
    ]) {
      delete next[key];
    }

    if (
      !next?.data ||
      typeof next.data !== 'object' ||
      Array.isArray(next.data)
    ) {
      throw new Error('Character card data is unavailable.');
    }
    if (
      !next.data.extensions ||
      typeof next.data.extensions !== 'object' ||
      Array.isArray(next.data.extensions)
    ) {
      next.data.extensions = {};
    }

    const data = next.data;
    const extensions = data.extensions;
    const currentWorld = String(extensions.world ?? '').trim();
    if (currentWorld === worldName) {
      return {
        ok: true,
        avatarUrl: normalizedAvatarUrl,
        characterName: String(data.name || next.name || '').trim(),
        world: worldName,
        deduplicated: true,
      };
    }
    if (currentWorld) {
      throw new Error(
        `Character is already bound to ${currentWorld}. Unbind first.`,
      );
    }

    const bindingKey = 'sillytavern_mobile_world_binding';
    if (
      !extensions[bindingKey] ||
      typeof extensions[bindingKey] !== 'object' ||
      Array.isArray(extensions[bindingKey])
    ) {
      extensions[bindingKey] = {
        managed: true,
        previousCharacterBook:
          Object.prototype.hasOwnProperty.call(data, 'character_book')
            ? JSON.parse(JSON.stringify(data.character_book))
            : null,
      };
    }

    extensions.world = worldName;

    const updated = await this.updateCharacter({
      avatarUrl: normalizedAvatarUrl,
      card: next,
    });
    return {
      ...updated,
      world: worldName,
    };
  }

  async unbindCharacterWorld({ avatarUrl }) {
    const normalizedAvatarUrl = String(avatarUrl || '').trim();
    if (!normalizedAvatarUrl) throw new Error('avatarUrl is required.');

    const existing = await this.getCharacter(normalizedAvatarUrl);
    const next = JSON.parse(JSON.stringify(existing || {}));
    for (const key of [
      'avatar',
      'chat',
      'create_date',
      'date_added',
      'chat_size',
      'date_last_chat',
      'data_size',
    ]) {
      delete next[key];
    }

    if (
      !next?.data ||
      typeof next.data !== 'object' ||
      Array.isArray(next.data)
    ) {
      throw new Error('Character card data is unavailable.');
    }
    if (
      !next.data.extensions ||
      typeof next.data.extensions !== 'object' ||
      Array.isArray(next.data.extensions)
    ) {
      next.data.extensions = {};
    }

    const data = next.data;
    const extensions = data.extensions;
    const currentWorld = String(extensions.world ?? '').trim();
    const bindingKey = 'sillytavern_mobile_world_binding';
    const binding =
      extensions[bindingKey] &&
      typeof extensions[bindingKey] === 'object' &&
      !Array.isArray(extensions[bindingKey])
        ? extensions[bindingKey]
        : null;

    if (!currentWorld && !binding) {
      return {
        ok: true,
        avatarUrl: normalizedAvatarUrl,
        characterName: String(data.name || next.name || '').trim(),
        world: '',
        deduplicated: true,
      };
    }

    extensions.world = '';

    if (binding?.managed === true) {
      if (binding.previousCharacterBook == null) {
        delete data.character_book;
      } else {
        data.character_book = JSON.parse(
          JSON.stringify(binding.previousCharacterBook),
        );
      }
      delete extensions[bindingKey];
    } else if (
      currentWorld &&
      data.character_book &&
      typeof data.character_book === 'object' &&
      String(data.character_book.name || '').trim() === currentWorld
    ) {
      delete data.character_book;
    }

    const updated = await this.updateCharacter({
      avatarUrl: normalizedAvatarUrl,
      card: next,
    });
    return {
      ...updated,
      world: '',
    };
  }

  async deleteCharacter({ avatarUrl, deleteChats = false }) {
    const normalizedAvatarUrl = String(avatarUrl || '').trim();
    if (!normalizedAvatarUrl) throw new Error('avatarUrl is required.');
    if (typeof deleteChats !== 'boolean') {
      throw new Error('deleteChats must be a boolean.');
    }

    try {
      await this.getCharacter(normalizedAvatarUrl);
    } catch (error) {
      if (isCharacterGetNotFound(error)) {
        return {
          ok: true,
          deleted: false,
          deduplicated: true,
          alreadyAbsent: true,
          avatarUrl: normalizedAvatarUrl,
          deleteChats,
        };
      }
      throw error;
    }

    try {
      await this.post('/api/characters/delete', {
        avatar_url: normalizedAvatarUrl,
        delete_chats: deleteChats,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes('/api/characters/delete') &&
        message.includes('HTTP 400')
      ) {
        try {
          await this.getCharacter(normalizedAvatarUrl);
        } catch (verifyError) {
          if (isCharacterGetNotFound(verifyError)) {
            return {
              ok: true,
              deleted: false,
              deduplicated: true,
              alreadyAbsent: true,
              avatarUrl: normalizedAvatarUrl,
              deleteChats,
            };
          }
          throw verifyError;
        }
      }
      throw error;
    }

    return {
      ok: true,
      deleted: true,
      avatarUrl: normalizedAvatarUrl,
      deleteChats,
    };
  }

  async duplicateCharacter({ avatarUrl, newName, fileName = '' }) {
    const sourceAvatarUrl = String(avatarUrl || '').trim();
    const targetName = String(newName || '').trim();
    if (!sourceAvatarUrl) throw new Error('avatarUrl is required.');
    if (!targetName) throw new Error('newName is required.');

    const source = await this.getCharacter(sourceAvatarUrl);
    const card = JSON.parse(JSON.stringify(characterCardSemanticCore(source)));
    if (!card.data || typeof card.data !== 'object' || Array.isArray(card.data)) {
      card.data = {};
    }
    card.data.name = targetName;

    const targetFileName = String(fileName || targetName)
      .trim()
      .replace(/\.png$/i, '');
    const created = await this.createCharacter({
      card,
      fileName: targetFileName,
    });

    return {
      ...created,
      sourceAvatarUrl,
    };
  }

  async renameCharacter({ avatarUrl, newName }) {
    const oldAvatarUrl = String(avatarUrl || '').trim();
    const targetName = String(newName || '').trim();
    if (!oldAvatarUrl) throw new Error('avatarUrl is required.');
    if (!targetName) throw new Error('newName is required.');

    const findTargetMatches = async () => {
      const characters = await this.listCharacters();
      return Array.isArray(characters)
        ? characters.filter((character) => {
            const name = String(
              character?.data?.name ?? character?.name ?? '',
            ).trim();
            const avatar = String(character?.avatar ?? '').trim();
            return name === targetName && avatar !== oldAvatarUrl;
          })
        : [];
    };

    const resolveUniqueTarget = async () => {
      const matches = await findTargetMatches();
      if (matches.length > 1) {
        throw new Error(
          `Character rename is ambiguous: multiple characters already have the name ${targetName}.`,
        );
      }
      if (matches.length === 1) {
        const avatarUrl = String(matches[0]?.avatar ?? '').trim();
        if (!avatarUrl) {
          throw new Error('Renamed character match has no avatar filename.');
        }
        return avatarUrl;
      }
      return '';
    };

    let source;
    try {
      source = await this.getCharacter(oldAvatarUrl);
    } catch (error) {
      if (!isCharacterGetNotFound(error)) throw error;
      const alreadyRenamedAvatarUrl = await resolveUniqueTarget();
      if (!alreadyRenamedAvatarUrl) throw error;
      return {
        ok: true,
        oldAvatarUrl,
        avatarUrl: alreadyRenamedAvatarUrl,
        characterName: targetName,
        deduplicated: true,
      };
    }

    const currentName = String(
      source?.data?.name ?? source?.name ?? '',
    ).trim();
    if (currentName === targetName) {
      return {
        ok: true,
        oldAvatarUrl,
        avatarUrl: oldAvatarUrl,
        characterName: targetName,
        deduplicated: true,
      };
    }

    const occupiedTargets = await findTargetMatches();
    if (occupiedTargets.length > 0) {
      throw new Error(
        `Character name ${targetName} already exists. Choose another name.`,
      );
    }

    let renamedResult;
    try {
      renamedResult = await this.post('/api/characters/rename', {
        avatar_url: oldAvatarUrl,
        new_name: targetName,
      });
    } catch (error) {
      let sourceStillExists = true;
      try {
        await this.getCharacter(oldAvatarUrl);
      } catch (verifyError) {
        if (isCharacterGetNotFound(verifyError)) {
          sourceStillExists = false;
        } else {
          throw verifyError;
        }
      }
      if (!sourceStillExists) {
        const alreadyRenamedAvatarUrl = await resolveUniqueTarget();
        if (alreadyRenamedAvatarUrl) {
          return {
            ok: true,
            oldAvatarUrl,
            avatarUrl: alreadyRenamedAvatarUrl,
            characterName: targetName,
            deduplicated: true,
          };
        }
      }
      throw error;
    }

    const newAvatarUrl = String(renamedResult?.avatar ?? '').trim();
    if (!newAvatarUrl) {
      throw new Error('SillyTavern character rename returned no avatar filename.');
    }

    return {
      ok: true,
      oldAvatarUrl,
      avatarUrl: newAvatarUrl,
      characterName: targetName,
    };
  }

  listWorldInfo() {
    return this.post('/api/worldinfo/list', {});
  }

  getWorldInfo(name) {
    return this.post('/api/worldinfo/get', { name });
  }

  async worldInfoExists(name) {
    const target = String(name || '').trim();
    if (!target) throw new Error('name is required.');
    const items = await this.listWorldInfo();
    return Array.isArray(items) && items.some((item) =>
      String(item?.file_id || '') === target || String(item?.name || '') === target
    );
  }

  validateWorldInfoData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('World info data must be an object.');
    }
    if (!data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
      throw new Error('World info data must contain an entries object.');
    }
  }

  async verifyWorldInfoStored(name, expectedData, operation = 'write') {
    const target = String(name || '').trim();
    if (!(await this.worldInfoExists(target))) {
      throw new Error(
        `World info ${target} ${operation} returned success but the book did not persist.`,
      );
    }
    const stored = await this.getWorldInfo(target);
    if (semanticSha256(stored) !== semanticSha256(expectedData)) {
      throw new Error(
        `World info ${target} persisted with different data after ${operation}.`,
      );
    }
    return stored;
  }

  async verifyWorldInfoAbsent(name, operation = 'delete') {
    const target = String(name || '').trim();
    if (await this.worldInfoExists(target)) {
      throw new Error(
        `World info ${target} ${operation} returned success but the book still exists.`,
      );
    }
  }

  async createWorldInfo({ name, data }) {
    const target = String(name || '').trim();
    if (!target) throw new Error('name is required.');
    this.validateWorldInfoData(data);

    if (await this.worldInfoExists(target)) {
      const existing = await this.getWorldInfo(target);
      if (semanticSha256(existing) === semanticSha256(data)) {
        return { ok: true, name: target, created: false, deduplicated: true };
      }
      throw new Error(
        `World info ${target} already exists with different data. Use world_info_update.`,
      );
    }

    const json = JSON.stringify(data, null, 4);
    const form = new FormData();
    form.append(
      'avatar',
      new Blob([json], { type: 'application/json' }),
      `${target}.json`,
    );
    form.append('convertedData', json);

    const imported = await this.postForm('/api/worldinfo/import', form);
    const importedName = String(imported?.name || '').trim();
    if (importedName && importedName !== target) {
      throw new Error(
        `World info import returned unexpected name ${importedName}; expected ${target}.`,
      );
    }

    await this.verifyWorldInfoStored(target, data, 'import');
    return { ok: true, name: target, created: true };
  }

  async updateWorldInfo({ name, data }) {
    const target = String(name || '').trim();
    if (!target) throw new Error('name is required.');
    this.validateWorldInfoData(data);

    if (await this.worldInfoExists(target)) {
      const existing = await this.getWorldInfo(target);
      if (semanticSha256(existing) === semanticSha256(data)) {
        return { ok: true, name: target, updated: false, deduplicated: true };
      }
    }

    await this.post('/api/worldinfo/edit', { name: target, data });
    await this.verifyWorldInfoStored(target, data, 'update');
    return { ok: true, name: target, updated: true };
  }

  async saveWorldInfo({ name, data }) {
    const target = String(name || '').trim();
    if (!target) throw new Error('name is required.');
    this.validateWorldInfoData(data);

    if (await this.worldInfoExists(target)) {
      const existing = await this.getWorldInfo(target);
      if (semanticSha256(existing) === semanticSha256(data)) {
        return { ok: true, name: target, deduplicated: true };
      }
    }

    await this.post('/api/worldinfo/edit', { name: target, data });
    await this.verifyWorldInfoStored(target, data, 'save');
    return { ok: true, name: target, saved: true };
  }

  async deleteWorldInfo({ name }) {
    const target = String(name || '').trim();
    if (!target) throw new Error('name is required.');

    if (!(await this.worldInfoExists(target))) {
      return {
        ok: true,
        deleted: false,
        deduplicated: true,
        alreadyAbsent: true,
        name: target,
      };
    }

    try {
      await this.post('/api/worldinfo/delete', { name: target });
    } catch (error) {
      if (!(await this.worldInfoExists(target))) {
        return {
          ok: true,
          deleted: false,
          deduplicated: true,
          alreadyAbsent: true,
          name: target,
        };
      }
      throw error;
    }

    await this.verifyWorldInfoAbsent(target, 'delete');
    return { ok: true, deleted: true, name: target };
  }

  async upsertWorldInfoEntry({ name, uid, entry }) {
    const target = String(name || '').trim();
    if (!target) throw new Error('name is required.');
    if (!Number.isInteger(uid) || uid < 0) {
      throw new Error('uid must be a non-negative integer.');
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('entry must be an object.');
    }
    if (!(await this.worldInfoExists(target))) {
      throw new Error(`World info ${target} does not exist.`);
    }

    const current = await this.getWorldInfo(target);
    this.validateWorldInfoData(current);
    const next = JSON.parse(JSON.stringify(current));
    next.entries[String(uid)] = { ...entry, uid };

    if (semanticSha256(current) === semanticSha256(next)) {
      return { ok: true, name: target, uid, updated: false, deduplicated: true };
    }

    await this.post('/api/worldinfo/edit', { name: target, data: next });
    await this.verifyWorldInfoStored(target, next, 'entry upsert');
    return { ok: true, name: target, uid, updated: true };
  }

  async deleteWorldInfoEntry({ name, uid }) {
    const target = String(name || '').trim();
    if (!target) throw new Error('name is required.');
    if (!Number.isInteger(uid) || uid < 0) {
      throw new Error('uid must be a non-negative integer.');
    }
    if (!(await this.worldInfoExists(target))) {
      return {
        ok: true,
        name: target,
        uid,
        deleted: false,
        deduplicated: true,
        alreadyAbsent: true,
      };
    }

    const current = await this.getWorldInfo(target);
    this.validateWorldInfoData(current);
    if (!Object.prototype.hasOwnProperty.call(current.entries, String(uid))) {
      return {
        ok: true,
        name: target,
        uid,
        deleted: false,
        deduplicated: true,
        alreadyAbsent: true,
      };
    }

    const next = JSON.parse(JSON.stringify(current));
    delete next.entries[String(uid)];
    await this.post('/api/worldinfo/edit', { name: target, data: next });
    await this.verifyWorldInfoStored(target, next, 'entry delete');
    return { ok: true, name: target, uid, deleted: true };
  }

  recentChats() {
    return this.post('/api/chats/recent', {});
  }

  normalizeChatFileName(value) {
    return String(value || '').trim().replace(/\.jsonl$/i, '');
  }

  findCharacterChatInList(chats, { avatarUrl, fileName }) {
    const normalizedAvatarUrl = String(avatarUrl || '').trim();
    const normalizedFileName = this.normalizeChatFileName(fileName);
    if (!normalizedAvatarUrl || !normalizedFileName || !Array.isArray(chats)) {
      return null;
    }

    return chats.find((item) => {
      const avatar = String(item?.avatar || '').trim();
      const fileId = this.normalizeChatFileName(item?.file_id || '');
      const fileNameValue = this.normalizeChatFileName(item?.file_name || '');
      return (
        avatar === normalizedAvatarUrl &&
        (fileId === normalizedFileName || fileNameValue === normalizedFileName)
      );
    }) || null;
  }

  async findCharacterChat({ avatarUrl, fileName }) {
    const chats = await this.recentChats();
    return this.findCharacterChatInList(chats, { avatarUrl, fileName });
  }

  async createChat({ avatarUrl, fileName, nonce = '' }) {
    const normalizedAvatarUrl = String(avatarUrl || '').trim();
    const normalizedFileName = this.normalizeChatFileName(fileName);
    const normalizedNonce = String(nonce || '').trim();
    if (!normalizedAvatarUrl || !normalizedFileName) {
      throw new Error('avatarUrl and fileName are required.');
    }

    const character = await this.getCharacter(normalizedAvatarUrl);
    const characterName = String(
      character?.data?.name ?? character?.name ?? normalizedAvatarUrl.replace(/\.png$/i, ''),
    ).trim() || 'Assistant';

    const existingInfo = await this.findCharacterChat({
      avatarUrl: normalizedAvatarUrl,
      fileName: normalizedFileName,
    });
    if (existingInfo) {
      const existing = await this.getChat({
        avatarUrl: normalizedAvatarUrl,
        fileName: normalizedFileName,
      });
      const header = Array.isArray(existing) ? existing[0] : null;
      if (
        normalizedNonce &&
        header?.chat_metadata?.one_shot_nonce === normalizedNonce &&
        header?.chat_metadata?.one_shot_op === 'chat_create'
      ) {
        return {
          ok: true,
          created: false,
          deduplicated: true,
          avatarUrl: normalizedAvatarUrl,
          fileName: normalizedFileName,
        };
      }
      throw new Error(
        `Chat ${normalizedFileName} already exists for ${normalizedAvatarUrl}.`,
      );
    }

    const chat = [{
      user_name: 'You',
      character_name: characterName,
      create_date: new Date().toISOString(),
      chat_metadata: normalizedNonce
        ? {
            one_shot_nonce: normalizedNonce,
            one_shot_op: 'chat_create',
          }
        : {},
    }];

    await this.post('/api/chats/save', {
      ch_name: characterName,
      file_name: normalizedFileName,
      chat,
      avatar_url: normalizedAvatarUrl,
    });

    const persisted = await this.findCharacterChat({
      avatarUrl: normalizedAvatarUrl,
      fileName: normalizedFileName,
    });
    if (!persisted) {
      throw new Error(
        `Chat ${normalizedFileName} save returned success but the file did not persist.`,
      );
    }

    const stored = await this.getChat({
      avatarUrl: normalizedAvatarUrl,
      fileName: normalizedFileName,
    });
    const storedHeader = Array.isArray(stored) ? stored[0] : null;
    if (
      normalizedNonce &&
      (
        storedHeader?.chat_metadata?.one_shot_nonce !== normalizedNonce ||
        storedHeader?.chat_metadata?.one_shot_op !== 'chat_create'
      )
    ) {
      throw new Error(
        `Chat ${normalizedFileName} persisted without the expected create nonce.`,
      );
    }

    return {
      ok: true,
      created: true,
      avatarUrl: normalizedAvatarUrl,
      fileName: normalizedFileName,
    };
  }

  async renameChat({ avatarUrl, fileName, newFileName }) {
    const normalizedAvatarUrl = String(avatarUrl || '').trim();
    const oldName = this.normalizeChatFileName(fileName);
    const newName = this.normalizeChatFileName(newFileName);
    if (!normalizedAvatarUrl || !oldName || !newName) {
      throw new Error('avatarUrl, fileName, and newFileName are required.');
    }
    if (oldName === newName) {
      return {
        ok: true,
        renamed: false,
        deduplicated: true,
        alreadyRenamed: true,
        avatarUrl: normalizedAvatarUrl,
        fileName: newName,
        oldFileName: oldName,
      };
    }

    let chats = await this.recentChats();
    let source = this.findCharacterChatInList(chats, {
      avatarUrl: normalizedAvatarUrl,
      fileName: oldName,
    });
    let target = this.findCharacterChatInList(chats, {
      avatarUrl: normalizedAvatarUrl,
      fileName: newName,
    });

    if (!source) {
      if (target) {
        return {
          ok: true,
          renamed: false,
          deduplicated: true,
          alreadyRenamed: true,
          avatarUrl: normalizedAvatarUrl,
          fileName: newName,
          oldFileName: oldName,
        };
      }
      throw new Error(`Source chat ${oldName} does not exist.`);
    }
    if (target) {
      throw new Error(`Target chat ${newName} already exists.`);
    }

    try {
      await this.post('/api/chats/rename', {
        avatar_url: normalizedAvatarUrl,
        original_file: `${oldName}.jsonl`,
        renamed_file: `${newName}.jsonl`,
        is_group: false,
      });
    } catch (error) {
      chats = await this.recentChats();
      source = this.findCharacterChatInList(chats, {
        avatarUrl: normalizedAvatarUrl,
        fileName: oldName,
      });
      target = this.findCharacterChatInList(chats, {
        avatarUrl: normalizedAvatarUrl,
        fileName: newName,
      });
      if (!source && target) {
        return {
          ok: true,
          renamed: false,
          deduplicated: true,
          alreadyRenamed: true,
          avatarUrl: normalizedAvatarUrl,
          fileName: newName,
          oldFileName: oldName,
        };
      }
      throw error;
    }

    chats = await this.recentChats();
    source = this.findCharacterChatInList(chats, {
      avatarUrl: normalizedAvatarUrl,
      fileName: oldName,
    });
    target = this.findCharacterChatInList(chats, {
      avatarUrl: normalizedAvatarUrl,
      fileName: newName,
    });
    if (source || !target) {
      throw new Error(
        `Chat rename ${oldName} -> ${newName} returned success but the final state did not persist.`,
      );
    }

    return {
      ok: true,
      renamed: true,
      avatarUrl: normalizedAvatarUrl,
      fileName: newName,
      oldFileName: oldName,
    };
  }

  async deleteChat({ avatarUrl, fileName }) {
    const normalizedAvatarUrl = String(avatarUrl || '').trim();
    const normalizedFileName = this.normalizeChatFileName(fileName);
    if (!normalizedAvatarUrl || !normalizedFileName) {
      throw new Error('avatarUrl and fileName are required.');
    }

    let existing = await this.findCharacterChat({
      avatarUrl: normalizedAvatarUrl,
      fileName: normalizedFileName,
    });
    if (!existing) {
      return {
        ok: true,
        deleted: false,
        deduplicated: true,
        alreadyAbsent: true,
        avatarUrl: normalizedAvatarUrl,
        fileName: normalizedFileName,
      };
    }

    try {
      await this.post('/api/chats/delete', {
        avatar_url: normalizedAvatarUrl,
        chatfile: `${normalizedFileName}.jsonl`,
      });
    } catch (error) {
      existing = await this.findCharacterChat({
        avatarUrl: normalizedAvatarUrl,
        fileName: normalizedFileName,
      });
      if (!existing) {
        return {
          ok: true,
          deleted: false,
          deduplicated: true,
          alreadyAbsent: true,
          avatarUrl: normalizedAvatarUrl,
          fileName: normalizedFileName,
        };
      }
      throw error;
    }

    existing = await this.findCharacterChat({
      avatarUrl: normalizedAvatarUrl,
      fileName: normalizedFileName,
    });
    if (existing) {
      throw new Error(
        `Chat ${normalizedFileName} delete returned success but the file still exists.`,
      );
    }

    return {
      ok: true,
      deleted: true,
      avatarUrl: normalizedAvatarUrl,
      fileName: normalizedFileName,
    };
  }

  getChat({ avatarUrl, fileName }) {
    return this.post('/api/chats/get', {
      avatar_url: avatarUrl,
      file_name: fileName,
    });
  }

  async appendUserMessage({ avatarUrl, fileName, userText, nonce = '' }) {
    const character = await this.getCharacter(avatarUrl);
    const fallbackName = String(avatarUrl).replace(/\.png$/i, '');
    const characterName = String(
      character?.name || character?.data?.name || fallbackName || 'Assistant',
    ).trim();

    const existing = await this.getChat({ avatarUrl, fileName });
    const chat = Array.isArray(existing) ? existing.slice() : [];
    const normalizedNonce = String(nonce || '').trim();
    if (normalizedNonce) {
      const duplicate = chat.find(
        (entry) =>
          entry &&
          typeof entry === 'object' &&
          !Array.isArray(entry) &&
          entry?.extra?.one_shot_nonce === normalizedNonce &&
          entry?.extra?.one_shot_op === 'turn',
      );
      if (duplicate) {
        return {
          ok: true,
          saved: true,
          deduplicated: true,
          avatarUrl,
          fileName,
          characterName,
          messageCount: chat.length,
        };
      }
    }
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
      extra: normalizedNonce
        ? { one_shot_nonce: normalizedNonce, one_shot_op: 'turn' }
        : {},
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

  async generateAssistantMessage({ avatarUrl, fileName, source, model, nonce = '' }) {
    const character = await this.getCharacter(avatarUrl);
    const fallbackName = String(avatarUrl).replace(/\\.png$/i, '');
    const characterName = String(
      character?.name || character?.data?.name || fallbackName || 'Assistant',
    ).trim();

    const existing = await this.getChat({ avatarUrl, fileName });
    const chat = Array.isArray(existing) ? existing.slice() : [];
    const normalizedNonce = String(nonce || '').trim();
    if (normalizedNonce) {
      const duplicate = chat.find(
        (entry) =>
          entry &&
          typeof entry === 'object' &&
          !Array.isArray(entry) &&
          entry?.extra?.one_shot_nonce === normalizedNonce &&
          entry?.extra?.one_shot_op === 'generate' &&
          typeof entry.mes === 'string' &&
          entry.mes.trim(),
      );
      if (duplicate) {
        return {
          ok: true,
          saved: true,
          deduplicated: true,
          avatarUrl,
          fileName,
          characterName,
          source,
          model,
          message: String(duplicate.mes),
          finishReason: String(duplicate?.extra?.provider_finish_reason || ''),
          truncated: duplicate?.extra?.provider_finish_reason === 'length',
          messageCount: chat.length,
        };
      }
    }
    const conversation = chat.filter(
      (entry) => entry && typeof entry === 'object' && typeof entry.mes === 'string' && entry.mes.trim(),
    );
    if (!conversation.some((entry) => entry.is_user === true)) {
      throw new Error('Chat must contain a user message before generation.');
    }

    const data = character?.data && typeof character.data === 'object' ? character.data : {};
    let linkedWorldInfo = null;
    const embeddedEntries = data?.character_book?.entries;
    const hasEmbeddedLore =
      (Array.isArray(embeddedEntries) && embeddedEntries.length > 0) ||
      (
        embeddedEntries &&
        typeof embeddedEntries === 'object' &&
        !Array.isArray(embeddedEntries) &&
        Object.keys(embeddedEntries).length > 0
      );
    const linkedWorldName = String(data?.extensions?.world || '').trim();
    if (!hasEmbeddedLore && linkedWorldName) {
      try {
        linkedWorldInfo = await this.getWorldInfo(linkedWorldName);
      } catch {
        linkedWorldInfo = null;
      }
    }

    const messages = buildCharacterGenerationMessages({
      character,
      characterName,
      conversation,
      linkedWorldInfo,
    });

    const payload = await this.post('/api/backends/chat-completions/generate', {
      chat_completion_source: source,
      messages,
      model,
      temperature: 0.7,
      max_tokens: 2048,
      stream: false,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
      stop: [],
      seed: 0,
      logprobs: 0,
      include_reasoning: false,
    });

    const choice = payload?.choices?.[0] || {};
    const finishReason = String(choice?.finish_reason || '').trim();
    const message = String(
      choice?.message?.content ||
      choice?.text ||
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
      extra: normalizedNonce
        ? {
            one_shot_nonce: normalizedNonce,
            one_shot_op: 'generate',
            provider_finish_reason: finishReason,
          }
        : finishReason
          ? { provider_finish_reason: finishReason }
          : {},
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
      finishReason,
      truncated: finishReason === 'length',
      messageCount: chat.length,
    };
  }

  async generateNemoAssistantMessage({
    avatarUrl,
    fileName,
    entryId,
    source,
    model,
    nonce = '',
  }) {
    const character = await this.getCharacter(avatarUrl);
    const fallbackName = String(avatarUrl).replace(/\\.png$/i, '');
    const characterName = String(
      character?.name || character?.data?.name || fallbackName || 'Assistant',
    ).trim();

    const existing = await this.getChat({ avatarUrl, fileName });
    const chat = Array.isArray(existing) ? existing.slice() : [];
    const normalizedNonce = String(nonce || '').trim();
    if (normalizedNonce) {
      const duplicate = chat.find(
        (entry) =>
          entry &&
          typeof entry === 'object' &&
          !Array.isArray(entry) &&
          entry?.extra?.one_shot_nonce === normalizedNonce &&
          entry?.extra?.one_shot_op === 'nemo_generate' &&
          typeof entry.mes === 'string' &&
          entry.mes.trim(),
      );
      if (duplicate) {
        return {
          ok: true,
          saved: true,
          deduplicated: true,
          compiled: true,
          avatarUrl,
          fileName,
          characterName,
          entryId,
          source,
          model,
          message: String(duplicate.mes),
          finishReason: String(duplicate?.extra?.provider_finish_reason || ''),
          truncated: duplicate?.extra?.provider_finish_reason === 'length',
          presetSemanticSha256: String(duplicate?.extra?.nemo_preset_sha256 || ''),
          compiledSha256: String(duplicate?.extra?.nemo_compiled_sha256 || ''),
          compiledChars: Number(duplicate?.extra?.nemo_compiled_chars || 0),
          messageCount: chat.length,
        };
      }
    }

    const conversation = chat.filter(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof entry.mes === 'string' &&
        entry.mes.trim(),
    );
    if (!conversation.some((entry) => entry.is_user === true)) {
      throw new Error('Chat must contain a user message before Nemo generation.');
    }

    const data =
      character?.data && typeof character.data === 'object' ? character.data : {};
    let linkedWorldInfo = null;
    const embeddedEntries = data?.character_book?.entries;
    const hasEmbeddedLore =
      (Array.isArray(embeddedEntries) && embeddedEntries.length > 0) ||
      (
        embeddedEntries &&
        typeof embeddedEntries === 'object' &&
        !Array.isArray(embeddedEntries) &&
        Object.keys(embeddedEntries).length > 0
      );
    const linkedWorldName = String(data?.extensions?.world || '').trim();
    if (!hasEmbeddedLore && linkedWorldName) {
      try {
        linkedWorldInfo = await this.getWorldInfo(linkedWorldName);
      } catch {
        linkedWorldInfo = null;
      }
    }

    const built = await buildExactNemoPreset(entryId);
    const context = buildNemoPortableContext({
      character,
      characterName,
      conversation,
    });
    const compiled = await this.nemoCompiler({
      preset: built.preset,
      context,
      profile: '100001',
    });
    if (!compiled?.instructions || typeof compiled.instructions !== 'string') {
      throw new Error('Nemo compiler returned no portable instructions.');
    }

    const messages = buildCharacterGenerationMessages({
      character,
      characterName,
      conversation,
      linkedWorldInfo,
    });
    messages.unshift({
      role: 'system',
      content:
        'NemoEngine compiled portable runtime instructions follow. Apply them to the current character and conversation. Preserve user agency and return only the final user-facing response.\n\n' +
        compiled.instructions,
    });

    const tokenBudget = source === 'groq'
      ? { max_completion_tokens: 16_384 }
      : { max_tokens: 4096 };

    const groqReasoning =
      source === 'groq' && /(?:^|\/)gpt-oss-(?:20b|120b)$/i.test(model)
        ? { reasoning_effort: 'low', include_reasoning: false }
        : { include_reasoning: false };

    const payload = await this.post('/api/backends/chat-completions/generate', {
      chat_completion_source: source,
      messages,
      model,
      temperature: 0.7,
      ...tokenBudget,
      ...groqReasoning,
      stream: false,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
      stop: [],
      seed: 0,
      logprobs: 0,
    });

    if (payload?.error) {
      const providerError =
        payload.error && typeof payload.error === 'object' && !Array.isArray(payload.error)
          ? payload.error
          : { message: String(payload.error) };
      const providerMessage = String(providerError.message || 'Unknown provider error').trim();
      const providerType = String(providerError.type || '').trim();
      const providerCode = String(providerError.code || '').trim();
      const providerParam = String(providerError.param || '').trim();
      const details = [
        providerType && `type=${providerType}`,
        providerCode && `code=${providerCode}`,
        providerParam && `param=${providerParam}`,
      ].filter(Boolean).join('; ');
      throw new Error(
        `SillyTavern ${source} provider error: ${providerMessage}${details ? ` (${details})` : ''}.`,
      );
    }

    const choice = payload?.choices?.[0] || {};
    const finishReason = String(choice?.finish_reason || '').trim();
    const rawMessage = String(
      choice?.message?.content ||
      choice?.text ||
      '',
    ).trim();
    if (!rawMessage) {
      const responseMessage =
        choice?.message && typeof choice.message === 'object' && !Array.isArray(choice.message)
          ? choice.message
          : {};
      const reasoning = String(
        responseMessage?.reasoning ??
        responseMessage?.reasoning_content ??
        '',
      );
      const messageKeys = Object.keys(responseMessage).sort().join(',') || 'none';
      const completionTokens = Number(payload?.usage?.completion_tokens || 0);
      const reasoningTokens = Number(
        payload?.usage?.completion_tokens_details?.reasoning_tokens || 0,
      );
      throw new Error(
        `SillyTavern ${source} Nemo generation returned no message content ` +
        `(finish_reason=${finishReason || 'unknown'}; message_keys=${messageKeys}; ` +
        `reasoning_chars=${Array.from(reasoning).length}; ` +
        `completion_tokens=${completionTokens}; reasoning_tokens=${reasoningTokens}).`,
      );
    }
    const message = this.nemoOutputSanitizer(rawMessage);

    const nemoExtra = {
      one_shot_op: 'nemo_generate',
      provider_finish_reason: finishReason,
      nemo_entry_id: entryId,
      nemo_preset_sha256: built.presetSemanticSha256,
      nemo_compiled_sha256: String(compiled.sha256 || ''),
      nemo_compiled_chars: Number(compiled.chars || Array.from(compiled.instructions).length),
    };
    if (normalizedNonce) nemoExtra.one_shot_nonce = normalizedNonce;

    chat.push({
      name: characterName,
      is_user: false,
      is_system: false,
      send_date: new Date().toISOString(),
      mes: message,
      extra: nemoExtra,
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
      compiled: true,
      avatarUrl,
      fileName,
      characterName,
      entryId,
      presetName: built.entry.name,
      source,
      model,
      message,
      finishReason,
      truncated: finishReason === 'length',
      presetSemanticSha256: built.presetSemanticSha256,
      compiledSha256: String(compiled.sha256 || ''),
      compiledChars: Number(compiled.chars || Array.from(compiled.instructions).length),
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

  const imageProviderId = imageProviderFromEndpointPath(pathname, aiPrefix);
  if (imageProviderId) return { kind: 'image_provider', providerId: imageProviderId };

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
    if (params.has('fallbackName')) parsed.fallbackName = params.get('fallbackName') || '';
    if (params.has('presetJson')) parsed.presetJson = params.get('presetJson') || '';
    if (params.has('profileId')) parsed.profileId = params.get('profileId') || '';
    if (params.has('entryId')) parsed.entryId = params.get('entryId') || '';
    return parsed;
  }

  throw new Error('Unsupported content type.');
}

function readRawRequestBody(req, maxBytes = 100 * 1024 * 1024) {
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
      chunks.push(Buffer.from(chunk));
    });

    req.on('end', () => {
      if (tooLarge) {
        rejectBody(new Error('Request body too large.'));
        return;
      }
      resolveBody(Buffer.concat(chunks));
    });
    req.on('error', rejectBody);
  });
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function mobileNemoExactActivateFormHtml(actionPath) {
  const action = escapeHtmlAttribute(actionPath);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SillyTavern Mobile Exact Nemo Activate</title>
</head>
<body>
<form method="post" action="${action}">
<label>entryId <input name="entryId" autocomplete="off" required></label>
<button type="submit">Activate exact Nemo preset</button>
</form>
</body>
</html>`;
}

export function mobileNemoExactInstallFormHtml(actionPath) {
  const action = escapeHtmlAttribute(actionPath);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SillyTavern Mobile Exact Nemo Install</title>
</head>
<body>
<form method="post" action="${action}">
<label>entryId <input name="entryId" autocomplete="off" required></label>
<button type="submit">Install exact Nemo preset</button>
</form>
</body>
</html>`;
}

export function mobileNemoProfileInstallFormHtml(actionPath) {
  const action = escapeHtmlAttribute(actionPath);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SillyTavern Mobile Nemo Profile Install</title>
</head>
<body>
<form method="post" action="${action}">
<label>profileId <input name="profileId" autocomplete="off" required></label>
<button type="submit">Install Nemo profile</button>
</form>
</body>
</html>`;
}

export function mobilePresetDeleteFormHtml(actionPath) {
  const action = escapeHtmlAttribute(actionPath);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SillyTavern Mobile Preset Delete</title>
</head>
<body>
<form method="post" action="${action}">
<label>name <input name="name" autocomplete="off" required></label>
<label>fallbackName <input name="fallbackName" autocomplete="off"></label>
<button type="submit">Delete preset</button>
</form>
</body>
</html>`;
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

export function registerSillyTavernWriteTools(
  server,
  { getClient = clientFromEnv } = {},
) {
  server.registerTool(
    'sillytavern_append_turn',
    {
      description:
        'Append exactly one explicit user-authored turn to an existing SillyTavern chat and persist it. This mutates chat history; use only when the user explicitly asks to write/send/continue in SillyTavern. The tool never retries a failed write.',
      inputSchema: z.object({
        avatarUrl: z.string().min(1).max(500),
        fileName: z.string().min(1).max(1_000),
        userText: z.string().min(1).max(200_000),
      }),
    },
    async ({ avatarUrl, fileName, userText }) => {
      try {
        return textResult(
          await getClient().appendUserMessage({
            avatarUrl,
            fileName,
            userText,
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'sillytavern_generate_reply',
    {
      description:
        'Generate and persist exactly one assistant reply for an existing SillyTavern chat through the selected configured server-side provider. This mutates chat history and never retries. Server-side generation is not proof of NemoEngine client-side generation or parity.',
      inputSchema: z.object({
        avatarUrl: z.string().min(1).max(500),
        fileName: z.string().min(1).max(1_000),
        source: z.enum(['deepseek', 'groq', 'openrouter']),
        model: z.string().min(1).max(500),
      }),
    },
    async ({ avatarUrl, fileName, source, model }) => {
      try {
        return textResult(
          await getClient().generateAssistantMessage({
            avatarUrl,
            fileName,
            source,
            model,
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
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

  registerSillyTavernWriteTools(server, { getClient });

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
  const enqueueMobileMutation = createSerialTaskQueue();

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
  const ideogramHandler = createIdeogramNodeHandler();

  const httpServer = createServer((req, res) => {
    const requestTarget = req.url || '/';
    const pathname = requestTarget.split('?', 1)[0];
    const bootstrapPath = `${MOBILE_REST_BASE_PATH}/client-bootstrap`;
    const clientGeneratePath = `${MOBILE_REST_BASE_PATH}/client-generate`;
    const daryaSourceFilePath = `${MOBILE_REST_BASE_PATH}/darya-source-file`;

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

    if (pathname === daryaSourceFilePath) {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.setHeader('allow', 'POST');
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: false, error: 'POST required.' }));
        return;
      }

      const expectedToken = process.env.DARYA_IMPORT_TOKEN || '';
      const suppliedToken = String(req.headers['x-darya-import-token'] || '');
      if (!isDaryaImportAuthorized(suppliedToken, expectedToken)) {
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }

      const relativePath = String(req.headers['x-darya-path'] || '').trim();
      const sha256 = String(req.headers['x-darya-sha256'] || '').trim();

      void readRawRequestBody(req)
        .then((body) =>
          getClient().importDaryaSourceFile({
            relativePath,
            sha256,
            body,
            token: expectedToken,
          }),
        )
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
            message.includes('must be a 64-character hex digest') ||
            message.includes('body must be a Buffer') ||
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
      const mobileWriteRoute = isMobileRestWriteRoute(mobileRoute);

      if (
        mobileWriteRoute &&
        req.method === 'GET' &&
        isMobileRestPostOnlyRoute(mobileRoute)
      ) {
        res.statusCode = 405;
        res.setHeader('allow', 'POST');
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: false, error: 'POST required.' }));
        return;
      }

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
                : mobileRoute.kind === 'preset_delete'
                  ? mobilePresetDeleteFormHtml(
                      `${MOBILE_REST_BASE_PATH}/preset-delete`,
                    )
                  : mobileRoute.kind === 'nemo_profile_install'
                  ? mobileNemoProfileInstallFormHtml(
                      `${MOBILE_REST_BASE_PATH}/nemo-profile-install`,
                    )
                  : mobileRoute.kind === 'nemo_exact_install'
                    ? mobileNemoExactInstallFormHtml(
                        `${MOBILE_REST_BASE_PATH}/nemo-exact-install`,
                      )
                    : mobileRoute.kind === 'nemo_exact_activate'
                      ? mobileNemoExactActivateFormHtml(
                          `${MOBILE_REST_BASE_PATH}/nemo-exact-activate`,
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
        const executeRoute = () =>
          executeMobileRestRoute(mobileRoute, getClient(), body);
        return mobileWriteRoute
          ? enqueueMobileMutation(executeRoute)
          : executeRoute();
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
            message === 'deleteChats must be a boolean.' ||
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

    if (route.kind === 'image_provider') {
      if (route.providerId === 'ideogram') {
        void ideogramHandler(req, res);
      } else if (route.providerId === 'leonardo') {
        void proxyLeonardoMcpRequest(req, res);
      } else {
        res.statusCode = 404;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('Not found');
      }
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