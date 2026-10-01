import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { runDaryaUrlImportJobs } from './import-darya-url-jobs.mjs';

test('URL importer downloads, verifies, and writes one source file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darya-url-import-'));
  const body = Buffer.from('exact private bytes');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const calls = [];

  const result = await runDaryaUrlImportJobs({
    root,
    jobsJson: JSON.stringify([{
      url: 'https://private.example.test/file',
      path: 'assets/test.bin',
      sha256,
      size: body.length,
    }]),
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(body, { status: 200 });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 0);
  assert.equal(fs.readFileSync(path.join(root, 'assets/test.bin')).equals(body), true);
});

test('URL importer skips an already-correct destination without fetching again', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darya-url-import-'));
  const body = Buffer.from('already there');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const target = path.join(root, 'assets/test.bin');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);

  let fetched = false;
  const result = await runDaryaUrlImportJobs({
    root,
    jobsJson: JSON.stringify([{
      url: 'https://private.example.test/file',
      path: 'assets/test.bin',
      sha256,
      size: body.length,
    }]),
    fetchImpl: async () => {
      fetched = true;
      throw new Error('must not fetch');
    },
  });

  assert.equal(fetched, false);
  assert.equal(result.imported, 0);
  assert.equal(result.skipped, 1);
});

test('URL importer rejects traversal, non-https URLs, size mismatch, and digest mismatch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'darya-url-import-'));
  const body = Buffer.from('abc');
  const sha256 = createHash('sha256').update(body).digest('hex');

  await assert.rejects(
    runDaryaUrlImportJobs({
      root,
      jobsJson: JSON.stringify([{ url:'https://x.test/a', path:'../x', sha256, size:3 }]),
      fetchImpl: async () => new Response(body, { status:200 }),
    }),
    /path|traversal/i,
  );

  await assert.rejects(
    runDaryaUrlImportJobs({
      root,
      jobsJson: JSON.stringify([{ url:'http://x.test/a', path:'x', sha256, size:3 }]),
      fetchImpl: async () => new Response(body, { status:200 }),
    }),
    /https/i,
  );

  await assert.rejects(
    runDaryaUrlImportJobs({
      root,
      jobsJson: JSON.stringify([{ url:'https://x.test/a', path:'x', sha256, size:99 }]),
      fetchImpl: async () => new Response(body, { status:200 }),
    }),
    /size/i,
  );

  await assert.rejects(
    runDaryaUrlImportJobs({
      root,
      jobsJson: JSON.stringify([{ url:'https://x.test/a', path:'x', sha256:'0'.repeat(64), size:3 }]),
      fetchImpl: async () => new Response(body, { status:200 }),
    }),
    /sha256/i,
  );
});
