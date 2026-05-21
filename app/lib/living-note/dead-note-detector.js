'use strict';

// HYPHA · W5.3 Living Note — Dead Note Detector (BLUEPRINT §10.2).
//
// A note is dead-suspect when ALL three conditions hold:
//   1. state = Dormant
//   2. age since last touch > 90 days
//   3. utility_score < 20  (per utility-score.js 8-factor formula)
//   4. zero outgoing edges (no [[wikilink]] or W5.2 typed-edge reference)
//
// "Dead" ≠ "delete". Archive is move-only:
//   vault/<slug>/<note>.md  →  vault/<slug>/.archive/<note>.md
//
// User can always restore. Re-activation goes through states.transition
// Archived → Active with reason "user_unarchived".
//
// dryRun=true (default) walks but doesn't move. Set dryRun=false to actually
// archive — the IPC handler should always confirm at UI before flipping it.

const fs   = require('node:fs');
const path = require('node:path');

const states = require('./states');
const utility = require('./utility-score');

const DEAD_THRESHOLDS = Object.freeze({
  MIN_AGE_DAYS: 90,
  MAX_UTILITY: 20,
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

function _safeReadText(abs) {
  try { return fs.readFileSync(abs, 'utf-8'); } catch (_) { return ''; }
}

function _parseFm(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return fm;
}

function _hasOutgoingEdges(text) {
  if (!text) return false;
  // wiki link [[X]] / [[X|alias]] OR W5.2 typed-edge `→ note:`
  if (/\[\[[^\]\n]+\]\]/.test(text)) return true;
  if (/→\s*note:\s*[^\s]/.test(text)) return true;
  return false;
}

function _daysSince(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  const ms = Date.now() - t;
  if (ms < 0) return 0;
  return ms / (1000 * 60 * 60 * 24);
}

function _ageDays(fm, statAbs) {
  // Prefer explicit frontmatter timestamps; fall back to mtime.
  const cand = fm.last_touched || fm.life_state_updated || fm.last_updated;
  if (cand) return _daysSince(cand);
  try {
    const stat = fs.statSync(statAbs);
    const ms = Date.now() - stat.mtime.getTime();
    if (ms < 0) return 0;
    return ms / (1000 * 60 * 60 * 24);
  } catch (_) {
    return Infinity;
  }
}

function _listMarkdownNotes(slugDir) {
  if (!fs.existsSync(slugDir)) return [];
  let dirents = [];
  try { dirents = fs.readdirSync(slugDir, { withFileTypes: true }); }
  catch (_) { return []; }
  const out = [];
  for (const d of dirents) {
    if (d.name.startsWith('.')) continue;        // skip .archive / .beiking
    if (d.isFile() && d.name.endsWith('.md')) {
      out.push(path.join(slugDir, d.name));
    }
  }
  return out;
}

function _utilityFromFm(fm) {
  return utility.computeUtilityScore({
    helped_lesson_count: Number(fm.helped_lesson_count) || 0,
    helped_decision_count: Number(fm.helped_decision_count) || 0,
    produced_action_count: Number(fm.produced_action_count) || 0,
    cited_count: Number(fm.cited_count) || 0,
    sparked_count: Number(fm.sparked_count) || 0,
    reduced_understanding_cost: fm.reduced_understanding_cost === 'true',
    influenced_product: fm.influenced_product === 'true',
    outdated_penalty: (fm.life_state === states.LIFE_STATES.OUTDATED),
  }).score;
}

/**
 * Scan vault subdir and return notes flagged as dead suspect.
 *
 * @param {string} slug
 * @returns {Array<{ path:string, deadness_score:number, reason:string,
 *                   state:string, utility:number, ageDays:number }>}
 */
function detectDeadNotes(slug) {
  if (!slug || typeof slug !== 'string') {
    throw new Error('living-note/dead-note-detector: slug required');
  }
  const root = _resolveVaultRoot(slug);
  const notes = _listMarkdownNotes(root);
  const out = [];
  for (const abs of notes) {
    const text = _safeReadText(abs);
    if (!text) continue;
    const fm = _parseFm(text);
    const state = fm.life_state || states.LIFE_STATES.DORMANT;
    if (state !== states.LIFE_STATES.DORMANT) continue;
    const age = _ageDays(fm, abs);
    if (age <= DEAD_THRESHOLDS.MIN_AGE_DAYS) continue;
    const uScore = _utilityFromFm(fm);
    if (uScore >= DEAD_THRESHOLDS.MAX_UTILITY) continue;
    if (_hasOutgoingEdges(text)) continue;
    // deadness_score: how dead. Higher = deader. 0-100 scale.
    const ageFactor = Math.min(age / 365, 1);                     // 0..1 (1 year cap)
    const utilityFactor = 1 - (uScore / DEAD_THRESHOLDS.MAX_UTILITY);
    const deadness = Math.round((ageFactor * 0.6 + utilityFactor * 0.4) * 100);
    out.push({
      path: abs,
      deadness_score: deadness,
      reason: `Dormant ${Math.round(age)}d · 工具分 ${uScore}/100 · 无出链`,
      state,
      utility: uScore,
      ageDays: Math.round(age),
    });
  }
  out.sort((a, b) => b.deadness_score - a.deadness_score);
  return out;
}

/**
 * Archive (move) the listed dead notes into vault/<slug>/.archive/.
 * Preserves filename. Dry-run by default — pass dryRun=false to actually move.
 *
 * @param {string} slug
 * @param {boolean} dryRun  default true
 * @param {Array<string>} [explicitPaths] optionally override the detected list
 * @returns {{ ok:true, dryRun:boolean, archived:string[], skipped:Array<{path:string,reason:string}> }}
 */
function archiveDeadNotes(slug, dryRun = true, explicitPaths) {
  if (!slug || typeof slug !== 'string') {
    throw new Error('living-note/dead-note-detector: slug required');
  }
  const root = _resolveVaultRoot(slug);
  const archiveDir = path.join(root, '.archive');
  const targets = Array.isArray(explicitPaths) && explicitPaths.length > 0
    ? explicitPaths.map(p => ({ path: p }))
    : detectDeadNotes(slug);

  const archived = [];
  const skipped = [];
  if (!dryRun) {
    try { fs.mkdirSync(archiveDir, { recursive: true }); } catch (_) {}
  }
  for (const t of targets) {
    const src = t.path;
    if (!fs.existsSync(src)) {
      skipped.push({ path: src, reason: 'missing' });
      continue;
    }
    const base = path.basename(src);
    const dst = path.join(archiveDir, base);
    if (fs.existsSync(dst)) {
      skipped.push({ path: src, reason: 'destination_exists' });
      continue;
    }
    if (dryRun) {
      archived.push(src);
      continue;
    }
    try {
      fs.renameSync(src, dst);
      archived.push(src);
    } catch (e) {
      skipped.push({ path: src, reason: `move_failed: ${e.message}` });
    }
  }
  return { ok: true, dryRun: !!dryRun, archived, skipped };
}

module.exports = {
  DEAD_THRESHOLDS,
  detectDeadNotes,
  archiveDeadNotes,
};
