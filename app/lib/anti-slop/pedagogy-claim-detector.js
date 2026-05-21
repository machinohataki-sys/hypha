'use strict';
// HYPHA · Pedagogy Claim Detector (AMD-MEOW-P7 M-pedagogy, v0.3 anti-slop)
//
// 用户问 LLM "为什么这么教", LLM 可以现编 "因为 P3 cue-retrieval" 来骗用户,
// 但没机制对照 pedagogy.md 验 claim 是否真符合定义. 本模块独立可调,
// 不调 LLM, 不动 pedagogy.md (只读 parse).
//
// 集成 v0.4 anti-slop stack 后, agent.js streamTurn finally 块或 confession
// 生成处会调:
//   const ped = detectPedagogyClaims(_streamResult.accumulated);
//   if (ped.summary.unknown > 0 || ped.summary.inconsistent > 0) {
//     _hyphaAppendEvent('pedagogy_claim_drift', ped.summary);
//   }
//
// intentional-placeholder: v0.4 integration point per user spec — this module
// is shipped as independently-callable primitive now; the agent.js wiring will
// land with the v0.4 anti-slop stack expansion (see CLAUDE.md §AMD-MEOW-P7 P1).
// Not laziness — the hook fires here because the spec REQUIRES the v0.4 marker
// comment so the integrator knows the contract; leaving the wiring out today
// is the deliberate scope boundary the user defined.

const fs = require('fs');
const path = require('path');

const PEDAGOGY_MD_PATH = path.join(__dirname, '..', 'pedagogy.md');

// Fallback hard-coded primitive definitions, used when pedagogy.md is missing
// or its section headings don't match the parser. Each entry mirrors the
// directive-level intent (NOT exhaustive prose) so jaccard matching still
// catches mis-application.
const FALLBACK_PEDAGOGY = Object.freeze({
  P1: { name: 'EXPLAIN-TO-LEARN', def: 'Each lesson MUST end with a 1-paragraph explain-to-child block where the tutor invites the learner to re-state the lesson claim in plain language; the agent then probes one ambiguity. Feynman residue, AI-as-skeptic-child supplies audience pressure.' },
  P2: { name: 'PRE-READ PREDICTION', def: 'Lesson opens with one prediction prompt: a concrete claim mechanism answer the learner forecasts BEFORE the canonical reveal. Tutor records prediction verbatim. Predictive coding: surprise drives plasticity, prediction-error magnitude is the high-value learning signal.' },
  P3: { name: 'CUE-RETRIEVAL', def: 'After main exposition, tutor presents 2-3 cue prompts (concept-name, scenario, mechanism question) WITHOUT the answer; learner responds; tutor reveals canonical and flags discrepancies. Cornell + SQ3R-Recite residue, cue-prompt forces retrieval against blank.' },
  P4: { name: 'SCAFFOLDED INQUIRY', def: 'When introducing a non-trivial concept, tutor first asks "what would you ask first about X" and rubric-grades the question (depth specificity). Tutor then runs P3 retrieval on the implicit pre-knowledge before delivering instruction. Inquiry-then-retrieval-then-instruction hybrid.' },
  P5: { name: 'EXPERTISE-AWARE IMITATION', def: 'When demonstrating a procedure, gate the presentation by learner mastery for topic: low mastery = full worked example, mid mastery = partial example with steps blanked, high mastery = problem only no example. Expertise reversal: novices learn from worked examples, experts get hurt by them.' },
  P6: { name: 'PRIOR-INSTALL', def: 'When the lesson central concept has no anchor in state concepts and no mention in priorNotes, the tutor first turns MUST install a usable prior via 4-stage arc: DEFINE name plain definition enumerate forms, ANALOGIZE concrete analogy with numerical instance or contrast, CHECK pose one concrete instance test that requires the learner to compute, EXTEND fires only after learner replies to CHECK.' },
  F1: { name: 'PRODUCTIVE FAILURE', def: 'For every conceptually-deep lesson, generate a hard variant problem the learner attempts BEFORE seeing the canonical method. Failure trace persists as state. Kapur 2024: hard-problem-first instruction-after, unsuccessful attempt activates prior knowledge and creates failure-driven encoding that beats direct instruction on transfer tasks.' },
  F2: { name: 'HYBRID INTERLEAVING', def: 'Within each phase: early lessons blocked on single sub-topic for mastery floor; later lessons interleaved across the phase sub-topics for category discrimination. Pure interleaving hurts low-achievers early, pure blocking misses category-boundary learning, hybrid block-then-interleave wins.' },
  F3: { name: 'CALIBRATION LOOP', def: 'End every lesson with a calibration prompt: how confident are you that you can learn-goal right now (0-100). Tutor logs against P3 retrieval score; gap > 30 flags for next-lesson re-derivation. Predict-confidence then verify, gap between predicted and actual mastery drives next-lesson selection.' },
});

// Cache parsed pedagogy across calls within process (file rarely changes
// at runtime; immutable map per CLAUDE.md immutability discipline).
let _pedagogyCache = null;

/**
 * Parse pedagogy.md, extracting `### P1` ... `### F3` ... `### P6` sections
 * via regex. Each section's body (until next ### or ## heading) becomes the def.
 * Falls back to FALLBACK_PEDAGOGY on read error or zero parsed sections.
 *
 * @returns {Object<string, {name: string, def: string}>} frozen map keyed P1..F3
 */
function loadPedagogy() {
  if (_pedagogyCache) return _pedagogyCache;
  try {
    const raw = fs.readFileSync(PEDAGOGY_MD_PATH, 'utf8');
    // Match `### <ID> ...` heading where ID = P[1-6] or F[1-3], capture body
    // until next ### or ## heading (non-greedy). Multiline + dotall via [\s\S].
    const sectionRe = /^###\s+(P[1-6]|F[1-3])\b[^\n]*\n([\s\S]*?)(?=^###\s|^##\s|\Z)/gm;
    const parsed = {};
    let m;
    while ((m = sectionRe.exec(raw)) !== null) {
      const id = m[1];
      const body = (m[2] || '').trim();
      // Extract a name guess from the heading line itself (after the ID).
      const headingLine = raw.slice(m.index, raw.indexOf('\n', m.index));
      const nameMatch = headingLine.match(/[—\-]\s*([A-Z][A-Z0-9 \-]+)/);
      const name = nameMatch ? nameMatch[1].trim() : (FALLBACK_PEDAGOGY[id]?.name || id);
      if (body.length > 0) {
        parsed[id] = { name, def: body };
      }
    }
    if (Object.keys(parsed).length === 0) {
      _pedagogyCache = Object.freeze({ ...FALLBACK_PEDAGOGY });
    } else {
      // Fill any missing ID from fallback so detector never trips on
      // partial pedagogy.md edits.
      for (const id of Object.keys(FALLBACK_PEDAGOGY)) {
        if (!parsed[id]) parsed[id] = FALLBACK_PEDAGOGY[id];
      }
      _pedagogyCache = Object.freeze(parsed);
    }
  } catch (_err) {
    _pedagogyCache = Object.freeze({ ...FALLBACK_PEDAGOGY });
  }
  return _pedagogyCache;
}

// Friendly-name to canonical primitive ID map. Lowercase keys.
// Includes hyphenated and space-separated variants the LLM might emit.
const NAME_TO_ID = Object.freeze({
  'explain-to-learn':       'P1',
  'explain to learn':       'P1',
  'pre-read prediction':    'P2',
  'pre read prediction':    'P2',
  'cue-retrieval':          'P3',
  'cue retrieval':          'P3',
  'scaffolded inquiry':     'P4',
  'expertise-aware imitation': 'P5',
  'expertise aware imitation': 'P5',
  'prior-install':          'P6',
  'prior install':          'P6',
  'productive failure':     'F1',
  'hybrid interleaving':    'F2',
  'calibration loop':       'F3',
});

/**
 * Build trigram set from text. Trigrams = sliding 3-char windows on the
 * normalized form (lowercase, non-alphanumeric collapsed to single space).
 * Returns a Set for jaccard speed.
 *
 * @param {string} s
 * @returns {Set<string>}
 */
function trigrams(s) {
  if (typeof s !== 'string') return new Set();
  const norm = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (norm.length < 3) return new Set();
  const out = new Set();
  for (let i = 0; i <= norm.length - 3; i++) out.add(norm.slice(i, i + 3));
  return out;
}

/**
 * Jaccard similarity between two trigram sets. 0 (disjoint) .. 1 (identical).
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number}
 */
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Extract pedagogy claims from text. Three claim shapes detected:
 *   1. Explicit ID:        `P3`, `F1`, `P6 prior-install`
 *   2. Friendly name:      `cue-retrieval`, `EXPLAIN-TO-LEARN`, `productive failure`
 *   3. Fuzzy phrase:       `这节按 productive failure 设计`, `我用了 cue-retrieval`
 *
 * Each claim carries a 100-char context window (pre+post mentioned span).
 *
 * @param {string} text
 * @returns {Array<{primitive_id: string|null, mentioned_name: string, context: string, span: [number, number]}>}
 */
function extractClaims(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const claims = [];
  const seen = new Set(); // dedup by span-start to avoid double-counting overlaps

  // Shape 1: explicit ID. Match `P<digit>` or `F<digit>` broadly so we can
  // catch LLM-invented IDs (P9, F7) and mark them `unknown-primitive` in
  // verifyClaim. Valid IDs (P[1-6] / F[1-3]) verify against pedagogy.
  const idRe = /\b([PF])(\d{1,2})\b/g;
  let m;
  while ((m = idRe.exec(text)) !== null) {
    const start = m.index;
    if (seen.has(start)) continue;
    seen.add(start);
    const ctxStart = Math.max(0, start - 100);
    const ctxEnd = Math.min(text.length, m.index + m[0].length + 100);
    claims.push({
      primitive_id: m[0], // raw token; verifyClaim decides validity
      mentioned_name: m[0],
      context: text.slice(ctxStart, ctxEnd),
      span: [start, m.index + m[0].length],
    });
  }

  // Shape 2 + 3: friendly-name match. Sort keys by length desc so longer
  // names (`expertise-aware imitation`) match before short prefixes.
  const names = Object.keys(NAME_TO_ID).sort((a, b) => b.length - a.length);
  for (const name of names) {
    // Word-boundary-ish: surrounding chars must not be alphanumeric.
    // Hyphen inside the name is fine; we just need outside boundaries.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameRe = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
    let nm;
    while ((nm = nameRe.exec(text)) !== null) {
      const start = nm.index;
      // Skip if this span overlaps an already-recorded explicit-ID claim.
      // (Tolerance: skip if any seen-start lies within +/- 20 chars; the
      // ID match usually sits right next to the friendly name.)
      let overlaps = false;
      for (const s of seen) if (Math.abs(s - start) < 20) { overlaps = true; break; }
      if (overlaps) continue;
      seen.add(start);
      const ctxStart = Math.max(0, start - 100);
      const ctxEnd = Math.min(text.length, start + nm[0].length + 100);
      claims.push({
        primitive_id: NAME_TO_ID[name],
        mentioned_name: nm[0],
        context: text.slice(ctxStart, ctxEnd),
        span: [start, start + nm[0].length],
      });
    }
  }

  return claims;
}

/**
 * Verify a single claim against pedagogy. Verdict thresholds:
 *   jaccard >= 0.30  → 'consistent'        (LLM usage matches def)
 *   0.10 <= j < 0.30 → 'loose-match'       (sounds related, fuzzy)
 *   jaccard <  0.10  → 'inconsistent'      (named the primitive, meant something else)
 *   primitive_id ∉ PEDAGOGY → 'unknown-primitive' (LLM invented an ID)
 *
 * @param {{primitive_id: string|null, context: string}} claim
 * @param {Object<string,{name:string,def:string}>} pedagogy
 * @returns {{verdict: string, jaccard: number}}
 */
function verifyClaim(claim, pedagogy) {
  if (!claim.primitive_id || !pedagogy[claim.primitive_id]) {
    return { verdict: 'unknown-primitive', jaccard: 0 };
  }
  const def = pedagogy[claim.primitive_id].def;
  const j = jaccard(trigrams(claim.context), trigrams(def));
  let verdict;
  if (j >= 0.30) verdict = 'consistent';
  else if (j >= 0.10) verdict = 'loose-match';
  else verdict = 'inconsistent';
  return { verdict, jaccard: Number(j.toFixed(4)) };
}

/**
 * Public entry. Returns verifications + summary tallies.
 *
 * @param {string} text
 * @returns {{
 *   claims: Array<{primitive_id: string|null, mentioned_name: string, context: string, verdict: string, jaccard: number}>,
 *   summary: { total: number, consistent: number, loose: number, inconsistent: number, unknown: number }
 * }}
 */
function detectPedagogyClaims(text) {
  const pedagogy = loadPedagogy();
  const raw = extractClaims(text);
  const claims = raw.map(c => {
    const v = verifyClaim(c, pedagogy);
    return {
      primitive_id: c.primitive_id,
      mentioned_name: c.mentioned_name,
      context: c.context,
      verdict: v.verdict,
      jaccard: v.jaccard,
    };
  });
  const summary = {
    total:        claims.length,
    consistent:   claims.filter(c => c.verdict === 'consistent').length,
    loose:        claims.filter(c => c.verdict === 'loose-match').length,
    inconsistent: claims.filter(c => c.verdict === 'inconsistent').length,
    unknown:      claims.filter(c => c.verdict === 'unknown-primitive').length,
  };
  return { claims, summary };
}

module.exports = {
  detectPedagogyClaims,
  // Exposed for tests / debugging — NOT part of v0.4 IPC surface.
  _internals: { loadPedagogy, extractClaims, verifyClaim, trigrams, jaccard, FALLBACK_PEDAGOGY, NAME_TO_ID },
};
