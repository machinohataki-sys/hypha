'use strict';

// HYPHA · Creation System — Expected Years Estimator (Pillar 2)
// =============================================================
//
// PURPOSE
// -------
// Goal Guardian's `_estimateDifficulty` is a keyword heuristic (1 dictionary
// lookup → score 0-1) and the LLM judge prompt mocks Ericsson 1993 anchors.
// Result: every Nobel-tier goal collapses to either "10000 hours / 10-15 years"
// (Ericsson training cutoff) or the math anchor (Macnamara 1000h base) — both
// of which silently undershoot reality. Real Nobel literature laureates:
// Mo Yan 31y (career → win), Ishiguro 36y, Kawabata 47y. The system never
// asks "what did real people who hit this goal actually take".
//
// This module is HYPHA's frontier-grounded answer: harvest 2024-2026 sources
// about actual human trajectories for the user's goal, extract concrete
// (name, role, start_year, achieve_year) records, then compute p25/p50/p75
// + modal years from those records. Cross-reference with the existing math
// floor (feasibility.js) so the OUTPUT is always the MORE CONSERVATIVE of
// (trajectory p75, math-derived p90, 0.3-year hard floor).
//
// CONTRACT
// --------
//   const { estimate } = require('./expected-years-estimator');
//   const out = await estimate({ goalContract, archetype, settings, onProgress });
//   //  out = { conservative_years, evidence: [...cases], p25, p50, p75, modal,
//   //          sources_used, used_feasibility_floor, _meta }
//
// FAIL MODES
// ----------
// - scout returns 0 case-trajectory sources → cases=[], p* all null,
//   conservative_years falls back to feasibility-derived p90 only.
// - LLM cannot parse cases → cases=[], same fallback.
// - Both → conservative_years = max(feasibility_years_p90, 0.3).
//
// EMITS (via onProgress)
// ---------------------
//   estimate:start          { goal }
//   estimate:cases-found    { count, samples: [top-3 names] }
//   estimate:done           { conservative_years, p50, p75, source_count }
//
// LIMITATIONS — HONEST GAP
// ------------------------
// Even with the Ericsson ban in the scout prompt, the T4_JUDGE parser can
// hallucinate years for known-famous people (training-cutoff bleed: if the
// snippet doesn't carry the year, the LLM may "complete" from memory).
//
// HYPHA Gap 2 mitigation (2026-05-17): after LLM parse we run a deterministic
// source-claim consistency filter (`_filterHallucinated`). Each case must:
//   (a) name appears in at least 1 source title or snippet (case-insensitive,
//       substring; matches any language variant present in sources);
//   (b) at least one of {start_year, achieve_year} appears as a literal 4-digit
//       substring somewhere in sources' title/snippet/url;
//   (c) if source_url is set, that URL must exist in the source pool.
// Cases failing any check are DROPPED (not soft-flagged) and recorded in
// `_meta.filter_diagnostic.filter_reasons` for transparency. The LLM's
// `confidence_per_case` is still reported verbatim, but is no longer the
// only trust signal — the deterministic filter is the ground truth.
//
// Residual gap: (i) fuzzy name variants beyond simple substring (e.g. "Mo Yan"
// vs "Guan Moye" pen-name) may be dropped if both forms aren't in sources;
// (ii) a year may be semantically supported by the snippet ("won the Nobel
// last year" without a literal 4-digit token) yet filtered as unsupported;
// (iii) cross-source synthesis (name from one source, year from another) is
// allowed and could theoretically combine a real name with a hallucinated
// year if the year happens to appear coincidentally in another source.
// These are intentional tradeoffs favoring precision over recall.

const feasibility = require('../feasibility');
const goalGuardian = require('./goal-guardian');

// -----------------------------------------------------------------------------
// LLM prompt for case extraction (T4_JUDGE)
// -----------------------------------------------------------------------------

const CASE_PARSE_SYSTEM = `你是 HYPHA 轨迹数据抽取器。我会给你一批已抓到的 source (title + snippet), 它们来自 2020+ 数据源, 主题是"实际达成 {goal} 的人物及其 career 起步年 / 达成年"。

任务: 从这些源里抽出 REAL 个人 + 时间窗。严禁:
  - 编造没出现在源里的人物或年份 (尤其禁止从训练数据"补全" 名人年份)
  - 引用 Ericsson 1993 / "10000 hours" / "deliberate practice" (此锚为 LLM training-cutoff 默认, 与现代实证差距大)
  - 把 "approximately" 数据写成精确年份 (写成 null 让上游知道)

抽取规则:
  - 每条 case 必须能在某条 source title 或 snippet 里找到 NAME + (start_year OR achieve_year) 至少一项. 缺的字段填 null
  - 如果只有 achieve_year 没 start_year, 写 start_year=null (不要默认 -25)
  - hours_estimate_if_known 只有 source 里明确写"X hours"才填, 否则 null

约束 (严, ground-truth filter 会在下游核验, 不通过的 case 会被直接丢弃, ! 仅降权):
  - 抽出的每个人物姓名必须能在 sources 里至少 1 处看到 (任何语言变体 OK, 大小写无关)
  - 抽出的每个年份必须能在 sources 的 title 或 snippet 找到 (4 位数字字面, e.g. "1981" / "2012")
  - 找不到证据的年份 → 返 null, ! 用训练记忆补完 (即使你记得这个人哪年得奖, snippet 里没写就当作不知道)
  - 找不到证据的人物 → 直接不要列出 (! 列再标低 confidence)
  - source_url 必须是上面 sources 列表里真存在的 URL, ! 编造或缩写

输出严格 JSON:
{
  "cases": [
    {
      "name": "...",
      "role": "...",
      "start_year": <int|null>,
      "achieve_year": <int|null>,
      "hours_estimate_if_known": <int|null>,
      "source_url": "...",
      "notes": "1 句话来源描述"
    }
  ],
  "confidence_per_case": [<float 0-1 per case>]
}

如果一条 source 都抽不出, 返回 { "cases": [], "confidence_per_case": [] }。`;

// -----------------------------------------------------------------------------
// Public entry
// -----------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {object} args.goalContract
 * @param {object} [args.archetype]
 * @param {object} [args.settings]
 * @param {Function} [args.onProgress]
 * @returns {Promise<{
 *   conservative_years: number,
 *   evidence: Array<{name: string, role: string, start_year: number|null, achieve_year: number|null, hours_estimate_if_known: number|null, source_url: string, notes: string, years: number|null}>,
 *   p25: number|null, p50: number|null, p75: number|null, modal: number|null,
 *   sources_used: number,
 *   used_feasibility_floor: boolean,
 *   _meta: object
 * }>}
 */
async function estimate({ goalContract, archetype, settings, onProgress } = {}) {
  const emit = typeof onProgress === 'function' ? onProgress : (() => {});
  const gc = goalContract || {};
  const goal = String(gc.north_star_goal || '').trim();
  const mainCreation = String(gc.main_creation || '').trim();

  emit('estimate:start', { goal });

  if (!goal) {
    const fallback = _buildOutput({
      cases: [],
      p25: null, p50: null, p75: null, modal: null,
      sourcesUsed: 0,
      feasibilityYearsP90: 0,
      feasibilityHoursNeeded: 0,
      reason: 'empty north_star_goal',
    });
    emit('estimate:done', {
      conservative_years: fallback.conservative_years,
      p50: null, p75: null, source_count: 0,
    });
    return fallback;
  }

  // ── Step 1 — scout case-trajectory dim ──
  let sources = [];
  let scoutMeta = null;
  try {
    const { scoutFrontier } = require('../harvest/hypha-scout');
    const scoutResult = await scoutFrontier({
      northStar: goal,
      mainCreation,
      archetype,
      settings,
      onProgress: (stage, payload) => emit(stage, payload),
      mode: 'estimate',
    });
    sources = Array.isArray(scoutResult && scoutResult.sources) ? scoutResult.sources : [];
    scoutMeta = scoutResult && scoutResult.meta;
  } catch (err) {
    emit('estimate:scout-error', { message: err && err.message ? err.message : 'scout failed' });
    sources = [];
  }

  const trajectorySources = sources.filter(s => s && s.dimension === 'case-trajectory');
  const sourcesUsed = trajectorySources.length;

  // ── Step 2 — LLM-parse cases from trajectory sources ──
  let cases = [];
  let confidencePerCase = [];
  if (sourcesUsed > 0) {
    const parsed = await _parseCases({ goal, trajectorySources, emit });
    cases = parsed.cases || [];
    confidencePerCase = parsed.confidence_per_case || [];
  }

  // ── Step 2.5 — Hallucination filter (HYPHA Gap 2, 2026-05-17) ──
  // Deterministic source-claim consistency check. LLM may complete years/names
  // from training memory; this filter is the ground-truth gate. Cases failing
  // any rule are DROPPED, not soft-flagged. See header LIMITATIONS section.
  const casesRawFromLlm = cases.length;
  const filterReport = _filterHallucinated({ cases, sources: trajectorySources });
  const keptCases = filterReport.kept;
  // Keep confidence_per_case aligned with kept cases (drop confidence rows whose
  // case was filtered). LLM emits per-case parallel array; we filter by index.
  const keptConfidences = filterReport.keptIndices.map(i => confidencePerCase[i]).filter(v => v != null);

  emit('estimate:hallucination-filtered', {
    raw: casesRawFromLlm,
    kept: keptCases.length,
    filtered: filterReport.reasons.length,
    top_reasons: filterReport.reasons.slice(0, 5).map(r => ({ name: r.name, year: r.year, reason: r.reason })),
  });

  // Compute years per case (null if either endpoint missing) — on FILTERED set.
  const enrichedCases = keptCases.map(c => {
    const start = Number.isFinite(Number(c.start_year)) ? Number(c.start_year) : null;
    const achieve = Number.isFinite(Number(c.achieve_year)) ? Number(c.achieve_year) : null;
    const years = (start != null && achieve != null && achieve > start) ? (achieve - start) : null;
    return { ...c, years };
  });

  const yearSpans = enrichedCases.map(c => c.years).filter(y => Number.isFinite(y) && y > 0);

  // ── Step 3 — stats ──
  const stats = _computeStats(yearSpans);

  emit('estimate:cases-found', {
    count: enrichedCases.length,
    samples: enrichedCases.slice(0, 3).map(c => c.name || '(unnamed)'),
  });

  // ── Step 4 — cross-reference feasibility.js ──
  const targetDifficulty = goalGuardian._estimateDifficulty(goal);
  const dailyHours = Number(gc.dailyHours) || _dailyHoursFromContract(gc);
  const safeDaily = Math.max(0.5, dailyHours);
  // Use trajectory p50 (or 5y default) to size feasibility window so the math
  // computes hoursNeeded consistent with the trajectory horizon. Note: hoursNeeded
  // is path-independent of timeWeeks here (effectiveHoursNeeded only depends on
  // target/prior/load/alpha) — but we still need to pass a plausible timeWeeks
  // so classifyFeasibility doesn't div-by-zero or compute weird ratios.
  const p50Years = stats.p50 || 5;
  const timeWeeks = p50Years * 52;
  const feas = feasibility.classifyFeasibility({
    targetDifficulty,
    priorKnowledge: 0.3,
    timeWeeks,
    dailyHours: safeDaily,
    intrinsicLoad: 'med',
    priorConsistency: 0.5,
    failedAttempts: 0,
  });
  const feasibilityHoursNeeded = Number(feas.hoursNeeded) || 0;
  // hoursNeeded ÷ (dailyHours × 7 × 52) = years at user's pace.
  // ×1.3 to convert p50 → p90 (conservative tail of Macnamara variance).
  const feasibilityYearsP90 = (feasibilityHoursNeeded / (safeDaily * 7 * 52)) * 1.3;

  // ── Step 5 — most-conservative output ──
  const out = _buildOutput({
    cases: enrichedCases,
    confidencePerCase: keptConfidences,
    p25: stats.p25, p50: stats.p50, p75: stats.p75, modal: stats.modal,
    sourcesUsed,
    feasibilityYearsP90,
    feasibilityHoursNeeded,
    scoutMeta,
    targetDifficulty,
    filterDiagnostic: {
      cases_raw_from_llm: casesRawFromLlm,
      cases_kept: keptCases.length,
      cases_filtered_hallucinated: filterReport.reasons.length,
      filter_reasons: filterReport.reasons,
    },
  });

  emit('estimate:done', {
    conservative_years: out.conservative_years,
    p50: out.p50,
    p75: out.p75,
    source_count: sourcesUsed,
  });

  return out;
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

async function _parseCases({ goal, trajectorySources, emit }) {
  let llm = null;
  try { llm = require('../llm'); } catch (_) { llm = null; }
  if (!llm || typeof llm.executeChat !== 'function') {
    emit('estimate:parse-error', { reason: 'llm router unavailable' });
    return { cases: [], confidence_per_case: [] };
  }

  // Compress sources to title + 400-char snippet to fit context.
  const sourcesBlock = trajectorySources
    .slice(0, 40)
    .map((s, i) => `[#${i + 1}] ${String(s.title || '').slice(0, 200)}\n      URL: ${s.url || ''}\n      ${String(s.snippet || '').slice(0, 400)}`)
    .join('\n\n');

  const userMsg = [
    `目标 (north_star): ${goal}`,
    '',
    'Sources (title + URL + snippet):',
    sourcesBlock || '(empty)',
    '',
    '请抽取实际人物的 career 轨迹 JSON。如无数据返回空 cases 数组。',
  ].join('\n');

  let parsed = null;
  let rawText = '';
  try {
    const d = await llm.executeChat('T4_JUDGE', {
      messages: [
        { role: 'system', content: CASE_PARSE_SYSTEM.replace('{goal}', goal) },
        { role: 'user', content: userMsg },
      ],
      json: true,
      temperature: 0.2,
      maxTokens: 2000,
      timeoutMs: 60_000,
    });
    const r = d && d.result;
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      // Provider returned parsed object
      parsed = r;
    } else if (typeof r === 'string') {
      rawText = r;
    } else if (r && typeof r.content === 'string') {
      rawText = r.content;
    } else if (r && Array.isArray(r.choices) && r.choices[0] && r.choices[0].message) {
      rawText = String(r.choices[0].message.content || '');
    } else {
      rawText = JSON.stringify(r || {});
    }
  } catch (err) {
    emit('estimate:parse-error', { reason: (err && err.message) || 'llm threw' });
    return { cases: [], confidence_per_case: [] };
  }

  if (!parsed) parsed = _safeParseJSON(rawText);
  if (!parsed || typeof parsed !== 'object') {
    emit('estimate:parse-error', { reason: 'unparseable JSON' });
    return { cases: [], confidence_per_case: [] };
  }

  const cases = Array.isArray(parsed.cases) ? parsed.cases.filter(c => c && c.name) : [];
  const confidence = Array.isArray(parsed.confidence_per_case) ? parsed.confidence_per_case : [];
  return { cases, confidence_per_case: confidence };
}

function _safeParseJSON(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) {}
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}

/**
 * Source-claim consistency filter (HYPHA Gap 2, 2026-05-17).
 *
 * For each LLM-emitted case, verify against the actual source pool:
 *   1. `name` substring (case-insensitive) appears in some source's title/snippet
 *   2. At least one of {start_year, achieve_year} appears as a literal 4-digit
 *      token somewhere in sources' title/snippet/url
 *   3. If `source_url` is set, that URL must exist in the source pool
 *
 * Returns { kept: Case[], keptIndices: number[], reasons: Array<{name,year,reason}> }.
 *
 * Cases failing ANY check are dropped (not soft-flagged). Reasons recorded for
 * `_meta.filter_diagnostic` transparency. Index parity with the input `cases`
 * array lets callers re-align `confidence_per_case`.
 *
 * @param {{cases: Array, sources: Array}} args
 */
function _filterHallucinated({ cases, sources }) {
  const kept = [];
  const keptIndices = [];
  const reasons = [];

  const sourceUrls = new Set();
  // Concatenated haystack for substring + year matching. Lowercased once.
  let haystackLc = '';
  for (const s of (sources || [])) {
    if (!s) continue;
    if (s.url) sourceUrls.add(String(s.url));
    const parts = [s.title || '', s.snippet || '', s.url || ''];
    haystackLc += parts.join(' ') + '\n';
  }
  haystackLc = haystackLc.toLowerCase();

  // Pre-extract all 4-digit year tokens (1500-2100 plausibility window) so we
  // don't false-match arbitrary 4-digit numbers like article IDs. Conservative
  // window: career trajectories outside this range are not realistic 2026 data.
  const yearTokens = new Set();
  const yearRe = /\b(1[5-9]\d{2}|20\d{2}|2100)\b/g;
  let m;
  while ((m = yearRe.exec(haystackLc)) != null) yearTokens.add(m[1]);

  for (let i = 0; i < (cases || []).length; i++) {
    const c = cases[i];
    if (!c || typeof c !== 'object') {
      reasons.push({ name: '(invalid)', year: null, reason: 'case not an object' });
      continue;
    }
    const name = String(c.name || '').trim();
    if (!name) {
      reasons.push({ name: '(empty)', year: null, reason: 'empty name' });
      continue;
    }

    // Rule 1 — name substring (case-insensitive). Use lowercased name. Single-
    // char names rejected (too noisy); 2+ char minimum.
    const nameLc = name.toLowerCase();
    // Split on common separator (e.g. "莫言 / Mo Yan") and pass if ANY variant
    // appears in haystack — accommodates LLM emitting bilingual labels.
    const variants = nameLc.split(/[\/／,;|]| - /).map(v => v.trim()).filter(v => v.length >= 2);
    const nameOk = variants.length > 0 && variants.some(v => haystackLc.includes(v));
    if (!nameOk) {
      reasons.push({ name, year: null, reason: 'name not in any source' });
      continue;
    }

    // Rule 2 — at least one year token present in sources.
    const startStr = (c.start_year != null && Number.isFinite(Number(c.start_year))) ? String(Number(c.start_year)) : null;
    const achieveStr = (c.achieve_year != null && Number.isFinite(Number(c.achieve_year))) ? String(Number(c.achieve_year)) : null;
    const startOk = startStr != null && yearTokens.has(startStr);
    const achieveOk = achieveStr != null && yearTokens.has(achieveStr);
    if (!startOk && !achieveOk) {
      // Report the first non-null year for diagnostic clarity.
      const reportedYear = startStr || achieveStr || null;
      reasons.push({ name, year: reportedYear, reason: 'year not in any source' });
      continue;
    }

    // Rule 3 — source_url must exist in pool (if set).
    if (c.source_url) {
      const url = String(c.source_url).trim();
      if (url && !sourceUrls.has(url)) {
        reasons.push({ name, year: achieveStr || startStr || null, reason: 'source_url not in source pool' });
        continue;
      }
    }

    kept.push(c);
    keptIndices.push(i);
  }

  return { kept, keptIndices, reasons };
}

function _computeStats(yearSpans) {
  if (!yearSpans.length) return { p25: null, p50: null, p75: null, modal: null };
  const sorted = [...yearSpans].sort((a, b) => a - b);
  const pct = (p) => {
    const idx = Math.floor((sorted.length - 1) * p);
    return sorted[Math.min(sorted.length - 1, Math.max(0, idx))];
  };
  const counts = new Map();
  for (const y of sorted) {
    // Bucket to nearest year for modal calc — collapses 5.0/5.1/5.2 into "5"
    const k = Math.round(y);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let modal = null;
  let modalCount = -1;
  for (const [k, c] of counts) {
    if (c > modalCount) { modalCount = c; modal = k; }
  }
  return { p25: pct(0.25), p50: pct(0.5), p75: pct(0.75), modal };
}

function _dailyHoursFromContract(gc) {
  // Mirror creation/goal-guardian._dailyHoursFor minus the dependency.
  const map = { intensive: 4, steady: 2, casual: 1, growth: 2, exam: 3, hybrid: 2.5 };
  const k = String(gc.learning_model || '').toLowerCase().trim();
  return map[k] != null ? map[k] : 2;
}

function _buildOutput({ cases, confidencePerCase, p25, p50, p75, modal, sourcesUsed, feasibilityYearsP90, feasibilityHoursNeeded, scoutMeta, targetDifficulty, reason, filterDiagnostic }) {
  const trajP75 = Number.isFinite(p75) ? p75 : 0;
  const feasP90 = Number.isFinite(feasibilityYearsP90) ? feasibilityYearsP90 : 0;
  // Most conservative of: trajectory p75, feasibility p90, 0.3y hard floor.
  const conservative_years = Math.max(trajP75, feasP90, 0.3);
  const usedFeasibilityFloor = feasP90 > trajP75;
  return {
    conservative_years: _round1(conservative_years),
    evidence: cases || [],
    p25: Number.isFinite(p25) ? _round1(p25) : null,
    p50: Number.isFinite(p50) ? _round1(p50) : null,
    p75: Number.isFinite(p75) ? _round1(p75) : null,
    modal: Number.isFinite(modal) ? modal : null,
    sources_used: sourcesUsed || 0,
    used_feasibility_floor: !!usedFeasibilityFloor,
    _meta: {
      confidence_per_case: confidencePerCase || [],
      feasibility_years_p90: _round1(feasP90),
      feasibility_hours_needed: Math.round(feasibilityHoursNeeded || 0),
      target_difficulty: Number.isFinite(targetDifficulty) ? targetDifficulty : null,
      scout_rounds: scoutMeta && scoutMeta.rounds || 0,
      scout_coverage: scoutMeta && scoutMeta.coverage || null,
      degraded_reason: reason || null,
      filter_diagnostic: filterDiagnostic || {
        cases_raw_from_llm: 0,
        cases_kept: 0,
        cases_filtered_hallucinated: 0,
        filter_reasons: [],
      },
    },
  };
}

function _round1(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

module.exports = {
  estimate,
  // Exposed for testing only.
  __internals: {
    _computeStats,
    _safeParseJSON,
    _parseCases,
    _dailyHoursFromContract,
    _buildOutput,
    _filterHallucinated,
  },
};
