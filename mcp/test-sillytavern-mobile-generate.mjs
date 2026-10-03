import assert from 'node:assert/strict';
import test from 'node:test';
import { SillyTavernClient } from './sillytavern-server.mjs';

function response(body) {
  return {
    ok: true,
    status: 200,
    headers: { getSetCookie() { return []; }, get(name) { return name === 'content-type' ? 'application/json' : null; } },
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

test('generateAssistantMessage uses current chat and persists one assistant reply', async () => {
  let generated = null;
  let saved = null;
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return response({ token: 'csrf' });
    if (path === '/api/characters/get') return response({ name: 'Seraphina', description: 'Guardian of Eldoria.' });
    if (path === '/api/chats/get') return response([
      { user_name: 'You', character_name: 'Seraphina', chat_metadata: {} },
      { name: 'You', is_user: true, is_system: false, mes: 'Are we safe?' },
    ]);
    if (path === '/api/backends/chat-completions/generate') {
      generated = JSON.parse(options.body);
      return response({ choices: [{ finish_reason: 'stop', message: { content: 'Yes. My wards are holding.' } }] });
    }
    if (path === '/api/chats/save') {
      saved = JSON.parse(options.body);
      return response({ result: 'ok' });
    }
    throw new Error('unexpected path: ' + path);
  };

  const client = new SillyTavernClient({ baseUrl: 'https://st.example.test', fetchImpl });
  const result = await client.generateAssistantMessage({
    avatarUrl: 'default_Seraphina.png', fileName: 'Chat 1', source: 'deepseek', model: 'deepseek-flash',
  });

  assert.equal(result.ok, true);
  assert.equal(result.saved, true);
  assert.equal(result.message, 'Yes. My wards are holding.');
  assert.equal(generated.chat_completion_source, 'deepseek');
  assert.equal(generated.model, 'deepseek-flash');
  assert.ok(generated.max_tokens >= 2048, `expected long-form budget, got ${generated.max_tokens}`);
  assert.equal(result.finishReason, 'stop');
  assert.equal(generated.messages.at(-1).role, 'user');
  assert.equal(generated.messages.at(-1).content, 'Are we safe?');
  assert.equal(saved.chat.at(-1).is_user, false);
  assert.equal(saved.chat.at(-1).mes, 'Yes. My wards are holding.');
});