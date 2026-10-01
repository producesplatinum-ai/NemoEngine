// Mobile REST gateway for SillyTavern Mobile; write routes stay explicit and payload-validated.
function normalizeAbsolutePath(value, label) {
  const text = String(value || '').trim();
  if (!text.startsWith('/') || text.includes('#')) {
    throw new Error(`${label} must be an absolute URL path.`);
  }
  return text.length > 1 ? text.replace(/\/+$/, '') : text;
}

export function deriveMobileRestBasePath(mcpPath) {
  const normalized = normalizeAbsolutePath(mcpPath, 'MCP path');
  if (!normalized.endsWith('/mcp')) {
    throw new Error('MCP path must end with /mcp.');
  }
  return `${normalized.slice(0, -4)}/mobile`;
}

function one(searchParams, key) {
  const value = searchParams.get(key);
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

const MOBILE_REST_WRITE_ROUTE_KINDS = new Set([
  'turn',
  'generate',
  'chat_delete',
  'chat_rename',
  'chat_create',
  'character_create',
  'character_update',
  'character_delete',
  'character_duplicate',
  'character_rename',
  'character_import_json',
  'character_world_unbind',
  'character_world_bind',
  'world_info_entry_delete',
  'world_info_entry_upsert',
  'world_info_delete',
  'world_info_save',
  'world_info_update',
  'world_info_create',
  'preset_save',
  'preset_delete',
  'nemo_profile_install',
  'nemo_exact_install',
  'nemo_exact_activate',
]);

const MOBILE_REST_POST_ONLY_ROUTE_KINDS = new Set([
  'character_update',
  'character_delete',
  'character_duplicate',
  'character_rename',
  'character_import_json',
  'world_info_create',
  'world_info_update',
  'world_info_save',
  'world_info_delete',
  'world_info_entry_upsert',
  'world_info_entry_delete',
  'character_world_bind',
  'character_world_unbind',
  'chat_create',
  'chat_rename',
  'chat_delete',
]);

export function isMobileRestWriteRoute(route) {
  return MOBILE_REST_WRITE_ROUTE_KINDS.has(route?.kind);
}

export function isMobileRestPostOnlyRoute(route) {
  return MOBILE_REST_POST_ONLY_ROUTE_KINDS.has(route?.kind);
}

export function classifyMobileRestRequest(requestTarget, basePath) {
  const normalizedBase = normalizeAbsolutePath(basePath, 'Mobile REST base path');
  const url = new URL(String(requestTarget || '/'), 'https://local.invalid');
  const pathname =
    url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

  if (pathname === `${normalizedBase}/status`) return { kind: 'status' };
  if (pathname === `${normalizedBase}/characters`) return { kind: 'characters' };
  if (pathname === `${normalizedBase}/presets`) return { kind: 'presets' };
  if (pathname === `${normalizedBase}/nemo-exact-catalog`) return { kind: 'nemo_exact_catalog' };
  if (pathname === `${normalizedBase}/nemo-exact-install`) return { kind: 'nemo_exact_install' };
  if (pathname === `${normalizedBase}/nemo-exact-activate`) return { kind: 'nemo_exact_activate' };
  if (pathname === `${normalizedBase}/preset-save`) return { kind: 'preset_save' };
  if (pathname === `${normalizedBase}/preset-delete`) return { kind: 'preset_delete' };
  if (pathname === `${normalizedBase}/character-create`) return { kind: 'character_create' };
  if (pathname === `${normalizedBase}/character-update`) return { kind: 'character_update' };
  if (pathname === `${normalizedBase}/character-delete`) return { kind: 'character_delete' };
  if (pathname === `${normalizedBase}/character-duplicate`) return { kind: 'character_duplicate' };
  if (pathname === `${normalizedBase}/character-rename`) return { kind: 'character_rename' };
  if (pathname === `${normalizedBase}/character-export-json`) {
    return { kind: 'character_export_json', avatarUrl: one(url.searchParams, 'avatarUrl') };
  }
  if (pathname === `${normalizedBase}/character-import-json`) return { kind: 'character_import_json' };
  if (pathname === `${normalizedBase}/character-world-bind`) return { kind: 'character_world_bind' };
  if (pathname === `${normalizedBase}/character-world-unbind`) return { kind: 'character_world_unbind' };
  if (pathname === `${normalizedBase}/character`) {
    return { kind: 'character', avatarUrl: one(url.searchParams, 'avatarUrl') };
  }
  if (pathname === `${normalizedBase}/world-info`) return { kind: 'world_info' };
  if (pathname === `${normalizedBase}/world-info-entry`) {
    return { kind: 'world_info_entry', name: one(url.searchParams, 'name') };
  }
  if (pathname === `${normalizedBase}/world-info-create`) return { kind: 'world_info_create' };
  if (pathname === `${normalizedBase}/world-info-update`) return { kind: 'world_info_update' };
  if (pathname === `${normalizedBase}/world-info-save`) return { kind: 'world_info_save' };
  if (pathname === `${normalizedBase}/world-info-delete`) return { kind: 'world_info_delete' };
  if (pathname === `${normalizedBase}/world-info-entry-upsert`) return { kind: 'world_info_entry_upsert' };
  if (pathname === `${normalizedBase}/world-info-entry-delete`) return { kind: 'world_info_entry_delete' };
  if (pathname === `${normalizedBase}/recent-chats`) {
    return { kind: 'recent_chats' };
  }
  if (pathname === `${normalizedBase}/chat-create`) return { kind: 'chat_create' };
  if (pathname === `${normalizedBase}/chat-rename`) return { kind: 'chat_rename' };
  if (pathname === `${normalizedBase}/chat-delete`) return { kind: 'chat_delete' };
  if (pathname === `${normalizedBase}/turn`) return { kind: 'turn' };
  if (pathname === `${normalizedBase}/generate`) return { kind: 'generate' };
  if (pathname === `${normalizedBase}/client-generation-status`) {
    return {
      kind: 'client_generation_status',
      marker: one(url.searchParams, 'marker'),
    };
  }
  if (pathname === `${normalizedBase}/chat`) {
    return {
      kind: 'chat',
      avatarUrl: one(url.searchParams, 'avatarUrl'),
      fileName: one(url.searchParams, 'fileName'),
    };
  }
  return { kind: 'not_found' };
}

export async function executeMobileRestRoute(route, client, body = {}) {
  switch (route?.kind) {
    case 'status': {
      const status = await client.status();
      return {
        ok: Boolean(status?.ok),
        csrfSessionReady: Boolean(status?.csrfSessionReady),
        basicAuthConfigured: Boolean(status?.basicAuthConfigured),
      };
    }
    case 'characters':
      return client.listCharacters();
    case 'presets':
      return client.listOpenAiPresets();
    case 'nemo_exact_catalog':
      return client.listExactNemoCatalog();
    case 'nemo_exact_install': {
      const entryId = typeof body?.entryId === 'string' ? body.entryId.trim() : '';
      if (!entryId) throw new Error('entryId is required.');
      if (entryId === 'all') return client.installAllExactNemoCatalog();
      return client.installExactNemoCatalogEntry(entryId);
    }
    case 'nemo_exact_activate': {
      const entryId = typeof body?.entryId === 'string' ? body.entryId.trim() : '';
      if (!entryId) throw new Error('entryId is required.');
      return client.activateExactNemoCatalogEntry(entryId);
    }
    case 'preset_save': {
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      const presetJson = typeof body?.presetJson === 'string' ? body.presetJson.trim() : '';
      if (!name || !presetJson) throw new Error('name and presetJson are required.');

      let preset;
      try {
        preset = JSON.parse(presetJson);
      } catch {
        throw new Error('presetJson must be valid JSON.');
      }
      if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
        throw new Error('presetJson must be valid JSON.');
      }
      return client.saveOpenAiPreset({ name, preset });
    }
    case 'preset_delete': {
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      const fallbackName =
        typeof body?.fallbackName === 'string' ? body.fallbackName.trim() : '';
      if (!name) throw new Error('name is required.');
      return client.deleteOpenAiPreset({ name, fallbackName });
    }
    case 'character':
      if (!route.avatarUrl) throw new Error('avatarUrl is required.');
      return client.getCharacter(route.avatarUrl);
    case 'character_export_json':
      if (!route.avatarUrl) throw new Error('avatarUrl is required.');
      return client.exportCharacterJson(route.avatarUrl);
    case 'character_create': {
      const cardJson =
        typeof body?.cardJson === 'string' ? body.cardJson.trim() : '';
      const fileName =
        typeof body?.fileName === 'string' ? body.fileName.trim() : '';
      if (!cardJson) throw new Error('cardJson is required.');

      let card;
      try {
        card = JSON.parse(cardJson);
      } catch {
        throw new Error('cardJson must be valid JSON.');
      }
      if (!card || typeof card !== 'object' || Array.isArray(card)) {
        throw new Error('cardJson must be valid JSON.');
      }

      return client.createCharacter({ card, fileName });
    }
    case 'character_import_json': {
      const cardJson =
        typeof body?.cardJson === 'string' ? body.cardJson.trim() : '';
      const fileName =
        typeof body?.fileName === 'string' ? body.fileName.trim() : '';
      if (!cardJson) throw new Error('cardJson is required.');

      let card;
      try {
        card = JSON.parse(cardJson);
      } catch {
        throw new Error('cardJson must be valid JSON.');
      }
      if (!card || typeof card !== 'object' || Array.isArray(card)) {
        throw new Error('cardJson must be valid JSON.');
      }

      return client.importCharacterJson({ card, fileName });
    }
    case 'character_update': {
      const avatarUrl =
        typeof body?.avatarUrl === 'string' ? body.avatarUrl.trim() : '';
      const cardJson =
        typeof body?.cardJson === 'string' ? body.cardJson.trim() : '';
      if (!avatarUrl) throw new Error('avatarUrl is required.');
      if (!cardJson) throw new Error('cardJson is required.');

      let card;
      try {
        card = JSON.parse(cardJson);
      } catch {
        throw new Error('cardJson must be valid JSON.');
      }
      if (!card || typeof card !== 'object' || Array.isArray(card)) {
        throw new Error('cardJson must be valid JSON.');
      }

      return client.updateCharacter({ avatarUrl, card });
    }
    case 'character_delete': {
      const avatarUrl =
        typeof body?.avatarUrl === 'string' ? body.avatarUrl.trim() : '';
      if (!avatarUrl) throw new Error('avatarUrl is required.');
      if (body?.deleteChats != null && typeof body.deleteChats !== 'boolean') {
        throw new Error('deleteChats must be a boolean.');
      }
      return client.deleteCharacter({
        avatarUrl,
        deleteChats: body?.deleteChats === true,
      });
    }
    case 'character_duplicate': {
      const avatarUrl =
        typeof body?.avatarUrl === 'string' ? body.avatarUrl.trim() : '';
      const newName =
        typeof body?.newName === 'string' ? body.newName.trim() : '';
      const fileName =
        typeof body?.fileName === 'string' ? body.fileName.trim() : '';
      if (!avatarUrl) throw new Error('avatarUrl is required.');
      if (!newName) throw new Error('newName is required.');
      return client.duplicateCharacter({
        avatarUrl,
        newName,
        fileName: fileName || newName.replace(/\.png$/i, ''),
      });
    }
    case 'character_rename': {
      const avatarUrl =
        typeof body?.avatarUrl === 'string' ? body.avatarUrl.trim() : '';
      const newName =
        typeof body?.newName === 'string' ? body.newName.trim() : '';
      if (!avatarUrl) throw new Error('avatarUrl is required.');
      if (!newName) throw new Error('newName is required.');
      return client.renameCharacter({ avatarUrl, newName });
    }
    case 'character_world_bind': {
      const avatarUrl =
        typeof body?.avatarUrl === 'string' ? body.avatarUrl.trim() : '';
      const name =
        typeof body?.name === 'string' ? body.name.trim() : '';
      if (!avatarUrl) throw new Error('avatarUrl is required.');
      if (!name) throw new Error('name is required.');
      return client.bindCharacterWorld({ avatarUrl, name });
    }
    case 'character_world_unbind': {
      const avatarUrl =
        typeof body?.avatarUrl === 'string' ? body.avatarUrl.trim() : '';
      if (!avatarUrl) throw new Error('avatarUrl is required.');
      return client.unbindCharacterWorld({ avatarUrl });
    }
    case 'world_info':
      return client.listWorldInfo();
    case 'world_info_entry':
      if (!route.name) throw new Error('name is required.');
      return client.getWorldInfo(route.name);
    case 'world_info_create': {
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      const worldJson = typeof body?.worldJson === 'string' ? body.worldJson.trim() : '';
      if (!name) throw new Error('name is required.');
      if (!worldJson) throw new Error('worldJson is required.');
      let data;
      try { data = JSON.parse(worldJson); } catch { throw new Error('worldJson must be valid JSON.'); }
      if (!data || typeof data !== 'object' || Array.isArray(data) || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
        throw new Error('worldJson must contain an entries object.');
      }
      return client.createWorldInfo({ name, data });
    }
    case 'world_info_update': {
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      const worldJson = typeof body?.worldJson === 'string' ? body.worldJson.trim() : '';
      if (!name) throw new Error('name is required.');
      if (!worldJson) throw new Error('worldJson is required.');
      let data;
      try { data = JSON.parse(worldJson); } catch { throw new Error('worldJson must be valid JSON.'); }
      if (!data || typeof data !== 'object' || Array.isArray(data) || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
        throw new Error('worldJson must contain an entries object.');
      }
      return client.updateWorldInfo({ name, data });
    }
    case 'world_info_save': {
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      const dataJson = typeof body?.dataJson === 'string' ? body.dataJson.trim() : '';
      if (!name) throw new Error('name is required.');
      if (!dataJson) throw new Error('dataJson is required.');
      let data;
      try { data = JSON.parse(dataJson); } catch { throw new Error('dataJson must be valid JSON.'); }
      if (!data || typeof data !== 'object' || Array.isArray(data) || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
        throw new Error('dataJson must contain an entries object.');
      }
      return client.saveWorldInfo({ name, data });
    }
    case 'world_info_delete': {
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (!name) throw new Error('name is required.');
      return client.deleteWorldInfo({ name });
    }
    case 'world_info_entry_upsert': {
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (!name) throw new Error('name is required.');
      if (!Number.isInteger(body?.uid) || body.uid < 0) throw new Error('uid must be a non-negative integer.');
      const entryJson = typeof body?.entryJson === 'string' ? body.entryJson.trim() : '';
      if (!entryJson) throw new Error('entryJson is required.');
      let entry;
      try { entry = JSON.parse(entryJson); } catch { throw new Error('entryJson must be valid JSON.'); }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('entryJson must be a JSON object.');
      return client.upsertWorldInfoEntry({ name, uid: body.uid, entry });
    }
    case 'world_info_entry_delete': {
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (!name) throw new Error('name is required.');
      if (!Number.isInteger(body?.uid) || body.uid < 0) throw new Error('uid must be a non-negative integer.');
      return client.deleteWorldInfoEntry({ name, uid: body.uid });
    }
    case 'recent_chats':
      return client.recentChats();
    case 'chat_create': {
      const avatarUrl = typeof body?.avatarUrl === 'string' ? body.avatarUrl.trim() : '';
      const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : '';
      if (!avatarUrl || !fileName) {
        throw new Error('avatarUrl and fileName are required.');
      }
      const nonce = typeof body?.nonce === 'string' ? body.nonce.trim() : '';
      return client.createChat({
        ...(nonce ? { nonce } : {}),
        avatarUrl,
        fileName,
      });
    }
    case 'chat_rename': {
      const avatarUrl = typeof body?.avatarUrl === 'string' ? body.avatarUrl.trim() : '';
      const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : '';
      const newFileName = typeof body?.newFileName === 'string' ? body.newFileName.trim() : '';
      if (!avatarUrl || !fileName || !newFileName) {
        throw new Error('avatarUrl, fileName, and newFileName are required.');
      }
      return client.renameChat({ avatarUrl, fileName, newFileName });
    }
    case 'chat_delete': {
      const avatarUrl = typeof body?.avatarUrl === 'string' ? body.avatarUrl.trim() : '';
      const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : '';
      if (!avatarUrl || !fileName) {
        throw new Error('avatarUrl and fileName are required.');
      }
      return client.deleteChat({ avatarUrl, fileName });
    }
    case 'client_generation_status':
      return client.getNemoClientGenerationStatus(route.marker || '');
    case 'turn': {
      const avatarUrl = typeof body?.avatarUrl === 'string' ? body.avatarUrl.trim() : '';
      const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : '';
      if (!avatarUrl || !fileName || body?.userText === undefined || body?.userText === null) {
        throw new Error('avatarUrl, fileName, and userText are required.');
      }
      const userText = String(body.userText);
      const nonce = typeof body?.nonce === 'string' ? body.nonce.trim() : '';
      if (!userText.trim()) throw new Error('userText must not be empty.');
      return client.appendUserMessage({
        ...(nonce ? { nonce } : {}),
        avatarUrl,
        fileName,
        userText,
      });
    }
    case 'generate': {
      const avatarUrl = typeof body?.avatarUrl === 'string' ? body.avatarUrl.trim() : '';
      const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : '';
      const source = typeof body?.source === 'string' ? body.source.trim() : '';
      const model = typeof body?.model === 'string' ? body.model.trim() : '';
      if (!avatarUrl || !fileName) {
        throw new Error('avatarUrl and fileName are required.');
      }
      if (!source || !model) {
        throw new Error('source and model are required.');
      }
      if (!['deepseek', 'groq', 'openrouter'].includes(source)) {
        throw new Error('Unsupported generation source.');
      }
      const nonce = typeof body?.nonce === 'string' ? body.nonce.trim() : '';
      return client.generateAssistantMessage({
        ...(nonce ? { nonce } : {}),
        avatarUrl,
        fileName,
        source,
        model,
      });
    }
    case 'chat':
      if (!route.avatarUrl || !route.fileName) {
        throw new Error('avatarUrl and fileName are required.');
      }
      return client.getChat({
        avatarUrl: route.avatarUrl,
        fileName: route.fileName,
      });
    default:
      throw new Error('Unknown mobile REST route.');
  }
}
