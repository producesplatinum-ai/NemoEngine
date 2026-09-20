#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cp,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const AUDITED_REF = 'b988a06eedb24b916182d0b5d545eb9a2dbabe02';

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function mutateJson(filePath, mutate, verify) {
  const original = await readFile(filePath, 'utf8');
  try {
    const value = JSON.parse(original);
    mutate(value);
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await verify();
  } finally {
    await writeFile(filePath, original, 'utf8');
  }
}

test('fidelity verifier fails closed for provenance and binding mutations', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'nemo-fidelity-negative-'));
  const fixture = path.join(parent, 'fixture');
  const add = run('git', ['worktree', 'add', '--force', '--detach', fixture, AUDITED_REF], ROOT);
  assert.equal(add.status, 0, add.stderr);

  try {
    await cp(
      path.join(ROOT, 'audit', 'nemo-static-evidence'),
      path.join(fixture, 'audit', 'nemo-static-evidence'),
      { recursive: true },
    );
    await cp(
      path.join(ROOT, 'scripts', 'verify-nemo-fidelity.mjs'),
      path.join(fixture, 'scripts', 'verify-nemo-fidelity.mjs'),
    );

    const evidencePath = path.join(
      fixture,
      'audit',
      'nemo-static-evidence',
      'provenance',
      'excerpts.json',
    );
    const guardsPath = path.join(
      fixture,
      'audit',
      'nemo-static-evidence',
      'fidelity-guard.json',
    );
    const verify = () => run(process.execPath, ['scripts/verify-nemo-fidelity.mjs'], fixture);
    const expectFailure = (needle) => {
      const result = verify();
      assert.notEqual(result.status, 0, 'mutation unexpectedly passed');
      assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(needle, 'u'));
    };

    const baseline = verify();
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(JSON.parse(baseline.stdout).status, 'STRUCTURAL_PROVENANCE_PASS');

    await mutateJson(
      evidencePath,
      (document) => {
        document.ref = '0000000000000000000000000000000000000000';
      },
      () => expectFailure('excerpts\\.ref'),
    );
    await mutateJson(
      evidencePath,
      (document) => {
        document.excerpts[0].blob_sha = '0000000000000000000000000000000000000000';
      },
      () => expectFailure('pinned_path_blob'),
    );
    await mutateJson(
      evidencePath,
      (document) => {
        document.excerpts.find((entry) => entry.evidence_id === 'src-courier').json_pointer =
          '/999/content';
      },
      () => expectFailure('src-courier\\.literal_match'),
    );
    await mutateJson(
      evidencePath,
      (document) => {
        document.excerpts.find(
          (entry) => entry.evidence_id === 'runtime-family-candidates',
        ).symbol = 'wrongSymbol';
      },
      () => expectFailure('FG-C002\\.runtime_symbol'),
    );
    await mutateJson(
      evidencePath,
      (document) => {
        document.excerpts.find((entry) => entry.evidence_id === 'src-courier').module_identifier =
          'wrong-module';
      },
      () => expectFailure('src-courier\\.source_identifier'),
    );
    await mutateJson(
      guardsPath,
      (guards) => {
        guards[0].dynamic_test_required = 'yes';
      },
      () => expectFailure('FG-C002\\.dynamic_boolean'),
    );
    await mutateJson(
      evidencePath,
      (document) => {
        document.excerpts.find(
          (entry) => entry.evidence_id === 'runtime-rewrite-372',
        ).template_value_sha256 = '0'.repeat(64);
      },
      () => expectFailure('template_value_sha256'),
    );
    await mutateJson(
      evidencePath,
      (document) => {
        const regex = document.excerpts.find((entry) => entry.evidence_id === 'regex-31');
        regex.excerpt = '/never-match/g';
        regex.excerpt_sha256 = sha256(regex.excerpt);
      },
      () => expectFailure('canonical_regex'),
    );

    const runtimePath = path.join(fixture, 'scripts', 'nemo-chatgpt-runtime.mjs');
    const runtimeBackup = path.join(fixture, 'scripts', 'nemo-chatgpt-runtime.backup');
    await rename(runtimePath, runtimeBackup);
    try {
      await symlink(path.basename(runtimeBackup), runtimePath);
      expectFailure('scripts/nemo-chatgpt-runtime\\.mjs\\.regular');
    } finally {
      await unlink(runtimePath);
      await rename(runtimeBackup, runtimePath);
    }
  } finally {
    const remove = run('git', ['worktree', 'remove', '--force', fixture], ROOT);
    if (remove.status !== 0) await rm(fixture, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
    run('git', ['worktree', 'prune'], ROOT);
  }
});
