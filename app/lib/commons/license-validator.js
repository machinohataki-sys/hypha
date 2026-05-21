'use strict';

// HYPHA · Commons · License Validator (strict gate for pack ingestion).
//
// Complements license-layer.js (which models USE intent) by enforcing the
// approved-list policy at pack registration time. Reject early:
//   - Missing or empty `license` field
//   - License token not in approved list
//   - Conflicting upstream: pack source carries an NC clause but pack itself
//     declares CC-BY (commercial-allowed). Downgrades silently are blocked.
//
// Approved token mapping (brief vocabulary → license-layer canonical):
//   PUBLIC_DOMAIN | CC0   → CC0
//   CC_BY                 → CC-BY
//   CC_BY_SA              → CC-BY-SA
//   CC_BY_NC              → CC-BY-NC
//   CC_BY_NC_SA           → CC-BY-NC-SA
//   MIT                   → MIT
//   Apache-2.0 | APACHE_2 → Apache-2.0
// Schema-style aliases (CC-BY-4.0 etc) are also accepted so older packs
// validate without rewrite.
//
// API:
//   validatePackLicense(pack)              → {ok, canonical?, error?, detail?}
//   detectUpstreamConflict(pack, upstreams) → {ok, conflicts: [...]}

const _licenseLayer = require('./license-layer');

const APPROVED_BRIEF = Object.freeze({
  'PUBLIC_DOMAIN': 'CC0',
  'CC0':           'CC0',
  'CC_BY':         'CC-BY',
  'CC_BY_SA':      'CC-BY-SA',
  'CC_BY_NC':      'CC-BY-NC',
  'CC_BY_NC_SA':   'CC-BY-NC-SA',
  'MIT':           'MIT',
  'APACHE_2':      'Apache-2.0',
  'Apache-2.0':    'Apache-2.0',
});

// Schema-style tokens from the existing pack-schema.LICENSES set — keep
// backward compat with packs already on disk.
const SCHEMA_TO_CANONICAL = Object.freeze({
  'CC-BY-4.0':    'CC-BY',
  'CC-BY-NC-4.0': 'CC-BY-NC',
  'CC-BY-SA-4.0': 'CC-BY-SA',
  'MIT':          'MIT',
  'proprietary':  'proprietary',
});

const APPROVED_CANONICAL = new Set([
  'CC0', 'CC-BY', 'CC-BY-SA', 'CC-BY-NC', 'CC-BY-NC-SA', 'MIT', 'Apache-2.0',
]);

function _normalizeToken(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (APPROVED_BRIEF[s]) return APPROVED_BRIEF[s];
  if (SCHEMA_TO_CANONICAL[s]) return SCHEMA_TO_CANONICAL[s];
  // Last resort: route through license-layer canonicalization.
  const parsed = _licenseLayer.parseLicense({ license: s });
  if (parsed && parsed.license && parsed.license !== 'unknown') return parsed.license;
  return null;
}

function validatePackLicense(pack) {
  if (!pack || typeof pack !== 'object') {
    return { ok: false, error: 'BAD_INPUT', detail: 'pack must be object' };
  }
  if (pack.license == null || (typeof pack.license === 'string' && !pack.license.trim())) {
    return { ok: false, error: 'LICENSE_MISSING', detail: 'license field empty or absent' };
  }
  const canonical = _normalizeToken(pack.license);
  if (!canonical) {
    return { ok: false, error: 'LICENSE_NOT_APPROVED', detail: `unrecognized: ${String(pack.license).slice(0, 60)}` };
  }
  if (!APPROVED_CANONICAL.has(canonical)) {
    return { ok: false, error: 'LICENSE_NOT_APPROVED', detail: `${canonical} not in approved list` };
  }
  return { ok: true, canonical };
}

function _isNonCommercial(canonical) {
  return canonical === 'CC-BY-NC' || canonical === 'CC-BY-NC-SA';
}

function _isShareAlike(canonical) {
  return canonical === 'CC-BY-SA' || canonical === 'CC-BY-NC-SA';
}

/**
 * Detect license conflicts with upstream sources. A pack derived from an
 * NC-licensed source cannot publish itself as CC-BY (commercial-allowed) —
 * that would silently downgrade the upstream constraint. SA propagation is
 * also checked.
 *
 * @param {object} pack
 * @param {Array<{license, url?, title?}>} upstreams
 * @returns {{ok: boolean, conflicts: Array<{upstream, reason}>}}
 */
function detectUpstreamConflict(pack, upstreams) {
  const own = validatePackLicense(pack);
  const conflicts = [];
  if (!own.ok) {
    return { ok: false, conflicts: [{ upstream: null, reason: own.error }] };
  }
  if (!Array.isArray(upstreams)) return { ok: true, conflicts };

  const ownCanonical = own.canonical;
  for (const up of upstreams) {
    if (!up || typeof up !== 'object') continue;
    const upRaw = up.license;
    if (upRaw == null) continue;
    const upCanonical = _normalizeToken(upRaw);
    if (!upCanonical) continue;
    if (_isNonCommercial(upCanonical) && !_isNonCommercial(ownCanonical)) {
      conflicts.push({
        upstream: up.title || up.url || upCanonical,
        reason: `upstream ${upCanonical} requires NC; pack declares ${ownCanonical}`,
      });
    }
    if (_isShareAlike(upCanonical) && !_isShareAlike(ownCanonical)) {
      conflicts.push({
        upstream: up.title || up.url || upCanonical,
        reason: `upstream ${upCanonical} requires SA; pack declares ${ownCanonical}`,
      });
    }
  }
  return { ok: conflicts.length === 0, conflicts };
}

module.exports = {
  APPROVED_CANONICAL,
  APPROVED_BRIEF,
  SCHEMA_TO_CANONICAL,
  validatePackLicense,
  detectUpstreamConflict,
};
