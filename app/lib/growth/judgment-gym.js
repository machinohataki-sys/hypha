'use strict';

// HYPHA · β17 Judgment Gym (Growth System §28 子组件 v0, 2026-05-16)
//
// 判断练习场。学习中遇到的 contestable claim 沉淀, 一段时间后系统拿出来让
// user 重新判断一次, 记录前后判断 + 理由变化。Anti-Sycophancy + Persona
// Coherence 训练场 (user 对 LLM 给的判断有自己的 calibration)。
//
// 蓝图 §28: "Judgment Gym 把课程内出现的 contestable claim 沉淀, 后续 surface
// 让学生在更冷的时间点重新判断 — Anti-LLM-hypnosis"。
//
// Public surface:
//   addClaim({ slug, claim, sourceLessonIdx, sourceLessonTitle, initialJudgment, initialReasoning, topic })
//     → { ok:true, entry } | { ok:false, error }
//   listOpenClaims({ slug, limit })      — rejudgments.length === 0
//   listAllClaims({ slug, limit })       — full aggregate (incl. rejudgments)
//   rejudgeClaim({ slug, claimId, newJudgment, newReasoning })
//     → { ok:true, entry } | { ok:false, error }
//   getClaim({ slug, claimId })
//     → { ok:true, entry } | { ok:false, error }
//   dueForRejudge({ slug, minAgeDays })  — open AND age > minAgeDays
//
// Storage: vault/<slug>/.judgment-gym.jsonl, append-only.
//   row A — claim seed:     { id, ts, claim, sourceLessonIdx, sourceLessonTitle,
//                             topic, initialJudgment, initialReasoning }
//   row B — rejudge event:  { rejudgeOf: claimId, ts, judgment, reasoning }
// aggregate-on-read: 扫一次文件, claimMap[id] = seed, push rejudgeOf rows to
// entry.rejudgments[]。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { resolveRoot } = require('../vault');

const JUDGMENT_ENUM = Object.freeze(['agree', 'disagree', 'partial', 'unsure']);
const MAX_CLAIM_LEN = 500;
const MAX_REASONING_LEN = 800;
const DEFAULT_MIN_AGE_DAYS = 3;

// Yerkes-Dodson edge band — stability in [0.3, 0.7] = right at the boundary
// between over-confident (1.0 always-agree) and pure noise (0.0 flip-flop).
const EDGE_BAND_LOW = 0.3;
const EDGE_BAND_HIGH = 0.7;
const DEFAULT_EDGE_TARGET = 0.5;

function _gymPath(slug) {
  const vaultRoot = resolveRoot();
  return path.join(vaultRoot, String(slug), '.judgment-gym.jsonl');
}

function _readAllRows(abs) {
  if (!fs.existsSync(abs)) return [];
  let text = '';
  try { text = fs.readFileSync(abs, 'utf-8'); }
  catch (_) { return []; }
  if (!text) return [];
  const out = [];
  for (const ln of text.split(/\r?\n/)) {
    if (!ln.trim()) continue;
    try { out.push(JSON.parse(ln)); } catch (_) { /* skip malformed */ }
  }
  return out;
}

// Aggregate seed rows + rejudge rows → entries with rejudgments[] populated.
// Sorted by seed ts ascending (oldest first). Caller can reverse if needed.
function _aggregate(rows) {
  const claimMap = new Map();
  const rejudgeRows = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r.rejudgeOf === 'string') {
      rejudgeRows.push(r);
      continue;
    }
    if (typeof r.id !== 'string' || !r.id) continue;
    claimMap.set(r.id, {
      id: r.id,
      ts: r.ts,
      claim: r.claim,
      sourceLessonIdx: (typeof r.sourceLessonIdx === 'number') ? r.sourceLessonIdx : null,
      sourceLessonTitle: (typeof r.sourceLessonTitle === 'string') ? r.sourceLessonTitle : null,
      topic: (typeof r.topic === 'string') ? r.topic : '',
      initialJudgment: r.initialJudgment,
      initialReasoning: (typeof r.initialReasoning === 'string') ? r.initialReasoning : '',
      rejudgments: [],
    });
  }
  for (const rj of rejudgeRows) {
    const entry = claimMap.get(rj.rejudgeOf);
    if (!entry) continue;
    entry.rejudgments.push({
      ts: rj.ts,
      judgment: rj.judgment,
      reasoning: (typeof rj.reasoning === 'string') ? rj.reasoning : '',
    });
  }
  // Sort each entry's rejudgments by ts ascending (chronological).
  for (const e of claimMap.values()) {
    e.rejudgments.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  }
  return Array.from(claimMap.values());
}

function _ageDays(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return (Date.now() - t) / 86400000;
}

async function addClaim({
  slug,
  claim,
  sourceLessonIdx = null,
  sourceLessonTitle = null,
  initialJudgment,
  initialReasoning = '',
  topic = '',
} = {}) {
  try {
    if (!slug || typeof slug !== 'string') {
      return { ok: false, error: 'MISSING_SLUG' };
    }
    if (!JUDGMENT_ENUM.includes(initialJudgment)) {
      return { ok: false, error: 'INVALID_JUDGMENT' };
    }
    const trimmedClaim = (typeof claim === 'string') ? claim.trim() : '';
    if (!trimmedClaim) {
      return { ok: false, error: 'CLAIM_TOO_LONG', message: 'empty claim' };
    }
    if (trimmedClaim.length > MAX_CLAIM_LEN) {
      return { ok: false, error: 'CLAIM_TOO_LONG' };
    }
    const trimmedReasoning = (typeof initialReasoning === 'string')
      ? initialReasoning.trim().slice(0, MAX_REASONING_LEN)
      : '';
    const trimmedTopic = (typeof topic === 'string')
      ? topic.trim().slice(0, 120)
      : '';

    const seed = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      claim: trimmedClaim,
      sourceLessonIdx: (typeof sourceLessonIdx === 'number' && Number.isFinite(sourceLessonIdx))
        ? sourceLessonIdx
        : null,
      sourceLessonTitle: (typeof sourceLessonTitle === 'string' && sourceLessonTitle.trim())
        ? sourceLessonTitle.trim()
        : null,
      topic: trimmedTopic,
      initialJudgment,
      initialReasoning: trimmedReasoning,
    };

    const abs = _gymPath(slug);
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.appendFileSync(abs, JSON.stringify(seed) + '\n', 'utf-8');
    } catch (err) {
      return { ok: false, error: 'EXCEPTION', message: err && err.message };
    }

    return { ok: true, entry: { ...seed, rejudgments: [] } };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

async function listOpenClaims({ slug, limit = 20 } = {}) {
  try {
    if (!slug || typeof slug !== 'string') {
      return { ok: false, error: 'MISSING_SLUG' };
    }
    const rows = _readAllRows(_gymPath(slug));
    const entries = _aggregate(rows).filter(e => e.rejudgments.length === 0);
    // newest first for surface UX
    entries.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    const cap = (typeof limit === 'number' && limit > 0) ? Math.floor(limit) : 20;
    return { ok: true, entries: entries.slice(0, cap) };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

async function listAllClaims({ slug, limit = 50 } = {}) {
  try {
    if (!slug || typeof slug !== 'string') {
      return { ok: false, error: 'MISSING_SLUG' };
    }
    const rows = _readAllRows(_gymPath(slug));
    const entries = _aggregate(rows);
    entries.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    const cap = (typeof limit === 'number' && limit > 0) ? Math.floor(limit) : 50;
    return { ok: true, entries: entries.slice(0, cap) };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

async function rejudgeClaim({
  slug,
  claimId,
  newJudgment,
  newReasoning = '',
} = {}) {
  try {
    if (!slug || typeof slug !== 'string') {
      return { ok: false, error: 'MISSING_SLUG' };
    }
    if (!claimId || typeof claimId !== 'string') {
      return { ok: false, error: 'CLAIM_NOT_FOUND' };
    }
    if (!JUDGMENT_ENUM.includes(newJudgment)) {
      return { ok: false, error: 'INVALID_JUDGMENT' };
    }
    const abs = _gymPath(slug);
    const rows = _readAllRows(abs);
    const aggregated = _aggregate(rows);
    const target = aggregated.find(e => e.id === claimId);
    if (!target) {
      return { ok: false, error: 'CLAIM_NOT_FOUND' };
    }
    const trimmedReasoning = (typeof newReasoning === 'string')
      ? newReasoning.trim().slice(0, MAX_REASONING_LEN)
      : '';
    const rejudgeRow = {
      rejudgeOf: claimId,
      ts: new Date().toISOString(),
      judgment: newJudgment,
      reasoning: trimmedReasoning,
    };
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.appendFileSync(abs, JSON.stringify(rejudgeRow) + '\n', 'utf-8');
    } catch (err) {
      return { ok: false, error: 'EXCEPTION', message: err && err.message };
    }
    // Return refreshed entry with new rejudge appended.
    const refreshed = {
      ...target,
      rejudgments: [
        ...target.rejudgments,
        { ts: rejudgeRow.ts, judgment: rejudgeRow.judgment, reasoning: rejudgeRow.reasoning },
      ],
    };
    return { ok: true, entry: refreshed };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

async function getClaim({ slug, claimId } = {}) {
  try {
    if (!slug || typeof slug !== 'string') {
      return { ok: false, error: 'MISSING_SLUG' };
    }
    if (!claimId || typeof claimId !== 'string') {
      return { ok: false, error: 'CLAIM_NOT_FOUND' };
    }
    const rows = _readAllRows(_gymPath(slug));
    const entries = _aggregate(rows);
    const target = entries.find(e => e.id === claimId);
    if (!target) {
      return { ok: false, error: 'CLAIM_NOT_FOUND' };
    }
    return { ok: true, entry: target };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

async function dueForRejudge({
  slug,
  minAgeDays = DEFAULT_MIN_AGE_DAYS,
} = {}) {
  try {
    if (!slug || typeof slug !== 'string') {
      return { ok: false, error: 'MISSING_SLUG' };
    }
    const rows = _readAllRows(_gymPath(slug));
    const entries = _aggregate(rows);
    const threshold = (typeof minAgeDays === 'number' && minAgeDays >= 0)
      ? minAgeDays
      : DEFAULT_MIN_AGE_DAYS;
    const due = entries
      .filter(e => e.rejudgments.length === 0 && _ageDays(e.ts) > threshold)
      // oldest first — they have been cold longest, surface them first
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    return { ok: true, entries: due };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

// Per-domain stability calibration. Stability = fraction of judgments where
// initial matches latest rejudgment (proxy: did your cold-judgment hold?).
// 1.0 = always stable (could be over-confident); 0.0 = always flips
// (under-confident / noisy); 0.5 = honest edge. Y-D optimum = mid-band.
function _stabilityForEntry(entry) {
  if (!entry || !Array.isArray(entry.rejudgments) || entry.rejudgments.length === 0) {
    return null;
  }
  const latest = entry.rejudgments[entry.rejudgments.length - 1];
  return latest.judgment === entry.initialJudgment ? 1 : 0;
}

async function getCalibration({ slug } = {}) {
  try {
    if (!slug || typeof slug !== 'string') {
      return { ok: false, error: 'MISSING_SLUG' };
    }
    const rows = _readAllRows(_gymPath(slug));
    const entries = _aggregate(rows);
    const perTopic = new Map();
    for (const e of entries) {
      const topic = (typeof e.topic === 'string' && e.topic) ? e.topic : '__unknown__';
      const stab = _stabilityForEntry(e);
      if (stab === null) continue;
      const bucket = perTopic.get(topic) || { topic, n: 0, sum: 0 };
      bucket.n += 1;
      bucket.sum += stab;
      perTopic.set(topic, bucket);
    }
    const calibration = Array.from(perTopic.values()).map(b => ({
      topic: b.topic,
      n: b.n,
      stability: Number((b.sum / b.n).toFixed(3)),
    }));
    return { ok: true, calibration };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

// Pick the next claim to surface at the user's edge of competence:
// 1. Open claims whose topic stability sits inside the edge band (0.3..0.7)
//    are scored by distance from target (default 0.5).
// 2. Tie-break by age (older = more thawed = better for rejudge).
// 3. Cold-start: topic with no rejudgments yet → treat stability = target so
//    user gets exposure (rather than refuse).
async function nextEdgeChallenge({
  slug,
  target = DEFAULT_EDGE_TARGET,
  band = [EDGE_BAND_LOW, EDGE_BAND_HIGH],
} = {}) {
  try {
    if (!slug || typeof slug !== 'string') {
      return { ok: false, error: 'MISSING_SLUG' };
    }
    const calRes = await getCalibration({ slug });
    if (!calRes.ok) return calRes;
    const stabByTopic = new Map(calRes.calibration.map(c => [c.topic, c.stability]));

    const openRes = await listOpenClaims({ slug, limit: 200 });
    if (!openRes.ok) return openRes;

    const [lo, hi] = Array.isArray(band) && band.length === 2 ? band : [EDGE_BAND_LOW, EDGE_BAND_HIGH];
    const tgt = (typeof target === 'number' && target >= 0 && target <= 1) ? target : DEFAULT_EDGE_TARGET;

    const scored = openRes.entries.map(e => {
      const topic = (typeof e.topic === 'string' && e.topic) ? e.topic : '__unknown__';
      const stab = stabByTopic.has(topic) ? stabByTopic.get(topic) : tgt;
      const inBand = stab >= lo && stab <= hi;
      return { entry: e, topic, stability: stab, inBand, distance: Math.abs(stab - tgt) };
    });

    const inBand = scored.filter(s => s.inBand);
    const pool = inBand.length > 0 ? inBand : scored;
    pool.sort((a, b) => a.distance - b.distance
      || String(a.entry.ts).localeCompare(String(b.entry.ts)));

    if (pool.length === 0) {
      return { ok: true, entry: null, reason: 'NO_OPEN_CLAIMS' };
    }
    const top = pool[0];
    return {
      ok: true,
      entry: top.entry,
      topic: top.topic,
      stability: top.stability,
      inBand: top.inBand,
      distance: Number(top.distance.toFixed(3)),
    };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

module.exports = {
  addClaim,
  listOpenClaims,
  listAllClaims,
  rejudgeClaim,
  getClaim,
  dueForRejudge,
  getCalibration,
  nextEdgeChallenge,
  _internals: {
    JUDGMENT_ENUM,
    MAX_CLAIM_LEN,
    MAX_REASONING_LEN,
    DEFAULT_MIN_AGE_DAYS,
    EDGE_BAND_LOW,
    EDGE_BAND_HIGH,
    DEFAULT_EDGE_TARGET,
    stabilityForEntry: _stabilityForEntry,
  },
};
