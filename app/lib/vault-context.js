'use strict';

// vault-context — assemble structured, provenance-anchored vault context for
// the deepen pipeline. The whole point is to make Cmd+D / Cmd+Q condition on
// the user's growing corpus WITHOUT (a) blowing the prompt budget, (b) giving
// the LLM room to fabricate "your notes say X" claims that aren't there.
//
// Design lineage: LLM-Wiki (provenance anchors + structured cards) + Gbrain
// (graph-aware retrieval, hierarchical drill-down). V1 ships flat top-k cards
// with [NOTE:slug] anchors + DRILL-on-demand hint. V2 (deferred) adds 1-hop
// co-citation neighborhood + per-stage projections.
//
// What this is NOT: it is not a body dump of top notes. Body dumps are how
// hallucination amplifies — model treats long context as license to embroider.
// Cards = compressed summaries with explicit slugs; if the model wants more,
// it must request [DRILL:slug] and we re-fetch. V1 doesn't implement the
// DRILL loop yet — but the prompt asks for it instead of inventing.
//
// Output budget target: ≤1.0K tokens per pipeline run (8 cards × ~80 tokens
// + ~120 tokens charter). Gemini-2.5-flash 1M window absorbs this trivially;
// the discipline is for relevance, not size.

const path = require('node:path');

// Lazy-resolve ptor2 modules. ptor-design lives at E:\victor\ptor-design\app\lib;
// ptor2 lives at E:\victor\ptor2. Three levels up + ptor2 path.
let _searchFn = null;
let _charterMod = null;

function ragSearch() {
  if (_searchFn) return _searchFn;
  try {
    _searchFn = require('../../../ptor2-legacy-corpus-bet/rag/search').search;
  } catch (e) {
    _searchFn = null;
  }
  return _searchFn;
}

function charterMod() {
  if (_charterMod) return _charterMod;
  try {
    _charterMod = require('../../../ptor2-legacy-corpus-bet/corpus/charter');
  } catch (e) {
    _charterMod = null;
  }
  return _charterMod;
}

// rel "ai-learn/SAGE_Day01.md" → slug "ai-learn/SAGE_Day01"
// Slugs are the provenance anchor: model can cite [NOTE:ai-learn/SAGE_Day01]
// but it cannot invent slugs that don't appear in the cards block.
function relToSlug(rel) {
  return String(rel || '').replace(/\.md$/i, '');
}

// Cap snippet to maxChars, strip markdown noise that bloats tokens without
// adding signal. Keep CJK + Latin, drop wikilink syntax, strip emphasis markers.
function trimSnippet(s, maxChars = 140) {
  if (!s) return '';
  let t = String(s)
    .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\*)\*(?!\*)([^*]+)(?<!\*)\*(?!\*)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > maxChars) t = t.slice(0, maxChars).replace(/\s+\S*$/, '') + '…';
  return t;
}

// Format the cards + charter into a single context block for prompt injection.
// Layout is the LLM-Wiki memory-card pattern: each note one card, with explicit
// [NOTE:slug] anchor + relation score + drill-down + provenance instructions
// baked into the block (so the rule travels with the data).
function formatContext({ charterText, cards, currentNoteRel }) {
  const parts = [];

  if (charterText) {
    parts.push(charterText);
    parts.push('');
  }

  if (!cards || cards.length === 0) {
    parts.push('[your vault — no related prior notes for this query]');
    parts.push('— treat this as fresh thinking. do not fabricate vault citations.');
    return parts.join('\n');
  }

  parts.push('[your vault — top ' + cards.length + ' related cards from your prior notes]');
  parts.push('');

  for (const c of cards) {
    const isCurrent = currentNoteRel && c.rel === currentNoteRel;
    parts.push('[NOTE:' + c.slug + ']' + (isCurrent ? ' (current note)' : ''));
    parts.push('  ↳ ' + trimSnippet(c.snippet));
    parts.push('  rel: ' + Number(c.score).toFixed(2));
    parts.push('');
  }

  parts.push('— provenance rules:');
  parts.push('  • cite [NOTE:slug] when you draw on a card. the slug must appear above.');
  parts.push('  • if a card looks relevant but you need its full body, output [DRILL:slug]');
  parts.push('    in your reasoning — do not invent contents not visible above.');
  parts.push('  • web/general-knowledge claims: mark [WEB] or [REASONING], not vault.');
  parts.push('  • the "rel" score is similarity to the selection, not endorsement.');

  return parts.join('\n');
}

// Build vault context for one deepen-pipeline run. Single RAG call shared
// across stages (paragraphs deduped to one card per source note).
//
// @param {object} args
// @param {string} args.vaultRoot   — absolute vault path (vault.resolveRoot())
// @param {string} args.query       — selection text used for RAG retrieval
// @param {string} [args.currentNoteRel] — note the selection lives in (filtered out of cards by default)
// @param {number} [args.kCards=8]  — max cards to keep after dedupe
// @param {AbortSignal} [args.signal]
// @returns {Promise<{cards, charter, formatted}>}
async function buildVaultContext({ vaultRoot, query, currentNoteRel, kCards = 8, signal }) {
  const empty = { cards: [], charter: '', formatted: '' };

  if (!vaultRoot || !query || String(query).trim().length < 3) {
    empty.formatted = formatContext({ charterText: '', cards: [] });
    return empty;
  }

  // 1. Charter preamble (≤120 tokens, optional).
  let charterText = '';
  const cm = charterMod();
  if (cm && cm.readCharter && cm.computePhase && cm.buildPreamble) {
    try {
      const charter = cm.readCharter(vaultRoot);
      if (charter) {
        const phaseInfo = cm.computePhase(charter);
        charterText = cm.buildPreamble(charter, phaseInfo) || '';
      }
    } catch (_) {}
  }

  if (signal && signal.aborted) return empty;

  // 2. RAG hits — paragraph-level. Pull k*3 to allow dedupe-by-note + filter.
  const search = ragSearch();
  if (!search) {
    return {
      cards: [],
      charter: charterText,
      formatted: formatContext({ charterText, cards: [] }),
    };
  }

  let hits = [];
  try {
    hits = await search(vaultRoot, String(query).trim(), kCards * 3);
  } catch (_) {
    return {
      cards: [],
      charter: charterText,
      formatted: formatContext({ charterText, cards: [] }),
    };
  }

  if (signal && signal.aborted) return empty;

  // 3. Dedupe by note. Keep best-scoring paragraph per source note.
  // Filter out the current note (the selection's own home) — citing yourself
  // adds no value. User can still see [DRILL:current] hints if model wants
  // self-reference for some reason.
  const byNote = new Map();
  for (const h of hits) {
    if (!h || !h.noteRelPath) continue;
    if (currentNoteRel && h.noteRelPath === currentNoteRel) continue;
    const cur = byNote.get(h.noteRelPath);
    if (!cur || cur.score < h.score) byNote.set(h.noteRelPath, h);
  }

  const cards = [];
  for (const [rel, h] of byNote.entries()) {
    cards.push({
      rel,
      slug: relToSlug(rel),
      snippet: h.snippet,
      score: h.score,
    });
    if (cards.length >= kCards) break;
  }

  // Sort cards by score desc so the most relevant card appears first.
  cards.sort((a, b) => b.score - a.score);

  // 4. Format for prompt injection.
  const formatted = formatContext({ charterText, cards, currentNoteRel });

  return { cards, charter: charterText, formatted };
}

module.exports = {
  buildVaultContext,
  formatContext,
  trimSnippet,
  relToSlug,
};
