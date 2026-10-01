import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SillyTavernClient,
  buildCharacterGenerationMessages,
  checkReadiness,
  classifyRequestPath,
  normalizeBaseUrl,
  resolveSillyTavernBaseUrl,
  parseMobileWriteBody,
  mobileTurnFormHtml,
  mobileClientGenerateFormHtml,
  buildClientGenerateRedirect,
  sanitizeNemoClientGenerationReport,
  createBootstrapProxyCookie,
  hasBootstrapProxyCookie,
  sanitizeNemoRuntimeReport,
  sanitizeNemoClientRuntimeReport,
  isDaryaImportAuthorized,
  createSerialTaskQueue,
} from './sillytavern-server.mjs';
import { classifyMobileRestRequest, executeMobileRestRoute } from './sillytavern-mobile-rest.mjs';

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


test('card-aware server generation assembly uses V3 prompt, lore, depth prompt, and post-history instructions', () => {
  const character = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Дарья',
      description: 'DARYA_DESCRIPTION',
      personality: 'DARYA_PERSONALITY',
      scenario: 'DARYA_SCENARIO',
      mes_example: '<START>\n{{user}}: EXAMPLE_USER\n{{char}}: EXAMPLE_DARYA',
      system_prompt: 'DARYA_SYSTEM_PROMPT',
      post_history_instructions: 'DARYA_POST_HISTORY',
      extensions: {
        depth_prompt: {
          prompt: 'DARYA_DEPTH_PROMPT',
          depth: 2,
          role: 'system',
        },
      },
      character_book: {
        entries: [
          {
            id: 0,
            comment: 'constant',
            content: 'DARYA_CONSTANT_LORE',
            enabled: true,
            constant: true,
            selective: false,
            keys: [],
          },
          {
            id: 1,
            comment: 'matched',
            content: 'DARYA_MATCHED_LORE',
            enabled: true,
            constant: false,
            selective: true,
            keys: ['гараж'],
          },
          {
            id: 2,
            comment: 'unmatched',
            content: 'DARYA_UNMATCHED_LORE',
            enabled: true,
            constant: false,
            selective: true,
            keys: ['салон'],
          },
        ],
      },
    },
  };
  const conversation = [
    { is_user: true, is_system: false, mes: 'Мы снова за гаражами.' },
    { is_user: false, is_system: false, mes: 'Продолжай.' },
    { is_user: true, is_system: false, mes: 'Точнее.' },
  ];

  const messages = buildCharacterGenerationMessages({
    character,
    characterName: 'Дарья',
    conversation,
  });

  const joined = messages.map(x => `[${x.role}] ${x.content}`).join('\n');
  assert.match(joined, /DARYA_SYSTEM_PROMPT/);
  assert.match(joined, /DARYA_DESCRIPTION/);
  assert.match(joined, /DARYA_PERSONALITY/);
  assert.match(joined, /DARYA_SCENARIO/);
  assert.match(joined, /EXAMPLE_DARYA/);
  assert.match(joined, /DARYA_CONSTANT_LORE/);
  assert.match(joined, /DARYA_MATCHED_LORE/);
  assert.doesNotMatch(joined, /DARYA_UNMATCHED_LORE/);
  assert.match(joined, /DARYA_DEPTH_PROMPT/);
  assert.equal(messages.at(-1).role, 'system');
  assert.equal(messages.at(-1).content, 'DARYA_POST_HISTORY');

  const userMessages = messages.filter(x => x.role === 'user').map(x => x.content);
  assert.deepEqual(userMessages, ['Мы снова за гаражами.', 'Точнее.']);
});


test('generateAssistantMessage actually sends card-aware messages to the configured provider', async () => {
  let generationBody = null;
  let savedChat = null;
  const card = {
    data: {
      name: 'Дарья',
      description: 'CARD_DESCRIPTION',
      personality: 'CARD_PERSONALITY',
      scenario: 'CARD_SCENARIO',
      system_prompt: 'CARD_SYSTEM_PROMPT',
      post_history_instructions: 'CARD_POST_HISTORY',
      extensions: { depth_prompt: { prompt: 'CARD_DEPTH_PROMPT', depth: 1, role: 'system' } },
      character_book: {
        entries: [{
          id: 0,
          content: 'CARD_CONSTANT_LORE',
          enabled: true,
          constant: true,
          selective: false,
          keys: [],
        }],
      },
    },
  };
  const chat = [
    { user_name: 'You', character_name: 'Дарья', chat_metadata: {} },
    { name: 'You', is_user: true, is_system: false, mes: 'Проверка карточки.' },
  ];

  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-card-aware' });
    if (path === '/api/characters/get') return makeJsonResponse(card);
    if (path === '/api/chats/get') return makeJsonResponse(chat);
    if (path === '/api/backends/chat-completions/generate') {
      generationBody = JSON.parse(options.body);
      return makeJsonResponse({ choices: [{ message: { content: 'CARD_AWARE_REPLY' } }] });
    }
    if (path === '/api/chats/save') {
      savedChat = JSON.parse(options.body);
      return makeJsonResponse({ ok: true });
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({ baseUrl: 'https://st.example.test', fetchImpl });
  const result = await client.generateAssistantMessage({
    avatarUrl: 'Darya.png',
    fileName: 'Darya card-aware test',
    source: 'deepseek',
    model: 'deepseek-flash',
    nonce: 'card-aware-nonce',
  });

  const joined = generationBody.messages.map(x => `[${x.role}] ${x.content}`).join('\n');
  assert.match(joined, /CARD_SYSTEM_PROMPT/);
  assert.match(joined, /CARD_CONSTANT_LORE/);
  assert.match(joined, /CARD_DEPTH_PROMPT/);
  assert.equal(generationBody.messages.at(-1).content, 'CARD_POST_HISTORY');
  assert.equal(result.message, 'CARD_AWARE_REPLY');
  assert.equal(savedChat.chat.at(-1).mes, 'CARD_AWARE_REPLY');
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
    classifyRequestPath('/ai-secret/leonardo/mcp', { sillyPath, aiPrefix }),
    { kind: 'image_provider', providerId: 'leonardo' },
  );
  assert.deepEqual(
    classifyRequestPath('/ai-secret/ideogram/mcp', { sillyPath, aiPrefix }),
    { kind: 'image_provider', providerId: 'ideogram' },
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


test('parses browser form POST bodies for mobile turn writes', () => {
  assert.deepEqual(
    parseMobileWriteBody(
      'application/x-www-form-urlencoded',
      'avatarUrl=default_Seraphina.png&fileName=Nemo+mobile+test&userText=NEMO_ST_MOBILE_WRITE_0929',
    ),
    {
      avatarUrl: 'default_Seraphina.png',
      fileName: 'Nemo mobile test',
      userText: 'NEMO_ST_MOBILE_WRITE_0929',
    },
  );
});

test('mobile turn GET form posts the three explicit fields back to the same endpoint', () => {
  const html = mobileTurnFormHtml('/st-secret/mobile/turn');
  assert.match(html, /<form[^>]+method="post"/i);
  assert.match(html, /action="\/st-secret\/mobile\/turn"/);
  assert.match(html, /name="avatarUrl"/);
  assert.match(html, /name="fileName"/);
  assert.match(html, /name="userText"/);
});


test('bootstrap proxy cookie is capability-bound, short-lived, and not accepted with the wrong MCP path', () => {
  const cookie = createBootstrapProxyCookie('/st-secret/mcp');
  assert.match(cookie, /^st_bootstrap_proxy=/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=300/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);

  const pair = cookie.split(';', 1)[0];
  assert.equal(hasBootstrapProxyCookie(pair, '/st-secret/mcp'), true);
  assert.equal(hasBootstrapProxyCookie(pair, '/other-secret/mcp'), false);
  assert.equal(hasBootstrapProxyCookie('', '/st-secret/mcp'), false);
});


test('client runtime status falls back to NemoFullBootstrap settings when persisted report file is unreadable', async () => {
  const runtime = {
    ok: true,
    bootstrapVersion: '1.1.0',
    preset: 'Nemo Engine 11.5.2 - Ready RU RP',
    importedAt: '2026-09-29T03:14:34.000Z',
    transform: { coldPromptCount: 445, promptCount: 458, regexCount: 97, recipeRuntime: false, vexRuntime: false },
    preflight: { available: true, ok: true, aborted: false },
    recipe: null,
    cold: { hydrated: 445 },
    vex: null,
    rendering: { enabled: true },
    persistence: { ok: true, path: '/files/nemo-client-runtime-report.json' },
  };

  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-client-fallback' });
    if (path === '/user/files/nemo-client-runtime-report.json') {
      return makeJsonResponse({ error: 'temporary read failure' }, { status: 500 });
    }
    if (path === '/api/settings/get') {
      assert.equal(options.method, 'POST');
      return makeJsonResponse({ extension_settings: { NemoFullBootstrap: runtime } });
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({ baseUrl: 'https://st.example.test', fetchImpl });
  const report = await client.getNemoClientRuntimeStatus();
  assert.deepEqual(report, sanitizeNemoClientRuntimeReport(runtime));
});


test('client runtime file read proves persistence when older report omitted persistence metadata', async () => {
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-persisted-client' });
    if (path === '/user/files/nemo-client-runtime-report.json') {
      assert.equal(options.method, 'GET');
      return makeJsonResponse({
        ok: true,
        bootstrapVersion: '1.1.0',
        preset: 'Nemo Engine 11.5.2 - Ready RU Gooner RP',
        importedAt: '2026-09-29T03:23:08.190Z',
        transform: { coldPromptCount: 445, promptCount: 458, regexCount: 97 },
        preflight: { available: true, ok: true, aborted: false },
        persistence: null,
      });
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({ baseUrl: 'https://st.example.test', fetchImpl });
  const report = await client.getNemoClientRuntimeStatus();
  assert.deepEqual(report.persistence, {
    ok: true,
    path: '/files/nemo-client-runtime-report.json',
  });
});


test('client generate form is explicit and redirect is request-bound', () => {
  const html = mobileClientGenerateFormHtml('/st-secret/mobile/client-generate');
  assert.match(html, /<form[^>]+method="post"/i);
  assert.match(html, /action="\/st-secret\/mobile\/client-generate"/);
  assert.match(html, /name="avatarUrl"/);
  assert.match(html, /name="fileName"/);
  assert.match(html, /name="marker"/);

  const target = buildClientGenerateRedirect({
    avatarUrl: 'default_Seraphina.png',
    fileName: 'Nemo mobile test',
    marker: 'NEMO_ST_MOBILE_WRITE_0929',
    requestId: 'req-123',
  });
  const url = new URL(target, 'https://gateway.invalid');
  assert.equal(url.pathname, '/');
  assert.equal(url.searchParams.get('nemoClientGenerate'), '1');
  assert.equal(url.searchParams.get('avatarUrl'), 'default_Seraphina.png');
  assert.equal(url.searchParams.get('fileName'), 'Nemo mobile test');
  assert.equal(url.searchParams.get('marker'), 'NEMO_ST_MOBILE_WRITE_0929');
  assert.equal(url.searchParams.get('requestId'), 'req-123');

  assert.throws(
    () => buildClientGenerateRedirect({
      avatarUrl: '',
      fileName: 'Nemo mobile test',
      marker: 'marker',
      requestId: 'req-123',
    }),
    /avatarUrl, fileName, marker, and requestId are required/,
  );
});

test('client generation report sanitizer keeps only verification fields', () => {
  assert.deepEqual(
    sanitizeNemoClientGenerationReport({
      ok: true,
      requestId: 'req-123',
      generatedAt: '2026-09-29T03:30:00.000Z',
      preset: 'Nemo Engine 11.5.2 - Ready RU Gooner RP',
      avatarUrl: 'default_Seraphina.png',
      fileName: 'Nemo mobile test',
      marker: 'NEMO_ST_MOBILE_WRITE_0929',
      beforeCount: 2,
      afterCount: 3,
      assistantMessagePresent: true,
      generatedNewAssistant: false,
      outcome: '',
      bootstrapImportedAt: '2026-09-29T03:23:08.190Z',
      error: '',
      secretShouldNotLeak: 'nope',
    }),
    {
      ok: true,
      requestId: 'req-123',
      generatedAt: '2026-09-29T03:30:00.000Z',
      preset: 'Nemo Engine 11.5.2 - Ready RU Gooner RP',
      avatarUrl: 'default_Seraphina.png',
      fileName: 'Nemo mobile test',
      marker: 'NEMO_ST_MOBILE_WRITE_0929',
      beforeCount: 2,
      afterCount: 3,
      assistantMessagePresent: true,
      generatedNewAssistant: false,
      outcome: '',
      bootstrapImportedAt: '2026-09-29T03:23:08.190Z',
      error: '',
    },
  );
});


test('client generation status rejects stale marker reports', async () => {
  const fetchImpl = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-generation-status' });
    if (path === '/user/files/nemo-client-generation-report.json') {
      return makeJsonResponse({
        ok: true,
        requestId: 'old-request',
        generatedAt: '2026-09-29T03:36:38.786Z',
        preset: 'Nemo Engine 11.5.2 - Ready RU Gooner RP',
        avatarUrl: 'default_Seraphina.png',
        fileName: 'Nemo mobile test',
        marker: 'OLD_MARKER',
        beforeCount: 2,
        afterCount: 2,
        assistantMessagePresent: true,
        generatedNewAssistant: false,
        outcome: 'already_present',
        bootstrapImportedAt: '2026-09-29T03:36:38.675Z',
        error: '',
      });
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({ baseUrl: 'https://st.example.test', fetchImpl });
  const report = await client.getNemoClientGenerationStatus('NEW_MARKER');
  assert.deepEqual(report, {
    available: false,
    stale: true,
    expectedMarker: 'NEW_MARKER',
    reportMarker: 'OLD_MARKER',
  });
});

test('client generation report exposes whether a new assistant was actually generated', () => {
  assert.deepEqual(
    sanitizeNemoClientGenerationReport({
      ok: true,
      requestId: 'req-456',
      generatedAt: '2026-09-29T03:40:00.000Z',
      preset: 'Nemo Engine 11.5.2 - Ready RU Gooner RP',
      avatarUrl: 'default_Seraphina.png',
      fileName: 'Nemo mobile test',
      marker: 'SAFE_MARKER',
      beforeCount: 4,
      afterCount: 5,
      assistantMessagePresent: true,
      generatedNewAssistant: true,
      outcome: 'generated',
      bootstrapImportedAt: '2026-09-29T03:39:50.000Z',
      error: '',
    }),
    {
      ok: true,
      requestId: 'req-456',
      generatedAt: '2026-09-29T03:40:00.000Z',
      preset: 'Nemo Engine 11.5.2 - Ready RU Gooner RP',
      avatarUrl: 'default_Seraphina.png',
      fileName: 'Nemo mobile test',
      marker: 'SAFE_MARKER',
      beforeCount: 4,
      afterCount: 5,
      assistantMessagePresent: true,
      generatedNewAssistant: true,
      outcome: 'generated',
      bootstrapImportedAt: '2026-09-29T03:39:50.000Z',
      error: '',
    },
  );
});


test('client-generation-status carries expected marker through the mobile route', async () => {
  const route = classifyMobileRestRequest(
    '/st-secret/mobile/client-generation-status?marker=SAFE_MARKER',
    '/st-secret/mobile',
  );
  assert.deepEqual(route, {
    kind: 'client_generation_status',
    marker: 'SAFE_MARKER',
  });

  let received = null;
  const client = {
    async getNemoClientGenerationStatus(marker) {
      received = marker;
      return { available: false, stale: true, expectedMarker: marker, reportMarker: 'OLD' };
    },
  };
  const result = await executeMobileRestRoute(route, client);
  assert.equal(received, 'SAFE_MARKER');
  assert.deepEqual(result, {
    available: false,
    stale: true,
    expectedMarker: 'SAFE_MARKER',
    reportMarker: 'OLD',
  });
});


test('client creates a character card through the current SillyTavern create endpoint', async () => {
  let createBody = null;
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-create-character' });
    if (path === '/api/characters/get') {
      return makeJsonResponse({ error: 'not found' }, { status: 404 });
    }
    if (path === '/api/characters/create') {
      createBody = JSON.parse(options.body);
      return makeJsonResponse('Darya.png');
    }
    throw new Error('unexpected URL: ' + url);
  };

  const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Darya',
      description: 'Darya voice',
      personality: 'sharp and evidence-led',
      scenario: 'private adult roleplay',
      first_mes: 'Говори.',
      mes_example: '',
      creator_notes: 'Darya canonical card',
      system_prompt: 'Stay in Darya voice.',
      post_history_instructions: 'Keep role facts grounded.',
      tags: ['darya', 'nemo'],
      creator: 'producesplatinum-ai',
      character_version: '1.0',
      alternate_greetings: [],
      extensions: {
        talkativeness: 0.7,
        fav: true,
        world: 'Darya',
        depth_prompt: {
          prompt: 'DARYA_DEPTH_PROMPT',
          depth: 4,
          role: 'system',
        },
        custom_marker: 'preserve-me',
      },
    },
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });
  const result = await client.createCharacter({ card, fileName: 'Darya' });

  assert.deepEqual(result, {
    ok: true,
    avatarUrl: 'Darya.png',
    characterName: 'Darya',
  });
  assert.equal(createBody.ch_name, 'Darya');
  assert.equal(createBody.file_name, 'Darya');
  assert.equal(createBody.description, 'Darya voice');
  assert.equal(createBody.system_prompt, 'Stay in Darya voice.');
  assert.equal(createBody.post_history_instructions, 'Keep role facts grounded.');
  assert.deepEqual(createBody.tags, ['darya', 'nemo']);
  assert.equal(createBody.talkativeness, 0.7);
  assert.equal(createBody.fav, 'true');
  assert.equal(createBody.world, 'Darya');
  assert.equal(createBody.depth_prompt_prompt, 'DARYA_DEPTH_PROMPT');
  assert.equal(createBody.depth_prompt_depth, 4);
  assert.equal(createBody.depth_prompt_role, 'system');
  assert.deepEqual(JSON.parse(createBody.extensions), {
    talkativeness: 0.7,
    fav: true,
    world: 'Darya',
    depth_prompt: {
      prompt: 'DARYA_DEPTH_PROMPT',
      depth: 4,
      role: 'system',
    },
    custom_marker: 'preserve-me',
  });
  assert.equal(createBody.json_data, JSON.stringify(card));
});

test('browser form parser carries character card JSON without altering it', () => {
  const cardJson = JSON.stringify({
    spec: 'chara_card_v3',
    data: { name: 'Darya' },
  });
  const encoded = new URLSearchParams({
    fileName: 'Darya',
    cardJson,
  }).toString();
  const parsed = parseMobileWriteBody(
    'application/x-www-form-urlencoded',
    encoded,
  );

  assert.equal(parsed.fileName, 'Darya');
  assert.equal(parsed.cardJson, cardJson);
});


test('Darya import gateway auth requires exact sufficiently long token', () => {
  const token = 'abc123456789def0';
  assert.equal(isDaryaImportAuthorized(token, token), true);
  assert.equal(isDaryaImportAuthorized('wrong', token), false);
  assert.equal(isDaryaImportAuthorized('', token), false);
  assert.equal(isDaryaImportAuthorized(token, ''), false);
});

test('client forwards one Darya source file as raw bytes through protected importer', async () => {
  const body = Buffer.from('darya source bytes');
  const sha256 = 'a'.repeat(64);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/csrf-token')) {
      return makeJsonResponse({ token: 'csrf-import' });
    }

    assert.equal(
      String(url),
      'https://st.example.test/api/plugins/darya-source-import/file',
    );
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['x-csrf-token'], 'csrf-import');
    assert.equal(options.headers['x-darya-import-token'], 'abc123456789def0');
    assert.equal(options.headers['x-darya-path'], 'references/darya-core.md');
    assert.equal(options.headers['x-darya-sha256'], sha256);
    assert.equal(options.headers['content-type'], 'application/octet-stream');
    assert.equal(Buffer.isBuffer(options.body), true);
    assert.equal(options.body.equals(body), true);

    return makeJsonResponse({
      ok: true,
      path: 'references/darya-core.md',
      size: body.length,
      sha256,
    });
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });

  const result = await client.importDaryaSourceFile({
    relativePath: 'references/darya-core.md',
    sha256,
    body,
    token: 'abc123456789def0',
  });

  assert.equal(result.ok, true);
  assert.equal(result.path, 'references/darya-core.md');
  assert.equal(calls.length, 2);
});


test('client deletes a Chat Completion preset and switches away first when it is active', async () => {
  const calls = [];
  const settings = {
    oai_settings: {
      preset_settings_openai: 'Nemo Exact Active',
      temp_openai: 0.5,
    },
  };
  const fallbackPreset = {
    temperature: 0.8,
    prompts: [{ identifier: 'fallback' }],
    prompt_order: [{ character_id: 100001, order: [] }],
  };

  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-delete-preset' });
    if (path === '/api/settings/get') {
      return makeJsonResponse({
        settings: JSON.stringify(settings),
        openai_setting_names: [
          'Nemo Exact Active',
          'Nemo Engine 11.5.2 - Ready RU Gooner RP',
        ],
        openai_settings: [
          JSON.stringify({ temperature: 0.1 }),
          JSON.stringify(fallbackPreset),
        ],
      });
    }
    if (path === '/api/settings/save') return makeJsonResponse({ ok: true });
    if (path === '/api/presets/delete') return makeJsonResponse({ ok: true });
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });

  const result = await client.deleteOpenAiPreset({
    name: 'Nemo Exact Active',
    fallbackName: 'Nemo Engine 11.5.2 - Ready RU Gooner RP',
  });

  assert.deepEqual(result, {
    ok: true,
    deleted: 'Nemo Exact Active',
    fallbackApplied: 'Nemo Engine 11.5.2 - Ready RU Gooner RP',
  });

  const saveCall = calls.find((item) => item.path === '/api/settings/save');
  assert(saveCall);
  assert.equal(
    saveCall.body.oai_settings.preset_settings_openai,
    'Nemo Engine 11.5.2 - Ready RU Gooner RP',
  );
  assert.equal(saveCall.body.oai_settings.temp_openai, 0.8);

  const deleteCall = calls.find((item) => item.path === '/api/presets/delete');
  assert.deepEqual(deleteCall.body, {
    apiId: 'openai',
    name: 'Nemo Exact Active',
  });
});

test('client deletes an inactive Chat Completion preset without rewriting settings', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-delete-inactive' });
    if (path === '/api/settings/get') {
      return makeJsonResponse({
        settings: JSON.stringify({
          oai_settings: { preset_settings_openai: 'Nemo Engine 11.5.2 - Ready RU Gooner RP' },
        }),
        openai_setting_names: ['Darya Custom'],
        openai_settings: [JSON.stringify({ temperature: 0.7 })],
      });
    }
    if (path === '/api/presets/delete') return makeJsonResponse({ ok: true });
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });

  const result = await client.deleteOpenAiPreset({
    name: 'Darya Custom',
    fallbackName: 'Nemo Engine 11.5.2 - Ready RU Gooner RP',
  });

  assert.deepEqual(result, {
    ok: true,
    deleted: 'Darya Custom',
    fallbackApplied: '',
  });
  assert.equal(calls.some((item) => item.path === '/api/settings/save'), false);
});

test('exact activation never retries an ambiguous settings mutation and recovers by read-only verification', async () => {
  let savedPreset = null;
  let attemptedSettings = null;
  let settingsGetCalls = 0;
  let settingsSaveCalls = 0;
  let csrfCalls = 0;

  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') {
      csrfCalls += 1;
      return makeJsonResponse({ token: 'csrf-' + csrfCalls });
    }
    if (path === '/api/presets/save') {
      const body = JSON.parse(options.body);
      savedPreset = body.preset;
      return makeJsonResponse({ name: 'Nemo Exact Active' });
    }
    if (path === '/api/settings/get') {
      settingsGetCalls += 1;
      if (settingsGetCalls === 1) {
        return makeJsonResponse({
          settings: JSON.stringify({
            oai_settings: {
              preset_settings_openai: 'Nemo Engine 11.5.2 - Ready RU RP',
              temp_openai: 0.7,
            },
          }),
          openai_setting_names: [],
          openai_settings: [],
        });
      }
      return makeJsonResponse({
        settings: JSON.stringify(attemptedSettings),
        openai_setting_names: ['Nemo Exact Active'],
        openai_settings: [JSON.stringify(savedPreset)],
      });
    }
    if (path === '/api/settings/save') {
      settingsSaveCalls += 1;
      attemptedSettings = JSON.parse(options.body);
      throw new TypeError('fetch failed');
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });

  const result = await client.activateExactNemoCatalogEntry(
    'overlay-fetish-v11-639-fetish-humiliation',
  );

  assert.equal(settingsSaveCalls, 1, 'ambiguous settings mutation must never be retried');
  assert.ok(csrfCalls >= 2, 'session should be re-bootstrapped after a restart');
  assert.equal(result.storedPresetExact, true);
  assert.equal(result.activeSettingsExact, true);
  assert.equal(result.recoveredAfterRestart, true);
});

test('serial task queue runs concurrent mutations in FIFO order and recovers after failure', async () => {
  const enqueue = createSerialTaskQueue();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = enqueue(async () => {
    events.push('first:start');
    await firstGate;
    events.push('first:end');
    return 'first-result';
  });
  const second = enqueue(async () => {
    events.push('second:start');
    events.push('second:end');
    return 'second-result';
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first:start']);

  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [
    'first-result',
    'second-result',
  ]);
  assert.deepEqual(events, [
    'first:start',
    'first:end',
    'second:start',
    'second:end',
  ]);

  await assert.rejects(
    () => enqueue(async () => {
      events.push('third:start');
      throw new Error('intentional queue failure');
    }),
    /intentional queue failure/,
  );

  const fourth = await enqueue(async () => {
    events.push('fourth:start');
    return 'fourth-result';
  });
  assert.equal(fourth, 'fourth-result');
  assert.deepEqual(events.slice(-2), ['third:start', 'fourth:start']);
});

test('client updates a character through native edit while preserving chat metadata', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-update-character' });
    if (path === '/api/characters/get') {
      calls.push({ path, body: JSON.parse(options.body) });
      return makeJsonResponse({
        name: 'Mobile CRUD Probe',
        avatar: 'Mobile CRUD Probe.png',
        chat: 'existing-chat',
        create_date: '2026-10-01T12:00:00.000Z',
      });
    }
    if (path === '/api/characters/edit') {
      calls.push({ path, body: JSON.parse(options.body) });
      return new Response('', { status: 200 });
    }
    throw new Error('unexpected URL: ' + url);
  };

  const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Mobile CRUD Probe',
      description: 'updated description',
      personality: 'updated personality',
      scenario: 'updated scenario',
      first_mes: 'Updated hello',
      mes_example: '<START>\nProbe: example',
      system_prompt: 'Updated system prompt.',
      post_history_instructions: 'Updated post-history.',
      tags: ['probe'],
      alternate_greetings: ['Alt hello'],
      extensions: {
        talkativeness: 0.65,
        fav: true,
        world: 'ProbeWorld',
        depth_prompt: { prompt: 'PROBE_DEPTH', depth: 3, role: 'system' },
        custom_marker: 'keep-this',
      },
    },
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });
  const result = await client.updateCharacter({
    avatarUrl: 'Mobile CRUD Probe.png',
    card,
  });

  assert.deepEqual(result, {
    ok: true,
    avatarUrl: 'Mobile CRUD Probe.png',
    characterName: 'Mobile CRUD Probe',
  });

  const edit = calls.find(x => x.path === '/api/characters/edit');
  assert(edit);
  assert.equal(edit.body.avatar_url, 'Mobile CRUD Probe.png');
  assert.equal(edit.body.ch_name, 'Mobile CRUD Probe');
  assert.equal(edit.body.description, 'updated description');
  assert.equal(edit.body.chat, 'existing-chat');
  assert.equal(edit.body.create_date, '2026-10-01T12:00:00.000Z');
  assert.equal(edit.body.fav, 'true');
  assert.equal(edit.body.world, 'ProbeWorld');
  assert.equal(edit.body.depth_prompt_prompt, 'PROBE_DEPTH');
  assert.equal(edit.body.depth_prompt_depth, 3);
  assert.equal(edit.body.depth_prompt_role, 'system');
  assert.equal(edit.body.json_data, JSON.stringify(card));
});

test('client deletes a character through native delete without chats by default', async () => {
  let deleteBody = null;
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-delete-character' });
    if (path === '/api/characters/get') {
      return makeJsonResponse({
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: { name: 'Mobile CRUD Probe' },
        avatar: 'Mobile CRUD Probe.png',
      });
    }
    if (path === '/api/characters/delete') {
      deleteBody = JSON.parse(options.body);
      return new Response('', { status: 200 });
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });
  const result = await client.deleteCharacter({
    avatarUrl: 'Mobile CRUD Probe.png',
    deleteChats: false,
  });

  assert.deepEqual(deleteBody, {
    avatar_url: 'Mobile CRUD Probe.png',
    delete_chats: false,
  });
  assert.deepEqual(result, {
    ok: true,
    deleted: true,
    avatarUrl: 'Mobile CRUD Probe.png',
    deleteChats: false,
  });
});

test('character create deduplicates an identical deterministic file instead of writing twice', async () => {
  let createCalls = 0;
  const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Deterministic Probe',
      description: 'same card',
      extensions: { talkativeness: 0.5 },
    },
  };
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-create-dedupe' });
    if (path === '/api/characters/get') {
      return makeJsonResponse({
        ...card,
        avatar: 'Deterministic Probe.png',
        chat: 'existing-chat',
        create_date: '2026-10-01T12:00:00.000Z',
      });
    }
    if (path === '/api/characters/create') {
      createCalls += 1;
      return makeJsonResponse('Deterministic Probe.png');
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });
  const result = await client.createCharacter({
    card,
    fileName: 'Deterministic Probe',
  });

  assert.equal(createCalls, 0);
  assert.deepEqual(result, {
    ok: true,
    avatarUrl: 'Deterministic Probe.png',
    characterName: 'Deterministic Probe',
    deduplicated: true,
  });
});

test('character create refuses to overwrite a deterministic file with different card data', async () => {
  const requested = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: { name: 'Deterministic Probe', description: 'new data' },
  };
  const existing = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: { name: 'Deterministic Probe', description: 'existing data' },
  };
  const fetchImpl = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-create-conflict' });
    if (path === '/api/characters/get') return makeJsonResponse(existing);
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });

  await assert.rejects(
    () => client.createCharacter({ card: requested, fileName: 'Deterministic Probe' }),
    /already exists with different data.*character_update/i,
  );
});

test('character update deduplicates when requested card data is already stored', async () => {
  let editCalls = 0;
  const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Update Probe',
      description: 'already current',
      extensions: { crud_probe: 'same' },
    },
  };
  const fetchImpl = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-update-dedupe' });
    if (path === '/api/characters/get') return makeJsonResponse({
      ...card,
      avatar: 'Update Probe.png',
      chat: 'existing-chat',
      create_date: '2026-10-01T12:00:00.000Z',
    });
    if (path === '/api/characters/edit') {
      editCalls += 1;
      return new Response('', { status: 200 });
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });
  const result = await client.updateCharacter({
    avatarUrl: 'Update Probe.png',
    card,
  });

  assert.equal(editCalls, 0);
  assert.equal(result.deduplicated, true);
});

test('character delete treats an already absent target as a successful final state', async () => {
  let deleteCalls = 0;
  const fetchImpl = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-delete-absent' });
    if (path === '/api/characters/get') {
      return makeJsonResponse({ error: 'missing' }, { status: 404 });
    }
    if (path === '/api/characters/delete') {
      deleteCalls += 1;
      return new Response('', { status: 200 });
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });
  const result = await client.deleteCharacter({
    avatarUrl: 'Already Gone.png',
    deleteChats: false,
  });

  assert.equal(deleteCalls, 0);
  assert.deepEqual(result, {
    ok: true,
    deleted: false,
    deduplicated: true,
    alreadyAbsent: true,
    avatarUrl: 'Already Gone.png',
    deleteChats: false,
  });
});

test('client duplicates a stored V3 character while changing only identity and target file', async () => {
  let createBody = null;
  const stored = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Darya',
      description: 'canonical description',
      personality: 'sharp',
      scenario: 'canonical scenario',
      first_mes: 'Hello',
      mes_example: '<START>\\nDarya: example',
      creator_notes: 'notes',
      system_prompt: 'system',
      post_history_instructions: 'post-history',
      tags: ['darya'],
      creator: 'producesplatinum-ai',
      character_version: '9.9',
      alternate_greetings: ['Alt'],
      extensions: {
        talkativeness: 0.73,
        fav: true,
        world: 'DaryaWorld',
        depth_prompt: { prompt: 'DEPTH', depth: 3, role: 'system' },
        custom_marker: 'preserve-me',
      },
      character_book: {
        name: 'Darya Book',
        entries: [{ id: 1, keys: ['key'], content: 'book content' }],
      },
    },
    avatar: 'Darya.png',
    chat: 'Darya - old chat',
    create_date: '2026-09-01T00:00:00.000Z',
    date_added: 123,
    chat_size: 456,
    data_size: 789,
  };

  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-duplicate' });
    if (path === '/api/characters/get') {
      const body = JSON.parse(options.body);
      if (body.avatar_url === 'Darya.png') return makeJsonResponse(stored);
      if (body.avatar_url === 'Darya Copy.png') {
        return makeJsonResponse({ error: 'not found' }, { status: 404 });
      }
    }
    if (path === '/api/characters/create') {
      createBody = JSON.parse(options.body);
      return makeJsonResponse('Darya Copy.png');
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });
  const result = await client.duplicateCharacter({
    avatarUrl: 'Darya.png',
    newName: 'Darya Copy',
    fileName: 'Darya Copy',
  });

  assert.deepEqual(result, {
    ok: true,
    sourceAvatarUrl: 'Darya.png',
    avatarUrl: 'Darya Copy.png',
    characterName: 'Darya Copy',
  });
  assert.equal(createBody.file_name, 'Darya Copy');
  assert.equal(createBody.ch_name, 'Darya Copy');

  const duplicated = JSON.parse(createBody.json_data);
  assert.equal(duplicated.spec, 'chara_card_v3');
  assert.equal(duplicated.spec_version, '3.0');
  assert.equal(duplicated.data.name, 'Darya Copy');
  assert.equal(duplicated.data.description, 'canonical description');
  assert.equal(duplicated.data.system_prompt, 'system');
  assert.equal(duplicated.data.extensions.custom_marker, 'preserve-me');
  assert.deepEqual(duplicated.data.character_book, stored.data.character_book);
  assert.equal(duplicated.avatar, undefined);
  assert.equal(duplicated.chat, undefined);
  assert.equal(duplicated.create_date, undefined);
  assert.equal(duplicated.date_added, undefined);
  assert.equal(duplicated.chat_size, undefined);
  assert.equal(duplicated.data_size, undefined);
});

test('character duplicate is idempotent through deterministic create semantics', async () => {
  let createCalls = 0;
  const source = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Darya',
      description: 'same',
      extensions: { custom_marker: 'same' },
    },
  };
  const existingTarget = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Darya Copy',
      description: 'same',
      extensions: { custom_marker: 'same' },
    },
  };

  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-duplicate-dedupe' });
    if (path === '/api/characters/get') {
      const body = JSON.parse(options.body);
      if (body.avatar_url === 'Darya.png') return makeJsonResponse(source);
      if (body.avatar_url === 'Darya Copy.png') return makeJsonResponse(existingTarget);
    }
    if (path === '/api/characters/create') {
      createCalls += 1;
      return makeJsonResponse('Darya Copy.png');
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });
  const result = await client.duplicateCharacter({
    avatarUrl: 'Darya.png',
    newName: 'Darya Copy',
    fileName: 'Darya Copy',
  });

  assert.equal(createCalls, 0);
  assert.equal(result.deduplicated, true);
  assert.equal(result.avatarUrl, 'Darya Copy.png');
  assert.equal(result.sourceAvatarUrl, 'Darya.png');
});

test('client renames a character through native rename and verifies the new card', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-rename' });
    if (path === '/api/characters/all') {
      return makeJsonResponse([
        {
          spec: 'chara_card_v3',
          spec_version: '3.0',
          data: { name: 'Old Name' },
          avatar: 'Old Name.png',
        },
      ]);
    }
    if (path === '/api/characters/get') {
      const body = JSON.parse(options.body);
      if (body.avatar_url === 'Old Name.png') {
        return makeJsonResponse({
          spec: 'chara_card_v3',
          spec_version: '3.0',
          data: { name: 'Old Name', description: 'keep me' },
          avatar: 'Old Name.png',
          chat: 'Old Name - chat',
        });
      }
      if (body.avatar_url === 'New Name.png') {
        return makeJsonResponse({
          spec: 'chara_card_v3',
          spec_version: '3.0',
          data: { name: 'New Name', description: 'keep me' },
          avatar: 'New Name.png',
          chat: 'Old Name - chat',
        });
      }
    }
    if (path === '/api/characters/rename') {
      calls.push(JSON.parse(options.body));
      return makeJsonResponse({ avatar: 'New Name.png' });
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });
  const result = await client.renameCharacter({
    avatarUrl: 'Old Name.png',
    newName: 'New Name',
  });

  assert.deepEqual(calls, [{ avatar_url: 'Old Name.png', new_name: 'New Name' }]);
  assert.deepEqual(result, {
    ok: true,
    oldAvatarUrl: 'Old Name.png',
    avatarUrl: 'New Name.png',
    characterName: 'New Name',
  });
});

test('character rename deduplicates after a concurrent rename already reached the target state', async () => {
  let renameCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-rename-dedupe' });
    if (path === '/api/characters/get') {
      const body = JSON.parse(options.body);
      if (body.avatar_url === 'Old Name.png') {
        return makeJsonResponse({ error: 'not found' }, { status: 404 });
      }
    }
    if (path === '/api/characters/all') {
      return makeJsonResponse([
        {
          spec: 'chara_card_v3',
          spec_version: '3.0',
          data: { name: 'New Name', description: 'same' },
          avatar: 'New Name.png',
          name: 'New Name',
        },
      ]);
    }
    if (path === '/api/characters/rename') {
      renameCalls += 1;
      return makeJsonResponse({ avatar: 'New Name.png' });
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });
  const result = await client.renameCharacter({
    avatarUrl: 'Old Name.png',
    newName: 'New Name',
  });

  assert.equal(renameCalls, 0);
  assert.deepEqual(result, {
    ok: true,
    deduplicated: true,
    oldAvatarUrl: 'Old Name.png',
    avatarUrl: 'New Name.png',
    characterName: 'New Name',
  });
});

test('character rename refuses ambiguous already-renamed matches', async () => {
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-rename-ambiguous' });
    if (path === '/api/characters/get') {
      return makeJsonResponse({ error: 'not found' }, { status: 404 });
    }
    if (path === '/api/characters/all') {
      return makeJsonResponse([
        { data: { name: 'New Name' }, avatar: 'New Name.png', name: 'New Name' },
        { data: { name: 'New Name' }, avatar: 'New Name_1.png', name: 'New Name' },
      ]);
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });
  await assert.rejects(
    () => client.renameCharacter({
      avatarUrl: 'Old Name.png',
      newName: 'New Name',
    }),
    /ambiguous/i,
  );
});

test('client renames a native character and returns the new avatar filename', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-rename' });
    if (path === '/api/characters/all') {
      return makeJsonResponse([
        {
          spec: 'chara_card_v3',
          spec_version: '3.0',
          data: { name: 'Old Name' },
          avatar: 'Old Name.png',
        },
      ]);
    }
    if (path === '/api/characters/get') {
      const body = JSON.parse(options.body);
      calls.push({ path, body });
      if (body.avatar_url === 'Old Name.png') {
        return makeJsonResponse({
          spec: 'chara_card_v3',
          spec_version: '3.0',
          data: { name: 'Old Name' },
          avatar: 'Old Name.png',
        });
      }
      if (body.avatar_url === 'New Name.png') {
        return makeJsonResponse({
          spec: 'chara_card_v3',
          spec_version: '3.0',
          data: { name: 'New Name' },
          avatar: 'New Name.png',
        });
      }
    }
    if (path === '/api/characters/rename') {
      calls.push({ path, body: JSON.parse(options.body) });
      return makeJsonResponse({ avatar: 'New Name.png' });
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });
  const result = await client.renameCharacter({
    avatarUrl: 'Old Name.png',
    newName: 'New Name',
  });

  assert.deepEqual(result, {
    ok: true,
    oldAvatarUrl: 'Old Name.png',
    avatarUrl: 'New Name.png',
    characterName: 'New Name',
  });
  const rename = calls.find(x => x.path === '/api/characters/rename');
  assert.deepEqual(rename.body, {
    avatar_url: 'Old Name.png',
    new_name: 'New Name',
  });
});

test('character rename is idempotent when source is absent and exactly one target already exists', async () => {
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-rename-dedupe' });
    if (path === '/api/characters/get') {
      return makeJsonResponse({ error: 'not found' }, { status: 404 });
    }
    if (path === '/api/characters/all') {
      return makeJsonResponse([
        {
          spec: 'chara_card_v3',
          spec_version: '3.0',
          data: { name: 'New Name' },
          avatar: 'New Name.png',
        },
      ]);
    }
    if (path === '/api/characters/rename') {
      throw new Error('rename should not be called');
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });
  const result = await client.renameCharacter({
    avatarUrl: 'Old Name.png',
    newName: 'New Name',
  });

  assert.deepEqual(result, {
    ok: true,
    deduplicated: true,
    oldAvatarUrl: 'Old Name.png',
    avatarUrl: 'New Name.png',
    characterName: 'New Name',
  });
});

test('client exports a character as native JSON and returns parsed card data', async () => {
  let exportBody = null;
  const exported = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Darya',
      description: 'exported description',
      extensions: { custom_marker: 'preserved' },
      character_book: {
        name: 'Darya Book',
        entries: [{ id: 1, keys: ['k'], content: 'c' }],
      },
    },
  };

  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-export-json' });
    if (path === '/api/characters/export') {
      exportBody = JSON.parse(options.body);
      return makeJsonResponse(exported);
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });
  const result = await client.exportCharacterJson('Darya.png');

  assert.deepEqual(exportBody, {
    format: 'json',
    avatar_url: 'Darya.png',
  });
  assert.deepEqual(result, exported);
});

test('client character JSON export rejects a missing avatarUrl before network use', async () => {
  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl: async () => {
      throw new Error('should not be called');
    },
  });

  await assert.rejects(
    () => client.exportCharacterJson(''),
    /avatarUrl is required/,
  );
});

test('client imports exported JSON through deterministic native create semantics', async () => {
  let createBody = null;
  const exported = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Imported Probe',
      description: 'exported description',
      personality: 'exported personality',
      scenario: 'exported scenario',
      first_mes: 'hello',
      mes_example: '<START>\\nImported Probe: example',
      creator_notes: 'notes',
      system_prompt: 'system',
      post_history_instructions: 'post',
      tags: ['imported'],
      creator: 'tester',
      character_version: '2.1',
      alternate_greetings: ['alt'],
      extensions: {
        talkativeness: 0.66,
        fav: true,
        world: 'ImportedWorld',
        depth_prompt: { prompt: 'IMPORT_DEPTH', depth: 3, role: 'system' },
        custom_marker: 'preserve-import',
      },
      character_book: {
        name: 'Imported Book',
        entries: [{ id: 1, keys: ['key'], content: 'content' }],
      },
    },
  };

  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-import-json' });
    if (path === '/api/characters/get') {
      return makeJsonResponse({ error: 'not found' }, { status: 404 });
    }
    if (path === '/api/characters/create') {
      createBody = JSON.parse(options.body);
      return makeJsonResponse('Imported Probe.png');
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });
  const result = await client.importCharacterJson({
    card: exported,
    fileName: 'Imported Probe',
  });

  assert.deepEqual(result, {
    ok: true,
    imported: true,
    avatarUrl: 'Imported Probe.png',
    characterName: 'Imported Probe',
  });
  assert.equal(createBody.file_name, 'Imported Probe');
  assert.equal(createBody.ch_name, 'Imported Probe');
  assert.equal(createBody.description, 'exported description');
  assert.equal(createBody.depth_prompt_prompt, 'IMPORT_DEPTH');

  const stored = JSON.parse(createBody.json_data);
  assert.equal(stored.spec, 'chara_card_v2');
  assert.equal(stored.spec_version, '2.0');
  assert.equal(stored.data.extensions.custom_marker, 'preserve-import');
  assert.deepEqual(stored.data.character_book, exported.data.character_book);
});

test('character JSON import inherits create idempotency', async () => {
  let createCalls = 0;
  const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: { name: 'Import Dedupe', description: 'same data' },
  };

  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-import-dedupe' });
    if (path === '/api/characters/get') return makeJsonResponse({
      ...card,
      avatar: 'Import Dedupe.png',
    });
    if (path === '/api/characters/create') {
      createCalls += 1;
      return makeJsonResponse('Import Dedupe.png');
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });
  const result = await client.importCharacterJson({
    card,
    fileName: 'Import Dedupe',
  });

  assert.equal(createCalls, 0);
  assert.equal(result.imported, true);
  assert.equal(result.deduplicated, true);
  assert.equal(result.avatarUrl, 'Import Dedupe.png');
});

test('client creates a lorebook without overwriting an existing different book', async () => {
  const imports = [];
  let listMode = 'absent';
  let stored = null;
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-wi-create' });
    if (path === '/api/worldinfo/list') {
      return makeJsonResponse(listMode === 'absent' ? [] : [{ name: 'Probe World', file_id: 'Probe World' }]);
    }
    if (path === '/api/worldinfo/get') {
      return makeJsonResponse(stored || { entries: { 0: { uid: 0, content: 'existing' } } });
    }
    if (path === '/api/worldinfo/import') {
      assert(options.body instanceof FormData);
      const convertedData = String(options.body.get('convertedData') || '');
      imports.push(JSON.parse(convertedData));
      stored = JSON.parse(convertedData);
      listMode = 'present';
      return makeJsonResponse({ name: 'Probe World' });
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({ baseUrl: 'https://st.example.test', fetchImpl });
  const created = await client.createWorldInfo({
    name: 'Probe World',
    data: { entries: {} },
  });
  assert.equal(created.created, true);
  assert.deepEqual(imports, [{ entries: {} }]);

  stored = { entries: { 0: { uid: 0, content: 'existing' } } };
  await assert.rejects(
    () => client.createWorldInfo({
      name: 'Probe World',
      data: { entries: {} },
    }),
    /already exists with different data.*world_info_update/i,
  );
});

test('client treats identical lorebook create/update as deduplicated and updates changed data', async () => {
  const edits = [];
  let stored = { entries: { 0: { uid: 0, content: 'same' } } };
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-wi-upsert' });
    if (path === '/api/worldinfo/list') return makeJsonResponse([{ name: 'Probe', file_id: 'Probe' }]);
    if (path === '/api/worldinfo/get') return makeJsonResponse(stored);
    if (path === '/api/worldinfo/edit') {
      const body = JSON.parse(options.body);
      edits.push(body);
      stored = body.data;
      return makeJsonResponse({ ok: true });
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({ baseUrl: 'https://st.example.test', fetchImpl });
  const sameCreate = await client.createWorldInfo({ name: 'Probe', data: stored });
  assert.equal(sameCreate.deduplicated, true);
  const sameUpdate = await client.updateWorldInfo({ name: 'Probe', data: stored });
  assert.equal(sameUpdate.deduplicated, true);
  assert.equal(edits.length, 0);

  const changed = { entries: { 0: { uid: 0, content: 'changed' } } };
  const updated = await client.updateWorldInfo({ name: 'Probe', data: changed });
  assert.equal(updated.updated, true);
  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0], { name: 'Probe', data: changed });
});

test('client upserts and deletes lorebook entries while preserving the rest of the book', async () => {
  let stored = {
    name: 'Probe',
    extensions: { keep: true },
    entries: {
      0: { uid: 0, content: 'keep', key: ['keep'] },
      7: { uid: 7, content: 'old', key: ['old'] },
    },
  };
  const edits = [];
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-wi-entry' });
    if (path === '/api/worldinfo/list') return makeJsonResponse([{ name: 'Probe', file_id: 'Probe' }]);
    if (path === '/api/worldinfo/get') return makeJsonResponse(stored);
    if (path === '/api/worldinfo/edit') {
      const body = JSON.parse(options.body);
      edits.push(body);
      stored = body.data;
      return makeJsonResponse({ ok: true });
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({ baseUrl: 'https://st.example.test', fetchImpl });
  const upserted = await client.upsertWorldInfoEntry({
    name: 'Probe',
    uid: 7,
    entry: { content: 'new', key: ['new'], constant: true },
  });
  assert.equal(upserted.uid, 7);
  assert.equal(upserted.updated, true);
  assert.equal(stored.extensions.keep, true);
  assert.equal(stored.entries[0].content, 'keep');
  assert.deepEqual(stored.entries[7], {
    uid: 7,
    content: 'new',
    key: ['new'],
    constant: true,
  });

  const deleted = await client.deleteWorldInfoEntry({ name: 'Probe', uid: 7 });
  assert.equal(deleted.deleted, true);
  assert.equal(stored.entries[7], undefined);
  assert.equal(stored.entries[0].content, 'keep');
  assert.equal(edits.length, 2);

  const absent = await client.deleteWorldInfoEntry({ name: 'Probe', uid: 7 });
  assert.equal(absent.deduplicated, true);
  assert.equal(absent.alreadyAbsent, true);
  assert.equal(edits.length, 2);
});

test('client deletes lorebooks idempotently', async () => {
  let exists = true;
  let deletes = 0;
  const fetchImpl = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-wi-delete' });
    if (path === '/api/worldinfo/list') {
      return makeJsonResponse(exists ? [{ name: 'Probe', file_id: 'Probe' }] : []);
    }
    if (path === '/api/worldinfo/delete') {
      deletes += 1;
      exists = false;
      return new Response('', { status: 200 });
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({ baseUrl: 'https://st.example.test', fetchImpl });
  const first = await client.deleteWorldInfo({ name: 'Probe' });
  assert.equal(first.deleted, true);
  const second = await client.deleteWorldInfo({ name: 'Probe' });
  assert.equal(second.deduplicated, true);
  assert.equal(second.alreadyAbsent, true);
  assert.equal(deletes, 1);
});

test('client saves world info with state idempotency', async () => {
  let editCalls = 0;
  const data = { entries: { 0: { uid: 0, key: ['probe'], content: 'WORLD_PROBE' } } };

  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-world-save' });
    if (path === '/api/worldinfo/list') {
      return makeJsonResponse([{ file_id: 'Probe Lore', name: 'Probe Lore', extensions: {} }]);
    }
    if (path === '/api/worldinfo/get') {
      return makeJsonResponse(data);
    }
    if (path === '/api/worldinfo/edit') {
      editCalls += 1;
      return makeJsonResponse({ ok: true });
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });
  const result = await client.saveWorldInfo({ name: 'Probe Lore', data });

  assert.equal(editCalls, 0);
  assert.deepEqual(result, {
    ok: true,
    name: 'Probe Lore',
    deduplicated: true,
  });
});

test('client writes changed world info through native edit', async () => {
  let editBody = null;
  const existing = { entries: { 0: { uid: 0, key: ['probe'], content: 'OLD' } } };
  const data = { entries: { 0: { uid: 0, key: ['probe'], content: 'NEW' } } };

  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-world-save-change' });
    if (path === '/api/worldinfo/list') {
      return makeJsonResponse([{ file_id: 'Probe Lore', name: 'Probe Lore', extensions: {} }]);
    }
    if (path === '/api/worldinfo/get') return makeJsonResponse(existing);
    if (path === '/api/worldinfo/edit') {
      editBody = JSON.parse(options.body);
      return makeJsonResponse({ ok: true });
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });
  const result = await client.saveWorldInfo({ name: 'Probe Lore', data });

  assert.deepEqual(editBody, { name: 'Probe Lore', data });
  assert.deepEqual(result, { ok: true, name: 'Probe Lore', saved: true });
});

test('client deletes world info idempotently', async () => {
  let deleteCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-world-delete' });
    if (path === '/api/worldinfo/list') return makeJsonResponse([]);
    if (path === '/api/worldinfo/delete') {
      deleteCalls += 1;
      return new Response('', { status: 200 });
    }
    throw new Error('unexpected URL: ' + url);
  };

  const client = new SillyTavernClient({
    baseUrl: 'https://st.example.test',
    fetchImpl,
  });
  const result = await client.deleteWorldInfo({ name: 'Probe Lore' });

  assert.equal(deleteCalls, 0);
  assert.deepEqual(result, {
    ok: true,
    deleted: false,
    deduplicated: true,
    alreadyAbsent: true,
    name: 'Probe Lore',
  });
});

test('client creates a missing lorebook through native multipart import and verifies persistence', async () => {
  let importedName = '';
  let stored = null;
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/csrf-token') return makeJsonResponse({ token: 'csrf-wi-import-create' });
    if (path === '/api/worldinfo/list') {
      return makeJsonResponse(
        stored ? [{ name: importedName, file_id: importedName, extensions: stored.extensions || {} }] : [],
      );
    }
    if (path === '/api/worldinfo/get') {
      return makeJsonResponse(stored || { entries: {} });
    }
    if (path === '/api/worldinfo/import') {
      assert.equal(options.method, 'POST');
      assert(options.body instanceof FormData);
      const file = options.body.get('avatar');
      const convertedData = options.body.get('convertedData');
      assert.equal(options.body.get('file'), null);
      assert(file);
      assert.equal(file.name, 'Probe World.json');
      assert.equal(await file.text(), JSON.stringify({
        name: 'Probe World',
        extensions: { marker: 'persist-me' },
        entries: { 0: { uid: 0, key: ['probe'], content: 'PERSIST_ME' } },
      }, null, 4));
      assert.equal(convertedData, await file.text());
      stored = JSON.parse(String(convertedData));
      importedName = 'Probe World';
      return makeJsonResponse({ name: 'Probe World' });
    }
    if (path === '/api/worldinfo/edit') {
      throw new Error('create must not use /api/worldinfo/edit for a missing lorebook');
    }
    throw new Error('unexpected URL: ' + url);
  };

  const data = {
    name: 'Probe World',
    extensions: { marker: 'persist-me' },
    entries: { 0: { uid: 0, key: ['probe'], content: 'PERSIST_ME' } },
  };
  const client = new SillyTavernClient({ baseUrl: 'https://st.example.test', fetchImpl });
  const result = await client.createWorldInfo({ name: 'Probe World', data });

  assert.deepEqual(result, { ok: true, name: 'Probe World', created: true });
  assert.deepEqual(stored, data);
});

