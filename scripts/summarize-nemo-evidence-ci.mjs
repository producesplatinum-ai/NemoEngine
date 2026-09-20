#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const CANONICAL_SHA256 =
  'c5e13e951340d17addef0e16e7a7152a8256c41f2c046a52e81d86e1feef31d4';
const COMMANDS = [
  'reassembly',
  'connector-mirror',
  'structural',
  'dynamic',
  'negative',
  'runtime',
  'executor',
];
let requestedEvidenceDir = null;

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--evidence-dir' || !argv[1]) {
    throw new Error('Usage: node scripts/summarize-nemo-evidence-ci.mjs --evidence-dir DIR');
  }
  return { evidenceDir: path.resolve(process.cwd(), argv[1]) };
}

function git(args) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr.trim() || `git ${args[0]} failed`);
  }
  return result.stdout.trim();
}

function tapSummary(text) {
  const value = (label) => {
    const match = text.match(new RegExp(`^(?:#|ℹ) ${label} (\\d+)$`, 'mu'));
    return match ? Number.parseInt(match[1], 10) : null;
  };
  return { tests: value('tests'), pass: value('pass'), fail: value('fail') };
}

async function readExitCode(directory, name) {
  const raw = (await readFile(path.join(directory, 'status', `${name}.exit`), 'utf8')).trim();
  if (!/^\d+$/u.test(raw)) throw new Error(`Invalid exit code for ${name}.`);
  return Number.parseInt(raw, 10);
}

async function main() {
  const { evidenceDir } = parseArguments(process.argv.slice(2));
  requestedEvidenceDir = evidenceDir;
  const failures = [];
  const check = (condition, name, detail = null) => {
    if (!condition) failures.push({ check: name, ...(detail ? { detail } : {}) });
  };

  const commandStatuses = {};
  for (const name of COMMANDS) {
    try {
      commandStatuses[name] = await readExitCode(evidenceDir, name);
      check(commandStatuses[name] === 0, `command.${name}.exit_zero`);
    } catch (error) {
      commandStatuses[name] = null;
      check(false, `command.${name}.status_readable`, error.message);
    }
  }

  const structural = JSON.parse(
    await readFile(path.join(evidenceDir, 'structural-verification.json'), 'utf8'),
  );
  const dynamic = JSON.parse(
    await readFile(path.join(evidenceDir, 'dynamic-verification.json'), 'utf8'),
  );
  const reassemblyLog = await readFile(
    path.join(evidenceDir, 'logs', 'reassembly.log'),
    'utf8',
  );
  const mirrorLog = await readFile(
    path.join(evidenceDir, 'logs', 'connector-mirror.log'),
    'utf8',
  );
  const runtime = tapSummary(
    await readFile(path.join(evidenceDir, 'logs', 'runtime.tap'), 'utf8'),
  );
  const executor = tapSummary(
    await readFile(path.join(evidenceDir, 'logs', 'executor.tap'), 'utf8'),
  );
  const negative = tapSummary(
    await readFile(path.join(evidenceDir, 'logs', 'negative.tap'), 'utf8'),
  );

  check(
    structural.status === 'STRUCTURAL_PROVENANCE_PASS' &&
      structural.failedChecks === 0,
    'structural.result',
  );
  check(
    dynamic.status === 'EXECUTABLE_CASES_PASS_WITH_PENDING_BROWSER_E2E' &&
      dynamic.dynamicRequired === 3 &&
      dynamic.dynamicVerified === 2 &&
      dynamic.pending?.length === 1 &&
      dynamic.pending[0]?.guardId === 'FG-C010',
    'dynamic.result_and_gap',
  );
  check(
    reassemblyLog.includes(`Byte-identical SHA-256: ${CANONICAL_SHA256}`),
    'reassembly.canonical_sha256',
  );
  check(mirrorLog.includes('Verified 46 connector-readable files'), 'mirror.files46');
  check(
    negative.tests !== null &&
      negative.tests >= 1 &&
      negative.pass === negative.tests &&
      negative.fail === 0,
    'negative.tap_complete',
  );
  check(
    runtime.tests !== null &&
      runtime.tests >= 302 &&
      runtime.pass === runtime.tests &&
      runtime.fail === 0,
    'runtime.tap_complete',
  );
  check(
    executor.tests !== null &&
      executor.tests >= 38 &&
      executor.pass === executor.tests &&
      executor.fail === 0,
    'executor.tap_complete',
  );

  const headSha = git(['rev-parse', 'HEAD']);
  const headTree = git(['rev-parse', 'HEAD^{tree}']);
  const dirty = git(['status', '--porcelain=v1']);
  check(dirty === '', 'repository.clean_after_validation');

  const result = {
    schemaVersion: 'nemo-evidence-ci-summary/v1',
    status:
      failures.length === 0
        ? 'PIPELINE_PASS_WITH_KNOWN_BROWSER_GAP'
        : 'PIPELINE_FAIL',
    overallFidelity: 'PARTIAL',
    repository: {
      headSha,
      headTree,
      cleanAfterValidation: dirty === '',
    },
    commandExitCodes: commandStatuses,
    canonicalPreset: {
      sha256: structural.canonicalPreset?.sha256 ?? null,
      reassemblyVerified: reassemblyLog.includes(
        `Byte-identical SHA-256: ${CANONICAL_SHA256}`,
      ),
      connectorFilesVerified: mirrorLog.includes('Verified 46 connector-readable files'),
    },
    structuralProvenance: {
      status: structural.status,
      checks: structural.checks,
      failedChecks: structural.failedChecks,
      guards: structural.evidence?.fidelityGuards ?? null,
      excerpts: structural.evidence?.excerpts ?? null,
      sourceFiles: structural.evidence?.sourceFiles ?? null,
    },
    executableCases: {
      status: dynamic.status,
      required: dynamic.dynamicRequired,
      verified: dynamic.dynamicVerified,
      verifiedGuards: dynamic.verifiedGuards,
      pending: dynamic.pending,
    },
    verifierNegativeTests: negative,
    productionTests: { runtime, executor },
    boundaries: {
      semanticClaimsMachineProven: false,
      browserRendererParity: false,
      modelTraining: false,
      modelCognition: false,
      fullPriorConversationBundleRevalidated: false,
    },
    failures,
  };
  await writeFile(
    path.join(evidenceDir, 'ci-summary.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch(async (error) => {
  const result = {
    schemaVersion: 'nemo-evidence-ci-summary/v1',
    status: 'ERROR',
    overallFidelity: 'PARTIAL',
    error: error.message,
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (requestedEvidenceDir) {
    await mkdir(requestedEvidenceDir, { recursive: true });
    await writeFile(path.join(requestedEvidenceDir, 'ci-summary.json'), serialized, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
  process.stderr.write(serialized);
  process.exitCode = 1;
});
