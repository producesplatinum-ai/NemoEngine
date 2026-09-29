import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyMobileRestRequest,
  deriveMobileRestBasePath,
  executeMobileRestRoute,
} from './sillytavern-mobile-rest.mjs';

test('derives mobile REST base from secret MCP path', () => {
  assert.equal(
    deriveMobileRestBasePath('/st-secret/mcp'),
    '/st-secret/mobile',
  );
});

test('classifies read-only mobile REST routes and preserves query inputs', () => {
  const basePath = '/st-secret/mobile';
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/status', basePath),
    { kind: 'status' },
  );
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/characters', basePath),
    { kind: 'characters' },
  );
  assert.deepEqual(
    classifyMobileRestRequest(
      '/st-secret/mobile/character?avatarUrl=Darya.png',
      basePath,
    ),
    { kind: 'character', avatarUrl: 'Darya.png' },
  );
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/world-info', basePath),
    { kind: 'world_info' },
  );
  assert.deepEqual(
    classifyMobileRestRequest(
      '/st-secret/mobile/world-info-entry?name=Main%20Lore',
      basePath,
    ),
    { kind: 'world_info_entry', name: 'Main Lore' },
  );
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/recent-chats', basePath),
    { kind: 'recent_chats' },
  );
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/turn', basePath),
    { kind: 'turn' },
  );
  assert.deepEqual(
    classifyMobileRestRequest(
      '/st-secret/mobile/chat?avatarUrl=Darya.png&fileName=Chat%201',
      basePath,
    ),
    { kind: 'chat', avatarUrl: 'Darya.png', fileName: 'Chat 1' },
  );
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/nope', basePath),
    { kind: 'not_found' },
  );
});

test('executes only read-only client methods for mobile REST routes', async () => {
  const calls = [];
  const client = {
    async status() {
      calls.push(['status']);
      return {
        ok: true,
        baseUrl: 'private',
        csrfSessionReady: true,
        basicAuthConfigured: true,
      };
    },
    async listCharacters() {
      calls.push(['listCharacters']);
      return [{ name: 'Darya' }];
    },
    async getCharacter(value) {
      calls.push(['getCharacter', value]);
      return { name: 'Darya' };
    },
    async listWorldInfo() {
      calls.push(['listWorldInfo']);
      return ['Main Lore'];
    },
    async getWorldInfo(value) {
      calls.push(['getWorldInfo', value]);
      return { name: value };
    },
    async recentChats() {
      calls.push(['recentChats']);
      return [{ file_name: 'Chat 1' }];
    },
    async getChat(value) {
      calls.push(['getChat', value]);
      return [{ mes: 'hello' }];
    },
  };

  assert.deepEqual(await executeMobileRestRoute({ kind: 'status' }, client), {
    ok: true,
    csrfSessionReady: true,
    basicAuthConfigured: true,
  });
  assert.deepEqual(
    await executeMobileRestRoute({ kind: 'characters' }, client),
    [{ name: 'Darya' }],
  );
  assert.deepEqual(
    await executeMobileRestRoute(
      { kind: 'character', avatarUrl: 'Darya.png' },
      client,
    ),
    { name: 'Darya' },
  );
  assert.deepEqual(
    await executeMobileRestRoute({ kind: 'world_info' }, client),
    ['Main Lore'],
  );
  assert.deepEqual(
    await executeMobileRestRoute(
      { kind: 'world_info_entry', name: 'Main Lore' },
      client,
    ),
    { name: 'Main Lore' },
  );
  assert.deepEqual(
    await executeMobileRestRoute({ kind: 'recent_chats' }, client),
    [{ file_name: 'Chat 1' }],
  );
  assert.deepEqual(
    await executeMobileRestRoute(
      { kind: 'chat', avatarUrl: 'Darya.png', fileName: 'Chat 1' },
      client,
    ),
    [{ mes: 'hello' }],
  );

  assert.deepEqual(calls, [
    ['status'],
    ['listCharacters'],
    ['getCharacter', 'Darya.png'],
    ['listWorldInfo'],
    ['getWorldInfo', 'Main Lore'],
    ['recentChats'],
    ['getChat', { avatarUrl: 'Darya.png', fileName: 'Chat 1' }],
  ]);
});

test('rejects missing identifiers instead of broadening a read', async () => {
  const client = {};
  await assert.rejects(
    () => executeMobileRestRoute({ kind: 'character', avatarUrl: '' }, client),
    /avatarUrl is required/,
  );
  await assert.rejects(
    () => executeMobileRestRoute({ kind: 'world_info_entry', name: '' }, client),
    /name is required/,
  );
  await assert.rejects(
    () =>
      executeMobileRestRoute(
        { kind: 'chat', avatarUrl: '', fileName: '' },
        client,
      ),
    /avatarUrl and fileName are required/,
  );
});


test('executes mobile turn only with explicit payload', async () => {
  const calls = [];
  const client = {
    async appendUserMessage(input) {
      calls.push(input);
      return { ok: true, ...input };
    },
  };

  const body = {
    avatarUrl: 'Seraphina.png',
    fileName: 'Nemo mobile test',
    userText: 'NEMO_ST_MOBILE_WRITE_0929',
  };
  const result = await executeMobileRestRoute({ kind: 'turn' }, client, body);

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [body]);
});

test('mobile turn rejects missing or empty write inputs', async () => {
  const client = { appendUserMessage() { throw new Error('should not be called'); } };
  await assert.rejects(
    () => executeMobileRestRoute({ kind: 'turn' }, client, {}),
    /avatarUrl, fileName, and userText are required/,
  );
  await assert.rejects(
    () => executeMobileRestRoute(
      { kind: 'turn' },
      client,
      { avatarUrl: 'Seraphina.png', fileName: 'Test', userText: '   ' },
    ),
    /userText must not be empty/,
  );
});
