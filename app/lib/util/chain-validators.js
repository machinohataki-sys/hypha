'use strict';

// HYPHA v0.4.11 — shared validators for slug + parent_chain_slug + chain
// surface IPCs. Extracted so app/main.js and app/scripts/_dev_verify_chain_surface.js
// hit the same code path; smoke can assert validation rules offline without
// spinning Electron IPC.

// Slug = course directory name on disk. Reject traversal characters; require
// at least one char. Same rule used everywhere by curriculum:* handlers.
function validateSlug(slug) {
  if (!slug || typeof slug !== 'string') {
    return { ok: false, error: 'slug required' };
  }
  if (slug.includes('/') || slug.includes('\\') || slug.includes('..') || slug.startsWith('.')) {
    return { ok: false, error: 'invalid slug shape' };
  }
  return { ok: true, value: slug };
}

// parent_chain_slug shape: null OR trimmed string 3-80 chars, allowed chars
// = alphanumeric + CJK unified ideographs + hyphens. Matches the slug pattern
// curriculum:create uses when slugifying user goals.
//
// Distinct from validateSlug — that one guards a filesystem path; this one
// guards a logical chain-grouping reference (no `/`, no `..`, no `.` prefix,
// AND length+charset constraints).
const PARENT_CHAIN_SLUG_RE = /^[\p{L}\p{N}一-鿿-]+$/u;

function validateParentChainSlug(value) {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: 'parentChainSlug must be string or null' };
  }
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 80) {
    return { ok: false, error: 'parentChainSlug must be 3-80 chars trimmed' };
  }
  if (!PARENT_CHAIN_SLUG_RE.test(trimmed)) {
    return { ok: false, error: 'parentChainSlug must be alphanumeric/CJK/hyphens' };
  }
  return { ok: true, value: trimmed };
}

module.exports = {
  validateSlug,
  validateParentChainSlug,
  PARENT_CHAIN_SLUG_RE,
};
