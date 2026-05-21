'use strict';

// HYPHA · Phase C · lifetime-ledger storage layer (2026-05-17).
//
// Per-chain append-only JSONL recording weekly self-reports of axis counts.
// Path: `<slug>/lifetime-ledger.jsonl` under vault root.
//
// Entry schema (one JSON object per line):
//   {
//     ts: ISO timestamp (when written)
//     weekIso: 'YYYY-Www' (ISO 8601 week, derived if missing)
//     linkIdx: integer (which chain link this report covers; null = chain-level)
//     axis_counts: { [axis]: number, ... }   // honest cumulative for THIS week
//     note: string                            // user free-text, optional
//   }
//
// Aggregation reads the whole file; volume stays low (weekly cadence, ~52
// rows/year). No deletion or compaction — the ledger is the user's record of
// real time spent and must be preserved verbatim.
//
// vault.appendJSONL + vault.readJSONL exist (see `app/lib/vault.js:501-512`),
// so we use them as primary path; a defensive fallback via vault.read +
// JSON.parse covers older callers (smoke harness) that stub vault differently.

const vault = require('../vault');

const LEDGER_REL = (slug) => `${slug}/lifetime-ledger.jsonl`;

async function getLedger(slug) {
  if (!slug) return { entries: [], firstWeek: null, latestWeek: null };
  try {
    const rel = LEDGER_REL(slug);
    let entries = [];
    if (typeof vault.readJSONL === 'function') {
      entries = (await vault.readJSONL(rel)) || [];
    } else if (typeof vault.read === 'function') {
      const r = await vault.read(rel);
      const raw = r && typeof r.body === 'string' ? r.body : (typeof r === 'string' ? r : '');
      entries = String(raw).split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch (_) { return null; }
      }).filter(Boolean);
    }
    const firstWeek = entries[0] && entries[0].weekIso;
    const latestWeek = entries[entries.length - 1] && entries[entries.length - 1].weekIso;
    return {
      entries,
      firstWeek: firstWeek || null,
      latestWeek: latestWeek || null,
    };
  } catch (_) {
    return { entries: [], firstWeek: null, latestWeek: null };
  }
}

async function appendEntry(slug, weekEntry) {
  if (!slug || !weekEntry) return { ok: false, error: 'slug + weekEntry required' };
  const entry = {
    ts: new Date().toISOString(),
    weekIso: weekEntry.weekIso || _isoWeek(new Date()),
    linkIdx: (typeof weekEntry.linkIdx === 'number') ? weekEntry.linkIdx : null,
    axis_counts: _sanitizeCounts(weekEntry.axis_counts || {}),
    note: typeof weekEntry.note === 'string' ? weekEntry.note : '',
  };
  try {
    const rel = LEDGER_REL(slug);
    if (typeof vault.appendJSONL === 'function') {
      await vault.appendJSONL(rel, entry);
    } else if (typeof vault.write === 'function' && typeof vault.read === 'function') {
      // Fallback (legacy harness only): read-modify-write.
      const existing = await vault.read(rel);
      const prev = existing && typeof existing.body === 'string'
        ? existing.body
        : (typeof existing === 'string' ? existing : '');
      await vault.write(rel, (prev || '') + JSON.stringify(entry) + '\n');
    } else {
      return { ok: false, error: 'vault has no appendJSONL or write' };
    }
    return { ok: true, entry };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

async function aggregateByLink(slug, linkIdx) {
  const { entries } = await getLedger(slug);
  const out = {};
  for (const e of entries) {
    if (e.linkIdx !== linkIdx) continue;
    const ac = e.axis_counts || {};
    for (const [axis, n] of Object.entries(ac)) {
      const num = Number(n);
      if (!Number.isFinite(num)) continue;
      out[axis] = (out[axis] || 0) + num;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function _sanitizeCounts(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || !k) continue;
    const num = Number(v);
    if (!Number.isFinite(num) || num < 0) continue;
    out[k] = num;
  }
  return out;
}

// ISO 8601 week computation — matches `YYYY-Www` (e.g. "2026-W20").
// Implements the Thursday-anchor rule (W01 = week containing Jan 4). All math
// is in UTC; we read getUTC* off the input so a Date constructed as
// `Date.UTC(...)` doesn't get re-localized in non-UTC hosts (caught a bug
// running under TZ=America/Chicago where local-getDate() shifted Jan 5 UTC
// back to Jan 4 local).
function _isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

module.exports = {
  getLedger,
  appendEntry,
  aggregateByLink,
  LEDGER_REL,
  _isoWeek, // exported for smoke verification only
};
