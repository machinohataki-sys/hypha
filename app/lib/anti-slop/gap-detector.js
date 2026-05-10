'use strict';
// HYPHA · Gap Detector (AMD-MEOW-P7 M3)
//
// Pure-JS, no LLM. Detects the gap between what a lesson skeleton/body CLAIMS
// to have done (apparent_completion) and what is actually backed by evidence
// (verified_completion). The delta is the "Apparent-Success-Seeking" surface
// the user can see in the Course Trust Panel.
//
// Contract: input is a plan + optional body + the evidence_ledger that the
// Generator (or Evidence Auditor) attached. We do not score truth; we score
// only whether claims have provenance backing.

/**
 * Count "apparent" claims = the Generator's surface. Heuristic — every path
 * step + the objective + each hook fragment + each body path_prose entry is
 * one apparent claim.
 *
 * @param {object} plan
 * @param {object} [body]
 * @returns {number}
 */
function countApparentClaims(plan, body) {
  let n = 0;
  if (plan && typeof plan === 'object') {
    if (typeof plan.objective === 'string' && plan.objective.trim()) n++;
    if (typeof plan.hook_concrete === 'string' && plan.hook_concrete.trim()) n++;
    if (Array.isArray(plan.path)) n += plan.path.filter(s => typeof s === 'string' && s.trim()).length;
    if (plan.micro_proof && typeof plan.micro_proof === 'object') {
      if (typeof plan.micro_proof.stimulus === 'string') n++;
      if (typeof plan.micro_proof.expected_signal === 'string') n++;
    }
  }
  if (body && typeof body === 'object') {
    if (typeof body.intro_prose === 'string' && body.intro_prose.trim()) n++;
    if (typeof body.closing_prose === 'string' && body.closing_prose.trim()) n++;
    if (Array.isArray(body.path_prose)) n += body.path_prose.filter(s => typeof s === 'string' && s.trim()).length;
  }
  return n;
}

/**
 * Count "apparent" claims from a per-turn lesson transcript (Phase C-5).
 * Pure heuristic: each assistant turn contributes one apparent claim per
 * assertion-like sentence (period/question/exclamation-ended, > 4 words).
 * User turns are ignored — they are inputs, not the agent's surface.
 *
 * @param {Array<{role:'user'|'assistant', text:string}>} transcript
 * @returns {number}
 */
function countApparentClaimsFromTranscript(transcript) {
  if (!Array.isArray(transcript)) return 0;
  let count = 0;
  for (const t of transcript) {
    if (!t || typeof t.text !== 'string') continue;
    // MEOW Gate B Patch 4 (2026-05-08): accept BOTH 'assistant' (chat-mode
    // canonical) AND 'tutor' (main.js:2663 persists this role for vault
    // session jsonl). Previously rejecting 'tutor' meant recalibrate sweeps
    // on real CN sessions counted 0 claims when fed raw vault rows.
    if (t.role !== 'assistant' && t.role !== 'tutor') continue;
    // CN-aware sentence count: split on EN + CN sentence terminators + newlines.
    // Filter signal: char count > 12 OR word count > 4 — captures CN sentences
    // (no whitespace, single \s+-token after split → word count = 1, fails old
    // word-only filter). Char threshold tuned against a 28-turn CN session
    // where the prior heuristic returned 2 claims (implausibly low).
    const sentences = t.text
      .split(/[.!?。！？\n]+/)
      .filter(s => {
        const trimmed = s.trim();
        if (!trimmed) return false;
        const words = trimmed.split(/\s+/).filter(Boolean).length;
        return trimmed.length > 12 || words > 4;
      });
    count += sentences.length;
  }
  return count;
}

/**
 * Count "verified" claims from an evidence_ledger. A row counts as verified
 * iff it has a non-null evidence_pointer AND confidence != 'speculative'
 * AND verifiability ∈ {high, partial}.
 *
 * @param {Array} ledger
 * @returns {number}
 */
function countVerifiedClaims(ledger) {
  if (!Array.isArray(ledger)) return 0;
  return ledger.filter(row => {
    if (!row || typeof row !== 'object') return false;
    const hasPointer = row.evidence_pointer !== null && row.evidence_pointer !== undefined && row.evidence_pointer !== '';
    const realConfidence = row.confidence && row.confidence !== 'speculative';
    const verifiableEnough = row.verifiability === 'high' || row.verifiability === 'partial';
    return hasPointer && realConfidence && verifiableEnough;
  }).length;
}

/**
 * Compute the gap between apparent and verified completion.
 *
 * @param {object} args
 * @param {object} [args.plan]
 * @param {object} [args.body]
 * @param {Array}  [args.evidenceLedger]
 * @param {Array<{role:'user'|'assistant', text:string}>} [args.transcript] —
 *   per-turn lesson transcript (Phase C-5). When supplied + non-empty,
 *   apparent-claim count comes from `countApparentClaimsFromTranscript` and
 *   the plan/body path is skipped. Backward-compatible.
 * @returns {{apparent_completion: number, verified_completion: number, gap_score: number, gap_pct: number, details: object}}
 */
function computeGap({ plan, body, evidenceLedger, transcript } = {}) {
  const useTranscript = Array.isArray(transcript) && transcript.length > 0;
  const apparent = useTranscript
    ? countApparentClaimsFromTranscript(transcript)
    : countApparentClaims(plan, body);
  const verified = countVerifiedClaims(evidenceLedger);
  // Cap verified at apparent — it makes no sense to have more verified rows
  // than apparent claims; if it happens, the ledger likely covers claims we
  // didn't enumerate (use min for the ratio).
  const cappedVerified = Math.min(verified, apparent);
  const gap = apparent === 0 ? 0 : (apparent - cappedVerified) / apparent;
  const gapPct = Math.round(gap * 100);

  const speculative = Array.isArray(evidenceLedger)
    ? evidenceLedger.filter(r => r && r.confidence === 'speculative').length
    : 0;
  const lowVerif = Array.isArray(evidenceLedger)
    ? evidenceLedger.filter(r => r && (r.verifiability === 'low' || r.verifiability === 'unverifiable')).length
    : 0;

  return {
    apparent_completion: apparent,
    verified_completion: cappedVerified,
    gap_score: Number(gap.toFixed(3)),
    gap_pct: gapPct,
    details: {
      ledger_total_rows: Array.isArray(evidenceLedger) ? evidenceLedger.length : 0,
      verified_rows_uncapped: verified,
      speculative_rows: speculative,
      low_verifiability_rows: lowVerif,
    },
  };
}

/**
 * Render gap as a 1-line summary suitable for Course Trust Panel default tier.
 * Example: "Gap 31% (apparent 13 / verified 9 — 4 unverified)".
 */
function renderGapSummary(gap) {
  if (!gap || typeof gap !== 'object') return 'Gap n/a';
  const unverified = gap.apparent_completion - gap.verified_completion;
  return `Gap ${gap.gap_pct}% (apparent ${gap.apparent_completion} / verified ${gap.verified_completion} — ${unverified} unverified)`;
}

module.exports = {
  computeGap,
  countApparentClaims,
  countApparentClaimsFromTranscript,
  countVerifiedClaims,
  renderGapSummary,
};
