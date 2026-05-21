'use strict';

// HYPHA · Community (Commons) v0.1 — curated GitHub YAML/JSON packs.
//
// Decision (R-LIB Day 3, 2026-05-12): hand-curated packs hosted on GitHub
// at hypha-org/hypha-packs (NOT v0.5+ P2P vault sync). Scale ↓ / trust ↑.
// User-installed packs cache under ~/.hypha/commons/packs/<pack-id>/pack.json.
// Read-only consumption — submissions go through GitHub PR, not in-app upload.
//
// Storage layout:
//   ~/.hypha/commons/packs/<pack-id>/pack.json   (user-installed)
//   app/lib/commons-packs/<pack-id>/pack.json    (bundled stubs for v0.1)
//
// Pack schema:
//   {
//     topic, lang, curator, version, ratified_by[], ratified_at,
//     aliases[],              // multilingual topic variants for matching
//     syllabus_skeleton[]: [{ chapter, kp_candidates[] }],
//     recommended_sources[]: [{ title|url, type, reason }],
//     contested_questions[]   // for CHALLENGE pipeline seeding
//   }
//
// v0.2 ladder: HTTP fetch of hypha-org/hypha-packs index.json at startup +
// per-pack download on user click (Commons UI tab). v0.1 = bundled-only.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BUNDLED_PACKS_DIR = path.join(__dirname, 'commons-packs');

function _userPacksDir() {
  // Allow HYPHA_COMMONS_DIR override for testing
  const env = (process.env.HYPHA_COMMONS_DIR || '').trim();
  if (env) return env;
  return path.join(os.homedir(), '.hypha', 'commons', 'packs');
}

function _safeReadJSON(absPath) {
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    return JSON.parse(raw);
  } catch (_) { return null; }
}

/**
 * Enumerate pack directories under a root.
 * Each pack lives in its own subdir containing pack.json.
 */
function _scanPacksDir(rootDir, sourceTag) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  let entries;
  try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); }
  catch (_) { return out; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const packJson = path.join(rootDir, ent.name, 'pack.json');
    if (!fs.existsSync(packJson)) continue;
    const pack = _safeReadJSON(packJson);
    if (!pack || !pack.topic) continue;
    out.push({
      id: ent.name,
      _source: sourceTag,
      _path: packJson,
      ...pack,
    });
  }
  return out;
}

/**
 * Optional W6.5 enrichment — lazy-loaded so the base community module
 * stays usable when the commons/ subtree is absent (e.g. in lean tests).
 * Returns null on load failure rather than throwing.
 */
function _loadCommonsEnrichers() {
  try {
    return {
      security: require('./commons/security-layer'),
      trust:    require('./commons/source-trust'),
      license:  require('./commons/license-layer'),
    };
  } catch (_) { return null; }
}

/**
 * Annotate a single pack with W6.5 Commons indicators. Mutation-free —
 * returns a NEW object preserving the source pack untouched. Per CLAUDE.md
 * SURGICAL rule: this enrichment runs only when the commons/ libs are
 * present; otherwise pack flows through identity.
 */
function _enrichPack(pack, enrichers) {
  if (!enrichers || !pack) return pack;
  const packDir = pack._path ? path.dirname(pack._path) : null;
  let scan = null, safetyLevel = 'safe';
  if (packDir) {
    try {
      scan = enrichers.security.scanPack(packDir);
      safetyLevel = enrichers.security.assessSafetyLevel(scan);
    } catch (_) { /* enrichment failure is non-fatal */ }
  }
  let trust = null;
  try { trust = enrichers.trust.trustBreakdown(pack); } catch (_) {}
  let license = null;
  try { license = enrichers.license.parseLicense(pack); } catch (_) {}
  return Object.assign({}, pack, {
    _safety_level: safetyLevel,
    _safety_scan: scan,
    _trust: trust,
    _license: license,
  });
}

/**
 * List all available packs — user-installed first, bundled fallback.
 * Dedupe by pack id (user copy wins). When the W6.5 commons/ subtree is
 * present, each pack is enriched with safety / trust / license indicators
 * (mutation-free, additive only).
 *
 * @returns {Array<{id, topic, lang, curator, version, ratified_by, _source,
 *   _safety_level, _trust, _license, ...}>}
 */
function listPacks() {
  const user = _scanPacksDir(_userPacksDir(), 'user');
  const bundled = _scanPacksDir(BUNDLED_PACKS_DIR, 'bundled');
  const seen = new Set(user.map(p => p.id));
  const result = [...user];
  for (const b of bundled) {
    if (!seen.has(b.id)) result.push(b);
  }
  const enrichers = _loadCommonsEnrichers();
  return enrichers ? result.map(p => _enrichPack(p, enrichers)) : result;
}

/**
 * Normalize text for topic match — lowercase, strip whitespace + punctuation.
 */
function _norm(s) {
  return String(s || '').toLowerCase().trim().replace(/[\s.,;:()【】《》「」"'`]+/g, ' ');
}

/**
 * Check whether a pack matches a topic. Match priority:
 *   1. exact topic match (post-normalize)
 *   2. alias substring match either direction
 *   3. topic substring of pack.topic or vice versa
 */
function _packMatches(pack, topic) {
  const tn = _norm(topic);
  if (!tn) return false;
  const pt = _norm(pack.topic);
  if (!pt) return false;
  if (tn === pt) return true;
  if (tn.includes(pt) || pt.includes(tn)) return true;
  const aliases = Array.isArray(pack.aliases) ? pack.aliases : [];
  for (const alias of aliases) {
    const an = _norm(alias);
    if (an && (tn.includes(an) || an.includes(tn))) return true;
  }
  return false;
}

/**
 * Query packs matching a topic. Returns full pack records sorted by
 * trust score (ratified_by count + recency).
 *
 * @param {string} topic
 * @param {object} opts
 * @param {string} opts.lang — preferred language (zh/en); matches preferred
 * @returns {Array<pack>}
 */
function queryPacks(topic, opts = {}) {
  if (!topic) return [];
  const lang = (opts.lang || '').toLowerCase();
  const all = listPacks();
  const matches = all.filter(p => _packMatches(p, topic));
  matches.sort((a, b) => {
    // Language preference
    if (lang) {
      const aMatch = (a.lang || '').toLowerCase() === lang ? 1 : 0;
      const bMatch = (b.lang || '').toLowerCase() === lang ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
    }
    // Trust signal: ratified_by count
    const aTrust = Array.isArray(a.ratified_by) ? a.ratified_by.length : 0;
    const bTrust = Array.isArray(b.ratified_by) ? b.ratified_by.length : 0;
    if (aTrust !== bTrust) return bTrust - aTrust;
    // Recency
    const aDate = String(a.ratified_at || '');
    const bDate = String(b.ratified_at || '');
    return bDate.localeCompare(aDate);
  });
  return matches;
}

// intentional-placeholder: v0.1 ships bundled-only packs per Day 3 plan;
// install-from-GitHub flow is Day 6 UI work + requires Commons tab + git/HTTP
// fetch path. Function exists now as the stable API surface so renderer can
// already wire window.ptor.commons.install() — implementation lands Day 6.
function installPack(_packId) {
  return { ok: false, error: 'pack install deferred to v0.1 Day 6 — bundled packs only this tranche; submit via GitHub PR to hypha-org/hypha-packs to add new packs' };
}

/**
 * Stale check — pack older than 12 months returns true.
 */
function isPackStale(pack, nowMs) {
  if (!pack || !pack.ratified_at) return false;
  const ratifiedMs = Date.parse(pack.ratified_at);
  if (!Number.isFinite(ratifiedMs)) return false;
  const now = nowMs || Date.now();
  const twelveMonths = 12 * 30 * 24 * 60 * 60 * 1000;
  return (now - ratifiedMs) > twelveMonths;
}

module.exports = {
  listPacks,
  queryPacks,
  installPack,
  isPackStale,
  BUNDLED_PACKS_DIR,
};
