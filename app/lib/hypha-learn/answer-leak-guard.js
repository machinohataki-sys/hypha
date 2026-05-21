'use strict';

// answer-leak-guard.js — binary post-generation classifier.
//
// Asks Haiku 4.5 a single yes/no fact-check after each tutor reply: "did the
// tutor give away the final answer the student should derive themselves?"
// If LEAK, caller regenerates with a sharper-probe hint (cap 2 attempts in
// caller). If OK, accept.
//
// Why binary structural fact-check (not aesthetic rubric):
// Muse's Goodhart attack killed YOGO's aesthetic-rubric judge gate because
// graders could rationalize any output to pass. Here the question is
// structurally checkable — "is the answer literally present?" — yielding
// high κ inter-rater agreement and a tight surface to game.
//
// Fail-safe: any error (rate limit, network, timeout) returns leaked=false.
// We never block a lesson on guard infra failure.

const { runOnce } = require('../anthropic-adapter');

// States that legitimately resolve the loop — a final reveal here is the
// correct pedagogical move, not a leak. Skip the API call entirely.
const RESOLVING_STATES = new Set(['LATCH', 'CONNECT', 'END']);

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 5000;

const SYSTEM_PROMPT =
  'You are an answer-leak detector. Output exactly LEAK or OK, nothing else.';

function _buildUserPrompt({ lessonGoal, state, response }) {
  return (
    `LESSON GOAL: ${lessonGoal}\n` +
    `STATE: ${state}\n` +
    `TUTOR REPLY:\n${response}\n\n` +
    'Did the tutor give away the final answer the student should derive ' +
    'themselves? Output LEAK or OK.'
  );
}

function buildRegenHint(state) {
  return (
    `[ANSWER-LEAK detected at state ${state} — DO NOT reveal the answer; ` +
    'ask a sharper sub-question that probes a smaller piece the student ' +
    'can derive on their own.]'
  );
}

async function checkAnswerLeak(opts) {
  const { state, response, lessonGoal, settings } = opts || {};

  // Cheap structural skip — resolving states may legitimately reveal.
  if (RESOLVING_STATES.has(state)) {
    return { leaked: false, hint: null };
  }

  // Guard against missing inputs — fail-safe.
  if (!response || !settings || !settings.apiKey) {
    return { leaked: false, hint: null };
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: _buildUserPrompt({
        lessonGoal: lessonGoal || '(unspecified)',
        state: state || '(unspecified)',
        response,
      }),
    },
  ];

  // Pin model to Haiku 4.5 regardless of caller's settings.model (they may be
  // running Opus 4.7 for tutor turns; guard is intentionally cheap).
  const guardSettings = {
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    model: HAIKU_MODEL,
  };

  try {
    const text = await runOnce(messages, guardSettings, {
      max_tokens: 10,
      temperature: 0,
      thinking: false,
      timeoutMs: TIMEOUT_MS,
    });
    if (/LEAK/i.test(text || '')) {
      return { leaked: true, hint: buildRegenHint(state) };
    }
    return { leaked: false, hint: null };
  } catch (_err) {
    // Fail-safe: never block a lesson on guard infra failure.
    return { leaked: false, hint: null };
  }
}

module.exports = { checkAnswerLeak, buildRegenHint };
