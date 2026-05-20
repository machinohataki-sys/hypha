#!/usr/bin/env node
'use strict';

// HYPHA · Phase C · _dev_verify_lifetime_schema (2026-05-17, Agent C / Glue)
//
// Schema smoke for the 5-axis output_targets emitted by agent.js planChain
// (Phase C.2) and read by screen-chain-plan.jsx (Phase C.4).
//
// We do NOT call the live LLM (slow + costs tokens + flaky in CI). Instead
// we feed an inline-mocked planChain return that mirrors §5008-§5020 of the
// prompt block (chain.links[*] output_targets array with axes ∈ AXES).
// This validates:
//
//   1. AXES enum + ARCHETYPE_AXIS_SET load from app/lib/lifetime-ledger/axes.js
//   2. HUMANITIES archetype yields 5 axes; every axis ∈ AXES.
//   3. Each link.output_targets entry has {axis, unit?, count} where count is
//      a finite number ≥ 0 and axis ∈ AXES.
//   4. link.frontier_axis_p50 is object-or-null (null is legitimate per
//      agent.js:5024 "If you don't know, set field to null").
//   5. The reader fallback (_readAxes) gracefully returns an empty array when
//      output_targets is missing — UI must not throw on legacy chains.
//
// Run:  node app/scripts/_dev_verify_lifetime_schema.js
// Exit: 0 = PASS N/N, 1 = any FAIL.

const path = require('path');

const results = [];
function record(name, ok, msg) {
  results.push({ name, ok, msg });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${msg ? '  ' + msg : ''}`);
}

// ─── Test 1: axes module loads + AXES enum present ─────────────────────
let AXES, ARCHETYPE_AXIS_SET, axisesForArchetype;
try {
  ({ AXES, ARCHETYPE_AXIS_SET, axisesForArchetype } = require('../lib/lifetime-ledger/axes'));
  record(
    'axes module loads',
    Array.isArray(AXES) && AXES.length === 5,
    `AXES=[${AXES.join(',')}]`,
  );
  record(
    'AXES has expected 5 entries',
    ['learn', 'practice', 'produce', 'read', 'reflect'].every(a => AXES.includes(a)),
    '(learn / practice / produce / read / reflect)',
  );
} catch (e) {
  record('axes module loads', false, e.message);
  process.exit(1);
}

// ─── Test 2: HUMANITIES archetype yields 5 axes ────────────────────────
const humanitiesAxes = axisesForArchetype('HUMANITIES');
record(
  'HUMANITIES archetype → 5 axes',
  Array.isArray(humanitiesAxes) && humanitiesAxes.length === 5,
  `got=[${humanitiesAxes.join(',')}]`,
);
record(
  'HUMANITIES axes ⊆ AXES',
  humanitiesAxes.every(a => AXES.includes(a)),
  '(every HUMANITIES axis is a canonical AXES entry)',
);

// ─── Mock planChain output (HUMANITIES, mirrors agent.js:5012-5020) ────
const mockChain = {
  ultimate_goal: '出版一部诺奖文学的小说',
  archetype: 'HUMANITIES',
  chain: {
    links: [
      {
        topic: '20 世纪现代主义诗学',
        role: 'prerequisite',
        duration_weeks: 12,
        lessons_count: 35,
        rationale: '没有诗学语言后面的形式批判只能直觉化',
        exit_criterion: '从 focalization / chronotope 两套术语对当代小说作 2000 字技术分析',
        output_targets: [
          { axis: 'learn',    unit: '流派',       count: 8 },
          { axis: 'practice', unit: '精读片段',   count: 120 },
          { axis: 'produce',  unit: '札记',       count: 30 },
          { axis: 'read',     unit: '本',         count: 35 },
          { axis: 'reflect',  unit: '论辩往返',   count: 10 },
        ],
        frontier_axis_p50: { learn: 8, practice: 100, produce: 25, read: 30, reflect: 8 },
      },
      {
        topic: '20 世纪诺奖代表作精读',
        role: 'core',
        duration_weeks: 24,
        lessons_count: 90,
        rationale: '建立诺奖审美坐标',
        exit_criterion: '能指认 Marquez/Coetzee/大江的代表性形式特征并比较',
        output_targets: [
          { axis: 'learn',    unit: '作家',       count: 16 },
          { axis: 'practice', unit: '精读章节',   count: 220 },
          { axis: 'produce',  unit: '比较札记',   count: 60 },
          { axis: 'read',     unit: '本',         count: 80 },
          { axis: 'reflect',  unit: '论辩往返',   count: 28 },
        ],
        frontier_axis_p50: null, // legitimately unknown per agent.js:5024
      },
      // Edge case: legacy link missing output_targets — UI must fall back, not crash.
      {
        topic: '叙事身份与作者位置',
        role: 'core',
        duration_weeks: 8,
        lessons_count: 25,
        rationale: '没有作者位置 form 只是模仿',
        exit_criterion: '能在 2000 字内陈述自己写作的立场假设并接受反驳',
        // output_targets omitted deliberately
      },
    ],
    ultimate_goal: '出版一部诺奖文学的小说',
  },
};

// ─── Test 3: every link with output_targets has 5 well-formed entries ──
const linksWithTargets = mockChain.chain.links.filter(l => Array.isArray(l.output_targets));
record(
  'links carrying output_targets',
  linksWithTargets.length === 2,
  `${linksWithTargets.length} link(s) carry output_targets (1 legacy stub)`,
);
for (let i = 0; i < linksWithTargets.length; i++) {
  const link = linksWithTargets[i];
  record(
    `link[${i}] output_targets length === 5 (HUMANITIES)`,
    link.output_targets.length === 5,
    `topic="${link.topic}" len=${link.output_targets.length}`,
  );
  const axesSeen = link.output_targets.map(t => t.axis);
  record(
    `link[${i}] every axis ∈ AXES`,
    axesSeen.every(a => AXES.includes(a)),
    `axes=[${axesSeen.join(',')}]`,
  );
  record(
    `link[${i}] every count is finite number ≥ 0`,
    link.output_targets.every(t => Number.isFinite(t.count) && t.count >= 0),
    '(no NaN / negative / undefined counts)',
  );
}

// ─── Test 4: frontier_axis_p50 object-or-null ──────────────────────────
for (let i = 0; i < linksWithTargets.length; i++) {
  const link = linksWithTargets[i];
  const fp = link.frontier_axis_p50;
  const isObjOrNull = fp === null || (typeof fp === 'object' && fp !== undefined);
  record(
    `link[${i}] frontier_axis_p50 is object-or-null`,
    isObjOrNull,
    `value=${JSON.stringify(fp)}`,
  );
}

// ─── Test 5: _readAxes fallback never throws on missing output_targets ──
// This mirrors the reader screen-chain-plan.jsx WILL ship in Phase C.4. Until
// that lands, smoke owns the canonical fallback shape so any future reader
// matches. Returns [] when targets are absent, [...]-of-{axis,count} when present.
function _readAxes(link) {
  if (!link || !Array.isArray(link.output_targets)) return [];
  return link.output_targets
    .filter(t => t && typeof t.axis === 'string' && AXES.includes(t.axis))
    .map(t => ({ axis: t.axis, count: Number(t.count) || 0, unit: t.unit || '' }));
}

const legacyLink = mockChain.chain.links[2]; // missing output_targets
let legacyThrew = false;
let legacyResult = null;
try { legacyResult = _readAxes(legacyLink); }
catch (e) { legacyThrew = true; record('_readAxes legacy fallback', false, e.message); }
if (!legacyThrew) {
  record(
    '_readAxes(missing-targets) returns []',
    Array.isArray(legacyResult) && legacyResult.length === 0,
    `result=${JSON.stringify(legacyResult)}`,
  );
}
const fullResult = _readAxes(linksWithTargets[0]);
record(
  '_readAxes(full link) returns 5 typed rows',
  Array.isArray(fullResult) && fullResult.length === 5
    && fullResult.every(r => AXES.includes(r.axis) && typeof r.count === 'number'),
  `len=${fullResult.length}`,
);

// ─── Test 6: null safety on garbage input ──────────────────────────────
try {
  record('_readAxes(null) === []', JSON.stringify(_readAxes(null)) === '[]', '');
  record('_readAxes(undefined) === []', JSON.stringify(_readAxes(undefined)) === '[]', '');
  record('_readAxes({}) === []', JSON.stringify(_readAxes({})) === '[]', '');
} catch (e) {
  record('_readAxes null-safety', false, e.message);
}

// ─── Summary ───────────────────────────────────────────────────────────
const passN = results.filter(r => r.ok).length;
const failN = results.length - passN;
console.log('');
console.log(`PASS ${passN}/${results.length}` + (failN > 0 ? `  (${failN} FAIL)` : ''));
process.exit(failN > 0 ? 1 : 0);
