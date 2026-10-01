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


test('classifies mobile generate route and dispatches explicit generation inputs', async () => {
  const basePath = '/st-secret/mobile';
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/generate', basePath),
    { kind: 'generate' },
  );

  const calls = [];
  const client = {
    async generateAssistantMessage(input) {
      calls.push(input);
      return { ok: true, saved: true, message: 'SERAPHINA_GENERATED_OK' };
    },
  };

  const body = {
    avatarUrl: 'default_Seraphina.png',
    fileName: 'Seraphina - 2023-5-12 @21h 32m 29s 224ms',
    source: 'deepseek',
    model: 'deepseek-flash',
  };
  const result = await executeMobileRestRoute({ kind: 'generate' }, client, body);

  assert.equal(result.ok, true);
  assert.equal(result.saved, true);
  assert.equal(result.message, 'SERAPHINA_GENERATED_OK');
  assert.deepEqual(calls, [body]);
});

test('mobile generate rejects missing chat identifiers', async () => {
  const client = {
    generateAssistantMessage() {
      throw new Error('should not be called');
    },
  };

  await assert.rejects(
    () => executeMobileRestRoute(
      { kind: 'generate' },
      client,
      { source: 'deepseek', model: 'deepseek-flash' },
    ),
    /avatarUrl and fileName are required/,
  );
});


test('classifies character create route and dispatches a parsed character card', async () => {
  const basePath = '/st-secret/mobile';
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/character-create', basePath),
    { kind: 'character_create' },
  );

  const calls = [];
  const client = {
    async createCharacter(input) {
      calls.push(input);
      return { ok: true, avatarUrl: 'Darya.png', characterName: 'Darya' };
    },
  };
  const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Darya',
      description: 'Darya voice',
      system_prompt: 'Stay in Darya voice.',
      tags: ['darya', 'nemo'],
    },
  };
  const result = await executeMobileRestRoute(
    { kind: 'character_create' },
    client,
    {
      fileName: 'Darya',
      cardJson: JSON.stringify(card),
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ card, fileName: 'Darya' }]);
});

test('character create rejects missing or invalid card JSON', async () => {
  const client = {
    createCharacter() {
      throw new Error('should not be called');
    },
  };

  await assert.rejects(
    () => executeMobileRestRoute({ kind: 'character_create' }, client, {}),
    /cardJson is required/,
  );
  await assert.rejects(
    () =>
      executeMobileRestRoute(
        { kind: 'character_create' },
        client,
        { cardJson: '{not-json}' },
      ),
    /cardJson must be valid JSON/,
  );
});



test('classifies preset list and preset save routes', () => {
  const basePath = '/st-secret/mobile';
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/presets', basePath),
    { kind: 'presets' },
  );
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/preset-save', basePath),
    { kind: 'preset_save' },
  );
});

test('lists openai presets and saves one explicit preset payload', async () => {
  const calls = [];
  const client = {
    async listOpenAiPresets() {
      calls.push(['listOpenAiPresets']);
      return ['Default', 'Nemo Engine 11.5.2 - Ready RU Gooner RP'];
    },
    async saveOpenAiPreset(input) {
      calls.push(['saveOpenAiPreset', input]);
      return { ok: true, name: input.name };
    },
  };

  assert.deepEqual(
    await executeMobileRestRoute({ kind: 'presets' }, client),
    ['Default', 'Nemo Engine 11.5.2 - Ready RU Gooner RP'],
  );

  const preset = { preset_name: 'Darya Test', prompts: [] };
  const result = await executeMobileRestRoute(
    { kind: 'preset_save' },
    client,
    { name: 'Darya Test', presetJson: JSON.stringify(preset) },
  );

  assert.deepEqual(result, { ok: true, name: 'Darya Test' });
  assert.deepEqual(calls, [
    ['listOpenAiPresets'],
    ['saveOpenAiPreset', { name: 'Darya Test', preset }],
  ]);
});

test('preset save rejects missing or invalid payloads', async () => {
  const client = {
    saveOpenAiPreset() {
      throw new Error('should not be called');
    },
  };

  await assert.rejects(
    () => executeMobileRestRoute({ kind: 'preset_save' }, client, {}),
    /name and presetJson are required/,
  );
  await assert.rejects(
    () => executeMobileRestRoute(
      { kind: 'preset_save' },
      client,
      { name: 'Bad', presetJson: '{not-json}' },
    ),
    /presetJson must be valid JSON/,
  );
});


test('Darya-specific Nemo profile routes are removed in favor of the official exact catalog', () => {
  const basePath = '/st-secret/mobile';
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/nemo-profiles', basePath),
    { kind: 'not_found' },
  );
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/nemo-profile-install', basePath),
    { kind: 'not_found' },
  );
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/nemo-exact-catalog', basePath),
    { kind: 'nemo_exact_catalog' },
  );
});

test('classifies exhaustive exact Nemo catalog routes and supports all install', async () => {
  const basePath = '/st-secret/mobile';
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/nemo-exact-catalog', basePath),
    { kind: 'nemo_exact_catalog' },
  );
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/nemo-exact-install', basePath),
    { kind: 'nemo_exact_install' },
  );

  const client = {
    listExactNemoCatalog() {
      return [{ id: 'canonical-11.5.2-general-rp' }];
    },
    async installExactNemoCatalogEntry(entryId) {
      return { ok: true, entryId, verified: true };
    },
    async installAllExactNemoCatalog() {
      return { ok: true, installed: 99, verified: 99 };
    },
  };

  assert.deepEqual(
    await executeMobileRestRoute({ kind: 'nemo_exact_catalog' }, client),
    [{ id: 'canonical-11.5.2-general-rp' }],
  );
  assert.deepEqual(
    await executeMobileRestRoute(
      { kind: 'nemo_exact_install' },
      client,
      { entryId: 'canonical-11.5.2-general-rp' },
    ),
    { ok: true, entryId: 'canonical-11.5.2-general-rp', verified: true },
  );
  assert.deepEqual(
    await executeMobileRestRoute(
      { kind: 'nemo_exact_install' },
      client,
      { entryId: 'all' },
    ),
    { ok: true, installed: 99, verified: 99 },
  );
});

test('exact Nemo install rejects missing entry id', async () => {
  await assert.rejects(
    () => executeMobileRestRoute({ kind: 'nemo_exact_install' }, {}, {}),
    /entryId is required/,
  );
});


test('classifies exact Nemo activate route and dispatches one catalog entry', async () => {
  const basePath = '/st-secret/mobile';
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/nemo-exact-activate', basePath),
    { kind: 'nemo_exact_activate' },
  );

  const client = {
    async activateExactNemoCatalogEntry(entryId) {
      return {
        ok: true,
        entryId,
        slotName: 'Nemo Exact Active',
        storedPresetExact: true,
        activeSettingsExact: true,
      };
    },
  };

  assert.deepEqual(
    await executeMobileRestRoute(
      { kind: 'nemo_exact_activate' },
      client,
      { entryId: 'canonical-ready-ru-gooner-rp' },
    ),
    {
      ok: true,
      entryId: 'canonical-ready-ru-gooner-rp',
      slotName: 'Nemo Exact Active',
      storedPresetExact: true,
      activeSettingsExact: true,
    },
  );
});

test('exact Nemo activate rejects missing entry id', async () => {
  await assert.rejects(
    () => executeMobileRestRoute({ kind: 'nemo_exact_activate' }, {}, {}),
    /entryId is required/,
  );
});


test('classifies preset delete route and dispatches explicit name with fallback', async () => {
  const basePath = '/st-secret/mobile';
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/preset-delete', basePath),
    { kind: 'preset_delete' },
  );

  const calls = [];
  const client = {
    async deleteOpenAiPreset(input) {
      calls.push(input);
      return { ok: true, deleted: input.name };
    },
  };

  const result = await executeMobileRestRoute(
    { kind: 'preset_delete' },
    client,
    {
      name: 'Nemo Exact Active',
      fallbackName: 'Nemo Engine 11.5.2 - Ready RU Gooner RP',
    },
  );

  assert.deepEqual(result, { ok: true, deleted: 'Nemo Exact Active' });
  assert.deepEqual(calls, [{
    name: 'Nemo Exact Active',
    fallbackName: 'Nemo Engine 11.5.2 - Ready RU Gooner RP',
  }]);
});

test('preset delete rejects missing name', async () => {
  await assert.rejects(
    () => executeMobileRestRoute({ kind: 'preset_delete' }, {}, {}),
    /name is required/,
  );
});

test('classifies character update/delete routes and dispatches validated payloads', async () => {
  const basePath = '/st-secret/mobile';
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/character-update', basePath),
    { kind: 'character_update' },
  );
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/character-delete', basePath),
    { kind: 'character_delete' },
  );

  const calls = [];
  const client = {
    async updateCharacter(input) {
      calls.push({ op: 'update', input });
      return { ok: true, avatarUrl: input.avatarUrl, characterName: input.card.data.name };
    },
    async deleteCharacter(input) {
      calls.push({ op: 'delete', input });
      return { ok: true, deleted: true, ...input };
    },
  };
  const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: { name: 'Mobile CRUD Probe', description: 'updated' },
  };

  const update = await executeMobileRestRoute(
    { kind: 'character_update' },
    client,
    {
      avatarUrl: 'Mobile CRUD Probe.png',
      cardJson: JSON.stringify(card),
    },
  );
  assert.equal(update.ok, true);

  const deleted = await executeMobileRestRoute(
    { kind: 'character_delete' },
    client,
    {
      avatarUrl: 'Mobile CRUD Probe.png',
      deleteChats: false,
    },
  );
  assert.equal(deleted.deleted, true);
  assert.deepEqual(calls, [
    {
      op: 'update',
      input: { avatarUrl: 'Mobile CRUD Probe.png', card },
    },
    {
      op: 'delete',
      input: { avatarUrl: 'Mobile CRUD Probe.png', deleteChats: false },
    },
  ]);
});

test('character update/delete reject invalid payloads', async () => {
  const client = {
    updateCharacter() { throw new Error('should not be called'); },
    deleteCharacter() { throw new Error('should not be called'); },
  };

  await assert.rejects(
    () => executeMobileRestRoute(
      { kind: 'character_update' },
      client,
      { avatarUrl: 'Darya.png', cardJson: '{bad}' },
    ),
    /cardJson must be valid JSON/,
  );
  await assert.rejects(
    () => executeMobileRestRoute(
      { kind: 'character_delete' },
      client,
      { avatarUrl: '' },
    ),
    /avatarUrl is required/,
  );
  await assert.rejects(
    () => executeMobileRestRoute(
      { kind: 'character_delete' },
      client,
      { avatarUrl: 'Darya.png', deleteChats: 'yes' },
    ),
    /deleteChats must be a boolean/,
  );
});

