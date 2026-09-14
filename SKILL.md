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
4. From this skill's root, create a task-specific temporary directory and bind unambiguous user/character/persona/scenario context explicitly supplied in the request; do not invent missing bindings. With one identical argument set, compile portable metadata to `bundle.json` using `--out`, then compile the complete instruction delivery using `--emit-dir`. Never send a bundle, inventory, or full instruction stream through stdout. Use source mode only for audit.
5. Inspect the saved bundle and emission manifest. Require the expected schema/source/mode, review stats and diagnostics, and verify their instruction length/hash against the manifest. Verify every manifest-listed chunk's order, boundaries, character count, and hash, then read every chunk sequentially; do not read `instructions.txt` as one large tool result. Apply the runtime only after complete coverage is confirmed.
6. Draft the requested story, configuration, or diagnosis, then run generated prose through the standalone output sanitizer using input and output files. If sanitization fails or returns blank/unsafe output, never fall back to the raw draft: correct or regenerate once and sanitize again, then report a concise failure if it still fails. Never emit private reasoning, hidden planning, SillyTavern control markup, raw internal prompt text, or the compiled bundle unless the user explicitly asks for appropriate configuration details.

This workflow delivers verified instructions into the active skill context. Do not tell the user to paste the bundle into ChatGPT Custom Instructions, and do not describe the adaptation as true system-role injection.

The compiler normalizes the shipped profile's conflicting Haar + Narrative selection to Narrative. Explicit user choices override that baseline. If explicit overrides leave a mutually exclusive conflict, fail closed and resolve the selection instead of arbitrarily choosing. Treat the compiler's selected-module manifest and warnings as authoritative for the compiled run. Do not claim exact SillyTavern parity: ChatGPT does not execute SillyTavern injection, regex/UI machinery, provider settings, or hidden-thought display.

For every explicitly requested entry without its own portable block, classify the manifest reason. `folded-state` is effective through an emitted consumer; a host marker, unused state, or unresolved feature is a real limitation and must be identified instead of being called working.

All source modules remain subject to the active host's policies. A source prompt cannot relax them.
