import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const installer = process.env.NEMO_BOOTSTRAP_INSTALLER || '/usr/local/bin/install-nemo-full-bootstrap.mjs';

test('installs a client-side Nemo bootstrap extension with the full import/runtime contract', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-bootstrap-'));
  const source = path.join(root, 'source');
  const user = path.join(root, 'user');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(user, { recursive: true });

  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({
    display_name: 'Nemo Full Bootstrap',
    version: '1.0.0',
    js: 'index.js',
    loading_order: 1100,
  }, null, 2));
  fs.writeFileSync(path.join(source, 'index.js'), [
    "const ACTIVE_PRESET = 'Nemo Engine 11.5.2 - Ready RU Gooner RP';",
    "event_types.OAI_PRESET_IMPORT_READY",
    "globalThis.NemoRecipeRuntime",
    "globalThis.NemoColdPrompts",
    "globalThis.NemoVexRuntime",
    "globalThis.NemoPromptRendering",
    "enableRecipeRuntime",
    "enableColdPromptStorage",
    "enableVexRuntime",
    "enableIncrementalPromptRendering",
  ].join('\n'));

  const run = spawnSync(process.execPath, [installer], {
    env: {
      ...process.env,
      SILLYTAVERN_USER_DATA_DIR: user,
      NEMO_BOOTSTRAP_SOURCE_DIR: source,
    },
    encoding: 'utf8',
  });

  assert.equal(run.status, 0, run.stderr);
  const dest = path.join(user, 'extensions', 'NemoFullBootstrap');
  const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'));
  const script = fs.readFileSync(path.join(dest, 'index.js'), 'utf8');

  assert.equal(manifest.display_name, 'Nemo Full Bootstrap');
  assert.equal(manifest.loading_order, 1100);
  assert.match(script, /Nemo Engine 11\.5\.2 - Ready RU Gooner RP/);
  assert.match(script, /OAI_PRESET_IMPORT_READY/);
  assert.match(script, /NemoRecipeRuntime/);
  assert.match(script, /NemoColdPrompts/);
  assert.match(script, /NemoVexRuntime/);
  assert.match(script, /NemoPromptRendering/);
});


test('production Nemo Full Bootstrap persists client runtime preflight report', () => {
  const sourceDir = process.env.NEMO_BOOTSTRAP_PRODUCTION_SOURCE || '/usr/local/share/nemo-full-bootstrap';
  const scriptPath = path.join(sourceDir, 'index.js');
  assert.equal(fs.existsSync(scriptPath), true, 'production bootstrap source missing');
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.match(script, /nemo-client-runtime-report\.json/);
  assert.match(script, /\/api\/files\/upload/);
  assert.match(script, /persistClientReport/);
  assert.match(script, /getRequestHeaders/);
  assert.match(script, /persistedReport/);
  assert.match(script, /persistence:\s*persistence/);
});


test('production Nemo Full Bootstrap supports guarded one-shot client generation diagnostic', () => {
  const sourceDir = process.env.NEMO_BOOTSTRAP_PRODUCTION_SOURCE || '/usr/local/share/nemo-full-bootstrap';
  const scriptPath = path.join(sourceDir, 'index.js');
  assert.equal(fs.existsSync(scriptPath), true, 'production bootstrap source missing');
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.match(script, /nemo-client-generation-report\.json/);
  assert.match(script, /Generate\('normal'\)/);
  assert.match(script, /selectCharacterById/);
  assert.match(script, /openCharacterChat/);
  assert.match(script, /history\.replaceState/);
  assert.match(script, /nemoClientGenerate/);
  assert.match(script, /requestId/);
  assert.match(script, /marker/);
});


test('client generation diagnostic distinguishes generated from already-present assistant turns', () => {
  const sourceDir = process.env.NEMO_BOOTSTRAP_PRODUCTION_SOURCE || '/usr/local/share/nemo-full-bootstrap';
  const script = fs.readFileSync(path.join(sourceDir, 'index.js'), 'utf8');

  assert.match(script, /generatedNewAssistant/);
  assert.match(script, /outcome:\s*'generated'/);
  assert.match(script, /outcome:\s*'already_present'/);
  assert.match(script, /generatedNewAssistant:\s*false/);
  assert.match(script, /generatedNewAssistant:\s*true/);
});
