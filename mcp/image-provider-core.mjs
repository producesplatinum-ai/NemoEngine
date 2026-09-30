export const IMAGE_PROVIDERS = Object.freeze({
  leonardo: Object.freeze({
    name: 'Leonardo AI',
    baseUrl: 'https://mcp.leonardo.ai/v1/mcp',
    envKey: 'LEONARDO_API_KEY',
    defaultModel: 'lucid-origin',
  }),
  ideogram: Object.freeze({
    name: 'Ideogram',
    baseUrl: 'https://api.ideogram.ai',
    envKey: 'IDEOGRAM_API_KEY',
    defaultModel: 'ideogram-v4',
  }),
});

function safeErrorBody(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 2_000);
}

export function normalizeImagePrefix(value = '') {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (!trimmed.startsWith('/') || trimmed.includes('?') || trimmed.includes('#')) {
    throw new Error('AI_MCP_PREFIX must be an absolute URL path prefix.');
  }
  return trimmed.replace(/\/+$/, '');
}

export function imageProviderFromEndpointPath(pathname, prefix = '') {
  const normalizedPrefix = normalizeImagePrefix(prefix);
  for (const providerId of Object.keys(IMAGE_PROVIDERS)) {
    if (pathname === `${normalizedPrefix}/${providerId}/mcp`) {
      return providerId;
    }
  }
  return null;
}

export class IdeogramClient {
  constructor({ apiKey = '', fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('A fetch implementation is required.');
    }
    this.apiKey = String(apiKey || '').trim();
    this.fetchImpl = fetchImpl;
  }

  status() {
    const config = IMAGE_PROVIDERS.ideogram;
    return {
      ok: true,
      provider: 'ideogram',
      providerName: config.name,
      configured: Boolean(this.apiKey),
      envKey: config.envKey,
      defaultModel: config.defaultModel,
      baseUrl: config.baseUrl,
    };
  }

  async generate({
    prompt,
    resolution,
    renderingSpeed = 'DEFAULT',
    negativePrompt,
    seed,
  } = {}) {
    const config = IMAGE_PROVIDERS.ideogram;
    if (!this.apiKey) {
      throw new Error(`${config.envKey} is not configured.`);
    }

    const normalizedPrompt = String(prompt || '').trim();
    if (!normalizedPrompt) throw new Error('prompt is required.');

    const normalizedSpeed = String(renderingSpeed || 'DEFAULT').trim().toUpperCase();
    if (!['TURBO', 'DEFAULT', 'QUALITY'].includes(normalizedSpeed)) {
      throw new Error('renderingSpeed must be TURBO, DEFAULT, or QUALITY.');
    }

    const form = new FormData();
    form.set('text_prompt', normalizedPrompt);
    form.set('rendering_speed', normalizedSpeed);

    if (resolution !== undefined && resolution !== null && String(resolution).trim()) {
      form.set('resolution', String(resolution).trim());
    }

    if (
      negativePrompt !== undefined &&
      negativePrompt !== null &&
      String(negativePrompt).trim()
    ) {
      form.set('negative_prompt', String(negativePrompt).trim());
    }

    if (seed !== undefined && seed !== null) {
      const parsedSeed = Number(seed);
      if (
        !Number.isInteger(parsedSeed) ||
        parsedSeed < 0 ||
        parsedSeed > 2_147_483_647
      ) {
        throw new Error('seed must be an integer between 0 and 2147483647.');
      }
      form.set('seed', String(parsedSeed));
    }

    const response = await this.fetchImpl(
      `${config.baseUrl}/v1/ideogram-v4/generate`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'Api-Key': this.apiKey,
        },
        body: form,
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `${config.name} API failed with HTTP ${response.status}: ${safeErrorBody(errorBody)}`,
      );
    }

    const payload = await response.json();
    const images = (Array.isArray(payload?.data) ? payload.data : [])
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        url: typeof item.url === 'string' ? item.url : undefined,
        prompt: typeof item.prompt === 'string' ? item.prompt : undefined,
        resolution:
          typeof item.resolution === 'string' ? item.resolution : undefined,
        seed: Number.isInteger(item.seed) ? item.seed : undefined,
        isImageSafe:
          typeof item.is_image_safe === 'boolean'
            ? item.is_image_safe
            : undefined,
      }))
      .filter((item) => item.url);

    if (!images.length) {
      throw new Error(`${config.name} returned no image URL.`);
    }

    return {
      provider: 'ideogram',
      model: config.defaultModel,
      created:
        typeof payload?.created === 'string' ? payload.created : undefined,
      images,
    };
  }
}

const LEONARDO_FORWARD_HEADERS = new Set([
  'accept',
  'content-type',
  'mcp-session-id',
  'last-event-id',
  'user-agent',
]);

export function buildLeonardoProxyRequest({
  requestUrl = '/leonardo/mcp',
  method = 'POST',
  headers = {},
  body,
  apiKey = '',
} = {}) {
  const config = IMAGE_PROVIDERS.leonardo;
  const normalizedKey = String(apiKey || '').trim();
  if (!normalizedKey) {
    throw new Error(`${config.envKey} is not configured.`);
  }

  const parsedRequestUrl = new URL(
    String(requestUrl || '/'),
    'https://local.invalid',
  );
  const remoteUrl = new URL(config.baseUrl);
  remoteUrl.search = parsedRequestUrl.search;

  const outgoingHeaders = {};
  for (const [rawName, rawValue] of Object.entries(headers || {})) {
    const name = String(rawName || '').toLowerCase();
    if (!LEONARDO_FORWARD_HEADERS.has(name)) continue;
    if (rawValue === undefined || rawValue === null) continue;
    outgoingHeaders[name] = Array.isArray(rawValue)
      ? rawValue.join(', ')
      : String(rawValue);
  }
  outgoingHeaders['API-Key'] = normalizedKey;

  const normalizedMethod = String(method || 'POST').toUpperCase();
  const init = {
    method: normalizedMethod,
    headers: outgoingHeaders,
    redirect: 'manual',
  };

  if (
    normalizedMethod !== 'GET' &&
    normalizedMethod !== 'HEAD' &&
    body !== undefined
  ) {
    init.body = body;
  }

  return {
    url: remoteUrl.toString(),
    init,
  };
}
