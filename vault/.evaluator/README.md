# vault/.evaluator/

Evaluator artifacts for V0.5. Tracked in git; public.

## Subdirs

- `golden/` — HITL-labeled tuples organized by topic. Each topic dir contains JSON files with double-coded labels (rater_a / rater_b / agreement). 50 items at E0, 100 items at E1.
- `runs/` — Weekly F1 + IRR Cohen's κ snapshots. One JSONL file per date.
- `verification-channels/` (referenced from `app/lib/evaluator/verification-channels/`) — code-cell / sealed-rubric / lean-check implementations live in `app/lib/`, not here.

## Conventions

- **IRR before F1**: any F1 number published in this directory must be preceded by a Cohen's κ ≥ 0.7 result on the same eval set. The hypha-constitution rule applies here too.
- **Lifecycle field**: every golden item carries `lifecycle: 'draft' | 'ratified' | 'superseded' | 'deprecated'`. Default `draft` on creation.
- **Discarded items stay**: items moved to `lifecycle: 'deprecated'` remain in the directory with the deprecation reason, do not delete.

## E0 golden item schema

```json
{
  "id": "philosophy-tuple-001",
  "topic": "philosophy",
  "lifecycle": "ratified",
  "instance": "<the prompt the learner sees>",
  "response_passed": "<an example response that passed verification>",
  "response_failed": "<an example response that failed verification>",
  "verification_channel": "sealed_rubric",
  "answer_key_hash": "<sha256 of the rubric, locked before test>",
  "rater_a": { "name": "...", "verdict": "pass", "justification": "..." },
  "rater_b": { "name": "...", "verdict": "pass", "justification": "..." },
  "agreement": true,
  "notes": "..."
}
```
