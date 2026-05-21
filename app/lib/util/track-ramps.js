'use strict';

// HYPHA v0.4.13 — Track A/B Exit Ramp pure helpers. Extracted from
// app/main.js so app/scripts/_dev_verify_track_exit_ramps.js can exercise
// validation + aggregation offline without spinning Electron IPC.
//
// Design contract (see specs/track-a-b-social-sandbox.md §164 jsonl row +
// CLAUDE.md project_hypha_NOTE_AGENT register): each row = one user choice
// at /finish boundary. Append-only. Skip-resilient on parse failure.

const VALID_TRACKS = new Set(['A', 'B', 'skip']);
const MAX_URL_LEN = 500;
const MAX_NOTE_LEN = 500;
const URL_RE = /^https?:\/\//i;

function validateSlugShape(slug) {
  if (!slug || typeof slug !== 'string') {
    return { ok: false, error: 'slug required' };
  }
  if (slug.includes('/') || slug.includes('\\') || slug.includes('..') || slug.startsWith('.')) {
    return { ok: false, error: 'invalid slug shape' };
  }
  return { ok: true, value: slug };
}

function validateExitRampArgs(args) {
  const { slug, lessonIdx, track, artifactUrl, commitmentNote } = args || {};
  const slugCheck = validateSlugShape(slug);
  if (!slugCheck.ok) return slugCheck;
  if (!Number.isInteger(lessonIdx) || lessonIdx < 0) {
    return { ok: false, error: 'lessonIdx must be a non-negative integer' };
  }
  if (!VALID_TRACKS.has(track)) {
    return { ok: false, error: "track must be one of 'A' | 'B' | 'skip'" };
  }
  let normUrl = null;
  if (artifactUrl !== undefined && artifactUrl !== null) {
    if (typeof artifactUrl !== 'string') {
      return { ok: false, error: 'artifactUrl must be a string when provided' };
    }
    const trimmed = artifactUrl.trim();
    if (trimmed.length === 0) {
      normUrl = null;
    } else {
      if (trimmed.length > MAX_URL_LEN) {
        return { ok: false, error: `artifactUrl exceeds ${MAX_URL_LEN} chars` };
      }
      if (!URL_RE.test(trimmed)) {
        return { ok: false, error: 'artifactUrl must start with http:// or https://' };
      }
      normUrl = trimmed;
    }
  }
  let normNote = null;
  if (commitmentNote !== undefined && commitmentNote !== null) {
    if (typeof commitmentNote !== 'string') {
      return { ok: false, error: 'commitmentNote must be a string when provided' };
    }
    const trimmed = commitmentNote.trim();
    if (trimmed.length === 0) {
      normNote = null;
    } else {
      if (trimmed.length > MAX_NOTE_LEN) {
        return { ok: false, error: `commitmentNote exceeds ${MAX_NOTE_LEN} chars` };
      }
      normNote = trimmed;
    }
  }
  return {
    ok: true,
    normalized: {
      slug: slugCheck.value,
      lessonIdx,
      track,
      artifactUrl: normUrl,
      commitmentNote: normNote,
    },
  };
}

function buildExitRampEntry(normalized, nowIso) {
  return {
    ts: nowIso || new Date().toISOString(),
    lessonIdx: normalized.lessonIdx,
    track: normalized.track,
    artifactUrl: normalized.artifactUrl || null,
    commitmentNote: normalized.commitmentNote || null,
  };
}

function aggregateExitRamps(lines) {
  const status = {
    totalRamps: 0,
    trackACount: 0,
    trackBCount: 0,
    skipCount: 0,
    entries: [],
    lastRampAt: null,
    byLesson: {},
  };
  if (!Array.isArray(lines)) return status;
  for (const ln of lines) {
    if (typeof ln !== 'string') continue;
    const trimmed = ln.trim();
    if (!trimmed) continue;
    let rec;
    try { rec = JSON.parse(trimmed); } catch (_) { continue; }
    if (!rec || typeof rec !== 'object') continue;
    if (!VALID_TRACKS.has(rec.track)) continue;
    if (!Number.isInteger(rec.lessonIdx) || rec.lessonIdx < 0) continue;
    status.totalRamps += 1;
    if (rec.track === 'A') status.trackACount += 1;
    else if (rec.track === 'B') status.trackBCount += 1;
    else status.skipCount += 1;
    status.entries.push(rec);
    if (typeof rec.ts === 'string') {
      if (!status.lastRampAt || rec.ts > status.lastRampAt) status.lastRampAt = rec.ts;
    }
    const key = String(rec.lessonIdx);
    if (!status.byLesson[key]) status.byLesson[key] = [];
    status.byLesson[key].push({
      track: rec.track,
      ts: rec.ts || null,
      artifactUrl: rec.artifactUrl || null,
      commitmentNote: rec.commitmentNote || null,
    });
  }
  return status;
}

module.exports = {
  VALID_TRACKS,
  MAX_URL_LEN,
  MAX_NOTE_LEN,
  validateExitRampArgs,
  buildExitRampEntry,
  aggregateExitRamps,
};
