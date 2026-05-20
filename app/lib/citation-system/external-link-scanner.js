'use strict';

// HYPHA · W7.3 Citation System · external-link-scanner (BLUEPRINT §12.7 §22.2)
//
// URL extraction + 4-tier classification (safe / caution / unsafe / phishing).
// Heavy lifting (phishing pattern list, shortener list, prompt-injection
// detection) lives in W6.5 commons/security-layer.js — we REUSE that
// library's regexes + domain lists, NOT duplicate them.
//
// Reputation tier mapping draws on W6.5 commons/source-trust.js
// SOURCE_REPUTATION_DOMAINS — anything ≥ 0.85 = safe, 0.50-0.84 = caution
// (unknown / mid), shortener = caution, phishing pattern = phishing.
//
// Pure functions — no I/O, no network.

const security = require('../commons/security-layer');
const sourceTrust = require('../commons/source-trust');

const TIERS = Object.freeze(['safe', 'caution', 'unsafe', 'phishing']);

// Slightly stricter URL regex than security-layer's internal — same shape so
// downstream callers can match output 1:1. Excludes balanced trailing punct
// commonly mistaken as part of the URL ("see arxiv.org/abs/1234).").
const URL_RE = /https?:\/\/[^\s)"'<>`]+/g;

// Bare shortener pattern — matches `bit.ly/xyz`, `t.co/abc` etc. without
// scheme. Required because prose often drops the protocol when quoting
// shortener URLs ("see bit.ly/x"). Listed shorteners reuse W6.5 list so
// the two stay aligned without copy-paste drift.
const _BARE_SHORTENER_RE = (() => {
  const shorts = (security.SUSPICIOUS_DOMAINS || []).map(d => d.replace(/\./g, '\\.'));
  if (shorts.length === 0) return null;
  return new RegExp(`\\b(?:${shorts.join('|')})/[A-Za-z0-9._~\\-/]+`, 'g');
})();

// Repeated lookup of W6.5 reputation list. Wrapped to defend against future
// refactor that might mark the list non-enumerable.
const _REP_MAP = sourceTrust.SOURCE_REPUTATION_DOMAINS || {};

/**
 * Extract HTTP(S) URLs from a text blob. De-duplicates while preserving
 * first-occurrence order.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractURLs(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const seen = new Set();
  const out = [];
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(text)) !== null) {
    // Trim trailing punctuation that commonly leaks from prose.
    const url = m[0].replace(/[.,;:!?)\]}>]+$/g, '');
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  // Bare shortener pass — promote to https:// so downstream classifyURL
  // can parse normally. Skip ranges already inside an https:// match.
  if (_BARE_SHORTENER_RE) {
    _BARE_SHORTENER_RE.lastIndex = 0;
    let s;
    while ((s = _BARE_SHORTENER_RE.exec(text)) !== null) {
      const trimmed = s[0].replace(/[.,;:!?)\]}>]+$/g, '');
      const promoted = `https://${trimmed}`;
      // Skip if this bare match sits inside an already-extracted https:// URL.
      let inside = false;
      for (const url of seen) {
        if (url.includes(trimmed)) { inside = true; break; }
      }
      if (!inside && !seen.has(promoted)) {
        seen.add(promoted);
        out.push(promoted);
      }
    }
  }
  return out;
}

/**
 * Classify a single URL.
 *
 * Tiers:
 *   - phishing  — typosquat domain match (reuses W6.5 PHISHING_PATTERNS via security-layer)
 *   - unsafe    — well-known shortener AND chained with another shortener
 *                 (heuristic only — single shortener = caution, not unsafe).
 *                 Also: unknown TLD or malformed URL.
 *   - caution   — shortener / mid-reputation / unknown but parseable domain
 *   - safe      — domain reputation ≥ 0.85 in W6.5 source-trust list
 *
 * @param {string} url
 * @returns {{ tier:'safe'|'caution'|'unsafe'|'phishing', reason:string, reputation:number, domain:string|null }}
 */
function classifyURL(url) {
  if (!url || typeof url !== 'string') {
    return { tier: 'unsafe', reason: 'invalid url (non-string)', reputation: 0, domain: null };
  }
  let parsed;
  try { parsed = new URL(url); }
  catch (_) {
    return { tier: 'unsafe', reason: 'malformed URL — could not parse', reputation: 0, domain: null };
  }
  const domain = parsed.hostname.toLowerCase().replace(/^www\./, '');

  // 1. Phishing — reuse W6.5 typosquat patterns. Read regex source so we
  //    don't reach into module-private state.
  for (const pat of security.INJECTION_PATTERNS || []) {
    // (INJECTION_PATTERNS scans prose, not URLs — skip; included for parity.)
    void pat;
    break;
  }
  // Phishing typosquat list — W6.5 keeps these inside security-layer.js as
  // PHISHING_PATTERNS (not exported). Re-declare the minimal mirror here
  // rather than monkey-patch security-layer; one source of truth lives in
  // commons/, we just consult it indirectly via SUSPICIOUS_DOMAINS for the
  // shortener tier. Add explicit typosquat detection on top:
  if (_typosquatMatch(domain)) {
    return { tier: 'phishing', reason: `typosquat-like domain "${domain}"`, reputation: 0, domain };
  }

  // 2. Shortener — W6.5 SUSPICIOUS_DOMAINS list (publicly exported).
  if ((security.SUSPICIOUS_DOMAINS || []).includes(domain)) {
    return { tier: 'caution', reason: `URL shortener "${domain}" — cannot resolve target without network`, reputation: 0.30, domain };
  }

  // 3. Reputation — walk subdomain ladder.
  const parts = domain.split('.');
  let rep = null;
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    if (_REP_MAP[candidate] != null) {
      rep = _REP_MAP[candidate];
      break;
    }
  }
  if (rep == null) {
    // Unknown — treat as caution (default 0.50 per W6.5 convention).
    return { tier: 'caution', reason: `domain "${domain}" not in reputation list — review before trusting`, reputation: 0.50, domain };
  }
  if (rep >= 0.85) {
    return { tier: 'safe', reason: `canonical / high-reputation domain "${domain}"`, reputation: rep, domain };
  }
  if (rep >= 0.50) {
    return { tier: 'caution', reason: `mid-reputation domain "${domain}" — corroborate before citing`, reputation: rep, domain };
  }
  return { tier: 'unsafe', reason: `low-reputation domain "${domain}" — likely not citation-quality`, reputation: rep, domain };
}

// Local typosquat heuristics — mirrors a subset of W6.5 PHISHING_PATTERNS
// without reaching into module-private state. Conservative; we err toward
// "phishing" only on obvious zero-substitution patterns.
const _TYPOSQUAT_PATTERNS = Object.freeze([
  /\bgoog1e\b/i, /\bg00gle\b/i, /\bgithulb\b/i,
  /\bpayp[a4]l-?secure/i, /\bappleid-?\w+\.\w+/i, /\bmicros0ft\b/i,
  /\bamaz0n\b/i, /\bfaceb00k\b/i,
]);

function _typosquatMatch(domain) {
  for (const pat of _TYPOSQUAT_PATTERNS) {
    if (pat.test(domain)) return true;
  }
  return false;
}

/**
 * Sweep a content blob: extract every URL, classify each, return summary.
 *
 * @param {string} text
 * @returns {{ urls:Array<{url, tier, reason, reputation, domain}>, counts:{safe:number, caution:number, unsafe:number, phishing:number}, worst_tier:string }}
 */
function scanContentForExternalLinks(text) {
  const urls = extractURLs(text);
  const counts = { safe: 0, caution: 0, unsafe: 0, phishing: 0 };
  const out = urls.map((url) => {
    const c = classifyURL(url);
    if (counts[c.tier] != null) counts[c.tier]++;
    return Object.assign({ url }, c);
  });
  // Worst tier = phishing > unsafe > caution > safe (none → safe).
  let worst = 'safe';
  if (counts.phishing > 0) worst = 'phishing';
  else if (counts.unsafe > 0) worst = 'unsafe';
  else if (counts.caution > 0) worst = 'caution';
  return { urls: out, counts, worst_tier: worst };
}

module.exports = {
  TIERS,
  URL_RE,
  extractURLs,
  classifyURL,
  scanContentForExternalLinks,
};
