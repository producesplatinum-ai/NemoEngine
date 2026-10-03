import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseOneShotCommand,
  runOneShot,
} from './sillytavern-one-shot.mjs';

test('parses one explicit turn command with nonce', () => {
  const command = parseOneShotCommand(JSON.stringify({
    nonce: 'n-123',
    op: 'turn',
    avatarUrl: 'Darya.png',
    fileName: 'Darya Native Story F1',
    userText: 'ONE_SHOT',
  }));

  assert.deepEqual(command, {
    nonce: 'n-123',
    op: 'turn',
    avatarUrl: 'Darya.png',
    fileName: 'Darya Native Story F1',
    userText: 'ONE_SHOT',
  });
});

test('turn performs exactly one POST and returns parsed JSON', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, saved: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await runOneShot({
    raw: JSON.stringify({
      nonce: 'n-turn',
      op: 'turn',
      avatarUrl: 'Darya.png',
      fileName: 'Darya Native Story F1',
      userText: 'ONE_SHOT_ONLY',
    }),
    baseUrl: 'https://example.test/mobile',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.test/mobile/turn');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    nonce: 'n-turn',
    avatarUrl: 'Darya.png',
    fileName: 'Darya Native Story F1',
    userText: 'ONE_SHOT_ONLY',
  });
  assert.deepEqual(result, {
    nonce: 'n-turn',
    op: 'turn',
    status: 200,
    body: { ok: true, saved: true },
  });
});

test('generate performs exactly one POST and never retries a failure', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: 'upstream failed' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  };

  await assert.rejects(
    runOneShot({
      raw: JSON.stringify({
        nonce: 'n-generate',
        op: 'generate',
        avatarUrl: 'Darya.png',
        fileName: 'Darya Native Story F1',
        source: 'deepseek',
        model: 'deepseek-flash',
      }),
      baseUrl: 'https://example.test/mobile',
      fetchImpl,
    }),
    /one-shot generate failed: 502/,
  );

  assert.equal(calls, 1);
});

test('chat read encodes identifiers and performs one GET', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, messages: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await runOneShot({
    raw: JSON.stringify({
      nonce: 'n-read',
      op: 'chat',
      avatarUrl: 'Darya.png',
      fileName: 'Darya Native Story F1',
    }),
    baseUrl: 'https://example.test/mobile',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /avatarUrl=Darya%2Epng|avatarUrl=Darya.png/);
  assert.match(calls[0].url, /fileName=Darya(?:%20|\+)Native(?:%20|\+)Story(?:%20|\+)F1/);
  assert.equal(calls[0].init.method, 'GET');
});

test('empty command is a no-op and performs no network request', async () => {
  let calls = 0;
  const result = await runOneShot({
    raw: '',
    baseUrl: 'https://example.test/mobile',
    fetchImpl: async () => {
      calls += 1;
      throw new Error('should not call');
    },
  });

  assert.deepEqual(result, { skipped: true });
  assert.equal(calls, 0);
});
