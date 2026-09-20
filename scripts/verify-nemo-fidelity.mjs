#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const AUDIT_ROOT = path.join(ROOT, 'audit', 'nemo-static-evidence');
const REPOSITORY = 'producesplatinum-ai/NemoEngine';
const AUDITED_REF = 'b988a06eedb24b916182d0b5d545eb9a2dbabe02';
const CANONICAL_SHA256 =
  'c5e13e951340d17addef0e16e7a7152a8256c41f2c046a52e81d86e1feef31d4';
const ALLOWED_CLASSES = new Set([
  'SOURCE_INTERNAL_CONFLICT',
  'RENDERER_GRAMMAR_MISMATCH',
  'DOCUMENTED_NONPORTABLE_LIMIT',
  'PROVEN_SEMANTIC_LOSS',
  'INTENTIONAL_PORTABLE_DEGRADATION',
]);

let checks = 0;
const failures = [];

function check(condition, name, detail = null) {
  checks += 1;
  if (!condition) failures.push({ check: name, ...(detail ? { detail } : {}) });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitBlobSha(bytes) {
  return createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

function resolveJsonPointer(value, pointer) {
  if (pointer === '') return value;
  if (!pointer.startsWith('/')) throw new Error('JSON pointer must start with /.');
  let current = value;
  for (const rawPart of pointer.slice(1).split('/')) {
    const part = rawPart.replaceAll('~1', '/').replaceAll('~0', '~');
    if (current === null || typeof current !== 'object' || !(part in current)) {
      throw new Error(`JSON pointer segment not found: ${part}`);
    }
    current = current[part];
  }
  return current;
}

function decodeTemplateValue(source, evidence) {
  const tablePrefix = `const ${evidence.table} = Object.freeze({`;
  const start = source.indexOf(tablePrefix);
  if (start < 0) throw new Error(`Template table not found: ${evidence.table}`);
  const tail = source.slice(start);
  const name = evidence.module_identifier;
  const candidates = [`  '${name}': \``, `  ${name}: \``]
    .map((prefix) => ({ prefix, index: tail.indexOf(prefix) }))
    .filter(({ index }) => index >= 0)
    .sort((left, right) => left.index - right.index);
  if (candidates.length === 0) throw new Error(`Template entry not found: ${name}`);

  const found = candidates[0];
  let index = found.index + found.prefix.length;
  let decoded = '';
  for (; index < tail.length; index += 1) {
    let character = tail[index];
    if (character === '`') return decoded;
    if (character === '\\') {
      index += 1;
      if (index >= tail.length) throw new Error(`Unterminated escape in template: ${name}`);
      character = tail[index];
      decoded += character === 'n' ? '\n' : character === 'r' ? '\r' : character === 't' ? '\t' : character;
    } else {
      decoded += character;
    }
  }
  throw new Error(`Unterminated template entry: ${name}`);
}

function parseArguments(argv) {
  if (argv.length === 0) return { out: null };
  if (argv.length !== 2 || argv[0] !== '--out' || !argv[1]) {
    throw new Error('Usage: node scripts/verify-nemo-fidelity.mjs [--out FILE]');
  }
  return { out: path.resolve(process.cwd(), argv[1]) };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const guards = await readJson(path.join(AUDIT_ROOT, 'fidelity-guard.json'));
  const evidenceDocument = await readJson(
    path.join(AUDIT_ROOT, 'provenance', 'excerpts.json'),
  );
  const excerpts = evidenceDocument.excerpts;

  check(Array.isArray(guards), 'guards.array');
  check(guards.length === 17, 'guards.count17');
  check(Array.isArray(excerpts), 'excerpts.array');
  check(excerpts.length === 52, 'excerpts.count52');
  check(evidenceDocument.repository === REPOSITORY, 'excerpts.repository');
  check(evidenceDocument.ref === AUDITED_REF, 'excerpts.ref');

  const expectedGuardIds = Array.from({ length: 17 }, (_, index) =>
    `FG-C${String(index + 2).padStart(3, '0')}`,
  );
  const actualGuardIds = guards.map((guard) => guard.guard_id);
  check(
    JSON.stringify(actualGuardIds) === JSON.stringify(expectedGuardIds),
    'guards.exact_ids',
  );
  check(new Set(actualGuardIds).size === guards.length, 'guards.unique_ids');

  const evidenceById = new Map();
  const fileCache = new Map();
  for (const evidence of excerpts) {
    check(nonempty(evidence.evidence_id), 'excerpt.id');
    check(!evidenceById.has(evidence.evidence_id), `excerpt.${evidence.evidence_id}.unique`);
    evidenceById.set(evidence.evidence_id, evidence);
    check(evidence.repository === REPOSITORY, `excerpt.${evidence.evidence_id}.repository`);
    check(evidence.ref === AUDITED_REF, `excerpt.${evidence.evidence_id}.ref`);
    check(nonempty(evidence.path), `excerpt.${evidence.evidence_id}.path`);
    check(/^[a-f0-9]{40}$/.test(evidence.blob_sha), `excerpt.${evidence.evidence_id}.blob`);
    check(nonempty(evidence.excerpt), `excerpt.${evidence.evidence_id}.nonempty`);
    check(
      sha256(Buffer.from(evidence.excerpt, 'utf8')) === evidence.excerpt_sha256,
      `excerpt.${evidence.evidence_id}.sha256`,
    );

    const absolute = path.resolve(ROOT, evidence.path);
    check(isWithin(absolute, ROOT), `excerpt.${evidence.evidence_id}.safe_path`);
    if (!isWithin(absolute, ROOT)) continue;

    let record = fileCache.get(absolute);
    if (!record) {
      const bytes = await readFile(absolute);
      record = {
        bytes,
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        blob: gitBlobSha(bytes),
      };
      fileCache.set(absolute, record);
    }
    check(record.blob === evidence.blob_sha, `excerpt.${evidence.evidence_id}.git_blob`);

    try {
      let haystack = record.text;
      if (evidence.json_pointer) {
        haystack = resolveJsonPointer(JSON.parse(record.text), evidence.json_pointer);
      }
      if (evidence.representation === 'decoded template literal value') {
        haystack = decodeTemplateValue(record.text, evidence);
      }
      check(
        typeof haystack === 'string' && haystack.includes(evidence.excerpt),
        `excerpt.${evidence.evidence_id}.literal_match`,
      );
    } catch (error) {
      check(false, `excerpt.${evidence.evidence_id}.literal_match`, error.message);
    }
  }

  for (const guard of guards) {
    const id = guard.guard_id;
    check(guard.repository === REPOSITORY, `${id}.repository`);
    check(guard.ref === AUDITED_REF, `${id}.ref`);
    check(
      guard.registered_discrepancy_id === id.slice(3),
      `${id}.discrepancy_binding`,
    );
    check(ALLOWED_CLASSES.has(guard.discrepancy_class), `${id}.allowed_class`);
    check(
      Array.isArray(guard.secondary_classes) &&
        guard.secondary_classes.every((value) => ALLOWED_CLASSES.has(value)),
      `${id}.allowed_secondary_classes`,
    );
    for (const field of [
      'affected_module_identifier',
      'module_name',
      'original_rule',
      'actual_portable_behavior',
      'proven_loss_or_change',
      'manifestation_condition',
      'safe_model_behavior',
      'explanation',
      'dynamic_verification_scope',
      'review_basis',
    ]) {
      check(nonempty(guard[field]), `${id}.${field}`);
    }
    check(
      guard.qualification === undefined || typeof guard.qualification === 'string',
      `${id}.qualification_type`,
    );
    check(typeof guard.dynamic_test_required === 'boolean', `${id}.dynamic_boolean`);
    check(typeof guard.source_semantics_modified === 'boolean', `${id}.modified_boolean`);

    const sourceEvidence = evidenceById.get(guard.source_evidence_id);
    const runtimeEvidence = evidenceById.get(guard.runtime_evidence_id);
    check(Boolean(sourceEvidence), `${id}.source_evidence_exists`);
    check(Boolean(runtimeEvidence), `${id}.runtime_evidence_exists`);
    if (sourceEvidence) {
      check(sourceEvidence.path === guard.source_evidence_path, `${id}.source_path`);
      check(sourceEvidence.blob_sha === guard.source_blob_sha, `${id}.source_blob`);
      check(sourceEvidence.excerpt === guard.source_excerpt, `${id}.source_excerpt`);
      check(
        sourceEvidence.json_pointer === guard.source_json_pointer,
        `${id}.source_pointer`,
      );
    }
    if (runtimeEvidence) {
      check(runtimeEvidence.path === guard.runtime_evidence_path, `${id}.runtime_path`);
      check(runtimeEvidence.blob_sha === guard.runtime_blob_sha, `${id}.runtime_blob`);
      check(runtimeEvidence.excerpt === guard.runtime_excerpt, `${id}.runtime_excerpt`);
    }
    check(
      Array.isArray(guard.additional_evidence_ids) &&
        guard.additional_evidence_ids.every((evidenceId) => evidenceById.has(evidenceId)),
      `${id}.additional_evidence`,
    );
  }

  const presetPath = path.join(
    ROOT,
    'Nemo Engine',
    'Nemo Engine 11.5.2 - General RP.json',
  );
  const presetBytes = await readFile(presetPath);
  const preset = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(presetBytes));
  const profileCounts = preset.prompt_order.map((profile) => ({
    characterId: profile.character_id,
    entries: profile.order.length,
    enabled: profile.order.filter((entry) => entry.enabled).length,
  }));
  const regex = preset.extensions?.regex_scripts;
  check(presetBytes.length === 1_700_950, 'preset.bytes');
  check(sha256(presetBytes) === CANONICAL_SHA256, 'preset.sha256');
  check(preset.prompts.length === 458, 'preset.prompts458');
  check(preset.prompt_order.length === 2, 'preset.profiles2');
  check(profileCounts.every((profile) => profile.entries === 458), 'preset.profile_entries458');
  check(profileCounts.every((profile) => profile.enabled === 107), 'preset.profile_enabled107');
  check(Array.isArray(regex) && regex.length === 97, 'preset.regex97');
  check(regex.filter((entry) => !entry.disabled).length === 95, 'preset.regex_active95');

  const result = {
    schemaVersion: 'nemo-fidelity-verification/v1',
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    checks,
    passedChecks: checks - failures.length,
    failedChecks: failures.length,
    repository: REPOSITORY,
    auditedRef: AUDITED_REF,
    canonicalPreset: {
      bytes: presetBytes.length,
      sha256: sha256(presetBytes),
      prompts: preset.prompts.length,
      profiles: profileCounts,
      regexScripts: regex.length,
      activeRegexScripts: regex.filter((entry) => !entry.disabled).length,
    },
    evidence: {
      fidelityGuards: guards.length,
      excerpts: excerpts.length,
      sourceFiles: fileCache.size,
      classes: [...new Set(guards.flatMap((guard) => [
        guard.discrepancy_class,
        ...guard.secondary_classes,
      ]))].sort(),
    },
    boundaries: {
      productionExecution: 'SEPARATE_TEST_SUITE',
      canonicalReassembly: 'SEPARATE_REASSEMBLE_COMMAND',
      modelTraining: false,
      sillyTavernParity: false,
    },
    failures,
  };

  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out) {
    await mkdir(path.dirname(options.out), { recursive: true });
    await writeFile(options.out, serialized, { encoding: 'utf8', mode: 0o600 });
  }
  process.stdout.write(serialized);
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
});
