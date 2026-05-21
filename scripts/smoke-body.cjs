'use strict';

/**
 * HYPHA · Lesson body generator smoke — v0.1 sub-step F.
 *
 * Calls generateLessonBody() with 1 hardcoded plan (4 path steps), asserts
 * body shape: intro_prose string >50 chars, path_prose length === 4,
 * step_id sequence i/ii/iii/iv, closing_prose string >50 chars.
 *
 * Requires GLM_API_KEY env var. Single LLM call, ~10-20s.
 *
 * Usage: $env:GLM_API_KEY = '...' ; node scripts/smoke-body.cjs
 */

const path = require('path');
const lg = require(path.resolve(__dirname, '..', 'app', 'lib', 'lesson-generator.js'));

const PLAN = {
  objective: 'Identify the inputs and outputs of a single workflow step.',
  prerequisite_check: '你能描述一个工作流当前的输入和输出吗?',
  hook_concrete: '一个工作流接收一份订单数据, 决定是否扣库存. 这一步的输入和输出可以画在一张白纸上.',
  path: [
    '画一张白纸, 标记本工作流当前一步的所有输入字段.',
    '在同一张纸上, 列出这一步对外发出的输出字段.',
    '为每个输出字段, 写一句话说明它依赖哪些输入字段.',
    '把这张图给一个不熟悉这块业务的同事看, 让他用自己话复述一遍.',
  ],
  micro_proof: {
    stimulus: '把你画的输入输出图 + 同事复述的文字粘贴在 STIMULUS 区.',
    expected_signal: '输出至少 2 个字段, 每个字段映射 ≥1 输入; 复述包含字段名 ≥3 个.',
    fail_mode: '只画输入不画输出 / 复述只用术语不用具体字段名.',
  },
  next_lesson_seed: '下一节: 把这张图改成可执行的 1 步代码.',
};

const GOAL = {
  north_star_goal: '搭建一个能跑的 AI 工作流',
  current_level: '零基础',
  learning_model: 'Growth',
  deadline: null,
  main_creation: '订单工作流原型',
  core_competencies: ['工作流思维', '输入输出建模', '产品判断'],
  forbidden_drifts: ['空泛聊天', '过多黑话'],
  discipline_mode: 'guided',
};

(async () => {
  console.log('=== HYPHA Lesson body smoke (sub-step F) ===\n');
  const t0 = Date.now();

  let result;
  try {
    result = await lg.generateLessonBody({
      plan: PLAN,
      goalContract: GOAL,
      audience: 'self-directed adult learner',
      learnerState: { known: ['javascript'], unknown: ['workflow design'] },
    });
  } catch (e) {
    console.error('[FAIL] generateLessonBody threw:', e.message);
    process.exit(1);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const body = result && result.body;

  if (!body) {
    console.error('[FAIL] no body in result:', JSON.stringify(result));
    process.exit(1);
  }

  let pass = 0, fail = 0;
  function assert(cond, label, detail) {
    if (cond) {
      console.log(`  [PASS] ${label}`);
      pass++;
    } else {
      console.log(`  [FAIL] ${label} -- ${detail}`);
      fail++;
    }
  }

  console.log(`Generated in ${elapsed}s. Asserting shape:\n`);

  assert(typeof body.intro_prose === 'string', 'intro_prose is string', `got ${typeof body.intro_prose}`);
  assert(body.intro_prose && body.intro_prose.length > 50, 'intro_prose >50 chars', `len=${(body.intro_prose || '').length}`);
  assert(Array.isArray(body.path_prose), 'path_prose is array', `got ${typeof body.path_prose}`);
  assert(Array.isArray(body.path_prose) && body.path_prose.length === PLAN.path.length, `path_prose length === ${PLAN.path.length}`, `got ${body.path_prose && body.path_prose.length}`);
  if (Array.isArray(body.path_prose)) {
    const expected = ['i', 'ii', 'iii', 'iv'];
    body.path_prose.forEach((item, i) => {
      assert(item && item.step_id === expected[i], `path_prose[${i}].step_id === "${expected[i]}"`, `got "${item && item.step_id}"`);
      assert(item && typeof item.prose === 'string' && item.prose.length >= 20, `path_prose[${i}].prose >=20 chars`, `len=${item && item.prose && item.prose.length}`);
    });
  }
  assert(typeof body.closing_prose === 'string', 'closing_prose is string', `got ${typeof body.closing_prose}`);
  assert(body.closing_prose && body.closing_prose.length > 50, 'closing_prose >50 chars', `len=${(body.closing_prose || '').length}`);

  console.log(`\n--- Sample output ---`);
  console.log(`intro_prose (${body.intro_prose.length} chars):\n  ${body.intro_prose.slice(0, 200)}${body.intro_prose.length > 200 ? '...' : ''}`);
  console.log(`\npath_prose[0] (${(body.path_prose[0] || {}).prose?.length} chars):\n  step_id=${(body.path_prose[0] || {}).step_id}\n  ${(body.path_prose[0] || {}).prose?.slice(0, 200) || ''}`);
  console.log(`\nclosing_prose (${body.closing_prose.length} chars):\n  ${body.closing_prose.slice(0, 200)}${body.closing_prose.length > 200 ? '...' : ''}`);

  console.log(`\nSummary: ${pass} passed / ${fail} failed (${elapsed}s)`);
  process.exit(fail === 0 ? 0 : 1);
})();
