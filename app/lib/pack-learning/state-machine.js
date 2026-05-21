'use strict';

// HYPHA · W7.1 Pack Learning State Machine (BLUEPRINT §12.4).
//
// 9 explicit states a community Pack walks through as the user moves it from
// "downloaded YAML on disk" to "principle baked into the user's own corpus":
//
//   Imported → Previewed → Learning → Understood
//            → Applied → Personalized → Integrated
//            → Productized → Crystallized
//
// Why a separate state machine from W5.3 Living Note (9 life states) and from
// W3.4 Product Spark (5 states)?  Three reasons (theory-ship boundary):
//   1. Different epistemic object — a Pack is an INSTRUMENT (someone else's
//      compressed cognition). A Note is your raw capture. A Spark is your
//      idea. Conflating their lifecycles flattens distinct lifecycles into
//      one and forces fake transitions.
//   2. Different operations — `forkAndRewrite` is meaningful for a Pack
//      (third-party knowledge under license, see commons/license-layer)
//      but undefined for a Note or Spark.
//   3. Different terminal — Crystallized for a Pack means "I distilled
//      this into MY principle"; that is the W5.3 crystallizer hand-off,
//      not the W3.4 spark "implemented" terminal.
//
// Persistence: per-pack state is a tiny JSON file under
// `vault/.hypha/pack-learning/<pack_id>.json`. The directory is hidden from
// the vault tree (per W5.2 convention of `.hypha/`). Pack state is NOT
// scoped to a slug — a single user installs the same pack once. Where the
// pack is _applied_ (which slug + lesson + note) is recorded inside the
// state record as a journal, not by foldering.
//
// All functions are sync + fs-backed. No LLM. No async. CommonJS for the
// Electron main process.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ─── Constants ──────────────────────────────────────────────────────────────

const PACK_LEARNING_STATES = Object.freeze([
  'Imported',
  'Previewed',
  'Learning',
  'Understood',
  'Applied',
  'Personalized',
  'Integrated',
  'Productized',
  'Crystallized',
]);

// 8 directed transitions (BLUEPRINT §12.4). The graph is a DAG with two
// natural branches from `Understood` (Apply path vs Fork path) that re-merge
// at `Integrated`. Crystallized is the only deep terminal — Productized
// can still walk forward to Crystallized when the user distills the
// productized pack into a principle.
//
// `Previewed → Imported` is the "decline" edge — user previewed, decided
// not to learn it now, parks it for later. Not lossy: parking-queue holds
// the pointer. We keep `Imported` reachable from `Previewed` so the state
// reflects "available but not started" rather than dead-ending the pack.
const PACK_LEARNING_TRANSITIONS = Object.freeze({
  Imported:     Object.freeze(['Previewed']),
  Previewed:    Object.freeze(['Learning', 'Imported']),
  Learning:     Object.freeze(['Understood']),
  Understood:   Object.freeze(['Applied', 'Personalized']),
  Applied:      Object.freeze(['Personalized', 'Integrated']),
  Personalized: Object.freeze(['Integrated']),
  Integrated:   Object.freeze(['Productized', 'Crystallized']),
  Productized:  Object.freeze(['Crystallized']),
  Crystallized: Object.freeze([]),
});

// ─── Path resolution (mirrors product-spark.js _vaultRoot) ─────────────────

function _vaultRoot() {
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) {
    return process.env.HYPHA_DATA;
  }
  if (process.env.HYPHA_VAULT_DIR && fs.existsSync(process.env.HYPHA_VAULT_DIR)) {
    return process.env.HYPHA_VAULT_DIR;
  }
  return path.join(__dirname, '..', '..', '..', 'data');
}

function _stateDir() {
  // Hidden under vault root, NOT inside any slug — pack state is global per
  // user, slug-independent.
  return path.join(_vaultRoot(), '.hypha', 'pack-learning');
}

function _ensurePackId(packId) {
  if (!packId || typeof packId !== 'string') {
    throw new Error('pack-learning: packId required (non-empty string)');
  }
  if (packId.includes('..') || packId.includes(path.sep) || /[<>:"|?*\0]/.test(packId)) {
    throw new Error('pack-learning: packId must be a safe filename segment');
  }
}

function _statePath(packId) {
  _ensurePackId(packId);
  return path.join(_stateDir(), `${packId}.json`);
}

function _readState(packId) {
  const p = _statePath(packId);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch (_) {
    return null;
  }
}

function _writeState(packId, record) {
  const dir = _stateDir();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = _statePath(packId) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(tmp, _statePath(packId));
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Return the legal next states for `currentState`. Empty array for terminal
 * (Crystallized). Unknown state → empty array (defensive — caller should
 * have validated state name first).
 *
 * @param {string} currentState
 * @returns {string[]}
 */
function getValidTransitions(currentState) {
  if (!currentState || typeof currentState !== 'string') return [];
  const row = PACK_LEARNING_TRANSITIONS[currentState];
  return row ? row.slice() : [];
}

/**
 * Initial state for a freshly-imported pack. The first time a user installs
 * a pack via `community.js`, we create the record at `Imported` with an
 * empty journal. Caller is community.js's install hook (deferred to W7.1
 * surface activation — for now any caller can seed it).
 *
 * @param {string} packId
 * @param {object} [meta]  optional pack metadata snapshot (topic, version, ...)
 * @returns {{packId, state, journal, _path}}
 */
function initPackState(packId, meta = {}) {
  _ensurePackId(packId);
  const existing = _readState(packId);
  if (existing) return Object.assign(existing, { _path: _statePath(packId) });
  const record = {
    packId,
    state: 'Imported',
    journal: [{ at: new Date().toISOString(), from: null, to: 'Imported', reason: 'initial-import' }],
    meta: meta && typeof meta === 'object' ? meta : {},
  };
  _writeState(packId, record);
  return Object.assign({}, record, { _path: _statePath(packId) });
}

/**
 * Read current state. Returns null when pack was never initialized — caller
 * should treat null as "Imported not yet recorded" and either init or skip.
 *
 * @param {string} packId
 * @returns {{packId, state, journal, meta}|null}
 */
function getPackState(packId) {
  _ensurePackId(packId);
  return _readState(packId);
}

/**
 * Strict transition. Validates: pack exists OR fromState='Imported' implies
 * init; fromState matches the persisted state; toState is in the valid-next
 * set for fromState. Throws on any violation — callers can catch + display.
 *
 * Sync + idempotent on the file at level of fsync — uses a tmp+rename write
 * so a crashed write does not leave a half-state file.
 *
 * @param {string} packId
 * @param {string} fromState
 * @param {string} toState
 * @param {string} [reason]   short string for the journal row
 * @returns {{packId, state, journal, prevState}}
 */
function transitionPackState(packId, fromState, toState, reason = '') {
  _ensurePackId(packId);
  if (!PACK_LEARNING_STATES.includes(fromState)) {
    throw new Error(`pack-learning: unknown fromState "${fromState}"`);
  }
  if (!PACK_LEARNING_STATES.includes(toState)) {
    throw new Error(`pack-learning: unknown toState "${toState}"`);
  }
  const valid = getValidTransitions(fromState);
  if (!valid.includes(toState)) {
    throw new Error(
      `pack-learning: illegal transition ${fromState} → ${toState} ` +
      `(valid next: ${valid.join(', ') || '(terminal)'})`
    );
  }
  let record = _readState(packId);
  if (!record) {
    // Allow callers to bootstrap on the Imported → Previewed step without
    // first calling initPackState — convenience.
    if (fromState !== 'Imported') {
      throw new Error(`pack-learning: no record for ${packId}; init first`);
    }
    record = initPackState(packId);
  }
  if (record.state !== fromState) {
    throw new Error(
      `pack-learning: state mismatch — persisted=${record.state} but fromState=${fromState}`
    );
  }
  const next = {
    packId,
    state: toState,
    journal: Array.isArray(record.journal) ? record.journal.slice() : [],
    meta: record.meta || {},
  };
  next.journal.push({
    at: new Date().toISOString(),
    from: fromState,
    to: toState,
    reason: String(reason || '').slice(0, 240),
  });
  _writeState(packId, next);
  return Object.assign({}, next, { prevState: fromState, _path: _statePath(packId) });
}

/**
 * Convenience: is this state a terminal (no outbound transitions)?
 */
function isTerminal(state) {
  return getValidTransitions(state).length === 0;
}

/**
 * Convenience: enumerate every legal directed edge as { from, to } pairs.
 * Useful for renderer state-graph visualisations.
 */
function listAllTransitions() {
  const out = [];
  for (const from of PACK_LEARNING_STATES) {
    for (const to of getValidTransitions(from)) {
      out.push({ from, to });
    }
  }
  return out;
}

module.exports = {
  PACK_LEARNING_STATES,
  PACK_LEARNING_TRANSITIONS,
  getValidTransitions,
  initPackState,
  getPackState,
  transitionPackState,
  isTerminal,
  listAllTransitions,
  // exposed for tests + IPC inspection — do not write into directly
  _vaultRoot,
  _stateDir,
};
