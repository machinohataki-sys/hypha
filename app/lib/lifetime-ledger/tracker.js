'use strict';

// HYPHA · Phase C · per-link target tracker (2026-05-17).
//
// Reads chain.json's `output_targets` per link (written by planChain) and
// merges with aggregated ledger entries to compute per-axis {done, target,
// pct}. Used by UI to render the 5-band progress strip on the link card.
//
// Pure: no LLM, no network. Just chain.json + lifetime-ledger.jsonl.

const vault = require('../vault');
const { aggregateByLink } = require('./index');

function buildLinkTargets(chain) {
  // chain.chain.links → [{linkIdx: {axis: count}}]
  const links = (chain && chain.chain && Array.isArray(chain.chain.links))
    ? chain.chain.links
    : [];
  const out = {};
  links.forEach((link, idx) => {
    const targets = {};
    const ot = Array.isArray(link.output_targets) ? link.output_targets : [];
    for (const t of ot) {
      if (!t || typeof t.axis !== 'string') continue;
      const num = Number(t.count);
      if (!Number.isFinite(num)) continue;
      targets[t.axis] = num;
    }
    out[idx] = targets;
  });
  return out;
}

async function computeProgress(slug, linkIdx) {
  if (!slug || !Number.isFinite(linkIdx)) return null;
  let chain = null;
  try {
    chain = await vault.readJSON(`${slug}/chain.json`);
  } catch (_) {
    chain = null;
  }
  const allTargets = buildLinkTargets(chain);
  const targets = allTargets[linkIdx] || {};
  const done = await aggregateByLink(slug, linkIdx);

  const axes = new Set([...Object.keys(targets), ...Object.keys(done)]);
  const out = {};
  for (const axis of axes) {
    const t = targets[axis] || 0;
    const d = done[axis] || 0;
    out[axis] = {
      done: d,
      target: t,
      pct: t > 0 ? Math.min(1, d / t) : null,
    };
  }
  return { linkIdx, axes: out };
}

module.exports = {
  buildLinkTargets,
  computeProgress,
};
