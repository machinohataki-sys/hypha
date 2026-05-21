'use strict';

// HYPHA · W5.3 Living Note — Crystallizer (BLUEPRINT §10.2).
//
// High-utility notes get *re-shaped* into a denser form for the user's
// workflow. Six target shapes:
//
//   principle         — single-sentence claim + 1 example + 1 counter-case
//   checklist         — 5-9 bullet steps, imperative voice
//   workflow          — ordered phases with entry/exit criteria
//   template          — fill-in slot schema + 1 example fill
//   product_principle — claim + product implication (read by Creation Pool)
//   roadmap_item      — title + acceptance criteria + suggested week
//
// Crystallization writes a NEW note alongside the source (does NOT replace it).
// Source note transitions Useful → Crystallized via states.transitionNoteState
// when triggered through this module (caller orchestrates).
//
// Gate (caller-enforced; this lib provides isEligible):
//   utility_score ≥ 80 AND state = Useful AND cited_count ≥ 3
//
// LLM call goes through T6_STRONG. In test / smoke paths we accept an
// injected `_t6Shim(args) → string` so unit tests stay fs-only.

const fs   = require('node:fs');
const path = require('node:path');

const states = require('./states');
const utility = require('./utility-score');

const TARGET_TYPES = Object.freeze({
  PRINCIPLE:         'principle',
  CHECKLIST:         'checklist',
  WORKFLOW:          'workflow',
  TEMPLATE:          'template',
  PRODUCT_PRINCIPLE: 'product_principle',
  ROADMAP_ITEM:      'roadmap_item',
});

const TARGET_VALUES = new Set(Object.values(TARGET_TYPES));

const CRYSTALLIZE_GATE = Object.freeze({
  MIN_UTILITY: 80,
  MIN_CITED: 3,
  REQUIRED_STATE: states.LIFE_STATES.USEFUL,
});

function _resolveVaultRoot(slug) {
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) {
    return path.join(process.env.HYPHA_DATA, slug);
  }
  if (process.env.HYPHA_VAULT_DIR && fs.existsSync(process.env.HYPHA_VAULT_DIR)) {
    return path.join(process.env.HYPHA_VAULT_DIR, slug);
  }
  return path.join(__dirname, '..', '..', '..', 'data', slug);
}

function _slugify(s) {
  return String(s || 'note')
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'note';
}

function _safeReadText(abs) {
  try { return fs.readFileSync(abs, 'utf-8'); } catch (_) { return ''; }
}

function _parseFm(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { fm, body: text.slice(m[0].length) };
}

// Default mock for T6_STRONG. Real wiring: caller injects opts._t6Shim
// or this module looks up app/lib/llm. To keep the unit boundary clean
// (no LLM in tests), default behavior produces a structural skeleton
// derived from the source body verbatim. Real crystallization replaces
// this with a real call site.
function _defaultT6({ sourceBody, targetType, hint }) {
  const head = String(sourceBody || '').split(/\r?\n/).slice(0, 6).join('\n').trim();
  const sourceLine = head || '(空源 — 等待补充)';
  switch (targetType) {
    case TARGET_TYPES.PRINCIPLE:
      return [
        `# 原则\n`,
        `**Claim** — ${sourceLine.replace(/\n/g, ' / ')}\n`,
        `**Example** — (待补)\n`,
        `**Counter-case** — (待补)\n`,
        hint ? `> ${hint}\n` : '',
      ].join('\n');
    case TARGET_TYPES.CHECKLIST:
      return [
        `# 清单\n`,
        `1. 起步动作 — ${sourceLine.split('\n')[0]}`,
        `2. 第二步`,
        `3. 第三步`,
        `4. 第四步`,
        `5. 第五步`,
      ].join('\n');
    case TARGET_TYPES.WORKFLOW:
      return [
        `# 工作流\n`,
        `## Phase 1 — 入口\n`,
        `- 进入条件: ${sourceLine.split('\n')[0]}`,
        `- 退出条件: (待补)\n`,
        `## Phase 2\n- ...\n`,
      ].join('\n');
    case TARGET_TYPES.TEMPLATE:
      return [
        `# 模板\n`,
        `## Slots`,
        `- {{title}}`,
        `- {{claim}}`,
        `- {{evidence}}`,
        `- {{action}}\n`,
        `## Example fill`,
        sourceLine,
      ].join('\n');
    case TARGET_TYPES.PRODUCT_PRINCIPLE:
      return [
        `# 产品原则\n`,
        `**Claim** — ${sourceLine.replace(/\n/g, ' / ')}\n`,
        `**Product implication** — (待补: 这条原则在产品里如何兑现)\n`,
      ].join('\n');
    case TARGET_TYPES.ROADMAP_ITEM:
      return [
        `# Roadmap Item\n`,
        `**Title** — ${sourceLine.split('\n')[0]}\n`,
        `**Acceptance criteria** —`,
        `- (待补)\n`,
        `**Suggested week** — next-1\n`,
      ].join('\n');
    default:
      return sourceLine;
  }
}

function _renderFrontmatter(meta) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (v == null) continue;
    lines.push(`${k}: ${typeof v === 'string' && /[":#\n]/.test(v) ? JSON.stringify(v) : v}`);
  }
  lines.push('---');
  return lines.join('\n');
}

/**
 * Gate check — caller may consult this before triggering crystallization.
 * Returns { ok: true } or { ok: false, reason }.
 */
function isEligibleForCrystallization({ fm }) {
  if (!fm || typeof fm !== 'object') {
    return { ok: false, reason: 'missing frontmatter' };
  }
  const state = fm.life_state || states.LIFE_STATES.DORMANT;
  if (state !== CRYSTALLIZE_GATE.REQUIRED_STATE) {
    return { ok: false, reason: `state must be ${CRYSTALLIZE_GATE.REQUIRED_STATE}, got ${state}` };
  }
  const cited = Number(fm.cited_count) || 0;
  if (cited < CRYSTALLIZE_GATE.MIN_CITED) {
    return { ok: false, reason: `cited_count ${cited} < ${CRYSTALLIZE_GATE.MIN_CITED}` };
  }
  const uScore = utility.computeUtilityScore({
    helped_lesson_count: Number(fm.helped_lesson_count) || 0,
    helped_decision_count: Number(fm.helped_decision_count) || 0,
    produced_action_count: Number(fm.produced_action_count) || 0,
    cited_count: cited,
    sparked_count: Number(fm.sparked_count) || 0,
    reduced_understanding_cost: fm.reduced_understanding_cost === 'true',
    influenced_product: fm.influenced_product === 'true',
    outdated_penalty: false,
  }).score;
  if (uScore < CRYSTALLIZE_GATE.MIN_UTILITY) {
    return { ok: false, reason: `utility_score ${uScore} < ${CRYSTALLIZE_GATE.MIN_UTILITY}` };
  }
  return { ok: true, utility: uScore };
}

/**
 * Crystallize a high-utility note into one of 6 structured forms.
 *
 * @param {string} slug
 * @param {string} noteId            absolute path OR filename relative to slug dir
 * @param {string} targetType        one of TARGET_TYPES values
 * @param {object} [opts]
 * @param {Function} [opts._t6Shim]  inject mock T6_STRONG for tests
 * @param {boolean} [opts.skipGate]  bypass eligibility check (caller knows)
 * @param {string} [opts.hint]       optional user-supplied hint
 * @returns {{ ok:true, newNotePath:string, type:string, structured_content:string,
 *             sourcePath:string, utility:number }}
 * @throws Error when source missing OR gate fails (unless skipGate)
 */
function crystallizeNote(slug, noteId, targetType, opts) {
  if (!slug || typeof slug !== 'string') {
    throw new Error('living-note/crystallizer: slug required');
  }
  if (!TARGET_VALUES.has(targetType)) {
    throw new Error(`living-note/crystallizer: targetType must be one of ${[...TARGET_VALUES].join('|')}`);
  }
  const options = opts || {};
  const root = _resolveVaultRoot(slug);
  const sourcePath = path.isAbsolute(noteId) ? noteId : path.join(root, noteId);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`living-note/crystallizer: source note missing at ${sourcePath}`);
  }
  const text = _safeReadText(sourcePath);
  const { fm, body } = _parseFm(text);

  if (!options.skipGate) {
    const gate = isEligibleForCrystallization({ fm });
    if (!gate.ok) {
      throw new Error(`living-note/crystallizer: gate failed — ${gate.reason}`);
    }
  }

  const t6 = (typeof options._t6Shim === 'function') ? options._t6Shim : _defaultT6;
  const structuredBody = t6({
    sourceBody: body,
    targetType,
    hint: options.hint || '',
  });

  const title = fm.title || path.basename(sourcePath).replace(/\.md$/, '');
  const stamp = new Date().toISOString();
  const newBase = `crystal-${_slugify(title)}-${targetType}.md`;
  const newDir  = path.join(root, '.crystal');
  const newPath = path.join(newDir, newBase);
  try { fs.mkdirSync(newDir, { recursive: true }); } catch (_) {}

  const frontmatter = _renderFrontmatter({
    title: `${title} · ${targetType}`,
    crystallized_from: path.relative(root, sourcePath).replace(/\\/g, '/'),
    crystallized_at: stamp,
    crystal_type: targetType,
    life_state: states.LIFE_STATES.CRYSTALLIZED,
    life_state_updated: stamp,
  });
  const out = `${frontmatter}\n\n${structuredBody}\n`;
  fs.writeFileSync(newPath, out, 'utf-8');

  // Compute utility on whatever fm we have (for caller telemetry).
  const u = utility.computeUtilityScore({
    helped_lesson_count: Number(fm.helped_lesson_count) || 0,
    helped_decision_count: Number(fm.helped_decision_count) || 0,
    produced_action_count: Number(fm.produced_action_count) || 0,
    cited_count: Number(fm.cited_count) || 0,
    sparked_count: Number(fm.sparked_count) || 0,
    reduced_understanding_cost: fm.reduced_understanding_cost === 'true',
    influenced_product: fm.influenced_product === 'true',
    outdated_penalty: false,
  }).score;

  return {
    ok: true,
    newNotePath: newPath,
    type: targetType,
    structured_content: structuredBody,
    sourcePath,
    utility: u,
  };
}

module.exports = {
  TARGET_TYPES,
  CRYSTALLIZE_GATE,
  isEligibleForCrystallization,
  crystallizeNote,
};
