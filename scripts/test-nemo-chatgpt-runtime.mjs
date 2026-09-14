#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(scriptsDirectory);
const runtimePath = path.join(scriptsDirectory, 'nemo-chatgpt-runtime.mjs');
const sourcePath = path.join(
  repositoryRoot,
  'Nemo Engine',
  'Nemo Engine 11.5.2 - General RP.json',
);
const psychologyHumiliationJoiReadyPath = path.join(
  repositoryRoot,
  'Nemo Engine',
  'Ready',
  'Nemo Engine 11.5.2 - Ready RU Psychology Humiliation JOI RP.json',
);

const EXPECTED_SOURCE_SHA256 =
  'c5e13e951340d17addef0e16e7a7152a8256c41f2c046a52e81d86e1feef31d4';
const EXPECTED_SOURCE_PROMPTS = 458;
const EXPECTED_SOURCE_PROFILES = 2;
const EXPECTED_SOURCE_REGEX_SCRIPTS = 97;
const EXPECTED_DEFAULT_ENABLED_PROMPTS = 106;
const EXPECTED_DEFAULT_PORTABLE_PROMPTS = 26;
const EXPECTED_FETISH_PROMPTS = 16;
const MAX_DEFAULT_PORTABLE_CHARACTERS = 170_000;

const IDS = Object.freeze({
  variableInit: 'v11-000-variable-init',
  narrativeVex: 'v11-305-vex-narrative-vex',
  haarVex: 'v11-326-vex-haar-vex',
  goonerVex: 'v11-329-vex-gooner-vex',
  goonGremlinVex: 'v11-304-vex-goon-gremlin-vex',
  modernNsfwCore: 'v11-180-nsfw-nsfw-core',
  classicNsfwCore: 'v11-537-classic-nsfw-core',
  dirtyTalk: 'v11-176-nsfw-dirty-talk',
  domLanguage: 'v11-177-nsfw-dom-language',
  goonerProtocol: 'v11-178-nsfw-gooner-protocol',
  goonerSlop: 'v11-620-nsfw-gooner-slop-mode',
  goonerMasterpiece: 'v11-621-nsfw-gooner-s-masterpiece-protocol',
  cbt: 'v11-166-fetish-cbt',
  femdom: 'v11-167-fetish-femdom',
  ntr: 'v11-173-fetish-ntr',
  petplay: 'v11-174-fetish-petplay',
  humiliation: 'v11-639-fetish-humiliation',
  joi: 'v11-640-fetish-joi',
  datingSim: 'v11-624-fetish-dating-sim-quantum',
  corruption: 'v11-625-fetish-corruption-fefnik',
  forcedFemClassic: 'v11-626-fetish-forced-fem-classic',
  harmonizedHtml: 'v11-627-fetish-harmonized-html-enable-fefnik',
  manipulationRealism: 'v11-611-augment-manipulation-realism',
  psychologicalRealism: 'v11-613-augment-psychological-emotional-realism',
  characterFriction: 'v11-244-utility-character-friction',
  moreDialogue: 'v11-240-utility-more-dialogue',
  balancedDifficulty: 'v11-100-difficulty-balanced',
  heroicDifficulty: 'v11-103-difficulty-heroic',
  animeWorldLogic: 'v11-133-world-logic-anime',
  hentaiWorldLogic: 'v11-134-world-logic-hentai',
});

const sourceBytes = readFileSync(sourcePath);
const source = JSON.parse(sourceBytes.toString('utf8'));
const sourcePromptById = new Map(
  source.prompts.map((prompt) => [prompt.identifier, prompt]),
);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function categoryOf(prompt) {
  const match = prompt.content?.match(/\{\{\/\/\s*@category\s+([^}\r\n]+?)\s*}}/i);
  return match?.[1]?.trim() ?? null;
}

function exclusiveGroupOf(prompt) {
  if (prompt.identifier === IDS.classicNsfwCore) return 'NSFW-Core';
  const match = prompt.content?.match(
    /\{\{\/\/\s*@mutual-exclusive-group\s+([^}\r\n]+?)\s*}}/i,
  );
  return match?.[1]?.trim() ?? null;
}

function isSectionHeader(prompt) {
  return /\{\{\/\/\s*@section-header\s+true\s*}}/i.test(prompt.content ?? '');
}

const vexPersonaIds = new Set(
  source.prompts
    .filter(
      (prompt) =>
        categoryOf(prompt) === 'Vex-Personality' && !isSectionHeader(prompt),
    )
    .map((prompt) => prompt.identifier),
);
const nsfwIds = new Set(
  source.prompts
    .filter((prompt) => categoryOf(prompt) === 'NSFW' && !isSectionHeader(prompt))
    .map((prompt) => prompt.identifier),
);
const fetishIds = new Set(
  source.prompts
    .filter((prompt) => categoryOf(prompt) === 'Fetish' && !isSectionHeader(prompt))
    .map((prompt) => prompt.identifier),
);
const goonerIds = new Set(
  source.prompts
    .filter((prompt) => /goon(?:er| gremlin)/i.test(prompt.name))
    .map((prompt) => prompt.identifier),
);

function invokeRuntime(args = [], { input } = {}) {
  const result = spawnSync(process.execPath, [runtimePath, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    input,
  });

  assert.equal(
    result.signal,
    null,
    `runtime terminated by ${result.signal}; stderr:\n${result.stderr}`,
  );
  assert.equal(result.error, undefined, result.error?.stack);
  return result;
}

function invokeBundle(args = []) {
  const result = invokeRuntime(args);
  assert.equal(
    result.status,
    0,
    `runtime exited ${result.status}; stderr:\n${result.stderr}`,
  );
  assert.notEqual(result.stdout.trim(), '', 'runtime emitted no JSON bundle');

  try {
    return { bundle: JSON.parse(result.stdout), result };
  } catch (error) {
    assert.fail(`runtime stdout is not JSON: ${error.message}\n${result.stdout}`);
  }
}

function moduleIds(bundle) {
  return bundle.modules.map((module) => module.id);
}

function selectedIds(entries) {
  return entries.map((entry) => entry.id);
}

function intersectionInModuleOrder(bundle, candidates) {
  return moduleIds(bundle).filter((id) => candidates.has(id));
}

function renderBundleInstructions(bundle) {
  return `${bundle.prompts
    .map(
      (prompt, index) =>
        `## Nemo module ${index + 1}: ${prompt.name}\n` +
        `Role: ${prompt.role}\n` +
        `Identifier: ${prompt.id}\n\n` +
        prompt.content,
    )
    .join('\n\n')}\n`;
}

function assertPortableInstructionText(text, label = 'portable instructions') {
  assert.notEqual(text.trim(), '', `${label} is empty`);
  assert.doesNotMatch(
    text,
    /\{\{\s*(?:setvar|getvar|getglobalvar|addvar)::|\{\{\s*trim\s*}}|\{\{\/\//i,
    `${label} contains a raw SillyTavern macro`,
  );
  assert.doesNotMatch(
    text,
    /<\/?\s*(?:plan|planning|think|thinking|nemo-final|nemo-pad)\b/i,
    `${label} contains a hidden-control tag`,
  );
  assert.doesNotMatch(
    text,
    /<!--|-->|<\/?(?:html|head|body|style|script)\b[^>]*>|```(?:html|css|javascript|js)|\[\[\/?(?:tab|who|room|thread|deep|else)\b/i,
    `${label} contains renderer markup`,
  );
}

function readEmissionDirectory(directory) {
  const fileNames = readdirSync(directory).sort();
  const files = new Map(
    fileNames.map((fileName) => [fileName, readFileSync(path.join(directory, fileName))]),
  );
  const manifest = JSON.parse(files.get('instructions.manifest.json').toString('utf8'));
  const instructions = files.get('instructions.txt').toString('utf8');
  return { fileNames, files, manifest, instructions };
}

function assertEmissionDirectory(directory, bundle, directInstructions) {
  const emission = readEmissionDirectory(directory);
  const { manifest, instructions } = emission;

  assert.equal(manifest.schemaVersion, 'nemo-chatgpt-runtime-emission/v1');
  assert.equal(manifest.sourceSha256, bundle.source.sha256);
  assert.deepEqual(manifest.profile, bundle.profile);
  assert.equal(manifest.mode, 'portable');
  assert.deepEqual(manifest.selections, bundle.selections);
  assert.deepEqual(manifest.stats, bundle.stats);
  assert.deepEqual(
    manifest.orderedEmittedIds,
    bundle.prompts.map((prompt) => prompt.id),
  );
  assert.deepEqual(
    manifest.omittedModules,
    bundle.modules
      .filter((module) => module.emission !== 'portable')
      .map((module) => ({
        id: module.id,
        name: module.name,
        reason: module.emission,
      })),
  );

  assert.equal(instructions, directInstructions);
  assert.equal(instructions, renderBundleInstructions(bundle));
  assert.equal(manifest.instructionChars, Array.from(instructions).length);
  assert.equal(manifest.instructionBytes, Buffer.byteLength(instructions, 'utf8'));
  assert.equal(manifest.instructionSha256, sha256(Buffer.from(instructions, 'utf8')));
  assert.equal(manifest.chunkSizeChars, 24_000);
  assert.ok(manifest.chunks.length > 0);
  assert.ok(manifest.chunks.length <= 8);
  assertPortableInstructionText(instructions);

  const seenFiles = new Set();
  const chunkTexts = [];
  let expectedStart = 0;
  for (const [arrayIndex, chunk] of manifest.chunks.entries()) {
    assert.equal(chunk.index, arrayIndex + 1);
    assert.match(chunk.file, /^chunk-\d{3}\.txt$/);
    assert.equal(path.basename(chunk.file), chunk.file);
    assert.ok(!chunk.file.includes('..'));
    assert.doesNotMatch(chunk.file, /[\u0000-\u001f\u007f]/);
    assert.ok(!seenFiles.has(chunk.file), `duplicate chunk path ${chunk.file}`);
    seenFiles.add(chunk.file);
    assert.ok(emission.files.has(chunk.file), `missing ${chunk.file}`);

    const chunkText = emission.files.get(chunk.file).toString('utf8');
    const chars = Array.from(chunkText).length;
    assert.equal(chunk.start, expectedStart);
    assert.equal(chunk.chars, chars);
    assert.ok(chars > 0 && chars <= 24_000);
    assert.equal(chunk.end, chunk.start + chars);
    assert.equal(chunk.sha256, sha256(Buffer.from(chunkText, 'utf8')));
    assertPortableInstructionText(chunkText, chunk.file);
    chunkTexts.push(chunkText);
    expectedStart = chunk.end;
  }
  assert.equal(expectedStart, manifest.instructionChars);
  assert.equal(chunkTexts.join(''), instructions);

  const expectedFiles = [
    'instructions.manifest.json',
    'instructions.txt',
    ...manifest.chunks.map((chunk) => chunk.file),
  ].sort();
  assert.deepEqual(emission.fileNames, expectedFiles);
  return emission;
}

test('source fixture has the pinned byte hash and complete 11.5.2 counts', () => {
  assert.equal(sha256(sourceBytes), EXPECTED_SOURCE_SHA256);
  assert.equal(source.prompts.length, EXPECTED_SOURCE_PROMPTS);
  assert.equal(source.prompt_order.length, EXPECTED_SOURCE_PROFILES);
  assert.deepEqual(
    source.prompt_order.map((profile) => profile.order.length),
    [EXPECTED_SOURCE_PROMPTS, EXPECTED_SOURCE_PROMPTS],
  );
  assert.equal(source.extensions.regex_scripts.length, EXPECTED_SOURCE_REGEX_SCRIPTS);
});

test('Humiliation and JOI are complete disabled Fetish modules in every source profile', () => {
  const expectedHeadings = new Map([
    [
      IDS.humiliation,
      [
        '[LAW] Adult Consent Frame',
        '[DIRECTIVE] Fetish: Humiliation',
        '[DIRECTIVE] Addressed And Scenic Modes',
        '[DIRECTIVE] Anchor To Consequence',
        '[DIRECTIVE] Consequences In Action',
        '[DIRECTIVE] Intensity Calibration',
        '[DIRECTIVE] Stack Compatibility',
        '[BOUNDARY] Preserve User State And Localize The Target',
      ],
    ],
    [
      IDS.joi,
      [
        '[LAW] Adult Opt-In And Procedure Priority',
        '[LAW] User Owns Body And State',
        '[DIRECTIVE] Conversational State Machine',
        '[DIRECTIVE] One-Turn Instruction Loop',
        '[BOUNDARY] No Pretend Clock',
        '[BOUNDARY] Physical Safety',
        '[BOUNDARY] Clean Termination',
      ],
    ],
  ]);

  for (const [id, headings] of expectedHeadings) {
    const matchingPrompts = source.prompts.filter((prompt) => prompt.identifier === id);
    assert.equal(matchingPrompts.length, 1, `${id} must be unique in prompts[]`);
    const [prompt] = matchingPrompts;
    assert.equal(prompt.role, 'system');
    assert.equal(prompt.injection_position, 0);
    assert.equal(prompt.injection_depth, 4);
    assert.equal(prompt.injection_order, 100);
    assert.equal(prompt.system_prompt, false);
    assert.equal(prompt.marker, false);
    assert.equal(prompt.enabled, false);
    assert.equal(prompt.forbid_overrides, false);
    assert.deepEqual(prompt.injection_trigger, []);
    assert.equal(categoryOf(prompt), 'Fetish');
    assert.equal(isSectionHeader(prompt), false);
    assert.match(prompt.content, /@badge TOGGLE/);
    assert.match(prompt.content, /setvar::FetishName::/);
    for (const heading of headings) assert.ok(prompt.content.includes(heading), `${id}: ${heading}`);
  }

  for (const profile of source.prompt_order) {
    const orderIds = profile.order.map((entry) => entry.identifier);
    const petplayIndex = orderIds.indexOf(IDS.petplay);
    const humiliationIndex = orderIds.indexOf(IDS.humiliation);
    const joiIndex = orderIds.indexOf(IDS.joi);
    assert.ok(petplayIndex >= 0, `${profile.character_id}: Petplay missing`);
    assert.equal(humiliationIndex, petplayIndex + 1, `${profile.character_id}: Humiliation order`);
    assert.equal(joiIndex, humiliationIndex + 1, `${profile.character_id}: JOI order`);
    assert.equal(
      orderIds.filter((id) => id === IDS.humiliation).length,
      1,
      `${profile.character_id}: duplicate Humiliation order entry`,
    );
    assert.equal(
      orderIds.filter((id) => id === IDS.joi).length,
      1,
      `${profile.character_id}: duplicate JOI order entry`,
    );
    assert.equal(profile.order[humiliationIndex].enabled, false);
    assert.equal(profile.order[joiIndex].enabled, false);
    assert.equal(orderIds.at(-1), 'v11-classic-user-message-ender');
  }
});

test('default compilation reports its source exactly', () => {
  const { bundle } = invokeBundle();

  assert.equal(bundle.schemaVersion, 'nemo-chatgpt-runtime/v1');
  assert.equal(bundle.mode, 'portable');
  assert.deepEqual(bundle.profile, { characterId: 100001 });
  assert.equal(bundle.source.sha256, EXPECTED_SOURCE_SHA256);
  assert.equal(bundle.source.presetName, 'Nemo Engine v11.5.2');
  assert.equal(
    bundle.source.path,
    'Nemo Engine/Nemo Engine 11.5.2 - General RP.json',
  );
  assert.equal(bundle.stats.sourcePrompts, EXPECTED_SOURCE_PROMPTS);
  assert.equal(bundle.stats.sourceProfiles, EXPECTED_SOURCE_PROFILES);
  assert.equal(bundle.stats.sourceRegexScripts, EXPECTED_SOURCE_REGEX_SCRIPTS);
  assert.equal(bundle.stats.enabledPrompts, EXPECTED_DEFAULT_ENABLED_PROMPTS);
  assert.equal(bundle.modules.length, EXPECTED_DEFAULT_ENABLED_PROMPTS);
  assert.equal(bundle.stats.emittedPrompts, bundle.prompts.length);
  assert.equal(bundle.stats.emittedPrompts, EXPECTED_DEFAULT_PORTABLE_PROMPTS);
  const sourceModuleIds = new Set(bundle.modules.map((module) => module.id));
  const syntheticPromptIds = bundle.prompts
    .filter((prompt) => !sourceModuleIds.has(prompt.id))
    .map((prompt) => prompt.id);
  assert.deepEqual(syntheticPromptIds, ['nemo-portable-output-contract']);
  assert.equal(
    bundle.modules.filter((module) => module.emission === 'portable').length,
    bundle.stats.emittedPrompts - syntheticPromptIds.length,
  );
  assert.equal(bundle.compatibility.target, 'ChatGPT');
  assert.equal(bundle.compatibility.mode, 'portable');
  assert.ok(Array.isArray(bundle.compatibility.limitations));
});

test('portable mode emits only non-empty, macro-free operative content', () => {
  const { bundle } = invokeBundle();

  assert.equal(bundle.compatibility.mode, 'portable');
  assert.ok(bundle.prompts.length > 0);
  for (const prompt of bundle.prompts) {
    assert.equal(typeof prompt.content, 'string', `${prompt.id} has no portable content`);
    assert.notEqual(prompt.content.trim(), '', `${prompt.id} has empty portable content`);
    assert.ok(!Object.hasOwn(prompt, 'rawContent'), `${prompt.id} leaked rawContent`);
    assert.doesNotMatch(
      prompt.content,
      /\{\{\s*(?:setvar|getvar|getglobalvar|addvar)::|\{\{\s*trim\s*}}/i,
      `${prompt.id} contains a SillyTavern variable macro`,
    );
    assert.doesNotMatch(
      prompt.content,
      /\{\{\/\//,
      `${prompt.id} contains a source metadata comment`,
    );
    assert.doesNotMatch(
      prompt.content,
      /<\/?\s*(?:plan|planning|think|thinking|nemo-final|nemo-pad)\b/i,
      `${prompt.id} contains a hidden-control tag token`,
    );
  }
});

test('portable mode expands state-only modules into their operative consumer', () => {
  const { bundle } = invokeBundle();
  const narrationId = 'v11-030-narration-omega';
  const assemblerId = 'v11-010-core-assembler';
  const narrationModule = bundle.modules.find((module) => module.id === narrationId);
  const assembler = bundle.prompts.find((prompt) => prompt.id === assemblerId);

  assert.equal(narrationModule.emission, 'folded-state');
  assert.ok(!bundle.prompts.some((prompt) => prompt.id === narrationId));
  assert.ok(assembler, 'Core Assembler was not emitted');
  assert.match(assembler.content, /<Prose_Foundation>/);
  assert.match(assembler.content, /Physical Storytelling:/);
});

test('source mode preserves every selected source block byte-for-byte', () => {
  const { bundle } = invokeBundle(['--mode', 'source']);

  assert.equal(bundle.compatibility.mode, 'source');
  assert.equal(bundle.mode, 'source');
  assert.equal(bundle.stats.enabledPrompts, EXPECTED_DEFAULT_ENABLED_PROMPTS);
  assert.equal(bundle.stats.emittedPrompts, EXPECTED_DEFAULT_ENABLED_PROMPTS);
  assert.equal(bundle.modules.length, EXPECTED_DEFAULT_ENABLED_PROMPTS);
  assert.equal(bundle.prompts.length, EXPECTED_DEFAULT_ENABLED_PROMPTS);
  assert.deepEqual(
    bundle.prompts.map((prompt) => prompt.id),
    moduleIds(bundle),
    'source-mode prompt order must equal the selected module manifest order',
  );

  for (const prompt of bundle.prompts) {
    assert.ok(sourcePromptById.has(prompt.id), `unknown source prompt ${prompt.id}`);
    assert.equal(prompt.rawContent, sourcePromptById.get(prompt.id).content, prompt.id);
    assert.ok(!Object.hasOwn(prompt, 'content'), `${prompt.id} mixed source and portable fields`);
  }
  assert.match(
    bundle.prompts.map((prompt) => prompt.rawContent).join('\n'),
    /<\/?\s*(?:plan|planning|think|thinking|nemo-final|nemo-pad)\b/i,
    'source mode unexpectedly sanitized control-tag text',
  );
});

test('portable prompt payload is materially smaller than source mode', () => {
  const { bundle: portable } = invokeBundle();
  const { bundle: sourceBundle } = invokeBundle(['--mode', 'source']);
  const portableBytes = Buffer.byteLength(
    portable.prompts.map((prompt) => prompt.content).join('\n'),
    'utf8',
  );
  const sourceBytesInSelection = Buffer.byteLength(
    sourceBundle.prompts.map((prompt) => prompt.rawContent).join('\n'),
    'utf8',
  );

  assert.ok(portableBytes > 0);
  assert.ok(
    portableBytes <= sourceBytesInSelection * 0.8,
    `portable payload is ${portableBytes}/${sourceBytesInSelection} bytes; expected at least 20% reduction`,
  );
});

test('instructions-only output round-trips the bundle within an absolute budget', () => {
  const { bundle } = invokeBundle();
  const result = invokeRuntime(['--instructions-only']);
  const expectedText = renderBundleInstructions(bundle);
  const characters = Array.from(result.stdout).length;
  const bytes = Buffer.byteLength(result.stdout, 'utf8');
  const hash = sha256(Buffer.from(result.stdout, 'utf8'));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, expectedText);
  assert.equal(bundle.portableInstructions.mediaType, 'text/plain; charset=utf-8');
  assert.equal(bundle.portableInstructions.sha256, hash);
  assert.equal(bundle.portableInstructions.characters, characters);
  assert.equal(bundle.portableInstructions.bytes, bytes);
  assert.equal(bundle.portableInstructions.blockCount, bundle.prompts.length);
  assert.equal(bundle.stats.instructionChars, characters);
  assert.ok(
    characters <= MAX_DEFAULT_PORTABLE_CHARACTERS,
    `default portable instructions require ${characters} characters`,
  );
  assertPortableInstructionText(result.stdout);
});

test('emit-dir round-trips deterministic Unicode-safe chunks', async (t) => {
  const cases = [
    { name: 'default', args: [] },
    {
      name: 'Gooner plus CBT and NTR',
      args: [
        '--vex',
        'Gooner Vex',
        '--nsfw',
        'NSFW Core,Gooner Protocol',
        '--fetish',
        'CBT,NTR',
      ],
      expected: {
        vex: IDS.goonerVex,
        nsfw: [IDS.modernNsfwCore, IDS.goonerProtocol],
        fetish: [IDS.cbt, IDS.ntr],
        operative: [IDS.cbt, IDS.ntr],
      },
    },
    {
      name: 'full psychology, Humiliation, and JOI stack',
      args: [
        '--enable',
        IDS.manipulationRealism,
        '--enable',
        IDS.psychologicalRealism,
        '--vex',
        IDS.goonerVex,
        '--nsfw',
        `${IDS.modernNsfwCore},${IDS.goonerProtocol}`,
        '--fetish',
        `${IDS.femdom},${IDS.ntr},${IDS.humiliation},${IDS.joi}`,
      ],
      expected: {
        vex: IDS.goonerVex,
        nsfw: [IDS.modernNsfwCore, IDS.goonerProtocol],
        fetish: [IDS.femdom, IDS.ntr, IDS.humiliation, IDS.joi],
        operative: [
          IDS.manipulationRealism,
          IDS.psychologicalRealism,
          IDS.humiliation,
          IDS.joi,
        ],
      },
    },
    {
      name: 'ready Psychology Humiliation JOI preset',
      args: ['--preset', psychologyHumiliationJoiReadyPath],
      expected: {
        vex: IDS.narrativeVex,
        nsfw: [IDS.modernNsfwCore, IDS.dirtyTalk, IDS.domLanguage],
        fetish: [IDS.humiliation, IDS.joi],
        operative: [
          IDS.manipulationRealism,
          IDS.psychologicalRealism,
          IDS.humiliation,
          IDS.joi,
        ],
        enabledPrompts: 115,
      },
    },
  ];

  for (const sample of cases) {
    await t.test(sample.name, () => {
      const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'nemo-emission-test-'));
      const firstDirectory = path.join(temporaryRoot, 'first');
      const secondDirectory = path.join(temporaryRoot, 'second');

      try {
        const { bundle } = invokeBundle(sample.args);
        const direct = invokeRuntime([...sample.args, '--instructions-only']);
        assert.equal(direct.status, 0, direct.stderr);

        const firstRun = invokeRuntime([...sample.args, '--emit-dir', firstDirectory]);
        assert.equal(firstRun.status, 0, firstRun.stderr);
        assert.equal(firstRun.stdout, '');
        const first = assertEmissionDirectory(firstDirectory, bundle, direct.stdout);

        const secondRun = invokeRuntime([...sample.args, '--emit-dir', secondDirectory]);
        assert.equal(secondRun.status, 0, secondRun.stderr);
        assert.equal(secondRun.stdout, '');
        const second = assertEmissionDirectory(secondDirectory, bundle, direct.stdout);

        assert.deepEqual(second.fileNames, first.fileNames);
        for (const fileName of first.fileNames) {
          assert.ok(
            second.files.get(fileName).equals(first.files.get(fileName)),
            `${fileName} changed across identical fresh-dir emissions`,
          );
        }

        if (sample.expected) {
          assert.equal(bundle.selections.vex.id, sample.expected.vex);
          assert.deepEqual(selectedIds(bundle.selections.nsfw), sample.expected.nsfw);
          assert.deepEqual(selectedIds(bundle.selections.fetish), sample.expected.fetish);
          if (sample.expected.enabledPrompts !== undefined) {
            assert.equal(bundle.stats.enabledPrompts, sample.expected.enabledPrompts);
          }
          const omittedIds = new Set(first.manifest.omittedModules.map((module) => module.id));
          for (const id of sample.expected.operative) {
            assert.ok(first.manifest.orderedEmittedIds.includes(id), `${id} was not emitted`);
            assert.ok(!omittedIds.has(id), `${id} was incorrectly omitted`);
          }
          assert.ok(bundle.stats.instructionChars <= MAX_DEFAULT_PORTABLE_CHARACTERS);
        }
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    });
  }
});

test('emit-dir rejects incompatible modes and size overflow before writing', async (t) => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'nemo-emission-fail-test-'));
  const cases = [
    {
      name: 'portable size overflow',
      args: ['--max-portable-chars', '1000'],
      error: /Portable instructions require .* above the --max-portable-chars limit/i,
    },
    {
      name: 'source mode',
      args: ['--mode', 'source'],
      error: /--emit-dir requires --mode portable/i,
    },
    {
      name: 'out conflict',
      args: ['--out', path.join(temporaryRoot, 'other.txt')],
      error: /--emit-dir cannot be combined with --out/i,
    },
    {
      name: 'instructions-only conflict',
      args: ['--instructions-only'],
      error: /--emit-dir cannot be combined with --instructions-only/i,
    },
  ];

  try {
    for (const [index, sample] of cases.entries()) {
      await t.test(sample.name, () => {
        const target = path.join(temporaryRoot, `target-${index}`);
        const result = invokeRuntime([...sample.args, '--emit-dir', target]);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /^Error:/);
        assert.match(result.stderr, sample.error);
        assert.equal(existsSync(target), false, 'failed emission created its target directory');
      });
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('portable macro resolution exposes stable semantic placeholders and bindings', () => {
  const { bundle } = invokeBundle();
  const resolution = bundle.diagnostics.macroResolution;
  const content = bundle.prompts.map((prompt) => prompt.content).join('\n');

  assert.equal(typeof resolution, 'object');
  assert.equal(typeof resolution.counts, 'object');
  for (const key of [
    'commentsStripped',
    'setvar',
    'addvar',
    'getvar',
    'trim',
    'contextSubstitutions',
    'dynamicFallbacks',
  ]) {
    assert.equal(Number.isInteger(resolution.counts[key]), true, key);
    assert.ok(resolution.counts[key] >= 0, key);
  }
  assert.ok(resolution.counts.commentsStripped > 0);
  assert.ok(resolution.counts.setvar > 0);
  assert.ok(resolution.counts.getvar > 0);
  assert.ok(Array.isArray(resolution.unresolved));
  assert.ok(Array.isArray(resolution.semanticContextSlots));
  assert.ok(resolution.semanticContextSlots.length > 0);

  for (const slot of resolution.semanticContextSlots) {
    assert.equal(typeof slot.macro, 'string');
    assert.match(slot.placeholder, /^\[[A-Z][A-Z_]*]$/);
    assert.equal(slot.provided, false);
    assert.ok(Number.isInteger(slot.occurrences) && slot.occurrences > 0);
    assert.ok(
      content.includes(slot.placeholder),
      `${slot.placeholder} is declared but absent from portable prompts`,
    );
  }

  const userSlot = resolution.semanticContextSlots.find((slot) => slot.macro === 'user');
  assert.deepEqual(userSlot, {
    macro: 'user',
    placeholder: '[USER]',
    provided: false,
    occurrences: userSlot?.occurrences,
  });
  assert.ok(userSlot.occurrences > 0);
});

test('provided semantic context replaces placeholders and is reported explicitly', () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'nemo-context-test-'));
  const contextPath = path.join(temporaryDirectory, 'context.json');
  const userBinding = 'RUNTIME_USER_BINDING_7821';
  const characterBinding = 'RUNTIME_CHARACTER_BINDING_7821';
  writeFileSync(
    contextPath,
    `${JSON.stringify({ macros: { user: userBinding, char: characterBinding } })}\n`,
    'utf8',
  );

  try {
    const { bundle } = invokeBundle(['--context', contextPath]);
    const content = bundle.prompts.map((prompt) => prompt.content).join('\n');
    const slots = bundle.diagnostics.macroResolution.semanticContextSlots;
    const userSlot = slots.find((slot) => slot.macro === 'user');
    const characterSlot = slots.find((slot) => slot.macro === 'char');

    assert.ok(content.includes(userBinding));
    assert.ok(content.includes(characterBinding));
    assert.ok(!content.includes('[USER]'));
    assert.ok(!content.includes('[CHARACTER]'));
    assert.equal(userSlot.provided, true);
    assert.equal(characterSlot.provided, true);
    assert.ok(userSlot.occurrences > 0);
    assert.ok(characterSlot.occurrences > 0);
    assert.ok(bundle.diagnostics.macroResolution.counts.contextSubstitutions > 0);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('default repairs the shipped Vex conflict to Narrative Vex only', () => {
  const { bundle } = invokeBundle();
  const activeVexIds = intersectionInModuleOrder(bundle, vexPersonaIds);

  assert.deepEqual(bundle.selections.vex, {
    id: IDS.narrativeVex,
    name: '🎭 Narrative Vex',
  });
  assert.deepEqual(activeVexIds, [IDS.narrativeVex]);
  assert.ok(moduleIds(bundle).includes(IDS.narrativeVex));
  assert.ok(!moduleIds(bundle).includes(IDS.haarVex));
  assert.equal(bundle.diagnostics.repairs.length, 1);
  assert.equal(bundle.diagnostics.repairs[0].code, 'GENERAL_PROFILE_VEX_CONFLICT');
  assert.equal(bundle.diagnostics.repairs[0].disabled.id, IDS.haarVex);
  assert.equal(bundle.diagnostics.repairs[0].kept.id, IDS.narrativeVex);
});

test('portable baseline preserves the profile difficulty instead of rewriting it', () => {
  const { bundle } = invokeBundle();
  const ids = moduleIds(bundle);

  assert.equal(sourcePromptById.get(IDS.heroicDifficulty).enabled, false);
  assert.equal(sourcePromptById.get(IDS.balancedDifficulty).enabled, true);
  assert.ok(ids.includes(IDS.heroicDifficulty));
  assert.ok(!ids.includes(IDS.balancedDifficulty));
  assert.equal(bundle.diagnostics.repairs.length, 1);
  assert.equal(bundle.diagnostics.repairs[0].code, 'GENERAL_PROFILE_VEX_CONFLICT');
});

test('portable baseline drops empty scratchpad resolvers and unsafe OOC HTML advice', () => {
  const { bundle } = invokeBundle();
  const omittedStateIds = ['nemo_pad_consequence', 'nemo-pad-loader-resolver'];
  const promptIds = new Set(bundle.prompts.map((prompt) => prompt.id));

  for (const id of omittedStateIds) {
    const module = bundle.modules.find((candidate) => candidate.id === id);
    assert.ok(module, `missing baseline module ${id}`);
    assert.equal(module.emission, 'omitted-state-only');
    assert.ok(!promptIds.has(id), `${id} became a fallback-only prompt`);
  }

  const oocResolver = bundle.prompts.find(
    (prompt) => prompt.id === 'v11-635-utility-ooc-resolver',
  );
  assert.ok(oocResolver, 'baseline OOC Resolver was not emitted');
  assert.doesNotMatch(oocResolver.content, /Use HTML font tags/i);
  assert.doesNotMatch(oocResolver.content, /<\/?font\b/i);
});

test('folded-state classification requires an observable emitted consumer', () => {
  const { bundle: baseline } = invokeBundle();
  const { bundle: withoutVariableInit } = invokeBundle([
    '--disable',
    IDS.variableInit,
  ]);
  const module = baseline.modules.find(
    (candidate) => candidate.id === IDS.variableInit,
  );
  const emittedPayload = (bundle) =>
    bundle.prompts.map(({ id, role, content }) => ({ id, role, content }));
  const changesEmittedPayload =
    JSON.stringify(emittedPayload(baseline)) !==
    JSON.stringify(emittedPayload(withoutVariableInit));

  assert.ok(module, 'default profile omitted Variable Init from its manifest');
  assert.ok(
    module.emission !== 'folded-state' || changesEmittedPayload,
    'Variable Init claims folded-state even though disabling it changes no emitted content',
  );
  if (!changesEmittedPayload) {
    assert.equal(module.emission, 'omitted-state-only');
  }
});

test('module inventory exposes all source prompts as addressable selectors', () => {
  const { bundle: inventory } = invokeBundle(['--list', 'modules']);
  const expectedIds = source.prompts.map((prompt) => prompt.identifier);

  assert.equal(inventory.schemaVersion, 'nemo-chatgpt-runtime/v1/inventory');
  assert.equal(inventory.modules.length, EXPECTED_SOURCE_PROMPTS);
  assert.deepEqual(
    inventory.modules.map((module) => module.id),
    expectedIds,
  );
  assert.equal(
    new Set(inventory.modules.map((module) => module.id)).size,
    EXPECTED_SOURCE_PROMPTS,
  );
  for (const [index, module] of inventory.modules.entries()) {
    assert.equal(module.sourceIndex, index);
    assert.equal(Number.isInteger(module.profileOrderIndex), true, module.id);
    assert.equal(typeof module.profileEnabled, 'boolean', module.id);
    assert.equal(typeof module.enabled, 'boolean', module.id);
    assert.equal(typeof module.name, 'string', module.id);
    assert.equal(typeof module.kind, 'string', module.id);
  }
});

test(
  'every source module survives real CLI enable and disable paths',
  { timeout: 180_000 },
  () => {
    const { bundle: baseline } = invokeBundle();
    const activeByExclusiveGroup = new Map();
    for (const module of baseline.modules) {
      if (!module.exclusiveGroup) continue;
      if (!activeByExclusiveGroup.has(module.exclusiveGroup)) {
        activeByExclusiveGroup.set(module.exclusiveGroup, []);
      }
      activeByExclusiveGroup.get(module.exclusiveGroup).push(module.id);
    }
    const allowedEmissions = new Set([
      'portable',
      'folded-state',
      'omitted-state-only',
      'omitted-section-header',
      'omitted-host-marker',
    ]);

    for (const prompt of source.prompts) {
      const group = exclusiveGroupOf(prompt);
      const activePeers = (activeByExclusiveGroup.get(group) ?? []).filter(
        (id) => id !== prompt.identifier,
      );
      const enableArgs = [];
      if (activePeers.length > 0) {
        enableArgs.push('--disable', activePeers.join(','));
      }
      enableArgs.push('--enable', prompt.identifier);

      let enabled;
      try {
        ({ bundle: enabled } = invokeBundle(enableArgs));
      } catch (error) {
        throw new Error(
          `enable path failed for ${prompt.name} (${prompt.identifier}): ${error.message}`,
          { cause: error },
        );
      }
      const enabledModule = enabled.modules.find(
        (module) => module.id === prompt.identifier,
      );
      assert.ok(enabledModule, `enable manifest omitted ${prompt.identifier}`);
      assert.ok(
        allowedEmissions.has(enabledModule.emission),
        `${prompt.identifier} has unexplained emission ${enabledModule.emission}`,
      );
      assert.ok(
        enabled.selections.overrides.enabled.some(
          (selection) => selection.id === prompt.identifier,
        ),
        `enable override manifest omitted ${prompt.identifier}`,
      );
      assertPortableInstructionText(
        renderBundleInstructions(enabled),
        `enabled module ${prompt.identifier}`,
      );

      const disableArgs = ['--disable', prompt.identifier];
      if (prompt.identifier === IDS.narrativeVex) {
        disableArgs.push('--enable', IDS.haarVex);
      }
      let disabled;
      try {
        ({ bundle: disabled } = invokeBundle(disableArgs));
      } catch (error) {
        throw new Error(
          `disable path failed for ${prompt.name} (${prompt.identifier}): ${error.message}`,
          { cause: error },
        );
      }
      assert.ok(
        !disabled.modules.some((module) => module.id === prompt.identifier),
        `disable path retained ${prompt.identifier}`,
      );
      assert.ok(
        disabled.selections.overrides.disabled.some(
          (selection) => selection.id === prompt.identifier,
        ),
        `disable override manifest omitted ${prompt.identifier}`,
      );
    }
  },
);

test('ambiguous generic names fail instead of selecting a module by guess', async (t) => {
  for (const selector of ['AO3 Style', 'Erotica']) {
    await t.test(selector, () => {
      const result = invokeRuntime(['--enable', selector]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^Error: Ambiguous --enable module selector/);
      assert.match(result.stderr, /Use an identifier\./);
      assert.match(result.stderr, new RegExp(selector));
    });
  }
});

test('default enables only the modern NSFW core and no Gooner or fetish module', () => {
  const { bundle } = invokeBundle();
  const ids = moduleIds(bundle);

  assert.deepEqual(selectedIds(bundle.selections.nsfw), [IDS.modernNsfwCore]);
  assert.deepEqual(bundle.selections.fetish, []);
  assert.deepEqual(intersectionInModuleOrder(bundle, nsfwIds), [IDS.modernNsfwCore]);
  assert.deepEqual(intersectionInModuleOrder(bundle, fetishIds), []);
  assert.deepEqual(intersectionInModuleOrder(bundle, goonerIds), []);
  assert.ok(ids.includes(IDS.modernNsfwCore));
});

test('the largest single adult module compiles as the Classic NSFW core', () => {
  const { bundle } = invokeBundle(['--nsfw', IDS.classicNsfwCore]);

  assert.deepEqual(selectedIds(bundle.selections.nsfw), [IDS.classicNsfwCore]);
  assert.ok(moduleIds(bundle).includes(IDS.classicNsfwCore));
  assert.ok(!moduleIds(bundle).includes(IDS.modernNsfwCore));
  assert.ok(bundle.stats.instructionChars <= MAX_DEFAULT_PORTABLE_CHARACTERS);
  assertPortableInstructionText(renderBundleInstructions(bundle), 'Classic NSFW runtime');
});

test('selecting Gooner Vex replaces every other Vex personality', () => {
  const { bundle } = invokeBundle(['--vex', 'Gooner Vex']);

  assert.equal(bundle.selections.vex.id, IDS.goonerVex);
  assert.equal(bundle.selections.vex.name, '🎭 Gooner Vex');
  assert.deepEqual(intersectionInModuleOrder(bundle, vexPersonaIds), [IDS.goonerVex]);
  assert.ok(!moduleIds(bundle).includes(IDS.narrativeVex));
  assert.ok(!moduleIds(bundle).includes(IDS.haarVex));
  assert.ok(!moduleIds(bundle).includes(IDS.goonGremlinVex));
});

test('selecting Goon Gremlin Vex also replaces every other Vex personality', () => {
  const { bundle } = invokeBundle(['--vex', 'Goon Gremlin Vex']);

  assert.equal(bundle.selections.vex.id, IDS.goonGremlinVex);
  assert.deepEqual(intersectionInModuleOrder(bundle, vexPersonaIds), [IDS.goonGremlinVex]);
});

test('generic overrides cannot leave the runtime without a Vex personality', () => {
  const result = invokeRuntime(['--disable', IDS.narrativeVex]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Error:/);
  assert.match(result.stderr, /Vex/i);
});

test('selected NSFW and fetish modules are exact and profile ordered', () => {
  const { bundle } = invokeBundle([
    '--nsfw',
    'Gooner Protocol',
    '--fetish',
    'CBT,NTR',
  ]);

  assert.deepEqual(selectedIds(bundle.selections.nsfw), [IDS.goonerProtocol]);
  assert.deepEqual(selectedIds(bundle.selections.fetish), [IDS.cbt, IDS.ntr]);
  assert.deepEqual(intersectionInModuleOrder(bundle, nsfwIds), [IDS.goonerProtocol]);
  assert.deepEqual(intersectionInModuleOrder(bundle, fetishIds), [IDS.cbt, IDS.ntr]);
  assert.ok(!moduleIds(bundle).includes(IDS.modernNsfwCore));
  assert.ok(!moduleIds(bundle).includes(IDS.goonerSlop));
  assert.ok(!moduleIds(bundle).includes(IDS.goonerMasterpiece));
});

test('Fetish inventory exposes Humiliation and JOI as disabled exact selectors', () => {
  const { bundle: inventory } = invokeBundle(['--list', 'fetish']);
  const entries = inventory.families.fetish;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  assert.equal(inventory.schemaVersion, 'nemo-chatgpt-runtime/v1/inventory');
  assert.equal(entries.length, EXPECTED_FETISH_PROMPTS);
  assert.deepEqual(byId.get(IDS.humiliation), {
    id: IDS.humiliation,
    name: '🎀 Humiliation',
    profileEnabled: false,
    enabled: false,
  });
  assert.deepEqual(byId.get(IDS.joi), {
    id: IDS.joi,
    name: '🎀 JOI',
    profileEnabled: false,
    enabled: false,
  });
});

test('Humiliation and JOI resolve identically by exact name and identifier', () => {
  const byName = invokeRuntime(['--fetish', 'Humiliation,JOI', '--pretty']);
  const byIdentifier = invokeRuntime([
    '--fetish',
    `${IDS.humiliation},${IDS.joi}`,
    '--pretty',
  ]);

  assert.equal(byName.status, 0, byName.stderr);
  assert.equal(byIdentifier.status, 0, byIdentifier.stderr);
  assert.equal(byName.stderr, '');
  assert.equal(byIdentifier.stderr, '');
  assert.equal(byIdentifier.stdout, byName.stdout);

  const bundle = JSON.parse(byName.stdout);
  assert.deepEqual(selectedIds(bundle.selections.fetish), [IDS.humiliation, IDS.joi]);
  for (const id of [IDS.humiliation, IDS.joi]) {
    assert.equal(bundle.modules.find((module) => module.id === id)?.emission, 'portable');
    assert.ok(bundle.prompts.some((prompt) => prompt.id === id), `${id} was not emitted`);
  }
  const joiPrompt = bundle.prompts.find((prompt) => prompt.id === IDS.joi);
  assert.doesNotMatch(joiPrompt.content, /<\/?joi-state\b|\[\[\/?joi-state\b/i);
  assertPortableInstructionText(renderBundleInstructions(bundle), 'Humiliation + JOI runtime');
});

test('psychology, Gooner, Humiliation, JOI, Femdom, and NTR compile as one exact stack', () => {
  const { bundle } = invokeBundle([
    '--enable',
    IDS.manipulationRealism,
    '--enable',
    IDS.psychologicalRealism,
    '--vex',
    IDS.goonerVex,
    '--nsfw',
    `${IDS.modernNsfwCore},${IDS.goonerProtocol}`,
    '--fetish',
    `${IDS.femdom},${IDS.ntr},${IDS.humiliation},${IDS.joi}`,
  ]);
  const requestedOperativeIds = [
    IDS.manipulationRealism,
    IDS.psychologicalRealism,
    IDS.humiliation,
    IDS.joi,
  ];

  assert.equal(bundle.selections.vex.id, IDS.goonerVex);
  assert.deepEqual(selectedIds(bundle.selections.nsfw), [
    IDS.modernNsfwCore,
    IDS.goonerProtocol,
  ]);
  assert.deepEqual(selectedIds(bundle.selections.fetish), [
    IDS.femdom,
    IDS.ntr,
    IDS.humiliation,
    IDS.joi,
  ]);
  assert.deepEqual(
    selectedIds(bundle.selections.overrides.enabled),
    [IDS.manipulationRealism, IDS.psychologicalRealism],
  );
  for (const id of requestedOperativeIds) {
    assert.equal(bundle.modules.find((module) => module.id === id)?.emission, 'portable');
    assert.ok(bundle.prompts.some((prompt) => prompt.id === id), `${id} was not emitted`);
  }
  assert.ok(bundle.stats.instructionChars <= MAX_DEFAULT_PORTABLE_CHARACTERS);
  assertPortableInstructionText(renderBundleInstructions(bundle), 'full psychology/adult stack');
});

test('UI-dependent fetish modules degrade to safe plain text in portable mode', async (t) => {
  const cases = [
    ['Dating Sim (Quantum)', IDS.datingSim],
    ['Corruption (Fefnik)', IDS.corruption],
    ['Forced Fem (Classic)', IDS.forcedFemClassic],
    ['Harmonized HTML Enable (fefnik)', IDS.harmonizedHtml],
  ];
  const rawHtmlTag =
    /<\/?(?:html|head|body|style|script|div|span|details|summary|table|tr|td|th|h[1-6]|strong|em|hr|p|ul|ol|li|br)\b[^>]*>/i;
  const trackerDsl = /\[\[\/?(?:tab|who|room|thread|deep|else)\b/i;

  for (const [name, id] of cases) {
    await t.test(name, () => {
      const { bundle } = invokeBundle(['--fetish', id]);
      const prompt = bundle.prompts.find((candidate) => candidate.id === id);
      const degradation = bundle.diagnostics.portableTransforms.find(
        (entry) => entry.code === 'PORTABLE_UI_DEGRADED',
      );
      const warning = bundle.diagnostics.warnings.find(
        (entry) => entry.code === 'PORTABLE_UI_DEGRADED',
      );

      assert.deepEqual(selectedIds(bundle.selections.fetish), [id]);
      assert.ok(prompt, `${name} was selected but not emitted`);
      assert.ok(degradation?.moduleIds.includes(id), `${name} lacks transform diagnostics`);
      assert.ok(warning?.promptIds.includes(id), `${name} lacks degradation warning`);
      assert.doesNotMatch(prompt.content, rawHtmlTag);
      assert.doesNotMatch(prompt.content, /<!--|-->/);
      assert.doesNotMatch(prompt.content, /```(?:html|css|javascript|js)?/i);
      assert.doesNotMatch(prompt.content, trackerDsl);
      assert.doesNotMatch(prompt.content, /(?:^|\n)\s*OOC\s*:/i);

      const withoutNegativeGuards = prompt.content.replace(
        /\b(?:do not|never)\b[^.\n]*(?:HTML|CSS|JavaScript|code\s*block|tracker DSL)[^.\n]*[.\n]?/gi,
        '',
      );
      assert.doesNotMatch(
        withoutNegativeGuards,
        /\b(?:generate|render|output|emit|wrap|write|create)\b[^.\n]{0,100}\b(?:HTML|CSS|JavaScript|code\s*block)\b/i,
      );
      assert.doesNotMatch(
        withoutNegativeGuards,
        /\b(?:must|required|mandated|non-negotiable|always)\b[^.\n]{0,140}\b(?:HTML|CSS|JavaScript|code\s*block)\b/i,
      );
      assert.doesNotMatch(
        withoutNegativeGuards,
        /\b(?:always\s+wrap|start\s+with|end\s+with|opening\s+tag|closing\s+tag|inside\s+(?:a|one|the)\s+[^.\n]{0,40}\bblock)\b/i,
      );
    });
  }
});

test('every Fetish module is individually selectable by its exact identifier', async (t) => {
  assert.equal(fetishIds.size, EXPECTED_FETISH_PROMPTS);
  for (const id of fetishIds) {
    await t.test(id, () => {
      const { bundle } = invokeBundle(['--fetish', id]);
      assert.deepEqual(selectedIds(bundle.selections.fetish), [id]);
      assert.deepEqual(intersectionInModuleOrder(bundle, fetishIds), [id]);
    });
  }
});

test('literal none clears optional NSFW and fetish categories', () => {
  const { bundle } = invokeBundle(['--nsfw', 'none', '--fetish', 'none']);

  assert.deepEqual(bundle.selections.nsfw, []);
  assert.deepEqual(bundle.selections.fetish, []);
  assert.deepEqual(intersectionInModuleOrder(bundle, nsfwIds), []);
  assert.deepEqual(intersectionInModuleOrder(bundle, fetishIds), []);
});

test('the full non-conflicting adult inventory fails the absolute portable budget', () => {
  const compatibleNsfwIds = [...nsfwIds].filter(
    (id) => id !== IDS.classicNsfwCore,
  );
  const result = invokeRuntime([
    '--nsfw',
    compatibleNsfwIds.join(','),
    '--fetish',
    [...fetishIds].join(','),
  ]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Error:/);
  assert.match(result.stderr, /Portable instructions require \d+ characters/);
  assert.match(result.stderr, /--max-portable-chars limit of 170000/);
});

test('all Scratchpad-Tabs modules compile through the portable adapter', async (t) => {
  const scratchpadIds = source.prompts
    .filter((prompt) => categoryOf(prompt) === 'Scratchpad-Tabs')
    .map((prompt) => prompt.identifier);
  assert.equal(scratchpadIds.length, 13);

  for (const id of scratchpadIds) {
    await t.test(id, () => {
      const { bundle } = invokeBundle(['--enable', id]);
      const module = bundle.modules.find((candidate) => candidate.id === id);

      assert.ok(module, `${id} missing from selected module manifest`);
      assert.ok(
        [
          'portable',
          'folded-state',
          'omitted-state-only',
          'omitted-section-header',
          'omitted-host-marker',
        ].includes(module.emission),
        `${id} has unexplained emission status ${module.emission}`,
      );
      assert.ok(
        bundle.selections.overrides.enabled.some((selection) => selection.id === id),
      );
      assertPortableInstructionText(
        renderBundleInstructions(bundle),
        `Scratchpad runtime ${id}`,
      );
    });
  }
});

test('generic overrides enable and disable exact non-family modules', () => {
  const { bundle } = invokeBundle([
    '--enable',
    'Character Friction',
    '--disable',
    IDS.moreDialogue,
  ]);
  const ids = moduleIds(bundle);

  assert.ok(ids.includes(IDS.characterFriction));
  assert.ok(!ids.includes(IDS.moreDialogue));
  assert.deepEqual(bundle.selections.overrides, {
    enabled: [
      {
        id: IDS.characterFriction,
        name: '🗡️ Character Friction',
      },
    ],
    disabled: [
      {
        id: IDS.moreDialogue,
        name: '🛠️ More Dialogue',
      },
    ],
  });
  assert.equal(bundle.stats.enabledPrompts, EXPECTED_DEFAULT_ENABLED_PROMPTS);
  assert.equal(bundle.stats.emittedPrompts, bundle.prompts.length);
  assert.equal(bundle.selections.vex.id, IDS.narrativeVex);
  assert.deepEqual(selectedIds(bundle.selections.nsfw), [IDS.modernNsfwCore]);
  assert.deepEqual(bundle.selections.fetish, []);
});

test('unknown generic override selector fails closed', () => {
  const unknown = 'definitely-not-a-real-module';
  const result = invokeRuntime(['--enable', unknown]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Error:/);
  assert.match(result.stderr, new RegExp(unknown));
});

test('generic enable cannot create a mutual-exclusive conflict', () => {
  const result = invokeRuntime(['--enable', IDS.hentaiWorldLogic]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Error:/);
  assert.match(result.stderr, /(?:mutual|exclusive|conflict)/i);
  assert.match(result.stderr, /Hentai/i);
  assert.match(result.stderr, /Anime/i);
});

test('unknown selectors fail closed with a useful error', async (t) => {
  const cases = [
    ['--vex', 'definitely-not-a-vex'],
    ['--nsfw', 'definitely-not-an-nsfw-module'],
    ['--fetish', 'definitely-not-a-fetish'],
  ];

  for (const args of cases) {
    await t.test(args[0], () => {
      const result = invokeRuntime(args);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^Error:/);
      assert.match(result.stderr, new RegExp(args[1]));
    });
  }
});

test('duplicate and mutually exclusive family selections fail closed', async (t) => {
  const cases = [
    {
      name: 'duplicate fetish',
      args: ['--fetish', 'CBT,CBT'],
      error: /Duplicate Fetish selection/i,
    },
    {
      name: 'duplicate JOI',
      args: ['--fetish', 'JOI,JOI'],
      error: /Duplicate Fetish selection.*JOI/i,
    },
    {
      name: 'none combined with JOI',
      args: ['--fetish', 'none,JOI'],
      error: /Fetish selector "none" cannot be combined/i,
    },
    {
      name: 'modern and classic NSFW cores',
      args: ['--nsfw', 'NSFW Core,NSFW Core (Classic) [V6]'],
      error: /Mutual-exclusive selection conflict.*NSFW-Core/i,
    },
  ];

  for (const sample of cases) {
    await t.test(sample.name, () => {
      const result = invokeRuntime(sample.args);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^Error:/);
      assert.match(result.stderr, sample.error);
    });
  }
});

test('JOI aliases and contradictory generic overrides fail closed', async (t) => {
  const cases = [
    {
      name: 'unsupported Orgasm Control alias',
      args: ['--fetish', 'Orgasm Control'],
      error: /Unknown Fetish selector.*Orgasm Control/i,
    },
    {
      name: 'same JOI module enabled and disabled',
      args: ['--enable', IDS.joi, '--disable', IDS.joi],
      error: /same module cannot be passed to both --enable and --disable.*JOI/i,
    },
  ];

  for (const sample of cases) {
    await t.test(sample.name, () => {
      const result = invokeRuntime(sample.args);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^Error:/);
      assert.match(result.stderr, sample.error);
    });
  }
});

test('compilation never mutates the authoritative preset', () => {
  const before = readFileSync(sourcePath);

  invokeBundle(['--vex', 'Gooner Vex', '--nsfw', 'Gooner Protocol']);
  invokeBundle(['--fetish', 'CBT,NTR', '--pretty']);
  invokeBundle([
    '--enable',
    IDS.characterFriction,
    '--disable',
    IDS.moreDialogue,
  ]);
  const listing = invokeRuntime(['--list', 'all']);
  assert.equal(listing.status, 0, listing.stderr);

  const after = readFileSync(sourcePath);
  assert.deepEqual(after, before);
  assert.equal(sha256(after), EXPECTED_SOURCE_SHA256);
});

test('output sanitizer removes internal blocks and preserves final prose', async (t) => {
  const cases = [
    {
      name: 'closed internal blocks and closed final wrapper',
      input:
        '<plan>private plan</plan>\n' +
        '<think>private reasoning</think>\n' +
        '<service>private service data</service>\n' +
        '<nemo-final>Visible prose.</nemo-final>',
      expected: 'Visible prose.\n',
    },
    {
      name: 'unclosed final wrapper',
      input: '<nemo-final>Unclosed final prose survives.',
      expected: 'Unclosed final prose survives.\n',
    },
  ];

  for (const sample of cases) {
    await t.test(sample.name, () => {
      const result = invokeRuntime(['--sanitize-output', '-'], {
        input: sample.input,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, sample.expected);
      assert.doesNotMatch(result.stdout, /<\/?(?:plan|planning|think|thinking|service|nemo-final)\b/i);
    });
  }
});

test('output sanitizer supports a file input path', () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'nemo-sanitize-test-'));
  const inputPath = path.join(temporaryDirectory, 'model-output.txt');
  writeFileSync(
    inputPath,
    '<planning>remove me</planning>\nPublic answer remains.\n',
    'utf8',
  );

  try {
    const result = invokeRuntime(['--sanitize-output', inputPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'Public answer remains.\n');
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('output sanitizer unwraps public scene and tab DSL without leaking markers', async (t) => {
  const cases = [
    {
      name: 'scene wrapper',
      input: '<scene>Rain fell.\nShe left.</scene>',
      expected: 'Rain fell.\nShe left.\n',
    },
    {
      name: 'tab wrapper',
      input: 'Before.\n[[tab Status|blue]]Visible details.[[/tab]]\nAfter.',
      expected: 'Before.\nStatus\nVisible details.\nAfter.\n',
    },
  ];

  for (const sample of cases) {
    await t.test(sample.name, () => {
      const result = invokeRuntime(['--sanitize-output', '-'], { input: sample.input });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, sample.expected);
      assert.doesNotMatch(result.stdout, /<\/?scene\b|\[\[\/?tab\b/i);
    });
  }
});

test('output sanitizer removes runtime, language, and service scaffolding', () => {
  const input =
    '(OOC: internal setup that must not reach the reader)\n' +
    '<runtime_settings_reminder>runtime secret</runtime_settings_reminder>\n' +
    '<language_runtime>language secret</language_runtime>\n' +
    '<language_runtime_resolver>resolver secret</language_runtime_resolver>\n' +
    '<service>service secret</service>\n' +
    '<nemo-final>Public prose.</nemo-final>';
  const result = invokeRuntime(['--sanitize-output', '-'], { input });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'Public prose.\n');
  assert.doesNotMatch(result.stdout, /^\s*\(OOC:/i);
  assert.doesNotMatch(
    result.stdout,
    /runtime_settings_reminder|language_runtime(?:_resolver)?|<\/?service\b/i,
  );
});

test('output sanitizer preserves public JOI controls without treating them as service data', () => {
  const input = 'Pause now. Say "resume" to start again, or "stop" to end. Release remains your choice.';
  const result = invokeRuntime(['--sanitize-output', '-'], { input });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${input}\n`);
});

test('output sanitizer rejects JOI state wrappers instead of exposing session machinery', async (t) => {
  const cases = [
    {
      name: 'XML state wrapper',
      input: '<joi-state>EDGE</joi-state>',
      error: /unsafe|residual|service|tag/i,
    },
    {
      name: 'tracker-style state wrapper',
      input: 'Continue.\n[[joi-state EDGE]]',
      error: /unsafe|residual|tracker|service|DSL/i,
    },
  ];

  for (const sample of cases) {
    await t.test(sample.name, () => {
      const result = invokeRuntime(['--sanitize-output', '-'], { input: sample.input });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^Error:/);
      assert.match(result.stderr, sample.error);
    });
  }
});

test('output sanitizer rejects residual raw HTML instead of guessing', () => {
  const result = invokeRuntime(['--sanitize-output', '-'], {
    input: '<nemo-final><script>hidden()</script>Visible prose.</nemo-final>',
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Error:/);
  assert.match(result.stderr, /unsafe|residual|HTML|tag/i);
});

test('output sanitizer fails closed when cleanup is empty or unsafe', async (t) => {
  const cases = [
    {
      name: 'empty after closed blocks',
      input: '<plan>secret</plan>\n<think>hidden</think>',
      error: /empty/i,
    },
    {
      name: 'unclosed private block',
      input: '<think>secret\ntext with no trustworthy final boundary',
      error: /unsafe|unclosed/i,
    },
    {
      name: 'unclosed private prefix before final boundary',
      input: '<analysis>PRIVATE REASONING\n<nemo-final>LEAK',
      error: /unsafe|unclosed/i,
    },
    {
      name: 'inline unclosed private opener',
      input: 'User-facing lead. <analysis>SECRET_CHAIN_OF_THOUGHT',
      error: /unsafe|unclosed/i,
    },
    {
      name: 'prefixed inline private opener before final boundary',
      input: 'private <analysis>secret\n<nemo-final>LEAK',
      error: /unsafe|unclosed/i,
    },
    {
      name: 'unmatched private closing tag',
      input: 'PRIVATE REASONING\n</analysis>\nVisible prose.',
      error: /unsafe|unclosed/i,
    },
    {
      name: 'multiple final wrappers',
      input: '<nemo-final>First.</nemo-final>\n<nemo-final>Second.</nemo-final>',
      error: /unsafe|multiple|final/i,
    },
    {
      name: 'residual user XML',
      input: '<user>oops</user>',
      error: /unsafe|residual|tag/i,
    },
    {
      name: 'mid-output OOC scaffold',
      input: 'Visible opening.\n(OOC: private metadata)\nVisible ending.',
      error: /unsafe|residual|OOC/i,
    },
    {
      name: 'unknown tracker DSL',
      input: 'Visible opening.\n[[tracker secret]]\nVisible ending.',
      error: /unsafe|residual|DSL/i,
    },
    {
      name: 'HTML comment',
      input: 'Visible.\n<!-- private -->',
      error: /unsafe|residual|HTML|comment/i,
    },
    {
      name: 'attributed malformed final boundary',
      input: '<nemo-final data="SECRET>LEAK">Visible</nemo-final>',
      error: /unsafe|residual|final|tag/i,
    },
    {
      name: 'final boundary smuggled inside an internal attribute',
      input: '<analysis note="<nemo-final>">SECRET',
      error: /unsafe|unclosed|final|boundary/i,
    },
    {
      name: 'final boundary smuggled inside an HTML attribute',
      input: '<div title="<nemo-final>">LEAK',
      error: /unsafe|residual|final|boundary|tag/i,
    },
    {
      name: 'quoted mid-prose final token',
      input: 'Visible literal "<nemo-final>" LEAK',
      error: /unsafe|residual|final|boundary/i,
    },
    {
      name: 'DOCTYPE declaration',
      input: '<!DOCTYPE story>Visible.',
      error: /unsafe|residual|HTML|markup/i,
    },
    {
      name: 'ENTITY declaration',
      input: '<!ENTITY private "secret">Visible.',
      error: /unsafe|residual|HTML|markup/i,
    },
    {
      name: 'opaque template delimiter',
      input: '<% private service metadata %>Visible.',
      error: /unsafe|residual|markup|delimiter/i,
    },
    {
      name: 'unknown generic XML tag',
      input: '<custom>Visible?</custom>',
      error: /unsafe|residual|tag/i,
    },
  ];

  for (const sample of cases) {
    await t.test(sample.name, () => {
      const result = invokeRuntime(['--sanitize-output', '-'], { input: sample.input });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^Error:/);
      assert.match(result.stderr, sample.error);
    });
  }
});

test('identical inputs produce byte-identical JSON output', () => {
  const args = [
    '--enable',
    IDS.manipulationRealism,
    '--enable',
    IDS.psychologicalRealism,
    '--vex',
    IDS.goonerVex,
    '--nsfw',
    `${IDS.modernNsfwCore},${IDS.goonerProtocol}`,
    '--fetish',
    `${IDS.femdom},${IDS.ntr},${IDS.humiliation},${IDS.joi}`,
    '--pretty',
  ];
  const first = invokeRuntime(args);
  const second = invokeRuntime(args);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, first.stdout);
  assert.equal(second.stderr, first.stderr);
  assert.doesNotMatch(first.stdout, /"(?:generatedAt|timestamp|createdAt)"\s*:/i);
  assert.doesNotThrow(() => JSON.parse(first.stdout));
});
