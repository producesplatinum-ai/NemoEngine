import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const seeder = process.env.NEMO_SEED_SCRIPT || '/usr/local/bin/seed-nemoengine.mjs';

const PRESETS = [
  'Nemo Engine 11.5.2 - General RP',
  'Nemo Engine 11.5.2 - Default RP',
  'Nemo Engine 11.5.2 - Ready RU RP',
  'Nemo Engine 11.5.2 - Ready RU Gooner RP',
  'Nemo Engine 11.5.2 - Ready RU Psychology Humiliation JOI RP',
];

function fakePreset(name) {
  return {
    name,
    prompts: Array.from({ length: 458 }, (_, i) => ({ identifier: `p-${i}`, name: `Prompt ${i}` })),
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'p-0', enabled: true }] }],
    extensions: {
      regex_scripts: Array.from({ length: 97 }, (_, i) => ({ id: `rx-${i}`, scriptName: `Regex ${i}` })),
    },
  };
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-nemo-'));
  const userDataDir = path.join(root, 'default-user');
  const sourceDir = path.join(root, 'preset-source');
  const extSource = path.join(root, 'ext-source');

  fs.mkdirSync(path.join(userDataDir, 'backups'), { recursive: true });
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(extSource, { recursive: true });

  fs.writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify({
    marker: 'keep-me',
    main_api: 'openai',
    oai_settings: {
      preset_settings_openai: 'Default',
      chat_completion_source: 'groq',
      groq_model: 'openai/gpt-oss-120b',
    },
    extension_settings: {
      connectionManager: {
        selectedProfile: 'groq-profile',
        profiles: [{ id: 'groq-profile', name: 'Groq' }],
      },
      preset_allowed_regex: {
        openai: ['Existing Preset'],
      },
    },
  }, null, 2));

  for (const name of PRESETS) {
    fs.writeFileSync(path.join(sourceDir, `${name}.json`), JSON.stringify(fakePreset(name)));
  }

  fs.writeFileSync(path.join(extSource, 'manifest.json'), JSON.stringify({
    display_name: 'NemoPresetExt',
    author: '@NemoVonNirgend',
    version: '6.0.6',
    js: 'content.js',
    css: 'styles.css',
  }, null, 2));
  fs.writeFileSync(path.join(extSource, 'content.js'), 'globalThis.NemoPresetExtFixture = true;');
  fs.writeFileSync(path.join(extSource, 'styles.css'), '/* fixture */');

  return { root, userDataDir, sourceDir, extSource };
}

function runSeeder(fixture) {
  return spawnSync(process.execPath, [seeder], {
    env: {
      ...process.env,
      SILLYTAVERN_USER_DATA_DIR: fixture.userDataDir,
      NEMOENGINE_PRESET_SOURCE_DIR: fixture.sourceDir,
      NEMO_PRESET_EXT_SOURCE_DIR: fixture.extSource,
      NEMOENGINE_SKIP_EXTENSION_GIT_UPDATE: '1',
    },
    encoding: 'utf8',
  });
}

test('installs the complete NemoEngine 11.5.2 preset set, enables embedded regex, and installs NemoPresetExt', () => {
  const fixture = makeFixture();

  const result = runSeeder(fixture);
  assert.equal(result.status, 0, result.stderr);

  const presetDir = path.join(fixture.userDataDir, 'OpenAI Settings');
  for (const name of PRESETS) {
    const file = path.join(presetDir, `${name}.json`);
    assert.equal(fs.existsSync(file), true, `missing ${name}`);
    const preset = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(preset.prompts.length, 458);
    assert.equal(preset.extensions.regex_scripts.length, 97);
  }

  const settings = JSON.parse(fs.readFileSync(path.join(fixture.userDataDir, 'settings.json'), 'utf8'));
  assert.equal(settings.marker, 'keep-me');
  assert.equal(settings.oai_settings.preset_settings_openai, 'Nemo Engine 11.5.2 - Ready RU RP');
  assert.equal(settings.oai_settings.chat_completion_source, 'groq');
  assert.equal(settings.oai_settings.groq_model, 'openai/gpt-oss-120b');
  assert.equal(settings.extension_settings.connectionManager.selectedProfile, 'groq-profile');

  const allowed = settings.extension_settings.preset_allowed_regex.openai;
  assert.equal(allowed.includes('Existing Preset'), true);
  for (const name of PRESETS) {
    assert.equal(allowed.includes(name), true, `regex not allowed for ${name}`);
  }

  assert.equal(
    fs.existsSync(path.join(fixture.userDataDir, 'backups', 'settings.before-nemoengine.json')),
    true,
  );

  const manifestPath = path.join(fixture.userDataDir, 'extensions', 'NemoPresetExt', 'manifest.json');
  assert.equal(fs.existsSync(manifestPath), true);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.display_name, 'NemoPresetExt');
  assert.equal(manifest.version, '6.0.6');

  assert.match(result.stdout, /NemoEngine presets synced/);
  assert.match(result.stdout, /NemoPresetExt ready/);
  assert.match(result.stdout, /NemoEngine active preset: Nemo Engine 11\.5\.2 - Ready RU RP/);
  assert.match(result.stdout, /NemoEngine preset regex allowed/);
});

test('is idempotent and fails closed on structurally invalid Nemo preset input', () => {
  const fixture = makeFixture();

  let result = runSeeder(fixture);
  assert.equal(result.status, 0, result.stderr);

  const settingsPath = path.join(fixture.userDataDir, 'settings.json');
  const firstSettings = fs.readFileSync(settingsPath, 'utf8');

  result = runSeeder(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), firstSettings);

  fs.writeFileSync(
    path.join(fixture.sourceDir, 'Nemo Engine 11.5.2 - General RP.json'),
    JSON.stringify({ prompts: [], prompt_order: [], extensions: { regex_scripts: [] } }),
  );

  result = runSeeder(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid NemoEngine preset/i);

  const settingsAfterFailure = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(settingsAfterFailure.oai_settings.chat_completion_source, 'groq');
  assert.equal(settingsAfterFailure.extension_settings.connectionManager.selectedProfile, 'groq-profile');
});
