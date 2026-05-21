-- V0.5 E0 — initial schema migration
-- Created 2026-05-10 on v0.5-substrate branch
--
-- Purpose: queryable indices over JSONL append-only event log.
-- JSONL stays canonical (per memory feedback_chouguang_audit_v081 / Notion 5-rebuild lesson).
-- SQLite holds derived state for fast aggregation.

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('version', '1');
INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('applied_at', strftime('%Y-%m-%d %H:%M:%S', 'now'));

-- per-tuple model invocation cost ledger (per v0.4 §4.6)
CREATE TABLE IF NOT EXISTS model_calls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL,
  user_id         TEXT,
  tuple_id        TEXT,
  task_type       TEXT NOT NULL,
  provider_id     TEXT NOT NULL,
  model_name      TEXT NOT NULL,
  prompt_version  TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  estimated_cost  REAL,
  latency_ms      INTEGER,
  success         INTEGER NOT NULL DEFAULT 1,
  cache_hit       INTEGER NOT NULL DEFAULT 0,
  capability      TEXT
);

CREATE INDEX IF NOT EXISTS idx_model_calls_ts ON model_calls(ts);
CREATE INDEX IF NOT EXISTS idx_model_calls_tuple ON model_calls(tuple_id);
CREATE INDEX IF NOT EXISTS idx_model_calls_provider ON model_calls(provider_id);

-- HITL-labeled golden items, mirrored from vault/.evaluator/golden/<topic>/*.json
CREATE TABLE IF NOT EXISTS golden_items (
  id                   TEXT PRIMARY KEY,
  topic                TEXT NOT NULL,
  lifecycle            TEXT NOT NULL DEFAULT 'draft',
  verification_channel TEXT NOT NULL,
  answer_key_hash      TEXT,
  rater_a_verdict      TEXT,
  rater_b_verdict      TEXT,
  agreement            INTEGER,
  ratified_at          TEXT,
  notes                TEXT,
  source_path          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_golden_topic ON golden_items(topic);
CREATE INDEX IF NOT EXISTS idx_golden_lifecycle ON golden_items(lifecycle);

-- weekly evaluator runs (F1 + Cohen's κ snapshots)
CREATE TABLE IF NOT EXISTS evaluator_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date    TEXT NOT NULL,
  topic       TEXT NOT NULL,
  split       TEXT NOT NULL,
  n_items     INTEGER NOT NULL,
  irr_kappa   REAL,
  f1_score    REAL,
  precision_  REAL,
  recall      REAL,
  notes       TEXT,
  artifact_path TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_date ON evaluator_runs(run_date);
CREATE INDEX IF NOT EXISTS idx_runs_topic ON evaluator_runs(topic);

-- per-tuple lesson outcomes (Yogo flywheel substrate)
CREATE TABLE IF NOT EXISTS lesson_outcomes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                TEXT NOT NULL,
  tuple_id          TEXT NOT NULL UNIQUE,
  goal_topic        TEXT NOT NULL,
  user_id           TEXT,
  verification_channel TEXT NOT NULL,
  verdict           TEXT NOT NULL,
  transfer_held     INTEGER,
  exec_result_pass  INTEGER,
  cost_estimate     REAL,
  duration_ms       INTEGER,
  notes             TEXT
);

CREATE INDEX IF NOT EXISTS idx_outcomes_ts ON lesson_outcomes(ts);
CREATE INDEX IF NOT EXISTS idx_outcomes_topic ON lesson_outcomes(goal_topic);
CREATE INDEX IF NOT EXISTS idx_outcomes_verdict ON lesson_outcomes(verdict);
