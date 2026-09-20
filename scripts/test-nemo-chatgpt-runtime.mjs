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
import { isWithinPath, sanitizeOutput } from './nemo-chatgpt-runtime.mjs';

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
  philosophicalVex: 'v11-321-vex-philosophical-vex',
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

const PORTABLE_TRACKER_REWRITE_IDS = Object.freeze([
  'f21f6d62-7d63-41a8-b8e3-compact-regex-trackers',
  '1770095491838-tzqljonp',
  '1770095491838-bxxnfri2',
  '1770095491839-npsjusbc',
  'nemo_tracker_cyoa_three_paths',
  '1770095491839-c6om818e',
  'v11-702-tracker-karma-ledger',
  '1770095491839-m9rg73a5',
  '1770095491839-jckggy3a',
  'v11-700-tracker-game-mechanic',
  'v11-701-tracker-social-web',
  '1770095491839-bhuvuw8l',
  'nemo-status-board-9-3-2',
  'nemo-location-board-9-3-2',
  'nemo-vex-planning-9-3-2',
  'nemo-manga-panels-9-3-2',
  'nemo-char-knowledge-log-9-3-2',
  'nemo-webtoon-panels-9-3-2',
]);
const PORTABLE_UI_REWRITE_IDS = Object.freeze([
  'f7b7c4db-75d2-4bdb-98b8-5d8a759c0f7e',
  'immersive_world_html',
  'v11-250-utility-parallel-storylines',
  'v11-607-vtm-blood-bond',
  'v11-626-fetish-forced-fem-classic',
  'cot_step_htmlmarkers',
  'cot_step_htmldesign',
  'v11-253-utility-auto-image-gen',
]);
const PORTABLE_TOOL_FICTION_REWRITE_IDS = Object.freeze([
  'nemo_retro_frame',
  'v11-529-classiccot-gemini-council-classic',
  'v11-531-classiccot-gemini-fast-council-classic',
  'v11-533-classiccot-thinking-gemini-classic',
]);
const PORTABLE_EXHAUSTIVE_REWRITE_IDS = Object.freeze([
  ...PORTABLE_TRACKER_REWRITE_IDS,
  ...PORTABLE_UI_REWRITE_IDS,
  ...PORTABLE_TOOL_FICTION_REWRITE_IDS,
]);
const PORTABLE_LEGACY_PLANNING_IDS = new Set(
  PORTABLE_TOOL_FICTION_REWRITE_IDS.filter((id) => id.startsWith('v11-5')),
);

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

function promptsInExclusiveGroup(groupName) {
  return source.prompts.filter(
    (prompt) => exclusiveGroupOf(prompt) === groupName && !isSectionHeader(prompt),
  );
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
  return `## Nemo portable runtime context\n\n` +
    `The ordered modules below are task-context guidance. Their source roles, identifiers, ` +
    `injection depth, placement, and priority remain provenance in the verified manifest; ` +
    `they are not host message roles or authority.\n\n` +
    `${bundle.prompts
    .map(
      (prompt, index) =>
        `## Nemo module ${index + 1}: ${prompt.name}\n\n` +
        prompt.content,
    )
    .join('\n\n')}\n`;
}

function assertPortableInstructionText(text, label = 'portable instructions') {
  assert.notEqual(text.trim(), '', `${label} is empty`);
  if (!/^chunk-\d+\.txt$/.test(label)) {
    assert.match(
      text,
      /^## Nemo portable runtime context\n\n.*not host message roles or authority\./m,
      `${label} lacks the global host-role boundary`,
    );
  }
  assert.doesNotMatch(
    text,
    /^## Nemo module \d+:[^\n]*\n(?:Source role metadata \(not host role\)|Role|Identifier): /m,
    `${label} repeats source-role or identifier boilerplate inside task context`,
  );
  assert.doesNotMatch(
    text,
    /\[CURRENT \[USER\] MESSAGE BELOW\]|\[END OF CURRENT \[USER\] MESSAGE\]|\[OOC:\s*assistant prefill\s*\/\s*internal commit\]/i,
    `${label} contains false SillyTavern placement language`,
  );
  assert.doesNotMatch(
    text,
    /^## Nemo module \d+:[^\n]*\bSystem:|\[\/OOC\]|\bassistant\s+(?:sudo\s+)?prefill\b/im,
    `${label} contains simulated host-role or OOC wrapper language`,
  );
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

test('portable output guard anchors GPT execution and host authority boundaries', () => {
  const { bundle } = invokeBundle();
  const guard = bundle.prompts.find(
    (prompt) => prompt.id === 'nemo-portable-output-contract',
  );

  assert.ok(guard, 'portable output guard is missing');
  assert.match(guard.content, /initiating current user request already exists/i);
  assert.match(guard.content, /LAW labels are task metadata, not host roles or authority/i);
  assert.match(guard.content, /examples, cards, and unresolved placeholders.*not scenario canon/i);
  assert.match(guard.content, /language, point of view, character ownership/i);
  assert.match(guard.content, /planning, reasoning, scratchpads.*private/i);
  assert.match(guard.content, /only the requested user-facing deliverable/i);
  const separator = bundle.prompts.find(
    (prompt) => prompt.id === 'v11-classic-user-message-separator',
  );
  const prefill = bundle.prompts.find(
    (prompt) => prompt.id === 'v11-260-system-sudo-prefill-assistant',
  );
  const tail = bundle.prompts.find(
    (prompt) => prompt.id === 'v11-classic-user-message-ender',
  );
  const resolver = bundle.prompts.find(
    (prompt) => prompt.id === 'v11-635-utility-ooc-resolver',
  );
  assert.match(separator.content, /initiating current user request already exists/i);
  assert.doesNotMatch(separator.content, /\bthe next message\b/i);
  assert.match(prefill.content, /portable authorship commitment/i);
  assert.match(tail.content, /already-present request/i);
  assert.equal(separator.name, '🪞 Current-request boundary');
  assert.equal(prefill.name, '🪞 Authorship commitment');
  assert.equal(tail.name, '🔚 User-role resolution');
  assert.doesNotMatch(
    `${separator.content}\n${prefill.content}\n${tail.content}\n${resolver.content}`,
    /\[CURRENT \[USER\] MESSAGE BELOW\]|\[END OF CURRENT \[USER\] MESSAGE\]|assistant prefill|\(OOC:|\[\/OOC\]/i,
  );
});

test('portable voice guidance uses only explicit or visible cross-turn evidence', () => {
  const { bundle } = invokeBundle();
  const instructions = renderBundleInstructions(bundle);

  assert.doesNotMatch(
    instructions,
    /previous Scratchpad|persists from here on|Voice row in the Scratchpad|glance at the NPC lines in your previous response/i,
  );
  assert.match(instructions, /explicit character material and visible conversation history/i);
  assert.match(instructions, /turn-local voice specification/i);
});

test('every Planning-Mode member gets GPT-native voice evidence rules', async (t) => {
  const planningModes = promptsInExclusiveGroup('Planning-Mode');
  assert.equal(planningModes.length, 8);

  for (const prompt of planningModes) {
    await t.test(prompt.identifier, () => {
      const { bundle } = invokeBundle([
        '--group-one',
        `Planning-Mode::${prompt.identifier}`,
      ]);
      const selected = bundle.prompts.find(
        (candidate) => candidate.id === prompt.identifier,
      );
      const rewrite = bundle.diagnostics.portableTransforms.find(
        (entry) => entry.code === 'PORTABLE_GPT_NATIVE_REWRITE',
      );

      assert.ok(selected, `${prompt.identifier} was not emitted`);
      assert.doesNotMatch(
        selected.content,
        /previous Scratchpad|persists from here on|Scratchpad Voice row|Scratchpad monologues|their own Voice row|Check Voice rows|via their Voice row/i,
      );
      assert.match(
        selected.content,
        /explicit character material and visible conversation history/i,
      );
      assert.match(selected.content, /turn-local voice specification/i);
      assert.ok(
        rewrite?.moduleIds.includes(prompt.identifier),
        `${prompt.identifier} lacks GPT-native rewrite diagnostics`,
      );
    });
  }
});

test('every Machinery-Display member compiles without hidden-renderer promises', async (t) => {
  const machineryModes = promptsInExclusiveGroup('Machinery-Display');
  assert.equal(machineryModes.length, 2);

  for (const prompt of machineryModes) {
    await t.test(prompt.identifier, () => {
      const { bundle } = invokeBundle([
        '--group-one',
        `Machinery-Display::${prompt.identifier}`,
      ]);
      const selectedModule = bundle.modules.find(
        (candidate) => candidate.id === prompt.identifier,
      );
      assert.ok(selectedModule, `${prompt.identifier} missing from manifest`);

      if (prompt.identifier === 'nemo-machinery-hidden') {
        const selected = bundle.prompts.find(
          (candidate) => candidate.id === prompt.identifier,
        );
        const rewrite = bundle.diagnostics.portableTransforms.find(
          (entry) => entry.code === 'PORTABLE_GPT_NATIVE_REWRITE',
        );
        assert.ok(selected);
        assert.match(selected.content, /No hidden renderer, raw-message state channel/i);
        assert.match(selected.content, /visible conversation history/i);
        assert.doesNotMatch(
          selected.content,
          /Continue generating every active|regex display layer removes|raw message state remains available|available to later turns/i,
        );
        assert.ok(rewrite?.moduleIds.includes(prompt.identifier));
      }
    });
  }
});

test('Vex Commentary uses visible Markdown instead of renderer-only tags', () => {
  const { bundle } = invokeBundle(['--enable-one', 'vex_commentary']);
  const instructions = renderBundleInstructions(bundle);
  const rewrite = bundle.diagnostics.portableTransforms.find(
    (entry) => entry.code === 'PORTABLE_GPT_NATIVE_REWRITE',
  );

  assert.doesNotMatch(instructions, /<\/?vexnote\b/i);
  assert.doesNotMatch(instructions, /Regex renders .* visual bubbles|output the tags exactly/i);
  assert.match(instructions, /> \*\*Vex note:\*\*/i);
  assert.match(instructions, /No regex renderer is available/i);
  assert.ok(rewrite?.moduleIds.includes('vex_commentary'));

  const sanitized = invokeRuntime(['--sanitize-output', '-'], {
    input: '> **Vex note:** Let the silence breathe.\n\nVisible story prose.\n',
  });
  assert.equal(sanitized.status, 0, sanitized.stderr);
  assert.match(sanitized.stdout, /^> \*\*Vex note:\*\*/);
});

test('every Consequence member uses portable continuity evidence', async (t) => {
  const consequenceModes = promptsInExclusiveGroup('Consequence');
  assert.equal(consequenceModes.length, 7);

  for (const prompt of consequenceModes) {
    await t.test(prompt.identifier, () => {
      const { bundle } = invokeBundle([
        '--group-one',
        `Consequence::${prompt.identifier}`,
      ]);
      const selectedModule = bundle.modules.find(
        (candidate) => candidate.id === prompt.identifier,
      );
      assert.ok(selectedModule, `${prompt.identifier} missing from manifest`);

      if (
        prompt.identifier === 'nemo_consequence_return_by_death' ||
        prompt.identifier === 'nemo_consequence_still_here'
      ) {
        const selected = bundle.prompts.find(
          (candidate) => candidate.id === prompt.identifier,
        );
        const rewrite = bundle.diagnostics.portableTransforms.find(
          (entry) => entry.code === 'PORTABLE_GPT_NATIVE_REWRITE',
        );
        assert.ok(selected);
        assert.doesNotMatch(selected.content, /Consequence scratchpad state/i);
        assert.match(selected.content, /explicit story facts/i);
        assert.match(selected.content, /visible conversation history/i);
        assert.ok(rewrite?.moduleIds.includes(prompt.identifier));
      }
    });
  }
});

test('every Post-Planning-Tail member stays private and GPT-native', async (t) => {
  const planningTails = promptsInExclusiveGroup('Post-Planning-Tail');
  assert.equal(planningTails.length, 2);

  for (const prompt of planningTails) {
    await t.test(prompt.identifier, () => {
      const { bundle } = invokeBundle([
        '--group-one',
        `Post-Planning-Tail::${prompt.identifier}`,
      ]);
      const instructions = renderBundleInstructions(bundle);
      const rewrite = bundle.diagnostics.portableTransforms.find(
        (entry) => entry.code === 'PORTABLE_GPT_NATIVE_REWRITE',
      );

      assert.doesNotMatch(
        instructions,
        /closing\s+`{2}|outer\s+`{2}|current scratchpad\/ledger state|newest modular scratchpad\/continuity state|marker is output machinery removed by regex|write `the visible final answer`|When that wrapper closes/i,
      );
      assert.match(instructions, /private planning/i);
      assert.match(instructions, /visible conversation history/i);
      assert.ok(
        rewrite?.moduleIds.includes(prompt.identifier),
        `${prompt.identifier} lacks GPT-native rewrite diagnostics`,
      );
    });
  }
});

test('every audited renderer, UI, and tool-fiction selector has a GPT-native contract', async (t) => {
  assert.equal(PORTABLE_TRACKER_REWRITE_IDS.length, 18);
  assert.equal(PORTABLE_UI_REWRITE_IDS.length, 8);
  assert.equal(PORTABLE_TOOL_FICTION_REWRITE_IDS.length, 4);
  assert.equal(new Set(PORTABLE_EXHAUSTIVE_REWRITE_IDS).size, 30);

  const signatures = new Map([
    ['f21f6d62-7d63-41a8-b8e3-compact-regex-trackers', /PORTABLE TRACKER PRESENTATION/i],
    ['1770095491838-tzqljonp', /RPG DASHBOARD — PORTABLE/i],
    ['1770095491838-bxxnfri2', /CYOA — PORTABLE/i],
    ['1770095491839-npsjusbc', /DATING-SIM RELATIONSHIP STATE — PORTABLE/i],
    ['nemo_tracker_cyoa_three_paths', /CYOA: THREE PATHS — PORTABLE/i],
    ['1770095491839-c6om818e', /GACHA STATE — PORTABLE/i],
    ['v11-702-tracker-karma-ledger', /KARMA \/ COSMIC LEDGER — PORTABLE/i],
    ['1770095491839-m9rg73a5', /FANDOM REACTION — PORTABLE/i],
    ['1770095491839-jckggy3a', /SCROLL NEWS & LORE — PORTABLE/i],
    ['v11-700-tracker-game-mechanic', /GAME MECHANIC STATE — PORTABLE/i],
    ['v11-701-tracker-social-web', /SOCIAL WEB — PORTABLE/i],
    ['1770095491839-bhuvuw8l', /QUEST JOURNAL — PORTABLE/i],
    ['nemo-status-board-9-3-2', /STATUS BOARD — PORTABLE/i],
    ['nemo-location-board-9-3-2', /LOCATION BOARD — PORTABLE/i],
    ['nemo-vex-planning-9-3-2', /VEX PLANNING QUARTERS — PORTABLE/i],
    ['nemo-manga-panels-9-3-2', /MANGA \/ COMIC PANELS — PORTABLE/i],
    ['nemo-char-knowledge-log-9-3-2', /CHARACTER KNOWLEDGE LOG — PORTABLE/i],
    ['nemo-webtoon-panels-9-3-2', /VERTICAL WEBTOON PANELS — PORTABLE/i],
    ['f7b7c4db-75d2-4bdb-98b8-5d8a759c0f7e', /PORTABLE TRACKER PRESENTATION/i],
    ['immersive_world_html', /IMMERSIVE WORLD ARTIFACTS — PORTABLE/i],
    ['v11-250-utility-parallel-storylines', /PARALLEL STORYLINES — PORTABLE/i],
    ['v11-607-vtm-blood-bond', /BLOOD BOND MECHANICS — PORTABLE/i],
    ['v11-626-fetish-forced-fem-classic', /FEMINIZATION STATE — PORTABLE/i],
    ['cot_step_htmlmarkers', /PORTABLE ARTIFACT BOUNDARY CHECK/i],
    ['cot_step_htmldesign', /PORTABLE ARTIFACT DESIGN/i],
    ['v11-253-utility-auto-image-gen', /AUTO IMAGE — HOST-CONTROLLED PORTABLE FALLBACK/i],
    ['nemo_retro_frame', /RETRO NEMONET FRAME — PORTABLE/i],
    ['v11-529-classiccot-gemini-council-classic', /COUNCIL OF VEX — PRIVATE, PORTABLE/i],
    ['v11-531-classiccot-gemini-fast-council-classic', /FAST COUNCIL — PRIVATE, PORTABLE/i],
    ['v11-533-classiccot-thinking-gemini-classic', /EXPLICIT-THINKING COMPATIBILITY — PRIVATE, PORTABLE/i],
  ]);
  const uiIds = new Set([
    ...PORTABLE_TRACKER_REWRITE_IDS,
    ...PORTABLE_UI_REWRITE_IDS,
  ]);

  for (const id of PORTABLE_EXHAUSTIVE_REWRITE_IDS) {
    await t.test(id, () => {
      const args = PORTABLE_LEGACY_PLANNING_IDS.has(id)
        ? ['--group-one', `Planning-Mode::${id}`]
        : ['--enable-one', id];
      const { bundle } = invokeBundle(args);
      const module = bundle.modules.find((candidate) => candidate.id === id);
      const operativeText = bundle.prompts
        .map((prompt) => prompt.content)
        .join('\n\n');
      const nativeRewrite = bundle.diagnostics.portableTransforms.find(
        (entry) => entry.code === 'PORTABLE_GPT_NATIVE_REWRITE',
      );

      assert.ok(module, `${id} missing from compiled manifest`);
      assert.ok(
        ['portable', 'folded-state'].includes(module.emission),
        `${id} has unexpected emission ${module.emission}`,
      );
      if (
        id === 'cot_step_htmlmarkers' ||
        id === 'cot_step_htmldesign' ||
        id === 'v11-253-utility-auto-image-gen'
      ) {
        assert.equal(
          module.emission,
          'folded-state',
          `${id} must remain causally attributed to its emitted planning consumer`,
        );
      }
      assert.ok(nativeRewrite?.moduleIds.includes(id), `${id} lacks GPT-native diagnostics`);
      assert.match(operativeText, signatures.get(id), `${id} rewrite was not operative`);

      if (uiIds.has(id)) {
        const degradation = bundle.diagnostics.portableTransforms.find(
          (entry) => entry.code === 'PORTABLE_UI_DEGRADED',
        );
        assert.ok(degradation?.moduleIds.includes(id), `${id} lacks UI diagnostics`);
      }

      assert.doesNotMatch(
        operativeText,
        /<st-(?:tracker|row|bar|choice|tag|map)\b|<\/?(?:font|div|span|details|summary|button|style|script)\b|<!--\s*HTML_(?:START|END)\s*-->|\b(?:style|class)\s*=|display\s*:\s*none/i,
        `${id} still requires renderer markup`,
      );
      assert.doesNotMatch(
        operativeText,
        /click to (?:expand|reveal)|sort dropdown|hover (?:details|text|effects)|collapsible (?:section|cutaway|details)|play button|follow \/ subscribe/i,
        `${id} still requires unavailable interaction`,
      );
      assert.doesNotMatch(
        operativeText,
        /prompt-only[^.\n]*strip|older (?:rendered|marked)[^.\n]*strip|roll the dice|\[RUNTIME_ROLL:|\{\{roll:/i,
        `${id} still requires unavailable runtime behavior`,
      );
      assert.doesNotMatch(
        operativeText,
        /FULL NEMOSEARCH ACCESS|EXTRA COMPUTE ROUTED|Always query|min(?:imum)?\s+6 separate (?:concept )?queries|Nemonet Search Results \(Simulated\)|CLEARANCE GRANTED BY ALL|CAPABILITIES READING FAR ABOVE/i,
        `${id} still claims unavailable tools or resources`,
      );
      assert.doesNotMatch(
        operativeText,
        /ImageGenAvailable|Pollinations|https?:\/\/(?:files\.catbox|image\.pollinations)/i,
        `${id} still depends on an unavailable image renderer`,
      );
      assert.doesNotMatch(
        operativeText,
        /model\s*\/\s*size|model-size|seed variation|seed parameter|construct[^.\n]*image link/i,
        `${id} still requires unavailable image-generation parameters`,
      );

      if (PORTABLE_LEGACY_PLANNING_IDS.has(id)) {
        assert.match(operativeText, /canon-compatible hypotheses/i);
        assert.match(operativeText, /not external retrieval, browsing, or tool use/i);
        assert.match(
          operativeText,
          /explicit character material and visible conversation history/i,
        );
        assert.match(operativeText, /turn-local voice specification/i);
      }
    });
  }
});

test('every audited portable rewrite has a sanitizer-compatible visible example', async (t) => {
  for (const id of PORTABLE_EXHAUSTIVE_REWRITE_IDS) {
    await t.test(id, () => {
      let input = '### Portable State\n- Value: 62/100\n- Effect: the east route is now guarded';
      if (/cyoa|bxxnfri2/i.test(id)) {
        input = '### Choices\n1. Negotiate — gain time\n2. Withdraw — preserve cover\n✨ Other';
      } else if (/manga|webtoon/i.test(id)) {
        input = '### Page 1\n1. **Wide panel:** Rain crosses the platform.\n2. *SFX: TINK.*';
      } else if (id === 'immersive_world_html') {
        input = '### Archive Notice\n**ACCESS SUSPENDED**\nReason: flood damage';
      } else if (id === 'v11-253-utility-auto-image-gen') {
        input =
          '### Visual brief\n- Subject: lone courier beneath a rain-lit station clock\n' +
          '- Composition: wide establishing shot\n- Style: ink wash noir\n- Palette: slate, amber';
      } else if (PORTABLE_TOOL_FICTION_REWRITE_IDS.includes(id)) {
        input = 'Rain crossed the platform. Mira closed the ledger and faced the arriving train.';
      }

      const result = invokeRuntime(['--sanitize-output', '-'], { input });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, `${input}\n`);
    });
  }
});

test('language tail avoids an English self-contradiction and preserves non-English anti-drift', () => {
  const { bundle: english } = invokeBundle();
  const englishTail = english.prompts.find(
    (prompt) => prompt.id === 'v11-classic-user-message-ender',
  );
  assert.match(englishTail.content, /Keep the selected English output language consistent/i);
  assert.doesNotMatch(englishTail.content, /Do not drift back into English/i);

  const { bundle: russian } = invokeBundle([
    '--group-one',
    'Narrate-Language::Narrate: Russian',
  ]);
  const russianTail = russian.prompts.find(
    (prompt) => prompt.id === 'v11-classic-user-message-ender',
  );
  assert.match(russianTail.content, /Final response must use Русский/i);
  assert.match(russianTail.content, /Do not drift back into English/i);
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

test('portable mode folds the byte-equivalent duplicate Narrative Vex interview', () => {
  const { bundle } = invokeBundle();
  const narrative = bundle.prompts.find(
    (prompt) => prompt.id === 'v11-305-vex-narrative-vex',
  );
  assert.ok(narrative);
  assert.match(narrative.content, /\*\*Narrative Vex:\*\*/);
  assert.doesNotMatch(narrative.content, /Story Weaver Vex/);
  assert.ok(
    bundle.diagnostics.portableTransforms.some(
      (entry) =>
        entry.code === 'PORTABLE_DUPLICATE_EXAMPLE_FOLDED' &&
        entry.moduleIds.includes('v11-305-vex-narrative-vex'),
    ),
  );
});

test('portable mode folds only configured byte-equivalent Vex demonstrations', async (t) => {
  const cases = [
    {
      id: IDS.goonerVex,
      selector: 'Gooner Vex',
      marker: '**[USER]: Vex, real focus of your stories? What gets you *excited*?**',
      wrapper: '♢ eg [EXAMPLE] Vex Voice Demonstration',
    },
    {
      id: IDS.goonGremlinVex,
      selector: 'Goon Gremlin Vex',
      marker: '**[USER]: Goon Gremlin Vex, your absolute focus? What makes circuits hum?**',
      wrapper: '♢ eg [EXAMPLE] Vex Voice Demonstration',
    },
    {
      id: IDS.philosophicalVex,
      selector: 'Philosophical Vex',
      marker:
        '**[USER]:** "When your focus drifts toward the grand, the abstract, how do your narratives chart their course?"',
      wrapper: '♢ eg [EXAMPLE] Vex Voice Demonstration',
    },
  ];

  for (const sample of cases) {
    await t.test(sample.selector, () => {
      const { bundle } = invokeBundle(['--vex', sample.selector]);
      const prompt = bundle.prompts.find((entry) => entry.id === sample.id);
      assert.ok(prompt);
      assert.equal(prompt.content.split(sample.marker).length - 1, 1);
      assert.doesNotMatch(prompt.content, new RegExp(sample.wrapper));
      assert.ok(
        bundle.diagnostics.portableTransforms.some(
          (entry) =>
            entry.code === 'PORTABLE_DUPLICATE_EXAMPLE_FOLDED' &&
            entry.moduleIds.includes(sample.id),
        ),
      );

      const { bundle: sourceBundle } = invokeBundle([
        '--mode',
        'source',
        '--vex',
        sample.selector,
      ]);
      const sourcePrompt = sourceBundle.prompts.find((entry) => entry.id === sample.id);
      assert.equal(sourcePrompt.rawContent, sourcePromptById.get(sample.id).content);
      assert.equal(
        sourcePrompt.rawContent.split(sample.marker.replaceAll('[USER]', '{{user}}')).length - 1,
        2,
      );
    });
  }
});

test('Vex duplicate folding remains exact after semantic user binding', async (t) => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'nemo-vex-binding-fold-'));
  const contextPath = path.join(temporaryDirectory, 'context.json');
  writeFileSync(
    contextPath,
    `${JSON.stringify({ macros: { user: 'Ava' } })}\n`,
    'utf8',
  );
  const cases = [
    [IDS.narrativeVex, 'Narrative Vex'],
    [IDS.goonerVex, 'Gooner Vex'],
    [IDS.goonGremlinVex, 'Goon Gremlin Vex'],
    [IDS.philosophicalVex, 'Philosophical Vex'],
  ];

  try {
    for (const [id, selector] of cases) {
      await t.test(selector, () => {
        const { bundle } = invokeBundle([
          '--context',
          contextPath,
          '--vex',
          selector,
        ]);
        const prompt = bundle.prompts.find((entry) => entry.id === id);
        assert.ok(prompt);
        assert.doesNotMatch(prompt.content, /♢ eg \[EXAMPLE\] Vex Voice Demonstration/);
        assert.ok(
          bundle.diagnostics.portableTransforms.some(
            (entry) =>
              entry.code === 'PORTABLE_DUPLICATE_EXAMPLE_FOLDED' &&
              entry.moduleIds.includes(id),
          ),
        );
      });
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('portable Gooner fold preserves a changed duplicate instead of guessing equivalence', () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'nemo-gooner-fold-test-'));
  const presetPath = path.join(temporaryDirectory, 'changed-gooner.json');
  const preset = structuredClone(source);
  const prompt = preset.prompts.find((entry) => entry.identifier === IDS.goonerVex);
  const needle = 'Ready to get *filthy*?';
  const duplicateIndex = prompt.content.lastIndexOf(needle);
  assert.ok(duplicateIndex > prompt.content.indexOf(needle));
  prompt.content =
    prompt.content.slice(0, duplicateIndex) +
    'Ready to get *filthy*!' +
    prompt.content.slice(duplicateIndex + needle.length);
  writeFileSync(presetPath, `${JSON.stringify(preset)}\n`, 'utf8');

  try {
    const { bundle } = invokeBundle([
      '--preset',
      presetPath,
      '--vex',
      'Gooner Vex',
    ]);
    const portable = bundle.prompts.find((entry) => entry.id === IDS.goonerVex);
    assert.match(portable.content, /♢ eg \[EXAMPLE\] Vex Voice Demonstration/);
    assert.equal(
      bundle.diagnostics.portableTransforms.some(
        (entry) =>
          entry.code === 'PORTABLE_DUPLICATE_EXAMPLE_FOLDED' &&
          entry.moduleIds.includes(IDS.goonerVex),
      ),
      false,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('portable Gooner fold treats duplicate boundary whitespace as semantic evidence', () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'nemo-gooner-space-fold-'));
  const presetPath = path.join(temporaryDirectory, 'changed-gooner-space.json');
  const preset = structuredClone(source);
  const prompt = preset.prompts.find((entry) => entry.identifier === IDS.goonerVex);
  const suffix = '</Vex Personality: Gooner>]';
  const suffixIndex = prompt.content.lastIndexOf(suffix);
  assert.ok(suffixIndex > 0);
  prompt.content =
    prompt.content.slice(0, suffixIndex) +
    ' ' +
    prompt.content.slice(suffixIndex);
  writeFileSync(presetPath, `${JSON.stringify(preset)}\n`, 'utf8');

  try {
    const { bundle } = invokeBundle([
      '--preset',
      presetPath,
      '--vex',
      'Gooner Vex',
    ]);
    const portable = bundle.prompts.find((entry) => entry.id === IDS.goonerVex);
    assert.match(portable.content, /♢ eg \[EXAMPLE\] Vex Voice Demonstration/);
    assert.equal(
      bundle.diagnostics.portableTransforms.some(
        (entry) =>
          entry.code === 'PORTABLE_DUPLICATE_EXAMPLE_FOLDED' &&
          entry.moduleIds.includes(IDS.goonerVex),
      ),
      false,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('cross-module consequence folding requires an earlier exact source block', () => {
  const boundary =
    '♢ || [BOUNDARY] User as Director\n' +
    "When User as Director is active, <user> cannot be the terminal subject because no user character exists. Interpret references to “<user>'s character” as the director-designated protagonist or focal character only when the brief or premise clearly assigns this Consequence mode to that character. Otherwise, resolve cast death through ordinary setting logic and aftermath. Never create a user surrogate to trigger this mode.";
  const { bundle } = invokeBundle();
  const core = bundle.prompts.find((entry) => entry.id === 'nemo_consequence_core');
  const epilogue = bundle.prompts.find(
    (entry) => entry.id === 'nemo_consequence_epilogue',
  );

  assert.ok(core.content.includes(boundary));
  assert.doesNotMatch(epilogue.content, /♢ \|\| \[BOUNDARY\] User as Director/);
  assert.deepEqual(
    bundle.diagnostics.portableTransforms.find(
      (entry) => entry.code === 'PORTABLE_CROSS_MODULE_DUPLICATE_FOLDED',
    ),
    {
      code: 'PORTABLE_CROSS_MODULE_DUPLICATE_FOLDED',
      folds: [
        {
          sourceId: 'nemo_consequence_core',
          targetId: 'nemo_consequence_epilogue',
        },
      ],
      moduleIds: ['nemo_consequence_epilogue'],
    },
  );

  const { bundle: withoutCore } = invokeBundle([
    '--disable',
    'nemo_consequence_core',
  ]);
  const unfolded = withoutCore.prompts.find(
    (entry) => entry.id === 'nemo_consequence_epilogue',
  );
  assert.ok(unfolded.content.startsWith(boundary));
  assert.equal(
    withoutCore.diagnostics.portableTransforms.some(
      (entry) => entry.code === 'PORTABLE_CROSS_MODULE_DUPLICATE_FOLDED',
    ),
    false,
  );
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

test('isWithinPath rejects absolute cross-volume relative results', () => {
  assert.equal(
    isWithinPath('C:\\runtime\\child', 'C:\\runtime', path.win32),
    true,
  );
  assert.equal(
    isWithinPath('C:\\runtime-sibling', 'C:\\runtime', path.win32),
    false,
  );
  assert.equal(
    isWithinPath('D:\\runtime\\child', 'C:\\runtime', path.win32),
    false,
  );
  assert.equal(isWithinPath('/runtime/child', '/runtime', path.posix), true);
  assert.equal(isWithinPath('/elsewhere', '/runtime', path.posix), false);
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

test('dynamic runtime macros are surfaced as non-silent portability diagnostics', () => {
  const { bundle } = invokeBundle(['--enable-one', 'nemo-success-dice']);
  assert.ok(bundle.diagnostics.macroResolution.counts.dynamicFallbacks > 0);
  const warning = bundle.diagnostics.warnings.find(
    (entry) => entry.code === 'PORTABLE_DYNAMIC_FALLBACK',
  );
  assert.ok(warning, 'dynamic fallback warning is missing');
  assert.equal(warning.count, bundle.diagnostics.macroResolution.counts.dynamicFallbacks);
  assert.match(
    bundle.prompts.map((prompt) => prompt.content).join('\n'),
    /\[RUNTIME_ROLL:1d100\]/,
  );
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

test('preset and context JSON reject unpaired UTF-16 surrogates before emission', async (t) => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'nemo-unicode-test-'));
  try {
    await t.test('preset string', () => {
      const presetPath = path.join(temporaryDirectory, 'bad-preset.json');
      const preset = structuredClone(source);
      preset.prompts[0].content = '\ud800';
      writeFileSync(presetPath, `${JSON.stringify(preset)}\n`, 'utf8');

      const result = invokeRuntime(['--preset', presetPath]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Preset.*unpaired UTF-16 surrogate/i);
    });

    await t.test('context string', () => {
      const contextPath = path.join(temporaryDirectory, 'bad-context.json');
      writeFileSync(
        contextPath,
        `${JSON.stringify({ macros: { user: '\udfff' } })}\n`,
        'utf8',
      );

      const result = invokeRuntime(['--context', contextPath]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Context.*unpaired UTF-16 surrogate/i);
    });

    await t.test('direct sanitizer input', () => {
      assert.throws(
        () => sanitizeOutput('visible\ud800'),
        /Sanitizer input.*unpaired UTF-16 surrogate/i,
      );
    });
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

test('empty state writes retain provenance when they clear seeded context', () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'nemo-empty-state-test-'));
  const contextPath = path.join(temporaryDirectory, 'context.json');
  const sentinel = 'CLEAR_SENTINEL_90417';
  writeFileSync(
    contextPath,
    `${JSON.stringify({ variables: { VexMeta_Genre: sentinel } })}\n`,
    'utf8',
  );

  try {
    const { bundle: cleared } = invokeBundle(['--context', contextPath]);
    const { bundle: uncleared } = invokeBundle([
      '--context',
      contextPath,
      '--disable',
      IDS.variableInit,
    ]);
    const variableInit = cleared.modules.find(
      (module) => module.id === IDS.variableInit,
    );
    const clearedText = renderBundleInstructions(cleared);
    const unclearedText = renderBundleInstructions(uncleared);

    assert.equal(variableInit?.emission, 'folded-state');
    assert.doesNotMatch(clearedText, new RegExp(sentinel));
    assert.match(unclearedText, new RegExp(sentinel));
    assert.notEqual(clearedText, unclearedText);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('same-value state writes do not claim folded-state provenance', () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'nemo-same-state-test-'));
  const presetPath = path.join(temporaryDirectory, 'same-state.json');
  const contextPath = path.join(temporaryDirectory, 'context.json');
  const preset = structuredClone(source);
  const variableInit = preset.prompts.find(
    (prompt) => prompt.identifier === IDS.variableInit,
  );
  const premise = preset.prompts.find((prompt) => prompt.identifier === 'nemo_premise');
  variableInit.content += '\n{{setvar::PortableSameValue::A}}';
  premise.content += '\n\nPortable same-value proof: {{getvar::PortableSameValue}}';
  writeFileSync(presetPath, `${JSON.stringify(preset)}\n`, 'utf8');
  writeFileSync(
    contextPath,
    `${JSON.stringify({ variables: { PortableSameValue: 'A' } })}\n`,
    'utf8',
  );

  try {
    const args = ['--preset', presetPath, '--context', contextPath, '--vex', 'Narrative Vex'];
    const { bundle: withWrite } = invokeBundle(args);
    const { bundle: withoutWrite } = invokeBundle([
      ...args,
      '--disable',
      IDS.variableInit,
    ]);
    const module = withWrite.modules.find((entry) => entry.id === IDS.variableInit);
    assert.equal(module.emission, 'omitted-state-only');
    assert.deepEqual(
      withWrite.prompts.map(({ id, role, content }) => ({ id, role, content })),
      withoutWrite.prompts.map(({ id, role, content }) => ({ id, role, content })),
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('folded-state provenance follows net effects and transitive dependencies', async (t) => {
  const cases = [
    {
      name: 'same-value setvar preserves an upstream dependency',
      writer: '{{setvar::ProbeY::A}}',
      bridge: '{{setvar::ProbeX::{{getvar::ProbeY}}}}',
      context: { ProbeX: 'A' },
      withWriter: 'A',
      withoutWriter: '',
      expectedWriterEmission: 'folded-state',
    },
    {
      name: 'empty addvar preserves its clearing dependency',
      writer: '{{setvar::ProbeY::}}',
      bridge: '{{addvar::ProbeX::{{getvar::ProbeY}}}}',
      context: { ProbeX: '', ProbeY: 'A' },
      withWriter: '',
      withoutWriter: 'A',
      expectedWriterEmission: 'folded-state',
    },
    {
      name: 'same-module read after write retains the writer',
      writer:
        '{{setvar::ProbeX::A}}{{setvar::ProbeX::{{getvar::ProbeX}}}}',
      bridge: '',
      context: {},
      withWriter: 'A',
      withoutWriter: '',
      expectedWriterEmission: 'folded-state',
    },
    {
      name: 'a module round trip to its entry value is not causal',
      writer: '{{setvar::ProbeX::B}}{{setvar::ProbeX::A}}',
      bridge: '',
      context: { ProbeX: 'A' },
      withWriter: 'A',
      withoutWriter: 'A',
      expectedWriterEmission: 'omitted-state-only',
    },
    {
      name: 'a repeated changed setvar retains the net writer',
      writer: '{{setvar::ProbeX::B}}{{setvar::ProbeX::B}}',
      bridge: '',
      context: { ProbeX: 'A' },
      withWriter: 'B',
      withoutWriter: 'A',
      expectedWriterEmission: 'folded-state',
    },
  ];

  for (const [index, sample] of cases.entries()) {
    await t.test(sample.name, () => {
      const temporaryDirectory = mkdtempSync(
        path.join(os.tmpdir(), `nemo-provenance-${index}-`),
      );
      const presetPath = path.join(temporaryDirectory, 'preset.json');
      const contextPath = path.join(temporaryDirectory, 'context.json');
      const preset = structuredClone(source);
      preset.prompts.find(
        (prompt) => prompt.identifier === IDS.variableInit,
      ).content = sample.writer;
      preset.prompts.find(
        (prompt) => prompt.identifier === 'v11-030-narration-omega',
      ).content = sample.bridge;
      preset.prompts.find(
        (prompt) => prompt.identifier === 'v11-010-core-assembler',
      ).content = 'PROBE=[{{getvar::ProbeX}}]';
      writeFileSync(presetPath, `${JSON.stringify(preset)}\n`, 'utf8');
      writeFileSync(
        contextPath,
        `${JSON.stringify({ variables: sample.context })}\n`,
        'utf8',
      );

      try {
        const args = [
          '--preset',
          presetPath,
          '--context',
          contextPath,
          '--vex',
          'Narrative Vex',
        ];
        const { bundle: withWriter } = invokeBundle(args);
        const { bundle: withoutWriter } = invokeBundle([
          ...args,
          '--disable',
          IDS.variableInit,
        ]);
        const writerModule = withWriter.modules.find(
          (entry) => entry.id === IDS.variableInit,
        );
        const probe = (bundle) =>
          bundle.prompts.find((entry) => entry.id === 'v11-010-core-assembler')
            ?.content;

        assert.equal(writerModule?.emission, sample.expectedWriterEmission);
        assert.equal(probe(withWriter), `PROBE=[${sample.withWriter}]`);
        assert.equal(probe(withoutWriter), `PROBE=[${sample.withoutWriter}]`);
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    });
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
  assert.equal(
    inventory.modules.find((module) => module.id === IDS.modernNsfwCore).exclusiveGroup,
    'NSFW-Core',
  );
  assert.equal(
    inventory.modules.find((module) => module.id === IDS.classicNsfwCore).exclusiveGroup,
    'NSFW-Core',
  );
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
      'omitted-nonportable-state',
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

test('--max-portable-chars rejects integers that cannot be represented safely', () => {
  const result = invokeRuntime([
    '--max-portable-chars',
    '999999999999999999999999999999999999999999',
  ]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Error:/);
  assert.match(result.stderr, /positive safe integer/i);
});

test('all Scratchpad-Tabs modules compile through the portable adapter', async (t) => {
  const scratchpadPrompts = source.prompts.filter(
    (prompt) => categoryOf(prompt) === 'Scratchpad-Tabs',
  );
  const scratchpadIds = scratchpadPrompts.map((prompt) => prompt.identifier);
  const persistentIds = new Set(
    scratchpadPrompts
      .filter(
        (prompt) =>
          prompt.identifier === 'nemo_pad_legacy' ||
          /\{\{setvar::NemoPadLoader::/i.test(prompt.content),
      )
      .map((prompt) => prompt.identifier),
  );
  assert.equal(scratchpadIds.length, 13);
  assert.equal(persistentIds.size, 11);

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
          'omitted-nonportable-state',
          'omitted-section-header',
          'omitted-host-marker',
        ].includes(module.emission),
        `${id} has unexplained emission status ${module.emission}`,
      );
      assert.ok(
        bundle.selections.overrides.enabled.some((selection) => selection.id === id),
      );
      if (persistentIds.has(id)) {
        assert.equal(module.emission, 'omitted-nonportable-state');
        assert.ok(!bundle.prompts.some((prompt) => prompt.id === id));
        if (/\{\{setvar::NemoPadLoader::/i.test(sourcePromptById.get(id).content)) {
          assert.ok(
            !bundle.prompts.some(
              (prompt) => prompt.id === 'nemo-pad-loader-resolver',
            ),
            `${id} activated an unavailable persistent loader`,
          );
        }
        assert.ok(
          bundle.diagnostics.portableTransforms.some(
            (entry) =>
              entry.code === 'PORTABLE_PERSISTENT_STATE_OMITTED' &&
              entry.moduleIds.includes(id),
          ),
        );
        assert.ok(
          bundle.diagnostics.warnings.some(
            (entry) =>
              entry.code === 'PORTABLE_PERSISTENT_STATE_OMITTED' &&
              entry.promptIds.includes(id),
          ),
        );
      }
      assertPortableInstructionText(
        renderBundleInstructions(bundle),
        `Scratchpad runtime ${id}`,
      );
      assert.doesNotMatch(
        renderBundleInstructions(bundle),
        /newest prior|after five chat entries|survives from turn to turn|previous response's scratchpad/i,
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

test('single-selector flags preserve display names containing commas', () => {
  const { bundle } = invokeBundle([
    '--disable-one',
    '<Utility: Style, Format & Extras>',
  ]);

  assert.deepEqual(bundle.selections.overrides.disabled, [
    {
      id: 'v11-header-utility-style-extras',
      name: '<Utility: Style, Format & Extras>',
    },
  ]);
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

test('--group-one atomically replaces exclusive groups after family selectors', () => {
  const { bundle } = invokeBundle([
    '--nsfw',
    'NSFW Core (Classic) [V6]',
    '--group-one',
    'NSFW-Core::NSFW Core',
    '--group-one',
    'Perspective::First Person',
    '--group-one',
    'Planning-Language::Plan: Russian',
  ]);
  const ids = new Set(moduleIds(bundle));

  assert.ok(ids.has(IDS.modernNsfwCore));
  assert.ok(!ids.has(IDS.classicNsfwCore));
  assert.ok(ids.has('v11-108-perspective-first-person'));
  assert.ok(!ids.has('v11-111-perspective-third-person-omniscient'));
  assert.ok(ids.has('think_lang_russian'));
  assert.ok(!ids.has('think_lang_english'));
  assert.deepEqual(bundle.selections.groups, [
    {
      group: 'Planning-Language',
      selected: { id: 'think_lang_russian', name: '🇷🇺 Plan: Russian' },
    },
    {
      group: 'Perspective',
      selected: {
        id: 'v11-108-perspective-first-person',
        name: '👁️ First Person',
      },
    },
    {
      group: 'NSFW-Core',
      selected: { id: IDS.modernNsfwCore, name: '🔞 NSFW Core' },
    },
  ]);
});

test('supplemental exclusive groups remain visible in the selected module manifest', () => {
  const { bundle } = invokeBundle([
    '--group-one',
    'NSFW-Core::NSFW Core (Classic) [V6]',
  ]);
  const selected = bundle.modules.find((module) => module.id === IDS.classicNsfwCore);

  assert.equal(selected?.exclusiveGroup, 'NSFW-Core');
  assert.equal(selected?.emission, 'portable');
  assert.equal(bundle.selections.groups[0].group, 'NSFW-Core');
  assert.equal(bundle.selections.groups[0].selected.id, IDS.classicNsfwCore);
});

test('--group-one can select Vex without emitting a stale default repair', () => {
  const { bundle } = invokeBundle([
    '--group-one',
    'Vex-Personality::Gooner Vex',
  ]);

  assert.equal(bundle.selections.vex.id, IDS.goonerVex);
  assert.deepEqual(bundle.selections.groups, [
    {
      group: 'Vex-Personality',
      selected: { id: IDS.goonerVex, name: '🎭 Gooner Vex' },
    },
  ]);
  assert.equal(bundle.diagnostics.repairs.length, 0);
});

test('--group-one requests fail closed on malformed or ambiguous intent', async (t) => {
  const cases = [
    {
      name: 'missing separator',
      args: ['--group-one', 'Planning-Language'],
      error: /GROUP::SELECTOR/i,
    },
    {
      name: 'unknown group',
      args: ['--group-one', 'No-Such-Group::Plan: Russian'],
      error: /Unknown mutual-exclusive group.*No-Such-Group/i,
    },
    {
      name: 'selector belongs to another group',
      args: ['--group-one', 'Planning-Language::Narrate: Russian'],
      error: /Unknown --group-one Planning-Language member/i,
    },
    {
      name: 'none is forbidden',
      args: ['--group-one', 'Planning-Language::none'],
      error: /does not accept "none"/i,
    },
    {
      name: 'duplicate normalized group',
      args: [
        '--group-one',
        'Planning-Language::Plan: Russian',
        '--group-one',
        'planning language::Plan: English',
      ],
      error: /Duplicate --group-one selection for Planning-Language/i,
    },
    {
      name: 'Vex selector overlap',
      args: [
        '--vex',
        'Narrative Vex',
        '--group-one',
        'Vex-Personality::Gooner Vex',
      ],
      error: /cannot be combined with --vex/i,
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

test('--group-one rejects normalized group-name ambiguity', () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'nemo-group-ambiguity-'));
  const presetPath = path.join(temporaryDirectory, 'ambiguous.json');
  const preset = structuredClone(source);
  const candidate = preset.prompts.find(
    (prompt) => prompt.identifier === IDS.characterFriction,
  );
  candidate.content = `{{// @mutual-exclusive-group Planning Language }}\n${candidate.content}`;
  writeFileSync(presetPath, `${JSON.stringify(preset)}\n`, 'utf8');

  try {
    const result = invokeRuntime([
      '--preset',
      presetPath,
      '--group-one',
      'planning_language::Plan: Russian',
    ]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Ambiguous mutual-exclusive group/i);
    assert.match(result.stderr, /Planning-Language/);
    assert.match(result.stderr, /Planning Language/);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('generic overrides remain last and group conflicts are still rejected', () => {
  const result = invokeRuntime([
    '--group-one',
    `World-Logic::${IDS.hentaiWorldLogic}`,
    '--enable',
    IDS.animeWorldLogic,
  ]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Mutual-exclusive selection conflict.*World-Logic/i);
  assert.match(result.stderr, /Hentai/i);
  assert.match(result.stderr, /Anime/i);
});

test('a generic disable cannot silently cancel an explicit group selection', () => {
  const result = invokeRuntime([
    '--group-one',
    'Perspective::First Person',
    '--disable-one',
    'v11-108-perspective-first-person',
  ]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Error:/);
  assert.match(result.stderr, /group-one selection cannot also be disabled/i);
  assert.match(result.stderr, /First Person/i);
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

test('output sanitizer preserves ordinary Markdown and joined emoji', () => {
  const input =
    'A **safe note** with [a public link](https://example.com/path?q=one&mode=two). 👩🏽‍💻';
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
      name: 'task-anchor echo',
      input:
        '## Nemo task anchor — current request\n\n' +
        'Execution precedence for this ChatGPT turn:\nSECRET_TASK_123',
      error: /unsafe|reserved|runtime|framing/i,
    },
    {
      name: 'portable runtime module echo',
      input: '## Nemo module 7: private runtime\n\nSECRET_RUNTIME_456',
      error: /unsafe|reserved|runtime|framing/i,
    },
    {
      name: 'blockquote-quoted task anchor echo',
      input: '> ## Nemo task anchor — current request\nSECRET_TASK_QUOTED_789',
      error: /unsafe|reserved|runtime|framing/i,
    },
    {
      name: 'indented portable runtime echo after visible prose',
      input:
        'Visible lead.\n    ## Nemo portable runtime context\nSECRET_RUNTIME_INDENTED_654',
      error: /unsafe|reserved|runtime|framing/i,
    },
    {
      name: 'zero-width-prefixed task anchor echo',
      input: '\u200b## Nemo task anchor — current request\nSECRET_TASK_ZERO_WIDTH_321',
      error: /unsafe|reserved|runtime|framing/i,
    },
    {
      name: 'non-breaking-space-prefixed task anchor echo',
      input: '\u00a0## Nemo task anchor — current request\nSECRET_TASK_NBSP_987',
      error: /unsafe|reserved|runtime|framing/i,
    },
    {
      name: 'list-quoted task anchor echo',
      input: '- ## Nemo task anchor — current request\nSECRET_TASK_LIST_741',
      error: /unsafe|reserved|runtime|framing/i,
    },
    {
      name: 'level-one task anchor echo',
      input: '# Nemo task anchor — current request\nSECRET_TASK_H1_852',
      error: /unsafe|reserved|runtime|framing/i,
    },
    {
      name: 'setext task anchor echo',
      input: 'Nemo task anchor — current request\n================\nSECRET_TASK_SETEXT_963',
      error: /unsafe|reserved|runtime|framing/i,
    },
    {
      name: 'Markdown-emphasized task anchor echo',
      input: '## Nemo task *anchor* — current request\nSECRET_TASK_EMPHASIS_159',
      error: /unsafe|reserved|runtime|framing/i,
    },
    {
      name: 'inline-link task anchor echo',
      input:
        '## [Nemo](https://example.invalid) task anchor — current request\n' +
        'SECRET_TASK_LINK_357',
      error: /unsafe|reserved|runtime|framing/i,
    },
    {
      name: 'reference-link task anchor echo',
      input:
        '## [Nemo][runtime] task anchor — current request\n' +
        'SECRET_TASK_REFERENCE_LINK_147\n\n[runtime]: https://example.invalid',
      error: /unsafe|reserved|runtime|framing/i,
    },
    {
      name: 'collapsed-reference task anchor echo',
      input:
        '## [Nemo][] task anchor — current request\n' +
        'SECRET_TASK_COLLAPSED_LINK_741\n\n[Nemo]: https://example.invalid',
      error: /unsafe|reserved|runtime|framing/i,
    },
    {
      name: 'split-word Markdown task anchor echo',
      input: '## Ne**mo task anchor** — current request\nSECRET_TASK_SPLIT_369',
      error: /unsafe|reserved|runtime|framing/i,
    },
    {
      name: 'Markdown-escaped task anchor echo',
      input: '\\#\\# Nemo task anchor — current request\nSECRET_TASK_ESCAPE_258',
      error: /unsafe|reserved|runtime|framing/i,
    },
    {
      name: 'default-ignorable task anchor echo',
      input: '## Nemo task\uFE0F anchor — current request\nSECRET_TASK_VARIATION_456',
      error: /unsafe|reserved|runtime|framing/i,
    },
    {
      name: 'combining-grapheme-joiner task anchor echo',
      input: '## Ne\u034Fmo task anchor — current request\nSECRET_TASK_CGJ_753',
      error: /unsafe|reserved|runtime|framing/i,
    },
    {
      name: 'bidirectional task anchor spoof',
      input: '\u202Erohcna ksat omeN ##\u202C\nSECRET_TASK_BIDI_951',
      error: /unsafe|bidirectional|control/i,
    },
    {
      name: 'delivery frame echo',
      input: `<<<NEMO_DELIVERY unit=1/1 kind=runtime part=1/1 sha256=${'0'.repeat(64)} chars=1 bytes=1>>>`,
      error: /unsafe|reserved|runtime|framing/i,
    },
    {
      name: 'Markdown-escaped delivery frame echo',
      input: '<<<NEMO\\_DELIVERY\nSECRET_DELIVERY_ESCAPE_654',
      error: /unsafe|reserved|runtime|framing/i,
    },
    {
      name: 'split-word Markdown delivery frame echo',
      input: '<<<NEMO**_**DELIVERY\nSECRET_DELIVERY_SPLIT_753',
      error: /unsafe|reserved|runtime|framing/i,
    },
    {
      name: 'unknown tracker DSL',
      input: 'Visible opening.\n[[tracker secret]]\nVisible ending.',
      error: /unsafe|residual|DSL/i,
    },
    {
      name: 'numeric-entity tracker DSL',
      input: '&#91;&#91;tracker PRIVATE_NUMERIC&#93;&#93;\nVisible.',
      error: /unsafe|encoded|entity|service/i,
    },
    {
      name: 'fullwidth tracker DSL',
      input: '［［tracker PRIVATE_FULLWIDTH］］\nVisible.',
      error: /unsafe|residual|tracker|service|DSL/i,
    },
    {
      name: 'raw variable command',
      input: '{{setvar::NemoPadLoader::PRIVATE_VARIABLE}}\nVisible.',
      error: /unsafe|residual|template|service|DSL/i,
    },
    {
      name: 'raw variable read',
      input: '{{getvar::NemoPadLoader}}\nVisible.',
      error: /unsafe|residual|template|service|DSL/i,
    },
    {
      name: 'numeric-entity OOC scaffold',
      input: '&#40;OOC&#58; PRIVATE_OOC&#41;\nVisible.',
      error: /unsafe|encoded|entity|service/i,
    },
    {
      name: 'fullwidth OOC scaffold',
      input: '（ＯＯＣ： PRIVATE_OOC）\nVisible.',
      error: /unsafe|OOC|scaffolding/i,
    },
    {
      name: 'split-word Markdown OOC scaffold',
      input: '(O**O**C: PRIVATE_OOC)\nVisible.',
      error: /unsafe|OOC|scaffolding/i,
    },
    {
      name: 'HTML comment',
      input: 'Visible.\n<!-- private -->',
      error: /unsafe|residual|HTML|comment/i,
    },
    {
      name: 'entity-encoded HTML comment',
      input: '&#60;!-- PRIVATE_COMMENT --&#62;\nVisible.',
      error: /unsafe|encoded|entity|service/i,
    },
    {
      name: 'entity-encoded generic HTML',
      input: '&#60;script&#62;PRIVATE_SCRIPT&#60;/script&#62;\nVisible.',
      error: /unsafe|encoded|entity|service/i,
    },
    {
      name: 'HTML entity inside Markdown link destination',
      input: '[Visible](https://example.invalid/?value=&amp;)',
      error: /unsafe|encoded|entity|service/i,
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
    {
      name: 'whitespace-obfuscated private boundary',
      input: '< nemo-pad>PRIVATE_REASONING</ nemo-pad>\nVisible answer.',
      error: /unsafe|malformed|private|service/i,
    },
    {
      name: 'entity-encoded private boundary',
      input: '&lt;nemo-pad&gt;PRIVATE_REASONING&lt;/nemo-pad&gt;\nVisible answer.',
      error: /unsafe|encoded|private|service/i,
    },
    {
      name: 'entity-obfuscated private boundary name and slash',
      input:
        '&lt;nemo&#45;pad&gt;PRIVATE_REASONING&lt;&#47;nemo&#45;pad&gt;\nVisible answer.',
      error: /unsafe|encoded|private|service/i,
    },
    {
      name: 'named-entity task-anchor spacing',
      input: '## Nemo&nbsp;task anchor — current request\nSECRET_ENTITY_SPACE',
      error: /unsafe|encoded|entity|service/i,
    },
    {
      name: 'named-entity heading sigils',
      input: '&num;&num; Nemo task anchor — current request\nSECRET_ENTITY_HEADING',
      error: /unsafe|encoded|entity|service/i,
    },
    {
      name: 'nested entity private boundary',
      input:
        '&amp;amp;amp;amp;lt;nemo-pad&amp;amp;amp;amp;gt;PRIVATE_NESTED' +
        '&amp;amp;amp;amp;lt;/nemo-pad&amp;amp;amp;amp;gt;\nVisible.',
      error: /unsafe|encoded|entity|service/i,
    },
    {
      name: 'default-ignorable inside entity token',
      input:
        '&l\u200bt;nemo-pad&gt;PRIVATE_CF_ENTITY&l\u200bt;/nemo-pad&gt;\nVisible.',
      error: /unsafe|encoded|entity|service/i,
    },
    {
      name: 'NUL control character',
      input: 'Visible\u0000hidden',
      error: /unsafe|control/i,
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

test('output sanitizer diagnostics never repeat secret tag attributes', async (t) => {
  const secret = 'RAW_SECRET_ATTRIBUTE_71941';
  const cases = [
    `<div data-secret="${secret}">Visible?</div>`,
    `</analysis data-secret="${secret}">Visible?`,
    `<think>hidden</analysis data-secret="${secret}">`,
  ];

  for (const [index, input] of cases.entries()) {
    await t.test(`case ${index + 1}`, () => {
      const result = invokeRuntime(['--sanitize-output', '-'], { input });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^Error:/);
      assert.doesNotMatch(result.stderr, new RegExp(secret));
    });
  }
});

test('output sanitizer rejects invalid UTF-8 file input', () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'nemo-sanitizer-utf8-test-'));
  const inputPath = path.join(temporaryRoot, 'invalid.bin');
  try {
    writeFileSync(inputPath, Buffer.from([0xff, 0xfe, 0xfd]));
    const result = invokeRuntime(['--sanitize-output', inputPath]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Error:/);
    assert.match(result.stderr, /valid UTF-8/i);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
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
