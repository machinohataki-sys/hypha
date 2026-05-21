'use strict';
// Smoke for app/lib/track/validation-mass.js — offline only.

const path = require('node:path');
const { computeMass, DEFAULT_WEIGHTS } = require(path.join(__dirname, '..', 'lib', 'track', 'validation-mass.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`PASS ${name}`); pass++; }
  else { console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

// VM1: computeMass([]) returns zeros + entry_count: 0
const r1 = computeMass([]);
check('VM1 empty → zeros + entry_count 0',
  r1.composite_score === 0 && r1.comments === 0 && r1.shares === 0 &&
  r1.reactions === 0 && r1.views === 0 && r1.entry_count === 0,
  JSON.stringify(r1));

// VM2: 1 entry with comments: 3 → composite_score = 30 (3 × 10)
const r2 = computeMass([{ metrics: { comments: 3 } }]);
check('VM2 1×comments:3 → composite 30',
  r2.composite_score === 30 && r2.comments === 3 && r2.entry_count === 1,
  JSON.stringify(r2));

// VM3: multi-entry aggregation
// e1: c:2 s:1 r:4 v:100  → 2×10 + 1×5 + 4×3 + 100×1 = 20+5+12+100 = 137
// e2: c:1 s:0 r:2 v:50   → 1×10 + 0×5 + 2×3 + 50×1  = 10+0+6+50   = 66
// total: c:3 s:1 r:6 v:150 → 3×10 + 1×5 + 6×3 + 150×1 = 30+5+18+150 = 203
const r3 = computeMass([
  { metrics: { comments: 2, shares: 1, reactions: 4, views: 100 } },
  { metrics: { comments: 1, shares: 0, reactions: 2, views: 50 } },
]);
check('VM3 multi-entry aggregation',
  r3.composite_score === 203 &&
  r3.comments === 3 && r3.shares === 1 && r3.reactions === 6 && r3.views === 150 &&
  r3.entry_count === 2,
  JSON.stringify(r3));

// VM4: custom weights override defaults
// 1 comment with weight 100 = 100, instead of default 10
const r4 = computeMass(
  [{ metrics: { comments: 1 } }],
  { weights: { comments: 100 } }
);
check('VM4 custom weights override',
  r4.composite_score === 100 &&
  r4.weights.comments === 100 &&
  // other weights still default
  r4.weights.shares === DEFAULT_WEIGHTS.shares &&
  r4.weights.reactions === DEFAULT_WEIGHTS.reactions &&
  r4.weights.views === DEFAULT_WEIGHTS.views,
  JSON.stringify(r4));

// VM5: malformed entries (null / no metrics) skipped silently
const r5 = computeMass([
  null,
  undefined,
  { metrics: { comments: 5 } }, // 5 × 10 = 50
  { /* no metrics */ },
  'not-an-object',
  42,
  { metrics: null },
  { metrics: { comments: 'NaN-string' } }, // Number(...) → NaN → coerced to 0
]);
check('VM5 malformed entries skipped',
  r5.composite_score === 50 && r5.comments === 5 && r5.entry_count === 8,
  JSON.stringify(r5));

console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail === 0 ? 0 : 1);
