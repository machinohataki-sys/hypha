#!/usr/bin/env node
'use strict';

// HYPHA · v2-push B1+B2+B3 IPC wiring smoke (2026-05-21).
//
// Verifies the 18 new IPC handlers + 18 preload bridges shipped to expose v2
// lib functions (B1 companion coherence trend / B2 cross-spark + scope shrink
// + pack lifecycle + dependency graph + monthly rollup + cost preflight /
// B3 feasibility confidence_band + atlas decay + preping priors + persona
// classifier) to the renderer.
//
// Strategy: source-level scan. We do NOT boot Electron — that would require
// a real renderer + main process pair. Instead we regex-match the registered
// channel names in app/main.js and the matching bridge entries in
// app/preload.js. Catches: missing handler, missing bridge, typo'd channel
// name (handler ≠ bridge string).
//
// Run:   node app/scripts/_dev_verify_v2_ipc.js
// Exit:  0 = PASS N/N, 1 = any FAIL.

const fs = require('node:fs');
const path = require('node:path');

const results = [];
function record(name, ok, msg) {
  results.push({ name, ok, msg });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${msg ? '  ' + msg : ''}`);
}

const MAIN_JS_PATH = path.resolve(__dirname, '..', 'main.js');
const PRELOAD_JS_PATH = path.resolve(__dirname, '..', 'preload.js');

let mainSrc = '';
let preloadSrc = '';
try {
  mainSrc = fs.readFileSync(MAIN_JS_PATH, 'utf-8');
  record('app/main.js readable', mainSrc.length > 0, `bytes=${mainSrc.length}`);
} catch (e) {
  record('app/main.js readable', false, e.message);
  process.exit(1);
}
try {
  preloadSrc = fs.readFileSync(PRELOAD_JS_PATH, 'utf-8');
  record('app/preload.js readable', preloadSrc.length > 0, `bytes=${preloadSrc.length}`);
} catch (e) {
  record('app/preload.js readable', false, e.message);
  process.exit(1);
}

// 18 handler channels expected (B1=2, B2=8, B3=8).
const CHANNELS = [
  // B1
  'companion:coherence-trend',
  'companion:coherence-log',
  // B2
  'growth:cross-spark-strength',
  'growth:north-star-alert',
  'exam:scope-shrink',
  'exam:judge-4axis',
  'commons:lifecycle-transition',
  'commons:license-validate',
  'creation:dependency-graph-list',
  'creation:dependency-cascade-events',
  'infra:cost-preflight',
  'infra:lifetime-monthly-rollup',
  'infra:router-events-tail',
  // B3
  'cold-start:get-playbook',
  'cold-start:classify-persona',
  'note:atlas-entropy-badge',
  'note:atlas-decay',
  'goal:feasibility-with-confidence',
];

// Verify each channel is registered exactly once in main.js as an
// ipcMain.handle('<channel>', ...) call. "Exactly once" guards against the
// classic copy-paste-rename mistake where a stale handler shadows the new
// one. We escape colons + dashes since they're regex-literal but safe.
function _escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

for (const channel of CHANNELS) {
  const re = new RegExp(`ipcMain\\.handle\\(\\s*['"]${_escapeRe(channel)}['"]`, 'g');
  const matches = mainSrc.match(re) || [];
  record(
    `main.js registers ipcMain.handle('${channel}')`,
    matches.length === 1,
    `count=${matches.length}`,
  );
}

// Each channel must have at least one matching bridge in preload.js. We do
// not require uniqueness here — a bridge might appear under multiple
// namespaces in the future (e.g. legacy + new). For now we just verify the
// channel string is invoked somewhere.
for (const channel of CHANNELS) {
  const re = new RegExp(`ipcRenderer\\.invoke\\(\\s*['"]${_escapeRe(channel)}['"]`, 'g');
  const matches = preloadSrc.match(re) || [];
  record(
    `preload.js exposes ipcRenderer.invoke('${channel}')`,
    matches.length >= 1,
    `count=${matches.length}`,
  );
}

// Spot-check the new v2 namespace shape so renderer code can rely on it. The
// regex confirms `ptor.v2` exists with all 9 sub-namespaces (companion /
// growth / exam / commons / creation / infra / coldStart / note / goal).
const v2 = preloadSrc.match(/v2:\s*\{[\s\S]*?\n\s*\},\s*\n\}\);?/);
record('preload.js declares ptor.v2 namespace block', !!v2, v2 ? `len=${v2[0].length}` : 'block not found');

const SUB_NAMESPACES = ['companion', 'growth', 'exam', 'commons', 'creation', 'infra', 'coldStart', 'note', 'goal'];
if (v2) {
  for (const ns of SUB_NAMESPACES) {
    const sub = new RegExp(`\\b${ns}:\\s*\\{`).test(v2[0]);
    record(`ptor.v2.${ns} sub-namespace present`, sub);
  }
} else {
  for (const ns of SUB_NAMESPACES) {
    record(`ptor.v2.${ns} sub-namespace present`, false, 'v2 block missing — sub-namespace check N/A');
  }
}

// Cross-check: every channel registered in main.js newly-added block also
// appears in CHANNELS — guards against drift (someone adds a handler
// without telling the smoke). We scope the search to the v2-push comment
// header introduced in this batch.
const v2Block = mainSrc.match(/v2-push B1\+B2\+B3 IPC wiring[\s\S]*?app\.on\('before-quit'/);
record(
  'main.js contains v2-push IPC wiring block',
  !!v2Block,
  v2Block ? `len=${v2Block[0].length}` : 'header not found',
);
if (v2Block) {
  const allHandleCalls = v2Block[0].match(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g) || [];
  const registered = allHandleCalls
    .map(s => (s.match(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/) || [])[1])
    .filter(Boolean);
  const unknown = registered.filter(ch => !CHANNELS.includes(ch));
  record(
    'no untracked channels in v2-push block',
    unknown.length === 0,
    unknown.length ? `untracked=${unknown.join(',')}` : `tracked=${registered.length}`,
  );
  record(
    `v2-push block registers exactly ${CHANNELS.length} channels`,
    registered.length === CHANNELS.length,
    `got=${registered.length} expected=${CHANNELS.length}`,
  );
}

// Lib-module existence check — each handler's underlying lib must resolve
// via require(). This is the cheap shape check before runtime invocation.
const LIB_PATHS = [
  './lib/companion',
  './lib/growth/cross-spark',
  './lib/growth/north-star-metrics',
  './lib/exam-system/scope-engine',
  './lib/exam-system/judge',
  './lib/commons/pack-lifecycle',
  './lib/commons/license-validator',
  './lib/creation/dependency-graph',
  './lib/creation/kill-watcher',
  './lib/llm/cost-predictor',
  './lib/lifetime-ledger',
  './lib/onboarding/preping-priors',
  './lib/onboarding/persona-classifier',
  './lib/note-system/atlas-decay',
  './lib/feasibility',
];

for (const libRel of LIB_PATHS) {
  const abs = path.resolve(__dirname, '..', libRel + '.js');
  let exists = fs.existsSync(abs);
  if (!exists) {
    // try index.js for directory-modules
    const idx = path.resolve(__dirname, '..', libRel, 'index.js');
    exists = fs.existsSync(idx);
  }
  record(`lib module resolvable: ${libRel}`, exists, exists ? '' : `not at ${abs}`);
}

// Functional-shape check on a few stable, deterministic lib fns. We can run
// these without Electron because they're pure JS. Picks: feasibility math,
// preping-priors lookup, persona-classifier, cross-spark strength,
// commons license validator.
try {
  const fb = require('../lib/feasibility');
  const out = fb.classifyFeasibility({
    targetDifficulty: 0.6, priorKnowledge: 0.2, timeWeeks: 4, dailyHours: 2,
  });
  record(
    'feasibility.classifyFeasibility returns confidence_band',
    Array.isArray(out.confidence_band) && out.confidence_band.length === 2,
    `band=${JSON.stringify(out.confidence_band)}`,
  );
} catch (e) {
  record('feasibility.classifyFeasibility returns confidence_band', false, e.message);
}
try {
  const pp = require('../lib/onboarding/preping-priors');
  const pb = pp.getStarterPlaybook('engineer-mid');
  record(
    "preping-priors.getStarterPlaybook('engineer-mid') returns playbook",
    pb && pb.archetype === 'engineer-mid' && Array.isArray(pb.trajectories),
    pb ? `trajectories=${pb.trajectories.length}` : 'null',
  );
} catch (e) {
  record('preping-priors.getStarterPlaybook works', false, e.message);
}
try {
  const pc = require('../lib/onboarding/persona-classifier');
  const v = pc.classifyFromOnboarding({ role: 'engineer', experience_years: 6 });
  record(
    'persona-classifier.classifyFromOnboarding returns archetype',
    v && typeof v.archetype === 'string' && typeof v.confidence === 'number',
    `archetype=${v && v.archetype} conf=${v && v.confidence}`,
  );
} catch (e) {
  record('persona-classifier.classifyFromOnboarding works', false, e.message);
}
try {
  const cs = require('../lib/growth/cross-spark');
  const s = cs._internals.computeStrength('learning', 'learn deeply about subject');
  record(
    'cross-spark _internals.computeStrength returns numeric',
    typeof s === 'number' && Number.isFinite(s),
    `strength=${s}`,
  );
} catch (e) {
  record('cross-spark _internals.computeStrength works', false, e.message);
}
try {
  const lv = require('../lib/commons/license-validator');
  const ok = lv.validatePackLicense({ license: 'CC-BY-SA' });
  record(
    'license-validator.validatePackLicense accepts CC-BY-SA',
    ok && ok.ok === true,
    JSON.stringify(ok),
  );
  const bad = lv.validatePackLicense({ license: 'WTF-1.0' });
  record(
    'license-validator.validatePackLicense rejects unknown',
    bad && bad.ok === false && bad.error === 'LICENSE_NOT_APPROVED',
    JSON.stringify(bad),
  );
} catch (e) {
  record('license-validator works', false, e.message);
}

// ─── Summary ───────────────────────────────────────────────────────────────
const passN = results.filter(r => r.ok).length;
const failN = results.length - passN;
console.log('');
console.log(`PASS ${passN}/${results.length}` + (failN > 0 ? `  (${failN} FAIL)` : ''));
process.exit(failN > 0 ? 1 : 0);
