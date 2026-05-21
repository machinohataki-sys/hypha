'use strict';
// HYPHA · Confession Verifier (AMD-MEOW-P7 M2 hardening, 2026-05-14)
//
// Problem (E80-class): `gradeConfessionHonesty` (boilerplate detector) gives
// FULL SCORE to a confession that SOUNDS specific but is fabricated —
// e.g. weakest_link.why = "path[2] 应该更深 — 我只讲了 EXTEND 没真正测试
// student 的 retrieval" — when the lesson transcript has only 1 state
// transition (no path[2]) and never entered EXTEND. The LLM is confessing
// against a hallucinated trace; the rule-based grader cannot detect this
// because the surface form passes every boilerplate filter.
//
// Fix: extract concrete "anchors" from the confession (state names,
// `path[N]` references, quoted terms, timestamp/turn references) and check
// each anchor really appears in the transcript. Anchors that nobody can
// find = `fake_anchor`. Confession with zero anchors at all (pure vague
// language) = `no_specific_anchor`. Output `score` is the fraction of
// anchors that verified, suitable for merging with the boilerplate score.
//
// Pure heuristic — no LLM call. Cheap enough to run on every confession.

/**
 * Verify a confession's specific anchors against the actual lesson transcript.
 *
 * @param {object} confession — output of generateConfession (must have weakest_link)
 * @param {Array<{role:'user'|'assistant', text:string}>} transcript — per-turn array
 * @returns {{
 *   verified: boolean,
 *   score: number,            // 0..1, fraction of anchors that verified
 *   flags: string[],          // 'fake_anchor' | 'no_specific_anchor' | 'no_transcript' | 'no_confession'
 *   missing_anchors: string[],
 *   found_anchors: string[],
 * }}
 */
function verifyConfessionAgainstTranscript(confession, transcript) {
  if (!confession || typeof confession !== 'object') {
    return { verified: false, score: 0, flags: ['no_confession'], missing_anchors: [], found_anchors: [] };
  }
  // Collect every searchable string field from the confession we'd expect to
  // anchor against transcript content. weakest_link.why is the primary, but
  // ornamentation_flagged + tasks_not_finished + deepen_recommendation +
  // unverified_claims + speculative_claims may also reference path[N] /
  // states / quoted terms — include them so a confession that buries its
  // only concrete anchor in `tasks_not_finished[0]` still counts.
  const corpusParts = [];
  const wl = confession.weakest_link;
  if (wl && typeof wl === 'object') {
    if (typeof wl.ref === 'string') corpusParts.push(wl.ref);
    if (typeof wl.why === 'string') corpusParts.push(wl.why);
  }
  for (const k of ['unverified_claims', 'speculative_claims', 'ornamentation_flagged', 'tasks_not_finished']) {
    if (Array.isArray(confession[k])) {
      for (const item of confession[k]) {
        if (typeof item === 'string') corpusParts.push(item);
      }
    }
  }
  if (typeof confession.deepen_recommendation === 'string') corpusParts.push(confession.deepen_recommendation);
  const corpus = corpusParts.join('\n');

  // ── Anchor extraction ────────────────────────────────────────────────
  // Each entry: { kind, raw, test(transcriptText, transcriptTurns) → boolean }
  const anchors = [];

  // 1) path[N] — N >= 0; transcript must contain at least N+1 state markers / assistant turns.
  const pathRefs = new Set();
  const pathRe = /\bpath\[(\d+)\]/gi;
  let m;
  while ((m = pathRe.exec(corpus)) !== null) {
    pathRefs.add(parseInt(m[1], 10));
  }
  for (const n of pathRefs) {
    anchors.push({ kind: 'path_index', raw: `path[${n}]`, n });
  }

  // 2) State names — Hypha state machine markers.
  const STATE_NAMES = ['EXPOSE', 'EXTEND', 'CONNECT', 'LATCH', 'END', 'OPEN', 'PROBE'];
  const stateRefs = new Set();
  for (const s of STATE_NAMES) {
    // word-boundary, case-insensitive — but limit to upper-case occurrences in
    // confession to avoid false-hit on prose ("extend the metaphor").
    const re = new RegExp(`\\b${s}\\b`, 'g');
    if (re.test(corpus)) stateRefs.add(s);
  }
  for (const s of stateRefs) {
    anchors.push({ kind: 'state', raw: s });
  }

  // 3) Quoted terms — "X" / 「X」 / “X” / 'X' with 2..40 char body.
  //    Skip very short (<=1 char) or punctuation-only matches.
  const quoteRes = [
    /"([^"\n]{2,40})"/g,
    /'([^'\n]{2,40})'/g,
    /“([^”\n]{2,40})”/g,
    /「([^」\n]{2,40})」/g,
    /『([^』\n]{2,40})』/g,
  ];
  const quotedTerms = new Set();
  for (const re of quoteRes) {
    let q;
    while ((q = re.exec(corpus)) !== null) {
      const term = q[1].trim();
      if (term && !/^[\s\p{P}]+$/u.test(term)) quotedTerms.add(term);
    }
  }
  for (const term of quotedTerms) {
    anchors.push({ kind: 'quoted_term', raw: term });
  }

  // 4) Turn / time references — "第 N 分钟" / "第 N 轮" / "上一轮" / "first turn".
  //    These map to transcript.length checks rather than text content.
  const turnRefs = new Set();
  const turnRe = /第\s*(\d+)\s*(轮|回合|分钟|节)/g;
  while ((m = turnRe.exec(corpus)) !== null) {
    turnRefs.add(parseInt(m[1], 10));
  }
  const enTurnRe = /\bturn\s+(\d+)\b/gi;
  while ((m = enTurnRe.exec(corpus)) !== null) {
    turnRefs.add(parseInt(m[1], 10));
  }
  for (const n of turnRefs) {
    anchors.push({ kind: 'turn_ref', raw: `turn-${n}`, n });
  }

  // ── Verification ─────────────────────────────────────────────────────
  if (!Array.isArray(transcript) || transcript.length === 0) {
    // No transcript to verify against. If there were anchors we have no way
    // to confirm or deny — surface explicitly. If there were no anchors
    // either, this is also "no specific anchor".
    const flags = ['no_transcript'];
    if (anchors.length === 0) flags.push('no_specific_anchor');
    return {
      verified: false,
      score: 0,
      flags,
      missing_anchors: anchors.map(a => a.raw),
      found_anchors: [],
    };
  }

  if (anchors.length === 0) {
    return {
      verified: false,
      score: 0,
      flags: ['no_specific_anchor'],
      missing_anchors: [],
      found_anchors: [],
    };
  }

  const transcriptText = transcript
    .filter(t => t && typeof t.text === 'string')
    .map(t => t.text)
    .join('\n');
  const transcriptUpper = transcriptText.toUpperCase();
  // Count assistant turns + state-transition markers. We accept either as a
  // "state transition" for path[N] purposes: an explicit `[STATE:X]` style
  // marker, OR a bare uppercase state name, OR (fallback) an assistant turn.
  const stateMarkerRe = /\[STATE:[A-Z]+\]|\b(EXPOSE|EXTEND|CONNECT|LATCH|OPEN|PROBE|END)\b/g;
  const stateMarkerHits = transcriptText.match(stateMarkerRe) || [];
  const assistantTurns = transcript.filter(t => t && t.role === 'assistant').length;
  // Use the LARGER of the two as the "path length" available — gives the
  // confession the benefit of the doubt while still failing fabricated
  // deep-path references when the conversation was clearly short.
  const pathLen = Math.max(stateMarkerHits.length, assistantTurns);

  const found = [];
  const missing = [];

  for (const a of anchors) {
    let ok = false;
    if (a.kind === 'path_index') {
      // path[N] requires at least N+1 state transitions (0-indexed).
      ok = pathLen >= (a.n + 1);
    } else if (a.kind === 'state') {
      ok = transcriptUpper.includes(a.raw);
    } else if (a.kind === 'quoted_term') {
      // Case-insensitive substring check on raw transcript text.
      ok = transcriptText.toLowerCase().includes(a.raw.toLowerCase());
    } else if (a.kind === 'turn_ref') {
      ok = transcript.length >= a.n;
    }
    if (ok) found.push(a.raw);
    else missing.push(a.raw);
  }

  const score = anchors.length > 0 ? found.length / anchors.length : 0;
  const verified = anchors.length > 0 && missing.length === 0;
  const flags = [];
  if (!verified && found.length === 0) flags.push('fake_anchor');
  // Note: we DO NOT add `no_specific_anchor` here — we already handled the
  // zero-anchor case above. Partial misses (some found, some missing) get
  // only the proportional score; no special flag.

  return {
    verified,
    score: Math.max(0, Math.min(1, score)),
    flags,
    missing_anchors: missing,
    found_anchors: found,
  };
}

module.exports = {
  verifyConfessionAgainstTranscript,
};
