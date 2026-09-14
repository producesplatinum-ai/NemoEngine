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
- `scripts/test-nemo-chatgpt-runtime.mjs` checks the compiler, its defaults,
  module selection, invalid-input handling, and deterministic output.

The adapter uses `prompt_order` as the authority for enabled prompts. Its
default profile is `100001`; the shipped Haar/Narrative Vex conflict is resolved
to Narrative. The shipped profile keeps its modern `NSFW Core`; Gooner and
Fetish modules stay disabled unless they are selected explicitly. Run the
compiler's help and list commands for the exact selectors supported by the
checked-out version:

```sh
node scripts/nemo-chatgpt-runtime.mjs --help
node scripts/nemo-chatgpt-runtime.mjs --list all
```

Compile the default runtime package:

```sh
node scripts/nemo-chatgpt-runtime.mjs \
  --profile 100001 \
  --pretty \
  --out build/nemo-chatgpt-runtime.json
```

Every one of the preset's 458 prompt entries can be addressed with the generic,
repeatable `--enable LIST` and `--disable LIST` overrides; each list accepts
comma-separated identifiers or display names and is applied after the family
selectors. `--vex SELECTOR`,
`--nsfw LIST`, and `--fetish LIST` are convenience selectors for those named
families; they are not the limit of the adapter. `--preset PATH` selects another
compatible source preset. Selection is explicit and deterministic: the adapter
does not silently enable every available module or combine mutually
incompatible writing strategies.

For example:

```sh
node scripts/nemo-chatgpt-runtime.mjs \
  --enable "Character Friction" \
  --disable "More Dialogue" \
  --pretty
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

The runtime compiler and connector-readable mirror use only Node.js built-ins;
there is no npm dependency installation step. From the repository root, run:

```sh
node --test scripts/test-nemo-chatgpt-runtime.mjs
node 'Nemo Engine/tools/build-connector-readable-11.5.2.mjs' --check
```

The second command regenerates the expected connector representation in memory
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
with SillyTavern.
