import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyMobileRestRequest,
  deriveMobileRestBasePath,
  executeMobileRestRoute,
  isMobileRestWriteRoute,
  isMobileRestPostOnlyRoute,
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

test('classifies character duplicate route and dispatches exact source/target identifiers', async () => {
  const basePath = '/st-secret/mobile';
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/character-duplicate', basePath),
    { kind: 'character_duplicate' },
  );

  const calls = [];
  const client = {
    async duplicateCharacter(input) {
      calls.push(input);
      return {
        ok: true,
        sourceAvatarUrl: input.avatarUrl,
        avatarUrl: 'Darya Copy.png',
        characterName: input.newName,
      };
    },
  };

  const result = await executeMobileRestRoute(
    { kind: 'character_duplicate' },
    client,
    {
      avatarUrl: 'Darya.png',
      newName: 'Darya Copy',
      fileName: 'Darya Copy',
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{
    avatarUrl: 'Darya.png',
    newName: 'Darya Copy',
    fileName: 'Darya Copy',
  }]);
});

test('character duplicate rejects missing identifiers', async () => {
  const client = {
    duplicateCharacter() {
      throw new Error('should not be called');
    },
  };

  await assert.rejects(
    () => executeMobileRestRoute(
      { kind: 'character_duplicate' },
      client,
      { newName: 'Copy' },
    ),
    /avatarUrl is required/,
  );
  await assert.rejects(
    () => executeMobileRestRoute(
      { kind: 'character_duplicate' },
      client,
      { avatarUrl: 'Darya.png' },
    ),
    /newName is required/,
  );
});

test('classifies character rename route and dispatches exact identifiers', async () => {
  const basePath = '/st-secret/mobile';
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/character-rename', basePath),
    { kind: 'character_rename' },
  );

  const calls = [];
  const client = {
    async renameCharacter(input) {
      calls.push(input);
      return {
        ok: true,
        oldAvatarUrl: input.avatarUrl,
        avatarUrl: 'New Name.png',
        characterName: input.newName,
      };
    },
  };

  const result = await executeMobileRestRoute(
    { kind: 'character_rename' },
    client,
    { avatarUrl: 'Old Name.png', newName: 'New Name' },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{
    avatarUrl: 'Old Name.png',
    newName: 'New Name',
  }]);
});

test('character rename rejects missing identifiers', async () => {
  const client = {
    renameCharacter() { throw new Error('should not be called'); },
  };
  await assert.rejects(
    () => executeMobileRestRoute(
      { kind: 'character_rename' },
      client,
      { newName: 'New Name' },
    ),
    /avatarUrl is required/,
  );
  await assert.rejects(
    () => executeMobileRestRoute(
      { kind: 'character_rename' },
      client,
      { avatarUrl: 'Old Name.png' },
    ),
    /newName is required/,
  );
});

test('classifies character rename route and dispatches exact identifiers', async () => {
  const basePath = '/st-secret/mobile';
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/character-rename', basePath),
    { kind: 'character_rename' },
  );

  const calls = [];
  const client = {
    async renameCharacter(input) {
      calls.push(input);
      return {
        ok: true,
        oldAvatarUrl: input.avatarUrl,
        avatarUrl: 'New Name.png',
        characterName: input.newName,
      };
    },
  };

  const result = await executeMobileRestRoute(
    { kind: 'character_rename' },
    client,
    { avatarUrl: 'Old Name.png', newName: 'New Name' },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{
    avatarUrl: 'Old Name.png',
    newName: 'New Name',
  }]);
});

test('character rename rejects missing identifiers', async () => {
  const client = {
    renameCharacter() {
      throw new Error('should not be called');
    },
  };

  await assert.rejects(
    () => executeMobileRestRoute(
      { kind: 'character_rename' },
      client,
      { newName: 'New Name' },
    ),
    /avatarUrl is required/,
  );
  await assert.rejects(
    () => executeMobileRestRoute(
      { kind: 'character_rename' },
      client,
      { avatarUrl: 'Old Name.png' },
    ),
    /newName is required/,
  );
});

test('classifies character export JSON route and dispatches avatarUrl', async () => {
  const basePath = '/st-secret/mobile';
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/character-export-json?avatarUrl=Darya.png', basePath),
    { kind: 'character_export_json', avatarUrl: 'Darya.png' },
  );

  const calls = [];
  const client = {
    async exportCharacterJson(avatarUrl) {
      calls.push(avatarUrl);
      return {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: { name: 'Darya' },
      };
    },
  };

  const result = await executeMobileRestRoute(
    { kind: 'character_export_json', avatarUrl: 'Darya.png' },
    client,
  );

  assert.deepEqual(calls, ['Darya.png']);
  assert.equal(result.data.name, 'Darya');
});

test('character export JSON rejects missing avatarUrl', async () => {
  const client = {
    exportCharacterJson() { throw new Error('should not be called'); },
  };
  await assert.rejects(
    () => executeMobileRestRoute(
      { kind: 'character_export_json', avatarUrl: '' },
      client,
    ),
    /avatarUrl is required/,
  );
});

test('classifies character JSON import route and dispatches parsed card', async () => {
  const basePath = '/st-secret/mobile';
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/character-import-json', basePath),
    { kind: 'character_import_json' },
  );

  const calls = [];
  const client = {
    async importCharacterJson(input) {
      calls.push(input);
      return {
        ok: true,
        imported: true,
        avatarUrl: 'Imported Probe.png',
        characterName: input.card.data.name,
      };
    },
  };
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { name: 'Imported Probe', description: 'from JSON' },
  };

  const result = await executeMobileRestRoute(
    { kind: 'character_import_json' },
    client,
    {
      fileName: 'Imported Probe',
      cardJson: JSON.stringify(card),
    },
  );

  assert.equal(result.imported, true);
  assert.deepEqual(calls, [{
    card,
    fileName: 'Imported Probe',
  }]);
});

test('character JSON import rejects malformed input before client mutation', async () => {
  const client = {
    importCharacterJson() { throw new Error('should not be called'); },
  };

  await assert.rejects(
    () => executeMobileRestRoute(
      { kind: 'character_import_json' },
      client,
      { cardJson: '{bad}' },
    ),
    /cardJson must be valid JSON/,
  );
});

test('mobile write-route classification includes every character mutation including JSON import', () => {
  for (const kind of [
    'character_create',
    'character_update',
    'character_delete',
    'character_duplicate',
    'character_rename',
    'character_import_json',
  ]) {
    assert.equal(isMobileRestWriteRoute({ kind }), true, kind);
  }

  assert.equal(isMobileRestWriteRoute({ kind: 'character_export_json' }), false);
  assert.equal(isMobileRestWriteRoute({ kind: 'character' }), false);
});

test('POST-only mobile route classification covers character mutations without HTML forms', () => {
  for (const kind of [
    'character_update',
    'character_delete',
    'character_duplicate',
    'character_rename',
    'character_import_json',
  ]) {
    assert.equal(isMobileRestPostOnlyRoute({ kind }), true, kind);
  }

  assert.equal(isMobileRestPostOnlyRoute({ kind: 'character_create' }), false);
  assert.equal(isMobileRestPostOnlyRoute({ kind: 'turn' }), false);
  assert.equal(isMobileRestPostOnlyRoute({ kind: 'generate' }), false);
});

test('classifies all lorebook mutation routes as explicit POST routes', () => {
  const basePath = '/st-secret/mobile';
  for (const [suffix, kind] of [
    ['world-info-create', 'world_info_create'],
    ['world-info-update', 'world_info_update'],
    ['world-info-delete', 'world_info_delete'],
    ['world-info-entry-upsert', 'world_info_entry_upsert'],
    ['world-info-entry-delete', 'world_info_entry_delete'],
  ]) {
    const route = classifyMobileRestRequest('/st-secret/mobile/' + suffix, basePath);
    assert.deepEqual(route, { kind });
    assert.equal(isMobileRestWriteRoute(route), true);
    assert.equal(isMobileRestPostOnlyRoute(route), true);
  }
});

test('dispatches lorebook create/update/delete and deterministic entry mutations', async () => {
  const calls = [];
  const client = {
    createWorldInfo(input) { calls.push(['create', input]); return { ok: true, created: true }; },
    updateWorldInfo(input) { calls.push(['update', input]); return { ok: true, updated: true }; },
    deleteWorldInfo(input) { calls.push(['delete', input]); return { ok: true, deleted: true }; },
    upsertWorldInfoEntry(input) { calls.push(['upsert', input]); return { ok: true, uid: input.uid }; },
    deleteWorldInfoEntry(input) { calls.push(['entry-delete', input]); return { ok: true, uid: input.uid }; },
  };
  const data = { entries: { 0: { uid: 0, content: 'x' } } };

  await executeMobileRestRoute(
    { kind: 'world_info_create' },
    client,
    { name: 'Probe', worldJson: JSON.stringify({ entries: {} }) },
  );
  await executeMobileRestRoute(
    { kind: 'world_info_update' },
    client,
    { name: 'Probe', worldJson: JSON.stringify(data) },
  );
  await executeMobileRestRoute(
    { kind: 'world_info_delete' },
    client,
    { name: 'Probe' },
  );
  await executeMobileRestRoute(
    { kind: 'world_info_entry_upsert' },
    client,
    { name: 'Probe', uid: 7, entryJson: JSON.stringify({ content: 'entry' }) },
  );
  await executeMobileRestRoute(
    { kind: 'world_info_entry_delete' },
    client,
    { name: 'Probe', uid: 7 },
  );

  assert.deepEqual(calls, [
    ['create', { name: 'Probe', data: { entries: {} } }],
    ['update', { name: 'Probe', data }],
    ['delete', { name: 'Probe' }],
    ['upsert', { name: 'Probe', uid: 7, entry: { content: 'entry' } }],
    ['entry-delete', { name: 'Probe', uid: 7 }],
  ]);
});

test('lorebook mutation routes reject malformed payloads before client writes', async () => {
  const client = new Proxy({}, {
    get() {
      return () => { throw new Error('should not be called'); };
    },
  });

  await assert.rejects(
    () => executeMobileRestRoute(
      { kind: 'world_info_update' },
      client,
      { name: 'Probe', worldJson: '{bad}' },
    ),
    /worldJson must be valid JSON/,
  );
  await assert.rejects(
    () => executeMobileRestRoute(
      { kind: 'world_info_entry_upsert' },
      client,
      { name: 'Probe', uid: -1, entryJson: '{}' },
    ),
    /uid must be a non-negative integer/,
  );
});

test('classifies world info save/delete as write routes', async () => {
  const basePath = '/st-secret/mobile';
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/world-info-save', basePath),
    { kind: 'world_info_save' },
  );
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/world-info-delete', basePath),
    { kind: 'world_info_delete' },
  );
  assert.equal(isMobileRestWriteRoute({ kind: 'world_info_save' }), true);
  assert.equal(isMobileRestWriteRoute({ kind: 'world_info_delete' }), true);
  assert.equal(isMobileRestPostOnlyRoute({ kind: 'world_info_save' }), true);
  assert.equal(isMobileRestPostOnlyRoute({ kind: 'world_info_delete' }), true);

  const calls = [];
  const client = {
    async saveWorldInfo(input) {
      calls.push({ op: 'save', input });
      return { ok: true, name: input.name };
    },
    async deleteWorldInfo(input) {
      calls.push({ op: 'delete', input });
      return { ok: true, deleted: true, name: input.name };
    },
  };
  const data = { entries: { 0: { uid: 0, key: ['probe'], content: 'WORLD_PROBE' } } };

  const saved = await executeMobileRestRoute(
    { kind: 'world_info_save' },
    client,
    { name: 'Probe Lore', dataJson: JSON.stringify(data) },
  );
  const deleted = await executeMobileRestRoute(
    { kind: 'world_info_delete' },
    client,
    { name: 'Probe Lore' },
  );

  assert.equal(saved.ok, true);
  assert.equal(deleted.deleted, true);
  assert.deepEqual(calls, [
    { op: 'save', input: { name: 'Probe Lore', data } },
    { op: 'delete', input: { name: 'Probe Lore' } },
  ]);
});

test('world info save rejects invalid world JSON before mutation', async () => {
  const client = {
    saveWorldInfo() { throw new Error('should not be called'); },
  };
  await assert.rejects(
    () => executeMobileRestRoute(
      { kind: 'world_info_save' },
      client,
      { name: 'Probe', dataJson: JSON.stringify({ nope: true }) },
    ),
    /entries/,
  );
});

test('classifies character world bind/unbind as POST-only write routes', async () => {
  const basePath = '/st-secret/mobile';
  const bindRoute = classifyMobileRestRequest('/st-secret/mobile/character-world-bind', basePath);
  const unbindRoute = classifyMobileRestRequest('/st-secret/mobile/character-world-unbind', basePath);
  assert.deepEqual(bindRoute, { kind: 'character_world_bind' });
  assert.deepEqual(unbindRoute, { kind: 'character_world_unbind' });
  assert.equal(isMobileRestWriteRoute(bindRoute), true);
  assert.equal(isMobileRestWriteRoute(unbindRoute), true);
  assert.equal(isMobileRestPostOnlyRoute(bindRoute), true);
  assert.equal(isMobileRestPostOnlyRoute(unbindRoute), true);

  const calls = [];
  const client = {
    async bindCharacterWorld(input) {
      calls.push({ op: 'bind', input });
      return { ok: true, ...input };
    },
    async unbindCharacterWorld(input) {
      calls.push({ op: 'unbind', input });
      return { ok: true, ...input };
    },
  };

  await executeMobileRestRoute(bindRoute, client, {
    avatarUrl: 'Darya.png',
    name: 'Darya Lore',
  });
  await executeMobileRestRoute(unbindRoute, client, {
    avatarUrl: 'Darya.png',
  });

  assert.deepEqual(calls, [
    { op: 'bind', input: { avatarUrl: 'Darya.png', name: 'Darya Lore' } },
    { op: 'unbind', input: { avatarUrl: 'Darya.png' } },
  ]);
});

test('character world bind/unbind validate payloads before client mutation', async () => {
  const client = {
    bindCharacterWorld() { throw new Error('should not be called'); },
    unbindCharacterWorld() { throw new Error('should not be called'); },
  };
  await assert.rejects(
    () => executeMobileRestRoute(
      { kind: 'character_world_bind' },
      client,
      { avatarUrl: 'Darya.png' },
    ),
    /name is required/,
  );
  await assert.rejects(
    () => executeMobileRestRoute(
      { kind: 'character_world_unbind' },
      client,
      {},
    ),
    /avatarUrl is required/,
  );
});

test('classifies chat lifecycle routes as POST-only mutations', () => {
  const basePath = '/st-secret/mobile';
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/chat-create', basePath),
    { kind: 'chat_create' },
  );
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/chat-rename', basePath),
    { kind: 'chat_rename' },
  );
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/chat-delete', basePath),
    { kind: 'chat_delete' },
  );

  for (const kind of ['chat_create', 'chat_rename', 'chat_delete']) {
    assert.equal(isMobileRestWriteRoute({ kind }), true, kind);
    assert.equal(isMobileRestPostOnlyRoute({ kind }), true, kind);
  }
});

test('dispatches chat create rename and delete with exact identifiers', async () => {
  const calls = [];
  const client = {
    async createChat(input) {
      calls.push({ op: 'create', input });
      return { ok: true, created: true, ...input };
    },
    async renameChat(input) {
      calls.push({ op: 'rename', input });
      return { ok: true, renamed: true, ...input };
    },
    async deleteChat(input) {
      calls.push({ op: 'delete', input });
      return { ok: true, deleted: true, ...input };
    },
  };

  await executeMobileRestRoute(
    { kind: 'chat_create' },
    client,
    { nonce: 'chat-create-1', avatarUrl: 'Darya.png', fileName: 'Probe Chat' },
  );
  await executeMobileRestRoute(
    { kind: 'chat_rename' },
    client,
    { avatarUrl: 'Darya.png', fileName: 'Probe Chat', newFileName: 'Renamed Chat' },
  );
  await executeMobileRestRoute(
    { kind: 'chat_delete' },
    client,
    { avatarUrl: 'Darya.png', fileName: 'Renamed Chat' },
  );

  assert.deepEqual(calls, [
    {
      op: 'create',
      input: { nonce: 'chat-create-1', avatarUrl: 'Darya.png', fileName: 'Probe Chat' },
    },
    {
      op: 'rename',
      input: { avatarUrl: 'Darya.png', fileName: 'Probe Chat', newFileName: 'Renamed Chat' },
    },
    {
      op: 'delete',
      input: { avatarUrl: 'Darya.png', fileName: 'Renamed Chat' },
    },
  ]);
});

test('chat lifecycle routes reject incomplete payloads before client mutation', async () => {
  const client = {
    createChat() { throw new Error('should not be called'); },
    renameChat() { throw new Error('should not be called'); },
    deleteChat() { throw new Error('should not be called'); },
  };
  await assert.rejects(
    () => executeMobileRestRoute({ kind: 'chat_create' }, client, { fileName: 'Probe' }),
    /avatarUrl and fileName are required/,
  );
  await assert.rejects(
    () => executeMobileRestRoute(
      { kind: 'chat_rename' },
      client,
      { avatarUrl: 'Darya.png', fileName: 'Old' },
    ),
    /avatarUrl, fileName, and newFileName are required/,
  );
  await assert.rejects(
    () => executeMobileRestRoute(
      { kind: 'chat_delete' },
      client,
      { avatarUrl: 'Darya.png' },
    ),
    /avatarUrl and fileName are required/,
  );
});



test('classifies character patch route and dispatches a partial patch', async () => {
  const basePath = '/st-secret/mobile';
  assert.deepEqual(
    classifyMobileRestRequest('/st-secret/mobile/character-patch', basePath),
    { kind: 'character_patch' },
  );

  const calls = [];
  const client = {
    async patchCharacter(input) {
      calls.push(input);
      return { ok: true, avatarUrl: input.avatarUrl, characterName: 'Darya' };
    },
  };
  const patch = {
    data: {
      description: 'new description',
      extensions: { darya_source_revision: 'new-revision' },
    },
    characterBookEntries: [{ id: 3, content: 'new visual' }],
  };

  const result = await executeMobileRestRoute(
    { kind: 'character_patch' },
    client,
    {
      avatarUrl: 'Darya.png',
      patchJson: JSON.stringify(patch),
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ avatarUrl: 'Darya.png', patch }]);
});

test('character patch rejects missing identifiers and malformed patch JSON', async () => {
  const client = {
    patchCharacter() {
      throw new Error('should not be called');
    },
  };

  await assert.rejects(
    () => executeMobileRestRoute(
      { kind: 'character_patch' },
      client,
      { patchJson: '{}' },
    ),
    /avatarUrl is required/,
  );
  await assert.rejects(
    () => executeMobileRestRoute(
      { kind: 'character_patch' },
      client,
      { avatarUrl: 'Darya.png', patchJson: '{bad}' },
    ),
    /patchJson must be valid JSON/,
  );
});
