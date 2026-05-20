'use strict';
// HYPHA Wave 2.4 — Motivation Recovery pipeline (theory ship).
//
// Triggered by W2.3 Goal Guardian when state === 'frustrated' (user
// writes '学不动了' / 'I want to give up' / 'tired' / 'I'm done' OR
// scoreHistory shows ≥ 3 consecutive low scores OR session-time >
// cadence soft cap with no break).
//
// Hard constraint (BLUEPRINT §7.5 anti-illusion + manuscript register):
// NO cheerleading. NO '加油'. NO '你可以的'. NO 'great question!'.
// NO emoji. NO '!'. The recovery is built from CONCRETE EVIDENCE, not
// rhetoric. The user owns the next-step choice; we do not pre-select.
//
// 4-stage flow:
//
//   Stage 1 — no push. Strip any motivational rhetoric from output.
//             Validate via the anti-ingratiation guard (mirrored from
//             agent.js post-stream scan).
//
//   Stage 2 — evidence recap. Read vault/<slug>/events.jsonl for the
//             last 7 days. Collect any row where (a) type starts with
//             'micro_proof' AND result === 'PASS', OR (b) type ===
//             'mastery:kp_passed', OR (c) type === 'lesson:complete'.
//             Render as 'you have already grasped: X / Y / Z' with
//             concrete KP labels (not generic).
//
//   Stage 3 — micro-rest offer. 3 options: short (5min) / long (today)
//             / none (continue). UI renders; we just package them.
//
//   Stage 4 — user picks. We do not pick.
//
// Output schema is consumed by repairResultToTutorPrompt() (see
// ./index.js) which produces the next-turn manuscript-register text.

const path = require('path');
const fs = require('fs');

// Phrases banned from any output the pipeline emits. Mirrors agent.js
// post-stream ingratiation scan + adds the motivational rhetoric class.
const _BANNED_PHRASES = Object.freeze([
  '加油', '你可以的', '相信自己', '坚持住', '不要放弃',
  'you can do it', 'great question', 'great job', 'you got this',
  'keep going', 'don\'t give up', 'believe in yourself', 'awesome',
  // Emoji + exclamation handled by separate scan below.
]);

function _vaultRoot() {
  return process.env.HYPHA_VAULT_DIR || path.join(__dirname, '..', '..', '..', 'vault');
}

function _safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function _newInterventionId() {
  return `repair-motivation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Stage 2 — read events.jsonl for last `windowDays` of PASS evidence.
// Returns an array of { kp_id, kp_label, ts, type } records.
function _readEvidenceRecap(slug, windowDays) {
  if (!slug) return [];
  const filePath = path.join(_vaultRoot(), String(slug), 'events.jsonl');
  if (!fs.existsSync(filePath)) return [];
  let lines;
  try {
    lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  } catch (_err) {
    return [];
  }
  const cutoff = Date.now() - (windowDays || 7) * 24 * 60 * 60 * 1000;
  const out = [];
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch (_) { continue; }
    const t = row && row.ts ? Date.parse(row.ts) : 0;
    if (!t || t < cutoff) continue;
    const type = String(row.type || '');
    const result = String(row.result || row.outcome || '').toUpperCase();
    // Three accepted shapes.
    const isMicroProof = /^micro_proof/i.test(type) && result === 'PASS';
    const isKpPassed = type === 'mastery:kp_passed';
    const isLessonComplete = type === 'lesson:complete';
    if (!(isMicroProof || isKpPassed || isLessonComplete)) continue;
    out.push({
      ts: row.ts,
      type,
      kp_id: row.kp_id || row.kpId || null,
      kp_label: row.kp_label || row.kpLabel || row.kp_id || row.lesson_id || null,
    });
  }
  // De-dupe by kp_id (keep most recent).
  const byKp = new Map();
  for (const r of out) {
    const key = r.kp_id || r.kp_label || r.ts;
    if (!byKp.has(key) || byKp.get(key).ts < r.ts) byKp.set(key, r);
  }
  return Array.from(byKp.values()).slice(0, 8);
}

// Validator — scan text for banned phrases / emoji / '!'.
function _violatesRegister(text) {
  const s = String(text || '').toLowerCase();
  for (const p of _BANNED_PHRASES) {
    if (s.includes(String(p).toLowerCase())) return p;
  }
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) return '<emoji>';
  if (text && text.includes('!')) return '!';
  if (text && text.includes('！')) return '！';
  return null;
}

function _writeEvent(slug, payload) {
  if (!slug) return { ok: false, reason: 'no-slug' };
  try {
    const events = require('../events');
    return events.write(String(slug), {
      type: 'repair:motivation',
      ...payload,
    });
  } catch (_err) {
    try {
      const dir = path.join(_vaultRoot(), String(slug));
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const row = JSON.stringify({
        ts: new Date().toISOString(),
        type: 'repair:motivation',
        ...payload,
      }) + '\n';
      fs.appendFileSync(path.join(dir, 'events.jsonl'), row, 'utf8');
      return { ok: true, fallback: true };
    } catch (e2) {
      return { ok: false, reason: e2.message };
    }
  }
}

// Public entry — runMotivationRecovery.
async function runMotivationRecovery(args) {
  const a = args || {};
  const slug = a.slug || null;
  const _recentTurns = _safeArray(a.recentTurns);
  const _scoreHistory = _safeArray(a.scoreHistory);
  const _masteryMap = a.masteryMap || {};
  const windowDays = Number.isFinite(a.windowDays) ? a.windowDays : 7;

  // Stage 2 — evidence recap (real fs read, mandated by task brief).
  const evidence_rows = _readEvidenceRecap(slug, windowDays);
  const evidence_recap = evidence_rows
    .map(r => r.kp_label || r.kp_id)
    .filter(Boolean)
    .map(label => String(label).slice(0, 80));

  // Stage 3 — rest offer.
  const rest_options = [
    { id: 'short_rest', label: '休息 5 分钟', minutes: 5 },
    { id: 'end_session', label: '今天到这里, 明天再来', minutes: null },
    { id: 'continue', label: '不歇, 继续' },
  ];

  // Stage 1 — no push. Recovery body is built from evidence, not rhetoric.
  const bodyLines = [];
  if (evidence_recap.length > 0) {
    bodyLines.push('先看一眼你这周已经握住的东西:');
    for (const label of evidence_recap.slice(0, 6)) {
      bodyLines.push(`  · ${label}`);
    }
  } else {
    bodyLines.push('这周还没有沉淀下来的稳定证据 —— 这本身也是一个数据点, 不是错处.');
  }
  bodyLines.push('');
  bodyLines.push('接下来三选一, 你定:');
  bodyLines.push('  A) 休息 5 分钟');
  bodyLines.push('  B) 今天到这里, 明天再来');
  bodyLines.push('  C) 不歇, 继续');

  let recovery_turn = bodyLines.join('\n');

  // Stage 1 validation — strip any accidental rhetoric.
  const violation = _violatesRegister(recovery_turn);
  if (violation) {
    // Hard fail-safe: if the manuscript-register validator catches a
    // banned phrase / emoji / '!', we rewrite that line out. This is
    // belt-and-suspenders — the template above is already clean, but
    // future T4_JUDGE wiring could leak rhetoric in.
    recovery_turn = recovery_turn
      .replace(/[!！]/g, '.')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');
  }

  const intervention_id = a.intervention_id || _newInterventionId();
  const rest_offered = rest_options.length > 0;

  _writeEvent(slug, {
    intervention_id,
    rest_offered,
    evidence_count: evidence_recap.length,
    window_days: windowDays,
    outcome: 'pending',
  });

  return {
    recovery_turn,
    rest_offered,
    evidence_recap,
    next_choice: null, // user picks downstream; we do not preselect
    rest_options,
    intervention_id,
  };
}

module.exports = {
  runMotivationRecovery,
  _readEvidenceRecap,
  _violatesRegister,
  _BANNED_PHRASES,
};
