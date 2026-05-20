# Hypha

> A methodology log, not a product.

This repository documents an attempt to build a learning system whose claims about a learner's understanding can be falsified by something other than another language model.

## Why this is not a product page

Most learning tools either teach with confidence or grade with confidence. Both moves are cheap when the only check on the answer is the same kind of system that produced it. The substrate here is different: every claim that a learner has understood something must pass a non-language-model verification — a code cell that asserts, a proof that type-checks, or an answer key sealed before the test was taken.

If that substrate doesn't hold, the system is honest about it on this page, in public, with measurements.

## Branch state

- `main` — read-only baseline at `hypha@0.11.2`. Held until first calibration release.
- `v0.5-substrate` — current ship branch. Where week-1 through week-16 work happens.

## What week 1 through week 16 commits to producing

Two artifacts, neither of which is the application itself.

1. A weekly methodology log in `vault/.dev-log/`. Written by hand. Public from day one. Includes failures.
2. A first calibration release in `vault/.calibration/2026-XX-XX/` at week 16. Parameter-frozen corpus, fixed evaluation set, third-party reproducibility script that runs in 30 minutes on commodity hardware. The release ships with measured F1 and Cohen's κ — even if the F1 is below target.

If neither artifact ships, the experiment failed. That failure will be documented in the same dev-log.

## First calibration release

`vault/.calibration/2026-05-31/` — parameter-frozen corpus snapshot, code-channel evaluation set, and a thirty-minute reproducibility script. Ships ahead of the week-16 deadline because the code channel locked early; the broader release at week 16 will extend coverage to additional channels.

## Numbers, with caveats

Three measurements come out of `v0.5-substrate` D20. Each is reported with its source path. Each is qualified, because the figure on its own is misleading without the qualification.

- **Substrate F1 on code domain (mutation-test) — 0.9659.** The verifier was tested against 96 mutations of 20 correct candidates. Recall 1.0, precision 0.934. This is the real substrate signal: it measures whether the exec-cell channel discriminates real correctness from cargo-cult correctness on perturbed code. Source: `vault/.evaluator/runs/d20-mutation-test.json`.
- **Internal consistency F1 (verifier determinism) — 1.0000.** The same verifier auto-judged the original 60 (item, candidate) pairs against author-declared expected_pass labels. F1 is tautological here because the verifier is being asked whether it agrees with the labels it was built to enforce; report it only as a determinism baseline, not as evidence of substrate quality. Source: `vault/.evaluator/runs/d20-pivot-exec-channel.json`.
- **IRR Cohen's κ — not applicable this release.** The sealed-rubric prose path was dropped after a documented rubric design flaw was caught at philosophy item 13. κ on the code channel is meaningless because there is no human rater. The flaw and the decision to archive items 1-12 are written up in `vault/.evaluator/golden/philosophy/_ARCHIVE.md` and the pivot is part of the methodology log at `vault/.dev-log/2026-05-22.md`.

## What is being tested

A claim with one falsifier.

> Goal–Instance–Evidence tuples logged by a single learner can reach 80% transfer-hold under non-language-model verification, with inter-rater reliability κ ≥ 0.7 on a fifty-item double-coded golden set, within four weeks.

If the four-week test passes, week 5 through week 16 attempts the same with ten design partners and a hundred-item evaluation set, ¥1.5 per tuple cost ceiling, F1 ≥ 0.75 on out-of-distribution held-out split.

If either falsifier fires, the work pauses. The dev-log records why.

## What Hypha does today vs eventually

- **Today.** A methodology log, a fifty-item evaluator, and an exec-cell verifier with a measurable robustness profile on code-domain learning. Reproducible end-to-end on commodity hardware in under thirty minutes.
- **Eventually.** A tutor that compounds across sessions, with verified transfer-hold and cross-domain coverage (proof channel, sealed-rubric channel redesigned, additional substrate channels as they become defensible).

No promise about the second bullet until measurements support it.

## Run

```bash
git checkout v0.5-substrate
npm install
export HYPHA_DEFAULT_GLM_KEY="your_glm_key_here"
npm start
```

The application interface preserved from `main` continues to work. The change is internal: a tuple-stream substrate is being added beneath the lesson surface, and the lesson surface itself is being reorganized around instance / response / verdict rather than chat.

## Pre-V0.5 history

Six months of accumulated work was committed as a single baseline at `f8107b3` on `main`. That commit captures four character contracts, a three-provider abstraction, a five-connector harvest layer, an anti-slop telemetry stack, and an early Lesson Quality Harness. None of those components determine whether the four-week falsifier passes; they continue to run as monitoring, not as critical-path verifiers.

## Pre-V0.5 user data

Discarded. Old course state archived to `vault/.archive-pre-v0.5/2026-05-10/` and excluded from version control. The methodology log starts with an empty vault.

## What this repo does not claim

It does not claim to be a private university. It does not claim to teach better than other tools. It does not claim that language-model judgments of learning are reliable. The point of the exercise is to find out whether a different substrate works, and to be specific about how that question is being answered.

## User-facing docs

For people running Hypha as a learning tool rather than auditing the methodology:

- [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md) — install, first goal, first lesson (zh)
- [`docs/PRIVACY.md`](docs/PRIVACY.md) — what stays local, what is sent to providers (zh)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — process split, ten systems, vault layout (en)

## Contributing

See `CONTRIBUTING.md` for how to add a golden item, how to add a verification channel, how to run the evaluator, and how to read the κ and F1 numbers.

## Plan

Full plan lives at `C:\Users\32043\.claude\plans\fluffy-hugging-swan.md` under "V0.5 — Council-Synthesized Path". Sixteen-week scope: epoch zero (substrate proof, four weeks) and epoch one (initial Hypha, twelve weeks). Subsequent epochs (conversion, flywheel, university) are planned separately and gated on this one.
