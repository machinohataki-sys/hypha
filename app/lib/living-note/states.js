'use strict';

// HYPHA · W5.3 Living Note Reactivation — state machine (BLUEPRINT §10.2).
//
// 9 life states + permitted transitions. The point of Living Note is NOT
// flashcards: it is to make the *call-site* of a note explicit. Each state
// answers "what role does this note play *right now* in the user's cognition?"
//
//   Dormant       — exists on disk, not currently active in thought
//   Active        — touched by lesson / writing / decision in the last window
//   Useful        — at least one decision_followed event credits this note
//   Crystallized  — re-used across ≥ 3 lessons; promoted to principle/etc.
//   Operational   — folded into a checklist/workflow the user runs
//   Productized   — referenced in product blueprint / shipped artifact
//   Outdated      — stale by clock, no new evidence
//   Contradicted  — new evidence (frontier, lesson, source) flatly disagrees
//   Archived      — user-archived (NOT deleted). Reversible only by re-activate.
//
// Transitions are *whitelisted*. Calling transitionNoteState with an
// off-graph move throws — illegal moves are bugs, not silent no-ops.
// Reason codes are recorded in frontmatter `state_history:` for audit.
//
// Pure fs + path. No LLM. Re-uses the markdown frontmatter convention
// already established by lesson notes / vault.js parseFrontmatter().

const fs = require('node:fs');
const path = require('node:path');

const LIFE_STATES = Object.freeze({
  DORMANT: 'Dormant',
  ACTIVE: 'Active',
  USEFUL: 'Useful',
  CRYSTALLIZED: 'Crystallized',
  OPERATIONAL: 'Operational',
  PRODUCTIZED: 'Productized',
  OUTDATED: 'Outdated',
  CONTRADICTED: 'Contradicted',
  ARCHIVED: 'Archived',
});

const STATE_VALUES = new Set(Object.values(LIFE_STATES));

// Adjacency list — legal `from -> to` moves.
// Per BLUEPRINT §10.2 + Wave 5.3 spec.
//   - Productized only exits via Outdated/Contradicted (no demotion to lower
//     life states; productized notes stay productized until the product is
//     killed or the underlying fact is contradicted).
//   - Archived can be re-activated (Archived → Active) by user gesture only.
const STATE_TRANSITIONS = Object.freeze({
  Dormant:      Object.freeze(['Active', 'Outdated', 'Archived']),
  Active:       Object.freeze(['Useful', 'Dormant', 'Contradicted', 'Outdated']),
  Useful:       Object.freeze(['Crystallized', 'Operational', 'Dormant', 'Contradicted', 'Outdated']),
  Crystallized: Object.freeze(['Operational', 'Productized', 'Contradicted', 'Outdated']),
  Operational:  Object.freeze(['Productized', 'Outdated', 'Contradicted']),
  Productized:  Object.freeze(['Outdated', 'Contradicted']),
  Outdated:     Object.freeze(['Archived', 'Active']),
  Contradicted: Object.freeze(['Archived', 'Active']),
  Archived:     Object.freeze([]),   // terminal (re-activate path goes through user-gesture write directly)
});

function isLifeState(s) {
  return typeof s === 'string' && STATE_VALUES.has(s);
}

function canTransition(fromState, toState) {
  if (!isLifeState(fromState) || !isLifeState(toState)) return false;
  if (fromState === toState) return false;
  const allowed = STATE_TRANSITIONS[fromState];
  return Array.isArray(allowed) && allowed.includes(toState);
}

function _validateMove(fromState, toState) {
  if (!isLifeState(fromState)) {
    throw new Error(`living-note/states: unknown fromState "${fromState}"`);
  }
  if (!isLifeState(toState)) {
    throw new Error(`living-note/states: unknown toState "${toState}"`);
  }
  if (fromState === toState) {
    throw new Error(`living-note/states: no-op transition ${fromState}→${toState}`);
  }
  if (!canTransition(fromState, toState)) {
    throw new Error(
      `living-note/states: illegal transition ${fromState}→${toState} ` +
      `(allowed from ${fromState}: ${STATE_TRANSITIONS[fromState].join('|') || '∅'})`
    );
  }
}

function _readText(abs) {
  try { return fs.readFileSync(abs, 'utf-8'); } catch (_) { return ''; }
}

function _writeText(abs, text) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf-8');
}

// Frontmatter rewrite — mirrors lesson-body-generator pattern. Preserves
// existing YAML keys, replaces `life_state:` line, appends `state_history:`
// JSON-as-string entry (one per line). Body content untouched.
function _rewriteFrontmatter(text, patch, historyEntry) {
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  let fmBody = fmMatch ? fmMatch[1] : '';
  let bodyAfter = fmMatch ? text.slice(fmMatch[0].length) : text;

  const lines = fmBody.split(/\r?\n/);
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv && Object.prototype.hasOwnProperty.call(patch, kv[1])) {
      out.push(`${kv[1]}: ${patch[kv[1]]}`);
      seen.add(kv[1]);
    } else {
      out.push(line);
    }
  }
  for (const k of Object.keys(patch)) {
    if (!seen.has(k)) out.push(`${k}: ${patch[k]}`);
  }
  if (historyEntry) {
    // Append a JSONL-style row inline (one line, no nested YAML — keeps
    // parseFrontmatter compatible).
    out.push(`state_history_entry: ${JSON.stringify(historyEntry)}`);
  }
  const newFm = out.filter(l => l.length > 0).join('\n');
  return `---\n${newFm}\n---\n${bodyAfter}`;
}

/**
 * Transition a note from `fromState` to `toState`. Validates the move
 * against STATE_TRANSITIONS, then rewrites the frontmatter `life_state`
 * key and appends a `state_history_entry` audit row.
 *
 * @param {string} nodePath  absolute path to the note .md file
 * @param {string} fromState current state (must match frontmatter or caller)
 * @param {string} toState   target state
 * @param {string} reason    short human reason (e.g. "decision_followed")
 * @returns {{ ok: true, nodePath: string, from: string, to: string, ts: string }}
 * @throws Error on illegal transition (caller bug) or fs failure
 */
function transitionNoteState(nodePath, fromState, toState, reason) {
  if (!nodePath || typeof nodePath !== 'string') {
    throw new Error('living-note/states: nodePath required (absolute path)');
  }
  _validateMove(fromState, toState);
  const ts = new Date().toISOString();
  const text = _readText(nodePath);
  if (!text) {
    throw new Error(`living-note/states: note not readable at ${nodePath}`);
  }
  const rewritten = _rewriteFrontmatter(text, {
    life_state: toState,
    life_state_updated: ts,
  }, {
    ts,
    from: fromState,
    to: toState,
    reason: typeof reason === 'string' && reason ? reason : null,
  });
  _writeText(nodePath, rewritten);
  return { ok: true, nodePath, from: fromState, to: toState, ts };
}

module.exports = {
  LIFE_STATES,
  STATE_TRANSITIONS,
  isLifeState,
  canTransition,
  transitionNoteState,
  // internal-exposed for unit tests
  _rewriteFrontmatter,
};
