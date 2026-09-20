#!/usr/bin/env node

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

const SPEC_SCHEMA = 'nemo-chatgpt-run-spec/v1';
const STATE_SCHEMA = 'nemo-chatgpt-execution/v1';
const BUNDLE_SCHEMA = 'nemo-chatgpt-runtime/v1';
const MANIFEST_SCHEMA = 'nemo-chatgpt-runtime-emission/v1';
const DEFAULT_PROFILE = '100001';
const DEFAULT_MAX_PORTABLE_CHARS = 170_000;
const DELIVERY_UNIT_CHARS = 12_000;
const MAX_SANITIZER_ATTEMPTS = 2;
const CANONICAL_PRESET_SHA256 =
  'c5e13e951340d17addef0e16e7a7152a8256c41f2c046a52e81d86e1feef31d4';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..');
const RUNTIME_PATH = path.join(SCRIPT_DIR, 'nemo-chatgpt-runtime.mjs');
const DEFAULT_PRESET = path.join(
  REPOSITORY_ROOT,
  'Nemo Engine',
  'Nemo Engine 11.5.2 - General RP.json',
);
const STATE_FILE = 'execution-state.json';
const STATE_KEY_FILE = '.execution-state.key';
const LOCK_FILE = '.execution.lock';

const HELP = `NemoEngine verified ChatGPT executor

Usage:
  node scripts/nemo-chatgpt-executor.mjs prepare --spec FILE --run-dir DIR
  node scripts/nemo-chatgpt-executor.mjs next --run-dir DIR
  node scripts/nemo-chatgpt-executor.mjs ack --run-dir DIR --unit N --sha256 HEX
  node scripts/nemo-chatgpt-executor.mjs status --run-dir DIR
  node scripts/nemo-chatgpt-executor.mjs finish --run-dir DIR --draft FILE
  node scripts/nemo-chatgpt-executor.mjs show-output --run-dir DIR

Lifecycle:
  prepare -> (next -> ack) x N -> active ChatGPT writes draft -> finish -> show-output

The active ChatGPT turn is the generation callback between ready_to_draft and
finish. The executor verifies compilation and delivery; it does not claim that
task-context text has system-message priority or that an acknowledgement proves
model cognition.
`;

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function codePoints(text) {
  return Array.from(text);
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8.`);
  }
}

function assertNoForbiddenControls(text, label) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) {
    fail(`${label} contains forbidden control characters.`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be a JSON object.`);
}

function requireOnlyKeys(object, allowed, label) {
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail(`${label} contains unknown field(s): ${unknown.sort().join(', ')}.`);
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function equalJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function requireJsonEqual(left, right, label) {
  if (!equalJson(left, right)) fail(`${label} mismatch.`);
}

function isWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
}

function parseCli(argv) {
  if (argv.length === 0 || argv.includes('--help')) return { command: 'help' };
  const command = argv[0];
  const knownCommands = new Set(['prepare', 'next', 'ack', 'status', 'finish', 'show-output']);
  if (!knownCommands.has(command)) fail(`Unknown command: ${command}`);

  const options = { command, spec: null, runDir: null, unit: null, sha256: null, draft: null };
  const allowed = {
    prepare: new Set(['--spec', '--run-dir']),
    next: new Set(['--run-dir']),
    ack: new Set(['--run-dir', '--unit', '--sha256']),
    status: new Set(['--run-dir']),
    finish: new Set(['--run-dir', '--draft']),
    'show-output': new Set(['--run-dir']),
  }[command];
  const names = {
    '--spec': 'spec',
    '--run-dir': 'runDir',
    '--unit': 'unit',
    '--sha256': 'sha256',
    '--draft': 'draft',
  };

  for (let index = 1; index < argv.length; index += 1) {
    const raw = argv[index];
    const equals = raw.indexOf('=');
    const option = equals === -1 ? raw : raw.slice(0, equals);
    if (!allowed.has(option)) fail(`Unknown option for ${command}: ${option}`);
    const key = names[option];
    if (options[key] !== null) fail(`${option} may be provided only once.`);
    let value;
    if (equals !== -1) {
      value = raw.slice(equals + 1);
    } else {
      value = argv[index + 1];
      index += 1;
    }
    if (!value || value.startsWith('--')) fail(`${option} requires a value.`);
    options[key] = value;
  }

  for (const option of allowed) {
    const key = names[option];
    if (options[key] === null) fail(`${command} requires ${option}.`);
  }
  if (options.unit !== null) {
    if (!/^\d+$/.test(options.unit) || !Number.isSafeInteger(Number(options.unit))) {
      fail('--unit must be a positive safe integer.');
    }
    options.unit = Number(options.unit);
    if (options.unit < 1) fail('--unit must be a positive safe integer.');
  }
  if (options.sha256 !== null) {
    options.sha256 = options.sha256.toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(options.sha256)) {
      fail('--sha256 must be exactly 64 hexadecimal characters.');
    }
  }
  return options;
}

async function readJson(filePath, label) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    fail(`Cannot read ${label}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`Cannot parse ${label} as JSON: ${error.message}`);
  }
}

async function requireRegularFile(filePath, label) {
  let status;
  try {
    status = await lstat(filePath);
  } catch (error) {
    fail(`Cannot inspect ${label}: ${error.message}`);
  }
  if (status.isSymbolicLink() || !status.isFile()) {
    fail(`${label} must be a regular file and not a symbolic link.`);
  }
  return status;
}

async function resolveExistingRunDir(rawPath) {
  const directory = path.resolve(process.cwd(), rawPath);
  let status;
  try {
    status = await lstat(directory);
  } catch (error) {
    fail(`Run directory is unavailable: ${error.message}`);
  }
  if (status.isSymbolicLink() || !status.isDirectory()) {
    fail('Run directory must be a real directory, not a symbolic link.');
  }
  if ((await realpath(directory)) !== directory) {
    fail('Run directory path may not traverse symbolic links.');
  }
  if (isWithin(directory, REPOSITORY_ROOT)) {
    fail('Run directory must be outside the NemoEngine repository.');
  }
  return directory;
}

async function createFreshRunDir(rawPath) {
  const directory = path.resolve(process.cwd(), rawPath);
  if (isWithin(directory, REPOSITORY_ROOT)) {
    fail('Run directory must be outside the NemoEngine repository.');
  }

  let existing = false;
  try {
    const status = await lstat(directory);
    existing = true;
    if (status.isSymbolicLink() || !status.isDirectory()) {
      fail('Run directory must be a real directory, not a symbolic link.');
    }
    if ((await readdir(directory)).length > 0) {
      fail('Run directory must be new or empty.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let ancestor = existing ? directory : path.dirname(directory);
  while (true) {
    try {
      const status = await lstat(ancestor);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        fail('Run directory path may not traverse symbolic links.');
      }
      if ((await realpath(ancestor)) !== path.resolve(ancestor)) {
        fail('Run directory path may not traverse symbolic links.');
      }
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  if (!existing) await mkdir(directory, { recursive: true });
  await chmod(directory, 0o700);
  return resolveExistingRunDir(directory);
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await rename(temporary, filePath);
}

async function withLock(runDir, callback) {
  const lockPath = path.join(runDir, LOCK_FILE);
  const openLock = async () => {
    const candidate = await open(lockPath, 'wx', 0o600);
    try {
      await candidate.writeFile(
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
        'utf8',
      );
      return candidate;
    } catch (error) {
      await candidate.close();
      try {
        await unlink(lockPath);
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      }
      throw error;
    }
  };

  let handle;
  try {
    handle = await openLock();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const status = await lstat(lockPath);
    if (status.isSymbolicLink() || !status.isFile()) {
      fail('Run lock is not a regular file; refusing unsafe recovery.');
    }
    let metadata = null;
    try {
      metadata = JSON.parse(await readFile(lockPath, 'utf8'));
    } catch {
      // A freshly created lock can briefly be empty. Recover malformed locks
      // only after a conservative age threshold.
    }
    const hasOwnerPid = Number.isSafeInteger(metadata?.pid) && metadata.pid > 0;
    let ownerAlive = false;
    if (hasOwnerPid) {
      ownerAlive = true;
      try {
        process.kill(metadata.pid, 0);
      } catch (probeError) {
        if (probeError.code === 'ESRCH') ownerAlive = false;
        else if (probeError.code !== 'EPERM') throw probeError;
      }
    }
    const olderThanFifteenMinutes = Date.now() - status.mtimeMs > 15 * 60 * 1_000;
    if (ownerAlive || (!hasOwnerPid && !olderThanFifteenMinutes)) {
      fail('Run directory is locked by another executor process.');
    }
    try {
      await unlink(lockPath);
    } catch (unlinkError) {
      if (unlinkError.code !== 'ENOENT') throw unlinkError;
    }
    try {
      handle = await openLock();
    } catch (retryError) {
      if (retryError.code === 'EEXIST') {
        fail('Run directory lock changed during stale-lock recovery.');
      }
      throw retryError;
    }
  }
  try {
    return await callback();
  } finally {
    await handle.close();
    try {
      await unlink(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function unsignedState(state) {
  const value = { ...state };
  delete value.integrity;
  return value;
}

function stateSignature(state, key) {
  return createHmac('sha256', key).update(canonicalJson(unsignedState(state))).digest('hex');
}

async function readStateKey(runDir) {
  const keyPath = path.join(runDir, STATE_KEY_FILE);
  await requireRegularFile(keyPath, 'execution state key');
  const key = await readFile(keyPath);
  if (key.length !== 32) fail('Execution state key has an invalid length.');
  return key;
}

async function writeStateAtomic(runDir, state) {
  const key = await readStateKey(runDir);
  state.integrity = {
    algorithm: 'hmac-sha256',
    keySha256: sha256(key),
    value: stateSignature(state, key),
  };
  await writeJsonAtomic(path.join(runDir, STATE_FILE), state);
}

function normalizedString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string.`);
  }
  if (value.length > 1_000) fail(`${label} is unreasonably long.`);
  if (/[\u0000-\u001f\u007f]/.test(value)) fail(`${label} contains control characters.`);
  return value.trim();
}

function normalizedStringList(value, label, { identifiersOnly = false } = {}) {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  const result = value.map((entry, index) => normalizedString(entry, `${label}[${index}]`));
  if (result.some((entry) => entry.toLowerCase() === 'none')) {
    fail(`${label} must use an empty array, not the reserved selector "none".`);
  }
  if (new Set(result).size !== result.length) fail(`${label} contains duplicates.`);
  if (identifiersOnly) {
    for (const entry of result) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(entry)) {
        fail(`${label} accepts exact module identifiers only.`);
      }
    }
  }
  return result;
}

function assertSafeContextValue(value, label) {
  if (typeof value !== 'string') fail(`${label} must be a string.`);
  if (value.length > 100_000) fail(`${label} is too large.`);
  const control = value.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
  if (control) {
    fail(`${label} contains a forbidden control character U+${control[0]
      .codePointAt(0)
      .toString(16)
      .toUpperCase()
      .padStart(4, '0')}.`);
  }
  const structural =
    /##[ \t]+Nemo module\b|(?:Source role metadata \(not host role\)|Role|Identifier):|<<<(?:END_)?NEMO_DELIVERY\b|\{\{[\s\S]*?\}\}|<\/?(?:plan|planning|think|thinking|analysis|scratchpad|service|nemo-final|nemo-pad)\b|\[\[|<!--|-->/i;
  const match = value.match(structural);
  if (match) {
    fail(`${label} contains reserved runtime or service syntax: ${JSON.stringify(match[0])}.`);
  }
}

function normalizeContext(value) {
  if (value === undefined) return { macros: {}, globals: {}, variables: {} };
  requireObject(value, 'spec.context');
  requireOnlyKeys(value, new Set(['macros', 'globals', 'variables']), 'spec.context');
  const output = {};
  let totalCharacters = 0;
  for (const section of ['macros', 'globals', 'variables']) {
    const entries = value[section] ?? {};
    requireObject(entries, `spec.context.${section}`);
    output[section] = {};
    for (const [rawKey, rawValue] of Object.entries(entries)) {
      if (['__proto__', 'prototype', 'constructor'].includes(rawKey)) {
        fail(`spec.context.${section} contains a reserved key: ${JSON.stringify(rawKey)}.`);
      }
      if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(rawKey)) {
        fail(`spec.context.${section} contains an unsafe key: ${JSON.stringify(rawKey)}.`);
      }
      assertSafeContextValue(rawValue, `spec.context.${section}.${rawKey}`);
      totalCharacters += codePoints(rawValue).length;
      output[section][rawKey] = rawValue;
    }
  }
  if (totalCharacters > 200_000) fail('spec.context exceeds 200000 Unicode characters.');
  return output;
}

function normalizeSelections(value) {
  if (value === undefined) return {};
  requireObject(value, 'spec.selections');
  requireOnlyKeys(value, new Set(['vex', 'nsfw', 'fetish', 'enable', 'disable']), 'spec.selections');
  const output = {};
  if (Object.hasOwn(value, 'vex')) output.vex = normalizedString(value.vex, 'spec.selections.vex');
  for (const family of ['nsfw', 'fetish', 'enable', 'disable']) {
    if (Object.hasOwn(value, family)) {
      output[family] = normalizedStringList(value[family], `spec.selections.${family}`);
    }
  }
  return output;
}

function normalizeSpec(raw, specPath) {
  requireObject(raw, 'Run spec');
  requireOnlyKeys(
    raw,
    new Set([
      'schemaVersion',
      'profile',
      'preset',
      'maxPortableChars',
      'selections',
      'context',
      'allowNonPortable',
    ]),
    'Run spec',
  );
  if (raw.schemaVersion !== SPEC_SCHEMA) {
    fail(`Run spec schemaVersion must be ${SPEC_SCHEMA}.`);
  }

  const profileRaw = raw.profile ?? DEFAULT_PROFILE;
  const profile = String(profileRaw);
  if (!/^\d+$/.test(profile) || !Number.isSafeInteger(Number(profile))) {
    fail('spec.profile must be a non-negative safe integer or digit string.');
  }
  const maxPortableChars = raw.maxPortableChars ?? DEFAULT_MAX_PORTABLE_CHARS;
  if (
    !Number.isSafeInteger(maxPortableChars) ||
    maxPortableChars < 1 ||
    maxPortableChars > DEFAULT_MAX_PORTABLE_CHARS
  ) {
    fail(`spec.maxPortableChars must be a safe integer from 1 through ${DEFAULT_MAX_PORTABLE_CHARS}.`);
  }

  let preset = null;
  if (Object.hasOwn(raw, 'preset')) {
    preset = normalizedString(raw.preset, 'spec.preset');
    preset = path.resolve(path.dirname(specPath), preset);
  }
  return {
    schemaVersion: SPEC_SCHEMA,
    profile,
    preset,
    maxPortableChars,
    selections: normalizeSelections(raw.selections),
    context: normalizeContext(raw.context),
    allowNonPortable: Object.hasOwn(raw, 'allowNonPortable')
      ? normalizedStringList(raw.allowNonPortable, 'spec.allowNonPortable', {
          identifiersOnly: true,
        })
      : [],
  };
}

function runtimeArgsFor(spec, snapshotPreset, snapshotContext, canonicalPreset) {
  const args = [
    '--mode',
    'portable',
    '--profile',
    spec.profile,
    '--max-portable-chars',
    String(spec.maxPortableChars),
    '--preset',
    snapshotPreset,
    '--context',
    snapshotContext,
  ];
  const selections = spec.selections;
  if (Object.hasOwn(selections, 'vex')) {
    args.push('--vex', selections.vex);
  } else if (canonicalPreset) {
    // Snapshotting intentionally changes the preset filename, while the legacy
    // conflict repair also uses that filename as a recognition signal. Make the
    // canonical General RP baseline explicit so immutable execution preserves
    // the documented Narrative Vex normalization without relying on a path.
    args.push('--vex', 'Narrative Vex');
  }
  for (const family of ['nsfw', 'fetish']) {
    if (Object.hasOwn(selections, family)) {
      if (selections[family].length === 0) {
        args.push(`--${family}`, 'none');
      } else {
        for (const selector of selections[family]) args.push(`--${family}-one`, selector);
      }
    }
  }
  for (const kind of ['enable', 'disable']) {
    if (Object.hasOwn(selections, kind) && selections[kind].length > 0) {
      for (const selector of selections[kind]) args.push(`--${kind}-one`, selector);
    }
  }
  return args;
}

function runRuntime(runtimeSnapshot, args, runDir, label) {
  const result = spawnSync(process.execPath, [runtimeSnapshot, ...args], {
    cwd: runDir,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const diagnostic = String(result.stderr || result.stdout || '').trim().slice(0, 4_000);
    fail(`${label} failed with exit ${result.status}${diagnostic ? `: ${diagnostic}` : '.'}`);
  }
  if (String(result.stdout).trim().length > 0) {
    fail(`${label} unexpectedly wrote to stdout; refusing an unverifiable transport.`);
  }
}

function explicitRequestedIds(spec, bundle) {
  const ids = new Set();
  if (Object.hasOwn(spec.selections, 'vex') && bundle.selections.vex) {
    ids.add(bundle.selections.vex.id);
  }
  if (Object.hasOwn(spec.selections, 'nsfw')) {
    for (const entry of bundle.selections.nsfw) ids.add(entry.id);
  }
  if (Object.hasOwn(spec.selections, 'fetish')) {
    for (const entry of bundle.selections.fetish) ids.add(entry.id);
  }
  if (Object.hasOwn(spec.selections, 'enable')) {
    for (const entry of bundle.selections.overrides.enabled) ids.add(entry.id);
  }
  return ids;
}

function classifyExplicitOmissions(spec, bundle, manifest) {
  const requested = explicitRequestedIds(spec, bundle);
  const omitted = new Map(manifest.omittedModules.map((entry) => [entry.id, entry]));
  const effectiveFolded = [];
  const limitations = [];
  const blocked = [];
  for (const id of requested) {
    const entry = omitted.get(id);
    if (!entry) continue;
    if (entry.reason === 'folded-state') {
      effectiveFolded.push(entry);
    } else if (spec.allowNonPortable.includes(id)) {
      limitations.push(entry);
    } else {
      blocked.push(entry);
    }
  }
  const allowedButUnused = spec.allowNonPortable.filter(
    (id) => !limitations.some((entry) => entry.id === id),
  );
  if (allowedButUnused.length > 0) {
    fail(`spec.allowNonPortable contains unused identifier(s): ${allowedButUnused.join(', ')}.`);
  }
  if (blocked.length > 0) {
    fail(
      'Explicitly requested module(s) are not operative in ChatGPT portable mode: ' +
        blocked.map((entry) => `${entry.id} (${entry.reason})`).join(', ') +
        '. Add exact IDs to allowNonPortable only if this limitation is intentional.',
    );
  }
  return { effectiveFolded, limitations };
}

function summarizeDiagnostics(bundle) {
  return {
    repairs: bundle.diagnostics.repairs.length,
    warnings: bundle.diagnostics.warnings.length,
    unresolvedMacros: bundle.diagnostics.macroResolution.unresolved.length,
    portableTransforms: bundle.diagnostics.portableTransforms.length,
    uiDegradedModules: bundle.diagnostics.portableTransforms
      .filter((entry) => entry.code === 'PORTABLE_UI_DEGRADED')
      .reduce((count, entry) => count + entry.moduleIds.length, 0),
  };
}

function publicDiagnosticsFor(bundle) {
  return {
    repairs: bundle.diagnostics.repairs,
    warnings: bundle.diagnostics.warnings,
    macroResolution: {
      unresolved: bundle.diagnostics.macroResolution.unresolved,
      semanticContextSlots: bundle.diagnostics.macroResolution.semanticContextSlots,
    },
    portableTransforms: bundle.diagnostics.portableTransforms,
  };
}

function readinessFor(omissionClassification, diagnostics) {
  if (omissionClassification.limitations.length > 0) return 'verified_with_limitations';
  if (
    diagnostics.warnings > 0 ||
    diagnostics.repairs > 0 ||
    diagnostics.uiDegradedModules > 0
  ) {
    return 'verified_with_diagnostics';
  }
  return 'verified';
}

async function verifyCompiledArtifacts(runDir, expected = null) {
  const paths = {
    spec: path.join(runDir, 'run-spec.normalized.json'),
    runtime: path.join(runDir, 'runtime-snapshot.mjs'),
    preset: path.join(runDir, 'source-preset.json'),
    context: path.join(runDir, 'context.json'),
    bundle: path.join(runDir, 'bundle.json'),
    emission: path.join(runDir, 'emission'),
  };
  paths.manifest = path.join(paths.emission, 'instructions.manifest.json');
  paths.instructions = path.join(paths.emission, 'instructions.txt');

  for (const [name, filePath] of Object.entries(paths)) {
    if (name === 'emission') continue;
    await requireRegularFile(filePath, name);
  }
  const emissionStatus = await lstat(paths.emission);
  if (emissionStatus.isSymbolicLink() || !emissionStatus.isDirectory()) {
    fail('Emission artifact must be a real directory.');
  }

  const [specBytes, runtimeBytes, presetBytes, contextBytes, bundleBytes, manifestBytes, instructionBytes] =
    await Promise.all([
      readFile(paths.spec),
      readFile(paths.runtime),
      readFile(paths.preset),
      readFile(paths.context),
      readFile(paths.bundle),
      readFile(paths.manifest),
      readFile(paths.instructions),
    ]);
  const spec = JSON.parse(specBytes.toString('utf8'));
  const context = JSON.parse(contextBytes.toString('utf8'));
  const bundle = JSON.parse(bundleBytes.toString('utf8'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const instructions = instructionBytes.toString('utf8');

  if (spec.schemaVersion !== SPEC_SCHEMA) fail('Normalized run spec schema mismatch.');
  if (bundle.schemaVersion !== BUNDLE_SCHEMA) fail('Bundle schema mismatch.');
  if (bundle.mode !== 'portable' || bundle.compatibility?.mode !== 'portable') {
    fail('Bundle is not portable.');
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA || manifest.mode !== 'portable') {
    fail('Emission manifest is not portable.');
  }
  if (sha256(presetBytes) !== bundle.source.sha256) fail('Preset hash does not match bundle source.');
  if (spec.preset === null && bundle.source.sha256 !== CANONICAL_PRESET_SHA256) {
    fail('Default preset does not match the canonical NemoEngine 11.5.2 hash.');
  }
  if (String(bundle.profile?.characterId) !== spec.profile) fail('Compiled profile mismatch.');
  if (manifest.sourceSha256 !== bundle.source.sha256) fail('Bundle/manifest source mismatch.');
  requireJsonEqual(manifest.profile, bundle.profile, 'Bundle/manifest profile');
  requireJsonEqual(manifest.selections, bundle.selections, 'Bundle/manifest selections');
  requireJsonEqual(manifest.stats, bundle.stats, 'Bundle/manifest stats');

  const emittedIds = bundle.prompts.map((prompt) => prompt.id);
  requireJsonEqual(manifest.orderedEmittedIds, emittedIds, 'Emitted module order');
  const omitted = bundle.modules
    .filter((module) => module.emission !== 'portable')
    .map((module) => ({ id: module.id, name: module.name, reason: module.emission }));
  requireJsonEqual(manifest.omittedModules, omitted, 'Omitted module ledger');

  const instructionTextSha = sha256(instructionBytes);
  const instructionCharacters = codePoints(instructions).length;
  if (manifest.instructionSha256 !== instructionTextSha) fail('Instruction hash mismatch.');
  if (manifest.instructionChars !== instructionCharacters) fail('Instruction character count mismatch.');
  if (manifest.instructionBytes !== instructionBytes.length) fail('Instruction byte count mismatch.');
  if (bundle.portableInstructions.sha256 !== instructionTextSha) fail('Bundle instruction hash mismatch.');
  if (bundle.portableInstructions.characters !== instructionCharacters) {
    fail('Bundle instruction character count mismatch.');
  }
  if (bundle.portableInstructions.bytes !== instructionBytes.length) {
    fail('Bundle instruction byte count mismatch.');
  }
  if (bundle.portableInstructions.blockCount !== emittedIds.length) {
    fail('Portable block count mismatch.');
  }
  if (bundle.stats.emittedPrompts !== emittedIds.length) fail('Emitted prompt count mismatch.');
  if (bundle.stats.instructionChars !== instructionCharacters) fail('Stats instruction count mismatch.');
  if (/<<<(?:END_)?NEMO_DELIVERY\b/.test(instructions)) {
    fail('Instruction stream collides with reserved delivery framing.');
  }

  if (!Array.isArray(manifest.chunks) || manifest.chunks.length < 1 || manifest.chunks.length > 8) {
    fail('Manifest chunk count is invalid.');
  }
  const expectedFiles = new Set(['instructions.txt', 'instructions.manifest.json']);
  const chunkTexts = [];
  let expectedStart = 0;
  for (const [arrayIndex, chunk] of manifest.chunks.entries()) {
    if (!isPlainObject(chunk) || chunk.index !== arrayIndex + 1) fail('Chunk index mismatch.');
    if (!/^chunk-\d{3}\.txt$/.test(chunk.file) || path.basename(chunk.file) !== chunk.file) {
      fail('Unsafe chunk filename in manifest.');
    }
    if (chunk.start !== expectedStart || chunk.end - chunk.start !== chunk.chars) {
      fail(`Chunk ${chunk.index} has non-contiguous boundaries.`);
    }
    if (!Number.isSafeInteger(chunk.chars) || chunk.chars < 1 || chunk.chars > 24_000) {
      fail(`Chunk ${chunk.index} has an invalid character count.`);
    }
    const chunkPath = path.join(paths.emission, chunk.file);
    await requireRegularFile(chunkPath, `chunk ${chunk.index}`);
    const chunkBytes = await readFile(chunkPath);
    const chunkText = chunkBytes.toString('utf8');
    if (codePoints(chunkText).length !== chunk.chars) fail(`Chunk ${chunk.index} character mismatch.`);
    if (sha256(chunkBytes) !== chunk.sha256) fail(`Chunk ${chunk.index} hash mismatch.`);
    expectedStart = chunk.end;
    expectedFiles.add(chunk.file);
    chunkTexts.push(chunkText);
  }
  if (expectedStart !== manifest.instructionChars) fail('Final chunk boundary mismatch.');
  if (chunkTexts.join('') !== instructions) fail('Chunk reassembly mismatch.');
  const actualFiles = new Set(await readdir(paths.emission));
  if (!equalJson([...actualFiles].sort(), [...expectedFiles].sort())) {
    fail('Emission directory contains missing or unexpected files.');
  }

  const units = [];
  for (const [chunkArrayIndex, chunkText] of chunkTexts.entries()) {
    const characters = codePoints(chunkText);
    const partCount = Math.ceil(characters.length / DELIVERY_UNIT_CHARS);
    for (let start = 0; start < characters.length; start += DELIVERY_UNIT_CHARS) {
      const text = characters.slice(start, start + DELIVERY_UNIT_CHARS).join('');
      units.push({
        index: units.length + 1,
        chunkIndex: chunkArrayIndex + 1,
        partIndex: Math.floor(start / DELIVERY_UNIT_CHARS) + 1,
        partCount,
        startInChunk: start,
        endInChunk: start + codePoints(text).length,
        chars: codePoints(text).length,
        bytes: Buffer.byteLength(text, 'utf8'),
        sha256: sha256(Buffer.from(text, 'utf8')),
      });
    }
  }

  const hashes = {
    specSha256: sha256(specBytes),
    runtimeSha256: sha256(runtimeBytes),
    presetSha256: sha256(presetBytes),
    contextSha256: sha256(contextBytes),
    bundleSha256: sha256(bundleBytes),
    manifestSha256: sha256(manifestBytes),
    instructionSha256: instructionTextSha,
  };
  if (expected) {
    requireJsonEqual(hashes, expected.artifacts, 'Immutable artifact hashes');
    requireJsonEqual(units, expected.delivery.units, 'Delivery unit ledger');
    const expectedArgv = runtimeArgsFor(
      spec,
      paths.preset,
      paths.context,
      hashes.presetSha256 === CANONICAL_PRESET_SHA256,
    );
    requireJsonEqual(expected.compiler.argv, expectedArgv, 'Stored compiler arguments');
    if (expected.compiler.runtimeArgsSha256 !== sha256(Buffer.from(canonicalJson(expectedArgv)))) {
      fail('Stored compiler argument hash mismatch.');
    }
  }
  return { paths, spec, context, bundle, manifest, instructions, chunkTexts, units, hashes };
}

async function loadState(runDir) {
  const statePath = path.join(runDir, STATE_FILE);
  await requireRegularFile(statePath, 'execution state');
  const state = await readJson(statePath, 'execution state');
  const key = await readStateKey(runDir);
  if (
    !isPlainObject(state.integrity) ||
    state.integrity.algorithm !== 'hmac-sha256' ||
    state.integrity.keySha256 !== sha256(key) ||
    !/^[a-f0-9]{64}$/.test(state.integrity.value ?? '')
  ) {
    fail('Execution state authentication metadata is invalid.');
  }
  const expectedSignature = Buffer.from(stateSignature(state, key), 'hex');
  const actualSignature = Buffer.from(state.integrity.value, 'hex');
  if (
    expectedSignature.length !== actualSignature.length ||
    !timingSafeEqual(expectedSignature, actualSignature)
  ) {
    fail('Execution state authentication failed; the lifecycle ledger was modified.');
  }
  if (state.schemaVersion !== STATE_SCHEMA) fail('Execution state schema mismatch.');
  if (!['delivering', 'ready_to_draft', 'complete', 'failed'].includes(state.phase)) {
    fail('Execution state has an invalid phase.');
  }
  if (!isPlainObject(state.delivery) || !Array.isArray(state.delivery.units)) {
    fail('Execution state delivery ledger is invalid.');
  }
  if (!Array.isArray(state.delivery.acknowledged)) {
    fail('Execution state acknowledgement ledger is invalid.');
  }
  return { state };
}

function validateStateLedger(state) {
  const total = state.delivery.units.length;
  if (state.delivery.totalUnits !== total || total < 1) fail('State totalUnits mismatch.');
  const acknowledgements = state.delivery.acknowledged;
  if (acknowledgements.length > total) fail('Too many acknowledgements in state.');
  for (const [index, acknowledgement] of acknowledgements.entries()) {
    const unit = state.delivery.units[index];
    if (acknowledgement.unit !== index + 1 || acknowledgement.sha256 !== unit.sha256) {
      fail('Acknowledgement ledger is not contiguous or does not match delivery hashes.');
    }
  }
  if (state.delivery.pending !== null) {
    const expectedIndex = acknowledgements.length + 1;
    const unit = state.delivery.units[expectedIndex - 1];
    if (
      !unit ||
      state.delivery.pending.unit !== expectedIndex ||
      state.delivery.pending.sha256 !== unit.sha256
    ) {
      fail('Pending delivery state is invalid.');
    }
  }
  const allAcknowledged = acknowledgements.length === total;
  if (state.phase === 'delivering' && allAcknowledged) fail('Delivering phase has no remaining units.');
  if (state.phase !== 'delivering' && !allAcknowledged) {
    fail(`${state.phase} phase was reached before complete delivery.`);
  }
  const sanitizer = state.sanitizer;
  if (
    !isPlainObject(sanitizer) ||
    !Number.isSafeInteger(sanitizer.attempts) ||
    sanitizer.attempts < 0 ||
    sanitizer.attempts > MAX_SANITIZER_ATTEMPTS ||
    sanitizer.maxAttempts !== MAX_SANITIZER_ATTEMPTS ||
    !Array.isArray(sanitizer.failures)
  ) {
    fail('Sanitizer state is invalid.');
  }
  const successfulAttempt = sanitizer.output === null ? 0 : 1;
  if (sanitizer.attempts !== sanitizer.failures.length + successfulAttempt) {
    fail('Sanitizer attempt ledger is inconsistent.');
  }
  if (state.phase === 'complete' && !isPlainObject(sanitizer.output)) {
    fail('Complete state lacks a sanitized output receipt.');
  }
  if (state.phase !== 'complete' && sanitizer.output !== null) {
    fail('Non-complete state contains an output receipt.');
  }
  if (state.phase === 'failed' && sanitizer.attempts !== MAX_SANITIZER_ATTEMPTS) {
    fail('Failed state was reached before the sanitizer attempt limit.');
  }
  if (state.phase === 'delivering' && sanitizer.attempts !== 0) {
    fail('Sanitizer ran before instruction delivery completed.');
  }
}

async function verifiedState(runDir) {
  const loaded = await loadState(runDir);
  validateStateLedger(loaded.state);
  const compiled = await verifyCompiledArtifacts(runDir, loaded.state);
  if (loaded.state.compile.sourceSha256 !== compiled.bundle.source.sha256) {
    fail('State source hash mismatch.');
  }
  if (loaded.state.compile.instructionSha256 !== compiled.manifest.instructionSha256) {
    fail('State instruction hash mismatch.');
  }
  requireJsonEqual(loaded.state.compile.profile, compiled.bundle.profile, 'State profile');
  requireJsonEqual(loaded.state.compile.selections, compiled.bundle.selections, 'State selections');
  requireJsonEqual(loaded.state.compile.stats, compiled.bundle.stats, 'State statistics');
  if (
    loaded.state.compile.instructionChars !== compiled.manifest.instructionChars ||
    loaded.state.compile.instructionBytes !== compiled.manifest.instructionBytes
  ) {
    fail('State instruction size mismatch.');
  }
  const omissionClassification = classifyExplicitOmissions(
    compiled.spec,
    compiled.bundle,
    compiled.manifest,
  );
  requireJsonEqual(
    loaded.state.compile.effectiveFolded,
    omissionClassification.effectiveFolded,
    'State folded-module ledger',
  );
  requireJsonEqual(
    loaded.state.compile.limitations,
    omissionClassification.limitations,
    'State portability limitations',
  );
  const diagnostics = summarizeDiagnostics(compiled.bundle);
  requireJsonEqual(loaded.state.compile.diagnostics, diagnostics, 'State diagnostics');
  requireJsonEqual(
    loaded.state.compile.publicDiagnostics,
    publicDiagnosticsFor(compiled.bundle),
    'State public diagnostics',
  );
  const readiness = readinessFor(omissionClassification, diagnostics);
  if (loaded.state.readiness !== readiness) fail('State readiness classification mismatch.');
  const contract = loaded.state.contract;
  if (
    contract?.deliveryMode !== 'task-context' ||
    contract.systemRoleInjection !== false ||
    contract.sillyTavernParity !== false ||
    contract.consumptionMeaning !==
      'host delivery acknowledgement, not proof of model cognition'
  ) {
    fail('Execution contract was modified.');
  }
  let cleanOutputBytes = null;
  if (loaded.state.phase === 'complete') {
    const outputPath = path.join(runDir, 'clean-output.txt');
    await requireRegularFile(outputPath, 'clean output');
    cleanOutputBytes = await readFile(outputPath);
    if (sha256(cleanOutputBytes) !== loaded.state.sanitizer.output.sha256) {
      fail('Clean output hash mismatch.');
    }
    if (cleanOutputBytes.length !== loaded.state.sanitizer.output.bytes) {
      fail('Clean output size mismatch.');
    }
    const cleanOutputText = decodeUtf8(cleanOutputBytes, 'Clean output');
    assertNoForbiddenControls(cleanOutputText, 'Clean output');
  }
  return { ...loaded, compiled, cleanOutputBytes };
}

function publicReceipt(state, command) {
  const acknowledged = state.delivery.acknowledged.length;
  const receipt = {
    schemaVersion: STATE_SCHEMA,
    command,
    runId: state.runId,
    phase: state.phase,
    readiness: state.readiness,
    sourceSha256: state.compile.sourceSha256,
    runtimeSha256: state.artifacts.runtimeSha256,
    specSha256: state.artifacts.specSha256,
    profile: state.compile.profile,
    selections: state.compile.selections,
    stats: state.compile.stats,
    instruction: {
      chars: state.compile.instructionChars,
      bytes: state.compile.instructionBytes,
      sha256: state.compile.instructionSha256,
    },
    delivery: {
      acknowledged,
      totalUnits: state.delivery.totalUnits,
      nextUnit: acknowledged < state.delivery.totalUnits ? acknowledged + 1 : null,
      pendingUnit: state.delivery.pending?.unit ?? null,
    },
    diagnostics: state.compile.diagnostics,
    limitations: state.compile.limitations,
    contract: state.contract,
  };
  if (state.phase === 'complete') receipt.output = state.sanitizer.output;
  if (command === 'prepare' || command === 'status') {
    receipt.inspection = {
      effectiveFolded: state.compile.effectiveFolded,
      diagnostics: state.compile.publicDiagnostics,
    };
  }
  return receipt;
}

function emitJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function prepare(options) {
  const specPath = path.resolve(process.cwd(), options.spec);
  await requireRegularFile(specPath, 'run spec');
  const rawSpec = await readJson(specPath, 'run spec');
  const spec = normalizeSpec(rawSpec, specPath);
  const runDir = await createFreshRunDir(options.runDir);

  await withLock(runDir, async () => {
    const normalizedSpecPath = path.join(runDir, 'run-spec.normalized.json');
    const runtimeSnapshot = path.join(runDir, 'runtime-snapshot.mjs');
    const presetSnapshot = path.join(runDir, 'source-preset.json');
    const contextSnapshot = path.join(runDir, 'context.json');
    const bundlePath = path.join(runDir, 'bundle.json');
    const emissionPath = path.join(runDir, 'emission');

    const presetSource = spec.preset ?? DEFAULT_PRESET;
    await Promise.all([
      requireRegularFile(RUNTIME_PATH, 'runtime compiler'),
      requireRegularFile(presetSource, 'source preset'),
    ]);
    const [runtimeBytes, presetBytes] = await Promise.all([
      readFile(RUNTIME_PATH),
      readFile(presetSource),
    ]);
    await writeJsonAtomic(normalizedSpecPath, spec);
    await writeFile(runtimeSnapshot, runtimeBytes, { mode: 0o500, flag: 'wx' });
    await writeFile(presetSnapshot, presetBytes, { mode: 0o400, flag: 'wx' });
    await writeFile(contextSnapshot, `${JSON.stringify(spec.context, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o400,
      flag: 'wx',
    });
    await writeFile(path.join(runDir, STATE_KEY_FILE), randomBytes(32), {
      mode: 0o400,
      flag: 'wx',
    });

    const runtimeArgs = runtimeArgsFor(
      spec,
      presetSnapshot,
      contextSnapshot,
      sha256(presetBytes) === CANONICAL_PRESET_SHA256,
    );
    const initialRuntimeHash = sha256(await readFile(runtimeSnapshot));
    runRuntime(runtimeSnapshot, [...runtimeArgs, '--out', bundlePath], runDir, 'Bundle compilation');
    if (sha256(await readFile(runtimeSnapshot)) !== initialRuntimeHash) {
      fail('Runtime snapshot changed during bundle compilation.');
    }
    runRuntime(runtimeSnapshot, [...runtimeArgs, '--emit-dir', emissionPath], runDir, 'Emission compilation');
    if (sha256(await readFile(runtimeSnapshot)) !== initialRuntimeHash) {
      fail('Runtime snapshot changed during emission compilation.');
    }

    const compiled = await verifyCompiledArtifacts(runDir);
    const omissionClassification = classifyExplicitOmissions(spec, compiled.bundle, compiled.manifest);
    const diagnostics = summarizeDiagnostics(compiled.bundle);
    const readiness = readinessFor(omissionClassification, diagnostics);
    const createdAt = new Date().toISOString();
    const state = {
      schemaVersion: STATE_SCHEMA,
      runId: sha256(
        Buffer.from(
          `${compiled.hashes.specSha256}:${compiled.hashes.runtimeSha256}:${compiled.hashes.instructionSha256}`,
        ),
      ).slice(0, 24),
      phase: 'delivering',
      readiness,
      createdAt,
      updatedAt: createdAt,
      contract: {
        deliveryMode: 'task-context',
        systemRoleInjection: false,
        sillyTavernParity: false,
        consumptionMeaning: 'host delivery acknowledgement, not proof of model cognition',
        generationCallback: 'active ChatGPT session after ready_to_draft',
      },
      artifacts: compiled.hashes,
      compiler: {
        argv: runtimeArgs,
        runtimeArgsSha256: sha256(Buffer.from(canonicalJson(runtimeArgs))),
      },
      compile: {
        sourceSha256: compiled.bundle.source.sha256,
        alternatePreset: spec.preset !== null,
        profile: compiled.bundle.profile,
        selections: compiled.bundle.selections,
        stats: compiled.bundle.stats,
        instructionChars: compiled.manifest.instructionChars,
        instructionBytes: compiled.manifest.instructionBytes,
        instructionSha256: compiled.manifest.instructionSha256,
        diagnostics,
        publicDiagnostics: publicDiagnosticsFor(compiled.bundle),
        effectiveFolded: omissionClassification.effectiveFolded,
        limitations: omissionClassification.limitations,
      },
      delivery: {
        unitSizeChars: DELIVERY_UNIT_CHARS,
        totalUnits: compiled.units.length,
        units: compiled.units,
        acknowledged: [],
        pending: null,
      },
      sanitizer: {
        attempts: 0,
        maxAttempts: MAX_SANITIZER_ATTEMPTS,
        failures: [],
        output: null,
      },
    };
    await writeStateAtomic(runDir, state);
    emitJson(publicReceipt(state, 'prepare'));
  });
}

function unitText(compiled, unit) {
  const chunk = compiled.chunkTexts[unit.chunkIndex - 1];
  if (chunk === undefined) fail(`Delivery unit ${unit.index} references a missing chunk.`);
  const text = codePoints(chunk).slice(unit.startInChunk, unit.endInChunk).join('');
  if (sha256(Buffer.from(text, 'utf8')) !== unit.sha256) {
    fail(`Delivery unit ${unit.index} failed its final hash check.`);
  }
  return text;
}

async function nextUnit(options) {
  const runDir = await resolveExistingRunDir(options.runDir);
  await withLock(runDir, async () => {
    const { state, compiled } = await verifiedState(runDir);
    if (state.phase !== 'delivering') {
      fail(`No delivery unit is available in phase ${state.phase}.`);
    }
    const nextIndex = state.delivery.acknowledged.length + 1;
    const unit = state.delivery.units[nextIndex - 1];
    if (!unit) fail('Delivery ledger is exhausted unexpectedly.');
    if (state.delivery.pending === null) {
      state.delivery.pending = {
        unit: unit.index,
        sha256: unit.sha256,
        presentedAt: new Date().toISOString(),
      };
      state.updatedAt = state.delivery.pending.presentedAt;
      await writeStateAtomic(runDir, state);
    }
    const text = unitText(compiled, unit);
    process.stdout.write(
      `<<<NEMO_DELIVERY unit=${unit.index}/${state.delivery.totalUnits} sha256=${unit.sha256} chars=${unit.chars}>>>\n` +
        `${text}\n` +
        `<<<END_NEMO_DELIVERY unit=${unit.index} sha256=${unit.sha256}>>>\n`,
    );
  });
}

async function acknowledge(options) {
  const runDir = await resolveExistingRunDir(options.runDir);
  await withLock(runDir, async () => {
    const { state } = await verifiedState(runDir);
    if (state.phase !== 'delivering') fail(`Cannot acknowledge a unit in phase ${state.phase}.`);
    if (state.delivery.pending === null) fail('Call next before ack; no unit is pending delivery.');
    if (state.delivery.pending.unit !== options.unit) {
      fail(`Expected acknowledgement for unit ${state.delivery.pending.unit}, not ${options.unit}.`);
    }
    if (state.delivery.pending.sha256 !== options.sha256) {
      fail(`SHA-256 mismatch for delivery unit ${options.unit}.`);
    }
    const now = new Date().toISOString();
    state.delivery.acknowledged.push({
      unit: options.unit,
      sha256: options.sha256,
      acknowledgedAt: now,
    });
    state.delivery.pending = null;
    state.updatedAt = now;
    if (state.delivery.acknowledged.length === state.delivery.totalUnits) {
      state.phase = 'ready_to_draft';
    }
    await writeStateAtomic(runDir, state);
    emitJson(publicReceipt(state, 'ack'));
  });
}

async function status(options) {
  const runDir = await resolveExistingRunDir(options.runDir);
  const { state } = await verifiedState(runDir);
  emitJson(publicReceipt(state, 'status'));
}

async function recordSanitizerFailure(runDir, state, message, draftSha256) {
  const attempt = state.sanitizer.attempts + 1;
  state.sanitizer.attempts = attempt;
  state.sanitizer.failures.push({
    attempt,
    draftSha256,
    message: String(message).slice(0, 2_000),
    at: new Date().toISOString(),
  });
  state.updatedAt = state.sanitizer.failures.at(-1).at;
  if (attempt >= state.sanitizer.maxAttempts) state.phase = 'failed';
  await writeStateAtomic(runDir, state);
}

async function removeExecutorOrphan(filePath, label, protectedStatus) {
  let status;
  try {
    status = await lstat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (status.isSymbolicLink() || !status.isFile()) {
    fail(`${label} is not a regular executor-owned file; refusing recovery.`);
  }
  if (status.dev === protectedStatus.dev && status.ino === protectedStatus.ino) {
    fail(`${label} aliases the supplied draft; refusing destructive recovery.`);
  }
  await unlink(filePath);
  return true;
}

async function readDraftSnapshot(draftPath) {
  let handle;
  try {
    handle = await open(
      draftPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const status = await handle.stat();
    if (!status.isFile()) fail('Draft must be a regular file.');
    const bytes = await handle.readFile();
    return { bytes, status };
  } catch (error) {
    if (error instanceof Error && error.message === 'Draft must be a regular file.') throw error;
    fail(`Cannot open draft as a stable regular file: ${error.message}`);
  } finally {
    if (handle) await handle.close();
  }
}

async function requireUnchangedDraftPath(draftPath, expectedRealPath, expectedStatus) {
  let currentRealPath;
  try {
    currentRealPath = await realpath(draftPath);
  } catch (error) {
    fail(`Draft path changed after snapshot: ${error.message}`);
  }
  if (currentRealPath !== expectedRealPath) fail('Draft path changed after snapshot.');
  const currentStatus = await requireRegularFile(currentRealPath, 'draft');
  if (currentStatus.dev !== expectedStatus.dev || currentStatus.ino !== expectedStatus.ino) {
    fail('Draft file changed after snapshot.');
  }
}

async function finish(options) {
  const runDir = await resolveExistingRunDir(options.runDir);
  const draftPath = path.resolve(process.cwd(), options.draft);
  const realDraftPath = await realpath(draftPath).catch((error) => {
    fail(`Cannot resolve draft path: ${error.message}`);
  });
  if (realDraftPath !== draftPath) {
    fail('Draft path may not traverse symbolic links.');
  }
  if (isWithin(realDraftPath, runDir)) {
    fail('Draft must be outside the executor-owned run directory.');
  }
  const { bytes: draftBytes, status: draftStatus } = await readDraftSnapshot(realDraftPath);
  const draftText = decodeUtf8(draftBytes, 'Draft');
  assertNoForbiddenControls(draftText, 'Draft');
  const draftSha256 = sha256(draftBytes);
  await withLock(runDir, async () => {
    const { state, compiled } = await verifiedState(runDir);
    if (state.phase !== 'ready_to_draft') {
      fail(`finish requires phase ready_to_draft; current phase is ${state.phase}.`);
    }
    if (state.sanitizer.attempts >= state.sanitizer.maxAttempts) {
      fail('Sanitizer attempt limit has been reached.');
    }
    await requireUnchangedDraftPath(draftPath, realDraftPath, draftStatus);
    for (let attempt = 1; attempt <= state.sanitizer.maxAttempts; attempt += 1) {
      await removeExecutorOrphan(
        path.join(runDir, `draft-attempt-${attempt}.snapshot`),
        `Draft snapshot ${attempt}`,
        draftStatus,
      );
      await removeExecutorOrphan(
        path.join(runDir, `sanitized-attempt-${attempt}.txt`),
        `Sanitizer artifact ${attempt}`,
        draftStatus,
      );
    }
    await removeExecutorOrphan(
      path.join(runDir, 'clean-output.txt'),
      'Incomplete clean output',
      draftStatus,
    );
    const attemptNumber = state.sanitizer.attempts + 1;
    const attemptPath = path.join(runDir, `sanitized-attempt-${attemptNumber}.txt`);
    const snapshotPath = path.join(runDir, `draft-attempt-${attemptNumber}.snapshot`);
    let attemptOwned = false;
    let snapshotOwned = false;
    let cleanOwned = false;
    let countSanitizerFailure = false;
    try {
      for (const ownedPath of [attemptPath, snapshotPath]) {
        try {
          await lstat(ownedPath);
          fail(`Executor attempt artifact already exists: ${path.basename(ownedPath)}.`);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      await writeFile(snapshotPath, draftBytes, { mode: 0o400, flag: 'wx' });
      snapshotOwned = true;
      try {
        runRuntime(
          compiled.paths.runtime,
          ['--sanitize-output', snapshotPath, '--out', attemptPath],
          runDir,
          `Sanitizer attempt ${attemptNumber}`,
        );
      } catch {
        countSanitizerFailure = true;
        fail(`Sanitizer attempt ${attemptNumber} rejected the draft.`);
      }
      attemptOwned = true;
      await requireRegularFile(attemptPath, `sanitizer attempt ${attemptNumber}`);
      const outputBytes = await readFile(attemptPath);
      const outputText = decodeUtf8(outputBytes, 'Sanitized output');
      assertNoForbiddenControls(outputText, 'Sanitized output');
      if (outputText.trim().length === 0) fail('Sanitized output is empty.');
      if (
        /<!--|-->|<\/?[A-Za-z][A-Za-z0-9:_-]*\b[^>]*>|<(?:\s+\/?\s*|\/\s+)(?:think(?:ing)?|plan(?:ning)?|analysis|scratchpad|nemo\s*[-_]?\s*(?:pad|final)|service)\b|&(?:lt|#0*60|#x0*3c);?\s*\/?\s*(?:think|plan|analysis|scratchpad|nemo\s*[-_]?\s*(?:pad|final)|service)\b|\[\[|\]\]|\(OOC:/i.test(
          outputText,
        )
      ) {
        countSanitizerFailure = true;
        fail('Sanitized output still contains service markup.');
      }
      const cleanPath = path.join(runDir, 'clean-output.txt');
      try {
        await lstat(cleanPath);
        fail('Clean output already exists before completion.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await unlink(snapshotPath);
      snapshotOwned = false;
      await rename(attemptPath, cleanPath);
      attemptOwned = false;
      cleanOwned = true;
      const now = new Date().toISOString();
      state.sanitizer.attempts = attemptNumber;
      state.sanitizer.output = {
        sha256: sha256(outputBytes),
        bytes: outputBytes.length,
        chars: codePoints(outputText).length,
      };
      state.phase = 'complete';
      state.updatedAt = now;
      await writeStateAtomic(runDir, state);
      cleanOwned = false;
      emitJson(publicReceipt(state, 'finish'));
    } catch (error) {
      if (snapshotOwned) {
        try {
          await unlink(snapshotPath);
        } catch (unlinkError) {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        }
      }
      if (attemptOwned) {
        try {
          await unlink(attemptPath);
        } catch (unlinkError) {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        }
      }
      if (cleanOwned) {
        try {
          await unlink(path.join(runDir, 'clean-output.txt'));
        } catch (unlinkError) {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        }
      }
      if (countSanitizerFailure) {
        await recordSanitizerFailure(runDir, state, error.message, draftSha256);
      }
      throw error;
    }
  });
}

async function showOutput(options) {
  const runDir = await resolveExistingRunDir(options.runDir);
  const { state, cleanOutputBytes } = await verifiedState(runDir);
  if (state.phase !== 'complete') {
    fail(`show-output requires phase complete; current phase is ${state.phase}.`);
  }
  process.stdout.write(cleanOutputBytes);
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (options.command === 'prepare') return prepare(options);
  if (options.command === 'next') return nextUnit(options);
  if (options.command === 'ack') return acknowledge(options);
  if (options.command === 'status') return status(options);
  if (options.command === 'finish') return finish(options);
  if (options.command === 'show-output') return showOutput(options);
  fail(`Unimplemented command: ${options.command}`);
}

main().catch((error) => {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
});
