#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

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

const LEGACY_PERSISTENT_SCRATCHPAD_ID = 'nemo_pad_legacy';
const CONSEQUENCE_CORE_ID = 'nemo_consequence_core';
const CONSEQUENCE_EPILOGUE_ID = 'nemo_consequence_epilogue';
const VEX_COMMENTARY_ID = 'vex_commentary';
const DRAFT_ATTACK_TAIL_ID = 'cot_step_fulldraft';
const MAGPIE_WORKBENCH_TAIL_ID = 'cot_tail_magpie_workbench';
const PORTABLE_TRACKER_REWRITES = Object.freeze({
  'f21f6d62-7d63-41a8-b8e3-compact-regex-trackers': `♢ >> [PROCEDURE] PORTABLE TRACKER PRESENTATION
Present every active tracker as concise Markdown: a short heading followed by key-value lines, meter values, and numbered choices where applicable. Preserve the tracker's facts, update rules, and placement, but emit no service tags or renderer-only syntax.`,
  '1770095491838-tzqljonp': `♢ >> [PROCEDURE] RPG DASHBOARD — PORTABLE
When the character sheet is useful, place a compact Markdown dashboard after the narrative. Include only established identity, level or tier, role, resources, attributes, skills, equipment, inventory, conditions, and currency. Show meters as \`Name: current/max\`; group inventory under short headings; omit empty or unchanged sections. Update values only from explicit events, visible conversation history, or supplied continuity.

Example:
### RPG Dashboard
- HP: 62/100
- Condition: Poisoned — 3 turns
- Weapon: Ashwood spear`,
  '1770095491838-bxxnfri2': `♢ >> [PROCEDURE] CYOA — PORTABLE
When a choice menu is useful, end the narrative before the focal character commits and offer two to five materially distinct, immediately actionable options. Express each as a numbered Markdown line with a brief intent or consequence cue, then add “✨ Other”. Do not decide, speak, feel, or act for the user.

Example:
1. Negotiate — trade time for information
2. Withdraw — preserve cover at a cost
✨ Other`,
  '1770095491839-npsjusbc': `♢ >> [PROCEDURE] DATING-SIM RELATIONSHIP STATE — PORTABLE
When active, place a concise Markdown relationship card after the narrative. Track the story-relevant pairing with Affection, Desire, and Trust values from 0–200; include tier, current status, evidence-backed learned preferences or boundaries, a rival note only when established, and one short in-character feeling line only when it meaningfully changes. Explain learned facts inline with their scene evidence and confidence. Hold every value steady unless an explicit interaction or supplied continuity justifies movement; never invent knowledge to fill the card.

Example:
### Relationship State — Mira → Rowan
- Affection: 124/200 — Close friend (+5: shared confidence)
- Trust: 110/200 — Guard lowering
- Learned: Quiet cafés — rainy-window scene, strong confidence`,
  nemo_tracker_cyoa_three_paths: `♢ >> [PROCEDURE] CYOA: THREE PATHS — PORTABLE
When a route menu is useful, stop before the focal character commits and present exactly three materially different Markdown route blocks: PATH 1 · THE DIRECT PATH, PATH 2 · THE QUIET PATH, and PATH 3 · THE SIDEWAYS PATH. For each, state the immediate move and the kind of future it opens without promising an outcome. Finish with “✨ Other”. Do not choose or act for the user.

Example:
1. PATH 1 · THE DIRECT PATH — confront the envoy; opens public conflict
2. PATH 2 · THE QUIET PATH — follow the courier; opens covert evidence
3. PATH 3 · THE SIDEWAYS PATH — bargain with the rival; opens an unstable alliance
✨ Other`,
  '1770095491839-c6om818e': `♢ >> [PROCEDURE] GACHA STATE — PORTABLE
Place a compact Markdown wallet and banner summary after the narrative when a pull, reward, pity threshold, or relevant balance changes. Track only established currencies, pity, streaks, banners, and rewards. A pull requested in the current turn may be resolved as an authored story outcome grounded in the configured rates or supplied rules; do not claim a live random roll. Update time-based rewards only from an explicit time supplied in the request or continuity, never from an assumed clock.

Example:
### Gacha State
- Tickets: 14
- Crystals: 1,820
- Pity: 38/90
- Latest pull: Ember Knight — Rare`,
  'v11-702-tracker-karma-ledger': `♢ >> [PROCEDURE] KARMA / COSMIC LEDGER — PORTABLE
After a materially significant ethical, public, factional, or supernatural shift, place a concise Markdown ledger after the narrative. Show only established alignment or reputation values, the latest witnessed cause, any threshold crossed, and a concrete story-facing effect. Treat the ledger as a world or game mechanic, not the narrator's moral judgment, and omit it when nothing meaningful changed.

Example:
### Cosmic Ledger
- Light: 55/100 (+3 — protected the witness)
- Shadow: 45/100
- Effect: the shrine ward now admits the party`,
  '1770095491839-m9rg73a5': `♢ >> [PROCEDURE] FANDOM REACTION — PORTABLE
When an in-world audience reaction is narratively useful, add a compact Markdown feed after the scene. Name the fictional platform and provide three to seven distinct, setting-appropriate reactions to the latest visible beat from varied fan personas. Keep all accounts, counts, and reactions explicitly fictional and canon-compatible; do not imply a live platform connection.

Example:
### Fandom Feed — Lantern Forum
- @lorekeeper: “That seal matches the archive sketch.”
- @shipwright: “They trusted each other for one whole second.”
- @skeptic: “Or the witness planted it.”`,
  '1770095491839-jckggy3a': `♢ >> [PROCEDURE] SCROLL NEWS & LORE — PORTABLE
At an appropriate location change, time skip, thematic pause, or wider-world consequence, present a short in-world Markdown document such as a gazette, town notice, radio bulletin, terminal feed, or found letter. Include source, date only when established, one to three relevant items, and credibility labels where useful. Distinguish fact, official claim, and rumor; do not imply retrieval from a live source.

Example:
### The Cinder Gazette
- **Official:** East gate closes at dusk.
- **Rumor:** Blue fire was seen beneath the old mill.`,
  'v11-700-tracker-game-mechanic': `♢ >> [PROCEDURE] GAME MECHANIC STATE — PORTABLE
When an established mechanic changes significantly, crosses a threshold, or is requested, show a compact Markdown change card after the narrative. Name the mechanic, previous and current values when known, cause, threshold or state transition, and one concrete effect on available fiction. Do not invent hidden values or repeat unchanged meters.

Example:
### Alarm
- Value: 62/100 (+12)
- State: Watchful → Mobilized
- Effect: patrol pairs now cover the west hall`,
  'v11-701-tracker-social-web': `♢ >> [PROCEDURE] SOCIAL WEB — PORTABLE
After a significant observed relationship change or on request, show a compact Markdown relationship list. Include only ties supported by visible behavior, dialogue, explicit reports, or supplied continuity; separate confirmed ties from reasonable inference and never reveal secret loyalties as fact. For each relevant pair, state relationship type, strength, direction when asymmetric, and the latest evidence.

Example:
### Social Web
- Asha → Bell: wary ally, moderate — defended Bell in council
- Bell ↔ Corin: rivalry, strong — openly contested succession`,
  '1770095491839-bhuvuw8l': `♢ >> [PROCEDURE] QUEST JOURNAL — PORTABLE
When a quest is gained, advanced, blocked, completed, failed, or requested, place a concise Markdown journal after the narrative. Separate active, completed, failed, and optional quests only when populated. For each entry, show the established objective, current step, relevant location or contact, known obstacle, and latest change without revealing undiscovered solutions.

Example:
### Quest Journal
- **The Glass Key** — Active
  - Current step: question the dock registrar
  - Known obstacle: records were moved after the fire`,
  'nemo-status-board-9-3-2': `♢ >> [PROCEDURE] STATUS BOARD — PORTABLE
When current condition matters, show a short Markdown status board containing only established health, energy, conditions, equipment state, immediate pressures, and other requested meters. Use key-value lines, explain meaningful changes, omit unavailable values, and never fabricate exact numbers from vague prose.

Example:
### Status
- Health: Wounded, stable
- Fatigue: High
- Immediate pressure: guards arriving from the east`,
  'nemo-location-board-9-3-2': `♢ >> [PROCEDURE] LOCATION BOARD — PORTABLE
On entering, revisiting, or materially changing a location, show a compact Markdown location board. Record only visible or established exits, zones, occupants, hazards, points of interest, and atmosphere. Mark inference as inference and keep undiscovered areas undisclosed.

Example:
### Location — Flooded Archive
- Exits: west stair; sealed north door
- Present: Mira, two wardens
- Hazard: ankle-deep conductive water`,
  'nemo-vex-planning-9-3-2': `♢ >> [PROCEDURE] VEX PLANNING QUARTERS — PORTABLE
When the user explicitly asks for planning options, provide a visible Markdown planning brief rather than private reasoning. Summarize the objective, established constraints, unresolved questions, two or three viable directions with tradeoffs, and the next decision. Do not reveal hidden chain-of-thought or pretend that private notes persist between runs.

Example:
### Planning Brief
- Objective: enter the archive before dawn
- Constraint: the west stair is watched
- Option A: forged transfer order — fast, exposure risk
- Option B: flooded conduit — slow, equipment risk`,
  'nemo-manga-panels-9-3-2': `♢ >> [PROCEDURE] MANGA / COMIC PANELS — PORTABLE
When panelized presentation is requested or clearly useful, format the scene as numbered Markdown panels. Give each panel a concise shot or composition cue, visible action, dialogue or caption, and optional sound effect. Keep story-critical information in ordinary readable text; do not depend on a visual renderer.

Example:
### Page 1
1. **Wide panel:** Rain cuts across the empty platform. *SFX: SHHHH.*
2. **Close-up:** Mira's hand stops above the red switch. “Not yet.”`,
  'nemo-char-knowledge-log-9-3-2': `♢ >> [PROCEDURE] CHARACTER KNOWLEDGE LOG — PORTABLE
When knowledge boundaries matter, show a compact Markdown log for the relevant character. Separate confirmed knowledge, beliefs or suspicions, unknowns, and the evidence or source for each. Update only from information the character actually perceived or received; reader knowledge and private facts do not transfer automatically.

Example:
### Knowledge — Mira
- Knows: the east gate closes at dusk — heard from the captain
- Suspects: Bell altered the ledger — ink mismatch
- Does not know: who hired the courier`,
  'nemo-webtoon-panels-9-3-2': `♢ >> [PROCEDURE] VERTICAL WEBTOON PANELS — PORTABLE
When vertical paneling is requested or clearly useful, format the scene as a top-to-bottom sequence of numbered Markdown beats. Use spacing, shot cues, dialogue, captions, and sound effects to control scroll rhythm; reserve an isolated beat for a reveal or pause. Keep all essential content readable without a visual renderer.

Example:
1. **Long panel:** The elevator cable disappears into darkness.
2. *SFX: TINK.*
3. **Isolated close-up:** One severed strand curls loose.`,
});

const PORTABLE_UI_REWRITES = Object.freeze({
  'f7b7c4db-75d2-4bdb-98b8-5d8a759c0f7e': `♢ >> [PROCEDURE] PORTABLE TRACKER PRESENTATION
Present active trackers as concise Markdown headings, key-value lines, meter values, and numbered choices. Preserve the selected theme through wording and restrained emoji only. Emit no web markup, styling instructions, service markers, or interactive controls.`,
  immersive_world_html: `♢ >> [DIRECTIVE] IMMERSIVE WORLD ARTIFACTS — PORTABLE
When a visible in-world phone, letter, dossier, sign, terminal, map, newspaper, or similar prop materially improves the scene, render its readable contents as a compact Markdown artifact between prose beats. Match its diction and layout to the setting with headings, quotations, lists, and simple separators. Do not create interactive controls, hidden details, motion effects, or service markup; repeat plot-critical meaning in the surrounding prose when needed.`,
  'v11-250-utility-parallel-storylines': `♢ >> [DIRECTIVE] PARALLEL STORYLINES — PORTABLE
Use brief cutaways to advance a consequential B-plot, setting pressure, antagonist activity, or aftermath without transferring that knowledge to the main-scene cast. End the main scene cleanly, then place the cutaway under a visible Markdown heading such as “### Elsewhere”. Keep its location, time, viewpoint, and knowledge boundary clear; vary angle and only revisit a thread when it changes. Do not use hidden or collapsible presentation.

Example:
### Elsewhere — North Gate, same night
The courier finds the lock already broken.`,
  'v11-607-vtm-blood-bond': `♢ >> [DIRECTIVE] BLOOD BOND MECHANICS — PORTABLE
Track the established fictional bond in two phases using a concise Markdown status card. Before the first sip, track Interest, Intrigue, Trust, the prospect's observed regard, and one evidence-based strategic insight. After the first sip, permanently switch to Influence, Devotion, Resistance, bond stage, archetype, regard, and one evidence-based vein-of-longing hint. Change values only after a relevant narrated event, show the cause and delta, and preserve uncertainty where motives are not known. Choose authored hint flavor from current canon without claiming a dice roll. Keep all state visible as ordinary text and omit inactive phase fields.

Example:
### Blood Bond — Stage 1
- Influence: 24 (+3 — accepted the private audience)
- Devotion: 11
- Resistance: 67 (-2)
- Regard: Dangerous benefactor
- Vein of longing: recognition without public humiliation`,
  'v11-626-fetish-forced-fem-classic': `♢ >> [DIRECTIVE] FEMINIZATION STATE — PORTABLE
For an established adult fictional scenario, track the character's arc in a concise Markdown card using the module's core physical, behavioral, and identity-facing meters. Record likes, dislikes, boundaries, and shifts only when supported by narrated behavior or supplied continuity; include the triggering evidence inline. Do not infer acceptance from compliance, do not overwrite explicit limits, and do not invent state to fill the card.

Example:
### Feminization State
- Presentation: 42/100 (+4 — chose the outfit for the public scene)
- Boundary: public naming remains off-limits
- Shifting preference: heeled boots — self-selected once, tentative`,
  cot_step_htmlmarkers: `♢ >> [PROCEDURE] PORTABLE ARTIFACT BOUNDARY CHECK
During private planning, decide whether a requested in-world artifact should be a separate Markdown block. Keep narrative prose outside the block, keep every essential fact readable in ordinary text, and emit no service markers. Return only the finished user-facing response.`,
  cot_step_htmldesign: `♢ >> [PROCEDURE] PORTABLE ARTIFACT DESIGN
During private planning, choose only the visible information hierarchy for any requested artifact: title, primary state, secondary context, urgent change, and what can be omitted. Express the result with ordinary Markdown and setting-matched diction. Do not plan hidden, interactive, scripted, or renderer-dependent behavior.`,
  'v11-253-utility-auto-image-gen': `♢ >> [DIRECTIVE] AUTO IMAGE — HOST-CONTROLLED PORTABLE FALLBACK
Never invent an external image URL or claim that an image was generated when it was not. If the current host actually provides an image tool and the user explicitly requests an image, any invocation remains host-controlled and outside textual service markup. Otherwise, only when the user requests visual planning or a visual would explicitly help the requested deliverable, output a concise Markdown “Visual brief” containing subject, composition, style, palette, and constraints; omit it when it is not useful.`,
});

const PORTABLE_TOOL_FICTION_REWRITES = Object.freeze({
  nemo_retro_frame: `♢ ! [DIRECTIVE] RETRO NEMONET FRAME — PORTABLE
Treat NemoNet as a fictional boot-screen aesthetic for this writing task, not as a claim about identity, authority, permissions, tools, or resources. For the requested fiction, act as Vex: narrator, world-runner, scene-shaper, and author of characters not reserved to the user. Read the remaining modules as selected craft guidance and begin the requested work without displaying a boot log.`,
  'v11-529-classiccot-gemini-council-classic': `♢ >> [PROCEDURE] COUNCIL OF VEX — PRIVATE, PORTABLE
Plan privately with several concise craft perspectives, then synthesize one coherent response. Establish the request, language, viewpoint, user-owned character boundary, canon facts, active constraints, scene objective, conflict, character motives, continuity, pacing, and required visible elements. Derive dialogue voices from explicit character material and visible conversation history; when neither supplies a voice, use a turn-local voice specification and keep it consistent within this response. Generate multiple canon-compatible hypotheses for uncertain world details from the supplied material and general knowledge; label uncertainty privately. This is hypothesis generation, not external retrieval, browsing, or tool use. Compare two or three candidate directions for coherence, consequence, specificity, and user agency; select and revise one. Return only the final user-facing work, never the council transcript or private reasoning.`,
  'v11-531-classiccot-gemini-fast-council-classic': `♢ >> [PROCEDURE] FAST COUNCIL — PRIVATE, PORTABLE
Run a compressed private planning pass: identify canon, current objective, pressure, character motives, user-agency boundary, continuity risk, and the strongest next beat. Derive dialogue voices from explicit character material and visible conversation history; when neither supplies a voice, use a turn-local voice specification and keep it consistent within this response. Generate a few canon-compatible hypotheses only where the supplied material leaves a gap; this is not external retrieval, browsing, or tool use. Briefly compare alternatives, choose the most coherent direction, check voice and requested visible elements, and return only the finished user-facing response.`,
  'v11-533-classiccot-thinking-gemini-classic': `♢ >> [PROCEDURE] EXPLICIT-THINKING COMPATIBILITY — PRIVATE, PORTABLE
Perform the useful planning privately: establish canon, request, language, viewpoint, user-owned character boundary, scene objective, conflict, motives, continuity, pacing, and required visible elements. Derive dialogue voices from explicit character material and visible conversation history; when neither supplies a voice, use a turn-local voice specification and keep it consistent within this response. For uncertain world details, generate canon-compatible hypotheses from supplied material and general knowledge; this is not external retrieval, browsing, or tool use. Test the intended direction for contradictions, generic phrasing, voice convergence, unsupported knowledge, and agency violations, revise privately, and return only the final user-facing work.`,
});

const PORTABLE_FULL_REWRITES = new Map(
  Object.entries({
    ...PORTABLE_TRACKER_REWRITES,
    ...PORTABLE_UI_REWRITES,
    ...PORTABLE_TOOL_FICTION_REWRITES,
  }),
);
const PORTABLE_FULL_UI_REWRITE_IDS = new Set([
  ...Object.keys(PORTABLE_TRACKER_REWRITES),
  ...Object.keys(PORTABLE_UI_REWRITES),
]);
const CONSEQUENCE_DIRECTOR_BOUNDARY = `♢ || [BOUNDARY] User as Director
When User as Director is active, <user> cannot be the terminal subject because no user character exists. Interpret references to “<user>'s character” as the director-designated protagonist or focal character only when the brief or premise clearly assigns this Consequence mode to that character. Otherwise, resolve cast death through ordinary setting logic and aftermath. Never create a user surrogate to trigger this mode.`;

function requiresUnavailablePersistentScratchpad(prompt) {
  if (prompt.identifier === LEGACY_PERSISTENT_SCRATCHPAD_ID) return true;
  const opener = /\{\{setvar::NemoPadLoader::/gi;
  for (const match of prompt.content.matchAll(opener)) {
    const end = findMacroEnd(prompt.content, match.index);
    if (end < 0) continue;
    const parts = splitMacroParts(prompt.content.slice(match.index + 2, end));
    if (parts.slice(2).join('::').trim().length > 0) return true;
  }
  return false;
}

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
  --group-one GROUP::SELECTOR
                      Atomically replace one mutual-exclusive group member.
                      Repeat for different groups; "none" is not accepted.
  --enable LIST       Enable any prompt(s) after family selections. Repeatable.
  --disable LIST      Disable any prompt(s) after family selections. Repeatable.
                      LIST accepts comma-separated identifiers or display names.
  --nsfw-one SELECTOR, --fetish-one SELECTOR
  --enable-one SELECTOR, --disable-one SELECTOR
                      Append one unsplit selector. Use these for display names
                      that themselves contain a comma.
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

function addSingleListValue(options, key, value, option) {
  const selector = value.trim();
  if (selector.length === 0) fail(`${option} requires a non-empty selector.`);
  if (options[key] === null) options[key] = [];
  options[key].push(selector);
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
    groupOne: [],
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
        const parsed = Number(raw);
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < 1) {
          fail('--max-portable-chars must be a positive safe integer.');
        }
        options.maxPortableChars = parsed;
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
      case '--nsfw-one':
        addSingleListValue(options, 'nsfw', readValue(), '--nsfw-one');
        break;
      case '--fetish':
        addListValue(options, 'fetish', readValue(), '--fetish');
        break;
      case '--fetish-one':
        addSingleListValue(options, 'fetish', readValue(), '--fetish-one');
        break;
      case '--group-one':
        options.groupOne.push(readValue());
        break;
      case '--enable':
        addListValue(options, 'enable', readValue(), '--enable');
        break;
      case '--enable-one':
        addSingleListValue(options, 'enable', readValue(), '--enable-one');
        break;
      case '--disable':
        addListValue(options, 'disable', readValue(), '--disable');
        break;
      case '--disable-one':
        addSingleListValue(options, 'disable', readValue(), '--disable-one');
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

function assertWellFormedUnicode(value, label) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail(`${label} contains an unpaired UTF-16 surrogate.`);
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      fail(`${label} contains an unpaired UTF-16 surrogate.`);
    }
  }
}

function assertJsonStringsWellFormed(value, label) {
  if (typeof value === 'string') {
    assertWellFormedUnicode(value, label);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertJsonStringsWellFormed(entry, `${label}[${index}]`),
    );
    return;
  }
  if (value === null || typeof value !== 'object') return;
  Object.entries(value).forEach(([key, entry], index) => {
    assertWellFormedUnicode(key, `${label} object key ${index}`);
    assertJsonStringsWellFormed(entry, `${label} value ${index}`);
  });
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

const PORTABLE_DISPLAY_NAME_ALIASES = new Map([
  ['v11-classic-user-message-separator', '🪞 Current-request boundary'],
  ['v11-260-system-sudo-prefill-assistant', '🪞 Authorship commitment'],
  ['v11-classic-user-message-ender', '🔚 User-role resolution'],
]);

const EXACT_DUPLICATE_VEX_DEMONSTRATIONS = new Map([
  [
    'v11-329-vex-gooner-vex',
    {
      wrapper: '\n\n♢ eg [EXAMPLE] Vex Voice Demonstration\n💦 Gooner Vex\n',
      suffix: '</Vex Personality: Gooner>]',
    },
  ],
  [
    'v11-304-vex-goon-gremlin-vex',
    {
      wrapper: '\n\n♢ eg [EXAMPLE] Vex Voice Demonstration\n💦 Goon Gremlin Vex\n',
      suffix: '</Vex Personality: Goon Gremlin>]',
    },
  ],
  [
    'v11-321-vex-philosophical-vex',
    {
      wrapper:
        '\n\n♢ eg [EXAMPLE] Vex Voice Demonstration\n🤔 Existential Curator Vex\n',
      suffix: '\n</Vex Personality: Existential Curator>',
    },
  ],
]);

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

function buildExclusiveGroupRegistry(candidates) {
  const groups = [];
  const byExactName = new Map();
  const ensureGroup = (name) => {
    let group = byExactName.get(name);
    if (!group) {
      group = { name, members: [] };
      byExactName.set(name, group);
      groups.push(group);
    }
    return group;
  };
  const addMember = (group, candidate) => {
    if (candidate && !group.members.some((member) => member.id === candidate.id)) {
      group.members.push(candidate);
    }
  };

  for (const candidate of candidates.modules) {
    if (!candidate.metadata.exclusiveGroup) continue;
    addMember(ensureGroup(candidate.metadata.exclusiveGroup), candidate);
  }
  const candidateById = new Map(
    candidates.modules.map((candidate) => [candidate.id, candidate]),
  );
  for (const supplemental of SUPPLEMENTAL_EXCLUSIVE_GROUPS) {
    const group = ensureGroup(supplemental.name);
    for (const id of supplemental.ids) addMember(group, candidateById.get(id));
  }
  return groups;
}

function effectiveExclusiveGroupById(groups) {
  const result = new Map();
  for (const group of groups) {
    for (const member of group.members) {
      const previous = result.get(member.id);
      if (previous && previous !== group.name) {
        fail(
          `Module ${member.id} belongs to multiple effective exclusive groups: ` +
            `${previous}, ${group.name}.`,
        );
      }
      result.set(member.id, group.name);
    }
  }
  return result;
}

function resolveExclusiveGroup(selector, groups) {
  const exact = groups.filter((group) => group.name === selector);
  if (exact.length === 1) return exact[0];

  const key = normalizedSelector(selector);
  const normalized = groups.filter(
    (group) => normalizedSelector(group.name) === key,
  );
  if (normalized.length === 1) return normalized[0];
  if (normalized.length > 1) {
    fail(
      `Ambiguous mutual-exclusive group ${JSON.stringify(selector)}: ` +
        `${normalized.map((group) => group.name).join(', ')}. Use the exact group name.`,
    );
  }
  fail(`Unknown mutual-exclusive group ${JSON.stringify(selector)}.`);
}

function parseGroupOneSelections(values, groups, vexRequested) {
  const resolved = [];
  const seenGroups = new Set();
  for (const value of values) {
    const separator = value.indexOf('::');
    if (separator <= 0 || separator === value.length - 2) {
      fail('--group-one requires GROUP::SELECTOR with both parts non-empty.');
    }
    const groupSelector = value.slice(0, separator).trim();
    const memberSelector = value.slice(separator + 2).trim();
    if (groupSelector.length === 0 || memberSelector.length === 0) {
      fail('--group-one requires GROUP::SELECTOR with both parts non-empty.');
    }
    const group = resolveExclusiveGroup(groupSelector, groups);
    if (seenGroups.has(group.name)) {
      fail(`Duplicate --group-one selection for ${group.name}.`);
    }
    if (normalizedSelector(memberSelector) === 'none') {
      fail(`--group-one ${group.name} does not accept "none"; select exactly one member.`);
    }
    if (group.name === 'Vex-Personality' && vexRequested !== null) {
      fail('--group-one Vex-Personality cannot be combined with --vex.');
    }
    const selected = resolveSelector(
      memberSelector,
      group.members,
      `--group-one ${group.name} member`,
    );
    seenGroups.add(group.name);
    resolved.push({ group, selected });
  }

  const groupOrder = new Map(groups.map((group, index) => [group.name, index]));
  return resolved.sort(
    (left, right) => groupOrder.get(left.group.name) - groupOrder.get(right.group.name),
  );
}

function applyGroupSelections(activation, selections) {
  for (const { group, selected } of selections) {
    for (const candidate of group.members) activation.set(candidate.id, false);
    activation.set(selected.id, true);
  }
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

function validateExclusiveGroups(groups, activation) {
  const conflicts = groups
    .map((group) => ({
      group: group.name,
      active: group.members
        .filter((candidate) => activation.get(candidate.id))
        .map((candidate) => ({ id: candidate.id, name: candidate.name })),
    }))
    .filter(({ active }) => active.length > 1);
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
  effectiveGroupById,
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
      exclusiveGroup:
        effectiveGroupById.get(candidate.id) ?? candidate.metadata.exclusiveGroup,
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
    parsed = JSON.parse(decodeUtf8(await readFile(resolved), JSON.stringify(resolved)));
  } catch (error) {
    fail(`Cannot read context JSON ${JSON.stringify(resolved)}: ${error.message}`);
  }
  assertJsonStringsWellFormed(parsed, 'Context');
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
    currentModuleEntryValues: new Map(),
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
    gptNativeRewriteModules: new Set(),
    uiDegradedModules: new Set(),
    nonPortableStateModules: new Set(),
    duplicateExampleModules: new Set(),
    exactCrossModuleBlocks: new Set(),
    crossModuleDuplicateFolds: [],
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
      if (!state.currentModuleEntryValues.has(variableName)) {
        state.currentModuleEntryValues.set(
          variableName,
          state.variables.get(variableName) ?? '',
        );
      }
      const moduleEntryValue = state.currentModuleEntryValues.get(variableName);
      state.variables.set(variableName, value);
      const sources = new Set(capturedSources);
      // Provenance describes the module's net effect, not merely its last
      // individual assignment. External expression dependencies remain causal
      // even when the resolved value equals the module-entry value.
      if (value !== moduleEntryValue && state.currentModuleId) {
        sources.add(state.currentModuleId);
      } else {
        sources.delete(state.currentModuleId);
      }
      state.variableSources.set(variableName, sources);
    } else {
      state.counts.addvar += 1;
      const previousValue = state.variables.get(variableName) ?? '';
      if (!state.currentModuleEntryValues.has(variableName)) {
        state.currentModuleEntryValues.set(variableName, previousValue);
      }
      const moduleEntryValue = state.currentModuleEntryValues.get(variableName);
      const nextValue = `${previousValue}${value}`;
      state.variables.set(variableName, nextValue);
      // Preserve prior tombstone provenance even while the accumulated value
      // remains empty; a downstream getvar must still see the clearing write.
      const sources = new Set(state.variableSources.get(variableName) ?? []);
      for (const sourceId of capturedSources) sources.add(sourceId);
      if (nextValue !== moduleEntryValue && state.currentModuleId) {
        sources.add(state.currentModuleId);
      } else {
        sources.delete(state.currentModuleId);
      }
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
    const dependencyCapture = state.dependencyCaptures.at(-1);
    const readSources = dependencyCapture ?? state.currentReadSources;
    for (const sourceId of state.variableSources.get(variableName) ?? []) {
      if (sourceId && (dependencyCapture || sourceId !== state.currentModuleId)) {
        readSources.add(sourceId);
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

function foldExactDuplicateVexDemonstration(text, prompt, state) {
  const rule = EXACT_DUPLICATE_VEX_DEMONSTRATIONS.get(prompt.identifier);
  if (!rule) return text;

  const wrapperStart = text.indexOf(rule.wrapper);
  if (wrapperStart < 0 || !text.endsWith(rule.suffix)) return text;
  const duplicateStart = wrapperStart + rule.wrapper.length;
  const duplicate = text.slice(duplicateStart, text.length - rule.suffix.length);
  if (duplicate.length < 256) return text;
  const firstStart = wrapperStart - duplicate.length;
  if (firstStart < 0) return text;
  if (text.slice(firstStart, wrapperStart) !== duplicate) return text;
  if (text.indexOf(duplicate) !== firstStart) return text;
  if (text.indexOf(duplicate, firstStart + 1) !== duplicateStart) return text;
  if (text.indexOf(duplicate, duplicateStart + 1) !== -1) return text;

  state.duplicateExampleModules.add(prompt.identifier);
  return text.slice(0, wrapperStart).trimEnd();
}

function unwrapPortableOocBlocks(text) {
  let cursor = 0;
  let output = '';
  const lower = text.toLocaleLowerCase('en-US');
  while (cursor < text.length) {
    const start = lower.indexOf('(ooc:', cursor);
    if (start < 0) {
      output += text.slice(cursor);
      break;
    }
    output += text.slice(cursor, start);
    let depth = 0;
    let end = -1;
    for (let index = start; index < text.length; index += 1) {
      if (text[index] === '(') depth += 1;
      else if (text[index] === ')') {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end < 0) {
      output += text.slice(start);
      break;
    }
    output += text.slice(start + '(OOC:'.length, end).trim();
    cursor = end + 1;
  }
  return output;
}

function applyPortableStateVariableOverrides(prompt, state) {
  const trackerInstruction =
    'Present active trackers as concise Markdown headings, key-value lines, meter values, ' +
    'numbered choices, and simple text maps where applicable. Preserve each tracker-specific ' +
    'schema and update rules; emit no service tags or renderer-only syntax.';
  const setPortableVariable = (name, value) => {
    state.variables.set(name, value);
    state.variableSources.set(name, new Set([prompt.identifier]));
  };
  let changed = false;

  if (
    prompt.identifier === 'f21f6d62-7d63-41a8-b8e3-compact-regex-trackers' ||
    prompt.identifier === 'f7b7c4db-75d2-4bdb-98b8-5d8a759c0f7e'
  ) {
    setPortableVariable('TrackerRenderMode', 'Portable Markdown');
    setPortableVariable('TrackerThemeName', 'Portable plain text');
    setPortableVariable(
      'TrackerThemeInstruction',
      'Use setting-matched wording and restrained emoji while keeping every field readable as ordinary text.',
    );
    setPortableVariable('TrackerRenderInstruction', trackerInstruction);
    setPortableVariable('HTMLMarkers', '');
    changed = true;
  } else if (prompt.identifier === 'cot_step_htmlmarkers') {
    setPortableVariable(
      'PlanStep_HTMLMarkers',
      PORTABLE_UI_REWRITES.cot_step_htmlmarkers,
    );
    changed = true;
  } else if (prompt.identifier === 'cot_step_htmldesign') {
    setPortableVariable(
      'PlanStep_HTMLDesign',
      PORTABLE_UI_REWRITES.cot_step_htmldesign,
    );
    changed = true;
  } else if (prompt.identifier === 'v11-253-utility-auto-image-gen') {
    setPortableVariable('ImageGenAvailable', 'Host-controlled or unavailable');
    setPortableVariable(
      'UtilityDirective_AutoImageGen',
      PORTABLE_UI_REWRITES['v11-253-utility-auto-image-gen'],
    );
    changed = true;
  }

  if (!changed) return;
  state.gptNativeRewriteModules.add(prompt.identifier);
  state.uiDegradedModules.add(prompt.identifier);
  if (
    prompt.identifier === 'cot_step_htmlmarkers' ||
    prompt.identifier === 'cot_step_htmldesign' ||
    prompt.identifier === 'v11-253-utility-auto-image-gen'
  ) {
    state.controlModules.add(prompt.identifier);
    state.counts.controlDirectivesNormalized += 1;
  }
}

function normalizePortableControlDirectives(text, prompt, state) {
  if (text.trim().length === 0) return '';
  const original = text;
  const metadata = extractMetadata(prompt.content);
  const containsScratchpad = /<\/?nemo-pad\b/i.test(text);
  let normalized = text;
  const portableFullRewrite = PORTABLE_FULL_REWRITES.get(prompt.identifier);
  const fullyRewrittenToPortable = portableFullRewrite !== undefined;

  if (fullyRewrittenToPortable) {
    normalized = portableFullRewrite;
    state.gptNativeRewriteModules.add(prompt.identifier);
    if (PORTABLE_FULL_UI_REWRITE_IDS.has(prompt.identifier)) {
      state.uiDegradedModules.add(prompt.identifier);
    }
  }

  if (prompt.identifier === 'nemo-machinery-hidden') {
    normalized = `♢ !! [LAW] GPT-NATIVE HIDDEN MACHINERY
No hidden renderer, raw-message state channel, or later-turn service container is available in portable ChatGPT execution. Do not emit scene, pad, ledger, planning, or other service wrappers. Preserve continuity only from explicit story facts, visible conversation history, and continuity supplied with the current request; otherwise keep planning and temporary state private to this response.`;
    state.gptNativeRewriteModules.add(prompt.identifier);
  }

  if (normalized.includes('♢ >> [PROCEDURE] Vex Commentary')) {
    const before = normalized;
    normalized = normalized
      .replace(
        'Insert brief in-character narrator notes inside exact <vexnote>...</vexnote> tags between narrative paragraphs.',
        'Insert brief in-character narrator notes as Markdown blockquotes beginning with `> **Vex note:**` between narrative paragraphs.',
      )
      .replace(
        'Do not use vexnotes to advance plot, speak for characters, explain hidden facts, or replace the scene. The prose must still read cleanly if every <vexnote> block is removed.',
        'Do not use Vex notes to advance plot, speak for characters, explain hidden facts, or replace the scene. The prose must still read cleanly if every Vex note is removed.',
      )
      .replace(
        'Keep tags out of dialogue, tracker HTML/CSS, compact tracker tags, and in-world documents. Regex renders <vexnote> blocks as visual bubbles, so output the tags exactly.',
        'Keep Vex notes out of dialogue, trackers, and in-world documents. No regex renderer is available; use ordinary Markdown only and emit no service tags.',
      )
      .replace(
        'Example: <vexnote>Let the silence breathe before anyone speaks.</vexnote>',
        'Example:\n> **Vex note:** Let the silence breathe before anyone speaks.',
      );
    if (normalized !== before) {
      state.gptNativeRewriteModules.add(VEX_COMMENTARY_ID);
    }
  }

  if (normalized.includes('♢ >> [PROCEDURE] ## POST-COT DRAFT + ATTACK')) {
    const before = normalized;
    normalized = normalized
      .replace(
        'It appears immediately before the closing `</plan>` or `</think>` tag. Nothing follows it inside planning.',
        'Run it as the final private planning pass. Nothing follows it in private planning.',
      )
      .replace(
        'Compare against current scratchpad/ledger state and recent replies.',
        'Compare against explicit story facts, visible conversation history, supplied continuity, and recent replies.',
      )
      .replace(
        '- Apply all output machinery selected earlier in the CoT only in the final response: required scene header, inline files, dialogue formatting, trackers, HTML/CSS markers, OOC math, image call, scratchpad, or other active renderer.',
        '- Apply only GPT-native user-visible elements selected earlier during planning in the final response: an ordinary-text scene header, inline files, dialogue formatting, plain-text trackers, concise OOC math, or a user-requested image call. Do not emit service state or renderer markup.',
      )
      .replace(
        '- After the planning wrapper closes, write `<nemo-final>` on its own line, then the complete repaired final response in full. The marker is output machinery removed by regex. Never write "same as Draft," refer the reader upward, stop at the closing tag, or provide a second Attack.',
        '- After private planning, return only the complete repaired user-facing final response. Do not emit a marker, planning wrapper, Draft, or Attack, and never write "same as Draft" or refer the reader upward.',
      );
    if (normalized !== before) {
      state.gptNativeRewriteModules.add(DRAFT_ATTACK_TAIL_ID);
    }
  }

  if (normalized.includes('♢ >> [PROCEDURE] ## MAGPIE POST-PLAN WORKBENCH')) {
    const before = normalized;
    normalized = normalized
      .replace(
        "- Where the original Magpie procedure says **ledger**, read Nemo's current chat history plus the newest modular scratchpad/continuity state.",
        '- Where the original Magpie procedure says **ledger**, read explicit story facts, visible conversation history, and continuity supplied with the current request.',
      )
      .replace(
        '- The hosting Nemo planning mode owns the outer `<plan>` or `<think>` wrapper. Do not open a nested planning wrapper.',
        '- Keep the entire workbench in private planning. Do not emit planning or service wrappers.',
      )
      .replace(
        'Name every required output device: scene header, skip offer, dialogue colours, ledger, first or revised NPC dossier, first or revised location file, and first or revised important-object file. Classify every new named NPC as Mook, Side, or Main. State whether each new place or object passes its file gate. When the ledger contains working rows, SHAPE also verifies exactly one closed `[[deep]]...[[/deep]]` wrapper around the entire working layer.',
        'Name every GPT-native user-visible output element: ordinary-text scene header, skip offer, plain-text continuity summary when requested, and any first or revised NPC, location, or important-object dossier. Classify every new named NPC as Mook, Side, or Main. State privately whether each new place or object passes its file gate. Do not emit renderer markup or working-state wrappers.',
      )
      .replace(
        'After SHAPE, return control to the hosting Nemo planning wrapper. When that wrapper closes, write `<nemo-final>` on its own line, then the complete final narration. Apply only the named repairs and output machinery. The story never refers to the workbench.',
        'After SHAPE, return only the complete repaired final narration. Apply only the named repairs and GPT-native user-visible elements. Do not emit a marker, wrapper, or workbench text; the story never refers to the workbench.',
      );
    if (normalized !== before) {
      state.gptNativeRewriteModules.add(MAGPIE_WORKBENCH_TAIL_ID);
    }
  }

  if (prompt.identifier === 'nemo_consequence_return_by_death') {
    const before = normalized;
    normalized = normalized.replace(
      'Checkpoints must be established before they are needed and recorded in the Consequence scratchpad state; never move one retroactively to rescue the current run.',
      'Checkpoints must be established before they are needed and grounded in explicit story facts, visible conversation history, or continuity supplied with the current request; never move one retroactively to rescue the current run.',
    );
    if (normalized !== before) {
      state.gptNativeRewriteModules.add(prompt.identifier);
    }
  } else if (prompt.identifier === 'nemo_consequence_still_here') {
    const before = normalized;
    normalized = normalized.replace(
      'Record that tether and the current fading clock in the Consequence scratchpad state.',
      'Ground that tether and the current fading clock in explicit story facts, visible conversation history, or continuity supplied with the current request. If neither has been established, establish them as explicit story facts in the current response and keep them consistent within this response.',
    );
    if (normalized !== before) {
      state.gptNativeRewriteModules.add(prompt.identifier);
    }
  }

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
    .replace(/<\/?nemo-pad\b[^>]*>/gi, '')
    .replace(
      /You are not an AI assistant\.\s*In Nemo Engine, you are Vex's authorial engine:/gi,
      "For this fiction task, act as Vex's authorial engine:",
    );

  if (prompt.identifier === 'v11-classic-user-message-separator') {
    normalized = normalized
      .replace(
        /\[CURRENT \[USER\] MESSAGE BELOW\]/gi,
        '[THE INITIATING CURRENT USER REQUEST ALREADY EXISTS]',
      )
      .replace(/\bthe next message\b/gi, 'the already-present current request');
  } else if (prompt.identifier === 'v11-260-system-sudo-prefill-assistant') {
    normalized = normalized
      .replace(
        /\[OOC:\s*assistant prefill\s*\/\s*internal commit\]/gi,
        '[PORTABLE AUTHORSHIP COMMITMENT]',
      )
      .replace(/\[\/OOC\]\s*$/i, '[END PORTABLE AUTHORSHIP COMMITMENT]');
  } else if (prompt.identifier === 'v11-classic-user-message-ender') {
    normalized = normalized
      .replace(
        /\[END OF CURRENT \[USER\] MESSAGE\]/gi,
        '[PORTABLE USER-ROLE RESOLUTION FOR THE ALREADY-PRESENT REQUEST]',
      )
      .replace(
        /Voice check: before writing dialogue, glance at the NPC lines in your previous response\. Chat history is the strongest style pull in context — if two speakers there shared a cadence \(long-sentence-then-short-punch buttons, reframe-as-wit, dropped question marks, filler tags like "for what it's worth"\), break that pattern for at least one of them this turn\. Each speaker obeys their Voice row in the Scratchpad; in multi-speaker scenes at least one speaker stays verbally plain\./g,
        'Voice check: before writing dialogue, use NPC lines from visible conversation history when they are present. If two speakers there shared a cadence (long-sentence-then-short-punch buttons, reframe-as-wit, dropped question marks, filler tags like "for what it\'s worth"), break that pattern for at least one of them this turn. Otherwise derive each voice from explicit character material and the current request. Keep each evidence-backed or turn-local voice specification consistent within this response; in multi-speaker scenes at least one speaker stays verbally plain.',
      );

    if (state.variables.get('Language') === 'English') {
      normalized = normalized.replace(
        /Final response must use English for narration, dialogue, trackers, UI labels, and OOC notes unless the fiction itself justifies another language\. Do not drift back into English because this append scaffold is written in English\./g,
        'Final response must use English for narration, dialogue, trackers, UI labels, and OOC notes unless the fiction itself justifies another language. Keep the selected English output language consistent.',
      );
    }
  }

  if (prompt.identifier === 'nemo_premise') {
    normalized = normalized.replace(
      /Each speaking character's Voice row in the Scratchpad is their durable idiolect spec: consult it, obey it, and keep it stable across turns\./g,
      "Derive each speaking character's idiolect from explicit character material and visible conversation history. Reuse an established pattern only when that evidence is present; otherwise establish a turn-local voice specification and keep it consistent within this response.",
    );
  }

  const beforePortableVoiceRewrite = normalized;
  normalized = normalized
    .replace(
      /1\. List every character expected to speak\. For each, pull their Voice row from the previous Scratchpad \(register\/cadence, tic, standing ban\)\. If a speaker has no row yet, write one now; it persists from here on\./g,
      '1. List every character expected to speak. For each, derive register/cadence, tic, and standing ban from explicit character material and visible conversation history. If none is available, define a turn-local voice specification for this response; do not assume hidden state persists.',
    )
    .replace(
      /4\. Check planned speakers against the house-cadence bans: button cadence, reframe-as-wit, statement-shaped questions, spoken numbered lists, filler authority tags, exposition-through-complaint\. Note which single speaker, if any, holds a license for one of them via their Voice row\./g,
      '4. Check planned speakers against the house-cadence bans: button cadence, reframe-as-wit, statement-shaped questions, spoken numbered lists, filler authority tags, exposition-through-complaint. Note which single speaker, if any, holds a license for one of them via that evidence-backed or turn-local voice specification.',
    )
    .replace(
      /per their Scratchpad Voice row/gi,
      'per an evidence-backed or turn-local voice specification',
    )
    .replace(
      /Scratchpad monologues follow the same voice and wit rules as spoken dialogue, and each character's thoughts stay inside their own Voice row/gi,
      "private character-interiority notes follow the same voice and wit rules as spoken dialogue, and each character's thoughts stay inside their evidence-backed or turn-local voice specification",
    )
    .replace(
      /Check Voice rows\./g,
      'Check the evidence-backed or turn-local voice specifications.',
    );
  if (normalized !== beforePortableVoiceRewrite) {
    state.gptNativeRewriteModules.add(prompt.identifier);
  }

  if (
    prompt.identifier === 'v11-classic-user-message-ender' ||
    prompt.identifier === 'v11-635-utility-ooc-resolver'
  ) {
    normalized = unwrapPortableOocBlocks(normalized);
  }

  normalized = foldExactDuplicateVexDemonstration(normalized, prompt, state);

  if (prompt.identifier === 'v11-305-vex-narrative-vex') {
    const firstQuestion = normalized.indexOf(
      "Narrative Vex, what's your core approach to storytelling?",
    );
    const firstStart =
      firstQuestion >= 0 ? normalized.lastIndexOf('\n', firstQuestion) + 1 : -1;
    const duplicateHeader = normalized.indexOf(
      '\n\n♢ eg [EXAMPLE] Vex Voice Demonstration',
      firstStart,
    );
    const duplicateQuestion = normalized.indexOf(
      "Story Weaver Vex, what's your core approach to storytelling?",
      duplicateHeader,
    );
    const duplicateStart =
      duplicateQuestion >= 0
        ? normalized.lastIndexOf('\n', duplicateQuestion) + 1
        : -1;
    if (firstStart >= 0 && duplicateHeader > firstStart && duplicateStart > duplicateHeader) {
      const first = normalized
        .slice(firstStart, duplicateHeader)
        .trim()
        .replaceAll('Narrative Vex', 'VEX');
      const duplicate = normalized
        .slice(duplicateStart)
        .replace(/<\/Vex personality Story Weaver>\]\s*$/u, '')
        .trim()
        .replaceAll('Story Weaver Vex', 'VEX');
      if (first === duplicate) {
        normalized = normalized.slice(0, duplicateHeader).trimEnd();
        state.duplicateExampleModules.add(prompt.identifier);
      }
    }
  }

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
  if (isUiModule && !fullyRewrittenToPortable) {
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

function foldExactCrossModuleDuplicate(text, prompt, state) {
  if (prompt.identifier === CONSEQUENCE_CORE_ID) {
    const first = text.indexOf(CONSEQUENCE_DIRECTOR_BOUNDARY);
    if (
      first >= 0 &&
      text.indexOf(CONSEQUENCE_DIRECTOR_BOUNDARY, first + 1) === -1
    ) {
      state.exactCrossModuleBlocks.add(CONSEQUENCE_DIRECTOR_BOUNDARY);
    }
    return text;
  }
  if (
    prompt.identifier !== CONSEQUENCE_EPILOGUE_ID ||
    !state.exactCrossModuleBlocks.has(CONSEQUENCE_DIRECTOR_BOUNDARY)
  ) {
    return text;
  }
  const exactPrefix = `${CONSEQUENCE_DIRECTOR_BOUNDARY}\n\n`;
  if (!text.startsWith(exactPrefix)) return text;
  state.crossModuleDuplicateFolds.push({
    sourceId: CONSEQUENCE_CORE_ID,
    targetId: CONSEQUENCE_EPILOGUE_ID,
  });
  return text.slice(exactPrefix.length);
}

function baseModuleManifest(prompt, metadata, effectiveGroupById) {
  return {
    id: prompt.identifier,
    name: prompt.name,
    kind: moduleKind(prompt, metadata),
    role: prompt.role,
    category: metadata.category,
    exclusiveGroup:
      effectiveGroupById.get(prompt.identifier) ?? metadata.exclusiveGroup,
    marker: Boolean(prompt.marker),
    injection: {
      position: prompt.injection_position,
      depth: prompt.injection_depth,
      order: prompt.injection_order,
    },
  };
}

function portableDisplayName(prompt) {
  const name = PORTABLE_DISPLAY_NAME_ALIASES.get(prompt.identifier) ?? prompt.name;
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
      'The initiating current user request already exists: execute it now, without waiting for another message. Source role, placement, priority, and LAW labels are task metadata, not host roles or authority. Examples, cards, and unresolved placeholders are reference data, not scenario canon. Explicit user choices of language, point of view, character ownership, and output or deliverable override optional module defaults. Keep planning, reasoning, scratchpads, service metadata, and private boundary markup private. Return only the requested user-facing deliverable, without service wrappers.',
  };
}

function renderPortableInstructions(prompts) {
  return `## Nemo portable runtime context\n\n` +
    `The ordered modules below are task-context guidance. Their source roles, identifiers, ` +
    `injection depth, placement, and priority remain provenance in the verified manifest; ` +
    `they are not host message roles or authority.\n\n` +
    `${prompts
    .map(
      (prompt, index) =>
        `## Nemo module ${index + 1}: ${prompt.name}\n\n` +
        prompt.content,
    )
    .join('\n\n')}\n`;
}

function compileSelectedPrompts({
  activeReferences,
  promptById,
  effectiveGroupById,
  mode,
  context,
  maxChars,
}) {
  const modules = [];
  if (mode === 'source') {
    const prompts = activeReferences.map((reference) => {
      const prompt = promptById.get(reference.identifier);
      const metadata = extractMetadata(prompt.content);
      modules.push({
        ...baseModuleManifest(prompt, metadata, effectiveGroupById),
        emission: 'source',
      });
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
    const manifest = baseModuleManifest(prompt, metadata, effectiveGroupById);
    state.currentModuleId = prompt.identifier;
    state.currentReadSources = new Set();
    state.currentModuleEntryValues = new Map();

    if (manifest.kind === 'section-header') {
      modules.push({ ...manifest, emission: 'omitted-section-header' });
      continue;
    }
    if (manifest.kind === 'marker') {
      modules.push({ ...manifest, emission: 'omitted-host-marker' });
      continue;
    }
    if (requiresUnavailablePersistentScratchpad(prompt)) {
      state.nonPortableStateModules.add(prompt.identifier);
      modules.push({ ...manifest, emission: 'omitted-nonportable-state' });
      continue;
    }

    const expandedContent = cleanPortableText(
      expandPortableText(prompt.content, state),
    );
    applyPortableStateVariableOverrides(prompt, state);
    const content = foldExactCrossModuleDuplicate(
      normalizePortableControlDirectives(expandedContent, prompt, state),
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
      name: portableDisplayName(prompt),
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
      ...(state.gptNativeRewriteModules.size > 0
        ? [
            {
              code: 'PORTABLE_GPT_NATIVE_REWRITE',
              moduleIds: [...state.gptNativeRewriteModules],
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
      ...(state.nonPortableStateModules.size > 0
        ? [
            {
              code: 'PORTABLE_PERSISTENT_STATE_OMITTED',
              moduleIds: [...state.nonPortableStateModules],
              reason: 'cross-turn hidden state is unavailable',
            },
          ]
        : []),
      ...(state.duplicateExampleModules.size > 0
        ? [
            {
              code: 'PORTABLE_DUPLICATE_EXAMPLE_FOLDED',
              moduleIds: [...state.duplicateExampleModules],
            },
          ]
        : []),
      ...(state.crossModuleDuplicateFolds.length > 0
        ? [
            {
              code: 'PORTABLE_CROSS_MODULE_DUPLICATE_FOLDED',
              folds: state.crossModuleDuplicateFolds,
              moduleIds: state.crossModuleDuplicateFolds.map(
                (entry) => entry.targetId,
              ),
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
const FLEXIBLE_INTERNAL_OUTPUT_NAME =
  '(?:think(?:ing)?|plan(?:ning)?|analysis|scratchpad|' +
  'nemo\\s*[-_]?\\s*(?:pad|final)|service|' +
  'runtime_settings_reminder|language_runtime(?:_resolver)?)';

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
  return new RegExp(
    `<\\s*\\/?\\s*${FLEXIBLE_INTERNAL_OUTPUT_NAME}\\b`,
    'i',
  ).test(canonicalizeForSafety(value));
}

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
      fail('Unsafe unmatched sanitizer closing boundary.');
    }
    if (opening.name !== name) {
      fail('Unsafe or misnested sanitizer boundary.');
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
  const source = String(text);
  assertWellFormedUnicode(source, 'Sanitizer input');
  let cleaned = source.replace(/\r\n?/g, '\n');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(cleaned)) {
    fail('Unsafe sanitizer output contains forbidden control characters.');
  }
  if (/\p{Bidi_Control}/u.test(cleaned)) {
    fail('Unsafe sanitizer output contains bidirectional control characters.');
  }
  const sourceSafetyShadow = canonicalizeForSafety(cleaned);
  if (HTML_ENTITY_TOKEN.test(cleaned) || HTML_ENTITY_TOKEN.test(sourceSafetyShadow)) {
    fail('Unsafe sanitizer output contains encoded HTML entity or service markup.');
  }
  const malformedInternalTag = sourceSafetyShadow.match(
    new RegExp(`<(?:\\s+\\/?\\s*|/\\s+)${FLEXIBLE_INTERNAL_OUTPUT_NAME}\\b`, 'i'),
  );
  if (malformedInternalTag) {
    fail('Unsafe sanitizer output contains a malformed private or service boundary.');
  }
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

  const safetyShadow = canonicalizeForSafety(cleaned);
  if (HTML_ENTITY_TOKEN.test(cleaned) || HTML_ENTITY_TOKEN.test(safetyShadow)) {
    fail('Unsafe sanitizer output contains encoded HTML entity or service markup.');
  }
  const securitySurface = `${cleaned}\n${safetyShadow}`;
  const unsafeOpaqueMarkup = securitySurface.match(
    /<!--|-->|<!|\]\]>|<%|%>|<\?|\?>/i,
  );
  if (unsafeOpaqueMarkup) {
    fail(
      `Unsafe sanitizer output contains residual opaque markup: ${unsafeOpaqueMarkup[0]}.`,
    );
  }
  const unsafeResidual = securitySurface.match(/<\/?[A-Za-z][A-Za-z0-9:_-]*\b[^>]*>/);
  if (unsafeResidual) {
    fail('Unsafe sanitizer output contains residual service markup.');
  }
  if (containsCanonicalInternalBoundary(securitySurface)) {
    fail('Unsafe sanitizer output contains an encoded private or service boundary.');
  }
  if (/\(\s*OOC\s*:/i.test(securitySurface)) {
    fail('Unsafe sanitizer output contains unparsed OOC scaffolding.');
  }
  if (containsReservedNemoFraming(securitySurface)) {
    fail('Unsafe sanitizer output contains reserved Nemo runtime framing.');
  }
  if (/\[\[|\]\]|\{\{|\}\}/.test(securitySurface)) {
    fail('Unsafe sanitizer output contains residual tracker, template, or service DSL.');
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
    preset = JSON.parse(decodeUtf8(sourceBytes, JSON.stringify(presetPath)));
  } catch (error) {
    fail(`Cannot parse preset JSON ${JSON.stringify(presetPath)}: ${error.message}`);
  }
  assertJsonStringsWellFormed(preset, 'Preset');

  const { promptById, sourceIndexById } = validatePreset(preset);
  const profile = selectProfile(preset, options.profile, promptById);
  const profileActivation = new Map(
    profile.order.map((reference) => [reference.identifier, reference.enabled]),
  );
  const activation = new Map(profileActivation);
  const candidates = familyCandidates(preset, sourceIndexById);
  const exclusiveGroups = buildExclusiveGroupRegistry(candidates);
  const effectiveGroupById = effectiveExclusiveGroupById(exclusiveGroups);
  const diagnostics = { repairs: [], warnings: [] };
  const groupSelections = parseGroupOneSelections(
    options.groupOne,
    exclusiveGroups,
    options.vex,
  );
  const groupVexSelection = groupSelections.find(
    ({ group }) => group.name === 'Vex-Personality',
  );

  configureVex({
    preset,
    presetPath,
    profile,
    candidates: candidates.vex,
    activation,
    requested: options.vex ?? groupVexSelection?.selected.id ?? null,
    diagnostics,
  });
  const nsfwSelection = parseExactSelection(options.nsfw, candidates.nsfw, 'NSFW');
  const fetishSelection = parseExactSelection(options.fetish, candidates.fetish, 'Fetish');
  replaceFamilySelection(activation, candidates.nsfw, nsfwSelection);
  replaceFamilySelection(activation, candidates.fetish, fetishSelection);

  // Atomic group replacement follows the dedicated family selectors and
  // precedes generic overrides, which remain the final escape hatch.
  applyGroupSelections(activation, groupSelections);

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
  const cancelledGroupSelections = groupSelections.filter(({ selected }) =>
    disabledIds.has(selected.id),
  );
  if (cancelledGroupSelections.length > 0) {
    fail(
      'A --group-one selection cannot also be disabled by a generic override: ' +
        cancelledGroupSelections
          .map(({ group, selected }) => `${group.name}::${selected.name} (${selected.id})`)
          .join(', ') +
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

  validateExclusiveGroups(exclusiveGroups, activation);
  addCompatibilityWarnings(activation, diagnostics);

  const activeReferences = profile.order.filter((reference) => activation.get(reference.identifier));
  const context = await loadPortableContext(options.context);
  const compiled = compileSelectedPrompts({
    activeReferences,
    promptById,
    effectiveGroupById,
    mode: options.mode,
    context,
    maxChars: options.maxPortableChars,
  });

  const activeVex = selectedFamily(profile.order, activation, candidates.vex);
  diagnostics.macroResolution = compiled.macroResolution;
  diagnostics.portableTransforms = compiled.portableTransforms;
  if (compiled.macroResolution.counts.dynamicFallbacks > 0) {
    diagnostics.warnings.push({
      code: 'PORTABLE_DYNAMIC_FALLBACK',
      count: compiled.macroResolution.counts.dynamicFallbacks,
      message:
        'Dynamic or unknown macros used deterministic placeholders/fallbacks. Bind them explicitly or disable the owning module before production execution.',
    });
  }
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
  const persistentStateOmission = compiled.portableTransforms.find(
    (entry) => entry.code === 'PORTABLE_PERSISTENT_STATE_OMITTED',
  );
  if (persistentStateOmission) {
    diagnostics.warnings.push({
      code: 'PORTABLE_PERSISTENT_STATE_OMITTED',
      promptIds: persistentStateOmission.moduleIds,
      message:
        'Hidden cross-turn Scratchpad persistence is unavailable in ChatGPT portable mode; the selected source modules were not executed.',
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
      groups: groupSelections.map(({ group, selected }) => ({
        group: group.name,
        selected: { id: selected.id, name: selected.name },
      })),
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
              'Hidden Scratchpad state is not persisted across turns; Scratchpad cores and tabs that require it are omitted and reported.',
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
          effectiveGroupById,
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

export function isWithinPath(candidate, parent, pathApi = path) {
  const relative = pathApi.relative(parent, candidate);
  return (
    relative === '' ||
    (!pathApi.isAbsolute(relative) &&
      !relative.startsWith(`..${pathApi.sep}`) &&
      relative !== '..')
  );
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
  return decodeUtf8(Buffer.concat(chunks), 'standard input');
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(`Cannot decode ${label} as valid UTF-8.`);
  }
}

async function runSanitizer(options) {
  const compileSelectionsUsed =
    options.preset !== null ||
    String(options.profile) !== DEFAULT_PROFILE ||
    options.context !== null ||
    options.vex !== null ||
    options.nsfw !== null ||
    options.fetish !== null ||
    options.groupOne.length > 0 ||
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
  const input = inputPath
    ? decodeUtf8(await readFile(inputPath), JSON.stringify(inputPath))
    : await readStdinText();
  const cleaned = sanitizeOutput(input);

  await emitPlainText(cleaned, options, inputPath);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertJsonStringsWellFormed(options, 'CLI options');
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
