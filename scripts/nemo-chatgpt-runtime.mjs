#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCHEMA_VERSION = 'nemo-chatgpt-runtime/v1';
const DEFAULT_PROFILE = '100001';
const DEFAULT_MODE = 'portable';
const DEFAULT_MAX_PORTABLE_CHARS = 170_000;
const EMIT_CHUNK_CHARS = 24_000;
const EMIT_MAX_CHUNKS = 8;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_PRESET = path.join(
  REPOSITORY_ROOT,
  'Nemo Engine',
  'Nemo Engine 11.5.2 - General RP.json',
);

const KNOWN_VEX = Object.freeze({
  haar: 'v11-326-vex-haar-vex',
  narrative: 'v11-305-vex-narrative-vex',
});

// 11.5.2 omits the mutual-exclusive tag from the classic prompt even though
// both entries are alternative NSFW cores. Keep the known pair explicit rather
// than guessing from names.
const SUPPLEMENTAL_EXCLUSIVE_GROUPS = Object.freeze([
  {
    name: 'NSFW-Core',
    ids: ['v11-180-nsfw-nsfw-core', 'v11-537-classic-nsfw-core'],
  },
]);

const GOONER_STRATEGY_IDS = Object.freeze([
  'v11-178-nsfw-gooner-protocol',
  'v11-620-nsfw-gooner-slop-mode',
  'v11-621-nsfw-gooner-s-masterpiece-protocol',
]);

const PORTABLE_UI_PROMPT_IDS = new Set([
  'v11-624-fetish-dating-sim-quantum',
  'v11-625-fetish-corruption-fefnik',
  'v11-626-fetish-forced-fem-classic',
  'v11-627-fetish-harmonized-html-enable-fefnik',
]);

const SEMANTIC_PLACEHOLDERS = Object.freeze({
  user: '[USER]',
  char: '[CHARACTER]',
  persona: '[USER_PERSONA]',
  scenario: '[SCENARIO]',
  group: '[GROUP]',
  personality: '[CHARACTER_PERSONALITY]',
  description: '[CHARACTER_DESCRIPTION]',
  summary: '[CHAT_SUMMARY]',
  short_term_memory: '[SHORT_TERM_MEMORY]',
  long_term_memory: '[LONG_TERM_MEMORY]',
  NemoLore: '[NEMO_LORE]',
  datetimeformat: '[CURRENT_DATETIME]',
});

const HELP = `NemoEngine 11.5.2 -> deterministic ChatGPT prompt bundle

Usage:
  node scripts/nemo-chatgpt-runtime.mjs [options]

Options:
  --preset PATH       Preset JSON. Defaults to the 11.5.2 General RP preset.
  --profile ID        prompt_order character_id. Default: 100001.
  --mode MODE         portable (default) or source (verbatim audit bundle).
  --context PATH      JSON bindings for portable macros; see Context below.
  --max-portable-chars N
                      Fail rather than silently truncate above N characters.
                      Default: 170000.
  --instructions-only
                      Emit the ordered portable instruction text instead of JSON.
                      Valid only in portable mode; combine with --out for a file.
  --emit-dir DIR      Write instructions.txt, a verified manifest, and Unicode-safe
                      chunk-001.txt files (24000 characters each, at most 8).
  --vex SELECTOR      Select exactly one Vex by identifier or display name.
  --nsfw LIST         Replace active NSFW modules with a comma-separated list.
                      Repeat the option to append; use "none" to clear the list.
  --fetish LIST       Replace active Fetish modules. Same list rules as --nsfw.
  --enable LIST       Enable any prompt(s) after family selections. Repeatable.
  --disable LIST      Disable any prompt(s) after family selections. Repeatable.
                      LIST accepts comma-separated identifiers or display names.
  --sanitize-output PATH
                      Strip hidden planning boundaries from PATH; use - for stdin.
                      This mode does not compile a preset. Combine with --out.
  --out PATH          Write JSON to PATH instead of stdout.
  --pretty            Pretty-print JSON (compact JSON is the default).
  --list FAMILY       List selectors and exit: vex, nsfw, fetish, modules, or all.
  --help              Show this help and exit.

Selector matching:
  Exact identifiers always win. Display names are matched case-insensitively
  after removing emoji, punctuation, and a trailing [V6] badge. Ambiguous or
  unknown selectors fail; they are never guessed.

Examples:
  node scripts/nemo-chatgpt-runtime.mjs --pretty
  node scripts/nemo-chatgpt-runtime.mjs --vex "Gooner Vex" \\
    --nsfw "NSFW Core,Gooner Protocol" --fetish "Femdom,NTR" --pretty
  node scripts/nemo-chatgpt-runtime.mjs --disable "Narrative Vex" \\
    --enable "Haar Vex" --pretty
  node scripts/nemo-chatgpt-runtime.mjs --nsfw none --fetish none \\
    --out build/nemo-chatgpt-runtime.json
  node scripts/nemo-chatgpt-runtime.mjs --list all --pretty
  node scripts/nemo-chatgpt-runtime.mjs --context nemo-context.json --pretty
  node scripts/nemo-chatgpt-runtime.mjs --sanitize-output model-output.txt
  cat model-output.txt | node scripts/nemo-chatgpt-runtime.mjs \\
    --sanitize-output - --out clean-output.txt

Context JSON:
  {"macros":{"user":"Ava","char":"Vex","persona":"..."},
   "globals":{"NemoLoreTimeline":"..."},
   "variables":{"OptionalInitialVariable":"..."}}

Portable mode resolves the deterministic setvar/addvar/getvar/trim subset,
removes source metadata and no-op host markers, and reports every unresolved
macro. Source mode preserves verbatim rawContent for audit. Neither mode claims
full SillyTavern injection, lorebook, regex, tracker, HTML, or UI parity.
`;

function fail(message) {
  throw new Error(message);
}

function valueAfter(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    fail(`${option} requires a value.`);
  }
  return value;
}

function addListValue(options, key, value, option) {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    fail(`${option} requires at least one selector or "none".`);
  }

  if (options[key] === null) options[key] = [];
  options[key].push(...parts);
}

function parseArgs(argv) {
  const options = {
    preset: null,
    profile: DEFAULT_PROFILE,
    mode: DEFAULT_MODE,
    context: null,
    maxPortableChars: DEFAULT_MAX_PORTABLE_CHARS,
    instructionsOnly: false,
    emitDir: null,
    vex: null,
    nsfw: null,
    fetish: null,
    enable: [],
    disable: [],
    sanitizeOutput: null,
    out: null,
    pretty: false,
    list: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const equals = argument.indexOf('=');
    const option = equals === -1 ? argument : argument.slice(0, equals);
    const inlineValue = equals === -1 ? null : argument.slice(equals + 1);
    const readValue = () => {
      if (inlineValue !== null) {
        if (inlineValue.length === 0) fail(`${option} requires a value.`);
        return inlineValue;
      }
      const value = valueAfter(argv, index, option);
      index += 1;
      return value;
    };

    switch (option) {
      case '--help':
        if (inlineValue !== null) fail('--help does not accept a value.');
        options.help = true;
        break;
      case '--pretty':
        if (inlineValue !== null) fail('--pretty does not accept a value.');
        options.pretty = true;
        break;
      case '--preset':
        options.preset = readValue();
        break;
      case '--profile':
        options.profile = readValue();
        break;
      case '--mode':
        options.mode = readValue().toLowerCase();
        if (!['portable', 'source'].includes(options.mode)) {
          fail('--mode must be either portable or source.');
        }
        break;
      case '--context':
        if (options.context !== null) fail('--context may be provided only once.');
        options.context = readValue();
        break;
      case '--max-portable-chars': {
        const raw = readValue();
        if (!/^\d+$/.test(raw) || Number(raw) < 1) {
          fail('--max-portable-chars must be a positive integer.');
        }
        options.maxPortableChars = Number(raw);
        break;
      }
      case '--instructions-only':
        if (inlineValue !== null) fail('--instructions-only does not accept a value.');
        options.instructionsOnly = true;
        break;
      case '--emit-dir':
        if (options.emitDir !== null) fail('--emit-dir may be provided only once.');
        options.emitDir = readValue();
        break;
      case '--vex':
        if (options.vex !== null) fail('--vex may be provided only once.');
        options.vex = readValue();
        break;
      case '--nsfw':
        addListValue(options, 'nsfw', readValue(), '--nsfw');
        break;
      case '--fetish':
        addListValue(options, 'fetish', readValue(), '--fetish');
        break;
      case '--enable':
        addListValue(options, 'enable', readValue(), '--enable');
        break;
      case '--disable':
        addListValue(options, 'disable', readValue(), '--disable');
        break;
      case '--sanitize-output':
        if (options.sanitizeOutput !== null) {
          fail('--sanitize-output may be provided only once.');
        }
        options.sanitizeOutput = readValue();
        break;
      case '--out':
        if (options.out !== null) fail('--out may be provided only once.');
        options.out = readValue();
        break;
      case '--list':
        if (options.list !== null) fail('--list may be provided only once.');
        options.list = readValue().toLowerCase();
        if (!['vex', 'nsfw', 'fetish', 'modules', 'all'].includes(options.list)) {
          fail('--list must be one of: vex, nsfw, fetish, modules, all.');
        }
        break;
      default:
        if (argument.startsWith('-')) fail(`Unknown option: ${argument}`);
        fail(`Unexpected positional argument: ${argument}`);
    }
  }

  return options;
}

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a JSON object.`);
  }
}

function extractMetadata(content) {
  const text = typeof content === 'string' ? content : '';
  const tag = (name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`@${escaped}\\s+([^}\\r\\n]+)`, 'i'));
    return match ? match[1].trim() : null;
  };

  return {
    category: tag('category'),
    exclusiveGroup: tag('mutual-exclusive-group'),
    sectionHeader: /@section-header\s+true\b/i.test(text),
  };
}

function validatePreset(preset) {
  assertObject(preset, 'Preset');
  if (!Array.isArray(preset.prompts)) fail('Preset.prompts must be an array.');
  if (!Array.isArray(preset.prompt_order)) {
    fail('Preset.prompt_order must be an array.');
  }

  const promptById = new Map();
  const sourceIndexById = new Map();

  preset.prompts.forEach((prompt, sourceIndex) => {
    assertObject(prompt, `prompts[${sourceIndex}]`);
    const id = prompt.identifier;
    if (typeof id !== 'string' || id.length === 0) {
      fail(`prompts[${sourceIndex}].identifier must be a non-empty string.`);
    }
    if (promptById.has(id)) {
      fail(
        `Duplicate prompt identifier ${JSON.stringify(id)} at indexes ` +
          `${sourceIndexById.get(id)} and ${sourceIndex}.`,
      );
    }
    if (typeof prompt.name !== 'string' || prompt.name.length === 0) {
      fail(`Prompt ${JSON.stringify(id)} has no display name.`);
    }
    if (typeof prompt.content !== 'string') {
      fail(`Prompt ${JSON.stringify(id)} has non-string content.`);
    }
    if (typeof prompt.role !== 'string' || prompt.role.length === 0) {
      fail(`Prompt ${JSON.stringify(id)} has no role.`);
    }
    promptById.set(id, prompt);
    sourceIndexById.set(id, sourceIndex);
  });

  preset.prompt_order.forEach((profile, profileIndex) => {
    assertObject(profile, `prompt_order[${profileIndex}]`);
    if (!Array.isArray(profile.order)) {
      fail(`prompt_order[${profileIndex}].order must be an array.`);
    }
  });

  return { promptById, sourceIndexById };
}

function selectProfile(preset, profileSelector, promptById) {
  const matches = preset.prompt_order.filter(
    (profile) => String(profile.character_id) === String(profileSelector),
  );
  if (matches.length === 0) {
    const available = preset.prompt_order.map((profile) => profile.character_id).join(', ');
    fail(`Unknown profile ${JSON.stringify(profileSelector)}. Available profiles: ${available}.`);
  }
  if (matches.length > 1) {
    fail(`Profile character_id ${JSON.stringify(profileSelector)} is not unique.`);
  }

  const profile = matches[0];
  const seen = new Map();
  profile.order.forEach((reference, orderIndex) => {
    assertObject(reference, `profile ${profileSelector} order[${orderIndex}]`);
    const id = reference.identifier;
    if (typeof id !== 'string' || id.length === 0) {
      fail(`profile ${profileSelector} order[${orderIndex}] has no identifier.`);
    }
    if (seen.has(id)) {
      fail(
        `Profile ${profileSelector} references ${JSON.stringify(id)} more than once ` +
          `(indexes ${seen.get(id)} and ${orderIndex}).`,
      );
    }
    if (!promptById.has(id)) {
      fail(`Profile ${profileSelector} references unknown prompt ${JSON.stringify(id)}.`);
    }
    if (typeof reference.enabled !== 'boolean') {
      fail(
        `Profile ${profileSelector} reference ${JSON.stringify(id)} has a non-boolean enabled value.`,
      );
    }
    seen.set(id, orderIndex);
  });

  const missing = [...promptById.keys()].filter((id) => !seen.has(id));
  if (missing.length > 0) {
    fail(
      `Profile ${profileSelector} omits ${missing.length} prompt identifier(s): ` +
        `${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', ...' : ''}.`,
    );
  }

  return profile;
}

function normalizedSelector(value) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

function moduleKind(prompt, metadata = extractMetadata(prompt.content)) {
  if (metadata.sectionHeader) return 'section-header';
  if (prompt.marker) return 'marker';
  return 'prompt';
}

function familyCandidates(preset, sourceIndexById) {
  const decorated = preset.prompts.map((prompt) => {
    const metadata = extractMetadata(prompt.content);
    return {
      id: prompt.identifier,
      name: prompt.name,
      sourceIndex: sourceIndexById.get(prompt.identifier),
      role: prompt.role,
      kind: moduleKind(prompt, metadata),
      metadata,
    };
  });

  return {
    modules: decorated,
    vex: decorated.filter(
      (entry) => entry.metadata.exclusiveGroup === 'Vex-Personality',
    ),
    nsfw: decorated.filter(
      (entry) => entry.metadata.category === 'NSFW' && !entry.metadata.sectionHeader,
    ),
    fetish: decorated.filter(
      (entry) => entry.metadata.category === 'Fetish' && !entry.metadata.sectionHeader,
    ),
  };
}

function resolveSelector(selector, candidates, familyName) {
  const byId = candidates.filter((candidate) => candidate.id === selector);
  if (byId.length === 1) return byId[0];

  const key = normalizedSelector(selector);
  const byName = candidates.filter((candidate) => normalizedSelector(candidate.name) === key);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    fail(
      `Ambiguous ${familyName} selector ${JSON.stringify(selector)}: ` +
        `${byName.map((candidate) => candidate.id).join(', ')}. Use an identifier.`,
    );
  }

  const nearby = candidates
    .filter((candidate) => {
      const candidateKey = normalizedSelector(candidate.name);
      return key.length > 0 && (candidateKey.includes(key) || key.includes(candidateKey));
    })
    .slice(0, 6)
    .map((candidate) => `${candidate.name} (${candidate.id})`);
  const suffix = nearby.length > 0 ? ` Nearby: ${nearby.join('; ')}.` : '';
  fail(`Unknown ${familyName} selector ${JSON.stringify(selector)}.${suffix}`);
}

function parseExactSelection(values, candidates, familyName) {
  if (values === null) return null;
  const noneValues = values.filter((value) => normalizedSelector(value) === 'none');
  if (noneValues.length > 0) {
    if (values.length !== 1) {
      fail(`${familyName} selector "none" cannot be combined with other selectors.`);
    }
    return [];
  }

  const selected = values.map((value) => resolveSelector(value, candidates, familyName));
  const seen = new Set();
  for (const candidate of selected) {
    if (seen.has(candidate.id)) {
      fail(`Duplicate ${familyName} selection: ${candidate.name} (${candidate.id}).`);
    }
    seen.add(candidate.id);
  }
  return selected;
}

function parseModuleSelection(values, candidates, optionName) {
  const selected = values.map((value) =>
    resolveSelector(value, candidates, `${optionName} module`),
  );
  const seen = new Set();
  for (const candidate of selected) {
    if (seen.has(candidate.id)) {
      fail(`Duplicate ${optionName} selection: ${candidate.name} (${candidate.id}).`);
    }
    seen.add(candidate.id);
  }
  return selected;
}

function isKnownGeneralProfile(preset, presetPath, profile) {
  const label = `${preset.preset_name ?? ''} ${path.basename(presetPath)}`.toLowerCase();
  return String(profile.character_id) === DEFAULT_PROFILE && label.includes('general');
}

function configureVex({
  preset,
  presetPath,
  profile,
  candidates,
  activation,
  requested,
  diagnostics,
}) {
  if (requested !== null) {
    const selected = resolveSelector(requested, candidates, 'Vex');
    for (const candidate of candidates) activation.set(candidate.id, false);
    activation.set(selected.id, true);
    return selected;
  }

  const active = candidates.filter((candidate) => activation.get(candidate.id));
  if (active.length === 1) return active[0];

  const activeIds = new Set(active.map((candidate) => candidate.id));
  const knownConflict =
    active.length === 2 &&
    activeIds.has(KNOWN_VEX.haar) &&
    activeIds.has(KNOWN_VEX.narrative) &&
    isKnownGeneralProfile(preset, presetPath, profile);

  if (knownConflict) {
    const disabled = candidates.find((candidate) => candidate.id === KNOWN_VEX.haar);
    const kept = candidates.find((candidate) => candidate.id === KNOWN_VEX.narrative);
    activation.set(disabled.id, false);
    diagnostics.repairs.push({
      code: 'GENERAL_PROFILE_VEX_CONFLICT',
      group: 'Vex-Personality',
      action: 'disabled-conflicting-vex',
      disabled: { id: disabled.id, name: disabled.name },
      kept: { id: kept.id, name: kept.name },
      reason:
        'General RP profile 100001 enables Haar and Narrative together; Narrative is the conservative General default.',
    });
    return kept;
  }

  if (active.length === 0) {
    fail('The selected profile has no active Vex. Choose one explicitly with --vex.');
  }
  fail(
    `The selected profile has ${active.length} active Vex personalities: ` +
      `${active.map((candidate) => candidate.name).join(', ')}. Choose one with --vex.`,
  );
}

function replaceFamilySelection(activation, candidates, selected) {
  if (selected === null) return;
  for (const candidate of candidates) activation.set(candidate.id, false);
  for (const candidate of selected) activation.set(candidate.id, true);
}

function validateExclusiveGroups(preset, activation) {
  const groups = new Map();
  for (const prompt of preset.prompts) {
    if (!activation.get(prompt.identifier)) continue;
    const group = extractMetadata(prompt.content).exclusiveGroup;
    if (!group) continue;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ id: prompt.identifier, name: prompt.name });
  }

  for (const supplemental of SUPPLEMENTAL_EXCLUSIVE_GROUPS) {
    const active = supplemental.ids
      .filter((id) => activation.get(id))
      .map((id) => {
        const prompt = preset.prompts.find((candidate) => candidate.identifier === id);
        return { id, name: prompt?.name ?? id };
      });
    const existing = groups.get(supplemental.name) ?? [];
    const merged = new Map([...existing, ...active].map((entry) => [entry.id, entry]));
    if (merged.size > 0) groups.set(supplemental.name, [...merged.values()]);
  }

  const conflicts = [...groups.entries()]
    .filter(([, active]) => active.length > 1)
    .map(([group, active]) => ({ group, active }));
  if (conflicts.length > 0) {
    const details = conflicts
      .map(
        ({ group, active }) =>
          `${group}: ${active.map((entry) => `${entry.name} (${entry.id})`).join(', ')}`,
      )
      .join('; ');
    fail(`Mutual-exclusive selection conflict(s): ${details}.`);
  }
}

function addCompatibilityWarnings(activation, diagnostics) {
  const goonerStrategies = GOONER_STRATEGY_IDS.filter((id) => activation.get(id));
  if (goonerStrategies.length > 1) {
    diagnostics.warnings.push({
      code: 'MULTIPLE_GOONER_STRATEGIES',
      promptIds: goonerStrategies,
      message:
        'The source does not mark these modules as mutually exclusive, but their narrative strategies compete. The bundle preserves the explicit selection.',
    });
  }
}

function selectedFamily(order, activation, candidateList) {
  const candidates = new Map(candidateList.map((candidate) => [candidate.id, candidate]));
  return order
    .filter((reference) => activation.get(reference.identifier) && candidates.has(reference.identifier))
    .map((reference) => {
      const candidate = candidates.get(reference.identifier);
      return { id: candidate.id, name: candidate.name };
    });
}

function portableSourcePath(presetPath) {
  const relative = path.relative(REPOSITORY_ROOT, presetPath);
  if (relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..') {
    return relative.split(path.sep).join('/');
  }
  return path.resolve(presetPath).split(path.sep).join('/');
}

function buildInventory(
  bundle,
  familyCandidatesByName,
  activation,
  profileActivation,
  profileOrder,
  requested,
) {
  const familyNames =
    requested === 'all'
      ? ['vex', 'nsfw', 'fetish']
      : requested === 'modules'
        ? []
        : [requested];
  const families = {};
  for (const family of familyNames) {
    families[family] = familyCandidatesByName[family].map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      profileEnabled: Boolean(profileActivation.get(candidate.id)),
      enabled: Boolean(activation.get(candidate.id)),
    }));
  }
  const inventory = {
    schemaVersion: `${SCHEMA_VERSION}/inventory`,
    source: bundle.source,
    profile: bundle.profile,
    families,
    diagnostics: bundle.diagnostics,
  };
  if (requested === 'modules' || requested === 'all') {
    const profileOrderIndex = new Map(
      profileOrder.map((reference, index) => [reference.identifier, index]),
    );
    inventory.modules = familyCandidatesByName.modules.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      kind: candidate.kind,
      role: candidate.role,
      category: candidate.metadata.category,
      exclusiveGroup: candidate.metadata.exclusiveGroup,
      sourceIndex: candidate.sourceIndex,
      profileOrderIndex: profileOrderIndex.get(candidate.id),
      profileEnabled: Boolean(profileActivation.get(candidate.id)),
      enabled: Boolean(activation.get(candidate.id)),
    }));
  }
  return inventory;
}

function primitiveStringMap(value, label) {
  if (value === undefined) return new Map();
  assertObject(value, label);
  const result = new Map();
  for (const [key, entry] of Object.entries(value)) {
    if (
      entry !== null &&
      typeof entry !== 'string' &&
      typeof entry !== 'number' &&
      typeof entry !== 'boolean'
    ) {
      fail(`${label}.${key} must be a string, number, boolean, or null.`);
    }
    result.set(key, entry === null ? '' : String(entry));
  }
  return result;
}

async function loadPortableContext(contextPath) {
  if (contextPath === null) {
    return { macros: new Map(), globals: new Map(), variables: new Map() };
  }
  if (contextPath === '-') {
    fail('--context does not accept stdin; provide a JSON file path.');
  }
  const resolved = path.resolve(process.cwd(), contextPath);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolved, 'utf8'));
  } catch (error) {
    fail(`Cannot read context JSON ${JSON.stringify(resolved)}: ${error.message}`);
  }
  assertObject(parsed, 'Context');
  const unknown = Object.keys(parsed).filter(
    (key) => !['macros', 'globals', 'variables'].includes(key),
  );
  if (unknown.length > 0) {
    fail(`Unknown context section(s): ${unknown.join(', ')}.`);
  }
  return {
    macros: primitiveStringMap(parsed.macros, 'Context.macros'),
    globals: primitiveStringMap(parsed.globals, 'Context.globals'),
    variables: primitiveStringMap(parsed.variables, 'Context.variables'),
  };
}

function findMacroEnd(text, start) {
  let depth = 0;
  for (let index = start; index < text.length - 1; index += 1) {
    const pair = text.slice(index, index + 2);
    if (pair === '{{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (pair === '}}') {
      depth -= 1;
      if (depth === 0) return index;
      index += 1;
    }
  }
  return -1;
}

function splitMacroParts(inner) {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < inner.length - 1; index += 1) {
    const pair = inner.slice(index, index + 2);
    if (pair === '{{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (pair === '}}') {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (pair === '::' && depth === 0) {
      parts.push(inner.slice(start, index));
      start = index + 2;
      index += 1;
    }
  }
  parts.push(inner.slice(start));
  return parts;
}

function createMacroState(context) {
  return {
    context,
    variables: new Map(context.variables),
    variableSources: new Map(
      [...context.variables.keys()].map((name) => [name, new Set()]),
    ),
    consumedSourceModules: new Set(),
    currentReadSources: new Set(),
    dependencyCaptures: [],
    counts: {
      commentsStripped: 0,
      setvar: 0,
      addvar: 0,
      getvar: 0,
      trim: 0,
      contextSubstitutions: 0,
      dynamicFallbacks: 0,
      controlDirectivesNormalized: 0,
    },
    unresolved: new Map(),
    semanticSlots: new Map(),
    controlModules: new Set(),
    uiDegradedModules: new Set(),
    currentModuleId: null,
  };
}

function recordUnresolved(state, macro, replacement) {
  const key = `${macro}\u0000${replacement}`;
  let entry = state.unresolved.get(key);
  if (!entry) {
    entry = { macro, replacement, moduleIds: [] };
    state.unresolved.set(key, entry);
  }
  if (
    state.currentModuleId &&
    !entry.moduleIds.includes(state.currentModuleId)
  ) {
    entry.moduleIds.push(state.currentModuleId);
  }
}

function semanticReplacement(state, macroName) {
  const supplied = state.context.macros.has(macroName);
  const replacement = supplied
    ? state.context.macros.get(macroName)
    : SEMANTIC_PLACEHOLDERS[macroName];
  let slot = state.semanticSlots.get(macroName);
  if (!slot) {
    slot = {
      macro: macroName,
      placeholder: SEMANTIC_PLACEHOLDERS[macroName],
      provided: supplied,
      occurrences: 0,
    };
    state.semanticSlots.set(macroName, slot);
  }
  slot.occurrences += 1;
  if (supplied) {
    state.counts.contextSubstitutions += 1;
  } else {
    recordUnresolved(state, `{{${macroName}}}`, replacement);
  }
  return replacement;
}

function normalizeStoredVariableValue(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return value;
}

function evaluateMacro(inner, state, depth) {
  const trimmed = inner.trim();
  if (trimmed.startsWith('//')) {
    state.counts.commentsStripped += 1;
    return '';
  }

  const parts = splitMacroParts(inner);
  const command = parts[0].trim();
  const lowerCommand = command.toLowerCase();

  if (lowerCommand === 'setvar' || lowerCommand === 'addvar') {
    if (parts.length < 3 || parts[1].trim().length === 0) {
      recordUnresolved(state, `{{${trimmed}}}`, '');
      return '';
    }
    const variableName = parts[1].trim();
    const rawValue = parts.slice(2).join('::');
    const capturedSources = new Set();
    state.dependencyCaptures.push(capturedSources);
    let value;
    try {
      value = normalizeStoredVariableValue(
        expandPortableText(rawValue, state, depth + 1),
      );
    } finally {
      state.dependencyCaptures.pop();
    }
    if (lowerCommand === 'setvar') {
      state.counts.setvar += 1;
      state.variables.set(variableName, value);
      state.variableSources.set(
        variableName,
        value.length > 0
          ? new Set([state.currentModuleId, ...capturedSources].filter(Boolean))
          : new Set(),
      );
    } else {
      state.counts.addvar += 1;
      const previousValue = state.variables.get(variableName) ?? '';
      const nextValue = `${previousValue}${value}`;
      state.variables.set(variableName, nextValue);
      const sources = new Set(
        previousValue.length > 0 ? (state.variableSources.get(variableName) ?? []) : [],
      );
      if (value.length > 0) {
        if (state.currentModuleId) sources.add(state.currentModuleId);
        for (const sourceId of capturedSources) sources.add(sourceId);
      }
      if (nextValue.length === 0) sources.clear();
      state.variableSources.set(variableName, sources);
    }
    return '';
  }

  if (lowerCommand === 'getvar') {
    state.counts.getvar += 1;
    const variableName = parts.slice(1).join('::').trim();
    if (!state.variables.has(variableName)) {
      recordUnresolved(state, `{{getvar::${variableName}}}`, '');
      return '';
    }
    const value = state.variables.get(variableName);
    if (value.length > 0) {
      const readSources = state.dependencyCaptures.at(-1) ?? state.currentReadSources;
      for (const sourceId of state.variableSources.get(variableName) ?? []) {
        if (sourceId && sourceId !== state.currentModuleId) {
          readSources.add(sourceId);
        }
      }
    }
    return value;
  }

  if (lowerCommand === 'getglobalvar') {
    const variableName = parts.slice(1).join('::').trim();
    if (state.context.globals.has(variableName)) {
      state.counts.contextSubstitutions += 1;
      return state.context.globals.get(variableName);
    }
    recordUnresolved(state, `{{getglobalvar::${variableName}}}`, '');
    return '';
  }

  if (lowerCommand === 'trim') {
    state.counts.trim += 1;
    return '';
  }

  if (Object.hasOwn(SEMANTIC_PLACEHOLDERS, command)) {
    return semanticReplacement(state, command);
  }
  if (state.context.macros.has(command)) {
    state.counts.contextSubstitutions += 1;
    return state.context.macros.get(command);
  }

  if (lowerCommand === 'random') {
    const choices = parts.slice(1);
    const chosen = choices[0] ?? '';
    const replacement = expandPortableText(chosen, state, depth + 1);
    state.counts.dynamicFallbacks += 1;
    recordUnresolved(state, `{{${trimmed}}}`, replacement);
    return replacement;
  }
  if (lowerCommand.startsWith('random:')) {
    const choices = command.slice(command.indexOf(':') + 1).split(',');
    const replacement = expandPortableText(choices[0] ?? '', state, depth + 1);
    state.counts.dynamicFallbacks += 1;
    recordUnresolved(state, `{{${trimmed}}}`, replacement);
    return replacement;
  }
  if (lowerCommand.startsWith('roll:')) {
    const specification = command.slice(command.indexOf(':') + 1).trim();
    const replacement = `[RUNTIME_ROLL:${specification || 'unspecified'}]`;
    state.counts.dynamicFallbacks += 1;
    recordUnresolved(state, `{{${trimmed}}}`, replacement);
    return replacement;
  }
  if (lowerCommand === 'datetimeformat' || lowerCommand.startsWith('datetimeformat ')) {
    return semanticReplacement(state, 'datetimeformat');
  }

  const placeholderName = command
    .replace(/[^\p{Letter}\p{Number}_-]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase() || 'UNKNOWN';
  const replacement = `[RUNTIME_${placeholderName}]`;
  state.counts.dynamicFallbacks += 1;
  recordUnresolved(state, `{{${trimmed}}}`, replacement);
  return replacement;
}

function expandPortableText(text, state, depth = 0) {
  if (depth > 64) fail(`Macro nesting exceeded 64 levels in ${state.currentModuleId}.`);
  let output = '';
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('{{', cursor);
    if (start === -1) {
      output += text.slice(cursor);
      break;
    }
    output += text.slice(cursor, start);
    const end = findMacroEnd(text, start);
    if (end === -1) {
      recordUnresolved(state, text.slice(start), '[UNTERMINATED_MACRO]');
      output += '[UNTERMINATED_MACRO]';
      break;
    }
    output += evaluateMacro(text.slice(start + 2, end), state, depth);
    cursor = end + 2;
  }
  return output;
}

function cleanPortableText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeTrackerDsl(text) {
  let output = '';
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('[[', cursor);
    if (start === -1) {
      output += text.slice(cursor);
      break;
    }
    output += text.slice(cursor, start);
    let depth = 0;
    let end = -1;
    for (let index = start; index < text.length - 1; index += 1) {
      const pair = text.slice(index, index + 2);
      if (pair === '[[') {
        depth += 1;
        index += 1;
      } else if (pair === ']]') {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
        index += 1;
      }
    }
    if (end === -1) {
      output += text.slice(start).replace(/\[\[/g, '').replace(/\]\]/g, '');
      break;
    }

    const marker = text.slice(start + 2, end).trim();
    const [head, ...tail] = marker.split('|');
    const [rawCommand, ...rawArguments] = head.trim().split(/\s+/);
    const command = rawCommand.toLowerCase();
    const argument = rawArguments.join(' ').trim();
    if (command.startsWith('/')) {
      // Closing marker: omit.
    } else if (command === 'tab') {
      output += argument ? `Section: ${argument}` : '';
    } else if (['who', 'room', 'thread', 'else'].includes(command)) {
      output += argument;
    } else if (command === 'item') {
      output += `${argument}${tail.length > 0 ? ` — ${tail.join(' | ').trim()}` : ''}`;
    } else if (command !== 'deep') {
      output += marker;
    }
    cursor = end + 2;
  }
  return output;
}

function normalizePortableControlDirectives(text, prompt, state) {
  if (text.trim().length === 0) return '';
  const original = text;
  const metadata = extractMetadata(prompt.content);
  const containsScratchpad = /<\/?nemo-pad\b/i.test(text);
  let normalized = text;

  normalized = normalized
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(
      /When a planning mode is active,\s*write its compact scaffold inside explicit\s*`?<plan>`?\s*blocks?/gi,
      'When a planning mode is active, perform its compact scaffold privately and never expose it',
    )
    .replace(
      /When this mode is active,\s*begin with a compact operational plan inside\s*`?<plan>`?\s*and close it with\s*`?<\/plan>`?\s*before visible prose\./gi,
      'When this mode is active, perform a compact operational plan privately before writing visible prose.',
    )
    .replace(
      /write the compact scaffold inside\s*`?<plan>`?/gi,
      'perform the compact scaffold privately',
    )
    .replace(/inside\s*`?<plan>`?/gi, 'during private planning')
    .replace(/Procedure,\s*during private planning:/gi, 'Private planning procedure:')
    .replace(/<\/?(?:plan(?:ning)?|think(?:ing)?|analysis)\b[^>]*>/gi, '')
    .replace(/<nemo-final\b[^>]*>/gi, 'the visible final answer')
    .replace(/<\/nemo-final\s*>/gi, '')
    .replace(
      /<\/?(?:runtime_settings_reminder|language_runtime(?:_resolver)?|style_elements)\b[^>]*>/gi,
      '',
    )
    .replace(/<style\s+influences=[^>]*\/>/gi, '')
    .replace(/<scene\b[^>]*>([\s\S]*?)<\/scene\s*>/gi, '$1')
    .replace(/<\/?scene\b[^>]*>/gi, '')
    .replace(/output one exact marker before narration:/gi, 'output one plain-text scene header before narration:')
    .replace(
      /Regex renders the marker; never write raw HTML\./gi,
      'No marker renderer is available; write the header as ordinary text.',
    )
    .replace(
      /- Color Formatting:[^\n]*/gi,
      '- Dialogue Formatting: use ordinary quotation marks and, when useful, Markdown emphasis. Keep narration and attribution unadorned; color markup is unavailable.',
    )
    .replace(/\[\[tab\s+([^|\]]+)(?:\|[^\]]*)?\]\]/gi, 'Section: $1')
    .replace(/\[\[\/(?:tab|who|room|thread|else|deep)\]\]/gi, '')
    .replace(/\[\[(?:who|room|thread|else)\s+([^\]]+)\]\]/gi, '$1')
    .replace(/\[\[deep\]\]/gi, '')
    .replace(/<\/?nemo-pad\b[^>]*>/gi, '');

  if (containsScratchpad) {
    normalized = normalized
      .replace(
        /Emit exactly one block at the absolute end of the response:/gi,
        'Maintain one private state snapshot after responding; do not expose it:',
      )
      .replace(
        /At the end of each response, revise one current-state snapshot\./gi,
        'After each response, revise one private current-state snapshot without displaying it.',
      );
  }

  const category = metadata.category ?? '';
  const isUiModule =
    PORTABLE_UI_PROMPT_IDS.has(prompt.identifier) ||
    /(?:tracker|interface|scratchpad|html)/i.test(category) ||
    /<html\b|<div\b|<table\b|<style\b[^>]*>[\s\S]*<\/style\s*>|```html|\[\[tab\b|\bHTML\s+(?:codeblock|panel|interface|renderer)|\b(?:use|output|emit|render|write|return|produce)\b[^\n]{0,100}\bHTML\b/i.test(
      `${prompt.content}\n${normalized}`,
    );
  if (isUiModule) {
    state.uiDegradedModules.add(prompt.identifier);
    normalized = normalized
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
      .replace(/```(?:html|css|javascript|js)?\s*/gi, '')
      .replace(
        /<\/?(?:html|head|body|style|script|div|span|details|summary|table|thead|tbody|tfoot|tr|td|th|ul|ol|li|h[1-6]|strong|em|hr|br|p|section|article|button|input|label|progress|meter)\b[^>]*>/gi,
        '',
      )
      .replace(
        /Initial Post Only:[^\n]*/gi,
        'Presentation: include current state as concise plain-text key-value lines.',
      )
      .replace(
        /All Subsequent Posts:[^\n]*/gi,
        'On later responses, update the plain-text state without repeating static explanation.',
      )
      .replace(/\bHTML\b/gi, 'plain-text')
      .replace(/\bCSS\b/gi, 'plain-text formatting')
      .replace(/\bJavaScript\b/gi, 'scripting')
      .replace(
        /^\s*OOC:\s*use\s+this\s*Core\s+Directive:\s*/i,
        'Core directive: ',
      );
    if (prompt.identifier === 'v11-627-fetish-harmonized-html-enable-fefnik') {
      normalized =
        'Presentation compatibility: keep any optional state display in concise plain-text ' +
        'key-value lines. Do not wrap it in web markup or a code fence.';
    }
    normalized =
      'Portable UI fallback: express the useful state as concise plain text. Do not emit web markup, styling code, scripts, regex-renderer markup, or tracker DSL.\n\n' +
      normalized;
  }

  normalized = cleanPortableText(normalizeTrackerDsl(normalized));
  if (normalized !== original) {
    state.counts.controlDirectivesNormalized += 1;
    state.controlModules.add(prompt.identifier);
  }
  return normalized;
}

function baseModuleManifest(prompt, metadata) {
  return {
    id: prompt.identifier,
    name: prompt.name,
    kind: moduleKind(prompt, metadata),
    role: prompt.role,
    category: metadata.category,
    exclusiveGroup: metadata.exclusiveGroup,
    marker: Boolean(prompt.marker),
    injection: {
      position: prompt.injection_position,
      depth: prompt.injection_depth,
      order: prompt.injection_order,
    },
  };
}

function portableDisplayName(name) {
  return name
    .replace(/<\s*(?:think(?:ing)?|plan(?:ning)?|analysis)\s*>/gi, 'private planning')
    .replace(/<\s*user\s*>/gi, '[USER]')
    .replace(/<([^<>]+)>/g, '[$1]');
}

function portableOutputGuard() {
  return {
    id: 'nemo-portable-output-contract',
    name: 'Nemo portable output contract',
    kind: 'portable-guard',
    role: 'system',
    synthetic: true,
    content:
      'This portable runtime has no SillyTavern postprocessor. Keep all planning, reasoning, analysis, service metadata, and scratchpads private. Return only the user-facing answer, without internal boundary labels or service wrappers.',
  };
}

function renderPortableInstructions(prompts) {
  return `${prompts
    .map(
      (prompt, index) =>
        `## Nemo module ${index + 1}: ${prompt.name}\n` +
        `Role: ${prompt.role}\n` +
        `Identifier: ${prompt.id}\n\n` +
        prompt.content,
    )
    .join('\n\n')}\n`;
}

function compileSelectedPrompts({ activeReferences, promptById, mode, context, maxChars }) {
  const modules = [];
  if (mode === 'source') {
    const prompts = activeReferences.map((reference) => {
      const prompt = promptById.get(reference.identifier);
      const metadata = extractMetadata(prompt.content);
      modules.push({ ...baseModuleManifest(prompt, metadata), emission: 'source' });
      return {
        id: prompt.identifier,
        name: prompt.name,
        kind: moduleKind(prompt, metadata),
        role: prompt.role,
        rawContent: prompt.content,
      };
    });
    return {
      modules,
      prompts,
      macroResolution: {
        counts: {
          commentsStripped: 0,
          setvar: 0,
          addvar: 0,
          getvar: 0,
          trim: 0,
          contextSubstitutions: 0,
          dynamicFallbacks: 0,
          controlDirectivesNormalized: 0,
        },
        unresolved: [],
        semanticContextSlots: [],
      },
      portableTransforms: [],
      instructionChars: prompts.reduce((sum, prompt) => sum + prompt.rawContent.length, 0),
      instructionsText: null,
    };
  }

  const state = createMacroState(context);
  const prompts = [];
  for (const reference of activeReferences) {
    const prompt = promptById.get(reference.identifier);
    const metadata = extractMetadata(prompt.content);
    const manifest = baseModuleManifest(prompt, metadata);
    state.currentModuleId = prompt.identifier;
    state.currentReadSources = new Set();

    if (manifest.kind === 'section-header') {
      modules.push({ ...manifest, emission: 'omitted-section-header' });
      continue;
    }
    if (manifest.kind === 'marker') {
      modules.push({ ...manifest, emission: 'omitted-host-marker' });
      continue;
    }

    const content = normalizePortableControlDirectives(
      cleanPortableText(expandPortableText(prompt.content, state)),
      prompt,
      state,
    );
    if (content.length === 0) {
      modules.push({ ...manifest, emission: 'omitted-state-only' });
      continue;
    }
    for (const sourceId of state.currentReadSources) {
      if (sourceId && sourceId !== prompt.identifier) {
        state.consumedSourceModules.add(sourceId);
      }
    }
    modules.push({ ...manifest, emission: 'portable' });
    prompts.push({
      id: prompt.identifier,
      name: portableDisplayName(prompt.name),
      kind: manifest.kind,
      role: prompt.role,
      content,
    });
  }

  for (const module of modules) {
    if (
      module.emission === 'omitted-state-only' &&
      state.consumedSourceModules.has(module.id)
    ) {
      module.emission = 'folded-state';
    }
  }

  prompts.push(portableOutputGuard());
  for (const prompt of prompts) {
    const forbidden = `${prompt.name}\n${prompt.content}`.match(
      /\{\{|<!--|-->|<!|<%|%>|<\?|\?>|<\/?(?:plan(?:ning)?|think(?:ing)?|analysis|scratchpad|service|nemo-final|nemo-pad|scene|runtime_settings_reminder|language_runtime(?:_resolver)?)\b|\[\[(?:\/?tab|\/?who|\/?room|\/?thread|\/?deep)\b/i,
    );
    if (forbidden) {
      fail(
        `Portable normalization left unsupported syntax ${JSON.stringify(forbidden[0])} ` +
          `in ${prompt.id}. Use --mode source for audit.`,
      );
    }
  }
  const instructionsText = renderPortableInstructions(prompts);
  const instructionChars = Array.from(instructionsText).length;
  if (instructionChars > maxChars) {
    fail(
      `Portable instructions require ${instructionChars} characters, above the ` +
        `--max-portable-chars limit of ${maxChars}. Raise the limit explicitly or select fewer modules.`,
    );
  }

  return {
    modules,
    prompts,
    macroResolution: {
      counts: state.counts,
      unresolved: [...state.unresolved.values()],
      semanticContextSlots: [...state.semanticSlots.values()],
    },
    portableTransforms: [
      ...(state.controlModules.size > 0
        ? [
            {
              code: 'PORTABLE_CONTROL_DIRECTIVES_NORMALIZED',
              moduleIds: [...state.controlModules],
            },
          ]
        : []),
      ...(state.uiDegradedModules.size > 0
        ? [
            {
              code: 'PORTABLE_UI_DEGRADED',
              moduleIds: [...state.uiDegradedModules],
              fallback: 'plain-text',
            },
          ]
        : []),
    ],
    instructionChars,
    instructionsText,
  };
}

const INTERNAL_OUTPUT_TAG =
  '(?:think(?:ing)?|plan(?:ning)?|analysis|scratchpad|nemo-pad|service|' +
  'runtime_settings_reminder|language_runtime(?:_resolver)?)';

function stripBalancedInternalBlocks(text) {
  const tokenPattern = new RegExp(`<(/?)(${INTERNAL_OUTPUT_TAG})\\b[^>]*>`, 'gi');
  const stack = [];
  const edits = [];
  for (const match of text.matchAll(tokenPattern)) {
    const closing = match[1] === '/';
    const name = match[2].toLowerCase();
    if (!closing) {
      stack.push({ name, start: match.index });
      continue;
    }
    const opening = stack.at(-1);
    if (!opening) {
      fail(`Unsafe unmatched sanitizer boundary: ${match[0]}.`);
    }
    if (opening.name !== name) {
      fail(`Unsafe or misnested sanitizer boundary: ${match[0]}.`);
    }
    stack.pop();
    if (stack.length === 0) {
      edits.push({ start: opening.start, end: match.index + match[0].length, replacement: '' });
    }
  }
  if (stack.length > 0) {
    fail(`Unsafe or unclosed sanitizer boundary: <${stack[0].name}>.`);
  }

  edits.sort((left, right) => left.start - right.start || right.end - left.end);
  let output = '';
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue;
    output += text.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  return output + text.slice(cursor);
}

export function sanitizeOutput(text) {
  let cleaned = String(text).replace(/\r\n?/g, '\n');
  const finalTokens = [...cleaned.matchAll(/<(\/?)nemo-final\s*>/gi)];
  const openings = finalTokens.filter((match) => match[1] !== '/');
  const closings = finalTokens.filter((match) => match[1] === '/');
  if (openings.length > 1 || closings.length > 1) {
    fail('Unsafe sanitizer output: multiple nemo-final boundaries.');
  }
  if (closings.length > 0 && openings.length === 0) {
    fail('Unsafe sanitizer output: closing nemo-final boundary has no opening boundary.');
  }

  if (openings.length === 1) {
    const opening = openings[0];
    const closing = closings[0] ?? null;
    if (closing && closing.index < opening.index) {
      fail('Unsafe sanitizer output: nemo-final boundaries are out of order.');
    }
    const lineStart = cleaned.lastIndexOf('\n', opening.index - 1) + 1;
    if (cleaned.slice(lineStart, opening.index).trim().length > 0) {
      fail('Unsafe sanitizer output: nemo-final opening boundary is not standalone.');
    }
    // A final marker is trusted only after a prefix made exclusively of fully
    // balanced private blocks and whitespace. Arbitrary discarded prose or a
    // dangling tag could otherwise smuggle the marker inside an attribute or
    // quoted literal.
    const prefix = cleaned.slice(0, opening.index);
    const prefixRemainder = stripBalancedInternalBlocks(prefix).replace(
      /^[ \t]*\(OOC:[^\n]*\)[ \t]*$/gim,
      '',
    );
    if (prefixRemainder.trim().length > 0) {
      fail('Unsafe sanitizer output: non-private data precedes nemo-final.');
    }
    if (closing && cleaned.slice(closing.index + closing[0].length).trim().length > 0) {
      fail('Unsafe sanitizer output: non-whitespace data follows nemo-final.');
    }
    cleaned = cleaned.slice(
      opening.index + opening[0].length,
      closing ? closing.index : cleaned.length,
    );
  }

  cleaned = stripBalancedInternalBlocks(cleaned);
  cleaned = cleaned
    .replace(/<scene\b[^>]*>([\s\S]*?)<\/scene\s*>/gi, '$1')
    .replace(/<\/?scene\b[^>]*>/gi, '')
    .replace(/\[\[tab\s+([^|\]]+)(?:\|[^\]]*)?\]\]/gi, '$1\n')
    .replace(/\[\[item\s+([^|\]]+)\|([^\]]+)\]\]/gi, '$1 — $2')
    .replace(/\[\[(?:who|room|thread|else)\s+([^\]]+)\]\]/gi, '$1')
    .replace(/\[\[\/?(?:tab|who|room|thread|else|deep)\]\]/gi, '')
    .replace(/^[ \t]*(?:\(OOC:[^\n]*\)[ \t]*\n?)+/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const unsafeOpaqueMarkup = cleaned.match(
    /<!--|-->|<!|\]\]>|<%|%>|<\?|\?>/i,
  );
  if (unsafeOpaqueMarkup) {
    fail(
      `Unsafe sanitizer output contains residual opaque markup: ${unsafeOpaqueMarkup[0]}.`,
    );
  }
  const unsafeResidual = cleaned.match(/<\/?[A-Za-z][A-Za-z0-9:_-]*\b[^>]*>/);
  if (unsafeResidual) {
    fail(`Unsafe sanitizer output contains residual service markup: ${unsafeResidual[0]}.`);
  }
  if (/\(OOC:/i.test(cleaned)) {
    fail('Unsafe sanitizer output contains unparsed OOC scaffolding.');
  }
  if (/\[\[|\]\]/.test(cleaned)) {
    fail('Unsafe sanitizer output contains residual tracker or service DSL.');
  }
  if (cleaned.length === 0) fail('Sanitized output is empty.');
  return `${cleaned}\n`;
}

async function compile(options) {
  const presetPath = options.preset
    ? path.resolve(process.cwd(), options.preset)
    : DEFAULT_PRESET;
  const sourceBytes = await readFile(presetPath);
  let preset;
  try {
    preset = JSON.parse(sourceBytes.toString('utf8'));
  } catch (error) {
    fail(`Cannot parse preset JSON ${JSON.stringify(presetPath)}: ${error.message}`);
  }

  const { promptById, sourceIndexById } = validatePreset(preset);
  const profile = selectProfile(preset, options.profile, promptById);
  const profileActivation = new Map(
    profile.order.map((reference) => [reference.identifier, reference.enabled]),
  );
  const activation = new Map(profileActivation);
  const candidates = familyCandidates(preset, sourceIndexById);
  const diagnostics = { repairs: [], warnings: [] };

  configureVex({
    preset,
    presetPath,
    profile,
    candidates: candidates.vex,
    activation,
    requested: options.vex,
    diagnostics,
  });
  const nsfwSelection = parseExactSelection(options.nsfw, candidates.nsfw, 'NSFW');
  const fetishSelection = parseExactSelection(options.fetish, candidates.fetish, 'Fetish');
  replaceFamilySelection(activation, candidates.nsfw, nsfwSelection);
  replaceFamilySelection(activation, candidates.fetish, fetishSelection);

  // Generic module overrides are deliberately last. This makes them a precise
  // escape hatch over both the profile baseline and the family selectors.
  const genericDisabled = parseModuleSelection(
    options.disable,
    candidates.modules,
    '--disable',
  );
  const genericEnabled = parseModuleSelection(
    options.enable,
    candidates.modules,
    '--enable',
  );
  const disabledIds = new Set(genericDisabled.map((candidate) => candidate.id));
  const contradictory = genericEnabled.filter((candidate) => disabledIds.has(candidate.id));
  if (contradictory.length > 0) {
    fail(
      'The same module cannot be passed to both --enable and --disable: ' +
        contradictory.map((candidate) => `${candidate.name} (${candidate.id})`).join(', ') +
        '.',
    );
  }
  for (const candidate of genericDisabled) activation.set(candidate.id, false);
  for (const candidate of genericEnabled) activation.set(candidate.id, true);

  const finalVexCandidates = candidates.vex.filter((candidate) => activation.get(candidate.id));
  if (finalVexCandidates.length !== 1) {
    fail(
      `Exactly one Vex personality must remain active; found ${finalVexCandidates.length}. ` +
        'Use --vex SELECTOR or pair --disable with --enable.',
    );
  }

  validateExclusiveGroups(preset, activation);
  addCompatibilityWarnings(activation, diagnostics);

  const activeReferences = profile.order.filter((reference) => activation.get(reference.identifier));
  const context = await loadPortableContext(options.context);
  const compiled = compileSelectedPrompts({
    activeReferences,
    promptById,
    mode: options.mode,
    context,
    maxChars: options.maxPortableChars,
  });

  const activeVex = selectedFamily(profile.order, activation, candidates.vex);
  diagnostics.macroResolution = compiled.macroResolution;
  diagnostics.portableTransforms = compiled.portableTransforms;
  const uiDegradation = compiled.portableTransforms.find(
    (entry) => entry.code === 'PORTABLE_UI_DEGRADED',
  );
  if (uiDegradation) {
    diagnostics.warnings.push({
      code: 'PORTABLE_UI_DEGRADED',
      promptIds: uiDegradation.moduleIds,
      message: 'SillyTavern UI instructions were converted to a plain-text fallback.',
    });
  }

  const bundle = {
    schemaVersion: SCHEMA_VERSION,
    mode: options.mode,
    source: {
      path: portableSourcePath(presetPath),
      sha256: createHash('sha256').update(sourceBytes).digest('hex'),
      presetName: preset.preset_name ?? null,
    },
    profile: {
      characterId: profile.character_id,
    },
    selections: {
      vex: activeVex.length === 1 ? activeVex[0] : null,
      nsfw: selectedFamily(profile.order, activation, candidates.nsfw),
      fetish: selectedFamily(profile.order, activation, candidates.fetish),
      overrides: {
        enabled: genericEnabled.map((candidate) => ({ id: candidate.id, name: candidate.name })),
        disabled: genericDisabled.map((candidate) => ({ id: candidate.id, name: candidate.name })),
      },
    },
    compatibility: {
      target: 'ChatGPT',
      mode: options.mode,
      limitations:
        options.mode === 'portable'
          ? [
              'Only deterministic setvar, addvar, getvar, getglobalvar, trim, metadata-comment, and context substitutions are compiled.',
              'SillyTavern injection position/depth/order are preserved in modules metadata, not executed.',
              'Regex scripts, lorebook retrieval, tracker UI, and HTML rendering are not executed.',
              'Provider context, sampling, reasoning, prefill, tool, web, and image settings are not applied.',
              'Run --sanitize-output on generated text when the calling host cannot enforce the portable output contract.',
            ]
          : [
              'Source mode is an audit representation and is not directly runnable in ChatGPT.',
              'SillyTavern macros and host markers are preserved verbatim in rawContent.',
              'Injection, regex, lorebooks, tracker UI, HTML rendering, and provider settings are not executed.',
            ],
    },
    stats: {
      sourcePrompts: preset.prompts.length,
      sourceProfiles: preset.prompt_order.length,
      sourceRegexScripts: Array.isArray(preset.extensions?.regex_scripts)
        ? preset.extensions.regex_scripts.length
        : 0,
      profileEnabledPrompts: [...profileActivation.values()].filter(Boolean).length,
      enabledPrompts: activeReferences.length,
      emittedPrompts: compiled.prompts.length,
      instructionChars: compiled.instructionChars,
    },
    portableInstructions:
      options.mode === 'portable'
        ? {
            mediaType: 'text/plain; charset=utf-8',
            sha256: createHash('sha256').update(compiled.instructionsText, 'utf8').digest('hex'),
            bytes: Buffer.byteLength(compiled.instructionsText, 'utf8'),
            characters: Array.from(compiled.instructionsText).length,
            blockCount: compiled.prompts.length,
          }
        : null,
    diagnostics,
    modules: compiled.modules,
    prompts: compiled.prompts,
  };

  return {
    bundle,
    inventory: options.list
      ? buildInventory(
          bundle,
          candidates,
          activation,
          profileActivation,
          profile.order,
          options.list,
        )
      : null,
    presetPath,
    instructionsText: compiled.instructionsText,
  };
}

async function pathsAlias(leftPath, rightPath) {
  if (path.resolve(leftPath) === path.resolve(rightPath)) return true;
  try {
    const [left, right] = await Promise.all([stat(leftPath), stat(rightPath)]);
    return left.dev === right.dev && left.ino === right.ino;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function emit(value, options, presetPath) {
  const json = `${JSON.stringify(value, null, options.pretty ? 2 : 0)}\n`;
  if (!options.out || options.out === '-') {
    process.stdout.write(json);
    return;
  }

  const outputPath = path.resolve(process.cwd(), options.out);
  if (await pathsAlias(outputPath, presetPath)) {
    fail('Refusing to overwrite the source preset. Choose a different --out path.');
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, json, 'utf8');
  process.stderr.write(`Wrote ${outputPath}\n`);
}

async function emitPlainText(text, options, protectedPath = null) {
  if (!options.out || options.out === '-') {
    process.stdout.write(text);
    return;
  }
  const outputPath = path.resolve(process.cwd(), options.out);
  if (protectedPath && (await pathsAlias(outputPath, protectedPath))) {
    fail('Refusing to overwrite the input file. Choose a different --out path.');
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, text, 'utf8');
  process.stderr.write(`Wrote ${outputPath}\n`);
}

function isWithinPath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
}

async function prepareFreshEmissionDirectory(directoryPath) {
  const sourceDirectory = path.join(REPOSITORY_ROOT, 'Nemo Engine');
  if (isWithinPath(directoryPath, sourceDirectory)) {
    fail('--emit-dir may not target the authoritative Nemo Engine source tree.');
  }

  let existing = false;
  try {
    const status = await lstat(directoryPath);
    existing = true;
    if (status.isSymbolicLink()) fail('--emit-dir refuses a symbolic-link target.');
    if (!status.isDirectory()) fail('--emit-dir target exists and is not a directory.');
    const entries = await readdir(directoryPath);
    if (entries.length > 0) {
      fail('--emit-dir target must be new or empty; refusing a non-empty directory.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let ancestor = existing ? directoryPath : path.dirname(directoryPath);
  while (true) {
    try {
      const status = await lstat(ancestor);
      if (status.isSymbolicLink()) {
        fail('--emit-dir refuses a path reached through a symbolic-link directory.');
      }
      const resolvedAncestor = await realpath(ancestor);
      if (resolvedAncestor !== path.resolve(ancestor)) {
        fail('--emit-dir refuses a path reached through symbolic links.');
      }
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }

  if (!existing) await mkdir(directoryPath, { recursive: true });
}

async function emitPortableDirectory(directory, bundle, instructionsText) {
  if (bundle.compatibility.mode !== 'portable' || instructionsText === null) {
    fail('--emit-dir requires --mode portable.');
  }
  const characters = Array.from(instructionsText);
  if (characters.length > DEFAULT_MAX_PORTABLE_CHARS) {
    fail(
      `--emit-dir hard limit is ${DEFAULT_MAX_PORTABLE_CHARS} characters; ` +
        `the selected runtime requires ${characters.length}.`,
    );
  }

  const directoryPath = path.resolve(process.cwd(), directory);
  const chunks = [];
  for (let start = 0; start < characters.length; start += EMIT_CHUNK_CHARS) {
    const end = Math.min(start + EMIT_CHUNK_CHARS, characters.length);
    const text = characters.slice(start, end).join('');
    const index = chunks.length + 1;
    chunks.push({
      index,
      start,
      end,
      chars: end - start,
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      file: `chunk-${String(index).padStart(3, '0')}.txt`,
      text,
    });
  }
  if (chunks.length > EMIT_MAX_CHUNKS) {
    fail(
      `--emit-dir requires ${chunks.length} chunks; the hard limit is ${EMIT_MAX_CHUNKS}.`,
    );
  }
  const reassembled = chunks.map((chunk) => chunk.text).join('');
  if (reassembled !== instructionsText) {
    fail('Internal chunk round-trip verification failed.');
  }

  const instructionSha256 = createHash('sha256')
    .update(instructionsText, 'utf8')
    .digest('hex');
  const manifest = {
    schemaVersion: 'nemo-chatgpt-runtime-emission/v1',
    sourceSha256: bundle.source.sha256,
    profile: bundle.profile,
    mode: 'portable',
    selections: bundle.selections,
    stats: bundle.stats,
    orderedEmittedIds: bundle.prompts.map((prompt) => prompt.id),
    omittedModules: bundle.modules
      .filter((module) => module.emission !== 'portable')
      .map((module) => ({
        id: module.id,
        name: module.name,
        reason: module.emission,
      })),
    instructionChars: characters.length,
    instructionBytes: Buffer.byteLength(instructionsText, 'utf8'),
    instructionSha256,
    chunkSizeChars: EMIT_CHUNK_CHARS,
    chunks: chunks.map(({ text: _text, ...chunk }) => chunk),
  };

  await prepareFreshEmissionDirectory(directoryPath);
  await writeFile(path.join(directoryPath, 'instructions.txt'), instructionsText, 'utf8');
  await Promise.all(
    chunks.map((chunk) =>
      writeFile(path.join(directoryPath, chunk.file), chunk.text, 'utf8'),
    ),
  );
  await writeFile(
    path.join(directoryPath, 'instructions.manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  process.stderr.write(
    `Wrote ${directoryPath} (${characters.length} characters, ${chunks.length} chunks, sha256 ${instructionSha256})\n`,
  );
}

async function readStdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function runSanitizer(options) {
  const compileSelectionsUsed =
    options.preset !== null ||
    String(options.profile) !== DEFAULT_PROFILE ||
    options.context !== null ||
    options.vex !== null ||
    options.nsfw !== null ||
    options.fetish !== null ||
    options.enable.length > 0 ||
    options.disable.length > 0 ||
    options.instructionsOnly ||
    options.emitDir !== null ||
    options.list !== null;
  if (compileSelectionsUsed) {
    fail('--sanitize-output is standalone and cannot be combined with preset selectors or --list.');
  }

  const inputPath =
    options.sanitizeOutput === '-'
      ? null
      : path.resolve(process.cwd(), options.sanitizeOutput);
  const input = inputPath ? await readFile(inputPath, 'utf8') : await readStdinText();
  const cleaned = sanitizeOutput(input);

  await emitPlainText(cleaned, options, inputPath);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  if (options.sanitizeOutput !== null) {
    await runSanitizer(options);
    return;
  }

  if (options.instructionsOnly && options.mode !== 'portable') {
    fail('--instructions-only requires --mode portable.');
  }
  if (options.instructionsOnly && options.list !== null) {
    fail('--instructions-only cannot be combined with --list.');
  }
  if (options.emitDir !== null) {
    if (options.mode !== 'portable') fail('--emit-dir requires --mode portable.');
    if (options.out !== null) fail('--emit-dir cannot be combined with --out.');
    if (options.instructionsOnly) {
      fail('--emit-dir cannot be combined with --instructions-only.');
    }
    if (options.list !== null) fail('--emit-dir cannot be combined with --list.');
  }

  const { bundle, inventory, presetPath, instructionsText } = await compile(options);
  if (options.emitDir !== null) {
    await emitPortableDirectory(options.emitDir, bundle, instructionsText);
    return;
  }
  if (options.instructionsOnly) {
    await emitPlainText(instructionsText, options, presetPath);
    return;
  }
  await emit(inventory ?? bundle, options, presetPath);
}

const invokedAsCli =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedAsCli) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
