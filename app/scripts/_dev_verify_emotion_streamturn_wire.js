#!/usr/bin/env node
'use strict';

// HYPHA · _dev_verify_emotion_streamturn_wire — P10 smoke for agent.js wire of
// Companion emotion-tone bridge into streamTurn. 8 tests covering:
//
//   ST1: agent.js exports streamTurn (regression — wire didn't remove it)
//   ST2: composeExpression call site identifiable in agent.js (grep test)
//   ST3: _runCompanionCompose helper defined in streamTurn body
//   ST4: all 3 stream branches attach `companion` field to return envelope
//   ST5: SUPPRESSION flow — BOUNDARY_PROTECT + lesson_complete → suppressed=true (via bridge)
//   ST6: NORMAL flow — IDLE + interrupt_resume → suppressed=false + expression candidate
//   ST7: ESCALATION flow — BOUNDARY + interrupt_resume → effective_trigger='over_grind'
//   ST8: GRACEFUL FALLBACK — helper swallows bridge throw, never re-throws
//   ST9: REGRESSION — W3.5 enforceBoundary still referenced in companion lib
//   ST10: REGRESSION — emotion-state.classifyQuestionType still exported
//
// Run:  node app/scripts/_dev_verify_emotion_streamturn_wire.js
// Exit 0 = PASS N/N, Exit 1 = any failure.

const fs = require('fs');
const path = require('path');

const AGENT_JS = path.join(__dirname, '..', 'agent.js');
const COMPANION_DIR = path.join(__dirname, '..', 'lib', 'companion');
const BRIDGE = require(path.join(COMPANION_DIR, 'emotion-tone-bridge.js'));
const EMOTION = require(path.join(COMPANION_DIR, 'emotion-state.js'));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`);
  }
}

console.log('\n[emotion-streamTurn-wire smoke]');

// Load agent.js source ONCE for static analysis (don't require — pulls Electron).
const agentSrc = fs.readFileSync(AGENT_JS, 'utf8');

// ── ST1: streamTurn export still present ────────────────────────────────
(function ST1() {
  const hasFn = /async function streamTurn\s*\(/.test(agentSrc);
  const hasExport = /streamTurn\s*,/.test(agentSrc) || /streamTurn\s*}/.test(agentSrc);
  check('ST1: streamTurn function declared + exported', hasFn && hasExport,
    `hasFn=${hasFn} hasExport=${hasExport}`);
})();

// ── ST2: composeExpression call site grepable ───────────────────────────
(function ST2() {
  const hasRequire = /require\(['"]\.\/lib\/companion\/emotion-tone-bridge['"]\)/.test(agentSrc);
  const hasCall = /composeExpression\s*\(/.test(agentSrc);
  check('ST2: bridge required + composeExpression invoked', hasRequire && hasCall,
    `hasRequire=${hasRequire} hasCall=${hasCall}`);
})();

// ── ST3: _runCompanionCompose helper defined ────────────────────────────
(function ST3() {
  const hasHelper = /_runCompanionCompose\s*=\s*async/.test(agentSrc);
  const hasState = /let\s+_companionExpression\s*=\s*null/.test(agentSrc);
  check('ST3: _runCompanionCompose helper + _companionExpression state', hasHelper && hasState,
    `helper=${hasHelper} state=${hasState}`);
})();

// ── ST4: all 3 stream branches attach `companion` to envelope ───────────
(function ST4() {
  // count occurrences of "companion: _companionExpression" in return objects
  const matches = agentSrc.match(/companion:\s*_companionExpression/g) || [];
  check('ST4: companion field on all 3 stream-branch returns', matches.length === 3,
    `count=${matches.length} expected=3`);
})();

// ── ST5: SUPPRESSION flow via bridge ────────────────────────────────────
(async function ST5() {
  // BOUNDARY_PROTECT triggered by delegate request in currentText.
  const r = await BRIDGE.composeExpression({
    trigger: 'lesson_complete',
    sessionContext: {
      currentText: '帮我做这道题',  // matches DELEGATE_PATTERNS → BOUNDARY_PROTECT
      recentQuestions: [],
      turnCount: 5,
    },
  });
  check('ST5: BOUNDARY_PROTECT + lesson_complete → suppressed',
    r.ok === true && r.suppressed === true && r.emotion === EMOTION.STATES.BOUNDARY_PROTECT,
    `ok=${r.ok} suppressed=${r.suppressed} emotion=${r.emotion}`);
})();

// ── ST6: NORMAL flow ─────────────────────────────────────────────────────
(async function ST6() {
  const r = await BRIDGE.composeExpression({
    trigger: 'interrupt_resume',
    sessionContext: {
      currentText: '继续讲',  // no special pattern → IDLE
      recentQuestions: [],
      turnCount: 3,
    },
  });
  // suppressed must be false; effective_trigger preserved; bias.register present.
  check('ST6: IDLE + interrupt_resume → not suppressed, register present',
    r.ok === true && r.suppressed === false && r.effective_trigger === 'interrupt_resume'
      && r.bias && typeof r.bias.register === 'string',
    `ok=${r.ok} suppressed=${r.suppressed} effective=${r.effective_trigger} reg=${r.bias && r.bias.register}`);
})();

// ── ST7: ESCALATION flow — interrupt_resume + BOUNDARY → over_grind ─────
(async function ST7() {
  const r = await BRIDGE.composeExpression({
    trigger: 'interrupt_resume',
    sessionContext: {
      currentText: '帮我写这段代码',  // delegate → BOUNDARY_PROTECT
      recentQuestions: [],
      turnCount: 8,
    },
  });
  check('ST7: BOUNDARY + interrupt_resume → escalated to over_grind',
    r.ok === true && r.suppressed === false
      && r.effective_trigger === 'over_grind'
      && r.emotion === EMOTION.STATES.BOUNDARY_PROTECT,
    `ok=${r.ok} effective=${r.effective_trigger} emotion=${r.emotion}`);
})();

// ── ST8: GRACEFUL FALLBACK — helper structure swallows throw ────────────
(function ST8() {
  // Static check: the helper body contains try/catch + console.warn pattern
  // such that a bridge throw cannot escape streamTurn. Regex finds the helper
  // and asserts catch block exists inside.
  const helperBlock = agentSrc.match(
    /_runCompanionCompose\s*=\s*async[\s\S]{0,2500}?\n\s{2,4}\};/
  );
  const hasTryCatch = !!(helperBlock && /try\s*\{[\s\S]+catch\s*\(\s*err\s*\)\s*\{/.test(helperBlock[0]));
  const hasWarnFallback = !!(helperBlock && /console\.warn\([^)]*companion compose failed/.test(helperBlock[0]));
  const setsNullOnErr = !!(helperBlock && /_companionExpression\s*=\s*null/.test(helperBlock[0]));
  check('ST8: helper try/catch + warn + null-on-error (graceful fallback)',
    hasTryCatch && hasWarnFallback && setsNullOnErr,
    `try=${hasTryCatch} warn=${hasWarnFallback} null=${setsNullOnErr}`);
})();

// ── ST9: REGRESSION — enforceBoundary still in companion lib ────────────
(function ST9() {
  const bgPath = path.join(COMPANION_DIR, 'boundary-guard.js');
  const bgSrc = fs.readFileSync(bgPath, 'utf8');
  const hasEB = /(?:function|const)\s+enforceBoundary\b/.test(bgSrc)
    || /enforceBoundary\s*:/.test(bgSrc)
    || /module\.exports[\s\S]*enforceBoundary/.test(bgSrc);
  check('ST9: enforceBoundary still defined in boundary-guard.js', hasEB,
    'expected enforceBoundary export untouched');
})();

// ── ST10: REGRESSION — classifyQuestionType still exported ──────────────
(function ST10() {
  const hasFn = typeof EMOTION.classifyQuestionType === 'function';
  // sanity: should classify a definition question correctly
  const got = hasFn ? EMOTION.classifyQuestionType('什么是 X?') : null;
  check('ST10: emotion-state.classifyQuestionType still callable',
    hasFn && got === 'definition',
    `hasFn=${hasFn} got=${got}`);
})();

// ── Done ─────────────────────────────────────────────────────────────────
// Allow async tests (ST5/ST6/ST7) to settle before final report.
setTimeout(() => {
  console.log(`\n[result] ${pass} PASS / ${fail} FAIL  (total ${pass + fail})`);
  if (fail > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  - ${f.name}${f.detail ? '  (' + f.detail + ')' : ''}`);
    }
    process.exit(1);
  } else {
    process.exit(0);
  }
}, 200);
