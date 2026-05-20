'use strict';

// HYPHA · W8.2 Learning Commons Flywheel · Step 1 — Note → Spark
//
// Transforms qualified vault Notes into Product Spark candidates. This is
// the FIRST hop of the §20 v2.5 flywheel:
//
//     User Note → [evaluateNoteForSpark] → eligible? → proposeNoteToSpark
//        ─────────────────────────────────────────────────────────────▶
//     (W3.4 createSpark seeded)
//
// Boundary contract (do NOT cross):
//   - Reads vault/<slug>/lesson-NN.md frontmatter + W5.3 utility-score lib +
//     W7.5 living-note states lib. Does NOT mutate notes — write-side is
//     W3.x territory.
//   - Calls W3.4 product-spark.createSpark(slug, data) with source.type='note'.
//   - No LLM. Eligibility = deterministic rule set. The reason a note is
//     eligible (or not) is surfaced as `reasons[]` so the UI can render a
//     transparent funnel rather than a black-box recommendation.
//
// Eligibility rules (cumulative — ALL must pass):
//   1. utility_score (W5.3 computeUtilityScore) >= UTILITY_THRESHOLD
//   2. life-state ∈ ALLOWED_STATES ({Useful, Crystallized})
//   3. note age in days >= MIN_AGE_DAYS
//   4. cited_count (decision_followed events crediting this note) >= MIN_CITED
//
// If a rule lib is missing (test env, dry-run, prior to W5.3/W7.5 ship),
// the module DEGRADES OPEN by treating the missing signal as neutral
// (pass with a [DEGRADED] reason tag). This is INTENTIONAL: blocking the
// whole flywheel because one upstream lib is absent would defeat the
// flywheel's purpose. Surfaced in `reasons` for audit.

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Eligibility thresholds (per BLUEPRINT §20 v2.5 + spec/learning-commons-flywheel.md)
// ---------------------------------------------------------------------------

const UTILITY_THRESHOLD = 70;
const MIN_AGE_DAYS = 7;
const MIN_CITED = 2;
const ALLOWED_STATES = Object.freeze(['Useful', 'Crystallized']);

// ---------------------------------------------------------------------------
// Best-effort lib loading — degrade open if upstream is absent
// ---------------------------------------------------------------------------

let _utilityScore = null;
try { _utilityScore = require('../living-note/utility-score'); } catch (_) { _utilityScore = null; }

let _states = null;
try { _states = require('../living-note/states'); } catch (_) { _states = null; }

let _productSpark = null;
try { _productSpark = require('../product-spark'); } catch (_) { _productSpark = null; }

let _events = null;
try { _events = require('../events'); } catch (_) { _events = null; }

// ---------------------------------------------------------------------------
// Path helpers — mirror W3.x convention (vault/<slug>/lesson-NN.md)
// ---------------------------------------------------------------------------

function _vaultRoot() {
  // Prefer explicit override (test harness); fall back to repo-root/vault.
  if (process.env.HYPHA_VAULT_ROOT) return process.env.HYPHA_VAULT_ROOT;
  return path.join(process.cwd(), 'vault');
}

function _slugDir(slug) {
  if (!slug || typeof slug !== 'string') {
    throw new TypeError('slug must be a non-empty string');
  }
  return path.join(_vaultRoot(), slug);
}

// ---------------------------------------------------------------------------
// Frontmatter parsing — minimal YAML-ish reader; keeps note module untouched
// ---------------------------------------------------------------------------

function _readFrontmatter(notePath) {
  if (!fs.existsSync(notePath)) return null;
  const raw = fs.readFileSync(notePath, 'utf8');
  if (!raw.startsWith('---')) return { _bodyOnly: true, content: raw };
  const end = raw.indexOf('\n---', 4);
  if (end < 0) return { _bodyOnly: true, content: raw };
  const fm = raw.slice(4, end);
  const body = raw.slice(end + 4);
  const out = { content: body };
  for (const line of fm.split('\n')) {
    const m = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    // Strip surrounding quotes
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    // Number coercion only when value is fully numeric
    if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    out[m[1]] = v;
  }
  return out;
}

function _ageDays(frontmatter) {
  const stamp = frontmatter && (frontmatter.created_at || frontmatter.created);
  if (!stamp) return null;
  const d = new Date(stamp);
  if (Number.isNaN(d.valueOf())) return null;
  return Math.floor((Date.now() - d.valueOf()) / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a single note qualifies as Spark material.
 *
 * @param {string} slug      — vault folder slug
 * @param {string} notePath  — absolute path OR vault-relative (lesson-N.md)
 * @returns {{ eligible: boolean, score: number, reasons: string[], facts: object }}
 */
function evaluateNoteForSpark(slug, notePath) {
  if (!slug) throw new TypeError('slug required');
  if (!notePath) throw new TypeError('notePath required');

  const absPath = path.isAbsolute(notePath) ? notePath : path.join(_slugDir(slug), notePath);
  const reasons = [];
  const facts = {};

  // 1. file exists?
  if (!fs.existsSync(absPath)) {
    return {
      eligible: false,
      score: 0,
      reasons: [`note_not_found:${absPath}`],
      facts: { path: absPath },
    };
  }

  const fm = _readFrontmatter(absPath);
  facts.path = absPath;

  // 2. utility_score gate
  let utility = 0;
  if (_utilityScore && typeof _utilityScore.computeUtilityScore === 'function') {
    try {
      const { score } = _utilityScore.computeUtilityScore(fm || {});
      utility = Number.isFinite(score) ? score : 0;
    } catch (_) {
      utility = 0;
      reasons.push('utility_compute_failed:degrade-open');
      utility = UTILITY_THRESHOLD; // neutral pass on lib failure
    }
  } else {
    reasons.push('utility_lib_missing:degrade-open');
    utility = UTILITY_THRESHOLD; // degrade open
  }
  facts.utility_score = utility;
  if (utility >= UTILITY_THRESHOLD) {
    reasons.push(`utility_ok:${utility}>=${UTILITY_THRESHOLD}`);
  } else {
    reasons.push(`utility_low:${utility}<${UTILITY_THRESHOLD}`);
  }

  // 3. life-state gate
  const lifeState = (fm && (fm.life_state || fm.lifeState || fm.state)) || null;
  facts.life_state = lifeState;
  let lifeOk = false;
  if (!lifeState) {
    reasons.push('life_state_missing:degrade-open');
    lifeOk = true; // degrade open
  } else if (ALLOWED_STATES.includes(lifeState)) {
    reasons.push(`life_state_ok:${lifeState}`);
    lifeOk = true;
  } else {
    reasons.push(`life_state_excluded:${lifeState}`);
  }

  // 4. age gate
  const age = _ageDays(fm);
  facts.age_days = age;
  let ageOk = false;
  if (age === null) {
    reasons.push('age_unknown:degrade-open');
    ageOk = true;
  } else if (age >= MIN_AGE_DAYS) {
    reasons.push(`age_ok:${age}d>=${MIN_AGE_DAYS}d`);
    ageOk = true;
  } else {
    reasons.push(`age_young:${age}d<${MIN_AGE_DAYS}d`);
  }

  // 5. cited_count gate (decision_followed events)
  const cited = Number((fm && (fm.cited_count || fm.cited)) || 0);
  facts.cited_count = cited;
  let citedOk = false;
  if (cited >= MIN_CITED) {
    reasons.push(`cited_ok:${cited}>=${MIN_CITED}`);
    citedOk = true;
  } else {
    reasons.push(`cited_low:${cited}<${MIN_CITED}`);
  }

  const utilityOk = utility >= UTILITY_THRESHOLD;
  const eligible = utilityOk && lifeOk && ageOk && citedOk;

  return { eligible, score: utility, reasons, facts };
}

/**
 * Propose a Spark seed from a qualified note. Returns the W3.4 createSpark
 * envelope when product-spark is loadable; otherwise a dry-run preview
 * (so test harnesses don't need full lib graph wired).
 *
 * @param {string} slug
 * @param {string} notePath
 * @param {object} [opts]    — { dryRun?: boolean }
 * @returns {{ ok: boolean, spark_id?: string, dryRun?: boolean, data?: object, error?: string }}
 */
function proposeNoteToSpark(slug, notePath, opts = {}) {
  const evalRes = evaluateNoteForSpark(slug, notePath);
  if (!evalRes.eligible) {
    return { ok: false, error: 'not_eligible', evaluation: evalRes };
  }

  const absPath = evalRes.facts.path;
  const fm = _readFrontmatter(absPath) || {};
  const conceptId = fm.conceptId || fm.concept_id || path.basename(absPath, '.md');
  const transferLine = (fm.core_transfer || fm.transfer || fm.takeaway || '')
    .toString().slice(0, 280) || `Promoted from note ${path.basename(absPath)}`;

  const sparkData = {
    source: {
      type: 'note',
      ref: path.relative(_slugDir(slug), absPath).replace(/\\/g, '/'),
      label: fm.title || conceptId,
    },
    related_product: fm.related_product || '',
    core_transfer: transferLine,
    affected_modules: Array.isArray(fm.affected_modules) ? fm.affected_modules : [],
    possible_actions: [],
    risk: '',
    state: 'seed',
  };

  if (opts.dryRun || !_productSpark || typeof _productSpark.createSpark !== 'function') {
    return { ok: true, dryRun: true, data: sparkData, evaluation: evalRes };
  }

  try {
    const res = _productSpark.createSpark(slug, sparkData);
    if (_events && typeof _events.write === 'function') {
      try {
        _events.write(slug, {
          type: 'flywheel:noteToSpark:proposed',
          spark_id: res.spark_id,
          note_ref: sparkData.source.ref,
          utility: evalRes.facts.utility_score,
        });
      } catch (_) { /* event log is index, not canonical */ }
    }
    return { ok: true, spark_id: res.spark_id, data: sparkData, evaluation: evalRes };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err), evaluation: evalRes };
  }
}

/**
 * Scan every lesson-N.md in vault/<slug>/ and return all eligible candidates.
 * Pure read — does NOT mutate. Caller (UI) decides which to promote.
 *
 * @param {string} slug
 * @returns {{ ok: boolean, scanned: number, eligible: Array, ineligible: Array }}
 */
function batchNoteToSpark(slug) {
  const dir = _slugDir(slug);
  if (!fs.existsSync(dir)) {
    return { ok: false, scanned: 0, eligible: [], ineligible: [], error: 'slug_dir_missing' };
  }
  const eligible = [];
  const ineligible = [];
  let scanned = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!/^lesson-\d+\.md$/i.test(name)) continue;
    scanned += 1;
    const abs = path.join(dir, name);
    const res = evaluateNoteForSpark(slug, abs);
    const row = { notePath: name, ...res };
    if (res.eligible) eligible.push(row);
    else ineligible.push(row);
  }
  return { ok: true, scanned, eligible, ineligible };
}

module.exports = {
  // Public API
  evaluateNoteForSpark,
  proposeNoteToSpark,
  batchNoteToSpark,

  // Constants (UI may render them for transparency)
  UTILITY_THRESHOLD,
  MIN_AGE_DAYS,
  MIN_CITED,
  ALLOWED_STATES,

  // Test surface
  _internals: {
    vaultRoot: _vaultRoot,
    slugDir: _slugDir,
    readFrontmatter: _readFrontmatter,
    ageDays: _ageDays,
  },
};
