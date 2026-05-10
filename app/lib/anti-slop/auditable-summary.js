'use strict';
// HYPHA · Auditable Reasoning Summary (AMD-MEOW-P7 M5)
//
// Pure-JS composer (no LLM call). Aggregates outputs from earlier passes:
//   - plan + body (structure)
//   - evidence_ledger (provenance)
//   - confession (Generator self-report)
//   - drift_score (Goal Drift Detector v0.2 partial, optional)
//   - persona_coherence (P8 C3 score, optional)
//   - prosecutor charges + judge rulings (for "反对意见" section)
//
// Output: {markdown, structured} dual channel. Markdown is what the user
// reads in Course Trust Panel 展开 layer. Structured is what the system
// stores for downstream queries (Knowledge Contamination Graph etc).

/**
 * @param {object} args
 * @param {object} [args.plan]
 * @param {object} [args.body]
 * @param {Array<{role:'user'|'assistant', text:string}>} [args.transcript] —
 *   per-turn lesson transcript (Phase C-5). When `plan.path` is empty/missing
 *   and transcript has assistant turns, a `turn-N` chain is synthesized as
 *   the narrative ordering for `关键推理`. Backward-compatible: existing
 *   `plan.path` callers are unaffected.
 * @param {Array}  [args.evidenceLedger]
 * @param {object} [args.confession] — output of generateConfession
 * @param {number} [args.driftScore] — output of goal-drift-detector (0-1; optional)
 * @param {object} [args.personaCoherence] — output of computePersonaCoherence
 * @param {Array}  [args.charges] — Prosecutor charges
 * @param {Array}  [args.rulings] — Judge rulings (parallel to charges)
 * @returns {{markdown: string, structured: object}}
 */
function composeAuditableSummary({
  plan,
  body,
  transcript,
  evidenceLedger,
  confession,
  driftScore,
  personaCoherence,
  charges,
  rulings,
} = {}) {
  // ── 结论 ──
  const conclusion = (plan && plan.objective) || '(no objective set)';

  // ── 依据 ──
  const evidenceRows = Array.isArray(evidenceLedger) ? evidenceLedger : [];
  const evidenceSummary = evidenceRows.length === 0
    ? ['(no evidence ledger attached — claims unverified at v0.2 P0)']
    : evidenceRows.slice(0, 6).map((r, i) =>
        `- [${r.evidence_type}/${r.confidence}] ${r.claim_text || '(no text)'} → ${r.evidence_pointer || 'null'}`);
  if (evidenceRows.length > 6) evidenceSummary.push(`- ... and ${evidenceRows.length - 6} more rows`);

  // ── 关键推理 ──
  // Per Phase C-5: if no plan.path available but transcript supplied, synth
  // a turn-N chain so post-session audit still has a narrative spine.
  let pathSteps;
  if (plan && Array.isArray(plan.path) && plan.path.length > 0) {
    pathSteps = plan.path.slice();
  } else if (Array.isArray(transcript) && transcript.length > 0) {
    pathSteps = transcript
      .filter(t => t && t.role === 'assistant')
      .map((_t, i) => `turn-${i + 1}`);
  } else {
    pathSteps = [];
  }
  const pathChain = pathSteps.length > 0
    ? pathSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : '(no path set)';

  // ── 不确定性 ──
  const uncertaintyItems = [];
  if (Array.isArray(confession?.unverified_claims)) {
    for (const c of confession.unverified_claims) uncertaintyItems.push(`unverified: ${c}`);
  }
  if (Array.isArray(confession?.speculative_claims)) {
    for (const c of confession.speculative_claims) uncertaintyItems.push(`speculative: ${c}`);
  }
  for (const r of evidenceRows) {
    if (r && (r.verifiability === 'low' || r.verifiability === 'unverifiable')) {
      uncertaintyItems.push(`low-verif: ${r.claim_ref} (${r.evidence_type})`);
    }
  }
  if (typeof driftScore === 'number' && driftScore > 0.3) {
    uncertaintyItems.push(`goal drift score: ${driftScore.toFixed(2)} — plan may have drifted from goal`);
  }
  const uncertainty = uncertaintyItems.length === 0 ? ['(none reported)'] : uncertaintyItems.map(s => `- ${s}`);

  // ── 反对意见 ──
  // Per anti-slop-layer.md M5: surface ONLY deferred charges (Judge accepted
  // as legitimate but out-of-scope-this-pass). Dismissed charges are NOT
  // shown — the Judge ruled them invalid; surfacing them undermines the Judge
  // layer and confuses default-tier readers. Dismissed charges live in
  // expert-tier panel per §24.2 (v0.5+).
  const objections = [];
  if (Array.isArray(charges) && Array.isArray(rulings)) {
    rulings.forEach(r => {
      const charge = charges[r.charge_idx];
      if (!charge) return;
      if (r.status === 'deferred') {
        objections.push(`- (deferred) ${charge.ref}: ${charge.claim} — Judge: ${r.reasoning}`);
      }
    });
  }
  if (Array.isArray(confession?.ornamentation_flagged) && confession.ornamentation_flagged.length > 0) {
    for (const ref of confession.ornamentation_flagged) {
      objections.push(`- (self-flagged ornamentation) ${ref}`);
    }
  }
  if (objections.length === 0) objections.push('(none surviving)');

  // ── 修复建议 ──
  const fix = (confession && confession.deepen_recommendation) || '(no fix recommendation)';

  // ── Markdown ──
  const md = [
    `# Auditable Reasoning Summary`,
    '',
    `**结论**: ${conclusion}`,
    '',
    `**依据**:`,
    ...evidenceSummary,
    '',
    `**关键推理**:`,
    pathChain,
    '',
    `**不确定性**:`,
    ...uncertainty,
    '',
    `**反对意见**:`,
    ...objections,
    '',
    `**修复建议**: ${fix}`,
    '',
    '---',
    '',
    `_Persona: ${personaCoherence ? `coherence ${personaCoherence.score}` : 'n/a'}; Drift: ${typeof driftScore === 'number' ? driftScore.toFixed(2) : 'n/a'}; Evidence rows: ${evidenceRows.length}_`,
  ].join('\n');

  return {
    markdown: md,
    structured: {
      conclusion,
      evidence_count: evidenceRows.length,
      path_steps: pathSteps.length,
      uncertainty_count: uncertaintyItems.length,
      objection_count: objections.filter(o => !o.startsWith('(none')).length,
      fix_recommendation: fix,
      drift_score: typeof driftScore === 'number' ? driftScore : null,
      persona_coherence_score: personaCoherence ? personaCoherence.score : null,
      audit_timestamp: new Date().toISOString(),
    },
  };
}

module.exports = {
  composeAuditableSummary,
};
