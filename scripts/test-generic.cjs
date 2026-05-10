'use strict';

/**
 * HYPHA · Anti-Generic-Course Detector v0.2 — 3-case smoke test.
 *
 * 1. low-generic    — body with concrete nouns + concrete examples → score < 30
 * 2. high-generic   — opener / closer / scholar filler dominant   → score > 60
 * 3. abstract-verbs — 提升用户体验 / 赋能业务 without object       → axes.abstract_verbs > 40
 *
 * Usage: node scripts/test-generic.cjs
 * Exit 0 if all 3 pass acceptance, 1 otherwise.
 */

const path = require('path');
const detector = require(path.resolve(__dirname, '..', 'app', 'lib', 'anti-generic-detector.js'));

const cases = [
  {
    name: 'low-generic',
    body: {
      intro_prose:
        '订单工作流由 5 个输入字段触发: 商品 ID, 数量, 收件地址, 支付凭证, 用户 token. 当数量 > 100 件时, 工作流转入批发审核分支.',
      path_prose: [
        {
          step_id: 'step-1',
          prose:
            '把商品 ID 映射到库存表. 库存表有 3 个字段: SKU 编码, 在途数量, 仓库位置. 在途数量 < 数量则触发缺货事件.',
        },
        {
          step_id: 'step-2',
          prose:
            '案例: SKU=A1024 库存 50 件, 用户下单 80 件, 系统分批 30 件北京仓 + 50 件上海仓发货, 工单号 W-20260508-001.',
        },
      ],
      closing_prose:
        '回到 SKU=A1024 这条工单, 你能列出 3 个会让分批失败的边界条件吗?',
    },
    accept: r => r.generic_score < 30,
  },
  {
    name: 'high-generic',
    body: {
      intro_prose:
        '今天我们来讲一个非常重要的内容. 在本节课中, 众所周知, 学习是一件需要持续付出的事情.',
      path_prose: [
        {
          step_id: 'step-1',
          prose:
            '首先, 我们要建立基础.\n其次, 我们要深化理解.\n再次, 我们要应用实践.\n最后, 我们要不断复盘.',
        },
        {
          step_id: 'step-2',
          prose:
            '毫无疑问, 这是显而易见的道理. 因此, 我们必须努力. 所以, 我们必须坚持. 由此可见, 学习就是这样.',
        },
      ],
      closing_prose:
        '总结一下, 综上所述, 希望大家通过本节课能够收获满满. 接下来我们继续下一节. 请大家记住今天的内容.',
    },
    accept: r => r.generic_score > 60,
  },
  {
    name: 'abstract-verb-trap',
    body: {
      intro_prose:
        '我们要提升, 我们要优化, 我们要赋能, 我们要重塑. 提升的关键在于优化, 优化的本质是赋能.',
      path_prose: [
        {
          step_id: 'step-1',
          prose: '提升是关键. 优化是手段. 赋能是结果. 重塑是方向. 革新是动力.',
        },
        {
          step_id: 'step-2',
          prose: '提升, 优化, 赋能, 重塑, 革新. 这些都需要持续推动.',
        },
      ],
      closing_prose: '提升思维, 优化路径, 赋能未来.',
    },
    accept: r => r.axes.abstract_verbs > 40,
  },
];

let passed = 0;
let failed = 0;

console.log('=== HYPHA Anti-Generic-Course Detector v0.2 — 3-case smoke ===\n');

for (const c of cases) {
  const result = detector.detectGeneric(c.body);
  const ok = c.accept(result);
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${c.name}`);
  console.log(`  generic_score: ${result.generic_score}`);
  console.log(
    `  axes: opener=${result.axes.opener} closer=${result.axes.closer} ` +
    `scholar_filler=${result.axes.scholar_filler} ` +
    `transition_overuse=${result.axes.transition_overuse} ` +
    `abstract_verbs=${result.axes.abstract_verbs} ` +
    `vague_examples=${result.axes.vague_examples} ` +
    `concrete_density=${result.axes.concrete_density}`
  );
  if (result.violations.length > 0) {
    console.log(
      `  violations: ${result.violations.length} (sample: ${JSON.stringify(result.violations.slice(0, 3))})`
    );
  } else {
    console.log('  violations: 0');
  }
  console.log('');
  if (ok) passed++;
  else failed++;
}

console.log(`Summary: ${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
