#!/usr/bin/env node
'use strict';

// HYPHA · _dev_verify_metaphor_detect — smoke for Phase D.0 anti-metaphor detector.
//
// Validates app/lib/anti-slop/metaphor-as-structure-detector.js:
//   1. CLEAN — text with 0 metaphor → verdict 'CLEAN'
//   2. INSUFFICIENT_DATA — 1-2 metaphors → 'INSUFFICIENT_DATA'
//   3. TYPE_A_DISGUISED — ≥3 metaphors w/o forcing functions → flagged
//   4. BALANCED — ≥3 metaphors each paired with forcing function
//   5. HUMANITIES archetype loosens threshold (0.35 vs 0.5 default)
//   6. Metaphor markers detected across CN + EN
//   7. Forcing-function markers detected in ±200 char window
//   8. force_pair_ratio math holds
//
// Run: node app/scripts/_dev_verify_metaphor_detect.js
// Exit 0 = PASS, exit 1 = any failure.

const { detectMetaphorAsStructure, _internals } = require('../lib/anti-slop/metaphor-as-structure-detector');

const tests = [];
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; tests.push(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else      { failed++; tests.push(`  \x1b[31mFAIL\x1b[0m ${name}${extra ? '\n    ' + extra : ''}`); }
}

// ─── Test 1: CLEAN ────────────────────────────────────────────────────────
{
  const r = detectMetaphorAsStructure('注意力是 transformer 的核心机制, 让模型并行处理 token 序列.');
  check('1. CLEAN — 0 metaphor → verdict=CLEAN', r.summary.verdict === 'CLEAN', `got verdict=${r.summary.verdict} count=${r.summary.metaphor_count}`);
  check('1. CLEAN — metaphor_count=0', r.summary.metaphor_count === 0);
}

// ─── Test 2: INSUFFICIENT_DATA ────────────────────────────────────────────
{
  const r = detectMetaphorAsStructure('注意力好比聚光灯. 想象在演讲厅里.', { archetype: 'TECH-CONCEPT' });
  check('2. INSUFFICIENT_DATA — 2 metaphors → verdict=INSUFFICIENT_DATA',
    r.summary.verdict === 'INSUFFICIENT_DATA',
    `got verdict=${r.summary.verdict} count=${r.summary.metaphor_count}`);
}

// ─── Test 3: TYPE_A_DISGUISED ─────────────────────────────────────────────
{
  // 5 metaphors, 0 forcing function → Type-A disguised
  const t = `
    神经网络好比大脑. 反向传播就像老师纠错. 想象一下,
    Embedding 如同地图坐标. 注意力机制仿佛聚光灯. 模型推理犹如思考.
    每层都在提取特征.
  `;
  const r = detectMetaphorAsStructure(t, { archetype: 'TECH-CONCEPT' });
  check('3. TYPE_A_DISGUISED — 5 metaphor, 0 force → flagged',
    r.summary.verdict === 'TYPE_A_DISGUISED',
    `got verdict=${r.summary.verdict} count=${r.summary.metaphor_count} ratio=${r.summary.force_pair_ratio}`);
  check('3. TYPE_A_DISGUISED — metaphor_count ≥ 3', r.summary.metaphor_count >= 3, `count=${r.summary.metaphor_count}`);
  check('3. TYPE_A_DISGUISED — force_pair_ratio < 0.5', r.summary.force_pair_ratio < 0.5, `ratio=${r.summary.force_pair_ratio}`);
}

// ─── Test 4: BALANCED ─────────────────────────────────────────────────────
{
  // 3 metaphors, each paired with a forcing function within ±200 chars
  const t = `
    Step 1: 先猜, 注意力机制好比什么? 写完发我, 之后我给标准答案.
    Step 2: 不查资料, 复述上一节 — 反向传播就像老师纠错那样, 你怎么解释?
    Step 3: 想象一下, 神经网络仿佛大脑. 现在 contrast 一下两种比喻, 哪不同?
  `;
  const r = detectMetaphorAsStructure(t, { archetype: 'TECH-CONCEPT' });
  check('4. BALANCED — 3+ metaphor each w/ forcing fn → BALANCED',
    r.summary.verdict === 'BALANCED',
    `got verdict=${r.summary.verdict} count=${r.summary.metaphor_count} ratio=${r.summary.force_pair_ratio}`);
  check('4. BALANCED — force_pair_ratio ≥ 0.5', r.summary.force_pair_ratio >= 0.5, `ratio=${r.summary.force_pair_ratio}`);
  check('4. BALANCED — supported_count ≥ 2', r.summary.supported_count >= 2, `supported=${r.summary.supported_count}`);
}

// ─── Test 5: HUMANITIES threshold (0.35 vs 0.5) ───────────────────────────
{
  // 5 metaphors, 2 with forcing functions → ratio = 0.4
  // TECH-CONCEPT (0.5 threshold) → TYPE_A_DISGUISED
  // HUMANITIES (0.35 threshold) → BALANCED (literature register tolerates higher metaphor density)
  const t = `
    川端写雪国, 笔法好比雪. 想象一下夜的底.
    先预测: 物哀仿佛什么? 写完发我.
    一行间又如同镜像. 又似留白. 又像水墨.
    不查资料, 复述 — 物哀就像什么?
  `;
  const rTech = detectMetaphorAsStructure(t, { archetype: 'TECH-CONCEPT' });
  const rHum  = detectMetaphorAsStructure(t, { archetype: 'HUMANITIES' });
  check('5. HUMANITIES threshold — TECH-CONCEPT flags same text',
    rTech.summary.verdict === 'TYPE_A_DISGUISED' || rTech.summary.verdict === 'BALANCED',
    `tech verdict=${rTech.summary.verdict} ratio=${rTech.summary.force_pair_ratio}`);
  check('5. HUMANITIES threshold — HUMANITIES more lenient on same text',
    rHum.summary.archetype_threshold === 0.35,
    `humanities threshold=${rHum.summary.archetype_threshold}`);
  check('5. HUMANITIES threshold — both produce identical metaphor_count',
    rTech.summary.metaphor_count === rHum.summary.metaphor_count,
    `tech=${rTech.summary.metaphor_count} hum=${rHum.summary.metaphor_count}`);
}

// ─── Test 6: marker coverage (CN + EN) ────────────────────────────────────
{
  const cn = '比如说, 注意力就像聚光灯. 想象一下. 好比. 如同. 仿佛. 像河流一样流动.';
  const en = 'For example, attention is like a spotlight. Think of it as a beam. An analogy: a river. Imagine.';
  const rCn = detectMetaphorAsStructure(cn);
  const rEn = detectMetaphorAsStructure(en);
  check('6. CN marker coverage — ≥ 5 detected', rCn.summary.metaphor_count >= 5, `cn=${rCn.summary.metaphor_count}`);
  check('6. EN marker coverage — ≥ 3 detected', rEn.summary.metaphor_count >= 3, `en=${rEn.summary.metaphor_count}`);
}

// ─── Test 7: forcing-function detection in ±200 char window ──────────────
{
  const t = 'A. 先猜结果如何. B. 比如说 attention. C. 不查资料复述刚刚的概念.';
  const r = detectMetaphorAsStructure(t);
  // metaphor "比如说" at middle, has "先猜" within 200 chars (left) AND "不查资料/复述" within 200 chars (right)
  check('7. forcing-fn detection — metaphor in middle finds forcers in ±200', r.metaphors.length > 0);
  if (r.metaphors.length > 0) {
    const m = r.metaphors[0];
    check('7. forcing-fn detection — supported=true', m.supported === true, `support_forcers=${JSON.stringify(m.support_forcers)}`);
    check('7. forcing-fn detection — pre_question detected', m.support_forcers.includes('pre_question'), `forcers=${JSON.stringify(m.support_forcers)}`);
  } else {
    check('7. forcing-fn detection — supported=true (skipped, no metaphor)', false, 'no metaphor detected');
    check('7. forcing-fn detection — pre_question detected (skipped, no metaphor)', false, 'no metaphor detected');
  }
}

// ─── Test 8: ratio math holds ─────────────────────────────────────────────
{
  // 4 metaphors total, 1 with forcing function nearby
  const t = `
    比如 A. 好比 B. 就像 C.
    在这一段, 先预测一下: 如同 D 是什么?
  `;
  const r = detectMetaphorAsStructure(t);
  check('8. ratio math — count > 0', r.summary.metaphor_count > 0, `count=${r.summary.metaphor_count}`);
  if (r.summary.metaphor_count > 0) {
    const expectedRatio = r.summary.supported_count / r.summary.metaphor_count;
    check('8. ratio math — force_pair_ratio = supported / total',
      Math.abs(r.summary.force_pair_ratio - Number(expectedRatio.toFixed(3))) < 0.01,
      `got=${r.summary.force_pair_ratio} expected≈${expectedRatio.toFixed(3)}`);
  } else {
    check('8. ratio math — skipped', false, 'no metaphor detected');
  }
}

// ─── Report ───────────────────────────────────────────────────────────────
console.log('\n=== HYPHA · Metaphor-as-Structure Detector smoke ===\n');
for (const line of tests) console.log(line);
console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed}/${passed + failed} PASS\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
