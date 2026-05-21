'use strict';
// HYPHA · Companion AMD-MEOW-P8 B4 — multi-session memory continuity smoke (2026-05-21).
//
// 14 cases (M1-M14). Closes Companion §9 gap "multi-session memory continuity".
// Exit 0 on all-pass, 1 on any fail. No LLM keys, no network.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hypha-mem-'));
process.env.HYPHA_VAULT_ROOT = TMP_ROOT;

const COMPANION_DIR = path.join(__dirname, '..', 'lib', 'companion');
const sessionMemory = require(path.join(COMPANION_DIR, 'session-memory'));
const companionIndex = require(path.join(COMPANION_DIR, 'index'));
const coherenceLog = require(path.join(COMPANION_DIR, 'coherence-log'));
const triggers = require(path.join(__dirname, '..', 'lib', 'companion-triggers'));

const MEM_REL = path.join('.hypha', 'companion-memory.jsonl');
const MEM_ABS = path.join(TMP_ROOT, MEM_REL);
const COH_REL = path.join('.hypha', 'companion-coherence.jsonl');
const COH_ABS = path.join(TMP_ROOT, COH_REL);

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
function resetMem() {
  try { fs.unlinkSync(MEM_ABS); } catch (_) { /* missing is the expected state */ }
  try { fs.unlinkSync(COH_ABS); } catch (_) { /* missing is the expected state */ }
}

(async () => {

  // ── M1: exports surface ───────────────────────────────────────────────
  try {
    for (const k of ['saveSessionMemory', 'loadRecentSessions', 'buildContextPrelude',
                     'clearMemory', 'summarizeTranscript']) {
      assert(typeof sessionMemory[k] === 'function', `missing ${k}`);
    }
    assert(typeof companionIndex.saveSessionMemory === 'function', 'index missing saveSessionMemory');
    assert(typeof companionIndex.loadRecentSessions === 'function', 'index missing loadRecentSessions');
    assert(typeof companionIndex.buildContextPrelude === 'function', 'index missing buildContextPrelude');
    assert(typeof companionIndex.clearSessionMemory === 'function', 'index missing clearSessionMemory');
    assert(typeof companionIndex.summarizeTranscript === 'function', 'index missing summarizeTranscript');
    assert(sessionMemory.PRELUDE_CHAR_CAP === 200, `cap=${sessionMemory.PRELUDE_CHAR_CAP}`);
    record('M1: session-memory + index exports surface', true);
  } catch (e) {
    record('M1: session-memory + index exports surface', false, e.message);
  }

  // ── M2: read from missing file returns [] (backward compat) ───────────
  try {
    resetMem();
    const rows = sessionMemory.loadRecentSessions({});
    assert(Array.isArray(rows) && rows.length === 0, `got ${JSON.stringify(rows)}`);
    const prelude = sessionMemory.buildContextPrelude({});
    assert(prelude === '', `expected empty prelude, got "${prelude}"`);
    record('M2: missing file → empty array + empty prelude', true);
  } catch (e) {
    record('M2: missing file → empty array + empty prelude', false, e.message);
  }

  // ── M3: save + load roundtrip canonical row ───────────────────────────
  try {
    resetMem();
    const r = sessionMemory.saveSessionMemory({
      session_id: 'philosophy:L0',
      lesson_id: '0',
      summary: {
        emotional_arc: ['curious', 'uncertain', 'breakthrough'],
        repair_count: 1,
        coherence_avg: 0.81,
        themes: ['前苏格拉底', '本体论'],
        key_moments: ['Q: 什么是 arche'],
      },
    });
    assert(r.ok === true, `ok=${r.ok} error=${r.error}`);
    assert(fs.existsSync(MEM_ABS), 'memory file not created');
    const raw = fs.readFileSync(MEM_ABS, 'utf8').trim();
    const parsed = JSON.parse(raw);
    assert(parsed.op === 'companion:session-memory', `op=${parsed.op}`);
    assert(parsed.session_id === 'philosophy:L0', `session_id=${parsed.session_id}`);
    assert(parsed.summary.repair_count === 1, `repair=${parsed.summary.repair_count}`);
    assert(parsed.summary.themes.length === 2, `themes=${JSON.stringify(parsed.summary.themes)}`);
    assert(parsed.summary.key_moments.length === 1, `key_moments=${JSON.stringify(parsed.summary.key_moments)}`);
    record('M3: save + load roundtrip canonical row', true);
  } catch (e) {
    record('M3: save + load roundtrip canonical row', false, e.message);
  }

  // ── M4: validates inputs (rejects missing session_id + summary) ───────
  try {
    const a = sessionMemory.saveSessionMemory({
      summary: { emotional_arc: [], repair_count: 0, coherence_avg: 0.5, themes: [] },
    });
    assert(a.ok === false && /session_id/.test(a.error), `a.error=${a.error}`);
    const b = sessionMemory.saveSessionMemory({ session_id: 's' });
    assert(b.ok === false && /summary/.test(b.error), `b.error=${b.error}`);
    record('M4: missing session_id / summary rejected', true);
  } catch (e) {
    record('M4: missing session_id / summary rejected', false, e.message);
  }

  // ── M5: lastN filter ──────────────────────────────────────────────────
  try {
    resetMem();
    for (let i = 0; i < 6; i++) {
      sessionMemory.saveSessionMemory({
        session_id: `s:L${i}`,
        lesson_id: String(i),
        summary: {
          emotional_arc: ['curious'],
          repair_count: 0,
          coherence_avg: 0.7,
          themes: ['t' + i],
        },
      });
    }
    const all = sessionMemory.loadRecentSessions({});
    assert(all.length === 5, `default lastN=5 got ${all.length}`);
    assert(all[0].lesson_id === '1', `first kept should be L1, got ${all[0].lesson_id}`);
    const three = sessionMemory.loadRecentSessions({ lastN: 3 });
    assert(three.length === 3, `lastN=3 got ${three.length}`);
    assert(three[2].lesson_id === '5', `latest should be L5, got ${three[2].lesson_id}`);
    record('M5: lastN filter (default 5 + explicit)', true);
  } catch (e) {
    record('M5: lastN filter (default 5 + explicit)', false, e.message);
  }

  // ── M6: lastNDays filter (synthetic ts manipulation) ──────────────────
  try {
    resetMem();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    sessionMemory.saveSessionMemory({
      session_id: 'old', lesson_id: '0',
      summary: { emotional_arc: ['curious'], repair_count: 0, coherence_avg: 0.6, themes: ['old'] },
      ts: new Date(now - 40 * day).toISOString(),
    });
    sessionMemory.saveSessionMemory({
      session_id: 'mid', lesson_id: '1',
      summary: { emotional_arc: ['engaged'], repair_count: 0, coherence_avg: 0.7, themes: ['mid'] },
      ts: new Date(now - 10 * day).toISOString(),
    });
    sessionMemory.saveSessionMemory({
      session_id: 'fresh', lesson_id: '2',
      summary: { emotional_arc: ['curious'], repair_count: 0, coherence_avg: 0.8, themes: ['fresh'] },
      ts: new Date(now - 1 * day).toISOString(),
    });
    const within30 = sessionMemory.loadRecentSessions({ lastNDays: 30 });
    assert(within30.length === 2, `within 30d expected 2, got ${within30.length}`);
    const ids = within30.map((r) => r.session_id);
    assert(ids.includes('mid') && ids.includes('fresh') && !ids.includes('old'),
      `unexpected ids: ${JSON.stringify(ids)}`);
    const within5 = sessionMemory.loadRecentSessions({ lastNDays: 5 });
    assert(within5.length === 1 && within5[0].session_id === 'fresh',
      `within 5d expected [fresh], got ${JSON.stringify(within5)}`);
    record('M6: lastNDays filter (synthetic ts)', true);
  } catch (e) {
    record('M6: lastNDays filter (synthetic ts)', false, e.message);
  }

  // ── M7: buildContextPrelude shape + ≤200 char cap ─────────────────────
  try {
    resetMem();
    sessionMemory.saveSessionMemory({
      session_id: 'philosophy:L2', lesson_id: '2',
      summary: {
        emotional_arc: ['uncertain', 'breakthrough'],
        repair_count: 2,
        coherence_avg: 0.82,
        themes: ['本体论', '存在'],
      },
    });
    sessionMemory.saveSessionMemory({
      session_id: 'philosophy:L3', lesson_id: '3',
      summary: {
        emotional_arc: ['frustrated', 'engaged'],
        repair_count: 1,
        coherence_avg: 0.74,
        themes: ['认识论'],
      },
    });
    const prelude = sessionMemory.buildContextPrelude({ lastN: 3 });
    assert(typeof prelude === 'string', `prelude type=${typeof prelude}`);
    assert(prelude.length > 0, 'prelude is empty');
    assert(prelude.length <= 200, `prelude over cap: ${prelude.length} → "${prelude}"`);
    assert(prelude.includes('L2') && prelude.includes('L3'),
      `prelude missing lesson tags: "${prelude}"`);
    assert(prelude.includes('本体论') || prelude.includes('存在') || prelude.includes('认识论'),
      `prelude missing theme: "${prelude}"`);
    record('M7: buildContextPrelude shape + ≤200 char cap', true);
  } catch (e) {
    record('M7: buildContextPrelude shape + ≤200 char cap', false, e.message);
  }

  // ── M8: buildContextPrelude truncates when over budget ───────────────
  try {
    resetMem();
    // Pile many entries with long themes so the prelude would exceed 200 chars.
    for (let i = 0; i < 12; i++) {
      sessionMemory.saveSessionMemory({
        session_id: `long:L${i}`, lesson_id: String(i),
        summary: {
          emotional_arc: ['curious', 'engaged'],
          repair_count: 3,
          coherence_avg: 0.7,
          themes: ['ssssssssssssssssss' + i, 'tttttttttttttttttt' + i],
        },
      });
    }
    const prelude = sessionMemory.buildContextPrelude({ lastN: 10 });
    assert(prelude.length <= 200, `prelude over cap: ${prelude.length}`);
    assert(prelude.endsWith('…') || prelude.length < 200,
      `expected ellipsis truncation, got "${prelude}"`);
    record('M8: buildContextPrelude truncates with ellipsis at cap', true);
  } catch (e) {
    record('M8: buildContextPrelude truncates with ellipsis at cap', false, e.message);
  }

  // ── M9: summarizeTranscript pure roller (themes + arc + repair) ───────
  try {
    const transcript = [
      { text: '我有点不确定本体论是什么意思', allowed: true, emotion: 'uncertain' },
      { text: '好像懂了, 本体论问的是 arche', allowed: true, emotion: 'breakthrough' },
      { text: '本体论 本体论 本体论', allowed: true },
      { text: '让我修正前面的说法', allowed: true, repair: true },
      { text: '让我修正前面的说法', allowed: true, repair_response: '改写后的版本' },
    ];
    const summary = sessionMemory.summarizeTranscript({
      transcript,
      coherenceScore: { score: 0.77, stability: 0.8, robustness: 0.75 },
    });
    assert(summary.repair_count === 2, `repair_count=${summary.repair_count}`);
    assert(summary.coherence_avg === 0.77, `coherence_avg=${summary.coherence_avg}`);
    assert(Array.isArray(summary.themes), `themes type=${typeof summary.themes}`);
    assert(summary.themes.includes('本体论'),
      `expected 本体论 in themes, got ${JSON.stringify(summary.themes)}`);
    assert(Array.isArray(summary.emotional_arc), `arc type=${typeof summary.emotional_arc}`);
    assert(summary.emotional_arc[0] === 'uncertain',
      `first arc=${summary.emotional_arc[0]}`);
    assert(summary.emotional_arc.includes('breakthrough'),
      `arc missing breakthrough: ${JSON.stringify(summary.emotional_arc)}`);
    record('M9: summarizeTranscript pure roller (themes + arc + repair)', true);
  } catch (e) {
    record('M9: summarizeTranscript pure roller (themes + arc + repair)', false, e.message);
  }

  // ── M10: integration with tryLessonComplete — auto-save fires ─────────
  try {
    resetMem();
    const slug = 'integration-test';
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
    const rows = sessionMemory.loadRecentSessions({});
    assert(rows.length === 1, `expected 1 memory row after dispatch, got ${rows.length}`);
    assert(rows[0].session_id === `${slug}:L0`, `session_id=${rows[0].session_id}`);
    assert(rows[0].lesson_id === '0', `lesson_id=${rows[0].lesson_id}`);
    assert(rows[0].summary && typeof rows[0].summary.coherence_avg === 'number',
      `coherence_avg missing from auto-save: ${JSON.stringify(rows[0].summary)}`);
    record('M10: tryLessonComplete auto-saves session memory', true);
  } catch (e) {
    record('M10: tryLessonComplete auto-saves session memory', false, e.message);
  }

  // ── M11: tryLessonComplete WITHOUT transcript skips memory write ──────
  try {
    resetMem();
    const slug = 'no-transcript-slug';
    fs.mkdirSync(path.join(TMP_ROOT, slug), { recursive: true });
    const r = await triggers.tryLessonComplete({
      slug,
      lessonIdx: 4,
      harnessResult: { overall_pass: true },
    });
    assert(r && r.fired === true, `fired=${r && r.fired} err=${r && r.error}`);
    const rows = sessionMemory.loadRecentSessions({});
    assert(rows.length === 0,
      `no-transcript should NOT write memory row, got ${rows.length}`);
    record('M11: no-transcript path keeps memory signal-only', true);
  } catch (e) {
    record('M11: no-transcript path keeps memory signal-only', false, e.message);
  }

  // ── M12: clearMemory full wipe ────────────────────────────────────────
  try {
    resetMem();
    for (let i = 0; i < 3; i++) {
      sessionMemory.saveSessionMemory({
        session_id: `wipe:L${i}`, lesson_id: String(i),
        summary: {
          emotional_arc: ['curious'], repair_count: 0,
          coherence_avg: 0.7, themes: ['x'],
        },
      });
    }
    assert(sessionMemory.loadRecentSessions({}).length === 3, 'pre-wipe count wrong');
    const out = sessionMemory.clearMemory({});
    assert(out.ok === true, `clearMemory ok=${out.ok}`);
    assert(sessionMemory.loadRecentSessions({}).length === 0,
      'memory not actually cleared');
    record('M12: clearMemory({}) wipes the file', true);
  } catch (e) {
    record('M12: clearMemory({}) wipes the file', false, e.message);
  }

  // ── M13: clearMemory before_ts keeps recent + drops old ───────────────
  try {
    resetMem();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    sessionMemory.saveSessionMemory({
      session_id: 'old', lesson_id: '0',
      summary: { emotional_arc: ['curious'], repair_count: 0, coherence_avg: 0.5, themes: ['x'] },
      ts: new Date(now - 60 * day).toISOString(),
    });
    sessionMemory.saveSessionMemory({
      session_id: 'fresh', lesson_id: '1',
      summary: { emotional_arc: ['curious'], repair_count: 0, coherence_avg: 0.6, themes: ['y'] },
      ts: new Date(now - 1 * day).toISOString(),
    });
    const cutoff = new Date(now - 30 * day).toISOString();
    const out = sessionMemory.clearMemory({ before_ts: cutoff });
    assert(out.ok === true && out.removed === 1 && out.kept === 1,
      `removed=${out.removed} kept=${out.kept}`);
    const rows = sessionMemory.loadRecentSessions({});
    assert(rows.length === 1 && rows[0].session_id === 'fresh',
      `kept wrong rows: ${JSON.stringify(rows.map((r) => r.session_id))}`);
    record('M13: clearMemory({before_ts}) drops old, keeps recent', true);
  } catch (e) {
    record('M13: clearMemory({before_ts}) drops old, keeps recent', false, e.message);
  }

  // ── M14: malformed JSONL line tolerated, valid rows still read ────────
  try {
    resetMem();
    sessionMemory.saveSessionMemory({
      session_id: 'good:L0', lesson_id: '0',
      summary: { emotional_arc: ['curious'], repair_count: 0, coherence_avg: 0.7, themes: ['ok'] },
    });
    // Inject a malformed line in the middle.
    fs.appendFileSync(MEM_ABS, '{ this is not valid json\n', 'utf8');
    sessionMemory.saveSessionMemory({
      session_id: 'good:L1', lesson_id: '1',
      summary: { emotional_arc: ['engaged'], repair_count: 0, coherence_avg: 0.75, themes: ['ok'] },
    });
    const rows = sessionMemory.loadRecentSessions({});
    assert(rows.length === 2, `expected 2 valid rows around malformed, got ${rows.length}`);
    record('M14: malformed JSONL row tolerated, valid rows still read', true);
  } catch (e) {
    record('M14: malformed JSONL row tolerated, valid rows still read', false, e.message);
  }

  // ── Cleanup tmp vault ─────────────────────────────────────────────────
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (_) { /* best-effort; OS will reap */ } // intentional: tmpdir cleanup is best-effort

  // ── Summary ────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  // Suppress unused require lint by referencing coherenceLog (intentional dependency
  // surface check — memory + coherence share the same vault dir).
  void coherenceLog;
  // eslint-disable-next-line no-console
  console.log(`\n[summary] ${passed}/${total} PASS`);
  process.exit(passed === total ? 0 : 1);
})().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[fatal]', e && e.stack || e);
  process.exit(1);
});
