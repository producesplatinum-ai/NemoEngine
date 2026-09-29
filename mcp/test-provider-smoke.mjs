import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SillyTavernClient,
  runProviderSmoke,
} from './sillytavern-server.mjs';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      getSetCookie() { return []; },
      get(name) {
        return String(name).toLowerCase() === 'content-type' ? 'application/json' : null;
      },
    },
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

test('SillyTavern client sends a minimal provider generation through chat-completions backend', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/csrf-token')) {
      return jsonResponse({ token: 'csrf-smoke' });
    }

    assert.equal(String(url), 'https://st.example.test/api/backends/chat-completions/generate');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['x-csrf-token'], 'csrf-smoke');

    const body = JSON.parse(options.body);
    assert.equal(body.chat_completion_source, 'groq');
    assert.equal(body.model, 'openai/gpt-oss-120b');
    assert.equal(body.stream, false);
    assert.equal(body.temperature, 0);
    assert.equal(body.max_tokens, 24);
    assert.deepEqual(body.messages, [
      { role: 'user', content: 'Reply exactly: GROQ_OK' },
    ]);

    return jsonResponse({
      choices: [{ message: { content: 'GROQ_OK' } }],
    });
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });

  const result = await client.generateChatCompletion({
    source: 'groq',
    model: 'openai/gpt-oss-120b',
    expected: 'GROQ_OK',
  });

  assert.deepEqual(result, {
    source: 'groq',
    model: 'openai/gpt-oss-120b',
    ok: true,
    response: 'GROQ_OK',
  });
  assert.equal(calls.length, 2);
});

test('provider smoke checks DeepSeek, Groq, and OpenRouter sequentially without returning raw provider payloads', async () => {
  const seen = [];
  const fakeClient = {
    async status() {
      return { ok: true };
    },
    async generateChatCompletion(input) {
      seen.push(input);
      return {
        source: input.source,
        model: input.model,
        ok: true,
        response: input.expected,
      };
    },
  };

  const result = await runProviderSmoke({
    getClient: () => fakeClient,
    retryDelayMs: 0,
    maxReadinessAttempts: 1,
  });

  assert.deepEqual(seen, [
    { source: 'deepseek', model: 'deepseek-flash', expected: 'DEEPSEEK_OK' },
    { source: 'groq', model: 'openai/gpt-oss-120b', expected: 'GROQ_OK' },
    { source: 'openrouter', model: 'openrouter/auto', expected: 'OPENROUTER_OK' },
  ]);
  assert.deepEqual(result, {
    ok: true,
    providers: [
      { source: 'deepseek', model: 'deepseek-flash', ok: true, response: 'DEEPSEEK_OK' },
      { source: 'groq', model: 'openai/gpt-oss-120b', ok: true, response: 'GROQ_OK' },
      { source: 'openrouter', model: 'openrouter/auto', ok: true, response: 'OPENROUTER_OK' },
    ],
  });
});
