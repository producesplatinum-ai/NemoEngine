import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildDaryaCharacter,
  buildDaryaWorldInfo,
  shouldRefreshDarya,
  syncBundledDaryaSource,
  writeTextIfChanged,
} from './seed-darya.mjs';

const revision = '36e967df9f7524ca862bf380087f0ea0494daaad';

test('buildDaryaCharacter creates a linked chara_card_v3 Darya card', () => {
  const card = buildDaryaCharacter({ revision });

  assert.equal(card.spec, 'chara_card_v3');
  assert.equal(card.spec_version, '3.0');
  assert.equal(card.data.name, 'Darya');
  assert.equal(card.data.extensions.world, 'Darya');
  assert.equal(card.data.extensions.darya_source_revision, revision);
  assert.match(card.data.system_prompt, /русск/i);
  assert.match(card.data.post_history_instructions, /продолж/i);
  assert.ok(card.data.first_mes.length > 20);
});

test('buildDaryaWorldInfo contains the required GitHub-backed behavior layers', () => {
  const book = buildDaryaWorldInfo({ revision });
  const entries = Object.values(book.entries);
  const comments = new Set(entries.map(x => x.comment));

  for (const required of [
    'Darya core voice',
    'Darya speech mechanics',
    'Darya evidence boundary',
    'Darya visual identity',
    'Darya adult routing',
    'Darya causal humiliation',
    'Darya NemoEngine bridge',
    'Darya correction and continuation',
    'Darya source provenance',
  ]) {
    assert.ok(comments.has(required), `missing lore entry: ${required}`);
  }

  assert.ok(entries.some(x => x.constant === true));
  assert.ok(entries.some(x => Array.isArray(x.key) && x.key.includes('NemoEngine')));
  assert.ok(entries.some(x => String(x.content).includes(revision)));
});

test('shouldRefreshDarya refreshes on source revision changes only', () => {
  assert.equal(shouldRefreshDarya(null, revision), true);
  assert.equal(shouldRefreshDarya({ revision }, revision), false);
  assert.equal(shouldRefreshDarya({ revision: 'older' }, revision), true);
});

test('writeTextIfChanged is additive and does not rewrite identical existing content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darya-seed-test-'));
  const file = path.join(dir, 'Darya.json');

  assert.equal(writeTextIfChanged(file, '{"a":1}'), true);
  const firstMtime = fs.statSync(file).mtimeMs;
  assert.equal(writeTextIfChanged(file, '{"a":1}'), false);
  assert.equal(fs.statSync(file).mtimeMs, firstMtime);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
});


test('syncBundledDaryaSource copies a complete private-repo snapshot without git credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darya-bundled-source-'));
  const bundled = path.join(root, 'bundled');
  const destination = path.join(root, 'persistent', 'darya-source');

  fs.mkdirSync(path.join(bundled, 'assets', 'darya-face'), { recursive: true });
  fs.mkdirSync(path.join(bundled, 'references'), { recursive: true });
  fs.writeFileSync(path.join(bundled, 'SKILL.md'), '# Darya bundled source');
  fs.writeFileSync(path.join(bundled, 'references', 'darya-core.md'), '# core');
  fs.writeFileSync(path.join(bundled, 'assets', 'darya-face', 'primary-static.jpeg'), 'avatar');

  const result = syncBundledDaryaSource({
    bundledSourceDir: bundled,
    sourceDir: destination,
    revision,
  });

  assert.equal(result, revision);
  assert.equal(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8'), '# Darya bundled source');
  assert.equal(fs.readFileSync(path.join(destination, 'references', 'darya-core.md'), 'utf8'), '# core');
  assert.equal(fs.readFileSync(path.join(destination, 'assets', 'darya-face', 'primary-static.jpeg'), 'utf8'), 'avatar');
  assert.equal(fs.existsSync(path.join(destination, '.git')), false);
});
