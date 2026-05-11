'use strict';
// V0.5 E1 D-verify — cost-ledger token-metadata coverage smoke gate.
//
// Created 2026-05-11 on v0.5-substrate branch.
//
// Purpose: prove the V0.5 E1 patch landed. V0.5 E0 logged 74 model_calls rows
// but only 1 had token data — root cause = glm/deepseek/kimi direct clients
// dropped `response.usage` from the OpenAI ChatCompletion response when
// packaging just `content` for callers. E1 added `chatWithUsage()` to each
// provider, surfaces `usage` on the router dispatch envelope, and routes it
// through `recordChatCallEstimate`.
//
// What this script does:
//   1. For each of T6_STRONG / T4_JUDGE / T3_MID, fire one minimal chat call
//      ("pong" prompt, maxTokens=50) and record the dispatch via
//      recordChatCallEstimate.
//   2. Pull each just-written row back and check:
//        - input_tokens IS NOT NULL
//        - output_tokens IS NOT NULL
//        - estimation_source = 'provider' (gold) or 'tokenizer-fallback' (acceptable)
//   3. Compute coverage on the post-patch window (rows logged today).
//   4. Print a single-line summary; exit 0 if coverage > 0.95 on the 3 new
//      calls AND every new call has both token fields non-null, else exit 1.
//
// This is a SMOKE gate — does not exercise scaling, parallelism, error paths.
// V0.5 E1 trigger evaluation runs a larger sample after this passes.

const sqlite = require('../db/sqlite');
const llm = require('../lib/llm');

const CAPABILITIES = ['T6_STRONG', 'T4_JUDGE', 'T3_MID'];
const TASK_TAG = '_dev_verify_cost_ledger';

async function fireOne(capability) {
  const t0 = Date.now();
  const messages = [
    { role: 'user', content: 'Reply with the single word: pong' },
  ];
  let dispatch;
  let success = true;
  let errMsg = null;
  try {
    dispatch = await llm.executeChat(capability, {
      messages,
      maxTokens: 50,
      temperature: 0,
      timeoutMs: 30_000,
    });
  } catch (err) {
    success = false;
    errMsg = err && err.message;
    dispatch = { result: null, providerId: 'unknown', model: 'unknown', capability };
  }
  const latency_ms = Date.now() - t0;
  let rowId = null;
  try {
    rowId = sqlite.recordChatCallEstimate(dispatch, TASK_TAG, {
      latency_ms,
      success,
      tuple_id: 'verify-' + capability,
    });
  } catch (err) {
    console.warn('[verify] recordChatCallEstimate threw:', err && err.message);
  }
  return { capability, rowId, dispatch, success, errMsg, latency_ms };
}

async function main() {
  const db = sqlite.open();
  const startedAt = new Date().toISOString();
  console.log('[verify] V0.5 E1 cost-ledger coverage check — started', startedAt);
  console.log('[verify] providers registered:', llm.listProviders());

  const fires = [];
  for (const cap of CAPABILITIES) {
    const r = await fireOne(cap);
    fires.push(r);
    console.log(`[verify] ${cap} -> provider=${r.dispatch.providerId} model=${r.dispatch.model} success=${r.success} latency_ms=${r.latency_ms} row_id=${r.rowId}${r.errMsg ? ' err=' + r.errMsg : ''}`);
  }

  // Per-call row inspection
  const newRows = db.prepare(
    `SELECT id, ts, provider_id, model_name, input_tokens, output_tokens, estimation_source, success, task_type
       FROM model_calls
      WHERE ts >= @startedAt AND task_type = @task_type
      ORDER BY id ASC`
  ).all({ startedAt, task_type: TASK_TAG });

  console.log('\n[verify] per-row diagnostic:');
  for (const r of newRows) {
    const tokensOk = r.input_tokens != null && r.output_tokens != null;
    console.log('  row#%d provider=%s model=%s in=%s out=%s source=%s tokens_populated=%s',
      r.id, r.provider_id, r.model_name, String(r.input_tokens), String(r.output_tokens),
      r.estimation_source, tokensOk);
  }

  // Coverage on TODAY's calls (UTC midnight onwards) — the E1 patch landed today,
  // so this approximates "post-patch window".
  const sinceMidnight = new Date(); sinceMidnight.setUTCHours(0, 0, 0, 0);
  const todayISO = sinceMidnight.toISOString();
  const total = db.prepare('SELECT COUNT(*) AS c FROM model_calls WHERE ts >= ?').get(todayISO).c;
  const filled = db.prepare(
    'SELECT COUNT(*) AS c FROM model_calls WHERE ts >= ? AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL'
  ).get(todayISO).c;
  const coverage = total > 0 ? filled / total : 0;

  console.log('\n[verify] post-midnight UTC coverage (today, includes any pre-patch rows from today):');
  console.log('  total=%d filled=%d coverage=%s', total, filled, coverage.toFixed(4));

  // Coverage strictly on the new calls this script fired
  const newTotal = newRows.length;
  const newFilled = newRows.filter(r => r.input_tokens != null && r.output_tokens != null).length;
  const newCoverage = newTotal > 0 ? newFilled / newTotal : 0;

  console.log('\n[verify] strictly-this-script coverage (the 3 calls fired by this run):');
  console.log('  new_total=%d new_filled=%d new_coverage=%s', newTotal, newFilled, newCoverage.toFixed(4));

  // Source distribution on new rows
  const sources = {};
  for (const r of newRows) {
    sources[r.estimation_source || '(null)'] = (sources[r.estimation_source || '(null)'] || 0) + 1;
  }
  console.log('  estimation_source breakdown:', sources);

  // Gate
  const pass = newTotal === CAPABILITIES.length
    && newFilled === newTotal
    && newCoverage > 0.95;

  console.log('\n[verify] gate: %s', pass ? 'PASS' : 'FAIL');
  if (!pass) {
    console.log('[verify] gate reason:');
    if (newTotal !== CAPABILITIES.length) console.log('  - expected', CAPABILITIES.length, 'rows, got', newTotal);
    if (newFilled !== newTotal) console.log('  - some new rows have null tokens:', newRows.filter(r => r.input_tokens == null || r.output_tokens == null));
    if (newCoverage <= 0.95) console.log('  - new_coverage', newCoverage, 'below 0.95 threshold');
  }

  sqlite.close();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('[verify] fatal:', err);
  process.exit(2);
});
