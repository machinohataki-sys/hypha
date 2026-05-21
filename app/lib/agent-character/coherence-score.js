'use strict';
// HYPHA · Persona Coherence Score (AMD-MEOW-P8 C3 minimal v0.2)
//
// 3-dimension aggregate: failure_honesty (40%) + anti_ingratiation (30%)
// + contract_alignment (30%). Full 8-dim formula ships at v0.4 P1 per
// blueprint §25.2 / spec persona-coherence-layer.md.
//
// Inputs come from already-shipped Tranche 1 functions:
//   - failure_honesty: gradeConfessionHonesty(confession) [confession.js]
//   - anti_ingratiation: detectIngratiation(text).length × penalty [anti-ingratiation.js]
//   - contract_alignment: heuristic regex against contract.i_am_not entries
//
// Output is per-turn; ledger aggregation across turns is P1 v0.4 (C5).

const { gradeConfessionHonesty } = require('../anti-slop/confession');
const { detectIngratiation } = require('./anti-ingratiation');

/**
 * Score how strongly the agent's output text VIOLATES the things its contract
 * says it is NOT. We extract the most specific phrases from each i_am_not
 * entry and check substring presence in output. Hits = violations = lower score.
 *
 * @param {string} outputText
 * @param {object} contract
 * @returns {{score: number, violations: Array<{i_am_not: string, hint: string}>}}
 */
function scoreContractAlignment(outputText, contract) {
  if (!contract || !Array.isArray(contract.i_am_not)) {
    return { score: 100, violations: [] };
  }
  const text = (outputText || '').toLowerCase();
  if (!text) return { score: 0, violations: [] };

  // Heuristic phrase extraction: each i_am_not entry's last meaningful noun
  // ("a flattering assistant" → "flattering", "a marketing copywriter" → "marketing")
  // OR direct substring if entry is short enough.
  const violations = [];
  for (const entry of contract.i_am_not) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const phrases = _extractAntiPhrases(entry);
    for (const p of phrases) {
      if (text.includes(p.toLowerCase())) {
        violations.push({ i_am_not: entry, hint: p });
        break; // 1 violation per i_am_not entry
      }
    }
  }
  const score = Math.max(0, 100 - violations.length * 15);
  return { score, violations };
}

function _extractAntiPhrases(iAmNotEntry) {
  // Drop articles + identify content words. Crude but adequate v0.2 minimal.
  const cleaned = iAmNotEntry
    .replace(/^(a|an|the)\s+/i, '')
    .replace(/\(.*?\)/g, '')
    .trim();
  const phrases = [cleaned];
  // Add the trailing noun-ish word (rough)
  const words = cleaned.split(/\s+/);
  if (words.length >= 2) {
    const tail = words[words.length - 1];
    if (tail.length >= 5 && !phrases.includes(tail)) phrases.push(tail);
  }
  return phrases;
}

/**
 * Compute 3-dim Persona Coherence Score.
 *
 * @param {object} args
 * @param {object} [args.confession] — output of generateConfession (Tranche 1)
 * @param {Array}  [args.ingratiationViolations] — output of detectIngratiation
 * @param {string} [args.outputText] — combined plan+body text for contract-alignment scan
 * @param {object} args.contract — Character Contract (loaded)
 * @param {'session'|'turn'} [args.mode='session'] — scoring mode. `session`
 *   uses the full -10/violation penalty calibrated for whole-lesson bodies;
 *   `turn` uses a softer -5/violation penalty so a single conversational turn
 *   with 2-3 incidental ingratiation tokens does not floor the dimension.
 * @returns {{score: number, dims: object, contract_violations: Array}}
 */
function computePersonaCoherence({ confession, ingratiationViolations, outputText, contract, mode = 'session' } = {}) {
  // Failure honesty (0-100)
  const failure_honesty = confession ? gradeConfessionHonesty(confession) : 0;

  // Anti-ingratiation: 100 - penaltyMult * violations, floor 0.
  // Calibration 2026-05-08: 5/violation was too lenient at session scale — a
  // body with 10 ingratiation phrases (egregious) scored 50, dampened by the
  // 0.3 weight to a non-blocking signal in the aggregate. 10/violation makes
  // 10 hits → 0. Per-turn (Phase C-5) reverts to 5/violation: a single turn
  // is short, 2-3 incidental hits are noise, not a contract violation.
  let violations = ingratiationViolations;
  if (!Array.isArray(violations) && typeof outputText === 'string') {
    violations = detectIngratiation(outputText);
  }
  const violationCount = Array.isArray(violations) ? violations.length : 0;
  const penaltyMult = mode === 'turn' ? 5 : 10;
  const anti_ingratiation = Math.max(0, 100 - violationCount * penaltyMult);

  // Contract alignment
  const contractRes = scoreContractAlignment(outputText || '', contract || {});
  const contract_alignment = contractRes.score;

  const score = Math.round(0.4 * failure_honesty + 0.3 * anti_ingratiation + 0.3 * contract_alignment);

  return {
    score,
    dims: {
      failure_honesty,
      anti_ingratiation,
      contract_alignment,
    },
    contract_violations: contractRes.violations,
    ingratiation_violation_count: violationCount,
  };
}

/**
 * Render Persona Coherence as a 1-line summary for Course Trust Panel default.
 * Example: "Mycelium Professor v0.1 · 一致性 86 (诚实 88 / 反讨好 95 / 契约 75)"
 */
function renderPersonaSummary(personaScore, contract) {
  if (!personaScore || !contract) return 'Persona n/a';
  const name = contract.display_name || contract.agent_id || 'agent';
  const ver = contract.role_version ? ` ${contract.role_version}` : '';
  const d = personaScore.dims || {};
  return `${name}${ver} · 一致性 ${personaScore.score} (诚实 ${d.failure_honesty || 0} / 反讨好 ${d.anti_ingratiation || 0} / 契约 ${d.contract_alignment || 0})`;
}

module.exports = {
  computePersonaCoherence,
  scoreContractAlignment,
  renderPersonaSummary,
};
