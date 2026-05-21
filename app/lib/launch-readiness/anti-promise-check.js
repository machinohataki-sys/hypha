'use strict';

// HYPHA · W8.1 Launch Readiness — Anti-Promise scanner.
//
// BLUEPRINT §20 v2.4 locks the "不承诺" list. Any public-facing surface
// (lesson prompt, donate copy, feedback channel copy, onboarding text,
// release-note draft) that says or implies the banned promises is a
// trust catastrophe — we promised something HYPHA cannot deliver in v2.4.
//
// This module is the gate. Run scanForOverpromises(content) before
// shipping any user-facing copy. The W8.4 Donate / Feedback streams MUST
// import this and run it on their final copy before commit.
//
// Patterns are tuned for zh user-facing surfaces (the v2.4 launch is CN
// audience) plus a small set of EN equivalents that creep in via prompts
// or marketing translation drafts.

// --------------------------------------------------------------------------
// Anti-promise terms. Each entry is { pattern, label, severity, reason }.
//   - pattern: RegExp or string (case-insensitive)
//   - severity: 'high' (blueprint-banned promise) | 'medium' (slop adjacent)
//   - reason: 1-line explanation of which §20 anti-promise it violates
// --------------------------------------------------------------------------

const ANTI_PROMISES = [
  // ---- "完全替代大学" --------------------------------------------------
  {
    id: 'replace_university_zh',
    pattern: /替代大学|取代大学|代替大学|大学替代品/g,
    label: '替代大学',
    severity: 'high',
    reason: '§20 v2.4: 不承诺"完全替代大学"',
  },
  {
    id: 'replace_university_en',
    pattern: /\b(replaces?|replacing|substitute\s+for)\s+(college|university|higher\s+education)\b/gi,
    label: 'replaces university',
    severity: 'high',
    reason: '§20 v2.4: 不承诺"完全替代大学"',
  },

  // ---- "全自动成才" / "全自动学习" -------------------------------------
  {
    id: 'fully_automatic_zh',
    pattern: /完全自动|全自动成才|自动成才|全自动学习|自动让你成才|不需要努力|轻松成才/g,
    label: '完全自动 / 自动成才',
    severity: 'high',
    reason: '§20 v2.4: 不承诺"全自动成才"',
  },
  {
    id: 'fully_automatic_en',
    pattern: /\b(fully\s+automatic|hands-?off)\s+(learn|mastery|expertise|education)\b/gi,
    label: 'fully automatic learning',
    severity: 'high',
    reason: '§20 v2.4: 不承诺"全自动成才"',
  },

  // ---- "全学科覆盖" ----------------------------------------------------
  {
    id: 'all_subjects_zh',
    pattern: /全学科覆盖|所有学科|任何学科|全部学科|涵盖一切学科|什么都能学/g,
    label: '全学科覆盖',
    severity: 'high',
    reason: '§20 v2.4: 不承诺"全学科覆盖"',
  },
  {
    id: 'all_subjects_en',
    pattern: /\b(every\s+subject|all\s+subjects|any\s+subject|every\s+field)\b/gi,
    label: 'every subject',
    severity: 'high',
    reason: '§20 v2.4: 不承诺"全学科覆盖"',
  },

  // ---- "无限模型使用" --------------------------------------------------
  {
    id: 'unlimited_models_zh',
    pattern: /无限模型|无限使用|无限调用|无限对话|无限次数|不限次数|永久免费/g,
    label: '无限模型 / 无限使用',
    severity: 'high',
    reason: '§20 v2.4: 不承诺"无限模型使用"',
  },
  {
    id: 'unlimited_models_en',
    pattern: /\bunlimited\s+(model|llm|gpt|inference|tokens|chat|access|usage)/gi,
    label: 'unlimited model',
    severity: 'high',
    reason: '§20 v2.4: 不承诺"无限模型使用"',
  },

  // ---- "全部真题内置" --------------------------------------------------
  {
    id: 'all_real_exams',
    pattern: /全部真题|所有真题|完整真题库|历年所有真题|真题全集/g,
    label: '全部真题内置',
    severity: 'high',
    reason: '§20 v2.4: 不承诺"全部真题内置"',
  },

  // ---- "复杂宠物养成" --------------------------------------------------
  {
    id: 'complex_pet_zh',
    pattern: /复杂宠物|宠物养成|养宠|宠物等级|宠物战斗|宠物对战/g,
    label: '复杂宠物养成',
    severity: 'high',
    reason: '§20 v2.4: 不承诺"复杂宠物养成"',
  },
  {
    id: 'complex_pet_en',
    pattern: /\b(virtual\s+pet|pet\s+leveling|pet\s+combat|tamagotchi)\b/gi,
    label: 'virtual pet leveling',
    severity: 'high',
    reason: '§20 v2.4: 不承诺"复杂宠物养成"',
  },

  // ---- "团队项目管理" --------------------------------------------------
  {
    id: 'team_project_zh',
    pattern: /团队项目管理|多人协作|团队协作平台|项目管理工具/g,
    label: '团队项目管理',
    severity: 'high',
    reason: '§20 v2.4: 不承诺"团队项目管理"',
  },
  {
    id: 'team_project_en',
    pattern: /\b(team\s+project\s+management|multi-?player\s+collaboration|enterprise\s+collaboration)\b/gi,
    label: 'team project management',
    severity: 'high',
    reason: '§20 v2.4: 不承诺"团队项目管理"',
  },

  // ---- Slop / 营销话术 (kept here so the same scanner gates 文案 too) --
  {
    id: 'zh_slop_density',
    pattern: /这一刀|闭环|拉满|王炸|杀疯了|干货|直击灵魂|上分|上车|上岸|内卷|出圈|真香|yyds|绝绝子/g,
    label: 'zh AI 流量词',
    severity: 'medium',
    reason: 'CLAUDE.md brand register · 禁 zh AI 流量词',
  },
  {
    id: 'sycophantic_en',
    pattern: /\bgreat\s+question!|\b(amazing|incredible|revolutionary)\s+(ai|tutor|product)\b/gi,
    label: 'sycophantic / 营销话术',
    severity: 'medium',
    reason: 'CLAUDE.md brand register · forbidden sycophantic copy',
  },
];

// --------------------------------------------------------------------------
// scanForOverpromises — return all matches with locations.
//
// content: string
// returns: { clean:boolean, violations: Array<{ id, label, severity, reason,
//            matches:[{ snippet, index }] }>, scanned_at }
// --------------------------------------------------------------------------

function scanForOverpromises(content) {
  if (typeof content !== 'string' || content.length === 0) {
    return { clean: true, violations: [], scanned_at: new Date().toISOString() };
  }
  const violations = [];
  for (const entry of ANTI_PROMISES) {
    const matches = [];
    let pattern = entry.pattern;
    if (typeof pattern === 'string') {
      // Convert literal strings to a case-insensitive global regex.
      pattern = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    } else {
      // Reset lastIndex defensively (regex literals are stateful with `g`).
      pattern.lastIndex = 0;
    }
    let m;
    while ((m = pattern.exec(content)) !== null) {
      const start = Math.max(0, m.index - 16);
      const end = Math.min(content.length, m.index + m[0].length + 16);
      matches.push({
        snippet: content.slice(start, end).replace(/\s+/g, ' ').trim(),
        index: m.index,
        matched: m[0],
      });
      if (matches.length >= 5) break; // cap per-rule; report representative not exhaustive
      // Prevent zero-length matches from looping.
      if (m.index === pattern.lastIndex) pattern.lastIndex++;
    }
    if (matches.length > 0) {
      violations.push({
        id: entry.id,
        label: entry.label,
        severity: entry.severity,
        reason: entry.reason,
        match_count: matches.length,
        matches,
      });
    }
  }
  return {
    clean: violations.length === 0,
    violations,
    high_count: violations.filter((v) => v.severity === 'high').length,
    medium_count: violations.filter((v) => v.severity === 'medium').length,
    scanned_at: new Date().toISOString(),
  };
}

// --------------------------------------------------------------------------
// scanFile — convenience for the CLI verifier.
// --------------------------------------------------------------------------

function scanFile(absPath) {
  const fs = require('fs');
  let body;
  try { body = fs.readFileSync(absPath, 'utf8'); }
  catch (err) {
    return {
      clean: false,
      file: absPath,
      error: 'read_failed: ' + ((err && err.message) || String(err)),
      violations: [],
    };
  }
  const scan = scanForOverpromises(body);
  return Object.assign({ file: absPath }, scan);
}

module.exports = {
  ANTI_PROMISES,
  scanForOverpromises,
  scanFile,
};
