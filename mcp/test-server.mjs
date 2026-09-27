import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRunSpec,
  MCP_ENDPOINT_PATH,
  resolveRunPaths,
  RUNS_ROOT,
} from './server.mjs';

test('buildRunSpec preserves omitted selection families', () => {
  const spec = buildRunSpec({
    mode: 'generate',
    request: 'exact task',
    deliveryUnitChars: 8000,
    profile: 100001,
    maxPortableChars: 170000,
    selections: {
      groups: [{ group: 'Narrate-Language', selector: 'Narrate: Russian' }],
      enable: ['Character Friction'],
      disable: [],
    },
    allowNonPortable: [],
  });

  assert.equal(spec.schemaVersion, 'nemo-chatgpt-run-spec/v2');
  assert.equal(spec.task.request, 'exact task');
  assert.equal(spec.profile, 100001);
  assert.deepEqual(spec.selections.groups, [
    { group: 'Narrate-Language', selector: 'Narrate: Russian' },
  ]);
  assert.deepEqual(spec.selections.enable, ['Character Friction']);
  assert.equal(Object.hasOwn(spec.selections, 'nsfw'), false);
  assert.equal(Object.hasOwn(spec.selections, 'fetish'), false);
  assert.equal(Object.hasOwn(spec.selections, 'vex'), false);
});

test('buildRunSpec includes explicit empty families so they can clear defaults', () => {
  const spec = buildRunSpec({
    mode: 'inspect',
    request: 'inspect',
    deliveryUnitChars: 2000,
    profile: 100001,
    maxPortableChars: 170000,
    selections: {
      nsfw: [],
      fetish: [],
    },
    allowNonPortable: [],
  });

  assert.deepEqual(spec.selections.nsfw, []);
  assert.deepEqual(spec.selections.fetish, []);
});

test('resolveRunPaths accepts UUIDv4 and stays under managed root', () => {
  const paths = resolveRunPaths('123e4567-e89b-42d3-a456-426614174000');
  assert.ok(paths.parent.startsWith(`${RUNS_ROOT}/`));
  assert.ok(paths.run.endsWith('/run'));
  assert.ok(paths.spec.endsWith('/run-spec.json'));
});

test('resolveRunPaths rejects path-like identifiers', () => {
  assert.throws(() => resolveRunPaths('../../tmp/escape'), /Invalid runId/);
});

test('MCP endpoint defaults to /mcp and always ends with /mcp', () => {
  assert.ok(MCP_ENDPOINT_PATH.endsWith('/mcp'));
});
