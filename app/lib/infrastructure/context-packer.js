'use strict';

// HYPHA · β20 Context Packer (Infrastructure §16 子组件 v0, 2026-05-16)
//
// Per-lesson 显式 budget for system-prompt blocks. Each lesson LLM call
// stacks: Constitution / Persona register / Wisdom / Lesson Brief /
// Grounding / History — easily 8k-12k tokens.  v0 = priority-stack greedy
// pack against an explicit token budget, char/3.7 近似 (! tiktoken),
// !v0 接 designLesson (集成下一波)。
//
// Public surface:
//   estimateTokens(text)
//     → integer (Math.ceil(text.length / 3.7))
//   packContext({ budget=6000, blocks=[], policy='priority-stack' })
//     → { ok:true, decision:{ accepted:[{name,included,truncated,tokens}],
//          totalTokens, budget, overBudget, warnings:[] } }
//        | { ok:false, error }
//   logPackDecision({ slug, lessonIdx, budget, blocks, decision, ts })
//     → { ok:true } | { ok:false, error }
//   listPackHistory({ slug, limit=50 })
//     → { ok:true, rows:[...] } | { ok:false, error }
//
// Error codes:
//   INVALID_BUDGET / INVALID_BLOCKS / INVALID_POLICY / MISSING_SLUG /
//   EXCEPTION
//
// Storage:
//   vault/<slug>/.context-pack-log.jsonl  — append-only summary
//     row: { ts, lessonIdx, budget, totalTokens, blockCount, overBudget,
//            decision_summary:[{name, included, truncated, tokens}] }
//     ! 写完整 content (避免 vault bloat + privacy leak).

const fs = require('node:fs');
const path = require('node:path');

const { resolveRoot } = require('../vault');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 3.7;     // v0 近似 (CN ~3, EN ~4, 3.7 折中)
const OVER_BUDGET_RATIO = 1.2;   // > budget * 1.2 → warning flag
const VALID_POLICIES = Object.freeze(['priority-stack']);
const LOG_FILE = '.context-pack-log.jsonl';
const TRUNCATE_TAIL = '\n[…截尾]';
const TRUNCATE_TAIL_TOKENS = estimateTokens(TRUNCATE_TAIL);

// ---------------------------------------------------------------------------
// estimateTokens — pure function (char-count proxy)
// ---------------------------------------------------------------------------

function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// _path helpers
// ---------------------------------------------------------------------------

function _slugLogPath(slug) {
  const root = resolveRoot();
  return path.join(root, slug, LOG_FILE);
}

function _ensureDir(abs) {
  try { fs.mkdirSync(path.dirname(abs), { recursive: true }); }
  catch (_) { /* swallow */ }
}

function _appendRow(abs, obj) {
  _ensureDir(abs);
  fs.appendFileSync(abs, JSON.stringify(obj) + '\n', 'utf-8');
}

function _readAllRows(abs) {
  if (!fs.existsSync(abs)) return [];
  let text = '';
  try { text = fs.readFileSync(abs, 'utf-8'); }
  catch (_) { return []; }
  if (!text) return [];
  const out = [];
  for (const ln of text.split(/\r?\n/)) {
    if (!ln.trim()) continue;
    try { out.push(JSON.parse(ln)); } catch (_) { /* skip malformed */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// _truncateToTokens — char-level truncate so resulting tokens <= maxTokens
// (including the trailing `[…截尾]` marker). Returns null if no room.
// ---------------------------------------------------------------------------

function _truncateToTokens(content, maxTokens) {
  if (maxTokens <= 0) return null;
  // Need room for content + tail. If maxTokens <= tail tokens → cannot fit.
  if (maxTokens <= TRUNCATE_TAIL_TOKENS) return null;
  const contentTokensCap = maxTokens - TRUNCATE_TAIL_TOKENS;
  // Convert token cap to char cap: contentTokens = ceil(chars/3.7) <= cap
  // → chars <= floor(cap * 3.7)
  const charCap = Math.floor(contentTokensCap * CHARS_PER_TOKEN);
  if (charCap <= 0) return null;
  if (content.length <= charCap) {
    // Already fits without truncation
    return content;
  }
  return content.slice(0, charCap) + TRUNCATE_TAIL;
}

// ---------------------------------------------------------------------------
// _validateBlocks — return [] (ok) or error string
// ---------------------------------------------------------------------------

function _validateBlocks(blocks) {
  if (!Array.isArray(blocks)) return 'blocks not array';
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b || typeof b !== 'object') return `block[${i}] not object`;
    if (typeof b.name !== 'string' || !b.name) return `block[${i}] missing name`;
    if (typeof b.content !== 'string') return `block[${i}] content not string`;
    const pri = b.priority;
    if (!Number.isFinite(pri) || pri < 1 || pri > 5 || Math.floor(pri) !== pri) {
      return `block[${i}] priority must be int 1-5`;
    }
    if (b.required !== undefined && typeof b.required !== 'boolean') {
      return `block[${i}] required must be boolean`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// packContext
// ---------------------------------------------------------------------------

function packContext(payload = {}) {
  try {
    const budget = Number.isFinite(payload.budget) ? payload.budget : 6000;
    const blocks = Array.isArray(payload.blocks) ? payload.blocks : null;
    const policy = typeof payload.policy === 'string' && payload.policy
      ? payload.policy : 'priority-stack';

    if (!Number.isFinite(budget) || budget <= 0 || Math.floor(budget) !== budget) {
      return { ok: false, error: 'INVALID_BUDGET' };
    }
    if (!blocks) {
      return { ok: false, error: 'INVALID_BLOCKS' };
    }
    if (!VALID_POLICIES.includes(policy)) {
      return { ok: false, error: 'INVALID_POLICY' };
    }
    const blocksErr = _validateBlocks(blocks);
    if (blocksErr) {
      return { ok: false, error: 'INVALID_BLOCKS' };
    }

    // priority-stack algorithm:
    //   1. accept all required=true blocks (even if cumulative > budget)
    //   2. order remaining (required=false) by priority ASC (1 most important)
    //      → greedy include full content if fits
    //   3. doesn't fit → try truncate to remaining budget
    //   4. flag overBudget if total > budget * OVER_BUDGET_RATIO

    const warnings = [];
    const accepted = []; // [{name, included, truncated, tokens}]
    let runningTokens = 0;

    // Phase 1: required
    for (const b of blocks) {
      if (b.required !== true) continue;
      const tokens = estimateTokens(b.content);
      runningTokens += tokens;
      accepted.push({
        name: b.name,
        included: true,
        truncated: false,
        tokens,
      });
    }
    if (runningTokens > budget) {
      warnings.push(`required blocks (${runningTokens}t) exceed budget (${budget}t)`);
    }

    // Phase 2: optional — sort by priority ASC, stable order on ties
    const optional = [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.required === true) continue;
      optional.push({ idx: i, block: b });
    }
    optional.sort((a, b) => {
      const dp = a.block.priority - b.block.priority;
      if (dp !== 0) return dp;
      return a.idx - b.idx;
    });

    for (const { block: b } of optional) {
      const remaining = budget - runningTokens;
      const fullTokens = estimateTokens(b.content);

      if (remaining <= 0) {
        // No room at all
        accepted.push({
          name: b.name,
          included: false,
          truncated: false,
          tokens: 0,
        });
        continue;
      }

      if (fullTokens <= remaining) {
        // Full include
        runningTokens += fullTokens;
        accepted.push({
          name: b.name,
          included: true,
          truncated: false,
          tokens: fullTokens,
        });
        continue;
      }

      // Try truncate to fit remaining
      const truncated = _truncateToTokens(b.content, remaining);
      if (truncated === null) {
        accepted.push({
          name: b.name,
          included: false,
          truncated: false,
          tokens: 0,
        });
        continue;
      }
      const truncTokens = estimateTokens(truncated);
      runningTokens += truncTokens;
      accepted.push({
        name: b.name,
        included: true,
        truncated: true,
        tokens: truncTokens,
      });
    }

    const overBudget = runningTokens > budget * OVER_BUDGET_RATIO;
    if (overBudget) {
      warnings.push(`total ${runningTokens}t > budget*${OVER_BUDGET_RATIO} (${Math.floor(budget * OVER_BUDGET_RATIO)}t)`);
    }

    return {
      ok: true,
      decision: {
        accepted,
        totalTokens: runningTokens,
        budget,
        overBudget,
        warnings,
      },
    };
  } catch (_) {
    return { ok: false, error: 'EXCEPTION' };
  }
}

// ---------------------------------------------------------------------------
// logPackDecision — append summary row to vault/<slug>/.context-pack-log.jsonl
// ---------------------------------------------------------------------------

async function logPackDecision(payload = {}) {
  try {
    const slug = typeof payload.slug === 'string' ? payload.slug.trim() : '';
    if (!slug) return { ok: false, error: 'MISSING_SLUG' };

    const lessonIdx = Number.isFinite(payload.lessonIdx) ? Math.floor(payload.lessonIdx) : -1;
    const budget = Number.isFinite(payload.budget) ? payload.budget : 0;
    const decision = payload.decision && typeof payload.decision === 'object'
      ? payload.decision : { accepted: [], totalTokens: 0, overBudget: false };
    const ts = typeof payload.ts === 'string' && payload.ts
      ? payload.ts : new Date().toISOString();

    // Summarize accepted — name + included + truncated + tokens only, ! content
    const decision_summary = Array.isArray(decision.accepted)
      ? decision.accepted.map(b => ({
          name: typeof b?.name === 'string' ? b.name : '',
          included: b?.included === true,
          truncated: b?.truncated === true,
          tokens: Number.isFinite(b?.tokens) ? b.tokens : 0,
        }))
      : [];

    const row = {
      ts,
      lessonIdx,
      budget,
      totalTokens: Number.isFinite(decision.totalTokens) ? decision.totalTokens : 0,
      blockCount: decision_summary.length,
      overBudget: decision.overBudget === true,
      decision_summary,
    };
    _appendRow(_slugLogPath(slug), row);
    return { ok: true };
  } catch (_) {
    return { ok: false, error: 'EXCEPTION' };
  }
}

// ---------------------------------------------------------------------------
// listPackHistory — reverse + limit
// ---------------------------------------------------------------------------

async function listPackHistory(payload = {}) {
  try {
    const slug = typeof payload.slug === 'string' ? payload.slug.trim() : '';
    if (!slug) return { ok: false, error: 'MISSING_SLUG' };

    const limit = Number.isFinite(payload.limit) && payload.limit > 0
      ? Math.floor(payload.limit) : 50;

    const abs = _slugLogPath(slug);
    if (!fs.existsSync(abs)) return { ok: true, rows: [] };
    const rows = _readAllRows(abs);
    const out = [];
    for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
      const r = rows[i];
      if (r && typeof r === 'object') out.push(r);
    }
    return { ok: true, rows: out };
  } catch (_) {
    return { ok: false, error: 'EXCEPTION' };
  }
}

module.exports = {
  estimateTokens,
  packContext,
  logPackDecision,
  listPackHistory,
  CHARS_PER_TOKEN,
  OVER_BUDGET_RATIO,
  VALID_POLICIES,
};
