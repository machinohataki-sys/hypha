'use strict';

// HYPHA · W1.5 Finish Ritual — 4-stage state machine (v0.1).
//
// Per BLUEPRINT §9.2 the "完成记录" button is NOT a save button — it is a
// MODE-SWITCH from Capture → Deepen. The full pipeline:
//
//   Capture Mode
//   → 点击完成记录
//   → 汇总草稿        (Stage 1 — aggregateDrafts)
//   → 汇总标记
//   → 合并相似标记     (within Stage 1, ≤60s same-mark_type collapse)
//   → 并行 Deepen     (Stage 2 — parallelDeepen, T4_JUDGE)
//   → 用户先写一句核心理解  (Stage 3 — Human First, Agent Second blocker)
//   → 生成正式 Lesson Note (Stage 4 — generateLessonNote via lesson-note lib)
//   → 生成轻量学习证明   (Stage 4 — evidence ledger, minimal v0.1)
//   → 检测 Product Transfer (Stage 4 — W3.3 hook, fires when 🧩 marks present)
//   → 更新 Mastery Map  (Stage 4 — TODO, deferred to W4)
//   → 进入 Web Note Engine  (W5.2 — downstream, handled by caller)
//
// The principle: **上课时只捕捉，课后才加工。完成记录不是结束，而是深化开始。**
//
// Surgical scope: this module owns Stages 1+2+3 fully, and orchestrates
// Stage 4 by *reusing* lesson-note.depositLessonNote — we never reimplement
// the lesson-note writer here. The 11-field LESSON BRIEF pipeline lives in
// lesson-body-generator.js; Capture → Finish Ritual is a separate ingestion
// path that produces a lighter-weight payload (no Quality Harness, no
// Anti-Slop loop yet — those are deferred to v0.4+ per BLUEPRINT §24 P0).

const fs = require('fs');
const path = require('path');
const capture = require('./capture-mode');
const lessonNote = require('./lesson-note');

const VAULT_ROOT_DEFAULT = path.resolve(__dirname, '..', '..', 'vault');
function vaultRoot() {
  return process.env.HYPHA_VAULT_ROOT || VAULT_ROOT_DEFAULT;
}

// Within-mark-type merge window. Two entries of the same mark_type that fall
// within this many milliseconds of each other are merged into one aggregated
// draft. Per BLUEPRINT §9.2 the operation is "合并相似标记" — we read that as
// same glyph + temporal proximity, not semantic clustering (semantic merge
// would need an embedding step, deferred to v0.4+ Web Note Engine).
const MERGE_WINDOW_MS = 60_000;

// ============================================================
// Stage 1 — aggregateDrafts
// ============================================================
//
// Input: a closed sessionId.
// Output: { drafts: [{ id, type, mark_type?, text, source_seqs[], earliest_offset_ms,
//                       latest_offset_ms, count }], manifest, source_entries }
//
// Algorithm:
//   1. Read raw.jsonl in seq order.
//   2. quick_note + deepen_now entries pass through 1:1 (no merge).
//   3. For each mark entry, walk back through the current drafts list and
//      look for the most recent draft of the same mark_type whose
//      latest_offset_ms is within MERGE_WINDOW_MS. If found, merge: concat
//      text with "\n", extend source_seqs, bump latest_offset_ms + count.
//      Else, push a new draft.
//
// This is intentionally a *local* merge (latest neighbor only). Greedy
// global merge would risk lassoing unrelated streaks together.
function aggregateDrafts(sessionId) {
  const { manifest, entries } = capture.readSession(sessionId);
  const drafts = [];
  let nextId = 1;
  for (const e of entries) {
    if (e.type === 'mark') {
      // Find most-recent draft of same mark_type within merge window.
      let merged = false;
      for (let i = drafts.length - 1; i >= 0; i--) {
        const d = drafts[i];
        if (d.type !== 'mark' || d.mark_type !== e.mark_type) continue;
        if ((e.timestamp_offset_ms || 0) - d.latest_offset_ms <= MERGE_WINDOW_MS) {
          // Merge in place.
          d.text = (d.text ? d.text + '\n' : '') + (e.text || '');
          d.source_seqs.push(e.seq);
          d.latest_offset_ms = Math.max(d.latest_offset_ms, e.timestamp_offset_ms || 0);
          d.count += 1;
          merged = true;
        }
        // Whether we merged or not, stop the walkback at the first same-type
        // candidate — older ones are further away in time.
        break;
      }
      if (!merged) {
        drafts.push({
          id: `draft-${nextId++}`,
          type: 'mark',
          mark_type: e.mark_type,
          text: e.text || '',
          source_seqs: [e.seq],
          earliest_offset_ms: e.timestamp_offset_ms || 0,
          latest_offset_ms: e.timestamp_offset_ms || 0,
          count: 1,
        });
      }
    } else {
      drafts.push({
        id: `draft-${nextId++}`,
        type: e.type,
        mark_type: null,
        text: e.text || '',
        source_seqs: [e.seq],
        earliest_offset_ms: e.timestamp_offset_ms || 0,
        latest_offset_ms: e.timestamp_offset_ms || 0,
        count: 1,
      });
    }
  }
  return { drafts, manifest, source_entries: entries };
}

// ============================================================
// Stage 2 — parallelDeepen
// ============================================================
//
// For each draft, fire a deepen pass. The deepen *strategy* depends on type:
//   - mark "?":   resolve confusion (one paragraph, no exam tone)
//   - mark "!":   compress the importance into one sentence + why
//   - mark "↗":   produce a follow-up question pair, no answers
//   - mark "⚡":  surface the cross-domain bridge (Spark)
//   - mark "×":   sharpen the contradiction, name both sides
//   - mark "→":   restate as a concrete action item (verb + object + deadline)
//   - mark "🔗":  name the prior-knowledge anchor and the relation type
//   - mark "🧩":  emit a Product Transfer trigger payload (W3.3 hook)
//   - quick_note: pass through (no deepen)
//   - deepen_now: pass through (was already deepened live, 30s answer)
//
// The actual T4_JUDGE call is a TODO — for v0.1 surface we mock the deepen
// output deterministically from the input text so the rest of the pipeline
// is end-to-end testable without a network round-trip.

const DEEPEN_STRATEGY = {
  '?':  { label: '不懂', kind: 'resolve_confusion' },
  '!':  { label: '重要', kind: 'compress_importance' },
  '↗': { label: '深化', kind: 'followup_questions' },
  '⚡': { label: 'Spark', kind: 'cross_domain_bridge' },
  '×': { label: '反驳', kind: 'sharpen_contradiction' },
  '→': { label: '行动', kind: 'action_item' },
  '🔗': { label: '连接', kind: 'prior_anchor' },
  '🧩': { label: '迁移', kind: 'product_transfer' },
};

async function parallelDeepen(aggregatedMarks, ctx = {}) {
  if (!Array.isArray(aggregatedMarks)) {
    throw Object.assign(new Error('aggregatedMarks must be array'), { code: 'BAD_INPUT' });
  }
  // Parallel via Promise.all — each deepen is independent, no cross-talk.
  const settled = await Promise.all(
    aggregatedMarks.map(async (draft) => {
      try {
        const deepened = await deepenOne(draft, ctx);
        return { ...draft, deepened, deepen_error: null };
      } catch (err) {
        // Surgical: a single deepen failure must NOT poison the whole ritual.
        // Surface error per-draft, keep going.
        return { ...draft, deepened: null, deepen_error: err.message || String(err) };
      }
    })
  );
  return settled;
}

async function deepenOne(draft, ctx) {
  if (draft.type === 'quick_note' || draft.type === 'deepen_now') {
    // Pass-through — no deepen needed.
    return {
      strategy: 'passthrough',
      kind: draft.type,
      text: draft.text,
      product_transfer: null,
    };
  }
  const strat = DEEPEN_STRATEGY[draft.mark_type];
  if (!strat) {
    return {
      strategy: 'unknown_mark',
      kind: null,
      text: draft.text,
      product_transfer: null,
    };
  }
  // intentional-placeholder: T4_JUDGE deepen LLM call is W1.5 scope-out per
  // user task brief ("T4_JUDGE deepen 留 TODO mock"). Replace this mock with
  // `executeChat('T4_JUDGE', { messages: [...] })` from app/lib/llm/router.js
  // once the per-strategy prompt templates land. Prompt template should be
  // per-strategy, with the lesson context (ctx.goalContract.north_star_goal)
  // as anchor and a strict 1-paragraph output cap. Keep this contract —
  // drafts in, deepened text out — so the swap is one-line.
  const mockedText = mockDeepen(strat.kind, draft.text);
  const productTransfer = (strat.kind === 'product_transfer')
    ? buildProductTransferTrigger(draft, ctx)
    : null;
  return {
    strategy: strat.kind,
    kind: strat.kind,
    text: mockedText,
    product_transfer: productTransfer,
  };
}

// Deterministic mock — keeps test surface stable without LLM. Marks the
// output with [MOCK] so any leak into production is loud, not silent.
function mockDeepen(kind, raw) {
  const prefix = '[MOCK · ' + kind + '] ';
  const body = (raw || '').trim().slice(0, 800);
  return prefix + (body || '(no body captured — deepen would resolve from lesson context)');
}

// W3.3 Product Transfer hook payload — fired when user marks 🧩 during
// capture. The downstream Product Pool (System 4) consumes this; v0.1 we
// only build the payload + emit it as part of the ritual result.
function buildProductTransferTrigger(draft, ctx) {
  return {
    source: 'capture',
    seqs: draft.source_seqs,
    text: draft.text,
    captured_at_offset_ms: draft.earliest_offset_ms,
    goal_anchor: (ctx && ctx.goalContract && ctx.goalContract.main_creation) || null,
    // W3.3 consumer will set status to 'pending_review'.
    status: 'pending_review',
  };
}

// ============================================================
// Stage 3 — userCoreUnderstandingFirst
// ============================================================
//
// Human First, Agent Second. The user MUST write their own one-sentence
// summary before the system writes the official lesson note. This is the
// load-bearing guard against passive consumption.
//
// We validate trim length + that it isn't a copy-paste of the captured
// text. Hard rules:
//   - non-empty, after trim ≥ 8 chars
//   - cap at 500 chars (one sentence; longform belongs in body)
//   - not equal (case-fold) to any single captured entry text
function userCoreUnderstandingFirst(sessionId, userCoreUnderstanding) {
  const s = (typeof userCoreUnderstanding === 'string') ? userCoreUnderstanding.trim() : '';
  if (s.length < 8) {
    throw Object.assign(new Error('userCoreUnderstanding must be at least 8 chars after trim'), { code: 'TOO_SHORT' });
  }
  if (s.length > 500) {
    throw Object.assign(new Error('userCoreUnderstanding must be ≤ 500 chars (one sentence)'), { code: 'TOO_LONG' });
  }
  // Anti-paste check: read the session and verify the line isn't a verbatim
  // copy of any captured entry text. We allow partial overlap (quoting a
  // mark is fine) — we only reject identical equality.
  let dupSeq = null;
  try {
    const { entries } = capture.readSession(sessionId);
    const norm = (t) => (t || '').trim().toLowerCase();
    const target = norm(s);
    for (const e of entries) {
      if (norm(e.text) === target) {
        dupSeq = e.seq;
        break;
      }
    }
  } catch (_) { /* session-read failure non-fatal here */ }
  if (dupSeq) {
    throw Object.assign(new Error(`userCoreUnderstanding duplicates capture seq ${dupSeq} verbatim — write your own sentence`), { code: 'DUPLICATE_CAPTURE' });
  }
  return { ok: true, normalized: s };
}

// ============================================================
// Stage 4 — generateLessonNote
// ============================================================
//
// Compose a depositLessonNote payload from the deepened drafts + user core
// understanding, then call lesson-note (DON'T reimplement). The shape mirrors
// what designLesson would have produced, minus the Quality Harness layers.

function buildLessonPlanFromCapture(deepened, userCore, ctx) {
  const goal = (ctx && ctx.goalContract) || {};
  const sourceLabel = (ctx && ctx.captureSource) ? ` (${ctx.captureSource})` : '';
  const objective = `Live capture · ${userCore.slice(0, 60)}${userCore.length > 60 ? '…' : ''}`;
  // Path: extract from deepened marks in order — each mark becomes a step.
  const pathSteps = deepened
    .filter(d => d.type === 'mark' && d.deepened && d.deepened.text)
    .map(d => {
      const strat = DEEPEN_STRATEGY[d.mark_type];
      const label = strat ? strat.label : d.mark_type;
      const head = (d.text || '').trim().split(/\n/)[0].slice(0, 80);
      return `[${d.mark_type} ${label}] ${head}`;
    })
    .slice(0, 8);
  const hook = (ctx && ctx.captureSource === 'lecture')
    ? `从一节真实课堂${sourceLabel}走出来。`
    : (ctx && ctx.captureSource === 'video')
      ? `刚看完一段视频课${sourceLabel}。`
      : `一段阅读笔记${sourceLabel}。`;
  const microProof = {
    stimulus: '把你刚写的核心理解用自己的话讲给一个不在场的朋友 (Track B) — 你卡在哪一句？',
    expected_signal: '能名词化卡点 + 至少给出一个反例',
    fail_mode: '原文复述',
  };
  return {
    objective,
    hook_concrete: hook,
    path: pathSteps.length > 0 ? pathSteps : ['_no marks captured — quick_note only_'],
    micro_proof: microProof,
    next_lesson_seed: '复习时把每个 🧩 标记升级为 Product Pool 条目',
    assignment_level: 1,
  };
}

function buildLessonBodyFromCapture(deepened, userCore) {
  const proseByIdx = deepened
    .filter(d => d.type === 'mark' && d.deepened && d.deepened.text)
    .map((d, i) => ({ step_id: String(i), prose: d.deepened.text }))
    .slice(0, 8);
  const intro = `**你的核心理解** — ${userCore}\n\n下方是这节课你当场标记的 ${deepened.length} 条线索的整理。`;
  const closing = '记得：完成记录不是结束，而是深化的开始。把任何一条 🧩 推到 Product Pool 试试。';
  return {
    intro_prose: intro,
    closing_prose: closing,
    path_prose: proseByIdx,
  };
}

function buildEvidence(deepened, manifest) {
  // v0.1 light-weight learning proof — counts per mark_type + total drafts +
  // deepen success ratio. Heavier evidence (Quality Harness + Confession +
  // Auditable Reasoning) is deferred to v0.4 anti-slop expansion.
  const counts = {};
  let deepenedCount = 0;
  for (const d of deepened) {
    if (d.type === 'mark') {
      counts[d.mark_type] = (counts[d.mark_type] || 0) + 1;
    }
    if (d.deepened && d.deepened.text && d.deepened.strategy !== 'passthrough') deepenedCount += 1;
  }
  return {
    capture_session: manifest.sessionId,
    source: manifest.source,
    raw_entry_count: manifest.entryCount || 0,
    draft_count: deepened.length,
    deepened_count: deepenedCount,
    mark_counts_by_type: counts,
    captured_at: manifest.startedAt,
    closed_at: manifest.closedAt,
  };
}

// runFinishRitual(sessionId, { userCoreUnderstanding, ctx? }) →
//   { ok, lessonNotePath, evidence, masteryUpdates, productTransferTriggered,
//     drafts, deepened, stage }
//
// `ctx` carries optional caller hints — goalContract, captureSource override,
// extra context for the mock deepen. In production the caller (main.js IPC
// handler) sources these from vault state.json for the active curriculum.
async function runFinishRitual(sessionId, { userCoreUnderstanding, ctx } = {}) {
  // Defensive — make sure the session is closed. Idempotent close.
  let manifest;
  try {
    const closed = capture.closeCaptureSession(sessionId);
    manifest = capture.readSession(sessionId).manifest;
    void closed;
  } catch (err) {
    return { ok: false, stage: 'open', error: err.message };
  }
  // Stage 1
  let aggregated;
  try {
    aggregated = aggregateDrafts(sessionId);
  } catch (err) {
    return { ok: false, stage: 'aggregate', error: err.message };
  }
  // Stage 2 — parallel deepen across drafts.
  let deepened;
  try {
    deepened = await parallelDeepen(aggregated.drafts, ctx || {});
  } catch (err) {
    return { ok: false, stage: 'deepen', error: err.message, drafts: aggregated.drafts };
  }
  // Stage 3 — Human First gate. Hard block if missing.
  let userCore;
  try {
    const r = userCoreUnderstandingFirst(sessionId, userCoreUnderstanding);
    userCore = r.normalized;
  } catch (err) {
    return {
      ok: false,
      stage: 'user_core',
      error: err.message,
      drafts: aggregated.drafts,
      deepened,
      hint: '用户必须先写一句自己的核心理解 (Human First, Agent Second)',
    };
  }
  // Stage 4 — assemble + deposit. We reuse lesson-note.depositLessonNote
  // verbatim; no schema fork.
  const goalContract = (ctx && ctx.goalContract) || _fallbackGoalContract(manifest);
  const plan = buildLessonPlanFromCapture(deepened, userCore, {
    captureSource: manifest.source,
    goalContract,
  });
  const body = buildLessonBodyFromCapture(deepened, userCore);
  const scoreResult = {
    evidence_type: 'live_capture_self_summary',
    passed: true,
    false_positive_risk: 'medium',
    baseline_check: { regex_hits: [] },
  };
  let depositResult;
  try {
    depositResult = await lessonNote.depositLessonNote({
      plan,
      body,
      response: userCore,
      scoreResult,
      goalContract,
    });
  } catch (err) {
    return {
      ok: false,
      stage: 'deposit',
      error: err.message,
      drafts: aggregated.drafts,
      deepened,
      userCore,
    };
  }
  // Stage 4 side products.
  const evidence = buildEvidence(deepened, manifest);
  const productTransferTriggered = deepened
    .filter(d => d.deepened && d.deepened.product_transfer)
    .map(d => d.deepened.product_transfer);
  // Stage 4 — write a sidecar `finish-ritual.json` next to the captured
  // session so we have a structured audit trail (lesson NOTE is markdown).
  try {
    const sidecar = {
      sessionId,
      lessonNotePath: depositResult.path,
      lessonId: depositResult.lessonId,
      slug: depositResult.slug,
      userCore,
      evidence,
      productTransferTriggered,
      drafts: aggregated.drafts,
      deepened,
      completed_at: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(vaultRoot(), '_captures', sessionId, 'finish-ritual.json'),
      JSON.stringify(sidecar, null, 2),
      'utf8'
    );
  } catch (_) { /* sidecar write non-fatal — lesson NOTE is canonical */ }
  // W3.6 Companion Triggers — finish_capture. Best-effort, off the hot path.
  try {
    const ct = require('./companion-triggers');
    await ct.tryFinishCapture({ slug: depositResult.slug, sessionId, ritualStage: 'completed' });
  } catch (_) { /* companion never breaks the ritual */ }
  return {
    ok: true,
    stage: 'done',
    lessonNotePath: depositResult.path,
    lessonId: depositResult.lessonId,
    slug: depositResult.slug,
    evidence,
    // intentional-placeholder: Mastery Map updates belong to W4 (Mastery Map
    // stream), which is scope-out for W1.5. Ship the IPC return-shape now so
    // the W4 wire-in is additive, not a contract break.
    masteryUpdates: { deferred_to: 'W4', concepts_touched: [] },
    productTransferTriggered,
    drafts: aggregated.drafts,
    deepened,
    userCore,
  };
}

// When the caller didn't pass a goalContract (e.g. capture before any
// curriculum exists), synthesize a minimal one from the manifest context so
// lesson-note's slugifier has something to chew on.
function _fallbackGoalContract(manifest) {
  const ctx = manifest.context || {};
  const ns = ctx.course_slug || ctx.lecture_title || `capture-${manifest.source}`;
  return {
    north_star_goal: ns,
    main_creation: ns,
    learning_model: 'capture-driven',
  };
}

module.exports = {
  runFinishRitual,
  aggregateDrafts,
  parallelDeepen,
  userCoreUnderstandingFirst,
  buildLessonPlanFromCapture,
  buildLessonBodyFromCapture,
  buildEvidence,
  // Surface constants for spec docs + UI hint rendering.
  MERGE_WINDOW_MS,
  DEEPEN_STRATEGY,
};
