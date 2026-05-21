'use strict';
// HYPHA · W5.1 Cheap Intelligence Router (per BLUEPRINT §17.2 + ROADMAP v1.1).
//
// Dispatches inexpensive tasks down the cheapest competent tier:
//   T0_RULE   — keyword / regex / Jaccard (zero LLM, deterministic)
//   T1_EMBED  — BGE-M3 cosine similarity (embed-stub fallback, mock 1024-d)
//   T2_LOCAL  — Gemma 3 4B via Ollama (local-stub, template fallback)
//   T3_MID    — Cloud cheap LLM (GLM-4.5-Air / DeepSeek-Flash via router.js)
//
// Routing philosophy: try the cheapest tier first; escalate ONLY when the
// cheap tier returns a low-confidence verdict (a "fuzzy band" like
// relevance ∈ [0.4, 0.7] where keyword evidence is ambiguous). This keeps
// the ~80% of routine traffic (Pack 初筛 / Note routing / Companion state)
// off cloud LLM bills while preserving accuracy on the ambiguous tail.
//
// Surface contract (locked):
//   routeToCheapest(task, options) → { capability, rationale }
//   runCheapTask(task, input, options) → { result, capability, rationale, ... }
//
// Per BLUEPRINT §17.2 these are the supported tasks (extensible — unknown
// task types fall through to T3_MID with a `unknown_task` rationale rather
// than throwing, so callers can register new tasks ahead of router updates).

const embedStub = require('./embed-stub');
const localStub = require('./local-stub');

// ---- Constants --------------------------------------------------------------

const TIER = Object.freeze({
  RULE:  'T0_RULE',
  EMBED: 'T1_EMBED',
  LOCAL: 'T2_LOCAL',
  MID:   'T3_MID',
});

const TASK = Object.freeze({
  RELEVANCE_SCORE:     'relevance_score',
  PACK_FIRST_PASS:     'pack_first_pass',
  NOTE_ROUTING:        'note_routing',
  QUALITY_SCORE:       'quality_score',
  TRANSFER_FIRST_PASS: 'transfer_first_pass',
  COMPANION_STATE:     'companion_state',
});

// Fuzzy bands — when a T0/T1 cheap pass lands in here, escalate one tier.
const FUZZY_RELEVANCE_LO = 0.4;
const FUZZY_RELEVANCE_HI = 0.7;
const FUZZY_QUALITY_LO   = 0.4;
const FUZZY_QUALITY_HI   = 0.7;

// Pack first-pass cheap-rule thresholds (file size + title keyword density).
const PACK_TITLE_KEYWORD_MIN_HITS = 2;
const PACK_FILE_SIZE_MIN_BYTES = 200;
const PACK_FILE_SIZE_MAX_BYTES = 80_000;

// ---- T0 rule primitives -----------------------------------------------------

const STOPWORDS = new Set([
  // Minimal stoplist — enough to keep token-overlap signals honest without
  // pulling a full NLP toolchain. Bilingual EN + CN.
  'the','a','an','and','or','but','of','to','in','on','for','with','is','are','was','were','be','been','it','this','that','as','at','by','from','if','then','so','do','does','did','have','has','had','will','can','could','should','would','may','might',
  '的','了','和','与','或','是','在','也','就','都','而','及','或者','以及','一个','这','那','这个','那个','他','她','它','我','你','们',
]);

function _tokenize(s) {
  // Split on whitespace + punctuation; keep CJK by character (each Han
  // codepoint counts as a token), strip stopwords + empties.
  const text = String(s || '').toLowerCase();
  const out = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = ch.charCodeAt(0);
    const isHan = code >= 0x4E00 && code <= 0x9FFF;
    const isWordChar = /[a-z0-9_]/.test(ch);
    if (isHan) {
      if (buf) { out.push(buf); buf = ''; }
      out.push(ch);
    } else if (isWordChar) {
      buf += ch;
    } else {
      if (buf) { out.push(buf); buf = ''; }
    }
  }
  if (buf) out.push(buf);
  return out.filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Jaccard similarity over token sets. 1.0 = identical sets, 0.0 = disjoint.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function jaccardSimilarity(a, b) {
  const ta = new Set(_tokenize(a));
  const tb = new Set(_tokenize(b));
  if (ta.size === 0 && tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Count case-insensitive keyword hits in haystack. Useful for pack first-pass.
 */
function _keywordHits(haystack, keywords) {
  if (!Array.isArray(keywords) || keywords.length === 0) return 0;
  const hay = String(haystack || '').toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    const k = String(kw || '').toLowerCase().trim();
    if (!k) continue;
    if (hay.includes(k)) hits++;
  }
  return hits;
}

// ---- Task-level routing rules ----------------------------------------------

function _route_relevance_score(input) {
  // T0 path: Jaccard cheap. If ambiguous → T1 embed.
  // If caller asks for `disable_embed:true` (rare), stay on T0 even when fuzzy.
  return {
    capability: TIER.RULE,
    rationale: 'jaccard token overlap; embed escalation if fuzzy ∈ [0.4, 0.7]',
    fallback: TIER.EMBED,
  };
}

function _route_pack_first_pass(input) {
  // T0 path: file-size guard + keyword-density on the title. Drop trivial /
  // pathologically huge files at T0; only ambiguous mid-size + low keyword
  // signal escalates to T3 mid LLM second-pass.
  return {
    capability: TIER.RULE,
    rationale: 'file-size guard + title keyword hits; T3_MID re-judge on fuzzy',
    fallback: TIER.MID,
  };
}

function _route_note_routing(input) {
  // T1 path: semantic similarity is the right primitive for note routing
  // (lexical match misses Chinese ⇄ English aliases, abbreviations).
  // T3_MID fallback handles ties / no-clear-winner cases.
  return {
    capability: TIER.EMBED,
    rationale: 'semantic similarity (cosine) over candidates; T3_MID on ties',
    fallback: TIER.MID,
  };
}

function _route_quality_score(input) {
  // T0 path: cheap heuristics (length, signal-word density). Fuzzy band
  // escalates to T3_MID for a real judge.
  return {
    capability: TIER.RULE,
    rationale: 'length + signal-word heuristics; T3_MID on fuzzy band',
    fallback: TIER.MID,
  };
}

function _route_transfer_first_pass(input) {
  // T0 path: keyword sieve against a controlled vocabulary of transfer
  // signals (product names, surface IDs). Anything that passes sieve goes
  // to T3_MID for the structured Transfer reasoning.
  return {
    capability: TIER.RULE,
    rationale: 'keyword sieve over transfer signal vocabulary; T3_MID on hit',
    fallback: TIER.MID,
  };
}

function _route_companion_state(input) {
  // T0 path: event-type → template lookup. T2_LOCAL refine only when the
  // caller asks for `refine:true` AND Ollama is available.
  return {
    capability: TIER.RULE,
    rationale: 'event-type template lookup; T2_LOCAL refine on demand',
    fallback: TIER.LOCAL,
  };
}

const ROUTE_TABLE = {
  [TASK.RELEVANCE_SCORE]:     _route_relevance_score,
  [TASK.PACK_FIRST_PASS]:     _route_pack_first_pass,
  [TASK.NOTE_ROUTING]:        _route_note_routing,
  [TASK.QUALITY_SCORE]:       _route_quality_score,
  [TASK.TRANSFER_FIRST_PASS]: _route_transfer_first_pass,
  [TASK.COMPANION_STATE]:     _route_companion_state,
};

/**
 * Resolve a task to the cheapest competent tier WITHOUT running it.
 * Pure routing decision — used by callers that want to inspect the plan
 * before committing (e.g. cost ledger pre-flight).
 *
 * @param {string} task — one of TASK.*
 * @param {object} [options]
 * @returns {{ capability: string, rationale: string, fallback: string|null }}
 */
function routeToCheapest(task, options = {}) {
  const fn = ROUTE_TABLE[task];
  if (!fn) {
    return {
      capability: TIER.MID,
      rationale: 'unknown task type; default to T3_MID',
      fallback: null,
    };
  }
  return fn(options || {});
}

// ---- Task runners (cheap pipeline) -----------------------------------------

async function _run_relevance_score(input, opts) {
  const query = String(input?.query || '');
  const doc   = String(input?.doc || '');
  const t0 = jaccardSimilarity(query, doc);
  if (t0 >= FUZZY_RELEVANCE_HI || t0 <= FUZZY_RELEVANCE_LO || opts.disable_embed) {
    return { result: { score: t0, method: 't0_jaccard' }, capability: TIER.RULE };
  }
  // Fuzzy band — escalate to T1 embed.
  const qv = await embedStub.embed(query);
  const dv = await embedStub.embed(doc);
  const cos = embedStub.cosineSimilarity(qv, dv);
  // Blend: take the more confident of the two. Tie-break toward embed.
  return {
    result: { score: cos, t0_score: t0, method: 't1_embed_after_fuzzy_t0' },
    capability: TIER.EMBED,
  };
}

async function _run_pack_first_pass(input, opts) {
  const title = String(input?.title || '');
  const size  = Number(input?.size_bytes || 0);
  const keywords = Array.isArray(input?.keywords) ? input.keywords : [];
  const hits = _keywordHits(title, keywords);

  const sizeTooSmall = size > 0 && size < PACK_FILE_SIZE_MIN_BYTES;
  const sizeTooLarge = size > PACK_FILE_SIZE_MAX_BYTES;
  if (sizeTooSmall || sizeTooLarge) {
    return {
      result: { keep: false, reason: sizeTooSmall ? 'too_small' : 'too_large', hits },
      capability: TIER.RULE,
    };
  }
  if (hits >= PACK_TITLE_KEYWORD_MIN_HITS) {
    return { result: { keep: true, reason: 'keyword_hits', hits }, capability: TIER.RULE };
  }
  // Ambiguous: mid-size, no keyword signal. Mark for T3_MID re-judge.
  // Theory-ship: surface decision is "needs_mid_review", actual T3 call is
  // the caller's responsibility (router.executeChat) — keeps this module
  // free of cloud-call coupling for unit tests.
  return {
    result: { keep: null, reason: 'needs_mid_review', hits },
    capability: TIER.MID,
    needs_escalation: true,
  };
}

async function _run_note_routing(input, opts) {
  const query = String(input?.query || '');
  const candidates = Array.isArray(input?.candidates) ? input.candidates : [];
  if (candidates.length === 0) {
    return { result: { match: null, ranked: [] }, capability: TIER.EMBED };
  }
  const ranked = await embedStub.topKSimilar(query, candidates, opts.k || 5);
  const top = ranked[0];
  const second = ranked[1];
  // "Clear winner" = top score > 0.55 AND gap to runner-up >= 0.1. Otherwise
  // mark for T3_MID disambiguation.
  const clearWinner = top && top.score > 0.55 && (!second || (top.score - second.score) >= 0.1);
  return {
    result: { match: top || null, ranked, clear_winner: clearWinner },
    capability: TIER.EMBED,
    needs_escalation: !clearWinner,
  };
}

async function _run_quality_score(input, opts) {
  const text = String(input?.text || '');
  const len = text.length;
  // Cheap heuristic: length-band + signal-word density (positive: "因为/
  // 例如/数据/出处"; negative: "好像/可能/大概").
  const positiveSignals = ['因为', '例如', '数据', '出处', 'because', 'for example', 'evidence'];
  const negativeSignals = ['好像', '可能', '大概', 'maybe', 'probably', 'seems'];
  const pos = _keywordHits(text, positiveSignals);
  const neg = _keywordHits(text, negativeSignals);
  let score = 0.5;
  if (len < 20) score = 0.1;
  else if (len > 200) score += 0.15;
  score += 0.08 * pos - 0.05 * neg;
  score = Math.max(0, Math.min(1, score));
  if (score >= FUZZY_QUALITY_LO && score <= FUZZY_QUALITY_HI) {
    return { result: { score, method: 't0_heuristic', pos, neg }, capability: TIER.RULE, needs_escalation: true };
  }
  return { result: { score, method: 't0_heuristic', pos, neg }, capability: TIER.RULE };
}

async function _run_transfer_first_pass(input, opts) {
  const text = String(input?.text || '');
  const signals = Array.isArray(input?.signals) && input.signals.length
    ? input.signals
    : ['transfer', 'ship', 'publish', '迁移', '复用', '产品化'];
  const hits = _keywordHits(text, signals);
  const interesting = hits >= 1;
  return {
    result: { interesting, hits },
    capability: TIER.RULE,
    needs_escalation: interesting,
  };
}

async function _run_companion_state(input, opts) {
  const eventType = String(input?.event_type || '');
  const tmpl = localStub.COMPANION_TEMPLATES[eventType];
  if (tmpl && !opts.refine) {
    return { result: { line: tmpl, source: 'template' }, capability: TIER.RULE };
  }
  // Refine path: ask T2_LOCAL Gemma to tailor the line to context. If Ollama
  // is unreachable the stub returns a template-anchored fallback, so this is
  // safe to call even on a clean machine.
  const prompt = (input?.prompt) || ('event=' + eventType + '\nbase=' + (tmpl || '(none)'));
  const line = await localStub.runLocal(prompt, { maxTokens: 60, temperature: 0.3 });
  return { result: { line, source: 'local_refine' }, capability: TIER.LOCAL };
}

const RUN_TABLE = {
  [TASK.RELEVANCE_SCORE]:     _run_relevance_score,
  [TASK.PACK_FIRST_PASS]:     _run_pack_first_pass,
  [TASK.NOTE_ROUTING]:        _run_note_routing,
  [TASK.QUALITY_SCORE]:       _run_quality_score,
  [TASK.TRANSFER_FIRST_PASS]: _run_transfer_first_pass,
  [TASK.COMPANION_STATE]:     _run_companion_state,
};

/**
 * Run a cheap task end-to-end. Always returns an envelope; never throws on
 * known task types. Unknown task types resolve to a `needs_escalation:true`
 * envelope that tells the caller to invoke `router.executeChat('T3_MID', ...)`
 * directly.
 *
 * @param {string} task
 * @param {object} input — task-specific shape (see TASK constants)
 * @param {object} [options]
 * @returns {Promise<{result, capability, rationale, needs_escalation:boolean}>}
 */
async function runCheapTask(task, input, options = {}) {
  const decision = routeToCheapest(task, options);
  const fn = RUN_TABLE[task];
  if (!fn) {
    return {
      result: null,
      capability: TIER.MID,
      rationale: decision.rationale,
      needs_escalation: true,
    };
  }
  const out = await fn(input || {}, options || {});
  return {
    result: out.result,
    capability: out.capability || decision.capability,
    rationale: decision.rationale,
    needs_escalation: Boolean(out.needs_escalation),
  };
}

module.exports = {
  routeToCheapest,
  runCheapTask,
  jaccardSimilarity,
  TIER,
  TASK,
  // Test seams — surfaced so __tests__/cheap-router.test.js can pin them.
  _tokenize,
  FUZZY_RELEVANCE_LO,
  FUZZY_RELEVANCE_HI,
};
