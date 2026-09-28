import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SillyTavernClient,
  normalizeBaseUrl,
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
