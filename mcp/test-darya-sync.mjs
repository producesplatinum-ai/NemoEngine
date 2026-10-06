import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DARYA_ROUTES,
  createDaryaGitHubClient,
  normalizeDaryaEndpointPath,
  safeBearerMatches,
} from './darya-sync.mjs';

test('Darya general route is the canonical speech base', () => {
  assert.deepEqual(DARYA_ROUTES.general, [
    'references/darya-core.md',
    'references/darya-speech-transfer.md',
  ]);
});

test('Darya endpoint must be an absolute MCP path', () => {
  assert.equal(
    normalizeDaryaEndpointPath('/native-darya/mcp'),
    '/native-darya/mcp',
  );
  assert.throws(() => normalizeDaryaEndpointPath('native-darya/mcp'));
  assert.throws(() => normalizeDaryaEndpointPath('/native-darya'));
  assert.throws(() => normalizeDaryaEndpointPath('/native-darya/mcp?x=1'));
});

test('bearer token comparison accepts only exact token bytes', () => {
  assert.equal(safeBearerMatches('Bearer abc123', 'abc123'), true);
  assert.equal(safeBearerMatches('Bearer abc124', 'abc123'), false);
  assert.equal(safeBearerMatches('abc123', 'abc123'), false);
  assert.equal(safeBearerMatches('', 'abc123'), false);
});

test('GitHub client reads current revision and decodes private file content', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/branches/main')) {
      return new Response(JSON.stringify({ commit: { sha: 'rev-123' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (String(url).includes('/contents/references%2Fdarya-core.md')) {
      return new Response(JSON.stringify({
        type: 'file',
        sha: 'blob-456',
        content: Buffer.from('hello Darya', 'utf8').toString('base64'),
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response('not found', { status: 404 });
  };

  const client = createDaryaGitHubClient({
    token: 'secret',
    fetchFn: fakeFetch,
  });

  assert.equal(await client.currentRevision(), 'rev-123');
  assert.deepEqual(
    await client.readFile('references/darya-core.md'),
    {
      path: 'references/darya-core.md',
      sha: 'blob-456',
      text: 'hello Darya',
      bytes: 11,
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
});
