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
       input_tokens, output_tokens, estimated_cost, latency_ms, success, cache_hit, capability)
    VALUES
      (@ts, @user_id, @tuple_id, @task_type, @provider_id, @model_name, @prompt_version,
       @input_tokens, @output_tokens, @estimated_cost, @latency_ms, @success, @cache_hit, @capability)
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
  upsertGoldenItem,
  recordEvaluatorRun,
  recordLessonOutcome,
  aggregateCostMedian,
};
