'use strict';
// HYPHA Wave 2.4 — Confusion Repair pipeline (theory ship).
//
// Triggered by W2.3 Goal Guardian when state === 'confused' (user is stuck
// on a concept, asks the same question 2-3 times across recent turns, OR
// answers a Feynman test with a different KP than the one being taught).
// The repair fires as a downstream stream from Goal Guardian's
// decideIntervention(); we do not own the assessment — only the repair.
//
// 4-stage flow:
//
//   Stage 1 — identify stuck KP. Count how many times each KP id appears
//             in recentTurns (user side). The most-mentioned KP that is
//             ALSO listed in lessonContext.kp_ids[] is the stuck point.
//             Falls back to lessonContext.current_kp_id when no signal.
//
//   Stage 2 — simpler analogy. T4_JUDGE-grade rephrase. Mocked to
//             '[mock] simpler analogy: ...' today; W2.4-followup wires
//             the real LLM call (router.executeChat('T4_JUDGE', ...)).
//
//   Stage 3 — concrete example. Reads lessonContext.canonical_example
//             first, then falls back to library retrieval (also a
//             mock-shaped seam). The example is anchored to the stuck KP
//             so the user can map analogy + concrete onto the same thing.
//
//   Stage 4 — 3-choice exit. A (got it → exit), B (still stuck → drop
//             difficulty further), C (need prerequisite → patch
//             upstream). difficulty_adjust starts at -1; user choice B
//             escalates to -2.
//
// Output is fed to repairResultToTutorPrompt() (see ./index.js) which
// produces the manuscript-register text the lesson chat will render
// next. The output MUST NOT contain '!', emoji, '加油', 'great', '你可以
// 的', or SaaS gamification (BLUEPRINT manuscript register, §7.2).

const path = require('path');
const fs = require('fs');

const STAGE_DEFAULT_ADJUST = -1;
const STAGE_ESCALATED_ADJUST = -2;

function _vaultRoot() {
  return process.env.HYPHA_VAULT_DIR || path.join(__dirname, '..', '..', '..', 'vault');
}

function _safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function _newInterventionId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `repair-confusion-${ts}-${rand}`;
}

// Stage 1 — stuck-point identification.
// Counts each KP id's appearance in user turns. Ties broken by recency
// (later turn wins). Falls through to lessonContext.current_kp_id when
// no KP id surfaces in the trace.
function _identifyStuckKP(stuckKP, recentTurns, lessonContext) {
  if (stuckKP && typeof stuckKP === 'string') return stuckKP;
  const turns = _safeArray(recentTurns);
  const kpIds = _safeArray(lessonContext && lessonContext.kp_ids);
  if (turns.length === 0 || kpIds.length === 0) {
    return (lessonContext && lessonContext.current_kp_id) || null;
  }
  const counts = new Map();
  const lastIndex = new Map();
  turns.forEach((t, i) => {
    if (!t || t.role !== 'user') return;
    const text = String(t.text || '').toLowerCase();
    for (const kp of kpIds) {
      if (!kp) continue;
      if (text.includes(String(kp).toLowerCase())) {
        counts.set(kp, (counts.get(kp) || 0) + 1);
        lastIndex.set(kp, i);
      }
    }
  });
  if (counts.size === 0) return (lessonContext && lessonContext.current_kp_id) || null;
  // Pick highest count, ties → most recent.
  let best = null;
  let bestCount = -1;
  let bestRecency = -1;
  for (const [kp, c] of counts) {
    const r = lastIndex.get(kp) || 0;
    if (c > bestCount || (c === bestCount && r > bestRecency)) {
      best = kp;
      bestCount = c;
      bestRecency = r;
    }
  }
  return best;
}

// Stage 2 — simpler analogy. Mocked LLM seam.
// intentional-placeholder: T4_JUDGE call deferred to W2.4-followup
// (router.executeChat('T4_JUDGE', { ... })). Today we return a
// deterministic mock that names the stuck KP so the renderer can
// confirm wiring without spending model budget.
async function _generateSimplerAnalogy(stuckKpId, lessonContext) {
  const thesis = (lessonContext && lessonContext.thesis) || '';
  const kpLabel = stuckKpId || 'this concept';
  // Mock — replaced by T4_JUDGE in followup. Phrasing must stay
  // manuscript register (no '!', no '你可以的', no SaaS).
  return {
    analogy_text: `[mock] 换一个更简的角度看 ${kpLabel}: 把它当作一个最小可工作的版本, 先抓住骨架再回到原文.${thesis ? ' (原文要点已留存)' : ''}`,
    source: 'mock-t4-judge',
  };
}

// Stage 3 — concrete example. Prefers lessonContext.canonical_example
// (already part of the v0.2 lesson body schema); falls back to a
// library-retrieval mock when absent.
function _pickConcreteExample(lessonContext, stuckKpId) {
  const ce = lessonContext && lessonContext.canonical_example;
  if (ce && String(ce).trim().length >= 12) {
    return { example_text: String(ce).slice(0, 300), source: 'canonical_example' };
  }
  // Library retrieval mock — W2.4-followup wires app/lib/library.js
  // query against the topic slug + KP id.
  return {
    example_text: `[mock] library 检索范例 (${stuckKpId || 'kp-unknown'}): 取一段最小可见的事例, 复述它的因果链.`,
    source: 'library-mock',
  };
}

// Append a structured event row for telemetry / cadence / Goal Guardian
// follow-up. No silent-catch: any write error surfaces back to the
// caller so the lesson chat can log it.
function _writeEvent(slug, payload) {
  if (!slug) return { ok: false, reason: 'no-slug' };
  try {
    const events = require('../events');
    return events.write(String(slug), {
      type: 'repair:confusion',
      ...payload,
    });
  } catch (err) {
    // Fallback raw write — events.js may not be initialized in tests.
    try {
      const dir = path.join(_vaultRoot(), String(slug));
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const row = JSON.stringify({
        ts: new Date().toISOString(),
        type: 'repair:confusion',
        ...payload,
      }) + '\n';
      fs.appendFileSync(path.join(dir, 'events.jsonl'), row, 'utf8');
      return { ok: true, fallback: true };
    } catch (e2) {
      return { ok: false, reason: e2.message };
    }
  }
}

// Public entry — runConfusionRepair.
// Returns:
//   {
//     repair_turn: string,                    // manuscript-register text
//     expected_action: 'choose'|'restate'|'try_example',
//     difficulty_adjust: -1 | -2,             // -2 only after Stage 4 'B'
//     intervention_id: string,                // for telemetry pairing
//     stuck_kp_id: string|null,               // Stage 1 output
//     analogy: { analogy_text, source },      // Stage 2
//     example: { example_text, source },      // Stage 3
//     choices: [ { id:'A'|'B'|'C', label, outcome } ], // Stage 4
//   }
async function runConfusionRepair(args) {
  const a = args || {};
  const stuckKP = a.stuckKP || null;
  const recentTurns = _safeArray(a.recentTurns);
  const userResponses = _safeArray(a.userResponses);
  const lessonContext = a.lessonContext || {};
  const slug = a.slug || (lessonContext && lessonContext.slug) || null;
  const escalated = a.escalated === true; // Stage 4-B re-entry

  // Stage 1
  const stuck_kp_id = _identifyStuckKP(stuckKP, recentTurns, lessonContext);

  // Stage 2 — simpler analogy
  const analogy = await _generateSimplerAnalogy(stuck_kp_id, lessonContext);

  // Stage 3 — concrete example
  const example = _pickConcreteExample(lessonContext, stuck_kp_id);

  // Stage 4 — 3-choice exit
  const choices = [
    { id: 'A', label: '我懂了, 继续', outcome: 'exit_repair' },
    { id: 'B', label: '还是不懂, 再换一种说法', outcome: 'escalate_difficulty' },
    { id: 'C', label: '我需要先复习更前置的概念', outcome: 'prerequisite_patch' },
  ];

  const difficulty_adjust = escalated ? STAGE_ESCALATED_ADJUST : STAGE_DEFAULT_ADJUST;
  const intervention_id = a.intervention_id || _newInterventionId();

  // Manuscript register turn body. No '!', no '加油', no '你可以的'.
  const bodyLines = [
    `卡点先标出来 —— 这一段最反复出现的, 是 ${stuck_kp_id || '当前概念'}.`,
    '',
    `换一种更轻的说法:`,
    analogy.analogy_text,
    '',
    `再看一个具体的例子:`,
    example.example_text,
    '',
    '看到这里, 你怎么选:',
    '  A) 我懂了, 继续',
    '  B) 还是不懂, 再换一种说法',
    '  C) 我需要先复习更前置的概念',
  ];
  const repair_turn = bodyLines.join('\n');

  // Event row — outcome=pending until UI surfaces user's choice.
  _writeEvent(slug, {
    intervention_id,
    stuck_kp_id,
    difficulty_adjust,
    escalated,
    outcome: 'pending',
    analogy_source: analogy.source,
    example_source: example.source,
  });

  return {
    repair_turn,
    expected_action: 'choose',
    difficulty_adjust,
    intervention_id,
    stuck_kp_id,
    analogy,
    example,
    choices,
  };
}

module.exports = {
  runConfusionRepair,
  // Surface for tests + index orchestrator.
  _identifyStuckKP,
  _pickConcreteExample,
  _writeEvent,
};
