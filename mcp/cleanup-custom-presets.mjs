import {
  SillyTavernClient,
  resolveSillyTavernBaseUrl,
} from './sillytavern-server.mjs';

const fallbackName = 'Nemo Engine 11.5.2 - Ready RU Gooner RP';

const customPresetNames = [
  'Nemo Exact Active',
  'Nemo Engine 11.5.2 - Darya Femdom Humiliation RP',
  'Nemo Engine 11.5.2 - Darya Feminization Humiliation RP',
  'Nemo Engine 11.5.2 - Darya Foot Fetish RP',
  'Nemo Engine 11.5.2 - Darya Goon Gremlin Hyper RP',
  'Nemo Engine 11.5.2 - Darya Gooner Humiliation RP',
  'Nemo Engine 11.5.2 - Darya Harem RP',
  'Nemo Engine 11.5.2 - Darya Netori RP',
  'Nemo Engine 11.5.2 - Darya NTR Humiliation RP',
  'Nemo Engine 11.5.2 - Darya Petplay RP',
];

const client = new SillyTavernClient({
  baseUrl: resolveSillyTavernBaseUrl(process.env),
  username: process.env.SILLYTAVERN_BASIC_AUTH_USERNAME || '',
  password: process.env.SILLYTAVERN_BASIC_AUTH_PASSWORD || '',
});

for (const name of customPresetNames) {
  try {
    const result = await client.deleteOpenAiPreset({ name, fallbackName });
    console.error('[preset-cleanup]', JSON.stringify(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('HTTP 404')) {
      console.error('[preset-cleanup]', JSON.stringify({ ok: true, alreadyAbsent: name }));
      continue;
    }
    throw error;
  }
}
