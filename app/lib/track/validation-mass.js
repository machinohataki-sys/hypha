'use strict';
// Track A/B Validation Mass — composite score from external engagement metrics.
// Per specs/track-a-b-social-sandbox.md §6 (Validation Mass).

const DEFAULT_WEIGHTS = { comments: 10, shares: 5, reactions: 3, views: 1 };

function computeMass(entries, opts = {}) {
  const weights = Object.assign({}, DEFAULT_WEIGHTS, opts.weights || {});
  if (!Array.isArray(entries)) entries = [];
  let totalComments = 0, totalShares = 0, totalReactions = 0, totalViews = 0;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const m = (e && e.metrics) || {};
    totalComments += Number(m.comments) || 0;
    totalShares += Number(m.shares) || 0;
    totalReactions += Number(m.reactions) || 0;
    totalViews += Number(m.views) || 0;
  }
  const compositeScore =
      weights.comments * totalComments
    + weights.shares * totalShares
    + weights.reactions * totalReactions
    + weights.views * totalViews;
  return {
    composite_score: compositeScore,
    comments: totalComments,
    shares: totalShares,
    reactions: totalReactions,
    views: totalViews,
    weights,
    entry_count: entries.length,
  };
}

// Read exit-ramps.jsonl + filter to Track A/B with metrics → compute mass.
function computeMassFromVault({ slug, vaultRoot }, opts = {}) {
  const fs = require('node:fs');
  const path = require('node:path');
  const rampPath = path.join(vaultRoot, slug, 'exit-ramps.jsonl');
  if (!fs.existsSync(rampPath)) return computeMass([], opts);
  let lines;
  try { lines = fs.readFileSync(rampPath, 'utf-8').split('\n').filter(Boolean); } catch (_) { return computeMass([], opts); }
  const entries = [];
  for (const ln of lines) {
    try {
      const obj = JSON.parse(ln);
      if (obj && (obj.track === 'A' || obj.track === 'B') && obj.metrics) entries.push(obj);
    } catch (_) { /* skip malformed */ }
  }
  return computeMass(entries, opts);
}

module.exports = { computeMass, computeMassFromVault, DEFAULT_WEIGHTS };
