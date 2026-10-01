import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  executeOneShot,
  parseOneShotCommand,
} from './sillytavern-railway-one-shot.mjs';

test('parseOneShotCommand treats empty input as skipped', () => {
  assert.deepEqual(parseOneShotCommand(''), { op: 'skip' });
  assert.deepEqual(parseOneShotCommand('   '), { op: 'skip' });
});

test('turn performs exactly one POST to the protected mobile gateway', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, saved: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await executeOneShot({
    command: {
      op: 'turn',
      avatarUrl: 'Darya.png',
      fileName: 'Darya Native Story F1',
      userText: 'ONE_SHOT_TEST',
    },
    publicDomain: 'example.up.railway.app',
    mcpPath: '/secret/mcp',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.up.railway.app/secret/mobile/turn');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    avatarUrl: 'Darya.png',
    fileName: 'Darya Native Story F1',
    userText: 'ONE_SHOT_TEST',
  });
  assert.deepEqual(result, { ok: true, saved: true });
});

test('recent_chats performs one GET and never retries a failure', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response('upstream failed', { status: 502 });
  };

  await assert.rejects(
    () =>
      executeOneShot({
        command: { op: 'recent_chats' },
        publicDomain: 'example.up.railway.app',
        mcpPath: '/secret/mcp',
        fetchImpl,
      }),
    /502/,
  );
  assert.equal(calls, 1);
});

test('skip performs no network call', async () => {
  let calls = 0;
  const result = await executeOneShot({
    command: { op: 'skip' },
    publicDomain: 'example.up.railway.app',
    mcpPath: '/secret/mcp',
    fetchImpl: async () => {
      calls += 1;
      throw new Error('must not be called');
    },
  });
  assert.equal(calls, 0);
  assert.deepEqual(result, { ok: true, skipped: true });
});


test('CLI executes only with explicit --run and emits a terminal result marker', () => {
  const script = fileURLToPath(new URL('./sillytavern-railway-one-shot.mjs', import.meta.url));
  const baseEnv = { ...process.env, SILLYTAVERN_ONE_SHOT_JSON: '' };

  const passive = spawnSync(process.execPath, [script], {
    env: baseEnv,
    encoding: 'utf8',
  });
  assert.equal(passive.status, 0);
  assert.equal(passive.stdout.trim(), '');

  const explicit = spawnSync(process.execPath, [script, '--run'], {
    env: baseEnv,
    encoding: 'utf8',
  });
  assert.equal(explicit.status, 0);
  assert.match(explicit.stdout, /SILLYTAVERN_ONE_SHOT_RESULT/);
  assert.match(explicit.stdout, /\"skipped\":true/);
});

test('preset list performs exactly one GET through the mobile gateway', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify([
      'Default',
      'Nemo Engine 11.5.2 - Ready RU RP',
    ]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await executeOneShot({
    command: { op: 'presets', nonce: 'presets-1' },
    publicDomain: 'example.up.railway.app',
    mcpPath: '/secret/mcp',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.up.railway.app/secret/mobile/presets');
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(result, [
    'Default',
    'Nemo Engine 11.5.2 - Ready RU RP',
  ]);
});

test('exact Nemo catalog performs exactly one GET through the mobile gateway', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify([{ id: 'canonical-ready-ru-gooner-rp' }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await executeOneShot({
    command: { op: 'nemo_exact_catalog', nonce: 'catalog-1' },
    publicDomain: 'example.up.railway.app',
    mcpPath: '/secret/mcp',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.up.railway.app/secret/mobile/nemo-exact-catalog');
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(result, [{ id: 'canonical-ready-ru-gooner-rp' }]);
});

test('exact Nemo activation performs one POST with the requested entryId', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      ok: true,
      entryId: 'canonical-ready-ru-gooner-rp',
      slotName: 'Nemo Exact Active',
      storedPresetExact: true,
      activeSettingsExact: true,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await executeOneShot({
    command: {
      op: 'nemo_exact_activate',
      nonce: 'activate-1',
      entryId: 'canonical-ready-ru-gooner-rp',
    },
    publicDomain: 'example.up.railway.app',
    mcpPath: '/secret/mcp',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.up.railway.app/secret/mobile/nemo-exact-activate');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    entryId: 'canonical-ready-ru-gooner-rp',
  });
  assert.equal(result.activeSettingsExact, true);
});

test('exact Nemo install accepts one entryId or all and client generation status preserves marker', async () => {
  assert.deepEqual(
    parseOneShotCommand(JSON.stringify({
      op: 'nemo_exact_install',
      nonce: 'install-1',
      entryId: 'all',
    })),
    {
      op: 'nemo_exact_install',
      nonce: 'install-1',
      entryId: 'all',
    },
  );

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ available: true, marker: 'M1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await executeOneShot({
    command: {
      op: 'client_generation_status',
      nonce: 'status-1',
      marker: 'M1',
    },
    publicDomain: 'example.up.railway.app',
    mcpPath: '/secret/mcp',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.up.railway.app/secret/mobile/client-generation-status?marker=M1');
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(result, { available: true, marker: 'M1' });
});

test('new exact Nemo write operations require entryId', () => {
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({ op: 'nemo_exact_install' })),
    /entryId is required/,
  );
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({ op: 'nemo_exact_activate' })),
    /entryId is required/,
  );
});

test('character_create validates a V3 card and performs exactly one POST', async () => {
  const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Mobile Character Probe',
      description: 'Created through the iOS one-shot bridge.',
    },
  };
  const cardJson = JSON.stringify(card);
  const parsed = parseOneShotCommand(JSON.stringify({
    op: 'character_create',
    nonce: 'character-create-1',
    fileName: 'Mobile Character Probe',
    cardJson,
  }));

  assert.equal(parsed.op, 'character_create');
  assert.equal(parsed.fileName, 'Mobile Character Probe');
  assert.equal(parsed.cardJson, cardJson);

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      ok: true,
      avatarUrl: 'Mobile Character Probe.png',
      characterName: 'Mobile Character Probe',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await executeOneShot({
    command: parsed,
    publicDomain: 'example.up.railway.app',
    mcpPath: '/secret/mcp',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://example.up.railway.app/secret/mobile/character-create',
  );
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    fileName: 'Mobile Character Probe',
    cardJson,
  });
  assert.equal(result.avatarUrl, 'Mobile Character Probe.png');
});

test('character_create rejects missing or malformed cardJson before any network call', () => {
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({ op: 'character_create' })),
    /cardJson is required/,
  );
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({
      op: 'character_create',
      cardJson: '{not-json}',
    })),
    /cardJson must be valid JSON/,
  );
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({
      op: 'character_create',
      cardJson: '[]',
    })),
    /cardJson must be a JSON object/,
  );
});

test('character_update validates a V3 card and performs exactly one POST', async () => {
  const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: { name: 'Mobile CRUD Probe', description: 'updated' },
  };
  const cardJson = JSON.stringify(card);
  const parsed = parseOneShotCommand(JSON.stringify({
    op: 'character_update',
    nonce: 'character-update-1',
    avatarUrl: 'Mobile CRUD Probe.png',
    cardJson,
  }));

  assert.equal(parsed.op, 'character_update');
  assert.equal(parsed.avatarUrl, 'Mobile CRUD Probe.png');
  assert.equal(parsed.cardJson, cardJson);

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      ok: true,
      avatarUrl: 'Mobile CRUD Probe.png',
      characterName: 'Mobile CRUD Probe',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await executeOneShot({
    command: parsed,
    publicDomain: 'example.up.railway.app',
    mcpPath: '/secret/mcp',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.up.railway.app/secret/mobile/character-update');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    avatarUrl: 'Mobile CRUD Probe.png',
    cardJson,
  });
  assert.equal(result.characterName, 'Mobile CRUD Probe');
});

test('character_delete defaults to preserving chats and performs exactly one POST', async () => {
  const parsed = parseOneShotCommand(JSON.stringify({
    op: 'character_delete',
    nonce: 'character-delete-1',
    avatarUrl: 'Mobile CRUD Probe.png',
  }));
  assert.equal(parsed.deleteChats, false);

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      ok: true,
      deleted: true,
      avatarUrl: 'Mobile CRUD Probe.png',
      deleteChats: false,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await executeOneShot({
    command: parsed,
    publicDomain: 'example.up.railway.app',
    mcpPath: '/secret/mcp',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.up.railway.app/secret/mobile/character-delete');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    avatarUrl: 'Mobile CRUD Probe.png',
    deleteChats: false,
  });
  assert.equal(result.deleted, true);
});

test('character_update and character_delete validate inputs before network use', () => {
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({ op: 'character_update' })),
    /avatarUrl is required/,
  );
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({
      op: 'character_update',
      avatarUrl: 'Darya.png',
      cardJson: '{bad}',
    })),
    /cardJson must be valid JSON/,
  );
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({
      op: 'character_delete',
      avatarUrl: 'Darya.png',
      deleteChats: 'yes',
    })),
    /deleteChats must be a boolean/,
  );
});

test('character_create derives deterministic fileName from card name when omitted', () => {
  const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: { name: 'Deterministic Character', description: 'probe' },
  };
  const parsed = parseOneShotCommand(JSON.stringify({
    op: 'character_create',
    nonce: 'character-create-derived-name',
    cardJson: JSON.stringify(card),
  }));

  assert.equal(parsed.fileName, 'Deterministic Character');
});

test('character_duplicate validates source and derives deterministic target filename', async () => {
  const parsed = parseOneShotCommand(JSON.stringify({
    op: 'character_duplicate',
    nonce: 'duplicate-1',
    avatarUrl: 'Darya.png',
    newName: 'Darya Copy',
  }));

  assert.equal(parsed.op, 'character_duplicate');
  assert.equal(parsed.avatarUrl, 'Darya.png');
  assert.equal(parsed.newName, 'Darya Copy');
  assert.equal(parsed.fileName, 'Darya Copy');

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      ok: true,
      sourceAvatarUrl: 'Darya.png',
      avatarUrl: 'Darya Copy.png',
      characterName: 'Darya Copy',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await executeOneShot({
    command: parsed,
    publicDomain: 'example.up.railway.app',
    mcpPath: '/secret/mcp',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.up.railway.app/secret/mobile/character-duplicate');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    avatarUrl: 'Darya.png',
    newName: 'Darya Copy',
    fileName: 'Darya Copy',
  });
  assert.equal(result.avatarUrl, 'Darya Copy.png');
});

test('character_duplicate rejects missing source or target name', () => {
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({
      op: 'character_duplicate',
      newName: 'Copy',
    })),
    /avatarUrl is required/,
  );
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({
      op: 'character_duplicate',
      avatarUrl: 'Darya.png',
    })),
    /newName is required/,
  );
});

test('character_rename validates source and target and performs exactly one POST', async () => {
  const parsed = parseOneShotCommand(JSON.stringify({
    op: 'character_rename',
    nonce: 'rename-1',
    avatarUrl: 'Old Name.png',
    newName: 'New Name',
  }));
  assert.equal(parsed.op, 'character_rename');
  assert.equal(parsed.avatarUrl, 'Old Name.png');
  assert.equal(parsed.newName, 'New Name');

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      ok: true,
      oldAvatarUrl: 'Old Name.png',
      avatarUrl: 'New Name.png',
      characterName: 'New Name',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await executeOneShot({
    command: parsed,
    publicDomain: 'example.up.railway.app',
    mcpPath: '/secret/mcp',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.up.railway.app/secret/mobile/character-rename');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    avatarUrl: 'Old Name.png',
    newName: 'New Name',
  });
  assert.equal(result.avatarUrl, 'New Name.png');
});

test('character_rename rejects missing source or target name', () => {
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({
      op: 'character_rename',
      newName: 'New Name',
    })),
    /avatarUrl is required/,
  );
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({
      op: 'character_rename',
      avatarUrl: 'Old Name.png',
    })),
    /newName is required/,
  );
});

test('character_rename validates source and target and performs exactly one POST', async () => {
  const parsed = parseOneShotCommand(JSON.stringify({
    op: 'character_rename',
    nonce: 'rename-1',
    avatarUrl: 'Old Name.png',
    newName: 'New Name',
  }));

  assert.equal(parsed.op, 'character_rename');
  assert.equal(parsed.avatarUrl, 'Old Name.png');
  assert.equal(parsed.newName, 'New Name');

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      ok: true,
      oldAvatarUrl: 'Old Name.png',
      avatarUrl: 'New Name.png',
      characterName: 'New Name',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await executeOneShot({
    command: parsed,
    publicDomain: 'example.up.railway.app',
    mcpPath: '/secret/mcp',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.up.railway.app/secret/mobile/character-rename');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    avatarUrl: 'Old Name.png',
    newName: 'New Name',
  });
  assert.equal(result.avatarUrl, 'New Name.png');
});

test('character_rename rejects missing identifiers', () => {
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({
      op: 'character_rename',
      newName: 'New Name',
    })),
    /avatarUrl is required/,
  );
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({
      op: 'character_rename',
      avatarUrl: 'Old Name.png',
    })),
    /newName is required/,
  );
});

test('character_export_json validates avatarUrl and performs exactly one GET', async () => {
  const parsed = parseOneShotCommand(JSON.stringify({
    op: 'character_export_json',
    nonce: 'export-json-1',
    avatarUrl: 'Darya.png',
  }));
  assert.equal(parsed.op, 'character_export_json');
  assert.equal(parsed.avatarUrl, 'Darya.png');

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: { name: 'Darya' },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await executeOneShot({
    command: parsed,
    publicDomain: 'example.up.railway.app',
    mcpPath: '/secret/mcp',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://example.up.railway.app/secret/mobile/character-export-json?avatarUrl=Darya.png',
  );
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(result.data.name, 'Darya');
});

test('character_export_json rejects missing avatarUrl', () => {
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({ op: 'character_export_json' })),
    /avatarUrl is required/,
  );
});

test('character_import_json validates card JSON and derives deterministic filename', async () => {
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Imported Probe',
      description: 'from exported JSON',
    },
  };
  const cardJson = JSON.stringify(card);
  const parsed = parseOneShotCommand(JSON.stringify({
    op: 'character_import_json',
    nonce: 'import-json-1',
    cardJson,
  }));

  assert.equal(parsed.op, 'character_import_json');
  assert.equal(parsed.cardJson, cardJson);
  assert.equal(parsed.fileName, 'Imported Probe');

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      ok: true,
      imported: true,
      avatarUrl: 'Imported Probe.png',
      characterName: 'Imported Probe',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await executeOneShot({
    command: parsed,
    publicDomain: 'example.up.railway.app',
    mcpPath: '/secret/mcp',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.up.railway.app/secret/mobile/character-import-json');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    fileName: 'Imported Probe',
    cardJson,
  });
  assert.equal(result.imported, true);
});

test('character_import_json rejects malformed or nameless cards without explicit filename', () => {
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({
      op: 'character_import_json',
      cardJson: '{bad}',
    })),
    /cardJson must be valid JSON/,
  );
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({
      op: 'character_import_json',
      cardJson: JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: {} }),
    })),
    /Character card name is required/,
  );
});

test('world-info mutations parse deterministic payloads and route to POST endpoints', async () => {
  const cases = [
    {
      raw: { op: 'world_info_create', nonce: 'wi-create-1', name: 'Probe World' },
      expectedPath: '/world-info-create',
      expectedBody: { name: 'Probe World', worldJson: '{"entries":{}}' },
    },
    {
      raw: {
        op: 'world_info_update',
        nonce: 'wi-update-1',
        name: 'Probe World',
        worldJson: JSON.stringify({ entries: { 0: { uid: 0, content: 'updated' } } }),
      },
      expectedPath: '/world-info-update',
      expectedBody: {
        name: 'Probe World',
        worldJson: JSON.stringify({ entries: { 0: { uid: 0, content: 'updated' } } }),
      },
    },
    {
      raw: { op: 'world_info_delete', nonce: 'wi-delete-1', name: 'Probe World' },
      expectedPath: '/world-info-delete',
      expectedBody: { name: 'Probe World' },
    },
    {
      raw: {
        op: 'world_info_entry_upsert',
        nonce: 'wi-entry-upsert-1',
        name: 'Probe World',
        uid: 7,
        entryJson: JSON.stringify({ content: 'entry', key: ['probe'] }),
      },
      expectedPath: '/world-info-entry-upsert',
      expectedBody: {
        name: 'Probe World',
        uid: 7,
        entryJson: JSON.stringify({ content: 'entry', key: ['probe'] }),
      },
    },
    {
      raw: {
        op: 'world_info_entry_delete',
        nonce: 'wi-entry-delete-1',
        name: 'Probe World',
        uid: 7,
      },
      expectedPath: '/world-info-entry-delete',
      expectedBody: { name: 'Probe World', uid: 7 },
    },
  ];

  for (const item of cases) {
    const parsed = parseOneShotCommand(JSON.stringify(item.raw));
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await executeOneShot({
      command: parsed,
      publicDomain: 'example.up.railway.app',
      mcpPath: '/secret/mcp',
      fetchImpl,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://example.up.railway.app/secret/mobile' + item.expectedPath);
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), item.expectedBody);
  }
});

test('world-info mutations validate JSON and deterministic integer UIDs', () => {
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({
      op: 'world_info_update',
      name: 'Probe',
      worldJson: '{bad}',
    })),
    /worldJson must be valid JSON/,
  );
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({
      op: 'world_info_update',
      name: 'Probe',
      worldJson: JSON.stringify({ nope: {} }),
    })),
    /worldJson must contain an entries object/,
  );
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({
      op: 'world_info_entry_upsert',
      name: 'Probe',
      uid: -1,
      entryJson: JSON.stringify({ content: 'x' }),
    })),
    /uid must be a non-negative integer/,
  );
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({
      op: 'world_info_entry_delete',
      name: 'Probe',
      uid: '7',
    })),
    /uid must be a non-negative integer/,
  );
});

test('world_info_save validates JSON and performs one POST', async () => {
  const data = { entries: { 0: { uid: 0, key: ['probe'], content: 'WORLD_PROBE' } } };
  const dataJson = JSON.stringify(data);
  const parsed = parseOneShotCommand(JSON.stringify({
    op: 'world_info_save',
    nonce: 'world-save-1',
    name: 'Probe Lore',
    dataJson,
  }));

  assert.equal(parsed.op, 'world_info_save');
  assert.equal(parsed.name, 'Probe Lore');
  assert.equal(parsed.dataJson, dataJson);

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, name: 'Probe Lore' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await executeOneShot({
    command: parsed,
    publicDomain: 'example.up.railway.app',
    mcpPath: '/secret/mcp',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.up.railway.app/secret/mobile/world-info-save');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    name: 'Probe Lore',
    dataJson,
  });
  assert.equal(result.ok, true);
});

test('world_info_delete validates name and performs one POST', async () => {
  const parsed = parseOneShotCommand(JSON.stringify({
    op: 'world_info_delete',
    nonce: 'world-delete-1',
    name: 'Probe Lore',
  }));

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, deleted: true, name: 'Probe Lore' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await executeOneShot({
    command: parsed,
    publicDomain: 'example.up.railway.app',
    mcpPath: '/secret/mcp',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.up.railway.app/secret/mobile/world-info-delete');
  assert.deepEqual(JSON.parse(calls[0].init.body), { name: 'Probe Lore' });
  assert.equal(result.deleted, true);
});

test('world_info_save/delete reject invalid payloads', () => {
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({ op: 'world_info_save', name: 'Probe' })),
    /dataJson is required/,
  );
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({
      op: 'world_info_save',
      name: 'Probe',
      dataJson: JSON.stringify({ nope: true }),
    })),
    /entries/,
  );
  assert.throws(
    () => parseOneShotCommand(JSON.stringify({ op: 'world_info_delete' })),
    /name is required/,
  );
});

