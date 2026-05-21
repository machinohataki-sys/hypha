'use strict';
// HYPHA · Lesson Critique-Loop (S66 Anthropic 3-agent harness + S75 Shopify
// critique-loop > parallel spawn + S80 weak-model boosting + S88 MSIFR).
//
// Post-generation critique pass for lesson drafts (body-v2 shape). Distinct
// from app/lib/critique/critique-runner.js (which critiques skeleton-level
// lessonPlan via 3 parallel judges). This module is per-lesson-body critique
// in a draft → critic → revise pipeline.
//
// Pipeline:
//   draft + plan
//     ↓
//   MSIFR rule validators (cheap, short-circuit on fail)
//     ↓
//   LLM critic scores 0..1 against plan.success_test / failure_test
//     ↓
//   if score < SCORE_REVISE_THRESHOLD → return {must_revise: true, criticism}
//     ↓
//   else return {must_revise: false, revised_draft = draft}
//
// One-line jsonl trace appended to vault/.hypha/quality-trace.jsonl per call
// (success path only; MSIFR-fail also traces with score_post=null).
//
// Cost contract: 1 critic LLM call per draft (T4_JUDGE, ~$0.001 GLM-4.5-Air).
// MSIFR fast-fail keeps wasted token spend to ~0. No vault writes outside the
// trace appendix line.
//
// Falsifier (S63 prediction contract): if A/B trace over ≥50 lessons shows
// no statistically significant uplift over single-model baseline (p<0.05),
// revert. Decision Log entry pre-registers this falsifier.

const fs   = require('node:fs');
const path = require('node:path');

const msifr = require('./lesson-critique-msifr');

const SCORE_REVISE_THRESHOLD = 0.7;

// ── Path resolution ────────────────────────────────────────────────────

function _resolveVaultRoot(opts) {
  const fromOpts = opts && (opts.vaultRoot || opts.vault_root);
  if (fromOpts && typeof fromOpts === 'string') return fromOpts;
  // Default = E:/victor/hypha/vault on Windows; cwd-relative everywhere else.
  // We deliberately resolve relative to module location so unit tests can
  // override via opts.vaultRoot without polluting cwd.
  return path.resolve(__dirname, '..', '..', 'vault');
}

function _traceFile(vaultRoot) {
  return path.join(vaultRoot, '.hypha', 'quality-trace.jsonl');
}

function _ensureDir(filePath) {
  const dir = path.dirname(filePath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* race ok */ }
}

// ── Trace emit ─────────────────────────────────────────────────────────

/**
 * Append a 1-line JSON record to quality-trace.jsonl. Best-effort —
 * never throws. The shape matches the A/B trace spec so a later
 * statistical-significance harness can parse the same file produced by
 * critique-enabled and critique-disabled runs.
 *
 * @param {object} entry — { ts, lesson_id, generator, critic, score_pre, score_post, divergence, ... }
 * @param {string} vaultRoot
 */
function _emitTrace(entry, vaultRoot) {
  try {
    const file = _traceFile(vaultRoot);
    _ensureDir(file);
    const line = JSON.stringify(Object.assign({ ts: new Date().toISOString() }, entry));
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch (_) { /* observability is non-fatal */ }
}

// ── LLM critic call ────────────────────────────────────────────────────

function _renderPlanForCritic(plan) {
  if (!plan || typeof plan !== 'object') return '(no plan)';
  const lines = [];
  if (plan.lessonTitle || plan.title) lines.push(`title: ${plan.lessonTitle || plan.title}`);
  if (plan.learnGoal) lines.push(`learnGoal: ${plan.learnGoal}`);
  if (plan.scope_in)  lines.push(`scope_in: ${plan.scope_in}`);
  if (plan.scope_out) lines.push(`scope_out: ${plan.scope_out}`);
  if (plan.prerequisite) lines.push(`prerequisite: ${plan.prerequisite}`);
  if (plan.success_test) lines.push(`success_test: ${plan.success_test}`);
  if (plan.failure_test) lines.push(`failure_test: ${plan.failure_test}`);
  if (plan.archetype) lines.push(`archetype: ${plan.archetype}`);
  return lines.join('\n');
}

function _renderDraftForCritic(draft) {
  if (typeof draft === 'string') return draft.slice(0, 8000);
  if (draft && typeof draft === 'object') {
    try { return JSON.stringify(draft, null, 2).slice(0, 8000); }
    catch (_) { return '(unserializable draft)'; }
  }
  return '(empty draft)';
}

function _buildCriticPrompt(draft, plan) {
  const planStr = _renderPlanForCritic(plan);
  const draftStr = _renderDraftForCritic(draft);
  return `You are a strict pedagogical critic. Score the LESSON DRAFT against the PLAN's success/failure criteria.

=== PLAN ===
${planStr}

=== LESSON DRAFT ===
${draftStr}

=== TASK ===
1. Score the draft 0.0 to 1.0 against the plan's success_test (if present) and learnGoal.
   - 1.0 = passes success_test exactly; draft delivers what learnGoal promises.
   - 0.7 = mostly delivers, minor gaps. (Anything ≥0.7 ships without revision.)
   - 0.5 = partial; key piece missing or weak.
   - 0.0 = irrelevant / drifts from learnGoal / triggers failure_test.
2. List up to 5 concrete criticisms (each one specific & actionable, not vague).
3. Return STRICT JSON (no markdown, no preamble):
{
  "score": <number 0..1>,
  "criticism": ["...", "..."],
  "verdict": "ship" | "revise"
}

Score conservatively. A confident draft that misses the learnGoal scores LOW. Empty criticism array is fine if score ≥ 0.85.`;
}

function _extractFirstJSON(rawIn) {
  if (typeof rawIn !== 'string') return rawIn;
  const raw = rawIn.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { JSON.parse(raw); return raw; } catch (_) { /* fall through */ }
  for (let start = 0; start < raw.length; start++) {
    const openCh = raw[start];
    if (openCh !== '{' && openCh !== '[') continue;
    const closeCh = openCh === '{' ? '}' : ']';
    let depth = 0, inStr = false, escape = false;
    for (let i = start; i < raw.length; i++) {
      const c = raw[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === openCh) depth++;
      else if (c === closeCh) {
        depth--;
        if (depth === 0) {
          const candidate = raw.slice(start, i + 1);
          try { JSON.parse(candidate); return candidate; } catch (_) {}
          break;
        }
      }
    }
  }
  return null;
}

function _extractRawText(dispatch) {
  const r = dispatch && dispatch.result;
  if (typeof r === 'string') return r;
  if (r && typeof r.content === 'string') return r.content;
  if (r && r.message && typeof r.message.content === 'string') return r.message.content;
  if (r && Array.isArray(r.choices) && r.choices[0] && r.choices[0].message
        && typeof r.choices[0].message.content === 'string') return r.choices[0].message.content;
  try { return JSON.stringify(r || dispatch || {}); } catch (_) { return ''; }
}

async function _invokeCritic({ prompt, capability, llmOverride }) {
  let llm = llmOverride;
  if (!llm) {
    try { llm = require('./llm'); } catch (_) { llm = null; }
  }
  if (!llm || typeof llm.executeChat !== 'function') {
    return { parsed: null, error: 'llm router unavailable', provider: null, model: null };
  }
  try {
    const dispatch = await llm.executeChat(capability || 'T4_JUDGE', {
      messages: [{ role: 'user', content: prompt }],
      json: true,
      temperature: 0.3,
      maxTokens: 1200,
      timeoutMs: 60000,
    });
    const raw = _extractRawText(dispatch);
    const cleaned = _extractFirstJSON(raw);
    let parsed = null;
    try { parsed = (typeof cleaned === 'string') ? JSON.parse(cleaned) : cleaned; }
    catch (_) { parsed = null; }
    return {
      parsed,
      error: parsed ? null : 'unparseable JSON',
      provider: dispatch && dispatch.providerId,
      model:    dispatch && dispatch.model,
    };
  } catch (err) {
    return { parsed: null, error: (err && err.message) || String(err), provider: null, model: null };
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Critique a lesson draft against its plan. Cheap MSIFR rules first; if all
 * pass, invoke LLM critic.
 *
 * @param {object} args
 * @param {string|object} args.draft         — lesson body (string markdown or v2 body object)
 * @param {object}        args.plan          — lesson plan with learnGoal / scope_in / success_test
 * @param {string}        [args.modelDraft]  — generator model name (for trace)
 * @param {string}        [args.modelCritic] — critic model name (for trace)
 * @param {object}        [args.config]      — { capability, vaultRoot, llm }
 * @returns {Promise<{score, criticism, revised_draft, must_revise, trace}>}
 */
async function critiqueLessonDraft({ draft, plan, modelDraft, modelCritic, config } = {}) {
  const cfg = config || {};
  const vaultRoot = _resolveVaultRoot(cfg);
  const lessonId = (plan && (plan.lesson_id || plan.lessonId || plan.idx)) ?? null;
  const generator = modelDraft || (cfg && cfg.modelDraft) || 'unknown';
  const critic    = modelCritic || (cfg && cfg.modelCritic) || 'T4_JUDGE';

  // Step 1 — MSIFR gates (cheap)
  const msifrResult = msifr.composeMsifr(draft, plan);
  if (!msifrResult.ok) {
    const trace = {
      lesson_id: lessonId,
      generator,
      critic,
      score_pre: null,
      score_post: null,
      divergence: 0,
      msifr_failed_at: msifrResult.failed_at,
      msifr_reason: msifrResult.reason,
    };
    _emitTrace(trace, vaultRoot);
    return {
      score: 0,
      criticism: [`MSIFR ${msifrResult.failed_at}: ${msifrResult.reason}`],
      revised_draft: null,
      must_revise: true,
      trace,
    };
  }

  // Step 2 — LLM critic
  const prompt = _buildCriticPrompt(draft, plan);
  const inv = await _invokeCritic({
    prompt,
    capability: cfg.capability,
    llmOverride: cfg.llm,
  });

  if (!inv.parsed) {
    // Critic unavailable / unparseable → fail-open (ship draft, log gap).
    // We do NOT block the lesson on critic failure; the loop is advisory in
    // this experimental tranche. A future tightening can convert this to
    // must_revise=true once provider health is proven.
    const trace = {
      lesson_id: lessonId,
      generator,
      critic,
      critic_provider: inv.provider,
      critic_model: inv.model,
      score_pre: null,
      score_post: null,
      divergence: 0,
      critic_error: inv.error,
    };
    _emitTrace(trace, vaultRoot);
    return {
      score: null,
      criticism: [`critic failed: ${inv.error}`],
      revised_draft: draft,
      must_revise: false,
      trace,
    };
  }

  const score = (typeof inv.parsed.score === 'number')
    ? Math.max(0, Math.min(1, inv.parsed.score))
    : null;
  const criticism = Array.isArray(inv.parsed.criticism)
    ? inv.parsed.criticism.filter(s => typeof s === 'string').slice(0, 5)
    : [];
  const verdict = (inv.parsed.verdict === 'revise' || inv.parsed.verdict === 'ship')
    ? inv.parsed.verdict
    : null;

  const must_revise = (score != null && score < SCORE_REVISE_THRESHOLD)
                   || verdict === 'revise';

  const trace = {
    lesson_id: lessonId,
    generator,
    critic,
    critic_provider: inv.provider,
    critic_model: inv.model,
    score_pre: score,
    score_post: must_revise ? null : score,
    divergence: criticism.length,
    must_revise,
  };
  _emitTrace(trace, vaultRoot);

  return {
    score,
    criticism,
    revised_draft: must_revise ? null : draft,
    must_revise,
    trace,
  };
}

module.exports = {
  critiqueLessonDraft,
  SCORE_REVISE_THRESHOLD,
  // Exposed for tests
  _buildCriticPrompt,
  _extractFirstJSON,
  _resolveVaultRoot,
};
