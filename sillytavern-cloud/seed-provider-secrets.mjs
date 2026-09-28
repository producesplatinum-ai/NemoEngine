import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const userDataDir = process.env.SILLYTAVERN_USER_DATA_DIR || '/persistent/data/default-user';
const secretsPath = path.join(userDataDir, 'secrets.json');

const providers = [
  { name: 'Groq', env: 'GROQ_API_KEY', key: 'api_key_groq' },
  { name: 'OpenRouter', env: 'OPENROUTER_API_KEY', key: 'api_key_openrouter' },
  { name: 'DeepSeek', env: 'DEEPSEEK_API_KEY', key: 'api_key_deepseek' },
];

fs.mkdirSync(userDataDir, { recursive: true });

let secrets = {};
if (fs.existsSync(secretsPath)) {
  const text = fs.readFileSync(secretsPath, 'utf8').trim();
  if (text) {
    secrets = JSON.parse(text);
  }
}

let changed = false;
const synced = [];

for (const provider of providers) {
  const value = (process.env[provider.env] || '').trim();
  if (!value) continue;

  const existing = Array.isArray(secrets[provider.key]) ? secrets[provider.key] : [];
  const active = existing.find(item => item && item.active === true);

  if (active?.value === value) {
    continue;
  }

  for (const item of existing) {
    if (item && typeof item === 'object') {
      item.active = false;
    }
  }

  existing.push({
    id: randomUUID(),
    value,
    label: 'Railway environment',
    active: true,
  });

  secrets[provider.key] = existing;
  changed = true;
  synced.push(provider.name);
}

if (changed) {
  const tmpPath = `${secretsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(secrets, null, 4), { mode: 0o600 });
  fs.renameSync(tmpPath, secretsPath);
  try {
    fs.chmodSync(secretsPath, 0o600);
  } catch {
    // Best effort only; some mounted filesystems do not support chmod.
  }
}

if (synced.length > 0) {
  console.log(`SillyTavern provider secrets synced: ${synced.join(', ')}`);
}
