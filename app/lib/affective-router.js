'use strict';

/**
 * HYPHA · W2.3 Affective Router — cheap-regex pre-screen for user turn affect.
 *
 * Per BLUEPRINT §3.4 (Goal Guardian) + specs/goal-guardian.md §4.
 *
 * Pure function. No network. No mutation. Returns:
 *   extractAffect(turnText) → { sentiment, energy, signals: [] }
 *   routeAffect(affect, currentLesson) → guardian_action enum | null
 *
 * 6 signal types (cheap regex pre-screen REAL, T4_JUDGE 二判 TODO):
 *   - frustration_marker — 我不懂 / 卡了 / 糟糕 / 算了 / 放弃 / 太难
 *   - doubt_marker       — 我是不是 / 可能不 / 也许不 / 笨 / 学不会
 *   - distraction_marker — off-topic noun + 问号  (heuristic: 长度 + 问号 +
 *                          不含 lesson concept tokens; requires currentLesson
 *                          context, so this signal only fires from routeAffect)
 *   - spark_marker       — 我想到 / 灵感 / 突然 / 联想到 / 可不可以
 *   - high_energy_marker — `!` / 真的吗 / 哇 / cool / amazing / 绝了
 *   - agreement_marker   — 明白了 / 懂了 / 对 / 是的 (telemetry only)
 *
 * Banned zh-AI 流量词 (per CLAUDE.md, do NOT count as high_energy_marker):
 *   yyds / 绝绝子 / 闭环 / 王炸 / 真香 / 上分 — explicitly excluded from
 *   HIGH_ENERGY_RE so user can use the legitimate 哇/绝了 path without
 *   accidentally inheriting brand-incoherent jargon.
 *
 * sentiment / energy baseline:
 *   sentiment ∈ [-1, 1] — start 0; frustration -0.3; doubt -0.3;
 *                          agreement +0.2; spark/high_energy +0.4; clip.
 *   energy ∈ [0, 1]     — start 0.3; long turn (≥60 char) + ! or ？ → +0.3;
 *                          extra ! → +0.15 each (cap 2); short (≤6 char) → -0.3.
 *
 * intentional-placeholder: T4_JUDGE upgrade deferred to W2.3.1. cheap regex
 * caps confidence at 0.55 (not 0.85) by design — strong action (W2.4 Repair
 * dispatch) waits for LLM confirmation.
 */

// -----------------------------------------------------------------------------
// Regex catalogue — each pattern matches Chinese-first cues plus English
// fallback markers. CJK chars in /u-mode regex are fine without spacing pass
// because we /test on the original string.
// -----------------------------------------------------------------------------

const FRUSTRATION_RE = /(我(完全)?不懂|看不懂|卡(了|住)|糟糕|算了|放弃|太难了?|不会(啊|了|做)?|难死了|烦死了?|崩溃|stuck|i (don'?t|do not) (get|understand))/i;

// doubt_marker covers two clusters: (a) explicit self-questioning ("我是不是 ..."),
// (b) defeat / give-up ("算了 ... 我放弃了") — give-up signals doubt about future
// ability even when not phrased as a question. Both clusters land on the same
// repair path (self-doubt) per spec §3.
const DOUBT_RE = /(我是不是|我可能.{0,4}(不|没)|也许.{0,4}不|怀疑自己|我(就是|真是)?(笨|蠢|废)|没天分|学不会|不适合(我|学)|跟不上|算了.{0,8}(放弃|不(学|做))|放弃了?$|i('?m| am)? (probably|maybe) (dumb|stupid|not))/i;

const SPARK_RE = /(我想到|灵感|想到了|有个想法|突然(想|意识)|联想到|类比到|可不可以|要是.*(会|怎么)|如果.*(会|怎么))/i;

// HIGH_ENERGY: `!` (en + zh ！) + 哇 / 真的吗 / cool / amazing / 绝了.
// EXCLUDES: yyds 绝绝子 闭环 王炸 真香 上分 (CLAUDE.md AI-cliché ban).
const HIGH_ENERGY_RE = /(!{1,}|！{1,}|真的吗\?{0,1}|哇[!！\s]|cool|amazing|惊艳|绝了[!！\s]?)/i;
const BANNED_AI_CLICHE_RE = /(yyds|绝绝子|闭环|拉满|王炸|杀疯了|干货|上分|上车|内卷|出圈|真香)/i;

const AGREEMENT_RE = /(明白了|懂了|对的?[!。\s]|是的[!。\s]?|确实|没错|got it|i see)/i;

// -----------------------------------------------------------------------------
// extractAffect — Pure regex pre-screen. Returns flat object.
// -----------------------------------------------------------------------------

/**
 * @param {string} turnText
 * @returns {{
 *   sentiment: number,        // -1..1
 *   energy: number,           // 0..1
 *   signals: string[],        // signal-type strings, see catalogue
 *   confidence: number,       // 0..0.55 cheap-regex cap
 *   evidence: Array<{ signal: string, snippet: string }>
 * }}
 */
function extractAffect(turnText) {
  const text = String(turnText == null ? '' : turnText);
  const signals = [];
  const evidence = [];
  let sentiment = 0;
  let energy = 0.3;

  if (FRUSTRATION_RE.test(text)) {
    signals.push('frustration_marker');
    sentiment -= 0.3;
    const m = text.match(FRUSTRATION_RE);
    if (m) evidence.push({ signal: 'frustration_marker', snippet: m[0] });
  }
  if (DOUBT_RE.test(text)) {
    signals.push('doubt_marker');
    sentiment -= 0.3;
    const m = text.match(DOUBT_RE);
    if (m) evidence.push({ signal: 'doubt_marker', snippet: m[0] });
  }
  if (SPARK_RE.test(text)) {
    signals.push('spark_marker');
    sentiment += 0.4;
    energy += 0.2;
    const m = text.match(SPARK_RE);
    if (m) evidence.push({ signal: 'spark_marker', snippet: m[0] });
  }
  if (HIGH_ENERGY_RE.test(text) && !BANNED_AI_CLICHE_RE.test(text)) {
    signals.push('high_energy_marker');
    sentiment += 0.4;
    // each ! adds energy up to cap +2 marks
    const bangCount = (text.match(/[!！]/g) || []).length;
    energy += Math.min(0.3, bangCount * 0.15);
    const m = text.match(HIGH_ENERGY_RE);
    if (m) evidence.push({ signal: 'high_energy_marker', snippet: m[0] });
  }
  if (AGREEMENT_RE.test(text)) {
    signals.push('agreement_marker');
    sentiment += 0.2;
    const m = text.match(AGREEMENT_RE);
    if (m) evidence.push({ signal: 'agreement_marker', snippet: m[0] });
  }

  // energy adjustments by length / shape
  const len = text.replace(/\s+/g, '').length;
  if (len >= 60 && /[!！？\?]/.test(text)) energy += 0.3;
  if (len <= 6 && len > 0) energy -= 0.3;
  if (len === 0) { energy = 0; }

  // clip
  sentiment = Math.max(-1, Math.min(1, sentiment));
  energy = Math.max(0, Math.min(1, energy));

  // cheap-regex confidence cap (per spec §4). T4_JUDGE will raise to 0.85.
  // Confidence = 0 when no signal fires (pure neutral turn).
  const confidence = signals.length === 0 ? 0 : 0.55;

  return { sentiment, energy, signals, confidence, evidence };
}

// -----------------------------------------------------------------------------
// routeAffect — map affect → guardian_action enum. Priority order (top wins
// when multiple signals fire simultaneously):
//   1. spark_marker / high_energy_marker → capture_spark
//   2. doubt_marker (+ short)             → repair_self_doubt
//   3. frustration_marker                  → lower_difficulty
//   4. distraction (computed below)        → redirect_distraction or gentle_pullback
//   5. agreement_marker only               → null (on_track)
// distraction_marker requires currentLesson context (lesson KP tokens). When
// currentLesson is missing or lesson has no concept tokens, distraction
// detection is SKIPPED (conservative — default trust).
// -----------------------------------------------------------------------------

const GUARDIAN_ACTIONS = Object.freeze([
  'gentle_pullback',
  'lower_difficulty',
  'revive_motivation',
  'repair_self_doubt',
  'capture_spark',
  'redirect_distraction',
]);

function _tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/([一-鿿㐀-䶿])/g, ' $1 ')
    .split(/[\s\p{P}\p{S}]+/u)
    .filter(t => t && t.length >= 2);
}

function _lessonConceptTokens(currentLesson) {
  if (!currentLesson || typeof currentLesson !== 'object') return new Set();
  const parts = [
    currentLesson.thesis,
    currentLesson.title,
    currentLesson.learn_goal,
    Array.isArray(currentLesson.concepts) ? currentLesson.concepts.join(' ') : '',
    currentLesson.canonical_example && (currentLesson.canonical_example.text || ''),
  ].filter(p => typeof p === 'string').join(' ');
  return new Set(_tokenize(parts));
}

function _looksOffTopic(turnText, currentLesson) {
  if (!turnText) return false;
  const text = String(turnText);
  // Heuristic: ends in 问号 + length >= 8 + low concept overlap.
  if (!/[?？]/.test(text)) return false;
  if (text.replace(/\s+/g, '').length < 8) return false;
  const concepts = _lessonConceptTokens(currentLesson);
  if (concepts.size === 0) return false; // no anchor → cannot decide
  const userTokens = _tokenize(text);
  if (userTokens.length === 0) return false;
  let overlap = 0;
  for (const t of userTokens) if (concepts.has(t)) overlap++;
  const overlapRatio = overlap / userTokens.length;
  return overlapRatio < 0.15;
}

/**
 * @param {ReturnType<typeof extractAffect>} affect
 * @param {object} [currentLesson]
 * @returns {{ guardian_action: string|null, reason: string }}
 */
function routeAffect(affect, currentLesson) {
  const a = affect || { signals: [], sentiment: 0, energy: 0.3 };
  const signals = Array.isArray(a.signals) ? a.signals : [];

  // priority 1 — capture spark
  if (signals.includes('spark_marker') || (signals.includes('high_energy_marker') && a.sentiment >= 0.3)) {
    return { guardian_action: 'capture_spark', reason: 'spark_or_high_energy' };
  }
  // priority 2 — self_doubt (doubt_marker + short turn)
  // shortness checked indirectly via energy (short → energy < 0.3)
  if (signals.includes('doubt_marker') && a.energy < 0.4) {
    return { guardian_action: 'repair_self_doubt', reason: 'doubt_with_low_energy' };
  }
  // priority 3 — frustration
  if (signals.includes('frustration_marker')) {
    // sentiment < -0.4 + frustration → revive_motivation (deeper)
    const action = a.sentiment <= -0.4 ? 'revive_motivation' : 'lower_difficulty';
    return { guardian_action: action, reason: 'frustration' };
  }
  // priority 4 — distraction (requires currentLesson context for the noun-overlap check)
  // (turnText not passed to routeAffect; distraction is detected upstream in
  // assessGuardianState when both lesson context + turn text are available.)
  // priority 5 — agreement-only → on_track
  return { guardian_action: null, reason: signals.length === 0 ? 'neutral' : 'agreement_or_unknown' };
}

module.exports = {
  extractAffect,
  routeAffect,
  // exported for goal-guardian.js distraction heuristic
  _looksOffTopic,
  _lessonConceptTokens,
  GUARDIAN_ACTIONS,
};
