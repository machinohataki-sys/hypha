'use strict';

// frontier-cron.js — v0.5.2 Frontier Scheduler.
// Walks active vault topics on a ≥6h interval, calls harvestV3 in cronMode
// (silent, Tavily fallback when Layer 3 returns 0), writes a daily digest
// to vault/.frontier-digest/<YYYY-MM-DD>.md. NO auto-run on import.
//
// Public surface:
//   tickOnce({ dryRun })  — single sweep, returns [{ topic, deltaCount, sources }]
//   start({ intervalHours, settings, dryRun })  — register setInterval
//   stop()                — clear interval
//
// Constraints (per plan §Cross-Lane):
//   - cron *imports* agent/vault; agent must NOT import this file
//   - interval ≥ 6h enforced (rate-limit safety)
//   - no silent-catch — every catch logs reason
//   - vault writes restricted to vault/.frontier-digest/<date>.md
//   - significant state writes use events.jsonl, not console.log
//   - every long op honors AbortController-based cancellation

const fs = require('node:fs');
const path = require('node:path');

const MIN_INTERVAL_HOURS = 6;
const MAX_INTERVAL_HOURS = 24;
const DEFAULT_INTERVAL_HOURS = 6;

// Module-scope state. start()/stop() guard against double-register.
let _intervalId = null;
let _activeAbort = null;

function _today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function _readActiveTopics(vault) {
  // Walk vault root for course folders. Active = state.json present + lifecycle
  // ≠ 'deprecated'. Returns array of { slug, topic, archetype }.
  const out = [];
  let listing;
  try {
    listing = vault.list();
  } catch (err) {
    _logEvent(vault, 'frontier_cron_topics_walk_failed', { reason: err && err.message ? err.message : String(err) });
    return out;
  }
  const folders = (listing && Array.isArray(listing.folders)) ? listing.folders : [];
  for (const f of folders) {
    const slug = f && (f.name || f.slug);
    if (!slug) continue;
    const stateRel = `${slug}/state.json`;
    let state;
    try {
      if (!vault.exists(stateRel)) continue;
      state = vault.readJSON(stateRel, null);
    } catch (err) {
      _logEvent(vault, 'frontier_cron_state_read_failed', { slug, reason: err && err.message ? err.message : String(err) });
      continue;
    }
    if (!state) continue;
    if (state.lifecycle === 'deprecated') continue;
    out.push({
      slug,
      topic: state.topic || slug,
      archetype: state.archetype || '_default',
    });
  }
  return out;
}

function _logEvent(vault, op, payload) {
  // Best-effort telemetry — do not throw if vault telemetry is down.
  try {
    if (vault && typeof vault.appendJSONL === 'function') {
      vault.appendJSONL('events.jsonl', {
        ts: new Date().toISOString(),
        op,
        ...(payload || {}),
      });
      return;
    }
  } catch (err) {
    // Fall through to stderr — never silent on persistence failure.
    process.stderr.write(`[frontier-cron] events.jsonl write failed (${op}): ${err && err.message ? err.message : err}\n`);
    return;
  }
  process.stderr.write(`[frontier-cron] ${op} ${JSON.stringify(payload || {})}\n`);
}

function _formatDigest(date, perTopic) {
  // Manuscript register — italic Garamond cadence in copy. No emoji, no
  // exclamation marks. Sections ordered chronologically per harvest.
  const lines = [];
  lines.push(`# Frontier digest · ${date}`);
  lines.push('');
  if (!perTopic.length) {
    lines.push('_No active topics swept this cycle._');
    lines.push('');
    return lines.join('\n');
  }
  for (const t of perTopic) {
    lines.push(`## ${t.topic}`);
    lines.push('');
    lines.push(`_${t.deltaCount} new source${t.deltaCount === 1 ? '' : 's'} this cycle._`);
    lines.push('');
    if (Array.isArray(t.sources) && t.sources.length) {
      const top = t.sources.slice(0, 8);
      for (const s of top) {
        const title = (s && s.title) ? s.title.replace(/\s+/g, ' ').slice(0, 140) : '(untitled)';
        const url = (s && s.url) ? s.url : '';
        const src = (s && s.source) ? ` _(${s.source})_` : (s && s.layer != null ? ` _(layer ${s.layer})_` : '');
        if (url) lines.push(`- [${title}](${url})${src}`);
        else lines.push(`- ${title}${src}`);
      }
      lines.push('');
    }
    if (t.warnings && t.warnings.length) {
      lines.push('_Warnings_:');
      for (const w of t.warnings.slice(0, 4)) lines.push(`- ${w}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

function _writeDigest(vault, date, perTopic) {
  const root = vault.resolveRoot();
  const dir = path.join(root, '.frontier-digest');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    _logEvent(vault, 'frontier_cron_digest_dir_failed', { reason: err && err.message ? err.message : String(err) });
    return null;
  }
  const file = path.join(dir, `${date}.md`);
  const body = _formatDigest(date, perTopic);
  try {
    fs.writeFileSync(file, body, 'utf8');
  } catch (err) {
    _logEvent(vault, 'frontier_cron_digest_write_failed', { reason: err && err.message ? err.message : String(err) });
    return null;
  }
  return file;
}

async function tickOnce(opts = {}) {
  const dryRun = !!opts.dryRun;
  const vault = require('../lib/vault');
  // Lazy-require agent.js only at tick time — avoids any boot-order coupling.
  const agent = require('../agent');
  const settings = opts.settings || {};

  // Per-tick AbortController so stop() can cancel in flight.
  const controller = new AbortController();
  _activeAbort = controller;

  const topics = _readActiveTopics(vault);
  _logEvent(vault, 'frontier_cron_tick_start', { count: topics.length, dryRun });

  const perTopic = [];
  for (const t of topics) {
    if (controller.signal.aborted) {
      _logEvent(vault, 'frontier_cron_tick_aborted', { remaining: topics.length - perTopic.length });
      break;
    }
    let r;
    try {
      r = await agent.harvestV3(t.topic, settings, null, t.archetype, {
        cronMode: true,
        tavilyFallback: true,
        signal: controller.signal,
      });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      _logEvent(vault, 'frontier_cron_topic_failed', { slug: t.slug, topic: t.topic, reason: msg });
      perTopic.push({ topic: t.topic, slug: t.slug, deltaCount: 0, sources: [], warnings: [msg] });
      continue;
    }
    const sources = (r && Array.isArray(r.sources)) ? r.sources : [];
    perTopic.push({
      topic: t.topic,
      slug: t.slug,
      deltaCount: sources.length,
      sources,
      warnings: (r && Array.isArray(r.warnings)) ? r.warnings : [],
    });
  }

  let digestPath = null;
  if (!dryRun && perTopic.length > 0) {
    digestPath = _writeDigest(vault, _today(), perTopic);
  }
  _logEvent(vault, 'frontier_cron_tick_done', {
    topics: perTopic.length,
    total_sources: perTopic.reduce((s, x) => s + (x.deltaCount || 0), 0),
    digest: digestPath,
    dryRun,
  });

  _activeAbort = null;
  // Return shape per orchestrator spec — array of { topic, deltaCount, sources }.
  return perTopic.map(t => ({ topic: t.topic, deltaCount: t.deltaCount, sources: t.sources }));
}

function _resolveIntervalMs(opts, settings) {
  let hours = DEFAULT_INTERVAL_HOURS;
  if (opts && Number.isFinite(opts.intervalHours)) hours = opts.intervalHours;
  else if (settings && settings.app && Number.isFinite(settings.app.frontierCronInterval)) hours = settings.app.frontierCronInterval;
  if (hours < MIN_INTERVAL_HOURS) hours = MIN_INTERVAL_HOURS;
  if (hours > MAX_INTERVAL_HOURS) hours = MAX_INTERVAL_HOURS;
  return { hours, ms: hours * 60 * 60 * 1000 };
}

function start(opts = {}) {
  if (_intervalId) {
    return { ok: true, alreadyRunning: true, intervalMs: null };
  }
  const settings = opts.settings || {};
  const { ms } = _resolveIntervalMs(opts, settings);
  if (!Number.isFinite(ms) || ms < MIN_INTERVAL_HOURS * 60 * 60 * 1000) {
    return { ok: false, error: 'interval >= 6h required' };
  }
  _intervalId = setInterval(() => {
    tickOnce({ dryRun: !!opts.dryRun, settings }).catch(err => {
      // Never let a tick failure kill the interval — log + continue.
      try {
        const vault = require('../lib/vault');
        _logEvent(vault, 'frontier_cron_tick_unhandled', { reason: err && err.message ? err.message : String(err) });
      } catch (logErr) {
        process.stderr.write(`[frontier-cron] unhandled tick error: ${err && err.message ? err.message : err}\n`);
      }
    });
  }, ms);
  // Surface start in events.jsonl so the user can audit cron lifecycle.
  try {
    const vault = require('../lib/vault');
    _logEvent(vault, 'frontier_cron_started', { intervalMs: ms });
  } catch (_) { /* logging best-effort; start succeeded */ }
  return { ok: true, intervalMs: ms };
}

function stop() {
  if (!_intervalId) return { ok: true, alreadyStopped: true };
  clearInterval(_intervalId);
  _intervalId = null;
  if (_activeAbort) {
    try { _activeAbort.abort(); } catch (_) { /* abort signal best-effort */ }
    _activeAbort = null;
  }
  try {
    const vault = require('../lib/vault');
    _logEvent(vault, 'frontier_cron_stopped', {});
  } catch (_) { /* logging best-effort */ }
  return { ok: true };
}

module.exports = { tickOnce, start, stop, MIN_INTERVAL_HOURS, MAX_INTERVAL_HOURS };
