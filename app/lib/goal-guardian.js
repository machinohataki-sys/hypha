'use strict';

/**
 * HYPHA · W2.3 Goal Guardian — user-behavior drift watcher.
 *
 * Per BLUEPRINT §3.4 + specs/goal-guardian.md.
 *
 * SCOPE — pulls user back to goal direction WITHOUT changing the goal itself.
 * Guardian is a MODULATOR (tone / difficulty / pace), NOT a MUTATOR (no plan
 * rewrite, no KP reorder, no north_star changes).
 *
 * Boundary vs siblings:
 *   - W1.2 Drift Detector  = LESSON output drifted (content偏 goal)
 *   - W1.3 Anti-Illusion   = user faked comprehension ("你懂了吗")
 *   - W2.3 Goal Guardian   = user state drifted ("你状态 OK 吗")
 *   - W2.4 Repair pipelines = downstream executors Guardian dispatches to
 *
 * Public surface:
 *   assessGuardianState({ userTrace, goalContract, slug }) →
 *     { state, confidence, guardian_action, evidence }
 *   decideIntervention(state, currentLesson) →
 *     { intervention_type, prompt_modifier, difficulty_adjust, message }
 *
 * Both are pure functions. No network. No mutation. No vault writes (caller
 * decides whether to persist via events.jsonl — see main.js IPC handler).
 *
 * intentional-placeholder: T4_JUDGE二判 deferred to W2.3.1. cheap regex caps
 * confidence at 0.55; strong-path repair_self_doubt / revive_motivation still
 * fire intervention but the message/prompt_modifier text stays template.
 */

const { extractAffect, routeAffect, _looksOffTopic } = require('./affective-router');

// -----------------------------------------------------------------------------
// 6 guardian states
// -----------------------------------------------------------------------------

const STATES = Object.freeze([
  'on_track',
  'drifting',
  'frustrated',
  'self_doubt',
  'distracted',
  'high_energy',
]);

// -----------------------------------------------------------------------------
// assessGuardianState — composite over recent turns.
// -----------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {object} args.userTrace
 * @param {Array<{ role: 'user'|'assistant', text: string }>} args.userTrace.recentTurns
 *   — newest last. Guardian only looks at user-role turns; assistant turns
 *   provide context but are not affect-scanned.
 * @param {string} [args.userTrace.mood]
 *   — explicit override (e.g. user clicked a Mood Pill in UI). Skips regex.
 * @param {Array<number>} [args.userTrace.scoreTrajectory]
 *   — recent micro-proof scores (0-100). Sustained < 50 triggers frustrated
 *   even without explicit cue.
 * @param {object} [args.goalContract]
 *   — Goal Contract object; presence required for non-degenerate guardian.
 *     When absent, guardian degrades to AFFECT-ONLY (signals + no action).
 * @param {object} [args.currentLesson]
 *   — lesson body / KP for distraction overlap check.
 * @param {string} [args.slug]                  — diagnostic only
 * @returns {{
 *   state: 'on_track'|'drifting'|'frustrated'|'self_doubt'|'distracted'|'high_energy',
 *   confidence: number,
 *   guardian_action: string|null,
 *   evidence: Array<{ signal: string, snippet: string, turn_idx: number }>,
 *   affect: { sentiment: number, energy: number, signals: string[] }
 * }}
 */
function assessGuardianState(args = {}) {
  const userTrace = args.userTrace || {};
  const goalContract = args.goalContract || null;
  const currentLesson = args.currentLesson || null;
  const recentTurns = Array.isArray(userTrace.recentTurns) ? userTrace.recentTurns : [];

  // Pick the latest user turn for primary affect extraction. Look back up to
  // 3 user turns for distraction streak detection.
  const userTurns = recentTurns.filter(t => t && t.role === 'user');
  const latest = userTurns[userTurns.length - 1];
  const latestText = latest ? String(latest.text || '') : '';
  const latestAffect = extractAffect(latestText);

  // Compose evidence list (newest-first when shown to UI).
  const evidence = [];
  for (const e of (latestAffect.evidence || [])) {
    evidence.push({ signal: e.signal, snippet: e.snippet, turn_idx: userTurns.length - 1 });
  }

  // --- explicit mood override path -----------------------------------------
  if (userTrace.mood && typeof userTrace.mood === 'string') {
    const moodState = _moodToState(userTrace.mood);
    if (moodState) {
      const route = _stateToAction(moodState, latestAffect.sentiment);
      return {
        state: moodState,
        confidence: 0.8,    // user-explicit beats regex
        guardian_action: route,
        evidence: [{ signal: 'explicit_mood', snippet: userTrace.mood, turn_idx: userTurns.length - 1 }],
        affect: { sentiment: latestAffect.sentiment, energy: latestAffect.energy, signals: latestAffect.signals },
      };
    }
  }

  // --- distraction streak detection (requires currentLesson) ---------------
  // Look at last 2 user turns. If both off-topic vs lesson concepts → distracted.
  if (currentLesson && userTurns.length >= 2) {
    const a = _looksOffTopic(userTurns[userTurns.length - 1].text, currentLesson);
    const b = _looksOffTopic(userTurns[userTurns.length - 2].text, currentLesson);
    if (a && b) {
      return {
        state: 'distracted',
        confidence: 0.55,
        guardian_action: 'redirect_distraction',
        evidence: [
          ...evidence,
          { signal: 'distraction_marker', snippet: userTurns[userTurns.length - 1].text.slice(0, 40), turn_idx: userTurns.length - 1 },
          { signal: 'distraction_marker', snippet: userTurns[userTurns.length - 2].text.slice(0, 40), turn_idx: userTurns.length - 2 },
        ],
        affect: { sentiment: latestAffect.sentiment, energy: latestAffect.energy, signals: [...latestAffect.signals, 'distraction_marker'] },
      };
    }
    if (a) {
      // single off-topic — soft pullback, not distraction state
      return {
        state: 'drifting',
        confidence: 0.45,
        guardian_action: 'gentle_pullback',
        evidence: [...evidence, { signal: 'distraction_marker', snippet: userTurns[userTurns.length - 1].text.slice(0, 40), turn_idx: userTurns.length - 1 }],
        affect: { sentiment: latestAffect.sentiment, energy: latestAffect.energy, signals: [...latestAffect.signals, 'distraction_marker'] },
      };
    }
  }

  // --- score trajectory signal (sustained low → frustrated even sans cue) --
  const traj = Array.isArray(userTrace.scoreTrajectory) ? userTrace.scoreTrajectory : [];
  if (traj.length >= 3) {
    const recent3 = traj.slice(-3);
    const allLow = recent3.every(s => typeof s === 'number' && s < 50);
    if (allLow && !latestAffect.signals.includes('frustration_marker')) {
      return {
        state: 'frustrated',
        confidence: 0.5,
        guardian_action: 'lower_difficulty',
        evidence: [...evidence, { signal: 'score_trajectory', snippet: `last 3 scores: ${recent3.join(', ')}`, turn_idx: userTurns.length - 1 }],
        affect: { sentiment: latestAffect.sentiment, energy: latestAffect.energy, signals: latestAffect.signals },
      };
    }
  }

  // --- regex-driven state from affect signals ------------------------------
  const route = routeAffect(latestAffect, currentLesson);
  const state = _actionToState(route.guardian_action, latestAffect);

  // If no goal contract, downgrade: still report state but null action.
  const guardian_action = goalContract ? route.guardian_action : null;
  const confidence = state === 'on_track' ? (latestAffect.signals.length === 0 ? 0.7 : 0.5) : latestAffect.confidence;

  return {
    state,
    confidence,
    guardian_action,
    evidence,
    affect: { sentiment: latestAffect.sentiment, energy: latestAffect.energy, signals: latestAffect.signals },
  };
}

function _moodToState(mood) {
  const m = String(mood).toLowerCase().trim();
  if (/(frustrat|stuck|lost|沮丧|卡)/i.test(m)) return 'frustrated';
  if (/(doubt|不行|笨|怀疑)/i.test(m)) return 'self_doubt';
  if (/(spark|idea|excited|灵感|高能)/i.test(m)) return 'high_energy';
  if (/(distract|tired|累|分心)/i.test(m)) return 'distracted';
  if (/(ok|fine|on track|流畅)/i.test(m)) return 'on_track';
  return null;
}

function _stateToAction(state, sentiment) {
  switch (state) {
    case 'frustrated':  return sentiment <= -0.4 ? 'revive_motivation' : 'lower_difficulty';
    case 'self_doubt':  return 'repair_self_doubt';
    case 'high_energy': return 'capture_spark';
    case 'distracted':  return 'redirect_distraction';
    case 'drifting':    return 'gentle_pullback';
    case 'on_track':
    default:            return null;
  }
}

function _actionToState(action, affect) {
  if (!action) return 'on_track';
  if (action === 'capture_spark') return 'high_energy';
  if (action === 'repair_self_doubt') return 'self_doubt';
  if (action === 'lower_difficulty' || action === 'revive_motivation') return 'frustrated';
  if (action === 'redirect_distraction') return 'distracted';
  if (action === 'gentle_pullback') return 'drifting';
  return 'on_track';
}

// -----------------------------------------------------------------------------
// decideIntervention — produces the modulator payload for the next tutor turn.
// -----------------------------------------------------------------------------

/**
 * Intervention messages are TEMPLATES, written in manuscript register (no
 * cheerleading, no emoji, no exclamation). They get rendered as italic
 * Garamond inline in the tutor reply — they do NOT replace the tutor's
 * answer, only prepend or annotate it.
 *
 * @param {string} state — one of STATES
 * @param {object} [currentLesson] — for thesis/title reference in message
 * @returns {{
 *   intervention_type: string|null,
 *   prompt_modifier: string,
 *   difficulty_adjust: -1 | 0 | 1,
 *   message: string,
 *   downstream_repair: string|null   // W2.4 pipeline name, null if W2.4 absent
 * }}
 */
function decideIntervention(state, currentLesson) {
  const thesis = (currentLesson && (currentLesson.thesis || currentLesson.title)) || '本节';
  switch (state) {
    case 'frustrated':
      return {
        intervention_type: 'lower_difficulty',
        prompt_modifier:
          '用户当前 frustration。下一段用更温和的口吻, 减少术语, 给一个生活化具体类比。' +
          '先 acknowledge 难度 (一句, 不夸张), 再退回最近一个 KP 重新解释, 不要继续推进新概念。',
        difficulty_adjust: -1,
        message: `这里我们慢一点 — ${thesis} 这一步有点吃力, 我换个角度再讲一遍。`,
        downstream_repair: 'ConfusionRepair',  // W2.4 placeholder
      };

    case 'self_doubt':
      return {
        intervention_type: 'repair_self_doubt',
        prompt_modifier:
          '用户在自我怀疑。下一段先 mirror 用户答对的部分 (具体引用, 不空夸), ' +
          '再温和指出还差的一小步。不要 cheerleading, 不要 "great question"。manuscript register。',
        difficulty_adjust: 0,
        message: '你刚才说对了一半 — 我把那一半先稳住, 再走下一步。',
        downstream_repair: 'SelfDoubtRepair',
      };

    case 'high_energy':
      return {
        intervention_type: 'capture_spark',
        prompt_modifier:
          '用户高能 / 主动联想。下一段保留正轨, 但在末尾留一个 Capture 入口 ' +
          '("如果想把这个想法记下来 — [📓 capture]"), 不打断当前 KP 推进。',
        difficulty_adjust: 0,
        message: '这个想法值得记一下 — 我先把当前一段讲完, 你随时打开 Capture。',
        downstream_repair: null,  // Capture is W1.5, not W2.4 Repair
      };

    case 'distracted':
      return {
        intervention_type: 'redirect_distraction',
        prompt_modifier:
          '用户走神 / 跨主题问。下一段先用 1 句温和回到主线 ' +
          '("记下了, 我们先把这节做完"), 再继续当前 KP。不要训斥, 不要忽视。',
        difficulty_adjust: 0,
        message: '我先把这个问题记下来 — 我们把 ' + thesis + ' 这一段先做完, 等下回头聊。',
        downstream_repair: null,
      };

    case 'drifting':
      return {
        intervention_type: 'gentle_pullback',
        prompt_modifier:
          '用户提到了相关但偏题。下一段先简短回应他的旁支问题 (1 句), ' +
          '再回到主线 ("我们刚才在讲 X")。',
        difficulty_adjust: 0,
        message: `我们刚才在讲 ${thesis} — 这个旁支记下来, 等下回头看。`,
        downstream_repair: null,
      };

    case 'on_track':
    default:
      return {
        intervention_type: null,
        prompt_modifier: '',
        difficulty_adjust: 0,
        message: '',
        downstream_repair: null,
      };
  }
}

module.exports = {
  assessGuardianState,
  decideIntervention,
  STATES,
};
