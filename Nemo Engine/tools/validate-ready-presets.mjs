import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const SOURCE_SHA256 = '983e31575b824d0f4910078a2549930495d5f7e5c5e49d508db331cd8a6bd698';
const here = new URL('.', import.meta.url);
const sourceUrl = new URL('../Nemo Engine 11.5.2 - General RP.json', here);
const variants = [
  ['general', new URL('../Ready/Nemo Engine 11.5.2 - Ready RU RP.json', here), 109],
  ['gooner', new URL('../Ready/Nemo Engine 11.5.2 - Ready RU Gooner RP.json', here), 111],
];

const rawSource = await readFile(sourceUrl, 'utf8');
const sourceHash = createHash('sha256').update(rawSource).digest('hex');
assert.equal(sourceHash, SOURCE_SHA256, 'authoritative General RP source changed');
const source = JSON.parse(rawSource);
const source100001 = source.prompt_order.find((profile) => profile.character_id === 100001);
assert(source100001, 'source profile 100001 is missing');

const idAt = (index) => source.prompts[index].identifier;
const range = (first, count) => Array.from({ length: count }, (_, offset) => first + offset);
const groups = {
  vex: [43, ...range(45, 31)],
  difficulty: range(327, 8),
  world: [250, 252, 254, 256, 258, 260, 263, 352, 354],
  planningMode: range(153, 8),
  planningLanguage: range(94, 12),
  narrationLanguage: range(107, 12),
  trackers: range(356, 36),
  fetish: range(421, 14),
  nsfw: range(406, 14),
};

function expectedState(kind) {
  const state = new Map(source100001.order.map((entry) => [entry.identifier, Boolean(entry.enabled)]));
  const set = (index, enabled) => state.set(idAt(index), enabled);
  const setMany = (indices, enabled) => indices.forEach((index) => set(index, enabled));

  setMany(groups.vex, false);
  set(kind === 'gooner' ? 74 : 60, true);
  setMany(groups.difficulty, false);
  set(327, true);
  setMany(groups.world, false);
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
  return state;
}

function activeMetadataGroups(preset, active) {
  const found = new Map();
  preset.prompts.forEach((prompt, index) => {
    const match = prompt.content.match(/@mutual-exclusive-group\s+([^\s}]+)/);
    if (!match || !active.has(prompt.identifier)) return;
    const entries = found.get(match[1]) ?? [];
    entries.push(`${index}:${prompt.name}`);
    found.set(match[1], entries);
  });
  return found;
}

function compileStoredRegex(value) {
  assert(value.startsWith('/'), `not a slash regex: ${value}`);
  const lastSlash = value.lastIndexOf('/');
  assert(lastSlash > 0, `invalid slash regex: ${value}`);
  return new RegExp(value.slice(1, lastSlash), value.slice(lastSlash + 1));
}

function validatePreset(preset, kind, expectedActiveCount) {
  assert.equal(preset.prompts.length, 456, `${kind}: prompt count`);
  assert.equal(preset.prompt_order.length, 2, `${kind}: profile count`);
  assert.equal(preset.extensions.regex_scripts.length, 97, `${kind}: regex count`);
  assert.deepEqual(preset.prompts, source.prompts, `${kind}: prompt definitions must remain unchanged`);

  const promptIds = preset.prompts.map((prompt) => prompt.identifier);
  assert.equal(new Set(promptIds).size, 456, `${kind}: duplicate prompt id`);
  assert.deepEqual(preset.prompt_order.map((profile) => profile.character_id), [100000, 100001], `${kind}: profile ids`);
  assert.deepEqual(preset.prompt_order[0].order, preset.prompt_order[1].order, `${kind}: profiles diverge`);

  const expected = expectedState(kind);
  for (const profile of preset.prompt_order) {
    assert.equal(profile.order.length, 456, `${kind}/${profile.character_id}: order count`);
    assert.equal(new Set(profile.order.map((entry) => entry.identifier)).size, 456, `${kind}/${profile.character_id}: duplicate order id`);
    assert.deepEqual(profile.order.map((entry) => entry.identifier), source100001.order.map((entry) => entry.identifier), `${kind}/${profile.character_id}: identifier order changed`);
    for (const entry of profile.order) assert.equal(entry.enabled, expected.get(entry.identifier), `${kind}/${profile.character_id}: unexpected state for ${entry.identifier}`);
    assert.equal(profile.order.at(-1).identifier, 'v11-classic-user-message-ender', `${kind}: final tail is not last`);
  }

  const active = new Set(preset.prompt_order[0].order.filter((entry) => entry.enabled).map((entry) => entry.identifier));
  assert.equal(active.size, expectedActiveCount, `${kind}: active count`);
  for (const [name, entries] of activeMetadataGroups(preset, active)) assert(entries.length <= 1, `${kind}: ${name} collision: ${entries.join(', ')}`);

  for (const index of [138, 139, 141, 142, 156, 297, 327, 392, 402, 403, 410, 443]) assert(active.has(idAt(index)), `${kind}: required prompt ${index} is off`);
  for (const index of [57, 260, 296, 330, 404, 419]) assert(!active.has(idAt(index)), `${kind}: conflicting prompt ${index} is on`);
  assert(active.has(idAt(96)) && active.has(idAt(109)), `${kind}: Russian language selectors are not active`);
  assert(groups.trackers.every((index) => !active.has(idAt(index))), `${kind}: a tracker is unexpectedly active`);
  assert(groups.fetish.every((index) => !active.has(idAt(index))), `${kind}: a Fetish toggle is unexpectedly active`);

  if (kind === 'general') {
    assert(active.has(idAt(60)) && !active.has(idAt(74)) && !active.has(idAt(408)), 'general: wrong Vex/NSFW overlay');
  } else {
    assert(active.has(idAt(74)) && active.has(idAt(408)) && active.has(idAt(412)), 'gooner: required stack is incomplete');
    assert(!active.has(idAt(415)) && !active.has(idAt(416)), 'gooner: Slop or Masterpiece must stay off');
  }

  assert.equal(preset.show_thoughts, false, `${kind}: private planning display must be off`);
  assert(!/Council of Vex/i.test(preset.assistant_prefill), `${kind}: stale Council prefill`);
  const finalTail = preset.prompts.at(-1);
  assert.equal(finalTail.identifier, 'v11-classic-user-message-ender');
  assert.equal(finalTail.role, 'user');
  assert.equal(finalTail.injection_position, 1);
  assert.equal(finalTail.injection_depth, 0);
  assert.equal(finalTail.injection_order, 201);

  const sourceRegex = structuredClone(source.extensions.regex_scripts);
  const targetRegex = structuredClone(preset.extensions.regex_scripts);
  assert.equal(targetRegex.filter((script) => !script.disabled).length, 96, `${kind}: active regex count`);
  assert.equal(targetRegex[0].disabled, false, `${kind}: HTML context cleanup is off`);
  assert.equal(targetRegex[11].disabled, true, `${kind}: closed plan display must stay off`);
  targetRegex[0].disabled = sourceRegex[0].disabled;
  assert.deepEqual(targetRegex, sourceRegex, `${kind}: an undeclared regex change exists`);
  for (const script of preset.extensions.regex_scripts) compileStoredRegex(script.findRegex);
}

for (const [kind, url, expectedCount] of variants) {
  const preset = JSON.parse(await readFile(url, 'utf8'));
  validatePreset(preset, kind, expectedCount);
  console.log(`PASS ${kind}: 456 prompts, ${expectedCount} active, 97 regex`);
}

console.log('PASS source integrity:', sourceHash);

