'use strict';

// HYPHA · α21 Cost Budget v0 (Infrastructure §16 子组件 v0, 2026-05-16)
//
// Per-curriculum 月 budget 跟踪 + soft 警告。cost-ledger 4-class UI 已 ship
// (provider / tokenizer-fallback / fallback-estimate / legacy), 但用户没有
// 月 budget 限可能一月烧太多。v0 = 给每 curriculum 设月 cap, 实时算累计
// spend, 到 90% 警告, 到 110% 锁 (soft, !硬阻止 LLM call, 只标 flag)。
//
// Public surface:
//   setMonthlyBudget({ slug, budgetUSD })
//     → { ok:true, budget:{slug,budgetUSD,setAt} }
//        | { ok:false, error }
//   getBudgetStatus({ slug, month=null })
//     → { ok:true, status:{ slug, month, budgetUSD, spentUSD, remainingUSD,
//          percentUsed, state, callCount } }
//        | { ok:false, error }
//   listBudgetHistory({ slug, limit=12 })
//     → { ok:true, rows:[{month, totalUSD, callCount}] }
//        | { ok:false, error }
//   recordSpend({ slug, costUSD, provider, model, ts=null })
//     → { ok:true } | { ok:false, error }
//
// Error codes:
//   MISSING_SLUG / INVALID_BUDGET / INVALID_COST / EXCEPTION
//
// Storage:
//   vault/<slug>/.cost-budget.json       — { slug, budgetUSD, setAt }
//   vault/<slug>/.cost-budget-log.jsonl  — append-only spend log
//     row: { ts, month:'YYYY-MM', costUSD, provider, model }
//
// State boundaries (percentUsed = spent / budget * 100):
//   < 90       → 'ok'
//   90 - 100   → 'warn-90'
//   100 - 110  → 'over-100'
//   > 110      → 'over-110'
//   no config OR no log in target month → 'no-budget' w/ spent=0
//
// v0 ! 接 agent.js LLM 拦截 (集成下一波)。

const fs = require('node:fs');
const path = require('node:path');

const { resolveRoot } = require('../vault');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BUDGET_USD = 1000;
const BUDGET_FILE = '.cost-budget.json';
const LOG_FILE = '.cost-budget-log.jsonl';

// ---------------------------------------------------------------------------
// _path helpers
// ---------------------------------------------------------------------------

function _slugBudgetPath(slug) {
  const root = resolveRoot();
  return path.join(root, slug, BUDGET_FILE);
}

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

function _readBudget(abs) {
  if (!fs.existsSync(abs)) return null;
  try {
    const text = fs.readFileSync(abs, 'utf-8');
    if (!text) return null;
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object') return null;
    return obj;
  } catch (_) {
    return null;
  }
}

function _writeBudget(abs, obj) {
  _ensureDir(abs);
  fs.writeFileSync(abs, JSON.stringify(obj, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// _monthKey — extract 'YYYY-MM' from an ISO ts (or any string whose first
// 7 chars match the prefix). Returns null if not parseable.
// ---------------------------------------------------------------------------

function _monthKey(ts) {
  if (typeof ts !== 'string' || ts.length < 7) return null;
  const head = ts.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(head)) return null;
  return head;
}

function _currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

// ---------------------------------------------------------------------------
// _classifyState — percentUsed → state enum
// ---------------------------------------------------------------------------

function _classifyState(percentUsed) {
  if (!Number.isFinite(percentUsed)) return 'ok';
  if (percentUsed < 90) return 'ok';
  if (percentUsed < 100) return 'warn-90';
  if (percentUsed <= 110) return 'over-100';
  return 'over-110';
}

// ---------------------------------------------------------------------------
// setMonthlyBudget
// ---------------------------------------------------------------------------

async function setMonthlyBudget(payload = {}) {
  try {
    const slug = typeof payload.slug === 'string' ? payload.slug.trim() : '';
    if (!slug) return { ok: false, error: 'MISSING_SLUG' };

    const budgetUSD = payload.budgetUSD;
    if (
      !Number.isFinite(budgetUSD) ||
      budgetUSD <= 0 ||
      budgetUSD > MAX_BUDGET_USD
    ) {
      return { ok: false, error: 'INVALID_BUDGET' };
    }

    const budget = {
      slug,
      budgetUSD,
      setAt: new Date().toISOString(),
    };
    _writeBudget(_slugBudgetPath(slug), budget);
    return { ok: true, budget };
  } catch (_) {
    return { ok: false, error: 'EXCEPTION' };
  }
}

// ---------------------------------------------------------------------------
// getBudgetStatus
// ---------------------------------------------------------------------------

async function getBudgetStatus(payload = {}) {
  try {
    const slug = typeof payload.slug === 'string' ? payload.slug.trim() : '';
    if (!slug) return { ok: false, error: 'MISSING_SLUG' };

    const month = typeof payload.month === 'string' && payload.month
      ? payload.month
      : _currentMonth();

    const budget = _readBudget(_slugBudgetPath(slug));
    const rows = _readAllRows(_slugLogPath(slug));

    let spentUSD = 0;
    let callCount = 0;
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      if (r.month !== month) continue;
      const cost = Number.isFinite(r.costUSD) ? r.costUSD : 0;
      spentUSD += cost;
      callCount += 1;
    }

    if (!budget || !Number.isFinite(budget.budgetUSD)) {
      return {
        ok: true,
        status: {
          slug,
          month,
          budgetUSD: 0,
          spentUSD,
          remainingUSD: 0 - spentUSD,
          percentUsed: 0,
          state: 'no-budget',
          callCount,
        },
      };
    }

    const budgetUSD = budget.budgetUSD;
    const remainingUSD = budgetUSD - spentUSD;
    const percentUsed = budgetUSD > 0
      ? Math.round((spentUSD / budgetUSD) * 1000) / 10
      : 0;
    const state = _classifyState(percentUsed);

    return {
      ok: true,
      status: {
        slug,
        month,
        budgetUSD,
        spentUSD: Math.round(spentUSD * 10000) / 10000,
        remainingUSD: Math.round(remainingUSD * 10000) / 10000,
        percentUsed,
        state,
        callCount,
      },
    };
  } catch (_) {
    return { ok: false, error: 'EXCEPTION' };
  }
}

// ---------------------------------------------------------------------------
// recordSpend — append a row to .cost-budget-log.jsonl
// ---------------------------------------------------------------------------

async function recordSpend(payload = {}) {
  try {
    const slug = typeof payload.slug === 'string' ? payload.slug.trim() : '';
    if (!slug) return { ok: false, error: 'MISSING_SLUG' };

    const costUSD = payload.costUSD;
    if (!Number.isFinite(costUSD) || costUSD < 0) {
      return { ok: false, error: 'INVALID_COST' };
    }

    const ts = typeof payload.ts === 'string' && payload.ts
      ? payload.ts
      : new Date().toISOString();
    const month = _monthKey(ts) || _currentMonth();

    const provider = typeof payload.provider === 'string' ? payload.provider : '';
    const model = typeof payload.model === 'string' ? payload.model : '';

    const row = { ts, month, costUSD, provider, model };
    _appendRow(_slugLogPath(slug), row);
    return { ok: true };
  } catch (_) {
    return { ok: false, error: 'EXCEPTION' };
  }
}

// ---------------------------------------------------------------------------
// listBudgetHistory — month-by-month aggregate, newest first
// ---------------------------------------------------------------------------

async function listBudgetHistory(payload = {}) {
  try {
    const slug = typeof payload.slug === 'string' ? payload.slug.trim() : '';
    if (!slug) return { ok: false, error: 'MISSING_SLUG' };

    const limit = Number.isFinite(payload.limit) && payload.limit > 0
      ? Math.floor(payload.limit) : 12;

    const rows = _readAllRows(_slugLogPath(slug));
    // Aggregate by month
    const byMonth = new Map();
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const month = typeof r.month === 'string' ? r.month : _monthKey(r.ts);
      if (!month) continue;
      const cost = Number.isFinite(r.costUSD) ? r.costUSD : 0;
      const prior = byMonth.get(month) || { month, totalUSD: 0, callCount: 0 };
      prior.totalUSD += cost;
      prior.callCount += 1;
      byMonth.set(month, prior);
    }
    // Sort by month DESC (newest first)
    const monthsDesc = Array.from(byMonth.keys()).sort((a, b) => b.localeCompare(a));
    const out = [];
    for (const m of monthsDesc) {
      if (out.length >= limit) break;
      const r = byMonth.get(m);
      out.push({
        month: r.month,
        totalUSD: Math.round(r.totalUSD * 10000) / 10000,
        callCount: r.callCount,
      });
    }
    return { ok: true, rows: out };
  } catch (_) {
    return { ok: false, error: 'EXCEPTION' };
  }
}

module.exports = {
  setMonthlyBudget,
  getBudgetStatus,
  recordSpend,
  listBudgetHistory,
  MAX_BUDGET_USD,
};
