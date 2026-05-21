'use strict';
// HYPHA · Jargon Firewall v0
//
// Per blueprint §6.2 + feedback_ban_ai_cliche_zh: monitor LLM output for
// banned EN tech jargon and ZH AI 流量词. v0 = monitoring only (console.warn),
// no blocking, no LLM, no async.
//
// EN: word-boundary regex, case-insensitive.
// ZH: substring match (CJK has no word boundaries).
// Returns ALL violations sorted by char position; never short-circuits.

const BANNED_EN = [
  'AI',
  'LLM',
  'embedding',
  'model',
  'prompt',
  'agent',
  'RAG',
  'vector',
  'fine-tune',
];

const BANNED_ZH = [
  '这一刀',
  '闭环',
  '拉满',
  '干货',
  '绝绝子',
  'yyds',
  '王炸',
  '杀疯了',
  '直击灵魂',
  '上分',
  '上车',
  '上岸',
  '内卷',
  '出圈',
  '真香',
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lineOf(text, position) {
  let line = 1;
  for (let i = 0; i < position && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function checkJargon(text) {
  if (typeof text !== 'string') {
    return { passed: true, violations: [] };
  }

  const violations = [];

  for (const word of BANNED_EN) {
    const re = new RegExp('\\b' + escapeRegex(word) + '\\b', 'gi');
    let m;
    while ((m = re.exec(text)) !== null) {
      violations.push({ word, position: m.index, line: lineOf(text, m.index) });
    }
  }

  for (const phrase of BANNED_ZH) {
    let from = 0;
    while (true) {
      const idx = text.indexOf(phrase, from);
      if (idx === -1) break;
      violations.push({ word: phrase, position: idx, line: lineOf(text, idx) });
      from = idx + phrase.length;
    }
  }

  violations.sort((a, b) => a.position - b.position);

  return { passed: violations.length === 0, violations };
}

module.exports = { BANNED_EN, BANNED_ZH, checkJargon };
