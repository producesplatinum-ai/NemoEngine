import assert from 'node:assert/strict';
import test from 'node:test';

import { SillyTavernClient } from './sillytavern-server.mjs';
import { executeMobileRestRoute } from './sillytavern-mobile-rest.mjs';
import { runOneShot } from './sillytavern-one-shot.mjs';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('one-shot forwards nonce in turn POST body', async () => {
  const calls = [];
  await runOneShot({
    raw: JSON.stringify({
      nonce: 'nonce-turn-1',
      op: 'turn',
      avatarUrl: 'Darya.png',
      fileName: 'Darya Native Story F1',
      userText: 'IDEMPOTENT_TURN',
    }),
    baseUrl: 'https://example.test/mobile',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true, saved: true });
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    nonce: 'nonce-turn-1',
    avatarUrl: 'Darya.png',
    fileName: 'Darya Native Story F1',
    userText: 'IDEMPOTENT_TURN',
  });
});

test('appendUserMessage deduplicates an already-persisted one-shot nonce', async () => {
  let saveCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return jsonResponse({ token: 'csrf-idempotent-turn' });
    if (path === '/api/characters/get') return jsonResponse({ name: 'Seraphina' });
    if (path === '/api/chats/get') {
      return jsonResponse([
        {
          user_name: 'You',
          character_name: 'Seraphina',
          chat_metadata: {},
        },
        {
          name: 'You',
          is_user: true,
          is_system: false,
          mes: 'IDEMPOTENT_TURN',
          extra: {
            one_shot_nonce: 'nonce-turn-1',
            one_shot_op: 'turn',
          },
        },
      ]);
    }
    if (path === '/api/chats/save') {
      saveCalls += 1;
      return jsonResponse({ result: 'ok' });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });

  const result = await client.appendUserMessage({
    avatarUrl: 'default_Seraphina.png',
    fileName: 'Nemo mobile test',
    userText: 'IDEMPOTENT_TURN',
    nonce: 'nonce-turn-1',
  });

  assert.equal(saveCalls, 0);
  assert.equal(result.ok, true);
  assert.equal(result.saved, true);
  assert.equal(result.deduplicated, true);
  assert.equal(result.messageCount, 2);
});

test('generateAssistantMessage deduplicates nonce without provider call or second save', async () => {
  let providerCalls = 0;
  let saveCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return jsonResponse({ token: 'csrf-idempotent-generate' });
    if (path === '/api/characters/get') return jsonResponse({ name: 'Seraphina' });
    if (path === '/api/chats/get') {
      return jsonResponse([
        {
          user_name: 'You',
          character_name: 'Seraphina',
          chat_metadata: {},
        },
        {
          name: 'You',
          is_user: true,
          is_system: false,
          mes: 'Say hello.',
          extra: {},
        },
        {
          name: 'Seraphina',
          is_user: false,
          is_system: false,
          mes: 'EXISTING_ASSISTANT',
          extra: {
            one_shot_nonce: 'nonce-generate-1',
            one_shot_op: 'generate',
          },
        },
      ]);
    }
    if (path === '/api/backends/chat-completions/generate') {
      providerCalls += 1;
      return jsonResponse({
        choices: [{ message: { content: 'DUPLICATE_SHOULD_NOT_HAPPEN' } }],
      });
    }
    if (path === '/api/chats/save') {
      saveCalls += 1;
      return jsonResponse({ result: 'ok' });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });

  const result = await client.generateAssistantMessage({
    avatarUrl: 'default_Seraphina.png',
    fileName: 'Nemo mobile test',
    source: 'deepseek',
    model: 'deepseek-flash',
    nonce: 'nonce-generate-1',
  });

  assert.equal(providerCalls, 0);
  assert.equal(saveCalls, 0);
  assert.equal(result.ok, true);
  assert.equal(result.saved, true);
  assert.equal(result.deduplicated, true);
  assert.equal(result.message, 'EXISTING_ASSISTANT');
  assert.equal(result.messageCount, 3);
});


test('mobile REST forwards nonce to explicit turn and generate client calls', async () => {
  const turnCalls = [];
  const generateCalls = [];
  const client = {
    async appendUserMessage(input) {
      turnCalls.push(input);
      return { ok: true, saved: true };
    },
    async generateAssistantMessage(input) {
      generateCalls.push(input);
      return { ok: true, saved: true, message: 'OK' };
    },
  };

  await executeMobileRestRoute(
    { kind: 'turn' },
    client,
    {
      nonce: 'nonce-rest-turn',
      avatarUrl: 'Darya.png',
      fileName: 'Darya Native Story F1',
      userText: 'TURN',
    },
  );
  await executeMobileRestRoute(
    { kind: 'generate' },
    client,
    {
      nonce: 'nonce-rest-generate',
      avatarUrl: 'Darya.png',
      fileName: 'Darya Native Story F1',
      source: 'deepseek',
      model: 'deepseek-flash',
    },
  );

  assert.deepEqual(turnCalls, [{
    nonce: 'nonce-rest-turn',
    avatarUrl: 'Darya.png',
    fileName: 'Darya Native Story F1',
    userText: 'TURN',
  }]);
  assert.deepEqual(generateCalls, [{
    nonce: 'nonce-rest-generate',
    avatarUrl: 'Darya.png',
    fileName: 'Darya Native Story F1',
    source: 'deepseek',
    model: 'deepseek-flash',
  }]);
});
