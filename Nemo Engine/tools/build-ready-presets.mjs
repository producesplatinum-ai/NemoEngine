import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const SOURCE_SHA256 = '983e31575b824d0f4910078a2549930495d5f7e5c5e49d508db331cd8a6bd698';
const here = new URL('.', import.meta.url);
const sourceUrl = new URL('../Nemo Engine 11.5.2 - General RP.json', here);
const outputDir = new URL('../Ready/', here);

const sourceRaw = await readFile(sourceUrl, 'utf8');
assert.equal(
  createHash('sha256').update(sourceRaw).digest('hex'),
  SOURCE_SHA256,
  'Refusing to build from an unknown General RP source',
);

const source = JSON.parse(sourceRaw);
assert.equal(source.prompts.length, 456);
const baseProfile = source.prompt_order.find((profile) => profile.character_id === 100001);
assert(baseProfile, 'Source profile 100001 is missing');

const clone = (value) => JSON.parse(JSON.stringify(value));
const idAt = (index) => source.prompts[index].identifier;
const range = (first, count) => Array.from({ length: count }, (_, offset) => first + offset);

const groups = {
  vex: [43, ...range(45, 31)],
  difficulty: range(327, 8),
  worldLogic: [250, 252, 254, 256, 258, 260, 263, 352, 354],
  planningMode: range(153, 8),
  planningLanguage: range(94, 12),
  narrationLanguage: range(107, 12),
  trackers: range(356, 36),
  nsfw: range(406, 14),
  fetish: range(421, 14),
};

function buildVariant(kind) {
  const preset = clone(source);
  const state = new Map(baseProfile.order.map((entry) => [entry.identifier, Boolean(entry.enabled)]));
  const set = (index, enabled) => state.set(idAt(index), enabled);
  const setMany = (indices, enabled) => indices.forEach((index) => set(index, enabled));

  setMany(groups.vex, false);
  set(kind === 'gooner' ? 74 : 60, true);

  setMany(groups.difficulty, false);
  set(327, true);
  setMany(groups.worldLogic, false);
  set(252, true);
  setMany(groups.planningMode, false);
  set(156, true);
  for (const index of [138, 139, 141, 142]) set(index, true);

  setMany(groups.planningLanguage, false);
  set(96, true);
  setMany(groups.narrationLanguage, false);
  set(109, true);

  set(296, false);
  set(297, true);
  setMany(groups.trackers, false);

  for (const index of [392, 402, 403]) set(index, true);
  set(404, false);

  setMany(groups.nsfw, false);
  set(410, true);
  setMany(groups.fetish, false);
  set(443, true);

  if (kind === 'gooner') {
    set(408, true);
    set(412, true);
  }

  const normalizedOrder = baseProfile.order.map((entry) => ({
    identifier: entry.identifier,
    enabled: state.get(entry.identifier) ?? false,
  }));
  preset.prompt_order = source.prompt_order.map((profile) => ({
    character_id: profile.character_id,
    order: clone(normalizedOrder),
  }));

  const suffix = kind === 'gooner' ? ' Gooner' : '';
  preset.preset_name = `Nemo Engine 11.5.2 - Ready RU${suffix} RP`;
  preset.assistant_prefill = 'Хорошо, я следую активному режиму планирования Nemo и контракту выполнения.';
  preset.show_thoughts = false;
  preset.nemo_merge_note = [
    `Nemo Engine 11.5.2 — Ready RU${suffix} RP.`,
    'Conservative derivative of General RP; the original preset is unchanged.',
    'Both prompt-order profiles use one identical, dependency-complete configuration.',
    kind === 'gooner'
      ? 'Gooner Vex, modern NSFW Core, Gooner Protocol and Proactive Partners are active. Slop, Masterpiece and all Fetish toggles remain off.'
      : 'Narrative Vex and modern NSFW Core are active. Gooner and all Fetish toggles remain off.',
    'Russian planning and narration; Balanced difficulty; Grounded world logic; Main Prompt; Main Plan; Character Turn Simulation; Pacing Beats; Narrative Hook; Modular Scratchpad; Consequence tab; Resolver; Hidden Machinery.',
    'All trackers remain off until intentionally selected. Closed plan display remains disabled.',
    'HTML cleanup for older context is enabled.',
  ].join('\n');

  preset.extensions.regex_scripts[0].disabled = false;
  return preset;
}

const variants = [
  ['general', 'Nemo Engine 11.5.2 - Ready RU RP.json'],
  ['gooner', 'Nemo Engine 11.5.2 - Ready RU Gooner RP.json'],
];

await mkdir(outputDir, { recursive: true });
for (const [kind, filename] of variants) {
  const preset = buildVariant(kind);
  await writeFile(new URL(filename, outputDir), `${JSON.stringify(preset, null, 2)}\n`, 'utf8');
  const active = preset.prompt_order[0].order.filter((entry) => entry.enabled).length;
  console.log(`BUILT ${filename}: ${preset.prompts.length} prompts, ${active} active`);
}
