'use strict';
// HYPHA · Pre-lesson body generator (v0.2 Surface Finishing, blueprint §6.1)
//
// Generates the v0.2 11-field lesson body BEFORE the LessonChat opens, so
// the tutor enters with a real prep artifact (thesis / canonical_example /
// common_misconceptions / exit_proof / mechanism / jargon_list / note_connection)
// and the user sees "本节焦点: ___" header in the chat surface (Track B B3).
//
// Why this exists: v0.4-shipped path generates lessons turn-by-turn from
// learn-start.txt + sources, with no per-lesson "prep notes". Production
// critique 2026-05-08: "不知道每节课上课之前有没有备课" — the tutor opens
// cold with no thesis. Fix = pre-generate a structured brief, persist it,
// and inject as LESSON BRIEF block into designLesson's system prompt so
// the tutor anchors in its own prep instead of winging the whole turn.
//
// Reuses:
//   - app/agent.js:rankSourcesBM25(sources, query, k, {desiredUse})
//     for grounding (v0.4 Course Source Stack)
//   - app/lib/llm/index.js:executeChat('T6_STRONG', ...) for the LLM call
//     with DispatchPolicy + ProviderHealth runtime fallback
//   - app/lib/jargon-firewall.checkJargon for output sanity
//
// Persists to vault/<slug>/lesson-N.body.json. Idempotent (callers should
// check if file exists first; this fn always regenerates when invoked).
//
// Cost: ~1 T6_STRONG call (~$0.005 GLM-5.1 / ~$0.05 Sonnet) per lesson.
// Wall time: ~5-10s. Gated upstream behind settings.experiments.preLessonBody.

const { executeChat } = require('./llm');
const sqliteDb = require('../db/sqlite');

// W8.3 Adaptive UX — lazy require; never crash if optional layer missing.
let _uxPrefs = null;
let _uxRender = null;
function _ux() {
  if (_uxPrefs === null) {
    try { _uxPrefs  = require('./adaptive-ux/preferences'); }   catch (_) { _uxPrefs  = false; }
    try { _uxRender = require('./adaptive-ux/render-modifier'); } catch (_) { _uxRender = false; }
  }
  return { prefs: _uxPrefs, render: _uxRender };
}
function _applyAdaptive(body, slug) {
  const { prefs, render } = _ux();
  if (!prefs || !render) return body;
  try {
    const { preferences } = prefs.loadUserPreferences(slug);
    if (!preferences) return body;
    // Apply density + language to prose-bearing string fields only. Untouched
    // structural fields (mechanism, jargon_list arrays) keep their shape.
    const proseFields = ['thesis', 'canonical_example', 'exit_proof', 'note_connection'];
    const next = { ...body };
    for (const f of proseFields) {
      if (typeof next[f] === 'string') {
        next[f] = render.composeAllModifiers(next[f], preferences);
      }
    }
    return next;
  } catch (_) {
    return body;
  }
}

// Lazy-load rankSourcesBM25 from agent.js to avoid circular require at boot.
let _rankCached = null;
function _getRanker() {
  if (_rankCached) return _rankCached;
  try { _rankCached = require('../agent').rankSourcesBM25; }
  catch (_) { _rankCached = null; }
  return _rankCached;
}

// Lazy-load jargon firewall (optional dependency — body still ships if missing).
let _jargonCached = null;
function _getJargon() {
  if (_jargonCached !== null) return _jargonCached;
  try { _jargonCached = require('./jargon-firewall'); }
  catch (_) { _jargonCached = false; }
  return _jargonCached;
}

// v0.2 Track C C1 — lazy-load goal-drift-detector. Returns null on missing.
let _driftCached = null;
function _getDriftDetector() {
  if (_driftCached !== null) return _driftCached;
  try { _driftCached = require('./goal-drift-detector'); }
  catch (_) { _driftCached = false; }
  return _driftCached;
}

// v0.2 Track C C1 — default forbidden_drifts injected when goalContract is
// silent on the field. Per blueprint §3.1+§3.4 these are the 5 drift modes
// the user mandate (2026-05-08) explicitly named as off-mission for HYPHA.
const DEFAULT_FORBIDDEN_DRIFTS = [
  '空泛聊天',
  '过多黑话',
  '无行动证明',
  '资讯流消费',
  '普通网课式总结',
];

// v0.2 Track C C1 — drift threshold. detectDrift returns 0-100; > 50 triggers
// regen-once. Conservative; one regen attempt only; second-fail returns body
// + _meta.drift_warning so trust panel surface (Machino-C) can render.
const DRIFT_THRESHOLD = 50;

// v0.2 Track C C2 — hook_concrete: an opening MUST start with a concrete
// scene (named person / specific moment / sensory detail), NOT a definition
// or encyclopedia framing. Spec from plan §C2; first 100 chars checked.
const HOOK_ABSTRACT_RE = /^(.+? 是 .+|定义|introduction|本课介绍|本课讨论|本节介绍|an overview of)/i;

const BODY_V2_SYSTEM_PROMPT = `You are a HYPHA Lesson Architect. You are NOT teaching the lesson — you are PREPARING it. Your output is a structured prep artifact the tutor will read before opening the chat. The tutor only teaches well if you give them a sharp brief.

OUTPUT — STRICT JSON with these 7 required fields plus 4 optional:

REQUIRED:
  thesis              — 1 sentence, ≤25 words, declarative. The ONE specific claim/skill/insight this 30-min lesson lands. NOT "an overview of X". Format: "By the end of this lesson, the learner will be able to / will see that ___." NO encyclopedia framing.
  canonical_example   — 1 paragraph, ≤80 words. ONE named, concrete instance the tutor will return to repeatedly. Has a person/year/place/number where possible. Used as the recurring anchor across HOOK→VERIFY→EXTEND beats.
  common_misconceptions — array of EXACTLY 2 strings, each ≤40 words. The two most likely wrong-priors the learner will arrive with. Each ends with the sharp correction (not just the wrong belief).
  exit_proof          — 1 paragraph, ≤60 words. The Feynman-test the tutor will close with: "apply X to a fresh case Y" or "explain X to someone who knows nothing of Z". Concrete + falsifiable.
  mechanism_explanation — 1-2 paragraphs, ≤150 words. Plain-language description of the underlying mechanism (NOT definition). HOW it works, not WHAT it is. Use a body metaphor before any symbol.
  jargon_list         — array, max 5 strings. Terms the lesson MUST introduce + their plain-language gloss. Format: ["term — plain gloss (≤15 words)", ...]. EXCLUDE any terms the learner already knows per LEARNER_STATE.known.
  note_connection     — 1 sentence, ≤30 words. Which prior lesson note (if any) this lesson connects to AND how. If no prior note, write "(first lesson — no prior note to bind to)".
  concepts            — array of 3-8 strings. The bare concept TERMS this lesson introduces or actively works (NOT glosses, NOT sentences — just the term itself, ≤6 words each). These become nodes in the cross-lesson knowledge-contamination graph; the tutor + downstream Trust Panel read this list to track first-seen / cross-lesson reuse. Distinct from jargon_list (which carries glosses).  Example: ["认知图谱", "节点", "有向边"].
  prerequisite_concepts — array of 0-8 strings. The bare concept TERMS the learner MUST already know before this lesson can land (from prior lessons in this chain, foundational priors, or LEARNER_STATE.known). NOT what THIS lesson teaches — what this lesson DEPENDS on. ≤6 words each. These become directed dependency edges in the contamination graph: if any prerequisite_concept is later flagged as quarantined, this lesson + its descendants get auto-flagged. Use [] for the first lesson of a chain (no upstream priors). Example: ["节点", "边"] for a lesson on "edge directionality".

OPTIONAL (write empty string if not applicable):
  examples            — array up to 3, each ≤30 words. Secondary instances beyond canonical_example.
  product_transfer    — 1 sentence, ≤30 words. Where the learner could USE this knowledge in their own work. (W3.3 may LATER overwrite this field with a structured object { content, P, generated_at, suggested_section } when the user's Product Pool blueprint scores P ≥ 0.6 relevance — do not include that shape here; emit only the 1-sentence prep hint.)
  intro_hook_scene    — 1-2 sentences, ≤50 words. A specific opening scene the tutor MAY use (named person, year, sensory detail) — NOT abstract definition. The tutor MAY override.
  closing_summary     — 1 sentence, ≤30 words. The single takeaway sentence the tutor closes with.

REQUIRED FOR v0.4.5 (2026-05-19 user lock — pacing + adaptive teaching). Lessons missing these fields ship as "draft thinness" and prompt user re-gen:

  expected_duration_min — number, default 25, range 15-50. Target in-session interactive teaching time. The tutor reads this and paces accordingly. Per user lock: lessons under 20 min = "死板速通" = failure mode; lessons over 40 min lose attention.

  transfer_cases — array of 2-4 objects. Concrete NEW scenarios (! the canonical_example) for the APPLY state to probe. Tutor uses these to force student into Feynman transfer-test: "now use the same mechanism to read THIS new case." Each: { "description": "1-2 sentence scenario, named subject + specific situation", "expected_response": "what a deep-understanding student would map onto this case" }. Without transfer_cases, APPLY state degrades and tutor can't test true comprehension. MUST be different domain/era/subject from canonical_example, not paraphrase.

  practice_assignments — array of 1-3 objects. Post-lesson tasks the student does PRIVATELY (≥30 min total across the array). Tutor writes these verbatim at LATCH state. Each: { "task": "1-2 sentence concrete action (find / write / sketch / observe)", "expected_minutes": 10-30, "deliverable": "what student brings to next session — '200 字 written' / 'sketch' / 'list of 3 examples'" }. These extend 25-min in-session into 1+ hour total commitment.

  answer_quality_rubric — object with three string arrays. The tutor's measuring stick for evaluating student answers turn-by-turn.
    {
      "strong_signals":   [3-5 strings, each ≤25 words: what a GOOD student answer demonstrates. e.g. "学生独立列举 ≥1 counter-case", "学生 transfer 框架到 unprompted 新领域"]
      "weak_signals":     [3-5 strings, each ≤25 words: what a WEAK answer looks like. e.g. "重复 tutor 措辞但无独立例", "回避 self-application turn 转生第二个示例"]
      "must_correct_if":  [2-4 strings, each ≤25 words: hard triggers — tutor MUST challenge/redirect, not validate. e.g. "学生将 contested 框架当 settled science", "学生 deflect 自省 turn → 重新拉回必"]
    }
    Without this rubric, the tutor has no measuring stick and defaults to validation. Per 2026-05-19 council Leo: "if the tutor has no rubric, the tutor's praise is structurally meaningless."

HUMANITIES ARCHETYPE FLOOR (per 2026-05-19 council Leo + Lung — applies when goalContract suggests humanities/social sciences/literature/philosophy/history):
  frameworks          — array of 2-4 objects. The primary framework being taught PLUS ≥1 rival school that contests it. Format: [{ "name": "Cambridge Ritualist (Harrison 1912)", "position": "ritual precedes myth" }, { "name": "Burkert structuralist (1979)", "position": "ritual + myth co-evolve, neither prior" }]. Lesson MUST expose the controversy, never present contested-as-settled.
  counter_cases       — array of 1-3 objects. Concrete cases where the primary framework FAILS or is contested. Format: [{ "phenomenon": "Cargo cults generate ritual FROM myth (planes will come if we build runways, Worsley 1957)", "why_it_breaks_thesis": "reverse direction — narrative scripted the embodied action" }]. Tutor uses these to force student into Feynman-test (apply to case where framework FAILS).

CONSTRAINTS:
- Service: north_star_goal first, then main_creation, then learn_goal of THIS lesson.
- Forbidden words: AI, LLM, embedding, model, prompt, agent, RAG, vector, fine-tune.
- AI-tell scrub: NO "这一刀" / NO "闭环 / 拉满 / 王炸 / 干货 / 直击灵魂 / 真香 / yyds / 绝绝子 / 上分 / 上车 / 内卷 / 出圈".
- Manuscript register: serif-cadence, ! exclamation marks, ! "great question!".
- Ground in SOURCES below — do not invent named people/years/numbers if no source supports them. If no source: pick fallback per learn-start.txt:48 (present-tense laboratory / sensory metaphor).
- common_misconceptions MUST be sourced from your knowledge of how learners typically err on this topic — they should be FALSIFIABLE wrong-priors, not strawmen.
- thesis must NOT begin with "Introduction to" / "An overview of" / "本课介绍" / "本课讨论" — those are encyclopedia framings.
- CITATION TOKENS (R-LIB v0.1): Some SOURCES carry an inline [CITE:book_id:chunk_idx] or [CITE:pack:pack_id] marker. When you use that source's content in mechanism_explanation / canonical_example / common_misconceptions, you MUST keep the bracketed marker inline next to the relevant claim. Markers are post-parsed into structured evidence_cite[] entries — do not paraphrase them away, do not invent new markers, do not duplicate. Marker format is literal: square-bracket, "CITE:", id1, ":", id2, close-bracket.

EVIDENCE LEDGER v1.0 (boot-9, 2026-05-20 — per-claim provenance, OPTIONAL but RECOMMENDED):
Emit an evidence_ledger[] array alongside the body fields. Each entry binds ONE structural claim to the source(s) backing it. Schema:
  evidence_ledger: [
    { "claim_id": "thesis | mechanism | canonical_example | misconception_0 | misconception_1 | example_0 | example_1 | example_2",
      "evidence_refs": [
        { "source_id": "book:<book_id>:<chunk_idx> | pack:<pack_id> | url:<full_url>",
          "weight": 0..1,
          "kind": "direct | corroborating | tangential" }
      ]
    }
  ]
Use the SOURCES block above as your source_id pool — each library source has its book_id + chunk_idx, each pack source has its pack_id (visible in the [CITE:...] markers). When you ground thesis/mechanism/canonical_example/misconception[i]/example[i] in a SOURCE, emit a matching ledger row referencing it. kind=direct = source verbatim states this claim; corroborating = source supports but doesn't state; tangential = adjacent context. If no source backs a claim, omit it from the ledger (leaving it an orphan claim — the Trust Panel will surface gentle "N orphan" warning, NOT block ship). Do not invent source_ids not in the SOURCES block. ledger entries are SEPARATE from inline [CITE:...] markers; both may coexist.

Return STRICT JSON only. No prose preamble.`;

// R-LIB Day 5 (2026-05-12): post-parse [CITE:b:c] markers out of generated
// body / KP arc, resolve each against the ranked source list, return structured
// evidence_cite[] array. The marker stays inline in the prose for human reading
// (e.g. "...实体不可分 [CITE:abc123:2]..."), but the structured array gives
// downstream consumers (NOTE wikilink renderer, PRODUCTION SCAFFOLD grader)
// the resolved book_id / chunk_idx / snippet to render footnotes + back-link.
//
// Markers come in 2 flavors:
//   [CITE:<book_id>:<chunk_idx>]  — library source (book_id = sha1 12-char hex, chunk_idx = int)
//   [CITE:pack:<pack_id>]         — community source (pack_id = slug like spinoza-zh)
//
// Unknown markers (LLM hallucination — referencing a source not in rankedSources)
// are filtered out + counted in _meta.unresolved_cites so downstream can
// surface "LLM invented 2 citations" warning if it gets bad.
const _CITE_MARKER_RX = /\[CITE:([^:\s\]]+):([^\]\s]+)\]/g;

// 2026-05-19 Phase 4 — Anti-Slop bridge helper. Emits a fidelity tag for
// low-quality sources so architect's prompt sees grounding fidelity info +
// can self-confession ("本节材料 OCR-提取, 表格保真低, 引用谨慎").
// Tag is silent on high-fidelity sources (≥ 0.7) to avoid prompt clutter.
// Reads s.fidelity_score / s.fidelity_tier / s.parsed_level (set by agent.js
// when harvesting library sources — backward-compat: missing fields → no tag).
function _formatFidelityTag(s) {
  if (!s || typeof s.fidelity_score !== 'number') return '';
  // v2 2026-05-19 — threshold lowered 0.70 → 0.60 after backfill survey of
  // user's actual library (12 books): mean mid-tier sits at 0.62-0.68, only
  // truly-degraded sources score < 0.60 (= 4/12 books, Copleston Vol 7-11
  // worse-scan). Old 0.70 cut flagged 11/12 → noise-flood. New cut flags 4/12
  // → clean signal aligned with user's intuitive "OCR translation quality drop".
  if (s.fidelity_score >= 0.60) return '';
  const tier = s.fidelity_tier || (s.fidelity_score >= 0.5 ? 'mid' : 'low');
  const levelHint = s.parsed_level === 'ocr' ? ' OCR'
    : s.parsed_level === 'raw-extract' ? ' raw-extract'
    : s.parsed_level === 'raw-stash' ? ' stash'
    : '';
  return ` [fidelity=${s.fidelity_score.toFixed(2)} ${tier}${levelHint}]`;
}

function _extractCitations(obj, rankedSources) {
  const text = JSON.stringify(obj || {});
  const seen = new Map();
  const unresolved = [];
  let m;
  _CITE_MARKER_RX.lastIndex = 0;
  while ((m = _CITE_MARKER_RX.exec(text)) !== null) {
    const id1 = m[1];
    const id2 = m[2];
    const key = `${id1}:${id2}`;
    if (seen.has(key)) continue;
    let resolved = null;
    if (id1 === 'pack') {
      const src = rankedSources.find(s => s && s.sourceType === 'community' && s.pack_id === id2);
      if (src) {
        resolved = {
          marker: `[CITE:${key}]`,
          cite_type: 'community',
          pack_id: id2,
          pack_curator: src.pack_curator || null,
          title: src.title || null,
          url: src.url || null,
          snippet: (src.excerpt || '').slice(0, 240),
        };
      }
    } else {
      const chunkIdx = parseInt(id2, 10);
      const src = rankedSources.find(s =>
        s && s.sourceType === 'library' &&
        String(s.book_id) === id1 &&
        Number(s.chunk_idx) === chunkIdx
      );
      if (src) {
        resolved = {
          marker: `[CITE:${key}]`,
          cite_type: 'library',
          book_id: id1,
          chunk_idx: chunkIdx,
          chunk_type: src.chunk_type || null,
          book_title: (src.title || '').split(' — ')[0] || null,
          chunk_title: (src.title || '').split(' — ')[1] || null,
          book_author: src.book_author || null,
          vec_origins: Array.isArray(src.vec_origins) ? [...src.vec_origins] : [],
          snippet: (src.excerpt || '').slice(0, 240),
        };
      }
    }
    if (resolved) seen.set(key, resolved);
    else unresolved.push(`[CITE:${key}]`);
  }
  return {
    evidence_cite: [...seen.values()],
    unresolved_cites: unresolved,
  };
}

function buildBodyV2UserMessage({ plan, goalContract, audience, learnerState, rankedSources, lessonTitle, learnGoal, idx, callbackBlock }) {
  const sourcesBlock = (Array.isArray(rankedSources) && rankedSources.length > 0)
    ? rankedSources.map((s, i) => {
        const tag = s.sourceType || 'src';
        const title = String(s.title || `Source ${i + 1}`).slice(0, 100);
        const excerpt = String(s.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 350);
        const url = s.url ? ` (${s.url})` : '';
        let citeMarker = '';
        if (tag === 'library' && s.book_id != null && s.chunk_idx != null) {
          citeMarker = ` [CITE:${s.book_id}:${s.chunk_idx}]`;
        } else if (tag === 'community' && s.pack_id) {
          citeMarker = ` [CITE:pack:${s.pack_id}]`;
        }
        // 2026-05-19 Anti-Slop bridge — surface low-fidelity sources so architect
        // can self-confession ("本节材料 OCR-提取, 表格保真低, 引用谨慎"). Only
        // tag when score is genuinely low (< 0.7); silent on high-fidelity.
        const fidTag = _formatFidelityTag(s);
        return `--- Source ${i + 1} [${tag}]${citeMarker}${fidTag}: ${title}${url} ---\n${excerpt || '(no excerpt available — cite by title only)'}`;
      }).join('\n\n')
    : '(no sources available — proceed without grounding citations; pick fallback opener per spec)';

  // R3 2026-05-13 — per-lesson KP target from resolveLessonShape (sits on
  // plan.target_count). When present, the architect must shape mechanism +
  // canonical_example density to fit exactly N knowledge points, not the
  // legacy fixed ~7. Emit a single-line directive only when stamped.
  const _kpTarget = (plan && Number.isFinite(plan.target_count) && plan.target_count > 0)
    ? plan.target_count
    : null;
  const kpTargetLine = _kpTarget
    ? `\n本课时 KP 目标 = ${_kpTarget} — shape mechanism_explanation density + canonical_example coverage to land exactly this many knowledge points. NOT the legacy fixed-7 default.`
    : '';

  // Phase D.1 (2026-05-18) — callback block goes BETWEEN goal contract and
  // sources so the architect sees user's prior productions before grounding
  // in canonical sources. Empty string when no callback material (lesson 0
  // or no prior user productions) — caller passes '' and template prints clean.
  const cbBlock = (typeof callbackBlock === 'string' && callbackBlock.trim())
    ? `\n${callbackBlock}\n`
    : '';

  return `LESSON CONTEXT
  topic_chain        : ${(goalContract && goalContract.north_star_goal) || ''}
  this_lesson_idx    : ${idx | 0} (sequence position)
  this_lesson_title  : ${lessonTitle || ''}
  this_lesson_goal   : ${learnGoal || (plan && plan.objective) || ''}
  audience           : ${audience || 'self-directed adult learner'}
  learner_state      : ${JSON.stringify(learnerState || { known: [], unknown: [] })}${kpTargetLine}

PLAN (6-field skeleton from designSeed):
${JSON.stringify(plan || {}, null, 2).slice(0, 2000)}

GOAL CONTRACT:
${JSON.stringify(goalContract || {}, null, 2).slice(0, 1000)}
${cbBlock}
SOURCES (BM25-ranked top-6 by best_use=lesson; ground specifics in these):
${sourcesBlock}

Generate the lesson body JSON.`;
}

// Required field validator. Optional fields are not enforced.
function validateBodyV2(body, opts = {}) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['body must be an object'];
  // V0.4.4 — opts.archetype enables HUMANITIES floor (frameworks ≥2 +
  // counter_cases ≥1). Backward-compat: opts undefined / archetype unset
  // means base validation only, no floor.
  const archetype = opts.archetype || null;

  const required = {
    thesis:                ['string', 5, 200],
    canonical_example:     ['string', 30, 600],
    exit_proof:            ['string', 20, 400],
    mechanism_explanation: ['string', 30, 1200],
    note_connection:       ['string', 5, 250],
  };
  for (const [key, [type, minLen, maxLen]] of Object.entries(required)) {
    const v = body[key];
    if (typeof v !== type) { errors.push(`${key}: expected ${type}, got ${typeof v}`); continue; }
    const len = String(v).length;
    if (len < minLen) errors.push(`${key}: too short (${len} < ${minLen})`);
    if (len > maxLen) errors.push(`${key}: too long (${len} > ${maxLen})`);
  }
  // common_misconceptions array of exactly 2 strings.
  if (!Array.isArray(body.common_misconceptions)) {
    errors.push('common_misconceptions: must be array');
  } else if (body.common_misconceptions.length !== 2) {
    errors.push(`common_misconceptions: expected exactly 2 entries, got ${body.common_misconceptions.length}`);
  } else {
    body.common_misconceptions.forEach((m, i) => {
      if (typeof m !== 'string' || m.length < 10) errors.push(`common_misconceptions[${i}]: too short or wrong type`);
    });
  }
  // jargon_list array, max 5 strings.
  if (!Array.isArray(body.jargon_list)) {
    errors.push('jargon_list: must be array (use [] when no new jargon needed)');
  } else if (body.jargon_list.length > 5) {
    errors.push(`jargon_list: too many entries (${body.jargon_list.length} > 5)`);
  }

  // 2026-05-20 GP3 closure — concepts + prerequisite_concepts.
  //
  // Backward-compat: bodies generated pre-2026-05-20 lack these fields. We
  // tolerate missing (default to [] in post-process) but FAIL hard on
  // wrong-type (string / object / non-array) so a malformed emit cannot
  // silently poison the contamination graph. Per Lens 9 SURGICAL: extend
  // validation, never rewrite it; never hard-fail legacy bodies for absence.
  //
  // The contamination-graph + concept-ledger readers both expect arrays of
  // strings (see app/lib/anti-slop/contamination-graph.js:113-131,
  // app/lib/anti-slop/concept-ledger.js:26-46). Match that contract exactly.
  if (body.concepts !== undefined) {
    if (!Array.isArray(body.concepts)) {
      errors.push('concepts: must be array of strings (got ' + typeof body.concepts + ')');
    } else {
      body.concepts.forEach((c, i) => {
        if (typeof c !== 'string') {
          errors.push(`concepts[${i}]: must be string, got ${typeof c}`);
        } else if (c.length > 60) {
          errors.push(`concepts[${i}]: too long (${c.length} chars > 60 — concepts are BARE TERMS, not glosses)`);
        }
      });
      if (body.concepts.length > 12) {
        errors.push(`concepts: too many entries (${body.concepts.length} > 12 — pick the load-bearing terms)`);
      }
    }
  }
  if (body.prerequisite_concepts !== undefined) {
    if (!Array.isArray(body.prerequisite_concepts)) {
      errors.push('prerequisite_concepts: must be array of strings (got ' + typeof body.prerequisite_concepts + ')');
    } else {
      body.prerequisite_concepts.forEach((c, i) => {
        if (typeof c !== 'string') {
          errors.push(`prerequisite_concepts[${i}]: must be string, got ${typeof c}`);
        } else if (c.length > 60) {
          errors.push(`prerequisite_concepts[${i}]: too long (${c.length} chars > 60 — concepts are BARE TERMS, not sentences)`);
        }
      });
      if (body.prerequisite_concepts.length > 12) {
        errors.push(`prerequisite_concepts: too many entries (${body.prerequisite_concepts.length} > 12 — only the truly required priors)`);
      }
    }
  }

  // Evidence Ledger v1.0 (boot-9, 2026-05-20) — per-claim provenance.
  //
  // Backward-compat: a body WITHOUT evidence_ledger is legal (legacy bodies
  // remain valid). When present, we validate SHAPE only — every row must be
  // { claim_id:string, evidence_refs:array<{source_id:string-with-known-prefix,
  // weight:0..1, kind:'direct'|'corroborating'|'tangential'}> }. Dangling
  // source_ids (no matching evidence_cite[] entry) are tolerated at schema
  // level — they surface later as orphan/invalid via the evidence-ledger
  // library, NOT as a hard schema fail. Per Lens 9 SURGICAL: extend, never
  // rewrite the existing schema; never block legacy bodies on absence.
  if (body.evidence_ledger !== undefined) {
    if (!Array.isArray(body.evidence_ledger)) {
      errors.push('evidence_ledger: must be array (got ' + typeof body.evidence_ledger + ')');
    } else {
      const validKinds = ['direct', 'corroborating', 'tangential'];
      const validPrefixes = ['book:', 'pack:', 'url:'];
      body.evidence_ledger.forEach((row, i) => {
        if (!row || typeof row !== 'object') {
          errors.push(`evidence_ledger[${i}]: must be object`);
          return;
        }
        if (typeof row.claim_id !== 'string' || !row.claim_id.trim()) {
          errors.push(`evidence_ledger[${i}].claim_id: must be non-empty string`);
        }
        if (!Array.isArray(row.evidence_refs)) {
          errors.push(`evidence_ledger[${i}].evidence_refs: must be array (use [] for empty)`);
          return;
        }
        row.evidence_refs.forEach((r, j) => {
          if (!r || typeof r !== 'object') {
            errors.push(`evidence_ledger[${i}].evidence_refs[${j}]: must be object`);
            return;
          }
          if (typeof r.source_id !== 'string' || !r.source_id.trim()) {
            errors.push(`evidence_ledger[${i}].evidence_refs[${j}].source_id: must be non-empty string`);
          } else if (!validPrefixes.some(p => r.source_id.startsWith(p))) {
            errors.push(`evidence_ledger[${i}].evidence_refs[${j}].source_id: prefix must be one of book:/pack:/url: (got "${String(r.source_id).slice(0, 24)}")`);
          }
          if (r.kind !== undefined && !validKinds.includes(r.kind)) {
            errors.push(`evidence_ledger[${i}].evidence_refs[${j}].kind: must be one of ${validKinds.join('|')} (got ${r.kind})`);
          }
          if (r.weight !== undefined && (typeof r.weight !== 'number' || !Number.isFinite(r.weight) || r.weight < 0 || r.weight > 1)) {
            errors.push(`evidence_ledger[${i}].evidence_refs[${j}].weight: must be number in [0, 1] (got ${r.weight})`);
          }
        });
      });
    }
  }

  // Encyclopedia-framing red flag (cheap pre-check; goal-drift-detector deeper later).
  const t = String(body.thesis || '').trim();
  if (/^(introduction to|an overview of|本课介绍|本课讨论|本节介绍)/i.test(t)) {
    errors.push('thesis: encyclopedia framing detected (starts with "Introduction to / An overview of / 本课介绍 / 本课讨论")');
  }

  // v0.2 Track C C2 — hook_concrete: opening must be a concrete scene.
  // Picks intro_hook_scene if non-empty, else falls back to canonical_example
  // (canonical_example carries the recurring anchor and is closest in spirit
  // to "the thing that grounds the first 30 seconds"). On match, push error
  // so the existing retry-once schema-validation flow regens with feedback.
  const hookField = (body.intro_hook_scene && String(body.intro_hook_scene).trim())
    ? 'intro_hook_scene'
    : (body.canonical_example && String(body.canonical_example).trim()) ? 'canonical_example' : null;
  if (hookField) {
    const opener = String(body[hookField]).trim().slice(0, 100);
    if (HOOK_ABSTRACT_RE.test(opener)) {
      errors.push(`hook_abstract: ${hookField} opens with abstract definition framing — rewrite as concrete scene (named person, specific moment, or sensory detail)`);
    }
  }

  // V0.4.4 — HUMANITIES floor (2026-05-19 council Leo + Lung). Bodies for
  // humanities lessons MUST expose framework controversy + concrete counter-
  // cases, else they teach contested-as-settled (epistemic malpractice per
  // Leo). Floor: frameworks≥2 (primary + ≥1 rival) + counter_cases≥1.
  if (archetype === 'HUMANITIES') {
    const fws = Array.isArray(body.frameworks) ? body.frameworks : [];
    const ccs = Array.isArray(body.counter_cases) ? body.counter_cases : [];
    if (fws.length < 2) {
      errors.push(`HUMANITIES floor: frameworks=${fws.length} (need ≥2: primary + ≥1 rival school. Never present contested-as-settled — expose the controversy)`);
    } else {
      fws.forEach((f, i) => {
        if (!f || typeof f !== 'object' || !f.name || !f.position) {
          errors.push(`frameworks[${i}]: requires { name, position } object`);
        }
      });
    }
    if (ccs.length < 1) {
      errors.push(`HUMANITIES floor: counter_cases=${ccs.length} (need ≥1: concrete case where primary framework FAILS. Tutor uses this for Feynman falsification)`);
    } else {
      ccs.forEach((c, i) => {
        if (!c || typeof c !== 'object' || !c.phenomenon || !c.why_it_breaks_thesis) {
          errors.push(`counter_cases[${i}]: requires { phenomenon, why_it_breaks_thesis } object`);
        }
      });
    }
  }

  // V0.4.4 — expected_duration_min: numeric range 15-50. Default 25 if absent.
  if (body.expected_duration_min !== undefined) {
    const d = body.expected_duration_min;
    if (typeof d !== 'number' || !Number.isFinite(d)) {
      errors.push('expected_duration_min: must be number');
    } else if (d < 15 || d > 50) {
      errors.push(`expected_duration_min: ${d} out of range [15, 50]. Default 25.`);
    }
  }

  // V0.4.4 — transfer_cases: 2-4 objects each {description, expected_response}.
  // Required for APPLY state to probe true comprehension. Without them, tutor
  // degrades to surface VERIFY only.
  if (body.transfer_cases !== undefined) {
    const tcs = body.transfer_cases;
    if (!Array.isArray(tcs)) {
      errors.push('transfer_cases: must be array');
    } else if (tcs.length < 2) {
      errors.push(`transfer_cases: ${tcs.length} (need ≥2 for APPLY state — 1 transfer_case = state degrades to one-shot test)`);
    } else if (tcs.length > 4) {
      errors.push(`transfer_cases: ${tcs.length} (max 4 — more = lesson over-runs)`);
    } else {
      tcs.forEach((t, i) => {
        if (!t || typeof t !== 'object' || !t.description || !t.expected_response) {
          errors.push(`transfer_cases[${i}]: requires { description, expected_response } object`);
        }
      });
    }
  }

  // V0.4.4 — practice_assignments: 1-3 objects {task, expected_minutes, deliverable}.
  // LATCH state writes these to student verbatim. Without them, 1-hour total
  // commitment never lands — chat ends + student forgets.
  if (body.practice_assignments !== undefined) {
    const pa = body.practice_assignments;
    if (!Array.isArray(pa)) {
      errors.push('practice_assignments: must be array');
    } else if (pa.length < 1) {
      errors.push('practice_assignments: must have ≥1 task (else 1-hour commitment unreachable)');
    } else if (pa.length > 3) {
      errors.push(`practice_assignments: ${pa.length} (max 3 — more = overwhelm)`);
    } else {
      pa.forEach((p, i) => {
        if (!p || typeof p !== 'object' || !p.task) {
          errors.push(`practice_assignments[${i}]: requires { task, expected_minutes, deliverable } object — at minimum task field`);
        }
        if (p && typeof p.expected_minutes === 'number' && (p.expected_minutes < 5 || p.expected_minutes > 90)) {
          errors.push(`practice_assignments[${i}].expected_minutes: ${p.expected_minutes} out of range [5, 90]`);
        }
      });
    }
  }

  // V0.4.4 — answer_quality_rubric optional schema check. When present, must
  // have non-empty 3 sub-arrays. Without rubric, tutor defaults to validation
  // (per Leo). Lessons without rubric still ship but emit _meta.no_rubric=true
  // so Trust Panel can show "tutor has no measuring stick" badge.
  if (body.answer_quality_rubric !== undefined) {
    const r = body.answer_quality_rubric;
    if (!r || typeof r !== 'object') {
      errors.push('answer_quality_rubric: must be object with strong_signals / weak_signals / must_correct_if arrays');
    } else {
      for (const key of ['strong_signals', 'weak_signals', 'must_correct_if']) {
        if (!Array.isArray(r[key])) {
          errors.push(`answer_quality_rubric.${key}: must be array of strings`);
        } else if (r[key].length === 0) {
          errors.push(`answer_quality_rubric.${key}: must have ≥1 entry (empty rubric defeats the purpose)`);
        }
      }
    }
  }

  return errors;
}

/**
 * Generate the v0.2 lesson body for one lesson.
 *
 * @param {object} args
 * @param {object} args.plan          — 6-field plan skeleton from designSeed/proposeNextLesson
 * @param {object} args.goalContract  — { north_star_goal, main_creation, current_level, ...forbidden_drifts }
 * @param {Array}  [args.sources]     — sources.json entries (will be BM25-ranked + filtered to best_use=lesson)
 * @param {string} [args.audience]    — defaults to 'self-directed adult learner'
 * @param {object} [args.learnerState]— { known: [], unknown: [], gaps: [] }
 * @param {string} [args.lessonTitle]
 * @param {string} [args.learnGoal]
 * @param {number} [args.idx]
 * @param {object} [args.options]
 * @param {number} [args.options.maxRetries=1]
 * @param {string} [args.options.capability='T6_STRONG']
 * @param {number} [args.options.maxTokens=3000]
 * @param {number} [args.options.timeoutMs=90000]
 * @returns {Promise<{body, _meta}>}
 */
async function generateLessonBodyV2({
  plan, goalContract, sources, audience, learnerState,
  lessonTitle, learnGoal, idx,
  // W8.3 — slug passes through so adaptive UX (density/language) can apply
  // user preferences to prose-bearing body fields on the success path.
  slug,
  // V0.4.5 (2026-05-19) — pedagogicalArchetype enables HUMANITIES floor in
  // validateBodyV2 (frameworks ≥2 + counter_cases ≥1). Callers pass state.archetype.
  // Backward-compat: undefined → base validation only, floor not applied.
  pedagogicalArchetype,
  options = {},
  // v0.2.1 — preview-and-approve regen. When user clicks "需要修改" in
  // PreviewCard + submits free-text, main.js reads the prior body off disk and
  // invokes us with both. Same message-shape as the drift-regen idiom (see
  // line ~322): append assistant(prior body JSON) + user(feedback prose).
  // Schema validation + drift gate + hook_concrete still run on the regen
  // result; if regen fails schema OR drifts on a 2nd consecutive attempt, the
  // prior body is preserved (defensive — main.js writes the new body only
  // after we return successfully).
  priorBody,
  userFeedback,
} = {}) {
  if (!plan || typeof plan !== 'object') throw new Error('plan (object) required');

  const ranker = _getRanker();
  const query = [
    learnGoal || '',
    lessonTitle || '',
    (plan && plan.objective) || '',
    (goalContract && goalContract.north_star_goal) || '',
  ].filter(Boolean).join(' ').trim();
  const srcArr = Array.isArray(sources) ? sources : [];
  const ranked = (ranker && query && srcArr.length > 0)
    ? ranker(srcArr, query, 6, { desiredUse: 'lesson' })
    : srcArr.slice(0, 6);

  const maxRetries = (options && Number.isFinite(options.maxRetries)) ? options.maxRetries : 1;
  const capability = (options && options.capability) || 'T6_STRONG';
  const maxTokens = (options && Number.isFinite(options.maxTokens)) ? options.maxTokens : 3000;
  const timeoutMs = (options && Number.isFinite(options.timeoutMs)) ? options.timeoutMs : 90_000;

  // Phase D.1 (2026-05-18) — load callback block (user productions from
  // prior lessons in this chain). Architect bakes user's words into
  // note_connection + canonical_example so identity persists across lessons
  // (Hattie d=0.72 relationship — dominant variance source per council).
  // Empty string when lesson 0 / no prior productions / vault unreadable.
  let _callbackBlock = '';
  try {
    const ci = require('./identity/callback-inject');
    _callbackBlock = ci.buildCallbackBlockForArchitect({
      chainSlug: slug,
      lessonIdx: Number.isFinite(idx) ? idx : 0,
      lookback: 3,
    });
  } catch (err) {
    // Identity primitive is optional — body generation must never break on its absence.
    console.warn('[lesson-body-generator] callback-inject failed (non-fatal):', err && err.message);
  }

  const userMsg = buildBodyV2UserMessage({
    plan, goalContract, audience, learnerState,
    rankedSources: ranked, lessonTitle, learnGoal, idx,
    callbackBlock: _callbackBlock,
  });

  let messages = [
    { role: 'system', content: BODY_V2_SYSTEM_PROMPT },
    { role: 'user', content: userMsg },
  ];

  // v0.2.1 — append user-feedback regen turn when both priorBody + userFeedback
  // present. Same shape as drift-regen idiom further down (assistant echoes
  // prior, user gives feedback). Treat empty feedback as no-op.
  if (priorBody && typeof userFeedback === 'string' && userFeedback.trim()) {
    messages = [
      ...messages,
      { role: 'assistant', content: JSON.stringify(priorBody) },
      { role: 'user', content: `USER FEEDBACK ON PRIOR ATTEMPT:\n${userFeedback.trim()}\n\nRewrite the body JSON to address this feedback. Keep the 7-field schema + all CONSTRAINTS. Same JSON shape. Return STRICT JSON only.` },
    ];
  }

  // v0.2 Track C C1 — drift gate state. After schema validation succeeds,
  // we run detectDrift; on drift > threshold, we regen ONCE with a feedback
  // turn appended. Tracked across the schema-retry loop so a body that passes
  // schema but trips drift gets exactly one drift-regen attempt.
  let _driftRegenUsed = false;
  let _lastSchemaResult = null;
  let _lastSchemaMeta = null;

  for (let attempt = 0; attempt <= maxRetries + 1; attempt++) {
    const t0 = Date.now();
    const dispatch = await executeChat(capability, {
      messages,
      json: true,
      temperature: 0.6,
      maxTokens,
      timeoutMs,
    });
    const ms = Date.now() - t0;
    // V0.5 E0 D11-D14 Phase 1 — record cost-estimate row for lessonBody call.
    // Wrapped: recordChatCallEstimate must never break body generation.
    try {
      sqliteDb.recordChatCallEstimate(dispatch, 'lessonBody', {
        latency_ms: ms,
        tuple_id: lessonTitle || null,
        slug: slug || null,
        success: true,
      });
    } catch (err) {
      console.warn('[recordChatCallEstimate] lessonBody title=', lessonTitle || '_unknown', 'err=', err && err.message);
    }
    const result = dispatch && dispatch.result;
    const errors = validateBodyV2(result, { archetype: pedagogicalArchetype });
    if (errors.length === 0) {
      // Optional jargon firewall sanity (monitor-only).
      const j = _getJargon();
      let jargonViolations = 0;
      try {
        if (j && typeof j.checkJargon === 'function') {
          const check = j.checkJargon(JSON.stringify(result));
          if (check && Array.isArray(check.violations)) jargonViolations = check.violations.length;
        }
      } catch (_) { /* monitor-only */ }

      const baseMeta = {
        ms,
        attempt: attempt + 1,
        provider: dispatch && dispatch.providerId,
        model: dispatch && dispatch.model,
        attempts: dispatch && dispatch.attempts,
        ranked_source_count: ranked.length,
        jargon_violations: jargonViolations,
        schema_version: 'v2',
      };

      // v0.2 Track C C1 — drift gate. If detector available, run against the
      // body. On drift > threshold and we haven't yet used our regen, append
      // feedback turn + continue the loop for one more attempt. On a SECOND
      // drift, return body anyway with _meta.drift_warning populated — main.js
      // surfaces that as a sibling drift-warning.json + trust-panel signal.
      const detector = _getDriftDetector();
      let driftReport = null;
      // Audit-A red 修复 (2026-05-14): track whether forbidden_drifts came from
      // the user explicitly (via onboarding) or was silently filled with the
      // 5 HYPHA defaults. Surfaced in body._meta.user_explicit_drifts so the
      // Course Trust Panel can render "Drift Detector 用的是你设的 / HYPHA 默认".
      let _driftsAreDefault = false;
      if (detector && typeof detector.detectDrift === 'function') {
        try {
          const gc = (goalContract && typeof goalContract === 'object') ? { ...goalContract } : {};
          if (!Array.isArray(gc.forbidden_drifts) || gc.forbidden_drifts.length === 0) {
            gc.forbidden_drifts = DEFAULT_FORBIDDEN_DRIFTS.slice();
            _driftsAreDefault = true;
          }
          driftReport = detector.detectDrift(gc, result);
        } catch (_) { /* monitor-only — drift gate must never break body gen */ }
      }

      const driftScore = (driftReport && Number.isFinite(driftReport.drift_score))
        ? driftReport.drift_score
        : null;

      if (driftScore !== null && driftScore > DRIFT_THRESHOLD && !_driftRegenUsed) {
        _driftRegenUsed = true;
        _lastSchemaResult = result;
        _lastSchemaMeta = baseMeta;
        const flagSummary = (driftReport.violations && driftReport.violations.length)
          ? driftReport.violations.slice(0, 4).map(v => `${v.axis}:${v.text}`).join('; ')
          : `axes=${JSON.stringify(driftReport.axes || {})}`;
        messages = [
          ...messages,
          { role: 'assistant', content: JSON.stringify(result) },
          { role: 'user', content: `PRIOR ATTEMPT TRIGGERED GOAL DRIFT (score=${driftScore} > ${DRIFT_THRESHOLD}). Triggered axes/flags: ${flagSummary}. Rewrite the body to avoid these drift modes — anchor every field to north_star_goal + main_creation; remove encyclopedia framing; cut jargon load; sharpen thesis to ONE specific claim/skill. Same JSON shape; same schema; just less drift.` },
        ];
        continue;
      }

      // 2026-05-20 GP3 closure — concepts + prerequisite_concepts default-fill.
      //
      // If the LLM omitted these (older prompts / strict-budget retries), fill
      // with safe fallbacks so the contamination graph reads SOMETHING rather
      // than degenerating to zero-edges. Order of preference:
      //   1. LLM-emitted (use verbatim if present + valid array)
      //   2. Derive from jargon_list: strip "term — gloss" prefix down to term
      //   3. [] (last resort — won't poison the graph, just yields no edges)
      // prerequisite_concepts has NO heuristic fallback (without LLM grounding
      // we cannot safely guess upstream priors); [] is the honest default.
      if (!Array.isArray(result.concepts)) {
        const fromJargon = Array.isArray(result.jargon_list)
          ? result.jargon_list
              .filter(x => typeof x === 'string')
              .map(s => s.split(/\s+—\s+|\s+--\s+|:/, 1)[0].trim())
              .filter(s => s && s.length <= 60)
          : [];
        result.concepts = fromJargon;
        result._concepts_derived_from = fromJargon.length > 0 ? 'jargon_list' : 'empty_fallback';
      }
      if (!Array.isArray(result.prerequisite_concepts)) {
        result.prerequisite_concepts = [];
        result._prerequisite_concepts_derived_from = 'empty_fallback';
      }

      // R-LIB Day 5: parse [CITE:b:c] markers out of validated body into
      // structured evidence_cite[] + count unresolved (hallucinated) markers.
      const citeResult = _extractCitations(result, ranked);
      result.evidence_cite = citeResult.evidence_cite;

      // W7.3 Citation + Global Trust — annotate each evidence_cite entry with
      // a global trust score + copyright risk tag so the LessonChat surface
      // can render trust badges + risk warning bars. Reuses W6.5 lib via the
      // citation-system orchestrator; cost = pure local computation (no LLM).
      try {
        const _cs = require('./citation-system');
        result.evidence_cite = (result.evidence_cite || []).map((e) => {
          const cite = _cs.createCitation({
            type: e.cite_type === 'community' ? 'pack' : 'book',
            source_id: e.cite_type === 'community' ? e.pack_id : e.book_id,
            source_url: e.url || null,
            page_or_idx: e.chunk_idx != null ? e.chunk_idx : null,
            snippet: e.snippet || '',
            attribution: e.book_author || e.pack_curator || null,
          });
          const trust = _cs.computeGlobalTrust(cite);
          const risk = _cs.assessCopyrightRisk({ content: e.snippet || '', citation: cite, intent: 'private_learn' });
          return Object.assign({}, e, { _trust_score: trust.score, _risk_level: risk.risk_level });
        });
      } catch (_) { /* W7.3 annotation is best-effort; never block the body */ }

      // Evidence Ledger v1.0 (boot-9, 2026-05-20) — gentle drift signal.
      // Compute per-claim grounding %, orphan count, dangling source_id count.
      // Pure-JS, no LLM, no block-on-fail. Surfaces in _meta for Trust Panel.
      let evidenceLedgerMeta = null;
      try {
        const _el = require('./anti-slop/evidence-ledger');
        const _sum = _el.summarize({ lessonBody: result });
        evidenceLedgerMeta = {
          schema_version: 'evidence-ledger-v1',
          total_claims: _sum.total_claims,
          grounded_claims: _sum.grounded_claims,
          grounding_pct: _sum.grounding_pct,
          orphan_count: _sum.orphan_claims.length,
          orphan_claim_ids: _sum.orphan_claims,
          invalid_ref_count: _sum.invalid_refs.length,
          unique_sources_cited: _sum.unique_sources_cited,
          ledger_present: _sum.ledger_present,
        };
      } catch (_) { /* monitor-only; never break body gen on ledger eval */ }

      // Critique-Loop (S66 + S75 + S80 + S88, 2026-05-15 frontier digest).
      // Experimental — OFF by default. Gates: `options.critiqueLoop.enabled`,
      // OR env `HYPHA_CRITIQUE_LOOP=1`. When OFF: emit a 1-line A/B trace with
      // critique_enabled=false (zero LLM cost) so a downstream harness can
      // compare critique-on vs critique-off pass-rates on identical drafts.
      // When ON: MSIFR validators first (cheap short-circuit), then T4_JUDGE
      // critic; on must_revise=true regenerate ONCE max (same retry-loop
      // mechanism as drift gate); on retry failure return original draft with
      // _meta.critique populated for observability.
      const critiqueCfg = (options && options.critiqueLoop) || {};
      const critiqueOn = critiqueCfg.enabled === true
                      || (process && process.env && process.env.HYPHA_CRITIQUE_LOOP === '1');
      let critiqueMeta = null;
      if (critiqueOn) {
        try {
          const { critiqueLessonDraft } = require('./lesson-critique');
          const planForCritique = {
            lessonTitle, learnGoal,
            scope_in:     (plan && plan.scope_in)     || null,
            scope_out:    (plan && plan.scope_out)    || null,
            prerequisite: (plan && plan.prerequisite) || null,
            success_test: (plan && plan.success_test) || (plan && plan.exit_proof) || null,
            failure_test: (plan && plan.failure_test) || null,
            archetype:    pedagogicalArchetype || null,
            lesson_id:    Number.isFinite(idx) ? idx : null,
          };
          const critique = await critiqueLessonDraft({
            draft: result,
            plan: planForCritique,
            modelDraft: dispatch && dispatch.model,
            modelCritic: critiqueCfg.criticModel,
            config: {
              capability: critiqueCfg.capability || 'T4_JUDGE',
              vaultRoot: critiqueCfg.vaultRoot,
              llm: critiqueCfg.llm,
            },
          });
          critiqueMeta = {
            enabled: true,
            score: critique.score,
            must_revise: critique.must_revise,
            criticism_count: (critique.criticism || []).length,
            criticism_sample: (critique.criticism || []).slice(0, 3),
          };
          // must_revise → trigger ONE regeneration with critic feedback. If
          // _driftRegenUsed already burned the regen budget this turn, we ship
          // the original draft + populated critique meta (observability without
          // double-LLM cost).
          if (critique.must_revise && !_driftRegenUsed && attempt < maxRetries + 1) {
            _driftRegenUsed = true; // share the regen budget with drift gate
            _lastSchemaResult = result;
            _lastSchemaMeta = baseMeta;
            const critFeedback = (critique.criticism || []).slice(0, 5)
              .map(c => '  - ' + c)
              .join('\n') || '  (low score; tighten draft against learnGoal + success_test)';
            messages = [
              ...messages,
              { role: 'assistant', content: JSON.stringify(result) },
              { role: 'user', content: `CRITIC REVIEW (score=${critique.score != null ? critique.score.toFixed(2) : 'n/a'} < ${0.7}). Issues:\n${critFeedback}\n\nRewrite the body to address these issues. Same JSON shape; same schema; fix the listed gaps only.` },
            ];
            critiqueMeta.regen_triggered = true;
            continue;
          }
        } catch (err) {
          critiqueMeta = { enabled: true, error: (err && err.message) || String(err) };
        }
      } else {
        // Flag-off path — emit a 1-line trace marker with critique_enabled=false
        // so A/B comparison can be done from a single jsonl file. No LLM cost.
        try {
          const fs = require('node:fs');
          const path = require('node:path');
          const vaultRoot = (critiqueCfg && critiqueCfg.vaultRoot)
            || path.resolve(__dirname, '..', '..', 'vault');
          const traceFile = path.join(vaultRoot, '.hypha', 'quality-trace.jsonl');
          fs.mkdirSync(path.dirname(traceFile), { recursive: true });
          fs.appendFileSync(traceFile, JSON.stringify({
            ts: new Date().toISOString(),
            lesson_id: Number.isFinite(idx) ? idx : null,
            generator: (dispatch && dispatch.model) || 'unknown',
            critic: null,
            score_pre: null,
            score_post: null,
            divergence: 0,
            critique_enabled: false,
          }) + '\n', 'utf8');
        } catch (_) { /* observability only */ }
      }

      return {
        body: _applyAdaptive(result, slug),  // W8.3 adaptive UX surface pass
        _meta: {
          ...baseMeta,
          drift_score: driftScore,
          evidence_ledger: evidenceLedgerMeta,
          critique: critiqueMeta,
          drift_warning: (driftScore !== null && driftScore > DRIFT_THRESHOLD)
            ? {
                score: driftScore,
                axes: driftReport.axes || {},
                violations: (driftReport.violations || []).slice(0, 8),
                attempts: 2,
              }
            : null,
          // intentional-placeholder: course-trust-panel.jsx UI consumption of
          // this field is explicitly out-of-scope for the Audit-A red fix
          // (2026-05-14). This commit ships the honest BACKEND signal — making
          // it visible in the panel is a follow-up surface ticket. The flag
          // is fully populated + correct here; downstream readers can wire it
          // whenever Course Trust Panel v0.2.1 lands. Render strings when
          // adopted: "Drift Detector · 用的是你设的" (true) / "Drift Detector
          // · 用的是 HYPHA 默认 5 条" (false, fallback fired).
          user_explicit_drifts: !_driftsAreDefault,
          evidence_cite_count: citeResult.evidence_cite.length,
          unresolved_cites: citeResult.unresolved_cites,
        },
      };
    }

    if (attempt < maxRetries + (_driftRegenUsed ? 1 : 0)) {
      messages = [
        ...messages,
        { role: 'assistant', content: JSON.stringify(result) },
        { role: 'user', content: `Body validation failed:\n${errors.map(e => '  - ' + e).join('\n')}\n\nRegenerate strictly per the SCHEMA + CONSTRAINTS. Same JSON shape; fix the listed issues only.` },
      ];
      continue;
    }
    // If we already passed schema once but the drift-regen attempt failed
    // schema, fall back to the prior schema-passing body with a warning.
    if (_lastSchemaResult) {
      return {
        body: _lastSchemaResult,
        _meta: {
          ..._lastSchemaMeta,
          drift_warning: {
            score: null,
            note: 'drift-regen attempt failed schema; returned prior schema-valid body',
            attempts: 2,
          },
        },
      };
    }
    throw new Error(`generateLessonBodyV2 failed schema validation after ${maxRetries + 1} attempts: ${errors.join('; ')}`);
  }
}

// =====================================================================
// KP narrative arc generator (pedagogy.md 2026-05-11 Layer 4 / Phase B 改动 3).
//
// Per knowledge-point sibling to generateLessonBodyV2. Preserves the 11-field
// body (shipped 2026-05-09, consumed by trust panel) and adds the 7+1
// narrative arc fields PER KP. Called after generateLessonBodyV2 returns and
// generateKPSeeds (lesson-generator.js) yields the seed array; one invocation
// per KP. Output array is sibling to body — Migration Matrix dual-write rule.
//
// Schema contract (pedagogy.md Layer 4 table):
//   1. lineage_link[]       required (may be [] for first KP)
//   2. definition           required, non-empty string
//   3. derivation_chain[]   required (may be [] for definition-only KP)
//   4. critique_of[]        required (may be [] for no-critique KP)
//   5. analogy              CONDITIONAL — gated by pedagogical archetype:
//                             HUMANITIES → MUST be null
//                             TECH-CONCEPT / TECH-PROC → MUST be non-empty string
//                             LANG-ACQ / DECL-MASS / MINDSET → null OR string
//   6. connects_to_next[]   required (may be [] for last KP in lesson)
//   7. intent_use_map       required, ≥1 intent must map to ≥1 slot
//   8. paraphrase_prompt    required, non-empty string

const KP_ARC_RELATIONS = ['prereq', 'opposite', 'corollary', 'co-construct'];
const KP_ARC_LINEAGE_RELATIONS = ['批判', '类比', '后续被反驳', '前驱', '共构'];
const KP_ARC_INTENTS = ['考研', '兴趣', '论文', '复盘'];

const SCAFFOLD_SLOTS = {
  '考研': ['承上', '主要内容', '评价', '提高技巧'],
  '兴趣': ['钩子', 'mechanism例', '日常关系', '跨思想家对比'],
  '论文': ['上下文铺垫', 'claim+论证', '反驳+你的立场', '推进方向'],
  '复盘': ['1句核心', '3关键关系', '1反例', '比上次新明白的'],
};

const HUMANITIES_PED_ARCHETYPE = 'HUMANITIES';
const TECH_PED_ARCHETYPES = ['TECH-CONCEPT', 'TECH-PROC'];

function analogyPolicy(pedArchetype) {
  if (pedArchetype === HUMANITIES_PED_ARCHETYPE) return 'SKIP';
  if (TECH_PED_ARCHETYPES.includes(pedArchetype)) return 'REQUIRED';
  return 'OPTIONAL';
}

const KP_ARC_SYSTEM_PROMPT = `You are a HYPHA KP narrative-arc author. Given a single knowledge-point seed + lesson context, produce a 7+1 typed narrative arc that captures how a PhD lecturer actually teaches one concept (per pedagogy.md Layer 4 — 4 PPT + 43-min Spinoza lecture verified).

OUTPUT — STRICT JSON, 7 required fields + 1 conditional:

REQUIRED:
  lineage_link        — array. Each entry = {
    "target": { "syllabus_slug": "_self | <slug>", "lesson_idx": <int>, "kp_id": "kp-<n> | null", "display_label": "human-readable", "fallback": "<plain-text if link broken>" },
    "relation": "<one of: 批判 | 类比 | 后续被反驳 | 前驱 | 共构>"
  }. May be [] for first KP in lineage. _self means same syllabus; cross-syllabus uses the parent vault slug.
  definition          — string, 200-400 字 / 80-160 words. Formal definition. Enumerate sub-types if any (e.g., Spinoza substance vs Cartesian 二元 vs Leibnizian 多元 = 3 forms).
  derivation_chain    — array. Each entry = {
    "step": <int starting 1>,
    "claim": "<≤150 char statement>",
    "follows_from": "axiom | step <n> | definition | external:<source>",
    "mechanism": "<≤200 char explanation of HOW step follows>"
  }. Ordered. May be [] for definition-only KP. Example: Spinoza 实体 = [自因→无限性→不可分性→唯一性→与神等同].
  critique_of         — array. Each entry = {
    "target_thinker": "<name>",
    "target_position": "<≤200 char description of attacked position>",
    "attack_summary": "<≤250 char description of attack mechanism>"
  }. May be [] when KP has no critique target. THIS REPLACES the old counter_example field — modeled after how Spinoza attacks Descartes' 我思故在 (我思非清楚直观 / 含混 / 又不穷后退).
  connects_to_next    — array. Each entry = {
    "target_kp_id": "kp-<n>",
    "relation": "<one of: prereq | opposite | corollary | co-construct>"
  }. Within-lesson edges only (cross-lesson is via lineage_link). May be [] for last KP.
  intent_use_map      — object. ≥1 intent key present, ≥1 slot total. Each value = array of { "slot_name": "<slot>", "rationale": "<≤80 char why this KP fills this slot>" }.
    Slot enum per intent:
      考研: ${SCAFFOLD_SLOTS['考研'].join(' | ')}
      兴趣: ${SCAFFOLD_SLOTS['兴趣'].join(' | ')}
      论文: ${SCAFFOLD_SLOTS['论文'].join(' | ')}
      复盘: ${SCAFFOLD_SLOTS['复盘'].join(' | ')}
    KP with NO slot in ANY intent = subtract candidate (drop, per pedagogy.md S3 atomicity).
  paraphrase_prompt   — string, intent-aware open prompt. ≤200 char.
    考研 → "draft 答 [exam Q], 用 [slot_name] 模板, 100 字内"
    兴趣 → "用 100 字给一个不懂哲学的朋友讲"
    论文 → "如果要在论文里引用这个概念, 写 1 段铺垫"
    复盘 → "1 句话给自己讲, 1 反例自检"

CONDITIONAL (gated by PEDAGOGICAL_ARCHETYPE):
  analogy             — HUMANITIES → MUST be null (no body metaphor — violates Garamond register per video evidence)
                        TECH-CONCEPT / TECH-PROC → MUST be non-empty string with numerical instance OR A-vs-B contrast
                        Others → null OR string acceptable

CONSTRAINTS:
- Service order: lesson.objective + this KP's title.
- Ground in lesson body's mechanism_explanation + canonical_example when present.
- FORBIDDEN words: AI, LLM, embedding, model, prompt, agent, RAG, vector, fine-tune.
- AI-tell scrub: NO "这一刀" / "闭环" / "拉满" / "王炸" / "干货" / "直击灵魂" / "绝绝子" / "yyds".
- Manuscript register: serif-cadence, ! exclamation marks, ! "great question!", peer-level 你 voice.
- CITATION TOKENS (R-LIB v0.1): if SOURCES block is present, each source carries an inline [CITE:book_id:chunk_idx] or [CITE:pack:pack_id] marker. When you use that source's content in definition / derivation_chain[].mechanism / critique_of[].attack_summary, you MUST keep the bracketed marker inline at the end of the relevant string. Markers are post-parsed into evidence_cite[] — do not paraphrase them away, do not invent new markers, do not duplicate. lineage_link entries that ground in a book may set target.fallback = "[CITE:book_id:chunk_idx]" to indicate evidence anchor.

Return STRICT JSON only. No preamble.`;

function validateKPArc(arc, opts = {}) {
  const errors = [];
  if (!arc || typeof arc !== 'object') {
    errors.push('arc must be object');
    return errors;
  }

  // 1. lineage_link
  if (!Array.isArray(arc.lineage_link)) {
    errors.push('lineage_link: must be array (use [] for first KP)');
  } else {
    arc.lineage_link.forEach((l, i) => {
      if (!l || typeof l !== 'object') { errors.push(`lineage_link[${i}]: must be object`); return; }
      if (!l.target || typeof l.target !== 'object') {
        errors.push(`lineage_link[${i}].target: must be object`);
      } else {
        const t = l.target;
        if (typeof t.syllabus_slug !== 'string') errors.push(`lineage_link[${i}].target.syllabus_slug: must be string`);
        if (!Number.isInteger(t.lesson_idx)) errors.push(`lineage_link[${i}].target.lesson_idx: must be int`);
        if (t.kp_id !== null && (typeof t.kp_id !== 'string' || !/^kp-\d+$/.test(t.kp_id))) {
          errors.push(`lineage_link[${i}].target.kp_id: must be null or kp-<n>`);
        }
        if (typeof t.display_label !== 'string' || !t.display_label.trim()) {
          errors.push(`lineage_link[${i}].target.display_label: required non-empty string`);
        }
        if (typeof t.fallback !== 'string') errors.push(`lineage_link[${i}].target.fallback: required string`);
      }
      if (!KP_ARC_LINEAGE_RELATIONS.includes(l.relation)) {
        errors.push(`lineage_link[${i}].relation: must be one of ${KP_ARC_LINEAGE_RELATIONS.join('|')}, got ${l.relation}`);
      }
    });
  }

  // 2. definition
  if (typeof arc.definition !== 'string' || arc.definition.length < 30 || arc.definition.length > 1200) {
    errors.push(`definition: required string 30-1200 char, got ${arc.definition ? `${arc.definition.length}` : 'missing'}`);
  }

  // 3. derivation_chain
  if (!Array.isArray(arc.derivation_chain)) {
    errors.push('derivation_chain: must be array (use [] for definition-only KP)');
  } else {
    arc.derivation_chain.forEach((s, i) => {
      if (!s || typeof s !== 'object') { errors.push(`derivation_chain[${i}]: must be object`); return; }
      if (!Number.isInteger(s.step) || s.step < 1) errors.push(`derivation_chain[${i}].step: positive int required`);
      if (typeof s.claim !== 'string' || !s.claim.trim()) errors.push(`derivation_chain[${i}].claim: required string`);
      if (typeof s.follows_from !== 'string') errors.push(`derivation_chain[${i}].follows_from: required string`);
      if (typeof s.mechanism !== 'string') errors.push(`derivation_chain[${i}].mechanism: required string`);
    });
  }

  // 4. critique_of
  if (!Array.isArray(arc.critique_of)) {
    errors.push('critique_of: must be array (use [] for no-critique KP)');
  } else {
    arc.critique_of.forEach((c, i) => {
      if (!c || typeof c !== 'object') { errors.push(`critique_of[${i}]: must be object`); return; }
      ['target_thinker', 'target_position', 'attack_summary'].forEach(k => {
        if (typeof c[k] !== 'string' || !c[k].trim()) errors.push(`critique_of[${i}].${k}: required non-empty string`);
      });
    });
  }

  // 5. analogy — archetype-gated
  const pedArchetype = opts.pedagogicalArchetype || null;
  const policy = analogyPolicy(pedArchetype);
  if (policy === 'SKIP') {
    if (arc.analogy !== null) errors.push(`analogy: HUMANITIES archetype requires null, got ${typeof arc.analogy === 'string' ? `"${arc.analogy.slice(0, 40)}"` : typeof arc.analogy}`);
  } else if (policy === 'REQUIRED') {
    if (typeof arc.analogy !== 'string' || !arc.analogy.trim()) errors.push(`analogy: ${pedArchetype} archetype requires non-empty string`);
  } else {
    if (arc.analogy !== null && typeof arc.analogy !== 'string') errors.push('analogy: must be null or string');
  }

  // 6. connects_to_next
  if (!Array.isArray(arc.connects_to_next)) {
    errors.push('connects_to_next: must be array (use [] for last KP)');
  } else {
    arc.connects_to_next.forEach((c, i) => {
      if (!c || typeof c !== 'object') { errors.push(`connects_to_next[${i}]: must be object`); return; }
      if (typeof c.target_kp_id !== 'string' || !/^kp-\d+$/.test(c.target_kp_id)) {
        errors.push(`connects_to_next[${i}].target_kp_id: must be kp-<n>`);
      }
      if (!KP_ARC_RELATIONS.includes(c.relation)) {
        errors.push(`connects_to_next[${i}].relation: must be one of ${KP_ARC_RELATIONS.join('|')}, got ${c.relation}`);
      }
    });
  }

  // 7. intent_use_map
  if (!arc.intent_use_map || typeof arc.intent_use_map !== 'object' || Array.isArray(arc.intent_use_map)) {
    errors.push('intent_use_map: must be object (keyed by intent)');
  } else {
    let totalSlots = 0;
    Object.entries(arc.intent_use_map).forEach(([intent, slots]) => {
      if (!KP_ARC_INTENTS.includes(intent)) errors.push(`intent_use_map: unknown intent "${intent}" (allowed: ${KP_ARC_INTENTS.join('|')})`);
      if (!Array.isArray(slots)) { errors.push(`intent_use_map.${intent}: must be array`); return; }
      slots.forEach((s, j) => {
        if (!s || typeof s !== 'object') { errors.push(`intent_use_map.${intent}[${j}]: must be object`); return; }
        const validSlots = SCAFFOLD_SLOTS[intent] || [];
        if (!validSlots.includes(s.slot_name)) {
          errors.push(`intent_use_map.${intent}[${j}].slot_name: must be one of ${validSlots.join('|')}, got ${s.slot_name}`);
        }
        if (typeof s.rationale !== 'string') errors.push(`intent_use_map.${intent}[${j}].rationale: required string`);
        totalSlots++;
      });
    });
    if (totalSlots < 1) errors.push('intent_use_map: ≥1 slot total required across all intents (KPs with no slot = subtract candidate per Layer 0 S3)');
  }

  // 8. paraphrase_prompt
  if (typeof arc.paraphrase_prompt !== 'string' || !arc.paraphrase_prompt.trim() || arc.paraphrase_prompt.length > 300) {
    errors.push('paraphrase_prompt: required non-empty string ≤300 char');
  }

  return errors;
}

/**
 * Generate the 7+1 narrative arc for one KP.
 *
 * @param {object} args
 * @param {object} args.lessonPlan         — 6-field skeleton
 * @param {object} args.lessonBody         — 11-field body (preserved; grounding context)
 * @param {object} args.kpSeed             — { id, title, archetype_hint, lineage_link_seeds }
 * @param {string} [args.userIntent]       — 考研 | 兴趣 | 论文 | 复盘
 * @param {string} [args.visualArchetype='DAG']
 * @param {string} [args.pedagogicalArchetype] — gates analogy field
 * @param {string} [args.syllabusSlug='_self']
 * @param {number} [args.lessonIdx=0]
 * @param {object} [args.options]
 * @returns {Promise<{ arc: object, _meta: object }>}
 */
async function generateKPArc({
  lessonPlan,
  lessonBody,
  kpSeed,
  userIntent = null,
  visualArchetype = 'DAG',
  pedagogicalArchetype = null,
  syllabusSlug = '_self',
  lessonIdx = 0,
  rankedSources = [],
  options = {},
} = {}) {
  if (!kpSeed || typeof kpSeed !== 'object' || !kpSeed.id) {
    throw new Error('kpSeed (object with id) required');
  }
  if (!lessonPlan || typeof lessonPlan !== 'object') {
    throw new Error('lessonPlan (object) required');
  }

  const maxRetries = Number.isFinite(options.maxRetries) ? options.maxRetries : 1;
  const capability = options.capability || 'T6_STRONG';
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : 2500;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 90_000;

  const policy = analogyPolicy(pedagogicalArchetype);

  // R-LIB Day 5: build SOURCES block from rankedSources, prefer chunks whose
  // section-type matches what KP arc consumes (definition / argument / critique).
  // Library + community sources get [CITE:b:c] markers — KP arc prompt
  // preserves them in output for post-parse into evidence_cite[].
  const _rs = Array.isArray(rankedSources) ? rankedSources : [];
  const _kpRelevant = _rs.filter(s => ['library', 'community'].includes(s.sourceType));
  // Boost section-type matches for the field types KP arc generates
  const _scored = _kpRelevant.map(s => {
    let bonus = 0;
    const t = s.chunk_type;
    if (t === 'definition' || t === 'argument' || t === 'critique') bonus += 1;
    return { src: s, bonus };
  }).sort((a, b) => b.bonus - a.bonus).slice(0, 6).map(x => x.src);

  const sourcesBlock = _scored.length > 0
    ? _scored.map((s, i) => {
        const tag = s.sourceType || 'src';
        let cite = '';
        if (tag === 'library' && s.book_id != null && s.chunk_idx != null) {
          cite = ` [CITE:${s.book_id}:${s.chunk_idx}]`;
        } else if (tag === 'community' && s.pack_id) {
          cite = ` [CITE:pack:${s.pack_id}]`;
        }
        const title = String(s.title || `Source ${i + 1}`).slice(0, 100);
        const excerpt = String(s.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 280);
        const typeTag = s.chunk_type ? ` (type=${s.chunk_type})` : '';
        const fidTag = _formatFidelityTag(s);
        return `--- Source ${i + 1} [${tag}]${typeTag}${cite}${fidTag}: ${title} ---\n${excerpt || '(no excerpt)'}`;
      }).join('\n\n')
    : '';

  const userMessage = `KP CONTEXT
  kp_id: ${kpSeed.id}
  kp_title: ${kpSeed.title || ''}
  archetype_hint: ${kpSeed.archetype_hint || '(unspecified)'}
  lineage_link_seeds: ${JSON.stringify(kpSeed.lineage_link_seeds || [])}

LESSON CONTEXT
  syllabus_slug: ${syllabusSlug}
  lesson_idx: ${lessonIdx}
  lesson_objective: ${lessonPlan.objective || ''}
  lesson_hook: ${(lessonPlan.hook_concrete || '').slice(0, 200)}
  visual_archetype: ${visualArchetype}
  pedagogical_archetype: ${pedagogicalArchetype || '(unspecified)'}
  analogy_policy: ${policy}
  user_intent: ${userIntent || '(unspecified)'}

LESSON BODY (grounding — quote / extend, do not invent past it)
  thesis: ${(lessonBody && lessonBody.thesis) || '(missing)'}
  mechanism_explanation: ${((lessonBody && lessonBody.mechanism_explanation) || '').slice(0, 600)}
  canonical_example: ${((lessonBody && lessonBody.canonical_example) || '').slice(0, 400)}
  common_misconceptions: ${JSON.stringify((lessonBody && lessonBody.common_misconceptions) || []).slice(0, 400)}
${sourcesBlock ? `
SOURCES (library + community, section-type ranked for KP arc fields):
${sourcesBlock}
` : ''}
Generate the KP narrative arc JSON now. STRICT JSON only.`;

  let messages = [
    { role: 'system', content: KP_ARC_SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const t0 = Date.now();
    const dispatch = await executeChat(capability, {
      messages,
      json: true,
      temperature: 0.55,
      maxTokens,
      timeoutMs,
    });
    const ms = Date.now() - t0;
    const result = dispatch && dispatch.result;
    const errors = validateKPArc(result, { pedagogicalArchetype });

    if (errors.length === 0) {
      try {
        sqliteDb.recordChatCallEstimate(dispatch, 'kpArc', {
          latency_ms: ms,
          tuple_id: `${syllabusSlug}/L${lessonIdx}/${kpSeed.id}`,
          slug: syllabusSlug || null,
          success: true,
        });
      } catch (err) {
        console.warn('[recordChatCallEstimate] kpArc err=', err && err.message);
      }
      // R-LIB Day 5: parse [CITE:b:c] markers out of arc fields → evidence_cite[]
      const citeResult = _extractCitations(result, _scored);
      result.evidence_cite = citeResult.evidence_cite;

      return {
        arc: result,
        _meta: {
          ms,
          attempt: attempt + 1,
          provider: dispatch && dispatch.providerId,
          model: dispatch && dispatch.model,
          attempts: dispatch && dispatch.attempts,
          analogy_policy: policy,
          schema_version: 'kp-arc-v1',
          evidence_cite_count: citeResult.evidence_cite.length,
          unresolved_cites: citeResult.unresolved_cites,
        },
      };
    }

    if (attempt < maxRetries) {
      messages = [
        ...messages,
        { role: 'assistant', content: JSON.stringify(result) },
        { role: 'user', content: `KP arc validation failed:\n${errors.map(e => '  - ' + e).join('\n')}\n\nRegenerate strictly per the SCHEMA. Same JSON shape; fix the listed issues only.` },
      ];
      continue;
    }
    throw new Error(`generateKPArc failed validation after ${maxRetries + 1} attempts: ${errors.join('; ')}`);
  }
}

module.exports = {
  generateLessonBodyV2,
  validateBodyV2,
  // Exposed for tests + Track C drift detector wiring.
  _BODY_V2_SYSTEM_PROMPT: BODY_V2_SYSTEM_PROMPT,
  DEFAULT_FORBIDDEN_DRIFTS,
  DRIFT_THRESHOLD,
  HOOK_ABSTRACT_RE,
  // Phase B 改动 3 / pedagogy.md Layer 4 — KP narrative arc sibling
  generateKPArc,
  validateKPArc,
  analogyPolicy,
  SCAFFOLD_SLOTS,
  KP_ARC_INTENTS,
  KP_ARC_RELATIONS,
  KP_ARC_LINEAGE_RELATIONS,
  // R-LIB Day 5 — exposed for unit tests + drift detector citation awareness
  _extractCitations,
};
