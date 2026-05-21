#!/usr/bin/env node
'use strict';
// HYPHA · 5-plan smoke test — sub-step D pre-validation
//
// Yogo-recommended falsifier (Path 2 of council synthesis): run the 6-field
// Lesson Plan strawman prompt against 5 different goal types BEFORE writing
// sub-step D code. User reads outputs + scores: ≥3/5 useful + ≤60s/plan +
// reader can match plan→goal at ≥80% → schema passes → push sub-step D.
//
// Usage: node scripts/smoke-5plans.cjs

const path = require('path');
const { getProvider, LLMAuthError, LLMTimeoutError, LLMProviderError } = require(path.resolve(__dirname, '..', 'app', 'lib', 'llm'));

const SYSTEM_PROMPT = `You are a HYPHA lesson architect. Output ONE JSON object matching the schema. No prose outside JSON.

SCHEMA (6 top-level fields, EXACTLY this shape):
{
  "objective": "one Bloom-action-verb sentence ≤25 words",
  "prerequisite_check": "≤25 word yes/no question OR null",
  "hook_concrete": "≤80 tokens — concrete artifact OR contradiction",
  "path": ["3-4 strings, each ≤30 words, learner action not model derivation"],
  "micro_proof": {
    "stimulus": "single question/prompt ≤30 words",
    "expected_signal": "structural pattern (≤30 words) — see RULES below",
    "fail_mode": "≤25 words — what wrong looks like"
  },
  "next_lesson_seed": "≤1 sentence ≤20 words"
}

STRUCTURE RULES (violation = output rejected):
- All 6 keys MUST be at root level of the JSON object.
- micro_proof and next_lesson_seed are TOP-LEVEL keys, NEVER nested inside path or any other field.
- path is an array of STRINGS only — no objects, no nested keys.
- path items end with period or no punctuation. NO exclamation marks.

expected_signal RULES:
- Describe a STRUCTURAL PATTERN, not a literal API output. Examples of good patterns: "output contains a city name and a temperature number", "answer includes ≥2 of: cost, recall, latency", "JSON has fields X, Y, Z populated".
- FORBIDDEN interpretive verbs: "explicitly ties", "clearly states", "properly demonstrates", "appropriately addresses", "correctly applies". These require human judgment, not eyeball check.
- Must be checkable in <10s by reading the learner's pasted output against the pattern. NO 2nd LLM call.

CONSTRAINTS:
- 30 minutes total work for the target audience.
- path = what LEARNER DOES, not what model derives.
- No filler. No preamble. Direct artifacts only.`;

const GOALS = [
  {
    label: 'G1 Procedural',
    goal: { north_star_goal: 'Build my first AI agent', main_creation: 'a working node.js agent', learning_model: 'Growth' },
    audience: 'solo developer, knows JS basics, never built an LLM agent',
    learner_state: { known: ['javascript', 'node.js basics'], unknown: ['LLM API', 'agent loop', 'tool use'] }
  },
  {
    label: 'G2 Conceptual',
    goal: { north_star_goal: 'Understand what an embedding is and when to use it', main_creation: 'an LLM-app with semantic search', learning_model: 'Growth' },
    audience: 'web developer, comfortable with REST APIs, no ML background',
    learner_state: { known: ['vectors as arrays of numbers', 'similarity intuitive sense'], unknown: ['embedding model', 'cosine similarity', 'semantic vs keyword'] }
  },
  {
    label: 'G3 Judgment',
    goal: { north_star_goal: 'Decide whether my LLM app needs a vector DB or simple keyword search', main_creation: 'a documented architecture decision', learning_model: 'Hybrid' },
    audience: 'engineering lead, building first LLM product, budget-constrained',
    learner_state: { known: ['embeddings exist', 'vector DBs are expensive', 'keyword search is cheap'], unknown: ['when each fails', 'recall vs precision tradeoff', 'cost-per-query at scale'] }
  },
  {
    label: 'G4 Cross-domain',
    goal: { north_star_goal: 'Apply Tetlock calibration mindset to product roadmap decisions', main_creation: 'a calibrated quarterly roadmap', learning_model: 'Growth' },
    audience: 'PM with 5 years experience, knows OKRs but not forecasting research',
    learner_state: { known: ['Tetlock name from Superforecasting book', 'Brier score concept vaguely'], unknown: ['pre-registration discipline', 'reference class forecasting', 'calibration vs accuracy'] }
  },
  {
    label: 'G5 Foundational',
    goal: { north_star_goal: 'Write a Goal Contract for HYPHA itself, not just for users of HYPHA', main_creation: 'HYPHA founder Goal Contract document', learning_model: 'Growth' },
    audience: 'solo founder building HYPHA, has read blueprint § 3.1',
    learner_state: { known: ['Goal Contract structure for users (8 fields)', 'HYPHA north star "private university"'], unknown: ['how meta Goal Contract differs', 'what discipline_mode means for the founder vs user', 'forbidden_drifts at meta level'] }
  }
];

async function generatePlan(goal) {
  const provider = getProvider();
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `GOAL_CONTRACT: ${JSON.stringify(goal.goal)}
TARGET_AUDIENCE: ${goal.audience}
TIME_BUDGET: 30 minutes
LEARNER_STATE: ${JSON.stringify(goal.learner_state)}

Generate the lesson plan JSON.` }
  ];

  try {
    const plan = await provider.chat({
      messages,
      model: 'glm-5.1',
      json: true,
      timeoutMs: 90000,
      maxTokens: 1500
    });
    return { ok: true, plan };
  } catch (err) {
    if (err instanceof LLMAuthError) {
      return { ok: false, error: 'AUTH', message: err.message };
    }
    if (err instanceof LLMTimeoutError) {
      return { ok: false, error: 'TIMEOUT', message: err.message };
    }
    // Try fallback model glm-4-plus once for any other error
    try {
      const plan = await provider.chat({
        messages,
        model: 'glm-4-plus',
        json: true,
        timeoutMs: 90000,
        maxTokens: 1500
      });
      return { ok: true, plan, fallback: 'glm-4-plus' };
    } catch (err2) {
      return { ok: false, error: 'PROVIDER', message: err2.message || err.message };
    }
  }
}

(async () => {
  console.log('='.repeat(72));
  console.log('HYPHA 5-plan smoke test — schema validation pre-sub-step-D');
  console.log('='.repeat(72));
  console.log();

  if (!process.env.GLM_API_KEY) {
    console.error('ERROR: GLM_API_KEY not set in environment.');
    console.error('Run: $env:GLM_API_KEY = "sk-..."  (PowerShell)  then retry.');
    process.exit(1);
  }

  const startTotal = Date.now();
  const results = [];

  for (let i = 0; i < GOALS.length; i++) {
    const g = GOALS[i];
    process.stdout.write(`[${i + 1}/5] ${g.label} ... `);
    const t0 = Date.now();
    const r = await generatePlan(g);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.ok) {
      console.log(`✓ ${elapsed}s${r.fallback ? ' (fallback ' + r.fallback + ')' : ''}`);
    } else {
      console.log(`✗ ${r.error} ${elapsed}s`);
    }
    results.push({ ...g, result: r, elapsed });
  }

  console.log();
  console.log('='.repeat(72));
  console.log('PLANS — read each below + score on 3 binary criteria:');
  console.log('  (a) advances stated goal Y/N');
  console.log('  (b) micro_proof.expected_signal externally checkable WITHOUT 2nd LLM Y/N');
  console.log('  (c) you would recommend this lesson to yourself Y/N');
  console.log('Pass threshold: ≥3/5 score 3/3, plan reads in ≤60s, plan→goal matches obvious.');
  console.log('='.repeat(72));

  for (const r of results) {
    console.log();
    console.log('─'.repeat(72));
    console.log(`${r.label}`);
    console.log(`Audience: ${r.audience}`);
    console.log(`Goal: ${r.goal.north_star_goal}`);
    console.log('─'.repeat(72));
    if (r.result.ok) {
      console.log(JSON.stringify(r.result.plan, null, 2));
    } else {
      console.log(`<FAILED: ${r.result.error} — ${r.result.message}>`);
    }
  }

  console.log();
  console.log('='.repeat(72));
  const totalElapsed = ((Date.now() - startTotal) / 1000).toFixed(1);
  const okCount = results.filter(r => r.result.ok).length;
  console.log(`Total elapsed: ${totalElapsed}s · ${okCount}/5 plans generated successfully.`);
  console.log('Score these in conversation. Threshold: ≥3/5 score 3/3 → push sub-step D.');
  console.log('='.repeat(72));
})();
