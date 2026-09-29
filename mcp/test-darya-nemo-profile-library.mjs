import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDaryaNemoPreset,
  listDaryaNemoProfiles,
} from './darya-nemo-profile-library.mjs';

const forbidden = new Set([
  'v11-175-fetish-noncon',
  'v11-166-fetish-cbt',
  'v11-626-fetish-forced-fem-classic',
  'v11-620-nsfw-gooner-slop-mode',
  'v11-621-nsfw-gooner-s-masterpiece-protocol',
]);

const vexIds = new Set([
  'v11-305-vex-narrative-vex',
  'v11-327-vex-lustful-vex',
  'v11-304-vex-goon-gremlin-vex',
  'v11-329-vex-gooner-vex',
]);

test('Darya Nemo profile library exposes a varied adult-safe profile set', () => {
  const profiles = listDaryaNemoProfiles();
  assert(profiles.length >= 8);
  const ids = new Set(profiles.map((item) => item.id));
  for (const id of [
    'darya-gooner-humiliation',
    'darya-femdom-humiliation',
    'darya-petplay',
    'darya-ntr-humiliation',
    'darya-netori',
    'darya-feminization-humiliation',
    'darya-foot-fetish',
    'darya-harem',
  ]) {
    assert(ids.has(id), `missing profile ${id}`);
  }
});

test('every Darya Nemo profile keeps one Vex, 458 prompts, and excludes unsafe/conflicting defaults', async () => {
  for (const profile of listDaryaNemoProfiles()) {
    const preset = await buildDaryaNemoPreset(profile.id);
    assert.equal(preset.prompts.length, 458, `${profile.id}: prompt count`);
    assert.equal(preset.prompt_order.length, 2, `${profile.id}: prompt-order profiles`);
    assert.deepEqual(
      preset.prompt_order[0].order,
      preset.prompt_order[1].order,
      `${profile.id}: prompt-order profiles diverged`,
    );

    const active = new Set(
      preset.prompt_order[0].order
        .filter((entry) => entry.enabled)
        .map((entry) => entry.identifier),
    );
    assert.equal(
      [...vexIds].filter((id) => active.has(id)).length,
      1,
      `${profile.id}: expected one selected Vex`,
    );
    for (const id of forbidden) assert(!active.has(id), `${profile.id}: forbidden ${id}`);
    assert(!(active.has('v11-173-fetish-ntr') && active.has('v11-172-fetish-netori')));
    assert(!(active.has('v11-168-fetish-feminization') && active.has('v11-626-fetish-forced-fem-classic')));
    assert(active.has('v11-180-nsfw-nsfw-core'), `${profile.id}: NSFW Core missing`);
    assert.equal(preset.show_thoughts, false, `${profile.id}: private planning visible`);
  }
});

test('profile-specific fetish selectors are actually activated', async () => {
  const expected = {
    'darya-gooner-humiliation': ['v11-639-fetish-humiliation'],
    'darya-femdom-humiliation': ['v11-167-fetish-femdom', 'v11-639-fetish-humiliation'],
    'darya-petplay': ['v11-174-fetish-petplay'],
    'darya-ntr-humiliation': ['v11-173-fetish-ntr', 'v11-639-fetish-humiliation'],
    'darya-netori': ['v11-172-fetish-netori'],
    'darya-feminization-humiliation': ['v11-168-fetish-feminization', 'v11-639-fetish-humiliation'],
    'darya-foot-fetish': ['v11-169-fetish-foot-fetish'],
    'darya-harem': ['v11-171-fetish-harem'],
  };

  for (const [id, fetishIds] of Object.entries(expected)) {
    const preset = await buildDaryaNemoPreset(id);
    const active = new Set(
      preset.prompt_order[0].order
        .filter((entry) => entry.enabled)
        .map((entry) => entry.identifier),
    );
    for (const fetishId of fetishIds) assert(active.has(fetishId), `${id}: missing ${fetishId}`);
  }
});
