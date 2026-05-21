'use strict';
// HYPHA · Cohort refiner (S86 SimPersona post-Day-1 loop, v1.0)
//
// After user accumulates real events (lessons completed, concepts asked,
// questions raised), re-classify archetype + persist diff. Closes the cold
// → warm loop: Day-1 priors gave a guess; events.jsonl converts guess into
// posterior. Persisted to `vault/.hypha/archetype-revisions.jsonl` so the
// system can show "你最初被识别为 PM, 5 节课后系统将你重置为 engineer-mid"
// transparency without losing the original signal.
//
// V1.0 = rule-based aggregation. V1.1 will swap in real VQ-VAE-style
// embedding on collected `events.jsonl` (SimPersona arXiv 2605.14205,
// target 78% conversion alignment).
//
// Backward compat (S88 MSIFR rule): missing events.jsonl = no-op return,
// ! throw. Refiner is opt-in: caller decides when to run (e.g. on session
// end after lesson 5).
//
// Surface contract:
//   refineArchetype({ userId, currentArchetype, sessionEvents?, vault? }) → revision
//   readEventsForUser(vault, userId)  → events[]
//   appendRevision(vault, revision)   → { ok }

const path = require('node:path');
const fs = require('node:fs');
const { ARCHETYPES, isKnownArchetype } = require('./preping-priors.js');
const { classifyFromOnboarding } = require('./persona-classifier.js');

const EVENTS_REL    = '.hypha/events.jsonl';
const REVISIONS_REL = '.hypha/archetype-revisions.jsonl';

function _resolveVault(v) {
  if (!v || typeof v !== 'object') {
    return {
      exists:      () => false,
      readJSON:    (_r, d) => d,
      writeJSON:   () => {},
      appendJSONL: () => {},
      readText:    () => '',
    };
  }
  return {
    exists:      typeof v.exists      === 'function' ? v.exists      : () => false,
    readJSON:    typeof v.readJSON    === 'function' ? v.readJSON    : (_r, d) => d,
    writeJSON:   typeof v.writeJSON   === 'function' ? v.writeJSON   : () => {},
    appendJSONL: typeof v.appendJSONL === 'function' ? v.appendJSONL : () => {},
    readText:    typeof v.readText    === 'function' ? v.readText    : () => '',
  };
}

/**
 * readEventsForUser — pull rows from .hypha/events.jsonl filtered by userId.
 * Returns [] if file missing OR userId not matched. ! throw on parse error;
 * malformed rows are skipped (S88: silent-catch only on read-only deserialize).
 */
function readEventsForUser(vault, userId) {
  const v = _resolveVault(vault);
  if (!v.exists(EVENTS_REL)) return [];
  const raw = v.readText(EVENTS_REL) || '';
  if (!raw) return [];
  const lines = raw.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (_e) {
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    if (userId && row.userId && row.userId !== userId) continue;
    out.push(row);
  }
  return out;
}

/**
 * _summarizeEvents — aggregate signal from event rows into a free-text blob
 * the classifier can score. Picks fields that correlate with archetype.
 */
function _summarizeEvents(events) {
  const parts = [];
  for (const ev of events) {
    if (typeof ev.role === 'string')             parts.push(ev.role);
    if (typeof ev.question === 'string')         parts.push(ev.question);
    if (typeof ev.lesson_topic === 'string')     parts.push(ev.lesson_topic);
    if (typeof ev.concept === 'string')          parts.push(ev.concept);
    if (typeof ev.note === 'string')             parts.push(ev.note);
    if (typeof ev.goal === 'string')             parts.push(ev.goal);
    if (typeof ev.lesson_title === 'string')     parts.push(ev.lesson_title);
    if (Array.isArray(ev.concepts)) {
      for (const c of ev.concepts) if (typeof c === 'string') parts.push(c);
    }
    if (Array.isArray(ev.questions)) {
      for (const q of ev.questions) if (typeof q === 'string') parts.push(q);
    }
  }
  return parts.join(' \n ');
}

/**
 * appendRevision — write a revision row to .hypha/archetype-revisions.jsonl.
 * Idempotent in spirit (caller should compare prev row before calling), but
 * we don't dedupe — caller owns that. Returns { ok: boolean, persisted: bool }.
 */
function appendRevision(vault, revision) {
  const v = _resolveVault(vault);
  if (!revision || typeof revision !== 'object') return { ok: false, persisted: false };
  try {
    v.appendJSONL(REVISIONS_REL, revision);
    return { ok: true, persisted: true };
  } catch (e) {
    return { ok: false, persisted: false, error: String(e && e.message || e) };
  }
}

/**
 * refineArchetype — re-classify a user based on accumulated events.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.currentArchetype  — current pick (from onboarding)
 * @param {Array}  [opts.sessionEvents]   — caller can pass events directly (preferred for tests)
 * @param {object} [opts.vault]           — vault accessor; if events not passed, refiner reads from .hypha/events.jsonl
 * @param {number} [opts.minEvents=5]     — below this, refiner declines to revise
 * @returns {{
 *   userId, previous, next, changed, confidence, why, eventCount, ts, breakdown
 * }}
 */
function refineArchetype(opts) {
  const o = opts || {};
  const userId = String(o.userId || 'anonymous');
  const previous = isKnownArchetype(o.currentArchetype) ? o.currentArchetype : null;
  const minEvents = Number.isInteger(o.minEvents) ? o.minEvents : 5;
  const ts = new Date().toISOString();

  let events = Array.isArray(o.sessionEvents) ? o.sessionEvents : null;
  if (!events) {
    events = readEventsForUser(o.vault, userId);
  }
  const eventCount = events.length;

  if (eventCount < minEvents) {
    return {
      userId,
      previous,
      next: previous,
      changed: false,
      confidence: 0,
      why: `! 足够 events (${eventCount}/${minEvents}) — 保持 ${previous || 'unset'}。`,
      eventCount,
      ts,
      breakdown: null,
    };
  }

  const summary = _summarizeEvents(events);
  const result = classifyFromOnboarding({ context: summary });

  const next = result.archetype;
  const changed = previous !== null && previous !== next;
  return {
    userId,
    previous,
    next,
    changed,
    confidence: result.confidence,
    why: changed
      ? `${eventCount} 事件后由 ${previous} 重分类为 ${next}: ${result.why}`
      : `${eventCount} 事件确认 ${next}: ${result.why}`,
    eventCount,
    ts,
    breakdown: result.breakdown,
  };
}

module.exports = {
  refineArchetype,
  readEventsForUser,
  appendRevision,
  EVENTS_REL,
  REVISIONS_REL,
};
