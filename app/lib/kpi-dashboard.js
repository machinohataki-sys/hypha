'use strict';

// HYPHA · W4.2 KPI Dashboard — aggregation library (BLUEPRINT §20 v1.0)
//
// Reads from existing fs side-effects of W1.x / W2.x / W3.x / W4.1 streams
// (events.jsonl + companion-fired.json + creation-pool ledgers + scenario-
// events.jsonl) and computes 5 KPI for the Closed Beta dashboard:
//
//   1. completion rate          — fraction of 7-day scenario completed
//   2. artifact rate            — qualifying artifacts / total assignment fires
//   3. product pool conversion  — lesson → transfer → spark seed → accepted
//   4. companion satisfaction   — expression net of dismissals + disable flag
//   5. payment willingness      — survey row (vault/<slug>/payment-survey.json)
//
// Boundary (do not edit):
//   - W1.x / W2.x / W3.x         = data producers (events / ledgers / sidecars)
//   - W4.1 (scenario-events)     = parallel stream; we READ scenario-events.jsonl
//                                  but never mutate it
//   - this module                = read-only aggregator + payment-survey writer
//
// No LLM. Pure fs + path. The KPI numbers are the protocol surface; the UI
// (W4.2 screen) only displays them. Pricing / payment routing is OUT of scope
// (deferred per pricing_qualification_loyalty memory).

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Vault root resolution — mirrors events.js + creation-pool.js convention.
// HYPHA_DATA (Electron userData) > HYPHA_VAULT_ROOT > HYPHA_VAULT_DIR > dev default.
// We test all three so this module works under any of the three layouts the
// rest of the codebase uses.
// ---------------------------------------------------------------------------
function _vaultRoot() {
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) {
    return process.env.HYPHA_DATA;
  }
  if (process.env.HYPHA_VAULT_ROOT && fs.existsSync(process.env.HYPHA_VAULT_ROOT)) {
    return process.env.HYPHA_VAULT_ROOT;
  }
  if (process.env.HYPHA_VAULT_DIR && fs.existsSync(process.env.HYPHA_VAULT_DIR)) {
    return process.env.HYPHA_VAULT_DIR;
  }
  return path.join(__dirname, '..', '..', 'vault');
}

function _ensureSlug(slug) {
  if (!slug || typeof slug !== 'string') {
    throw new Error('kpi-dashboard: slug required (non-empty string)');
  }
  if (slug.includes('..') || path.isAbsolute(slug)) {
    throw new Error('kpi-dashboard: slug must be a vault-relative directory name');
  }
}

function _readJSONLSafe(absPath) {
  if (!fs.existsSync(absPath)) return [];
  const rows = [];
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); }
      catch (_) { /* tolerate malformed row */ }
    }
  } catch (_) { /* tolerate missing / locked file */ }
  return rows;
}

function _readJSONSafe(absPath) {
  if (!fs.existsSync(absPath)) return null;
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    return JSON.parse(raw);
  } catch (_) { return null; }
}

function _slugEvents(slug) {
  return _readJSONLSafe(path.join(_vaultRoot(), slug, 'events.jsonl'));
}

function _scenarioEvents(slug) {
  // W4.1 stream writes here. We read tolerantly — file may not exist yet
  // for slugs created before W4.1 shipped.
  return _readJSONLSafe(path.join(_vaultRoot(), slug, 'scenario-events.jsonl'));
}

function _rootEvents() {
  // product-transfer.js writes vault-root events.jsonl rows with op:'transfer:fired'.
  // Read once per call — cheap (file stays small even at 100s of fires).
  return _readJSONLSafe(path.join(_vaultRoot(), 'events.jsonl'));
}

// ---------------------------------------------------------------------------
// 1. Completion rate — fraction of the 7-day scenario marked complete.
// ---------------------------------------------------------------------------
//
// W4.1 (parallel stream) writes scenario-events.jsonl rows shaped like:
//   { type: 'scenario_day_completed', scenario: 'seven-day-growth',
//     day: <0-6>, ts: <ISO> }
// or                                  ↳ alternate field names tolerated:
//   { type: 'scenario_progress',  day_index, ts }
//   { type: 'day_completed',      day, ts }
//
// We accept any of these to stay decoupled from W4.1's final shape. If the
// file is missing or empty, fall back to lesson-completion proxy: count
// distinct lessonIdx in slug events.jsonl assignment-level fires with
// level ≥ 3 (matches the artifact-rate threshold) and cap at 7.
//
// Returns:
//   { rate, days_completed, total: 7, evidence_chain: [{day, ts, source}, ...] }
//
// ---------------------------------------------------------------------------
function computeCompletionRate(slug, scenarioName = 'seven-day-growth') {
  _ensureSlug(slug);
  const total = 7;
  const evidence = [];
  const daysSeen = new Set();

  const scenarioRows = _scenarioEvents(slug);
  for (const row of scenarioRows) {
    if (!row || typeof row !== 'object') continue;
    const t = row.type || '';
    const matchesScenario = !row.scenario || row.scenario === scenarioName;
    if (!matchesScenario) continue;
    const isDoneType = (
      t === 'scenario_day_completed' ||
      t === 'day_completed' ||
      t === 'scenario_progress'
    );
    if (!isDoneType) continue;
    const day = Number.isFinite(row.day)
      ? row.day
      : (Number.isFinite(row.day_index) ? row.day_index : null);
    if (day == null || day < 0 || day >= total) continue;
    if (daysSeen.has(day)) continue;
    daysSeen.add(day);
    evidence.push({ day, ts: row.ts || null, source: 'scenario-events' });
  }

  // Fallback proxy: when W4.1 hasn't written yet, infer day-completion from
  // distinct lesson-completion fires (assignment:level-decided with level ≥ 3
  // = a real applied output, per anti-illusion floor). Cap at `total`.
  if (daysSeen.size === 0) {
    const slugRows = _slugEvents(slug);
    const seenLesson = new Set();
    for (const row of slugRows) {
      if (!row || row.type !== 'assignment:level-decided') continue;
      if (!Number.isFinite(row.lesson_idx) && !Number.isFinite(row.lessonIdx)) continue;
      const idx = Number.isFinite(row.lesson_idx) ? row.lesson_idx : row.lessonIdx;
      if (!Number.isFinite(row.assignment_level)) continue;
      if (row.assignment_level < 3) continue;
      if (idx < 0 || idx >= total) continue;
      if (seenLesson.has(idx)) continue;
      seenLesson.add(idx);
      evidence.push({ day: idx, ts: row.ts || null, source: 'proxy:lesson-level≥3' });
    }
    for (const d of seenLesson) daysSeen.add(d);
  }

  const days_completed = Math.min(daysSeen.size, total);
  const rate = total > 0 ? (days_completed / total) : 0;
  evidence.sort((a, b) => a.day - b.day);
  return { rate, days_completed, total, evidence_chain: evidence };
}

// ---------------------------------------------------------------------------
// 2. Artifact rate — qualifying artifacts / total artifact attempts.
// ---------------------------------------------------------------------------
//
// Per brief: micro_proof (Level 1) does NOT count; small_practice (Level 2)
// does NOT count; applied_task (Level 3) + product_spark (Level 4) +
// public_output (Level 5) count.
//
// Denominator = total assignment:level-decided rows (any level). Numerator
// = rows with level ≥ 3. This matches "40% of attempts produced a real
// artifact" — the BLUEPRINT §20 gate.
//
// Returns:
//   { rate, artifacts: [...qualifying], qualifying_count, total_attempts }
//
// ---------------------------------------------------------------------------
function computeArtifactRate(slug) {
  _ensureSlug(slug);
  const rows = _slugEvents(slug);
  const artifacts = [];
  let total_attempts = 0;
  for (const row of rows) {
    if (!row || row.type !== 'assignment:level-decided') continue;
    total_attempts += 1;
    const level = Number.isFinite(row.assignment_level) ? row.assignment_level : null;
    if (level == null || level < 3) continue;
    artifacts.push({
      type: row.level_name || _levelName(level) || `level-${level}`,
      level,
      source: `lesson:${row.lesson_idx ?? row.lessonIdx ?? '?'}`,
      ts: row.ts || null,
    });
  }
  const qualifying_count = artifacts.length;
  const rate = total_attempts > 0 ? (qualifying_count / total_attempts) : 0;
  return { rate, artifacts, qualifying_count, total_attempts };
}

function _levelName(level) {
  switch (level) {
    case 1: return 'micro_proof';
    case 2: return 'small_practice';
    case 3: return 'applied_task';
    case 4: return 'product_spark';
    case 5: return 'public_output';
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// 3. Product Pool conversion — funnel from lessons → transfer → spark.
// ---------------------------------------------------------------------------
//
// Funnel stages (each is a count we report; the rate is the END/START ratio):
//
//   lesson_count            ←  distinct lessonIdx in slug events.jsonl
//   transfer_triggered_count ← rows in root events.jsonl op='transfer:fired'
//                              & topic=slug & fired=true
//   spark_seed_count        ←  product:spark:created events
//   spark_accepted_count    ←  product:spark:transitioned → 'accepted'
//   spark_implemented_count ←  product:spark:transitioned → 'implemented'
//
// rate = spark_accepted_count / lesson_count (the "knowledge → product"
// conversion the blueprint asks for).
//
// ---------------------------------------------------------------------------
function computeProductPoolConversion(slug) {
  _ensureSlug(slug);
  const slugRows = _slugEvents(slug);
  const lessonIdxSeen = new Set();
  let spark_seed_count = 0;
  let spark_accepted_count = 0;
  let spark_implemented_count = 0;

  for (const row of slugRows) {
    if (!row) continue;
    if (row.type === 'assignment:level-decided') {
      const idx = Number.isFinite(row.lesson_idx) ? row.lesson_idx
                : (Number.isFinite(row.lessonIdx) ? row.lessonIdx : null);
      if (idx != null) lessonIdxSeen.add(idx);
    }
    if (row.type === 'product:spark:created') spark_seed_count += 1;
    if (row.type === 'product:spark:transitioned') {
      if (row.to === 'accepted') spark_accepted_count += 1;
      if (row.to === 'implemented') spark_implemented_count += 1;
    }
  }

  // transfer:fired lives in vault-root events.jsonl (per product-transfer.js
  // appendJSONL). Filter to this slug.
  const rootRows = _rootEvents();
  let transfer_triggered_count = 0;
  for (const row of rootRows) {
    if (!row) continue;
    if (row.op !== 'transfer:fired') continue;
    if (row.topic !== slug) continue;
    if (row.fired === false) continue;
    transfer_triggered_count += 1;
  }

  const lesson_count = lessonIdxSeen.size;
  const rate = lesson_count > 0
    ? (spark_accepted_count / lesson_count)
    : 0;
  return {
    rate,
    lesson_count,
    transfer_triggered_count,
    spark_seed_count,
    spark_accepted_count,
    spark_implemented_count,
  };
}

// ---------------------------------------------------------------------------
// 4. Companion satisfaction — net signal from expression / dismissal /
//    settings.companionEnabled.
// ---------------------------------------------------------------------------
//
// score (0..100, clamped):
//   base = 50
//   + 5 per expression_count (capped at +40)
//   - 7.5 per dismissed_count
//   - 50 if settings_disabled
//   clamp [0, 100]
//
// expression_count = fires in companion-fired.json (any type).
// dismissed_count  = events.jsonl rows type='companion:dismissed' (defensive;
//                    W3.5 may add later — for now usually 0).
// settings_disabled = vault/<slug>/companion-fired.json field "disabled" OR
//                    slug events.jsonl row type='companion:disabled' present.
//
// ---------------------------------------------------------------------------
function computeCompanionSatisfaction(slug) {
  _ensureSlug(slug);
  const firedFile = path.join(_vaultRoot(), slug, 'companion-fired.json');
  const firedJson = _readJSONSafe(firedFile);
  const expression_count = (firedJson && Array.isArray(firedJson.fires))
    ? firedJson.fires.length : 0;
  const settings_disabled = Boolean(firedJson && firedJson.disabled === true);

  let dismissed_count = 0;
  let disabled_event_seen = false;
  for (const row of _slugEvents(slug)) {
    if (!row) continue;
    if (row.type === 'companion:dismissed') dismissed_count += 1;
    if (row.type === 'companion:disabled') disabled_event_seen = true;
  }

  const disabled = settings_disabled || disabled_event_seen;
  const cappedExpressionBonus = Math.min(40, 5 * expression_count);
  let score = 50 + cappedExpressionBonus - 7.5 * dismissed_count - (disabled ? 50 : 0);
  if (!Number.isFinite(score)) score = 0;
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score,
    expression_count,
    dismissed_count,
    settings_disabled: disabled,
  };
}

// ---------------------------------------------------------------------------
// 5. Payment willingness — null-result shape until the survey is filled.
//    intentional-placeholder: the survey CAN be unanswered (user hasn't hit
//    day-7 yet, or skipped the prompt). Returning a null/empty record is the
//    correct steady-state, NOT a TODO — every caller must handle willing=null.
// ---------------------------------------------------------------------------
//
// Persisted at vault/<slug>/payment-survey.json:
//   { willing: 'yes'|'no'|'maybe'|'skipped'|null,
//     last_asked: ISO|null,
//     response: ISO|null,
//     free_text: string }
//
// `willing` (return-value) is a boolean OR null when not yet answered:
//   'yes'                    → true
//   'no' | 'skipped'         → false
//   'maybe' | null | missing → null   (don't force a binary on the user)
//
// ---------------------------------------------------------------------------
function surveyPaymentWillingness(slug) {
  _ensureSlug(slug);
  const surveyPath = path.join(_vaultRoot(), slug, 'payment-survey.json');
  const json = _readJSONSafe(surveyPath);
  if (!json) {
    return { willing: null, last_asked: null, response: null, free_text: '' };
  }
  let willing = null;
  if (json.willing === 'yes') willing = true;
  else if (json.willing === 'no' || json.willing === 'skipped') willing = false;
  else willing = null; // 'maybe' or unknown — explicit uncertainty
  return {
    willing,
    raw_willing: json.willing || null,
    last_asked: json.last_asked || null,
    response: json.response || null,
    free_text: typeof json.free_text === 'string' ? json.free_text : '',
  };
}

// Writer for the survey component. Idempotent overwrite — UI only fires it
// once when the 7-day path closes; subsequent calls log a fresh `response` ts.
function recordPaymentSurvey(slug, willing, freeText) {
  _ensureSlug(slug);
  const validValues = new Set(['yes', 'no', 'maybe', 'skipped']);
  if (!validValues.has(willing)) {
    throw new Error(`kpi-dashboard: willing must be one of ${Array.from(validValues).join('|')}`);
  }
  const dir = path.join(_vaultRoot(), slug);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const surveyPath = path.join(dir, 'payment-survey.json');
  const prev = _readJSONSafe(surveyPath) || {};
  const next = {
    willing,
    last_asked: prev.last_asked || new Date().toISOString(),
    response: new Date().toISOString(),
    free_text: typeof freeText === 'string' ? freeText.slice(0, 500) : '',
  };
  fs.writeFileSync(surveyPath, JSON.stringify(next, null, 2), 'utf8');
  return { ok: true, path: surveyPath, survey: next };
}

// ---------------------------------------------------------------------------
// Aggregate — single call wraps all five and returns an overall_score.
// ---------------------------------------------------------------------------
//
// overall_score (0..100) — weighted blend matching BLUEPRINT §20 priority:
//   completion         × 30
//   artifacts          × 30
//   product pool       × 20
//   companion          × 10
//   payment_signal     × 10   (null = neutral 50, true = 100, false = 0)
//
// ---------------------------------------------------------------------------
function aggregateAllKPI(slug) {
  _ensureSlug(slug);
  const completion = computeCompletionRate(slug);
  const artifacts = computeArtifactRate(slug);
  const productPool = computeProductPoolConversion(slug);
  const companion = computeCompanionSatisfaction(slug);
  const payment = surveyPaymentWillingness(slug);

  const paymentSignal = payment.willing === true ? 1
                      : payment.willing === false ? 0
                      : 0.5;

  const overall_score = Math.round(
    completion.rate * 30 +
    artifacts.rate * 30 +
    Math.min(1, productPool.rate) * 20 +
    (companion.score / 100) * 10 +
    paymentSignal * 10
  );

  return {
    slug,
    generated_at: new Date().toISOString(),
    completion,
    artifacts,
    productPool,
    companion,
    payment,
    overall_score,
  };
}

module.exports = {
  computeCompletionRate,
  computeArtifactRate,
  computeProductPoolConversion,
  computeCompanionSatisfaction,
  surveyPaymentWillingness,
  recordPaymentSurvey,
  aggregateAllKPI,
  // exposed for tests
  _internals: {
    vaultRoot: _vaultRoot,
    levelName: _levelName,
    readJSONLSafe: _readJSONLSafe,
    readJSONSafe: _readJSONSafe,
  },
};
