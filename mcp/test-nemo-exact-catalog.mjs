import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import {
  buildExactNemoPreset,
  listExactNemoCatalog,
  semanticSha256,
} from './nemo-exact-catalog.mjs';

const here = new URL('.', import.meta.url);
const generalUrl = new URL('../Nemo Engine/Nemo Engine 11.5.2 - General RP.json', here);
const general = JSON.parse(await readFile(generalUrl, 'utf8'));

const nonHeader = (prompt) => !/@section-header\s+true/.test(String(prompt?.content || ''));
const categoryIds = (category) => general.prompts
  .filter((prompt) => nonHeader(prompt) && String(prompt?.content || '').match(/@category\s+([^\s}]+)/)?.[1] === category)
  .map((prompt) => prompt.identifier);

const mutualOptions = general.prompts.flatMap((prompt) => {
  const group = String(prompt?.content || '').match(/@mutual-exclusive-group\s+([^\s}]+)/)?.[1];
  return group && nonHeader(prompt) ? [{ group, identifier: prompt.identifier }] : [];
});

test('exact catalog covers canonical presets, every mutual-exclusive option, every Fetish and every NSFW module', () => {
  const catalog = listExactNemoCatalog();
  const ids = new Set(catalog.map((entry) => entry.id));

  for (const required of [
    'canonical-11.5.2-default-rp',
    'canonical-11.5.2-general-rp',
    'canonical-ready-ru-rp',
    'canonical-ready-ru-gooner-rp',
    'canonical-ready-ru-explicit-porn-rp',
    'canonical-ready-ru-psychology-humiliation-joi-rp',
    'canonical-ready-ru-gooner-humiliation-joi-rp',
  ]) assert(ids.has(required), `missing canonical preset ${required}`);

  for (const { group, identifier } of mutualOptions) {
    assert(
      catalog.some((entry) =>
        entry.kind === 'selector' &&
        entry.group === group &&
        entry.identifier === identifier),
      `missing selector ${group}/${identifier}`,
    );
  }

  for (const identifier of categoryIds('Fetish')) {
    assert(
      catalog.some((entry) => entry.kind === 'overlay' && entry.family === 'Fetish' && entry.identifier === identifier),
      `missing Fetish overlay ${identifier}`,
    );
  }
  for (const identifier of categoryIds('NSFW')) {
    assert(
      catalog.some((entry) => entry.kind === 'overlay' && entry.family === 'NSFW' && entry.identifier === identifier),
      `missing NSFW overlay ${identifier}`,
    );
  }
});

test('canonical exact builds are semantically identical to their source JSON files', async () => {
  for (const entry of listExactNemoCatalog().filter((item) => item.kind === 'canonical')) {
    const raw = await readFile(new URL(entry.sourcePath, here), 'utf8');
    const source = JSON.parse(raw);
    const built = await buildExactNemoPreset(entry.id);
    assert.deepEqual(built.preset, source, `${entry.id}: canonical object changed`);
    assert.equal(built.sourceSemanticSha256, semanticSha256(source));
    assert.equal(built.presetSemanticSha256, semanticSha256(source));
    assert.equal(built.sourceRawSha256, createHash('sha256').update(raw).digest('hex'));
  }
});

test('selector variants change only prompt_order and select exactly one source option in that mutual-exclusive group', async () => {
  const sample = listExactNemoCatalog().find((entry) => entry.kind === 'selector');
  assert(sample, 'selector catalog is empty');
  const built = await buildExactNemoPreset(sample.id);
  const copy = structuredClone(built.preset);
  const base = structuredClone(general);
  delete copy.prompt_order;
  delete base.prompt_order;
  assert.deepEqual(copy, base, 'selector variant changed fields outside prompt_order');

  const sourceGroups = new Map(general.prompts.flatMap((prompt) => {
    const group = String(prompt?.content || '').match(/@mutual-exclusive-group\s+([^\s}]+)/)?.[1];
    return group ? [[prompt.identifier, group]] : [];
  }));
  for (const profile of built.preset.prompt_order) {
    const enabled = profile.order
      .filter((entry) => entry.enabled && sourceGroups.get(entry.identifier) === sample.group)
      .map((entry) => entry.identifier);
    assert.deepEqual(enabled, [sample.identifier]);
  }
});

test('overlay variants change only prompt_order and preserve every prompt definition and regex script exactly', async () => {
  for (const family of ['Fetish', 'NSFW']) {
    const sample = listExactNemoCatalog().find((entry) => entry.kind === 'overlay' && entry.family === family);
    assert(sample, `${family} overlay catalog is empty`);
    const built = await buildExactNemoPreset(sample.id);
    const copy = structuredClone(built.preset);
    const base = structuredClone(general);
    delete copy.prompt_order;
    delete base.prompt_order;
    assert.deepEqual(copy, base, `${family}: overlay changed fields outside prompt_order`);
    for (const profile of built.preset.prompt_order) {
      assert.equal(profile.order.find((entry) => entry.identifier === sample.identifier)?.enabled, true);
    }
  }
});



test('Ready RU Explicit Porn combines the requested explicit modules in one exact preset', async () => {
  const built = await buildExactNemoPreset('canonical-ready-ru-explicit-porn-rp');
  const enabled = new Set(
    built.preset.prompt_order[0].order
      .filter((entry) => entry.enabled)
      .map((entry) => entry.identifier),
  );

  for (const required of [
    'v11-329-vex-gooner-vex',
    'v11-178-nsfw-gooner-protocol',
    'v11-180-nsfw-nsfw-core',
    'v11-182-nsfw-proactive-partners',
    'v11-181-nsfw-porn-tropes',
    'v11-183-nsfw-realistic-smut',
    'v11-184-nsfw-sexual-physiology',
  ]) {
    assert.equal(enabled.has(required), true, `expected enabled prompt ${required}`);
  }

  assert.equal(enabled.has('v11-305-vex-narrative-vex'), false);
});

test('Ready RU Gooner Humiliation JOI combines the requested modules in one exact preset', async () => {
  const built = await buildExactNemoPreset('canonical-ready-ru-gooner-humiliation-joi-rp');
  const enabled = new Set(
    built.preset.prompt_order[0].order
      .filter((entry) => entry.enabled)
      .map((entry) => entry.identifier),
  );

  for (const required of [
    'v11-329-vex-gooner-vex',
    'v11-178-nsfw-gooner-protocol',
    'v11-182-nsfw-proactive-partners',
    'v11-639-fetish-humiliation',
    'v11-640-fetish-joi',
    'v11-176-nsfw-dirty-talk',
    'v11-177-nsfw-dom-language',
    'v11-611-augment-manipulation-realism',
    'v11-613-augment-psychological-emotional-realism',
  ]) {
    assert.equal(enabled.has(required), true, `expected enabled prompt ${required}`);
  }

  assert.equal(enabled.has('v11-305-vex-narrative-vex'), false);
});
