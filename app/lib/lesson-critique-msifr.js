'use strict';
// HYPHA · Lesson Critique MSIFR (Martingale-Safe Inflight Rule Validators)
//
// Cheap rule-based gates that run BEFORE the LLM critic (S88 arXiv 2605.14062
// — martingale-safe inflight rules cut 11-77% wasted tokens by short-circuiting
// drafts that already fail surface invariants).
//
// 4 validators, ordered cheapest-first:
//   1. validateSyntax       — markdown / JSON well-formed
//   2. validateNamespace    — no orphan citations / dangling [^N]
//   3. validateSilentCatch  — no `# TODO` / `# placeholder` body
//   4. validateScopeCreep   — body matches plan.scope_in; no scope_out leak
//
// Each returns { ok: boolean, failed_at: null | string, reason: string }.
// `composeMsifr(draft, plan)` runs all 4 in order, short-circuits on first
// fail. Stateless; no IO. Falsifier on regression: any positive test in
// _dev_verify_critique_loop.js fails the validator that previously passed.

// ── Helpers ────────────────────────────────────────────────────────────

function _asText(draft) {
  if (typeof draft === 'string') return draft;
  if (draft && typeof draft === 'object') {
    // Concatenate string-valued fields so the rules can scan a deterministic
    // surface. Skip arrays / nested objects — those have field-specific
    // validators in lesson-body-generator.validateBodyV2 already.
    const parts = [];
    for (const k of Object.keys(draft)) {
      const v = draft[k];
      if (typeof v === 'string') parts.push(`${k}: ${v}`);
    }
    return parts.join('\n');
  }
  return '';
}

// ── 1. Syntax ──────────────────────────────────────────────────────────

function validateSyntax(draft) {
  if (draft == null) {
    return { ok: false, failed_at: 'syntax', reason: 'draft is null/undefined' };
  }
  if (typeof draft === 'string') {
    if (draft.trim().length === 0) {
      return { ok: false, failed_at: 'syntax', reason: 'empty string draft' };
    }
    // Unbalanced fence-block detection — uneven count of ``` fences = broken
    // markdown that downstream renderers will mangle.
    const fenceCount = (draft.match(/```/g) || []).length;
    if (fenceCount % 2 !== 0) {
      return { ok: false, failed_at: 'syntax', reason: `unbalanced code fences (${fenceCount} backticks)` };
    }
    return { ok: true, failed_at: null, reason: '' };
  }
  if (typeof draft === 'object') {
    // If it parses as JSON when stringified, it's structurally fine.
    try {
      JSON.parse(JSON.stringify(draft));
      return { ok: true, failed_at: null, reason: '' };
    } catch (err) {
      return { ok: false, failed_at: 'syntax', reason: `unserializable object: ${err && err.message}` };
    }
  }
  return { ok: false, failed_at: 'syntax', reason: `unsupported draft type: ${typeof draft}` };
}

// ── 2. Namespace (orphan citations) ────────────────────────────────────

const ORPHAN_PATTERNS = [
  /\[\^(\d+)\](?!:)/g,          // footnote ref without definition
  /\[(\d+)\](?!\(|:|\s*\[)/g,    // bare [1] without link/def
  /\{\{[^}]+\}\}/g,              // template placeholders
];

function validateNamespace(draft) {
  const text = _asText(draft);
  if (text.length === 0) {
    return { ok: true, failed_at: null, reason: '' };
  }
  for (const re of ORPHAN_PATTERNS) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) {
      // For footnote refs, require the matching definition `[^N]:` to exist.
      if (m[0].startsWith('[^')) {
        const n = m[1];
        const defRe = new RegExp(`\\[\\^${n}\\]:`);
        if (!defRe.test(text)) {
          return { ok: false, failed_at: 'namespace', reason: `orphan citation [^${n}] (no matching definition)` };
        }
        continue;
      }
      // Bare [N] without link or definition → orphan.
      if (m[0].match(/^\[\d+\]$/)) {
        return { ok: false, failed_at: 'namespace', reason: `orphan citation ${m[0]} (no link or definition)` };
      }
      // Template placeholder.
      return { ok: false, failed_at: 'namespace', reason: `unresolved template placeholder ${m[0]}` };
    }
  }
  return { ok: true, failed_at: null, reason: '' };
}

// ── 3. Silent-catch (abandoned-marker body) ────────────────────────────
// intentional-placeholder: literal "TODO" / "FIXME" / "placeholder" tokens
// below are DETECTOR SIGNATURES, not deferred work. The validator scans
// generated lesson drafts for these markers (an LLM that emits "# TODO: fill
// this in" is silently catching its own failure — that is exactly what S88
// MSIFR is meant to short-circuit before paying for an LLM critic call).
const PLACEHOLDER_PATTERNS = [
  /#\s*TODO\b/i,
  /#\s*FIXME\b/i,
  /#\s*placeholder\b/i,
  /\bLOREM IPSUM\b/i,
  /\bTBD\b(?!\s*[:=])/,
  /<<\s*INSERT[^>]*>>/i,
  /\[\s*PLACEHOLDER\s*\]/i,
];

function validateSilentCatch(draft) {
  const text = _asText(draft);
  if (text.length === 0) {
    return { ok: false, failed_at: 'silent_catch', reason: 'empty body (no content to verify)' };
  }
  for (const re of PLACEHOLDER_PATTERNS) {
    const m = text.match(re);
    if (m) {
      return { ok: false, failed_at: 'silent_catch', reason: `placeholder marker: "${m[0]}"` };
    }
  }
  return { ok: true, failed_at: null, reason: '' };
}

// ── 4. Scope creep (body must match plan.scope_in, not leak scope_out) ──

function _tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/)
    .filter(t => t.length >= 2);
}

function validateScopeCreep(draft, plan) {
  const text = _asText(draft);
  if (text.length === 0 || !plan || typeof plan !== 'object') {
    return { ok: true, failed_at: null, reason: '' };
  }
  const scopeIn  = (plan.scope_in  || '').trim();
  const scopeOut = (plan.scope_out || '').trim();
  const lowerText = text.toLowerCase();

  // scope_in anchor — if non-empty, at least 1 distinctive token (≥3 char,
  // not a stopword) should appear in the body. Pure heuristic; not strict.
  if (scopeIn.length > 0) {
    const inTokens = _tokenize(scopeIn).filter(t => t.length >= 3);
    const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'are', '理论', '概念', '基本']);
    const distinctive = inTokens.filter(t => !STOPWORDS.has(t));
    if (distinctive.length > 0) {
      const anchorHit = distinctive.some(t => lowerText.includes(t));
      if (!anchorHit) {
        return {
          ok: false,
          failed_at: 'scope_creep',
          reason: `body misses every scope_in token (${distinctive.slice(0, 4).join(',')})`,
        };
      }
    }
  }

  // scope_out leak — if scope_out lists a phrase ≥4 chars long and body
  // literally contains it, treat as creep.
  if (scopeOut.length >= 4) {
    const phrases = scopeOut.split(/[,;。、·\/]+/).map(p => p.trim()).filter(p => p.length >= 4);
    for (const phrase of phrases) {
      if (lowerText.includes(phrase.toLowerCase())) {
        return {
          ok: false,
          failed_at: 'scope_creep',
          reason: `body leaks scope_out phrase: "${phrase}"`,
        };
      }
    }
  }
  return { ok: true, failed_at: null, reason: '' };
}

// ── Composer ───────────────────────────────────────────────────────────

function composeMsifr(draft, plan) {
  const checks = [
    () => validateSyntax(draft),
    () => validateNamespace(draft),
    () => validateSilentCatch(draft),
    () => validateScopeCreep(draft, plan),
  ];
  for (const fn of checks) {
    const r = fn();
    if (!r.ok) return r;
  }
  return { ok: true, failed_at: null, reason: '' };
}

module.exports = {
  validateSyntax,
  validateNamespace,
  validateSilentCatch,
  validateScopeCreep,
  composeMsifr,
};
