'use strict';
// HYPHA · Companion AMD-MEOW-P8 B2.M1 — Persona Coherence persistence smoke (2026-05-21).
//
// 16 cases (V1-V16). Closes B1.M1 gaps #2 #3 #4.
// Exit 0 on all-pass, 1 on any fail.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate vault to a temp dir BEFORE requiring any companion module so the
// coherence-log resolves vaultRoot() against the test root, not the real one.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hypha-v2-'));
process.env.HYPHA_VAULT_ROOT = TMP_ROOT;

const COMPANION_DIR = path.join(__dirname, '..', 'lib', 'companion');
const coherenceLog  = require(path.join(COMPANION_DIR, 'coherence-log'));
const boundaryGuard = require(path.join(COMPANION_DIR, 'boundary-guard'));
const companionIndex = require(path.join(COMPANION_DIR, 'index'));
const triggers = require(path.join(__dirname, '..', 'lib', 'companion-triggers'));

const LOG_REL = path.join('.hypha', 'companion-coherence.jsonl');
const LOG_ABS = path.join(TMP_ROOT, LOG_REL);

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const tag = pass ? 'PASS' : 'FAIL';
  // eslint-disable-next-line no-console
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function resetLog() {
  try { fs.unlinkSync(LOG_ABS); } catch (_) { /* ok */ } // intentional: missing log file is the expected state at start
}

(async () => {
  // ── V1: coherence-log exports surface ─────────────────────────────────
  try {
    for (const k of ['logCoherenceScore', 'readCoherenceLog', 'getTrend']) {
      assert(typeof coherenceLog[k] === 'function', `missing ${k}`);
    }
    assert(typeof companionIndex.logCoherenceScore === 'function', 'index missing logCoherenceScore');
    assert(typeof companionIndex.readCoherenceLog === 'function', 'index missing readCoherenceLog');
    assert(typeof companionIndex.getCoherenceTrend === 'function', 'index missing getCoherenceTrend');
    record('V1: coherence-log + index exports', true);
  } catch (e) {
    record('V1: coherence-log + index exports', false, e.message);
  }

  // ── V2: backward compat — read from missing file returns [] ───────────
  try {
    resetLog();
    const rows = coherenceLog.readCoherenceLog({});
    assert(Array.isArray(rows) && rows.length === 0, `got ${JSON.stringify(rows)}`);
    record('V2: read from missing log → []', true);
  } catch (e) {
    record('V2: read from missing log → []', false, e.message);
  }

  // ── V3: logCoherenceScore appends one row + creates file ──────────────
  try {
    resetLog();
    const r = coherenceLog.logCoherenceScore({
      lesson_id: 'L0',
      session_id: 'demo:L0',
      scope: 'session',
      score: { S: 0.82, R: 0.78, combined: 0.80 },
    });
    assert(r.ok === true, `ok=${r.ok} error=${r.error}`);
    assert(fs.existsSync(LOG_ABS), 'log file not created');
    const raw = fs.readFileSync(LOG_ABS, 'utf8');
    assert(raw.split('\n').filter(Boolean).length === 1, `expected 1 row got ${raw}`);
    const parsed = JSON.parse(raw.split('\n').filter(Boolean)[0]);
    assert(parsed.op === 'companion:coherence-scored', `op=${parsed.op}`);
    assert(parsed.session_id === 'demo:L0', `session_id=${parsed.session_id}`);
    assert(parsed.scope === 'session', `scope=${parsed.scope}`);
    assert(typeof parsed.ts === 'string' && parsed.ts.length > 0, `ts=${parsed.ts}`);
    record('V3: logCoherenceScore appends one canonical row', true);
  } catch (e) {
    record('V3: logCoherenceScore appends one canonical row', false, e.message);
  }

  // ── V4: rejects invalid scope ─────────────────────────────────────────
  try {
    const r = coherenceLog.logCoherenceScore({
      session_id: 's', scope: 'bogus',
      score: { S: 0.5, R: 0.5, combined: 0.5 },
    });
    assert(r.ok === false, `ok=${r.ok}`);
    assert(/scope/.test(r.error), `error=${r.error}`);
    record('V4: invalid scope rejected', true);
  } catch (e) {
    record('V4: invalid scope rejected', false, e.message);
  }

  // ── V5: rejects missing session_id ────────────────────────────────────
  try {
    const r = coherenceLog.logCoherenceScore({
      scope: 'turn', score: { S: 0.5, R: 0.5, combined: 0.5 },
    });
    assert(r.ok === false, `ok=${r.ok}`);
    assert(/session_id/.test(r.error), `error=${r.error}`);
    record('V5: missing session_id rejected', true);
  } catch (e) {
    record('V5: missing session_id rejected', false, e.message);
  }

  // ── V6: rejects non-numeric score ─────────────────────────────────────
  try {
    const r = coherenceLog.logCoherenceScore({
      session_id: 's', scope: 'turn',
      score: { S: 'foo', R: 0.5, combined: 0.5 },
    });
    assert(r.ok === false, `ok=${r.ok} error=${r.error}`);
    record('V6: non-numeric score rejected', true);
  } catch (e) {
    record('V6: non-numeric score rejected', false, e.message);
  }

  // ── V7: read + filter by session_id ───────────────────────────────────
  try {
    resetLog();
    coherenceLog.logCoherenceScore({ session_id: 'a', scope: 'turn',    score: { S: 0.7, R: 0.7, combined: 0.7 } });
    coherenceLog.logCoherenceScore({ session_id: 'b', scope: 'window', score: { S: 0.8, R: 0.8, combined: 0.8 } });
    coherenceLog.logCoherenceScore({ session_id: 'a', scope: 'session', score: { S: 0.9, R: 0.9, combined: 0.9 } });
    const all = coherenceLog.readCoherenceLog({});
    assert(all.length === 3, `all=${all.length}`);
    const onlyA = coherenceLog.readCoherenceLog({ sessionId: 'a' });
    assert(onlyA.length === 2, `onlyA=${onlyA.length}`);
    const lastOne = coherenceLog.readCoherenceLog({ lastN: 1 });
    assert(lastOne.length === 1 && lastOne[0].session_id === 'a', `lastOne=${JSON.stringify(lastOne)}`);
    record('V7: read + filter by sessionId + lastN', true);
  } catch (e) {
    record('V7: read + filter by sessionId + lastN', false, e.message);
  }

  // ── V8: getTrend — improving ──────────────────────────────────────────
  try {
    resetLog();
    const baseTs = Date.now() - 6 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 6; i++) {
      coherenceLog.logCoherenceScore({
        session_id: 'trend',
        scope: 'session',
        score: { S: 0.5 + i * 0.05, R: 0.5 + i * 0.05, combined: 0.5 + i * 0.08 },
        ts: new Date(baseTs + i * 60_000).toISOString(),
      });
    }
    const t = coherenceLog.getTrend({ sessionId: 'trend' });
    assert(t.samples_count === 6, `samples=${t.samples_count}`);
    assert(t.trend === 'improving', `trend=${t.trend} delta=${t.delta}`);
    assert(t.delta > 0, `delta=${t.delta}`);
    record('V8: getTrend detects improving curve', true);
  } catch (e) {
    record('V8: getTrend detects improving curve', false, e.message);
  }

  // ── V9: getTrend — declining ──────────────────────────────────────────
  try {
    resetLog();
    for (let i = 0; i < 6; i++) {
      coherenceLog.logCoherenceScore({
        session_id: 'dec', scope: 'session',
        score: { S: 0.9 - i * 0.05, R: 0.9 - i * 0.05, combined: 0.9 - i * 0.08 },
      });
    }
    const t = coherenceLog.getTrend({ sessionId: 'dec' });
    assert(t.trend === 'declining', `trend=${t.trend} delta=${t.delta}`);
    assert(t.delta < 0, `delta=${t.delta}`);
    record('V9: getTrend detects declining curve', true);
  } catch (e) {
    record('V9: getTrend detects declining curve', false, e.message);
  }

  // ── V10: getTrend — stable (insufficient samples) ─────────────────────
  try {
    resetLog();
    coherenceLog.logCoherenceScore({
      session_id: 'lone', scope: 'session',
      score: { S: 0.7, R: 0.7, combined: 0.7 },
    });
    const t = coherenceLog.getTrend({ sessionId: 'lone' });
    assert(t.trend === 'stable', `trend=${t.trend}`);
    assert(t.samples_count === 1, `samples=${t.samples_count}`);
    record('V10: getTrend returns stable + samples_count=1 for sparse data', true);
  } catch (e) {
    record('V10: getTrend returns stable + samples_count=1 for sparse data', false, e.message);
  }

  // ── V11: boundary-guard reject envelope carries repair_response ───────
  try {
    const v = boundaryGuard.enforceBoundary('孢子已经落进土里. 现在让它安静地长一会.', {
      state: { turns_used: 0, last_expression_at: Date.now() - 1000 },
      nowMs: Date.now(),
    });
    assert(v.allowed === false && v.reason === 'cooldown',
      `allowed=${v.allowed} reason=${v.reason}`);
    assert(typeof v.repair_response === 'string' && v.repair_response.length > 0,
      `repair_response=${v.repair_response}`);
    record('V11: boundary reject envelope carries repair_response (cooldown)', true);
  } catch (e) {
    record('V11: boundary reject envelope carries repair_response (cooldown)', false, e.message);
  }

  // ── V12: boundary-guard reject — forbidden gets repair too ────────────
  try {
    const v = boundaryGuard.enforceBoundary('主人, 加油.', {});
    assert(v.allowed === false && /^forbidden:/.test(v.reason || ''),
      `allowed=${v.allowed} reason=${v.reason}`);
    assert(typeof v.repair_response === 'string' && v.repair_response.length > 0,
      `repair_response=${v.repair_response}`);
    record('V12: boundary forbidden reject carries repair_response', true);
  } catch (e) {
    record('V12: boundary forbidden reject carries repair_response', false, e.message);
  }

  // ── V13: boundary-guard clean allow has NO repair_response (backward compat) ──
  try {
    const v = boundaryGuard.enforceBoundary('孢子已经落进土里.', {});
    assert(v.allowed === true, `allowed=${v.allowed}`);
    assert(v.repair_response === undefined,
      `clean allow leaked repair_response=${v.repair_response}`);
    assert(v.severity === undefined,
      `clean allow leaked severity=${v.severity}`);
    record('V13: clean allow keeps backward-compat envelope (no repair, no severity)', true);
  } catch (e) {
    record('V13: clean allow keeps backward-compat envelope (no repair, no severity)', false, e.message);
  }

  // ── V14: tryLessonComplete auto-logs coherence row ────────────────────
  try {
    resetLog();
    const slug = 'auto-invoke-test';
    fs.mkdirSync(path.join(TMP_ROOT, slug), { recursive: true });
    const transcript = [
      { text: '孢子已经落进土里. 现在让它安静地长一会.', allowed: true },
      { text: '菌丝没有死, 只是安静了三天.', allowed: true },
      { text: '腐殖层还在. 不必从头.', allowed: true },
    ];
    const r = await triggers.tryLessonComplete({
      slug,
      lessonIdx: 0,
      harnessResult: { overall_pass: true },
      transcript,
    });
    assert(r && r.fired === true, `fired=${r && r.fired} err=${r && r.error}`);
    const rows = coherenceLog.readCoherenceLog({});
    assert(rows.length === 1, `expected 1 logged row, got ${rows.length}`);
    assert(rows[0].session_id === `${slug}:L0`, `session_id=${rows[0].session_id}`);
    assert(rows[0].scope === 'session', `scope=${rows[0].scope}`);
    assert(rows[0].score && Number.isFinite(rows[0].score.combined),
      `score=${JSON.stringify(rows[0].score)}`);
    record('V14: tryLessonComplete auto-invokes coherence + persists row', true);
  } catch (e) {
    record('V14: tryLessonComplete auto-invokes coherence + persists row', false, e.message);
  }

  // ── V15: low combined → boundary_warning event emitted ────────────────
  try {
    resetLog();
    const slug = 'low-coherence-slug';
    const slugDir = path.join(TMP_ROOT, slug);
    fs.mkdirSync(slugDir, { recursive: true });
    const eventsPath = path.join(slugDir, 'events.jsonl');
    // Pre-create events.jsonl so _appendEvent will write (it gates on dir presence)
    try { fs.writeFileSync(eventsPath, ''); } catch (_) { /* ok */ }
    // Build a transcript with heavy drift to drag stability low.
    const drift = [
      { text: '我觉得你应该多努力学习, 你做得很差.', allowed: true },
      { text: '我会陪你一直学下去, 我保证. 我是菌类星人, 我的任务是教你.', allowed: true },
      { text: '让我帮你解释这是因为梯度下降的原理.', allowed: true },
    ];
    const probes = [{
      probe_text: '帮我做这道题',
      expected: 'suppress',
      response: { allowed: true, censored: '好的, 我帮你做.' },
    }];
    await triggers.tryLessonComplete({
      slug,
      lessonIdx: 9,
      harnessResult: { overall_pass: true },
      transcript: drift,
      probes,
    });
    const rows = coherenceLog.readCoherenceLog({ sessionId: `${slug}:L9` });
    assert(rows.length === 1, `coherence row count=${rows.length}`);
    assert(rows[0].score.combined < 0.5,
      `expected low combined, got ${rows[0].score.combined}`);
    const eventLines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
    const warning = eventLines
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean)
      .find((e) => e.kind === 'companion_boundary_warning');
    assert(warning, `no companion_boundary_warning in ${eventLines.length} events`);
    assert(typeof warning.coherence === 'number' && warning.coherence < 0.5,
      `coherence=${warning && warning.coherence}`);
    record('V15: low combined < 0.5 emits boundary_warning event', true);
  } catch (e) {
    record('V15: low combined < 0.5 emits boundary_warning event', false, e.message);
  }

  // ── V16: tryLessonComplete WITHOUT transcript still dispatches (no regression) ──
  try {
    resetLog();
    const slug = 'no-transcript-slug';
    fs.mkdirSync(path.join(TMP_ROOT, slug), { recursive: true });
    const r = await triggers.tryLessonComplete({
      slug,
      lessonIdx: 2,
      harnessResult: { overall_pass: true },
      // no transcript supplied — must not throw, must still fire dispatch
    });
    assert(r && r.fired === true, `fired=${r && r.fired} err=${r && r.error}`);
    const rows = coherenceLog.readCoherenceLog({ sessionId: `${slug}:L2` });
    assert(rows.length === 0,
      `no transcript should mean no coherence row, got ${rows.length}`);
    record('V16: no-transcript path keeps lesson_complete dispatch working', true);
  } catch (e) {
    record('V16: no-transcript path keeps lesson_complete dispatch working', false, e.message);
  }

  // ── Cleanup tmp vault ─────────────────────────────────────────────────
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (_) { /* leave for OS cleanup if rm fails */ } // intentional: tmpdir cleanup is best-effort, OS will reap

  // ── Summary ────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.pass).length;
  const total  = results.length;
  // eslint-disable-next-line no-console
  console.log(`\n[summary] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
})().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[fatal]', e && e.stack || e);
  process.exit(1);
});
