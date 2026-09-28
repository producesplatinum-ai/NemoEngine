import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROVIDERS,
  ProviderClient,
  extractResponseText,
  providerFromEndpointPath,
} from './ai-provider-server.mjs';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === 'content-type') return 'application/json';
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

test('provider registry exposes the intended Codex/mobile providers and default models', () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(PROVIDERS).map(([id, cfg]) => [
        id,
        {
          baseUrl: cfg.baseUrl,
          envKey: cfg.envKey,
          defaultModel: cfg.defaultModel,
        },
      ]),
    ),
    {
      groq: {
        baseUrl: 'https://api.groq.com/openai/v1',
        envKey: 'GROQ_API_KEY',
        defaultModel: 'openai/gpt-oss-120b',
      },
      openrouter: {
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
        defaultModel: 'openrouter/free',
      },
      deepseek: {
        baseUrl: 'https://api.deepseek.com',
        envKey: 'DEEPSEEK_API_KEY',
        defaultModel: 'deepseek-flash',
      },
    },
  );
});

test('provider client calls the Responses API without exposing the API key', async () => {
  const calls = [];
  const client = new ProviderClient({
    providerId: 'groq',
    apiKey: 'secret-groq-key',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        id: 'resp_1',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'hello from groq' }],
          },
        ],
      });
    },
  });

  const result = await client.generate({
    input: 'Say hello',
    instructions: 'Be brief',
    maxOutputTokens: 120,
  });

  assert.equal(result.text, 'hello from groq');
  assert.equal(result.provider, 'groq');
  assert.equal(result.model, 'openai/gpt-oss-120b');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/responses');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, 'Bearer secret-groq-key');

  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body, {
    model: 'openai/gpt-oss-120b',
    input: 'Say hello',
    instructions: 'Be brief',
    max_output_tokens: 120,
  });

  assert.equal(JSON.stringify(result).includes('secret-groq-key'), false);
});

test('provider client refuses generation when its API key is not configured', async () => {
  const client = new ProviderClient({
    providerId: 'openrouter',
    apiKey: '',
    fetchImpl: async () => {
      throw new Error('network should not be called');
    },
  });

  await assert.rejects(
    () => client.generate({ input: 'test' }),
    /OPENROUTER_API_KEY.*not configured/i,
  );
});

test('response text extraction handles output_text and Responses message content', () => {
  assert.equal(extractResponseText({ output_text: 'direct' }), 'direct');
  assert.equal(
    extractResponseText({
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'one' },
            { type: 'output_text', text: ' two' },
          ],
        },
      ],
    }),
    'one two',
  );
});

test('MCP endpoint path selects exactly one provider', () => {
  assert.equal(providerFromEndpointPath('/groq/mcp'), 'groq');
  assert.equal(providerFromEndpointPath('/openrouter/mcp'), 'openrouter');
  assert.equal(providerFromEndpointPath('/deepseek/mcp'), 'deepseek');
  assert.equal(providerFromEndpointPath('/healthz'), null);
  assert.equal(providerFromEndpointPath('/groq/other'), null);
});
