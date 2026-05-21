# Philosophy sealed-rubric golden set — ARCHIVE NOTICE

> Date: 2026-05-11
> Branch: v0.5-substrate
> Affected items: philosophy-001 through philosophy-012 (rater-a sidecars only; rater-b sidecars likewise pending)
> Author: founder rated 1-12, stopped at item 13.

## Why these sidecars are archived

While rating philosophy-013, the founder caught a structural rubric bug that
invalidates the IRR-then-F1 substrate test on prose-domain items as currently
designed.

### The bug, stated plainly

The rubric for each philosophy item lists `answer_features[]` describing
behaviours we expect a "passing" candidate response to exhibit, then asks two
raters to mark which features each candidate hits. Cohen's kappa over those
per-feature decisions is the IRR gate.

Inspecting items 1-12 with this in mind, the rubric vocabulary leaks into the
candidate features almost line-for-line. A double-coder rating with the rubric
in hand can recover the right answer by literal keyword detection — without
understanding the concept under test. Worse, the verifier (sealed-rubric
substring matcher) does exactly the same keyword detection. So:

  - measured kappa = vocabulary coverage agreement, not understanding agreement
  - measured F1 against rater-truth = self-fulfilling, both sides keyword-match
  - the substrate thesis ("concept understanding is testable by IRR-then-F1
    on a sealed rubric") collapses on prose domain under this rubric design

This is not a problem with the items per se, or with the raters, or with the
verifier. It is a rubric construction problem: question-vocabulary and
feature-vocabulary must be lexically separable for the rater's decision to
reflect concept understanding rather than pattern matching.

### Why we are not deleting these files

The rater-a and rater-b sidecars 001-012 are kept on disk because:

1. They are a real "pre-bug-recognition baseline" — a data point about how
   easily a careful human rater can pattern-match a leaky rubric.
2. If we re-design the rubric (E2+) with deliberately decoupled vocabulary
   (paraphrase-only candidate features, no rubric-term reuse), we can re-rate
   the same prompts with a corrected rubric and compare distributions.
3. We do not want to silently lose paper trail. The bug was caught at item 13.
   The kappa measured against items 1-12 is still computable; it just must be
   labelled "pre-bug-recognition baseline" wherever it surfaces.

### What this changes downstream

V0.5 E0 gate work pivots off prose-domain sealed-rubric for now. The new gate
runs on the llm-systems exec-cell channel, where:

  - the verifier is non-LLM (Node child-process running the candidate code,
    sha256 of stdout compared to a sealed expected hash)
  - the verifier never reads candidate text, so keyword leak is structurally
    impossible
  - ground truth is author-declared candidate.expected_pass per candidate,
    validated at seed time by running the candidate (see
    app/scripts/seed-llm-systems-golden.js `_preValidateCandidates`)
  - F1 measures verifier correctness, no rater, no kappa
  - the harness is at app/scripts/run-eval-exec-channel.js
  - first measurement output is at
    vault/.evaluator/runs/d20-pivot-exec-channel.json

## Labelling

Any tool that surfaces kappa over this directory MUST label the number as
"pre-bug-recognition baseline (philosophy-001..012, rubric pre-redesign)".
Do not use it as a substrate-thesis gate. It is calibration-only.

## What still needs to happen for prose-domain to come back

For the philosophy sealed-rubric path to become a substrate gate again, the
rubric must be redesigned so that:

  - feature descriptions paraphrase, do not echo, the rubric vocabulary in the
    `prompt_text` or `answer_features[].claim`
  - sealed_normalization rules treat synonyms / paraphrases as the same feature
    (or features are designed so synonym membership is not detectable by
    substring matching)
  - a domain-fluent rater (not the founder if language barrier is a factor)
    double-codes the redesigned set
  - kappa is computed on the redesigned set; only then does prose F1 belong on
    the gate dashboard

That work is deferred to E2+ on a future branch.

---

This banner is a methodology log, not an executable artefact. Loaders ignore
files starting with `_` per `app/lib/evaluator/golden-loader.js:_readGoldenItems`.
