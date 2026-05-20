#!/usr/bin/env node
'use strict';

// HYPHA · _dev_verify_difficulty_scaling — smoke test for the 2026-05-17 阶 2
// difficulty-driven lesson-count scaling.
//
// What it verifies:
//   1. `perLinkLessonCount` from app/lib/lesson-count.js scales monotonically
//      with the difficulty input (higher diff → more lessons, holding all
//      other inputs constant).
//   2. The difficultyMult formula 0.7 + d × 1.5 matches the spec for the 4
//      anchor difficulty levels (0.95 / 0.65 / 0.35 / 0.05).
//   3. The result respects the Growth 999999 / Exam 200 caps and the floor
//      of 25.
//   4. Backward-compat: calling without a `difficulty` argument falls back
//      to default 0.6 and produces the same number as `difficulty=0.6`.
//
// Run:
//   node app/scripts/_dev_verify_difficulty_scaling.js
// Exit code 0 = PASS N/N, 1 = FAIL.

const path = require('path');
const lc = require(path.join(__dirname, '..', 'lib', 'lesson-count.js'));

const W = 8;            // 8-week link duration
const HD = 2;           // 2 hours / day
const TIER = 'moderate';
const ROLE = 'core';
const MODE = 'Exam';    // capped at 200

// Inputs to scan
const DIFFS = [0.95, 0.65, 0.35, 0.05];
// Expected difficultyMult per spec 0.7 + d × 1.5
const EXPECTED_MULT = {
  0.95: 2.125,
  0.65: 1.675,
  0.35: 1.225,
  0.05: 0.775,
};

let pass = 0;
let fail = 0;
const failures = [];

function approxEq(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS · ${name}`);
  } else {
    fail++;
    failures.push(`${name} — ${detail || ''}`);
    console.log(`  FAIL · ${name} — ${detail || ''}`);
  }
}

console.log('HYPHA · difficulty-scaling smoke test\n');

// 1. difficultyMult correctness
console.log('1. difficultyMult formula (0.7 + d × 1.5)');
for (const d of DIFFS) {
  const got = lc._difficultyMult(d);
  const want = EXPECTED_MULT[d];
  check(
    `_difficultyMult(${d}) ≈ ${want}`,
    approxEq(got, want, 1e-9),
    `got ${got}`,
  );
}

// 2. perLinkLessonCount monotonicity + reference values
console.log('\n2. perLinkLessonCount monotonicity (w=8, hd=2, tier=moderate, role=core, mode=Exam)');
const counts = {};
for (const d of DIFFS) {
  counts[d] = lc.perLinkLessonCount(W, HD, TIER, ROLE, MODE, d);
  console.log(`     d=${d} → lessons = ${counts[d]}`);
}
// Higher difficulty → more lessons.
check(
  'counts[0.95] > counts[0.65]',
  counts[0.95] > counts[0.65],
  `${counts[0.95]} vs ${counts[0.65]}`,
);
check(
  'counts[0.65] > counts[0.35]',
  counts[0.65] > counts[0.35],
  `${counts[0.65]} vs ${counts[0.35]}`,
);
check(
  'counts[0.35] > counts[0.05]',
  counts[0.35] > counts[0.05],
  `${counts[0.35]} vs ${counts[0.05]}`,
);

// Reference: compute expected raw count from the formula and compare.
// raw = round(8 × 7 × 2 / 1.5 × 1.0 × 1.5 × diffMult) = round(112 × diffMult)
function expectedRaw(d) {
  const base = Math.round(W * 7 * HD / 1.5 * 1.0 * 1.5 * (0.7 + d * 1.5));
  return Math.max(25, Math.min(200, base));
}
for (const d of DIFFS) {
  const want = expectedRaw(d);
  check(
    `counts[${d}] = ${want} (formula reference)`,
    counts[d] === want,
    `got ${counts[d]}, want ${want}`,
  );
}

// 3. Default difficulty = 0.6 (no arg supplied)
console.log('\n3. backward-compat default (no difficulty arg = 0.6)');
const defaultCount = lc.perLinkLessonCount(W, HD, TIER, ROLE, MODE);
const explicitCount = lc.perLinkLessonCount(W, HD, TIER, ROLE, MODE, 0.6);
check(
  'no-arg call equals explicit difficulty=0.6',
  defaultCount === explicitCount,
  `default=${defaultCount}, explicit=${explicitCount}`,
);

// 4. Caps: Growth uncapped, Exam capped at 200
console.log('\n4. Growth vs Exam caps');
// Use very high inputs to force cap saturation.
const growthHigh = lc.perLinkLessonCount(52, 8, 'heroic', 'ultimate', 'Growth', 0.95);
const examHigh = lc.perLinkLessonCount(52, 8, 'heroic', 'ultimate', 'Exam', 0.95);
console.log(`     Growth 52w/8h/heroic/ultimate/d=0.95 → ${growthHigh}`);
console.log(`     Exam   52w/8h/heroic/ultimate/d=0.95 → ${examHigh}`);
check(
  'Exam capped at 200',
  examHigh === 200,
  `got ${examHigh}`,
);
check(
  'Growth uncapped (> 200)',
  growthHigh > 200,
  `got ${growthHigh}`,
);

// 5. Floor: low-difficulty short-duration still ≥ 25
console.log('\n5. floor (≥25 lessons)');
const tiny = lc.perLinkLessonCount(1, 1, 'gentle', 'prerequisite', 'Exam', 0.05);
check(
  'tiny inputs floor at 25',
  tiny >= 25,
  `got ${tiny}`,
);

// 6. resolveLessonsForLink — chain-link path
console.log('\n6. resolveLessonsForLink monotonicity');
const link = { role: 'core', duration_weeks: 8 };  // no lessons_count → falls back to derive
const r95 = lc.resolveLessonsForLink(link, HD, TIER, MODE, 0.95);
const r35 = lc.resolveLessonsForLink(link, HD, TIER, MODE, 0.35);
console.log(`     d=0.95 → ${r95},  d=0.35 → ${r35}`);
check(
  'resolveLessonsForLink high > low',
  r95 > r35,
  `${r95} vs ${r35}`,
);

// Final report
const total = pass + fail;
console.log('\n' + '─'.repeat(40));
console.log('Reference table (w=8, hd=2, tier=moderate, role=core, Exam):');
for (const d of DIFFS) {
  console.log(`     d=${d}  mult=${(0.7 + d * 1.5).toFixed(3)}  lessons=${counts[d]}`);
}
console.log('─'.repeat(40));

if (fail === 0) {
  console.log(`\nPASS ${pass}/${total}`);
  process.exit(0);
} else {
  console.log(`\nFAIL ${fail}/${total}`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
