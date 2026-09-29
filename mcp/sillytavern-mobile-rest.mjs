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
    case 'character':
      if (!route.avatarUrl) throw new Error('avatarUrl is required.');
      return client.getCharacter(route.avatarUrl);
    case 'world_info':
      return client.listWorldInfo();
    case 'world_info_entry':
      if (!route.name) throw new Error('name is required.');
      return client.getWorldInfo(route.name);
    case 'recent_chats':
      return client.recentChats();
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
