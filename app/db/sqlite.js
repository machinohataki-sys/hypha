// V0.5 E0 — SQLite wrapper for queryable indices
// JSONL stays canonical; SQLite holds derived state.
//
// Created 2026-05-10 on v0.5-substrate branch.

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'vault', '.evaluator', 'index.db');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

let _db = null;

function _ensureParentDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function _appliedMigrations(db) {
  try {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get();
    return row ? Number(row.value) : 0;
  } catch (_e) {
    return 0;
  }
}

function _runMigrations(db) {
  if (!fs.existsSync(MIGRATIONS_DIR)) return;
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  const current = _appliedMigrations(db);
  for (const f of files) {
    const num = Number(f.split('_')[0]);
    if (Number.isNaN(num) || num <= current) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    db.exec(sql);
    console.log(`[sqlite] applied migration ${f}`);
  }
}

function open(dbPath) {
  if (_db) return _db;
  const target = dbPath || process.env.HYPHA_DB_PATH || DEFAULT_DB_PATH;
  _ensureParentDir(target);
  _db = new Database(target);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _runMigrations(_db);
  return _db;
}

function close() {
  if (_db) { _db.close(); _db = null; }
}

function recordModelCall(row) {
  const db = open();
  const stmt = db.prepare(`
    INSERT INTO model_calls
      (ts, user_id, tuple_id, task_type, provider_id, model_name, prompt_version,
       input_tokens, output_tokens, estimated_cost, latency_ms, success, cache_hit, capability,
       estimation_source)
    VALUES
      (@ts, @user_id, @tuple_id, @task_type, @provider_id, @model_name, @prompt_version,
       @input_tokens, @output_tokens, @estimated_cost, @latency_ms, @success, @cache_hit, @capability,
       @estimation_source)
  `);
  return stmt.run({
    ts: row.ts || new Date().toISOString(),
    user_id: row.user_id || null,
    tuple_id: row.tuple_id || null,
    task_type: row.task_type,
    provider_id: row.provider_id,
    model_name: row.model_name,
    prompt_version: row.prompt_version || null,
    input_tokens: row.input_tokens || null,
    output_tokens: row.output_tokens || null,
    estimated_cost: row.estimated_cost || null,
    latency_ms: row.latency_ms || null,
    success: row.success === false ? 0 : 1,
    cache_hit: row.cache_hit ? 1 : 0,
    capability: row.capability || null,
    estimation_source: row.estimation_source || 'provider',
  }).lastInsertRowid;
}

function upsertGoldenItem(row) {
  const db = open();
  const stmt = db.prepare(`
    INSERT INTO golden_items
      (id, topic, lifecycle, verification_channel, answer_key_hash,
       rater_a_verdict, rater_b_verdict, agreement, ratified_at, notes, source_path)
    VALUES
      (@id, @topic, @lifecycle, @verification_channel, @answer_key_hash,
       @rater_a_verdict, @rater_b_verdict, @agreement, @ratified_at, @notes, @source_path)
    ON CONFLICT(id) DO UPDATE SET
      topic=excluded.topic,
      lifecycle=excluded.lifecycle,
      verification_channel=excluded.verification_channel,
      answer_key_hash=excluded.answer_key_hash,
      rater_a_verdict=excluded.rater_a_verdict,
      rater_b_verdict=excluded.rater_b_verdict,
      agreement=excluded.agreement,
      ratified_at=excluded.ratified_at,
      notes=excluded.notes,
      source_path=excluded.source_path
  `);
  return stmt.run({
    id: row.id,
    topic: row.topic,
    lifecycle: row.lifecycle || 'draft',
    verification_channel: row.verification_channel,
    answer_key_hash: row.answer_key_hash || null,
    rater_a_verdict: row.rater_a_verdict || null,
    rater_b_verdict: row.rater_b_verdict || null,
    agreement: row.agreement === true ? 1 : (row.agreement === false ? 0 : null),
    ratified_at: row.ratified_at || null,
    notes: row.notes || null,
    source_path: row.source_path,
  });
}

function recordEvaluatorRun(row) {
  const db = open();
  const stmt = db.prepare(`
    INSERT INTO evaluator_runs
      (run_date, topic, split, n_items, irr_kappa, f1_score, precision_, recall, notes, artifact_path)
    VALUES
      (@run_date, @topic, @split, @n_items, @irr_kappa, @f1_score, @precision_, @recall, @notes, @artifact_path)
  `);
  return stmt.run({
    run_date: row.run_date || new Date().toISOString().slice(0, 10),
    topic: row.topic,
    split: row.split,
    n_items: row.n_items,
    irr_kappa: row.irr_kappa,
    f1_score: row.f1_score,
    precision_: row.precision || row.precision_ || null,
    recall: row.recall || null,
    notes: row.notes || null,
    artifact_path: row.artifact_path || null,
  }).lastInsertRowid;
}

function recordLessonOutcome(row) {
  const db = open();
  const stmt = db.prepare(`
    INSERT INTO lesson_outcomes
      (ts, tuple_id, goal_topic, user_id, verification_channel, verdict,
       transfer_held, exec_result_pass, cost_estimate, duration_ms, notes)
    VALUES
      (@ts, @tuple_id, @goal_topic, @user_id, @verification_channel, @verdict,
       @transfer_held, @exec_result_pass, @cost_estimate, @duration_ms, @notes)
    ON CONFLICT(tuple_id) DO UPDATE SET
      verdict=excluded.verdict,
      transfer_held=excluded.transfer_held,
      exec_result_pass=excluded.exec_result_pass,
      cost_estimate=excluded.cost_estimate,
      notes=excluded.notes
  `);
  return stmt.run({
    ts: row.ts || new Date().toISOString(),
    tuple_id: row.tuple_id,
    goal_topic: row.goal_topic,
    user_id: row.user_id || null,
    verification_channel: row.verification_channel,
    verdict: row.verdict,
    transfer_held: row.transfer_held === true ? 1 : (row.transfer_held === false ? 0 : null),
    exec_result_pass: row.exec_result_pass === true ? 1 : (row.exec_result_pass === false ? 0 : null),
    cost_estimate: row.cost_estimate || null,
    duration_ms: row.duration_ms || null,
    notes: row.notes || null,
  }).lastInsertRowid;
}

// V0.5 E0 D6 — chat-call cost-estimate helper.
// Wraps `recordModelCall` for callers that have an `executeChat` dispatch
// result. Pulls token counts from `result.usage` (OpenAI shape: {prompt_tokens,
// completion_tokens}; some providers use {input_tokens, output_tokens}) and
// estimates RMB cost via per-provider PLACEHOLDER rates. Rates are
// **NOT calibrated** — order-of-magnitude only — and must be revisited once
// the real pricing engine ships (per BLUEPRINT §17.2.1 Cheap Router).
//
// Returns the inserted row id, or null on failure (logged, never throws).
//
// intentional-placeholder: Cheap Router (BLUEPRINT §17.2.1 Infrastructure system)
// owns calibrated per-provider rate cards + capability-class blended rates. Until
// that pricing engine ships in v0.6+, recordChatCallEstimate exists to keep the
// model_calls table populated (so cost-median aggregations work today) without
// pretending the numbers are vendor-confirmed. All four providers share the same
// stub triple ¥0.001 in / ¥0.003 out — order-of-magnitude only. Do not derive
// pricing UI / billing from these values; only relative comparison + plumbing.
const _COST_RATES_PLACEHOLDER = Object.freeze({
  glm:      { in_per_1k: 0.001, out_per_1k: 0.003 },
  deepseek: { in_per_1k: 0.001, out_per_1k: 0.003 },
  kimi:     { in_per_1k: 0.001, out_per_1k: 0.003 },
  moonshot: { in_per_1k: 0.001, out_per_1k: 0.003 },
  _default: { in_per_1k: 0.001, out_per_1k: 0.003 },
});

function _extractTokens(usage) {
  if (!usage || typeof usage !== 'object') return { in_: null, out_: null };
  const in_  = Number.isFinite(usage.input_tokens)  ? usage.input_tokens
             : Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens
             : null;
  const out_ = Number.isFinite(usage.output_tokens)     ? usage.output_tokens
             : Number.isFinite(usage.completion_tokens) ? usage.completion_tokens
             : null;
  return { in_, out_ };
}

// Rough char-to-token ratio for mixed-language text. OpenAI tiktoken
// cl100k_base maps EN ~4 chars/token, ZH ~1.5 chars/token. We bias toward
// the cheaper end (4) so the fallback under-counts rather than over-counts;
// labelled rows can be re-estimated when Cheap Router (v0.6+) lands real
// pricing. Order-of-magnitude only.
function _estimateTokensFromText(textOrMessages) {
  let chars = 0;
  if (typeof textOrMessages === 'string') {
    chars = textOrMessages.length;
  } else if (Array.isArray(textOrMessages)) {
    for (const m of textOrMessages) {
      if (m && typeof m.content === 'string') chars += m.content.length;
      else if (m && m.content != null) chars += String(m.content).length;
    }
  } else if (textOrMessages && typeof textOrMessages === 'object') {
    try { chars = JSON.stringify(textOrMessages).length; }
    catch (_) { chars = 0; }
  }
  return chars > 0 ? Math.ceil(chars / 4) : null;
}

// Stringify the dispatch result for output-token fallback estimation.
// `result` can be a plain string (chat mode) or a parsed JSON object (json mode).
function _stringifyResultForEstimate(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  try { return JSON.stringify(result); } catch (_) { return ''; }
}

function _estimateCost(providerId, inputTokens, outputTokens) {
  const key = String(providerId || '').toLowerCase();
  const rate = _COST_RATES_PLACEHOLDER[key] || _COST_RATES_PLACEHOLDER._default;
  const inCost  = Number.isFinite(inputTokens)  ? (inputTokens  / 1000) * rate.in_per_1k  : 0;
  const outCost = Number.isFinite(outputTokens) ? (outputTokens / 1000) * rate.out_per_1k : 0;
  return Number((inCost + outCost).toFixed(6));
}

// `dispatch` = executeChat return shape: {result, usage, _requestMessages, providerId, model, capability, attempts}
// `taskType` = string label (e.g. 'designSkeletonOnly', 'designLesson', 'classifyAll')
// `taskMeta` = optional {tuple_id, user_id, prompt_version, latency_ms, cache_hit, success,
//                        messages, response_text} — last two optional overrides for the
//                        tokenizer-fallback path when caller knows the source text.
//
// Resolution order for token counts:
//   1. dispatch.usage (set by router from provider.chatWithUsage, V0.5 E1 fix)
//   2. dispatch.result.usage / dispatch.result.message.usage (legacy fields, defensive)
//   3. _estimateTokensFromText fallback over (taskMeta.messages || dispatch._requestMessages)
//      and (taskMeta.response_text || dispatch.result) — marks estimation_source='tokenizer-fallback'
//   4. estimation_source='placeholder' if even text was unavailable (row written with null tokens)
function recordChatCallEstimate(dispatch, taskType, taskMeta) {
  if (!dispatch || typeof dispatch !== 'object') return null;
  const meta = taskMeta || {};
  const result = dispatch.result;

  // Priority 1: router-attached usage (V0.5 E1 path)
  // Priority 2: legacy result.usage (in case some caller built a dispatch manually)
  let usage = dispatch.usage || null;
  if (!usage && result && typeof result === 'object') {
    usage = result.usage || (result.message && result.message.usage) || null;
  }

  let { in_, out_ } = _extractTokens(usage);
  let estimationSource = (in_ !== null && out_ !== null) ? 'provider' : null;

  if (estimationSource === null) {
    // Priority 3: tokenizer fallback. Need the request messages + response text.
    const messages = meta.messages
      || dispatch._requestMessages
      || null;
    const responseText = (typeof meta.response_text === 'string' && meta.response_text)
      || _stringifyResultForEstimate(result);

    const inEst  = messages ? _estimateTokensFromText(messages) : null;
    const outEst = responseText ? _estimateTokensFromText(responseText) : null;

    if (inEst !== null || outEst !== null) {
      in_ = inEst;
      out_ = outEst;
      estimationSource = 'tokenizer-fallback';
      console.warn('[recordChatCallEstimate] provider usage missing — using tokenizer fallback. provider=%s model=%s task=%s in_est=%s out_est=%s',
        dispatch.providerId || 'unknown',
        dispatch.model || 'unknown',
        taskType || 'unknown',
        String(inEst),
        String(outEst));
    } else {
      estimationSource = 'placeholder';
      console.warn('[recordChatCallEstimate] no usage AND no source text — writing placeholder row. provider=%s model=%s task=%s',
        dispatch.providerId || 'unknown',
        dispatch.model || 'unknown',
        taskType || 'unknown');
    }
  }

  const providerId = dispatch.providerId || meta.provider_id || 'unknown';
  const row = {
    ts: meta.ts || new Date().toISOString(),
    user_id: meta.user_id || null,
    tuple_id: meta.tuple_id || null,
    task_type: taskType || 'unknown',
    provider_id: providerId,
    model_name: dispatch.model || meta.model_name || 'unknown',
    prompt_version: meta.prompt_version || null,
    input_tokens: in_,
    output_tokens: out_,
    estimated_cost: _estimateCost(providerId, in_, out_),
    latency_ms: Number.isFinite(meta.latency_ms) ? meta.latency_ms : null,
    success: meta.success === false ? false : true,
    cache_hit: !!meta.cache_hit,
    capability: dispatch.capability || meta.capability || null,
    estimation_source: estimationSource,
  };
  return recordModelCall(row);
}

function aggregateCostMedian(filter) {
  const db = open();
  const where = [];
  const params = {};
  if (filter && filter.since) { where.push('ts >= @since'); params.since = filter.since; }
  if (filter && filter.tuple_id) { where.push('tuple_id = @tuple_id'); params.tuple_id = filter.tuple_id; }
  const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT estimated_cost FROM model_calls ${whereSQL} ORDER BY estimated_cost`).all(params);
  if (rows.length === 0) return null;
  const mid = Math.floor(rows.length / 2);
  return rows.length % 2 === 0
    ? (rows[mid - 1].estimated_cost + rows[mid].estimated_cost) / 2
    : rows[mid].estimated_cost;
}

module.exports = {
  open,
  close,
  recordModelCall,
  recordChatCallEstimate,
  upsertGoldenItem,
  recordEvaluatorRun,
  recordLessonOutcome,
  aggregateCostMedian,
};
