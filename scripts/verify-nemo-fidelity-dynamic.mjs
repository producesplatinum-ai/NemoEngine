#!/usr/bin/env node

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const RUNTIME = path.join(SCRIPT_DIR, 'nemo-chatgpt-runtime.mjs');
let requestedOutput = null;

function parseArguments(argv) {
  if (argv.length === 0) return { out: null };
  if (argv.length !== 2 || argv[0] !== '--out' || !argv[1]) {
    throw new Error('Usage: node scripts/verify-nemo-fidelity-dynamic.mjs [--out FILE]');
  }
  return { out: path.resolve(process.cwd(), argv[1]) };
}

function runRuntime(args) {
  return spawnSync(process.execPath, [RUNTIME, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  requestedOutput = options.out;
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'nemo-fidelity-dynamic-'));
  const checks = [];
  const assert = (condition, name, detail = null) => {
    checks.push({ name, pass: Boolean(condition), ...(detail ? { detail } : {}) });
  };

  try {
    const c002Rejected = runRuntime([
      '--vex',
      'Midnight Courier Vex',
      '--out',
      path.join(temporary, 'c002-vex.json'),
    ]);
    assert(c002Rejected.status === 1, 'FG-C002.vex_selector_rejected');
    assert(
      c002Rejected.stderr.includes('Unknown Vex selector "Midnight Courier Vex".'),
      'FG-C002.vex_selector_diagnostic',
    );

    const c002Output = path.join(temporary, 'c002-generic.json');
    const c002Generic = runRuntime([
      '--enable-one',
      'v11-514-classicvex-midnight-courier',
      '--out',
      c002Output,
    ]);
    assert(c002Generic.status === 0, 'FG-C002.generic_enable_succeeds');
    if (c002Generic.status === 0) {
      const bundle = JSON.parse(await readFile(c002Output, 'utf8'));
      const ids = new Set(bundle.prompts.map((prompt) => prompt.id));
      assert(
        bundle.selections?.vex?.id === 'v11-305-vex-narrative-vex',
        'FG-C002.default_narrative_remains_selected',
      );
      assert(
        ids.has('v11-305-vex-narrative-vex') &&
          ids.has('v11-514-classicvex-midnight-courier'),
        'FG-C002.generic_route_emits_both_vex_modules',
      );
    }

    const c011Output = path.join(temporary, 'c011-both.json');
    const c011Both = runRuntime([
      '--enable-one',
      'nemo-manga-panels-9-3-2',
      '--enable-one',
      'nemo-webtoon-panels-9-3-2',
      '--out',
      c011Output,
    ]);
    assert(c011Both.status === 0, 'FG-C011.both_modules_compile');
    if (c011Both.status === 0) {
      const bundle = JSON.parse(await readFile(c011Output, 'utf8'));
      const selected = bundle.prompts.filter((prompt) =>
        ['nemo-manga-panels-9-3-2', 'nemo-webtoon-panels-9-3-2'].includes(prompt.id),
      );
      assert(selected.length === 2, 'FG-C011.both_modules_emitted');
      assert(
        selected.every(
          (prompt) =>
            prompt.exclusiveGroup === null || prompt.exclusiveGroup === undefined,
        ),
        'FG-C011.no_runtime_exclusive_group',
      );
    }

    const failed = checks.filter((entry) => !entry.pass);
    const result = {
      schemaVersion: 'nemo-fidelity-dynamic-verification/v1',
      status:
        failed.length === 0
          ? 'EXECUTABLE_CASES_PASS_WITH_PENDING_BROWSER_E2E'
          : 'EXECUTABLE_CASES_FAIL',
      checks: checks.length,
      passedChecks: checks.length - failed.length,
      failedChecks: failed.length,
      dynamicRequired: 3,
      dynamicVerified: failed.length === 0 ? 2 : 0,
      verifiedGuards: failed.length === 0 ? ['FG-C002', 'FG-C011'] : [],
      pending: [
        {
          guardId: 'FG-C010',
          status: 'PENDING_BROWSER_E2E',
          reason: 'No browser renderer is executed by this repository test.',
        },
      ],
      assertions: checks,
    };
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    if (options.out) {
      await mkdir(path.dirname(options.out), { recursive: true });
      await writeFile(options.out, serialized, { encoding: 'utf8', mode: 0o600 });
    }
    process.stdout.write(serialized);
    process.exitCode = failed.length === 0 ? 0 : 1;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch(async (error) => {
  const serialized = `${JSON.stringify({
    schemaVersion: 'nemo-fidelity-dynamic-verification/v1',
    status: 'ERROR',
    error: error.message,
  }, null, 2)}\n`;
  if (requestedOutput) {
    await mkdir(path.dirname(requestedOutput), { recursive: true });
    await writeFile(requestedOutput, serialized, { encoding: 'utf8', mode: 0o600 });
  }
  process.stderr.write(serialized);
  process.exitCode = 1;
});
