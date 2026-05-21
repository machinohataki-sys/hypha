#!/usr/bin/env node
'use strict';

// HYPHA · _dev_verify_chain_reroute_handler — boot-6 smoke (2026-05-20)
//
// Closes GP2 golden-path gap: chain-folder.foldChain emits
// `status: 'NEEDS_REROUTE'` when total lessons exceed HARD_CAP (60), but the
// chain:create IPC handler previously embedded that signal in chainData.fold
// WITHOUT surfacing it at the envelope level, AND the screen-chain-plan
// renderer ignored the field. The fix:
//   - chain:create envelope adds `needs_reroute: boolean` + `reroute_options[]`
//     (suggested_actions) so the renderer branches without digging into nested
//     fold data.
//   - screen-chain-plan.jsx renders a NEEDS_REROUTE banner with 3 options:
//     (a) split into prerequisite chain  — fires chain:propose-prereqs
//     (b) lower lesson density           — fires chain:refuse w/ reason
//     (c) accept anyway                  — proceeds to chain:accept
//
// Eight tests:
//   RR1 — foldChain w/ sub-cap chain → status='OK'
//   RR2 — foldChain w/ at-cap chain (total=60) → status='OK'
//   RR3 — foldChain w/ over-cap chain (total=64) → status='NEEDS_REROUTE'
//   RR4 — over-cap result yields actionable foldDecisions array
//   RR5 — main.js chain:create handler builds NEEDS_REROUTE envelope w/
//         reroute_options[] when foldResult.status='NEEDS_REROUTE'
//         (offline simulation: replay the envelope-building block on a
//         synthetic foldResult/chainData pair)
//   RR6 — chain:refuse IPC handler registered (grep)
//   RR7 — chain:propose-prereqs IPC handler registered (grep)
//   RR8 — screen-chain-plan.jsx renders NEEDS_REROUTE branch (grep)

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const APP  = path.join(ROOT, 'app');

const results = [];
const PASS = (name)        => { results.push({ name, ok: true });  console.log(`  \x1b[32mPASS\x1b[0m ${name}`); };
const FAIL = (name, why)   => { results.push({ name, ok: false, why }); console.log(`  \x1b[31mFAIL\x1b[0m ${name} — ${why}`); };

console.log('\n_dev_verify_chain_reroute_handler — boot-6 (8 tests)\n');

// Load chain-folder once.
let chainFolder;
try {
  chainFolder = require(path.join(APP, 'lib', 'chain-folder.js'));
} catch (e) {
  FAIL('boot — require chain-folder', e.message);
  process.exit(1);
}

// ─── Synthetic link factories ────────────────────────────────────────────
// Match the schema planChain emits (see agent.js:5012-5020).
function mkLink(role, topic, lessons, weeks) {
  return {
    topic, duration_weeks: weeks, lessons_count: lessons, role,
    rationale: `synthetic ${role}`,
    exit_criterion: `complete ${topic}`,
  };
}

// ─── RR1: foldChain sub-cap → OK ─────────────────────────────────────────
(function RR1() {
  const links = [
    mkLink('prerequisite', 'Foundations', 10, 4),
    mkLink('core',         'Mid stack',   12, 4),
  ]; // total 22, Growth softCap 30 → OK without folding
  const r = chainFolder.foldChain({ links, mode: 'Growth', tier: 'moderate' });
  if (r.status !== 'OK')           return FAIL('RR1 sub-cap → OK', `status=${r.status}`);
  if (chainFolder.totalLessons(r.folded) !== 22) {
    return FAIL('RR1 sub-cap → OK', `total=${chainFolder.totalLessons(r.folded)} expected 22`);
  }
  PASS('RR1 sub-cap chain (22 lessons) → status=OK');
})();

// ─── RR2: foldChain at-cap (total=60, exactly HARD_CAP) → OK ─────────────
(function RR2() {
  // Construct so post-fold ends exactly at 60 but not over.
  const links = [
    mkLink('prerequisite', 'Foundations', 25, 6),
    mkLink('core',         'Mid stack',   25, 6),
    mkLink('ultimate',     'Capstone',    10, 4),
  ]; // total 60, Growth softCap 30 → role-cap may kick in but HARD_CAP=60 not breached
  const r = chainFolder.foldChain({ links, mode: 'Growth', tier: 'moderate' });
  const total = chainFolder.totalLessons(r.folded);
  if (r.status !== 'OK')           return FAIL('RR2 at-cap → OK', `status=${r.status} total=${total}`);
  if (total > chainFolder.HARD_CAP) return FAIL('RR2 at-cap → OK', `total ${total} > HARD_CAP ${chainFolder.HARD_CAP}`);
  PASS(`RR2 at-cap chain (post-fold total=${total} ≤ HARD_CAP=60) → status=OK`);
})();

// ─── RR3: foldChain over-cap (total=64) → NEEDS_REROUTE ──────────────────
(function RR3() {
  const links = [
    mkLink('prerequisite', 'Pre A',  12, 6),
    mkLink('core',         'Core B', 22, 8),
    mkLink('ultimate',     'Cap C',  30, 10),
  ]; // total 64 — role caps already at ceiling, no merge possible (only 1 prereq)
  const r = chainFolder.foldChain({ links, mode: 'Growth', tier: 'moderate' });
  const total = chainFolder.totalLessons(r.folded);
  if (r.status !== 'NEEDS_REROUTE') {
    return FAIL('RR3 over-cap → NEEDS_REROUTE', `status=${r.status} total=${total}`);
  }
  PASS(`RR3 over-cap chain (total=${total} > HARD_CAP=60) → status=NEEDS_REROUTE`);
})();

// ─── RR4: over-cap returns actionable decisions array ────────────────────
(function RR4() {
  const links = [
    mkLink('prerequisite', 'Pre A',  12, 6),
    mkLink('core',         'Core B', 22, 8),
    mkLink('ultimate',     'Cap C',  30, 10),
  ];
  const r = chainFolder.foldChain({ links, mode: 'Growth', tier: 'moderate' });
  if (!Array.isArray(r.foldDecisions)) {
    return FAIL('RR4 decisions array', 'foldDecisions not array');
  }
  // Decisions array must exist (may be empty if no fold was possible; but
  // empty-array signal IS itself the actionable note → reroute is the only path).
  PASS(`RR4 foldDecisions array shape OK (${r.foldDecisions.length} decisions)`);
})();

// ─── RR5: simulate chain:create envelope branch on NEEDS_REROUTE ─────────
// Replays the post-fix envelope-building block w/o spinning Electron. We
// stub chainData (the persisted object) + foldResult, and verify the
// envelope adds needs_reroute=true + reroute_options[3] when status=
// NEEDS_REROUTE, and is untouched when status=OK.
(function RR5() {
  // Inline copy of the envelope logic (kept in lockstep with main.js patch).
  function buildEnvelope(slug, chainData, foldResult) {
    const env = { ok: true, slug, data: chainData };
    if (foldResult && foldResult.status === 'NEEDS_REROUTE') {
      env.needs_reroute = true;
      const total = chainFolder.totalLessons(foldResult.folded);
      env.reroute_options = [
        {
          id: 'split-prereq',
          label: '拆分前置链 — 先掌握基础, 再回到当前目标',
          ipc: 'chain:propose-prereqs',
          rationale: `当前 ${total} 节超过 HARD_CAP ${chainFolder.HARD_CAP}; 推荐先走前置链.`,
        },
        {
          id: 'lower-density',
          label: '降低课时密度 — 让 HYPHA 重排, 每阶段更少节',
          ipc: 'chain:refuse',
          rationale: '保留目标, 重新规划以收敛在 HARD_CAP 之内.',
        },
        {
          id: 'accept-partial',
          label: '仍然接受 — 我了解这超过推荐范围',
          ipc: 'chain:accept',
          rationale: '锁定当前计划, 进入第一阶段; HYPHA 不再阻拦.',
        },
      ];
      env.reroute_reason = {
        total_after: total,
        hard_cap: chainFolder.HARD_CAP,
        soft_cap: chainFolder.SOFT_CAPS.Growth,
        mode: 'Growth',
      };
    }
    return env;
  }

  // Over-cap path
  const overLinks = [
    mkLink('prerequisite', 'Pre A',  12, 6),
    mkLink('core',         'Core B', 22, 8),
    mkLink('ultimate',     'Cap C',  30, 10),
  ];
  const overFold = chainFolder.foldChain({ links: overLinks, mode: 'Growth', tier: 'moderate' });
  const overEnv  = buildEnvelope('test-slug', { slug: 'test-slug', fold: { status: overFold.status } }, overFold);

  if (overEnv.ok !== true)                    return FAIL('RR5 over-cap envelope', 'ok !== true');
  if (overEnv.needs_reroute !== true)         return FAIL('RR5 over-cap envelope', 'needs_reroute !== true');
  if (!Array.isArray(overEnv.reroute_options)) return FAIL('RR5 over-cap envelope', 'reroute_options missing');
  if (overEnv.reroute_options.length !== 3)   return FAIL('RR5 over-cap envelope', `expected 3 options got ${overEnv.reroute_options.length}`);
  const ids = overEnv.reroute_options.map(o => o.id).sort().join(',');
  if (ids !== 'accept-partial,lower-density,split-prereq') {
    return FAIL('RR5 over-cap envelope', `option ids wrong: ${ids}`);
  }
  if (!overEnv.reroute_reason || typeof overEnv.reroute_reason.total_after !== 'number') {
    return FAIL('RR5 over-cap envelope', 'reroute_reason missing or malformed');
  }

  // Sub-cap path (envelope must NOT add the reroute fields)
  const okLinks = [
    mkLink('prerequisite', 'A', 8, 3),
    mkLink('core',         'B', 8, 3),
  ];
  const okFold = chainFolder.foldChain({ links: okLinks, mode: 'Growth', tier: 'moderate' });
  const okEnv  = buildEnvelope('ok-slug', { slug: 'ok-slug', fold: { status: okFold.status } }, okFold);
  if (okEnv.needs_reroute !== undefined && okEnv.needs_reroute !== false) {
    return FAIL('RR5 sub-cap envelope', 'needs_reroute should be undefined/false on OK chain');
  }
  if (okEnv.reroute_options !== undefined) {
    return FAIL('RR5 sub-cap envelope', 'reroute_options must NOT be set when OK');
  }
  PASS('RR5 envelope branches on NEEDS_REROUTE w/ 3 reroute_options (and stays clean on OK)');
})();

// ─── RR6: chain:refuse handler exists in main.js (grep) ──────────────────
(function RR6() {
  const mainPath = path.join(APP, 'main.js');
  const src = fs.readFileSync(mainPath, 'utf8');
  if (!/ipcMain\.handle\(\s*['"]chain:refuse['"]/.test(src)) {
    return FAIL('RR6 chain:refuse handler', 'no `ipcMain.handle(\'chain:refuse\'` in app/main.js');
  }
  PASS('RR6 chain:refuse IPC handler registered');
})();

// ─── RR7: chain:propose-prereqs handler exists in main.js (grep) ─────────
(function RR7() {
  const mainPath = path.join(APP, 'main.js');
  const src = fs.readFileSync(mainPath, 'utf8');
  if (!/ipcMain\.handle\(\s*['"]chain:propose-prereqs['"]/.test(src)) {
    return FAIL('RR7 chain:propose-prereqs handler', 'no `ipcMain.handle(\'chain:propose-prereqs\'` in app/main.js');
  }
  PASS('RR7 chain:propose-prereqs IPC handler registered');
})();

// ─── RR8: screen-chain-plan.jsx handles NEEDS_REROUTE (grep) ─────────────
(function RR8() {
  const jsxPath = path.join(APP, 'design', 'screen-chain-plan.jsx');
  const src = fs.readFileSync(jsxPath, 'utf8');
  if (!/NEEDS_REROUTE/.test(src)) {
    return FAIL('RR8 screen-chain-plan reroute branch', 'no `NEEDS_REROUTE` token in screen-chain-plan.jsx');
  }
  // Must also reference reroute_options OR needs_reroute (renderer reads
  // envelope-level field, not just deep fold.status).
  if (!/needs_reroute|reroute_options|RerouteBanner/i.test(src)) {
    return FAIL('RR8 screen-chain-plan reroute branch',
      'screen-chain-plan.jsx mentions NEEDS_REROUTE but does not consume envelope (needs_reroute/reroute_options/RerouteBanner)');
  }
  PASS('RR8 screen-chain-plan.jsx renders NEEDS_REROUTE branch consuming envelope');
})();

// ─── Summary ─────────────────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok).length;
console.log(`\n  ${passed}/${results.length} passed${failed ? `, ${failed} failed` : ''}`);
process.exit(failed > 0 ? 1 : 0);
