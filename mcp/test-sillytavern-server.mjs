import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SillyTavernClient,
  checkReadiness,
  classifyRequestPath,
  normalizeBaseUrl,
  resolveSillyTavernBaseUrl,
  sanitizeNemoRuntimeReport,
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
