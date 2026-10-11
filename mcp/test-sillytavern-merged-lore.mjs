import assert from 'node:assert/strict';
import test from 'node:test';
import { SillyTavernClient } from './sillytavern-server.mjs';

function response(body) {
  return {
    ok: true,
    status: 200,
    headers: {
      getSetCookie() { return []; },
      get(name) { return name === 'content-type' ? 'application/json' : null; },
    },
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

for (const mode of ['generate', 'nemo_generate']) {
  test(`${mode} combines embedded character lore with selected external World Info records`, async () => {
    let postedMessages = null;
    let externalReads = 0;
    const fetchImpl = async (url, options = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === '/csrf-token') return response({ token: 'test-csrf' });
      if (path === '/api/characters/get') return response({
        data: {
          name: 'Дарья',
          description: 'Fictional adult test character',
          extensions: { world: 'Darya' },
          character_book: {
            name: 'Darya',
            entries: [{
              id: 0, enabled: true, constant: true, keys: [],
              content: 'TEST_EMBEDDED_VOICE_RULE',
            }],
          },
        },
      });
      if (path === '/api/chats/get') return response([
        { user_name: 'You', character_name: 'Дарья', chat_metadata: {} },
        { name: 'You', is_user: true, is_system: false, mes: 'Расскажи про страницу 184.' },
      ]);
      if (path === '/api/worldinfo/get') {
        externalReads++;
        return response({ entries: {
          26: {
            uid: 26, key: ['страница 184'], constant: false, disable: false,
            content: 'TEST_EXTERNAL_DIARY_SELECTED',
          },
          27: {
            uid: 27, key: ['страница 999'], constant: false, disable: false,
            content: 'TEST_EXTERNAL_DIARY_UNMATCHED',
          },
          28: {
            uid: 28, key: ['страница 184'], constant: false, disable: true,
            content: 'TEST_EXTERNAL_DIARY_DISABLED',
          },
        } });
      }
      if (path === '/api/backends/chat-completions/generate') {
        postedMessages = JSON.parse(options.body).messages;
        return response({ choices: [{
          finish_reason: 'stop',
          message: { content: 'TEST_MODEL_ANSWER' },
        }] });
      }
      if (path === '/api/chats/save') return response({ result: 'ok' });
      throw new Error('Unexpected path: ' + path);
    };
    const client = new SillyTavernClient({
      baseUrl: 'https://st.example.test',
      fetchImpl,
      nemoCompiler: async () => ({
        instructions: 'TEST_NEMO_INSTRUCTIONS',
        chars: 22,
        sha256: 'a'.repeat(64),
      }),
      nemoOutputSanitizer: s => s,
    });
    const args = {
      avatarUrl: 'Darya.png',
      fileName: 'Darya integration test',
      source: 'openrouter',
      model: 'test-model',
      nonce: `merged-lore-${mode}`,
    };
    if (mode === 'nemo_generate') {
      await client.generateNemoAssistantMessage({
        ...args, entryId: 'canonical-ready-ru-gooner-humiliation-joi-rp',
      });
    } else {
      await client.generateAssistantMessage(args);
    }

    const joined = postedMessages.map(x => x.content).join('\n');
    assert.equal(externalReads, 1, 'linked book must be loaded despite embedded card lore');
    assert.match(joined, /TEST_EMBEDDED_VOICE_RULE/);
    assert.match(joined, /TEST_EXTERNAL_DIARY_SELECTED/);
    assert.doesNotMatch(joined, /TEST_EXTERNAL_DIARY_UNMATCHED/);
    assert.doesNotMatch(joined, /TEST_EXTERNAL_DIARY_DISABLED/);
    assert.equal(joined.match(/TEST_EMBEDDED_VOICE_RULE/g)?.length, 1);
  });
}
