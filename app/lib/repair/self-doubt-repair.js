'use strict';
// HYPHA Wave 2.4 — Self-doubt Repair pipeline (theory ship).
//
// Triggered by W2.3 Goal Guardian when state === 'self_doubt' (user
// writes '我太笨', '我学不会', '别人都会', 'I'm too dumb', 'I'll never
// get this', OR scoreHistory low-streak + verbatim self-derogation in
// recentTurns).
//
// Hard constraint (BLUEPRINT §7.5 + §7.6): NO praise. NO 'great
// question!'. NO third-person ('用户...'). NO SaaS gamification (no
// streak badges, no level-up, no percentage bar). The repair is built
// from CONCRETE PROGRESS PLAYBACK + TOOLED DIAGNOSIS, not consolation.
//
// 4-stage flow:
//
//   Stage 1 — detect generalization vs specific.
//     'I'm too dumb' = generalization (more dangerous, easier to spiral)
//     'I don't get superposition' = specific (workable, name the KP)
//
//   Stage 2 — playback concrete progress. Read events.jsonl for the
//     user's own mistake → correction pairs in the last ~7 days.
//     Format: 'three lessons ago you missed X; you answered Y correctly
//     now; the mistake class is ZZZ, not intelligence.'
//
//   Stage 3 — tooled diagnosis. Call W1.4 Misconception engine to type
//     the mistake-class. If userTrace.lastWrongResponse is present, we
//     run detectMisconceptionInResponse against the KP's misconception
//     bank to surface a category (wrong_analogy / surface_understanding
//     / dangerous_simplification / pseudo_understanding). This converts
//     'I'm too dumb' into 'you held a wrong-analogy on X; that is a
//     specific repair target'.
//
//   Stage 4 — 3 actions: continue / misconception_check / micro_rest.
//
// Output schema:
//   {
//     repair_turn: string,                  // manuscript register
//     diagnostic: {
//       mistake_type: string,              // from W1.4
//       similar_users_pct: number|null,    // placeholder (no telemetry yet)
//       generalization: bool,              // Stage 1 output
//     },
//     action: 'continue'|'misconception_check'|'micro_rest',  // default
//     actions: [ { id, label } ],          // 3-choice for UI
//     intervention_id: string,
//   }

const path = require('path');
const fs = require('fs');

// Praise + third-person + SaaS-gamification phrases banned in output.
const _BANNED_PHRASES = Object.freeze([
  'great question', 'great job', 'awesome', 'amazing', 'perfect',
  '太棒了', '真厉害', '聪明', '天才',
  '用户', '该用户', 'the user', // third-person leakage
  'streak', 'level up', 'congratulations', '徽章', '等级',
]);

// Self-derogation cues. Generalization (more dangerous) vs specific.
const _GENERALIZATION_CUES = Object.freeze([
  '我太笨', '我太蠢', '我学不会', '我不行', '别人都会', '我没天分',
  'i\'m too dumb', 'i\'m stupid', 'i\'ll never', 'i can\'t learn',
  'everyone else gets it', 'no talent',
]);
const _SPECIFIC_CUES = Object.freeze([
  '我不懂', '我没搞懂', '没想明白',
  'i don\'t understand', 'i don\'t get', 'i\'m confused about',
]);

function _vaultRoot() {
  return process.env.HYPHA_VAULT_DIR || path.join(__dirname, '..', '..', '..', 'vault');
}

function _safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function _newInterventionId() {
  return `repair-self-doubt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Stage 1 — generalization vs specific.
function _classifyDoubt(doubtTrigger, recentTurns) {
  const haystack = [
    String(doubtTrigger || ''),
    ..._safeArray(recentTurns)
      .filter(t => t && t.role === 'user')
      .slice(-5)
      .map(t => String(t.text || '')),
  ].join(' ').toLowerCase();
  let genHits = 0;
  let specHits = 0;
  for (const c of _GENERALIZATION_CUES) if (haystack.includes(c)) genHits += 1;
  for (const c of _SPECIFIC_CUES) if (haystack.includes(c)) specHits += 1;
  if (genHits === 0 && specHits === 0) {
    return { generalization: false, confidence: 0.25, signal: 'none' };
  }
  return {
    generalization: genHits >= specHits,
    confidence: Math.min(0.85, 0.4 + (genHits + specHits) * 0.15),
    signal: genHits >= specHits ? 'generalization' : 'specific',
  };
}

// Stage 2 — concrete progress playback. Read events.jsonl for mistake
// → correction pairs in last `windowDays`.
function _readProgressPlayback(slug, windowDays) {
  if (!slug) return [];
  const filePath = path.join(_vaultRoot(), String(slug), 'events.jsonl');
  if (!fs.existsSync(filePath)) return [];
  let lines;
  try {
    lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  } catch (_) {
    return [];
  }
  const cutoff = Date.now() - (windowDays || 7) * 24 * 60 * 60 * 1000;
  const events = [];
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch (_) { continue; }
    const t = row && row.ts ? Date.parse(row.ts) : 0;
    if (!t || t < cutoff) continue;
    events.push(row);
  }
  // Build mistake → correction pairs. A pair = same kp_id, an earlier
  // FAIL/wrong row followed by a later PASS row.
  const byKp = new Map();
  for (const e of events) {
    const kp = e.kp_id || e.kpId;
    if (!kp) continue;
    if (!byKp.has(kp)) byKp.set(kp, []);
    byKp.get(kp).push(e);
  }
  const pairs = [];
  for (const [kp, evs] of byKp) {
    evs.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    let firstWrong = null;
    for (const e of evs) {
      const result = String(e.result || e.outcome || '').toUpperCase();
      const isWrong = result === 'FAIL' || result === 'WRONG' || e.type === 'misconception:triggered';
      const isCorrect = result === 'PASS' || e.type === 'mastery:kp_passed';
      if (isWrong && !firstWrong) firstWrong = e;
      if (isCorrect && firstWrong) {
        pairs.push({
          kp_id: kp,
          kp_label: firstWrong.kp_label || firstWrong.kpLabel || kp,
          wrong_ts: firstWrong.ts,
          correct_ts: e.ts,
          mistake_class: firstWrong.category || firstWrong.mistake_class || null,
        });
        firstWrong = null;
      }
    }
  }
  return pairs.slice(0, 5);
}

// Stage 3 — call W1.4 Misconception engine to type the mistake-class.
// Returns null when no signal; the orchestrator surfaces this as
// 'mistake_type: unknown' rather than fabricating a category.
function _diagnoseMistakeType(userTrace, lessonContext) {
  try {
    const mc = require('../misconception-engine');
    const lastWrong = userTrace && (userTrace.lastWrongResponse || userTrace.last_wrong_response);
    const bank = (lessonContext && Array.isArray(lessonContext.misconception_bank))
      ? lessonContext.misconception_bank
      : null;
    if (!lastWrong || !bank) return null;
    const res = mc.detectMisconceptionInResponse(lastWrong, bank);
    if (!res || !res.triggered) return null;
    return {
      category: res.triggered.category,
      severity: res.triggered.severity,
      confidence: res.confidence,
    };
  } catch (_err) {
    return null;
  }
}

// Validator (mirror of motivation-recovery's, with the praise-class
// banned set above).
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
      type: 'repair:self_doubt',
      ...payload,
    });
  } catch (_err) {
    try {
      const dir = path.join(_vaultRoot(), String(slug));
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const row = JSON.stringify({
        ts: new Date().toISOString(),
        type: 'repair:self_doubt',
        ...payload,
      }) + '\n';
      fs.appendFileSync(path.join(dir, 'events.jsonl'), row, 'utf8');
      return { ok: true, fallback: true };
    } catch (e2) {
      return { ok: false, reason: e2.message };
    }
  }
}

async function runSelfDoubtRepair(args) {
  const a = args || {};
  const slug = a.slug || null;
  const doubtTrigger = a.doubtTrigger || '';
  const recentTurns = _safeArray(a.recentTurns);
  const userTrace = a.userTrace || {};
  const lessonContext = a.lessonContext || {};
  const windowDays = Number.isFinite(a.windowDays) ? a.windowDays : 7;

  // Stage 1
  const classification = _classifyDoubt(doubtTrigger, recentTurns);

  // Stage 2
  const playback = _readProgressPlayback(slug, windowDays);

  // Stage 3
  const diagnosis = _diagnoseMistakeType(userTrace, lessonContext);
  const mistake_type = (diagnosis && diagnosis.category) || 'unknown';

  // Stage 4 — 3 actions. Default we suggest 'continue' when generalization
  // is low, 'misconception_check' when a concrete mistake_type was typed,
  // 'micro_rest' when both fail and the user seems generalizing.
  let action = 'continue';
  if (diagnosis && diagnosis.category) action = 'misconception_check';
  else if (classification.generalization && classification.confidence >= 0.55) action = 'micro_rest';

  const actions = [
    { id: 'continue', label: '继续这一节' },
    { id: 'misconception_check', label: '修一下刚才那处误解' },
    { id: 'micro_rest', label: '短暂休息' },
  ];

  // Repair turn body — concrete playback first, then diagnosis, then
  // action handoff. No praise. No third-person. No SaaS phrases.
  const bodyLines = [];
  if (playback.length > 0) {
    bodyLines.push('把刚才的话先放下, 看一下事实:');
    for (const p of playback.slice(0, 3)) {
      const kp = p.kp_label || p.kp_id;
      bodyLines.push(`  · 早先你在 ${kp} 上走错过一次, 后来又答对了 —— 这是位移, 不是状态描述.`);
    }
    bodyLines.push('');
  }
  if (mistake_type !== 'unknown') {
    bodyLines.push(`刚才的错处, 按类型看, 属于 "${String(mistake_type).replace(/_/g, ' ')}", 不是智力问题, 是一个具体的误解.`);
  } else {
    bodyLines.push('刚才的错处, 还没有被工具化诊断 —— 它是一个未命名的具体点, 不是 "笨".');
  }
  bodyLines.push('');
  bodyLines.push('下一步, 你定:');
  bodyLines.push('  A) 继续这一节');
  bodyLines.push('  B) 修一下刚才那处误解');
  bodyLines.push('  C) 短暂休息');

  let repair_turn = bodyLines.join('\n');

  // Validator — strip any accidental violation (defense in depth).
  const violation = _violatesRegister(repair_turn);
  if (violation) {
    repair_turn = repair_turn
      .replace(/[!！]/g, '.')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');
  }

  const intervention_id = a.intervention_id || _newInterventionId();

  _writeEvent(slug, {
    intervention_id,
    generalization: classification.generalization,
    mistake_type,
    playback_pairs: playback.length,
    action_suggested: action,
    outcome: 'pending',
  });

  return {
    repair_turn,
    diagnostic: {
      mistake_type,
      // intentional-placeholder: cross-user telemetry not wired in W2.4 —
      // we have no aggregate dataset yet; surfacing a fabricated percentage
      // would violate IRON_LAW (no fake evidence). W2.4-followup ships the
      // aggregate read once mastery-map cross-user sampling is online.
      similar_users_pct: null,
      generalization: classification.generalization,
    },
    action,
    actions,
    intervention_id,
    playback,
  };
}

module.exports = {
  runSelfDoubtRepair,
  _classifyDoubt,
  _readProgressPlayback,
  _violatesRegister,
  _BANNED_PHRASES,
};
