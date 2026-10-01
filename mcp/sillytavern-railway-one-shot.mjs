const SUPPORTED_OPS = new Set([
  'skip',
  'status',
  'presets',
  'nemo_exact_catalog',
  'nemo_exact_install',
  'nemo_exact_activate',
  'client_generation_status',
  'characters',
  'character',
  'character_create',
  'character_update',
  'character_delete',
  'world_info',
  'world_info_entry',
  'recent_chats',
  'chat',
  'turn',
  'generate',
]);

function requiredString(value, name) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

function normalizeMcpPath(value) {
  const path = requiredString(value, 'mcpPath').replace(/\/+$/, '');
  if (!path.startsWith('/') || !path.endsWith('/mcp')) {
    throw new Error('mcpPath must be an absolute path ending with /mcp.');
  }
  return path;
}

function normalizeBaseUrl(value) {
  const text = requiredString(value, 'baseUrl').replace(/\/+$/, '');
  const url = new URL(text);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new Error('baseUrl must use https.');
  }
  return url.toString().replace(/\/+$/, '');
}

export function parseOneShotCommand(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { op: 'skip' };

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('SILLYTAVERN_ONE_SHOT_JSON must be valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('SILLYTAVERN_ONE_SHOT_JSON must be a JSON object.');
  }

  const op = requiredString(value.op, 'op');
  if (!SUPPORTED_OPS.has(op)) throw new Error(`Unsupported one-shot op: ${op}`);

  const command = { ...value, op };
  if (value.nonce != null) command.nonce = requiredString(value.nonce, 'nonce');

  if (['character', 'character_update', 'character_delete', 'chat', 'turn', 'generate'].includes(op)) {
    command.avatarUrl = requiredString(value.avatarUrl, 'avatarUrl');
  }
  if (['character_create', 'character_update'].includes(op)) {
    command.cardJson = requiredString(value.cardJson, 'cardJson');
    let card;
    try {
      card = JSON.parse(command.cardJson);
    } catch {
      throw new Error('cardJson must be valid JSON.');
    }
    if (!card || typeof card !== 'object' || Array.isArray(card)) {
      throw new Error('cardJson must be a JSON object.');
    }
    if (op === 'character_create') {
      if (value.fileName != null) {
        command.fileName = requiredString(value.fileName, 'fileName').replace(/\.png$/i, '');
      } else {
        const cardName = String(card?.data?.name ?? card?.name ?? '').trim();
        if (!cardName) throw new Error('Character card name is required.');
        command.fileName = cardName.replace(/\.png$/i, '');
      }
    }
  }
  if (op === 'character_delete') {
    if (value.deleteChats != null && typeof value.deleteChats !== 'boolean') {
      throw new Error('deleteChats must be a boolean.');
    }
    command.deleteChats = value.deleteChats === true;
  }
  if (['chat', 'turn', 'generate'].includes(op)) {
    command.fileName = requiredString(value.fileName, 'fileName');
  }
  if (op === 'world_info_entry') {
    command.name = requiredString(value.name, 'name');
  }
  if (['nemo_exact_install', 'nemo_exact_activate'].includes(op)) {
    command.entryId = requiredString(value.entryId, 'entryId');
  }
  if (op === 'client_generation_status') {
    command.marker = requiredString(value.marker, 'marker');
  }
  if (op === 'turn') {
    command.userText = requiredString(value.userText, 'userText');
  }
  if (op === 'generate') {
    command.source = requiredString(value.source, 'source');
    command.model = requiredString(value.model, 'model');
    if (!['deepseek', 'groq', 'openrouter'].includes(command.source)) {
      throw new Error('source must be deepseek, groq, or openrouter.');
    }
  }

  return command;
}

function routeFor(command) {
  switch (command.op) {
    case 'status':
      return { method: 'GET', suffix: '/status' };
    case 'presets':
      return { method: 'GET', suffix: '/presets' };
    case 'nemo_exact_catalog':
      return { method: 'GET', suffix: '/nemo-exact-catalog' };
    case 'nemo_exact_install':
      return {
        method: 'POST',
        suffix: '/nemo-exact-install',
        body: { entryId: command.entryId },
      };
    case 'nemo_exact_activate':
      return {
        method: 'POST',
        suffix: '/nemo-exact-activate',
        body: { entryId: command.entryId },
      };
    case 'client_generation_status': {
      const q = new URLSearchParams({ marker: command.marker });
      return { method: 'GET', suffix: `/client-generation-status?${q}` };
    }
    case 'characters':
      return { method: 'GET', suffix: '/characters' };
    case 'character': {
      const q = new URLSearchParams({ avatarUrl: command.avatarUrl });
      return { method: 'GET', suffix: `/character?${q}` };
    }
    case 'character_create':
      return {
        method: 'POST',
        suffix: '/character-create',
        body: {
          fileName: command.fileName,
          cardJson: command.cardJson,
        },
      };
    case 'character_update':
      return {
        method: 'POST',
        suffix: '/character-update',
        body: {
          avatarUrl: command.avatarUrl,
          cardJson: command.cardJson,
        },
      };
    case 'character_delete':
      return {
        method: 'POST',
        suffix: '/character-delete',
        body: {
          avatarUrl: command.avatarUrl,
          deleteChats: command.deleteChats,
        },
      };
    case 'world_info':
      return { method: 'GET', suffix: '/world-info' };
    case 'world_info_entry': {
      const q = new URLSearchParams({ name: command.name });
      return { method: 'GET', suffix: `/world-info-entry?${q}` };
    }
    case 'recent_chats':
      return { method: 'GET', suffix: '/recent-chats' };
    case 'chat': {
      const q = new URLSearchParams({
        avatarUrl: command.avatarUrl,
        fileName: command.fileName,
      });
      return { method: 'GET', suffix: `/chat?${q}` };
    }
    case 'turn':
      return {
        method: 'POST',
        suffix: '/turn',
        body: {
          ...(command.nonce ? { nonce: command.nonce } : {}),
          avatarUrl: command.avatarUrl,
          fileName: command.fileName,
          userText: command.userText,
        },
      };
    case 'generate':
      return {
        method: 'POST',
        suffix: '/generate',
        body: {
          ...(command.nonce ? { nonce: command.nonce } : {}),
          avatarUrl: command.avatarUrl,
          fileName: command.fileName,
          source: command.source,
          model: command.model,
        },
      };
    default:
      throw new Error(`Unsupported one-shot op: ${command.op}`);
  }
}

async function perform({ command, baseUrl, fetchImpl }) {
  if (command.op === 'skip') {
    return { status: 200, body: { ok: true, skipped: true } };
  }

  const route = routeFor(command);
  const init = { method: route.method, headers: { accept: 'application/json' } };
  if (route.body) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(route.body);
  }

  // Deliberately exactly one fetch. Never retry writes or ambiguous failures.
  const response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}${route.suffix}`, init);
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Keep non-JSON upstream text as text.
  }

  if (!response.ok) {
    throw new Error(
      `one-shot ${command.op} failed: ${response.status}${text ? ` ${text.slice(0, 300)}` : ''}`,
    );
  }
  return { status: response.status, body };
}

export async function executeOneShot({
  command,
  publicDomain,
  mcpPath,
  fetchImpl = fetch,
}) {
  const parsed =
    typeof command === 'string' ? parseOneShotCommand(command) : command || { op: 'skip' };
  if (parsed.op === 'skip') return { ok: true, skipped: true };

  const domain = requiredString(publicDomain, 'publicDomain')
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  const path = normalizeMcpPath(mcpPath);
  const mobileBase = `https://${domain}${path.slice(0, -4)}/mobile`;
  const result = await perform({ command: parsed, baseUrl: mobileBase, fetchImpl });
  return result.body;
}

export async function runOneShot({
  raw,
  baseUrl,
  fetchImpl = fetch,
}) {
  const command = parseOneShotCommand(raw);
  if (command.op === 'skip') return { skipped: true };

  const result = await perform({
    command,
    baseUrl,
    fetchImpl,
  });

  return {
    ...(command.nonce ? { nonce: command.nonce } : {}),
    op: command.op,
    status: result.status,
    body: result.body,
  };
}

async function cliMain(env = process.env) {
  const command = parseOneShotCommand(env.SILLYTAVERN_ONE_SHOT_JSON || '');
  if (command.op === 'skip') {
    console.log('SILLYTAVERN_ONE_SHOT_RESULT '+JSON.stringify({ skipped: true }));
    return;
  }

  const domain = requiredString(env.RAILWAY_PUBLIC_DOMAIN, 'RAILWAY_PUBLIC_DOMAIN');
  const mcpPath = normalizeMcpPath(env.SILLYTAVERN_MCP_ENDPOINT_PATH || '/mcp');
  const baseUrl = `https://${domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}${mcpPath.slice(0, -4)}/mobile`;
  const result = await runOneShot({
    raw: JSON.stringify(command),
    baseUrl,
  });
  console.log('SILLYTAVERN_ONE_SHOT_RESULT '+JSON.stringify(result));
}

const invokedAsScript = process.argv.includes('--run');

if (invokedAsScript) {
  cliMain().catch((error) => {
    console.error('SILLYTAVERN_ONE_SHOT_ERROR '+(error?.message || String(error)));
    process.exitCode = 1;
  });
}