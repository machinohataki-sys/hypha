'use strict';
const path = require('path');
const fs = require('fs');
process.env.HYPHA_DATA = process.env.HYPHA_DATA || path.resolve(__dirname, '../../vault');

const assert = require('node:assert/strict');
const { derivePersona, getPersona, PERSONAS } = require('../lib/personas');
const wisdomLoader = require('../lib/personas/load-wisdom');

const results = [];

function step(name, fn) {
  try {
    const r = fn();
    results.push({ name, ok: true, info: r });
    console.log('PASS  ' + name, r ? '— ' + r : '');
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log('FAIL  ' + name, '— ' + e.message);
  }
}

// 1. derivePersona returns nobel-literature-critic for literature goal
step('derivePersona(魔戒+Tolkien) → nobel-literature-critic', () => {
  const id = derivePersona({ topic: '魔戒研读', goal: '托尔金次创造 + 诺贝尔文学奖深度' });
  assert.equal(id, 'nobel-literature-critic');
  return id;
});

// 2. registry has 13 personas including the 2 new
step('PERSONAS has tolkien + nobel-literature-critic', () => {
  assert.ok(PERSONAS.length >= 13, 'total=' + PERSONAS.length);
  assert.ok(PERSONAS.find(p => p.id === 'tolkien'), 'tolkien missing');
  assert.ok(PERSONAS.find(p => p.id === 'nobel-literature-critic'), 'nobel-literature-critic missing');
  return `total=${PERSONAS.length}`;
});

// 3. getPersona returns nobel-literature-critic correctly
step('getPersona(nobel-literature-critic) has literature prompt', () => {
  const p = getPersona('nobel-literature-critic');
  assert.equal(p.id, 'nobel-literature-critic');
  assert.match(p.prompt, /Nobel|literature|écriture|allegory|sub-creation|世界文学/i);
  return p.label;
});

// 4. wisdom file exists + DISTILLED
step('wisdom file DISTILLED', () => {
  const w = wisdomLoader.loadPersonaWisdom('nobel-literature-critic');
  assert.ok(w, 'wisdom null');
  assert.notEqual(w.status, 'WAITING_DISTILL', 'still WAITING');
  assert.ok(Object.keys(w.sections || {}).length >= 5, 'sections count=' + Object.keys(w.sections||{}).length);
  return `status=${w.status} sections=${Object.keys(w.sections||{}).length}`;
});

// 5. New CN schema sections present
step('wisdom has CN schema sections', () => {
  const w = wisdomLoader.loadPersonaWisdom('nobel-literature-critic');
  const expected = ['整体调子 (register)', '核心信念 (core_beliefs)', '标志性表达 (signature_voice)', '思维模式 (thought_patterns)', '反模式 (anti_patterns)'];
  const have = Object.keys(w.sections || {});
  const missing = expected.filter(e => !have.includes(e));
  assert.equal(missing.length, 0, 'missing: ' + missing.join(', '));
  return `5/5 CN sections present`;
});

// 6. wisdom body has key terms from the corpus
step('wisdom body cites corpus key terms', () => {
  const w = wisdomLoader.loadPersonaWisdom('nobel-literature-critic');
  const all = Object.values(w.sections || {}).join('\n');
  // Flexible match — accept any of CN/EN variants. "次创造" can render as
  // "次创造" or "次级创造" (LLM word-choice); "applicability" can be 适用性
  // or "适用性"; etc. We require ≥6 anchor families to fire.
  const families = [
    ['次创造', '次级创造', '次级世界', 'sub-creation', 'sub-creator'],   // Tolkien sub-creation
    ['寓言', 'allegory'],                                                  // allegory
    ['适用性', 'applicability'],                                            // applicability
    ['语言', '语文学', 'philological'],                                     // philological anchor
    ['采石场', 'quarry'],                                                  // quarry-tower metaphor
    ['écriture plate', '平白', '平白书写', '平白文体'],                     // Ernaux écriture plate
    ['静默', '倾听', 'listening', 'silence'],                              // Fosse listening
    ['见证', 'witness'],                                                    // Ernaux witness
    ['nationalism', '民族主义', 'patriotism'],                              // Vargas Llosa
  ];
  const hit = families.filter(fam => fam.some(t => all.includes(t)));
  assert.ok(hit.length >= 6, 'only ' + hit.length + '/9 corpus anchor families matched. Hit: ' + hit.map(f => f[0]).join(', ') + ' (floor=6, 2026-05-16)');
  return `matched ${hit.length}/${families.length} families: ${hit.map(f => f[0]).join(', ')}`;
});

// 7. Replay _buildPersonaWisdomBlock SURFACED logic with new schema
step('SURFACED keys cover new schema', () => {
  const SURFACED = [
    'What he is, in one line', 'What she is, in one line', 'What they are, in one line',
    'Six load-bearing teaching moves', 'Load-bearing teaching moves',
    'How he hedges', 'How she hedges', 'How they hedge',
    'How he admits limits', 'How she admits limits', 'How they admit limits',
    'Idiolect to keep available, not to mimic verbatim', 'Idiolect',
    'Where he is *not* a fit', 'Where she is *not* a fit', 'Where they are *not* a fit',
    'Where he is not a fit', 'Where she is not a fit', 'Where they are not a fit',
    '整体调子 (register)', '核心信念 (core_beliefs)', '标志性表达 (signature_voice)',
    '思维模式 (thought_patterns)', '反模式 (anti_patterns)',
    '常用 referent (favorite_referents)', '不碰的话题 (topics_he_avoids)',
  ];
  const w = wisdomLoader.loadPersonaWisdom('nobel-literature-critic');
  const lookup = new Map();
  for (const k of Object.keys(w.sections || {})) lookup.set(k.toLowerCase(), k);
  let surfaced = 0;
  for (const want of SURFACED) {
    const k = lookup.get(want.toLowerCase());
    if (k && (w.sections[k] || '').trim()) surfaced++;
  }
  assert.ok(surfaced >= 5, 'only ' + surfaced + ' surfaced');
  return `${surfaced} sections surfaced from wisdom`;
});

// 8. wisdom file size sane
step('wisdom file size sane', () => {
  const p = path.resolve(__dirname, '../../vault/.persona-wisdom/nobel-literature-critic.md');
  const stat = fs.statSync(p);
  assert.ok(stat.size >= 2000, 'too small: ' + stat.size);
  assert.ok(stat.size <= 30000, 'too big: ' + stat.size);
  return `${stat.size} bytes`;
});

// summary
console.log('\n===');
const passed = results.filter(r => r.ok).length;
console.log(`${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
