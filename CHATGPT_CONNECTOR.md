# Nemo Engine 11.5.2 in ChatGPT

Nemo Engine 11.5.2 is a SillyTavern completion preset. The original
`Nemo Engine/Nemo Engine 11.5.2 - General RP.json` remains the authoritative
source. It is not a native ChatGPT configuration and cannot be installed into
ChatGPT with exact SillyTavern behaviour.

This repository nevertheless contains a best-effort ChatGPT adapter:

- `SKILL.md` tells a skill-aware ChatGPT session when and how to compile the
  preset.
- `scripts/nemo-chatgpt-runtime.mjs` reads the authoritative JSON, resolves the
  selected profile and module choices, and emits a deterministic runtime
  package suitable for use as ChatGPT context.
- `scripts/nemo-chatgpt-executor.mjs` binds an exact user task, verifies the
  compiled artifacts, delivers bounded authenticated units, and sanitizes the
  final output through a fail-closed lifecycle.
- `scripts/test-nemo-chatgpt-runtime.mjs` checks the compiler, its defaults,
  module selection, invalid-input handling, and deterministic output.
- `scripts/test-nemo-chatgpt-executor.mjs` checks the v2 run contract, delivery
  protocol, lifecycle, artifact integrity, and output boundary.

The adapter uses `prompt_order` as the authority for enabled prompts. Its
default profile is `100001`; the shipped Haar/Narrative Vex conflict is resolved
to Narrative. The shipped profile keeps its modern `NSFW Core`; Gooner and
Fetish modules stay disabled unless they are selected explicitly. From the
skill/repository root (the directory containing `SKILL.md`), run the compiler's
help and list commands for the exact selectors supported by the checked-out
version:

```sh
nemo_inventory_dir="$(mktemp -d)"
node scripts/nemo-chatgpt-runtime.mjs --help
node scripts/nemo-chatgpt-runtime.mjs \
  --list all \
  --out "$nemo_inventory_dir/inventory.json"
```

Run all other relative commands from that same root. Query the saved inventory
only for the exact family, name, or identifier needed; do not print all 458
entries into one tool result.

For normal ChatGPT execution, create a `nemo-chatgpt-run-spec/v2` file and use
the production executor. The task request is required and exact; continuity is
optional and must contain only facts visible in the conversation:

```json
{
  "schemaVersion": "nemo-chatgpt-run-spec/v2",
  "task": {
    "mode": "generate",
    "request": "the exact current user request"
  },
  "deliveryUnitChars": 12000,
  "profile": 100001,
  "selections": {
    "groups": [
      { "group": "Narrate-Language", "selector": "Narrate: Russian" },
      { "group": "Perspective", "selector": "First Person" }
    ],
    "enable": [],
    "disable": []
  }
}
```

```sh
nemo_parent="$(mktemp -d)"
# Save the JSON spec above as "$nemo_parent/run-spec.json".

node scripts/nemo-chatgpt-executor.mjs prepare \
  --spec "$nemo_parent/run-spec.json" \
  --run-dir "$nemo_parent/run"

node scripts/nemo-chatgpt-executor.mjs next \
  --run-dir "$nemo_parent/run"

node scripts/nemo-chatgpt-executor.mjs advance \
  --run-dir "$nemo_parent/run" \
  --unit 1 \
  --sha256 SHA_FROM_COMPLETE_FOOTER \
  --receipt RECEIPT_FROM_COMPLETE_FOOTER
```

Continue `advance` with each completely seen footer until
`phase: ready_to_draft`. Units are split at semantic and Unicode-grapheme
boundaries and bounded by both characters and UTF-8 bytes. Runtime content is
delivered first; the signed task anchor containing the exact request is last.
If output is deterministically truncated, start a fresh run with a smaller
immutable `deliveryUnitChars`. If the user changes the task during delivery,
abandon the stale run and prepare a new exact task anchor.

After drafting, `finish` may be retried after completion only with the exact
same draft bytes (the same SHA-256); a different draft is rejected. Obtain the
user-facing bytes only with `show-output`.

Output sanitization is a fail-closed structural boundary. In addition to the
direct text, it examines an NFKC, Default-Ignorable-stripped,
Markdown-deobfuscated safety shadow and rejects bidirectional controls, HTML
entities, residual generic or OOC/service markup, `[[...]]` / `{{...}}`
service syntax, and reserved Nemo framing. This is not semantic DLP or proof
that otherwise ordinary prose does not restate or paraphrase task-context
material.

Use `task.mode: inspect` for configuration or diagnosis. It returns
`phase: inspection_ready` with public inspection data and no payload delivery.
Readiness is reported as `compilation`, `context`, `transport`, and
`contextFit`; the last remains `host_unverified` rather than pretending that
character and byte counts prove a model-context fit.

The portable Auto Image rewrite never fabricates an external image URL or
claims generation. It may use an image tool only when the current host actually
exposes one and the user explicitly requests an image; invocation remains
host-controlled. Otherwise it emits at most a concise Markdown `Visual brief`
when useful. The compiler reports this compatibility rewrite as
`PORTABLE_GPT_NATIVE_REWRITE` plus `PORTABLE_UI_DEGRADED`.

Every one of the preset's 458 prompt entries can be addressed with the generic,
repeatable `--enable LIST` and `--disable LIST` overrides; each list accepts
comma-separated identifiers or display names and is applied after family and
group selectors. `--group-one GROUP::SELECTOR` atomically replaces one member
of a mutually exclusive group. `--vex SELECTOR`,
`--nsfw LIST`, and `--fetish LIST` are convenience selectors for those named
families; they are not the limit of the adapter. `--preset PATH` selects another
compatible source preset. Selection is explicit and deterministic: the adapter
does not silently enable every available module or combine mutually
incompatible writing strategies.

For example:

```sh
node scripts/nemo-chatgpt-runtime.mjs \
  --group-one "Narrate-Language::Narrate: Russian" \
  --group-one "Perspective::First Person" \
  --enable "Character Friction" \
  --disable "More Dialogue" \
  --pretty \
  --out build/nemo-chatgpt-runtime.json
```

Psychology, Humiliation, and interactive JOI can be compiled together without
enabling unrelated Fetish modules:

```sh
node scripts/nemo-chatgpt-runtime.mjs \
  --enable "v11-611-augment-manipulation-realism,v11-613-augment-psychological-emotional-realism" \
  --fetish "Humiliation,JOI" \
  --pretty \
  --out build/nemo-psychology-humiliation-joi.json
```

For the adapter's supported semantics, output contract, integration notes, and
known limits, see `references/chatgpt-runtime.md`.

## Validation

The adapter and connector-readable mirror use only Node.js built-ins; there is
no npm dependency installation step. From the repository root, run:

```sh
node --test scripts/test-nemo-chatgpt-runtime.mjs
node --test scripts/test-nemo-chatgpt-executor.mjs
node 'Nemo Engine/tools/build-connector-readable-11.5.2.mjs' --check
```

The third command regenerates the expected connector representation in memory
and compares it with every checked-in shard. The mirror remains an exact,
byte-verifiable view of the authoritative monolithic preset. Its entry point is
`Nemo Engine/Connector Readable/11.5.2 General RP/README.md`.

In code mode, a GitHub connector can alternatively fetch blob
`34a469106a1df6fa88a77e3ae0673d0271e21fee` and parse the full tool result
without printing the entire payload into a model response. Do not substitute
the older 11.3 prompt archive.

## Compatibility boundary

The adapter preserves and validates the parts that can be represented as an
ordered ChatGPT prompt package. It does not reproduce the SillyTavern runtime.
In particular, ChatGPT does not provide exact parity for SillyTavern macros,
prompt injection depth/order, lorebook orchestration, regex-based output
rewrites and tracker widgets, provider-specific samplers, prefills, or hidden
reasoning controls. Model and host safety rules also remain authoritative.

Therefore a successful compile means that the selected Nemo prompt logic was
assembled consistently; it is not a claim of byte-for-byte behavioural parity
with SillyTavern. Source role, depth, placement, and `LAW` labels remain task
context metadata; they do not become host system messages. Runtime examples,
cards, optional defaults, and unresolved placeholders are not facts about the
user's requested scenario. A delivery receipt proves verified host transport,
not model cognition or cross-turn persistence.

Executor primary and recovery locks require strict schema, kind, PID,
timestamp, owner-token, and liveness-domain metadata. Lock names are published
atomically from synchronized candidates through exclusive hard links.
Automatic stale recovery occurs only when the current Linux hostname, boot ID,
and PID namespace reproduce the lock's strong liveness domain and its recorded
PID is provably absent. Foreign, weak-domain, live, empty, partial, or malformed
locks fail closed.

Each recovery lease is namespaced by the primary lock's owner token. Each lock
acquisition supplies a unique operation ID for draft/sanitizer staging, and
exclusive hard-link publication prevents a resumed orphan sanitizer child from
overwriting a newer generation. An uncommitted `clean-output.txt` is removed
automatically only when it is a regular file with exactly one same-inode,
operation-scoped sanitizer staging alias; every ambiguous case fails closed and
requires abandoning the opaque run directory for a fresh run.
