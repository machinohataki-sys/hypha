'use strict';
// HYPHA · Pre-lesson body generator (v0.2 Surface Finishing, blueprint §6.1)
//
// Generates the v0.2 11-field lesson body BEFORE the LessonChat opens, so
// the tutor enters with a real prep artifact (thesis / canonical_example /
// common_misconceptions / exit_proof / mechanism / jargon_list / note_connection)
// and the user sees "本节焦点: ___" header in the chat surface (Track B B3).
//
// Why this exists: v0.4-shipped path generates lessons turn-by-turn from
// learn-start.txt + sources, with no per-lesson "prep notes". Production
// critique 2026-05-08: "不知道每节课上课之前有没有备课" — the tutor opens
// cold with no thesis. Fix = pre-generate a structured brief, persist it,
// and inject as LESSON BRIEF block into designLesson's system prompt so
// the tutor anchors in its own prep instead of winging the whole turn.
//
// Reuses:
//   - app/agent.js:rankSourcesBM25(sources, query, k, {desiredUse})
//     for grounding (v0.4 Course Source Stack)
//   - app/lib/llm/index.js:executeChat('T6_STRONG', ...) for the LLM call
//     with DispatchPolicy + ProviderHealth runtime fallback
//   - app/lib/jargon-firewall.checkJargon for output sanity
//
// Persists to vault/<slug>/lesson-N.body.json. Idempotent (callers should
// check if file exists first; this fn always regenerates when invoked).
//
// Cost: ~1 T6_STRONG call (~$0.005 GLM-5.1 / ~$0.05 Sonnet) per lesson.
// Wall time: ~5-10s. Gated upstream behind settings.experiments.preLessonBody.

const { executeChat } = require('./llm');

// Lazy-load rankSourcesBM25 from agent.js to avoid circular require at boot.
let _rankCached = null;
function _getRanker() {
  if (_rankCached) return _rankCached;
  try { _rankCached = require('../agent').rankSourcesBM25; }
  catch (_) { _rankCached = null; }
  return _rankCached;
}

// Lazy-load jargon firewall (optional dependency — body still ships if missing).
let _jargonCached = null;
function _getJargon() {
  if (_jargonCached !== null) return _jargonCached;
  try { _jargonCached = require('./jargon-firewall'); }
  catch (_) { _jargonCached = false; }
  return _jargonCached;
}

// v0.2 Track C C1 — lazy-load goal-drift-detector. Returns null on missing.
let _driftCached = null;
function _getDriftDetector() {
  if (_driftCached !== null) return _driftCached;
  try { _driftCached = require('./goal-drift-detector'); }
  catch (_) { _driftCached = false; }
  return _driftCached;
}

// v0.2 Track C C1 — default forbidden_drifts injected when goalContract is
// silent on the field. Per blueprint §3.1+§3.4 these are the 5 drift modes
// the user mandate (2026-05-08) explicitly named as off-mission for HYPHA.
const DEFAULT_FORBIDDEN_DRIFTS = [
  '空泛聊天',
  '过多黑话',
  '无行动证明',
  '资讯流消费',
  '普通网课式总结',
];

// v0.2 Track C C1 — drift threshold. detectDrift returns 0-100; > 50 triggers
// regen-once. Conservative; one regen attempt only; second-fail returns body
// + _meta.drift_warning so trust panel surface (Machino-C) can render.
const DRIFT_THRESHOLD = 50;

// v0.2 Track C C2 — hook_concrete: an opening MUST start with a concrete
// scene (named person / specific moment / sensory detail), NOT a definition
// or encyclopedia framing. Spec from plan §C2; first 100 chars checked.
const HOOK_ABSTRACT_RE = /^(.+? 是 .+|定义|introduction|本课介绍|本课讨论|本节介绍|an overview of)/i;

const BODY_V2_SYSTEM_PROMPT = `You are a HYPHA Lesson Architect. You are NOT teaching the lesson — you are PREPARING it. Your output is a structured prep artifact the tutor will read before opening the chat. The tutor only teaches well if you give them a sharp brief.

OUTPUT — STRICT JSON with these 7 required fields plus 4 optional:

REQUIRED:
  thesis              — 1 sentence, ≤25 words, declarative. The ONE specific claim/skill/insight this 30-min lesson lands. NOT "an overview of X". Format: "By the end of this lesson, the learner will be able to / will see that ___." NO encyclopedia framing.
  canonical_example   — 1 paragraph, ≤80 words. ONE named, concrete instance the tutor will return to repeatedly. Has a person/year/place/number where possible. Used as the recurring anchor across HOOK→VERIFY→EXTEND beats.
  common_misconceptions — array of EXACTLY 2 strings, each ≤40 words. The two most likely wrong-priors the learner will arrive with. Each ends with the sharp correction (not just the wrong belief).
  exit_proof          — 1 paragraph, ≤60 words. The Feynman-test the tutor will close with: "apply X to a fresh case Y" or "explain X to someone who knows nothing of Z". Concrete + falsifiable.
  mechanism_explanation — 1-2 paragraphs, ≤150 words. Plain-language description of the underlying mechanism (NOT definition). HOW it works, not WHAT it is. Use a body metaphor before any symbol.
  jargon_list         — array, max 5 strings. Terms the lesson MUST introduce + their plain-language gloss. Format: ["term — plain gloss (≤15 words)", ...]. EXCLUDE any terms the learner already knows per LEARNER_STATE.known.
  note_connection     — 1 sentence, ≤30 words. Which prior lesson note (if any) this lesson connects to AND how. If no prior note, write "(first lesson — no prior note to bind to)".

OPTIONAL (write empty string if not applicable):
  examples            — array up to 3, each ≤30 words. Secondary instances beyond canonical_example.
  product_transfer    — 1 sentence, ≤30 words. Where the learner could USE this knowledge in their own work.
  intro_hook_scene    — 1-2 sentences, ≤50 words. A specific opening scene the tutor MAY use (named person, year, sensory detail) — NOT abstract definition. The tutor MAY override.
  closing_summary     — 1 sentence, ≤30 words. The single takeaway sentence the tutor closes with.

CONSTRAINTS:
- Service: north_star_goal first, then main_creation, then learn_goal of THIS lesson.
- Forbidden words: AI, LLM, embedding, model, prompt, agent, RAG, vector, fine-tune.
- AI-tell scrub: NO "这一刀" / NO "闭环 / 拉满 / 王炸 / 干货 / 直击灵魂 / 真香 / yyds / 绝绝子 / 上分 / 上车 / 内卷 / 出圈".
- Manuscript register: serif-cadence, ! exclamation marks, ! "great question!".
- Ground in SOURCES below — do not invent named people/years/numbers if no source supports them. If no source: pick fallback per learn-start.txt:48 (present-tense laboratory / sensory metaphor).
- common_misconceptions MUST be sourced from your knowledge of how learners typically err on this topic — they should be FALSIFIABLE wrong-priors, not strawmen.
- thesis must NOT begin with "Introduction to" / "An overview of" / "本课介绍" / "本课讨论" — those are encyclopedia framings.

Return STRICT JSON only. No prose preamble.`;

function buildBodyV2UserMessage({ plan, goalContract, audience, learnerState, rankedSources, lessonTitle, learnGoal, idx }) {
  const sourcesBlock = (Array.isArray(rankedSources) && rankedSources.length > 0)
    ? rankedSources.map((s, i) => {
        const tag = s.sourceType || 'src';
        const title = String(s.title || `Source ${i + 1}`).slice(0, 100);
        const excerpt = String(s.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 350);
        const url = s.url ? ` (${s.url})` : '';
        return `--- Source ${i + 1} [${tag}]: ${title}${url} ---\n${excerpt || '(no excerpt available — cite by title only)'}`;
      }).join('\n\n')
    : '(no sources available — proceed without grounding citations; pick fallback opener per spec)';

  return `LESSON CONTEXT
  topic_chain        : ${(goalContract && goalContract.north_star_goal) || ''}
  this_lesson_idx    : ${idx | 0} (sequence position)
  this_lesson_title  : ${lessonTitle || ''}
  this_lesson_goal   : ${learnGoal || (plan && plan.objective) || ''}
  audience           : ${audience || 'self-directed adult learner'}
  learner_state      : ${JSON.stringify(learnerState || { known: [], unknown: [] })}

PLAN (6-field skeleton from designSeed):
${JSON.stringify(plan || {}, null, 2).slice(0, 2000)}

GOAL CONTRACT:
${JSON.stringify(goalContract || {}, null, 2).slice(0, 1000)}

SOURCES (BM25-ranked top-6 by best_use=lesson; ground specifics in these):
${sourcesBlock}

Generate the lesson body JSON.`;
}

// Required field validator. Optional fields are not enforced.
function validateBodyV2(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['body must be an object'];

  const required = {
    thesis:                ['string', 5, 200],
    canonical_example:     ['string', 30, 600],
    exit_proof:            ['string', 20, 400],
    mechanism_explanation: ['string', 30, 1200],
    note_connection:       ['string', 5, 250],
  };
  for (const [key, [type, minLen, maxLen]] of Object.entries(required)) {
    const v = body[key];
    if (typeof v !== type) { errors.push(`${key}: expected ${type}, got ${typeof v}`); continue; }
    const len = String(v).length;
    if (len < minLen) errors.push(`${key}: too short (${len} < ${minLen})`);
    if (len > maxLen) errors.push(`${key}: too long (${len} > ${maxLen})`);
  }
  // common_misconceptions array of exactly 2 strings.
  if (!Array.isArray(body.common_misconceptions)) {
    errors.push('common_misconceptions: must be array');
  } else if (body.common_misconceptions.length !== 2) {
    errors.push(`common_misconceptions: expected exactly 2 entries, got ${body.common_misconceptions.length}`);
  } else {
    body.common_misconceptions.forEach((m, i) => {
      if (typeof m !== 'string' || m.length < 10) errors.push(`common_misconceptions[${i}]: too short or wrong type`);
    });
  }
  // jargon_list array, max 5 strings.
  if (!Array.isArray(body.jargon_list)) {
    errors.push('jargon_list: must be array (use [] when no new jargon needed)');
  } else if (body.jargon_list.length > 5) {
    errors.push(`jargon_list: too many entries (${body.jargon_list.length} > 5)`);
  }

  // Encyclopedia-framing red flag (cheap pre-check; goal-drift-detector deeper later).
  const t = String(body.thesis || '').trim();
  if (/^(introduction to|an overview of|本课介绍|本课讨论|本节介绍)/i.test(t)) {
    errors.push('thesis: encyclopedia framing detected (starts with "Introduction to / An overview of / 本课介绍 / 本课讨论")');
  }

  // v0.2 Track C C2 — hook_concrete: opening must be a concrete scene.
  // Picks intro_hook_scene if non-empty, else falls back to canonical_example
  // (canonical_example carries the recurring anchor and is closest in spirit
  // to "the thing that grounds the first 30 seconds"). On match, push error
  // so the existing retry-once schema-validation flow regens with feedback.
  const hookField = (body.intro_hook_scene && String(body.intro_hook_scene).trim())
    ? 'intro_hook_scene'
    : (body.canonical_example && String(body.canonical_example).trim()) ? 'canonical_example' : null;
  if (hookField) {
    const opener = String(body[hookField]).trim().slice(0, 100);
    if (HOOK_ABSTRACT_RE.test(opener)) {
      errors.push(`hook_abstract: ${hookField} opens with abstract definition framing — rewrite as concrete scene (named person, specific moment, or sensory detail)`);
    }
  }
  return errors;
}

/**
 * Generate the v0.2 lesson body for one lesson.
 *
 * @param {object} args
 * @param {object} args.plan          — 6-field plan skeleton from designSeed/proposeNextLesson
 * @param {object} args.goalContract  — { north_star_goal, main_creation, current_level, ...forbidden_drifts }
 * @param {Array}  [args.sources]     — sources.json entries (will be BM25-ranked + filtered to best_use=lesson)
 * @param {string} [args.audience]    — defaults to 'self-directed adult learner'
 * @param {object} [args.learnerState]— { known: [], unknown: [], gaps: [] }
 * @param {string} [args.lessonTitle]
 * @param {string} [args.learnGoal]
 * @param {number} [args.idx]
 * @param {object} [args.options]
 * @param {number} [args.options.maxRetries=1]
 * @param {string} [args.options.capability='T6_STRONG']
 * @param {number} [args.options.maxTokens=3000]
 * @param {number} [args.options.timeoutMs=90000]
 * @returns {Promise<{body, _meta}>}
 */
async function generateLessonBodyV2({
  plan, goalContract, sources, audience, learnerState,
  lessonTitle, learnGoal, idx,
  options = {},
  // v0.2.1 — preview-and-approve regen. When user clicks "需要修改" in
  // PreviewCard + submits free-text, main.js reads the prior body off disk and
  // invokes us with both. Same message-shape as the drift-regen idiom (see
  // line ~322): append assistant(prior body JSON) + user(feedback prose).
  // Schema validation + drift gate + hook_concrete still run on the regen
  // result; if regen fails schema OR drifts on a 2nd consecutive attempt, the
  // prior body is preserved (defensive — main.js writes the new body only
  // after we return successfully).
  priorBody,
  userFeedback,
} = {}) {
  if (!plan || typeof plan !== 'object') throw new Error('plan (object) required');

  const ranker = _getRanker();
  const query = [
    learnGoal || '',
    lessonTitle || '',
    (plan && plan.objective) || '',
    (goalContract && goalContract.north_star_goal) || '',
  ].filter(Boolean).join(' ').trim();
  const srcArr = Array.isArray(sources) ? sources : [];
  const ranked = (ranker && query && srcArr.length > 0)
    ? ranker(srcArr, query, 6, { desiredUse: 'lesson' })
    : srcArr.slice(0, 6);

  const maxRetries = (options && Number.isFinite(options.maxRetries)) ? options.maxRetries : 1;
  const capability = (options && options.capability) || 'T6_STRONG';
  const maxTokens = (options && Number.isFinite(options.maxTokens)) ? options.maxTokens : 3000;
  const timeoutMs = (options && Number.isFinite(options.timeoutMs)) ? options.timeoutMs : 90_000;

  const userMsg = buildBodyV2UserMessage({
    plan, goalContract, audience, learnerState,
    rankedSources: ranked, lessonTitle, learnGoal, idx,
  });

  let messages = [
    { role: 'system', content: BODY_V2_SYSTEM_PROMPT },
    { role: 'user', content: userMsg },
  ];

  // v0.2.1 — append user-feedback regen turn when both priorBody + userFeedback
  // present. Same shape as drift-regen idiom further down (assistant echoes
  // prior, user gives feedback). Treat empty feedback as no-op.
  if (priorBody && typeof userFeedback === 'string' && userFeedback.trim()) {
    messages = [
      ...messages,
      { role: 'assistant', content: JSON.stringify(priorBody) },
      { role: 'user', content: `USER FEEDBACK ON PRIOR ATTEMPT:\n${userFeedback.trim()}\n\nRewrite the body JSON to address this feedback. Keep the 7-field schema + all CONSTRAINTS. Same JSON shape. Return STRICT JSON only.` },
    ];
  }

  // v0.2 Track C C1 — drift gate state. After schema validation succeeds,
  // we run detectDrift; on drift > threshold, we regen ONCE with a feedback
  // turn appended. Tracked across the schema-retry loop so a body that passes
  // schema but trips drift gets exactly one drift-regen attempt.
  let _driftRegenUsed = false;
  let _lastSchemaResult = null;
  let _lastSchemaMeta = null;

  for (let attempt = 0; attempt <= maxRetries + 1; attempt++) {
    const t0 = Date.now();
    const dispatch = await executeChat(capability, {
      messages,
      json: true,
      temperature: 0.6,
      maxTokens,
      timeoutMs,
    });
    const ms = Date.now() - t0;
    const result = dispatch && dispatch.result;
    const errors = validateBodyV2(result);
    if (errors.length === 0) {
      // Optional jargon firewall sanity (monitor-only).
      const j = _getJargon();
      let jargonViolations = 0;
      try {
        if (j && typeof j.checkJargon === 'function') {
          const check = j.checkJargon(JSON.stringify(result));
          if (check && Array.isArray(check.violations)) jargonViolations = check.violations.length;
        }
      } catch (_) { /* monitor-only */ }

      const baseMeta = {
        ms,
        attempt: attempt + 1,
        provider: dispatch && dispatch.providerId,
        model: dispatch && dispatch.model,
        attempts: dispatch && dispatch.attempts,
        ranked_source_count: ranked.length,
        jargon_violations: jargonViolations,
        schema_version: 'v2',
      };

      // v0.2 Track C C1 — drift gate. If detector available, run against the
      // body. On drift > threshold and we haven't yet used our regen, append
      // feedback turn + continue the loop for one more attempt. On a SECOND
      // drift, return body anyway with _meta.drift_warning populated — main.js
      // surfaces that as a sibling drift-warning.json + trust-panel signal.
      const detector = _getDriftDetector();
      let driftReport = null;
      if (detector && typeof detector.detectDrift === 'function') {
        try {
          const gc = (goalContract && typeof goalContract === 'object') ? { ...goalContract } : {};
          if (!Array.isArray(gc.forbidden_drifts) || gc.forbidden_drifts.length === 0) {
            gc.forbidden_drifts = DEFAULT_FORBIDDEN_DRIFTS.slice();
          }
          driftReport = detector.detectDrift(gc, result);
        } catch (_) { /* monitor-only — drift gate must never break body gen */ }
      }

      const driftScore = (driftReport && Number.isFinite(driftReport.drift_score))
        ? driftReport.drift_score
        : null;

      if (driftScore !== null && driftScore > DRIFT_THRESHOLD && !_driftRegenUsed) {
        _driftRegenUsed = true;
        _lastSchemaResult = result;
        _lastSchemaMeta = baseMeta;
        const flagSummary = (driftReport.violations && driftReport.violations.length)
          ? driftReport.violations.slice(0, 4).map(v => `${v.axis}:${v.text}`).join('; ')
          : `axes=${JSON.stringify(driftReport.axes || {})}`;
        messages = [
          ...messages,
          { role: 'assistant', content: JSON.stringify(result) },
          { role: 'user', content: `PRIOR ATTEMPT TRIGGERED GOAL DRIFT (score=${driftScore} > ${DRIFT_THRESHOLD}). Triggered axes/flags: ${flagSummary}. Rewrite the body to avoid these drift modes — anchor every field to north_star_goal + main_creation; remove encyclopedia framing; cut jargon load; sharpen thesis to ONE specific claim/skill. Same JSON shape; same schema; just less drift.` },
        ];
        continue;
      }

      return {
        body: result,
        _meta: {
          ...baseMeta,
          drift_score: driftScore,
          drift_warning: (driftScore !== null && driftScore > DRIFT_THRESHOLD)
            ? {
                score: driftScore,
                axes: driftReport.axes || {},
                violations: (driftReport.violations || []).slice(0, 8),
                attempts: 2,
              }
            : null,
        },
      };
    }

    if (attempt < maxRetries + (_driftRegenUsed ? 1 : 0)) {
      messages = [
        ...messages,
        { role: 'assistant', content: JSON.stringify(result) },
        { role: 'user', content: `Body validation failed:\n${errors.map(e => '  - ' + e).join('\n')}\n\nRegenerate strictly per the SCHEMA + CONSTRAINTS. Same JSON shape; fix the listed issues only.` },
      ];
      continue;
    }
    // If we already passed schema once but the drift-regen attempt failed
    // schema, fall back to the prior schema-passing body with a warning.
    if (_lastSchemaResult) {
      return {
        body: _lastSchemaResult,
        _meta: {
          ..._lastSchemaMeta,
          drift_warning: {
            score: null,
            note: 'drift-regen attempt failed schema; returned prior schema-valid body',
            attempts: 2,
          },
        },
      };
    }
    throw new Error(`generateLessonBodyV2 failed schema validation after ${maxRetries + 1} attempts: ${errors.join('; ')}`);
  }
}

module.exports = {
  generateLessonBodyV2,
  validateBodyV2,
  // Exposed for tests + Track C drift detector wiring.
  _BODY_V2_SYSTEM_PROMPT: BODY_V2_SYSTEM_PROMPT,
  DEFAULT_FORBIDDEN_DRIFTS,
  DRIFT_THRESHOLD,
  HOOK_ABSTRACT_RE,
};
