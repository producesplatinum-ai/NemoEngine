#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
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
const GUARD_REGISTRY_SHA256 =
  'f6e00dcbc89c081b4e450c5102b3ee83789324c00f495443b9c0f3ee5d1cb037';
const ALLOWED_CLASSES = new Set([
  'SOURCE_INTERNAL_CONFLICT',
  'RENDERER_GRAMMAR_MISMATCH',
  'DOCUMENTED_NONPORTABLE_LIMIT',
  'PROVEN_SEMANTIC_LOSS',
  'INTENTIONAL_PORTABLE_DEGRADATION',
]);

let checks = 0;
const failures = [];
let requestedOutput = null;

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
    if (/~(?![01])/u.test(rawPart)) throw new Error('Invalid JSON pointer escape.');
    const part = rawPart.replaceAll('~1', '/').replaceAll('~0', '~');
    if (
      current === null ||
      typeof current !== 'object' ||
      !Object.hasOwn(current, part)
    ) {
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
  const end = source.indexOf('\n});\n\nconst ', start + tablePrefix.length);
  if (end < 0) throw new Error(`Template table boundary not found: ${evidence.table}`);
  const tail = source.slice(start, end + 4);
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
      const simpleEscapes = {
        0: '\0',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
        v: '\v',
        '\\': '\\',
        '`': '`',
      };
      if (Object.hasOwn(simpleEscapes, character)) {
        decoded += simpleEscapes[character];
      } else if (character === 'x') {
        const digits = tail.slice(index + 1, index + 3);
        if (!/^[0-9a-f]{2}$/iu.test(digits)) throw new Error('Invalid hexadecimal escape.');
        decoded += String.fromCodePoint(Number.parseInt(digits, 16));
        index += 2;
      } else if (character === 'u') {
        const braced = tail[index + 1] === '{';
        const close = braced ? tail.indexOf('}', index + 2) : index + 5;
        const digits = braced
          ? tail.slice(index + 2, close)
          : tail.slice(index + 1, close);
        if (close < 0 || !/^[0-9a-f]{4,6}$/iu.test(digits)) {
          throw new Error('Invalid Unicode escape.');
        }
        const codePoint = Number.parseInt(digits, 16);
        if (codePoint > 0x10ffff) throw new Error('Unicode escape out of range.');
        decoded += String.fromCodePoint(codePoint);
        index = braced ? close : close - 1;
      } else if (character === '\n') {
        // JavaScript line continuation contributes no character.
      } else {
        throw new Error(`Unsupported template escape: \\${character}`);
      }
    } else {
      if (character === '$' && tail[index + 1] === '{') {
        throw new Error(`Interpolated template is not static: ${name}`);
      }
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

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr.trim() || `git ${args[0]} failed`);
  }
  return result.stdout;
}

function pinnedBlobForPath(filePath) {
  const output = runGit(['ls-tree', '-z', AUDITED_REF, '--', filePath]);
  const records = output.split('\0').filter(Boolean);
  if (records.length !== 1) throw new Error(`Pinned path count is ${records.length}.`);
  const match = records[0].match(/^(\d+) blob ([a-f0-9]{40})\t([\s\S]+)$/u);
  if (!match || match[3] !== filePath) throw new Error('Malformed pinned tree entry.');
  if (!['100644', '100755'].includes(match[1])) throw new Error('Pinned path is not a file.');
  return { mode: match[1], sha: match[2] };
}

function parseRegexLiteral(literal) {
  if (typeof literal !== 'string' || !literal.startsWith('/')) {
    throw new Error('Regex evidence is not a literal.');
  }
  const boundary = literal.lastIndexOf('/');
  if (boundary <= 0) throw new Error('Regex literal has no closing slash.');
  return { source: literal.slice(1, boundary), flags: literal.slice(boundary + 1) };
}

function regexMatches(literal, input) {
  const parsed = parseRegexLiteral(literal);
  return new RegExp(parsed.source, parsed.flags).test(input);
}

function guardRegistryProjection(guards) {
  return guards.map(
    ({
      guard_id,
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

async function main() {
  const options = parseArguments(process.argv.slice(2));
  requestedOutput = options.out;
  const guards = await readJson(path.join(AUDIT_ROOT, 'fidelity-guard.json'));
  const evidenceDocument = await readJson(
    path.join(AUDIT_ROOT, 'provenance', 'excerpts.json'),
  );
  const excerpts = evidenceDocument.excerpts;
  const globalEvidenceIds = evidenceDocument.global_evidence_ids;
  const presetPath = path.join(
    ROOT,
    'Nemo Engine',
    'Nemo Engine 11.5.2 - General RP.json',
  );
  const presetBytes = await readFile(presetPath);
  const preset = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(presetBytes));
  const regex = preset.extensions?.regex_scripts;
  const rootRealPath = await realpath(ROOT);

  check(Array.isArray(guards), 'guards.array');
  check(guards.length === 17, 'guards.count17');
  check(Array.isArray(excerpts), 'excerpts.array');
  check(excerpts.length === 52, 'excerpts.count52');
  check(evidenceDocument.repository === REPOSITORY, 'excerpts.repository');
  check(evidenceDocument.ref === AUDITED_REF, 'excerpts.ref');
  check(
    Array.isArray(globalEvidenceIds) &&
      JSON.stringify(globalEvidenceIds) ===
        JSON.stringify(['runtime-profile-activation', 'runtime-profile-order']),
    'excerpts.global_evidence_ids',
  );
  try {
    runGit(['cat-file', '-e', `${AUDITED_REF}^{commit}`]);
    check(true, 'git.audited_ref_present');
  } catch (error) {
    check(false, 'git.audited_ref_present', error.message);
  }

  const expectedGuardIds = Array.from({ length: 17 }, (_, index) =>
    `FG-C${String(index + 2).padStart(3, '0')}`,
  );
  const actualGuardIds = guards.map((guard) => guard.guard_id);
  check(
    JSON.stringify(actualGuardIds) === JSON.stringify(expectedGuardIds),
    'guards.exact_ids',
  );
  check(new Set(actualGuardIds).size === guards.length, 'guards.unique_ids');
  const guardRegistrySha256 = sha256(
    Buffer.from(JSON.stringify(guardRegistryProjection(guards)), 'utf8'),
  );
  check(guardRegistrySha256 === GUARD_REGISTRY_SHA256, 'guards.exact_registry');

  const evidenceById = new Map();
  const fileCache = new Map();
  const pinnedContentCache = new Map();
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
      ['runtime', 'source-prompt', 'source-regex'].includes(evidence.kind),
      `excerpt.${evidence.evidence_id}.kind`,
    );
    check(
      sha256(Buffer.from(evidence.excerpt, 'utf8')) === evidence.excerpt_sha256,
      `excerpt.${evidence.evidence_id}.sha256`,
    );
    try {
      const pinned = pinnedBlobForPath(evidence.path);
      check(
        pinned.sha === evidence.blob_sha,
        `excerpt.${evidence.evidence_id}.pinned_path_blob`,
      );
      check(
        ['100644', '100755'].includes(pinned.mode),
        `excerpt.${evidence.evidence_id}.pinned_file_mode`,
      );
    } catch (error) {
      check(false, `excerpt.${evidence.evidence_id}.pinned_path_blob`, error.message);
    }

    const absolute = path.resolve(ROOT, evidence.path);
    check(isWithin(absolute, ROOT), `excerpt.${evidence.evidence_id}.safe_path`);
    if (!isWithin(absolute, ROOT)) continue;

    let record = fileCache.get(absolute);
    if (!record) {
      try {
        const metadata = await lstat(absolute);
        const resolved = await realpath(absolute);
        check(metadata.isFile() && !metadata.isSymbolicLink(), `file.${evidence.path}.regular`);
        check(isWithin(resolved, rootRealPath), `file.${evidence.path}.realpath`);
        if (!metadata.isFile() || metadata.isSymbolicLink() || !isWithin(resolved, rootRealPath)) {
          continue;
        }
        const bytes = await readFile(resolved);
        record = {
          bytes,
          text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          blob: gitBlobSha(bytes),
          json: null,
        };
        fileCache.set(absolute, record);
      } catch (error) {
        check(false, `file.${evidence.path}.readable`, error.message);
        continue;
      }
    }
    check(record.blob === evidence.blob_sha, `excerpt.${evidence.evidence_id}.git_blob`);
    try {
      let pinnedText = pinnedContentCache.get(evidence.blob_sha);
      if (pinnedText === undefined) {
        pinnedText = runGit(['cat-file', 'blob', evidence.blob_sha]);
        pinnedContentCache.set(evidence.blob_sha, pinnedText);
      }
      check(
        record.text === pinnedText,
        `excerpt.${evidence.evidence_id}.pinned_bytes_equal_worktree`,
      );
    } catch (error) {
      check(
        false,
        `excerpt.${evidence.evidence_id}.pinned_bytes_equal_worktree`,
        error.message,
      );
    }

    try {
      let haystack = record.text;
      if (evidence.json_pointer) {
        record.json ??= JSON.parse(record.text);
        haystack = resolveJsonPointer(record.json, evidence.json_pointer);
      }
      if (evidence.representation === 'decoded template literal value') {
        haystack = decodeTemplateValue(record.text, evidence);
        check(
          sha256(Buffer.from(haystack, 'utf8')) === evidence.template_value_sha256,
          `excerpt.${evidence.evidence_id}.template_value_sha256`,
        );
      }
      check(
        typeof haystack === 'string' && haystack.includes(evidence.excerpt),
        `excerpt.${evidence.evidence_id}.literal_match`,
      );

      if (evidence.kind === 'source-prompt') {
        check(
          evidence.representation === 'decoded JSON content string; continuous literal substring',
          `excerpt.${evidence.evidence_id}.prompt_representation`,
        );
        check(
          typeof evidence.json_pointer === 'string' && evidence.json_pointer.endsWith('/content'),
          `excerpt.${evidence.evidence_id}.content_pointer`,
        );
        const parentPointer = evidence.json_pointer.slice(0, -'/content'.length);
        const sourcePrompt = resolveJsonPointer(record.json, parentPointer);
        check(
          sourcePrompt.identifier === evidence.module_identifier,
          `excerpt.${evidence.evidence_id}.source_identifier`,
        );
        check(
          sourcePrompt.name === evidence.module_name,
          `excerpt.${evidence.evidence_id}.source_name`,
        );
        const canonicalPrompt = preset.prompts.find(
          (prompt) => prompt.identifier === evidence.module_identifier,
        );
        check(Boolean(canonicalPrompt), `excerpt.${evidence.evidence_id}.canonical_prompt`);
        if (canonicalPrompt) {
          check(
            canonicalPrompt.name === evidence.module_name,
            `excerpt.${evidence.evidence_id}.canonical_name`,
          );
          check(
            canonicalPrompt.content === sourcePrompt.content,
            `excerpt.${evidence.evidence_id}.canonical_content`,
          );
        }
      } else if (evidence.kind === 'source-regex') {
        check(
          evidence.representation === 'decoded JSON findRegex string; complete field',
          `excerpt.${evidence.evidence_id}.regex_representation`,
        );
        check(
          Number.isInteger(evidence.regex_index) &&
            evidence.json_pointer === `/${evidence.regex_index}/findRegex`,
          `excerpt.${evidence.evidence_id}.regex_pointer`,
        );
        check(haystack === evidence.excerpt, `excerpt.${evidence.evidence_id}.complete_regex`);
        check(
          regex?.[evidence.regex_index]?.findRegex === evidence.excerpt,
          `excerpt.${evidence.evidence_id}.canonical_regex`,
        );
      } else if (evidence.kind === 'runtime') {
        check(nonempty(evidence.symbol), `excerpt.${evidence.evidence_id}.runtime_symbol`);
        check(
          ['literal JavaScript source substring', 'decoded template literal value'].includes(
            evidence.representation,
          ),
          `excerpt.${evidence.evidence_id}.runtime_representation`,
        );
      }
    } catch (error) {
      check(false, `excerpt.${evidence.evidence_id}.literal_match`, error.message);
    }
  }

  const usedEvidenceIds = new Set(globalEvidenceIds);
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
    check(['HIGH', 'MEDIUM', 'LOW'].includes(guard.confidence), `${id}.confidence`);
    check(
      Array.isArray(guard.affected_modules) && guard.affected_modules.length > 0,
      `${id}.affected_modules`,
    );
    if (Array.isArray(guard.affected_modules)) {
      const moduleIdentifiers = new Set();
      for (const affected of guard.affected_modules) {
        check(
          Number.isInteger(affected.index) && affected.index >= 0,
          `${id}.affected_index`,
        );
        check(!moduleIdentifiers.has(affected.identifier), `${id}.affected_unique`);
        moduleIdentifiers.add(affected.identifier);
        const canonical = preset.prompts[affected.index];
        check(canonical?.identifier === affected.identifier, `${id}.affected_identifier`);
        check(canonical?.name === affected.name, `${id}.affected_name`);
      }
      check(
        moduleIdentifiers.has(guard.affected_module_identifier),
        `${id}.primary_identifier`,
      );
      check(
        guard.affected_modules.some((affected) => affected.name === guard.module_name),
        `${id}.primary_name`,
      );
    }

    const sourceEvidence = evidenceById.get(guard.source_evidence_id);
    const runtimeEvidence = evidenceById.get(guard.runtime_evidence_id);
    usedEvidenceIds.add(guard.source_evidence_id);
    usedEvidenceIds.add(guard.runtime_evidence_id);
    check(Boolean(sourceEvidence), `${id}.source_evidence_exists`);
    check(Boolean(runtimeEvidence), `${id}.runtime_evidence_exists`);
    if (sourceEvidence) {
      check(sourceEvidence.kind === 'source-prompt', `${id}.source_kind`);
      check(sourceEvidence.path === guard.source_evidence_path, `${id}.source_path`);
      check(sourceEvidence.blob_sha === guard.source_blob_sha, `${id}.source_blob`);
      check(sourceEvidence.excerpt === guard.source_excerpt, `${id}.source_excerpt`);
      check(
        sourceEvidence.json_pointer === guard.source_json_pointer,
        `${id}.source_pointer`,
      );
      check(
        guard.affected_modules.some(
          (affected) => affected.identifier === sourceEvidence.module_identifier,
        ),
        `${id}.source_module_binding`,
      );
    }
    if (runtimeEvidence) {
      check(runtimeEvidence.kind === 'runtime', `${id}.runtime_kind`);
      check(runtimeEvidence.path === guard.runtime_evidence_path, `${id}.runtime_path`);
      check(runtimeEvidence.blob_sha === guard.runtime_blob_sha, `${id}.runtime_blob`);
      check(runtimeEvidence.excerpt === guard.runtime_excerpt, `${id}.runtime_excerpt`);
      check(runtimeEvidence.symbol === guard.runtime_symbol, `${id}.runtime_symbol`);
    }
    check(
      Array.isArray(guard.additional_evidence_ids) &&
        guard.additional_evidence_ids.every((evidenceId) => evidenceById.has(evidenceId)),
      `${id}.additional_evidence`,
    );
    for (const evidenceId of guard.additional_evidence_ids ?? []) {
      usedEvidenceIds.add(evidenceId);
    }
  }

  check(
    [...evidenceById.keys()].every((evidenceId) => usedEvidenceIds.has(evidenceId)),
    'excerpts.no_orphans',
  );
  check(
    [...usedEvidenceIds].every((evidenceId) => evidenceById.has(evidenceId)),
    'excerpts.no_missing_references',
  );

  const regex30 = evidenceById.get('regex-30')?.excerpt;
  const regex31 = evidenceById.get('regex-31')?.excerpt;
  try {
    check(
      regexMatches(regex31, '<st-choice n="N">option text</st-choice>'),
      'FG-C006.regex_positive_control',
    );
    check(
      !regexMatches(regex31, '<st-choice n="N" icon="🤝">option text</st-choice>'),
      'FG-C006.regex_icon_negative',
    );
    check(
      regexMatches(regex30, '<st-bar k="Pity" v="38" l="38/90"/>'),
      'FG-C007.regex_positive_control',
    );
    check(
      !regexMatches(regex30, '<st-bar k="Tickets" v="14"/>'),
      'FG-C007.regex_missing_label_negative',
    );
    check(
      !regexMatches(regex30, '<st-bar k="Crystals" v="1820"/>'),
      'FG-C007.regex_source_crystals_negative',
    );
    check(
      !regexMatches(regex30, '<st-bar k="Crystals" v="1820" l="1820"/>'),
      'FG-C007.regex_four_digit_negative',
    );
  } catch (error) {
    check(false, 'renderer_regex_controls', error.message);
  }

  const profileCounts = preset.prompt_order.map((profile) => ({
    characterId: profile.character_id,
    entries: profile.order.length,
    enabled: profile.order.filter((entry) => entry.enabled).length,
  }));
  check(presetBytes.length === 1_700_950, 'preset.bytes');
  check(sha256(presetBytes) === CANONICAL_SHA256, 'preset.sha256');
  check(preset.prompts.length === 458, 'preset.prompts458');
  check(preset.prompt_order.length === 2, 'preset.profiles2');
  check(profileCounts.every((profile) => profile.entries === 458), 'preset.profile_entries458');
  check(profileCounts.every((profile) => profile.enabled === 107), 'preset.profile_enabled107');
  check(Array.isArray(regex) && regex.length === 97, 'preset.regex97');
  check(regex.filter((entry) => !entry.disabled).length === 95, 'preset.regex_active95');
  check(
    JSON.stringify(
      regex
        .map((entry, index) => (entry.disabled ? index : null))
        .filter((index) => index !== null),
    ) === JSON.stringify([0, 11]),
    'preset.regex_disabled_exact',
  );

  const result = {
    schemaVersion: 'nemo-fidelity-structural-verification/v2',
    status:
      failures.length === 0 ? 'STRUCTURAL_PROVENANCE_PASS' : 'STRUCTURAL_PROVENANCE_FAIL',
    scope: 'repository-owned guard structure, pinned provenance, and executable regex controls',
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
      guardRegistrySha256,
      excerpts: excerpts.length,
      sourceFiles: fileCache.size,
      executableGuardControls: ['FG-C006', 'FG-C007'],
      classes: [...new Set(guards.flatMap((guard) => [
        guard.discrepancy_class,
        ...guard.secondary_classes,
      ]))].sort(),
    },
    boundaries: {
      semanticClaimsMachineProven: false,
      semanticReviewSource: 'curated human review bound to exact evidence',
      dynamicRequired: guards.filter((guard) => guard.dynamic_test_required).length,
      dynamicVerifiedHere: 0,
      pendingDynamicGuards: guards
        .filter((guard) => guard.dynamic_test_required)
        .map((guard) => guard.guard_id),
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
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch(async (error) => {
  const result = {
    schemaVersion: 'nemo-fidelity-structural-verification/v2',
    status: 'ERROR',
    error: error.message,
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (requestedOutput) {
    await mkdir(path.dirname(requestedOutput), { recursive: true });
    await writeFile(requestedOutput, serialized, { encoding: 'utf8', mode: 0o600 });
  }
  process.stderr.write(serialized);
  process.exitCode = 1;
});
