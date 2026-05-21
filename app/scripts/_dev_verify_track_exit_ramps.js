#!/usr/bin/env node
'use strict';

// HYPHA · _dev_verify_track_exit_ramps — v0.4.13 Track A/B exit-ramp MVP smoke.
//
// Six tests exercising the pure helpers in app/lib/util/track-ramps.js + jsonl
// I/O against a temp scratch dir. No Electron IPC; uses fs.appendFileSync /
// readFileSync directly to mirror the main.js handler shape.

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');
const ramps = require(path.join(ROOT, 'app/lib/util/track-ramps.js'));

const tests = [];
const PASS = (n) => { tests.push({ name: n, ok: true });  console.log(`  \x1b[32mPASS\x1b[0m ${n}`); };
const FAIL = (n, w) => { tests.push({ name: n, ok: false, why: w }); console.log(`  \x1b[31mFAIL\x1b[0m ${n} — ${w}`); };

function withTmp(label, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `hypha-trampe-${label}-`));
  try { fn(tmp); }
  finally {
    try {
      if (tmp && tmp.startsWith(os.tmpdir()) && fs.existsSync(tmp)) {
        for (const f of fs.readdirSync(tmp)) {
          const p = path.join(tmp, f);
          if (fs.statSync(p).isDirectory()) {
            for (const sub of fs.readdirSync(p)) fs.unlinkSync(path.join(p, sub));
            fs.rmdirSync(p);
          } else {
            fs.unlinkSync(p);
          }
        }
        fs.rmdirSync(tmp);
      }
    } catch (_) { /* best-effort cleanup */ }
  }
}

function appendEntry(jsonlPath, args) {
  const v = ramps.validateExitRampArgs(args);
  if (!v.ok) throw new Error(`validate failed for ${JSON.stringify(args)}: ${v.error}`);
  const entry = ramps.buildExitRampEntry(v.normalized);
  fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n', 'utf-8');
  return entry;
}

// ── TE1: jsonl write + readback ─────────────────────────────────────────
withTmp('te1', (tmp) => {
  try {
    const slug = 'mock-course';
    const courseDir = path.join(tmp, slug);
    fs.mkdirSync(courseDir);
    const jsonlPath = path.join(courseDir, 'exit-ramps.jsonl');
    appendEntry(jsonlPath, { slug, lessonIdx: 0, track: 'A', artifactUrl: 'https://example.com/p' });
    appendEntry(jsonlPath, { slug, lessonIdx: 1, track: 'B', commitmentNote: 'will post tonight' });
    appendEntry(jsonlPath, { slug, lessonIdx: 2, track: 'skip' });
    const raw = fs.readFileSync(jsonlPath, 'utf-8');
    const status = ramps.aggregateExitRamps(raw.split('\n'));
    if (status.totalRamps !== 3) return FAIL('TE1 jsonl write + readback', `totalRamps expected 3, got ${status.totalRamps}`);
    if (status.trackACount !== 1) return FAIL('TE1 jsonl write + readback', `trackACount expected 1, got ${status.trackACount}`);
    if (status.trackBCount !== 1) return FAIL('TE1 jsonl write + readback', `trackBCount expected 1, got ${status.trackBCount}`);
    if (status.skipCount !== 1) return FAIL('TE1 jsonl write + readback', `skipCount expected 1, got ${status.skipCount}`);
    if (status.entries.length !== 3) return FAIL('TE1 jsonl write + readback', `entries.length expected 3, got ${status.entries.length}`);
    if (!status.lastRampAt) return FAIL('TE1 jsonl write + readback', 'lastRampAt should be set');
    PASS('TE1 jsonl write + readback aggregation');
  } catch (e) {
    FAIL('TE1 jsonl write + readback', e.message);
  }
});

// ── TE2: artifactUrl validation ─────────────────────────────────────────
(function TE2() {
  const slug = 'mock';
  const cases = [
    { url: 'https://example.com',                     wantOk: true,  desc: 'https OK' },
    { url: 'http://example.com',                      wantOk: true,  desc: 'http OK' },
    { url: '  https://example.com/path  ',            wantOk: true,  desc: 'trimmed whitespace OK' },
    { url: 'ftp://example.com',                       wantOk: false, desc: 'ftp:// rejected' },
    { url: 'example.com',                             wantOk: false, desc: 'missing protocol rejected' },
    { url: 'javascript:alert(1)',                     wantOk: false, desc: 'javascript: rejected' },
    { url: 'https://' + 'a'.repeat(501),              wantOk: false, desc: '> 500 chars rejected' },
    { url: 12345,                                     wantOk: false, desc: 'non-string rejected' },
  ];
  for (const c of cases) {
    const v = ramps.validateExitRampArgs({ slug, lessonIdx: 0, track: 'A', artifactUrl: c.url });
    if (v.ok !== c.wantOk) {
      return FAIL('TE2 artifactUrl validation', `${c.desc}: input=${JSON.stringify(c.url)} got ok=${v.ok}`);
    }
  }
  // null + undefined + empty-after-trim are explicitly allowed (no URL provided)
  const passthroughCases = [null, undefined, '', '   '];
  for (const u of passthroughCases) {
    const v = ramps.validateExitRampArgs({ slug, lessonIdx: 0, track: 'A', artifactUrl: u });
    if (!v.ok) return FAIL('TE2 artifactUrl validation', `nullish ${JSON.stringify(u)} rejected: ${v.error}`);
    if (v.normalized.artifactUrl !== null) return FAIL('TE2 artifactUrl validation', `nullish ${JSON.stringify(u)} should normalize to null`);
  }
  PASS(`TE2 artifactUrl validation (${cases.length + passthroughCases.length} cases)`);
})();

// ── TE3: track enum validation ──────────────────────────────────────────
(function TE3() {
  const slug = 'mock';
  const accept = ['A', 'B', 'skip'];
  const reject = ['C', 'a', 'b', 'SKIP', '', null, undefined, 0, 1, {}, []];
  for (const t of accept) {
    const v = ramps.validateExitRampArgs({ slug, lessonIdx: 0, track: t });
    if (!v.ok) return FAIL('TE3 track enum', `${JSON.stringify(t)} should be accepted: ${v.error}`);
  }
  for (const t of reject) {
    const v = ramps.validateExitRampArgs({ slug, lessonIdx: 0, track: t });
    if (v.ok) return FAIL('TE3 track enum', `${JSON.stringify(t)} should be rejected`);
  }
  PASS(`TE3 track enum validation (${accept.length} accept + ${reject.length} reject)`);
})();

// ── TE4: malformed jsonl line skipped ───────────────────────────────────
withTmp('te4', (tmp) => {
  try {
    const slug = 'mock-course';
    const courseDir = path.join(tmp, slug);
    fs.mkdirSync(courseDir);
    const jsonlPath = path.join(courseDir, 'exit-ramps.jsonl');
    // Write 4 lines, line 2 corrupt
    const goodLines = [
      JSON.stringify({ ts: '2026-05-19T00:00:00.000Z', lessonIdx: 0, track: 'A', artifactUrl: null, commitmentNote: null }),
      '{this is not valid json',
      JSON.stringify({ ts: '2026-05-19T00:01:00.000Z', lessonIdx: 1, track: 'B', artifactUrl: null, commitmentNote: 'note' }),
      JSON.stringify({ ts: '2026-05-19T00:02:00.000Z', lessonIdx: 2, track: 'skip', artifactUrl: null, commitmentNote: null }),
    ];
    fs.writeFileSync(jsonlPath, goodLines.join('\n') + '\n', 'utf-8');
    const raw = fs.readFileSync(jsonlPath, 'utf-8');
    const status = ramps.aggregateExitRamps(raw.split('\n'));
    if (status.totalRamps !== 3) return FAIL('TE4 malformed jsonl line skipped', `totalRamps expected 3, got ${status.totalRamps}`);
    if (status.entries.length !== 3) return FAIL('TE4 malformed jsonl line skipped', `entries expected 3, got ${status.entries.length}`);
    PASS('TE4 malformed jsonl line skipped');
  } catch (e) {
    FAIL('TE4 malformed jsonl line skipped', e.message);
  }
});

// ── TE5: missing file returns empty status ──────────────────────────────
(function TE5() {
  // Mirrors main.js handler short-circuit: when jsonl file missing, aggregator
  // never runs; handler returns empty status directly. Verify the shape with
  // the helper applied to an empty array.
  const status = ramps.aggregateExitRamps([]);
  if (status.totalRamps !== 0) return FAIL('TE5 missing file empty status', `totalRamps expected 0, got ${status.totalRamps}`);
  if (status.trackACount !== 0 || status.trackBCount !== 0 || status.skipCount !== 0) {
    return FAIL('TE5 missing file empty status', 'all counts must be 0');
  }
  if (status.entries.length !== 0) return FAIL('TE5 missing file empty status', 'entries must be empty');
  if (status.lastRampAt !== null) return FAIL('TE5 missing file empty status', 'lastRampAt must be null');
  if (Object.keys(status.byLesson).length !== 0) return FAIL('TE5 missing file empty status', 'byLesson must be empty object');
  PASS('TE5 missing file returns empty status shape');
})();

// ── TE6: lessonIdx grouping (byLesson) ──────────────────────────────────
withTmp('te6', (tmp) => {
  try {
    const slug = 'mock-course';
    const courseDir = path.join(tmp, slug);
    fs.mkdirSync(courseDir);
    const jsonlPath = path.join(courseDir, 'exit-ramps.jsonl');
    appendEntry(jsonlPath, { slug, lessonIdx: 0, track: 'A', artifactUrl: 'https://a.example' });
    appendEntry(jsonlPath, { slug, lessonIdx: 0, track: 'skip' });
    appendEntry(jsonlPath, { slug, lessonIdx: 2, track: 'B', commitmentNote: 'will post' });
    const raw = fs.readFileSync(jsonlPath, 'utf-8');
    const status = ramps.aggregateExitRamps(raw.split('\n'));
    const keys = Object.keys(status.byLesson).sort();
    if (keys.length !== 2 || keys[0] !== '0' || keys[1] !== '2') {
      return FAIL('TE6 lessonIdx grouping', `byLesson keys expected ['0','2'], got ${JSON.stringify(keys)}`);
    }
    if (status.byLesson['0'].length !== 2) {
      return FAIL('TE6 lessonIdx grouping', `byLesson[0] expected 2 entries, got ${status.byLesson['0'].length}`);
    }
    if (status.byLesson['2'].length !== 1) {
      return FAIL('TE6 lessonIdx grouping', `byLesson[2] expected 1 entry, got ${status.byLesson['2'].length}`);
    }
    const tracksAt0 = status.byLesson['0'].map(e => e.track).sort();
    if (tracksAt0[0] !== 'A' || tracksAt0[1] !== 'skip') {
      return FAIL('TE6 lessonIdx grouping', `byLesson[0] tracks expected [A,skip], got ${JSON.stringify(tracksAt0)}`);
    }
    PASS('TE6 lessonIdx grouping (byLesson)');
  } catch (e) {
    FAIL('TE6 lessonIdx grouping', e.message);
  }
});

// ── Summary ─────────────────────────────────────────────────────────────
const passed = tests.filter(t => t.ok).length;
const failed = tests.length - passed;
console.log('');
const summary = `${passed}/${tests.length} PASS`;
console.log(failed > 0 ? `\x1b[31m${summary}\x1b[0m` : `\x1b[32m${summary}\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
