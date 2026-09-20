# Nemo static fidelity evidence

This directory turns the 17 registered fidelity discrepancies into repository-owned,
machine-checkable evidence.

## Contents

- `fidelity-guard.json` contains guards `FG-C002` through `FG-C018`.
- `provenance/excerpts.json` contains 52 exact excerpts bound to repository paths,
  Git blob IDs, and (where applicable) JSON pointers.
- `../../scripts/verify-nemo-fidelity.mjs` verifies the guards, provenance, local
  blobs, literal excerpts, and the canonical preset identity.

## Reproduce locally

Run these commands from the repository root with Node.js 22:

```bash
node 'Nemo Engine/Connector Readable/11.5.2 General RP/reassemble.mjs'
node 'Nemo Engine/tools/build-connector-readable-11.5.2.mjs' --check
node scripts/verify-nemo-fidelity.mjs --out verification.json
node --test scripts/test-nemo-chatgpt-runtime.mjs
node --test scripts/test-nemo-chatgpt-executor.mjs
```

The verifier fails closed when a referenced file, blob ID, excerpt, guard binding,
count, preset size, or canonical SHA-256 differs. CI uploads the verification
result, test logs, evidence inputs, and package checksums as a workflow artifact.

## Scope boundary

A PASS proves the checked repository relationships and the test executions from
that run. It does not train or alter a language model, claim browser-renderer
parity with SillyTavern, or resolve the discrepancies described by the guards.
Those remain explicit behavioral constraints until their source/runtime semantics
are deliberately reconciled and reviewed.
