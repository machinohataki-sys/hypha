/**
 * Layer 4 Community Harvester — bb-browser CLI wrapper with WebSearch fallback.
 *
 * Pulls community-discussion signal across Twitter / Reddit / ProductHunt
 * (+ optional Xiaohongshu / AppStore RSS) via the bb-browser daemon's
 * site adapters. Each site adapter is invoked over child_process.execFile
 * with a short JSON envelope: { id, success, data | error, hint? }.
 *
 * Design notes:
 *   - Daemon precheck is mandatory. If `bb-browser daemon status` exits non-zero
 *     (or the stdout doesn't indicate a running daemon), we set
 *     `daemon_available:false` and route every requested platform through a
 *     WebSearch fallback shape — callers (Machino-D's curate step) can weight
 *     these lower via `fallback_used:true`.
 *   - 知乎 is OUT (user lock 2026-05-09). We never invoke `bb-browser site
 *     zhihu/*`. China-leaning topics that would have benefited from Zhihu
 *     fall back to a `site:zhihu.com` WebSearch (public-only, indirect).
 *   - Per-platform errors are isolated: if reddit fails, twitter still ships.
 *   - AbortSignal: checked between platform calls AND on each child_process.
 *   - No new npm deps; only Node built-ins.
 *
 * sourceType is always 'community-discussion' so the curate step can apply
 * its weighting policy uniformly.
 */

'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execFileAsync = promisify(execFile);

/**
 * Resolve the bb-browser executable. On Windows, npm-installed CLIs ship as
 * `<bin>.cmd` shims and bare `execFile('bb-browser', ...)` raises ENOENT.
 * We cache the resolved path so we only walk PATH once per process.
 */
let _resolvedBin = null;
function resolveBin() {
  if (_resolvedBin) return _resolvedBin;
  const explicit = process.env.BB_BROWSER_BIN;
  if (explicit && fs.existsSync(explicit)) {
    return (_resolvedBin = explicit);
  }
  const isWin = process.platform === 'win32';
  const exts = isWin ? ['.cmd', '.exe', '.bat', ''] : [''];
  const candidates = ['bb-browser'];
  const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const base of candidates) {
      for (const ext of exts) {
        const full = path.join(dir, base + ext);
        try {
          if (fs.existsSync(full) && fs.statSync(full).isFile()) {
            return (_resolvedBin = full);
          }
        } catch (_) { /* keep scanning */ }
      }
    }
  }
  // Fallback: let execFile try the bare name (will ENOENT on Windows but
  // works on POSIX where the bare name is fine).
  return (_resolvedBin = 'bb-browser');
}

// ----- Constants ------------------------------------------------------------

const ALL_PLATFORMS = ['twitter', 'reddit', 'producthunt', 'xiaohongshu', 'appstore'];
const EXCLUDED_PLATFORMS = new Set(['zhihu']); // 2026-05-09 user lock

const ARCHETYPE_PLATFORMS = {
  'TECH-CONCEPT':     ['twitter', 'reddit', 'producthunt'],
  'HUMANISTIC':       ['twitter', 'reddit'],
  'GUIDE':            ['reddit', 'producthunt'],
  'PROCESS-MASTERY':  ['reddit', 'producthunt'],
  'DECL-MASS':        ['reddit'],
};
const DEFAULT_PLATFORMS = ['twitter', 'reddit'];

const DEFAULTS = {
  maxPostsPerPlatform: 10,
  timeoutMs: 180_000,         // 3 min total
  perCallTimeoutMs: 45_000,   // each bb-browser call budget
};

// ----- Public API -----------------------------------------------------------

/**
 * @param {object} args
 * @param {string} args.topic
 * @param {string} [args.archetype]
 * @param {object} [args.options]
 * @returns {Promise<object>} CommunityHarvest
 */
async function harvestLayer4Community(args) {
  if (!args || typeof args.topic !== 'string' || !args.topic.trim()) {
    throw new Error('harvestLayer4Community: args.topic (string) required');
  }
  const topic = args.topic.trim();
  const archetype = (args.archetype || '').toUpperCase();
  const options = args.options || {};
  const signal = options.signal;

  const requested = pickPlatforms(options.platforms, archetype);
  const maxPosts = clampPositiveInt(options.maxPostsPerPlatform, DEFAULTS.maxPostsPerPlatform);
  const totalBudgetMs = clampPositiveInt(options.timeoutMs, DEFAULTS.timeoutMs);
  const deadline = Date.now() + totalBudgetMs;

  const warnings = [];
  const platforms = {};

  // Daemon precheck (mandatory).
  const daemonAvailable = await checkDaemon({ signal, deadline });

  for (const name of requested) {
    throwIfAborted(signal);
    if (Date.now() > deadline) {
      platforms[name] = makeEmptyPlatform({
        ok: false,
        error: 'total_timeout_exceeded',
        fallbackUsed: false,
      });
      warnings.push(`platform:${name} skipped — total budget exceeded`);
      continue;
    }

    const remainingMs = Math.max(5_000, deadline - Date.now());
    const perCallMs = Math.min(DEFAULTS.perCallTimeoutMs, remainingMs);

    if (!daemonAvailable) {
      platforms[name] = await fallbackWebSearch({ platform: name, topic, maxPosts, signal });
      continue;
    }

    try {
      const result = await harvestOnePlatform({
        platform: name, topic, maxPosts, perCallMs, signal,
      });
      if (result.ok && result.posts.length > 0) {
        platforms[name] = result;
      } else {
        // Soft-degrade to fallback when bb-browser returns ok-but-empty or errored.
        const fb = await fallbackWebSearch({ platform: name, topic, maxPosts, signal });
        // Preserve the original error context in the fallback record.
        if (result.error) fb.bb_error = result.error;
        platforms[name] = fb;
      }
    } catch (err) {
      if (err && err.code === 'CANCELLED') throw err;
      const fb = await fallbackWebSearch({ platform: name, topic, maxPosts, signal });
      fb.bb_error = String(err && err.message ? err.message : err);
      platforms[name] = fb;
    }
  }

  // Aggregate.
  let totalPosts = 0;
  let fallbackUsedAny = false;
  for (const k of Object.keys(platforms)) {
    totalPosts += (platforms[k].posts || []).length;
    if (platforms[k].fallback_used) fallbackUsedAny = true;
  }

  return {
    platforms,
    total_posts: totalPosts,
    daemon_available: daemonAvailable,
    fallback_used_any: fallbackUsedAny,
    warnings,
    excluded_platforms: Array.from(EXCLUDED_PLATFORMS),
    topic,
    archetype: archetype || null,
    timestamp: new Date().toISOString(),
  };
}

module.exports = { harvestLayer4Community };

// ----- Platform selection ---------------------------------------------------

function pickPlatforms(explicit, archetype) {
  let candidates;
  if (Array.isArray(explicit) && explicit.length > 0) {
    candidates = explicit;
  } else if (archetype && ARCHETYPE_PLATFORMS[archetype]) {
    candidates = ARCHETYPE_PLATFORMS[archetype];
  } else {
    candidates = DEFAULT_PLATFORMS;
  }
  // Exclude banned + unknown platforms.
  return candidates
    .map(p => String(p).toLowerCase())
    .filter(p => !EXCLUDED_PLATFORMS.has(p))
    .filter(p => ALL_PLATFORMS.includes(p));
}

// ----- Daemon precheck ------------------------------------------------------

async function checkDaemon({ signal, deadline }) {
  throwIfAborted(signal);
  const ms = Math.max(2_000, Math.min(8_000, deadline - Date.now()));
  try {
    const { stdout, stderr } = await execFileAsync(
      resolveBin(), ['daemon', 'status'],
      { timeout: ms, windowsHide: true, signal: toAbortSignal(signal) }
    );
    const out = (stdout || '') + '\n' + (stderr || '');
    return /Daemon running:\s*yes/i.test(out) || /CDP connected:\s*yes/i.test(out);
  } catch (err) {
    if (err && (err.code === 'ABORT_ERR' || err.name === 'AbortError')) {
      throw cancelled();
    }
    return false;
  }
}

// ----- Per-platform dispatch ------------------------------------------------

async function harvestOnePlatform({ platform, topic, maxPosts, perCallMs, signal }) {
  switch (platform) {
    case 'twitter':      return harvestTwitter({ topic, maxPosts, perCallMs, signal });
    case 'reddit':       return harvestReddit({ topic, maxPosts, perCallMs, signal });
    case 'producthunt':  return harvestProductHunt({ topic, maxPosts, perCallMs, signal });
    case 'xiaohongshu':  return harvestXiaohongshu({ topic, maxPosts, perCallMs, signal });
    case 'appstore':
      // bb-browser has no native appstore site adapter; the assassin skill uses
      // a custom node adapter we cannot import here. Treat as fallback-only.
      return { ok: false, posts: [], fallback_used: false, error: 'no_native_adapter' };
    default:
      return { ok: false, posts: [], fallback_used: false, error: 'unknown_platform' };
  }
}

async function harvestTwitter({ topic, maxPosts, perCallMs, signal }) {
  const env = await runBb(
    ['site', 'twitter/search', topic, '--count', String(maxPosts), '--type', 'top', '--json'],
    { perCallMs, signal }
  );
  if (!env.success) return { ok: false, posts: [], fallback_used: false, error: env.error || 'twitter_failed' };
  const data = env.data || {};
  const raw = Array.isArray(data.tweets) ? data.tweets
            : Array.isArray(data.results) ? data.results
            : Array.isArray(data.posts) ? data.posts
            : [];
  const posts = raw.slice(0, maxPosts).map(t => ({
    platform: 'twitter',
    url: t.url || t.permalink || t.link || null,
    title: truncate(t.text || t.full_text || t.title || '', 140),
    excerpt: t.text || t.full_text || '',
    author: pickAuthor(t),
    timestamp: t.created_at || t.timestamp || t.time || null,
    score: numOr(t.like_count, t.likes, t.favorite_count, t.score),
    upvotes: null,
    comment_count: numOr(t.reply_count, t.replies, t.comment_count),
    sourceType: 'community-discussion',
  })).filter(p => p.url || p.excerpt);
  return { ok: true, posts, fallback_used: false, error: null };
}

async function harvestReddit({ topic, maxPosts, perCallMs, signal }) {
  const env = await runBb(
    ['site', 'reddit/search', topic, '--sort', 'top', '--time', 'month',
     '--count', String(maxPosts), '--json'],
    { perCallMs, signal }
  );
  if (!env.success) return { ok: false, posts: [], fallback_used: false, error: env.error || 'reddit_failed' };
  const data = env.data || {};
  const raw = Array.isArray(data.posts) ? data.posts
            : Array.isArray(data.results) ? data.results
            : [];
  const posts = raw.slice(0, maxPosts).map(p => ({
    platform: 'reddit',
    url: p.url || p.permalink || (p.id ? `https://www.reddit.com${p.permalink || ''}` : null),
    title: p.title || '',
    excerpt: truncate(p.selftext || p.body || p.text || '', 500),
    author: p.author || null,
    timestamp: p.created_utc || p.created || p.timestamp || null,
    score: numOr(p.score, p.ups),
    upvotes: numOr(p.ups, p.upvotes, p.score),
    comment_count: numOr(p.num_comments, p.comments, p.comment_count),
    sourceType: 'community-discussion',
  })).filter(p => p.url || p.title);
  return { ok: true, posts, fallback_used: false, error: null };
}

async function harvestProductHunt({ topic, maxPosts, perCallMs, signal }) {
  // ProductHunt has no native search adapter — pull today's list and
  // keyword-filter on tagline / topics / name.
  const env = await runBb(
    ['site', 'producthunt/today', '--count', '50', '--json'],
    { perCallMs, signal }
  );
  if (!env.success) return { ok: false, posts: [], fallback_used: false, error: env.error || 'producthunt_failed' };
  const data = env.data || {};
  const raw = Array.isArray(data.products) ? data.products : [];
  const needle = topic.toLowerCase();
  const tokens = needle.split(/\s+/).filter(Boolean);
  const matches = raw.filter(p => {
    const hay = [
      p.name || '', p.tagline || '',
      Array.isArray(p.topics) ? p.topics.join(' ') : '',
    ].join(' ').toLowerCase();
    return tokens.some(t => hay.includes(t));
  });
  const posts = matches.slice(0, maxPosts).map(p => ({
    platform: 'producthunt',
    url: p.url || p.link || null,
    title: p.name || '',
    excerpt: p.tagline || '',
    author: Array.isArray(p.makers) && p.makers[0] ? (p.makers[0].name || p.makers[0]) : null,
    timestamp: p.timestamp || null,
    score: numOr(p.votes, p.upvotes),
    upvotes: numOr(p.votes, p.upvotes),
    comment_count: numOr(p.comment_count, p.comments),
    sourceType: 'community-discussion',
  })).filter(p => p.url || p.title);
  return { ok: true, posts, fallback_used: false, error: null };
}

async function harvestXiaohongshu({ topic, maxPosts, perCallMs, signal }) {
  const env = await runBb(
    ['site', 'xiaohongshu/search', topic, '--json'],
    { perCallMs, signal }
  );
  if (!env.success) return { ok: false, posts: [], fallback_used: false, error: env.error || 'xhs_failed' };
  const data = env.data || {};
  const raw = Array.isArray(data.notes) ? data.notes
            : Array.isArray(data.results) ? data.results
            : [];
  const posts = raw.slice(0, maxPosts).map(n => ({
    platform: 'xiaohongshu',
    url: n.url || (n.id ? `https://www.xiaohongshu.com/explore/${n.id}` : null),
    title: n.title || '',
    excerpt: truncate(n.desc || n.content || '', 400),
    author: pickAuthor(n),
    timestamp: n.timestamp || n.time || null,
    score: numOr(n.likes, n.like_count),
    upvotes: numOr(n.likes, n.like_count),
    comment_count: numOr(n.comments, n.comment_count),
    sourceType: 'community-discussion',
  })).filter(p => p.url || p.title);
  return { ok: true, posts, fallback_used: false, error: null };
}

// ----- WebSearch fallback ---------------------------------------------------

const WEBSEARCH_SITE = {
  twitter:     'site:twitter.com OR site:x.com',
  reddit:      'site:reddit.com',
  producthunt: 'site:producthunt.com',
  xiaohongshu: 'site:xiaohongshu.com',
  appstore:    'site:apps.apple.com',
};

/**
 * WebSearch fallback. Hypha doesn't have a callable WebSearch from inside a
 * Node module — so we emit a *fallback descriptor* with the exact query and
 * site filter that an upstream caller (e.g. the orchestrator's harvest pass)
 * can execute via the platform's WebSearch tool. Posts list is empty here,
 * but `fallback_query` carries the spec.
 *
 * Machino-D's curate step is expected to either:
 *   (a) re-run with a WebSearch-capable harness, or
 *   (b) treat fallback platforms as "missing community signal" and weight 0.
 */
async function fallbackWebSearch({ platform, topic, maxPosts, signal }) {
  throwIfAborted(signal);
  const siteFilter = WEBSEARCH_SITE[platform] || `site:${platform}.com`;
  return {
    ok: true,
    posts: [], // empty — actual WebSearch must be performed by caller harness
    fallback_used: true,
    error: null,
    fallback_query: `${siteFilter} ${JSON.stringify(topic)}`,
    fallback_max: maxPosts,
    note: 'WebSearch fallback — caller harness must execute the query and append posts',
  };
}

// ----- bb-browser invocation helper -----------------------------------------

async function runBb(argv, { perCallMs, signal }) {
  throwIfAborted(signal);
  try {
    const { stdout } = await execFileAsync(resolveBin(), argv, {
      timeout: perCallMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      signal: toAbortSignal(signal),
    });
    return parseEnvelope(stdout);
  } catch (err) {
    if (err && (err.code === 'ABORT_ERR' || err.name === 'AbortError')) {
      throw cancelled();
    }
    // Non-zero exit: stdout may still hold an envelope ({success:false,...}).
    if (err && typeof err.stdout === 'string' && err.stdout.trim()) {
      try { return parseEnvelope(err.stdout); } catch (_) { /* fallthrough */ }
    }
    return {
      success: false,
      error: `bb_exec_failed: ${err && err.code ? err.code : ''} ${err && err.message ? err.message : err}`.trim(),
    };
  }
}

function parseEnvelope(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return { success: false, error: 'empty_output' };
  // bb-browser may emit one or more JSON lines. Use the LAST parseable JSON object.
  const lines = text.split(/\r?\n/).reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t || (t[0] !== '{' && t[0] !== '[')) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === 'object') return obj;
    } catch (_) { /* keep scanning */ }
  }
  // Last resort: try the entire blob (handles pretty-printed JSON).
  try { return JSON.parse(text); }
  catch (_) { return { success: false, error: 'malformed_json', raw: text.slice(0, 500) }; }
}

// ----- Utilities ------------------------------------------------------------

function makeEmptyPlatform({ ok, error, fallbackUsed }) {
  return { ok: !!ok, posts: [], fallback_used: !!fallbackUsed, error: error || null };
}

function clampPositiveInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function numOr(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickAuthor(o) {
  if (!o) return null;
  if (typeof o.author === 'string') return o.author;
  if (o.author && typeof o.author === 'object') return o.author.name || o.author.handle || o.author.username || null;
  return o.user || o.username || o.handle || null;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw cancelled();
}

function cancelled() {
  const e = new Error('cancelled');
  e.code = 'CANCELLED';
  return e;
}

function toAbortSignal(signal) {
  // execFile accepts AbortSignal directly on Node 16+.
  return signal && typeof signal === 'object' && 'aborted' in signal ? signal : undefined;
}
