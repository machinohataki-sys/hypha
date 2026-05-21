-- V0.5 E1 — extend model_calls with estimation_source column
-- Created 2026-05-11 on v0.5-substrate branch
--
-- Why: V0.5 E0 logged 74 model_calls rows but only 1 had token data — all
-- three OpenAI-compat provider clients (glm-direct / deepseek-direct /
-- kimi-direct) dropped `response.usage` on the floor when packaging the
-- assistant content for callers. E1 fixes the providers AND adds this
-- column so the cost ledger can distinguish:
--
--   'provider'           — usage block came from the upstream API response
--   'tokenizer-fallback' — provider usage was missing, sqlite.js estimated
--                          from request/response char count (~4 chars/token)
--   'placeholder'        — neither usage nor source text was available
--                          (this is the lowest-trust tier label, not unfinished
--                          code; null-row rows still write so coverage queries
--                          can count them)
--                          intentional-placeholder: label name for a real
--                          ledger state (no source text available) — not a
--                          stub/TODO/unfinished implementation marker.
--
-- Pre-E1 rows default to 'provider' (assumed valid; pre-bug-recognition data).
-- The 73 broken rows from E0 have NULL tokens; they remain NULL — we do not
-- back-fill estimates because the original messages weren't preserved.

ALTER TABLE model_calls ADD COLUMN estimation_source TEXT DEFAULT 'provider';

CREATE INDEX IF NOT EXISTS idx_model_calls_estimation_source ON model_calls(estimation_source);

-- Back-fix rows that pre-date the E1 fix: they were logged with
-- estimation_source defaulting to 'provider', but their tokens are null,
-- which is internally inconsistent. The truth is they were the symptom of
-- the bug E1 fixed — usage block was dropped by the provider client. Tag
-- them 'legacy-broken' so coverage analytics aren't misled.
UPDATE model_calls
   SET estimation_source = 'legacy-broken'
 WHERE input_tokens IS NULL
   AND output_tokens IS NULL;

UPDATE schema_meta SET value = '2' WHERE key = 'version';
INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('migration_002_at', strftime('%Y-%m-%d %H:%M:%S', 'now'));
