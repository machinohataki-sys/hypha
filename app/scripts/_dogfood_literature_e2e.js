'use strict';

// HYPHA · Literature Curriculum E2E Dogfood (2026-05-16)
//
// Validates the full vault → persona → wisdom flow for a real curriculum
// (vault/魔戒-tolkien-次创造/) without spawning Electron or burning LLM
// calls. Asserts that when a user creates the literature curriculum,
// the persona resolution + wisdom-block-build chain returns substantive
// CN content that designLesson would have injected as system-prompt
// appendix.

const path = require('path');
const fs = require('fs');
const assert = require('node:assert/strict');

process.env.HYPHA_DATA = process.env.HYPHA_DATA || path.resolve(__dirname, '../../vault');

const SLUG = '魔戒-tolkien-次创造';
const VAULT = path.resolve(__dirname, '../../vault');
const CURR_DIR = path.join(VAULT, SLUG);

const { derivePersona, getPersona } = require('../lib/personas');
const wisdomLoader = require('../lib/personas/load-wisdom');

const results = [];
function step(name, fn) {
  try {
    const r = fn();
    results.push({ name, ok: true, info: r || '' });
    console.log('PASS  ' + name + (r ? ' — ' + r : ''));
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log('FAIL  ' + name + ' — ' + e.message);
  }
}

// ── 1. Vault layout exists
step('vault/魔戒-tolkien-次创造/ exists with state.json + agent.json', () => {
  assert.ok(fs.existsSync(CURR_DIR), 'curriculum dir missing');
  assert.ok(fs.existsSync(path.join(CURR_DIR, 'state.json')), 'state.json missing');
  assert.ok(fs.existsSync(path.join(CURR_DIR, 'agent.json')), 'agent.json missing');
  return `dir + 2 manifests at ${SLUG}`;
});

// ── 2. state.json archetype + goalContract sane
step('state.json archetype=HUMANITIES + goalContract 8 fields', () => {
  const state = JSON.parse(fs.readFileSync(path.join(CURR_DIR, 'state.json'), 'utf8'));
  assert.equal(state.archetype, 'HUMANITIES');
  assert.ok(state.goalContract, 'goalContract missing');
  const required = [
    'north_star_goal', 'skill_or_understanding', 'deliverable_kind',
    'feasibility_class', 'evidence_for_completion', 'anti_goal',
  ];
  for (const k of required) assert.ok(state.goalContract[k], `goalContract.${k} missing`);
  return `archetype=HUMANITIES, ${required.length}/8 goalContract fields filled`;
});

// ── 3. agent.json persona = nobel-literature-critic
step('agent.json persona = nobel-literature-critic', () => {
  const agent = JSON.parse(fs.readFileSync(path.join(CURR_DIR, 'agent.json'), 'utf8'));
  assert.equal(agent.persona, 'nobel-literature-critic');
  return agent.displayName;
});

// ── 4. derivePersona on user's actual topic+goal returns the right persona
step('derivePersona on real topic+goal → nobel-literature-critic', () => {
  const state = JSON.parse(fs.readFileSync(path.join(CURR_DIR, 'state.json'), 'utf8'));
  const id = derivePersona({ topic: state.topic, goal: state.learn_goal });
  assert.equal(id, 'nobel-literature-critic');
  return `derive('${state.topic.slice(0, 20)}...') → ${id}`;
});

// ── 5. wisdom file resolves + DISTILLED
step('loadPersonaWisdom(nobel-literature-critic) → DISTILLED', () => {
  const w = wisdomLoader.loadPersonaWisdom('nobel-literature-critic');
  assert.ok(w, 'wisdom null');
  assert.equal(w.status, 'DISTILLED');
  assert.ok(Object.keys(w.sections || {}).length >= 7, `sections=${Object.keys(w.sections||{}).length}`);
  return `${Object.keys(w.sections).length} sections, status=${w.status}`;
});

// ── 6. Replay _buildPersonaWisdomBlock SURFACED logic against current wisdom
step('replayed wisdom block surfaces ≥5 sections + CN body', () => {
  const SURFACED = [
    '整体调子 (register)', '核心信念 (core_beliefs)', '标志性表达 (signature_voice)',
    '思维模式 (thought_patterns)', '反模式 (anti_patterns)',
    '常用 referent (favorite_referents)', '不碰的话题 (topics_he_avoids)',
  ];
  const w = wisdomLoader.loadPersonaWisdom('nobel-literature-critic');
  const lookup = new Map();
  for (const k of Object.keys(w.sections || {})) lookup.set(k.toLowerCase(), k);
  let surfaced = 0;
  let totalBody = '';
  for (const want of SURFACED) {
    const k = lookup.get(want.toLowerCase());
    if (!k) continue;
    const body = String(w.sections[k] || '').trim();
    if (!body) continue;
    surfaced += 1;
    totalBody += body + '\n';
  }
  assert.ok(surfaced >= 5, `only ${surfaced} surfaced`);
  // CN body sanity — non-ASCII char ratio > 30% confirms Chinese-dominant
  let cnChars = 0; let nonWs = 0;
  for (const ch of totalBody) {
    if (/\s/.test(ch)) continue;
    nonWs += 1;
    if (ch.codePointAt(0) > 0x4E00) cnChars += 1;
  }
  const cnRatio = nonWs > 0 ? cnChars / nonWs : 0;
  assert.ok(cnRatio > 0.30, `CN ratio ${(cnRatio*100).toFixed(1)}% (expect >30%)`);
  return `${surfaced} sections, CN ratio ${(cnRatio*100).toFixed(1)}%`;
});

// ── 7. source_provenance section is NOT empty (renderer fix verified)
step('source_provenance section has body (renderer fix landed)', () => {
  const w = wisdomLoader.loadPersonaWisdom('nobel-literature-critic');
  const provKey = Object.keys(w.sections || {}).find(k =>
    k.includes('source_provenance') || k.includes('原文证据'));
  assert.ok(provKey, 'no source_provenance section header');
  const body = String(w.sections[provKey] || '').trim();
  assert.ok(body.length > 100, `provenance body only ${body.length} chars`);
  const bulletCount = (body.match(/^- /gm) || []).length;
  assert.ok(bulletCount >= 3, `only ${bulletCount} provenance bullets`);
  return `${bulletCount} bullets, ${body.length} chars`;
});

// ── 8. Persona registry getPersona returns label + literature prompt
step('getPersona returns literature-domain prompt', () => {
  const p = getPersona('nobel-literature-critic');
  assert.equal(p.id, 'nobel-literature-critic');
  assert.equal(p.domain, 'literature');
  assert.match(p.prompt, /Nobel|literature|écriture|allegory|sub-creation|世界文学/i);
  return p.label;
});

// ── Summary
console.log('\n===');
const passed = results.filter(r => r.ok).length;
console.log(`${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
