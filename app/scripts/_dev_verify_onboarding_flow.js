'use strict';
// HYPHA · Onboarding flow dev-verify (boot-7, 2026-05-20)
//
// Hermetic smoke for `app/lib/onboarding-state.js` + the IPC handler
// contract documented in `app/main.js` (onboarding:state / mark-complete /
// validate-key). Does NOT require Electron; substitutes an in-memory vault
// shim so the same code paths exercised by the IPC handlers run pure.
//
// Six test groups, each independent:
//   T1  first-launch detection on missing profile.json
//   T2  first-launch detection on profile.json without onboarded_at
//   T3  markOnboarded writes onboarded_at + role + first_goal_seed + history row
//   T4  re-launch after onboarded → isFirstLaunch === false
//   T5  validateApiKey happy + invalid (5 sub-cases)
//   T6  coerceSeed pulls goal from onboarding payload (skip path = no lock-out)
//
// Exit code: 0 on PASS, 1 on any FAIL, 2 on uncaught throw.

const path = require('node:path');

// ---------------------------------------------------------------------------
// Colours.
// ---------------------------------------------------------------------------
const C_GREEN  = '\x1b[32m';
const C_RED    = '\x1b[31m';
const C_YELLOW = '\x1b[33m';
const C_RESET  = '\x1b[0m';
const green  = (s) => `${C_GREEN}${s}${C_RESET}`;
const red    = (s) => `${C_RED}${s}${C_RESET}`;
const yellow = (s) => `${C_YELLOW}${s}${C_RESET}`;

// ---------------------------------------------------------------------------
// In-memory vault shim. Mirrors the surface of app/lib/vault.js used by
// onboarding-state.js: exists / readJSON / writeJSON / appendJSONL.
// ---------------------------------------------------------------------------
function makeMemVault(seed = {}) {
  const files = { ...seed };
  const jsonl = {};
  return {
    _files: files,
    _jsonl: jsonl,
    exists(rel) { return Object.prototype.hasOwnProperty.call(files, rel); },
    readJSON(rel, def) {
      if (!Object.prototype.hasOwnProperty.call(files, rel)) return def;
      try { return JSON.parse(files[rel]); } catch (_) { return def; }
    },
    writeJSON(rel, obj) { files[rel] = JSON.stringify(obj, null, 2); },
    appendJSONL(rel, row) {
      if (!Array.isArray(jsonl[rel])) jsonl[rel] = [];
      jsonl[rel].push(row);
    },
  };
}

// ---------------------------------------------------------------------------
// Test runner.
// ---------------------------------------------------------------------------
const results = [];
let assertionCount = 0;

function record(label, status, detail = '') {
  results.push({ label, status, detail });
  const tag = status === 'PASS' ? green('PASS') : status === 'SKIP' ? yellow('SKIP') : red('FAIL');
  console.log(`  ${tag}  ${label}${detail ? ' — ' + detail : ''}`);
}

function assert(cond, msg) {
  assertionCount++;
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function runTest(label, fn) {
  try {
    fn();
    record(label, 'PASS');
    return true;
  } catch (err) {
    record(label, 'FAIL', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Module under test.
// ---------------------------------------------------------------------------
const onb = require(path.join(__dirname, '..', 'lib', 'onboarding-state.js'));

// ---------------------------------------------------------------------------
// T1 — first-launch detection on missing profile.json
// ---------------------------------------------------------------------------
console.log('\nT1 — first-launch detection (no profile.json)');
runTest('isFirstLaunch returns true when profile missing', () => {
  const v = makeMemVault();
  assert(onb.isFirstLaunch(v) === true, 'expected true for missing profile');
  assert(onb.loadProfile(v) === null, 'expected null profile');
});

// ---------------------------------------------------------------------------
// T2 — first-launch detection when profile exists but no onboarded_at
// ---------------------------------------------------------------------------
console.log('\nT2 — first-launch detection (profile present, no onboarded_at)');
runTest('isFirstLaunch returns true when onboarded_at missing', () => {
  const v = makeMemVault({
    [onb.PROFILE_REL]: JSON.stringify({ name: 'Victor', about: '', tutorName: '' }),
  });
  assert(onb.isFirstLaunch(v) === true, 'expected true when onboarded_at absent');
  const p = onb.loadProfile(v);
  assert(p && p.name === 'Victor', 'profile should still load');
});

// ---------------------------------------------------------------------------
// T3 — markOnboarded persists onboarded_at + role + first_goal_seed
// ---------------------------------------------------------------------------
console.log('\nT3 — markOnboarded persistence');
runTest('markOnboarded writes onboarded_at + role + first_goal_seed', () => {
  const v = makeMemVault();
  const r = onb.markOnboarded(v, {
    role: 'self-directed adult learner',
    north_star_goal: '把 transformer 数学吃透',
    pedagogy_structure: '论文',
  });
  assert(r.ok === true, 'returns ok');
  assert(typeof r.profile.onboarded_at === 'string', 'onboarded_at is set');
  assert(/T.*Z$/.test(r.profile.onboarded_at), 'onboarded_at is ISO 8601');
  assert(r.profile.onboarded_role === 'self-directed adult learner', 'role persisted');
  assert(r.profile.first_goal_seed === '把 transformer 数学吃透', 'goal seed persisted');
  assert(r.profile.first_pedagogy === '论文', 'pedagogy persisted');
  // History row appended.
  assert(Array.isArray(v._jsonl[onb.HISTORY_REL]), 'history.jsonl appended');
  assert(v._jsonl[onb.HISTORY_REL].length === 1, 'one history row');
  assert(v._jsonl[onb.HISTORY_REL][0].first_goal_seed === '把 transformer 数学吃透', 'history row carries seed');
});

runTest('markOnboarded preserves existing name/about/tutorName', () => {
  const v = makeMemVault({
    [onb.PROFILE_REL]: JSON.stringify({ name: 'Machino', about: 'engineer', tutorName: '若虚' }),
  });
  const r = onb.markOnboarded(v, { role: 'engineer-shipped' });
  assert(r.profile.name === 'Machino', 'name preserved');
  assert(r.profile.about === 'engineer', 'about preserved');
  assert(r.profile.tutorName === '若虚', 'tutorName preserved');
  assert(typeof r.profile.onboarded_at === 'string', 'onboarded_at written');
});

runTest('markOnboarded is idempotent — second call does NOT overwrite onboarded_at', () => {
  const v = makeMemVault();
  const r1 = onb.markOnboarded(v, { role: 'novice' });
  const ts1 = r1.profile.onboarded_at;
  // Sleep is unnecessary — markOnboarded reads cur.onboarded_at first
  const r2 = onb.markOnboarded(v, { role: 'advanced' });  // should NOT change ts
  assert(r2.profile.onboarded_at === ts1, 'onboarded_at sticky on second call');
  // role also sticky — first write wins for the first_* family
  assert(r2.profile.onboarded_role === 'novice', 'role sticky');
});

// ---------------------------------------------------------------------------
// T4 — re-launch after onboarded → isFirstLaunch === false
// ---------------------------------------------------------------------------
console.log('\nT4 — re-launch skips welcome');
runTest('Re-launch sees isFirstLaunch === false', () => {
  const v = makeMemVault();
  onb.markOnboarded(v, { role: 'novice', north_star_goal: 'learn rust' });
  // Simulate a fresh process boot by reading isFirstLaunch from same vault.
  assert(onb.isFirstLaunch(v) === false, 'isFirstLaunch should be false after mark');
  const p = onb.loadProfile(v);
  assert(p && p.onboarded_at, 'profile still has onboarded_at');
});

// ---------------------------------------------------------------------------
// T5 — validateApiKey happy + invalid paths (5 cases)
// ---------------------------------------------------------------------------
console.log('\nT5 — validateApiKey happy + invalid');
runTest('Claude key with sk-ant- prefix is accepted', () => {
  const r = onb.validateApiKey('claude', 'sk-ant-api03-' + 'x'.repeat(40));
  assert(r.ok === true, 'sk-ant- should be ok');
});
runTest('Empty key on byok provider returns ok=false with skip hint', () => {
  const r = onb.validateApiKey('claude', '');
  assert(r.ok === false, 'empty key rejected');
  assert(/跳过|Settings/.test(r.hint), 'hint mentions skip / settings');
});
runTest('Empty key on hypha-managed is accepted (server resolves)', () => {
  const r = onb.validateApiKey('hypha-managed', '');
  assert(r.ok === true, 'hypha-managed empty ok');
});
runTest('Key with embedded newline rejected (PowerShell >> bake-in)', () => {
  const r = onb.validateApiKey('claude', 'sk-ant-' + 'x'.repeat(20) + '\n');
  assert(r.ok === false, 'newline rejected');
  assert(/空白|换行|PowerShell/.test(r.hint), 'hint mentions whitespace');
});
runTest('Wrong-prefix key rejected (openai key pasted into claude slot)', () => {
  const r = onb.validateApiKey('claude', 'sk-proj-' + 'x'.repeat(40));
  assert(r.ok === false, 'wrong prefix rejected');
  assert(/前缀|sk-ant-/.test(r.hint), 'hint mentions correct prefix');
});
runTest('Short key rejected', () => {
  const r = onb.validateApiKey('glm', 'short');
  assert(r.ok === false, 'short key rejected');
  assert(/过短|短/.test(r.hint), 'hint mentions length');
});

// ---------------------------------------------------------------------------
// T6 — coerceSeed flows first-goal-seed into Crystallizer-shaped object
// ---------------------------------------------------------------------------
console.log('\nT6 — first goal seed flows to crystallizer (skip path safe)');
runTest('coerceSeed pulls topic + level + pedagogy from onboarding payload', () => {
  const payload = {
    provider: 'glm',
    model: 'glm-5.1',
    goalContract: {
      north_star_goal: '成为 AI Builder, 做一个能帮人解释论文的 agent',
      current_level: 'self-directed adult learner',
      user_intent: '论文',
      learning_model: 'Growth',
      deadline: null,
      teacher_persona: null,
    },
    bookIds: ['ssh', 'gould'],
  };
  const seed = onb.coerceSeed(payload);
  assert(seed !== null, 'seed not null');
  assert(seed.topic.startsWith('成为 AI Builder'), 'topic carried');
  assert(seed.level === 'self-directed adult learner', 'level carried');
  assert(seed.pedagogy_structure === '论文', 'pedagogy carried');
  assert(seed.learning_model === 'Growth', 'model default');
  assert(Array.isArray(seed.bookIds) && seed.bookIds.length === 2, 'bookIds carried');
});

runTest('coerceSeed returns null on empty north_star_goal (skip-safe)', () => {
  assert(onb.coerceSeed({ goalContract: {} }) === null, 'empty goal → null');
  assert(onb.coerceSeed({ goalContract: { north_star_goal: '   ' } }) === null, 'whitespace → null');
  assert(onb.coerceSeed(null) === null, 'null payload → null');
  assert(onb.coerceSeed('not-an-object') === null, 'string payload → null');
});

runTest('Onboarding can be SKIPPED: markOnboarded with empty payload still completes', () => {
  // Defensive — if the UI ever ships a "skip onboarding" path, markOnboarded
  // should still produce a non-empty onboarded_at so the user is NOT locked
  // back into the welcome screen on next launch.
  const v = makeMemVault();
  const r = onb.markOnboarded(v, {});  // empty — no role, no seed
  assert(r.ok === true, 'skip path ok');
  assert(typeof r.profile.onboarded_at === 'string', 'still gets onboarded_at');
  assert(onb.isFirstLaunch(v) === false, 'isFirstLaunch flips even on skip');
  // BYOK can be skipped — Settings UI is reachable after.
  const keyVerdict = onb.validateApiKey('claude', '');
  assert(keyVerdict.ok === false, 'empty key returns ok=false');
  assert(/跳过|Settings/.test(keyVerdict.hint), 'hint reassures user can skip');
});

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
const passed = results.filter(r => r.status === 'PASS').length;
const failed = results.filter(r => r.status === 'FAIL').length;
const skipped = results.filter(r => r.status === 'SKIP').length;
const total = results.length;

console.log('\n' + '─'.repeat(70));
console.log(`Onboarding flow smoke: ${passed}/${total} PASS · ${failed} FAIL · ${skipped} SKIP · ${assertionCount} assertions`);

if (failed === 0) {
  console.log(green('All onboarding flow checks passed.'));
  process.exit(0);
} else {
  console.log(red(`${failed} check(s) failed.`));
  process.exit(1);
}
