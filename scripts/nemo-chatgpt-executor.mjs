#!/usr/bin/env node

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

const SPEC_SCHEMA = 'nemo-chatgpt-run-spec/v2';
const STATE_SCHEMA = 'nemo-chatgpt-execution/v2';
const BUNDLE_SCHEMA = 'nemo-chatgpt-runtime/v1';
const MANIFEST_SCHEMA = 'nemo-chatgpt-runtime-emission/v1';
const DEFAULT_PROFILE = '100001';
const DEFAULT_MAX_PORTABLE_CHARS = 170_000;
const DEFAULT_DELIVERY_UNIT_CHARS = 12_000;
const MIN_DELIVERY_UNIT_CHARS = 2_000;
const MAX_DELIVERY_UNIT_BYTES = 16_000;
const MAX_DELIVERY_UNITS = 128;
const DELIVERY_ALGORITHM = 'semantic-grapheme-v1';
const MAX_SANITIZER_ATTEMPTS = 2;
const MAX_DRAFT_BYTES = 4 * 1024 * 1024;
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
const RECOVERY_LOCK_FILE = '.execution.lock.recovery';
const LOCK_SCHEMA = 'nemo-chatgpt-lock/v1';
const LOCK_OWNER_TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const LOCK_LIVENESS_DOMAIN_PATTERN = /^[a-f0-9]{64}$/;
const LOCK_CANDIDATE_PATTERN =
  /^\.execution\.lock(?:\.recovery(?:\.[a-f0-9]{24})?)?\.candidate-[1-9]\d*-[a-f0-9]{24}$/;

const HELP = `NemoEngine verified ChatGPT executor

Usage:
  node scripts/nemo-chatgpt-executor.mjs prepare --spec FILE --run-dir DIR
  node scripts/nemo-chatgpt-executor.mjs next --run-dir DIR
  node scripts/nemo-chatgpt-executor.mjs advance --run-dir DIR --unit N --sha256 HEX --receipt HEX
  node scripts/nemo-chatgpt-executor.mjs ack --run-dir DIR --unit N --sha256 HEX --receipt HEX
  node scripts/nemo-chatgpt-executor.mjs status --run-dir DIR
  node scripts/nemo-chatgpt-executor.mjs finish --run-dir DIR --draft FILE
  node scripts/nemo-chatgpt-executor.mjs show-output --run-dir DIR

Lifecycle:
  prepare -> next -> advance x N -> active ChatGPT writes draft -> finish -> show-output

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

function assertWellFormedUnicode(text, label) {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail(`${label} contains an unpaired UTF-16 surrogate.`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail(`${label} contains an unpaired UTF-16 surrogate.`);
    }
  }
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

const HTML_ENTITY_TOKEN =
  /&(?:(?:#[xX][0-9A-Fa-f]+|#[0-9]+);?|[A-Za-z][A-Za-z0-9]+;|(?:amp|lt|gt|quot|nbsp)(?![A-Za-z0-9]))/i;
const MARKDOWN_INLINE_LINK =
  /!?\[([^\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g;
const MARKDOWN_REFERENCE_LINK = /!?\[([^\]\n]*)\]\[[^\]\n]*\]/g;
const MARKDOWN_ESCAPED_PUNCTUATION =
  /\\([\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e])/g;
const SAFETY_SEPARATOR = '[\\s\\p{P}\\p{S}]*';
const RESERVED_NEMO_PHRASE = new RegExp(
  `\\bNemo${SAFETY_SEPARATOR}(?:task${SAFETY_SEPARATOR}anchor|portable${SAFETY_SEPARATOR}runtime${SAFETY_SEPARATOR}context|module${SAFETY_SEPARATOR}\\d+)\\b`,
  'iu',
);

function canonicalizeForSafety(value) {
  let canonical = String(value)
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(MARKDOWN_ESCAPED_PUNCTUATION, '$1');
  for (let pass = 0; pass < 4; pass += 1) {
    const next = canonical
      .replace(MARKDOWN_INLINE_LINK, '$1')
      .replace(MARKDOWN_REFERENCE_LINK, '$1');
    if (next === canonical) break;
    canonical = next;
  }
  return canonical
    .replace(/[*_~`]/g, '')
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '');
}

function containsReservedNemoFraming(value) {
  const shadow = canonicalizeForSafety(value);
  return (
    RESERVED_NEMO_PHRASE.test(shadow) ||
    /<<<(?:END)?NEMODELIVERY\b/i.test(shadow)
  );
}

function containsCanonicalInternalBoundary(value) {
  return /<\s*\/?\s*(?:think(?:ing)?|plan(?:ning)?|analysis|scratchpad|nemo\s*[-_]?\s*(?:pad|final)|service|runtime_settings_reminder|language_runtime(?:_resolver)?)\b/i.test(
    canonicalizeForSafety(value),
  );
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
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..')
  );
}

function parseCli(argv) {
  if (argv.length === 0 || argv.includes('--help')) return { command: 'help' };
  const command = argv[0];
  const knownCommands = new Set([
    'prepare',
    'next',
    'advance',
    'ack',
    'status',
    'finish',
    'show-output',
  ]);
  if (!knownCommands.has(command)) fail(`Unknown command: ${command}`);

  const options = {
    command,
    spec: null,
    runDir: null,
    unit: null,
    sha256: null,
    receipt: null,
    draft: null,
  };
  const allowed = {
    prepare: new Set(['--spec', '--run-dir']),
    next: new Set(['--run-dir']),
    advance: new Set(['--run-dir', '--unit', '--sha256', '--receipt']),
    ack: new Set(['--run-dir', '--unit', '--sha256', '--receipt']),
    status: new Set(['--run-dir']),
    finish: new Set(['--run-dir', '--draft']),
    'show-output': new Set(['--run-dir']),
  }[command];
  const names = {
    '--spec': 'spec',
    '--run-dir': 'runDir',
    '--unit': 'unit',
    '--sha256': 'sha256',
    '--receipt': 'receipt',
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
  if (options.receipt !== null) {
    options.receipt = options.receipt.toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(options.receipt)) {
      fail('--receipt must be exactly 64 hexadecimal characters.');
    }
  }
  return options;
}

async function readJson(filePath, label) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    fail(`Cannot read ${label}: ${error.message}`);
  }
  const text = decodeUtf8(bytes, label);
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

function requireBigIntFileIdentity(status, label) {
  if (typeof status.dev !== 'bigint' || typeof status.ino !== 'bigint') {
    fail(`${label} file identity is not lossless.`);
  }
  return status;
}

async function requireRegularFileIdentity(filePath, label) {
  let status;
  try {
    status = await lstat(filePath, { bigint: true });
  } catch (error) {
    fail(`Cannot inspect ${label}: ${error.message}`);
  }
  if (status.isSymbolicLink() || !status.isFile()) {
    fail(`${label} must be a regular file and not a symbolic link.`);
  }
  return requireBigIntFileIdentity(status, label);
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
  if (!existing) {
    await mkdir(path.dirname(directory), { recursive: true });
    try {
      await mkdir(directory);
    } catch (error) {
      if (error.code === 'EEXIST') {
        fail('Run directory was created concurrently; retry with a new directory.');
      }
      throw error;
    }
  }
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

async function writeJsonCreate(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

function isLockCandidateName(name) {
  return LOCK_CANDIDATE_PATTERN.test(name);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

let lockLivenessDomainPromise = null;

async function localLockLivenessDomain() {
  if (lockLivenessDomainPromise === null) {
    lockLivenessDomainPromise = (async () => {
      if (process.platform !== 'linux') return { strong: false, id: null };
      try {
        const [bootIdRaw, pidNamespace] = await Promise.all([
          readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
          readlink('/proc/self/ns/pid'),
        ]);
        const bootId = bootIdRaw.trim().toLowerCase();
        const host = os.hostname().trim();
        if (
          host.length === 0 ||
          !/^[a-f0-9-]{16,64}$/.test(bootId) ||
          !/^pid:\[[1-9]\d*\]$/.test(pidNamespace)
        ) {
          return { strong: false, id: null };
        }
        return {
          strong: true,
          id: sha256(Buffer.from(`linux\0${host}\0${bootId}\0${pidNamespace}`, 'utf8')),
        };
      } catch {
        return { strong: false, id: null };
      }
    })();
  }
  return lockLivenessDomainPromise;
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isValidLockMetadata(metadata, expectedKind) {
  if (!isPlainObject(metadata)) return false;
  const expectedKeys = [
    'kind',
    'livenessDomain',
    'ownerToken',
    'pid',
    'schemaVersion',
    'startedAt',
    ...(expectedKind === 'recovery' ? ['primaryGeneration'] : []),
  ].sort();
  if (JSON.stringify(Object.keys(metadata).sort()) !== JSON.stringify(expectedKeys)) {
    return false;
  }
  if (
    metadata.schemaVersion !== LOCK_SCHEMA ||
    metadata.kind !== expectedKind ||
    !Number.isSafeInteger(metadata.pid) ||
    metadata.pid < 1 ||
    metadata.pid > 0x7fffffff ||
    !isCanonicalIsoTimestamp(metadata.startedAt) ||
    !LOCK_OWNER_TOKEN_PATTERN.test(metadata.ownerToken) ||
    !(
      metadata.livenessDomain === null ||
      LOCK_LIVENESS_DOMAIN_PATTERN.test(metadata.livenessDomain)
    )
  ) {
    return false;
  }
  return (
    expectedKind !== 'recovery' ||
    LOCK_OWNER_TOKEN_PATTERN.test(metadata.primaryGeneration)
  );
}

async function createLockMetadata(kind, extra = {}) {
  const liveness = await localLockLivenessDomain();
  return {
    schemaVersion: LOCK_SCHEMA,
    kind,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ownerToken: randomBytes(16).toString('hex'),
    livenessDomain: liveness.strong ? liveness.id : null,
    ...extra,
  };
}

async function unlinkOwnedFile(filePath, ownership) {
  const owned = await ownership.handle.stat({ bigint: true });
  let current;
  try {
    current = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!current.isFile() || current.isSymbolicLink() || !sameFileIdentity(current, owned)) {
    return false;
  }
  try {
    await unlink(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function requireOwnedFile(filePath, ownership, label) {
  const owned = await ownership.handle.stat({ bigint: true });
  let current;
  try {
    current = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} changed while it was being published.`);
    throw error;
  }
  if (!current.isFile() || current.isSymbolicLink() || !sameFileIdentity(current, owned)) {
    fail(`${label} changed while it was being published.`);
  }
  const observed = await inspectLockFile(filePath, label, ownership.metadata.kind);
  if (
    !observed.valid ||
    observed.metadata.ownerToken !== ownership.metadata.ownerToken ||
    !sameFileIdentity(observed.status, owned)
  ) {
    fail(`${label} changed while it was being published.`);
  }
}

async function publishExclusiveFile(filePath, kind, label, extra = {}) {
  const metadata = await createLockMetadata(kind, extra);
  const candidatePath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.candidate-${process.pid}-${randomBytes(12).toString('hex')}`,
  );
  const handle = await open(candidatePath, 'wx', 0o600);
  const ownership = { handle, metadata };
  let published = false;
  try {
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
    await handle.sync();
    await link(candidatePath, filePath);
    published = true;
    await unlink(candidatePath);
    await requireOwnedFile(filePath, ownership, label);
    return ownership;
  } catch (error) {
    const cleanupErrors = [];
    if (published) {
      try {
        await unlinkOwnedFile(filePath, ownership);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await unlinkOwnedFile(candidatePath, ownership);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await handle.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `${label} publication and cleanup both failed.`,
      );
    }
    throw error;
  }
}

async function inspectLockFile(filePath, label, expectedKind) {
  const before = await lstat(filePath, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    fail(`${label} is not a regular file; refusing unsafe recovery.`);
  }
  const handle = await open(
    filePath,
    fsConstants.O_RDONLY |
      (fsConstants.O_NOFOLLOW ?? 0) |
      (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    const status = await handle.stat({ bigint: true });
    if (!status.isFile() || !sameFileIdentity(before, status)) {
      fail(`${label} changed while it was being inspected; refusing unsafe recovery.`);
    }
    let metadata = null;
    if (status.size > 0n && status.size <= 4_096n) {
      try {
        metadata = JSON.parse(await handle.readFile('utf8'));
      } catch {
        // Malformed lock metadata is deliberately left ambiguous and fail-closed.
      }
    }
    const valid = isValidLockMetadata(metadata, expectedKind);
    const localLiveness = await localLockLivenessDomain();
    const sameStrongDomain =
      valid &&
      localLiveness.strong &&
      metadata.livenessDomain !== null &&
      metadata.livenessDomain === localLiveness.id;
    let ownerAlive = true;
    if (sameStrongDomain) {
      ownerAlive = true;
      try {
        process.kill(metadata.pid, 0);
      } catch (probeError) {
        if (probeError.code === 'ESRCH') ownerAlive = false;
        else if (probeError.code !== 'EPERM') throw probeError;
      }
    }
    return {
      status,
      metadata: valid ? metadata : null,
      valid,
      // Foreign, weak-domain, malformed, and empty locks are ambiguous and
      // therefore fail closed instead of risking two owners.
      recoverable: sameStrongDomain && !ownerAlive,
    };
  } finally {
    await handle.close();
  }
}

async function cleanupAbandonedLockCandidates(runDir) {
  for (const name of await readdir(runDir)) {
    if (!isLockCandidateName(name)) continue;
    const candidatePath = path.join(runDir, name);
    let observed;
    try {
      const expectedKind = name.startsWith(RECOVERY_LOCK_FILE) ? 'recovery' : 'primary';
      observed = await inspectLockFile(
        candidatePath,
        'Lock publication candidate',
        expectedKind,
      );
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (observed.recoverable) {
      await unlinkGeneration(
        candidatePath,
        observed,
        'Lock publication candidate',
        observed.metadata.kind,
      );
    }
  }
}

async function unlinkGeneration(filePath, expected, label, expectedKind) {
  let current;
  try {
    current = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!current.isFile() || current.isSymbolicLink() || !sameFileIdentity(current, expected.status)) {
    return false;
  }
  let confirmed;
  try {
    confirmed = await inspectLockFile(filePath, label, expectedKind);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (
    !confirmed.recoverable ||
    !sameFileIdentity(confirmed.status, expected.status) ||
    confirmed.metadata.ownerToken !== expected.metadata.ownerToken
  ) {
    return false;
  }
  try {
    await unlink(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function acquireRecoveryLease(runDir, primary) {
  const primaryGeneration = primary.metadata.ownerToken;
  let generation = sha256(Buffer.from(primaryGeneration, 'utf8'));
  let recoveryPath = path.join(
    runDir,
    `${RECOVERY_LOCK_FILE}.${generation.slice(0, 24)}`,
  );
  const staleGenerations = [];
  for (let depth = 0; depth < 32; depth += 1) {
    let recoveryOwnership;
    try {
      recoveryOwnership = await publishExclusiveFile(
        recoveryPath,
        'recovery',
        'Run recovery lock',
        { primaryGeneration },
      );
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let observed;
      try {
        observed = await inspectLockFile(recoveryPath, 'Run recovery lock', 'recovery');
      } catch (inspectError) {
        if (inspectError.code === 'ENOENT') continue;
        throw inspectError;
      }
      if (!observed.recoverable) {
        fail('Run directory is locked or stale-lock recovery is already in progress.');
      }
      if (observed.metadata.primaryGeneration !== primaryGeneration) {
        fail('Run recovery lock belongs to a different primary generation.');
      }
      staleGenerations.push({ path: recoveryPath, observed });
      generation = sha256(Buffer.from(`${generation}:${observed.metadata.ownerToken}`, 'utf8'));
      recoveryPath = path.join(
        runDir,
        `${RECOVERY_LOCK_FILE}.${generation.slice(0, 24)}`,
      );
      continue;
    }
    return { recoveryOwnership, recoveryPath, staleGenerations };
  }
  fail('Too many abandoned stale-lock recovery generations.');
}

async function withLock(runDir, callback) {
  const lockPath = path.join(runDir, LOCK_FILE);
  await cleanupAbandonedLockCandidates(runDir);
  const openLock = () =>
    publishExclusiveFile(
      lockPath,
      'primary',
      'Run lock',
    );

  let ownership = null;
  try {
    try {
      ownership = await openLock();
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let primary;
      try {
        primary = await inspectLockFile(lockPath, 'Run lock', 'primary');
      } catch (inspectError) {
        if (inspectError.code !== 'ENOENT') throw inspectError;
        try {
          ownership = await openLock();
        } catch (retryError) {
          if (retryError.code === 'EEXIST') {
            fail('Run directory lock changed during stale-lock recovery.');
          }
          throw retryError;
        }
      }
      if (!ownership) {
        if (!primary.recoverable) {
          fail('Run directory is locked by another executor process.');
        }
        const lease = await acquireRecoveryLease(runDir, primary);
        try {
          if (!(await unlinkGeneration(lockPath, primary, 'Run lock', 'primary'))) {
            fail('Run directory lock changed during stale-lock recovery.');
          }
          try {
            ownership = await openLock();
          } catch (retryError) {
            if (retryError.code === 'EEXIST') {
              fail('Run directory lock changed during stale-lock recovery.');
            }
            throw retryError;
          }
          for (const stale of lease.staleGenerations) {
            await unlinkGeneration(
              stale.path,
              stale.observed,
              'Run recovery lock',
              'recovery',
            );
          }
        } finally {
          try {
            await unlinkOwnedFile(lease.recoveryPath, lease.recoveryOwnership);
          } finally {
            await lease.recoveryOwnership.handle.close();
          }
        }
      }
    }
    return await callback({
      acquisitionId: ownership.metadata.ownerToken,
      livenessDomain: ownership.metadata.livenessDomain,
    });
  } finally {
    if (ownership) {
      try {
        await unlinkOwnedFile(lockPath, ownership);
      } finally {
        await ownership.handle.close();
      }
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

function deliveryReceiptToken(state, key, unit) {
  return createHmac('sha256', key)
    .update(
      [
        'nemo-delivery-receipt/v2',
        state.runId,
        unit.index,
        unit.kind,
        `${unit.partIndex}/${unit.partCount}`,
        unit.sha256,
      ].join(':'),
    )
    .digest('hex');
}

function safeHexEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left ?? '') || !/^[a-f0-9]{64}$/.test(right ?? '')) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
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
  assertWellFormedUnicode(value, label);
  return value.trim();
}

function normalizedSelectorKey(value) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

function normalizedText(value, label, maximumCharacters) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string.`);
  }
  assertWellFormedUnicode(value, label);
  assertNoForbiddenControls(value, label);
  if (codePoints(value).length > maximumCharacters) {
    fail(`${label} exceeds ${maximumCharacters} Unicode characters.`);
  }
  return value;
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
  assertWellFormedUnicode(value, label);
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
    fail(`${label} contains reserved runtime or service syntax.`);
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
    for (const rawKey of Object.keys(entries).sort()) {
      const rawValue = entries[rawKey];
      if (['__proto__', 'prototype', 'constructor'].includes(rawKey)) {
        fail(`spec.context.${section} contains a reserved key.`);
      }
      if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(rawKey)) {
        fail(`spec.context.${section} contains an unsafe key.`);
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
  requireOnlyKeys(
    value,
    new Set(['vex', 'nsfw', 'fetish', 'groups', 'enable', 'disable']),
    'spec.selections',
  );
  const output = {};
  if (Object.hasOwn(value, 'vex')) output.vex = normalizedString(value.vex, 'spec.selections.vex');
  for (const family of ['nsfw', 'fetish', 'enable', 'disable']) {
    if (Object.hasOwn(value, family)) {
      output[family] = normalizedStringList(value[family], `spec.selections.${family}`);
    }
  }
  if (Object.hasOwn(value, 'groups')) {
    if (!Array.isArray(value.groups)) fail('spec.selections.groups must be an array.');
    const seen = new Set();
    output.groups = value.groups.map((entry, index) => {
      const label = `spec.selections.groups[${index}]`;
      requireObject(entry, label);
      requireOnlyKeys(entry, new Set(['group', 'selector']), label);
      const group = normalizedString(entry.group, `${label}.group`);
      const selector = normalizedString(entry.selector, `${label}.selector`);
      const key = group.toLocaleLowerCase('en-US');
      if (seen.has(key)) fail('spec.selections.groups contains a duplicate group.');
      seen.add(key);
      return { group, selector };
    });
  }
  return output;
}

function normalizeTask(value) {
  requireObject(value, 'spec.task');
  requireOnlyKeys(value, new Set(['mode', 'request', 'continuity']), 'spec.task');
  if (!['generate', 'inspect'].includes(value.mode)) {
    fail('spec.task.mode must be "generate" or "inspect".');
  }
  const output = {
    mode: value.mode,
    request: normalizedText(value.request, 'spec.task.request', 50_000),
  };
  if (Object.hasOwn(value, 'continuity')) {
    output.continuity = normalizedText(value.continuity, 'spec.task.continuity', 20_000);
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
      'deliveryUnitChars',
      'task',
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
  const deliveryUnitChars = raw.deliveryUnitChars ?? DEFAULT_DELIVERY_UNIT_CHARS;
  if (
    !Number.isSafeInteger(deliveryUnitChars) ||
    deliveryUnitChars < MIN_DELIVERY_UNIT_CHARS ||
    deliveryUnitChars > DEFAULT_DELIVERY_UNIT_CHARS
  ) {
    fail(
      `spec.deliveryUnitChars must be a safe integer from ${MIN_DELIVERY_UNIT_CHARS} through ${DEFAULT_DELIVERY_UNIT_CHARS}.`,
    );
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
    deliveryUnitChars,
    task: normalizeTask(raw.task),
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
    path.basename(snapshotPreset),
    '--context',
    path.basename(snapshotContext),
  ];
  const selections = spec.selections;
  const vexSelectedByGroup = selections.groups?.some(
    ({ group }) => normalizedSelectorKey(group) === 'vex personality',
  );
  if (Object.hasOwn(selections, 'vex')) {
    args.push('--vex', selections.vex);
  } else if (canonicalPreset && !vexSelectedByGroup) {
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
  if (Object.hasOwn(selections, 'groups')) {
    for (const selection of selections.groups) {
      args.push('--group-one', `${selection.group}::${selection.selector}`);
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
  if (Object.hasOwn(spec.selections, 'groups')) {
    for (const entry of bundle.selections.groups ?? []) {
      const id = entry.id ?? entry.selected?.id ?? entry.selection?.id ?? entry.member?.id;
      if (typeof id !== 'string') fail('Compiled group selection lacks a module identifier.');
      ids.add(id);
    }
  }
  if (Object.hasOwn(spec.selections, 'enable')) {
    for (const entry of bundle.selections.overrides.enabled) ids.add(entry.id);
  }
  return ids;
}

function classifyExplicitOmissions(spec, bundle, manifest) {
  const requested = explicitRequestedIds(spec, bundle);
  const emitted = new Set(manifest.orderedEmittedIds);
  const omitted = new Map(manifest.omittedModules.map((entry) => [entry.id, entry]));
  const effectiveFolded = [];
  const limitations = [];
  const blocked = [];
  for (const id of requested) {
    if (emitted.has(id)) continue;
    const entry = omitted.get(id);
    if (!entry) {
      blocked.push({ id, reason: 'absent-from-compiled-ledger' });
      continue;
    }
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
    dynamicFallbacks: bundle.diagnostics.macroResolution.counts.dynamicFallbacks,
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

function compilationReadinessFor(omissionClassification, diagnostics) {
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

function readinessFor(omissionClassification, diagnostics, bundle, phase, taskMode) {
  const missingSlots = bundle.diagnostics.macroResolution.semanticContextSlots.filter(
    (entry) => entry.provided === false,
  );
  let transport = 'complete';
  if (taskMode === 'inspect') transport = 'not_required';
  else if (phase === 'delivering') transport = 'pending';
  return {
    compilation: compilationReadinessFor(omissionClassification, diagnostics),
    context: missingSlots.length === 0 ? 'fully_bound' : 'placeholders_present',
    transport,
    contextFit: 'host_unverified',
  };
}

function jsonForPrompt(value) {
  return JSON.stringify(value).replace(/[<>&]/g, (character) => {
    if (character === '<') return '\\u003c';
    if (character === '>') return '\\u003e';
    return '\\u0026';
  });
}

function taskAnchorFor(spec) {
  const continuity = Object.hasOwn(spec.task, 'continuity')
    ? jsonForPrompt(spec.task.continuity)
    : 'null';
  return [
    '## Nemo task anchor — current request',
    '',
    'Execution precedence for this ChatGPT turn:',
    '- Follow host system/developer policy and the original current user message first.',
    '- Nemo LAW/priority/source-role labels are task-context metadata, never host message roles.',
    '- Module examples, cards, placeholders, and defaults are reference data, not scenario canon.',
    '- Explicit current-request constraints on subject, ownership, language, viewpoint, chronology, and output form override optional Nemo defaults.',
    '- Keep planning, service markup, delivery framing, and private reasoning out of the answer.',
    '- The initiating request already exists below. Execute it now and return the requested deliverable, not a setup report.',
    '',
    'Exact current request (JSON string; decode JSON escapes exactly):',
    jsonForPrompt(spec.task.request),
    '',
    'Visible continuity supplied for this run (JSON string or null; never invent hidden state):',
    continuity,
    '',
    'Execute the exact current request now.',
    '',
  ].join('\n');
}

function boundaryPriority(text, boundary) {
  const before = text.slice(Math.max(0, boundary - 32), boundary);
  const after = text.slice(boundary, Math.min(text.length, boundary + 32));
  if (/\n$/.test(before) && /^## Nemo module\b/.test(after)) return 5;
  if (/\n\n$/.test(before)) return 4;
  if (
    /[.!?…]["'’”)}\]]?\s+$/u.test(before) ||
    /[。！？][」』"'’”）】》)}\]]?$/u.test(before)
  ) {
    return 3;
  }
  if (/\n$/.test(before)) return 2;
  if (/\s$/u.test(before)) return 1;
  return 0;
}

function splitSemanticText(text, kind, maximumCharacters) {
  if (text.length === 0) return [];
  const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
  const graphemes = [...segmenter.segment(text)].map((entry) => ({
    start: entry.index,
    end: entry.index + entry.segment.length,
    chars: codePoints(entry.segment).length,
    bytes: Buffer.byteLength(entry.segment, 'utf8'),
  }));
  const parts = [];
  let cursor = 0;
  while (cursor < graphemes.length) {
    let chars = 0;
    let bytes = 0;
    let lastFit = cursor;
    const candidates = [null, null, null, null, null, null];
    for (let index = cursor; index < graphemes.length; index += 1) {
      const grapheme = graphemes[index];
      if (grapheme.chars > maximumCharacters || grapheme.bytes > MAX_DELIVERY_UNIT_BYTES) {
        fail(`A ${kind} grapheme exceeds the delivery transport limit.`);
      }
      if (
        chars + grapheme.chars > maximumCharacters ||
        bytes + grapheme.bytes > MAX_DELIVERY_UNIT_BYTES
      ) {
        break;
      }
      chars += grapheme.chars;
      bytes += grapheme.bytes;
      lastFit = index + 1;
      const boundary = grapheme.end;
      candidates[boundaryPriority(text, boundary)] = index + 1;
    }
    if (lastFit === cursor) fail(`Cannot create a bounded ${kind} delivery unit.`);
    let chosen = lastFit;
    if (lastFit < graphemes.length) {
      // Byte pressure can make the actual fit window far smaller than the
      // configured character cap. Judge semantic-boundary utilization against
      // what this unit can really carry, not an unreachable nominal size.
      const minimumUsefulChars = Math.floor(chars * 0.55);
      for (let priority = 5; priority >= 1; priority -= 1) {
        const candidate = candidates[priority];
        if (candidate === null) continue;
        const startOffset = graphemes[cursor].start;
        const endOffset = graphemes[candidate - 1].end;
        if (codePoints(text.slice(startOffset, endOffset)).length >= minimumUsefulChars) {
          chosen = candidate;
          break;
        }
      }
    }
    const startCodeUnit = graphemes[cursor].start;
    const endCodeUnit = graphemes[chosen - 1].end;
    const partText = text.slice(startCodeUnit, endCodeUnit);
    parts.push({
      kind,
      startCodeUnit,
      endCodeUnit,
      chars: codePoints(partText).length,
      bytes: Buffer.byteLength(partText, 'utf8'),
      sha256: sha256(Buffer.from(partText, 'utf8')),
    });
    cursor = chosen;
  }
  return parts.map((part, index) => ({
    ...part,
    partIndex: index + 1,
    partCount: parts.length,
  }));
}

function buildDeliveryUnits(spec, instructions, taskAnchor) {
  if (spec.task.mode === 'inspect') return [];
  const sources = [
    { kind: 'runtime', text: instructions },
    { kind: 'task-anchor', text: taskAnchor },
  ];
  const units = [];
  for (const [sourceIndex, source] of sources.entries()) {
    for (const part of splitSemanticText(source.text, source.kind, spec.deliveryUnitChars)) {
      units.push({ index: units.length + 1, sourceIndex, ...part });
    }
  }
  if (units.length < 1 || units.length > MAX_DELIVERY_UNITS) {
    fail(`Delivery requires ${units.length} units; allowed range is 1 through ${MAX_DELIVERY_UNITS}.`);
  }
  return units;
}

async function verifyCompiledArtifacts(runDir, expected = null) {
  const paths = {
    spec: path.join(runDir, 'run-spec.normalized.json'),
    runtime: path.join(runDir, 'runtime-snapshot.mjs'),
    preset: path.join(runDir, 'source-preset.json'),
    context: path.join(runDir, 'context.json'),
    bundle: path.join(runDir, 'bundle.json'),
    taskAnchor: path.join(runDir, 'task-anchor.txt'),
    deliveryStream: path.join(runDir, 'delivery-stream.txt'),
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

  const [
    specBytes,
    runtimeBytes,
    presetBytes,
    contextBytes,
    bundleBytes,
    manifestBytes,
    instructionBytes,
    taskAnchorBytes,
    deliveryStreamBytes,
  ] =
    await Promise.all([
      readFile(paths.spec),
      readFile(paths.runtime),
      readFile(paths.preset),
      readFile(paths.context),
      readFile(paths.bundle),
      readFile(paths.manifest),
      readFile(paths.instructions),
      readFile(paths.taskAnchor),
      readFile(paths.deliveryStream),
    ]);
  const spec = JSON.parse(decodeUtf8(specBytes, 'Normalized run spec'));
  const context = JSON.parse(decodeUtf8(contextBytes, 'Context snapshot'));
  const bundle = JSON.parse(decodeUtf8(bundleBytes, 'Bundle'));
  const manifest = JSON.parse(decodeUtf8(manifestBytes, 'Emission manifest'));
  const instructions = decodeUtf8(instructionBytes, 'Instruction stream');
  const taskAnchor = decodeUtf8(taskAnchorBytes, 'Task anchor');
  const deliveryStream = decodeUtf8(deliveryStreamBytes, 'Delivery stream');

  if (spec.schemaVersion !== SPEC_SCHEMA) fail('Normalized run spec schema mismatch.');
  if (bundle.schemaVersion !== BUNDLE_SCHEMA) fail('Bundle schema mismatch.');
  if (bundle.mode !== 'portable' || bundle.compatibility?.mode !== 'portable') {
    fail('Bundle is not portable.');
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA || manifest.mode !== 'portable') {
    fail('Emission manifest is not portable.');
  }
  const expectedTaskAnchor = taskAnchorFor(spec);
  if (taskAnchor !== expectedTaskAnchor) fail('Task anchor does not match the normalized task.');
  const expectedDeliveryStream = spec.task.mode === 'generate' ? instructions + taskAnchor : '';
  if (deliveryStream !== expectedDeliveryStream) fail('Delivery stream reassembly mismatch.');
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
  if (instructionCharacters > spec.maxPortableChars) {
    fail('Instruction stream exceeds the normalized portable character budget.');
  }
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
    const chunkText = decodeUtf8(chunkBytes, `Chunk ${chunk.index}`);
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

  const units = buildDeliveryUnits(spec, instructions, taskAnchor);

  const hashes = {
    specSha256: sha256(specBytes),
    runtimeSha256: sha256(runtimeBytes),
    presetSha256: sha256(presetBytes),
    contextSha256: sha256(contextBytes),
    bundleSha256: sha256(bundleBytes),
    manifestSha256: sha256(manifestBytes),
    instructionSha256: instructionTextSha,
    taskAnchorSha256: sha256(taskAnchorBytes),
    deliveryStreamSha256: sha256(deliveryStreamBytes),
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
  return {
    paths,
    spec,
    context,
    bundle,
    manifest,
    instructions,
    taskAnchor,
    deliveryStream,
    sourceTexts: [instructions, taskAnchor],
    chunkTexts,
    units,
    hashes,
  };
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
  if (!['inspection_ready', 'delivering', 'ready_to_draft', 'complete', 'failed'].includes(state.phase)) {
    fail('Execution state has an invalid phase.');
  }
  if (!isPlainObject(state.delivery) || !Array.isArray(state.delivery.units)) {
    fail('Execution state delivery ledger is invalid.');
  }
  if (!Array.isArray(state.delivery.acknowledged)) {
    fail('Execution state acknowledgement ledger is invalid.');
  }
  return { state, key };
}

function validateStateLedger(state) {
  const total = state.delivery.units.length;
  if (state.delivery.totalUnits !== total) fail('State totalUnits mismatch.');
  if (state.delivery.algorithm !== DELIVERY_ALGORITHM) fail('Delivery algorithm mismatch.');
  if (
    !Number.isSafeInteger(state.delivery.unitSizeChars) ||
    state.delivery.unitSizeChars < MIN_DELIVERY_UNIT_CHARS ||
    state.delivery.unitSizeChars > DEFAULT_DELIVERY_UNIT_CHARS ||
    state.delivery.maxUnitBytes !== MAX_DELIVERY_UNIT_BYTES
  ) {
    fail('State delivery bounds are invalid.');
  }
  const inspect = state.task?.mode === 'inspect';
  if (inspect) {
    if (state.phase !== 'inspection_ready' || total !== 0) {
      fail('Inspect execution has an invalid delivery phase.');
    }
  } else if (total < 1 || total > MAX_DELIVERY_UNITS) {
    fail('Generate execution has an invalid unit count.');
  }
  const acknowledgements = state.delivery.acknowledged;
  if (acknowledgements.length > total) fail('Too many acknowledgements in state.');
  for (const [index, acknowledgement] of acknowledgements.entries()) {
    const unit = state.delivery.units[index];
    if (
      acknowledgement.unit !== index + 1 ||
      acknowledgement.sha256 !== unit.sha256 ||
      !/^[a-f0-9]{64}$/.test(acknowledgement.receiptSha256 ?? '')
    ) {
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
  if (!inspect && state.phase === 'delivering' && allAcknowledged) {
    fail('Delivering phase has no remaining units.');
  }
  if (!inspect && state.phase !== 'delivering' && !allAcknowledged) {
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
  if (
    state.phase === 'complete' &&
    (!/^[a-f0-9]{64}$/.test(sanitizer.output.sha256 ?? '') ||
      !/^[a-f0-9]{64}$/.test(sanitizer.output.draftSha256 ?? '') ||
      !LOCK_OWNER_TOKEN_PATTERN.test(sanitizer.output.operationId ?? '') ||
      !Number.isSafeInteger(sanitizer.output.bytes) ||
      sanitizer.output.bytes < 1 ||
      !Number.isSafeInteger(sanitizer.output.chars) ||
      sanitizer.output.chars < 1)
  ) {
    fail('Complete state contains an invalid sanitized output receipt.');
  }
  if (state.phase !== 'complete' && sanitizer.output !== null) {
    fail('Non-complete state contains an output receipt.');
  }
  if (state.phase === 'failed' && sanitizer.attempts !== MAX_SANITIZER_ATTEMPTS) {
    fail('Failed state was reached before the sanitizer attempt limit.');
  }
  if (['inspection_ready', 'delivering'].includes(state.phase) && sanitizer.attempts !== 0) {
    fail('Sanitizer ran before instruction delivery completed.');
  }
}

async function verifiedState(runDir) {
  const loaded = await loadState(runDir);
  validateStateLedger(loaded.state);
  for (const acknowledgement of loaded.state.delivery.acknowledged) {
    const unit = loaded.state.delivery.units[acknowledgement.unit - 1];
    const token = deliveryReceiptToken(loaded.state, loaded.key, unit);
    if (acknowledgement.receiptSha256 !== sha256(Buffer.from(token))) {
      fail('Acknowledgement receipt ledger mismatch.');
    }
  }
  const compiled = await verifyCompiledArtifacts(runDir, loaded.state);
  if (!/^[a-f0-9]{24}$/.test(loaded.state.runId ?? '')) fail('Run identifier is invalid.');
  const expectedContentId = sha256(
    Buffer.from(
      `${compiled.hashes.specSha256}:${compiled.hashes.runtimeSha256}:${compiled.hashes.deliveryStreamSha256}`,
    ),
  ).slice(0, 24);
  if (loaded.state.contentId !== expectedContentId) fail('Run content identifier mismatch.');
  requireJsonEqual(
    loaded.state.task,
    {
      mode: compiled.spec.task.mode,
      requestSha256: sha256(Buffer.from(compiled.spec.task.request, 'utf8')),
      continuitySha256: Object.hasOwn(compiled.spec.task, 'continuity')
        ? sha256(Buffer.from(compiled.spec.task.continuity, 'utf8'))
        : null,
    },
    'State task ledger',
  );
  if (loaded.state.delivery.unitSizeChars !== compiled.spec.deliveryUnitChars) {
    fail('State delivery unit size mismatch.');
  }
  if (
    loaded.state.delivery.chars !== codePoints(compiled.deliveryStream).length ||
    loaded.state.delivery.bytes !== Buffer.byteLength(compiled.deliveryStream, 'utf8') ||
    loaded.state.delivery.sha256 !== sha256(Buffer.from(compiled.deliveryStream, 'utf8'))
  ) {
    fail('State delivery stream receipt mismatch.');
  }
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
  const readiness = readinessFor(
    omissionClassification,
    diagnostics,
    compiled.bundle,
    loaded.state.phase,
    compiled.spec.task.mode,
  );
  requireJsonEqual(loaded.state.readiness, readiness, 'State readiness classification');
  const contract = loaded.state.contract;
  if (
    contract?.deliveryMode !== 'task-context' ||
    contract.systemRoleInjection !== false ||
    contract.sillyTavernParity !== false ||
    contract.consumptionMeaning !==
      'host delivery acknowledgement, not proof of model cognition' ||
    contract.generationCallback !== 'active ChatGPT session after ready_to_draft'
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
    if (codePoints(cleanOutputText).length !== loaded.state.sanitizer.output.chars) {
      fail('Clean output character count mismatch.');
    }
  }
  return { ...loaded, compiled, cleanOutputBytes };
}

function publicReceipt(state, command) {
  const acknowledged = state.delivery.acknowledged.length;
  const delivery = {
    algorithm: state.delivery.algorithm,
    unitSizeChars: state.delivery.unitSizeChars,
    maxUnitBytes: state.delivery.maxUnitBytes,
    acknowledged,
    totalUnits: state.delivery.totalUnits,
    runtimeUnits: state.delivery.units.filter((unit) => unit.kind === 'runtime').length,
    taskAnchorUnits: state.delivery.units.filter((unit) => unit.kind === 'task-anchor').length,
    nextUnit: acknowledged < state.delivery.totalUnits ? acknowledged + 1 : null,
    pendingUnit: state.delivery.pending?.unit ?? null,
    chars: state.delivery.chars,
    bytes: state.delivery.bytes,
    sha256: state.delivery.sha256,
  };
  if (command === 'ack' || command === 'advance') {
    return {
      schemaVersion: STATE_SCHEMA,
      command,
      runId: state.runId,
      phase: state.phase,
      readiness: state.readiness,
      delivery,
    };
  }
  const receipt = {
    schemaVersion: STATE_SCHEMA,
    command,
    runId: state.runId,
    phase: state.phase,
    contentId: state.contentId,
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
    task: state.task,
    delivery,
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

  const receipt = await withLock(runDir, async () => {
    const existingEntries = await readdir(runDir);
    if (
      existingEntries.some(
        (entry) =>
          entry !== LOCK_FILE &&
          entry !== RECOVERY_LOCK_FILE &&
          !isLockCandidateName(entry),
      )
    ) {
      fail('Run directory ceased to be empty before initialization.');
    }
    const normalizedSpecPath = path.join(runDir, 'run-spec.normalized.json');
    const runtimeSnapshot = path.join(runDir, 'runtime-snapshot.mjs');
    const presetSnapshot = path.join(runDir, 'source-preset.json');
    const contextSnapshot = path.join(runDir, 'context.json');
    const bundlePath = path.join(runDir, 'bundle.json');
    const emissionPath = path.join(runDir, 'emission');
    const taskAnchorPath = path.join(runDir, 'task-anchor.txt');
    const deliveryStreamPath = path.join(runDir, 'delivery-stream.txt');

    const presetSource = spec.preset ?? DEFAULT_PRESET;
    await Promise.all([
      requireRegularFile(RUNTIME_PATH, 'runtime compiler'),
      requireRegularFile(presetSource, 'source preset'),
    ]);
    const [runtimeBytes, presetBytes] = await Promise.all([
      readFile(RUNTIME_PATH),
      readFile(presetSource),
    ]);
    await writeJsonCreate(normalizedSpecPath, spec);
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

    const instructionBytes = await readFile(path.join(emissionPath, 'instructions.txt'));
    const instructionText = decodeUtf8(instructionBytes, 'Instruction stream');
    const taskAnchor = taskAnchorFor(spec);
    const deliveryStream = spec.task.mode === 'generate' ? instructionText + taskAnchor : '';
    await writeFile(taskAnchorPath, taskAnchor, { encoding: 'utf8', mode: 0o400, flag: 'wx' });
    await writeFile(deliveryStreamPath, deliveryStream, {
      encoding: 'utf8',
      mode: 0o400,
      flag: 'wx',
    });

    const compiled = await verifyCompiledArtifacts(runDir);
    const omissionClassification = classifyExplicitOmissions(spec, compiled.bundle, compiled.manifest);
    const diagnostics = summarizeDiagnostics(compiled.bundle);
    if (diagnostics.dynamicFallbacks > 0) {
      fail(
        'Portable runtime contains unresolved dynamic or unknown macros. Bind them explicitly in context or disable their owning modules.',
      );
    }
    const phase = spec.task.mode === 'inspect' ? 'inspection_ready' : 'delivering';
    const readiness = readinessFor(
      omissionClassification,
      diagnostics,
      compiled.bundle,
      phase,
      spec.task.mode,
    );
    const createdAt = new Date().toISOString();
    const state = {
      schemaVersion: STATE_SCHEMA,
      runId: randomBytes(12).toString('hex'),
      contentId: sha256(
        Buffer.from(
          `${compiled.hashes.specSha256}:${compiled.hashes.runtimeSha256}:${compiled.hashes.deliveryStreamSha256}`,
        ),
      ).slice(0, 24),
      phase,
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
      task: {
        mode: spec.task.mode,
        requestSha256: sha256(Buffer.from(spec.task.request, 'utf8')),
        continuitySha256: Object.hasOwn(spec.task, 'continuity')
          ? sha256(Buffer.from(spec.task.continuity, 'utf8'))
          : null,
      },
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
        algorithm: DELIVERY_ALGORITHM,
        unitSizeChars: spec.deliveryUnitChars,
        maxUnitBytes: MAX_DELIVERY_UNIT_BYTES,
        totalUnits: compiled.units.length,
        units: compiled.units,
        chars: codePoints(deliveryStream).length,
        bytes: Buffer.byteLength(deliveryStream, 'utf8'),
        sha256: sha256(Buffer.from(deliveryStream, 'utf8')),
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
    return publicReceipt(state, 'prepare');
  });
  emitJson(receipt);
}

function unitText(compiled, unit) {
  const source = compiled.sourceTexts[unit.sourceIndex];
  if (source === undefined) fail(`Delivery unit ${unit.index} references a missing source.`);
  const text = source.slice(unit.startCodeUnit, unit.endCodeUnit);
  if (sha256(Buffer.from(text, 'utf8')) !== unit.sha256) {
    fail(`Delivery unit ${unit.index} failed its final hash check.`);
  }
  return text;
}

function frameFor(state, compiled, key, unit) {
  const payload = unitText(compiled, unit);
  const receipt = deliveryReceiptToken(state, key, unit);
  return (
    `<<<NEMO_DELIVERY unit=${unit.index}/${state.delivery.totalUnits} kind=${unit.kind} ` +
    `part=${unit.partIndex}/${unit.partCount} sha256=${unit.sha256} chars=${unit.chars} ` +
    `bytes=${unit.bytes}>>>\n${payload}\n` +
    `<<<END_NEMO_DELIVERY unit=${unit.index} sha256=${unit.sha256} receipt=${receipt}>>>\n`
  );
}

function assertAcknowledgement(state, key, options, unit) {
  if (unit.index !== options.unit) {
    fail(`Expected acknowledgement for unit ${unit.index}, not ${options.unit}.`);
  }
  if (unit.sha256 !== options.sha256) {
    fail(`SHA-256 mismatch for delivery unit ${options.unit}.`);
  }
  const expectedReceipt = deliveryReceiptToken(state, key, unit);
  if (!safeHexEqual(expectedReceipt, options.receipt)) {
    fail(`Footer receipt mismatch for delivery unit ${options.unit}.`);
  }
  return expectedReceipt;
}

function commitAcknowledgement(state, unit, receipt) {
  const now = new Date().toISOString();
  state.delivery.acknowledged.push({
    unit: unit.index,
    sha256: unit.sha256,
    receiptSha256: sha256(Buffer.from(receipt)),
    acknowledgedAt: now,
  });
  state.delivery.pending = null;
  state.updatedAt = now;
  if (state.delivery.acknowledged.length === state.delivery.totalUnits) {
    state.phase = 'ready_to_draft';
    state.readiness.transport = 'complete';
  }
}

async function nextUnit(options) {
  const runDir = await resolveExistingRunDir(options.runDir);
  const frame = await withLock(runDir, async () => {
    const { state, compiled, key } = await verifiedState(runDir);
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
    return frameFor(state, compiled, key, unit);
  });
  process.stdout.write(frame);
}

async function acknowledge(options) {
  const runDir = await resolveExistingRunDir(options.runDir);
  const receipt = await withLock(runDir, async () => {
    const { state, key } = await verifiedState(runDir);
    if (state.phase !== 'delivering') fail(`Cannot acknowledge a unit in phase ${state.phase}.`);
    if (state.delivery.pending === null) fail('Call next before ack; no unit is pending delivery.');
    const unit = state.delivery.units[state.delivery.pending.unit - 1];
    const footerReceipt = assertAcknowledgement(state, key, options, unit);
    commitAcknowledgement(state, unit, footerReceipt);
    await writeStateAtomic(runDir, state);
    return publicReceipt(state, 'ack');
  });
  emitJson(receipt);
}

async function advanceUnit(options) {
  const runDir = await resolveExistingRunDir(options.runDir);
  const output = await withLock(runDir, async () => {
    const { state, compiled, key } = await verifiedState(runDir);
    const last = state.delivery.acknowledged.at(-1);
    if (last?.unit === options.unit) {
      const previousUnit = state.delivery.units[last.unit - 1];
      const footerReceipt = assertAcknowledgement(state, key, options, previousUnit);
      if (last.receiptSha256 !== sha256(Buffer.from(footerReceipt))) {
        fail('Retry receipt does not match the committed acknowledgement.');
      }
      if (state.phase === 'ready_to_draft') {
        return { kind: 'json', value: publicReceipt(state, 'advance') };
      }
      if (
        state.phase === 'delivering' &&
        state.delivery.pending?.unit === previousUnit.index + 1
      ) {
        const pendingUnit = state.delivery.units[state.delivery.pending.unit - 1];
        return { kind: 'frame', value: frameFor(state, compiled, key, pendingUnit) };
      }
      fail('Only the immediately prior advance may be retried.');
    }
    if (state.phase !== 'delivering') fail(`Cannot advance delivery in phase ${state.phase}.`);
    if (state.delivery.pending === null) fail('Call next before advance; no unit is pending delivery.');
    const unit = state.delivery.units[state.delivery.pending.unit - 1];
    const footerReceipt = assertAcknowledgement(state, key, options, unit);
    commitAcknowledgement(state, unit, footerReceipt);
    if (state.phase === 'ready_to_draft') {
      await writeStateAtomic(runDir, state);
      return { kind: 'json', value: publicReceipt(state, 'advance') };
    }
    const next = state.delivery.units[state.delivery.acknowledged.length];
    state.delivery.pending = {
      unit: next.index,
      sha256: next.sha256,
      presentedAt: new Date().toISOString(),
    };
    state.updatedAt = state.delivery.pending.presentedAt;
    await writeStateAtomic(runDir, state);
    return { kind: 'frame', value: frameFor(state, compiled, key, next) };
  });
  if (output.kind === 'json') emitJson(output.value);
  else process.stdout.write(output.value);
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

async function requireNoForeignCleanOutput(filePath, protectedStatus, runDir) {
  let status;
  try {
    status = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  requireBigIntFileIdentity(status, 'incomplete clean output');
  requireBigIntFileIdentity(protectedStatus, 'draft');
  if (status.isSymbolicLink() || !status.isFile()) {
    fail('Incomplete clean output is not a regular executor-owned file; refusing recovery.');
  }
  if (status.dev === protectedStatus.dev && status.ino === protectedStatus.ino) {
    fail('Incomplete clean output aliases the supplied draft; refusing destructive recovery.');
  }
  const ownedStatus = await lstat(filePath, { bigint: true });
  const aliases = [];
  for (const entry of await readdir(runDir)) {
    if (!/^sanitized-attempt-\d+-[a-f0-9]{32}\.txt$/.test(entry)) continue;
    const candidatePath = path.join(runDir, entry);
    let candidate;
    try {
      candidate = await lstat(candidatePath, { bigint: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (
      candidate.isFile() &&
      !candidate.isSymbolicLink() &&
      sameFileIdentity(candidate, ownedStatus)
    ) {
      aliases.push(candidatePath);
    }
  }
  if (aliases.length === 1) {
    if (!(await unlinkOwnedStagingPath(filePath, ownedStatus))) {
      fail('Incomplete clean output changed during safe recovery.');
    }
    return;
  }
  fail(
    'Incomplete clean output from another execution generation exists; refusing unsafe automatic recovery.',
  );
}

async function writeOwnedStagingFile(filePath, bytes, mode) {
  const handle = await open(filePath, 'wx', mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    return await handle.stat({ bigint: true });
  } catch (error) {
    const ownership = { handle };
    await unlinkOwnedFile(filePath, ownership);
    throw error;
  } finally {
    try {
      await handle.close();
    } catch {
      // A close failure cannot make an unshared, fully synced staging file unsafe.
    }
  }
}

async function requireOwnedStagingPath(filePath, expected, label) {
  let current;
  try {
    current = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} disappeared before commit.`);
    throw error;
  }
  if (!current.isFile() || current.isSymbolicLink() || !sameFileIdentity(current, expected)) {
    fail(`${label} changed before commit.`);
  }
}

async function unlinkOwnedStagingPath(filePath, expected) {
  let current;
  try {
    current = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!current.isFile() || current.isSymbolicLink() || !sameFileIdentity(current, expected)) {
    return false;
  }
  try {
    await unlink(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readOwnedStagingFile(filePath, label) {
  const handle = await open(
    filePath,
    fsConstants.O_RDONLY |
      (fsConstants.O_NOFOLLOW ?? 0) |
      (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    const status = await handle.stat({ bigint: true });
    if (!status.isFile()) fail(`${label} must be a regular file.`);
    if (status.size > BigInt(MAX_DRAFT_BYTES)) {
      fail(`${label} exceeds the executor limit.`);
    }
    const bytes = await handle.readFile();
    if (bytes.length > MAX_DRAFT_BYTES) fail(`${label} exceeds the executor limit.`);
    await requireOwnedStagingPath(filePath, status, label);
    return { bytes, status };
  } finally {
    await handle.close();
  }
}

async function publishOwnedStagingFile(sourcePath, finalPath, expected, label) {
  await requireOwnedStagingPath(sourcePath, expected, label);
  try {
    await link(sourcePath, finalPath);
  } catch (error) {
    if (error.code === 'EEXIST') {
      fail('Clean output already exists; refusing to overwrite another generation.');
    }
    throw error;
  }
  let published;
  try {
    published = await lstat(finalPath, { bigint: true });
  } catch (error) {
    fail(`Published clean output cannot be inspected: ${error.message}`);
  }
  if (!published.isFile() || published.isSymbolicLink() || !sameFileIdentity(published, expected)) {
    fail('Published clean output does not match the current sanitizer generation.');
  }
  return published;
}

async function readDraftSnapshot(draftPath) {
  let handle;
  try {
    handle = await open(
      draftPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const status = requireBigIntFileIdentity(
      await handle.stat({ bigint: true }),
      'draft',
    );
    if (!status.isFile()) fail('Draft must be a regular file.');
    if (status.size > BigInt(MAX_DRAFT_BYTES)) {
      fail(`Draft exceeds the ${MAX_DRAFT_BYTES}-byte executor limit.`);
    }
    const bytes = await handle.readFile();
    if (bytes.length > MAX_DRAFT_BYTES) {
      fail(`Draft exceeds the ${MAX_DRAFT_BYTES}-byte executor limit.`);
    }
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
  const currentStatus = await requireRegularFileIdentity(currentRealPath, 'draft');
  requireBigIntFileIdentity(expectedStatus, 'draft snapshot');
  if (!sameFileIdentity(currentStatus, expectedStatus)) {
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
  const receipt = await withLock(runDir, async ({ acquisitionId }) => {
    const { state, compiled } = await verifiedState(runDir);
    if (!['ready_to_draft', 'complete'].includes(state.phase)) {
      fail(`finish requires phase ready_to_draft; current phase is ${state.phase}.`);
    }
    if (
      state.phase === 'ready_to_draft' &&
      state.sanitizer.attempts >= state.sanitizer.maxAttempts
    ) {
      fail('Sanitizer attempt limit has been reached.');
    }
    const { bytes: draftBytes, status: draftStatus } = await readDraftSnapshot(realDraftPath);
    const draftText = decodeUtf8(draftBytes, 'Draft');
    assertWellFormedUnicode(draftText, 'Draft');
    assertNoForbiddenControls(draftText, 'Draft');
    const draftSha256 = sha256(draftBytes);
    await requireUnchangedDraftPath(draftPath, realDraftPath, draftStatus);
    if (state.phase === 'complete') {
      if (draftSha256 !== state.sanitizer.output.draftSha256) {
        fail('finish already committed a different draft.');
      }
      return publicReceipt(state, 'finish');
    }
    const cleanPath = path.join(runDir, 'clean-output.txt');
    await requireNoForeignCleanOutput(cleanPath, draftStatus, runDir);
    const attemptNumber = state.sanitizer.attempts + 1;
    const attemptPath = path.join(
      runDir,
      `sanitized-attempt-${attemptNumber}-${acquisitionId}.txt`,
    );
    const snapshotPath = path.join(
      runDir,
      `draft-attempt-${attemptNumber}-${acquisitionId}.snapshot`,
    );
    let attemptStatus = null;
    let snapshotStatus = null;
    let cleanStatus = null;
    let countSanitizerFailure = false;
    try {
      snapshotStatus = await writeOwnedStagingFile(snapshotPath, draftBytes, 0o400);
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
      const ownedAttempt = await readOwnedStagingFile(
        attemptPath,
        `Sanitizer attempt ${attemptNumber}`,
      );
      attemptStatus = ownedAttempt.status;
      const outputBytes = ownedAttempt.bytes;
      const outputText = decodeUtf8(outputBytes, 'Sanitized output');
      assertWellFormedUnicode(outputText, 'Sanitized output');
      assertNoForbiddenControls(outputText, 'Sanitized output');
      if (outputText.trim().length === 0) fail('Sanitized output is empty.');
      const outputSafetyShadow = canonicalizeForSafety(outputText);
      const outputSecuritySurface = `${outputText}\n${outputSafetyShadow}`;
      if (
        /\p{Bidi_Control}/u.test(outputText) ||
        HTML_ENTITY_TOKEN.test(outputText) ||
        HTML_ENTITY_TOKEN.test(outputSafetyShadow) ||
        /<!--|-->|<!|\]\]>|<%|%>|<\?|\?>|<\/?[A-Za-z][A-Za-z0-9:_-]*\b[^>]*>|<(?:\s+\/?\s*|\/\s+)(?:think(?:ing)?|plan(?:ning)?|analysis|scratchpad|nemo\s*[-_]?\s*(?:pad|final)|service)\b|\[\[|\]\]|\{\{|\}\}|\(\s*OOC\s*:/i.test(
          outputSecuritySurface,
        ) ||
        containsCanonicalInternalBoundary(outputSecuritySurface)
      ) {
        countSanitizerFailure = true;
        fail('Sanitized output still contains service markup.');
      }
      if (containsReservedNemoFraming(outputSecuritySurface)) {
        countSanitizerFailure = true;
        fail('Sanitized output still contains reserved Nemo runtime framing.');
      }
      cleanStatus = await publishOwnedStagingFile(
        attemptPath,
        cleanPath,
        attemptStatus,
        `Sanitizer attempt ${attemptNumber}`,
      );
      if (!(await unlinkOwnedStagingPath(snapshotPath, snapshotStatus))) {
        fail('Draft snapshot changed before sanitizer commit.');
      }
      snapshotStatus = null;
      const committedBytes = await readFile(cleanPath);
      if (
        !committedBytes.equals(outputBytes) ||
        sha256(committedBytes) !== sha256(outputBytes)
      ) {
        fail('Published clean output changed before state commit.');
      }
      const now = new Date().toISOString();
      state.sanitizer.attempts = attemptNumber;
      state.sanitizer.output = {
        draftSha256,
        operationId: acquisitionId,
        sha256: sha256(outputBytes),
        bytes: outputBytes.length,
        chars: codePoints(outputText).length,
      };
      state.phase = 'complete';
      state.updatedAt = now;
      await writeStateAtomic(runDir, state);
      cleanStatus = null;
      try {
        await unlinkOwnedStagingPath(attemptPath, attemptStatus);
      } catch {
        // The committed output is already integrity-bound; staging cleanup is best-effort.
      }
      attemptStatus = null;
      return publicReceipt(state, 'finish');
    } catch (error) {
      if (snapshotStatus) {
        try {
          await unlinkOwnedStagingPath(snapshotPath, snapshotStatus);
        } catch (unlinkError) {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        }
      }
      if (attemptStatus) {
        try {
          await unlinkOwnedStagingPath(attemptPath, attemptStatus);
        } catch (unlinkError) {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        }
      }
      if (cleanStatus) {
        try {
          await unlinkOwnedStagingPath(cleanPath, cleanStatus);
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
  emitJson(receipt);
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
  if (options.command === 'advance') return advanceUnit(options);
  if (options.command === 'ack') return acknowledge(options);
  if (options.command === 'status') return status(options);
  if (options.command === 'finish') return finish(options);
  if (options.command === 'show-output') return showOutput(options);
  fail(`Unimplemented command: ${options.command}`);
}

export { splitSemanticText };

const invokedAsCli =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedAsCli) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
