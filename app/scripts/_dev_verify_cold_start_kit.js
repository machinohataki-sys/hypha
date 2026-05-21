'use strict';
// HYPHA · Cohort cold-start kit smoke (v1.0, 2026-05-21)
//
// Hermetic verification for:
//   app/lib/onboarding/preping-priors.js
//   app/lib/onboarding/persona-classifier.js
//   app/lib/onboarding/cohort-refiner.js
//
// Test groups:
//   G1 — ARCHETYPES contract + 4 starter playbooks load with ≥20 trajectories
//   G2 — classifier on 8 synthetic answer fixtures (4 archetypes × 2 phrasings)
//   G3 — classifier degenerate inputs (empty / unrelated / tie scenarios)
//   G4 — refiner with synthetic events (below + above minEvents threshold)
//   G5 — refiner backward compat (missing events.jsonl = no-op)
//   G6 — revision persistence to .hypha/archetype-revisions.jsonl
//
// 19+ assertions across 16 tests. Exit 0 on PASS, 1 on FAIL, 2 on throw.

const path = require('node:path');

const C_GREEN  = '\x1b[32m';
const C_RED    = '\x1b[31m';
const C_YELLOW = '\x1b[33m';
const C_RESET  = '\x1b[0m';
const green  = (s) => `${C_GREEN}${s}${C_RESET}`;
const red    = (s) => `${C_RED}${s}${C_RESET}`;
const yellow = (s) => `${C_YELLOW}${s}${C_RESET}`;

function makeMemVault(seed = {}) {
  const files = { ...seed };
  const jsonl = {};
  const text = {};
  return {
    _files: files,
    _jsonl: jsonl,
    _text: text,
    exists(rel) {
      return Object.prototype.hasOwnProperty.call(files, rel)
          || Object.prototype.hasOwnProperty.call(text, rel);
    },
    readJSON(rel, def) {
      if (!Object.prototype.hasOwnProperty.call(files, rel)) return def;
      try { return JSON.parse(files[rel]); } catch (_) { return def; }
    },
    readText(rel) {
      if (Object.prototype.hasOwnProperty.call(text, rel)) return text[rel];
      if (Object.prototype.hasOwnProperty.call(files, rel)) return files[rel];
      return '';
    },
    writeJSON(rel, obj) { files[rel] = JSON.stringify(obj, null, 2); },
    writeText(rel, t) { text[rel] = String(t); },
    appendJSONL(rel, row) {
      if (!Array.isArray(jsonl[rel])) jsonl[rel] = [];
      jsonl[rel].push(row);
      const existing = text[rel] || '';
      text[rel] = existing + (existing && !existing.endsWith('\n') ? '\n' : '') + JSON.stringify(row) + '\n';
    },
  };
}

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

const priors     = require(path.join(__dirname, '..', 'lib', 'onboarding', 'preping-priors.js'));
const classifier = require(path.join(__dirname, '..', 'lib', 'onboarding', 'persona-classifier.js'));
const refiner    = require(path.join(__dirname, '..', 'lib', 'onboarding', 'cohort-refiner.js'));

// ---------------------------------------------------------------------------
// G1 — ARCHETYPES contract + 4 starter playbooks load
// ---------------------------------------------------------------------------
console.log('\nG1 — ARCHETYPES contract + 4 starter playbooks');

runTest('ARCHETYPES exports 4 known ids', () => {
  assert(Array.isArray(priors.ARCHETYPES), 'ARCHETYPES is array');
  assert(priors.ARCHETYPES.length === 4, `expected 4, got ${priors.ARCHETYPES.length}`);
  for (const a of ['engineer-mid', 'engineer-senior', 'pm', 'researcher']) {
    assert(priors.ARCHETYPES.includes(a), `missing archetype: ${a}`);
  }
});

runTest('All 4 archetypes load starter playbook with ≥20 trajectories', () => {
  for (const arc of priors.ARCHETYPES) {
    const pb = priors.getStarterPlaybook(arc);
    assert(pb !== null, `playbook missing for ${arc}`);
    assert(pb.archetype === arc, 'archetype echoed');
    assert(Array.isArray(pb.trajectories), 'trajectories array');
    assert(pb.trajectories.length >= 20, `${arc} expected ≥20 trajectories, got ${pb.trajectories.length}`);
    assert(typeof pb.suggested_lesson_0 === 'string' && pb.suggested_lesson_0.length > 20, 'lesson 0 framing non-empty');
    assert(Array.isArray(pb.suggested_concepts) && pb.suggested_concepts.length >= 5, 'seed concepts ≥5');
  }
});

runTest('Trajectory shape: goal + expected_next_lessons + expected_concepts + expected_questions', () => {
  for (const arc of priors.ARCHETYPES) {
    const t = priors.getStarterPlaybook(arc).trajectories;
    for (let i = 0; i < t.length; i++) {
      const tr = t[i];
      assert(typeof tr.goal === 'string' && tr.goal.length > 5, `${arc}[${i}] goal non-empty`);
      assert(Array.isArray(tr.expected_next_lessons) && tr.expected_next_lessons.length >= 2, `${arc}[${i}] next_lessons ≥2`);
      assert(Array.isArray(tr.expected_concepts) && tr.expected_concepts.length >= 2, `${arc}[${i}] concepts ≥2`);
      assert(Array.isArray(tr.expected_questions) && tr.expected_questions.length >= 1, `${arc}[${i}] questions ≥1`);
    }
  }
});

runTest('isKnownArchetype rejects bogus + null', () => {
  assert(priors.isKnownArchetype('engineer-mid') === true, 'valid accepted');
  assert(priors.isKnownArchetype('astronaut') === false, 'bogus rejected');
  assert(priors.isKnownArchetype(null) === false, 'null rejected');
  assert(priors.isKnownArchetype(undefined) === false, 'undefined rejected');
  assert(priors.getStarterPlaybook('astronaut') === null, 'unknown returns null');
});

// ---------------------------------------------------------------------------
// G2 — classifier on 8 synthetic answer fixtures
// ---------------------------------------------------------------------------
console.log('\nG2 — classifier on 8 synthetic answer fixtures');

const FIXTURES = [
  {
    label: 'engineer-mid #1 (CN)',
    answers: { role: '后端工程师', experience_years: '4', current_focus: '把日常开发的业务代码 ship 稳' },
    expect: 'engineer-mid',
  },
  {
    label: 'engineer-mid #2 (EN)',
    answers: { role: 'Backend IC', experience_years: '5', current_focus: 'shipping features, debugging prod issues' },
    expect: 'engineer-mid',
  },
  {
    label: 'engineer-senior #1 (CN)',
    answers: { role: '架构师 / 资深工程师', experience_years: '10', current_focus: '系统设计 + 带团队 + 指导新人' },
    expect: 'engineer-senior',
  },
  {
    label: 'engineer-senior #2 (EN)',
    answers: { role: 'Staff Engineer', experience_years: '12', current_focus: 'distributed systems, design review, mentoring' },
    expect: 'engineer-senior',
  },
  {
    label: 'pm #1 (CN)',
    answers: { role: '产品经理', experience_years: '3', current_focus: '写 PRD, 用户调研, 增长' },
    expect: 'pm',
  },
  {
    label: 'pm #2 (EN)',
    answers: { role: 'Product Manager', experience_years: '6', current_focus: 'roadmap, stakeholder management, A/B test analysis' },
    expect: 'pm',
  },
  {
    label: 'researcher #1 (CN)',
    answers: { role: '博士在读', experience_years: '3', current_focus: '论文复现, 消融实验, 投顶会' },
    expect: 'researcher',
  },
  {
    label: 'researcher #2 (EN)',
    answers: { role: 'Research Engineer', experience_years: '5', current_focus: 'ablation studies, NeurIPS submission, reproducibility' },
    expect: 'researcher',
  },
];

runTest('Classifier hits expected archetype on all 8 fixtures', () => {
  let hits = 0;
  const misses = [];
  for (const fx of FIXTURES) {
    const res = classifier.classifyFromOnboarding(fx.answers);
    if (res.archetype === fx.expect) {
      hits++;
    } else {
      misses.push(`${fx.label}: got ${res.archetype} (${Math.round(res.confidence * 100)}%) expected ${fx.expect}`);
    }
  }
  assert(misses.length === 0, `${hits}/8 hit; misses: ${misses.join(' | ')}`);
});

runTest('Classifier returns shape: { archetype, confidence, why, breakdown }', () => {
  const res = classifier.classifyFromOnboarding(FIXTURES[0].answers);
  assert(typeof res.archetype === 'string', 'archetype string');
  assert(typeof res.confidence === 'number', 'confidence number');
  assert(typeof res.why === 'string' && res.why.length > 0, 'why non-empty');
  assert(typeof res.breakdown === 'object' && res.breakdown !== null, 'breakdown object');
  for (const a of priors.ARCHETYPES) {
    assert(typeof res.breakdown[a] === 'number', `breakdown.${a} present`);
  }
});

runTest('Confidence ≥ 0.4 on at least 6/8 clear fixtures', () => {
  let confident = 0;
  for (const fx of FIXTURES) {
    const res = classifier.classifyFromOnboarding(fx.answers);
    if (res.archetype === fx.expect && res.confidence >= 0.4) confident++;
  }
  assert(confident >= 6, `${confident}/8 confident; expected ≥6`);
});

// ---------------------------------------------------------------------------
// G3 — classifier degenerate inputs
// ---------------------------------------------------------------------------
console.log('\nG3 — classifier degenerate inputs');

runTest('Empty answers → engineer-mid default (largest cohort)', () => {
  const res = classifier.classifyFromOnboarding({});
  assert(res.archetype === 'engineer-mid', `expected engineer-mid, got ${res.archetype}`);
  assert(res.confidence === 0, 'confidence 0 for empty');
  assert(/默认|空|空 answers/.test(res.why), 'why mentions default/empty');
});

runTest('Null / non-object answers handled (no throw)', () => {
  const r1 = classifier.classifyFromOnboarding(null);
  const r2 = classifier.classifyFromOnboarding(undefined);
  const r3 = classifier.classifyFromOnboarding('not-an-object');
  assert(r1.archetype && typeof r1.archetype === 'string', 'null returns string archetype');
  assert(r2.archetype && typeof r2.archetype === 'string', 'undefined returns string archetype');
  assert(r3.archetype && typeof r3.archetype === 'string', 'string answers returns archetype');
});

runTest('classifyFromText accepts a free-text blob', () => {
  const res = classifier.classifyFromText('我是产品经理, 负责写 PRD 跟用户调研');
  assert(res.archetype === 'pm', `expected pm, got ${res.archetype}`);
});

// ---------------------------------------------------------------------------
// G4 — refiner with synthetic events
// ---------------------------------------------------------------------------
console.log('\nG4 — refiner with synthetic events');

runTest('Refiner declines below minEvents threshold', () => {
  const result = refiner.refineArchetype({
    userId: 'u1',
    currentArchetype: 'engineer-mid',
    sessionEvents: [{ role: 'user', question: 'how do I debug?' }],
    minEvents: 5,
  });
  assert(result.changed === false, 'declined revision');
  assert(result.next === 'engineer-mid', 'previous archetype preserved');
  assert(result.eventCount === 1, 'event count reported');
  assert(/! 足够|不足|preserve/.test(result.why) || result.why.includes('保持'), 'why mentions insufficient');
});

runTest('Refiner reclassifies when events strongly point elsewhere', () => {
  // user was guessed pm initially, but events show heavy research vocabulary
  const events = [
    { question: '怎么做 ablation study?' },
    { question: 'NeurIPS 投稿截止' },
    { concept: '论文复现' },
    { concept: '消融实验' },
    { note: '导师让重做 baseline' },
    { lesson_topic: '博士第一年 reading list' },
  ];
  const result = refiner.refineArchetype({
    userId: 'u2',
    currentArchetype: 'pm',
    sessionEvents: events,
    minEvents: 5,
  });
  assert(result.eventCount === 6, 'all events counted');
  assert(result.next === 'researcher', `expected researcher, got ${result.next}`);
  assert(result.changed === true, 'changed flag set');
  assert(result.confidence > 0, 'positive confidence');
});

runTest('Refiner confirms archetype when events align', () => {
  const events = [
    { question: '怎么 debug 这个 prod 问题' },
    { question: 'ship 这个 feature 周五' },
    { note: '上线后回滚' },
    { concept: 'sprint 节奏' },
    { lesson_topic: '业务代码重构' },
  ];
  const result = refiner.refineArchetype({
    userId: 'u3',
    currentArchetype: 'engineer-mid',
    sessionEvents: events,
    minEvents: 5,
  });
  assert(result.next === 'engineer-mid', 'archetype stays');
  assert(result.changed === false, 'no change');
  assert(/确认/.test(result.why), 'why mentions confirm');
});

// ---------------------------------------------------------------------------
// G5 — refiner backward compat (missing events.jsonl)
// ---------------------------------------------------------------------------
console.log('\nG5 — refiner backward compat');

runTest('Missing events.jsonl → refiner returns no-op (! throw)', () => {
  const v = makeMemVault();
  const result = refiner.refineArchetype({
    userId: 'u4',
    currentArchetype: 'researcher',
    vault: v,
    minEvents: 5,
  });
  assert(result.eventCount === 0, 'no events');
  assert(result.changed === false, '! changed');
  assert(result.next === 'researcher', 'previous preserved');
});

runTest('Null vault + no sessionEvents → graceful no-op', () => {
  const result = refiner.refineArchetype({
    userId: 'u5',
    currentArchetype: 'pm',
    vault: null,
    minEvents: 5,
  });
  assert(result.eventCount === 0, 'no events');
  assert(result.changed === false, '! changed');
});

runTest('Malformed events.jsonl lines are skipped, ! throw', () => {
  const v = makeMemVault();
  v.writeText(refiner.EVENTS_REL,
    '{ "userId": "u6", "question": "ship feature" }\n' +
    'NOT_JSON_THIS_LINE\n' +
    '{ "userId": "u6", "question": "debug bug" }\n' +
    '\n' +
    '{ "userId": "u6", "concept": "上线" }\n'
  );
  const events = refiner.readEventsForUser(v, 'u6');
  assert(events.length === 3, `expected 3 valid events, got ${events.length}`);
});

// ---------------------------------------------------------------------------
// G6 — revision persistence
// ---------------------------------------------------------------------------
console.log('\nG6 — revision persistence to archetype-revisions.jsonl');

runTest('appendRevision writes to .hypha/archetype-revisions.jsonl', () => {
  const v = makeMemVault();
  const rev = {
    userId: 'u7',
    previous: 'pm',
    next: 'researcher',
    changed: true,
    confidence: 0.62,
    eventCount: 8,
    ts: new Date().toISOString(),
  };
  const r = refiner.appendRevision(v, rev);
  assert(r.ok === true, 'appendRevision ok');
  assert(Array.isArray(v._jsonl[refiner.REVISIONS_REL]), 'revisions jsonl present');
  assert(v._jsonl[refiner.REVISIONS_REL].length === 1, 'one revision row');
  assert(v._jsonl[refiner.REVISIONS_REL][0].userId === 'u7', 'userId carried');
});

runTest('refineArchetype + appendRevision end-to-end (vault-backed)', () => {
  const v = makeMemVault();
  v.writeText(refiner.EVENTS_REL,
    '{ "userId": "u8", "question": "NeurIPS 截稿" }\n' +
    '{ "userId": "u8", "concept": "消融" }\n' +
    '{ "userId": "u8", "concept": "论文" }\n' +
    '{ "userId": "u8", "note": "导师 review" }\n' +
    '{ "userId": "u8", "lesson_topic": "复现" }\n' +
    '{ "userId": "u8", "concept": "实验室" }\n'
  );
  const rev = refiner.refineArchetype({
    userId: 'u8',
    currentArchetype: 'pm',
    vault: v,
    minEvents: 5,
  });
  assert(rev.eventCount === 6, 'six events read');
  assert(rev.next === 'researcher', 'reclassified to researcher');
  const appendResult = refiner.appendRevision(v, rev);
  assert(appendResult.ok === true, 'persisted');
  assert(v._jsonl[refiner.REVISIONS_REL].length === 1, 'one row written');
});

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
const passed = results.filter(r => r.status === 'PASS').length;
const failed = results.filter(r => r.status === 'FAIL').length;
const skipped = results.filter(r => r.status === 'SKIP').length;
const total = results.length;

console.log('\n' + '─'.repeat(72));
console.log(`Cold-start kit smoke: ${passed}/${total} PASS · ${failed} FAIL · ${skipped} SKIP · ${assertionCount} assertions`);

if (failed === 0) {
  console.log(green('All cold-start kit checks passed.'));
  process.exit(0);
} else {
  console.log(red(`${failed} check(s) failed.`));
  process.exit(1);
}
