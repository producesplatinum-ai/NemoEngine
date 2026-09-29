import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SillyTavernClient,
  checkReadiness,
  classifyRequestPath,
  normalizeBaseUrl,
  resolveSillyTavernBaseUrl,
  sanitizeNemoRuntimeReport,
  sanitizeNemoClientRuntimeReport,
} from './sillytavern-server.mjs';

function makeJsonResponse(body, { status = 200, setCookies = [] } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      getSetCookie() {
        return setCookies;
      },
      get(name) {
        if (name.toLowerCase() === 'content-type') return 'application/json';
        return null;
      },
    },
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

test('normalizeBaseUrl accepts only http(s) and removes trailing slashes', () => {
  assert.equal(normalizeBaseUrl('https://example.test///'), 'https://example.test');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000');
  assert.throws(() => normalizeBaseUrl('file:///tmp/st'), /http/i);
});

test('Railway deployments prefer the private SillyTavern hostname while local runs keep SILLYTAVERN_URL', () => {
  assert.equal(
    resolveSillyTavernBaseUrl({
      SILLYTAVERN_URL: 'https://public.example.test',
      RAILWAY_ENVIRONMENT_ID: 'env-123',
    }),
    'http://sillytavern.railway.internal:8000',
  );

  assert.equal(
    resolveSillyTavernBaseUrl({
      SILLYTAVERN_URL: 'https://public.example.test',
    }),
    'https://public.example.test',
  );
});

test('client obtains a CSRF token, preserves the session cookie, and lists characters', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).endsWith('/csrf-token')) {
      return makeJsonResponse(
        { token: 'csrf-123' },
        { setCookies: ['connect.sid=session-abc; Path=/; HttpOnly'] },
      );
    }

    assert.equal(String(url), 'https://st.example.test/api/characters/all');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['x-csrf-token'], 'csrf-123');
    assert.equal(options.headers.cookie, 'connect.sid=session-abc');
    assert.equal(options.headers['content-type'], 'application/json');
    assert.equal(options.body, '{}');
    return makeJsonResponse([{ name: 'Darya', avatar: 'Darya.png' }]);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test/',
    fetchImpl,
  });

  const characters = await client.listCharacters();
  assert.deepEqual(characters, [{ name: 'Darya', avatar: 'Darya.png' }]);
  assert.equal(calls.length, 2);
});

test('client maps read-only SillyTavern API calls to current endpoints', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/csrf-token')) {
      return makeJsonResponse({ token: 'csrf' });
    }
    return makeJsonResponse({ ok: true });
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });

  await client.getCharacter('Darya.png');
  await client.listWorldInfo();
  await client.getWorldInfo('Main Lore');
  await client.recentChats();
  await client.getChat({ avatarUrl: 'Darya.png', fileName: 'Chat 1' });

  const mapped = calls.slice(1).map(({ url, options }) => ({
    path: new URL(url).pathname,
    body: options.body ? JSON.parse(options.body) : null,
  }));

  assert.deepEqual(mapped, [
    { path: '/api/characters/get', body: { avatar_url: 'Darya.png' } },
    { path: '/api/worldinfo/list', body: {} },
    { path: '/api/worldinfo/get', body: { name: 'Main Lore' } },
    { path: '/api/chats/recent', body: {} },
    {
      path: '/api/chats/get',
      body: { avatar_url: 'Darya.png', file_name: 'Chat 1' },
    },
  ]);
});

test('client supports optional HTTP Basic Authentication for protected remote SillyTavern', async () => {
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith('/csrf-token')) {
      assert.equal(
        options.headers.authorization,
        'Basic ' + Buffer.from('user:pass').toString('base64'),
      );
      return makeJsonResponse({ token: 'csrf' });
    }

    assert.equal(
      options.headers.authorization,
      'Basic ' + Buffer.from('user:pass').toString('base64'),
    );
    return makeJsonResponse([]);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    username: 'user',
    password: 'pass',
    fetchImpl,
  });

  await client.listCharacters();
});

test('readiness safely checks authenticated CSRF and characters API without deliberate auth failures', async () => {
  let listCharactersCalled = 0;

  const ok = await checkReadiness(() => ({
    async status() {
      return {
        ok: true,
        baseUrl: 'http://sillytavern.railway.internal:8000',
        csrfSessionReady: true,
        basicAuthConfigured: true,
      };
    },
    async listCharacters() {
      listCharactersCalled += 1;
      return [{ name: 'Darya', avatar: 'Darya.png' }];
    },
  }));

  assert.equal(listCharactersCalled, 1);
  assert.deepEqual(ok, {
    ok: true,
    service: 'sillytavern-mcp',
    upstream: {
      ok: true,
      csrfSessionReady: true,
      basicAuthConfigured: true,
      charactersReadable: true,
      characterCount: 1,
    },
  });

  const apiFailed = await checkReadiness(() => ({
    async status() {
      return {
        ok: true,
        csrfSessionReady: true,
        basicAuthConfigured: true,
      };
    },
    async listCharacters() {
      throw new Error('characters API unavailable');
    },
  }));

  assert.equal(apiFailed.ok, false);
  assert.match(apiFailed.error, /characters API unavailable/);
  assert.equal('baseUrl' in apiFailed, false);
});


test('client reads and sanitizes the persisted Nemo runtime report without exposing unrelated fields', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/csrf-token')) {
      return makeJsonResponse(
        { token: 'csrf-nemo' },
        { setCookies: ['connect.sid=nemo-session; Path=/; HttpOnly'] },
      );
    }
    assert.equal(String(url), 'https://st.example.test/user/files/nemo-runtime-report.json');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.cookie, 'connect.sid=nemo-session');
    return makeJsonResponse({
      ok: true,
      preset: 'Nemo Engine 11.5.2 - Ready RU RP',
      promptCount: 458,
      regexCount: 97,
      recipe: { applicable: true, active: true, validated: true },
      vex: { applicable: true, active: true, validated: true },
      cold: { applicable: true, active: true, validated: true, count: 321 },
      sidecars: { recipe: 4, vex: 6, cold: 3 },
      rendering: { stage: '5B.3/5', enabled: true, clientRuntime: 'NemoPresetExt' },
      secretShouldNotLeak: 'nope',
    });
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    username: 'user',
    password: 'pass',
    fetchImpl,
  });

  const report = await client.getNemoRuntimeStatus();
  assert.deepEqual(report, {
    ok: true,
    preset: 'Nemo Engine 11.5.2 - Ready RU RP',
    promptCount: 458,
    regexCount: 97,
    recipe: { applicable: true, active: true, validated: true },
    vex: { applicable: true, active: true, validated: true },
    cold: { applicable: true, active: true, validated: true, count: 321 },
    sidecars: { recipe: 4, vex: 6, cold: 3 },
    rendering: { stage: '5B.3/5', enabled: true, clientRuntime: 'NemoPresetExt' },
  });
  assert.equal(calls.length, 2);
});

test('client falls back to settings NemoFullRuntime when persisted report file is unavailable', async () => {
  const calls = [];
  const runtime = {
    ok: true,
    preset: 'Nemo Engine 11.5.2 - Ready RU RP',
    promptCount: 445,
    regexCount: 97,
    recipe: { applicable: false, active: false, validated: true },
    vex: { applicable: false, active: false, validated: true },
    cold: { applicable: true, active: true, validated: true, count: 445 },
    sidecars: { recipe: 0, vex: 0, cold: 445 },
    rendering: { stage: '5B.3/5', enabled: true, clientRuntime: 'NemoPresetExt' },
    secretShouldNotLeak: 'nope',
  };

  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/csrf-token')) {
      return makeJsonResponse(
        { token: 'csrf-fallback' },
        { setCookies: ['connect.sid=fallback-session; Path=/; HttpOnly'] },
      );
    }
    if (String(url).endsWith('/user/files/nemo-runtime-report.json')) {
      return makeJsonResponse({ error: 'Not Found' }, { status: 404 });
    }
    assert.equal(String(url), 'https://st.example.test/api/settings/get');
    assert.equal(options.method, 'POST');
    return makeJsonResponse({
      extension_settings: {
        NemoFullRuntime: runtime,
      },
      api_key: 'must-not-leak',
    });
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    username: 'user',
    password: 'pass',
    fetchImpl,
  });

  const report = await client.getNemoRuntimeStatus();
  assert.deepEqual(report, sanitizeNemoRuntimeReport(runtime));
  assert.equal(calls.length, 3);
});

test('Nemo runtime sanitizer keeps only the public verification contract', () => {
  assert.deepEqual(
    sanitizeNemoRuntimeReport({
      ok: true,
      preset: 'Nemo',
      promptCount: 458,
      regexCount: 97,
      recipe: { active: true },
      vex: { active: true },
      cold: { count: 12 },
      sidecars: { cold: 2 },
      rendering: { enabled: true },
      apiKey: 'must-not-leak',
      credentials: { username: 'hidden' },
    }),
    {
      ok: true,
      preset: 'Nemo',
      promptCount: 458,
      regexCount: 97,
      recipe: { active: true },
      vex: { active: true },
      cold: { count: 12 },
      sidecars: { cold: 2 },
      rendering: { enabled: true },
    },
  );
});

test('combined mobile gateway preserves SillyTavern and routes provider MCP endpoints', () => {
  const sillyPath = '/st-secret/mcp';
  const aiPrefix = '/ai-secret';

  assert.deepEqual(
    classifyRequestPath('/healthz', { sillyPath, aiPrefix }),
    { kind: 'health' },
  );
  assert.deepEqual(
    classifyRequestPath('/nemo-runtime-status', { sillyPath, aiPrefix }),
    { kind: 'nemo_status' },
  );
  assert.deepEqual(
    classifyRequestPath('/nemo-full-status', { sillyPath, aiPrefix }),
    { kind: 'nemo_full_status' },
  );
  assert.deepEqual(
    classifyRequestPath(sillyPath, { sillyPath, aiPrefix }),
    { kind: 'sillytavern' },
  );
  assert.deepEqual(
    classifyRequestPath('/ai-secret/groq/mcp', { sillyPath, aiPrefix }),
    { kind: 'provider', providerId: 'groq' },
  );
  assert.deepEqual(
    classifyRequestPath('/ai-secret/openrouter/mcp', { sillyPath, aiPrefix }),
    { kind: 'provider', providerId: 'openrouter' },
  );
  assert.deepEqual(
    classifyRequestPath('/ai-secret/deepseek/mcp', { sillyPath, aiPrefix }),
    { kind: 'provider', providerId: 'deepseek' },
  );
  assert.deepEqual(
    classifyRequestPath('/ai-secret/unknown/mcp', { sillyPath, aiPrefix }),
    { kind: 'not_found' },
  );
});


test('client sanitizes persisted Nemo client preflight report', async () => {
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith('/csrf-token')) return makeJsonResponse({ token: 'csrf-client' });
    assert.equal(String(url), 'https://st.example.test/user/files/nemo-client-runtime-report.json');
    assert.equal(options.method, 'GET');
    return makeJsonResponse({
      ok: true,
      bootstrapVersion: '1.1.0',
      preset: 'Nemo Engine 11.5.2 - Ready RU RP',
      importedAt: '2026-09-29T01:50:00.000Z',
      transform: { coldPromptCount: 445, promptCount: 458, regexCount: 97, recipeRuntime: false, vexRuntime: false },
      preflight: { available: true, ok: true, aborted: false },
      recipe: { active: false },
      cold: { hydrated: 445 },
      vex: { active: false },
      rendering: { enabled: true },
      persistence: { ok: true, path: '/files/nemo-client-runtime-report.json' },
      secretShouldNotLeak: 'nope',
    });
  };

  const client = new SillyTavernClient({ baseUrl: 'https://st.example.test', fetchImpl });
  const report = await client.getNemoClientRuntimeStatus();

  assert.deepEqual(report, {
    ok: true,
    bootstrapVersion: '1.1.0',
    preset: 'Nemo Engine 11.5.2 - Ready RU RP',
    importedAt: '2026-09-29T01:50:00.000Z',
    transform: { coldPromptCount: 445, promptCount: 458, regexCount: 97, recipeRuntime: false, vexRuntime: false },
    preflight: { available: true, ok: true, aborted: false },
    recipe: { active: false },
    cold: { hydrated: 445 },
    vex: { active: false },
    rendering: { enabled: true },
    persistence: { ok: true, path: '/files/nemo-client-runtime-report.json' },
  });
});

test('full Nemo status combines server verification with optional client preflight', async () => {
  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl: async (url) => {
      if (String(url).endsWith('/csrf-token')) return makeJsonResponse({ token: 'csrf-full' });
      if (String(url).endsWith('/user/files/nemo-runtime-report.json')) {
        return makeJsonResponse({
          ok: true,
          preset: 'Nemo Engine 11.5.2 - Ready RU RP',
          promptCount: 458,
          regexCount: 97,
          recipe: { applicable: false, active: false, validated: false },
          vex: { applicable: false, active: false, validated: false },
          cold: { applicable: true, active: true, validated: true, count: 445 },
          sidecars: { recipe: 0, vex: 0, cold: 5 },
          rendering: { stage: '5B.3/5', enabled: true, clientRuntime: 'NemoPresetExt' },
        });
      }
      if (String(url).endsWith('/user/files/nemo-client-runtime-report.json')) {
        return makeJsonResponse({ error: 'Not Found' }, { status: 404 });
      }
      throw new Error('unexpected URL');
    },
  });

  const status = await client.getNemoFullStatus();
  assert.equal(status.ok, true);
  assert.equal(status.server.ok, true);
  assert.deepEqual(status.client, { available: false });
});

test('Nemo client runtime sanitizer keeps only the verification contract', () => {
  assert.deepEqual(
    sanitizeNemoClientRuntimeReport({
      ok: true,
      bootstrapVersion: '1.1.0',
      preset: 'Nemo',
      importedAt: '2026-09-29T01:50:00.000Z',
      transform: { coldPromptCount: 445 },
      preflight: { available: true, ok: true, aborted: false },
      recipe: { active: false },
      cold: { hydrated: 445 },
      vex: { active: false },
      rendering: { enabled: true },
      persistence: { ok: true, path: '/files/nemo-client-runtime-report.json' },
      credentials: { hidden: true },
    }),
    {
      ok: true,
      bootstrapVersion: '1.1.0',
      preset: 'Nemo',
      importedAt: '2026-09-29T01:50:00.000Z',
      transform: { coldPromptCount: 445 },
      preflight: { available: true, ok: true, aborted: false },
      recipe: { active: false },
      cold: { hydrated: 445 },
      vex: { active: false },
      rendering: { enabled: true },
      persistence: { ok: true, path: '/files/nemo-client-runtime-report.json' },
    },
  );
});


test('client appends and persists a user message without replacing an existing chat contract', async () => {
  let saveBody = null;
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-turn' });
    if (path === '/api/characters/get') {
      assert.deepEqual(JSON.parse(options.body), { avatar_url: 'Seraphina.png' });
      return makeJsonResponse({ name: 'Seraphina' });
    }
    if (path === '/api/chats/get') {
      return makeJsonResponse({});
    }
    if (path === '/api/chats/save') {
      saveBody = JSON.parse(options.body);
      return makeJsonResponse({ result: 'ok' });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });

  const result = await client.appendUserMessage({
    avatarUrl: 'Seraphina.png',
    fileName: 'Nemo mobile test',
    userText: 'NEMO_ST_MOBILE_WRITE_0929',
  });

  assert.equal(result.ok, true);
  assert.equal(result.saved, true);
  assert.equal(result.characterName, 'Seraphina');
  assert.equal(result.messageCount, 2);
  assert.equal(saveBody.avatar_url, 'Seraphina.png');
  assert.equal(saveBody.file_name, 'Nemo mobile test');
  assert.equal(saveBody.ch_name, 'Seraphina');
  assert.equal(saveBody.chat.length, 2);
  assert.equal(saveBody.chat[1].is_user, true);
  assert.equal(saveBody.chat[1].mes, 'NEMO_ST_MOBILE_WRITE_0929');
});
