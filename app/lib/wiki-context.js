'use strict';

// wiki-context — replaces vault-context.js for the deepen pipeline.
//
// Calls ptor2/wiki/walk to retrieve top-K wiki articles + 1-hop graph
// neighborhood, formats as [WIKI:slug] cards. Keeps the same call signature
// as vault-context.js so deepen-pipeline.js's switch is just one require()
// rename.
//
// Fallback: if wiki-index.json is missing OR has zero articles, fall through
// to v1 vault-context (paragraph cosine RAG) so the pipeline still has SOME
// awareness of the vault during the migration window. This fallback is
// scheduled for removal in v0.3 once the wiki is mandatory.

let _walkFn = null;
function getWalk() {
  if (_walkFn) return _walkFn;
  try {
    _walkFn = require('../../../ptor2-legacy-corpus-bet/wiki/walk').walk;
  } catch (_) {
    _walkFn = null;
  }
  return _walkFn;
}

let _v1Build = null;
function getV1Build() {
  if (_v1Build) return _v1Build;
  try {
    _v1Build = require('./vault-context').buildVaultContext;
  } catch (_) {
    _v1Build = null;
  }
  return _v1Build;
}

// Same signature as v1 buildVaultContext for drop-in replacement.
//
// @returns {Promise<{ articles, charter, formatted, source }>}
//   source: 'wiki' | 'v1-fallback' | 'empty'
async function buildWikiContext({ vaultRoot, query, currentNoteRel, kCards = 8, signal }) {
  const empty = { articles: [], charter: '', formatted: '', source: 'empty' };

  if (!vaultRoot || !query || String(query).trim().length < 3) {
    return empty;
  }

  // Try wiki path first
  const walk = getWalk();
  if (walk) {
    try {
      const r = await walk({ vaultRoot, query, currentNoteRel, kCards, signal });
      if (r && r.articles && r.articles.length > 0) {
        return {
          articles: r.articles,
          charter: r.charter,
          formatted: r.formatted,
          source: 'wiki',
        };
      }
      // No articles matched — could be empty wiki (index 0 articles) or
      // simply a query that didn't lexically match. The walk module already
      // distinguishes via formatted text. If wiki has SOME articles but none
      // matched, return wiki source (don't fall back; that's a real result).
      // If wiki is completely empty, fall through to v1.
      const idx = require('../../../ptor2-legacy-corpus-bet/wiki/index');
      const wikiIdx = idx.loadIndex(vaultRoot);
      const wikiSize = Object.keys(wikiIdx.articles || {}).length;
      if (wikiSize > 0) {
        // Wiki built but no match — return wiki source with the empty-match block
        return {
          articles: [],
          charter: r.charter,
          formatted: r.formatted,
          source: 'wiki',
        };
      }
    } catch (e) {
      console.log(`[wiki-context] walk failed: ${e.message}, falling back to v1`);
    }
  }

  // Fallback: v1 paragraph-cosine RAG (will be removed in v0.3)
  const v1 = getV1Build();
  if (v1) {
    try {
      const r = await v1({ vaultRoot, query, currentNoteRel, kCards, signal });
      console.log('[wiki-context] using v1 vault-context fallback (wiki not built yet)');
      return {
        articles: r.cards || [],
        charter: r.charter || '',
        formatted: r.formatted || '',
        source: 'v1-fallback',
      };
    } catch (_) {}
  }

  return empty;
}

// Extract [WIKI:slug] citations from a text. Used by writeback to identify
// which articles a synth output cited. Returns deduped slugs.
function extractWikiCitations(text) {
  if (!text) return [];
  const matches = String(text).match(/\[WIKI:([^\s\]]+)\]/g) || [];
  const set = new Set();
  for (const m of matches) {
    const inner = m.replace(/^\[WIKI:/, '').replace(/\]$/, '');
    if (inner) set.add(inner);
  }
  return Array.from(set);
}

module.exports = { buildWikiContext, extractWikiCitations };
