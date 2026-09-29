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

export function classifyMobileRestRequest(requestTarget, basePath) {
  const normalizedBase = normalizeAbsolutePath(basePath, 'Mobile REST base path');
  const url = new URL(String(requestTarget || '/'), 'https://local.invalid');
  const pathname =
    url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

  if (pathname === `${normalizedBase}/status`) return { kind: 'status' };
  if (pathname === `${normalizedBase}/characters`) return { kind: 'characters' };
  if (pathname === `${normalizedBase}/presets`) return { kind: 'presets' };
  if (pathname === `${normalizedBase}/nemo-profiles`) return { kind: 'nemo_profiles' };
  if (pathname === `${normalizedBase}/nemo-exact-catalog`) return { kind: 'nemo_exact_catalog' };
  if (pathname === `${normalizedBase}/nemo-exact-install`) return { kind: 'nemo_exact_install' };
  if (pathname === `${normalizedBase}/nemo-exact-activate`) return { kind: 'nemo_exact_activate' };
  if (pathname === `${normalizedBase}/nemo-profile-install`) return { kind: 'nemo_profile_install' };
  if (pathname === `${normalizedBase}/preset-save`) return { kind: 'preset_save' };
  if (pathname === `${normalizedBase}/character-create`) return { kind: 'character_create' };
  if (pathname === `${normalizedBase}/character`) {
    return { kind: 'character', avatarUrl: one(url.searchParams, 'avatarUrl') };
  }
  if (pathname === `${normalizedBase}/world-info`) return { kind: 'world_info' };
  if (pathname === `${normalizedBase}/world-info-entry`) {
    return { kind: 'world_info_entry', name: one(url.searchParams, 'name') };
  }
  if (pathname === `${normalizedBase}/recent-chats`) {
    return { kind: 'recent_chats' };
  }
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
    case 'nemo_profiles':
      return client.listDaryaNemoProfiles();
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
    case 'nemo_profile_install': {
      const profileId = typeof body?.profileId === 'string' ? body.profileId.trim() : '';
      if (!profileId) throw new Error('profileId is required.');
      if (profileId === 'all') return client.installAllDaryaNemoProfiles();
      return client.installDaryaNemoProfile(profileId);
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
    case 'character':
      if (!route.avatarUrl) throw new Error('avatarUrl is required.');
      return client.getCharacter(route.avatarUrl);
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
    case 'world_info':
      return client.listWorldInfo();
    case 'world_info_entry':
      if (!route.name) throw new Error('name is required.');
      return client.getWorldInfo(route.name);
    case 'recent_chats':
      return client.recentChats();
    case 'client_generation_status':
      return client.getNemoClientGenerationStatus(route.marker || '');
    case 'turn': {
      const avatarUrl = typeof body?.avatarUrl === 'string' ? body.avatarUrl.trim() : '';
      const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : '';
      if (!avatarUrl || !fileName || body?.userText === undefined || body?.userText === null) {
        throw new Error('avatarUrl, fileName, and userText are required.');
      }
      const userText = String(body.userText);
      if (!userText.trim()) throw new Error('userText must not be empty.');
      return client.appendUserMessage({ avatarUrl, fileName, userText });
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
      return client.generateAssistantMessage({ avatarUrl, fileName, source, model });
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
