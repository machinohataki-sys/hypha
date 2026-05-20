'use strict';

// HYPHA · W6.3 Research Radar — engine entry (BLUEPRINT §15, ROADMAP v1.7)
//
// Anti-principle (binding): HYPHA 不推送前沿. Radar does NOT emit toasts /
// badges / notification streams. The frontier is COMPILED INTO 下一堂 Lesson
// + Product Pool only. Surfacing happens INSIDE existing surfaces (Lesson
// citation block, Spark pool seed entries), never as its own feed.
//
// Flow (per blueprint quote):
//   subscribeTopic → cron runRadarCycle → fetch external (4 sources) →
//   Cheap Router T0_RULE+T1_EMBED 初筛 → top 10 → T6_STRONG synth (mock)
//   → Frontier Report → reports/<topic>/<date>.json → frontier-report.md
//
// Boundary partners:
//   W5.1 cheap-router    — first-pass filtering (`require('../llm/cheap-router')`)
//   W5.2 web-note-engine — `storeAsNote` (auto-actions.js) writes layer='raw'
//   W3.4 product-spark   — `triggerProductSparkCandidate` (auto-actions.js)
//   W6.2 Cron Engine     — `runDailyRadar()` is the scheduled entry
//   W6.5 Voice Memo      — independent (no coupling)
//
// External sources are stubbed (4 TODO comments below) — production will
// route through bb-browser daemon for arxiv / huggingface / github trending
// and the Semantic Scholar API for citation graph. The mock generator is
// deterministic so unit tests can verify the full pipeline shape.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// =====================================================================
// Path resolution — mirrors product-spark.js + web-note-engine/graph.js
// so HYPHA_DATA / HYPHA_VAULT_DIR overrides apply uniformly.
// =====================================================================

function _vaultRoot() {
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) {
    return process.env.HYPHA_DATA;
  }
  if (process.env.HYPHA_VAULT_DIR && fs.existsSync(process.env.HYPHA_VAULT_DIR)) {
    return process.env.HYPHA_VAULT_DIR;
  }
  return path.join(__dirname, '..', '..', '..', 'data');
}

function _radarRoot(slug) {
  if (!slug || typeof slug !== 'string') {
    throw new Error('radar: slug required (non-empty string)');
  }
  if (slug.includes('..') || path.isAbsolute(slug)) {
    throw new Error('radar: slug must be a vault-relative directory name');
  }
  return path.join(_vaultRoot(), slug, 'research-radar');
}

function _subscriptionsPath(slug) {
  return path.join(_radarRoot(slug), 'subscriptions.json');
}

function _reportsDir(slug, topic) {
  return path.join(_radarRoot(slug), 'reports', _slugifyTopic(topic));
}

function _slugifyTopic(topic) {
  // Filesystem-safe topic key: lowercase, replace whitespace + punct with '-'.
  // CJK chars pass through (Windows + macOS handle them fine in paths).
  return String(topic || '').trim().toLowerCase()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80) || 'unknown-topic';
}

function _ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function _todayKey() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// =====================================================================
// Constants
// =====================================================================

const VALID_SOURCES = Object.freeze(['arxiv', 'huggingface', 'github', 'semantic-scholar']);
const VALID_FREQUENCIES = Object.freeze(['daily', 'weekly']);
const DEFAULT_SOURCES = Object.freeze(['arxiv', 'huggingface']);
const FIRST_PASS_TOP_K = 10;
const FIRST_PASS_RELEVANCE_FLOOR = 0.05; // drop only complete misses; T6_STRONG synth handles the rest

// =====================================================================
// Subscription CRUD
// =====================================================================

function _loadSubscriptions(slug) {
  const file = _subscriptionsPath(slug);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    // Malformed file — refuse to clobber, surface as empty list. Caller
    // can decide to repair manually.
    return [];
  }
}

function _saveSubscriptions(slug, subs) {
  _ensureDir(_radarRoot(slug));
  fs.writeFileSync(_subscriptionsPath(slug), JSON.stringify(subs, null, 2), 'utf8');
}

/**
 * Subscribe to a frontier topic for a curriculum slug.
 *
 * @param {string} slug
 * @param {string} topic - free-form topic name (e.g. "diffusion models")
 * @param {object} [options]
 * @param {('daily'|'weekly')} [options.frequency='weekly']
 * @param {string[]} [options.sources=DEFAULT_SOURCES]
 * @param {string[]} [options.filter_keywords]
 * @returns {{ ok:true, subscription:object } | { ok:false, error:string }}
 */
function subscribeTopic(slug, topic, options = {}) {
  if (!slug || typeof slug !== 'string') return { ok: false, error: 'slug required' };
  if (!topic || typeof topic !== 'string') return { ok: false, error: 'topic required (non-empty string)' };
  const frequency = options.frequency || 'weekly';
  if (!VALID_FREQUENCIES.includes(frequency)) {
    return { ok: false, error: `frequency must be one of ${VALID_FREQUENCIES.join('|')}` };
  }
  const sources = Array.isArray(options.sources) && options.sources.length
    ? options.sources.filter(s => VALID_SOURCES.includes(s))
    : DEFAULT_SOURCES.slice();
  if (sources.length === 0) {
    return { ok: false, error: `sources must include at least one of ${VALID_SOURCES.join('|')}` };
  }
  const filterKeywords = Array.isArray(options.filter_keywords)
    ? options.filter_keywords.filter(k => typeof k === 'string' && k.trim().length > 0)
    : [];

  const subs = _loadSubscriptions(slug);
  const existingIdx = subs.findIndex(s => s.topic === topic);
  const subscription = {
    topic,
    frequency,
    sources,
    filter_keywords: filterKeywords,
    last_run: existingIdx >= 0 ? subs[existingIdx].last_run : null,
    created_at: existingIdx >= 0 ? subs[existingIdx].created_at : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (existingIdx >= 0) subs[existingIdx] = subscription;
  else subs.push(subscription);
  _saveSubscriptions(slug, subs);
  return { ok: true, subscription };
}

/**
 * Remove a topic subscription. No-op if topic not found.
 */
function unsubscribeTopic(slug, topic) {
  if (!slug || !topic) return { ok: false, error: 'slug and topic required' };
  const subs = _loadSubscriptions(slug);
  const next = subs.filter(s => s.topic !== topic);
  _saveSubscriptions(slug, next);
  return { ok: true, removed: subs.length - next.length };
}

function listSubscriptions(slug) {
  return _loadSubscriptions(slug);
}

// =====================================================================
// Source fetchers — 4 TODO real-impl; mock deterministic for tests
// =====================================================================

/**
 * Generate deterministic mock items for a topic+source pair. Seeded by the
 * topic string so two runs with the same topic produce identical items —
 * essential for the test smoke pass and for diff-based dedup downstream.
 */
function _mockItems(topic, source, dateKey) {
  const seed = crypto.createHash('sha256').update(`${topic}|${source}|${dateKey}`).digest('hex');
  const count = (parseInt(seed.slice(0, 2), 16) % 4) + 3; // 3..6 items
  const out = [];
  for (let i = 0; i < count; i++) {
    const h = seed.slice(i * 8, i * 8 + 8) || seed.slice(0, 8);
    out.push({
      source,
      title: `${source}/${topic} mock item ${i + 1} (${h})`,
      url: `https://example.org/${source}/${h}`,
      summary_short: `Mock ${source} summary for ${topic} — variant ${i + 1}. Replace with real fetch when ${source} adapter ships.`,
      published_at: dateKey,
      _mock: true,
    });
  }
  return out;
}

async function _fetchArxiv(topic, dateKey) {
  // intentional-placeholder: external arxiv adapter deferred to W6.3 v0.2.
  // Wave 6.3 Alpha task brief explicitly scopes "4 source 真接留 TODO + mock
  // items 真实现 (deterministic)" so the pipeline shape locks first; real
  // fetch wires later. Production target: export.arxiv.org/api/query?
  // search_query=all:<topic> or bb-browser scrape; rate-limit per terms.
  return _mockItems(topic, 'arxiv', dateKey);
}

async function _fetchHuggingFace(topic, dateKey) {
  // intentional-placeholder: HF adapter deferred per Wave 6.3 Alpha brief
  // (mock-only this tranche). Production target: huggingface.co/api/models
  // ?search=<topic>&sort=likes + /api/datasets; cache 24h to spare HF infra.
  return _mockItems(topic, 'huggingface', dateKey);
}

async function _fetchGithub(topic, dateKey) {
  // intentional-placeholder: GitHub adapter deferred per Wave 6.3 Alpha brief
  // (mock-only this tranche). Production target: `gh search repos --json` +
  // GitHub trending RSS; filter by topic match + stars≥10 + last-push window.
  return _mockItems(topic, 'github', dateKey);
}

async function _fetchSemanticScholar(topic, dateKey) {
  // intentional-placeholder: Semantic Scholar adapter deferred per Wave 6.3
  // Alpha brief (mock-only this tranche). Production target: api.semanticscholar
  // .org/graph/v1/paper/search?query=<topic> + citation threshold + 24-month window.
  return _mockItems(topic, 'semantic-scholar', dateKey);
}

const SOURCE_FETCHERS = {
  'arxiv':            _fetchArxiv,
  'huggingface':      _fetchHuggingFace,
  'github':           _fetchGithub,
  'semantic-scholar': _fetchSemanticScholar,
};

async function _fetchAllSources(topic, sources, dateKey) {
  const all = [];
  for (const src of sources) {
    const fn = SOURCE_FETCHERS[src];
    if (!fn) continue;
    try {
      const items = await fn(topic, dateKey);
      if (Array.isArray(items)) all.push(...items);
    } catch (_) {
      // Source failure must not break the cycle — other sources continue.
    }
  }
  return all;
}

// =====================================================================
// Cheap Router first-pass — T0_RULE Jaccard + T1_EMBED escalation
// =====================================================================

async function _firstPassFilter(items, topic, filterKeywords) {
  // Load cheap-router lazily so this module loads without it (tests can
  // monkey-patch). When unavailable, fall back to keyword include match.
  let cheap;
  try { cheap = require('../llm/cheap-router'); } catch (_) { cheap = null; }

  const haystacks = items.map(it => `${it.title || ''} ${it.summary_short || ''}`.trim());
  const query = [topic, ...(filterKeywords || [])].filter(Boolean).join(' ');

  const scored = [];
  if (cheap && typeof cheap.runCheapTask === 'function') {
    // Cheap router relevance_score: T0 Jaccard, escalates to T1 embed on fuzzy band.
    for (let i = 0; i < items.length; i++) {
      try {
        const r = await cheap.runCheapTask('relevance_score', { query, doc: haystacks[i] }, {});
        const score = r && r.result && typeof r.result.score === 'number' ? r.result.score : 0;
        scored.push({ item: items[i], score, capability: r && r.capability });
      } catch (_) {
        scored.push({ item: items[i], score: 0, capability: 'fallback' });
      }
    }
  } else {
    // Lexical fallback when cheap-router not loadable (e.g. unit smoke).
    const q = String(query || '').toLowerCase();
    const qTokens = q.split(/\s+/).filter(t => t.length > 1);
    for (let i = 0; i < items.length; i++) {
      const hay = haystacks[i].toLowerCase();
      let hits = 0;
      for (const t of qTokens) if (hay.includes(t)) hits++;
      scored.push({ item: items[i], score: qTokens.length ? hits / qTokens.length : 0, capability: 'fallback_lexical' });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.filter(s => s.score >= FIRST_PASS_RELEVANCE_FLOOR).slice(0, FIRST_PASS_TOP_K);
}

// =====================================================================
// runRadarCycle — single end-to-end pass for one slug
// =====================================================================

/**
 * Run one radar cycle for a slug. When `topicFilter` is provided, only that
 * topic's subscription runs; otherwise all subscriptions for the slug fire.
 *
 * @param {string} slug
 * @param {string} [topicFilter]
 * @param {object} [opts]
 * @param {(items:Array, goalContract:object)=>Promise<object>} [opts.synthesizer]
 *   Override for the T6_STRONG report synthesizer (test hook). Defaults to
 *   frontier-report.generateReport.
 * @returns {Promise<{ ok:true, reports: Array<{topic, path, report}> } | { ok:false, error:string }>}
 */
async function runRadarCycle(slug, topicFilter, opts = {}) {
  if (!slug) return { ok: false, error: 'slug required' };
  const subs = _loadSubscriptions(slug);
  if (subs.length === 0) return { ok: true, reports: [] };

  const targets = topicFilter ? subs.filter(s => s.topic === topicFilter) : subs;
  if (targets.length === 0) {
    return { ok: false, error: `no subscription found for topic: ${topicFilter}` };
  }

  // Lazy load frontier-report — circular-safe (report module does not
  // re-require radar.js).
  let frontierReport;
  try { frontierReport = require('./frontier-report'); } catch (_) { frontierReport = null; }
  const synth = opts.synthesizer
    || (frontierReport && frontierReport.generateReport)
    || _fallbackSynth;

  const dateKey = _todayKey();
  const reports = [];
  const errors = [];
  for (const sub of targets) {
    try {
      const fetched = await _fetchAllSources(sub.topic, sub.sources, dateKey);
      const top = await _firstPassFilter(fetched, sub.topic, sub.filter_keywords);
      // Goal contract is read lazily via vault state.json; pass minimal shape
      // when absent so synth still produces a usable report.
      const goalContract = _loadGoalContract(slug) || { topic: sub.topic };
      const synthInput = top.map(s => s.item);
      const report = await synth(synthInput, goalContract, { topic: sub.topic, date: dateKey });
      const reportFinal = {
        topic: sub.topic,
        date: dateKey,
        slug,
        generated_at: new Date().toISOString(),
        items: synthInput,
        ...(report || {}),
      };
      const outDir = _reportsDir(slug, sub.topic);
      _ensureDir(outDir);
      const outPath = path.join(outDir, `${dateKey}.json`);
      fs.writeFileSync(outPath, JSON.stringify(reportFinal, null, 2), 'utf8');
      reports.push({ topic: sub.topic, path: outPath, report: reportFinal });

      // Update last_run for this subscription.
      const allSubs = _loadSubscriptions(slug);
      const idx = allSubs.findIndex(s => s.topic === sub.topic);
      if (idx >= 0) {
        allSubs[idx] = { ...allSubs[idx], last_run: new Date().toISOString() };
        _saveSubscriptions(slug, allSubs);
      }
    } catch (err) {
      errors.push({ topic: sub.topic, error: err && err.message });
    }
  }
  return { ok: true, reports, errors };
}

// Fallback synthesizer when frontier-report module is unavailable (tests).
async function _fallbackSynth(items, goalContract, ctx) {
  return {
    synthesis_paragraph: `[mock synth] ${items.length} items for ${ctx && ctx.topic}.`,
    action_items: [],
    product_spark_candidates: [],
  };
}

function _loadGoalContract(slug) {
  // Best-effort read of vault/<slug>/state.json learnGoal + main_creation
  // shape — the Goal Contract surface the report synthesizer reasons over.
  try {
    const p = path.join(_vaultRoot(), slug, 'state.json');
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      slug,
      north_star: raw.learn_goal || raw.learnGoal || raw.northStar || '',
      main_creation: raw.main_creation || '',
      topic: raw.topic || '',
    };
  } catch (_) {
    return null;
  }
}

// =====================================================================
// Report read API — used by UI dashboard + lesson citation hook
// =====================================================================

/**
 * Read the most recent report for a topic (or null if none).
 */
function getLatestReport(slug, topic) {
  const dir = _reportsDir(slug, topic);
  if (!fs.existsSync(dir)) return null;
  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return null; }
  const files = entries.filter(f => /\.json$/i.test(f)).sort().reverse();
  if (files.length === 0) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * List reports for a topic (most recent first).
 */
function listReports(slug, topic) {
  const dir = _reportsDir(slug, topic);
  if (!fs.existsSync(dir)) return [];
  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return []; }
  const files = entries.filter(f => /\.json$/i.test(f)).sort().reverse();
  return files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
    catch (_) { return null; }
  }).filter(Boolean);
}

/**
 * List all reports for a slug across every topic (flattened, newest first).
 */
function listAllReports(slug) {
  const subs = _loadSubscriptions(slug);
  const out = [];
  for (const sub of subs) out.push(...listReports(slug, sub.topic));
  out.sort((a, b) => String(b.generated_at || '').localeCompare(String(a.generated_at || '')));
  return out;
}

// =====================================================================
// Exports
// =====================================================================

module.exports = {
  // Subscriptions
  subscribeTopic,
  unsubscribeTopic,
  listSubscriptions,
  // Cycle
  runRadarCycle,
  // Reports
  getLatestReport,
  listReports,
  listAllReports,
  // Constants
  VALID_SOURCES,
  VALID_FREQUENCIES,
  DEFAULT_SOURCES,
  FIRST_PASS_TOP_K,
  // Internals exported for tests only — not part of the stable surface.
  _internals: {
    _slugifyTopic,
    _radarRoot,
    _todayKey,
    _mockItems,
    _firstPassFilter,
    _loadGoalContract,
  },
};
