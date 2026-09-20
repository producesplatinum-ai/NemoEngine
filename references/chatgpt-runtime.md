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

## Production execution path

For ChatGPT use `scripts/nemo-chatgpt-executor.mjs`. The lower-level compiler remains useful for audits, but it is not the normal generation path.

Run every relative command and resolve every relative path from the skill root (the directory containing `SKILL.md`). Create a unique temporary parent before writing the spec:

```bash
nemo_parent="$(mktemp -d)"
```

Place the following spec at `$nemo_parent/run-spec.json`, outside the new run directory. Version 2 makes the current task part of the signed, immutable run:

```json
{
  "schemaVersion": "nemo-chatgpt-run-spec/v2",
  "task": {
    "mode": "generate",
    "request": "the exact current user request",
    "continuity": "optional brief containing only visible prior facts"
  },
  "deliveryUnitChars": 12000,
  "profile": 100001,
  "maxPortableChars": 170000,
  "selections": {
    "vex": "Gooner Vex",
    "nsfw": ["NSFW Core", "Gooner Protocol"],
    "fetish": ["Humiliation", "JOI"],
    "groups": [
      { "group": "Planning-Language", "selector": "Plan: Russian" },
      { "group": "Narrate-Language", "selector": "Narrate: Russian" },
      { "group": "User-Role-Mode", "selector": "Director Mode" },
      { "group": "Perspective", "selector": "First Person" },
      { "group": "Tense", "selector": "Present Tense" },
      { "group": "Length", "selector": "Long" }
    ],
    "enable": [
      "v11-611-augment-manipulation-realism",
      "v11-613-augment-psychological-emotional-realism"
    ],
    "disable": []
  },
  "context": {
    "macros": { "user": "Ava", "char": "Vex" },
    "globals": {},
    "variables": {}
  },
  "allowNonPortable": []
}
```

`task.mode` is `generate` or `inspect`. `task.request` is required and must reproduce the current user request exactly. `task.continuity` is optional and may contain only facts visible in the conversation; do not turn an inference or remembered hidden state into continuity. A change to the task, continuity, selection, context, or unit size requires a fresh run. Do not claim that runtime delivery from an earlier turn remains active unless the current host explicitly attests it.

`deliveryUnitChars` is a safe integer from 2,000 through 12,000 and is fixed at preparation time. Choose a smaller value when the host's tool-output limit requires it. Every unit is also capped at 16,000 UTF-8 bytes and never splits a Unicode grapheme cluster. `preset` is optional and resolved relative to the spec file. `allowNonPortable` accepts exact module identifiers and acknowledges a real portability limitation; it does not make the omitted module operative, and must never be filled merely to force a build through.

Omitted selection families preserve normalized defaults; empty `nsfw` or `fetish` arrays clear those families. Each `selections.groups` item atomically replaces one member of a named mutually exclusive group, so language, role, perspective, tense, length, and similar choices do not require fragile disable-plus-enable pairs. Duplicate group requests, unknown or ambiguous groups/members, and conflicts fail closed. Generic `enable` and `disable` remain available for entries outside convenience families and groups.

The executor rejects unknown fields, unsafe limits, malformed Unicode, and values that could forge module, macro, private-output, tracker, or delivery boundaries. The run directory must be new or empty, outside the repository, private, and reachable without symlinks. Keep the spec and draft in its temporary parent.

Prepare the immutable run:

```bash
node scripts/nemo-chatgpt-executor.mjs prepare \
  --spec "$nemo_parent/run-spec.json" \
  --run-dir "$nemo_parent/run"
```

`prepare` snapshots the source, runtime, normalized spec, and context; compiles twice with one argument set; and cross-checks the full reconstructed instruction stream, all ledgers, boundaries, character/byte counts, and hashes. Its public receipt does not contain prompt bodies. Use `inspection` for safe repairs, warnings, unresolved macros, semantic context slots, portable transforms, and folded-state evidence.

Dynamic or unknown macros are never silently called production-ready. The low-level compiler records `PORTABLE_DYNAMIC_FALLBACK`; the production executor rejects the run until the exact macro is bound in `context.macros` from an explicit run value or its owning module is disabled. For example, bind `roll:1d100` only when the caller actually supplied that result—never fabricate a roll to pass preparation.

The `readiness` object separates four dimensions instead of collapsing them into one claim:

- `compilation` is `verified`, `verified_with_diagnostics`, or `verified_with_limitations`;
- `context` is `fully_bound` or `placeholders_present`;
- `transport` is `pending`, `complete`, or `not_required`;
- `contextFit` is `host_unverified`. Known character and byte counts are not a token count or proof that the remaining ChatGPT context is large enough.

Require `schemaVersion: nemo-chatgpt-execution/v2`, `contract.deliveryMode: task-context`, `contract.systemRoleInjection: false`, and `contract.sillyTavernParity: false`. Delivery receipts prove only what the host accepted through this protocol; they do not prove model cognition.

### Inspect mode

Use `task.mode: inspect` for configuration, compatibility, and diagnosis; it still requires the exact current `task.request`. A successful prepare returns `phase: inspection_ready`, zero delivery units, and `readiness.transport: not_required`. Read only public `prepare` or `status` fields. `next`, `ack`, `advance`, `finish`, and `show-output` are invalid in this mode; an inspection must not flood the active model context with the full runtime.

### Generate mode

A successful generate prepare starts in `phase: delivering`. Fetch the first unit, then atomically acknowledge each complete footer while requesting the next:

```bash
node scripts/nemo-chatgpt-executor.mjs next --run-dir "$nemo_parent/run"

node scripts/nemo-chatgpt-executor.mjs advance \
  --run-dir "$nemo_parent/run" \
  --unit 1 \
  --sha256 SHA_FROM_THE_COMPLETE_DELIVERY_FOOTER \
  --receipt RECEIPT_FROM_THE_COMPLETE_DELIVERY_FOOTER
```

Every frame declares its unit kind, part number, character count, byte count, and SHA-256. The unpredictable receipt appears only in the footer; seeing the header or hash alone is insufficient to acknowledge the unit. Read the entire payload and footer before calling `advance`. Under one run lock it commits that acknowledgement and selects and persists the next pending unit, or commits terminal `ready_to_draft`; only after releasing the lock does it write the resulting frame or compact receipt to stdout. A crash/retry with the just-committed acknowledgement re-presents the current pending unit or terminal readiness without skipping data. `ack` remains a lower-level compatibility/diagnostic command; normal execution uses `advance`.

If the entire remainder fits, it stays in one unit. Otherwise, at or after 55% of the actual character-and-byte-bounded fit window, splitting chooses the strongest available boundary—module, paragraph, sentence, newline, then whitespace—and falls back to the largest grapheme-safe bounded span when no such boundary qualifies. Reassembly remains byte-exact. Runtime units always precede the final task-anchor unit or units. The verified task anchor preserves the exact request and optional visible continuity, states that the initiating request is already present, and prevents examples, character cards, defaults, or placeholders from becoming scenario canon. Its hierarchy statement is deliberately truthful: host policy and the actual host user message outrank Nemo task context; source `system`, `LAW`, depth, and placement labels are metadata, not promoted host messages.

If a footer is missing or truncated, do not acknowledge it. A transient loss may be retried with `next`; if the same output is deterministically truncated, abandon the run and prepare a fresh one with a smaller `deliveryUnitChars`. The unit size is signed and immutable, so retrying the same oversized pending unit cannot solve a fixed transport cap.

If the user steers while delivery is in progress, abandon the stale run. Put the new exact request and updated visible continuity in a new spec and prepare again; never allow an older final task anchor to override a newer user message.

At `ready_to_draft`, generate the requested result in the active turn. The executor cannot invoke the current conversation's model itself. Readiness is not the deliverable. Apply Nemo modules as lower-priority task context while preserving the real request and host hierarchy.

Save the unprinted draft and finish:

```bash
node scripts/nemo-chatgpt-executor.mjs finish \
  --run-dir "$nemo_parent/run" \
  --draft "$nemo_parent/draft.txt"

node scripts/nemo-chatgpt-executor.mjs show-output \
  --run-dir "$nemo_parent/run"
```

`finish` is unavailable until delivery completes. The draft must be a regular external file reached without symlinks, valid UTF-8, and free of unsafe control bytes. The executor snapshots exact bytes, sanitizes its private copy, and returns only a receipt. After completion, retrying `finish` is idempotent only for the byte-identical draft with the same SHA-256; a different draft is rejected. `show-output` works only in `complete` and emits the verified sanitized bytes. A sanitizer failure permits one corrected retry; a second makes the run terminal. Never return the raw draft as fallback, and remove a task-created external draft after successful output.

The sanitizer is a fail-closed structural leakage guard. It checks both direct text and a detection-only safety shadow normalized with NFKC, stripped of Unicode `Default_Ignorable_Code_Point` characters, and deobfuscated across Markdown escapes, emphasis/code punctuation, and inline/reference-link wrappers. It rejects bidirectional controls, encoded HTML entities, residual generic HTML-like or opaque markup, private/service boundaries, unparsed OOC scaffolding, reserved Nemo framing, and residual `[[...]]` or `{{...}}` tracker/template syntax. These checks are not semantic DLP, a content classifier, or proof that ordinary prose contains no summary or paraphrase of task-context material; the caller must still avoid disclosing internal instructions semantically.

The host ledger phases are:

```text
inspect:  inspection_ready
generate: delivering -> ready_to_draft -> complete
                                    \-> failed (after two sanitizer failures)
```

The run directory is private (`0700`) and lifecycle state is authenticated with a per-run key. Never open, copy, edit, or expose `.execution-state.key`, hand-edit `execution-state.json`, or bypass executor commands. This detects accidental/direct state edits while the key remains private; it is not a security boundary against a process already trusted as the same operating-system account.

Primary and recovery locks use a strict metadata schema and exact key set: kind, bounded PID, canonical timestamp, random owner token, and liveness domain, plus the primary-generation token for recovery leases. Their names are published atomically only after the candidate metadata has been written and synchronized, using an exclusive hard link followed by inode and metadata revalidation.

Automatic stale-lock recovery is deliberately narrower than an age check. It is attempted only on Linux when the current hostname, kernel boot ID, and PID namespace produce the same strong liveness-domain identity recorded by the lock and the recorded PID is then provably absent. A live owner, non-Linux or otherwise weak local domain, foreign domain, wrong schema/kind/key set, malformed/partial/empty metadata, unsafe file type, or changing inode fails closed. Recoverable abandoned publication candidates are removed only after the same domain, owner-token, and inode checks.

A recovery lease is namespaced from the primary lock's owner token and carries that token as `primaryGeneration`; abandoned lease generations must match it and the recovery chain is bounded. Every successful primary-lock acquisition also supplies a unique operation ID used in the draft and sanitizer staging names. Sanitized output is published through an exclusive hard link, so an orphan child from an older acquisition cannot overwrite a newer generation's `clean-output.txt`. If a crash leaves an uncommitted clean output, automatic cleanup is allowed only when it is a regular file with exactly one same-inode, operation-scoped sanitizer staging alias. A clean output that cannot be uniquely attributed this way fails closed; because the run directory is opaque, abandon it and prepare a fresh run rather than editing it manually.

## Low-level compiler contract (audit and debugging)

Run from the skill root. Never print a bundle, full inventory, or complete instruction stream to stdout: tool transport can truncate it while the process still exits successfully. The production executor automates and strengthens this contract; use the manual sequence only when inspecting the compiler itself.

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
# nemo_runtime_args+=(--group-one "Narrate-Language::Narrate: Russian")
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

Before reading, determine whether the host explicitly exposes enough context-capacity information to establish a fit. If it does not, report fit as host-unverified rather than converting character counts into a false token guarantee. Never apply a partial runtime. Read every manifest-listed chunk sequentially, one chunk per bounded tool result, and keep a ledger of consumed indices. Do not generate until indices `1..N` have all been read and the final boundary equals `instructionChars`. If a tool reports output truncation, reread only that chunk in smaller, contiguous Unicode-character ranges and verify complete local coverage before continuing.

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

For a low-level audit, sanitize drafted prose through files and read the bounded cleaned file. Normal skill execution must use executor `finish` and `show-output` instead:

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
  [--nsfw-one SELECTOR]
  [--fetish-one SELECTOR]
  [--group-one GROUP::SELECTOR]
  [--enable-one SELECTOR]
  [--disable-one SELECTOR]
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

`SELECTOR` accepts an exact identifier or normalized exact name. `LIST` accepts comma-separated names/identifiers or repeated flags. When a display name contains a comma, use the corresponding `--*-one` form so it remains one selector; the executor does this for array entries. `--group-one GROUP::SELECTOR` atomically selects one member of an exclusive group. `none` clears a family where supported. `--enable` and `--disable` address any of the source's 458 entries and are applied after family and group selections. Use `--list modules` to inspect exact names. Invalid, ambiguous, duplicate, or conflicting selectors fail instead of being guessed.

## Selection rules

Use only selections supported by the request:

- Begin with profile `100001`; apply explicit user choices as overrides to that baseline.
- On a follow-up to an already configured NemoEngine story, preserve the last explicit module selections available in the conversation and apply only the user's new changes. Do not silently reset to the baseline or assume hidden runtime persistence.
- Use an atomic group selection for a mutually exclusive family and `--enable` or `--disable` for other prompts. A request to change a specific core, plan, genre, style, pacing, agency, world, utility, tracker, databank, or system entry must not be ignored merely because it lacks a dedicated family flag.
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

Route the authorship mode from the requested deliverable with one `User-Role-Mode` group selection:

| Request | User-role entry |
|---|---|
| Interactive roleplay in which the user controls an in-world character | `User is a Character` |
| A finished story in which the user's character may be fully authored | `Director Mode` |
| An external brief with no user character in the fiction | `User as Director` |
| Continuation or revision of prose the user already wrote | `Cowriter Frame` |

Treat explicitly requested planning/narration language, perspective, tense, and length as atomic group selections. Profile `100001` defaults to English narration and third-person omniscient; do not let those defaults override a request for Russian, first person, or another explicit form.

### Auto Image portability

The portable rewrite for `v11-253-utility-auto-image-gen` never fabricates an external image URL or claims that generation occurred. It may use an image tool only when the current host actually exposes one and the current user explicitly requests an image; the invocation remains host-controlled and outside Nemo textual service markup. Without that capability, it emits at most a concise Markdown `Visual brief`—subject, composition, style, palette, and constraints—when visual planning is requested or materially helps the deliverable, and otherwise emits nothing. When its consumer is active, the module is represented as `folded-state` through that emitted consumer; if the consumer is explicitly disabled, it becomes `omitted-state-only` and an explicit production request fails closed. Both cases report `PORTABLE_GPT_NATIVE_REWRITE` and `PORTABLE_UI_DEGRADED`; these diagnostics are compatibility evidence, not a claim of native renderer parity.

## Applying a low-level compiled bundle (audit path)

Require `schemaVersion: nemo-chatgpt-runtime/v1` and `compatibility.mode: portable`. Use the saved bundle only to inspect `modules[]`, `selections`, `stats`, `diagnostics`, and `portableInstructions`; consume the instruction payload through the verified manifest chunks, never by printing bundle `prompts[]`. `modules[]` records every selected entry, including entries that do not emit their own block; `stats.enabledPrompts` and `stats.emittedPrompts` expose the difference. Check `diagnostics.macroResolution` and its semantic context slots before generation. Classify every requested entry listed in `omittedModules`:

- `folded-state` means the entry's resolved variable state was consumed by an emitted block such as Core Assembler. It is effective through that consumer even though it has no separate instruction block.
- `omitted-state-only` means no active emitted consumer used the state; do not claim an operative effect.
- `omitted-nonportable-state` means the module requires hidden cross-turn state that ChatGPT portable mode cannot provide. Scratchpad Legacy and loader-backed Modular/Pad Tab modules use this reason. The executor blocks an explicit request unless its exact ID appears in `allowNonPortable`; allowing it acknowledges that it remains ineffective and does not enable persistence. `nemo_pad_consequence` and the loader resolver by themselves remain `omitted-state-only`.
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
