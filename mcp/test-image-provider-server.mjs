import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IMAGE_PROVIDERS,
  IdeogramClient,
  buildLeonardoProxyRequest,
  imageProviderFromEndpointPath,
} from './image-provider-core.mjs';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

test('image provider registry exposes Leonardo and Ideogram without embedding secrets', () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(IMAGE_PROVIDERS).map(([id, cfg]) => [
        id,
        {
          envKey: cfg.envKey,
          baseUrl: cfg.baseUrl,
          defaultModel: cfg.defaultModel,
        },
      ]),
    ),
    {
      leonardo: {
        envKey: 'LEONARDO_API_KEY',
        baseUrl: 'https://mcp.leonardo.ai/v1/mcp',
        defaultModel: 'lucid-origin',
      },
      ideogram: {
        envKey: 'IDEOGRAM_API_KEY',
        baseUrl: 'https://api.ideogram.ai',
        defaultModel: 'ideogram-v4',
      },
    },
  );
});

test('image provider endpoint path selects Leonardo or Ideogram under the existing prefix', () => {
  assert.equal(
    imageProviderFromEndpointPath('/ai-secret/leonardo/mcp', '/ai-secret'),
    'leonardo',
  );
  assert.equal(
    imageProviderFromEndpointPath('/ai-secret/ideogram/mcp', '/ai-secret'),
    'ideogram',
  );
  assert.equal(imageProviderFromEndpointPath('/ai-secret/recraft/mcp', '/ai-secret'), null);
  assert.equal(imageProviderFromEndpointPath('/leonardo/mcp', '/ai-secret'), null);
});

test('Ideogram client sends a v4 multipart request and never exposes the API key', async () => {
  const calls = [];
  const client = new IdeogramClient({
    apiKey: 'secret-ideogram-key',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        created: '2026-09-30T00:00:00Z',
        data: [
          {
            prompt: 'A chrome robot on a rainy Berlin street',
            resolution: '1024x1024',
            url: 'https://example.test/generated.png',
          },
        ],
      });
    },
  });

  const result = await client.generate({
    prompt: 'A chrome robot on a rainy Berlin street',
    resolution: '1024x1024',
    renderingSpeed: 'TURBO',
  });

  assert.equal(result.provider, 'ideogram');
  assert.equal(result.model, 'ideogram-v4');
  assert.equal(result.images[0].url, 'https://example.test/generated.png');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.ideogram.ai/v1/ideogram-v4/generate');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Api-Key'], 'secret-ideogram-key');
  assert.equal(calls[0].options.body.get('text_prompt'), 'A chrome robot on a rainy Berlin street');
  assert.equal(calls[0].options.body.get('resolution'), '1024x1024');
  assert.equal(calls[0].options.body.get('rendering_speed'), 'TURBO');
  assert.equal(JSON.stringify(result).includes('secret-ideogram-key'), false);
});

test('Ideogram client refuses generation when its API key is missing', async () => {
  const client = new IdeogramClient({
    apiKey: '',
    fetchImpl: async () => {
      throw new Error('network should not be called');
    },
  });

  await assert.rejects(
    () => client.generate({ prompt: 'test' }),
    /IDEOGRAM_API_KEY.*not configured/i,
  );
});

test('Leonardo proxy injects only the server-side API key and preserves MCP session headers', () => {
  const request = buildLeonardoProxyRequest({
    requestUrl: '/ai-secret/leonardo/mcp?trace=1',
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-session-id': 'session-123',
      authorization: 'Bearer should-not-forward',
      cookie: 'private-cookie=1',
      host: 'local.example',
    },
    body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    apiKey: 'secret-leonardo-key',
  });

  assert.equal(request.url, 'https://mcp.leonardo.ai/v1/mcp?trace=1');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers['API-Key'], 'secret-leonardo-key');
  assert.equal(request.init.headers.accept, 'application/json, text/event-stream');
  assert.equal(request.init.headers['content-type'], 'application/json');
  assert.equal(request.init.headers['mcp-session-id'], 'session-123');
  assert.equal('authorization' in request.init.headers, false);
  assert.equal('cookie' in request.init.headers, false);
  assert.equal('host' in request.init.headers, false);
  assert.equal(request.init.body.includes('secret-leonardo-key'), false);
});
