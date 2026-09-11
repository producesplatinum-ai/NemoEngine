# Nemo Engine 11.5.2 — connector-readable mirror

This directory is an additive, lossless view of `../Nemo Engine 11.5.2 - General RP.json`. The original importable preset is unchanged.

The source is not minified. Its size exceeds the GitHub Contents response that many chat clients render conveniently, so it is split into valid UTF-8 JSON files of at most 48 KiB. `reassemble.mjs` recreates the original file byte for byte.

## GitHub connector route

1. Read `manifest.json`.
2. Read `prompt-index.jsonl` to locate any prompt, or every file listed under `prompt_shards` to inspect all 456 prompts.
3. Read `prompt-order/100001.json` for the normal ChatGPT/SillyTavern runtime profile. Activation comes from each order entry's `enabled` value, not from `prompts[].enabled`.
4. Read `active-stack/100001.json` for a compact ordered map of the 107 active prompts and their shards.
5. Read every file under `regex_shards` to inspect all 97 regex scripts (95 active).
6. Read `settings.json` for the remaining top-level preset settings.

If code-mode access is available, the connector can also call `github_fetch_blob` with blob `dec71df412a9b2189aec271d1428d0728dde6e3c`, then parse `result.content` inside the tool call without printing the entire 1.7 MB payload. Do not fall back to 11.3 merely because a direct rendered response is truncated.

## Integrity

- Source commit: `ba88f80eb97608d55306e8fd34462d754c908d88`
- Git blob: `dec71df412a9b2189aec271d1428d0728dde6e3c`
- Source bytes: `1689140`
- Source SHA-256: `983e31575b824d0f4910078a2549930495d5f7e5c5e49d508db331cd8a6bd698`
- Prompts: `456`
- Prompt-order profiles: `2`
- Regex scripts: `97`

Run `node reassemble.mjs` from this directory to verify every shard and compare the reconstructed bytes with the original preset.
