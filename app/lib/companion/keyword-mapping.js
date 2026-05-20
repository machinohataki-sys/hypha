'use strict';
// HYPHA · W3.5 Companion Layer — 14-keyword HYPHA→Myco mapping.
//
// Single source of truth, mirrors BLUEPRINT.md §16.3 + specs/companion-myco.md
// §16.3 table. Consumed by boundary-guard.getKeywordMapping() and exposed
// over IPC (companion:keywordMap) so the renderer can swap HYPHA terms for
// Myco terms when rendering Companion-channel text.
//
// Edit policy: this is part of the brand surface. Any new mapping must
// honor the alien-quiet register (mycology / soil / spore vocabulary).
// New entries land in BLUEPRINT first, then here.

const KEYWORD_MAPPING = Object.freeze([
  { hypha: 'Note',                     myco: '孢子 / 菌丝' },
  { hypha: 'Lesson',                   myco: '营养层 / 生长层' },
  { hypha: 'Learning Evidence',        myco: '发芽证据' },
  { hypha: 'Review',                   myco: '回流' },
  { hypha: 'Dead Note',                myco: '休眠孢子' },
  { hypha: 'Living Note Reactivation', myco: '唤醒旧菌丝' },
  { hypha: 'Positive Feedback',        myco: '发光反应' },
  { hypha: 'Mastery Map',              myco: '地下菌网图' },
  { hypha: 'Pack',                     myco: '菌囊 / 知识菌包' },
  { hypha: 'Commons',                  myco: '公共菌落' },
  { hypha: 'Cross-Spark',              myco: '异种共生' },
  { hypha: 'Product Spark',            myco: '新菌芽' },
  { hypha: 'Finish Capture',           myco: '收束孢子' },
  { hypha: 'Entropy Reduction',        myco: '清理腐殖层' },
]);

module.exports = { KEYWORD_MAPPING };
