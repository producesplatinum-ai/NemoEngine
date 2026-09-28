import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const seedScript = process.env.SEED_SCRIPT || '/usr/local/bin/seed-provider-secrets.mjs';

function runSeeder(userDataDir, overrides = {}) {
  return spawnSync(process.execPath, [seedScript], {
    env: {
      ...process.env,
      SILLYTAVERN_USER_DATA_DIR: userDataDir,
      GROQ_API_KEY: '',
      OPENROUTER_API_KEY: '',
      DEEPSEEK_API_KEY: '',
      ...overrides,
    },
    encoding: 'utf8',
  });
}

function readSecrets(userDataDir) {
  return JSON.parse(fs.readFileSync(path.join(userDataDir, 'secrets.json'), 'utf8'));
}

test('seeds Groq, OpenRouter, and DeepSeek without overwriting unrelated secrets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-secrets-'));
  fs.writeFileSync(path.join(root, 'secrets.json'), JSON.stringify({
    api_key_openai: [{ id: 'existing', value: 'keep-me', label: 'Existing', active: true }],
  }));

  const result = runSeeder(root, {
    GROQ_API_KEY: 'groq-test-key',
    OPENROUTER_API_KEY: 'openrouter-test-key',
    DEEPSEEK_API_KEY: 'deepseek-test-key',
  });

  assert.equal(result.status, 0, result.stderr);
  const secrets = readSecrets(root);

  assert.equal(secrets.api_key_openai[0].value, 'keep-me');
  assert.equal(secrets.api_key_groq.length, 1);
  assert.equal(secrets.api_key_groq[0].value, 'groq-test-key');
  assert.equal(secrets.api_key_groq[0].active, true);
  assert.equal(secrets.api_key_openrouter.length, 1);
  assert.equal(secrets.api_key_openrouter[0].value, 'openrouter-test-key');
  assert.equal(secrets.api_key_deepseek.length, 1);
  assert.equal(secrets.api_key_deepseek[0].value, 'deepseek-test-key');

  for (const secret of ['groq-test-key', 'openrouter-test-key', 'deepseek-test-key']) {
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes(secret), false);
  }
});

test('is idempotent and rotates only the changed provider secret', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-secrets-'));

  let result = runSeeder(root, {
    GROQ_API_KEY: 'groq-v1',
    OPENROUTER_API_KEY: 'openrouter-v1',
    DEEPSEEK_API_KEY: 'deepseek-v1',
  });
  assert.equal(result.status, 0, result.stderr);

  result = runSeeder(root, {
    GROQ_API_KEY: 'groq-v1',
    OPENROUTER_API_KEY: 'openrouter-v1',
    DEEPSEEK_API_KEY: 'deepseek-v1',
  });
  assert.equal(result.status, 0, result.stderr);

  let secrets = readSecrets(root);
  assert.equal(secrets.api_key_groq.length, 1);
  assert.equal(secrets.api_key_openrouter.length, 1);
  assert.equal(secrets.api_key_deepseek.length, 1);

  result = runSeeder(root, {
    GROQ_API_KEY: 'groq-v2',
    OPENROUTER_API_KEY: 'openrouter-v1',
    DEEPSEEK_API_KEY: 'deepseek-v1',
  });
  assert.equal(result.status, 0, result.stderr);

  secrets = readSecrets(root);
  assert.equal(secrets.api_key_groq.length, 2);
  assert.equal(secrets.api_key_groq[0].active, false);
  assert.equal(secrets.api_key_groq[1].value, 'groq-v2');
  assert.equal(secrets.api_key_groq[1].active, true);
  assert.equal(secrets.api_key_openrouter.length, 1);
  assert.equal(secrets.api_key_deepseek.length, 1);
});
