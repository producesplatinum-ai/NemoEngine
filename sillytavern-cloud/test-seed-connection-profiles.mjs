import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const seeder = process.env.PROFILE_SEED_SCRIPT || '/usr/local/bin/seed-connection-profiles.mjs';

function writeSettings(root, value) {
  fs.mkdirSync(path.join(root, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(value, null, 2));
}

function readSettings(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
}

function runSeeder(root) {
  return spawnSync(process.execPath, [seeder], {
    env: { ...process.env, SILLYTAVERN_USER_DATA_DIR: root },
    encoding: 'utf8',
  });
}

test('creates DeepSeek, Groq, and OpenRouter profiles and selects DeepSeek on first setup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-profiles-'));
  writeSettings(root, {
    marker: 'keep-me',
    main_api: 'openai',
    oai_settings: {
      chat_completion_source: 'openai',
      deepseek_model: 'deepseek-v4-flash',
    },
    extension_settings: {
      connectionManager: { selectedProfile: '', profiles: [] },
    },
  });

  const result = runSeeder(root);
  assert.equal(result.status, 0, result.stderr);

  const settings = readSettings(root);
  assert.equal(settings.marker, 'keep-me');
  assert.equal(settings.main_api, 'openai');
  assert.equal(settings.oai_settings.chat_completion_source, 'deepseek');
  assert.equal(settings.oai_settings.deepseek_model, 'deepseek-flash');

  const manager = settings.extension_settings.connectionManager;
  assert.equal(manager.profiles.length, 3);

  const deepseek = manager.profiles.find(p => p.name === 'DeepSeek');
  const groq = manager.profiles.find(p => p.name === 'Groq');
  const openrouter = manager.profiles.find(p => p.name === 'OpenRouter');

  assert.deepEqual(
    { mode: deepseek.mode, api: deepseek.api, preset: deepseek.preset, model: deepseek.model, exclude: deepseek.exclude },
    { mode: 'cc', api: 'deepseek', preset: 'Default', model: 'deepseek-flash', exclude: ['secret-id', 'api-url', 'proxy'] },
  );
  assert.deepEqual(
    { mode: groq.mode, api: groq.api, preset: groq.preset, model: groq.model, exclude: groq.exclude },
    { mode: 'cc', api: 'groq', preset: 'Default', model: 'openai/gpt-oss-120b', exclude: ['secret-id', 'api-url', 'proxy'] },
  );
  assert.deepEqual(
    { mode: openrouter.mode, api: openrouter.api, preset: openrouter.preset, model: openrouter.model, exclude: openrouter.exclude },
    { mode: 'cc', api: 'openrouter', preset: 'Default', model: 'openrouter/auto', exclude: ['secret-id', 'api-url', 'proxy'] },
  );

  assert.equal(manager.selectedProfile, deepseek.id);
  assert.equal(fs.existsSync(path.join(root, 'backups', 'settings.before-provider-profiles.json')), true);
});

test('is idempotent, preserves profile ids, and does not override an existing selected profile', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-profiles-'));
  writeSettings(root, {
    main_api: 'openai',
    oai_settings: {
      chat_completion_source: 'groq',
      deepseek_model: 'deepseek-flash',
    },
    extension_settings: {
      connectionManager: {
        selectedProfile: 'groq-existing-id',
        profiles: [
          { id: 'deepseek-existing-id', name: 'DeepSeek', mode: 'cc', api: 'deepseek', preset: 'Old', model: 'old', exclude: [] },
          { id: 'groq-existing-id', name: 'Groq', mode: 'cc', api: 'groq', preset: 'Old', model: 'old', exclude: [] },
        ],
      },
    },
  });

  let result = runSeeder(root);
  assert.equal(result.status, 0, result.stderr);
  result = runSeeder(root);
  assert.equal(result.status, 0, result.stderr);

  const settings = readSettings(root);
  const manager = settings.extension_settings.connectionManager;

  assert.equal(manager.selectedProfile, 'groq-existing-id');
  assert.equal(manager.profiles.filter(p => p.name === 'DeepSeek').length, 1);
  assert.equal(manager.profiles.filter(p => p.name === 'Groq').length, 1);
  assert.equal(manager.profiles.filter(p => p.name === 'OpenRouter').length, 1);

  assert.equal(manager.profiles.find(p => p.name === 'DeepSeek').id, 'deepseek-existing-id');
  assert.equal(manager.profiles.find(p => p.name === 'Groq').id, 'groq-existing-id');
  assert.equal(manager.profiles.find(p => p.name === 'DeepSeek').model, 'deepseek-flash');
  assert.equal(manager.profiles.find(p => p.name === 'Groq').model, 'openai/gpt-oss-120b');
  assert.equal(manager.profiles.find(p => p.name === 'OpenRouter').model, 'openrouter/auto');

  // Existing active choice remains active on later restarts.
  assert.equal(settings.oai_settings.chat_completion_source, 'groq');
});
