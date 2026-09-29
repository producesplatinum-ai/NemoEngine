import assert from 'node:assert/strict';
import test from 'node:test';

import {
  registerSillyTavernWriteTools,
} from './sillytavern-server.mjs';

function makeToolRegistry() {
  const tools = new Map();
  return {
    tools,
    server: {
      registerTool(name, definition, handler) {
        tools.set(name, { definition, handler });
      },
    },
  };
}

function parseTextResult(result) {
  assert.equal(result?.content?.[0]?.type, 'text');
  return JSON.parse(result.content[0].text);
}

test('direct MCP append tool delegates exactly one explicit user turn to SillyTavern', async () => {
  const calls = [];
  const { server, tools } = makeToolRegistry();

  registerSillyTavernWriteTools(server, {
    getClient: () => ({
      async appendUserMessage(input) {
        calls.push(input);
        return { ok: true, saved: true, messageCount: 7 };
      },
      async generateAssistantMessage() {
        throw new Error('not used');
      },
    }),
  });

  assert.deepEqual(
    [...tools.keys()],
    ['sillytavern_append_turn', 'sillytavern_generate_reply'],
  );

  const result = await tools.get('sillytavern_append_turn').handler({
    avatarUrl: 'Darya.png',
    fileName: 'Darya Native Story F1',
    userText: 'CONTINUE_DIRECT_MCP',
  });

  assert.deepEqual(calls, [{
    avatarUrl: 'Darya.png',
    fileName: 'Darya Native Story F1',
    userText: 'CONTINUE_DIRECT_MCP',
  }]);
  assert.deepEqual(parseTextResult(result), {
    ok: true,
    saved: true,
    messageCount: 7,
  });
});

test('direct MCP generation tool delegates exactly one server-side provider generation', async () => {
  const calls = [];
  const { server, tools } = makeToolRegistry();

  registerSillyTavernWriteTools(server, {
    getClient: () => ({
      async appendUserMessage() {
        throw new Error('not used');
      },
      async generateAssistantMessage(input) {
        calls.push(input);
        return {
          ok: true,
          saved: true,
          message: 'DIRECT_MCP_GENERATED',
        };
      },
    }),
  });

  const result = await tools.get('sillytavern_generate_reply').handler({
    avatarUrl: 'Darya.png',
    fileName: 'Darya Native Story F1',
    source: 'deepseek',
    model: 'deepseek-flash',
  });

  assert.deepEqual(calls, [{
    avatarUrl: 'Darya.png',
    fileName: 'Darya Native Story F1',
    source: 'deepseek',
    model: 'deepseek-flash',
  }]);
  assert.deepEqual(parseTextResult(result), {
    ok: true,
    saved: true,
    message: 'DIRECT_MCP_GENERATED',
  });
});

test('direct MCP write tools return an MCP error result instead of retrying failed writes', async () => {
  let calls = 0;
  const { server, tools } = makeToolRegistry();

  registerSillyTavernWriteTools(server, {
    getClient: () => ({
      async appendUserMessage() {
        calls += 1;
        throw new Error('upstream write failed');
      },
      async generateAssistantMessage() {
        throw new Error('not used');
      },
    }),
  });

  const result = await tools.get('sillytavern_append_turn').handler({
    avatarUrl: 'Darya.png',
    fileName: 'Darya Native Story F1',
    userText: 'ONE_SHOT_ONLY',
  });

  assert.equal(calls, 1);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /upstream write failed/);
});
