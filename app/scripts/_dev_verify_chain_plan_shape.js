#!/usr/bin/env node
'use strict';

// HYPHA · _dev_verify_chain_plan_shape — mount-shape smoke for the new
// design/screen-chain-plan.jsx screen (Gap 1 / Machino 2026-05-17).
//
// Electron boot is too heavy for CI/smoke; instead we:
//   1. Read the .jsx file off disk + run light static checks (export marker,
//      window.ChainPlanScreen expose, brace balance).
//   2. Shell out to `npx esbuild --loader:.jsx=jsx --bundle=false` to confirm
//      JSX/JS syntax compiles. Exit non-zero = test FAIL.
//   3. Transform the JSX in-process via the same esbuild CLI (capturing
//      stdout) and require()-eval the compiled CJS in a stub-React sandbox.
//      Then call ChainPlanScreen({slug, plan, buildLog, onAcceptChain,
//      onCancel}) with fake props to confirm it does not throw at mount.
//   4. Sanity-check that app.jsx's humanizeStage map carries 'route:decided'
//      (Pillar 1 routing signal — chain-plan only fires after this row, so
//      missing here = regression).
//
// Run:
//   node app/scripts/_dev_verify_chain_plan_shape.js
//
// Exit 0 = PASS N/N, exit 1 = any FAIL.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCREEN_REL = 'app/design/screen-chain-plan.jsx';
const SCREEN_ABS = path.join(ROOT, SCREEN_REL);
const APP_ABS = path.join(ROOT, 'app/design/app.jsx');

const results = [];
function record(name, ok, msg) {
  results.push({ name, ok, msg });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${msg ? '  ' + msg : ''}`);
}

// ─── Test 1: file exists ────────────────────────────────────────────────
let src = '';
try {
  src = fs.readFileSync(SCREEN_ABS, 'utf8');
  record('file exists', true, `${SCREEN_REL} (${src.length} bytes)`);
} catch (e) {
  record('file exists', false, e.message);
  // No file → nothing to test downstream.
  process.exit(1);
}

// ─── Test 2: window expose ──────────────────────────────────────────────
record(
  'window.ChainPlanScreen exposed',
  /window\.ChainPlanScreen\s*=\s*ChainPlanScreen/.test(src),
  '(expected `window.ChainPlanScreen = ChainPlanScreen` near end of file)',
);

// ─── Test 3: default function declaration ──────────────────────────────
record(
  'ChainPlanScreen declared',
  /const\s+ChainPlanScreen\s*=\s*\(\s*{[^}]*}\s*\)\s*=>/.test(src),
  '(expected arrow-function component declaration)',
);

// ─── Test 4: brace balance ─────────────────────────────────────────────
const openCount = (src.match(/{/g) || []).length;
const closeCount = (src.match(/}/g) || []).length;
record(
  'brace balance',
  openCount === closeCount,
  `open=${openCount}  close=${closeCount}`,
);

// ─── Test 5: esbuild syntax check ──────────────────────────────────────
const esbuildOut = spawnSync('npx', ['esbuild', SCREEN_REL, '--loader:.jsx=jsx', '--bundle=false'], {
  cwd: ROOT,
  shell: true,
  encoding: 'utf8',
});
record(
  'esbuild --loader:.jsx=jsx parses',
  esbuildOut.status === 0,
  esbuildOut.status === 0
    ? `(${esbuildOut.stdout.length} bytes compiled stdout)`
    : `exit=${esbuildOut.status}\n${(esbuildOut.stderr || '').slice(0, 400)}`,
);

// ─── Test 6: synthetic mount with fake props ───────────────────────────
// Take the compiled stdout from esbuild and require()-eval it in a stub
// sandbox. React is replaced with a stub that records createElement calls;
// useState/useMemo are stubbed to behave naturally. If ChainPlanScreen
// throws during render with fake props, this test fails.
if (esbuildOut.status === 0 && esbuildOut.stdout) {
  try {
    const compiled = esbuildOut.stdout;
    // Stub React: createElement returns a marker object; useState returns
    // [initial, ()=>{}]; useMemo invokes its factory immediately.
    const stubReact = {
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useState: (initial) => [initial, () => {}],
      useMemo: (fn /* , deps */) => fn(),
      Fragment: 'Fragment',
    };
    // Synthetic window so the trailing `window.ChainPlanScreen = ...` runs.
    const sandboxWindow = {};
    const fn = new Function('React', 'window', 'console', compiled);
    fn(stubReact, sandboxWindow, console);
    const Comp = sandboxWindow.ChainPlanScreen;
    if (typeof Comp !== 'function') {
      record('synthetic mount', false, 'window.ChainPlanScreen is not a function after eval');
    } else {
      const fakePlan = {
        ultimate_goal: '出版一部诺奖文学的小说',
        tier: 'moderate',
        feasibility: { tier: 'possible', years_p50: 5.5 },
        inputs: { timeWeeks: 156, dailyHours: 2, difficulty: 0.85 },
        chain: {
          links: [
            {
              topic: '小说叙事学 (Genette / Bakhtin)',
              role: 'prerequisite',
              duration_weeks: 8,
              lessons_count: 35,
              exit_criterion: '从 focalization / chronotope 两套术语对当代小说作 2000 字技术分析',
              rationale: '没有叙事学语言, 后面的形式实验就只能模仿不能命名',
            },
            {
              topic: '20 世纪诺奖代表作精读',
              role: 'core',
              duration_weeks: 24,
              lessons_count: 90,
              exit_criterion: '能够指认 Marquez / Coetzee / 大江的代表性形式特征并比较',
              rationale: '建立诺奖审美坐标',
            },
            {
              topic: '出版一部诺奖文学的小说',
              role: 'ultimate',
              duration_weeks: 124,
              lessons_count: 150,
              exit_criterion: '完成一部 120000 字以上、形式自洽的长篇小说初稿',
              rationale: '终点 = 真实交付',
            },
          ],
          ultimate_goal: '出版一部诺奖文学的小说',
        },
      };
      const fakeProps = {
        slug: 'chuban-yi-bu-nuojiang-wenxue',
        plan: fakePlan,
        buildLog: [
          { stage: 'route:decided', label: '规划路由 · chain · difficulty 0.85', ts: Date.now(), payload: {} },
          { stage: 'classifying', label: '认题型 · 开始', ts: Date.now(), payload: {} },
        ],
        onAcceptChain: async () => {},
        onCancel: () => {},
      };
      try {
        const tree = Comp(fakeProps);
        record('synthetic mount (full plan)', !!(tree && tree.type), `tree.type=${tree && tree.type}`);
      } catch (e) {
        record('synthetic mount (full plan)', false, e.message);
      }

      // Edge case: empty plan should render the recoverable stub, not throw.
      try {
        const tree = Comp({ slug: null, plan: null, buildLog: [], onAcceptChain: async () => {}, onCancel: () => {} });
        record('synthetic mount (empty plan)', !!(tree && tree.type), `tree.type=${tree && tree.type}`);
      } catch (e) {
        record('synthetic mount (empty plan)', false, e.message);
      }
    }
  } catch (e) {
    record('synthetic mount', false, e.message);
  }
} else {
  record('synthetic mount', false, 'skipped (esbuild did not produce stdout)');
}

// ─── Test 7: app.jsx humanizeStage carries 'route:decided' ─────────────
try {
  const appSrc = fs.readFileSync(APP_ABS, 'utf8');
  record(
    "app.jsx humanizeStage map has 'route:decided'",
    appSrc.includes("'route:decided'") || appSrc.includes('"route:decided"'),
    '(needed so chain plan trail row renders in BuildLog)',
  );
  record(
    "app.jsx route case 'chain-plan' exists",
    /case\s+["']chain-plan["']/.test(appSrc),
    '(needed for chain-plan setRoute target)',
  );
  record(
    'app.jsx imports ChainPlanScreen via window',
    appSrc.includes('window.ChainPlanScreen'),
    '(needed for the typeof guard pattern)',
  );
} catch (e) {
  record('app.jsx wiring checks', false, e.message);
}

// ─── Summary ───────────────────────────────────────────────────────────
const passN = results.filter(r => r.ok).length;
const failN = results.length - passN;
console.log('');
console.log(`PASS ${passN}/${results.length}` + (failN > 0 ? `  (${failN} FAIL)` : ''));
process.exit(failN > 0 ? 1 : 0);
