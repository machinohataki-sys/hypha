'use strict';

// Hypha Lacquer Loop — chain feasibility classifier v1 (council 2026-05-01).
// 3-agent council: Yogo (calibration / cost asymmetry) + Leo (atoms / multi-plan
// reframe) + Scout (2024-2026 frontier evidence). Council archive in dialectics/.
//
// REPLACES v0 gut constants with research-anchored mechanism:
//   effective_hours_needed = (gap × base_h × element_mult × plateau_term) / (focus × α)
//
// Constants:
//   base_h = 1000               Macnamara-corrected (Ericsson 10kh meta explains 14-24% var
//                                per Macnamara 2014 / 2019 replication, NOT 80%)
//   element_mult = 1.0/1.5/2.0  Sweller 1988 element-interactivity / Likourezos 2024
//                                low = isolated vocab. med = related rules. high = abstract systems.
//   plateau_term = (1/(1-target))^1.5
//                                Donner-Hardy 2015 piecewise-power-law (n=25,280); "desert
//                                of dabblers" 0.7-0.85; mastery 0.5→1.4× / 0.85→17× / 0.95→90×
//   focus = 0.45 + consistency_bonus - overcommit_penalty (range 0.20-0.70)
//                                Gloria Mark 47s→43s 2026 collapse / Hubstaff <3h focused
//                                per 8h workday / Newport 4h deep-work ceiling
//   α = 1.2 vanilla / 1.7 Lacquer / 2.0 PS2-style
//                                Kestin et al. 2025 Harvard PS2 RCT d=0.73-1.3; α conditional
//                                on stepwise scaffolding, vanilla ChatGPT capped at 1.2
//
// Tier boundaries 0.7 / 2.5 (NOT 0.5 / 1.5) per Yogo cost-asymmetry: false-easy = burnout
// (cost 8) vs false-impossible = re-scope (cost 2), 4:1 asymmetry → boundaries shift right.
//
// Macnamara variance ceiling: even calibrated outputs explain ~25% individual variance →
// outputs framed as P10/P50/P90 ratio range, NOT point estimate. Confidence flag set
// to 'low' when tier(P10) ≠ tier(P90).
//
// Leo reframe: classifyFeasibility returns ONE verdict (caller convenience); proposePlans
// returns 4-5 plan-shapes (compress-target / extend-time / intensify-daily / pivot-easier).

const BASE_HOURS_PER_GAP = 1000;
const FOCUS_BASELINE = 0.45;
const FOCUS_CEILING = 0.70;
const FOCUS_FLOOR = 0.20;
const FOCUS_OVERCOMMIT_THRESHOLD_H = 4;
const FOCUS_OVERCOMMIT_PENALTY_PER_H = 0.08;
const FOCUS_CONSISTENCY_BONUS_MAX = 0.20;
const ALPHA_VANILLA = 1.2;
const ALPHA_LACQUER = 1.7;
const ALPHA_CEILING = 2.0;
const SIGMA_SHARE = 0.35;
const FAILED_ATTEMPT_PENALTY = 0.6;

const ELEMENT_MULT = { low: 1.0, med: 1.5, high: 2.0 };

const TIERS = {
  'nearly-impossible': {
    label_zh: '几乎不可能',
    label_en: 'nearly-impossible',
    ratio_max: 0.7,
    density: 0.95,
    ai_register: 'drill-sergeant',
    style_note: 'blunt, skip nuance, hit checkpoints, accept partial mastery',
    breaks_per_day: 0,
    advice: 'time too tight — recommend extending OR accepting intermediate target',
    p_complete_band: [0.05, 0.15],
  },
  'possible': {
    label_zh: '可能',
    label_en: 'possible',
    ratio_max: 2.5,
    density: 0.75,
    ai_register: 'guided-coach',
    style_note: 'structured, regular checkpoints, gentle redirects',
    breaks_per_day: 1,
    advice: 'feasible with disciplined execution; expect grind on prereqs',
    p_complete_band: [0.30, 0.65],
  },
  'easy': {
    label_zh: '轻松',
    label_en: 'easy',
    ratio_max: Infinity,
    density: 0.55,
    ai_register: 'socratic-companion',
    style_note: 'exploratory, deep dives allowed, open questions',
    breaks_per_day: 2,
    advice: 'time abundant; consider a more ambitious target or deeper exploration',
    p_complete_band: [0.75, 0.95],
  },
};

function tierFor(ratio) {
  if (ratio < TIERS['nearly-impossible'].ratio_max) return 'nearly-impossible';
  if (ratio < TIERS['possible'].ratio_max) return 'possible';
  return 'easy';
}

function computeFocus({ priorConsistency, dailyHours }) {
  const consistency = Math.max(0, Math.min(7, Number(priorConsistency) || 0));
  const consistencyBonus = (consistency / 7) * FOCUS_CONSISTENCY_BONUS_MAX;
  const hours = Math.max(0, Number(dailyHours) || 0);
  const overcommitPenalty = Math.max(0, hours - FOCUS_OVERCOMMIT_THRESHOLD_H) * FOCUS_OVERCOMMIT_PENALTY_PER_H;
  return Math.max(FOCUS_FLOOR, Math.min(FOCUS_CEILING, FOCUS_BASELINE + consistencyBonus - overcommitPenalty));
}

// effectiveHoursNeeded — closed-form integral of marginal-hours-per-mastery-unit.
// Marginal cost per mastery unit ∝ (1-m)^-1.5 (Donner-Hardy 2015 piecewise-power-law).
// Total hours to traverse [prior, target] = 2 × base_h × element_mult × [1/sqrt(1-target) - 1/sqrt(1-prior)].
// Then divide by α (AI tutor multiplier — Kestin Harvard 2025).
//
// IMPORTANT: focus is NOT in this denominator. focus belongs to hoursAvailable
// (multiplier on declared dailyHours). Putting it here would double-count.
//
// Sanity anchors (element=high=2.0, α=1.7 Lacquer):
//   novice → GPT-tier 0.85:    ~3700h    (Scout 10-15kh band assumes α=1.0 traditional)
//   novice → undergrad 0.5:    ~340h     (with element=med=1.5 → 260h Lacquer-augmented)
//   B1 0.4 → B2 0.7:           ~280h     (FSI Cat-1 base 480h ÷ α=1.7)
//   undergrad 0.5 → grad 0.8:  ~600h
function effectiveHoursNeeded({ target, prior, intrinsicLoad, alpha }) {
  const elementMult = ELEMENT_MULT[intrinsicLoad] || ELEMENT_MULT.med;
  const targetSafe = Math.max(0.05, Math.min(0.99, Number(target) || 0.5));
  const priorSafe = Math.max(0, Math.min(targetSafe - 0.01, Number(prior) || 0));
  const integralAt = (m) => 1 / Math.sqrt(1 - m);
  const numerator = 2 * BASE_HOURS_PER_GAP * elementMult * (integralAt(targetSafe) - integralAt(priorSafe));
  const denominator = Number(alpha) || ALPHA_LACQUER;
  return numerator / denominator;
}

// Context-sparsity scorer (v0.12, 2026-05-21). Counts which feasibility levers
// the caller actually supplied vs defaulted. Sparsity in [0,1] where 0 = every
// field supplied with non-default value, 1 = caller passed empty spec. Drives
// confidence_band width below (sparse context → wider band → "ask more" hint).
const SPARSITY_FIELDS = [
  'targetDifficulty', 'priorKnowledge', 'timeWeeks', 'dailyHours',
  'intrinsicLoad', 'priorConsistency', 'failedAttempts', 'alpha',
];
function _scoreSparsity(input) {
  const raw = input || {};
  let supplied = 0;
  for (const k of SPARSITY_FIELDS) {
    const v = raw[k];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    supplied++;
  }
  return Math.max(0, Math.min(1, 1 - supplied / SPARSITY_FIELDS.length));
}

function classifyFeasibility(input) {
  const target = Math.max(0, Math.min(1, Number(input.targetDifficulty) || 0.5));
  const prior = Math.max(0, Math.min(1, Number(input.priorKnowledge) || 0));
  const weeks = Math.max(0.1, Number(input.timeWeeks) || 4);
  const dailyHours = Math.max(0.5, Number(input.dailyHours) || 2);
  const intrinsicLoad = ELEMENT_MULT[input.intrinsicLoad] ? input.intrinsicLoad : 'med';
  const priorConsistency = Math.max(0, Math.min(7, Number(input.priorConsistency) || 0));
  const failedAttempts = Math.max(0, Math.min(5, Number(input.failedAttempts) || 0));
  const alpha = Number(input.alpha) || ALPHA_LACQUER;

  const gap = Math.max(0.05, target - prior);
  const focus = computeFocus({ priorConsistency, dailyHours });
  const hoursAvailable = weeks * 7 * dailyHours * focus;
  const hoursNeeded = effectiveHoursNeeded({ target, prior, intrinsicLoad, alpha });
  const ratio = hoursAvailable / hoursNeeded;

  // Macnamara variance — outputs are ranges
  const sigma = SIGMA_SHARE * ratio;
  const p10 = Math.max(0, ratio - 1.282 * sigma);
  const p90 = ratio + 1.282 * sigma;

  const tier = tierFor(ratio);
  const tierP10 = tierFor(p10);
  const tierP90 = tierFor(p90);
  const confidence = (tierP10 === tierP90) ? 'high' : 'low';

  // P(complete) — saturating ratio + failed-attempts compounding penalty
  const completionPrior = Math.min(1.0, ratio / TIERS['possible'].ratio_max);
  const failurePenalty = Math.pow(FAILED_ATTEMPT_PENALTY, failedAttempts);
  const pComplete = Math.max(0.02, Math.min(0.98, completionPrior * failurePenalty));

  // Confidence band — pComplete ± half-width derived from sparsity + sigma.
  // Sparse context widens band; ratio variance also widens it. Caller can read
  // band[1] - band[0] to decide "show 3-tier hard cut" vs "suggest ask more".
  const context_sparsity = round2(_scoreSparsity(input));
  const sparsityWidth = 0.10 + 0.25 * context_sparsity;
  const varianceWidth = Math.min(0.20, sigma * 0.30);
  const halfWidth = sparsityWidth + varianceWidth;
  const bandLow = round2(Math.max(0.02, pComplete - halfWidth));
  const bandHigh = round2(Math.min(0.98, pComplete + halfWidth));
  const verdict_strength = context_sparsity > 0.5 ? 'tentative'
    : context_sparsity > 0.25 ? 'provisional'
    : 'committed';
  const suggest_more_context = context_sparsity > 0.5;

  return {
    tier,
    verdict: tier,
    config: TIERS[tier],
    ratio: { p10: round2(p10), p50: round2(ratio), p90: round2(p90) },
    confidence,
    confidence_band: [bandLow, bandHigh],
    context_sparsity,
    verdict_strength,
    suggest_more_context,
    pComplete: round2(pComplete),
    gap: round2(gap),
    hoursNeeded: Math.round(hoursNeeded),
    hoursAvailable: Math.round(hoursAvailable),
    levers: {
      focus: round2(focus),
      element_load: intrinsicLoad,
      ai_alpha: alpha,
      target,
      prior_consistency: priorConsistency,
      failed_attempts: failedAttempts,
    },
    inputs: { target, prior, weeks, dailyHours, intrinsicLoad, priorConsistency, failedAttempts, alpha },
  };
}

// proposePlans — Leo reframe. Don't return 1 verdict, return 4-5 plan-shapes.
// Each variant tweaks ONE lever so the user can see what changes.
function proposePlans(spec) {
  const baseline = classifyFeasibility(spec);
  const plans = [{ shape: 'baseline', spec, classification: baseline, note: 'as you described' }];

  const compressed = { ...spec, targetDifficulty: Math.max(0.1, (Number(spec.targetDifficulty) || 0.5) * 0.7) };
  plans.push({
    shape: 'compress-target',
    spec: compressed,
    classification: classifyFeasibility(compressed),
    note: 'lower target by 30% (e.g. "intermediate" instead of "GPT-tier")',
  });

  const extended = { ...spec, timeWeeks: (Number(spec.timeWeeks) || 4) * 2 };
  plans.push({
    shape: 'extend-time',
    spec: extended,
    classification: classifyFeasibility(extended),
    note: '2× the time window',
  });

  const currentDaily = Number(spec.dailyHours) || 2;
  if (currentDaily < FOCUS_OVERCOMMIT_THRESHOLD_H) {
    const intensified = { ...spec, dailyHours: FOCUS_OVERCOMMIT_THRESHOLD_H };
    plans.push({
      shape: 'intensify-daily',
      spec: intensified,
      classification: classifyFeasibility(intensified),
      note: `commit ${FOCUS_OVERCOMMIT_THRESHOLD_H}h/day (Newport deep-work ceiling — beyond this, marginal hours collapse to ~0.2 efficiency)`,
    });
  }

  if (spec.intrinsicLoad !== 'low') {
    const pivoted = { ...spec, intrinsicLoad: 'low' };
    plans.push({
      shape: 'pivot-easier-domain',
      spec: pivoted,
      classification: classifyFeasibility(pivoted),
      note: 'pivot to a lower element-interactivity subtopic (less abstract / more concrete)',
    });
  }

  return plans;
}

function round2(x) { return Math.round(x * 100) / 100; }

module.exports = {
  classifyFeasibility,
  proposePlans,
  effectiveHoursNeeded,
  computeFocus,
  tierFor,
  _scoreSparsity,
  SPARSITY_FIELDS,
  TIERS,
  ELEMENT_MULT,
  CONSTANTS: {
    BASE_HOURS_PER_GAP, FOCUS_BASELINE, FOCUS_CEILING, FOCUS_FLOOR,
    FOCUS_OVERCOMMIT_THRESHOLD_H, FOCUS_OVERCOMMIT_PENALTY_PER_H, FOCUS_CONSISTENCY_BONUS_MAX,
    ALPHA_VANILLA, ALPHA_LACQUER, ALPHA_CEILING, SIGMA_SHARE, FAILED_ATTEMPT_PENALTY,
  },
};
