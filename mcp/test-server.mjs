import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import {
  buildMcpServer,
  buildRunSpec,
  MCP_ENDPOINT_PATH,
  resolveRunPaths,
  RUNS_ROOT,
  startHttpServer,
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

test('MCP server factory constructs without side effects', () => {
  const server = buildMcpServer();
  assert.ok(server);
});

test('HTTP server exposes health endpoint', async (t) => {
  const httpServer = startHttpServer({ port: 0, host: '127.0.0.1' });
  await once(httpServer, 'listening');

  t.after(
    () =>
      new Promise((resolvePromise, rejectPromise) => {
        httpServer.close((error) => {
          if (error) rejectPromise(error);
          else resolvePromise();
        });
      }),
  );

  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');

  const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: 'nemoengine-mcp',
  });
});
