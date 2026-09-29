import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  executeOneShot,
  parseOneShotCommand,
} from './sillytavern-railway-one-shot.mjs';

test('parseOneShotCommand treats empty input as skipped', () => {
  assert.deepEqual(parseOneShotCommand(''), { op: 'skip' });
  assert.deepEqual(parseOneShotCommand('   '), { op: 'skip' });
});

test('turn performs exactly one POST to the protected mobile gateway', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, saved: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await executeOneShot({
    command: {
      op: 'turn',
      avatarUrl: 'Darya.png',
      fileName: 'Darya Native Story F1',
      userText: 'ONE_SHOT_TEST',
    },
    publicDomain: 'example.up.railway.app',
    mcpPath: '/secret/mcp',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.up.railway.app/secret/mobile/turn');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    avatarUrl: 'Darya.png',
    fileName: 'Darya Native Story F1',
    userText: 'ONE_SHOT_TEST',
  });
  assert.deepEqual(result, { ok: true, saved: true });
});

test('recent_chats performs one GET and never retries a failure', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response('upstream failed', { status: 502 });
  };

  await assert.rejects(
    () =>
      executeOneShot({
        command: { op: 'recent_chats' },
        publicDomain: 'example.up.railway.app',
        mcpPath: '/secret/mcp',
        fetchImpl,
      }),
    /502/,
  );
  assert.equal(calls, 1);
});

test('skip performs no network call', async () => {
  let calls = 0;
  const result = await executeOneShot({
    command: { op: 'skip' },
    publicDomain: 'example.up.railway.app',
    mcpPath: '/secret/mcp',
    fetchImpl: async () => {
      calls += 1;
      throw new Error('must not be called');
    },
  });
  assert.equal(calls, 0);
  assert.deepEqual(result, { ok: true, skipped: true });
});


test('CLI executes only with explicit --run and emits a terminal result marker', () => {
  const script = fileURLToPath(new URL('./sillytavern-railway-one-shot.mjs', import.meta.url));
  const baseEnv = { ...process.env, SILLYTAVERN_ONE_SHOT_JSON: '' };

  const passive = spawnSync(process.execPath, [script], {
    env: baseEnv,
    encoding: 'utf8',
  });
  assert.equal(passive.status, 0);
  assert.equal(passive.stdout.trim(), '');

  const explicit = spawnSync(process.execPath, [script, '--run'], {
    env: baseEnv,
    encoding: 'utf8',
  });
  assert.equal(explicit.status, 0);
  assert.match(explicit.stdout, /SILLYTAVERN_ONE_SHOT_RESULT/);
  assert.match(explicit.stdout, /\"skipped\":true/);
});

test('exact Nemo catalog performs exactly one GET through the mobile gateway', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify([{ id: 'canonical-ready-ru-gooner-rp' }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await executeOneShot({
    command: { op: 'nemo_exact_catalog', nonce: 'catalog-1' },
    publicDomain: 'example.up.railway.app',
    mcpPath: '/secret/mcp',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.up.railway.app/secret/mobile/nemo-exact-catalog');
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(result, [{ id: 'canonical-ready-ru-gooner-rp' }]);
});

test('exact Nemo activation performs one POST with the requested entryId', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      ok: true,
      entryId: 'canonical-ready-ru-gooner-rp',
      slotName: 'Nemo Exact Active',
      storedPresetExact: true,
      activeSettingsExact: true,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await executeOneShot({
    command: {
      op: 'nemo_exact_activate',
      nonce: 'activate-1',
      entryId: 'canonical-ready-ru-gooner-rp',
    },
    publicDomain: 'example.up.railway.app',
    mcpPath: '/secret/mcp',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.up.railway.app/secret/mobile/nemo-exact-activate');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    entryId: 'canonical-ready-ru-gooner-rp',
  });
  assert.equal(result.activeSettingsExact, true);
});

test('exact Nemo install accepts one entryId or all and client generation status preserves marker', async () => {
  assert.deepEqual(
    parseOneShotCommand(JSON.stringify({
      op: 'nemo_exact_install',
      nonce: 'install-1',
      entryId: 'all',
    })),
    {
      op: 'nemo_exact_install',
      nonce: 'install-1',
      entryId: 'all',
    },
  );

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ available: true, marker: 'M1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await executeOneShot({
    command: {
      op: 'client_generation_status',
      nonce: 'status-1',
      marker: 'M1',
    },
    publicDomain: 'example.up.railway.app',
    mcpPath: '/secret/mcp',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.up.railway.app/secret/mobile/client-generation-status?marker=M1');
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(result, { available: true, marker: 'M1' });
});

test('new exact Nemo write operations require entryId', () => {
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({ op: 'nemo_exact_install' })),
    /entryId is required/,
  );
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({ op: 'nemo_exact_activate' })),
    /entryId is required/,
  );
});
