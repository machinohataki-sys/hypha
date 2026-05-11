# Contributing to Hypha

This document covers four things: how to add a golden item, how to add a verification channel, how to run the evaluator, and how to read the numbers it produces. Read the README first if you have not.

## Adding a Golden Item

Golden items live in `vault/.evaluator/golden/<topic>/<topic>-NNN.json`. They are the substrate. They lock the test before the learner sees it.

### philosophy items

Deferred until the rubric design is corrected. The sealed-rubric path on prose-domain items leaked rubric vocabulary into candidate features, so per-feature κ measured vocabulary-coverage agreement rather than understanding agreement. Items philosophy-001 through philosophy-012 are archived. Do not author new philosophy items in the current schema. See `vault/.evaluator/golden/philosophy/_ARCHIVE.md` and the dev-log entry at `vault/.dev-log/2026-05-22.md`.

### llm-systems items

Each item carries three candidate responses, written by the author, exercising three distinct failure modes:

- `c1` — correct, in a different style from the canonical exec-cell code. Tests that the verifier accepts genuine alternative implementations.
- `c2` — wrong formula or wrong convention. Tests rejection of substantively wrong answers.
- `c3` — cargo-cult: right vocabulary, wrong logic. Tests rejection of answers that pattern-match the prompt without solving it.

Each candidate carries `code` (executable JS) and `expected_pass` (author-declared boolean ground truth). The exec-channel auto-judge runs the code, sha256-compares stdout against `item.exec_cell.expected_stdout_hash`, and reports match against `expected_pass`. Bugs in `expected_pass` abort the seed via `app/scripts/seed-llm-systems-golden.js` at seed time.

Schema example (abbreviated from `llm-systems-001.json`):

```json
{
  "id": "llm-systems-001",
  "topic": "llm-systems",
  "lifecycle": "draft",
  "source_anchor": "Vaswani et al. 2017 §3.2.1",
  "prompt_text": "...",
  "verification_channel": "code",
  "exec_cell": {
    "language": "node",
    "code": "...",
    "expected_stdout_hash": "68438c68...",
    "timeout_ms": 5000
  },
  "k_threshold": 1,
  "candidate_responses": [
    { "id": "c1", "expected_pass": true,  "code": "..." },
    { "id": "c2", "expected_pass": false, "code": "..." },
    { "id": "c3", "expected_pass": false, "code": "..." }
  ],
  "sealed_at": "...",
  "sealed_algorithm": "sha256",
  "prompt_hash": "...",
  "code_hash": "..."
}
```

Field meanings: `source_anchor` cites the canonical reference the prompt is testing knowledge of. `verification_channel` selects the channel module. `k_threshold` is the minimum features-hit count for the sealed-rubric channel (unused by the code channel). `sealed_at` and the hash fields are written by the seed script to prevent silent rewrites; tampering invalidates the item.

## Adding a Verification Channel

Three channels exist today.

- **`code`** (`app/lib/evaluator/verification-channels/exec-cell.js`). Runs candidate code in a sandboxed child process with a five-second default timeout; compares sha256 of stdout against the item's `expected_stdout_hash`. Non-language-model verifier — code asserts pass/fail.
- **`sealed_rubric`** (`app/lib/evaluator/verification-channels/sealed-rubric.js`). Per-feature substring match against a sealed answer key with alt-phrasing tolerance. Currently flawed for prose-domain items as documented in `_ARCHIVE.md`; redesign deferred.
- **`proof`** (`app/lib/evaluator/verification-channels/lean-check.js`). Stub. Deferred to epoch 2.

To add a new channel:

1. Implement a module under `app/lib/evaluator/verification-channels/`. It must export at least `lockX(itemSpec) → sealedItem` (called at seed time to commit the answer key and hashes) and `verifyAgainstX(item, candidate) → { pass, evidence }` (called per (item, candidate) pair to produce a binary verdict and verifier-specific evidence).
2. Extend the channel dispatcher in `app/lib/evaluator/f1-harness.js` to route items whose `verification_channel` matches the new channel to your module.
3. Add a seed script under `app/scripts/seed-<channel>-golden.js` that validates author-declared ground truth at seed time and refuses to seal items whose declared truth disagrees with the verifier's own verdict.

A channel that does not refuse to seal its own contradictions is not yet a substrate.

## Running the Evaluator

Three scripts.

- `app/scripts/run-eval-exec-channel.js` — auto-judges all 60 (item, candidate) pairs on the code channel against author-declared `expected_pass`. The F1 it reports is tautological by construction (the verifier is checking the labels it was built to enforce); report it as an internal-consistency baseline only.
- `app/scripts/run-mutation-test.js` — mutation-test on c1 candidates. Applies perturbations that should preserve correctness (rename variables, inject no-op statements) and mutations that should break it (reverse argument order, off-by-one, etc.), then measures how the verifier scores them. The F1 here is the real substrate signal: it answers whether the verifier discriminates genuine correctness from surface-similar mistakes.
- `app/scripts/run-evaluation-d10.js` — chains the seeder, the wolf-rater, the κ check, and the F1 harness for the sealed-rubric path. Currently inert because the philosophy items are archived.

Each script writes to `vault/.evaluator/runs/<date>.json`.

## Reading the κ and F1

### Cohen's κ — inter-rater reliability

Measures agreement between two human raters on per-feature labels, corrected for chance agreement. Gate: κ ≥ 0.7 before any F1 computed downstream. Not relevant for the code channel because there is no human rater; the channel's ground truth is `candidate.expected_pass`. Reporting κ on the code channel would be a category error.

Source path when applicable: per-topic κ is written into `vault/.evaluator/golden/<topic>/_ledger.json` at load time by `app/lib/evaluator/golden-loader.js`.

### F1 on mutation-test

Measures verifier robustness. Recall = fraction of correctness-preserving perturbations the verifier still accepts. Precision = fraction of accepted responses that are genuinely correct. Gate: F1 ≥ 0.75 on the mutation set for the channel to count as a substrate.

Reported in this release: **0.9659**. Source: `vault/.evaluator/runs/d20-mutation-test.json` (`f1` field).

### F1 on internal consistency

Measures whether the verifier deterministically agrees with the labels it was built to enforce. Useful only as a determinism check. Do not report it as substrate signal — the test cannot fail in any informative way unless the verifier is non-deterministic or the seed script is broken.

Reported in this release: **1.0000**. Source: `vault/.evaluator/runs/d20-pivot-exec-channel.json` (`f1` field).

## What Counts As "Pass" in Each Channel

- **`code`**: `exit_code === 0` AND `sha256(stdout) === item.exec_cell.expected_stdout_hash`. Stdout is taken raw (no rstrip) to match exec-cell's behaviour.
- **`sealed_rubric`**: `features_hit.length ≥ item.k_threshold` AND each claimed feature matches by substring against the rubric's `alt_phrasings[]` for that feature, after the channel's normalization (trim ends, collapse whitespace, lowercase).
- **`proof`**: stub. Defined in epoch 2 when the Lean stack is wired.

## Reproducing the Calibration Release

The first calibration release at `vault/.calibration/2026-05-31/` ships two reproducibility scripts:

- `repro.sh` for POSIX shells
- `repro.ps1` for PowerShell

Expected runtime: under thirty minutes on commodity hardware (16GB RAM, no GPU required). Expected F1 within ±0.03 of the release-locked numbers reported in `run.log`. If your reproduction lands outside that band, open an issue and attach your `run.log` plus your environment dump; substrate divergence is a substantive finding, not user error.
