#!/usr/bin/env node
'use strict';

/**
 * HYPHA · v0.1 G1 acceptance gate form printer — inter-rater reliability.
 *
 * Reads scripts/g1-fixture.json (5 cases), prints a markdown form for two
 * independent testers to fill out. Each tester:
 *   1. Reads stimulus + expected_signal + fail_mode + user_response
 *   2. Scores 0-100 (does the response demonstrate the expected signal?)
 *   3. Writes 1-line reason
 *
 * After both testers fill, compute |score_A - score_B| per row.
 * PASS: max diff ≤ 15 across all 5 cases.
 *
 * Usage:
 *   node scripts/g1-blank-form.cjs > g1-form.md
 *   # Send g1-form.md to tester A and tester B (independently)
 *   # Collect filled forms back, compute diffs in spreadsheet.
 */

const path = require('path');
const fs = require('fs');

const FIXTURE_PATH = path.resolve(__dirname, 'g1-fixture.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

const lines = [];
lines.push('# HYPHA G1 — Inter-Rater Reliability Form');
lines.push('');
lines.push('**Instructions for tester:**');
lines.push('1. For each of the 5 cases below, read the **Stimulus**, **Expected signal**, **Fail mode**, and **User response**.');
lines.push('2. Score 0–100: how well does the user response demonstrate the expected signal? (100 = perfect; 0 = zero match.)');
lines.push('3. Write a 1-line reason for your score.');
lines.push('4. Do NOT discuss with the other tester until both forms are submitted.');
lines.push('');
lines.push('**Pass criteria (computed after both forms are in):** max |score_A − score_B| ≤ 15 across all 5 cases.');
lines.push('');
lines.push('---');
lines.push('');

for (let i = 0; i < fixture.cases.length; i++) {
  const c = fixture.cases[i];
  lines.push(`## Case ${i + 1}: ${c.name}`);
  lines.push('');
  lines.push(`**Stimulus**: ${c.stimulus}`);
  lines.push('');
  lines.push(`**Expected signal**: ${c.expected_signal}`);
  lines.push('');
  lines.push(`**Fail mode**: ${c.fail_mode}`);
  lines.push('');
  lines.push(`**User response**:`);
  lines.push('');
  lines.push('```');
  lines.push(c.user_response);
  lines.push('```');
  lines.push('');
  lines.push(`**Your score (0-100)**: ____`);
  lines.push('');
  lines.push(`**Reason (1 line)**: ____________________________________________`);
  lines.push('');
  lines.push('---');
  lines.push('');
}

lines.push('## After both forms are filled');
lines.push('');
lines.push('| Case | score_A | score_B | abs(diff) | binary_A (pass/fail at ≥60) | binary_B | agree? |');
lines.push('|---|---:|---:|---:|---|---|---|');
for (let i = 0; i < fixture.cases.length; i++) {
  lines.push(`| ${fixture.cases[i].name} | | | | | | |`);
}
lines.push('');
lines.push('**Pass G1 if**: max abs(diff) ≤ 15 AND Cohen\'s κ on binary ≥ 0.6.');
lines.push('');

console.log(lines.join('\n'));
