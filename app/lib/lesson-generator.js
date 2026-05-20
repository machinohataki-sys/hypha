'use strict';
// HYPHA · Lesson Skeleton generator — sub-step D backend
//
// ⚠ Naming clarification (2026-05-08, v0.3 pivot): the legacy export name
// `generatePlan` is a misnomer. Per BLUEPRINT §1.1, "Plan" = the curriculum
// CHAIN (multi-lesson 0→frontier path produced by `agent.js:planChain`),
// NOT the per-lesson 6-field skeleton this module emits. Internally this
// module produces a "Lesson Skeleton" / "starter card" — a HOOK seed used
// by the v0.3 chat surface (LessonChat + 8-state state-machine).
//
// The export name `generatePlan` is retained for ABI compatibility with
// existing IPC callers (main.js → preload.js → screen-lesson.jsx). New
// callers should treat the return value as a SKELETON, not as the
// authoritative lesson content. The 12-field §6.1 schema is covered
// through chat turns, not through this skeleton's 6 fields.
//
// `generateLessonBody` (3-field intro/path/closing static prose) is
// DEPRECATED v0.3 — its output violates §6.1 (12-field interactive
// coverage) and is auto-flagged ornamentation by the v0.2 trust stack.
// Retained as v0.2 transition surface; do not extend. See bottom of file.
//
// Pipeline position: between Goal Contract (sub-step A) and Lesson body
// generation (later sub-step). This module owns ONLY Lesson Skeleton
// generation — the 6-field skeleton-before-prose stage.
//
// Schema validated 2026-05-08 via 5-plan smoke test (round 2): 5/5 strict
// 3/3, plan→goal mapping 5/5 obvious. Council synthesis: Lung Tetlock +
// Yogo bimodal + Scout LearnLM/EduPlanner converged on this 6-field shape.
//
// Returns skeleton object or throws LLMError. v0.1 = single-pass + 1 retry
// on schema violation. NO Critic loop (deferred to v0.2 — 3-of-3 council
// questioned LLM-judging-LLM at v0.1).

const { getProvider, LLMProviderError } = require('./llm');
const jargonFirewall = require('./jargon-firewall');
const assignment = require('./assignment');

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

const REQUIRED_TOP_KEYS = ['objective', 'prerequisite_check', 'hook_concrete', 'path', 'micro_proof', 'next_lesson_seed'];
const REQUIRED_PROOF_KEYS = ['stimulus', 'expected_signal', 'fail_mode'];

// Evidence Ledger schema (AMD-MEOW-P7 M1, v0.2 Tranche 1 — schema + validator only,
// not yet enforced on generatePlan output to preserve v0.1 backward compat).
//
// Each row records the provenance of one non-trivial claim in the lesson
// skeleton or body. Hard claims (definition, mechanism) MUST set evidence_pointer != null;
// soft claims (analogy, spark, frontier judgment) MAY have null pointer but
// must declare confidence:speculative.
const EVIDENCE_TYPES = ['primary_source', 'reasoning', 'analogy', 'frontier_judgment', 'original_view', 'spark'];
const HARD_EVIDENCE_TYPES = ['primary_source', 'reasoning'];
const CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'speculative'];
const VERIFIABILITY_LEVELS = ['high', 'partial', 'low', 'unverifiable'];
const RISK_LEVELS = ['low', 'medium', 'high'];

const EVIDENCE_LEDGER_SCHEMA_DESCRIPTION = `Evidence Ledger row schema:
{
  "claim_ref": "path[i] | objective | hook_concrete | body.path_prose[i] | body.intro_prose | ...",
  "claim_text": "<= 120 chars verbatim quote of the claim",
  "evidence_type": "${EVIDENCE_TYPES.join(' | ')}",
  "evidence_pointer": "<file path | URL | source ID | null>",
  "confidence": "${CONFIDENCE_LEVELS.join(' | ')}",
  "verifiability": "${VERIFIABILITY_LEVELS.join(' | ')}",
  "risk": "${RISK_LEVELS.join(' | ')}"
}

Hard claims (evidence_type=primary_source OR reasoning) require evidence_pointer != null.`;

function validateEvidenceLedger(ledger) {
  const errors = [];
  if (!Array.isArray(ledger)) {
    errors.push('evidence_ledger must be an array');
    return errors;
  }
  ledger.forEach((row, i) => {
    if (!row || typeof row !== 'object') {
      errors.push(`evidence_ledger[${i}] must be an object`);
      return;
    }
    if (typeof row.claim_ref !== 'string' || !row.claim_ref.trim()) {
      errors.push(`evidence_ledger[${i}].claim_ref must be a non-empty string`);
    }
    if (typeof row.claim_text !== 'string' || row.claim_text.length > 200) {
      errors.push(`evidence_ledger[${i}].claim_text must be a string of <=200 chars`);
    }
    if (!EVIDENCE_TYPES.includes(row.evidence_type)) {
      errors.push(`evidence_ledger[${i}].evidence_type must be one of ${EVIDENCE_TYPES.join('|')} (got ${row.evidence_type})`);
    }
    if (HARD_EVIDENCE_TYPES.includes(row.evidence_type) && (row.evidence_pointer === null || row.evidence_pointer === undefined || row.evidence_pointer === '')) {
      errors.push(`evidence_ledger[${i}] is hard-claim (${row.evidence_type}) but evidence_pointer is null/empty`);
    }
    if (!CONFIDENCE_LEVELS.includes(row.confidence)) {
      errors.push(`evidence_ledger[${i}].confidence must be one of ${CONFIDENCE_LEVELS.join('|')} (got ${row.confidence})`);
    }
    if (!VERIFIABILITY_LEVELS.includes(row.verifiability)) {
      errors.push(`evidence_ledger[${i}].verifiability must be one of ${VERIFIABILITY_LEVELS.join('|')} (got ${row.verifiability})`);
    }
    if (!RISK_LEVELS.includes(row.risk)) {
      errors.push(`evidence_ledger[${i}].risk must be one of ${RISK_LEVELS.join('|')} (got ${row.risk})`);
    }
  });
  return errors;
}

// R-LIB Day 4 (2026-05-12): format LIBRARY_EVIDENCE block from library rollup
// cache. Top 3 books (already vec-rank sorted) contribute chapter TOC + D/P/R
// hit counts. Skeleton stage uses TOC to anchor chapter→KP mapping, combats
// LLM training-frequency bias (Galileo-skip v0.2.1 root cause).
function _formatLibraryEvidence(libraryRollup) {
  if (!Array.isArray(libraryRollup) || libraryRollup.length === 0) return '';
  const top = libraryRollup.slice(0, 3);
  const lines = ['LIBRARY_EVIDENCE (用户书架, 多向量 rank top 3):'];
  for (const b of top) {
    const author = b.book_author ? ` — ${b.book_author}` : '';
    lines.push(`\n=== ${b.book_title}${author} ===`);
    if (Array.isArray(b.toc) && b.toc.length > 0) {
      const tocLine = b.toc.slice(0, 12).map(t => t.title).join(' / ');
      lines.push(`TOC: ${tocLine}${b.toc.length > 12 ? ` (+ ${b.toc.length - 12} more)` : ''}`);
    }
    lines.push(`Hits: direct=${b.direct_hits} / prereq=${b.prereq_hits} / related=${b.related_hits}`);
    if (b.direct_hits === 0 && b.prereq_hits > 0) {
      lines.push('  (prereq context only — use for grounding ancestor concepts)');
    }
  }
  return lines.join('\n');
}

// R-LIB Day 4: format COMMUNITY_HINT block from pack cache. Suggested
// chapters + KP candidates per pack, plus curator/ratified trust signals.
function _formatCommunityHint(communityHint) {
  if (!communityHint || !Array.isArray(communityHint.packs_used) || communityHint.packs_used.length === 0) return '';
  const lines = ['COMMUNITY_HINT (hypha-packs curated):'];
  const syllabusByPack = {};
  for (const item of (communityHint.syllabus_skeleton || [])) {
    if (!syllabusByPack[item.pack_id]) syllabusByPack[item.pack_id] = [];
    syllabusByPack[item.pack_id].push(item);
  }
  for (const pack of communityHint.packs_used) {
    const staleTag = pack.stale ? ' [stale >12mo]' : '';
    lines.push(`\n=== ${pack.id} (curator: ${pack.curator}, ratified: ${pack.ratified_count})${staleTag} ===`);
    const chapters = syllabusByPack[pack.id] || [];
    if (chapters.length > 0) {
      lines.push('Suggested chapters:');
      for (const c of chapters) {
        const kps = Array.isArray(c.kp_candidates) ? c.kp_candidates.slice(0, 6).join(', ') : '';
        lines.push(`  • ${c.chapter}: ${kps}`);
      }
    }
  }
  const contestedCount = (communityHint.contested_questions || []).length;
  if (contestedCount > 0) {
    lines.push(`\nContested questions: ${contestedCount} listed (consumed by CHALLENGE pipeline, not skeleton)`);
  }
  return lines.join('\n');
}

function buildUserMessage({ goalContract, audience, learnerState, timeBudgetMin = 30, harvestContext = null }) {
  const sections = [
    `GOAL_CONTRACT: ${JSON.stringify(goalContract)}`,
    `TARGET_AUDIENCE: ${audience || 'self-directed adult learner'}`,
    `TIME_BUDGET: ${timeBudgetMin} minutes`,
    `LEARNER_STATE: ${JSON.stringify(learnerState || { known: [], unknown: [] })}`,
  ];

  if (harvestContext) {
    const libBlock = _formatLibraryEvidence(harvestContext.libraryRollup);
    const commBlock = _formatCommunityHint(harvestContext.communityHint);
    if (libBlock || commBlock) {
      sections.push('');
      if (libBlock) sections.push(libBlock);
      if (commBlock) sections.push(commBlock);
      sections.push('');
      sections.push(
        'USAGE: 用 LIBRARY_EVIDENCE 的 TOC 锚定 chapter→KP 映射 (实证 anchoring 优先于 LLM 训练频率默认). ' +
        'COMMUNITY_HINT 的 suggested chapters 作为 skeleton 候选 fallback (当 library 缺时). ' +
        '若 library 有 direct≥5 hits 的强匹配书, 以书的 chapter 为骨架; 若仅 prereq 命中, 取 prereq 概念作为本课时前导. ' +
        '禁忌: 跳过 prereq 书覆盖的前置概念 (e.g. 教 Spinoza 不教 substance Plato 出处 = Galileo-skip bug 复现).'
      );
    }
  }

  sections.push('');
  sections.push('Generate the lesson skeleton JSON.');
  return sections.join('\n');
}

function validatePlan(plan) {
  const errors = [];

  for (const k of REQUIRED_TOP_KEYS) {
    if (!(k in plan)) errors.push(`missing top-level key: ${k}`);
  }

  if (plan.path) {
    if (!Array.isArray(plan.path)) {
      errors.push('path must be an array');
    } else {
      plan.path.forEach((item, i) => {
        if (typeof item !== 'string') {
          errors.push(`path[${i}] must be a string, got ${typeof item}`);
        }
      });
    }
  }

  if (plan.micro_proof) {
    if (typeof plan.micro_proof !== 'object' || Array.isArray(plan.micro_proof)) {
      errors.push('micro_proof must be an object');
    } else {
      for (const k of REQUIRED_PROOF_KEYS) {
        if (!(k in plan.micro_proof)) errors.push(`micro_proof missing key: ${k}`);
        else if (typeof plan.micro_proof[k] !== 'string') errors.push(`micro_proof.${k} must be a string`);
      }
    }
  }

  if (plan.objective !== undefined && typeof plan.objective !== 'string') {
    errors.push('objective must be a string');
  }
  if (plan.hook_concrete !== undefined && typeof plan.hook_concrete !== 'string') {
    errors.push('hook_concrete must be a string');
  }
  if (plan.next_lesson_seed !== undefined && typeof plan.next_lesson_seed !== 'string') {
    errors.push('next_lesson_seed must be a string');
  }
  if (plan.prerequisite_check !== undefined && plan.prerequisite_check !== null && typeof plan.prerequisite_check !== 'string') {
    errors.push('prerequisite_check must be string or null');
  }

  return errors;
}

async function generatePlan({ goalContract, audience, learnerState, model = 'glm-5.1', timeBudgetMin = 30, maxRetries = 1, harvestContext = null } = {}) {
  if (!goalContract || typeof goalContract !== 'object') {
    throw new LLMProviderError('goalContract object is required');
  }

  const provider = getProvider();
  const userMessage = buildUserMessage({ goalContract, audience, learnerState, timeBudgetMin, harvestContext });

  let messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const plan = await provider.chat({
      messages,
      model,
      json: true,
      temperature: 0.7,
      maxTokens: 1500,
      timeoutMs: 90_000,
    });

    const errors = validatePlan(plan);
    if (errors.length === 0) {
      try {
        const j = jargonFirewall.checkJargon(JSON.stringify(plan));
        if (!j.passed) {
          console.warn('[jargon-firewall] %d violation(s) in plan:', j.violations.length, j.violations);
        }
      } catch (_) { /* monitor-only, never block */ }
      plan.assignment_level = assignment.computeAssignmentLevel(goalContract, learnerState, plan);
      return plan;
    }

    if (attempt < maxRetries) {
      const errorList = errors.map(e => '  - ' + e).join('\n');
      messages = [
        ...messages,
        { role: 'assistant', content: JSON.stringify(plan) },
        { role: 'user', content: `The previous output failed schema validation:\n${errorList}\n\nRegenerate with all 6 top-level keys present at root level. Strict adherence to the SCHEMA in the system prompt.` },
      ];
      continue;
    }

    throw new LLMProviderError(`Lesson skeleton failed schema validation after ${maxRetries + 1} attempts: ${errors.join('; ')}`);
  }
}

// =====================================================================
// Sub-step F — Lesson body generation from Skeleton (v0.1).
//
// ⚠ DEPRECATED v0.3 (2026-05-08). The 3-field static prose model
// (intro_prose / path_prose / closing_prose) is structurally wrong per
// BLUEPRINT §6.1 — a real lesson covers 12 fields THROUGH chat turns,
// not through static prose rendering. The v0.2 trust stack (Auditable
// Reasoning Summary) self-flagged intro_prose + closing_prose as
// "ornamentation" on production runs, confirming the diagnosis.
//
// The v0.3 replacement = LessonChat (NoteView.jsx) driven by:
//   - 8-state state-machine in app/lib/hypha-learn/state-machine.js
//   - app/prompts/learn-start.txt + learn-turn.txt (already shipped)
//   - turn-by-turn intercept by trust stack components
//
// Retained here only as the v0.2 transition surface for screen-lesson.jsx.
// DO NOT extend; bug fixes only.
//
// Per BLUEPRINT AMD-3+6: v0.1 only fields 4 + 11 (人话 prose + micro_proof
// inherits from plan). Fields 5-9 of v0.2+ schema (机制/术语/常见误解/Note
// 连接/Product Transfer) deferred — and per v0.3 pivot, not deferred to
// "later body generation" but to interactive chat coverage.

const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi'];

const BODY_SYSTEM_PROMPT = `You are a HYPHA lesson body writer. Given a 6-field Plan skeleton, expand to body prose for v0.1.

OUTPUT ONE JSON object (no prose outside JSON):
{
  "intro_prose": "1 paragraph introducing objective via hook_concrete",
  "path_prose": [
    { "step_id": "i", "prose": "..." },
    { "step_id": "ii", "prose": "..." }
  ],
  "closing_prose": "1 paragraph bridging next_lesson_seed back to objective"
}

STRUCTURE RULES (violation = output rejected):
- intro_prose: ≤120 words, 1 paragraph. MUST refer to a concrete artifact from hook_concrete. MUST relate to goalContract.main_creation if present.
- path_prose: array length MUST equal plan.path.length. step_id sequence MUST be exactly i, ii, iii, iv (lowercase Roman).
- Each path step prose: 1-2 sentences, ≤60 words. MUST give EITHER 1 concrete example OR 1 reflection question (not both).
- DO NOT introduce new concepts not in plan.
- DO NOT restate path[i] verbatim — paraphrase + concretize.
- closing_prose: ≤100 words, 1 paragraph. Bridge next_lesson_seed to current objective.

FORBIDDEN words (replace with domain term substitutes — use 助手 not agent, 模型不可用 — describe behavior instead):
EN: AI, LLM, embedding, model, prompt, agent, RAG, vector, fine-tune
ZH 流量词: 这一刀, 闭环, 拉满, 干货, 绝绝子, yyds, 王炸, 杀疯了, 直击灵魂

CONSTRAINTS:
- v0.1 frozen scope (per AMD-10): NO 机制解释 / 必要术语 / 常见误解 / Note 连接 / Product Transfer in body. Only 人话 prose.
- Tone: serif 学术 register, 不口语化, 不感叹号.
- 服务 north_star_goal first, main_creation second.`;

function buildBodyUserMessage({ plan, goalContract, audience, learnerState }) {
  return `PLAN: ${JSON.stringify(plan)}
GOAL_CONTRACT: ${JSON.stringify(goalContract || {})}
TARGET_AUDIENCE: ${audience || 'self-directed adult learner'}
LEARNER_STATE: ${JSON.stringify(learnerState || { known: [], unknown: [] })}

Generate the lesson body JSON.`;
}

function validateBody(body, expectedPathLength) {
  const errors = [];

  if (!body || typeof body !== 'object') {
    errors.push('body must be an object');
    return errors;
  }

  if (typeof body.intro_prose !== 'string' || body.intro_prose.length < 50) {
    errors.push(`intro_prose must be string >=50 chars (got ${typeof body.intro_prose}, len=${(body.intro_prose || '').length})`);
  }
  if (typeof body.closing_prose !== 'string' || body.closing_prose.length < 50) {
    errors.push(`closing_prose must be string >=50 chars (got ${typeof body.closing_prose}, len=${(body.closing_prose || '').length})`);
  }

  if (!Array.isArray(body.path_prose)) {
    errors.push('path_prose must be an array');
  } else {
    if (body.path_prose.length !== expectedPathLength) {
      errors.push(`path_prose length ${body.path_prose.length} != plan.path.length ${expectedPathLength}`);
    }
    body.path_prose.forEach((item, i) => {
      if (!item || typeof item !== 'object') {
        errors.push(`path_prose[${i}] must be an object`);
        return;
      }
      const expectedRoman = ROMAN[i];
      if (item.step_id !== expectedRoman) {
        errors.push(`path_prose[${i}].step_id "${item.step_id}" != expected "${expectedRoman}"`);
      }
      if (typeof item.prose !== 'string' || item.prose.length < 20) {
        errors.push(`path_prose[${i}].prose must be string >=20 chars`);
      }
    });
  }

  return errors;
}

async function generateLessonBody({ plan, goalContract, audience, learnerState, model = 'glm-5.1', maxRetries = 1 } = {}) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.path)) {
    throw new LLMProviderError('valid plan with path array is required');
  }
  if (!goalContract || typeof goalContract !== 'object') {
    throw new LLMProviderError('goalContract object is required');
  }

  const provider = getProvider();
  const userMessage = buildBodyUserMessage({ plan, goalContract, audience, learnerState });

  let messages = [
    { role: 'system', content: BODY_SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await provider.chat({
      messages,
      model,
      json: true,
      temperature: 0.7,
      maxTokens: 2000,
      timeoutMs: 90_000,
    });

    const errors = validateBody(result, plan.path.length);
    if (errors.length === 0) {
      try {
        const j = jargonFirewall.checkJargon(JSON.stringify(result));
        if (!j.passed) {
          console.warn('[jargon-firewall] %d violation(s) in body:', j.violations.length, j.violations);
        }
      } catch (_) { /* monitor-only */ }
      return { body: result };
    }

    if (attempt < maxRetries) {
      const errorList = errors.map(e => '  - ' + e).join('\n');
      messages = [
        ...messages,
        { role: 'assistant', content: JSON.stringify(result) },
        { role: 'user', content: `Body validation failed:\n${errorList}\n\nRegenerate strictly per the SCHEMA + STRUCTURE RULES.` },
      ];
      continue;
    }

    throw new LLMProviderError(`Lesson body failed schema validation after ${maxRetries + 1} attempts: ${errors.join('; ')}`);
  }
}

// =====================================================================
// Sub-step F.2 — KP seed generation (v0.3, pedagogy.md 2026-05-11 Layer 0 S3).
//
// For each lesson, produces an array of N knowledge-point seed objects
// (where N = target_count from agent.js:lessonSplit). Each seed is a
// lightweight stub that downstream lesson-body-generator.js:generateKPArc
// will expand into the 7+1 narrative arc fields per pedagogy.md Layer 4.
//
// Sibling to generatePlan (legacy 6-field skeleton, preserved). Migration
// Matrix dual-write: generatePlan output unchanged; the KP seed array is
// ADDITIONAL data on the skeleton preview payload — old lessons missing
// this field render as flat lesson NOTE per pedagogy.md Layer 6 fallback.

const KP_ARCHETYPE_HINTS = ['definition', 'mechanism', 'derivation', 'critique', 'example', 'distinction'];
const LINEAGE_RELATIONS = ['批判', '类比', '后续被反驳', '前驱', '共构'];

const KP_SEEDS_SYSTEM_PROMPT = `You are a HYPHA knowledge-point planner. Given a lesson plan + target KP count, output N atomic knowledge-point seeds.

OUTPUT — STRICT JSON:
{
  "knowledge_points": [
    {
      "id": "kp-1",
      "title": "5-12 字 / words — concrete concept name",
      "archetype_hint": "<one of: ${KP_ARCHETYPE_HINTS.join(' | ')}>",
      "lineage_link_seeds": [
        { "label": "prior thinker's concept name", "relation": "${LINEAGE_RELATIONS.join(' | ')}" }
      ]
    }
  ]
}

STRUCTURE RULES (violation = rejected):
- knowledge_points length MUST equal target_count exactly. NOT "around N", exactly N.
- id sequence: kp-1, kp-2, ..., kp-N. Strict order.
- title: name a SPECIFIC concept (e.g., "实体的自因属性"), NOT a phase ("Foundations") or generic ("Overview").
- archetype_hint: pick the dominant KP type. definition = formal naming, mechanism = HOW it works, derivation = follows-from-X-because-Y, critique = attacking prior position, example = concrete instance, distinction = X-vs-Y contrast.
- lineage_link_seeds: 0-3 entries. ONLY include if the KP genuinely depends on / responds to a prior thinker's concept. Empty array allowed for first-in-lineage KPs.

CONSTRAINTS:
- Service order: lesson.objective FIRST, then visual_archetype topology.
- For visual_archetype=DAG: titles should reflect inter-defining concepts (e.g., substance ↔ attribute ↔ mode).
- For visual_archetype=tree: titles should reflect parent-child hierarchy.
- For visual_archetype=timeline: titles should reflect temporal sequence.
- FORBIDDEN words: AI, LLM, embedding, model, prompt, agent, RAG, vector, fine-tune.
- AI-tell scrub: NO "这一刀" / "闭环" / "拉满" / "王炸" / "干货" / "直击灵魂" / "绝绝子" / "yyds".

Return STRICT JSON only. No preamble.`;

function validateKPSeeds(out, expectedCount) {
  const errors = [];
  if (!out || typeof out !== 'object') {
    errors.push('output must be an object');
    return errors;
  }
  if (!Array.isArray(out.knowledge_points)) {
    errors.push('knowledge_points must be array');
    return errors;
  }
  if (out.knowledge_points.length !== expectedCount) {
    errors.push(`knowledge_points length ${out.knowledge_points.length} ≠ expected ${expectedCount}`);
  }
  out.knowledge_points.forEach((kp, i) => {
    if (!kp || typeof kp !== 'object') {
      errors.push(`knowledge_points[${i}]: must be object`);
      return;
    }
    if (typeof kp.id !== 'string' || !/^kp-\d+$/.test(kp.id)) {
      errors.push(`knowledge_points[${i}].id: must match /^kp-\\d+$/, got ${kp.id}`);
    } else if (kp.id !== `kp-${i + 1}`) {
      errors.push(`knowledge_points[${i}].id: expected kp-${i + 1}, got ${kp.id}`);
    }
    if (typeof kp.title !== 'string' || kp.title.length < 2 || kp.title.length > 80) {
      errors.push(`knowledge_points[${i}].title: must be 2-80 char string`);
    }
    if (!KP_ARCHETYPE_HINTS.includes(kp.archetype_hint)) {
      errors.push(`knowledge_points[${i}].archetype_hint: must be one of ${KP_ARCHETYPE_HINTS.join('|')}, got ${kp.archetype_hint}`);
    }
    if (!Array.isArray(kp.lineage_link_seeds)) {
      errors.push(`knowledge_points[${i}].lineage_link_seeds: must be array (use [] if none)`);
    } else {
      if (kp.lineage_link_seeds.length > 3) {
        errors.push(`knowledge_points[${i}].lineage_link_seeds: max 3 entries, got ${kp.lineage_link_seeds.length}`);
      }
      kp.lineage_link_seeds.forEach((seed, j) => {
        if (!seed || typeof seed.label !== 'string' || typeof seed.relation !== 'string') {
          errors.push(`knowledge_points[${i}].lineage_link_seeds[${j}]: must have {label, relation} strings`);
        } else if (!LINEAGE_RELATIONS.includes(seed.relation)) {
          errors.push(`knowledge_points[${i}].lineage_link_seeds[${j}].relation: must be one of ${LINEAGE_RELATIONS.join('|')}, got ${seed.relation}`);
        }
      });
    }
  });
  return errors;
}

/**
 * Generate N knowledge-point seeds for one lesson.
 *
 * @param {object} args
 * @param {object} args.lessonPlan — 6-field skeleton from generatePlan
 * @param {number} args.targetCount — N from agent.js:lessonSplit target_counts[i]
 * @param {'tree'|'DAG'|'timeline'|'matrix'|'flat'} [args.visualArchetype='DAG']
 * @param {string} [args.pedagogicalArchetype] — Layer 3 archetype (LANG-ACQ etc.)
 * @param {string} [args.userIntent] — 考研 | 兴趣 | 论文 | 复盘
 * @param {string} [args.model='glm-5.1']
 * @param {number} [args.maxRetries=1]
 * @returns {Promise<{ knowledge_points: Array<{id, title, archetype_hint, lineage_link_seeds}> }>}
 */
async function generateKPSeeds({
  lessonPlan,
  targetCount,
  visualArchetype = 'DAG',
  pedagogicalArchetype = null,
  userIntent = null,
  model = 'glm-5.1',
  maxRetries = 1,
  signal = null,                        // MEOW v6 fix — AbortSignal threading
} = {}) {
  if (!lessonPlan || typeof lessonPlan !== 'object') {
    throw new LLMProviderError('lessonPlan object required');
  }
  if (!Number.isFinite(targetCount) || targetCount < 1 || targetCount > 12) {
    throw new LLMProviderError(`targetCount must be 1-12, got ${targetCount}`);
  }
  if (signal && signal.aborted) {
    // MEOW v7 fix — propagate as CURRICULUM_CANCELLED so the outer
    // _runHarvestAndSkeleton catch (which only matches err.code === 'CURRICULUM_CANCELLED')
    // routes abort to the cancellation branch instead of generic failure.
    throw Object.assign(new LLMProviderError('aborted before first attempt'), { code: 'CURRICULUM_CANCELLED' });
  }

  const provider = getProvider();
  const userMessage = `LESSON PLAN:
  objective: ${lessonPlan.objective || ''}
  hook_concrete: ${(lessonPlan.hook_concrete || '').slice(0, 200)}
  path: ${JSON.stringify(lessonPlan.path || []).slice(0, 500)}

TARGETS:
  target KP count: ${targetCount}
  visual_archetype: ${visualArchetype}
  pedagogical_archetype: ${pedagogicalArchetype || '(unspecified)'}
  user_intent: ${userIntent || '(unspecified)'}

Generate the knowledge_points JSON now. EXACTLY ${targetCount} entries.`;

  let messages = [
    { role: 'system', content: KP_SEEDS_SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal && signal.aborted) {
      throw Object.assign(new LLMProviderError(`aborted before attempt ${attempt + 1}`), { code: 'CURRICULUM_CANCELLED' });
    }
    // Pass signal through to provider.chat. Legacy providers that ignore it
    // still work; new path uses it to cancel in-flight HTTP. Either way,
    // pre-/post-loop checks above & below stop the retry chain immediately.
    const result = await provider.chat({
      messages,
      model,
      json: true,
      temperature: 0.4,
      maxTokens: 1500,
      timeoutMs: 60_000,
      signal,
    });

    if (signal && signal.aborted) {
      throw Object.assign(new LLMProviderError(`aborted after attempt ${attempt + 1}`), { code: 'CURRICULUM_CANCELLED' });
    }

    const errors = validateKPSeeds(result, targetCount);
    if (errors.length === 0) return result;

    if (attempt < maxRetries) {
      messages = [
        ...messages,
        { role: 'assistant', content: JSON.stringify(result) },
        { role: 'user', content: `Validation failed:\n${errors.map(e => '  - ' + e).join('\n')}\n\nRegenerate strictly. EXACTLY ${targetCount} entries with kp-1..kp-${targetCount} ids.` },
      ];
      continue;
    }
    throw new LLMProviderError(`generateKPSeeds failed validation after ${maxRetries + 1} attempts: ${errors.join('; ')}`);
  }
}

module.exports = {
  generatePlan,
  generateLessonBody,
  validatePlan,
  validateBody,
  validateEvidenceLedger,
  REQUIRED_TOP_KEYS,
  EVIDENCE_TYPES,
  HARD_EVIDENCE_TYPES,
  CONFIDENCE_LEVELS,
  VERIFIABILITY_LEVELS,
  RISK_LEVELS,
  EVIDENCE_LEDGER_SCHEMA_DESCRIPTION,
  // v0.3 Phase B / pedagogy.md 2026-05-11 Layer 0 S3 — KP seed sibling
  generateKPSeeds,
  validateKPSeeds,
  KP_ARCHETYPE_HINTS,
  LINEAGE_RELATIONS,
};
