'use strict';

// HYPHA · Phase C · variance vs frontier (2026-05-17).
//
// For a given (chainSlug, linkIdx, axis), compares user's logged count to
// frontier p50 pro-rated by elapsed weeks in this link. Returns a band
// (`leading` / `p50-p75` / `p25-p50` / `below-p25` / `insufficient_data`) +
// a Garamond-register supportive line + the underlying numbers so the UI
// can render an editorial tooltip.
//
// Approximations + honesty gaps documented inline; the supportive line is
// deliberately register-clean (no SaaS-y "you're crushing it!").

const vault = require('../vault');
const { aggregateByLink, getLedger } = require('./index');

async function varianceVsFrontier({ chainSlug, linkIdx, axis } = {}) {
  if (!chainSlug || typeof axis !== 'string' || !axis) {
    return _insufficient('missing args');
  }
  if (!Number.isFinite(linkIdx)) {
    return _insufficient('linkIdx must be a number');
  }

  let chain = null;
  try {
    chain = await vault.readJSON(`${chainSlug}/chain.json`);
  } catch (_) {
    chain = null;
  }
  const links = (chain && chain.chain && Array.isArray(chain.chain.links))
    ? chain.chain.links
    : [];
  const link = links[linkIdx];
  if (!link) return _insufficient('link not found');

  const p50Raw = link.frontier_axis_p50 && link.frontier_axis_p50[axis];
  const p50 = Number(p50Raw);
  if (!Number.isFinite(p50) || p50 <= 0) {
    return _insufficient('no frontier_axis_p50 anchor');
  }

  const done = await aggregateByLink(chainSlug, linkIdx);
  const userCount = Number(done[axis]) || 0;

  const weeksTotal = Math.max(1, Number(link.duration_weeks) || 1);

  // 2026-05-17 Phase C Gap 3 — prefer wall-clock weeks elapsed since
  // chain:start / chain:advance stamped linksState.links[N].startedAt.
  // Falls back to entries.length on legacy links (no startedAt).
  let weeksElapsed = null;
  let elapsedSource = 'unknown';
  try {
    // MEOW LOW 2026-05-17 — vault.readJSON is sync; drop `await` to avoid
    // misleading future readers + align with sister index.js callstyle.
    const linksState = vault.readJSON(`${chainSlug}/links-state.json`);
    const linkState = linksState && Array.isArray(linksState.links) && linksState.links[linkIdx];
    const startedAt = linkState && linkState.startedAt && Date.parse(linkState.startedAt);
    if (Number.isFinite(startedAt) && startedAt > 0) {
      const ms = Date.now() - startedAt;
      const w = ms / (7 * 24 * 60 * 60 * 1000);
      weeksElapsed = w;
      elapsedSource = 'wall-clock';
    }
  } catch (_) { /* legacy / read failure → fall through */ }

  if (weeksElapsed == null) {
    const { entries } = await getLedger(chainSlug);
    weeksElapsed = entries.filter(e => e.linkIdx === linkIdx).length;
    elapsedSource = 'entry-count-approx';
  }

  // Gap 1 — early floor: if < 2 wall-clock weeks elapsed AND we ARE on
  // the wall-clock branch, return insufficient_data so first-week ratio
  // noise (single big batch report on day 1) doesn't fake precision.
  if (elapsedSource === 'wall-clock' && weeksElapsed < 2) {
    return _insufficient('< 2 weeks elapsed since link start');
  }

  const weeksClamped = Math.max(1, weeksElapsed);
  const expectedAtThisPoint = p50 * (weeksClamped / weeksTotal);
  const ratio = expectedAtThisPoint > 0 ? userCount / expectedAtThisPoint : 0;

  let band;
  let supportiveLine;
  if (ratio >= 1.25) {
    band = 'leading';
    supportiveLine = `你在 ${axis} 轴节奏明显超出 frontier p50, 注意可持续性`;
  } else if (ratio >= 0.85) {
    band = 'p50-p75';
    supportiveLine = `你的 ${axis} 节奏与 frontier p50 接近, 状态稳`;
  } else if (ratio >= 0.5) {
    band = 'p25-p50';
    supportiveLine = `你的 ${axis} 节奏在 frontier p25-p50, 比一些对标人慢`;
  } else {
    band = 'below-p25';
    supportiveLine = `你的 ${axis} 节奏低于 frontier p25, 考虑增量`;
  }

  let sampleN = 0;
  try {
    const evidence = (chain && chain.inputs && Array.isArray(chain.inputs.evidence))
      ? chain.inputs.evidence
      : [];
    sampleN = evidence.length;
  } catch (_) {
    sampleN = 0;
  }

  return {
    band,
    supportiveLine,
    sampleN,
    userCount,
    p50_at_this_point: expectedAtThisPoint,
    ratio,
    weeks_elapsed: weeksClamped,
    elapsed_source: elapsedSource,
  };
}

function _insufficient(reason) {
  return {
    band: 'insufficient_data',
    supportiveLine: '对标数据采集中, 暂不显 variance',
    reason,
  };
}

module.exports = { varianceVsFrontier };
