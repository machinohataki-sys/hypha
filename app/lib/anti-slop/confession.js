'use strict';
// HYPHA · Confession Layer (AMD-MEOW-P7 M2)
//
// After lesson skeleton/body generation, the Generator agent self-reports its
// weakest links — what it likely cut corners on, what it didn't verify,
// what is guess. This is graded against the agent's Character Contract
// `failure_protocol` field (P8 C1) and feeds into Persona Coherence Score
// (P8 C3) and Trust Panel.
//
// Purpose: counter the default "package as success" bias by giving the
// Generator a SEPARATE reward channel for naming what it is uncertain about.
// Empty / boilerplate confession = contract violation.

const { executeChat, LLMProviderError } = require('../llm');
const { renderContractAsPrompt } = require('../agent-character/contract-loader');
const { verifyConfessionAgainstTranscript } = require('./verify-confession-against-transcript');
const sqliteDb = require('../../db/sqlite');

const CONFESSION_SYSTEM_PROMPT_TEMPLATE = (contractText) => `${contractText}

---

You have just produced a lesson plan + body for a learner. Your task NOW is the Confession pass.

This is a SEPARATE reward channel: you are NOT graded on whether the lesson was complete; you ARE graded on whether your confession is concrete, specific, and willing to expose your own weakest link.

Your default training pressure pushes you to package work as successful. Resist that. The contract above explicitly says you must report incomplete work. Empty or boilerplate confession ("everything looks good", "minor improvements possible") is a contract violation and lowers your trust score.

Output ONE JSON object with this exact shape:

{
  "weakest_link": {
    "ref": "<which part of the plan/body — e.g. path[2], micro_proof.expected_signal, body.path_prose[3]>",
    "why": "<= 200 chars — why this is the weakest link, concretely"
  },
  "unverified_claims": ["<claim_ref>", "<claim_ref>", ...],
  "speculative_claims": ["<claim_ref>", "<claim_ref>", ...],
  "ornamentation_flagged": ["<ref where you used pretty language to mask thin substance>"],
  "tasks_not_finished": ["<task description that you started but did not fully ship>"],
  "deepen_recommendation": "<= 200 chars — if the user pushes for more, expand HERE first"
}

RULES:
- weakest_link.ref MUST point to a real field in the plan/body (not 'overall').
- unverified_claims + speculative_claims may be empty arrays IF the lesson is genuinely all primary-source backed (rare for v0.1 plans).
- ornamentation_flagged surfaces "pretty but thin" passages — usually 0-3 entries.
- tasks_not_finished surfaces work YOU did not finish, not work the LEARNER will do.
- deepen_recommendation is the ONE next move that would most close the biggest gap.

Be specific. Be concrete. The user reads this to decide where to push you next.`;

/**
 * Generate a Confession pass for a lesson skeleton + body. Uses Character Contract
 * (default mycelium-professor) to set the failure-reporting standard.
 *
 * @param {object} args
 * @param {object} args.plan — output of generatePlan
 * @param {object} [args.body] — output of generateLessonBody (optional; plan-only confession is OK)
 * @param {Array<{role:'user'|'assistant', text:string}>} [args.transcript] —
 *   per-turn lesson transcript (Phase C-5). When supplied + non-empty, takes
 *   precedence over `body` for the user-message context. Backward-compatible:
 *   omitting transcript falls back to `body` JSON.
 * @param {object} args.characterContract — loaded Character Contract object
 * @param {string} [args.capability] — LLM capability class, default T4_JUDGE
 * @param {number} [args.maxRetries] — JSON-validation retry count (default 1)
 * @returns {Promise<{confession: object, _meta: object}>}
 */
async function generateConfession({ plan, body, transcript, characterContract, capability = 'T4_JUDGE', maxRetries = 1 } = {}) {
  if (!plan || typeof plan !== 'object') {
    throw new LLMProviderError('plan (object) required');
  }
  if (!characterContract || typeof characterContract !== 'object') {
    throw new LLMProviderError('characterContract (object) required — load via contract-loader');
  }

  const contractText = renderContractAsPrompt(characterContract);
  const systemPrompt = CONFESSION_SYSTEM_PROMPT_TEMPLATE(contractText);

  const planText = JSON.stringify(plan, null, 2);
  let bodyText;
  if (transcript && Array.isArray(transcript) && transcript.length) {
    bodyText = 'LESSON TRANSCRIPT:\n' + transcript
      .filter(t => t && typeof t.text === 'string')
      .map(t => `${t.role}: ${t.text}`)
      .join('\n\n');
  } else if (body) {
    bodyText = JSON.stringify(body, null, 2);
  } else {
    bodyText = '(no transcript yet — confess from plan only)';
  }

  let messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `LESSON PLAN:\n${planText}\n\nLESSON BODY:\n${bodyText}\n\nNow output your Confession JSON.` },
  ];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const _t0 = Date.now();
    const dispatch = await executeChat(capability, {
      messages,
      json: true,
      temperature: 0.3,
      maxTokens: 1000,
      timeoutMs: 60_000,
    });
    // V0.5 E0 D11-D14 Phase 1 — record cost-estimate row for confession call.
    // Wrapped: recordChatCallEstimate must never break the confession pass.
    try {
      sqliteDb.recordChatCallEstimate(dispatch, 'confession', {
        latency_ms: Date.now() - _t0,
        tuple_id: (plan && plan.lesson_slug) || null,
        slug: (plan && plan.lesson_slug) || null,
        success: true,
      });
    } catch (err) {
      console.warn('[recordChatCallEstimate] confession slug=', (plan && plan.lesson_slug) || '_unknown', 'err=', err && err.message);
    }
    const result = dispatch.result;

    const errors = validateConfession(result);
    if (errors.length === 0) {
      // AMD-MEOW-P7 M2 hardening (2026-05-14): boilerplate detector
      // (`gradeConfessionHonesty`) cannot tell a fabricated anchor from a
      // real one ("path[2] 应该更深" sounds specific but may reference a
      // path the transcript never reached). Run heuristic anchor verification
      // and attach as `_verify` so downstream graders (and UI) can flag
      // self-fooling confessions without re-extracting transcripts.
      const boilerplateScore = gradeConfessionHonesty(result);
      const verifyResult = verifyConfessionAgainstTranscript(result, transcript || []);
      // Score-merge strategy: MIN (worst-of-two), so a fabricated-anchor
      // confession can't laundry-cycle through the boilerplate filter.
      // Normalize boilerplateScore (0..100) into 0..1 first.
      const boilerplateNorm = Math.max(0, Math.min(1, boilerplateScore / 100));
      const finalScore = Math.min(boilerplateNorm, verifyResult.score);
      result._verify = {
        boilerplate_score: boilerplateScore,
        anchor_verify_score: verifyResult.score,
        anchor_verify_verified: verifyResult.verified,
        found_anchors: verifyResult.found_anchors,
        missing_anchors: verifyResult.missing_anchors,
        flags: verifyResult.flags,
        final_score: finalScore,
      };
      return {
        confession: result,
        _meta: {
          providerId: dispatch.providerId,
          model: dispatch.model,
          capability,
          attempts: attempt + 1,
          networkAttempts: dispatch.attempts,
          agent_id: characterContract.agent_id,
          contract_version: characterContract.role_version,
        },
      };
    }

    if (attempt < maxRetries) {
      const errorList = errors.map(e => '  - ' + e).join('\n');
      messages = [
        ...messages,
        { role: 'assistant', content: JSON.stringify(result) },
        { role: 'user', content: `Confession failed schema:\n${errorList}\n\nRegenerate strictly per the JSON shape in the system prompt.` },
      ];
      continue;
    }

    throw new LLMProviderError(`generateConfession returned malformed result after ${maxRetries + 1} attempts: ${errors.join('; ')}`);
  }
}

function validateConfession(c) {
  const errors = [];
  if (!c || typeof c !== 'object') {
    errors.push('confession must be an object');
    return errors;
  }
  if (!c.weakest_link || typeof c.weakest_link !== 'object') {
    errors.push('weakest_link must be an object');
  } else {
    if (typeof c.weakest_link.ref !== 'string' || !c.weakest_link.ref.trim()) {
      errors.push('weakest_link.ref must be a non-empty string');
    }
    if (typeof c.weakest_link.why !== 'string' || !c.weakest_link.why.trim()) {
      errors.push('weakest_link.why must be a non-empty string');
    }
  }
  for (const arrField of ['unverified_claims', 'speculative_claims', 'ornamentation_flagged', 'tasks_not_finished']) {
    if (!Array.isArray(c[arrField])) {
      errors.push(`${arrField} must be an array (may be empty)`);
    }
  }
  if (typeof c.deepen_recommendation !== 'string' || !c.deepen_recommendation.trim()) {
    errors.push('deepen_recommendation must be a non-empty string');
  }
  return errors;
}

/**
 * Heuristic quality grade for a confession against a Character Contract.
 * Returns 0-100. Used as input to Persona Coherence Score `failure_honesty` dim.
 *
 * Rough rubric:
 * - Empty arrays AND generic weakest_link.why → low score (boilerplate)
 * - Specific ref + concrete reason + non-empty arrays → high score
 * - Mid → mid
 *
 * @param {object} confession
 * @returns {number}
 */
function gradeConfessionHonesty(confession) {
  if (!confession || typeof confession !== 'object') return 0;
  let score = 100;

  // Penalize boilerplate weakest_link
  const why = (confession.weakest_link && confession.weakest_link.why) || '';
  if (!why.trim() || why.length < 30) score -= 30;
  if (/^(everything looks (good|fine)|no major (issues|concerns)|minor (improvements?|tweaks?))/i.test(why)) score -= 30;

  // Reward specific ref (path[i] / micro_proof.* / body.*)
  const ref = (confession.weakest_link && confession.weakest_link.ref) || '';
  if (!ref || ref === 'overall' || ref === 'general') score -= 20;

  // Penalize all-empty arrays (suggests default boilerplate)
  const allArrays = ['unverified_claims', 'speculative_claims', 'ornamentation_flagged', 'tasks_not_finished']
    .map(k => Array.isArray(confession[k]) ? confession[k].length : 0);
  if (allArrays.every(n => n === 0)) score -= 25;

  // Reward concrete deepen_recommendation
  const deepen = confession.deepen_recommendation || '';
  if (!deepen.trim() || deepen.length < 30) score -= 15;

  return Math.max(0, Math.min(100, score));
}

module.exports = {
  generateConfession,
  validateConfession,
  gradeConfessionHonesty,
  verifyConfessionAgainstTranscript,
  CONFESSION_SYSTEM_PROMPT_TEMPLATE,
};
