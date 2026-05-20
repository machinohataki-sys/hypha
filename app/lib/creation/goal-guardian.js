'use strict';

// HYPHA · Creation System — Goal Feasibility Guardian (onboarding gate)
//
// Per Machino-δ6 task brief (2026-05-14): a judgment gate between the
// OnboardingScreen submit and curriculum:create. Without this, a user who
// writes "成为诺贝尔文学奖得主, 1 天" is silently accepted and the system
// goes through the motions of generating a course — that is the core
// Anti-Slop / Apparent-Success violation HYPHA exists to refuse.
//
// SCOPE — feasibility judgment only. Guardian here is the WALL, not the
// remediator. It returns a verdict; the renderer decides whether to block,
// warn, or wave through. Three-tier verdict:
//
//   feasible — deadline is enough for current level → proceed silent.
//   strained — goal reasonable but pacing tight → user sees banner with
//              tighten_scope / extend_deadline suggestions; can override.
//   absurd   — physically/logically impossible (1-day Nobel, 1-week PhD,
//              "no English but read Shakespeare in original") → HARD BLOCK.
//
// Two-pass:
//   1) Math anchor from app/lib/feasibility.js (Macnamara 1000h base /
//      Donner-Hardy piecewise-power-law plateau / Newport deep-work focus).
//      Produces hoursNeeded vs
//      hoursAvailable ratio + tier (nearly-impossible / possible / easy).
//   2) LLM judge (T4_JUDGE, JSON mode, temperature 0.3) reads the math
//      anchor + the goal contract text and returns the final verdict +
//      reasoning + suggestions, in manuscript-register CN.
//
// Math is the floor — LLM cannot promote "1-day Nobel" to feasible no matter
// how the user phrases it, because hoursNeeded >> hoursAvailable and the
// system prompt explicitly forbids that promotion. LLM can DEMOTE feasible
// math → strained if it spots an internal contradiction the math missed
// (e.g. "learn no English but read Shakespeare in original").
//
// No vault writes. Pure async function. Caller (main.js) holds the verdict
// and surfaces it to the renderer; persisting to events.jsonl is the
// renderer's decision once onboarding commits or rejects.

const feasibility = require('../feasibility');

// -----------------------------------------------------------------------------
// Math wrapper — translate goalContract semantics into feasibility.js inputs.
//
// feasibility.js wants {targetDifficulty, priorKnowledge, timeWeeks, dailyHours,
// intrinsicLoad, priorConsistency, failedAttempts, alpha}. The Onboarding form
// gives north_star_goal text, current_level text, learning_model enum, deadline
// ISO string, days number, main_creation text — none of which are quantitative
// in the feasibility.js sense. So we estimate:
//
//   targetDifficulty — derived from north_star_goal text heuristics. Goals
//                      naming a Nobel / PhD / mastery tier → 0.95. Naming a
//                      published artifact (book / app / paper) → 0.65. Naming
//                      a beginner-level outcome (read X / write a draft) →
//                      0.45. Default 0.6.
//   priorKnowledge   — from current_level text. Empty → 0. Contains "零基础 /
//                      from scratch / beginner" → 0.05. Contains "intermediate
//                      / 中级 / B1" → 0.4. Contains "advanced / 高级 / expert"
//                      → 0.7. Default 0.15.
//   timeWeeks        — deadline preferred (today→deadline in weeks); fall
//                      back to days/7; fall back to 4.
//   dailyHours       — learning_model. intensive=4 / steady=2 / casual=1 /
//                      Growth=2 / Exam=3 / Hybrid=2.5. Default 2.
//   intrinsicLoad    — heuristic from main_creation. Code/math/physics →
//                      'high', research/writing/analysis → 'med', practice/
//                      exercise/reading → 'low'. Default 'med'.
//   priorConsistency — unknown at onboarding → 0 (user must earn this).
//   failedAttempts   — unknown → 0.
//   alpha            — ALPHA_LACQUER (1.7) since user is on HYPHA, not vanilla
//                      ChatGPT. This is generous; we'd rather false-flag
//                      strained and let LLM downgrade to feasible than the
//                      reverse.
// -----------------------------------------------------------------------------

const DIFFICULTY_KEYWORDS = Object.freeze({
  extreme: { score: 0.95, terms: ['诺贝尔', 'nobel', '院士', 'turing', 'fields medal', '菲尔兹', 'phd', '博士学位', '世界顶尖', 'world-class'] },
  high: { score: 0.85, terms: ['专家', 'expert', 'master', '精通', 'gpt-tier', 'frontier', '顶级', '硕士'] },
  pubished: { score: 0.65, terms: ['出版', 'publish', '发表', '上线', 'launch', '小说', 'novel', '论文', 'paper', '产品', 'product', 'startup'] },
  intermediate: { score: 0.5, terms: ['熟练', 'proficient', 'intermediate', '中级', '能做', 'build a', '写一个'] },
  beginner: { score: 0.35, terms: ['入门', 'beginner', '起步', '看懂', '理解', 'understand', 'introduction', 'read'] },
});

const PRIOR_KEYWORDS = Object.freeze({
  expert: { score: 0.7, terms: ['advanced', '高级', 'expert', '精通', '多年经验', '5+ years', '十年'] },
  intermediate: { score: 0.4, terms: ['intermediate', '中级', 'b1', 'b2', '会一些', '有基础', 'familiar'] },
  beginner: { score: 0.05, terms: ['零基础', 'from scratch', 'beginner', 'no background', '什么都不会', 'first time', '新手'] },
});

const LOAD_KEYWORDS = Object.freeze({
  high: ['code', '代码', 'math', '数学', 'physics', '物理', 'algorithm', '算法', 'theorem', '证明', 'compiler', 'kernel'],
  low: ['practice', '练习', '阅读', 'read', 'exercise', '记单词', 'vocabulary', 'drill'],
});

const LEARNING_MODEL_HOURS = Object.freeze({
  intensive: 4,
  steady: 2,
  casual: 1,
  growth: 2,
  exam: 3,
  hybrid: 2.5,
});

function _matchKeyword(text, dict) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  for (const tier of Object.keys(dict)) {
    const def = dict[tier];
    for (const term of def.terms) {
      if (t.includes(String(term).toLowerCase())) return { tier, score: def.score, term };
    }
  }
  return null;
}

function _estimateDifficulty(goalText) {
  const m = _matchKeyword(goalText, DIFFICULTY_KEYWORDS);
  return m ? m.score : 0.6;
}

function _estimatePrior(levelText) {
  if (!levelText || !String(levelText).trim()) return 0;
  const m = _matchKeyword(levelText, PRIOR_KEYWORDS);
  return m ? m.score : 0.15;
}

function _estimateLoad(creationText) {
  const t = String(creationText || '').toLowerCase();
  if (!t) return 'med';
  for (const term of LOAD_KEYWORDS.high) {
    if (t.includes(term)) return 'high';
  }
  for (const term of LOAD_KEYWORDS.low) {
    if (t.includes(term)) return 'low';
  }
  return 'med';
}

function _dailyHoursFor(learningModel) {
  const key = String(learningModel || '').toLowerCase().trim();
  if (LEARNING_MODEL_HOURS[key] != null) return LEARNING_MODEL_HOURS[key];
  return 2;
}

// Returns weeks from today → deadline ISO string. Falls back to days/7
// when deadline is empty/invalid. Floors at 0.1 to avoid div-by-zero in
// feasibility.js classify.
//
// 2026-05-17 fix — Growth mode (per 阶 1 onboarding redesign) has NO deadline
// by design. Previously the 4-week default flagged any ambitious Growth goal
// (诺贝尔 / 博士 / GPT-tier → difficulty 0.95) as absurd because 4w × 2h/day
// = 56h ≪ 10000h needed. Symptom: user clicks 开始 → bounces back silently
// (OnboardingScreen also didn't render the error). Growth without deadline
// = unbounded time horizon, so we use a generous 10-year (520 weeks) default
// so math becomes feasible / strained at worst, never absurd. LLM judge still
// gets the full context to flag truly impossible goals (e.g. "no English but
// read Shakespeare in original") via its text-level absurdity detection.
function _resolveTimeWeeks(deadlineIso, days, learningModel) {
  const today = Date.now();
  if (deadlineIso) {
    const dl = Date.parse(deadlineIso);
    if (Number.isFinite(dl) && dl > today) {
      const weeks = (dl - today) / (7 * 24 * 60 * 60 * 1000);
      return Math.max(0.1, weeks);
    }
  }
  if (Number.isFinite(Number(days)) && Number(days) > 0) {
    return Math.max(0.1, Number(days) / 7);
  }
  // No deadline + no days: differentiate by learning_model.
  if (String(learningModel || '').toLowerCase() === 'growth') {
    return 520; // 10 years — Growth = unbounded mastery horizon
  }
  return 4; // Exam/Hybrid default (these should always have explicit deadline)
}

function _availableHoursInDeadline(weeks, dailyHours) {
  return Math.round(weeks * 7 * dailyHours);
}

// -----------------------------------------------------------------------------
// LLM judge — T4_JUDGE.
// -----------------------------------------------------------------------------

const SYSTEM_PROMPT = `你是学习目标的**设计参谋**, ! 守门人。HYPHA 信条 (2026-05-17 user 锁定):

> 人类诞生的概率是 10 的四万方分之一。我们 ! 做的是劝退 user, 是 design + 尽一切手段最大程度趋近他想要的位置。

AI 时代的 Macnamara / Donner-Hardy 数学是**参考锚**, ! 上限。用 AI 协助下, 10000 小时压缩为 1000-3000 小时不是夸张, 是已被验证。你的 verdict ! 是 "能 / 不能", 是 "这条路有多远 + 我们怎么贴近"。

3 档判定 — 但**全部 verdict 都让 HYPHA 继续设计课程**, 区别只是 scope / 节奏 / 投入诚实度:

可行 (feasible):
- 学习者基础 + 时间投入 vs 目标 = 正常 effort 范围
- 例: "3 个月学完 Rust 写一个 CLI 工具" / "1 年读完 Aristotle 全集并写 5 篇分析"
- HYPHA: 正常节奏设计

紧张 (strained):
- 时间偏短 / scope 偏大 / 基础偏浅 — 但**只要不是物理硬约束, AI 时代仍可设计路径**
- 例: "1 个月内学完 Rust + Go + Python" (并行学三门) / "成为诺贝尔文学奖得主" (10-50 年量级 vs Growth 模式)
- 给出 2 种 spec 让 user 看见 trade-off:
  a) 保留 deadline, 缩 scope (e.g. 先精 1 门 → 后续 chain 续两门)
  b) 保留 scope, 扩 deadline (e.g. 把 3 月扩到 9 月)
- HYPHA: 仍然设计课程, scope 偏紧密 / 节奏偏快 / 投入诚实标记

极远 (absurd) — 但 仍然设计:
- **物理 / 时间硬约束** 才用这档: "1 天博士" (1 天 < 1 节 Hypha 课时) / "0 学英文读 Shakespeare 原文" (内在矛盾)
- 内在矛盾 / 真物理不可能 才标 absurd, 仅此而已
- 终身成就奖 / 长周期目标 (诺贝尔 / Olympic / 顶级学者) ! 算 absurd, 算 strained
- 给出 steel_man_intent (user 真正想要的是什么) + extend_deadline 建议
- HYPHA: 仍然设计课程, 但 scope 极度压缩 + 明确告诉 user 这是 micro-curriculum (e.g. "1 天博士" → 1 节高密 PhD-tier "怎么开始博士" 入门课)

核心:! 拒绝 user, 始终 design。verdict 信息进 BuildLog 作 context, ! 拦截创课。

输出 JSON, 不加解释:
{
  "verdict": "feasible" | "strained" | "absurd",
  "headline": "1 句话总评",
  "reasoning": "2-4 句为什么这么判, 挂数据(一万小时/Donner-Hardy 难度/学习者基础)",
  "suggestions": {
    "tighten_scope": "如果保留 deadline 怎么缩 scope (2-3 句具体方案)",
    "extend_deadline": "如果保留 scope 该扩到多长 (具体 X 周/月/年)",
    "steel_man_intent": "如果是 absurd, 用户可能真想要的是什么"
  },
  "math": {
    "estimated_hours_needed": <number>,
    "available_hours_in_deadline": <number>,
    "feasibility_ratio": <available / needed>
  }
}

规则:
- 诚实优先于鼓励, 但**诚实 ! 是拒绝**。"诺贝尔奖目标" 是 strained 而 ! absurd (40-50 年量级, 仍可设计长程路径)
- 只有**真物理不可能**才标 absurd (1 天博士 = 1 天 < 1 节课 / "0 学英文读原文" 内在矛盾). 长周期目标 ! 是 absurd
- 但不要劝退合理目标。"3 年内写出一本小说"是 feasible, 不是 strained
- 不假设用户态度。Steel-man 而非贬低
- 不编数据。estimated_hours 给保守估算, 挂哪个 anchor (Macnamara/Donner-Hardy)`;

function _buildUserPrompt(goalContract, mathAnchor, todayIso) {
  return [
    `今天: ${todayIso}`,
    `学习目标 (north_star): ${String(goalContract.north_star_goal || '').trim() || '(未设)'}`,
    `要产出的东西 (main_creation): ${String(goalContract.main_creation || '').trim() || '(未设)'}`,
    `当前水平: ${String(goalContract.current_level || '').trim() || '未声明'}`,
    `学习模式: ${goalContract.learning_model || '(未设)'}`,
    `Deadline: ${goalContract.deadline || '未设'}`,
    `可用天数: ${goalContract.days || '未设'}`,
    '',
    '数学锚 (供参考, 非强制依据):',
    `- 估算所需小时: ${mathAnchor.hoursNeeded} (Macnamara 1000h × Donner-Hardy 平台 × Newport deep-work)`,
    `- 可用小时 (deadline 内, focus 折扣后): ${mathAnchor.hoursAvailable}`,
    `- 比率 p50: ${mathAnchor.ratio_p50}`,
    `- math 档位: ${mathAnchor.tier}`,
    '',
    '判定。',
  ].join('\n');
}

function _extractFirstJSON(raw) {
  if (typeof raw !== 'string') return raw;
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith('{') || s.startsWith('[')) return s;
  // Find first { ... } block
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function _safeParseLLMResult(raw) {
  if (!raw) return null;
  try {
    if (typeof raw === 'object') return raw;
    const cleaned = _extractFirstJSON(raw);
    if (!cleaned) return null;
    return (typeof cleaned === 'string') ? JSON.parse(cleaned) : cleaned;
  } catch (_) {
    return null;
  }
}

function _normalizeVerdict(s) {
  const v = String(s || '').toLowerCase().trim();
  if (v === 'feasible' || v === 'strained' || v === 'absurd') return v;
  // Tolerate CN
  if (v.includes('荒谬') || v.includes('不可能') || v.includes('absurd')) return 'absurd';
  if (v.includes('紧张') || v.includes('strained') || v.includes('tight')) return 'strained';
  if (v.includes('可行') || v.includes('feasible')) return 'feasible';
  return null;
}

// Math-only fallback when LLM unreachable. Maps feasibility tier to verdict
// using cost-asymmetric thresholds:
//   ratio < 0.15 → absurd (resources are < 1/7 of need; this is "1-day Nobel"
//                  territory math-wise even before LLM weighs in)
//   ratio < 0.7 → strained (nearly-impossible tier per feasibility.js)
//   otherwise   → feasible
function _mathOnlyVerdict(math) {
  if (math.ratio_p50 < 0.15) return 'absurd';
  if (math.tier === 'nearly-impossible') return 'strained';
  return 'feasible';
}

function _fallbackPayload(goalContract, math, reason) {
  const verdict = _mathOnlyVerdict(math);
  const headlines = {
    absurd: 'Math says 不可能 — LLM 未响应, 用数学锚兜底',
    strained: 'Math says tight — LLM 未响应, 建议参考数学锚',
    feasible: 'Math says ok — LLM 未响应, 用数学锚兜底',
  };
  return {
    verdict,
    headline: headlines[verdict],
    reasoning: `LLM judge fallback: ${reason}. 数学锚: 需 ${math.hoursNeeded}h / 有 ${math.hoursAvailable}h / 比率 ${math.ratio_p50}.`,
    suggestions: {
      tighten_scope: verdict === 'feasible' ? '' : '缩小目标 scope (例: 由 "精通 X" 改为 "完成 X 的入门项目")',
      extend_deadline: verdict === 'feasible' ? '' : `把 deadline 扩到 ${Math.max(1, Math.round(math.hoursNeeded / (Math.max(1, math.dailyHours) * 7)))} 周以上`,
      steel_man_intent: verdict === 'absurd' ? '用户可能想要的是该目标的入门版本, 或者跨多年的长期路径' : '',
    },
    math: {
      estimated_hours_needed: math.hoursNeeded,
      available_hours_in_deadline: math.hoursAvailable,
      feasibility_ratio: math.ratio_p50,
    },
    _fallback: true,
  };
}

// -----------------------------------------------------------------------------
// evaluateGoalFeasibility — public entry point.
// -----------------------------------------------------------------------------

/**
 * @param {object} goalContract
 *   - north_star_goal      (required)
 *   - main_creation        (required)
 *   - current_level        (optional)
 *   - learning_model       (intensive | steady | casual | Growth | Exam | Hybrid)
 *   - deadline             (ISO date string | null)
 *   - days                 (number | null)
 *   - user_intent          (optional)
 *   - core_competencies    (optional array)
 * @param {object} [settings] — passed through to LLM router for provider config
 * @returns {Promise<{
 *   verdict: 'feasible' | 'strained' | 'absurd',
 *   headline: string,
 *   reasoning: string,
 *   suggestions: { tighten_scope: string, extend_deadline: string, steel_man_intent: string },
 *   math: { estimated_hours_needed: number, available_hours_in_deadline: number, feasibility_ratio: number },
 *   _fallback?: boolean,
 *   _meta: { provider?: string, model?: string, math_tier: string, math_ratio_p50: number }
 * }>}
 */
async function evaluateGoalFeasibility(goalContract = {}, settings = {}) {
  const todayIso = new Date().toISOString().slice(0, 10);

  // --- guard: required fields -----------------------------------------------
  const northStar = String(goalContract.north_star_goal || '').trim();
  const mainCreation = String(goalContract.main_creation || '').trim();
  if (!northStar) {
    return {
      verdict: 'absurd',
      headline: 'north_star_goal 为空, 无法判断',
      reasoning: 'Goal Guardian 拒绝空目标。请回到 onboarding 填写 north_star_goal。',
      suggestions: { tighten_scope: '', extend_deadline: '', steel_man_intent: '' },
      math: { estimated_hours_needed: 0, available_hours_in_deadline: 0, feasibility_ratio: 0 },
      _fallback: true,
      _meta: { math_tier: 'unknown', math_ratio_p50: 0 },
    };
  }

  // --- math anchor ----------------------------------------------------------
  const targetDifficulty = _estimateDifficulty(northStar);
  const priorKnowledge = _estimatePrior(goalContract.current_level);
  const dailyHours = _dailyHoursFor(goalContract.learning_model);
  const timeWeeks = _resolveTimeWeeks(goalContract.deadline, goalContract.days, goalContract.learning_model);
  const intrinsicLoad = _estimateLoad(mainCreation);

  const feasibilityInput = {
    targetDifficulty,
    priorKnowledge,
    timeWeeks,
    dailyHours,
    intrinsicLoad,
    priorConsistency: 0,
    failedAttempts: 0,
  };

  const verdict = feasibility.classifyFeasibility(feasibilityInput);
  const math = {
    tier: verdict.tier,
    ratio_p50: verdict.ratio.p50,
    hoursNeeded: verdict.hoursNeeded,
    hoursAvailable: verdict.hoursAvailable,
    dailyHours,
  };

  // --- LLM judge ------------------------------------------------------------
  const userPrompt = _buildUserPrompt(goalContract, math, todayIso);

  let llm = null;
  try { llm = require('../llm'); } catch (_) { llm = null; }

  if (!llm || typeof llm.executeChat !== 'function') {
    return Object.assign(
      _fallbackPayload(goalContract, math, 'llm router unavailable'),
      { _meta: { math_tier: math.tier, math_ratio_p50: math.ratio_p50 } }
    );
  }

  let providerId = null;
  let model = null;
  let parsed = null;
  let rawText = '';
  try {
    const d = await llm.executeChat('T4_JUDGE', {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      json: true,
      temperature: 0.3,
      maxTokens: 1500,
      timeoutMs: 60000,
    });
    providerId = d && d.providerId;
    model = d && d.model;
    const r = d && d.result;
    if (typeof r === 'string') rawText = r;
    else if (r && typeof r.content === 'string') rawText = r.content;
    else if (r && r.message && typeof r.message.content === 'string') rawText = r.message.content;
    else if (r && Array.isArray(r.choices) && r.choices[0] && r.choices[0].message && typeof r.choices[0].message.content === 'string') {
      rawText = r.choices[0].message.content;
    } else if (r && typeof r === 'object') {
      // Some providers return parsed object directly when json:true
      parsed = r;
    } else {
      rawText = JSON.stringify(r || d || {});
    }
  } catch (err) {
    return Object.assign(
      _fallbackPayload(goalContract, math, (err && err.message) || 'llm call threw'),
      { _meta: { math_tier: math.tier, math_ratio_p50: math.ratio_p50 } }
    );
  }

  if (!parsed) parsed = _safeParseLLMResult(rawText);
  if (!parsed || typeof parsed !== 'object') {
    return Object.assign(
      _fallbackPayload(goalContract, math, 'llm returned unparseable JSON'),
      { _meta: { provider: providerId, model, math_tier: math.tier, math_ratio_p50: math.ratio_p50 } }
    );
  }

  const llmVerdict = _normalizeVerdict(parsed.verdict);
  if (!llmVerdict) {
    return Object.assign(
      _fallbackPayload(goalContract, math, 'llm verdict unrecognized'),
      { _meta: { provider: providerId, model, math_tier: math.tier, math_ratio_p50: math.ratio_p50 } }
    );
  }

  // Math floor — LLM cannot promote ratio < 0.15 to feasible. Bullshit-protection.
  let finalVerdict = llmVerdict;
  if (math.ratio_p50 < 0.15 && finalVerdict === 'feasible') {
    finalVerdict = 'absurd';
  }
  if (math.ratio_p50 < 0.5 && finalVerdict === 'feasible') {
    finalVerdict = 'strained';
  }
  // 2026-05-17 fix — symmetric: math can also DEMOTE LLM's absurd to strained
  // when ratio is healthy. Previous direction (LLM → math) was one-way which
  // let the LLM hard-block "成为诺贝尔文学奖得主, Growth 模式" purely on the
  // keyword 诺贝尔, ignoring that math at 10y horizon gives ratio 0.53 = strained.
  // The asymmetric old behavior matched "math floor" intent but missed the
  // mirror case: LLM gut-reaction over-blocking on keywords. Math anchor wins.
  if (math.ratio_p50 >= 0.4 && finalVerdict === 'absurd') {
    finalVerdict = 'strained';
  }

  const sg = (parsed.suggestions && typeof parsed.suggestions === 'object') ? parsed.suggestions : {};
  const m = (parsed.math && typeof parsed.math === 'object') ? parsed.math : {};

  return {
    verdict: finalVerdict,
    headline: String(parsed.headline || '').trim().slice(0, 240) || '(无总评)',
    reasoning: String(parsed.reasoning || '').trim().slice(0, 1200),
    suggestions: {
      tighten_scope: String(sg.tighten_scope || '').trim().slice(0, 600),
      extend_deadline: String(sg.extend_deadline || '').trim().slice(0, 600),
      steel_man_intent: String(sg.steel_man_intent || '').trim().slice(0, 600),
    },
    math: {
      estimated_hours_needed: Number.isFinite(Number(m.estimated_hours_needed)) ? Number(m.estimated_hours_needed) : math.hoursNeeded,
      available_hours_in_deadline: Number.isFinite(Number(m.available_hours_in_deadline)) ? Number(m.available_hours_in_deadline) : math.hoursAvailable,
      feasibility_ratio: Number.isFinite(Number(m.feasibility_ratio)) ? Number(m.feasibility_ratio) : math.ratio_p50,
    },
    _meta: {
      provider: providerId,
      model,
      math_tier: math.tier,
      math_ratio_p50: math.ratio_p50,
      math_promoted: finalVerdict !== llmVerdict ? llmVerdict + '→' + finalVerdict : null,
    },
  };
}

module.exports = {
  evaluateGoalFeasibility,
  // exported for testing / reuse
  _estimateDifficulty,
  _estimatePrior,
  _estimateLoad,
  _resolveTimeWeeks,
  _availableHoursInDeadline,
};
