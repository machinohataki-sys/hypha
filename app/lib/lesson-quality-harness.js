'use strict';
// HYPHA · Lesson Quality Harness orchestrator (v0.2 Tranche 3, blueprint §6.4 + §24 + §25)
//
// Wires the v0.2 trust stack into a single pipeline. Two presets:
//
//   lite  (default, ~15-20s wall clock, 2-3 LLM calls):
//     plan ──┬─→ confession      ─→ persona  ─┐
//            └─→ gap detector    ─────────────┴─→ auditable summary
//
//   deep  (opt-in, ~80-90s wall clock, 5-6 LLM calls):
//     plan ──┬─→ confession      ─→ persona  ─┐
//            ├─→ gap detector                  │
//            └─→ Prosecutor → Judge → Rewriter ┴─→ auditable summary
//
// Caller passes plan + body. The harness returns a unified result with
// per-stage outputs + a top-level `verdict` (PASS / WARN / FAIL) decided by
// gap_pct + persona_score + (in deep mode) upheld charge severity.

const { generateConfession, gradeConfessionHonesty } = require('./anti-slop/confession');
const { computeGap } = require('./anti-slop/gap-detector');
const { computePersonaCoherence } = require('./agent-character/coherence-score');
const { runProsecuteJudgeRewrite } = require('./anti-slop/prosecute-judge-rewrite');
const { composeAuditableSummary } = require('./anti-slop/auditable-summary');
const { detectIngratiation } = require('./agent-character/anti-ingratiation');
const { loadContract } = require('./agent-character/contract-loader');
const { validateEvidenceLedger } = require('./lesson-generator');

/**
 * Verdict thresholds — shipped values, tunable per future calibration.
 * PASS  : gap_pct ≤ 30 AND persona_score ≥ 70 AND no high-severity upheld charges
 * WARN  : gap_pct ≤ 60 AND persona_score ≥ 50 AND no critical issues
 * FAIL  : otherwise
 */
const VERDICT_THRESHOLDS = {
  PASS: { gap_pct_max: 30, persona_min: 70, max_high_upheld: 0 },
  WARN: { gap_pct_max: 60, persona_min: 50, max_high_upheld: 1 },
};

function _decideVerdict({ gap, persona, prosecuteJudge, ledgerRows }) {
  // v0.2 P0 calibration: evidence_ledger is shipped as schema but NOT yet
  // auto-generated. If ledger is absent/sparse (< 3 rows), gap_pct is not a
  // meaningful signal — drop it from verdict and rely on persona + PJR.
  // v0.4 P1 will tighten when evidence_ledger generation becomes mandatory.
  const gp = (gap && gap.gap_pct) || 0;
  const ps = (persona && persona.score) || 0;
  const ledgerMeaningful = (ledgerRows || 0) >= 3;
  const highUpheld = prosecuteJudge && prosecuteJudge.summary
    ? (prosecuteJudge.judge.rulings || []).filter((r) => {
        const c = (prosecuteJudge.prosecutor.charges || [])[r.charge_idx];
        return r.status === 'upheld' && c && c.severity === 'high';
      }).length
    : 0;
  const t = VERDICT_THRESHOLDS;
  const gapOk = (level) => !ledgerMeaningful || gp <= t[level].gap_pct_max;
  // Hard floor: if ANY persona dimension is catastrophic, no PASS — averaged
  // scores can hide egregious single-axis failures (e.g. 10 ingratiation hits
  // averaged to 85 overall).
  const dims = (persona && persona.dims) || {};
  const anyDimCatastrophic = (dims.failure_honesty < 30) || (dims.anti_ingratiation < 30) || (dims.contract_alignment < 30);
  if (!anyDimCatastrophic && gapOk('PASS') && ps >= t.PASS.persona_min && highUpheld <= t.PASS.max_high_upheld) return 'PASS';
  if (gapOk('WARN') && ps >= t.WARN.persona_min && highUpheld <= t.WARN.max_high_upheld) return 'WARN';
  return 'FAIL';
}

/**
 * Run the Quality Harness pipeline on a plan + body.
 *
 * @param {object} args
 * @param {object} args.plan
 * @param {object} args.body
 * @param {Array}  [args.evidenceLedger]
 * @param {object} [args.options]
 * @param {string} [args.options.preset='lite'] — 'lite' | 'deep'
 * @param {string} [args.options.generatorAgentId='mycelium-professor']
 * @param {boolean}[args.options.skipConfession=false]
 * @param {boolean}[args.options.skipPJR=false]
 * @returns {Promise<{verdict, gap, persona, confession, prosecuteJudge?, auditable, _meta}>}
 */
async function runFullPipeline({ plan, body, evidenceLedger, options } = {}) {
  if (!plan || typeof plan !== 'object') throw new Error('plan (object) required');
  if (!body || typeof body !== 'object') throw new Error('body (object) required');
  const opts = Object.assign({ preset: 'lite', generatorAgentId: 'mycelium-professor', skipConfession: false, skipPJR: false }, options || {});
  const t0 = Date.now();

  const generatorContract = loadContract(opts.generatorAgentId);

  // Stage 1: Gap Detector (algorithmic, instant) + Evidence Ledger schema validation.
  // If a ledger was provided but is malformed (e.g. hard claims w/ null pointer),
  // surface the errors and cap verdict at FAIL — invalid ledger = trust break.
  const gap = computeGap({ plan, body, evidenceLedger });
  const ledgerSchemaErrors = Array.isArray(evidenceLedger) && evidenceLedger.length > 0
    ? validateEvidenceLedger(evidenceLedger)
    : [];

  // Stage 2: Confession (1 LLM call, T4_JUDGE)
  let confessionRes = null;
  if (!opts.skipConfession) {
    confessionRes = await generateConfession({ plan, body, characterContract: generatorContract });
  }

  // Stage 3: Persona Coherence (algorithmic, uses confession + body text)
  const bodyText = JSON.stringify(body);
  const ingrat = detectIngratiation(bodyText);
  const persona = computePersonaCoherence({
    confession: confessionRes ? confessionRes.confession : null,
    ingratiationViolations: ingrat,
    outputText: bodyText,
    contract: generatorContract,
  });

  // Stage 4 (deep mode only): Prosecutor / Judge / Rewriter (3 LLM calls)
  let prosecuteJudge = null;
  if (opts.preset === 'deep' && !opts.skipPJR) {
    prosecuteJudge = await runProsecuteJudgeRewrite({ plan, body });
  }

  // Stage 5: Auditable Summary (algorithmic composer)
  const auditable = composeAuditableSummary({
    plan,
    body: prosecuteJudge && prosecuteJudge.rewriter ? prosecuteJudge.rewriter.revised_body : body,
    evidenceLedger,
    confession: confessionRes ? confessionRes.confession : null,
    personaCoherence: persona,
    charges: prosecuteJudge ? prosecuteJudge.prosecutor.charges : null,
    rulings: prosecuteJudge ? prosecuteJudge.judge.rulings : null,
  });

  let verdict = _decideVerdict({
    gap,
    persona,
    prosecuteJudge,
    ledgerRows: Array.isArray(evidenceLedger) ? evidenceLedger.length : 0,
  });
  // MEOW-related harness wire: malformed evidence_ledger schema = hard FAIL.
  // A hard claim with null evidence_pointer is an integrity break, not a soft signal.
  if (ledgerSchemaErrors.length > 0) verdict = 'FAIL';

  return {
    verdict,
    gap,
    persona,
    confession: confessionRes,
    prosecuteJudge,
    auditable,
    ledger_schema_errors: ledgerSchemaErrors,
    _meta: {
      preset: opts.preset,
      generator_agent: opts.generatorAgentId,
      stages_ran: [
        'gap',
        confessionRes ? 'confession' : null,
        'persona',
        prosecuteJudge ? 'prosecute-judge-rewrite' : null,
        'auditable',
      ].filter(Boolean),
      elapsed_ms: Date.now() - t0,
      verdict_thresholds: VERDICT_THRESHOLDS,
    },
  };
}

module.exports = {
  runFullPipeline,
  VERDICT_THRESHOLDS,
};
