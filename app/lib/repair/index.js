'use strict';
// HYPHA Wave 2.4 — Repair pipelines orchestrator.
//
// Single entry surface used by main.js IPC + W2.3 Goal Guardian's
// decideIntervention() handoff. Two exports:
//
//   runRepair(type, args)         → dispatch to one of the 3 pipelines
//   repairResultToTutorPrompt(r)  → render the result as a prompt
//                                   modifier the lesson chat injects
//                                   on the next streamTurn() call
//
// Pipelines (touchstone: BLUEPRINT §3.4 Goal Guardian):
//   'confusion'    — user stuck on a concept (same Q ≥ 2x)
//   'motivation'   — user low / fatigued / wanting to quit
//   'self_doubt'   — user self-derogating ("I'm too dumb")

const _CONFUSION = require('./confusion-repair');
const _MOTIVATION = require('./motivation-recovery');
const _SELF_DOUBT = require('./self-doubt-repair');

const REPAIR_TYPES = Object.freeze(['confusion', 'motivation', 'self_doubt']);

// Dispatch — one of three pipelines. Throws on unknown type so callers
// surface the misuse instead of silent-catching it.
async function runRepair(type, args) {
  const t = String(type || '').trim().toLowerCase();
  switch (t) {
    case 'confusion':
      return _CONFUSION.runConfusionRepair(args || {});
    case 'motivation':
      return _MOTIVATION.runMotivationRecovery(args || {});
    case 'self_doubt':
    case 'self-doubt':
    case 'selfdoubt':
      return _SELF_DOUBT.runSelfDoubtRepair(args || {});
    default:
      throw new Error(`runRepair: unknown type "${type}". Expected one of: ${REPAIR_TYPES.join(', ')}`);
  }
}

// Render the pipeline output as a tutor-prompt modifier the lesson
// chat's next streamTurn() prepends to its system context. Keeps the
// UI free of prompt-engineering logic — call this once when the user
// confirms a repair-choice, hand the result to the tutor.
function repairResultToTutorPrompt(result) {
  if (!result || typeof result !== 'object') return '';
  // Discriminator: confusion has `stuck_kp_id`; motivation has
  // `evidence_recap`; self_doubt has `diagnostic`. Each path renders
  // a manuscript-register prompt block the tutor reads as context.
  const lines = ['REPAIR CONTEXT (W2.4 — read silently, do not echo verbatim):'];
  if (result.stuck_kp_id !== undefined) {
    lines.push(`Repair type: confusion. Stuck KP: ${result.stuck_kp_id || 'unknown'}.`);
    lines.push(`Difficulty adjust: ${result.difficulty_adjust}.`);
    if (result.analogy && result.analogy.analogy_text) {
      lines.push(`Simpler-frame seed: ${result.analogy.analogy_text}`);
    }
    if (result.example && result.example.example_text) {
      lines.push(`Concrete-example seed: ${result.example.example_text}`);
    }
    lines.push('Next turn: lead with the simpler frame, anchor on the example, then ask the user which of (A) understood (B) still stuck (C) prerequisite they pick.');
  } else if (result.evidence_recap !== undefined) {
    lines.push('Repair type: motivation. The user is fatigued; do NOT push.');
    lines.push('Evidence to surface (concrete, not rhetorical):');
    for (const e of (result.evidence_recap || []).slice(0, 6)) {
      lines.push(`  · ${e}`);
    }
    lines.push('Next turn: replay the evidence quietly, offer the 3-rest choice (5min / today / continue) and let the user pick. Banned: "加油", "你可以的", emoji, "!".');
  } else if (result.diagnostic !== undefined) {
    lines.push('Repair type: self_doubt. The user is self-derogating; do NOT praise.');
    lines.push(`Generalization: ${result.diagnostic.generalization ? 'yes' : 'no'}. Mistake type: ${result.diagnostic.mistake_type || 'unknown'}.`);
    if (Array.isArray(result.playback) && result.playback.length > 0) {
      lines.push('Concrete progress pairs to replay:');
      for (const p of result.playback.slice(0, 3)) {
        lines.push(`  · ${p.kp_label || p.kp_id}: earlier wrong → later correct.`);
      }
    }
    lines.push('Next turn: replay progress, name the mistake-class, hand off the 3-action choice. Banned: "great question", praise words, third-person "用户", SaaS gamification.');
  } else {
    return '';
  }
  return lines.join('\n');
}

module.exports = {
  runRepair,
  repairResultToTutorPrompt,
  REPAIR_TYPES,
  // Surface sub-modules for direct test access / Goal Guardian inline use.
  confusion: _CONFUSION,
  motivation: _MOTIVATION,
  selfDoubt: _SELF_DOUBT,
};
