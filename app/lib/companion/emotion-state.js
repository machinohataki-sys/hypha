'use strict';

// Companion emotion-state classifier — orthogonal to W3.5 trigger-event schema.
// Detects rolling emotional state from session signals.
//
// 5 states (independent of W3.5 6-trigger enum):
//   - idle: default, no signal
//   - curious: user introduced new concept (mention without definition)
//   - encouraging: user expressed stuck / frustrated
//   - mirror: user stated hypothesis (= reflect back)
//   - boundary-protect: detected over-reliance (>=5 same-type questions, or delegate request)
//
// Used alongside W3.5 trigger schema:
//   W3.5 = "at lesson_complete, say X"
//   This = "currently the user feels stuck, register tone-shift to encouraging"
//
// Per ban_ai_cliche_zh: no AI fluff words.
// Silent fail on null/undefined inputs — return IDLE.

const STATES = Object.freeze({
  IDLE: 'idle',
  CURIOUS: 'curious',
  ENCOURAGING: 'encouraging',
  MIRROR: 'mirror',
  BOUNDARY_PROTECT: 'boundary-protect',
});

const REPEATED_QUESTION_THRESHOLD = 5;
const STUCK_PATTERNS = /(卡住|不懂|搞不明白|不会|stuck|don't get|confused|lost)/i;
const HYPOTHESIS_PATTERNS = /(我认为|我觉得|我理解|我猜|i think|i believe|my hypothesis|my guess|i suspect)/i;
const NEW_CONCEPT_PATTERNS = /(听说过|遇到过|看到一个新|first time|新概念|never heard|encountered)/i;
const DELEGATE_PATTERNS = /(帮我做|帮我写|帮我生成|做给我|生成给我|do for me|do this for me|write this for me)/i;

function classifyQuestionType(text) {
  if (!text || typeof text !== 'string') return 'other';
  if (/(是什么|什么是|定义|什么意思|what is|definition)/i.test(text)) return 'definition';
  if (/(为什么|why)/i.test(text)) return 'why';
  if (/(怎么|how do|how to)/i.test(text)) return 'how';
  if (/(例子|example)/i.test(text)) return 'example';
  if (DELEGATE_PATTERNS.test(text)) return 'delegate';
  return 'other';
}

function detectEmotionState(input) {
  // Silent fail on null/undefined — default to IDLE.
  if (!input || typeof input !== 'object') {
    return { state: STATES.IDLE, signal: null, confidence: 0.5 };
  }

  const { currentText, recentQuestions, sessionTurnCount } = input;
  // sessionTurnCount reserved for future cadence-based escalation; unused in v0.1.
  void sessionTurnCount;

  // Highest priority: boundary-protect via explicit delegate request.
  if (currentText && typeof currentText === 'string' && DELEGATE_PATTERNS.test(currentText)) {
    return { state: STATES.BOUNDARY_PROTECT, signal: 'DELEGATE_REQUEST', confidence: 0.9 };
  }

  // Next priority: boundary-protect via repeated same-type questioning.
  if (Array.isArray(recentQuestions) && recentQuestions.length >= REPEATED_QUESTION_THRESHOLD) {
    const window = recentQuestions.slice(-REPEATED_QUESTION_THRESHOLD * 2);
    const types = new Map();
    for (const q of window) {
      const t = classifyQuestionType(q);
      types.set(t, (types.get(t) || 0) + 1);
    }
    for (const [t, n] of types) {
      if (n >= REPEATED_QUESTION_THRESHOLD && t !== 'other') {
        return {
          state: STATES.BOUNDARY_PROTECT,
          signal: 'REPEATED_QUESTION_TYPE',
          signal_type: t,
          confidence: 0.75,
        };
      }
    }
  }

  // Mirror: user stated a hypothesis worth reflecting back.
  if (currentText && typeof currentText === 'string' && HYPOTHESIS_PATTERNS.test(currentText)) {
    return { state: STATES.MIRROR, signal: 'HYPOTHESIS_STATEMENT', confidence: 0.7 };
  }

  // Encouraging: user signaled stuck / frustrated.
  if (currentText && typeof currentText === 'string' && STUCK_PATTERNS.test(currentText)) {
    return { state: STATES.ENCOURAGING, signal: 'STUCK_SIGNAL', confidence: 0.8 };
  }

  // Curious: user mentioned a new concept without defining it.
  if (currentText && typeof currentText === 'string' && NEW_CONCEPT_PATTERNS.test(currentText)) {
    return { state: STATES.CURIOUS, signal: 'NEW_CONCEPT', confidence: 0.6 };
  }

  // Fallback.
  return { state: STATES.IDLE, signal: null, confidence: 0.5 };
}

function getEmotionVocabulary(state) {
  // Distinct from W3.5 keyword-mapping.js. This is rolling-state tone register.
  const map = {
    [STATES.IDLE]: { tone_hint: '(留白)', signal_color: 'neutral' },
    [STATES.CURIOUS]: { tone_hint: '哦, 这个我没见过.', signal_color: 'amber' },
    [STATES.ENCOURAGING]: { tone_hint: '卡住是正常的, 退一步试试.', signal_color: 'brass' },
    [STATES.MIRROR]: { tone_hint: '你刚说的是 [user_text]. 接近吗?', signal_color: 'terracotta-1' },
    [STATES.BOUNDARY_PROTECT]: { tone_hint: '继续问会变依赖. 找人讲一次回来.', signal_color: 'terracotta-2' },
  };
  return map[state] || map[STATES.IDLE];
}

module.exports = {
  STATES,
  detectEmotionState,
  classifyQuestionType,
  getEmotionVocabulary,
  REPEATED_QUESTION_THRESHOLD,
};
