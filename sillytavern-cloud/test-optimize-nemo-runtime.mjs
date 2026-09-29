import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const optimizer = process.env.NEMO_OPTIMIZER || '/usr/local/bin/optimize-nemo-runtime.mjs';

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fixtureExtension(root) {
  write(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));\n  write(path.join(root, 'manifest.json'), JSON.stringify({ display_name: 'NemoPresetExt', version: '6.0.6' }));

  write(path.join(root, 'features/recipe-runtime/format.js'), `
export const runtimeOf = preset => preset.extensions?.nemoRecipeRuntime ?? null;
export const isCandidate = preset => preset.recipeCandidate === true && !runtimeOf(preset);
export const planExtraction = () => ({ fixture: true });
`);
  write(path.join(root, 'features/recipe-runtime/store.js'), `
export class RecipeStore {
  constructor({ fetchFn }) { this.fetchFn = fetchFn; }
  async extract(preset) {
    const response = await this.fetchFn('/api/files/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'nemo-recipes-fixture.json', data: btoa(JSON.stringify({ ok: true })) }),
    });
    if (!response.ok) throw new Error('recipe upload failed');
    return { ...preset, recipeCandidate: false, extensions: { ...preset.extensions, nemoRecipeRuntime: { schema: 1, manifest: { path: '/files/nemo-recipes-fixture.json', sha256: 'fixture' } } } };
  }
  async manifest(preset) { return preset.extensions.nemoRecipeRuntime; }
}
`);

  write(path.join(root, 'features/vex-runtime/format.js'), `
export const runtimeOf = preset => preset.extensions?.nemoVexRuntime ?? null;
export const candidate = preset => preset.vexCandidate === true && !runtimeOf(preset);
export async function planExtraction() { return { fixture: true }; }
`);
  write(path.join(root, 'features/vex-runtime/store.js'), `
export class VexStore {
  constructor({ fetchFn }) { this.fetchFn = fetchFn; }
  async extract(preset) {
    const response = await this.fetchFn('/api/files/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'nemo-vex-source-fixture.json', data: btoa(JSON.stringify({ ok: true })) }),
    });
    if (!response.ok) throw new Error('vex upload failed');
    return { ...preset, vexCandidate: false, extensions: { ...preset.extensions, nemoVexRuntime: { schema: 'fixture' } } };
  }
  async manifest(preset) { return preset.extensions.nemoVexRuntime; }
}
`);

  write(path.join(root, 'features/cold-prompts/format.js'), `
export const BODY_KEY = 'nemoPromptBody';
export const descriptorOf = prompt => prompt?.nemoPromptBody ?? null;
export const hasBodies = preset => preset.prompts.some(prompt => prompt.nemoPromptBody);
export const isNemoPreset = () => true;
export const eligible = prompt => prompt.identifier === 'cold-1' && !prompt.nemoPromptBody;
export function validatePreset(preset) {
  if (!Array.isArray(preset.prompts) || !Array.isArray(preset.prompt_order)) throw new Error('invalid preset');
}
`);
  write(path.join(root, 'features/cold-prompts/store.js'), `
const digest = async text => {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};
export class PromptBodyStore {
  constructor({ fetchFn }) { this.fetchFn = fetchFn; }
  async writeMany(records) {
    const text = JSON.stringify({ schema: 1, bodies: records.map(record => record.content) });
    const sha256 = await digest(text);
    const name = 'nemo-prompts-' + sha256 + '.json';
    const response = await this.fetchFn('/api/files/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, data: btoa(text) }),
    });
    if (!response.ok) throw new Error('cold upload failed');
    const ref = { path: '/files/' + name, sha256 };
    return new Map(records.map((record, index) => [record.prompt, {
      schema: 1,
      ref,
      index,
      characters: record.content.length,
      shell: '[cold-shell]',
    }]));
  }
  async readMany(prompts, visit) { for (const prompt of prompts) await visit(prompt, 'fixture-body'); }
}
`);
}

test('offline optimizer creates Nemo runtime descriptors and preserves the selected provider profile', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-offline-'));
  const user = path.join(root, 'default-user');
  const ext = path.join(user, 'extensions', 'NemoPresetExt');
  const presetDir = path.join(user, 'OpenAI Settings');
  fs.mkdirSync(presetDir, { recursive: true });
  fs.mkdirSync(path.join(user, 'files'), { recursive: true });
  fixtureExtension(ext);

  const presetName = 'Nemo Engine 11.5.2 - Ready RU RP';
  write(path.join(presetDir, presetName + '.json'), JSON.stringify({
    recipeCandidate: true,
    vexCandidate: true,
    prompts: [
      { identifier: 'cold-1', content: 'This long prompt body should be externalized.' },
      { identifier: 'hot-1', content: 'Keep me hot.' },
    ],
    prompt_order: [{ character_id: 100001, order: [
      { identifier: 'cold-1', enabled: false },
      { identifier: 'hot-1', enabled: true },
    ] }],
    extensions: { regex_scripts: Array.from({ length: 97 }, (_, i) => ({ id: 'rx-' + i })) },
  }, null, 2));

  write(path.join(user, 'settings.json'), JSON.stringify({
    oai_settings: {
      preset_settings_openai: presetName,
      chat_completion_source: 'groq',
      groq_model: 'openai/gpt-oss-120b',
    },
    extension_settings: {
      connectionManager: {
        selectedProfile: 'groq-profile',
        profiles: [{ id: 'groq-profile', name: 'Groq' }],
      },
      NemoPresetExt: {},
    },
  }, null, 2));

  const result = spawnSync(process.execPath, [optimizer], {
    env: {
      ...process.env,
      SILLYTAVERN_USER_DATA_DIR: user,
      NEMO_PRESET_EXT_DIR: ext,
      NEMO_ACTIVE_PRESET: presetName,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);

  const optimized = JSON.parse(fs.readFileSync(path.join(presetDir, presetName + '.json'), 'utf8'));
  assert.equal(Boolean(optimized.extensions.nemoRecipeRuntime), true);
  assert.equal(Boolean(optimized.extensions.nemoVexRuntime), true);
  assert.equal(Boolean(optimized.prompts[0].nemoPromptBody), true);
  assert.equal(optimized.prompts[0].content, '[cold-shell]');

  const settings = JSON.parse(fs.readFileSync(path.join(user, 'settings.json'), 'utf8'));
  assert.equal(settings.oai_settings.chat_completion_source, 'groq');
  assert.equal(settings.oai_settings.groq_model, 'openai/gpt-oss-120b');
  assert.equal(settings.extension_settings.connectionManager.selectedProfile, 'groq-profile');
  assert.equal(settings.extension_settings.NemoPresetExt.enableRecipeRuntime, true);
  assert.equal(settings.extension_settings.NemoPresetExt.enableColdPromptStorage, true);
  assert.equal(settings.extension_settings.NemoPresetExt.enableVexRuntime, true);
  assert.equal(settings.extension_settings.NemoPresetExt.enableIncrementalPromptRendering, true);

  const report = JSON.parse(fs.readFileSync(path.join(user, 'files', 'nemo-runtime-report.json'), 'utf8'));
  assert.equal(report.ok, true);
  assert.equal(report.recipe.active, true);
  assert.equal(report.vex.active, true);
  assert.equal(report.cold.count, 1);
  assert.equal(report.preset, presetName);

  assert.equal(fs.existsSync(path.join(user, 'files', 'nemo-recipes-fixture.json')), true);
  assert.equal(fs.existsSync(path.join(user, 'files', 'nemo-vex-source-fixture.json')), true);
  assert.equal(fs.readdirSync(path.join(user, 'files')).some(name => name.startsWith('nemo-prompts-')), true);
  assert.equal(fs.existsSync(path.join(user, 'backups', 'nemo-runtime', presetName + '.portable.json')), true);
});
