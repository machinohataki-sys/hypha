'use strict';

// HYPHA · Lesson Brief — Per-Field Quality Validator (rc.1 → 1.0)
//
// The 11-field Lesson Brief schema in lesson-body-generator.js validates
// PRESENCE + LENGTH + TYPE. This sibling layer validates QUALITY MINIMUMS:
//
//   - success_criteria / exit_proof: MUST contain ≥1 measurable verb
//     (master | recall | derive | apply | critique | predict | reproduce |
//      落实 | 复现 | 演绎 | 应用 | 批判 | 预测 | 推导)
//
//   - thesis: MUST commit to a specific claim (contains an action verb +
//     a concrete noun phrase) — rejects "an introduction to ..." filler.
//
//   - mechanism_explanation: MUST contain a causal connector (because |
//     therefore | so that | leads to | 因此 | 所以 | 由此 | 导致 | 是因为 |
//     的机制是 | 通过 ... 实现 | so | thus | hence) — without a connector the
//     "explanation" is just a description.
//
//   - canonical_example: MUST be SPECIFIC — contains either a named entity
//     (capitalized proper noun, 中文人名, 中文专有名词) OR a number / date /
//     measurement. Pure abstract examples ("imagine a system X with input Y")
//     fail.
//
//   - common_misconceptions[i].correct: MUST contain the corrective signal
//     (实际上 | 其实 | 真相是 | actually | in fact | the correct view | 正确的
//     | rather) so the misconception entry shows the FIX, not just the wrong
//     belief.
//
// Returns { ok, errors: [{field, rule, reason}], warnings: [...] }.
// errors block the schema-retry loop; warnings flow into _meta only.

const MEASURABLE_VERBS_EN = [
  'master', 'recall', 'derive', 'apply', 'critique', 'predict',
  'reproduce', 'recognize', 'identify', 'distinguish', 'compare',
  'explain', 'construct', 'design', 'compute', 'solve',
];
const MEASURABLE_VERBS_ZH = [
  '掌握', '回忆', '推导', '应用', '批判', '预测', '复现', '辨认',
  '识别', '区分', '比较', '解释', '构造', '设计', '计算', '求解',
  '落实', '演绎',
];

const CAUSAL_CONNECTORS_EN = [
  'because', 'therefore', 'so that', 'leads to', 'results in', 'causes',
  ' so ', ' thus ', ' hence ', 'as a result', 'gives rise to',
];
const CAUSAL_CONNECTORS_ZH = [
  '因此', '所以', '由此', '导致', '是因为', '的机制是', '通过',
  '从而', '使得', '以致', '因而', '故而',
];

const CORRECTIVE_SIGNALS_EN = [
  'actually', 'in fact', 'in reality', 'the correct view',
  'rather,', 'instead', 'on the contrary',
];
const CORRECTIVE_SIGNALS_ZH = [
  '实际上', '其实', '真相是', '正确的', '事实上', '准确地说',
  '更准确地说', '正确说法', '应当', '应该', '真正的',
];

function _hasAny(haystack, needles) {
  if (typeof haystack !== 'string') return false;
  const lc = haystack.toLowerCase();
  return needles.some(n => lc.includes(n.toLowerCase()) || haystack.includes(n));
}

function _looksSpecific(s) {
  if (typeof s !== 'string') return false;
  // Number / year / measurement.
  if (/\b\d{2,}\b/.test(s)) return true;
  // ISO date or year.
  if (/\b(1[89]\d{2}|20\d{2}|21\d{2})\b/.test(s)) return true;
  // Capitalized proper noun (2+ consecutive capitalized words) — Roman scripts.
  if (/[A-Z][a-zA-Z]+\s+[A-Z][a-zA-Z]+/.test(s)) return true;
  // Single proper noun with high-information context (capitalized, followed by
  // common indicator like 's / ' / specific verb).
  if (/[A-Z][a-zA-Z]{2,}\s+(in|at|of|on|wrote|said|showed|proved|discovered|argued)/.test(s)) return true;
  // 中文专有名词 — typically 2-4 chars, often with 学派 / 主义 / 派 / 之 / 论 etc.
  if (/[一-鿿]{2,4}(学派|主义|派|之|论|说|论证|定理|猜想|实验)/.test(s)) return true;
  // 中文人名 heuristic (2-3 char with capitalized Latin or comma after).
  if (/[一-鿿]{2,4}(在|于|说|认为|主张|提出|发现|证明|反驳|批评)/.test(s)) return true;
  return false;
}

function _validateThesis(thesis) {
  const errors = [];
  if (typeof thesis !== 'string' || !thesis.trim()) return errors; // presence checked elsewhere
  const lc = thesis.toLowerCase().trim();
  // Reject encyclopedia framing — base validator catches "introduction to /
  // an overview of"; we add the lookalikes.
  const filler = [
    'an introduction to', 'a brief introduction to', 'an exploration of',
    'a survey of', '本节将介绍', '本课旨在', '本节旨在',
  ];
  for (const f of filler) {
    if (lc.includes(f) || thesis.includes(f)) {
      errors.push({
        field: 'thesis', rule: 'encyclopedia_filler',
        reason: `thesis opens with "${f}" — replace with a specific claim/skill commitment`,
      });
      break;
    }
  }
  // Require a measurable verb OR a domain action verb (heuristic: a verb that
  // commits to a specific outcome).
  const hasVerb = _hasAny(thesis, MEASURABLE_VERBS_EN) || _hasAny(thesis, MEASURABLE_VERBS_ZH)
    || /\b(will|can|able to|see that|understand why)\b/.test(thesis)
    || /(将能|能够|学会|看出|明白)/.test(thesis);
  if (!hasVerb) {
    errors.push({
      field: 'thesis', rule: 'no_measurable_verb',
      reason: 'thesis lacks a measurable verb (master/recall/derive/apply/critique/掌握/复现/演绎/应用/批判 or commitment phrase like "will be able to" / "学会").',
    });
  }
  return errors;
}

function _validateExitProof(exitProof) {
  if (typeof exitProof !== 'string' || !exitProof.trim()) return [];
  const hasVerb = _hasAny(exitProof, MEASURABLE_VERBS_EN) || _hasAny(exitProof, MEASURABLE_VERBS_ZH);
  if (!hasVerb) {
    return [{
      field: 'exit_proof', rule: 'no_measurable_verb',
      reason: 'exit_proof must contain ≥1 measurable verb (apply/derive/critique/explain/predict or 应用/推导/批判/解释/预测) — without one, the Feynman test is not falsifiable.',
    }];
  }
  return [];
}

function _validateMechanism(mechanism) {
  if (typeof mechanism !== 'string' || !mechanism.trim()) return [];
  const hasConnector = _hasAny(mechanism, CAUSAL_CONNECTORS_EN) || _hasAny(mechanism, CAUSAL_CONNECTORS_ZH);
  if (!hasConnector) {
    return [{
      field: 'mechanism_explanation', rule: 'no_causal_connector',
      reason: 'mechanism_explanation lacks a causal connector (because/therefore/leads to/因此/所以/由此/导致/通过) — describes WHAT but not HOW/WHY.',
    }];
  }
  return [];
}

function _validateCanonicalExample(example) {
  if (typeof example !== 'string' || !example.trim()) return [];
  if (!_looksSpecific(example)) {
    return [{
      field: 'canonical_example', rule: 'not_specific',
      reason: 'canonical_example lacks a specific anchor (no named entity, number, date, or 中文专有名词). Generic "consider a system X" examples don\'t serve as recurring class anchors.',
    }];
  }
  return [];
}

function _validateMisconceptionCorrections(misconceptions) {
  if (!Array.isArray(misconceptions)) return [];
  const errors = [];
  misconceptions.forEach((m, i) => {
    if (!m || typeof m !== 'object') return;
    const correct = typeof m.correct === 'string' ? m.correct : '';
    if (!correct) return; // base validator catches absence
    const hasSignal = _hasAny(correct, CORRECTIVE_SIGNALS_EN) || _hasAny(correct, CORRECTIVE_SIGNALS_ZH);
    if (!hasSignal) {
      errors.push({
        field: `common_misconceptions[${i}].correct`, rule: 'no_corrective_signal',
        reason: 'correct lacks a corrective signal (actually/in fact/rather/实际上/其实/正确的) — fails to mark the fix vs the wrong belief.',
      });
    }
  });
  return errors;
}

// validateBriefQuality({body, opts: {strict}})
//   strict=true  → returned errors block the schema-retry loop.
//   strict=false → returned errors flow into warnings (advisory).
function validateBriefQuality(body, opts = {}) {
  const strict = opts && opts.strict === true;
  const errs = [];
  if (!body || typeof body !== 'object') return { ok: true, errors: [], warnings: [] };
  errs.push(..._validateThesis(body.thesis));
  errs.push(..._validateExitProof(body.exit_proof));
  errs.push(..._validateMechanism(body.mechanism_explanation));
  errs.push(..._validateCanonicalExample(body.canonical_example));
  errs.push(..._validateMisconceptionCorrections(body.common_misconceptions));

  if (strict) {
    return { ok: errs.length === 0, errors: errs, warnings: [] };
  }
  return { ok: true, errors: [], warnings: errs };
}

// Build a regen-feedback string from a strict-mode error list.
function buildRegenFeedback(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const lines = errors.slice(0, 6).map(e => `  - [${e.field}] ${e.reason}`).join('\n');
  return `BRIEF QUALITY FLOOR FAILED — ${errors.length} field(s) missed minimum quality:\n${lines}\n\nRewrite the affected fields to meet the listed criteria. Keep the JSON shape; fix only the listed issues.`;
}

module.exports = {
  validateBriefQuality,
  buildRegenFeedback,
  // exposed for tests
  MEASURABLE_VERBS_EN,
  MEASURABLE_VERBS_ZH,
  CAUSAL_CONNECTORS_EN,
  CAUSAL_CONNECTORS_ZH,
  CORRECTIVE_SIGNALS_EN,
  CORRECTIVE_SIGNALS_ZH,
  _looksSpecific,
};
