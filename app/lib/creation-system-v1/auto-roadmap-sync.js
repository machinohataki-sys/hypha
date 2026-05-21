'use strict';

// HYPHA · W5.4 Creation System v1 — Automated Weekly Roadmap Sync
//
// Per BLUEPRINT §11.8: each week, walk the last 7 days of lessons / sparks /
// notes / inspirations and propose 6-8 "high-value migration points" that
// should be considered for the user's product roadmap. The user gets a
// prioritized top-2 surfaced through the Blueprint UI; the full 6-8 are
// written into roadmap-sync.json for archival.
//
// Pipeline (this file owns the orchestration; LLM calls are mocked per the
// W5.4 brief):
//   1. Harvest — read recent inspiration-pool.jsonl + sparks/*.md + events
//   2. Cluster — group by source_type + affected_module overlap
//   3. Score   — urgency × impact × feasibility (deterministic mock proxy)
//   4. Top-K   — keep 6-8 candidates, surface top-2 to user
//   5. Write   — call creation-pool-ops.appendRoadmapSync to persist
//
// W5.1 embed integration is OPTIONAL — we probe for ./embed and walkGraph
// from W5.2, fall back to a token-overlap proxy when absent. Defensive
// lazy-require keeps the module standalone for tests.

const fs = require('fs');
const path = require('path');
const { tagMockOutput } = require('../v0-mock-marker');

// Lazy-loaded boundary deps. Each load is wrapped — never throws on missing.
let _poolMod = null;
function _getPool() {
  if (_poolMod !== null) return _poolMod;
  try { _poolMod = require('../creation-pool'); }
  catch (_) { _poolMod = false; }
  return _poolMod;
}

let _opsMod = null;
function _getOps() {
  if (_opsMod !== null) return _opsMod;
  try { _opsMod = require('../creation-pool-ops'); }
  catch (_) { _opsMod = false; }
  return _opsMod;
}

let _sparkMod = null;
function _getSpark() {
  if (_sparkMod !== null) return _sparkMod;
  try { _sparkMod = require('../product-spark'); }
  catch (_) { _sparkMod = false; }
  return _sparkMod;
}

let _eventsMod = null;
function _getEvents() {
  if (_eventsMod !== null) return _eventsMod;
  try { _eventsMod = require('../events'); }
  catch (_) { _eventsMod = false; }
  return _eventsMod;
}

// W5.1 / W5.2 — best-effort. Currently absent in repo; the proxy fallback
// keeps the pipeline shippable today and the swap-in is one require call.
let _embedMod = null;
function _getEmbed() {
  if (_embedMod !== null) return _embedMod;
  try { _embedMod = require('../embed'); }
  catch (_) { _embedMod = false; }
  return _embedMod;
}

let _graphMod = null;
function _getGraph() {
  if (_graphMod !== null) return _graphMod;
  try { _graphMod = require('../graph'); }
  catch (_) { _graphMod = false; }
  return _graphMod;
}

function _vaultRoot() {
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) {
    return process.env.HYPHA_DATA;
  }
  if (process.env.HYPHA_VAULT_DIR && fs.existsSync(process.env.HYPHA_VAULT_DIR)) {
    return process.env.HYPHA_VAULT_DIR;
  }
  return path.join(__dirname, '..', '..', '..', 'data');
}

// ---------------------------------------------------------------------------
// _harvestRecent — gather inspiration-pool rows + sparks + lesson_complete
// events from the last `days` window. All best-effort: missing files yield
// empty arrays so the pipeline still produces a deterministic output shape.
// ---------------------------------------------------------------------------
function _harvestRecent(slug, days) {
  const sinceMs = Date.now() - (days * 24 * 60 * 60 * 1000);
  const inspirations = _readInspirations(slug, sinceMs);
  const sparks = _readSparks(slug, sinceMs);
  const events = _readEventsRecent(slug, sinceMs);
  return { inspirations, sparks, events, since_ms: sinceMs, days };
}

function _readInspirations(slug, sinceMs) {
  const ip = path.join(_vaultRoot(), slug, 'product/inspiration-pool.jsonl');
  if (!fs.existsSync(ip)) return [];
  const out = [];
  let buf;
  try { buf = fs.readFileSync(ip, 'utf8'); }
  catch (_) { return []; }
  for (const line of buf.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const ts = row.ts ? Date.parse(row.ts) : 0;
      if (ts && ts < sinceMs) continue;
      out.push(row);
    } catch (_) { /* skip */ }
  }
  return out;
}

function _readSparks(slug, sinceMs) {
  const sparkLib = _getSpark();
  if (!sparkLib || typeof sparkLib.listSparks !== 'function') return [];
  try {
    const all = sparkLib.listSparks(slug);
    return all.filter((s) => {
      const ts = s.created_at ? Date.parse(s.created_at) : 0;
      return !ts || ts >= sinceMs;
    });
  } catch (_) { return []; }
}

function _readEventsRecent(slug, sinceMs) {
  const fp = path.join(_vaultRoot(), slug, 'events.jsonl');
  if (!fs.existsSync(fp)) return [];
  const out = [];
  let buf;
  try { buf = fs.readFileSync(fp, 'utf8'); }
  catch (_) { return []; }
  for (const line of buf.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const ts = row.ts ? Date.parse(row.ts) : 0;
      if (ts && ts < sinceMs) continue;
      out.push(row);
    } catch (_) { /* skip */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// _clusterCandidates — group harvest into candidate migration points. Each
// candidate has { id, source_type, source_refs[], summary, evidence_count }.
// Clustering proxy: bucket by (source_type, suggested_section || 'general')
// or by spark.affected_modules[0]. Real W5.1 embed-driven clustering swaps
// in here — same output contract.
// ---------------------------------------------------------------------------
function _clusterCandidates(harvest) {
  const buckets = new Map();
  function _push(key, item) {
    if (!buckets.has(key)) buckets.set(key, { id: key, items: [], source_types: new Set() });
    const b = buckets.get(key);
    b.items.push(item);
    if (item.source_type) b.source_types.add(item.source_type);
  }
  for (const i of harvest.inspirations || []) {
    const sec = i.blueprint_section || i.suggested_section || 'general';
    const key = `inspiration:${sec}`;
    _push(key, { source_type: 'inspiration', section: sec, ref: i.source || i.spark_id, summary: i.source_summary || i.core_transfer_preview || '' });
  }
  for (const s of harvest.sparks || []) {
    const mod = (s.affected_modules && s.affected_modules[0]) || 'general';
    const key = `spark:${mod}`;
    _push(key, { source_type: 'spark', module: mod, ref: s.spark_id, summary: s.core_transfer || '', state: s.state });
  }
  for (const e of harvest.events || []) {
    if (e.type === 'transfer:fired' || e.op === 'transfer:fired'
        || e.type === 'creation_v1:auto_transfer_scheduled') {
      const sec = e.suggested_section || 'general';
      const key = `transfer:${sec}`;
      _push(key, { source_type: 'transfer', section: sec, ref: `lesson-${e.idx || e.lesson_idx}`, summary: '' });
    }
  }
  return Array.from(buckets.values()).map((b) => ({
    id: b.id,
    source_types: Array.from(b.source_types),
    items: b.items,
    evidence_count: b.items.length,
  }));
}

// ---------------------------------------------------------------------------
// _scoreCandidate — deterministic mock for T6_STRONG. Real swap-in is one
// executeChat call. Output shape stable so the pipeline downstream + UI
// surface lock today against the same contract.
//   urgency       — 1.0 when ≥ 3 evidence rows, scaled down for fewer
//   impact        — 1.0 when ≥ 2 distinct source_types contribute
//   feasibility   — 1.0 base, 0.7 if no spark accepted state seen
//   priority      — urgency × impact × feasibility (0..1)
// ---------------------------------------------------------------------------
function _scoreCandidate(c) {
  const urgency = Math.min(1, (c.evidence_count || 0) / 3);
  const impact = (c.source_types && c.source_types.length >= 2) ? 1.0 : 0.6;
  const hasAccepted = (c.items || []).some(i => i.state === 'accepted' || i.state === 'implemented');
  const feasibility = hasAccepted ? 1.0 : 0.7;
  const priority = Math.round((urgency * impact * feasibility) * 1000) / 1000;
  return { urgency, impact, feasibility, priority };
}

// ---------------------------------------------------------------------------
// _synthesizeRecommendation — mock T6_STRONG body generation. Output ≤ 120
// chars summary so the user surface stays readable; full evidence rows stay
// in `evidence[]` for the expand-on-click view.
// ---------------------------------------------------------------------------
function _synthesizeRecommendation(c, score) {
  const sourceCount = c.evidence_count;
  const sources = c.source_types.join('+');
  const head = c.id.split(':')[0];
  const tail = c.id.split(':')[1] || 'general';
  // intentional-placeholder: T6_STRONG LLM call deferred per W5.4 brief.
  // Real swap: executeChat('T6_STRONG', { messages: [...summarize cluster...] })
  // returning { summary, action_verb, target_section }.
  const summary = `${sources} 三处近 7 日累计 ${sourceCount} 次提及 ${tail} — 建议汇入蓝图 ${tail}`;
  const action = head === 'spark' ? '审视' : head === 'transfer' ? '汇编' : '抽取';
  return tagMockOutput({
    text: summary,
    action,
    target_section: tail,
    evidence: (c.items || []).slice(0, 6).map(i => ({
      source_type: i.source_type,
      ref: i.ref,
      summary: (i.summary || '').slice(0, 80),
    })),
    score,
    candidate_id: c.id,
  }, 'auto-roadmap-sync T6_STRONG LLM 未上线, 当前用 deterministic cluster-summary 模板');
}

// ---------------------------------------------------------------------------
// weeklyRoadmapSync — main entry. Returns { ok, recommendations, top_2,
// roadmap_sync_id }. Always writes through W3.1 appendRoadmapSync (priority 1
// = top-2, priority 2 = remainder) so the canonical record lives in
// roadmap-sync.json + events.jsonl.
// ---------------------------------------------------------------------------
async function weeklyRoadmapSync(slug, opts = {}) {
  if (!slug || typeof slug !== 'string') {
    return { ok: false, reason: 'bad_slug' };
  }
  const pool = _getPool();
  const ops = _getOps();
  if (!pool || !ops) {
    return { ok: false, reason: 'creation_pool_missing' };
  }
  if (typeof pool.isProductBound === 'function' && !pool.isProductBound(slug)) {
    return { ok: false, reason: 'not_bound' };
  }
  const days = Number.isFinite(opts.days) ? opts.days : 7;
  const harvest = _harvestRecent(slug, days);

  const candidates = _clusterCandidates(harvest);
  const scored = candidates.map((c) => ({ c, score: _scoreCandidate(c) }));
  // priority desc — top of list = surface first
  scored.sort((a, b) => b.score.priority - a.score.priority);

  // Min 6, max 8. When the harvest is too sparse, synthesize generic
  // placeholders so the user always sees a non-empty surface and we can
  // verify the pipeline ships data through the contract.
  const MIN = 6, MAX = 8;
  const recommendations = scored.slice(0, MAX).map(({ c, score }) =>
    _synthesizeRecommendation(c, score));
  // intentional-placeholder: synthetic filler kept as-is per W5.4 brief —
  //   when harvest < MIN=6 we still surface a non-empty list so the pipeline
  //   contract is observable. The text + score below are explicitly marked
  //   via tagMockOutput so the UI banner renders "v0 模板输出" instead of
  //   masquerading as a real recommendation. Real swap lands when T6_STRONG
  //   ships per auto-roadmap-sync.js:219 plus a harvest-back-off policy.
  while (recommendations.length < MIN) {
    recommendations.push(tagMockOutput({
      text: `本周尚无 ${recommendations.length + 1} 号建议来源 — 蓝图缺口提示, 等待积累`,
      action: '观察',
      target_section: 'general',
      evidence: [],
      score: { urgency: 0, impact: 0, feasibility: 0.5, priority: 0 },
      candidate_id: `synthetic:${recommendations.length}`,
    }, 'auto-roadmap-sync synthetic filler (harvest below MIN=6, T6_STRONG deferred)'));
  }
  const top_2 = recommendations.slice(0, 2);
  const remainder = recommendations.slice(2);

  // Persist — priority 1 for top_2, priority 2 for the rest. ops handles the
  // events.jsonl row + roadmap-sync.json mutation.
  const writeRes = ops.appendRoadmapSync(slug, top_2, 1, 'creation_v1:auto_roadmap_sync');
  if (remainder.length > 0) {
    ops.appendRoadmapSync(slug, remainder, 2, 'creation_v1:auto_roadmap_sync');
  }

  const events = _getEvents();
  if (events && typeof events.write === 'function') {
    try {
      events.write(slug, {
        type: 'creation_v1:roadmap_sync_run',
        days,
        candidates: candidates.length,
        recommendations: recommendations.length,
        top_priority: top_2.length,
      });
    } catch (_) { /* best-effort */ }
  }

  return {
    ok: true,
    slug,
    days,
    recommendations,
    top_2,
    roadmap_sync_id: writeRes && writeRes.id,
    harvest_summary: {
      inspirations: harvest.inspirations.length,
      sparks: harvest.sparks.length,
      events: harvest.events.length,
    },
  };
}

module.exports = {
  weeklyRoadmapSync,
  _internals: {
    harvestRecent: _harvestRecent,
    clusterCandidates: _clusterCandidates,
    scoreCandidate: _scoreCandidate,
    synthesizeRecommendation: _synthesizeRecommendation,
    vaultRoot: _vaultRoot,
  },
};
