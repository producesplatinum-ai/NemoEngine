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

function guardRegistryProjection(guards) {
  return guards.map(
    ({
      guard_id,
      affected_module_identifier,
      module_name,
      affected_modules,
      discrepancy_class,
      secondary_classes,
      dynamic_test_required,
      source_semantics_modified,
      confidence,
      source_evidence_id,
      runtime_evidence_id,
      additional_evidence_ids,
      runtime_symbol,
    }) => ({
      guard_id,
      affected_module_identifier,
      module_name,
      affected_modules,
      discrepancy_class,
      secondary_classes,
      dynamic_test_required,
      source_semantics_modified,
      confidence,
      source_evidence_id,
      runtime_evidence_id,
      additional_evidence_ids,
      runtime_symbol,
    }),
  );
}

function replaceHashConstant(source, name, digest) {
  const prefix = `const ${name} =\n  '`;
  const start = source.indexOf(prefix);
  assert.notEqual(start, -1, `constant not found: ${name}`);
  const digestStart = start + prefix.length;
  assert.match(source.slice(digestStart, digestStart + 64), /^[a-f0-9]{64}$/u);
  assert.equal(source.slice(digestStart + 64, digestStart + 66), "';");
  return `${source.slice(0, digestStart)}${digest}${source.slice(digestStart + 64)}`;
}

async function resealFixture({ evidencePath, guardsPath, manifestPath, verifierPath }) {
  const evidenceText = await readFile(evidencePath, 'utf8');
  const guardsText = await readFile(guardsPath, 'utf8');
  const guards = JSON.parse(guardsText);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const registrySha256 = sha256(JSON.stringify(guardRegistryProjection(guards)));
  manifest.guardDocument.sha256 = sha256(guardsText);
  manifest.guardDocument.registrySha256 = registrySha256;
  manifest.provenanceDocument.sha256 = sha256(evidenceText);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestPath, manifestText, 'utf8');

  let verifier = await readFile(verifierPath, 'utf8');
  for (const [name, digest] of [
    ['EVIDENCE_MANIFEST_SHA256', sha256(manifestText)],
    ['GUARD_DOCUMENT_SHA256', sha256(guardsText)],
    ['PROVENANCE_DOCUMENT_SHA256', sha256(evidenceText)],
    ['GUARD_REGISTRY_SHA256', registrySha256],
  ]) {
    verifier = replaceHashConstant(verifier, name, digest);
  }
  await writeFile(verifierPath, verifier, 'utf8');
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

async function withRestoredFiles(filePaths, mutateAndVerify) {
  const originals = new Map();
  for (const filePath of filePaths) originals.set(filePath, await readFile(filePath, 'utf8'));
  try {
    await mutateAndVerify(originals);
  } finally {
    for (const [filePath, original] of originals) {
      await writeFile(filePath, original, 'utf8');
    }
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
    const verifierPath = path.join(fixture, 'scripts', 'verify-nemo-fidelity.mjs');

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
    const manifestPath = path.join(
      fixture,
      'audit',
      'nemo-static-evidence',
      'manifest.json',
    );
    const verify = () => run(process.execPath, ['scripts/verify-nemo-fidelity.mjs'], fixture);
    const expectFailure = (needle) => {
      const result = verify();
      assert.notEqual(result.status, 0, 'mutation unexpectedly passed');
      assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(needle, 'u'));
    };
    const expectOnlyFailures = (...expected) => {
      const result = verify();
      assert.equal(result.status, 1, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.status, 'STRUCTURAL_PROVENANCE_FAIL');
      assert.deepEqual(
        report.failures.map(({ check }) => check).sort(),
        [...expected].sort(),
      );
    };

    const baseline = verify();
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(JSON.parse(baseline.stdout).status, 'STRUCTURAL_PROVENANCE_PASS');

    await mutateJson(
      manifestPath,
      (manifest) => {
        manifest.untrusted_extra_field = true;
      },
      () => expectFailure('documents\\.manifest_sha256'),
    );

    await withRestoredFiles([guardsPath, manifestPath], async (originals) => {
      const guards = JSON.parse(originals.get(guardsPath));
      const manifest = JSON.parse(originals.get(manifestPath));
      guards[0].original_rule += ' coordinated semantic tamper';
      const serializedGuards = `${JSON.stringify(guards, null, 2)}\n`;
      manifest.guardDocument.sha256 = sha256(serializedGuards);
      await writeFile(guardsPath, serializedGuards, 'utf8');
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      expectFailure('documents\\.guard_sha256');
    });

    await withRestoredFiles([evidencePath, manifestPath], async (originals) => {
      const evidence = JSON.parse(originals.get(evidencePath));
      const manifest = JSON.parse(originals.get(manifestPath));
      evidence.evidence_scope += ' coordinated provenance tamper';
      const serializedEvidence = `${JSON.stringify(evidence, null, 2)}\n`;
      manifest.provenanceDocument.sha256 = sha256(serializedEvidence);
      await writeFile(evidencePath, serializedEvidence, 'utf8');
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      expectFailure('documents\\.provenance_sha256');
    });

    await withRestoredFiles(
      [evidencePath, guardsPath, manifestPath, verifierPath],
      async (originals) => {
        const evidence = JSON.parse(originals.get(evidencePath));
        const guards = JSON.parse(originals.get(guardsPath));
        const target = evidence.excerpts.find(
          (entry) => entry.evidence_id === 'runtime-rewrite-372',
        );
        const truncated = target.excerpt.slice(0, -1);
        target.excerpt = truncated;
        target.excerpt_sha256 = sha256(truncated);
        guards.find((guard) => guard.runtime_evidence_id === target.evidence_id).runtime_excerpt =
          truncated;
        const serializedEvidence = `${JSON.stringify(evidence, null, 2)}\n`;
        const serializedGuards = `${JSON.stringify(guards, null, 2)}\n`;
        await writeFile(evidencePath, serializedEvidence, 'utf8');
        await writeFile(guardsPath, serializedGuards, 'utf8');
        await resealFixture({ evidencePath, guardsPath, manifestPath, verifierPath });
        expectOnlyFailures('excerpt.runtime-rewrite-372.template_exact_match');
      },
    );

    await withRestoredFiles(
      [guardsPath, manifestPath, verifierPath],
      async (originals) => {
        const guards = JSON.parse(originals.get(guardsPath));
        const mixed = guards.find((guard) => guard.guard_id === 'FG-C003');
        mixed.module_name = mixed.affected_modules[1].name;
        const serializedGuards = `${JSON.stringify(guards, null, 2)}\n`;
        await writeFile(guardsPath, serializedGuards, 'utf8');
        await resealFixture({ evidencePath, guardsPath, manifestPath, verifierPath });
        expectOnlyFailures('FG-C003.primary_pair');
      },
    );

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
