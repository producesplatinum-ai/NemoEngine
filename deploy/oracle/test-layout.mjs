import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const text = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const compose = text('compose.yaml');
const dockerfile = text('Dockerfile');
const env = text('.env.example');
const docs = text('README.md');

// Tests describe the storage/security contract; they are NOT a live Oracle deployment.
test('services include official SillyTavern image and Node 22 gateway', () => {
  assert.match(compose, /ghcr\.io\/sillytavern\/sillytavern:latest/);
  assert.match(compose, /dockerfile:\s*deploy\/oracle\/Dockerfile/);
  assert.match(dockerfile, /FROM node:22-alpine/);
  assert.match(dockerfile, /CMD\s*\["node",\s*"mcp\/sillytavern-server\.mjs"\]/);
});
test('application ports are loopback-only, never publicly exposed by default', () => {
  assert.match(compose, /127\.0\.0\.1:8000:8000/);
  assert.match(compose, /127\.0\.0\.1:8790:8790/);
  assert.doesNotMatch(compose, /^\s*-\s*["']?(?:0\.0\.0\.0:)?(?:8000|8790):(?:8000|8790)/m);
});
test('gateway uses Docker DNS and not Railway internal routing', () => {
  assert.match(compose, /SILLYTAVERN_URL:\s*http:\/\/sillytavern:8000/);
  assert.doesNotMatch(compose, /railway\.internal|RAILWAY_ENVIRONMENT_ID/);
});
test('data, world info, config, plugins and backups are bind-mounted', () => {
  for (const directory of ['config', 'data', 'plugins', 'extensions', 'backups']) {
    assert.ok(compose.includes(`./state/${directory}:/home/node/app/${directory}`) ||
      (directory === 'extensions' && compose.includes('./state/extensions:/home/node/app/public/scripts/extensions/third-party')));
  }
});
test('example env has no real provider secrets and docs require private backups', () => {
  assert.match(env, /ST_BASIC_AUTH_USERNAME=/);
  assert.match(env, /ST_BASIC_AUTH_PASSWORD=/);
  assert.doesNotMatch(env, /sk-(?:proj-|or-)|github_pat_|ghp_[A-Za-z0-9]/);
  assert.match(docs, /не сохраняй.+секрет/i);
  assert.match(docs, /Tailscale/);
});
