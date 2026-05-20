'use strict';
// HYPHA · W1.2 Micro-Judges · orchestrator
// ----------------------------------------------------------------------------
// 3 micro-judges that compose into the W1.1 9-dim quality-harness:
//   1. goal-drift-judge   → wraps quality-harness/judges/goal-coherence.js
//   2. anti-generic-judge → wraps quality-harness/judges/not-generic-course.js
//   3. jargon-judge       → wraps quality-harness/judges/jargon-control.js
//
// gradeAllThree runs the trio in parallel (Promise.all), aggregates verdict +
// weakest dim, and appends one row to <vault>/<slug>/events.jsonl:
//   { ts, type: 'judges:graded', drift_score, generic_score, jargon_density,
//     weakest, overall_pass }
//
// events.jsonl write is optional — only fires if context.slug supplied so the
// orchestrator stays usable from unit tests / IPC scaffolds without a vault.

const path = require('node:path');
const fs = require('node:fs');

const { gradeDrift, DRIFT_FAIL, DRIFT_WARN } = require('./goal-drift-judge');
const { gradeGeneric, GENERIC_FAIL, GENERIC_WARN } = require('./anti-generic-judge');
const { gradeJargon, JARGON_FAIL, JARGON_WARN } = require('./jargon-judge');

function _bandOf(score, FAIL, WARN) {
  if (score < FAIL) return 'FAIL';
  if (score < WARN) return 'WARN';
  return 'PASS';
}

function _appendEvent(slug, row) {
  if (!slug) return; // events.jsonl is opt-in
  try {
    // resolve vault root the same way main.js does (env override, else default).
    // Late-require to keep this module decoupled from Electron when called by
    // pure-node tests / scaffolds.
    let vault;
    try { vault = require('../vault'); } catch (_) { vault = null; }
    if (vault && typeof vault.appendJSONL === 'function') {
      vault.appendJSONL(`${slug}/events.jsonl`, row);
      return;
    }
    // Last-ditch: best-effort filesystem write at HYPHA_VAULT_ROOT/<slug>/events.jsonl.
    const root = process.env.HYPHA_VAULT_ROOT;
    if (!root) return;
    const dir = path.join(root, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(row) + '\n', 'utf8');
  } catch (_) { /* events.jsonl write is non-fatal */ }
}

/**
 * Run all 3 micro-judges in parallel and return aggregated verdict.
 *
 * @param {object} lessonBody — 11-field v0.2 body.
 * @param {object} [context]
 * @param {object} [context.goalContract] — passed to drift judge.
 * @param {Array}  [context.prevLessons]  — passed to drift judge (most recent 3).
 * @param {string} [context.topic]        — passed to anti-generic judge.
 * @param {string} [context.audience_level] — passed to jargon judge.
 * @param {string} [context.slug]         — if set, append events.jsonl row.
 * @param {number} [context.idx]          — lesson index, for events.jsonl row.
 * @returns {Promise<{
 *   drift: object, generic: object, jargon: object,
 *   overall_pass: boolean,
 *   weakest: 'drift'|'generic'|'jargon',
 * }>}
 */
async function gradeAllThree(lessonBody, context = {}) {
  const [drift, generic, jargon] = await Promise.all([
    gradeDrift({
      lessonBody,
      goalContract: context.goalContract,
      prevLessons: context.prevLessons,
    }),
    gradeGeneric({
      lessonBody,
      topic: context.topic,
    }),
    gradeJargon({
      lessonBody,
      audience_level: context.audience_level,
    }),
  ]);

  const driftBand = _bandOf(drift.score, DRIFT_FAIL, DRIFT_WARN);
  const genericBand = _bandOf(generic.score, GENERIC_FAIL, GENERIC_WARN);
  const jargonBand = _bandOf(jargon.score, JARGON_FAIL, JARGON_WARN);

  // overall_pass = no judge in FAIL band.
  const overall_pass = driftBand !== 'FAIL' && genericBand !== 'FAIL' && jargonBand !== 'FAIL';

  // weakest = lowest score (normalised — all on 0-100).
  const scored = [
    { kind: 'drift',   score: drift.score   },
    { kind: 'generic', score: generic.score },
    { kind: 'jargon',  score: jargon.score  },
  ].sort((a, b) => a.score - b.score);
  const weakest = scored[0].kind;

  _appendEvent(context.slug, {
    ts: new Date().toISOString(),
    type: 'judges:graded',
    idx: typeof context.idx === 'number' ? context.idx : null,
    drift_score: drift.score,
    generic_score: generic.score,
    jargon_density: jargon.jargon_density,
    jargon_score: jargon.score,
    weakest,
    overall_pass,
  });

  return { drift, generic, jargon, overall_pass, weakest };
}

module.exports = {
  gradeDrift,
  gradeGeneric,
  gradeJargon,
  gradeAllThree,
  // re-export thresholds for UI badge color decisions.
  thresholds: {
    DRIFT_FAIL, DRIFT_WARN,
    GENERIC_FAIL, GENERIC_WARN,
    JARGON_FAIL, JARGON_WARN,
  },
};
