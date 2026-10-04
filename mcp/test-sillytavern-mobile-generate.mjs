import assert from 'node:assert/strict';
import test from 'node:test';
import { SillyTavernClient } from './sillytavern-server.mjs';
import {
  buildNemoPortableContext,
  compileNemoInstructions,
} from './nemo-mobile-generation.mjs';

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

test('buildNemoPortableContext maps character and recent transcript into runtime macros', () => {
  const context = buildNemoPortableContext({
    character: {
      data: {
        name: 'Дарья',
        scenario: 'Test scenario',
        personality: 'Sharp and direct',
        description: 'Adult fictional character',
      },
    },
    characterName: 'Дарья',
    conversation: [
      { is_user: true, mes: 'Первый факт.' },
      { is_user: false, mes: 'Ответ.' },
    ],
  });

  assert.equal(context.macros.char, 'Дарья');
  assert.equal(context.macros.scenario, 'Test scenario');
  assert.equal(context.macros.personality, 'Sharp and direct');
  assert.match(context.macros.summary, /User: Первый факт\./);
  assert.match(context.macros.summary, /Дарья: Ответ\./);
  assert.match(context.macros.short_term_memory, /Ответ\./);
  assert.equal(context.macros.NemoLore, '');
});

test('compileNemoInstructions invokes the repository runtime in portable instructions-only mode', async () => {
  let call = null;
  const result = await compileNemoInstructions({
    preset: { prompts: [], prompt_order: [] },
    context: { macros: {}, globals: {}, variables: {} },
    spawnImpl(executable, args, options) {
      call = { executable, args, options };
      return { status: 0, stdout: 'COMPILED_NEMO_INSTRUCTIONS\n', stderr: '' };
    },
  });

  assert.equal(result.instructions, 'COMPILED_NEMO_INSTRUCTIONS');
  assert.ok(result.chars > 0);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(call.executable, process.execPath);
  assert.ok(call.args.some(value => String(value).endsWith('nemo-chatgpt-runtime.mjs')));
  assert.ok(call.args.includes('--instructions-only'));
  assert.ok(call.args.includes('--mode'));
  assert.ok(call.args.includes('portable'));
  assert.ok(call.args.includes('--context'));
});

test('generateNemoAssistantMessage injects compiled Nemo instructions before provider generation and persists metadata', async () => {
  let generated = null;
  let saved = null;
  let sanitized = null;
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return response({ token: 'csrf' });
    if (path === '/api/characters/get') {
      return response({
        name: 'Дарья',
        data: {
          name: 'Дарья',
          description: 'Adult fictional character.',
          personality: 'Sharp and direct.',
          scenario: 'A controlled fictional test.',
          extensions: {},
        },
      });
    }
    if (path === '/api/chats/get') {
      return response([
        { user_name: 'You', character_name: 'Дарья', chat_metadata: {} },
        { name: 'You', is_user: true, is_system: false, mes: 'Продолжай сцену.' },
      ]);
    }
    if (path === '/api/backends/chat-completions/generate') {
      generated = JSON.parse(options.body);
      return response({
        choices: [{
          finish_reason: 'stop',
          message: { content: '<nemo-final>RAW_NEMO_REPLY</nemo-final>' },
        }],
      });
    }
    if (path === '/api/chats/save') {
      saved = JSON.parse(options.body);
      return response({ result: 'ok' });
    }
    throw new Error('unexpected path: ' + path);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
    nemoCompiler: async () => ({
      instructions: 'COMPILED_NEMO_SYSTEM',
      chars: 20,
      sha256: 'a'.repeat(64),
    }),
    nemoOutputSanitizer(value) {
      sanitized = value;
      return 'CLEAN_NEMO_REPLY';
    },
  });

  const result = await client.generateNemoAssistantMessage({
    avatarUrl: 'Darya.png',
    fileName: 'Nemo clean scene',
    entryId: 'canonical-ready-ru-gooner-humiliation-joi-rp',
    source: 'openrouter',
    model: 'openai/gpt-oss-120b',
    nonce: 'nemo-test-1',
  });

  assert.equal(result.ok, true);
  assert.equal(result.compiled, true);
  assert.equal(result.message, 'CLEAN_NEMO_REPLY');
  assert.equal(result.compiledSha256, 'a'.repeat(64));
  assert.equal(sanitized, '<nemo-final>RAW_NEMO_REPLY</nemo-final>');
  assert.equal(generated.messages[0].role, 'system');
  assert.match(generated.messages[0].content, /COMPILED_NEMO_SYSTEM/);
  assert.equal(generated.chat_completion_source, 'openrouter');
  assert.equal(generated.model, 'openai/gpt-oss-120b');
  assert.ok(generated.max_tokens >= 4096);
  assert.equal(saved.chat.at(-1).mes, 'CLEAN_NEMO_REPLY');
  assert.equal(saved.chat.at(-1).extra.one_shot_op, 'nemo_generate');
  assert.equal(saved.chat.at(-1).extra.one_shot_nonce, 'nemo-test-1');
  assert.equal(
    saved.chat.at(-1).extra.nemo_entry_id,
    'canonical-ready-ru-gooner-humiliation-joi-rp',
  );
  assert.equal(saved.chat.at(-1).extra.nemo_compiled_chars, 20);
});


test('generateNemoAssistantMessage uses max_completion_tokens for Groq reasoning models', async () => {
  let generated = null;
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === '/csrf-token') return response({ token: 'csrf' });
    if (pathname === '/api/characters/get') {
      return response({
        name: 'Дарья',
        data: {
          name: 'Дарья',
          description: 'Adult fictional character.',
          personality: 'Sharp and direct.',
          scenario: 'A controlled fictional test.',
          extensions: {},
        },
      });
    }
    if (pathname === '/api/chats/get') {
      return response([
        { user_name: 'You', character_name: 'Дарья', chat_metadata: {} },
        { name: 'You', is_user: true, is_system: false, mes: 'Продолжай сцену.' },
      ]);
    }
    if (pathname === '/api/backends/chat-completions/generate') {
      generated = JSON.parse(options.body);
      return response({
        choices: [{
          finish_reason: 'stop',
          message: { content: '<nemo-final>GROQ_REPLY</nemo-final>' },
        }],
      });
    }
    if (pathname === '/api/chats/save') return response({ result: 'ok' });
    throw new Error('unexpected path: ' + pathname);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
    nemoCompiler: async () => ({
      instructions: 'COMPILED_NEMO_SYSTEM',
      chars: 20,
      sha256: 'b'.repeat(64),
    }),
    nemoOutputSanitizer: value => String(value),
  });

  await client.generateNemoAssistantMessage({
    avatarUrl: 'Darya.png',
    fileName: 'Nemo clean scene',
    entryId: 'canonical-ready-ru-gooner-humiliation-joi-rp',
    source: 'groq',
    model: 'openai/gpt-oss-120b',
    nonce: 'nemo-groq-budget-1',
  });

  assert.equal(generated.chat_completion_source, 'groq');
  assert.equal(generated.model, 'openai/gpt-oss-120b');
  assert.equal(generated.max_tokens, undefined);
  assert.ok(generated.max_completion_tokens >= 16_384);
  assert.equal(generated.include_reasoning, false);
});


test('generateNemoAssistantMessage reports safe Groq response diagnostics when content is empty', async () => {
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === '/csrf-token') return response({ token: 'csrf' });
    if (pathname === '/api/characters/get') {
      return response({
        name: 'Дарья',
        data: {
          name: 'Дарья',
          description: 'Adult fictional character.',
          personality: 'Sharp and direct.',
          scenario: 'A controlled fictional test.',
          extensions: {},
        },
      });
    }
    if (pathname === '/api/chats/get') {
      return response([
        { user_name: 'You', character_name: 'Дарья', chat_metadata: {} },
        { name: 'You', is_user: true, is_system: false, mes: 'Продолжай сцену.' },
      ]);
    }
    if (pathname === '/api/backends/chat-completions/generate') {
      return response({
        choices: [{
          finish_reason: 'length',
          message: {
            role: 'assistant',
            content: null,
            reasoning: 'private reasoning that must never be exposed',
          },
        }],
        usage: {
          prompt_tokens: 5000,
          completion_tokens: 16384,
          completion_tokens_details: { reasoning_tokens: 16384 },
        },
      });
    }
    throw new Error('unexpected path: ' + pathname);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
    nemoCompiler: async () => ({
      instructions: 'COMPILED_NEMO_SYSTEM',
      chars: 20,
      sha256: 'c'.repeat(64),
    }),
  });

  await assert.rejects(
    () => client.generateNemoAssistantMessage({
      avatarUrl: 'Darya.png',
      fileName: 'Nemo clean scene',
      entryId: 'canonical-ready-ru-gooner-humiliation-joi-rp',
      source: 'groq',
      model: 'openai/gpt-oss-120b',
      nonce: 'nemo-groq-diagnostic-1',
    }),
    error => {
      assert.match(error.message, /finish_reason=length/);
      assert.match(error.message, /reasoning_chars=43/);
      assert.match(error.message, /completion_tokens=16384/);
      assert.match(error.message, /reasoning_tokens=16384/);
      assert.doesNotMatch(error.message, /private reasoning/);
      return true;
    },
  );
});
