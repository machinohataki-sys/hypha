'use strict';
// HYPHA · Socratic onboarding intake (2026-05-17)
//
// Replaces the 8-field onboarding pre-filling with 3 conversational turns fired
// right before lesson 0. Returns a patch object — caller decides where to write.
//
// Why 3 turns, not 1: SCOUT 2026 evidence (8→4 field cut → +50-120% completion).
// Single batch of 3 Q feels like a form; sequential round-trips read as a
// kind, low-friction setup conversation. Pedagogy.md Layer 0 S0 stays intact —
// user_intent is already collected in the form, so this just fills the 3
// fields we cut: current_level / teacher_persona / forbidden_drifts.
//
// Backend LLM call: T4_JUDGE (cheap, fast), JSON output for chip choices.
// We pre-define the 4/3/4 chip choices so the user gets buttons not free text,
// matching Scene B demo. We don't actually need the LLM for the chip pick —
// returnObject is deterministic from user choice. We do call T4_JUDGE for the
// opening line per question (light persona-aware framing of the chip prompt)
// when an opener is requested; default just returns canned phrasing.
//
// Architecture:
//   runSocraticIntake({ slug, goalContract, settings })
//     → returns 3-question definition + applyAnswer/finalize helpers
//
// We don't drive the conversation here. main.js drives the IPC turn loop and
// calls applyAnswer(...) after each user reply. finalize() returns the patch
// object to merge into state.json + agent.json.

const PERSONA_LABEL_TO_ID = {
  'Karpathy 试试': 'karpathy',
  'Feynman 先':    'feynman',
  '你看着派':       'auto',  // sentinel — caller falls through to derivePersona
};

const LEVEL_TO_ID = {
  '没碰过':             'novice',
  '用过 ChatGPT / Cursor': 'tool-user',
  '读过几篇论文':         'paper-reader',
  '已做过小项目':         'project-shipped',
};

const DRIFT_LABEL_TO_TAG = {
  '空泛聊天':   '空泛聊天',
  '只读不写':   '只读不写',
  '营销话术':   '营销话术',
  '没有':       null, // sentinel — empty drift list (Drift Detector disabled)
};

// Question schema — caller picks them up in order and renders chip UI.
// `id` matches the goalContract field the answer maps into; `chips` is the
// 4/3/4 surface (Scene B demo verbatim).
function buildQuestions({ goalContract } = {}) {
  const northStar = (goalContract && goalContract.north_star_goal) || '你的目标';
  return [
    {
      id: 'current_level',
      idx: 0,
      // Friendly framing — anchor in the user's stated north star so it doesn't
      // read like a placement test.
      prompt: `在动手之前,我先把你现在的状态摸一下。你说"${northStar}",你现在到哪儿了?`,
      chips: ['没碰过', '用过 ChatGPT / Cursor', '读过几篇论文', '已做过小项目'],
      mapTo: 'current_level',
    },
    {
      id: 'teacher_persona',
      idx: 1,
      prompt: '明白。你介意我用 Karpathy 的风格来 — 从零手搓,会有点公式有点代码?不喜欢的话我可以换 Feynman 剥术语,或者你看着派。',
      chips: ['Karpathy 试试', 'Feynman 先', '你看着派'],
      mapTo: 'teacher_persona',
    },
    {
      id: 'forbidden_drifts',
      idx: 2,
      prompt: '最后:有什么不希望我带你跑去的方向吗?例如"少黑话"或"不喜欢只读不写"。',
      chips: ['空泛聊天', '只读不写', '营销话术', '没有'],
      mapTo: 'forbidden_drifts',
    },
  ];
}

// Pure mapper — chip label → goalContract patch field value.
function mapAnswer(questionId, chipLabel) {
  if (questionId === 'current_level') {
    return { current_level: LEVEL_TO_ID[chipLabel] || chipLabel };
  }
  if (questionId === 'teacher_persona') {
    const persona = PERSONA_LABEL_TO_ID[chipLabel];
    // 'auto' is the sentinel meaning "fall back to derivePersona". Tracked
    // separately so caller can decide whether to write agent.json or skip.
    return {
      teacher_persona: persona === 'auto' ? null : persona,
      teacher_persona_explicit: persona !== 'auto',
    };
  }
  if (questionId === 'forbidden_drifts') {
    const tag = DRIFT_LABEL_TO_TAG[chipLabel];
    if (tag === null) {
      // "没有" → empty list, Drift Detector disabled.
      return { forbidden_drifts: [] };
    }
    return { forbidden_drifts: [tag] };
  }
  return {};
}

/**
 * Optional T4_JUDGE call to soften the opener phrasing per user's north star.
 * Currently a stub returning the canned prompt verbatim — the wrapper exists
 * so future passes can inject a tiny persona-aware rephrase (north_star_goal
 * + user_intent in scope) without changing the public surface.
 *
 * @param {object} args
 * @param {string} args.slug
 * @param {object} args.goalContract
 * @param {object} args.settings
 * @param {object} args.question — question object from buildQuestions
 * @returns {Promise<string>} prompt text (canned today; LLM-rephrased tomorrow)
 */
async function craftOpener({ slug, goalContract, settings, question }) {
  // Today: return canned. Tomorrow (deferred): wrap T4_JUDGE call with a 200-
  // token budget for a single-sentence rephrase. Keep deterministic for now so
  // the loop is testable without LLM keys.
  if (!question || !question.prompt) return '';
  return question.prompt;
}

/**
 * Driver that returns the question plan + helpers. Caller (main.js IPC) walks
 * the questions array, ships each prompt + chips to renderer, collects the
 * user's chip pick, then calls applyAnswer + finalize.
 *
 * Returns:
 *   { questions, applyAnswer(idx, chipLabel), finalize() → patch }
 *
 * Patch shape:
 *   {
 *     goalContractPatch: { current_level, teacher_persona,
 *                          teacher_persona_explicit, forbidden_drifts },
 *     personaId: 'karpathy' | 'feynman' | null
 *   }
 *
 * If personaId is null, caller should NOT overwrite agent.json — main.js's
 * existing derivePersona fallback will fire (curriculum:create path) or has
 * already fired (Socratic runs after, agent.json already seeded).
 */
async function runSocraticIntake({ slug, goalContract = {}, settings = {} } = {}) {
  const questions = buildQuestions({ goalContract });
  const answers = {}; // { current_level: 'novice', ... }
  const goalContractPatch = {};

  // Pre-craft opener text for each question. Today returns canned; future pass
  // can swap in a T4_JUDGE rephrase that anchors in north_star_goal.
  for (const q of questions) {
    try {
      q.opener = await craftOpener({ slug, goalContract, settings, question: q });
    } catch (_) {
      q.opener = q.prompt;
    }
  }

  return {
    questions,

    /**
     * Apply one user answer. idx is 0..2; chipLabel is one of question.chips.
     * Returns the merged patch so far (for incremental persistence if the
     * caller wants to write after every turn rather than at finalize).
     */
    applyAnswer(idx, chipLabel) {
      const q = questions[idx];
      if (!q) return goalContractPatch;
      const fragment = mapAnswer(q.id, chipLabel);
      answers[q.id] = chipLabel;
      Object.assign(goalContractPatch, fragment);
      return goalContractPatch;
    },

    /**
     * Finalize. Returns a patch object the caller merges into state.json's
     * goalContract + (if personaId is set) agent.json's persona slot.
     *
     * @returns {{ goalContractPatch: object, personaId: string|null, answers: object }}
     */
    finalize() {
      const personaId = goalContractPatch.teacher_persona_explicit
        ? goalContractPatch.teacher_persona
        : null;
      return {
        goalContractPatch: { ...goalContractPatch },
        personaId,
        answers: { ...answers },
      };
    },
  };
}

module.exports = {
  runSocraticIntake,
  buildQuestions,
  mapAnswer,
};
