import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDaryaCharacter,
  buildDaryaWorldInfo,
  mergeDaryaCanonicalProfile,
} from './seed-darya.mjs';

const revision = '36e967df9f7524ca862bf380087f0ea0494daaad';

test('canonical Darya card uses the GitHub-owned visible identity without profile coupling', () => {
  const card = buildDaryaCharacter({ revision, sourceMirrored: true });

  assert.equal(card.spec, 'chara_card_v3');
  assert.equal(card.spec_version, '3.0');
  assert.equal(card.data.name, 'Дарья');
  assert.equal(card.data.character_version, 'DARYA_ST_V4_GITHUB_CANON');
  assert.equal(card.data.extensions.world, 'Darya');
  assert.equal(card.data.extensions.darya_source_revision, revision);
  assert.equal(card.data.extensions.darya_speech_passport_id, 'DARYA_SPEECH_PASSPORT_2026_09_12_R4');
  assert.equal(card.data.extensions.darya_corpus_id, 'DARYA_SPEECH_CORPUS_2026_09_07_R6_ALL5_FORENSIC_AUDIT');
  assert.equal(card.data.extensions.darya_nemo_profile_binding, 'independent');
  assert.equal(card.data.tags.includes('NemoEngine'), false);
  assert.equal(card.data.tags.includes('adult'), false);
  assert.equal(card.data.tags.includes('humiliation'), false);
  assert.match(card.data.system_prompt, /STYLE_EVIDENCE_ONLY/i);
  assert.match(card.data.system_prompt, /REQUESTED_CONTENT_ONLY/i);
  assert.match(card.data.system_prompt, /дрочер/i);
  assert.match(card.data.system_prompt, /одобр|положительн/i);
  assert.match(card.data.post_history_instructions, /не то|не похоже/i);
  assert.match(card.data.extensions.depth_prompt.prompt, /Fact-lock|якор|anchor/i);
  assert.ok(card.data.alternate_greetings.length >= 3);
});

test('canonical Darya lorebook includes execution lock, voice continuity and long-form composition', () => {
  const world = buildDaryaWorldInfo({ revision, sourceMirrored: true });
  const entries = Object.values(world.entries);
  const practice = entries.find(x => x.comment === 'Darya practice execution lock');
  const continuity = entries.find(x => x.comment === 'Darya voice continuity');
  const longForm = entries.find(x => x.comment === 'Darya long-form composition');
  const address = entries.find(x => x.comment === 'Darya address and personalization');
  const scope = entries.find(x => x.comment === 'Darya scope discipline');

  assert.ok(practice);
  assert.equal(practice.constant, true);
  assert.match(practice.content, /STYLE_EVIDENCE_ONLY|служебн|control-plane/i);
  assert.match(practice.content, /практикуй/i);

  assert.ok(continuity);
  assert.equal(continuity.constant, true);
  assert.match(continuity.content, /явно выбрал другой голос|переключ/i);
  assert.match(continuity.content, /другие карточки|другие персонажи|других персонажей/i);

  assert.ok(longForm);
  assert.match(longForm.content, /нов(ое|ый) действие|нов(ая|ую) реплик|нов(ое|ый) последств/i);
  assert.match(longForm.content, /не.*кажд(ый|ом).*абзац|не.*механическ/i);

  assert.ok(address);
  assert.match(address.content, /дрочер/i);
  assert.match(address.content, /свеж.*не использовать|явн.*не использовать/i);

  assert.ok(scope);
  assert.match(scope.content, /точн.*услов|локальн.*дефицит/i);
  assert.match(scope.content, /положительн.*одобр|живое одобрение/i);
  assert.match(scope.content, /исправим.*упущ|проверяем.*действ/i);

  assert.ok(entries.length >= 14);
});

test('canonical migration upgrades Darya-owned fields but preserves local extensions and chat identity', () => {
  const existing = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    avatar: 'Darya.png',
    chat: 'KEEP_CHAT',
    data: {
      name: 'Дарья',
      description: 'OLD_DESCRIPTION',
      personality: 'OLD_PERSONALITY',
      scenario: 'OLD_SCENARIO',
      first_mes: 'OLD_FIRST',
      mes_example: 'OLD_EXAMPLES',
      system_prompt: 'OLD_SYSTEM',
      post_history_instructions: 'OLD_POST',
      alternate_greetings: ['OLD_GREETING'],
      tags: ['OLD_TAG'],
      creator: 'OLD_CREATOR',
      character_version: 'DARYA_ST_V1',
      extensions: {
        fav: true,
        custom_local_extension: { keep: 1 },
        depth_prompt: { prompt: 'OLD_DEPTH', depth: 9, role: 'system' },
      },
    },
  };

  const canonical = buildDaryaCharacter({ revision, sourceMirrored: true });
  const world = buildDaryaWorldInfo({ revision, sourceMirrored: true });
  const patched = mergeDaryaCanonicalProfile(existing, canonical, world, {
    revision,
    sourceMirrored: true,
  });

  assert.equal(patched.avatar, 'Darya.png');
  assert.equal(patched.chat, 'KEEP_CHAT');
  assert.equal(patched.data.name, 'Дарья');
  assert.equal(patched.data.description, canonical.data.description);
  assert.equal(patched.data.personality, canonical.data.personality);
  assert.equal(patched.data.scenario, canonical.data.scenario);
  assert.equal(patched.data.first_mes, canonical.data.first_mes);
  assert.equal(patched.data.mes_example, canonical.data.mes_example);
  assert.equal(patched.data.system_prompt, canonical.data.system_prompt);
  assert.equal(patched.data.post_history_instructions, canonical.data.post_history_instructions);
  assert.deepEqual(patched.data.alternate_greetings, canonical.data.alternate_greetings);
  assert.deepEqual(patched.data.tags, canonical.data.tags);
  assert.equal(patched.data.character_version, 'DARYA_ST_V4_GITHUB_CANON');
  assert.equal(patched.data.extensions.fav, true);
  assert.deepEqual(patched.data.extensions.custom_local_extension, { keep: 1 });
  assert.equal(patched.data.extensions.world, 'Darya');
  assert.equal(patched.data.extensions.darya_speech_passport_id, 'DARYA_SPEECH_PASSPORT_2026_09_12_R4');
  assert.equal(patched.data.extensions.darya_corpus_id, 'DARYA_SPEECH_CORPUS_2026_09_07_R6_ALL5_FORENSIC_AUDIT');
  assert.equal(patched.data.extensions.darya_nemo_profile_binding, 'independent');
  assert.equal(patched.data.extensions.depth_prompt.prompt, canonical.data.extensions.depth_prompt.prompt);
  assert.equal(patched.data.character_book.name, 'Darya');
  assert.ok(patched.data.character_book.entries.length >= 12);
});
