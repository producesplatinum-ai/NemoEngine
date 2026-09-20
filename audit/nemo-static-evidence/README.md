# Nemo fidelity and provenance evidence

This directory binds the 17 registered fidelity discrepancies to repository-owned,
machine-checkable provenance. The semantic interpretations remain curated review
claims; they are not converted into mathematical proofs by storing excerpts.

## Contents

- `manifest.json` fixes the evidence schemas, review timestamp, counts, audited
  ref, exact guard-registry hash, and known dynamic gap.
- `fidelity-guard.json` contains guards `FG-C002` through `FG-C018`.
- `provenance/excerpts.json` contains 52 exact excerpts bound to repository paths,
  Git blob IDs, and (where applicable) JSON pointers.
- `../../scripts/verify-nemo-fidelity.mjs` verifies the guards, provenance, local
  blobs, pinned-ref path bindings, literal excerpts, module bindings, renderer
  controls for C006/C007, and the canonical preset identity.
- `../../scripts/verify-nemo-fidelity-dynamic.mjs` executes the CLI routes for
  C002 and C011. C010 remains explicitly pending a browser end-to-end test.
- `../../scripts/test-nemo-fidelity-verifier.mjs` mutates ref, blob, pointer,
  symbol, module, dynamic flag, template hash, regex, and file type in an
  isolated worktree and requires every mutation to fail closed.

## Reproduce locally

Run these commands from the repository root with Node.js 22:

```bash
node 'Nemo Engine/Connector Readable/11.5.2 General RP/reassemble.mjs'
node 'Nemo Engine/tools/build-connector-readable-11.5.2.mjs' --check
node scripts/verify-nemo-fidelity.mjs --out structural-verification.json
node scripts/verify-nemo-fidelity-dynamic.mjs --out dynamic-verification.json
node --test scripts/test-nemo-fidelity-verifier.mjs
node --test scripts/test-nemo-chatgpt-runtime.mjs
node --test scripts/test-nemo-chatgpt-executor.mjs
```

The structural verifier requires the audited commit to exist in the local Git
object database and fails closed when a path-to-blob binding, worktree blob,
excerpt, pointer, module, guard relationship, count, preset size, or canonical
SHA-256 differs. CI uses a full checkout, records each command exit code, creates
an aggregate result only after both production test suites finish, and uploads
inputs, implementation snapshots, a self-contained reproduction snapshot,
results, logs, and checksums. Producer and logger exit codes are tracked
separately, and the aggregate requires the exact expected pre-summary file set.

## Scope boundary

`STRUCTURAL_PROVENANCE_PASS` proves only the checked repository relationships and
the C006/C007 regex controls. The CI aggregate may report
`VALIDATION_PASS_WITH_KNOWN_BROWSER_GAP` after reassembly, mirror validation, C002 and
C011 CLI checks, and both production suites pass. Overall fidelity remains
`PARTIAL` while C010 browser E2E is pending and most semantic claims remain
human-reviewed interpretations of the pinned evidence.

This directory is not the larger conversational static-analysis archive: it does
not include the eight analytic ledgers, the 458-entry portability histogram, or
the earlier archive's mutation-test records. No result here trains or alters a
language model, proves model cognition, or claims exact SillyTavern/browser parity.
