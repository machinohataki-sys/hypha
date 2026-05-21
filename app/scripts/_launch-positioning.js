'use strict';

// HYPHA · W8.1 Launch Readiness — canonical v1.0 positioning copy.
//
// Load-bearing for `app/main.js` launch:fullReport. If this file is missing,
// the IPC silently degrades positioning to '' and the anti-promise scanner
// reports "clean" with zero copy actually authored — a false-positive ship
// signal. Keeping the source of truth in a versioned module lets the smoke
// + the on-screen self-scan agree on the same line.
//
// Editing rules (per CLAUDE.md WHY + BLUEPRINT §20 v2.4):
//   - Must pass `anti-promise-check.scanForOverpromises` clean (high=0).
//     The launch-readiness smoke + the screen self-scan both verify this on
//     every render. Anti-promise patterns include 替代大学 / 完全自动 /
//     无限模型 / 全学科覆盖 / 复杂宠物 / 团队项目管理 / zh AI 流量词.
//   - Manuscript register: no exclamation marks, no emoji, no marketing
//     superlatives ("革命", "颠覆", "杀疯了"), no second-person sales
//     imperative ("立即获取", "马上下载").
//   - Honest hedge: describes what Hypha IS, not what it promises to deliver.
//   - Single short paragraph (≤ 280 zh chars).
//
// Updating this line is a v2.4 ship-coordination decision — touch BLUEPRINT
// §20 v2.4 in the same edit. Drift between the two = launch-readiness gate
// failure.

const LINE = 'Hypha 是把 LLM 智识带到真实社交场域的桥。学的每一段, 最后用自己的话讲给真人, 或亲手做成可被人用的产品。等真人 push back, 才算真懂。';

module.exports = {
  LINE,
};
