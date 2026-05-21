'use strict';
// HYPHA · Tutor Identity (Phase D.1, 2026-05-18)
//
// Council verdict (Lung/Leo/Yogo 三 R1 一致 收敛): HYPHA 当前 brief tool-like
// (lesson → 离开 → 几天后回) 形态在 Pareto-inferior 轴磨刀. Hattie d=0.72
// relationship + d=0.75 teacher clarity >> d=0.50 单 enum move. 主轴变量 =
// IDENTITY 持续性 across lessons, ! pedagogy_move 选 K.
//
// 此模块 = 文件持久 identity primitive. ! 靠 LLM session memory (历史课
// 不可靠), 靠 vault/<chain-slug>/tutor-identity.json 显式 dump.
//
// Schema v1:
//   {
//     schema_version: 1,
//     voice_register: 'italic-garamond-warm' | ...,
//     voice_name: 'Victor' | user_chosen,
//     established_priors: [
//       {lesson_idx, user_produced_text, concept_anchored, stored_at}
//     ],
//     callback_log: [
//       {lesson_idx, callbacks_to_lesson: [N-1, N-3], callback_text, stored_at}
//     ],
//     relationship_tokens: [
//       {event, lesson_idx, text, stored_at}
//     ],
//     created_at, updated_at
//   }
//
// Immutability discipline: every save creates new object via spread; never
// mutates in place. Consumer (callback-inject.js) reads, never writes.

const vault = require('../vault');

const SCHEMA_VERSION = 1;
const IDENTITY_REL = (chainSlug) => `${chainSlug}/tutor-identity.json`;

const DEFAULT_VOICE_REGISTER = 'italic-garamond-warm';
const DEFAULT_VOICE_NAME     = 'Victor';

/**
 * Build a fresh identity object with defaults.
 * @returns {Object}
 */
function _freshIdentity() {
  const now = new Date().toISOString();
  return {
    schema_version: SCHEMA_VERSION,
    voice_register: DEFAULT_VOICE_REGISTER,
    voice_name: DEFAULT_VOICE_NAME,
    established_priors: [],
    callback_log: [],
    relationship_tokens: [],
    created_at: now,
    updated_at: now,
  };
}

/**
 * Load identity for a chain. Returns a defaults-filled object when file
 * missing or unparseable — never throws. Caller should treat as read-only.
 *
 * @param {string} chainSlug
 * @returns {Object}
 */
function loadIdentity(chainSlug) {
  if (!chainSlug || typeof chainSlug !== 'string') return _freshIdentity();
  const stored = vault.readJSON(IDENTITY_REL(chainSlug), null);
  if (!stored || typeof stored !== 'object') return _freshIdentity();
  // Defensive: backfill missing fields so callers can always destructure safely.
  const base = _freshIdentity();
  return {
    ...base,
    ...stored,
    // arrays must be arrays even if stored was malformed
    established_priors: Array.isArray(stored.established_priors) ? stored.established_priors : [],
    callback_log:       Array.isArray(stored.callback_log)       ? stored.callback_log       : [],
    relationship_tokens: Array.isArray(stored.relationship_tokens) ? stored.relationship_tokens : [],
    // schema_version always = current writer's
    schema_version: SCHEMA_VERSION,
    created_at: stored.created_at || base.created_at,
  };
}

/**
 * Persist a full identity object. Stamps updated_at. Returns the saved object.
 * Use mutating helpers (appendPrior/appendCallback/...) for additions —
 * this is the lower-level writer.
 *
 * @param {string} chainSlug
 * @param {Object} identity
 * @returns {Object}
 */
function saveIdentity(chainSlug, identity) {
  if (!chainSlug) throw new Error('tutor-identity.saveIdentity: chainSlug required');
  const safe = {
    ..._freshIdentity(),
    ...identity,
    schema_version: SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
  };
  vault.writeJSON(IDENTITY_REL(chainSlug), safe);
  return safe;
}

/**
 * Append a prior to established_priors[]. Immutable: returns NEW identity.
 *
 * @param {string} chainSlug
 * @param {{lesson_idx: number, user_produced_text: string, concept_anchored?: string}} prior
 * @returns {Object} saved identity
 */
function appendPrior(chainSlug, prior) {
  if (!prior || typeof prior !== 'object') throw new Error('appendPrior: prior must be object');
  if (typeof prior.user_produced_text !== 'string' || !prior.user_produced_text.trim()) {
    throw new Error('appendPrior: user_produced_text required (non-empty string)');
  }
  const id = loadIdentity(chainSlug);
  const entry = {
    lesson_idx: Number.isFinite(prior.lesson_idx) ? prior.lesson_idx : null,
    user_produced_text: prior.user_produced_text.trim().slice(0, 800), // cap noise
    concept_anchored: typeof prior.concept_anchored === 'string' ? prior.concept_anchored.trim() : null,
    stored_at: new Date().toISOString(),
  };
  return saveIdentity(chainSlug, {
    ...id,
    established_priors: [...id.established_priors, entry],
  });
}

/**
 * Append a callback record. Use AFTER lesson-N is generated, recording
 * which prior lessons N-K were actually referenced (in the generated prompt).
 *
 * @param {string} chainSlug
 * @param {{lesson_idx: number, callbacks_to_lesson: number[], callback_text?: string}} cb
 * @returns {Object}
 */
function appendCallback(chainSlug, cb) {
  if (!cb || typeof cb !== 'object') throw new Error('appendCallback: cb must be object');
  const id = loadIdentity(chainSlug);
  const entry = {
    lesson_idx: Number.isFinite(cb.lesson_idx) ? cb.lesson_idx : null,
    callbacks_to_lesson: Array.isArray(cb.callbacks_to_lesson)
      ? cb.callbacks_to_lesson.filter(n => Number.isFinite(n))
      : [],
    callback_text: typeof cb.callback_text === 'string' ? cb.callback_text.trim().slice(0, 600) : null,
    stored_at: new Date().toISOString(),
  };
  return saveIdentity(chainSlug, {
    ...id,
    callback_log: [...id.callback_log, entry],
  });
}

/**
 * Append a relationship token (meaningful interaction event the tutor should
 * remember — corrections, moments of recognition, repeated patterns).
 *
 * @param {string} chainSlug
 * @param {{event: string, lesson_idx?: number, text?: string}} token
 * @returns {Object}
 */
function appendRelationshipToken(chainSlug, token) {
  if (!token || typeof token !== 'object') throw new Error('appendRelationshipToken: token must be object');
  if (typeof token.event !== 'string' || !token.event.trim()) {
    throw new Error('appendRelationshipToken: event required (non-empty string)');
  }
  const id = loadIdentity(chainSlug);
  const entry = {
    event: token.event.trim().slice(0, 120),
    lesson_idx: Number.isFinite(token.lesson_idx) ? token.lesson_idx : null,
    text: typeof token.text === 'string' ? token.text.trim().slice(0, 400) : null,
    stored_at: new Date().toISOString(),
  };
  return saveIdentity(chainSlug, {
    ...id,
    relationship_tokens: [...id.relationship_tokens, entry],
  });
}

module.exports = {
  loadIdentity,
  saveIdentity,
  appendPrior,
  appendCallback,
  appendRelationshipToken,
  _internals: { _freshIdentity, SCHEMA_VERSION, IDENTITY_REL, DEFAULT_VOICE_REGISTER, DEFAULT_VOICE_NAME },
};
