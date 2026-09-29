import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  sanitizeRelativePath,
  isAuthorized,
  writeUploadedFile,
} from './darya-source-import.mjs';

test('sanitizeRelativePath accepts nested repository paths', () => {
  assert.equal(
    sanitizeRelativePath('references/darya-core.md'),
    'references/darya-core.md',
  );
});

test('sanitizeRelativePath rejects traversal and absolute paths', () => {
  for (const value of ['../x', 'a/../../x', '/etc/passwd', 'C:\\x', '', '.']) {
    assert.throws(() => sanitizeRelativePath(value));
  }
});

test('isAuthorized requires exact strong bearer token', () => {
  const token = '0123456789abcdef0123456789abcdef';
  assert.equal(isAuthorized(`Bearer ${token}`, token), true);
  assert.equal(isAuthorized('Bearer wrong', token), false);
  assert.equal(isAuthorized('', token), false);
  assert.equal(isAuthorized(`Bearer ${token}`, ''), false);
});

test('writeUploadedFile verifies sha256 and writes atomically below root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darya-import-'));
  const body = Buffer.from('hello darya');
  const sha256 = createHash('sha256').update(body).digest('hex');

  const result = writeUploadedFile({
    root,
    relativePath: 'runtime/test.txt',
    body,
    expectedSha256: sha256,
  });

  assert.equal(result.sha256, sha256);
  assert.equal(result.size, body.length);
  assert.equal(fs.readFileSync(path.join(root, 'runtime/test.txt'), 'utf8'), 'hello darya');
});

test('writeUploadedFile rejects digest mismatch and preserves existing file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darya-import-'));
  const target = path.join(root, 'runtime', 'test.txt');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'original');

  assert.throws(() => writeUploadedFile({
    root,
    relativePath: 'runtime/test.txt',
    body: Buffer.from('replacement'),
    expectedSha256: '0'.repeat(64),
  }), /sha256/i);

  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
});
