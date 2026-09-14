# NemoEngine 11.5.2: ChatGPT Runtime

Use this reference when compiling or applying NemoEngine in ChatGPT. It defines the portable behavior, explicit module selection, and the boundary between the source SillyTavern preset and this runtime.

## Source and activation

- Canonical preset: `Nemo Engine/Nemo Engine 11.5.2 - General RP.json`.
- Canonical SHA-256: `c5e13e951340d17addef0e16e7a7152a8256c41f2c046a52e81d86e1feef31d4`.
- Expected inventory: 458 prompts, two `prompt_order` profiles, and 97 regex scripts.
- Default profile: `100001`.
- Activation authority: the chosen profile's `prompt_order[].order[].enabled` values.
- Do not activate a module because its own `prompts[].enabled` field is true or because its prose contains the word “Active”.
- Keep the chosen profile's `prompt_order` order after applying overrides. Module order is behaviorally significant.
- Normalize mutually exclusive families to one selected member. For the shipped Haar Vex + Narrative Vex conflict, keep Narrative Vex unless the user selects another Vex.

## Deterministic compile and delivery

Run from the skill root. Never print a bundle, full inventory, or complete instruction stream to stdout: tool transport can truncate it while the process still exits successfully.

Create a unique temporary directory and one argument array. Add request-specific selectors to that array before both compiler calls so metadata and delivered instructions cannot diverge:

```bash
nemo_run_dir="$(mktemp -d)"
nemo_runtime_args=(
  --mode portable
  --profile 100001
  --max-portable-chars 170000
)

# Add only options supported by the request. This is an explicit example:
# nemo_runtime_args+=(--vex "Gooner Vex")
# nemo_runtime_args+=(--nsfw "NSFW Core,Gooner Protocol")
# nemo_runtime_args+=(--fetish "Femdom,NTR")
# nemo_runtime_args+=(--context "$nemo_run_dir/context.json")

node scripts/nemo-chatgpt-runtime.mjs \
  "${nemo_runtime_args[@]}" \
  --out "$nemo_run_dir/bundle.json"

node scripts/nemo-chatgpt-runtime.mjs \
  "${nemo_runtime_args[@]}" \
  --emit-dir "$nemo_run_dir/emission"
```

`--emit-dir` writes:

- `instructions.manifest.json`: source/profile identity, emitted order, omitted selected entries, total character/byte counts, overall SHA-256, and the ordered chunk ledger;
- `chunk-001.txt` and following files: Unicode-safe chunks of at most 24,000 characters, at most eight chunks;
- `instructions.txt`: the complete text for external verification only. Never open it as one model/tool result.

Before applying any instruction, inspect the saved `bundle.json` and manifest without printing `prompts[]`. Require all of the following:

1. Bundle schema is `nemo-chatgpt-runtime/v1`; manifest schema is `nemo-chatgpt-runtime-emission/v1`.
2. Bundle `mode` and `compatibility.mode` and manifest `mode` are all `portable`.
3. Source SHA-256 and profile match between bundle and manifest. For the default preset, require the canonical source hash above. For an explicitly requested `--preset` override, require cross-call hash equality and report the alternate path/hash as provenance; do not compare it to the default preset's hash.
4. Bundle `portableInstructions.{characters,bytes,sha256,blockCount}` equals manifest `instructionChars`, `instructionBytes`, `instructionSha256`, and `orderedEmittedIds.length`.
5. Bundle `stats.emittedPrompts`, manifest emitted-ID count, and portable block count agree. Review the full `diagnostics` object.
6. Manifest chunk indices begin at 1; boundaries are contiguous from character 0 through `instructionChars`; every `end - start` equals `chars`; every chunk is at most 24,000 characters; there are at most eight.
7. Recompute every chunk's Unicode character count and SHA-256. Concatenate chunks in manifest order and verify the overall character count, byte count, and SHA-256.

Before reading, ensure the active context can hold the complete declared instruction artifact; if it cannot, select fewer modules and recompile rather than applying a partial runtime. Read every manifest-listed chunk sequentially, one chunk per bounded tool result, and keep a ledger of consumed indices. Do not generate until indices `1..N` have all been read and the final boundary equals `instructionChars`. If a tool reports output truncation, reread only that chunk in smaller, contiguous Unicode-character ranges and verify complete local coverage before continuing.

The compiler internally verifies the emitted round trip, but the caller still performs these checks to detect incomplete transport or reading. `--instructions-only --out PATH` is available for controlled integrations; it is not the normal skill path because it lacks the manifest-led chunk consumption contract.

`--emit-dir` is portable-only and cannot be combined with `--out`, `--instructions-only`, or `--list`. This is why the required workflow uses two deterministic calls with the same selection arguments.

For inventory or source audit, also write to files:

```bash
node scripts/nemo-chatgpt-runtime.mjs \
  --profile 100001 --list all --out "$nemo_run_dir/inventory.json"

node scripts/nemo-chatgpt-runtime.mjs \
  --mode source --profile 100001 --out "$nemo_run_dir/source-bundle.json"
```

Query the saved inventory for the needed exact name or identifier; do not print all 458 entries into one tool result.

After drafting user-facing prose, sanitize through files and read the bounded cleaned file:

```bash
node scripts/nemo-chatgpt-runtime.mjs \
  --sanitize-output "$nemo_run_dir/draft.txt" \
  --out "$nemo_run_dir/clean-output.txt"
```

CLI contract:

```text
node scripts/nemo-chatgpt-runtime.mjs
  [--preset PATH]
  [--profile 100001]
  [--mode portable|source]
  [--context PATH]
  [--max-portable-chars N]
  [--instructions-only]
  [--emit-dir DIR]
  [--vex SELECTOR]
  [--nsfw LIST]
  [--fetish LIST]
  [--enable LIST]
  [--disable LIST]
  [--sanitize-output PATH|-]
  [--out PATH]
  [--pretty]
  [--list vex|nsfw|fetish|modules|all]
  [--help]
```

Portable mode is the default. It resolves the supported simple variable operations, removes no-op SillyTavern scaffolding, records unresolved features, and supplies output-sanitization rules. `--mode source` preserves raw selected prompts for inspection and must not be treated as directly runnable ChatGPT instructions. `--max-portable-chars` defaults to the hard emission limit of `170000` and fails instead of silently truncating the result.

Portable context is optional JSON:

```json
{
  "macros": { "user": "Ava", "char": "Vex", "persona": "..." },
  "globals": { "NemoLoreTimeline": "..." },
  "variables": { "OptionalInitialVariable": "..." }
}
```

Before compilation, write `context.json` from semantic values the user actually supplied, including `user`, `char`, `persona`, or `scenario` when they are known and unambiguous. Bind any other context slot only from supplied character cards, lore, summaries, or memory; never invent missing data. Missing semantic values receive stable placeholders such as `[USER]` and `[CHARACTER]`. Confirm in `diagnostics.macroResolution.semanticContextSlots` that every supplied binding is marked as provided.

`--sanitize-output PATH` reads a drafted answer from that path, while `--sanitize-output -` reads stdin. Sanitization is standalone; in this skill, always provide `--out`. A blank or unsafe result is an error.

`SELECTOR` accepts an exact identifier or a normalized exact name. `LIST` accepts comma-separated names/identifiers or repeated flags. `none` clears a family where supported. `--enable` and `--disable` address any of the source's 458 entries and are applied after family selections; the family flags provide stricter, convenient replacement semantics for Vex, NSFW, and Fetish selections. Use `--list modules` to inspect the complete inventory. Invalid or ambiguous selectors fail with exit status 1 instead of guessing.

## Selection rules

Use only selections supported by the request:

- Begin with profile `100001`; apply explicit user choices as overrides to that baseline.
- On a follow-up to an already configured NemoEngine story, preserve the last explicit module selections available in the conversation and apply only the user's new changes. Do not silently reset to the baseline or assume hidden runtime persistence.
- Use `--enable` or `--disable` for any prompt outside the three convenience families. A request to change a specific core, plan, genre, style, pacing, agency, world, utility, tracker, databank, or system entry must not be ignored merely because it lacks a dedicated family flag.
- If the request does not alter Vex selection, keep the normalized Narrative Vex default.
- A specific Vex named: replace Narrative Vex with `--vex`, or pair a generic disable of the current Vex with an enable of the replacement. The final stack must contain exactly one Vex; zero or multiple Vex personalities fail closed.
- “Gooner” requested without a narrower variant: use `Gooner Vex` plus `NSFW Core,Gooner Protocol`.
- `Goon Gremlin Vex` is an alternative narrator personality, not an additional layer on Gooner Vex.
- `Gooner Protocol`, `Gooner Slop Mode [V6]`, and `Gooner's Masterpiece Protocol [V6]` are alternative strategies. Do not stack them unless the user explicitly requests the conflict for testing.
- A named Fetish request enables only the named entries. Multiple Fetish modules are allowed, but no module is silently added as a supposed dependency.
- `Harmonized HTML Enable (fefnik)` is presentation support, not fetish content.
- `--nsfw none` and `--fetish none` are the explicit clean overrides.
- Profile `100001` starts with modern `NSFW Core` but no Gooner or Fetish module. Because `--nsfw` replaces the family, name both `NSFW Core,Gooner Protocol` when both are intended; use `--nsfw none` for a clean stack.
- Explicit user choices take precedence over profile defaults. If the resulting explicit selection violates a mutual-exclusion group, stop with an error; do not choose a winner silently.
- Passing the same entry to both `--enable` and `--disable` is an error, not an ordering trick.

Available Fetish selectors in 11.5.2 are:

```text
CBT
Femdom
Feminization
Foot Fetish
Furry
Harem
Netori
NonCon
Dating Sim (Quantum)
Corruption (Fefnik)
Forced Fem (Classic)
Harmonized HTML Enable (fefnik)
NTR
Petplay
Humiliation
JOI
```

Psychology, Humiliation, and JOI are independently selectable. For the complete compatible stack, compile both psychological augments through generic overrides and the two adult procedures through the Fetish family:

```bash
node scripts/nemo-chatgpt-runtime.mjs \
  --enable "v11-611-augment-manipulation-realism,v11-613-augment-psychological-emotional-realism" \
  --fetish "Humiliation,JOI" \
  --pretty \
  --out build/nemo-psychology-humiliation-joi.json
```

- `Humiliation` supports either direct adult address or in-scene character dynamics. Keep its claims anchored to supplied facts and the current fiction; it must not invent the user's actions, inner state, or response.
- `JOI` is an adult opt-in, turn-by-turn procedure. It waits for the user's report after each instruction, honors `pause` and `stop` immediately, and never pretends to observe the body or run a live timer.
- The psychology augments affect character and world realism. They do not authorize diagnosis of the user or weaken JOI's consent, state, stop, and timing rules.
- Additional Fetish modules may be combined only when explicitly requested. Selecting `Humiliation` or `JOI` never silently enables Femdom, NTR, CBT, Gooner, or another fetish.

Resolve known semantic conflicts from the user's stated role and desired behavior:

- Choose Feminization or Forced Fem (Classic); do not silently combine their different progression systems.
- Choose Netori when the focal character takes another person's partner; choose NTR when the focal character is the betrayed partner.
- Dating Sim (Quantum) and Corruption (Fefnik) maintain different state models. Combine them only when both are explicitly requested.
- Both can request fefnik HTML/state rendering. Report its portability warning; do not silently enable `Harmonized HTML Enable (fefnik)` or claim the SillyTavern panel is rendered.
- If a direct request still leaves one of these choices genuinely ambiguous, ask one focused question. Otherwise compile and proceed.

Route the authorship mode from the requested deliverable. These are mutually exclusive, so disable the current mode before enabling its replacement:

| Request | User-role entry |
|---|---|
| Interactive roleplay in which the user controls an in-world character | `User is a Character` |
| A finished story in which the user's character may be fully authored | `Director Mode` |
| An external brief with no user character in the fiction | `User as Director` |
| Continuation or revision of prose the user already wrote | `Cowriter Frame` |

Treat an explicitly requested narration language, perspective, tense, and length as module overrides. Profile `100001` defaults to English narration and third-person omniscient; do not let those defaults override a request for Russian, first person, or another explicit form.

## Applying the compiled bundle

Require `schemaVersion: nemo-chatgpt-runtime/v1` and `compatibility.mode: portable`. Use the saved bundle only to inspect `modules[]`, `selections`, `stats`, `diagnostics`, and `portableInstructions`; consume the instruction payload through the verified manifest chunks, never by printing bundle `prompts[]`. `modules[]` records every selected entry, including entries that do not emit their own block; `stats.enabledPrompts` and `stats.emittedPrompts` expose the difference. Check `diagnostics.macroResolution` and its semantic context slots before generation. Classify every requested entry listed in `omittedModules`:

- `folded-state` means the entry's resolved variable state was consumed by an emitted block such as Core Assembler. It is effective through that consumer even though it has no separate instruction block.
- `omitted-state-only` means no active emitted consumer used the state; do not claim an operative effect.
- `omitted-section-header` is organizational only.
- `omitted-host-marker` requires host placement and is not executed by ChatGPT.
- Any requested entry with neither an emitted block nor verified folded effect must be reported as selected but non-portable.

In source mode, `prompts[].rawContent` is audit material only. Do not revive disabled entries from the preset.

Keep user intent above optional style defaults. In particular:

- Preserve the user's subject, ownership relations, character agency, chronology, point of view, language, and requested output form.
- Do not borrow scenarios or characters from module examples.
- When a user choice differs from the baseline, compile the explicit choice. For unresolved mutual exclusion, fail closed and ask for or derive only the missing choice; selected profile order is not a conflict resolver.
- Give the user the requested result. A normal story request should not receive a configuration dump or an explanation of the machinery.
- If the user asks what is active, report the public module manifest and compiler warnings. Do not reveal private chain-of-thought or hidden planning.
- Before returning generated prose, apply the portable output sanitizer. Do not expose `<plan>`, `<think>`, `<scene>`, `<nemo-pad>`, `[[tab]]`, runtime/OOC scaffolding, variable commands, or other service markup.

## Portability boundary

The compiler can address all 458 source prompt entries in deterministic selected-profile order. They are entries, not 458 independently portable capabilities. Default portable mode extracts only behavior it can represent and reports the rest:

- ChatGPT does not execute SillyTavern `setvar`, `addvar`, `getvar`, or `trim` macros. Portable mode may evaluate only the compiler's supported simple forms; unresolved forms remain diagnostics, never an implied capability.
- ChatGPT does not execute SillyTavern role/depth injection or conversation-history placement. Any retained fields are metadata only.
- ChatGPT does not run the 97 SillyTavern regex scripts, HTML/CSS transforms, tracker widgets, themes, or old-message cleanup. The portable output sanitizer is a narrow replacement for preventing service-markup leakage, not regex parity.
- ChatGPT does not inherit the preset's sampling values, requested context size, token limits, assistant prefill, or provider-specific switches.
- Character cards, lorebooks, world info, persona data, and chat history are external inputs; the preset cannot supply them by itself.
- ChatGPT provides no guaranteed hidden SillyTavern variable state across turns. Dating Sim, Corruption, Forced Fem, and tracker entries can maintain only plain-text state present in available chat history or an explicit context binding; they do not gain SillyTavern counters, persistence, regex cleanup, or UI storage.
- Source requests for visible or hidden reasoning do not authorize disclosure. Perform any necessary reasoning privately and return only the requested answer or a concise public diagnosis.

This is skill-context delivery: the agent reads the verified chunks as task instructions. It is not a Custom Instructions paste workflow and does not create genuine system-role messages. Source roles, selected-profile ordering, injection metadata, and flattened placement are adaptation records; none supplies SillyTavern injection parity.

Describe the result as a ChatGPT adaptation of NemoEngine 11.5.2, not as a byte-for-byte SillyTavern execution.

## Failure handling

- On an unknown selector, use `--list` to find the exact name; do not silently fall back.
- On a compiler error, report the failing option and error message concisely. Do not claim the requested modules were active.
- On sanitizer failure or blank/unsafe cleaned output, never return the unsanitized draft. Correct or regenerate once and rerun the sanitizer; after a second failure, return only a concise failure notice.
- If the preset path is overridden, verify bundle/manifest agreement and identify the alternate path and SHA-256 when configuration provenance matters; the canonical default hash no longer applies.
- If output quality is wrong but compilation succeeds, inspect the selected manifest for conflicting style, agency, perspective, length, or adult modules before changing the user's story premise.
