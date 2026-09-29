import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const NEMOENGINE_REF = '9a88242471b27670351ebbe2a62226714039964a';
const ACTIVE_PRESET = 'Nemo Engine 11.5.2 - Ready RU Gooner RP';

const PRESETS = [
  { name: 'Nemo Engine 11.5.2 - General RP', repoPath: 'Nemo Engine/Nemo Engine 11.5.2 - General RP.json' },
  { name: 'Nemo Engine 11.5.2 - Default RP', repoPath: 'Nemo Engine/Nemo Engine 11.5.2 - Default RP.json' },
  { name: 'Nemo Engine 11.5.2 - Ready RU Gooner RP', repoPath: 'Nemo Engine/Ready/Nemo Engine 11.5.2 - Ready RU Gooner RP.json' },
  { name: 'Nemo Engine 11.5.2 - Ready RU Gooner RP', repoPath: 'Nemo Engine/Ready/Nemo Engine 11.5.2 - Ready RU Gooner RP.json' },
  { name: 'Nemo Engine 11.5.2 - Ready RU Psychology Humiliation JOI RP', repoPath: 'Nemo Engine/Ready/Nemo Engine 11.5.2 - Ready RU Psychology Humiliation JOI RP.json' },
];

const userDataDir = process.env.SILLYTAVERN_USER_DATA_DIR || '/persistent/data/default-user';
const presetDir = path.join(userDataDir, 'OpenAI Settings');
const extensionRoot = path.join(userDataDir, 'extensions');
const extensionDir = path.join(extensionRoot, 'NemoPresetExt');
const settingsPath = path.join(userDataDir, 'settings.json');
const backupsDir = path.join(userDataDir, 'backups');
const backupPath = path.join(backupsDir, 'settings.before-nemoengine.json');

function encodeRepoPath(repoPath) {
  return repoPath.split('/').map(encodeURIComponent).join('/');
}

async function readPresetSource(spec) {
  const localDir = process.env.NEMOENGINE_PRESET_SOURCE_DIR;
  if (localDir) {
    return fs.readFileSync(path.join(localDir, `${spec.name}.json`), 'utf8');
  }

  const url =
    'https://raw.githubusercontent.com/producesplatinum-ai/NemoEngine/' +
    NEMOENGINE_REF + '/' + encodeRepoPath(spec.repoPath);

  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`NemoEngine preset download failed for ${spec.name}: HTTP ${response.status}`);
  }
  return response.text();
}

function validatePreset(name, text) {
  let preset;
  try {
    preset = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid NemoEngine preset ${name}: malformed JSON`);
  }

  const promptCount = Array.isArray(preset?.prompts) ? preset.prompts.length : 0;
  const promptOrderCount = Array.isArray(preset?.prompt_order) ? preset.prompt_order.length : 0;
  const regexCount = Array.isArray(preset?.extensions?.regex_scripts)
    ? preset.extensions.regex_scripts.length
    : 0;

  if (promptCount < 450 || promptOrderCount < 1 || regexCount < 90) {
    throw new Error(
      `Invalid NemoEngine preset ${name}: prompts=${promptCount}, prompt_order=${promptOrderCount}, regex=${regexCount}`,
    );
  }

  return { preset, promptCount, regexCount };
}

function writeAtomic(filePath, text, mode = 0o600) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tempPath, text, { mode });
  fs.renameSync(tempPath, filePath);
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // Mounted filesystems may not support chmod.
  }
}

function copyDirectory(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temp = `${destination}.tmp-${process.pid}`;
  fs.rmSync(temp, { recursive: true, force: true });
  fs.cpSync(source, temp, { recursive: true, force: true });
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(temp, destination);
}

function readExtensionManifest(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('NemoPresetExt manifest.json is missing');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest?.display_name !== 'NemoPresetExt' || !manifest?.version) {
    throw new Error('NemoPresetExt manifest is invalid');
  }
  return manifest;
}

function installExtension() {
  const fixtureSource = process.env.NEMO_PRESET_EXT_SOURCE_DIR;
  if (fixtureSource) {
    copyDirectory(fixtureSource, extensionDir);
    return readExtensionManifest(extensionDir);
  }

  if (fs.existsSync(extensionDir)) {
    const current = readExtensionManifest(extensionDir);
    if (
      process.env.NEMO_PRESET_EXT_AUTO_UPDATE === '1' &&
      fs.existsSync(path.join(extensionDir, '.git')) &&
      process.env.NEMOENGINE_SKIP_EXTENSION_GIT_UPDATE !== '1'
    ) {
      const pull = spawnSync('git', ['-C', extensionDir, 'pull', '--ff-only', 'origin', 'main'], {
        encoding: 'utf8',
        timeout: 120_000,
      });
      if (pull.status !== 0) {
        console.warn('NemoPresetExt update skipped: existing installation could not fast-forward');
      }
    }
    return readExtensionManifest(extensionDir) || current;
  }

  fs.mkdirSync(extensionRoot, { recursive: true });
  const temp = `${extensionDir}.clone-${process.pid}`;
  fs.rmSync(temp, { recursive: true, force: true });

  const clone = spawnSync(
    'git',
    ['clone', '--depth', '1', '--branch', 'main', 'https://github.com/NemoVonNirgend/NemoPresetExt', temp],
    { encoding: 'utf8', timeout: 180_000 },
  );
  if (clone.status !== 0) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw new Error('NemoPresetExt installation failed');
  }

  const manifest = readExtensionManifest(temp);
  fs.renameSync(temp, extensionDir);
  return manifest;
}

function overlayNemoPresetExtInstaller(activePresetText) {
  const assetPath = path.join(extensionDir, 'assets', 'nemo-engine-latest.json');
  const installerPath = path.join(extensionDir, 'features', 'preset-installer', 'runtime.js');

  if (!fs.existsSync(installerPath)) {
    throw new Error('NemoPresetExt preset installer runtime is missing');
  }

  writeAtomic(assetPath, activePresetText);

  const original = fs.readFileSync(installerPath, 'utf8');
  let patched = original
    .replace(/const PRESET_VERSION = '[^']+';/, "const PRESET_VERSION = '11.5.2';")
    .replace(
      /const PRESET_NAME = .*?;\n/,
      "const PRESET_NAME = 'Nemo Engine 11.5.2 - Ready RU Gooner RP';\n",
    );

  if (!patched.includes("const PRESET_VERSION = '11.5.2';") ||
      !patched.includes("const PRESET_NAME = 'Nemo Engine 11.5.2 - Ready RU Gooner RP';")) {
    throw new Error('NemoPresetExt installer overlay could not be applied safely');
  }

  if (patched !== original) {
    writeAtomic(installerPath, patched);
  }

  console.log('NemoPresetExt installer overlay: 11.5.2 Ready RU Gooner RP');
}

function updateSettings() {
  if (!fs.existsSync(settingsPath)) {
    throw new Error(`SillyTavern settings not found at ${settingsPath}`);
  }

  const originalText = fs.readFileSync(settingsPath, 'utf8');
  const settings = JSON.parse(originalText);
  let changed = false;

  settings.oai_settings ??= {};
  if (settings.oai_settings.preset_settings_openai !== ACTIVE_PRESET) {
    settings.oai_settings.preset_settings_openai = ACTIVE_PRESET;
    changed = true;
  }

  settings.extension_settings ??= {};
  settings.extension_settings.NemoPresetExt ??= {};
  const nemo = settings.extension_settings.NemoPresetExt;
  for (const [key, value] of Object.entries({
    enableRecipeRuntime: true,
    enableColdPromptStorage: true,
    enableVexRuntime: true,
    enableIncrementalPromptRendering: true,
    enablePromptManager: true,
    enableNemoEngineInstaller: true,
  })) {
    if (nemo[key] !== value) {
      nemo[key] = value;
      changed = true;
    }
  }

  settings.extension_settings.preset_allowed_regex ??= {};
  const allowed = Array.isArray(settings.extension_settings.preset_allowed_regex.openai)
    ? settings.extension_settings.preset_allowed_regex.openai
    : [];

  for (const { name } of PRESETS) {
    if (!allowed.includes(name)) {
      allowed.push(name);
      changed = true;
    }
  }
  settings.extension_settings.preset_allowed_regex.openai = allowed;

  if (!changed) return false;

  fs.mkdirSync(backupsDir, { recursive: true });
  if (!fs.existsSync(backupPath)) {
    fs.writeFileSync(backupPath, originalText, { mode: 0o600 });
  }

  writeAtomic(settingsPath, JSON.stringify(settings, null, 4));
  return true;
}

async function main() {
  const loaded = [];

  // Fail closed: validate every source before mutating persistent SillyTavern state.
  for (const spec of PRESETS) {
    const text = await readPresetSource(spec);
    const validation = validatePreset(spec.name, text);
    loaded.push({ ...spec, text, ...validation });
  }

  fs.mkdirSync(presetDir, { recursive: true });
  let presetWrites = 0;
  for (const item of loaded) {
    const target = path.join(presetDir, `${item.name}.json`);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (current !== item.text) {
      writeAtomic(target, item.text);
      presetWrites += 1;
    }
  }

  const manifest = installExtension();
  const active = loaded.find(item => item.name === ACTIVE_PRESET);
  if (!active) {
    throw new Error('Active NemoEngine preset was not loaded');
  }
  overlayNemoPresetExtInstaller(active.text);
  updateSettings();

  console.log(
    `NemoEngine presets synced: ${PRESETS.map(x => x.name).join(', ')}` +
      ` (updated ${presetWrites})`,
  );
  console.log(`NemoPresetExt ready: ${manifest.version}`);
  console.log(`NemoEngine active preset: ${ACTIVE_PRESET}`);
  console.log('NemoEngine preset regex allowed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
