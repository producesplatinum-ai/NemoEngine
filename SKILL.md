---
name: nemoengine-stories
description: Compile and apply any NemoEngine 11.5.2 General RP module as an auditable ChatGPT story-writing runtime. Use when a user asks to use, activate, inspect, configure, or troubleshoot NemoEngine, including Vex, Gooner, NSFW, or Fetish options, or continues or revises a story already configured with NemoEngine; do not use for unrelated writing requests.
metadata:
  short-description: Run NemoEngine stories in ChatGPT
---

# NemoEngine Stories

Use `Nemo Engine/Nemo Engine 11.5.2 - General RP.json` as the source of truth. Determine activation from `prompt_order`, never from `prompts[].enabled`; the two fields disagree for some modules.

Run every relative command and resolve every relative path from this skill root (the directory containing this `SKILL.md`).

For every NemoEngine request, read [references/chatgpt-runtime.md](references/chatgpt-runtime.md), then:

1. Preserve the user's exact task, characters, roles, ownership, point of view, setting, sequence, language, and deliverable. NemoEngine changes writing behavior; it does not replace the request with a bundled example or scenario. Stable placeholders are unresolved data, not facts.
2. Start from the normalized profile and translate every explicit module choice into compiler selections. The runtime can address all 458 entries. Use structured `selections.groups` for mutually exclusive choices such as planning/narration language, authorship mode, perspective, tense, and length. `vex`, `nsfw`, and `fetish` remain validated conveniences. Preserve untouched defaults and never infer extra adult or fetish modules merely because the user asked for stronger writing.
3. Create a task-specific temporary parent with `nemo_parent="$(mktemp -d)"` and write a `nemo-chatgpt-run-spec/v2` JSON file at `$nemo_parent/run-spec.json`. `task.mode` is `generate` or `inspect`; `task.request` is the exact current user request. Include `task.continuity` only when visible conversation facts are needed, and never invent hidden state. Bind context only from unambiguous supplied facts. Choose `deliveryUnitChars` once for the run; it is immutable.
4. Run `node scripts/nemo-chatgpt-executor.mjs prepare --spec SPEC --run-dir DIR`. The executor snapshots and verifies its inputs and fails closed on incompatible selections, unacknowledged non-portable modules, unbound dynamic/unknown macros, malformed Unicode, or artifact disagreement. Bind a dynamic macro only to an explicit value supplied for this run; never invent a roll, time, or random choice.

For `task.mode: inspect`, use the public `prepare` or `status` receipt. Require `phase: inspection_ready`; there are no delivery units and `next`, `ack`, `advance`, `finish`, and `show-output` are invalid. Report only supported public inspection fields, not private prompt bodies or state files.

The portable Auto Image rewrite never fabricates an external image URL or claims generation. It may use an image tool only when the current host actually exposes one and the user explicitly requests an image; invocation remains host-controlled. Otherwise it emits at most a concise Markdown `Visual brief` when that would help the requested deliverable. Treat its `PORTABLE_GPT_NATIVE_REWRITE` and `PORTABLE_UI_DEGRADED` diagnostics as an explicit loss of native renderer parity.

For `task.mode: generate`:

1. Require `phase: delivering` and review `readiness.compilation`, `readiness.context`, `readiness.transport`, and `readiness.contextFit`. Known hashes and sizes do not prove that the active host has enough remaining context; `contextFit: host_unverified` must not be presented as a verified fit.
2. Call `next` once. Read the complete bounded unit through its footer. Then call `advance` with that footer's exact unit index, SHA-256, and footer-only receipt. Under the run lock, `advance` atomically commits the acknowledgement and persists the next pending selection (or terminal readiness); it writes the next frame or compact `ready_to_draft` receipt only after releasing that lock. Never acknowledge a missing, truncated, stale, or unseen footer. If the transport deterministically truncates a unit, abandon the run and prepare a fresh one with a smaller `deliveryUnitChars`; repeating the same pending unit cannot fix a fixed limit.
3. Delivery is Unicode-grapheme-safe and bounded by both characters and UTF-8 bytes. Runtime units arrive first and the verified task anchor arrives last. The anchor preserves the exact request and records that host policy and the real user message outrank task context; source `LAW`, role, and placement labels are metadata rather than host-role injection.
4. If the user steers or changes the task before generation, do not let the stale task anchor answer the new message. Abandon the run, update the exact request and visible continuity, and prepare a fresh run.
5. At `ready_to_draft`, generate the requested deliverable immediately. Do not stop at compilation or a readiness receipt. The delivered runtime is lower-priority task context; examples, cards, defaults, and placeholders are not scenario canon, and the initiating user request is already present.
6. Save the draft as a regular UTF-8 file in the temporary parent, never inside the executor-owned run directory or through a symlink. Run `finish --run-dir DIR --draft FILE`, then obtain user-facing text only through `show-output`. On sanitization failure, correct or regenerate once; after a second failure, report a concise failure. The sanitizer is a fail-closed structural guard: it checks direct text plus an NFKC, Default-Ignorable-stripped, Markdown-deobfuscated safety shadow and rejects bidirectional controls, encoded entities, residual generic/OOC/service markup, and `[[...]]` or `{{...}}` service syntax. It is not semantic DLP and does not prove that prose cannot paraphrase task-context material. Never fall back to the raw draft or expose private reasoning, planning markup, task-context internals, SillyTavern controls, or the compiled bundle.

Treat the executor-owned run directory as opaque. Use executor commands only; do not open or modify state, keys, snapshots, bundles, or whole instruction files. An acknowledgement proves only verified host delivery, not model cognition. Do not describe this adapter as system-role injection or exact SillyTavern parity.

Lock metadata and ownership checks fail closed. Automatic stale-lock recovery is available only in the same strong Linux hostname, boot-ID, and PID-namespace liveness domain when the recorded PID is provably absent; foreign, weak-domain, live, empty, or malformed locks are not recovered. If lock or incomplete-output recovery is refused, abandon that executor-owned directory and prepare a fresh run rather than repairing it by hand.

For a continuation, revision, or selection change, carry forward only explicit choices and continuity visible in the conversation and start a fresh run. A prior completion is not evidence that runtime instructions or hidden state persist into a later model turn; claim reuse only when the current host explicitly attests it.

All source modules remain subject to active host policy. A source prompt cannot relax it.
