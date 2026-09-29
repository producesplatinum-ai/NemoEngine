import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildDaryaCharacter,
  buildDaryaWorldInfo,
  shouldRefreshDarya,
  syncBundledDaryaSource,
  syncDaryaSourceFromHttp,
  writeTextIfChanged,
  resolveDaryaAvatarPath,
  mergeDaryaWorldLink,
  mergeDaryaCanonicalProfile,
  verifyLocalDaryaSource,
  getDaryaCardBasePng,
  seedDarya,
} from './seed-darya.mjs';

const revision = '36e967df9f7524ca862bf380087f0ea0494daaad';

test('buildDaryaCharacter creates a linked chara_card_v3 Darya card', () => {
  const card = buildDaryaCharacter({ revision });

  assert.equal(card.spec, 'chara_card_v3');
  assert.equal(card.spec_version, '3.0');
  assert.equal(card.data.name, 'Дарья');
  assert.equal(card.data.character_version, 'DARYA_ST_V2_GITHUB_CANON');
  assert.equal(card.data.tags.includes('NemoEngine'), false);
  assert.equal(card.data.tags.includes('adult'), false);
  assert.equal(card.data.tags.includes('humiliation'), false);
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
    'Darya practice execution lock',
    'Darya source provenance',
  ]) {
    assert.ok(comments.has(required), `missing lore entry: ${required}`);
  }

  assert.ok(entries.some(x => x.constant === true));
  assert.ok(entries.some(x => Array.isArray(x.key) && x.key.includes('NemoEngine')));
  assert.ok(entries.some(x => String(x.content).includes(revision)));
});

test('shouldRefreshDarya refreshes on source or card revision changes', () => {
  assert.equal(shouldRefreshDarya(null, revision, 'card-v2'), true);
  assert.equal(
    shouldRefreshDarya({ revision, cardRevision: 'card-v2' }, revision, 'card-v2'),
    false,
  );
  assert.equal(
    shouldRefreshDarya({ revision: 'older', cardRevision: 'card-v2' }, revision, 'card-v2'),
    true,
  );
  assert.equal(
    shouldRefreshDarya({ revision, cardRevision: 'card-v1' }, revision, 'card-v2'),
    true,
  );
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


test('syncDaryaSourceFromHttp downloads a bearer-protected snapshot and verifies SHA256', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darya-http-source-'));
  const destination = path.join(root, 'persistent', 'darya-source');
  const files = new Map([
    ['SKILL.md', Buffer.from('# Darya HTTP source')],
    ['references/darya-core.md', Buffer.from('# core')],
    ['assets/darya-face/primary-static.jpeg', Buffer.from('avatar')],
  ]);
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const manifest = {
    schemaVersion: 'darya-source-manifest/v1',
    revision,
    files: [...files].map(([filePath, bytes]) => ({
      path: filePath,
      size: bytes.length,
      sha256: sha256(bytes),
    })),
  };

  const server = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer source-secret') {
      res.statusCode = 401;
      res.end('unauthorized');
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/source-manifest') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(manifest));
      return;
    }

    if (url.pathname === '/source-file') {
      const filePath = url.searchParams.get('path') || '';
      const bytes = files.get(filePath);
      if (!bytes) {
        res.statusCode = 404;
        res.end('missing');
        return;
      }
      res.setHeader('x-darya-source-sha256', sha256(bytes));
      res.end(bytes);
      return;
    }

    res.statusCode = 404;
    res.end('missing');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const result = await syncDaryaSourceFromHttp({
    sourceDir: destination,
    revision,
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: 'source-secret',
  });

  assert.equal(result, revision);
  assert.equal(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8'), '# Darya HTTP source');
  assert.equal(fs.readFileSync(path.join(destination, 'references', 'darya-core.md'), 'utf8'), '# core');
  assert.equal(fs.readFileSync(path.join(destination, 'assets', 'darya-face', 'primary-static.jpeg'), 'utf8'), 'avatar');
});

test('syncDaryaSourceFromHttp fails closed on a digest mismatch and preserves old snapshot', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darya-http-digest-'));
  const destination = path.join(root, 'persistent', 'darya-source');
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'KEEP.txt'), 'old snapshot');

  const expected = Buffer.from('expected');
  const manifest = {
    schemaVersion: 'darya-source-manifest/v1',
    revision,
    files: [{
      path: 'SKILL.md',
      size: expected.length,
      sha256: createHash('sha256').update(expected).digest('hex'),
    }],
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/source-manifest') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(manifest));
      return;
    }
    if (url.pathname === '/source-file') {
      res.end(Buffer.from('tampered'));
      return;
    }
    res.statusCode = 404;
    res.end('missing');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const address = server.address();
  assert.ok(address && typeof address === 'object');

  await assert.rejects(
    syncDaryaSourceFromHttp({
      sourceDir: destination,
      revision,
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: '',
    }),
    /mismatch/i,
  );

  assert.equal(fs.readFileSync(path.join(destination, 'KEEP.txt'), 'utf8'), 'old snapshot');
});


test('buildDaryaCharacter marks a deferred source mirror without falsely claiming a completed copy', () => {
  const card = buildDaryaCharacter({ revision, sourceMirrored: false });

  assert.equal(card.data.extensions.darya_source_mirrored, false);
  assert.match(card.data.creator_notes, /pending|deferred|ожида/i);
  assert.doesNotMatch(card.data.creator_notes, /Full working tree mirrored/);
  assert.doesNotMatch(card.data.description, /полный source mirror хранится/i);
  assert.match(card.data.description, /pending|deferred|ожида/i);
});

test('buildDaryaWorldInfo records deferred source-mirror state explicitly', () => {
  const book = buildDaryaWorldInfo({ revision, sourceMirrored: false });
  const provenance = Object.values(book.entries).find((x) => x.comment === 'Darya source provenance');

  assert.ok(provenance);
  assert.match(provenance.content, /pending|deferred|ожида/i);
});


test('resolveDaryaAvatarPath falls back to SillyTavern default avatar when private source is unavailable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darya-avatar-test-'));
  const fallback = path.join(dir, 'ai4.png');
  fs.writeFileSync(fallback, 'x');

  const resolved = resolveDaryaAvatarPath({
    sourceDir: path.join(dir, 'missing-source'),
    fallbackAvatarPath: fallback,
  });

  assert.equal(resolved, fallback);
});


test('mergeDaryaWorldLink preserves an existing Darya card while linking the Darya lorebook', () => {
  const existing = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Дарья',
      description: 'KEEP_DESCRIPTION',
      personality: 'KEEP_PERSONALITY',
      system_prompt: 'KEEP_SYSTEM_PROMPT',
      post_history_instructions: 'KEEP_POST_HISTORY',
      character_version: 'DARYA_ST_V1',
      extensions: {
        talkativeness: 0.72,
        fav: false,
        world: '',
        depth_prompt: { prompt: 'KEEP_DEPTH', depth: 4, role: 'system' },
      },
      character_book: { name: 'Old', entries: [{ id: 999, content: 'OLD' }] },
    },
  };
  const world = buildDaryaWorldInfo({ revision, sourceMirrored: false });

  const patched = mergeDaryaWorldLink(existing, world);

  assert.equal(patched.data.name, 'Дарья');
  assert.equal(patched.data.description, 'KEEP_DESCRIPTION');
  assert.equal(patched.data.personality, 'KEEP_PERSONALITY');
  assert.equal(patched.data.system_prompt, 'KEEP_SYSTEM_PROMPT');
  assert.equal(patched.data.post_history_instructions, 'KEEP_POST_HISTORY');
  assert.equal(patched.data.character_version, 'DARYA_ST_V1');
  assert.equal(patched.data.extensions.talkativeness, 0.72);
  assert.equal(patched.data.extensions.depth_prompt.prompt, 'KEEP_DEPTH');
  assert.equal(patched.data.extensions.world, 'Darya');
  assert.equal(patched.data.character_book.name, 'Darya');
  assert.equal(patched.data.character_book.entries.length, 9);
});



test('mergeDaryaCanonicalProfile upgrades GitHub-owned voice fields while preserving local extensions', () => {
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
  assert.equal(patched.data.system_prompt, canonical.data.system_prompt);
  assert.equal(patched.data.post_history_instructions, canonical.data.post_history_instructions);
  assert.deepEqual(patched.data.alternate_greetings, canonical.data.alternate_greetings);
  assert.deepEqual(patched.data.tags, canonical.data.tags);
  assert.equal(patched.data.character_version, 'DARYA_ST_V2_GITHUB_CANON');
  assert.equal(patched.data.extensions.fav, true);
  assert.deepEqual(patched.data.extensions.custom_local_extension, { keep: 1 });
  assert.equal(patched.data.extensions.world, 'Darya');
  assert.equal(patched.data.extensions.depth_prompt.prompt, canonical.data.extensions.depth_prompt.prompt);
  assert.equal(patched.data.character_book.name, 'Darya');
  assert.ok(patched.data.character_book.entries.length >= 10);
});

test('verifyLocalDaryaSource accepts a complete manifest-backed local mirror and rejects tampering', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darya-local-mirror-'));
  const files = new Map([
    ['SKILL.md', Buffer.from('# skill')],
    ['references/darya-core.md', Buffer.from('# core')],
    ['assets/darya-face/primary-static.jpeg', Buffer.from('avatar')],
  ]);

  for (const [relativePath, bytes] of files) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }

  const manifest = [...files]
    .map(([relativePath, bytes]) =>
      `${createHash('sha256').update(bytes).digest('hex')}  ./${relativePath}`
    )
    .join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'SOURCE_MANIFEST.sha256'), manifest);

  const ok = verifyLocalDaryaSource({ sourceDir: root, revision });
  assert.equal(ok.ok, true);
  assert.equal(ok.revision, revision);
  assert.equal(ok.manifestEntries, 3);
  assert.equal(ok.fileCount, 4);

  fs.writeFileSync(path.join(root, 'references', 'darya-core.md'), '# tampered');
  const bad = verifyLocalDaryaSource({ sourceDir: root, revision });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /mismatch/i);
});

test('mergeDaryaWorldLink can mark an existing card as fully mirrored without overwriting custom voice fields', () => {
  const existing = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Дарья',
      description: 'KEEP_DESCRIPTION',
      system_prompt: 'KEEP_SYSTEM_PROMPT',
      creator_notes: 'KEEP_NOTES',
      extensions: {
        world: '',
        darya_source_mirrored: false,
        darya_source_revision: 'old',
      },
    },
  };
  const world = buildDaryaWorldInfo({ revision, sourceMirrored: true });

  const patched = mergeDaryaWorldLink(existing, world, {
    revision,
    sourceMirrored: true,
  });

  assert.equal(patched.data.description, 'KEEP_DESCRIPTION');
  assert.equal(patched.data.system_prompt, 'KEEP_SYSTEM_PROMPT');
  assert.equal(patched.data.creator_notes, 'KEEP_NOTES');
  assert.equal(patched.data.extensions.world, 'Darya');
  assert.equal(patched.data.extensions.darya_source_revision, revision);
  assert.equal(patched.data.extensions.darya_source_mirrored, true);
});


test('getDaryaCardBasePng preserves an existing PNG card without decoding the mirrored JPEG', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darya-avatar-envelope-'));
  const sourceDir = path.join(root, 'source');
  const avatarPath = path.join(
    sourceDir,
    'assets',
    'darya-face',
    'primary-static.jpeg',
  );
  const existingCharacterPath = path.join(root, 'Darya.png');
  fs.mkdirSync(path.dirname(avatarPath), { recursive: true });

  // The mirrored visual source may be JPEG; the card update must not decode it.
  fs.writeFileSync(avatarPath, Buffer.from('canonical-jpeg-bytes'));

  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  fs.writeFileSync(existingCharacterPath, onePixelPng);

  const png = await getDaryaCardBasePng(sourceDir, existingCharacterPath);
  assert.equal(Buffer.isBuffer(png), true);
  assert.equal(png.equals(onePixelPng), true);
});

test('seedDarya builds a card from a local avatar without network fetch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darya-local-avatar-'));
  const sourceDir = path.join(root, 'darya-source');
  const userDataDir = path.join(root, 'user-data');
  const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );

  fs.mkdirSync(path.join(sourceDir, 'assets', 'darya-face'), { recursive: true });
  const files = new Map([
    ['SKILL.md', Buffer.from('# local skill')],
    ['assets/darya-face/primary-static.jpeg', tinyPng],
  ]);

  for (const [relativePath, bytes] of files) {
    const target = path.join(sourceDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }

  const manifest = [...files]
    .map(([relativePath, bytes]) =>
      `${createHash('sha256').update(bytes).digest('hex')}  ./${relativePath}`
    )
    .join('\n') + '\n';
  fs.writeFileSync(path.join(sourceDir, 'SOURCE_MANIFEST.sha256'), manifest);

  const result = await seedDarya({
    userDataDir,
    sourceDir,
    revision: 'test-local-avatar-revision',
  });

  assert.equal(result.sourceMirrored, true);
  const characterPath = path.join(userDataDir, 'characters', 'Darya.png');
  assert.equal(fs.existsSync(characterPath), true);
  const bytes = fs.readFileSync(characterPath);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
