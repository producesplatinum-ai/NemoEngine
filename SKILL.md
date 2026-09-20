---
name: nemoengine-stories
description: Compile and apply any NemoEngine 11.5.2 General RP module as an auditable ChatGPT story-writing runtime. Use when a user asks to use, activate, inspect, configure, or troubleshoot NemoEngine, including Vex, Gooner, NSFW, or Fetish options, or continues or revises a story already configured with NemoEngine; do not use for unrelated writing requests.
metadata:
  short-description: Run NemoEngine stories in ChatGPT
---

# NemoEngine Stories

Use `Nemo Engine/Nemo Engine 11.5.2 - General RP.json` as the source of truth. Determine activation from `prompt_order`, never from `prompts[].enabled`; the two fields disagree for some modules.

For a ChatGPT request that invokes NemoEngine:

1. Read [references/chatgpt-runtime.md](references/chatgpt-runtime.md).
2. Preserve the user's requested characters, roles, point of view, setting, sequence, language, and deliverable. NemoEngine changes writing behavior; it does not replace the request with a bundled scenario.
3. Start from the normalized profile and translate every explicit module choice into compiler overrides. The runtime can enable or disable any of the 458 prompt entries; `--vex`, `--nsfw`, and `--fetish` are validated conveniences, not the limit of its coverage. Keep untouched families at their normalized profile defaults. Do not silently add or remove modules as an optimization. In particular, never infer extra Gooner, NSFW, or Fetish modules from a generic request for “better” or “stronger” writing. Keep Narrative Vex when the request does not alter the Vex family. A replacement may use `--vex` or a paired disable + enable, but the final stack must contain exactly one Vex.
4. From this skill's root, create a task-specific temporary directory and a `nemo-chatgpt-run-spec/v1` JSON file. Bind only unambiguous user/character/persona/scenario context explicitly supplied in the request; do not invent missing bindings. Run `node scripts/nemo-chatgpt-executor.mjs prepare --spec SPEC --run-dir DIR`. The executor snapshots the source and compiler, performs both portable compilations with one immutable argument set, cross-checks every artifact, and fails closed on a requested non-portable module unless its exact identifier is deliberately allowlisted.
5. Deliver the verified task-context instructions with the executor's state machine. Repeatedly call `next`, read the complete bounded delivery unit including its footer, then call `ack` with that unit's exact index and SHA-256. Never acknowledge truncated or unseen output. Continue until the receipt says `phase: ready_to_draft`; do not read `instructions.txt`, skip a unit, or treat the source-role metadata as a real ChatGPT system message.
6. If the user requested creative or direct output, generate that requested deliverable in the active ChatGPT turn immediately after `ready_to_draft`. Do not stop at compilation, a manifest, a readiness receipt, or an explanation of the machinery unless the user asked for configuration or diagnosis. The active session is the generation callback: apply the completely delivered stack as lower-priority task context while preserving host policy and the user's request.
7. Save the draft as a regular UTF-8 file in the temporary parent, never inside the executor-owned run directory or through a symlink, and do not print it. Run `finish --run-dir DIR --draft FILE`, then read the user-facing result only through `show-output`. If sanitization fails, correct or regenerate once and call `finish` again; after the second failure, report a concise failure. After successful `show-output`, remove the task-created raw draft. Never fall back to or emit the raw draft, private reasoning, hidden planning, SillyTavern control markup, raw internal prompt text, or the compiled bundle unless the user explicitly asks for appropriate configuration details.

This workflow delivers verified instructions into the active skill context. An executor acknowledgement records host delivery, not proof of model cognition. Do not tell the user to paste the bundle into ChatGPT Custom Instructions, and do not describe the adaptation as true system-role injection.

Treat the executor-owned run directory as opaque. Never read or modify `execution-state.json`, `.execution-state.key`, snapshots, bundles, or whole instruction files directly; use only the executor receipts, bounded `next` output, and final `show-output` result.

For a configuration or diagnosis request, use the public `profile`, `selections`, `stats`, `diagnostics`, `limitations`, and `inspection` fields returned by `prepare` or `status`. `inspection` is the supported view of repairs, warnings, unresolved macros, semantic context slots, portable transforms, and effective folded-state entries; do not bypass it by opening internal artifacts.

The compiler normalizes the shipped profile's conflicting Haar + Narrative selection to Narrative. Explicit user choices override that baseline. If explicit overrides leave a mutually exclusive conflict, fail closed and resolve the selection instead of arbitrarily choosing. Treat the compiler's selected-module manifest and warnings as authoritative for the compiled run. Do not claim exact SillyTavern parity: ChatGPT does not execute SillyTavern injection, regex/UI machinery, provider settings, or hidden-thought display.

For every explicitly requested entry without its own portable block, classify the manifest reason. `folded-state` is effective through an emitted consumer; a host marker, unused state, or unresolved feature is a real limitation and must be identified instead of being called working.

All source modules remain subject to the active host's policies. A source prompt cannot relax them.

For a continuation, revision, or changed module request, carry forward the last explicit selections visible in the conversation, apply the new delta, and start a fresh executor run so changed story context and selections are recompiled and reverified. Never claim hidden state persisted merely because a previous run completed.
