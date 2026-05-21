'use strict';

// HYPHA · sub-step I smoke test — Lesson Note + Vault Deposit.
// Tests 3 cases: deposit lesson 1, deposit lesson 2 (same slug), and
// never-overwrite (manually plant lesson 3 → next deposit lands at 4).
// Uses a fresh tmpdir per run; cleans up at the end.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_VAULT = path.join(os.tmpdir(), 'hypha-test-vault-' + Date.now());
process.env.HYPHA_VAULT_ROOT = TMP_VAULT;

// Require AFTER setting env so the module reads it lazily (vaultRoot() is
// called per-deposit, not at module load — but we reset for safety).
const lessonNote = require('../app/lib/lesson-note');

const goalContract = {
  north_star_goal: '成为 AI Builder',
  main_creation: 'HYPHA',
  learning_model: 'Growth',
  current_level: 'self-directed adult',
};

const plan = {
  objective: 'Trace one IPC round-trip end-to-end',
  prerequisite_check: 'Knows what Electron processes are',
  hook_concrete: 'Open DevTools, fire one ipcRenderer.invoke, watch main.js handler log.',
  path: [
    'Read app/preload.js bridge surface',
    'Identify the matching ipcMain.handle in main.js',
    'Trace return value back to renderer',
  ],
  micro_proof: {
    stimulus: 'Describe the path of one round-trip IPC call.',
    expected_signal: 'mentions: invoke, handle, return',
    fail_mode: 'vague hand-waving without naming both endpoints',
  },
  next_lesson_seed: 'Streaming IPC channels (ipcRenderer.on)',
  assignment_level: 1,
};

const body = {
  intro_prose: 'IPC is a contract: each name is a sealed envelope.',
  path_prose: [
    { step_id: 0, prose: 'Open preload.js. Find the bridge object exposed to the renderer.' },
    { step_id: 1, prose: 'Trace the channel name to ipcMain.handle in main.js.' },
    { step_id: 2, prose: 'Follow the returned value back. The renderer awaits a promise.' },
  ],
  closing_prose: 'You have proven the wire. The rest is patience.',
};

const scoreResult = {
  evidence_type: 'recall',
  passed: true,
  baseline_check: { regex_hits: ['invoke', 'handle', 'return'] },
  llm_signal: { reason: 'all three lexical anchors present' },
  false_positive_risk: 'low',
};

const response = 'Renderer calls window.hypha.depositLessonNote which fires ipcRenderer.invoke; main.js ipcMain.handle('
  + "'note:deposit') returns the result back. Promise resolves with {ok, path, lessonId}.";

let failures = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log('  PASS ', label);
  } else {
    failures++;
    console.log('  FAIL ', label, detail ? '— ' + detail : '');
  }
}

(async () => {
  try {
    console.log('TMP_VAULT:', TMP_VAULT);
    console.log('');

    // --- Test 1 ---------------------------------------------------------
    console.log('Test 1 — first deposit (expect lessonId=1)');
    const r1 = await lessonNote.depositLessonNote({ plan, body, response, scoreResult, goalContract });
    ok('returns ok=true', r1.ok === true, JSON.stringify(r1));
    ok('lessonId is 1', r1.lessonId === 1, 'got ' + r1.lessonId);
    ok('slug is "hypha"', r1.slug === 'hypha', 'got ' + r1.slug);
    ok('file exists at returned path', fs.existsSync(r1.path), r1.path);

    const txt1 = fs.readFileSync(r1.path, 'utf8');
    ok('frontmatter has lesson_id', /^lesson_id:\s*1\b/m.test(txt1));
    ok('frontmatter has goal_north_star', /goal_north_star:/.test(txt1));
    ok('frontmatter has goal_main_creation: HYPHA', /goal_main_creation:\s*HYPHA/.test(txt1));
    ok('frontmatter has learning_model: Growth', /learning_model:\s*Growth/.test(txt1));
    ok('frontmatter has evidence_type: recall', /evidence_type:\s*recall/.test(txt1));
    ok('frontmatter has passed: true', /passed:\s*true/.test(txt1));
    ok('frontmatter has assignment_level: 1', /assignment_level:\s*1/.test(txt1));
    ok('body has 课程基础 H2', /^## 课程基础 \(Course Base\)/m.test(txt1));
    ok('body has 用户灵感 H2', /^## 用户灵感 \(User Insight\)/m.test(txt1));
    ok('body contains user response', txt1.indexOf('Renderer calls window.hypha.depositLessonNote') >= 0);
    ok('body contains stimulus', txt1.indexOf('Describe the path of one round-trip IPC call.') >= 0);
    console.log('');

    // --- Test 2 ---------------------------------------------------------
    console.log('Test 2 — second deposit same slug (expect lessonId=2)');
    const r2 = await lessonNote.depositLessonNote({ plan, body, response, scoreResult, goalContract });
    ok('returns ok=true', r2.ok === true, JSON.stringify(r2));
    ok('lessonId is 2', r2.lessonId === 2, 'got ' + r2.lessonId);
    ok('lesson-1.md still exists, untouched', fs.existsSync(r1.path) && fs.readFileSync(r1.path, 'utf8') === txt1);
    ok('lesson-2.md created', fs.existsSync(r2.path));
    console.log('');

    // --- Test 3 ---------------------------------------------------------
    console.log('Test 3 — never overwrite (manually plant lesson-3.md → expect lessonId=4)');
    const slugDir = path.join(TMP_VAULT, 'hypha');
    const planted = path.join(slugDir, 'lesson-3.md');
    const sentinel = '---\nlesson_id: 3\nplanted: true\n---\nDO NOT OVERWRITE\n';
    fs.writeFileSync(planted, sentinel, 'utf8');
    const r3 = await lessonNote.depositLessonNote({ plan, body, response, scoreResult, goalContract });
    ok('returns ok=true', r3.ok === true, JSON.stringify(r3));
    ok('lessonId is 4 (skipped 3)', r3.lessonId === 4, 'got ' + r3.lessonId);
    ok('lesson-3.md untouched (planted sentinel intact)', fs.readFileSync(planted, 'utf8') === sentinel);
    ok('lesson-4.md exists', fs.existsSync(r3.path));

  } catch (err) {
    failures++;
    console.error('UNCAUGHT', err.stack || err.message);
  } finally {
    // Cleanup.
    try {
      fs.rmSync(TMP_VAULT, { recursive: true, force: true });
      console.log('');
      console.log('Cleanup: removed', TMP_VAULT);
    } catch (e) {
      console.error('cleanup failed:', e.message);
    }
    console.log('');
    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  }
})();
