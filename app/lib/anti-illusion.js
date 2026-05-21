'use strict';

/**
 * HYPHA · Anti-Illusion v0 — learning-illusion detector.
 *
 * Per BLUEPRINT v0.4 §7.3 + ROADMAP v0.4 "Anti-Illusion v0".
 *
 * Detects 6 illusion types that indicate the user is faking comprehension:
 *   1. ai_mimicry          — user output ≈ lesson source text (paraphrase too thin)
 *   2. no_example          — user asked for a concrete instance, returns abstract
 *   3. no_transfer         — user asked to apply in a fresh scenario, stuck
 *   4. ai_ghostwrite       — answer too clean (timing/typo/punctuation signal)
 *   5. no_action_proof     — no `action_log` entry from prior lesson(s)
 *   6. no_creation_reflow  — knowledge not surfacing in Product Pool (W3.x dep)
 *
 * Output suggests one of 4 intervention types:
 *   - micro_transfer_task   — 30-sec fresh-scenario application
 *   - misconception_repair  — kick to W1.4 Misconception engine
 *   - product_transfer_drill — kick to W3.3 Product Transfer (W3.x dep)
 *   - request_action_log    — force user to write "I used X to do Y"
 *
 * Design discipline (BLUEPRINT critical constraint):
 *   - False-positive cost > false-negative cost. Default to TRUST.
 *   - Only `ai_mimicry` runs a real algorithmic check (trigram similarity).
 *     All other types return mock-false unless the LLM (T4_JUDGE) confirms.
 *   - When multiple illusion types fire, pick the one with highest confidence.
 *
 * No streaming. No mutation. Pure function + async LLM placeholder.
 *
 * intentional-placeholder: per W1.3 task spec, only ai_mimicry is real algo;
 * other 5 detectors keep a T4_JUDGE shim until LLM wiring lands in W1.3.1.
 * Detector hooks are present + tested so swap-in is mechanical, not redesign.
 */

const { tokenize, trigrams, jaccard } = require('./anti-illusion/similarity');

// -----------------------------------------------------------------------------
// Public types (JSDoc — Hypha is JS, not TS, but typed for clarity)
// -----------------------------------------------------------------------------

/**
 * @typedef {'ai_mimicry'|'no_example'|'no_transfer'|'ai_ghostwrite'|'no_action_proof'|'no_creation_reflow'} IllusionType
 *
 * @typedef {'micro_transfer_task'|'misconception_repair'|'product_transfer_drill'|'request_action_log'} InterventionType
 *
 * @typedef {object} DetectionContext
 * @property {object} [lessonKP] — lesson body or KP record. `mechanism_explanation`
 *   and `canonical_example` are the source-of-truth text we compare against.
 * @property {string} [exitProof] — the exit_proof question the user just answered.
 * @property {Array<{role:'user'|'assistant',text:string}>} [priorResponses]
 *   — recent transcript (last 1-3 turns). Used for ghostwrite signals (timing /
 *   punctuation) when shape data is attached to the rows.
 * @property {Array<object>} [actionLog] — entries from prior lessons' action proof.
 *   Empty = no_action_proof signal.
 * @property {number} [responseTimeMs] — wall-clock ms between user's prompt
 *   prompt-shown and submit. < 2000 with > 100 chars = ghostwrite-suspect.
 *
 * @typedef {object} DetectionResult
 * @property {boolean} illusion_detected
 * @property {IllusionType|null} illusion_type — highest-confidence type, null
 *   when no detector fired above threshold.
 * @property {number} confidence — 0..1
 * @property {string[]} evidence — short human-readable strings backing the call.
 * @property {InterventionType|null} suggested_intervention
 * @property {Array<{type:IllusionType,confidence:number,evidence:string[]}>} all_signals
 *   — every detector's output, including non-firing ones with confidence < threshold.
 *   Useful for telemetry + Course Trust Panel display.
 */

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const MIMICRY_THRESHOLD = 0.70;          // jaccard(trigram) over source text
const GHOSTWRITE_TIME_MIN_MS = 2000;     // < 2s + long polished output = suspect
const GHOSTWRITE_MIN_CHARS = 100;        // short answers don't count as ghostwrite
const FIRE_CONFIDENCE = 0.70;            // any signal >= 0.70 fires the gate

const ILLUSION_TYPES = Object.freeze([
  'ai_mimicry',
  'no_example',
  'no_transfer',
  'ai_ghostwrite',
  'no_action_proof',
  'no_creation_reflow',
]);

const INTERVENTION_MAP = Object.freeze({
  ai_mimicry:          'micro_transfer_task',
  no_example:          'micro_transfer_task',
  no_transfer:         'micro_transfer_task',
  ai_ghostwrite:       'request_action_log',
  no_action_proof:     'request_action_log',
  no_creation_reflow:  'product_transfer_drill',
  // misconception_repair routes via no_example when LLM (TODO) tags
  // the wrong answer as a known misconception — until then we fall back
  // to micro_transfer_task.
});

// -----------------------------------------------------------------------------
// Detector 1 — ai_mimicry (REAL implementation, trigram jaccard)
// -----------------------------------------------------------------------------

/**
 * Compare user response against lesson source text using trigram jaccard.
 * Both CJK char-split + EN word-split (per goal-drift-detector convention).
 *
 * High similarity (>= 0.70) means the user echoed the source rather than
 * generating new language — a strong copy-the-AI signal.
 *
 * @param {string} userResponse
 * @param {object} lessonKP
 * @returns {{type:'ai_mimicry', confidence:number, evidence:string[]}}
 */
function detectMimicry(userResponse, lessonKP) {
  const user = (typeof userResponse === 'string') ? userResponse.trim() : '';
  // CJK char ≈ 1 EN word information density; allow lower floor (8 chars)
  // so a short copy-paste like "完全照抄原文一字不差" still fires.
  if (!user || user.length < 8) {
    return { type: 'ai_mimicry', confidence: 0, evidence: ['too-short-to-judge'] };
  }
  // Build the source pool from any text-bearing lesson body fields.
  const sourcePieces = [];
  if (lessonKP && typeof lessonKP === 'object') {
    for (const k of ['mechanism_explanation', 'canonical_example', 'thesis', 'intro_prose']) {
      const v = lessonKP[k];
      if (typeof v === 'string' && v.trim()) sourcePieces.push(v.trim());
    }
    if (Array.isArray(lessonKP.path_prose)) {
      for (const p of lessonKP.path_prose) {
        if (typeof p === 'string' && p.trim()) sourcePieces.push(p.trim());
      }
    }
  }
  if (sourcePieces.length === 0) {
    return { type: 'ai_mimicry', confidence: 0, evidence: ['no-source-to-compare'] };
  }
  const source = sourcePieces.join(' ');
  const userTokens = tokenize(user);
  const srcTokens = tokenize(source);
  if (userTokens.length < 3 || srcTokens.length < 3) {
    return { type: 'ai_mimicry', confidence: 0, evidence: ['tokens-too-sparse'] };
  }
  const userTri = trigrams(userTokens);
  const srcTri = trigrams(srcTokens);
  const sim = jaccard(userTri, srcTri);
  // Confidence rises linearly from threshold up to 1.0.
  let confidence = 0;
  if (sim >= MIMICRY_THRESHOLD) {
    confidence = Math.min(1, MIMICRY_THRESHOLD + (sim - MIMICRY_THRESHOLD) * 2);
  } else if (sim >= MIMICRY_THRESHOLD * 0.8) {
    // Below-threshold but suspicious — log as low-confidence signal for
    // telemetry, don't fire the gate.
    confidence = sim - MIMICRY_THRESHOLD * 0.4;
  }
  const evidence = [
    `trigram_jaccard=${sim.toFixed(3)} (threshold ${MIMICRY_THRESHOLD})`,
    `user_len=${user.length} source_len=${source.length}`,
  ];
  if (sim >= MIMICRY_THRESHOLD) {
    evidence.push('user output trigram-overlaps lesson source > 70% — likely paraphrase-too-thin or direct copy');
  }
  return { type: 'ai_mimicry', confidence, evidence };
}

// -----------------------------------------------------------------------------
// Detector 2 — no_example (TODO: T4_JUDGE)
// -----------------------------------------------------------------------------

/**
 * The exit_proof asked for a concrete instance ("apply X to ...") but the
 * user returned an abstract restatement. Real check needs LLM — heuristic
 * fallback: scan user response for concrete-instance markers (proper noun,
 * year, place, "for example", "比如", "例如").
 *
 * @param {string} userResponse
 * @param {string} exitProof
 * @returns {{type:'no_example', confidence:number, evidence:string[]}}
 */
// 2026-05-15 — Stub upgraded to heuristic. Original placeholder claimed
// 'pending T4_JUDGE'; replaced with regex + structural detection (no LLM).
// T4_JUDGE upgrade still TODO v0.4 — heuristic catches obvious cases,
// T4_JUDGE will catch nuanced ones.
function detectNoExample(userResponse, _exitProof) {
  const user = (typeof userResponse === 'string') ? userResponse.trim() : '';
  if (!user) {
    return { type: 'no_example', confidence: 0, flags: ['missing-input'], evidence: ['missing-input'] };
  }
  // Example markers — bilingual zh/en. Match "比如," / "例:" / "举个例子" /
  // "for example" / "for instance" / "e.g." / "例如，" etc.
  const exampleMarkerRegex = /(例如|比如|举个例子|举例|例[:：]|比方说|譬如|打个比方|for example|for instance|e\.g\.|such as)/gi;
  const exampleMatches = user.match(exampleMarkerRegex) || [];
  // Definition markers — "X 是 Y", "定义为", "指的是", "is defined as", "refers to"
  const definitionMarkerRegex = /(定义为|定义是|指的是|的定义|是指|意思是|换言之|换句话说|is defined as|refers to|means that|in other words)/gi;
  const definitionMatches = user.match(definitionMarkerRegex) || [];
  // "X 是 Y" copula pattern — count CJK + EN both
  const copulaRegex = /([一-龥A-Za-z]{2,12})\s*(?:是|为|即|属于|belong[s]? to|are|is)\s+[一-龥A-Za-z]/g;
  const copulaCount = (user.match(copulaRegex) || []).length;

  const flags = [];
  const evidence = [];

  if (exampleMatches.length >= 1) {
    flags.push('example_mark_found');
    evidence.push(`example markers detected: ${exampleMatches.slice(0, 3).join(', ')}`.slice(0, 120));
    return { type: 'no_example', confidence: 0, flags, evidence };
  }

  // No example markers at all — judge severity by length + definition density.
  if (user.length <= 200) {
    flags.push('short-response-trust-default');
    evidence.push(`response length=${user.length} ≤ 200 chars, too short to judge`);
    return { type: 'no_example', confidence: 0, flags, evidence };
  }

  flags.push('no_example_mark_found');
  evidence.push(`zero example markers (例如/比如/for example/etc.) in ${user.length}-char response`);

  // Definition-heavy + no examples → "光定义不举例"
  if (definitionMatches.length + copulaCount >= 3) {
    flags.push('multiple_definitions_present');
    const sample = user.slice(0, 120);
    evidence.push(`${definitionMatches.length + copulaCount} definition-like clauses present`);
    evidence.push(`sample: ${sample}`);
    return { type: 'no_example', confidence: 0.85, flags, evidence };
  }

  evidence.push(`sample: ${user.slice(0, 120)}`);
  return { type: 'no_example', confidence: 0.7, flags, evidence };
}

// -----------------------------------------------------------------------------
// Detector 3 — no_transfer (TODO: T4_JUDGE)
// -----------------------------------------------------------------------------

/**
 * The exit_proof asked to apply X to a NEW scenario Y. We need LLM to judge
 * whether the user's response (a) names a new scenario, (b) maps mechanism
 * onto it, (c) doesn't collapse back to the canonical_example.
 *
 * @param {string} userResponse
 * @param {string} exitProof
 * @param {object} lessonKP
 * @returns {{type:'no_transfer', confidence:number, evidence:string[]}}
 */
// 2026-05-15 — Stub upgraded to heuristic. Original placeholder claimed
// 'pending T4_JUDGE'; replaced with regex + structural detection (no LLM).
// T4_JUDGE upgrade still TODO v0.4 — heuristic catches obvious cases,
// T4_JUDGE will catch nuanced ones.
function detectNoTransfer(userResponse, _exitProof, lessonKP) {
  const user = (typeof userResponse === 'string') ? userResponse.trim() : '';
  if (!user) {
    return { type: 'no_transfer', confidence: 0, flags: ['empty-response'], evidence: ['empty-response'] };
  }

  const flags = [];
  const evidence = [];

  // Cue A — high overlap with canonical_example == restatement, not transfer.
  const canonical = (lessonKP && typeof lessonKP.canonical_example === 'string')
    ? lessonKP.canonical_example.trim() : '';
  if (canonical.length > 30 && user.length > 20) {
    const userTri = trigrams(tokenize(user));
    const canonTri = trigrams(tokenize(canonical));
    if (userTri.size > 0 && canonTri.size > 0) {
      const sim = jaccard(userTri, canonTri);
      if (sim >= 0.55) {
        flags.push('restated_canonical_example');
        evidence.push(`user response trigram-overlaps canonical_example sim=${sim.toFixed(3)} (>= 0.55)`);
        evidence.push(`sample: ${user.slice(0, 120)}`);
        return { type: 'no_transfer', confidence: 0.75, flags, evidence };
      }
    }
  }

  // Cue B — transfer marker scan. Bilingual.
  const transferMarkerRegex = /(应用到|迁移到?|可以用在|换个场景|想象一下|想象成|放到.*?场景|套到|挪到|拿来.*?用|apply (this|that|it)|transfer (this|that|it)|in (another|a different|a new) (case|context|scenario)|imagine if|what if we|same idea in)/gi;
  const transferMatches = user.match(transferMarkerRegex) || [];

  if (transferMatches.length >= 1) {
    flags.push('transfer_mark_found');
    evidence.push(`transfer markers detected: ${transferMatches.slice(0, 3).join(', ')}`.slice(0, 120));
    return { type: 'no_transfer', confidence: 0, flags, evidence };
  }

  // No transfer mark — judge by technical density. Concept words signal a
  // mechanism explanation that *should* have a transfer pair.
  const techConceptRegex = /(原理|机制|理论|定律|公式|算法|模型|结构|框架|系统|principle|mechanism|theory|law|formula|algorithm|model|framework|structure)/gi;
  const techMatches = user.match(techConceptRegex) || [];

  if (techMatches.length >= 1 && user.length > 100) {
    flags.push('no_transfer_mark_found', 'technical_concept_present');
    evidence.push(`${techMatches.length} technical concept(s) present without transfer marker`);
    evidence.push(`concepts: ${techMatches.slice(0, 4).join(', ')}`.slice(0, 120));
    return { type: 'no_transfer', confidence: 0.7, flags, evidence };
  }

  flags.push('no_transfer_mark_found');
  evidence.push('no transfer markers but no clear technical-concept context');
  return { type: 'no_transfer', confidence: 0, flags, evidence };
}

// -----------------------------------------------------------------------------
// Detector 4 — ai_ghostwrite (timing + shape heuristics, TODO LLM polish)
// -----------------------------------------------------------------------------

/**
 * Signal of LLM-ghostwritten user response. Cues:
 *   - responseTimeMs < 2000 AND len > 100  → suspiciously fast for typed
 *   - typo-count = 0 AND markdown-punctuation present
 *   - perfectly balanced bullets / em-dashes / numbered lists
 *
 * @param {string} userResponse
 * @param {DetectionContext} ctx
 * @returns {{type:'ai_ghostwrite', confidence:number, evidence:string[]}}
 */
// 2026-05-15 — Stub upgraded to heuristic. Original placeholder claimed
// 'pending T4_JUDGE'; replaced with regex + structural detection (no LLM).
// T4_JUDGE upgrade still TODO v0.4 — heuristic catches obvious cases,
// T4_JUDGE will catch nuanced ones.
function detectGhostwrite(userResponse, ctx) {
  const user = (typeof userResponse === 'string') ? userResponse : '';
  const flags = [];
  const evidence = [];
  let score = 0;

  if (!user.trim()) {
    return { type: 'ai_ghostwrite', confidence: 0, flags: ['empty'], evidence: ['empty'] };
  }

  // -- Third-person dominance check (new heuristic per task spec) --
  // "你" / "你能" / "你可以" / "you" → second-person (peer voice = good)
  // "用户" / "学习者" / "学生" / "the user" / "the learner" → third-person
  // (ghostwrite tell = LLM narrating about a user rather than to them)
  const secondPersonRegex = /(你能|你可以|你会|你的|你们|\byou (can|could|will|should|may)\b|\byour\b|\byou\b)/gi;
  const thirdPersonRegex = /(用户|学习者|学生|读者|the user|the learner|the student|the reader|users will|learners will)/gi;
  const secondCount = (user.match(secondPersonRegex) || []).length;
  const thirdCount = (user.match(thirdPersonRegex) || []).length;

  if (thirdCount > secondCount && thirdCount >= 1) {
    score += 0.8;
    flags.push('third_person_dominant');
    evidence.push(`third-person count=${thirdCount} > second-person count=${secondCount}`);
  } else if (secondCount > 0 && thirdCount === 0) {
    flags.push('second_person_only');
    evidence.push(`second-person voice (count=${secondCount}), no third-person leak`);
  }

  // -- Passive narration construct ("如下所述", "以下展示") --
  const passiveNarrationRegex = /(如下所述|以下展示|以下说明|如下所示|下面将|as (shown|described|illustrated) below|the following)/gi;
  if (passiveNarrationRegex.test(user)) {
    score += 0.1;
    flags.push('passive_narration_construct');
    evidence.push('passive narration phrase ("如下所述" / "as shown below" / etc.) present');
  }

  // -- Original cue 1: timing --
  const rt = typeof ctx.responseTimeMs === 'number' ? ctx.responseTimeMs : null;
  if (rt !== null && user.length >= GHOSTWRITE_MIN_CHARS && rt < GHOSTWRITE_TIME_MIN_MS) {
    score += 0.35;
    flags.push('fast_long_response');
    evidence.push(`response_time=${rt}ms with ${user.length} chars (< ${GHOSTWRITE_TIME_MIN_MS}ms threshold)`);
  }

  // -- Original cue 2: shape (markdown bullets / em-dash) --
  if (user.length >= GHOSTWRITE_MIN_CHARS) {
    const hasMarkdownBullet = /^\s*[-*]\s/m.test(user);
    const hasNumberedList = /^\s*\d+\.\s/m.test(user);
    const hasEmDash = /—/.test(user);
    const hasMultiBullet = (user.match(/^\s*[-*]\s/mg) || []).length >= 3;
    if ((hasMarkdownBullet || hasNumberedList) && hasMultiBullet) {
      score += 0.2;
      flags.push('multi_bullet_list');
      evidence.push('multi-bullet markdown list in chat answer (LLM output shape)');
    }
    if (hasEmDash && !/\s-\s/.test(user)) {
      score += 0.1;
      flags.push('em_dash_punctuation');
      evidence.push('em-dash present without typed hyphen-substitute (LLM punctuation tell)');
    }
  }

  if (evidence.length === 0) {
    evidence.push('no-ghostwrite-cues');
  }
  return {
    type: 'ai_ghostwrite',
    confidence: Math.min(1, score),
    flags,
    evidence,
  };
}

// -----------------------------------------------------------------------------
// Detector 5 — no_action_proof (action_log empty signal)
// -----------------------------------------------------------------------------

/**
 * If the user has finished one or more prior lessons in this curriculum but
 * `actionLog` is empty, they've been learning-without-doing — illusion-prone.
 *
 * @param {DetectionContext} ctx
 * @returns {{type:'no_action_proof', confidence:number, evidence:string[]}}
 */
// 2026-05-15 — Stub upgraded to heuristic. Original placeholder claimed
// 'pending T4_JUDGE'; replaced with regex + structural detection (no LLM).
// T4_JUDGE upgrade still TODO v0.4 — heuristic catches obvious cases,
// T4_JUDGE will catch nuanced ones.
function detectNoActionProof(userResponse, ctx) {
  const user = (typeof userResponse === 'string') ? userResponse.trim() : '';
  const c = (ctx && typeof ctx === 'object') ? ctx : {};
  const log = Array.isArray(c.actionLog) ? c.actionLog : null;

  const flags = [];
  const evidence = [];

  // Channel 1: structured action_log (kept from previous behavior).
  if (log !== null) {
    if (log.length === 0) {
      flags.push('action_log_empty');
      evidence.push('action_log empty across prior lessons');
      evidence.push('user has not produced a single "I used X to do Y" entry');
      return { type: 'no_action_proof', confidence: 0.6, flags, evidence };
    }
    flags.push('action_log_has_entries');
    evidence.push(`action_log has ${log.length} entries`);
    return { type: 'no_action_proof', confidence: 0, flags, evidence };
  }

  // Channel 2: text-based action-word scan (new heuristic).
  if (!user) {
    flags.push('no-input-and-no-log');
    evidence.push('action_log not supplied and no user response — cannot judge');
    return { type: 'no_action_proof', confidence: 0, flags, evidence };
  }

  // Action / verb-of-doing markers — bilingual.
  // CJK verbs need lookahead-free matching; treat as substring hits.
  const actionWordList = [
    '做', '练', '写', '动手', '尝试', '实验', '试一下', '试试', '上手', '搭', '搭建',
    '编', '画', '建', '改', '调', '跑一下', '跑',
  ];
  const enActionRegex = /\b(try|do|build|make|write|practice|run|test|experiment|implement|sketch|draft|prototype)\b/gi;
  let zhActionHits = 0;
  for (const w of actionWordList) {
    // count occurrences
    let idx = 0;
    while ((idx = user.indexOf(w, idx)) !== -1) {
      zhActionHits += 1;
      idx += w.length;
    }
  }
  const enActionHits = (user.match(enActionRegex) || []).length;
  const totalActionHits = zhActionHits + enActionHits;

  // Imperative sentence count — sentence ending in "." not "?" with action verb.
  const imperativeRegex = /(?:^|[.。!！\n])\s*[^.。!！?？\n]{4,80}?(做|练|写|动手|尝试|实验|try|do|build|make|write|practice|run|test)\b[^?？]*?[.。!！]/gi;
  const imperativeCount = (user.match(imperativeRegex) || []).length;

  if (totalActionHits >= 3) {
    flags.push('action_words_present');
    evidence.push(`${totalActionHits} action word(s) found (zh=${zhActionHits} en=${enActionHits})`);
    if (imperativeCount > 0) {
      flags.push('imperative_present');
      evidence.push(`${imperativeCount} imperative-like clause(s)`);
    }
    return { type: 'no_action_proof', confidence: 0, flags, evidence };
  }

  if (totalActionHits === 0 && user.length > 200) {
    flags.push('zero_action_words');
    evidence.push(`response is ${user.length} chars with zero action verbs`);
    evidence.push(`sample: ${user.slice(0, 120)}`);
    return { type: 'no_action_proof', confidence: 0.75, flags, evidence };
  }

  flags.push('weak_action_signal');
  evidence.push(`${totalActionHits} action word(s) in ${user.length}-char response — neither full proof nor blank`);
  return { type: 'no_action_proof', confidence: 0, flags, evidence };
}

// -----------------------------------------------------------------------------
// Detector 6 — no_creation_reflow (W3.x placeholder)
// -----------------------------------------------------------------------------

/**
 * Placeholder — Product Pool (W3.x) ships later. Until then this detector
 * always returns 0 confidence with a note that it's deferred.
 *
 * @param {DetectionContext} ctx
 * @returns {{type:'no_creation_reflow', confidence:number, evidence:string[]}}
 */
// 2026-05-15 — Stub upgraded to heuristic. Original placeholder claimed
// 'pending T4_JUDGE'; replaced with regex + structural detection (no LLM).
// T4_JUDGE upgrade still TODO v0.4 — heuristic catches obvious cases,
// T4_JUDGE will catch nuanced ones.
function detectNoCreationReflow(userResponse, _ctx) {
  const user = (typeof userResponse === 'string') ? userResponse.trim() : '';
  const flags = [];
  const evidence = [];

  if (!user) {
    flags.push('empty-response');
    evidence.push('empty user response — cannot judge creation reflow');
    return { type: 'no_creation_reflow', confidence: 0, flags, evidence };
  }

  // Creation-object references — "你的产品 / 作品 / 论文 / 笔记 / 项目 / 代码 / demo"
  const creationObjectRegex = /(你的(产品|作品|论文|笔记|项目|代码|demo|稿子|文章|博客|工作|博士论文|毕设|课题|repo|仓库|脚本|脚手架)|my (product|paper|notebook|notes|project|code|demo|draft|article|blog|repo|essay))/gi;
  const creationMatches = user.match(creationObjectRegex) || [];

  // Reflow-to-creation patterns — "迁移到 X / 落实到 X / 应用到 X 上 / 用到 X 里"
  const reflowPatternRegex = /(迁移到|落实到|落到|应用到.{0,15}(上|里|中)|放进.{0,15}(里|中)|用到.{0,15}(里|上|中)|融入到|嵌入到|incorporate (this|that|it) into|integrate (this|that|it) into|bring (this|that|it) into)/gi;
  const reflowMatches = user.match(reflowPatternRegex) || [];

  const total = creationMatches.length + reflowMatches.length;

  if (total >= 1) {
    flags.push('creation_reflow_signal');
    if (creationMatches.length > 0) {
      flags.push('user_creation_object_referenced');
      evidence.push(`creation-object ref: ${creationMatches.slice(0, 3).join(', ')}`.slice(0, 120));
    }
    if (reflowMatches.length > 0) {
      flags.push('reflow_pattern_present');
      evidence.push(`reflow pattern: ${reflowMatches.slice(0, 3).join(', ')}`.slice(0, 120));
    }
    return { type: 'no_creation_reflow', confidence: 0, flags, evidence };
  }

  flags.push('no_creation_reflow_signal');
  evidence.push('no reference to user creation-object (产品/作品/项目/etc.)');
  evidence.push('no reflow-to-creation pattern (迁移到/落实到/apply-to-my-X)');
  evidence.push(`sample: ${user.slice(0, 120)}`);
  return { type: 'no_creation_reflow', confidence: 0.7, flags, evidence };
}

// -----------------------------------------------------------------------------
// Public API — detectIllusion
// -----------------------------------------------------------------------------

/**
 * Run all 6 detectors. Pick the highest-confidence one above FIRE_CONFIDENCE.
 *
 * @param {string} userResponse
 * @param {DetectionContext} [context]
 * @returns {DetectionResult}
 */
function detectIllusion(userResponse, context) {
  const ctx = (context && typeof context === 'object') ? context : {};
  const lessonKP = ctx.lessonKP || {};
  const exitProof = ctx.exitProof || (lessonKP && lessonKP.exit_proof) || '';

  const signals = [
    detectMimicry(userResponse, lessonKP),
    detectNoExample(userResponse, exitProof),
    detectNoTransfer(userResponse, exitProof, lessonKP),
    detectGhostwrite(userResponse, ctx),
    detectNoActionProof(userResponse, ctx),
    detectNoCreationReflow(userResponse, ctx),
  ];

  // Pick the highest-confidence signal above FIRE_CONFIDENCE.
  let best = null;
  for (const s of signals) {
    if (s.confidence >= FIRE_CONFIDENCE) {
      if (!best || s.confidence > best.confidence) best = s;
    }
  }

  if (!best) {
    return {
      illusion_detected: false,
      illusion_type: null,
      confidence: signals.reduce((m, s) => Math.max(m, s.confidence), 0),
      evidence: [],
      suggested_intervention: null,
      all_signals: signals,
    };
  }

  return {
    illusion_detected: true,
    illusion_type: best.type,
    confidence: best.confidence,
    evidence: best.evidence.slice(0),
    suggested_intervention: INTERVENTION_MAP[best.type] || 'micro_transfer_task',
    all_signals: signals,
  };
}

module.exports = {
  detectIllusion,
  // Exposed for tests / external composition.
  _detectors: {
    detectMimicry,
    detectNoExample,
    detectNoTransfer,
    detectGhostwrite,
    detectNoActionProof,
    detectNoCreationReflow,
  },
  ILLUSION_TYPES,
  INTERVENTION_MAP,
  MIMICRY_THRESHOLD,
  FIRE_CONFIDENCE,
};
