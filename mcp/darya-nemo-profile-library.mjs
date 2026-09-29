import { readFile } from 'node:fs/promises';

const BASE_PRESET_URL = new URL(
  '../Nemo Engine/Ready/Nemo Engine 11.5.2 - Ready RU RP.json',
  import.meta.url,
);

const VEX_IDS = [
  'v11-305-vex-narrative-vex',
  'v11-327-vex-lustful-vex',
  'v11-304-vex-goon-gremlin-vex',
  'v11-329-vex-gooner-vex',
];

const NSFW_OVERLAY_IDS = [
  'v11-176-nsfw-dirty-talk',
  'v11-177-nsfw-dom-language',
  'v11-178-nsfw-gooner-protocol',
  'v11-179-nsfw-moans-sfx',
  'v11-181-nsfw-porn-tropes',
  'v11-182-nsfw-proactive-partners',
  'v11-183-nsfw-realistic-smut',
  'v11-184-nsfw-sexual-physiology',
  'v11-620-nsfw-gooner-slop-mode',
  'v11-621-nsfw-gooner-s-masterpiece-protocol',
  'v11-622-nsfw-hentai-mode',
  'v11-623-nsfw-dead-dove-classic',
  'v11-537-classic-nsfw-core',
];

const FORBIDDEN_IDS = [
  'v11-175-fetish-noncon',
  'v11-166-fetish-cbt',
  'v11-626-fetish-forced-fem-classic',
  'v11-620-nsfw-gooner-slop-mode',
  'v11-621-nsfw-gooner-s-masterpiece-protocol',
];

const commonConsequences = [
  'v11-612-augment-consequences',
  'v11-244-utility-character-friction',
];

const PROFILE_LIBRARY = Object.freeze({
  'darya-gooner-humiliation': {
    name: 'Nemo Engine 11.5.2 - Darya Gooner Humiliation RP',
    label: 'Darya · Gooner Humiliation',
    vex: 'v11-329-vex-gooner-vex',
    nsfw: [
      'v11-176-nsfw-dirty-talk',
      'v11-177-nsfw-dom-language',
      'v11-178-nsfw-gooner-protocol',
      'v11-182-nsfw-proactive-partners',
      'v11-183-nsfw-realistic-smut',
      'v11-184-nsfw-sexual-physiology',
    ],
    fetishes: ['v11-639-fetish-humiliation'],
    extras: [...commonConsequences, 'v11-613-augment-psychological-emotional-realism'],
  },
  'darya-femdom-humiliation': {
    name: 'Nemo Engine 11.5.2 - Darya Femdom Humiliation RP',
    label: 'Darya · Femdom + Humiliation',
    vex: 'v11-327-vex-lustful-vex',
    nsfw: [
      'v11-176-nsfw-dirty-talk',
      'v11-177-nsfw-dom-language',
      'v11-182-nsfw-proactive-partners',
      'v11-183-nsfw-realistic-smut',
      'v11-184-nsfw-sexual-physiology',
    ],
    fetishes: ['v11-167-fetish-femdom', 'v11-639-fetish-humiliation'],
    extras: [...commonConsequences, 'v11-613-augment-psychological-emotional-realism'],
  },
  'darya-petplay': {
    name: 'Nemo Engine 11.5.2 - Darya Petplay RP',
    label: 'Darya · Petplay',
    vex: 'v11-327-vex-lustful-vex',
    nsfw: [
      'v11-176-nsfw-dirty-talk',
      'v11-177-nsfw-dom-language',
      'v11-182-nsfw-proactive-partners',
      'v11-183-nsfw-realistic-smut',
    ],
    fetishes: ['v11-174-fetish-petplay'],
    extras: commonConsequences,
  },
  'darya-ntr-humiliation': {
    name: 'Nemo Engine 11.5.2 - Darya NTR Humiliation RP',
    label: 'Darya · NTR + Humiliation',
    vex: 'v11-327-vex-lustful-vex',
    nsfw: [
      'v11-176-nsfw-dirty-talk',
      'v11-177-nsfw-dom-language',
      'v11-182-nsfw-proactive-partners',
      'v11-183-nsfw-realistic-smut',
      'v11-184-nsfw-sexual-physiology',
    ],
    fetishes: ['v11-173-fetish-ntr', 'v11-639-fetish-humiliation'],
    extras: [...commonConsequences, 'v11-613-augment-psychological-emotional-realism'],
  },
  'darya-netori': {
    name: 'Nemo Engine 11.5.2 - Darya Netori RP',
    label: 'Darya · Netori',
    vex: 'v11-327-vex-lustful-vex',
    nsfw: [
      'v11-176-nsfw-dirty-talk',
      'v11-182-nsfw-proactive-partners',
      'v11-183-nsfw-realistic-smut',
      'v11-184-nsfw-sexual-physiology',
    ],
    fetishes: ['v11-172-fetish-netori'],
    extras: commonConsequences,
  },
  'darya-feminization-humiliation': {
    name: 'Nemo Engine 11.5.2 - Darya Feminization Humiliation RP',
    label: 'Darya · Feminization + Humiliation',
    vex: 'v11-305-vex-narrative-vex',
    nsfw: [
      'v11-176-nsfw-dirty-talk',
      'v11-177-nsfw-dom-language',
      'v11-182-nsfw-proactive-partners',
    ],
    fetishes: ['v11-168-fetish-feminization', 'v11-639-fetish-humiliation'],
    extras: [...commonConsequences, 'v11-613-augment-psychological-emotional-realism'],
  },
  'darya-foot-fetish': {
    name: 'Nemo Engine 11.5.2 - Darya Foot Fetish RP',
    label: 'Darya · Foot Fetish',
    vex: 'v11-327-vex-lustful-vex',
    nsfw: [
      'v11-176-nsfw-dirty-talk',
      'v11-182-nsfw-proactive-partners',
      'v11-183-nsfw-realistic-smut',
    ],
    fetishes: ['v11-169-fetish-foot-fetish'],
    extras: commonConsequences,
  },
  'darya-harem': {
    name: 'Nemo Engine 11.5.2 - Darya Harem RP',
    label: 'Darya · Harem',
    vex: 'v11-327-vex-lustful-vex',
    nsfw: [
      'v11-176-nsfw-dirty-talk',
      'v11-182-nsfw-proactive-partners',
      'v11-183-nsfw-realistic-smut',
      'v11-184-nsfw-sexual-physiology',
    ],
    fetishes: ['v11-171-fetish-harem'],
    extras: commonConsequences,
  },
  'darya-goon-gremlin-hyper': {
    name: 'Nemo Engine 11.5.2 - Darya Goon Gremlin Hyper RP',
    label: 'Darya · Goon Gremlin Hyper',
    vex: 'v11-304-vex-goon-gremlin-vex',
    nsfw: [
      'v11-176-nsfw-dirty-talk',
      'v11-177-nsfw-dom-language',
      'v11-178-nsfw-gooner-protocol',
      'v11-179-nsfw-moans-sfx',
      'v11-181-nsfw-porn-tropes',
      'v11-182-nsfw-proactive-partners',
      'v11-184-nsfw-sexual-physiology',
      'v11-622-nsfw-hentai-mode',
    ],
    fetishes: ['v11-639-fetish-humiliation'],
    extras: commonConsequences,
  },
});

const clone = (value) => JSON.parse(JSON.stringify(value));

export function listDaryaNemoProfiles() {
  return Object.entries(PROFILE_LIBRARY).map(([id, spec]) => ({
    id,
    name: spec.name,
    label: spec.label,
    vex: spec.vex,
    nsfw: [...spec.nsfw],
    fetishes: [...spec.fetishes],
    extras: [...spec.extras],
  }));
}

function fetishIdsFromPreset(preset) {
  return preset.prompts.flatMap((prompt) => {
    const category = String(prompt?.content || '').match(/@category\s+([^\s}]+)/)?.[1];
    const isHeader = /@section-header\s+true/.test(String(prompt?.content || ''));
    return category === 'Fetish' && !isHeader ? [prompt.identifier] : [];
  });
}

function setKnown(state, knownIds, identifier, enabled) {
  if (!knownIds.has(identifier)) {
    throw new Error(`Unknown Nemo prompt identifier: ${identifier}`);
  }
  state.set(identifier, Boolean(enabled));
}

export async function buildDaryaNemoPreset(profileId) {
  const spec = PROFILE_LIBRARY[String(profileId || '').trim()];
  if (!spec) throw new Error(`Unknown Darya Nemo profile: ${profileId}`);

  const preset = JSON.parse(await readFile(BASE_PRESET_URL, 'utf8'));
  if (!Array.isArray(preset.prompts) || preset.prompts.length !== 458) {
    throw new Error('Unexpected Nemo Ready RU base preset.');
  }
  if (!Array.isArray(preset.prompt_order) || preset.prompt_order.length !== 2) {
    throw new Error('Unexpected Nemo prompt-order profile count.');
  }

  const knownIds = new Set(preset.prompts.map((prompt) => prompt.identifier));
  const baseOrder = preset.prompt_order[0].order;
  const state = new Map(baseOrder.map((entry) => [entry.identifier, Boolean(entry.enabled)]));

  for (const id of VEX_IDS) setKnown(state, knownIds, id, false);
  setKnown(state, knownIds, spec.vex, true);

  for (const id of NSFW_OVERLAY_IDS) setKnown(state, knownIds, id, false);
  setKnown(state, knownIds, 'v11-180-nsfw-nsfw-core', true);
  for (const id of spec.nsfw) setKnown(state, knownIds, id, true);

  for (const id of fetishIdsFromPreset(preset)) setKnown(state, knownIds, id, false);
  for (const id of spec.fetishes) setKnown(state, knownIds, id, true);

  for (const id of spec.extras) setKnown(state, knownIds, id, true);
  for (const id of FORBIDDEN_IDS) setKnown(state, knownIds, id, false);

  const normalizedOrder = baseOrder.map((entry) => ({
    identifier: entry.identifier,
    enabled: state.get(entry.identifier) ?? false,
  }));
  preset.prompt_order = preset.prompt_order.map((profile) => ({
    character_id: profile.character_id,
    order: clone(normalizedOrder),
  }));

  preset.preset_name = spec.name;
  preset.show_thoughts = false;
  preset.assistant_prefill =
    'Хорошо, я следую активному режиму NemoEngine и сохраняю голос текущего персонажа.';
  preset.nemo_merge_note = [
    spec.name,
    'Darya profile library derivative of Nemo Engine 11.5.2 Ready RU RP.',
    `Vex: ${spec.vex}`,
    `NSFW: ${spec.nsfw.join(', ') || 'NSFW Core only'}`,
    `Fetish: ${spec.fetishes.join(', ') || 'none'}`,
    `Extras: ${spec.extras.join(', ') || 'none'}`,
    'Russian planning/narration and Ready RU core remain unchanged.',
    'NonCon, CBT, Forced Fem Classic, Slop and Masterpiece remain disabled in this curated library.',
  ].join('\n');

  return preset;
}
