const SUPPORTED_OPS = new Set([
  'skip',
  'status',
  'characters',
  'character',
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

  if (['character', 'chat', 'turn', 'generate'].includes(op)) {
    command.avatarUrl = requiredString(value.avatarUrl, 'avatarUrl');
  }
  if (['chat', 'turn', 'generate'].includes(op)) {
    command.fileName = requiredString(value.fileName, 'fileName');
  }
  if (op === 'world_info_entry') {
    command.name = requiredString(value.name, 'name');
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
    case 'characters':
      return { method: 'GET', suffix: '/characters' };
    case 'character': {
      const q = new URLSearchParams({ avatarUrl: command.avatarUrl });
      return { method: 'GET', suffix: `/character?${q}` };
    }
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
