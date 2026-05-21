#!/usr/bin/env node
'use strict';

// RUN_SEQUENTIAL — LLM-bound, parallel pool causes rate-limit / timeout
// SKIP_HEADLESS — needs GLM_API_KEY (or equivalent provider key) in env; CI fresh-runners don't carry secrets on PR.

// HYPHA · _dev_verify_route_goal — smoke test for Pillar 1 dispatcher.
//
// Verifies that `app/lib/creation/route-goal.js` correctly forks ambitious
// goals to chain plan and modest goals to single curriculum.
//
// Test cases (locked by user 2026-05-17):
//   1. "成为诺贝尔文学奖得主"        (difficulty 0.95) → flow='chain'
//   2. "学 React Hooks 1 周入门"     (difficulty ~0.2) → flow='single'
//   3. "出版一本小说"                (difficulty 0.65) → flow='single' (差 0.05)
//   4. ""                            (empty goal, fallback) → flow='single'
//
// Run:
//   node app/scripts/_dev_verify_route_goal.js
//
// Exit 0 = PASS N/N, Exit 1 = at least one failure.

const path = require('path');
const { routeGoal } = require(path.join(__dirname, '..', 'lib', 'creation', 'route-goal.js'));

const CASES = [
  {
    name: '诺贝尔文学奖 (difficulty 0.95)',
    goalContract: { north_star_goal: '成为诺贝尔文学奖得主' },
    expectFlow: 'chain',
  },
  {
    name: 'React Hooks 1 周入门 (difficulty ~0.2)',
    goalContract: { north_star_goal: '学 React Hooks 1 周入门' },
    expectFlow: 'single',
  },
  {
    name: '出版小说 (difficulty 0.65, 差 0.05 没到阈)',
    goalContract: { north_star_goal: '出版一本小说' },
    expectFlow: 'single',
  },
  {
    name: '空 goal (fallback)',
    goalContract: { north_star_goal: '' },
    expectFlow: 'single',
  },
];

(async () => {
  let pass = 0;
  let fail = 0;
  for (const c of CASES) {
    try {
      const r = await routeGoal({ goalContract: c.goalContract, archetype: null });
      const ok = r && r.flow === c.expectFlow;
      const tag = ok ? 'PASS' : 'FAIL';
      console.log(
        `[${tag}] ${c.name}\n` +
          `        expect=${c.expectFlow}  got=${r && r.flow}\n` +
          `        difficulty=${r && r.difficulty != null ? r.difficulty.toFixed(2) : '?'}  ` +
          `years=${r && r.conservative_years}  ` +
          `estimator_used=${r && r.estimator_used}\n` +
          `        reason="${r && r.reason}"`,
      );
      if (ok) pass += 1;
      else fail += 1;
    } catch (err) {
      console.log(`[FAIL] ${c.name}\n        threw: ${err && err.message}`);
      fail += 1;
    }
  }
  const total = pass + fail;
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} ${pass}/${total}`);
  process.exit(fail === 0 ? 0 : 1);
})();
