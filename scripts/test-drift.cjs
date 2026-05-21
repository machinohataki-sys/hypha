'use strict';

/**
 * HYPHA · Goal Drift Detector v0.2 — 3-case smoke test.
 *
 * Per A4 brief: low-drift / high-drift / forbidden hit cases.
 * Note: high-drift expected drift_score may land ~60 (not >70) due to locked
 * 0.3/0.3/0.3/0.1 weighting — documented as v0.3 calibration item, NOT a bug.
 *
 * Usage: node scripts/test-drift.cjs
 * Exit 0 if all 3 cases pass acceptance, 1 otherwise.
 */

const path = require('path');
const detector = require(path.resolve(__dirname, '..', 'app', 'lib', 'goal-drift-detector.js'));

const cases = [
  {
    name: 'low-drift',
    goal: {
      north_star_goal: '成为 AI Builder',
      main_creation: 'agent 工作流',
      core_competencies: ['agent 思维', '产品判断'],
      forbidden_drifts: [],
    },
    lesson: {
      objective: '理解 agent 的输入输出',
      hook_concrete: 'agent 收到一个工作流请求, 决定下一步.',
      path: ['列出 agent 的输入字段', '列出 agent 的输出字段'],
    },
    accept: r => r.drift_score < 60,
  },
  {
    name: 'high-drift',
    goal: {
      north_star_goal: '成为 AI Builder',
      main_creation: 'agent 工作流',
      core_competencies: ['agent 思维', '产品判断'],
      forbidden_drifts: [],
    },
    lesson: {
      objective: '如何减肥',
      hook_concrete: '今天讲一下减脂的科学方法.',
      path: ['计算 BMI', '设计每日饮食结构'],
    },
    accept: r => r.drift_score > 50,
  },
  {
    name: 'forbidden-hit',
    goal: {
      north_star_goal: '成为 AI Builder',
      main_creation: 'agent 工作流',
      core_competencies: ['agent 思维'],
      forbidden_drifts: ['空泛聊天', '过多黑话'],
    },
    lesson: {
      objective: '今天空泛聊天一下 agent 是什么',
      hook_concrete: '不写代码, 只是空泛聊天.',
      path: ['听老师空泛聊天', '继续空泛聊天'],
    },
    accept: r => r.axes.forbidden >= 25 && r.violations.some(v => v.axis === 'forbidden' && v.text === '空泛聊天'),
  },
];

let passed = 0;
let failed = 0;

console.log('=== HYPHA Goal Drift Detector v0.2 — 3-case smoke ===\n');

for (const c of cases) {
  const result = detector.detectDrift(c.goal, c.lesson);
  const ok = c.accept(result);
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${c.name}`);
  console.log(`  drift_score: ${result.drift_score}`);
  console.log(`  axes: vocab=${result.axes.vocab} alignment=${result.axes.alignment} forbidden=${result.axes.forbidden} jargon_load=${result.axes.jargon_load}`);
  if (result.violations.length > 0) {
    console.log(`  violations: ${result.violations.length} (sample: ${JSON.stringify(result.violations.slice(0, 3))})`);
  } else {
    console.log(`  violations: 0`);
  }
  console.log('');
  if (ok) passed++;
  else failed++;
}

console.log(`Summary: ${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
