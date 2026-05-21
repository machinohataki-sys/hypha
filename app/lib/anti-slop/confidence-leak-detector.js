'use strict';
// HYPHA · Confidence Leak Detector (AMD-MEOW-P7, v0.4 anti-slop stack)
//
// Pure-JS, no LLM. Catches the gap between "should say 我不知道" and "asserts
// with full confidence anyway". The constitution (hypha-constitution.js) tells
// the model to confess when it doesn't know — this module is the *detector*
// the constitution has been missing. Without it the model can ignore the rule
// and self-grade as having complied.
//
// Strategy: cheap regex pass over output text. Two passes:
//   (1) find "assertive claims" — concrete dates / names+action / quotes /
//       statistics / specific technical detail. These are claims that are
//       falsifiable IF wrong AND embarrassing if guessed.
//   (2) look for "hedge" tokens within ±50 chars. A hedge near an assertion
//       lowers the leak score. No hedge + no provenance (context says output
//       is not source-grounded) = high leak score.
//
// Returns per-claim records + a summary. Caller (v0.4 anti-slop integration in
// agent.js streamTurn finally block) decides whether to flag in events.jsonl
// or regenerate with a sharper hedge hint.

const HEDGE_WINDOW = 50; // ±chars around each assertive claim

// --- archetype-aware score multipliers (Machino-α9, 2026-05-15) ------------
//
// TECH-* / DECL-MASS keep base weights (1.0×). HUMANITIES treats every
// assertive form as legitimate subjective judgment / literary commentary
// (0.6×). LANG-ACQ slackens history / person / quote claims a touch (0.8×)
// because foreign-language original quotation is normal. MINDSET keeps a
// mid 0.7× — philosophical assertions are usually opinions, not gotchas.
//
// `score_multiplier_by_type` lets us be granular per claim-type. Falsy /
// missing entry → 1.0 (no change). Multiplier applied after the base
// scoreClaim() math, then clamped to [0, 1].
const ARCHETYPE_CONFIDENCE_MULTIPLIERS = Object.freeze({
  'TECH-CONCEPT': Object.freeze({ default: 1.0 }),
  'TECH-PROC':    Object.freeze({ default: 1.0 }),
  'DECL-MASS':    Object.freeze({ default: 1.0 }),
  'HUMANITIES':   Object.freeze({ default: 0.6 }),
  'LANG-ACQ':     Object.freeze({
    default: 1.0,
    // Foreign-language quote + historical citation = expected; relax.
    date: 0.8, person: 0.8, quote: 0.8,
  }),
  'MINDSET':      Object.freeze({ default: 0.7 }),
});

function _archetypeMultiplier(archetype, type) {
  const row = ARCHETYPE_CONFIDENCE_MULTIPLIERS[archetype];
  if (!row) return 1.0;
  if (Object.prototype.hasOwnProperty.call(row, type)) return row[type];
  return row.default ?? 1.0;
}

// ---- (1) Assertive-claim regexes -------------------------------------------
//
// Each entry: { type, regex, weight }
//   type   — coarse class shown to the consumer
//   regex  — pure JS, no LLM
//   weight — base confidence_leak_score before hedge / source-grounded adjust
//
// Regexes are unicode-naive on purpose: CN docs we've seen don't put hedges in
// fullwidth-only forms, and we WANT ASCII-style assertions ("Spinoza wrote
// 1670") to be caught even in mostly-CN output.

const ASSERTIVE_PATTERNS = [
  // Historical year ("1670年" / "1851 年" / "1970-2020" / "2026-04-15" /
  // "in 1665"). Cover 15xx-20xx + ISO + "in YYYY". Years < 1500 OR > 2099
  // are out of scope — too noisy.
  {
    type: 'date',
    regex: /\b(?:1[5-9]\d{2}|20\d{2})\s*年(?:代)?|\b(?:1[5-9]\d{2}|20\d{2})-\d{2}-\d{2}\b|\bin\s+(?:1[5-9]\d{2}|20\d{2})\b/g,
    weight: 0.75,
  },

  // Specific person + action. Three sub-patterns:
  //   (a) CN name (1-4 CJK chars) + CN action verb     — "牛顿 提出了 …"
  //   (b) Latin name (Capital + lower 2+) + CN verb    — "Shannon 提出了 …"
  //   (c) Latin name + EN action verb                  — "Newton invented …"
  {
    type: 'person',
    regex: /[一-鿿]{1,4}\s*(?:于|在|写[了过]|提出[了过]|证明[了过]|发明[了过]|发表[了过]|创立[了过]|命名[了过])|\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)?\s*(?:于|写[了过]|提出[了过]|证明[了过]|发明[了过]|发表[了过]|创立[了过]|是)|\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)?\s+(?:wrote|proved|invented|coined|founded|published|stated|claimed|argued|discovered)\b/g,
    weight: 0.75,
  },

  // Quoted attribution ("X 在 Y 一书中说 ___" / "as X wrote in Y, ___" /
  // anything with both a CJK quote pair 「」 / 《》 / paired " " and an in/by/at
  // source clause nearby).
  {
    type: 'quote',
    regex: /[「《"][^「」《》"\n]{4,80}[」》"](?:\s*[—-]\s*[一-鿿A-Za-z]{2,})?|(?:据|根据|按|as)\s+[一-鿿A-Za-z\.]{2,}\s*(?:所言|所说|的说法|put it|wrote)/g,
    weight: 0.7,
  },

  // Specific number / percent / unit ("效率提升 37%" / "GDP 增长 4.2%" /
  // "1024 神经元" / "Bell Labs 7 楼" / "37 percent" / "every 7 years").
  // Bias toward 2+ digit numbers + unit OR digit + percent. Plain "3" / "10"
  // alone is too noisy.
  {
    type: 'number',
    regex: /\b\d{1,3}(?:\.\d+)?\s*%|\b\d{2,}(?:\.\d+)?\s*(?:倍|个|名|位|页|层|楼|年|月|日|岁|篇|条|million|billion|percent|points?)\b/g,
    weight: 0.65,
  },

  // Specific technical/insider detail ("Anthropic 内部用 X framework" /
  // "DeepMind 用 Y 算法" / "Google's internal X tool" / "OpenAI uses Z model").
  // Heuristic: 大公司/lab + 内部/团队/employees + concrete X.
  {
    type: 'technical',
    regex: /(?:Anthropic|OpenAI|DeepMind|Google|Meta|Microsoft|Apple|Tesla|NVIDIA|百度|字节|阿里|腾讯|华为|Bell\s+Labs|MIT|Stanford)\s+(?:内部|内的|team|的团队|engineers|工程师|employees|uses|用[了的]?|采用|内部用|的内部|started|launched|deployed)\s+[一-鿿A-Za-z][一-鿿A-Za-z0-9_\-]{1,40}/g,
    weight: 0.8,
  },
];

// ---- Hedge vocabulary -------------------------------------------------------

const HEDGE_TOKENS_ZH = [
  '可能', '大概', '我不确定', '不太确定', '据我所知', '据说', '似乎', '应该是',
  '或许', '也许', '我猜', '我想', '我记得', '印象中', '差不多', '大约', '左右',
];

const HEDGE_TOKENS_EN = [
  'probably', 'maybe', 'perhaps', 'i think', 'i believe', 'as far as i know',
  'approximately', 'roughly', 'around', 'somewhere around', 'sort of',
  'kind of', "i'm not sure", 'not certain', 'iirc', 'afaik',
];

// "Fake hedge" — sounds like a hedge but the speaker (LLM) can't actually have
// memory in the human sense, so the hedge is performative not honest.
const FAKE_HEDGE_TOKENS = [
  'as i recall', 'if i remember correctly', '如果我没记错',
  '如果我记得没错', '我依稀记得', '依稀记得',
];

// Cocky boosters — phrases that *raise* leak score (override any hedge nearby).
const COCKY_BOOSTERS_ZH = ['一定', '必然', '毫无疑问', '众所周知', '显然', '当然', '肯定'];
const COCKY_BOOSTERS_EN = ['definitely', 'certainly', 'undoubtedly', 'of course', 'clearly', 'obviously', 'without doubt'];

// ---- Helpers ----------------------------------------------------------------

function lowerHas(haystack, needle) {
  return haystack.toLowerCase().indexOf(needle.toLowerCase()) !== -1;
}

function hasAnyToken(window, tokens) {
  const low = window.toLowerCase();
  for (const t of tokens) {
    if (low.indexOf(t.toLowerCase()) !== -1) return true;
  }
  return false;
}

/**
 * Score one assertive claim given the surrounding window + context.
 *
 * Thresholds (4 buckets):
 *   0.0–0.3  hedged claim — model said the right thing, low concern
 *   0.3–0.5  source-grounded high-assertion — OK because evidence exists
 *   0.5–0.7  borderline — assertion w/o hedge but not flashy; watch
 *   0.7–1.0  leak — should have hedged; this is the case the detector catches
 *
 * @returns {{score:number, has_hedge:boolean, fake_hedge:boolean, cocky:boolean}}
 */
function scoreClaim(claimText, window, baseWeight, isSourceGrounded) {
  const realHedge = hasAnyToken(window, HEDGE_TOKENS_ZH) || hasAnyToken(window, HEDGE_TOKENS_EN);
  const fakeHedge = hasAnyToken(window, FAKE_HEDGE_TOKENS);
  const cocky = hasAnyToken(window, COCKY_BOOSTERS_ZH) || hasAnyToken(window, COCKY_BOOSTERS_EN);

  let score;
  if (realHedge && !cocky) {
    // Genuine hedge nearby — push into low bucket.
    score = Math.min(0.3, baseWeight * 0.35);
  } else if (isSourceGrounded) {
    // No hedge but caller asserts the output is source-grounded — middle bucket.
    score = 0.4;
  } else {
    // No hedge, no source — base weight kicks in.
    score = baseWeight;
  }

  // Cocky booster: +0.2 (clamp 1.0).
  if (cocky) score = Math.min(1.0, score + 0.2);
  // Fake hedge: +0.1 — performative not honest, the speaker can't recall.
  if (fakeHedge) score = Math.min(1.0, score + 0.1);

  return {
    score: Number(score.toFixed(2)),
    has_hedge: realHedge,
    fake_hedge: fakeHedge,
    cocky,
  };
}

function adviceFor(type) {
  switch (type) {
    case 'date':
      return '若日期不确定，请改用「大约 …」「印象中是 …」或直接「具体日期我记不清」。';
    case 'person':
      return '若人物/作品/事件不确定，请改用「据说」「我记得是 …，但不一定准」或承认「我不知道」。';
    case 'quote':
      return '引文/出处不确定时，禁止编造；改写为「这个观点大致是说 …」并去掉具体出处。';
    case 'number':
      return '具体数字无来源时，改成「大约」「数量级在 …」或承认「我没有可靠数字」。';
    case 'technical':
      return '内部技术细节无公开来源时，明确「我不知道他们具体怎么实现」而非编一个细节。';
    default:
      return '不确定时应说「我不知道」或加 hedge 词，不应直接断言。';
  }
}

// ---- Main entrypoint --------------------------------------------------------

/**
 * @param {string} text — the model output to inspect.
 * @param {object} [context]
 * @param {boolean} [context.is_source_grounded] — caller asserts the output
 *   is backed by retrieval / citation / a tool result. Mid-bucket if true.
 * @returns {{
 *   claims: Array<{type, text, has_hedge, fake_hedge, cocky,
 *                  confidence_leak_score, advice}>,
 *   summary: {total_assertive, with_hedge, without_hedge, leak_count,
 *             cocky_count, fake_hedge_count}
 * }}
 */
function detectConfidenceLeaks(text, context = {}) {
  // Machino-α9 — archetype is an optional context field. Default = strict
  // (TECH-CONCEPT base). Unknown archetype falls back to strict, so callers
  // that pass garbage don't accidentally relax the detector.
  const archetype = (context && context.archetype
                     && ARCHETYPE_CONFIDENCE_MULTIPLIERS[context.archetype])
    ? context.archetype
    : 'TECH-CONCEPT';

  if (typeof text !== 'string' || !text.trim()) {
    return {
      claims: [],
      summary: {
        total_assertive: 0,
        with_hedge: 0,
        without_hedge: 0,
        leak_count: 0,
        cocky_count: 0,
        fake_hedge_count: 0,
        archetype_used: archetype,
      },
    };
  }

  const isSourceGrounded = Boolean(context && context.is_source_grounded);

  const claims = [];
  const seen = new Set(); // dedupe identical (offset,type) entries

  for (const pat of ASSERTIVE_PATTERNS) {
    // Reset lastIndex defensively — module-level regex objects are stateful.
    pat.regex.lastIndex = 0;
    let m;
    while ((m = pat.regex.exec(text)) !== null) {
      const matched = m[0];
      if (!matched || !matched.trim()) {
        // Defensive: zero-width match would infinite-loop with the /g flag.
        if (m.index === pat.regex.lastIndex) pat.regex.lastIndex++;
        continue;
      }
      const offset = m.index;
      const key = `${offset}:${pat.type}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const winStart = Math.max(0, offset - HEDGE_WINDOW);
      const winEnd = Math.min(text.length, offset + matched.length + HEDGE_WINDOW);
      const window = text.slice(winStart, winEnd);

      const s = scoreClaim(matched, window, pat.weight, isSourceGrounded);
      // Machino-α9 — apply archetype-aware multiplier on top of base score.
      // HUMANITIES 0.6× / LANG-ACQ 0.8× (date/person/quote only) /
      // MINDSET 0.7× / TECH-* + DECL-MASS 1.0× (unchanged).
      const mult = _archetypeMultiplier(archetype, pat.type);
      const adjusted = Math.max(0, Math.min(1.0, s.score * mult));

      claims.push({
        type: pat.type,
        text: matched,
        has_hedge: s.has_hedge,
        fake_hedge: s.fake_hedge,
        cocky: s.cocky,
        confidence_leak_score: Number(adjusted.toFixed(2)),
        advice: adviceFor(pat.type),
      });
    }
  }

  const summary = {
    total_assertive: claims.length,
    with_hedge: claims.filter(c => c.has_hedge && !c.fake_hedge).length,
    without_hedge: claims.filter(c => !c.has_hedge).length,
    leak_count: claims.filter(c => c.confidence_leak_score > 0.6).length,
    cocky_count: claims.filter(c => c.cocky).length,
    fake_hedge_count: claims.filter(c => c.fake_hedge).length,
    archetype_used: archetype,
  };

  return { claims, summary };
}

module.exports = {
  detectConfidenceLeaks,
  // exported for tests / inspection — not part of the supported surface.
  _internals: {
    ASSERTIVE_PATTERNS,
    HEDGE_TOKENS_ZH,
    HEDGE_TOKENS_EN,
    FAKE_HEDGE_TOKENS,
    COCKY_BOOSTERS_ZH,
    COCKY_BOOSTERS_EN,
    HEDGE_WINDOW,
    ARCHETYPE_CONFIDENCE_MULTIPLIERS,
  },
};
