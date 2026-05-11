# V0.5 E0 First Calibration Release — 2026-05-31

Branch *v0.5-substrate* at commit `3809de337d5cbea9e27e68dc0ec5a0a1b2e714b6`.

This directory is a methodology log, not a product release. It records what
the substrate test looked like at the end of E0, what the numbers measure,
what they do not measure, and how a reviewer who has never touched Hypha
can run the same scripts and arrive at the same numbers.

## What this release contains

- `run.log` — machine-generated metrics summary. Plain text.
- `repro.sh` — bash reproduction script (Linux, macOS, WSL, git-bash).
- `repro.ps1` — PowerShell reproduction script (Windows native).
- `golden-snapshot/` — frozen copy of `vault/.evaluator/golden/` as it
  stood on 2026-05-31. 30 philosophy items plus 20 llm-systems items
  with all sidecars (`.zh.json`, `.rater-*.json`) and the philosophy
  archive notice. The copy is bit-exact — every byte agrees with the
  live tree at this commit.
- This `README.md`.

## What the numbers mean

Two F1 numbers ship in `run.log`. They measure different things and a
reviewer must read them differently.

### F1 = 0.9659 — mutation-test, substrate signal

Source: `vault/.evaluator/runs/d20-mutation-test.json`.

For each of the 20 llm-systems items, the seed-time correct candidate
(`c1`) was passed through 11 transformations: 5 perturbations that
preserve semantics (rename, comment, whitespace, parenthesisation, void
no-op), and 6 mutations that break semantics (off-by-one, sign flip,
const-zero, comparator inversion). A perturbation that the verifier
still accepts is a true positive; a mutation that the verifier rejects
is a true negative; a mutation that the verifier accepts is a false
positive; a perturbation the verifier rejects is a false negative.

195 transformations were run. Result: TP 99, FP 7, FN 0, TN 89.

The headline number is the F1 of the verifier against this
transformation-implied ground truth: precision 0.9340, recall 1.0000,
F1 0.9659.

What would falsify this claim. Re-running the suite on the same commit
producing F1 outside `0.9659 +/- 0.03` falsifies the reproducibility
claim. Re-running with different mutations producing FN > 0 falsifies
the recall claim. Re-running with FP exceeding the seven listed
output-invariance cases — `off_by_one_2000_to_2001` on item 8,
`sign_flip_8` on item 12, the two `cmp_invert` cases on items 11/13/17,
the two `const_zero` cases on items 10/15/16/17, and `sign_flip_1.2`
on items 10/16 — falsifies the output-invariance attribution.

### F1 = 1.0000 — auto-judge, internal consistency only

Source: `vault/.evaluator/runs/d20-pivot-exec-channel.json`.

Each of the 60 (item, candidate) pairs was run through the exec-cell
verifier. The verifier's prediction was compared to the seed-time
author declaration of `candidate.expected_pass`. Result: TP 20, FP 0,
FN 0, TN 40, F1 1.0000.

This number does not measure substrate quality. The seed-time author
declaration was forced to match verifier output during validation
(see `app/scripts/seed-llm-systems-golden.js` `_preValidateCandidates`
and the commit-message bug notes for `llm-systems-004` and
`llm-systems-017`). The auto-judge therefore measures verifier
determinism against itself, no more. It ships in this release as a
sanity check — if it ever drops below 1.0 the verifier has become
non-deterministic and the mutation-test number is invalid.

What would falsify this claim. Re-running the suite on the same commit
producing F1 below 1.0000 falsifies determinism.

## What this release does NOT prove

This release does not prove that Hypha can verify prose-domain concept
understanding. The philosophy items 001-012 carry `rater-a` sidecars
authored before a structural rubric bug was caught at item 013. The
bug, recorded in `golden-snapshot/philosophy/_ARCHIVE.md`, is that the
rubric vocabulary leaks into the candidate features almost line-for-line,
so a rater holding the rubric can recover the right answer by literal
keyword detection without understanding the concept. The verifier
(sealed-rubric substring matcher) does exactly the same keyword
detection. Cohen's kappa over that data measures vocabulary coverage
agreement, not understanding agreement. The IRR-then-F1 gate on the
philosophy set is therefore not a substrate test. Re-design of the
rubric with deliberately decoupled vocabulary is deferred to E2 on a
future branch.

This release does not prove cross-rater reliability. There is no
human IRR in this calibration. The mutation-test is a verifier-vs-self
test, not a verifier-vs-humans test.

This release does not prove transfer to real lesson events. The
exec-cell channel verifies code that runs in a sandbox child process.
Lesson chat turns, persona output, and harvest results are not yet on
this gate.

This release does not prove operating cost. Of the 74 LLM calls in
the SQLite ledger during the calibration window, only one carried
token-and-cost metadata; the 72 `translateZh` harvest calls returned
without usage blocks. Cost metering is queued for E1.

## How to reproduce

On a workstation with Node 18+, run from inside `vault/.calibration/2026-05-31/`:

```bash
./repro.sh
```

Or on Windows native PowerShell:

```powershell
.\repro.ps1
```

The script changes into the repository root, installs dependencies,
re-seeds the llm-systems golden set, runs the auto-judge, then runs
the mutation-test. Expected runtime under 30 minutes on commodity
hardware. Expected F1 on the mutation-test is `0.9659 +/- 0.03`.

Output JSON files are written to `vault/.evaluator/runs/`.

If the numbers diverge, the methodology is broken and we want to hear
about it. Open an issue against the branch with the diverging run log
attached.

## Path to E1

E0 closed on Day 20 with a pivot. The substrate thesis — that a
non-LLM verifier can score candidate answers without rater drift — is
validated on code domain via the mutation-test above. The same thesis
on prose domain is open; the rubric must be re-designed before that
gate is meaningful.

E1 runs Week 4 through Week 16 of the substrate branch. The work
queued so far is:

- Cost and token metering on every LLM call, not only seed-time calls.
- A second exec-cell topic to test that the mutation-test number does
  not depend on the llm-systems item authoring style.
- A re-designed sealed-rubric on a fresh philosophy subset, with
  feature vocabulary held lexically disjoint from prompt vocabulary,
  and a domain-fluent rater double-coding the redesigned set.
- A `lean-check` proof channel stub, currently deferred. The third
  verification channel is the gate for E2.

The first paying-user-eligible gates are the cost meter and the
second exec-cell topic. Until both close, no user pays.

A second calibration release is scheduled for the end of Week 16.
That release will include real human IRR on the redesigned rubric, a
non-trivial cost number, and the second exec-cell topic. If the
mutation-test F1 on llm-systems regresses between this release and
the next, the regression itself becomes a methodology log entry; the
release ships anyway with the regression annotated.

---

Calibration release ships even if the number is below target. The
log explains why. The repro scripts let an outside reader check the
log.
