import assert from 'node:assert/strict';
import test from 'node:test';

import { applyOpenAiPresetToSettings } from './openai-preset-activation.mjs';

test('applies Chat Completion preset fields using SillyTavern openai settings mapping', () => {
  const settings = {
    theme: 'dark',
    oai_settings: {
      preset_settings_openai: 'Old',
      temp_openai: 0.5,
      freq_pen_openai: 0,
      prompts: [{ identifier: 'old' }],
      prompt_order: [{ character_id: 100001, order: [] }],
      custom_model: 'keep-unless-preset-overrides',
    },
  };
  const preset = {
    temperature: 0.91,
    frequency_penalty: 0.22,
    prompts: [{ identifier: 'new' }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'new', enabled: true }] }],
    show_thoughts: false,
    assistant_prefill: 'prefill',
  };

  const next = applyOpenAiPresetToSettings(settings, preset, 'Nemo Exact Active');

  assert.equal(next.theme, 'dark');
  assert.equal(next.oai_settings.preset_settings_openai, 'Nemo Exact Active');
  assert.equal(next.oai_settings.temp_openai, 0.91);
  assert.equal(next.oai_settings.freq_pen_openai, 0.22);
  assert.deepEqual(next.oai_settings.prompts, preset.prompts);
  assert.deepEqual(next.oai_settings.prompt_order, preset.prompt_order);
  assert.equal(next.oai_settings.show_thoughts, false);
  assert.equal(next.oai_settings.assistant_prefill, 'prefill');
  assert.equal(next.oai_settings.custom_model, 'keep-unless-preset-overrides');
});

test('does not mutate input settings or copy unknown preset metadata into oai_settings', () => {
  const settings = { oai_settings: { preset_settings_openai: 'Old', seed: 7 } };
  const before = structuredClone(settings);
  const preset = {
    seed: 42,
    preset_name: 'source metadata',
    nemo_merge_note: 'metadata only',
  };

  const next = applyOpenAiPresetToSettings(settings, preset, 'Nemo Exact Active');

  assert.deepEqual(settings, before);
  assert.equal(next.oai_settings.seed, 42);
  assert.equal(next.oai_settings.preset_settings_openai, 'Nemo Exact Active');
  assert.equal(Object.hasOwn(next.oai_settings, 'preset_name'), false);
  assert.equal(Object.hasOwn(next.oai_settings, 'nemo_merge_note'), false);
});
