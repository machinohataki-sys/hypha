'use strict';

// HYPHA · W7.1 Pack Learning Operations (BLUEPRINT §12.4).
//
// The 6 user-facing verbs a learner runs on a community Pack:
//   1. previewPack       — 10-second go/no-go decision
//   2. quickLearn        — 15-25 min compressed walk-through
//   3. deepLearn         — multi-lesson plan (wraps W3.x designSequence)
//   4. applyPack         — bind Pack content to the user's current problem
//   5. forkAndRewrite    — branch a new Pack draft the user owns
//   6. transferToProduct — push insight into the user's Product Pool (W3.3)
//
// Theory-ship constraints (from the task brief):
//   - All LLM calls are MOCKED. We return deterministic, structurally-real
//     payloads so downstream surfaces (Pack Detail screen, parking-queue
//     revival, study-note appender) can wire against the locked shape.
//   - We DO NOT modify W3.3 / W3.4 / W5.1 / W5.2 / W6.5 — only import + call.
//   - transferToProduct is the only verb that dispatches into another wave.
//
// Each operation returns a payload + writes a journal entry (delegated to
// the state-machine module). Operations do not mutate the pack itself —
// the only operation that creates a NEW pack file is `forkAndRewrite`, and
// even that writes a DRAFT under `vault/.hypha/pack-forks/` rather than
// touching the canonical `commons/packs/<id>/pack.json`.

const path = require('node:path');
const sm = require('./state-machine');

// Optional, lazy-loaded peers — the lib stays usable in lean tests where
// these waves are absent. Failure to load is non-fatal; the operation that
// would have used the peer either degrades to a mock payload or fails with
// a typed error rather than throwing an unrelated MODULE_NOT_FOUND.
function _loadPIC() {
  try { return require('../commons/pack-intelligence-card'); }
  catch (_) { return null; }
}
function _loadTransfer() {
  try { return require('../product-transfer'); }
  catch (_) { return null; }
}

// ─── 1. Preview ─────────────────────────────────────────────────────────────
//
// Fast triage: render the PIC's primary_value + fit signal + a 10-second
// "should you spend time on this now?" verdict. No state transition here —
// preview is read-only by spec. The caller decides whether to follow up with
// `transitionPackState(pack.id, 'Imported', 'Previewed', ...)`.

/**
 * @param {object} pack             pack.json shape from community.js
 * @param {object} [userContext]    { goal, currentLesson, masteryMap, products }
 * @returns {{summary, fit_check, decision_10s}}
 */
function previewPack(pack, userContext = {}) {
  if (!pack || !pack.topic) {
    throw new Error('previewPack: pack.topic required');
  }
  const PIC = _loadPIC();
  const card = PIC ? PIC.generateCard(pack, userContext) : null;
  const summary = card
    ? `${pack.topic} · ${card.primary_value}`
    : `${pack.topic} · 候选包, 暂未生成 intelligence card`;

  // Fit check — 4 explicit signals over the pack/userContext pair. Each is
  // either 'hit' | 'miss' | 'unknown'. UI renders as a 4-pill row.
  const fitCheck = {
    goal_match:        _fitGoal(pack, userContext),
    lesson_relevance:  _fitLesson(pack, userContext),
    difficulty_fit:    card ? `难度 ${card.difficulty_level}` : 'unknown',
    safety:            card ? `安全 ${card.safety_level}` : 'unknown',
  };

  // 10s decision — deterministic verdict, no LLM. Three buckets:
  //   accept-now / park-for-later / not-for-you
  // Threshold logic mirrors the PIC ranker philosophy: goal + lesson hits
  // dominate; quality / safety act as veto.
  const hits = (fitCheck.goal_match === 'hit' ? 1 : 0)
             + (fitCheck.lesson_relevance === 'hit' ? 1 : 0);
  const qScore = card ? Number(card.quality_score) || 0 : 0;
  const isUnsafe = card && (card.safety_level === 'unsafe' || card.safety_level === 'blocked');
  let decision;
  if (isUnsafe) {
    decision = 'not-for-you';
  } else if (hits >= 1 && qScore >= 40) {
    decision = 'accept-now';
  } else if (qScore >= 30) {
    decision = 'park-for-later';
  } else {
    decision = 'not-for-you';
  }

  return {
    summary,
    fit_check: fitCheck,
    decision_10s: decision,
    _intelligence_card: card,
  };
}

function _fitGoal(pack, userContext) {
  const t = String(pack.topic || '').toLowerCase();
  const g = String(userContext && userContext.goal || '').toLowerCase();
  if (!t || !g) return 'unknown';
  return (g.includes(t) || t.includes(g)) ? 'hit' : 'miss';
}
function _fitLesson(pack, userContext) {
  const lt = String(userContext && userContext.currentLesson && userContext.currentLesson.topic || '').toLowerCase();
  const t = String(pack.topic || '').toLowerCase();
  if (!lt || !t) return 'unknown';
  return (lt.includes(t) || t.includes(lt)) ? 'hit' : 'miss';
}

// ─── 2. Quick Learn ─────────────────────────────────────────────────────────
//
// 15-25 minute compressed pass: extract core value + key concepts + the one
// mechanism, plus 1-3 action items. Deterministic mock — real W7.2 pipeline
// will swap with executeChat('T6_STRONG', ...).

/**
 * @param {object} pack
 * @param {object} [options]   { timeBudgetMin: number, focus: 'core' | 'mechanism' | 'actions' }
 * @returns {{core_value, key_concepts, mechanism, action_items, time_estimate_min}}
 */
function quickLearn(pack, options = {}) {
  if (!pack || !pack.topic) {
    throw new Error('quickLearn: pack.topic required');
  }
  const timeBudget = Math.max(15, Math.min(25, Number(options.timeBudgetMin) || 20));

  // Key concepts: prefer the top-of-syllabus KP candidates (they are the
  // pack curator's own "front door"). Fall back to the topic itself when
  // the syllabus is missing.
  const syllabus = Array.isArray(pack.syllabus_skeleton) ? pack.syllabus_skeleton : [];
  const firstChapter = syllabus[0] || {};
  const keyConcepts = Array.isArray(firstChapter.kp_candidates)
    ? firstChapter.kp_candidates.slice(0, 5)
    : [pack.topic];

  const mechanism = pack.lang === 'zh'
    ? `${pack.topic} 的核心机理 — 通过 ${syllabus.length || '若干'} 章 skeleton 串联, 锚在 ${(pack.recommended_sources || []).length || 'curator 推荐'} 一手源.`
    : `${pack.topic} core mechanism — ${syllabus.length || 'few'}-chapter skeleton anchored on ${(pack.recommended_sources || []).length || 'curator-selected'} primary source(s).`;

  const actionItems = [
    `把 ${pack.topic} 的 ${keyConcepts[0] || '入口'} 套用到当前 lesson 的一处例子`,
    `挑一条 contested question 写 50 字立场`,
    `在 study note 记一条 "如果用我的语言重写, 标题会是什么"`,
  ].filter(Boolean);

  return {
    core_value: pack.lang === 'zh'
      ? `${pack.topic} — 用 ${timeBudget} 分钟跑过 curator 的骨架, 抓 1 条机理 + 3 个动作`
      : `${pack.topic} — ${timeBudget}-minute pass over curator skeleton, surfacing 1 mechanism + 3 actions`,
    key_concepts: keyConcepts,
    mechanism,
    action_items: actionItems,
    time_estimate_min: timeBudget,
    _generated_at: new Date().toISOString(),
    _llm_source: 'mock-v0.1', // real call → executeChat('T6_STRONG', ...)
  };
}

// ─── 3. Deep Learn ──────────────────────────────────────────────────────────
//
// Multi-lesson plan. Real call should wrap W3.x designSequence (agent.js),
// but per task brief we mock that here. Returns a lesson plan shape that
// renderer + future agent wrap can both consume.

/**
 * @param {object} pack
 * @param {object} [options]   { lessons?: number, masteryMap?: object }
 * @returns {{plan, lessons[], _meta}}
 */
function deepLearn(pack, options = {}) {
  if (!pack || !pack.topic) {
    throw new Error('deepLearn: pack.topic required');
  }
  const syllabus = Array.isArray(pack.syllabus_skeleton) ? pack.syllabus_skeleton : [];
  const requested = Number(options.lessons) || 0;
  const N = requested > 0
    ? Math.min(12, Math.max(3, requested))
    : Math.min(8, Math.max(3, syllabus.length || 4));

  const lessons = [];
  for (let i = 0; i < N; i++) {
    const chapter = syllabus[i] || {};
    const title = chapter.chapter || `${pack.topic} — Lesson ${i + 1}`;
    const kps = Array.isArray(chapter.kp_candidates) ? chapter.kp_candidates : [];
    lessons.push({
      idx: i,
      title,
      learn_goal: pack.lang === 'zh'
        ? `掌握 ${title} 的最小可迁移单元`
        : `Acquire the smallest transferable unit of ${title}`,
      kp_candidates: kps.slice(0, 4),
      estimated_min: 25 + (kps.length >= 3 ? 10 : 0),
      pack_id: pack.id || null,
    });
  }

  return {
    plan: {
      pack_id: pack.id || null,
      topic: pack.topic,
      total_lessons: lessons.length,
      cadence_hint: lessons.length <= 5 ? 'sprint' : 'multi-week',
    },
    lessons,
    _meta: {
      generated_at: new Date().toISOString(),
      llm_source: 'mock-v0.1', // real → wrap agent.js designSequence(pack-derived)
      design_basis: syllabus.length ? 'pack_syllabus_skeleton' : 'topic_only_fallback',
    },
  };
}

// ─── 4. Apply Pack ──────────────────────────────────────────────────────────
//
// "Use this pack on this problem right now." Returns an applied-solution
// markdown blob + evidence links back into the pack's recommended_sources.
// State machine hand-off: caller is expected to transition Understood →
// Applied AFTER this returns ok.

/**
 * @param {object} pack
 * @param {object} currentProblem   { description, slug?, lessonIdx?, kpId? }
 * @returns {{applied_solution, evidence_links, _meta}}
 */
function applyPack(pack, currentProblem = {}) {
  if (!pack || !pack.topic) {
    throw new Error('applyPack: pack.topic required');
  }
  if (!currentProblem || !currentProblem.description) {
    throw new Error('applyPack: currentProblem.description required');
  }
  const sources = Array.isArray(pack.recommended_sources) ? pack.recommended_sources : [];
  const evidenceLinks = sources.slice(0, 5).map((s, i) => ({
    idx: i,
    title: s.title || s.url || `source-${i}`,
    url: s.url || null,
    type: s.type || 'unknown',
    reason: s.reason || null,
  }));

  const applied = [
    `## ${pack.topic} 应用到当前问题`,
    '',
    `**问题**: ${currentProblem.description}`,
    '',
    pack.lang === 'zh'
      ? `**Pack 的角度**: ${pack.topic} 的 frontier 把这类问题归到 ${(pack.syllabus_skeleton && pack.syllabus_skeleton[0] && pack.syllabus_skeleton[0].chapter) || '主章节'} 节; 关键移动 = 抓 ${(pack.contested_questions && pack.contested_questions[0]) || '核心争议'}, 再把它 collapse 到一句能解释当前案例的话.`
      : `**Pack lens**: ${pack.topic} situates this within "${(pack.syllabus_skeleton && pack.syllabus_skeleton[0] && pack.syllabus_skeleton[0].chapter) || 'core chapter'}"; the move is to grasp "${(pack.contested_questions && pack.contested_questions[0]) || 'core contested question'}" and collapse it onto the present case.`,
    '',
    '**下一步**: 把 evidence 链接里的 1-2 条原文打开, 在 study-note 写下 "如果不用 pack 的话怎么解 — 用 pack 后差在哪".',
  ].join('\n');

  return {
    applied_solution: applied,
    evidence_links: evidenceLinks,
    _meta: {
      generated_at: new Date().toISOString(),
      llm_source: 'mock-v0.1', // real → executeChat('T6_STRONG', ...) with current problem context
      slug: currentProblem.slug || null,
      lessonIdx: currentProblem.lessonIdx != null ? Number(currentProblem.lessonIdx) : null,
      kpId: currentProblem.kpId || null,
    },
  };
}

// ─── 5. Fork & Rewrite ──────────────────────────────────────────────────────
//
// Branch a NEW pack draft owned by the user. Original pack is untouched.
// The draft writes under `vault/.hypha/pack-forks/<new_pack_id>/draft.json`
// — the canonical commons packs dir is read-only by design.
//
// License check: only forks of CC-BY / CC0 / curator-marked-forkable packs
// are auto-greenlit. Per BLUEPRINT commons license layer, the renderer is
// expected to surface the license to the user BEFORE calling — this fn does
// the structural fork; license enforcement is W6.5 territory.

const fs = require('node:fs');
const os = require('node:os');

function _vaultRoot() {
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) return process.env.HYPHA_DATA;
  if (process.env.HYPHA_VAULT_DIR && fs.existsSync(process.env.HYPHA_VAULT_DIR)) return process.env.HYPHA_VAULT_DIR;
  return path.join(__dirname, '..', '..', '..', 'data');
}

/**
 * @param {object} pack
 * @param {object} [options]   { newTopic?, userNotes?, authorTag? }
 * @returns {{draft_id, draft_path, draft_pack}}
 */
function forkAndRewrite(pack, options = {}) {
  if (!pack || !pack.topic) {
    throw new Error('forkAndRewrite: pack.topic required');
  }
  const baseId = pack.id || pack.topic.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const draftId = `${baseId}--fork-${ts}`;
  const root = _vaultRoot();
  const forkDir = path.join(root, '.hypha', 'pack-forks', draftId);
  fs.mkdirSync(forkDir, { recursive: true });

  const draftPack = Object.assign({}, pack, {
    id: draftId,
    topic: options.newTopic || `${pack.topic} — 我的改写`,
    curator: options.authorTag || 'user-fork',
    ratified_by: [],
    ratified_at: null,
    forked_from: { id: pack.id || null, version: pack.version || null, topic: pack.topic },
    fork_notes: options.userNotes || '',
    fork_created_at: new Date().toISOString(),
    deprecated: false,
  });

  const draftPath = path.join(forkDir, 'draft.json');
  const tmp = draftPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(draftPack, null, 2), 'utf8');
  fs.renameSync(tmp, draftPath);

  return {
    draft_id: draftId,
    draft_path: draftPath,
    draft_pack: draftPack,
  };
}

// ─── 6. Transfer to Product ─────────────────────────────────────────────────
//
// Dispatch into W3.3 product-transfer.js. We DO NOT reimplement transfer
// scoring — only adapt the pack into a synthetic "lessonKP" payload that
// W3.3 can score against the user's productBlueprint.

/**
 * @param {object} pack
 * @param {string} slug         vault/<slug>/ product folder to write into
 * @param {object} [options]    { productBlueprint? — pre-loaded, else W3.3 fetches }
 * @returns {{routed_to, transfer_result, _meta}}
 */
function transferToProduct(pack, slug, options = {}) {
  if (!pack || !pack.topic) {
    throw new Error('transferToProduct: pack.topic required');
  }
  if (!slug || typeof slug !== 'string') {
    throw new Error('transferToProduct: slug required');
  }
  const transfer = _loadTransfer();
  if (!transfer || typeof transfer.computeRelevance !== 'function') {
    // Lib not loadable — return a structural mock so renderer can wire the
    // surface today. The mock is shaped exactly like the real return.
    return {
      routed_to: { slug, section: 'general', via: 'mock' },
      transfer_result: {
        P: 0.5,
        evidence: [],
        suggested_section: 'general',
        fired: false,
        _mock: true,
      },
      _meta: { generated_at: new Date().toISOString(), llm_source: 'mock-v0.1' },
    };
  }

  // Adapt the pack into the shape product-transfer expects.
  const syllabus0 = (pack.syllabus_skeleton && pack.syllabus_skeleton[0]) || {};
  const lessonKP = {
    title: pack.topic,
    canonical_example: (syllabus0.kp_candidates && syllabus0.kp_candidates[0]) || pack.topic,
    thesis: (Array.isArray(pack.contested_questions) && pack.contested_questions[0]) || '',
    definition: syllabus0.chapter || pack.topic,
  };
  const productBlueprint = options.productBlueprint || { sections: {} };
  const lessonContext = {
    learnGoal: options.learnGoal || pack.topic,
    lessonTitle: options.lessonTitle || pack.topic,
  };

  let scored;
  try {
    scored = transfer.computeRelevance({ lessonKP, productBlueprint, lessonContext });
  } catch (err) {
    return {
      routed_to: { slug, section: 'general', via: 'error' },
      transfer_result: { P: 0, evidence: [], suggested_section: 'general', error: err.message, fired: false },
      _meta: { generated_at: new Date().toISOString(), llm_source: 'mock-v0.1' },
    };
  }
  const fired = typeof transfer.shouldTriggerTransfer === 'function'
    ? transfer.shouldTriggerTransfer(scored.P)
    : (scored.P >= 0.6);

  return {
    routed_to: { slug, section: scored.suggested_section || 'general', via: 'w3.3' },
    transfer_result: Object.assign({}, scored, { fired }),
    _meta: { generated_at: new Date().toISOString(), llm_source: 'mock-v0.1' },
  };
}

module.exports = {
  previewPack,
  quickLearn,
  deepLearn,
  applyPack,
  forkAndRewrite,
  transferToProduct,
  // Re-export state-machine surface for callers that prefer a single import.
  PACK_LEARNING_STATES: sm.PACK_LEARNING_STATES,
  getValidTransitions: sm.getValidTransitions,
  transitionPackState: sm.transitionPackState,
};
