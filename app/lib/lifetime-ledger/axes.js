'use strict';

// HYPHA · Phase C · 5-axis output target schema (2026-05-17).
//
// chain.link gains an "output_targets" array (per-axis honest cumulative count
// for that link's duration_weeks) + "frontier_axis_p50" object (benchmark
// person's p50 estimate per axis). Set is archetype-aware: HUMANITIES gets 5
// axes, TECH-CONCEPT/TECH-PROC get 4, LANG-ACQ/DECL-MASS/MINDSET get 2.
//
// Source of truth for axis enumeration + unit hints. agent.js planChain
// imports here to build the prompt block; compute-variance + tracker import
// here for axis enumeration safety.
//
// archetype keys MUST match the 6 HYPHA archetypes defined in
// `app/lib/archetypes/` — do NOT add new keys here without aligning that side.

const AXES = ['learn', 'practice', 'produce', 'read', 'reflect'];

const ARCHETYPE_AXIS_SET = {
  'HUMANITIES':   ['learn', 'practice', 'produce', 'read', 'reflect'],
  'TECH-CONCEPT': ['learn', 'practice', 'produce', 'reflect'],
  'TECH-PROC':    ['learn', 'practice', 'produce', 'reflect'],
  'LANG-ACQ':     ['learn', 'practice'],
  'DECL-MASS':    ['learn', 'practice'],
  'MINDSET':      ['learn', 'practice'],
};

const ARCHETYPE_UNIT_HINTS = {
  'HUMANITIES':   { learn: '概念组', practice: '精读片段', produce: '札记|文章', read: '本', reflect: '论辩往返' },
  'TECH-CONCEPT': { learn: '概念', practice: '推导题', produce: '实验|文章', reflect: '复盘' },
  'TECH-PROC':    { learn: '操作', practice: '练习', produce: 'project|PR', reflect: '复盘' },
  'LANG-ACQ':     { learn: 'vocab|grammar', practice: '听说读写小时' },
  'DECL-MASS':    { learn: '考点', practice: '题量' },
  'MINDSET':      { learn: '原则', practice: '习惯次数' },
};

function axisLabel(axis, lang = 'zh') {
  const L = lang === 'en' ? {
    learn: 'Learn', practice: 'Practice', produce: 'Produce',
    read: 'Read', reflect: 'Reflect',
  } : {
    learn: '学', practice: '练', produce: '产', read: '读', reflect: '反',
  };
  return L[axis] || axis;
}

function axisesForArchetype(archetype) {
  return ARCHETYPE_AXIS_SET[archetype] || ['learn', 'practice'];
}

module.exports = {
  AXES,
  ARCHETYPE_AXIS_SET,
  ARCHETYPE_UNIT_HINTS,
  axisLabel,
  axisesForArchetype,
};
