import { createHash } from 'node:crypto';
import { readFile, readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const readFileAsync = promisify(readFile);
const here = new URL('.', import.meta.url);

const GENERAL_SOURCE_PATH = '../Nemo Engine/Nemo Engine 11.5.2 - General RP.json';
const generalRaw = readFileSync(new URL(GENERAL_SOURCE_PATH, here), 'utf8');
const general = JSON.parse(generalRaw);

const canonicalSources = [
  {
    id: 'canonical-v10',
    name: 'Nemo Engine v10',
    sourcePath: '../Nemo Engine/Nemo Engine v10.json',
  },
  {
    id: 'canonical-v11.1-cynthia-ensemble',
    name: 'NemoEngine v11.1 Cynthia Ensemble Setup',
    sourcePath: '../Nemo Engine/NemoEngine_v11.1_Cynthia_Ensemble_Setup.json',
  },
  {
    id: 'canonical-v112-release',
    name: 'NemoEngine v112 release',
    sourcePath: '../Nemo Engine/NemoEngine_v112 release.json',
  },
  {
    id: 'canonical-11.5.1-general-rp',
    name: 'Nemo Engine 11.5.1 - General RP',
    sourcePath: '../Nemo Engine/Nemo Engine 11.5.1 - General RP.json',
  },
  {
    id: 'canonical-11.5.2-default-rp',
    name: 'Nemo Engine 11.5.2 - Default RP',
    sourcePath: '../Nemo Engine/Nemo Engine 11.5.2 - Default RP.json',
  },
  {
    id: 'canonical-11.5.2-general-rp',
    name: 'Nemo Engine 11.5.2 - General RP',
    sourcePath: GENERAL_SOURCE_PATH,
  },
  {
    id: 'canonical-ready-ru-rp',
    name: 'Nemo Engine 11.5.2 - Ready RU RP',
    sourcePath: '../Nemo Engine/Ready/Nemo Engine 11.5.2 - Ready RU RP.json',
  },
  {
    id: 'canonical-ready-ru-gooner-rp',
    name: 'Nemo Engine 11.5.2 - Ready RU Gooner RP',
    sourcePath: '../Nemo Engine/Ready/Nemo Engine 11.5.2 - Ready RU Gooner RP.json',
  },
  {
    id: 'canonical-ready-ru-explicit-porn-rp',
    name: 'Nemo Engine 11.5.2 - Ready RU Explicit Porn RP',
    sourcePath: '../Nemo Engine/Ready/Nemo Engine 11.5.2 - Ready RU Explicit Porn RP.json',
  },
  {
    id: 'canonical-ready-ru-psychology-humiliation-joi-rp',
    name: 'Nemo Engine 11.5.2 - Ready RU Psychology Humiliation JOI RP',
    sourcePath: '../Nemo Engine/Ready/Nemo Engine 11.5.2 - Ready RU Psychology Humiliation JOI RP.json',
  },
  {
    id: 'canonical-ready-ru-gooner-humiliation-joi-rp',
    name: 'Nemo Engine 11.5.2 - Ready RU Gooner Humiliation JOI RP',
    sourcePath: '../Nemo Engine/Ready/Nemo Engine 11.5.2 - Ready RU Gooner Humiliation JOI RP.json',
  },
];

function isSectionHeader(prompt) {
  return /@section-header\s+true/.test(String(prompt?.content || ''));
}

function categoryOf(prompt) {
  return String(prompt?.content || '').match(/@category\s+([^\s}]+)/)?.[1] || '';
}

function mutualGroupOf(prompt) {
  return String(prompt?.content || '').match(/@mutual-exclusive-group\s+([^\s}]+)/)?.[1] || '';
}

function slug(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

export function semanticSha256(value) {
  return createHash('sha256')
    .update(JSON.stringify(sortKeys(value)))
    .digest('hex');
}

const selectorEntries = general.prompts.flatMap((prompt) => {
  const group = mutualGroupOf(prompt);
  if (!group || isSectionHeader(prompt)) return [];
  return [{
    id: `selector-${slug(group)}-${slug(prompt.identifier)}`,
    kind: 'selector',
    family: 'Mutual Exclusive',
    group,
    identifier: prompt.identifier,
    promptName: prompt.name,
    name: `Nemo Exact · ${group} · ${prompt.name}`,
    sourcePath: GENERAL_SOURCE_PATH,
  }];
});

const overlayEntries = ['Fetish', 'NSFW'].flatMap((family) =>
  general.prompts.flatMap((prompt) => {
    if (isSectionHeader(prompt) || categoryOf(prompt) !== family) return [];
    return [{
      id: `overlay-${family.toLowerCase()}-${slug(prompt.identifier)}`,
      kind: 'overlay',
      family,
      identifier: prompt.identifier,
      promptName: prompt.name,
      name: `Nemo Exact · ${family} · ${prompt.name}`,
      sourcePath: GENERAL_SOURCE_PATH,
    }];
  }),
);

const catalog = Object.freeze([
  ...canonicalSources.map((entry) => ({ ...entry, kind: 'canonical', family: 'Canonical' })),
  ...selectorEntries,
  ...overlayEntries,
]);

const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));

export function listExactNemoCatalog() {
  return catalog.map((entry) => ({ ...entry }));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function updateEveryPromptOrder(preset, updater) {
  preset.prompt_order = preset.prompt_order.map((profile) => ({
    ...profile,
    order: profile.order.map((entry) => updater({ ...entry })),
  }));
}

function buildSelectorPreset(entry) {
  const preset = clone(general);
  const groupById = new Map(
    general.prompts.flatMap((prompt) => {
      const group = mutualGroupOf(prompt);
      return group ? [[prompt.identifier, group]] : [];
    }),
  );

  updateEveryPromptOrder(preset, (orderEntry) => {
    if (groupById.get(orderEntry.identifier) !== entry.group) return orderEntry;
    return {
      ...orderEntry,
      enabled: orderEntry.identifier === entry.identifier,
    };
  });
  return preset;
}

function buildOverlayPreset(entry) {
  const preset = clone(general);
  updateEveryPromptOrder(preset, (orderEntry) => (
    orderEntry.identifier === entry.identifier
      ? { ...orderEntry, enabled: true }
      : orderEntry
  ));
  return preset;
}

export async function buildExactNemoPreset(id) {
  const entry = catalogById.get(String(id || '').trim());
  if (!entry) throw new Error(`Unknown exact Nemo catalog entry: ${id}`);

  const sourceUrl = new URL(entry.sourcePath, here);
  const raw = await readFileAsync(sourceUrl, 'utf8');
  const source = JSON.parse(raw);

  let preset;
  if (entry.kind === 'canonical') {
    preset = source;
  } else if (entry.kind === 'selector') {
    preset = buildSelectorPreset(entry);
  } else if (entry.kind === 'overlay') {
    preset = buildOverlayPreset(entry);
  } else {
    throw new Error(`Unsupported exact Nemo catalog kind: ${entry.kind}`);
  }

  return {
    entry: { ...entry },
    preset,
    sourceRawSha256: createHash('sha256').update(raw).digest('hex'),
    sourceSemanticSha256: semanticSha256(source),
    presetSemanticSha256: semanticSha256(preset),
  };
}
