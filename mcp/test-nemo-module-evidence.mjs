import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { verifiedModuleEvidence } from './nemo-module-evidence.mjs';

const text = 'verified compiled instruction text';
const manifest = () => ({
  schemaVersion: 'nemo-chatgpt-runtime-emission/v1',
  profile: { character_id: '100001' },
  instructionChars: Array.from(text).length,
  instructionSha256: createHash('sha256').update(text).digest('hex'),
  orderedEmittedIds: ['v11-176-nsfw-dirty-talk', 'v11-639-fetish-humiliation'],
  omittedModules: [{ id: 'v11-999-marker', reason: 'omitted-host-marker' }],
});

test('module audit contains emitted ids, omission reasons, bound SHA, and no source text', () => {
  const result = verifiedModuleEvidence(manifest(), text);
  assert.deepEqual(result.emittedModuleIds, ['v11-176-nsfw-dirty-talk', 'v11-639-fetish-humiliation']);
  assert.deepEqual(result.omittedModules, [{ id: 'v11-999-marker', reason: 'omitted-host-marker' }]);
  assert.equal(result.instructionsSha256, manifest().instructionSha256);
  assert.equal(result.externalSexSkills, 'not-attached');
  assert.equal(JSON.stringify(result).includes(text), false);
});
test('audit rejects a forged or stale instruction SHA', () => {
  assert.throws(() => verifiedModuleEvidence(manifest(), text+'!'), /does not match/);
});
test('audit rejects unstructured, duplicated or missing module records', () => {
  assert.throws(() => verifiedModuleEvidence({...manifest(), orderedEmittedIds: null}, text), /missing module/);
  assert.throws(() => verifiedModuleEvidence({...manifest(), omittedModules:[{id:'v11-176-nsfw-dirty-talk',reason:'test'}]}, text), /Duplicate/);
});
