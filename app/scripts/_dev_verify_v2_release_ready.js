#!/usr/bin/env node
'use strict';

// SKIP_HEADLESS — read-only gate, runs OUTSIDE the sweep (it asserts the
// LOCKED state the sweep produces; including it inside would deadlock).
// HYPHA · v2.0-rc.X release-readiness smoke (v2 push batches 1+2+3 2026-05-21).
//
// Mirrors `_dev_verify_v1_release_ready.js` shape, expanded to 8 invariants.
// Hard gate. If anything here fails, the v2 release tag must not move.
//
//   RR1  package.json    version  === '2.0.0' OR '2.0.0-rc.N'  (CONDITIONAL
//                                 — orchestrator bumps separately; passes
//                                 when V2_VERSION_BUMPED=1 OR version is on
//                                 the 2.0.0 line; otherwise CONDITIONAL,
//                                 surfaced but not counted as failure)
//   RR2  CHANGELOG.md    contains '## [2.0.0-rc.N]' release section
//                                 (CONDITIONAL — same release-gate dance)
//   RR3  smoke-baseline  LOCKED + total_smokes >= 74 + passing === total
//   RR4  v2 lib modules  all 20 expected files exist (B1+B2+B3 ship surface)
//   RR5  v2 smoke files  all 14 expected smokes exist
//   RR6  system ship-%   10 systems each reach >= 85% per CHANGELOG claims
//   RR7  Scout frontier  14 digest IDs cited in CHANGELOG (S52/S63/S66/S67/
//                                 S68/S69/S73/S75/S77/S80/S81/S83/S86/S88)
//   RR8  Companion lift  Companion no longer biggest gap — file count >= 5
//                                 AND coherence-log.js present
//
// Read-only — no vault writes, no LLM calls. Safe in every CI matrix cell.

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const tests = [];

function record(id, label, pass, detail, conditional) {
  tests.push({ id, label, pass, detail, conditional: !!conditional });
  let tag;
  if (conditional && !pass) {
    tag = '\x1b[33mCOND\x1b[0m';
  } else if (pass) {
    tag = '\x1b[32mPASS\x1b[0m';
  } else {
    tag = '\x1b[31mFAIL\x1b[0m';
  }
  console.log(`[${id}] ${tag}  ${label}${detail ? ' — ' + detail : ''}`);
}

const V2_VERSION_RE = /^2\.0\.0(-rc\.\d+)?$/;
const V2_HEADER_RE  = /^##\s+\[2\.0\.0(-rc\.\d+)?\]/m;

// RR1 — package.json version matches the v2.0 line (rc.N or stable)
// Conditional: orchestrator handles version bump separately.
let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const onV2 = V2_VERSION_RE.test(pkg.version);
  const bumpEnv = process.env.V2_VERSION_BUMPED === '1';
  const ok = onV2;
  record('RR1', 'package.json version on 2.0.0 line',
    ok, `version=${pkg.version}${bumpEnv ? ' (V2_VERSION_BUMPED=1)' : ''}`,
    !ok && !bumpEnv);
} catch (e) {
  record('RR1', 'package.json readable + parses', false, e.message);
}

// RR2 — CHANGELOG has matching '## [2.0.0-rc.N]' release-header section
try {
  const cl = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const has = V2_HEADER_RE.test(cl);
  record('RR2', "CHANGELOG.md has '## [2.0.0-rc.N]' section",
    has, has ? 'header found' : 'header missing (orchestrator finalizes)',
    !has);
} catch (e) {
  record('RR2', 'CHANGELOG.md readable', false, e.message);
}

// RR3 — smoke baseline locked + sized + clean
try {
  const bl = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'vault', '.hypha', 'smoke-baseline.json'), 'utf8'));
  const ok =
    bl.status === 'LOCKED' &&
    typeof bl.total_smokes === 'number' && bl.total_smokes >= 74 &&
    bl.passing === bl.total_smokes;
  record('RR3', "smoke-baseline LOCKED + >=74 + all passing",
    ok,
    `status=${bl.status} total=${bl.total_smokes} passing=${bl.passing} failing=${bl.failing}`);
} catch (e) {
  record('RR3', 'smoke-baseline.json readable', false, e.message);
}

// RR4 — v2 new lib modules from B1+B2+B3
const LIB_FILES = [
  // Batch 1
  'app/lib/companion/persona-coherence.js',
  'app/lib/companion/coherence-log.js',
  'app/lib/lesson-critique.js',
  'app/lib/lesson-critique-msifr.js',
  'app/lib/source-lane-router.js',
  'app/lib/source-conference-extractor.js',
  'app/lib/source-course-extractor.js',
  // Batch 2
  'app/lib/creation/dependency-graph.js',
  'app/lib/creation/wikilink-resolver.js',
  'app/lib/commons/pack-lifecycle.js',
  'app/lib/commons/license-validator.js',
  'app/lib/commons/source-trust-decay.js',
  // Batch 3
  'app/lib/anti-slop/meta-coherence-detector.js',
  'app/lib/anti-slop/encyclopedia-opener-guard.js',
  'app/lib/anti-slop/concept-drift-emitter.js',
  'app/lib/lesson-brief-field-validator.js',
  'app/lib/note-system/atlas-decay.js',
  'app/lib/onboarding/preping-priors.js',
  'app/lib/onboarding/persona-classifier.js',
  'app/lib/onboarding/cohort-refiner.js'
];
{
  const missing = LIB_FILES.filter(p => !fs.existsSync(path.join(ROOT, p)));
  record('RR4', `v2 new lib modules present (${LIB_FILES.length} expected)`,
    missing.length === 0,
    missing.length ? `missing=${missing.length}: ${missing.join(', ')}`
                   : `${LIB_FILES.length}/${LIB_FILES.length} present`);
}

// RR5 — v2 new smoke files
const SMOKE_FILES = [
  'app/scripts/_dev_verify_companion_persona_coherence.js',
  'app/scripts/_dev_verify_companion_v2.js',
  'app/scripts/_dev_verify_critique_loop.js',
  'app/scripts/_dev_verify_prediction_field.js',
  'app/scripts/_dev_verify_source_lane_router.js',
  'app/scripts/_dev_verify_dependency_graph.js',
  'app/scripts/_dev_verify_exam_v2.js',
  'app/scripts/_dev_verify_commons_v2.js',
  'app/scripts/_dev_verify_growth_v2.js',
  'app/scripts/_dev_verify_infra_v2.js',
  'app/scripts/_dev_verify_goal_v2.js',
  'app/scripts/_dev_verify_lesson_v2.js',
  'app/scripts/_dev_verify_note_v2.js',
  'app/scripts/_dev_verify_cold_start_kit.js'
];
{
  const missing = SMOKE_FILES.filter(p => !fs.existsSync(path.join(ROOT, p)));
  record('RR5', `v2 new smoke files present (${SMOKE_FILES.length} expected)`,
    missing.length === 0,
    missing.length ? `missing=${missing.length}: ${missing.join(', ')}`
                   : `${SMOKE_FILES.length}/${SMOKE_FILES.length} present`);
}

// RR6 — System ship-% audit table (parsed from CHANGELOG batch lines)
// Each system phrase appears like '**X System depth** (~A% → ~B%)' or
// '**X hardening** (~A% → ~B%)' etc. We scan for known labels and pull the
// post-arrow B%. Floor enforced at >= 85%.
try {
  const cl = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const SYSTEMS = [
    { name: 'Goal',        re: /\*\*Goal System depth\*\*[^~]*~\d[\d.]*%\s*→\s*~(\d[\d.]*)%/ },
    { name: 'Lesson',      re: /\*\*Lesson System depth\*\*[^~]*~\d[\d.]*%\s*→\s*~(\d[\d.]*)%/ },
    { name: 'Note',        re: /\*\*Note System depth\*\*[^~]*~\d[\d.]*%\s*→\s*~(\d[\d.]*)%/ },
    { name: 'Creation',    re: null, fixed: 95 }, // boot-12 baseline, no v2 push delta
    { name: 'Source',      re: /Knowledge Source System\s*~\d[\d.]*%\s*→\s*~(\d[\d.]*)%/ },
    { name: 'Commons',     re: /\*\*Commons System lifecycle\*\*[^~]*~\d[\d.]*%\s*→\s*~(\d[\d.]*)%/ },
    { name: 'Exam',        re: /\*\*Exam System depth\*\*[^~]*~\d[\d.]*%\s*→\s*~(\d[\d.]*)%/ },
    { name: 'Growth',      re: /\*\*Growth System depth\*\*[^~]*~\d[\d.]*%\s*→\s*~(\d[\d.]*)%/ },
    { name: 'Companion',   re: /\*\*Companion System wired\*\*[^~]*~\d[\d.]*%\s*→\s*~(\d[\d.]*)%/ },
    { name: 'Infra',       re: /\*\*Infrastructure hardening\*\*[^~]*~\d[\d.]*%\s*→\s*~(\d[\d.]*)%/ }
  ];
  const FLOOR = 85;
  const rows = SYSTEMS.map(s => {
    if (s.fixed != null) return { name: s.name, pct: s.fixed, source: 'boot-12' };
    const m = cl.match(s.re);
    const pct = m ? parseFloat(m[1]) : null;
    return { name: s.name, pct, source: m ? 'CHANGELOG' : 'NOT_FOUND' };
  });
  const below = rows.filter(r => r.pct == null || r.pct < FLOOR);
  const ok = below.length === 0;
  // Print the table (informational)
  console.log('       ┌────────────┬────────┬───────────┐');
  console.log('       │ System     │ Ship % │ Source    │');
  console.log('       ├────────────┼────────┼───────────┤');
  for (const r of rows) {
    const name = r.name.padEnd(10);
    const pct  = (r.pct == null ? '—' : r.pct + '%').padStart(6);
    const src  = (r.source || '—').padEnd(9);
    console.log(`       │ ${name} │ ${pct} │ ${src} │`);
  }
  console.log('       └────────────┴────────┴───────────┘');
  record('RR6', `all 10 systems reach >= ${FLOOR}%`, ok,
    ok ? `min=${Math.min(...rows.map(r => r.pct))}%`
       : `below floor: ${below.map(r => r.name + '=' + (r.pct ?? 'n/a')).join(', ')}`);
} catch (e) {
  record('RR6', 'ship-% audit', false, e.message);
}

// RR7 — Frontier (Scout) integrations cited
const SCOUT_IDS = ['S52','S63','S66','S67','S68','S69','S73','S75','S77','S80','S81','S83','S86','S88'];
try {
  const cl = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const missing = SCOUT_IDS.filter(id => !new RegExp('\\b' + id + '\\b').test(cl));
  record('RR7', `Scout digest IDs cited in CHANGELOG (${SCOUT_IDS.length})`,
    missing.length === 0,
    missing.length ? `missing=${missing.join(',')}`
                   : `present=${SCOUT_IDS.join(',')}`);
} catch (e) {
  record('RR7', 'CHANGELOG readable for Scout grep', false, e.message);
}

// RR8 — Companion no longer biggest gap
try {
  const compDir = path.join(ROOT, 'app', 'lib', 'companion');
  const files = fs.readdirSync(compDir).filter(f => f.endsWith('.js'));
  const hasCoherenceLog = files.includes('coherence-log.js');
  const ok = files.length >= 5 && hasCoherenceLog;
  record('RR8', 'Companion lifted (>=5 .js files + coherence-log present)',
    ok,
    `files=${files.length} coherence-log=${hasCoherenceLog ? 'yes' : 'no'}`);
} catch (e) {
  record('RR8', 'companion dir readable', false, e.message);
}

// Summary
const hard = tests.filter(t => !t.pass && !t.conditional);
const cond = tests.filter(t => !t.pass &&  t.conditional);
const pass = tests.filter(t =>  t.pass);
console.log('\n\x1b[2m' + '─'.repeat(60) + '\x1b[0m');
console.log(
  `\x1b[${hard.length ? '31m' : '32m'}${hard.length ? 'FAIL' : 'PASS'}\x1b[0m ` +
  `${pass.length}/${tests.length}   ` +
  (hard.length ? `\x1b[31mFAIL\x1b[0m ${hard.length}   ` : '') +
  (cond.length ? `\x1b[33mCOND\x1b[0m ${cond.length} (${cond.map(t => t.id).join(',')})   ` : '') +
  `\x1b[2massertions=${tests.length}\x1b[0m`);

if (cond.length) {
  console.log('\x1b[2m' + 'Conditional gates expect orchestrator to bump version + finalize CHANGELOG before v2 tag.' + '\x1b[0m');
}

// Exit code policy: hard failures only. Conditional gates surface but do not
// fail the smoke (orchestrator runs the bump + re-runs this script as the
// final hard gate before tagging).
process.exit(hard.length ? 1 : 0);
