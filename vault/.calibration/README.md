# vault/.calibration/

Calibration releases. Each subdirectory is one dated release containing:

- `corpus.frozen.json` — parameter-frozen corpus snapshot (model versions, prompt versions, source list)
- `eval-set.json` — fixed evaluation items (ratified subset of `vault/.evaluator/golden/<topic>/`)
- `repro.sh` — third-party reproducibility script (≤30 minutes runtime on commodity hardware)
- `run.log` — F1 and Cohen's κ output, signed
- `external-review.md` — independent reviewer's run notes (one-line outcome + observed F1)

First calibration release scheduled for week 16 of `v0.5-substrate`. The release ships even if the F1 number is below target. The dev-log explains why.
