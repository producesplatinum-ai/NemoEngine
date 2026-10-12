import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(execFileSync('docker', ['compose', '-f', path.join(dirname, 'compose.yaml'), '--project-directory', dirname, 'config', '--format', 'json'], { encoding: 'utf8' }));

for (const name of ['sillytavern', 'sillytavern-mcp', 'nemoengine-mcp']) {
  test(`${name} publishes only to local loopback`, () => {
    const svc = spec.services[name];
    assert.ok(svc, `missing service: ${name}`);
    assert.ok(svc.ports.length > 0);
    for (const port of svc.ports) {
      assert.equal(port.host_ip, '127.0.0.1', `publicly exposed ${name}:${port.target}`);
    }
    assert.equal(svc.restart, 'unless-stopped');
    assert.ok(svc.healthcheck);
  });
}

test('critical SillyTavern state survives replacement of the app container', () => {
  const svc = spec.services.sillytavern;
  for (const target of ['config', 'data', 'plugins', 'backups', 'public/scripts/extensions/third-party']) {
    assert.ok(svc.volumes.some(v => v.target === `/home/node/app/${target}`), `missing mounted ${target}`);
  }
});

test('Nemo compiler and SillyTavern gateway share the built image, not app data', () => {
  const gateway = spec.services['sillytavern-mcp'];
  const nemo = spec.services['nemoengine-mcp'];
  assert.equal(gateway.image, nemo.image);
  assert.equal(gateway.environment.SILLYTAVERN_URL, 'http://sillytavern:8000');
  assert.equal(gateway.command.join(' '), 'node mcp/sillytavern-server.mjs');
  assert.equal(nemo.command.join(' '), 'node mcp/server.mjs');
  assert.ok(!(gateway.volumes || []).some(v => v.source.includes('sillytavern/data')));
});
