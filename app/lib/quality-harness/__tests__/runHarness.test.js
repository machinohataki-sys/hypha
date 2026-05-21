'use strict';
// HYPHA · W1.1 Quality Harness · runner tests (placeholder, W1.2 接真断言)
//
// intentional-placeholder: 当前 W1.1 = scaffold; 9 judges 返 score=0 mock 值,
// 没有可断言的真信号. W1.2 接 T4_JUDGE 后, 这些 test.todo 转 test() 跑 fixture.
//
// 测试 framework: 暂用 node:test (Node 18+ 内置). hypha 仓内目前无 jest,
// 不引依赖. W1.2 决定 framework 时再迁.

let test;
try {
  ({ test } = require('node:test'));
} catch (_) {
  test = (name, fn) => { if (typeof fn === 'function') return; };
  test.todo = (name) => {};
}

test.todo('runHarness: 10 dry-run samples 出 mock 报告, pass_rate 不抛错');
test.todo('runHarness: 6 failure samples 全判 FAIL (regression)');
test.todo('runHarness: 10 golden samples 全判 PASS (regression)');
test.todo('gradeLesson: 9 dim 输出 shape 一致 (score / rationale / evidence / pass)');
test.todo('gradeLesson: hyphaSoul 双倍权重在 overall_score 公式生效');
test.todo('gradeLesson: weakest_dim 选最低分维 + 并列时取最早顺序');
test.todo('gradeLesson: judge crash 不传染, 单 judge fail 不杀整 grade');
test.todo('runHarness: --ci 模式 pass_rate < 80% exit 1');
