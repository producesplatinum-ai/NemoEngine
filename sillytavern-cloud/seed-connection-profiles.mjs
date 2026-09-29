import fs from 'node:fs';
import path from 'node:path';

const userDataDir = process.env.SILLYTAVERN_USER_DATA_DIR || '/persistent/data/default-user';
const settingsPath = path.join(userDataDir, 'settings.json');
const backupsDir = path.join(userDataDir, 'backups');
const backupPath = path.join(backupsDir, 'settings.before-provider-profiles.json');

const PROFILE_SPECS = [
  {
    id: '6487f357-9d3a-4318-a4c4-c170890a5a76',
    name: 'DeepSeek',
    mode: 'cc',
    api: 'deepseek',
    preset: 'Default',
    model: 'deepseek-flash',
    exclude: ['secret-id', 'api-url', 'proxy'],
  },
  {
    id: 'facc24d4-93b5-41be-b2ae-b6a9c57da42d',
    name: 'Groq',
    mode: 'cc',
    api: 'groq',
    preset: 'Default',
    model: 'openai/gpt-oss-120b',
    exclude: ['secret-id', 'api-url', 'proxy'],
  },
  {
    id: '0f856571-2966-40b1-9952-482e757b09fc',
    name: 'OpenRouter',
    mode: 'cc',
    api: 'openrouter',
    preset: 'Default',
    model: 'openrouter/auto',
    exclude: ['secret-id', 'api-url', 'proxy'],
  },
];

if (!fs.existsSync(settingsPath)) {
  process.exit(0);
}

const originalText = fs.readFileSync(settingsPath, 'utf8');
const settings = JSON.parse(originalText);

settings.extension_settings ??= {};
settings.extension_settings.connectionManager ??= { selectedProfile: '', profiles: [] };

const manager = settings.extension_settings.connectionManager;
if (!Array.isArray(manager.profiles)) manager.profiles = [];

const hadSelectedProfile = Boolean(manager.selectedProfile);
let changed = false;

for (const spec of PROFILE_SPECS) {
  let profile = manager.profiles.find(item => item && item.name === spec.name);

  if (!profile) {
    profile = { id: spec.id, name: spec.name };
    manager.profiles.push(profile);
    changed = true;
  }

  if (!profile.id) {
    profile.id = spec.id;
    changed = true;
  }

  for (const key of ['mode', 'api', 'preset', 'model']) {
    if (profile[key] !== spec[key]) {
      profile[key] = spec[key];
      changed = true;
    }
  }

  const currentExclude = Array.isArray(profile.exclude) ? profile.exclude : [];
  if (JSON.stringify(currentExclude) !== JSON.stringify(spec.exclude)) {
    profile.exclude = [...spec.exclude];
    changed = true;
  }
}

if (!hadSelectedProfile) {
  const deepseek = manager.profiles.find(item => item?.name === 'DeepSeek');
  if (deepseek && manager.selectedProfile !== deepseek.id) {
    manager.selectedProfile = deepseek.id;
    changed = true;
  }

  settings.main_api = 'openai';
  settings.oai_settings ??= {};

  if (settings.oai_settings.chat_completion_source !== 'deepseek') {
    settings.oai_settings.chat_completion_source = 'deepseek';
    changed = true;
  }
  if (settings.oai_settings.deepseek_model !== 'deepseek-flash') {
    settings.oai_settings.deepseek_model = 'deepseek-flash';
    changed = true;
  }
}

if (changed) {
  fs.mkdirSync(backupsDir, { recursive: true });
  if (!fs.existsSync(backupPath)) {
    fs.writeFileSync(backupPath, originalText, { mode: 0o600 });
  }

  const tempPath = `${settingsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(settings, null, 4), { mode: 0o600 });
  fs.renameSync(tempPath, settingsPath);
  try {
    fs.chmodSync(settingsPath, 0o600);
  } catch {
    // Best effort for mounted filesystems.
  }

  console.log('SillyTavern connection profiles synced: DeepSeek, Groq, OpenRouter');
}
