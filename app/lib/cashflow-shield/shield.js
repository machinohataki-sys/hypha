'use strict';

// HYPHA · W8.4 Cashflow Shield — Anti-runaway daily cost gate.
//
// Purpose: a runaway model loop (user misclick rapid-fire, agent infinite
// retry, system bug) can burn money silently if the only enforcement is
// per-lesson quota. The shield is a *daily* cost ceiling per tier.
//
// Files written:
//   vault/data/shield/daily/<userId>-<YYYY-MM-DD>.json
//     { user_id, day, total_cost_cny, soft_warn_emitted, last_call_ts }
//
// Pairs with `cost-budget.js`:
//   - shield = daily ¥ ceiling (cross-lesson)
//   - cost-budget = per-lesson call cap (per-capability)
// Both must pass for an LLM call to proceed.

const fs = require('node:fs');
const path = require('node:path');
const vault = require('../vault');
const costBudget = require('./cost-budget');

// -- thresholds -------------------------------------------------------------

// Legacy frozen table — RETAINED for backward compat with any caller that
// still imports `MAX_DAILY_COST_CNY` directly. The new source of truth is
// `loyalty-engine.TIER_DAILY_CAPS_CNY` (5 tiers, lowercase keys, null=∞).
// This object stays consistent with the original 3-tier surface but its
// values are now mirrored from loyalty-engine on every shield call.
const MAX_DAILY_COST_CNY = Object.freeze({
  Pro:      5,
  Founders: 10,
  BYOK:     999, // effectively unlimited; tracked for telemetry
});

const SOFT_WARN_FRACTION = 0.8;
// Three-tier gate transitions for v1.0 — UI surfaces consume `gate_state`:
//   < 0.9 limit       → OK            (silent)
//   [0.9, 1.0) limit  → WARN_90       (toast, BYOK fallback hint)
//   [1.0, 1.1) limit  → SOFT_BLOCK_100 (overage allowed if BYOK key present)
//   >= 1.1 limit      → HARD_BLOCK_110 (UI disabled until midnight reset)
// 10% headroom above 100% absorbs in-flight calls that already passed the
// pre-call gate; without it a fast double-fire could over-shoot then strand
// the user mid-lesson. Hard ceiling at 110% prevents runaway loop damage.
const WARN_FRACTION       = 0.9;
const SOFT_BLOCK_FRACTION = 1.0;
const HARD_BLOCK_FRACTION = 1.1;

// v1.0 boot-8 (2026-05-20) — process-life cache: userId → resolved tier id.
// Avoids re-reading vault/data/profile.json on every LLM pre-call. Profile
// is single-user single-file so a Map keyed by userId is sufficient. Cache
// invalidates on `pricing:set-founder-purchase` (main.js calls clearTierCache).
const _TIER_CACHE = new Map();          // userId → { tier, ts }
const _TIER_CACHE_TTL_MS = 5 * 60_000;  // 5min hard upper bound; invalidation
                                        //   is the primary mechanism, TTL is
                                        //   defensive against missed clears.

function _normaliseTierId(tier) {
  if (typeof tier !== 'string' || tier.length === 0) return null;
  return tier.toLowerCase();
}

function _readProfileTierSync(userId) {
  // userId currently unused in resolution (single-user vault); future multi-
  // user mode keys profile by userId. Kept in signature so the cache layer
  // stays correct under that migration.
  try {
    const root = vault.resolveRoot();
    const profileAbs = path.join(root, 'data', 'profile.json');
    if (!fs.existsSync(profileAbs)) return null;
    const raw = fs.readFileSync(profileAbs, 'utf8');
    const profile = JSON.parse(raw);
    // Late require — loyalty-engine is pure JS, no circular load risk.
    const engine = require('../pricing/loyalty-engine');
    const result = engine.queryTier(profile);
    return result && typeof result.tier === 'string' ? result.tier : null;
  } catch (_) {
    return null; // fail safe — caller falls through to caller-supplied tier
  }
}

function resolveCachedTier(userId) {
  if (!userId) return null;
  const hit = _TIER_CACHE.get(userId);
  const now = Date.now();
  if (hit && (now - hit.ts) < _TIER_CACHE_TTL_MS) return hit.tier;
  const fresh = _readProfileTierSync(userId);
  if (fresh) _TIER_CACHE.set(userId, { tier: fresh, ts: now });
  return fresh;
}

function clearTierCache(userId) {
  if (userId === undefined || userId === null) {
    _TIER_CACHE.clear();
    return;
  }
  _TIER_CACHE.delete(userId);
}

// -- io ---------------------------------------------------------------------

function _today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function _shieldDir() {
  const root = vault.resolveRoot();
  const dir = path.join(root, 'data', 'shield', 'daily');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function _stateFile(userId, day = _today()) {
  const safe = String(userId || 'local').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(_shieldDir(), `${safe}-${day}.json`);
}

function _readState(userId) {
  const f = _stateFile(userId);
  if (!fs.existsSync(f)) {
    return {
      user_id: userId,
      day: _today(),
      total_cost_cny: 0,
      soft_warn_emitted: false,
      last_call_ts: null,
    };
  }
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (_) {
    return {
      user_id: userId, day: _today(), total_cost_cny: 0,
      soft_warn_emitted: false, last_call_ts: null,
    };
  }
}

function _writeState(state) {
  const f = _stateFile(state.user_id, state.day);
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, f);
}

function _tierLimit(tier) {
  // 2026-05-13 — dev-mode bypass (HYPHA_DEV / HYPHA_ALLOW_CLI / NODE_ENV).
  // Authoritative check lives in cost-budget.isDevMode; mirror here so both
  // gates ungate together. Consumer Pro ¥5/day cap applies to end-users only.
  if (costBudget.isDevMode && costBudget.isDevMode()) {
    return MAX_DAILY_COST_CNY.BYOK;
  }
  // v1.0 boot-8 — route through loyalty-engine for per-tier cap.
  // BYOK + null cap → Infinity (still tracked for telemetry, never blocks).
  // Unknown / missing tier → most-restrictive (Free ¥5) per
  // loyalty-engine.getTierDailyCap fail-safe.
  try {
    const engine = require('../pricing/loyalty-engine');
    const id = _normaliseTierId(tier);
    const cap = engine.getTierDailyCap(id);
    if (cap === null) return Infinity; // BYOK unlimited
    if (Number.isFinite(cap)) return cap;
    return engine.getTierDailyCap('free'); // belt-and-braces fail safe
  } catch (_) {
    // loyalty-engine unavailable — fall back to legacy 3-tier table.
    if (!tier) return MAX_DAILY_COST_CNY.Pro;
    const titleCase = tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase();
    if (MAX_DAILY_COST_CNY[titleCase] !== undefined) return MAX_DAILY_COST_CNY[titleCase];
    return MAX_DAILY_COST_CNY.Pro;
  }
}

function _effectiveTier(tier) {
  if (costBudget.isDevMode && costBudget.isDevMode()) return 'byok';
  const norm = _normaliseTierId(tier);
  return norm || 'pro';
}

// -- core API ---------------------------------------------------------------

/**
 * Health check — returns budget state for the user today.
 *
 * @param {string} userId
 * @param {string} [tier='Pro']
 * @returns {{ok: boolean, today_cost_cny: number, remaining_cny: number,
 *            limit_cny: number, soft_warn: boolean, tier: string}}
 */
function checkCashflowShield(userId, tier = 'pro') {
  const state = _readState(userId);
  // v1.0 boot-8 — prefer profile-resolved tier (cached) over caller-supplied.
  // This is the security gate: end-users cannot pass `tier: 'founders'` from
  // renderer-side to escape their actual cap. Caller `tier` only wins when
  // no profile is on disk (e.g. first-run / smoke tests).
  const profileTier = resolveCachedTier(userId);
  const eff = _effectiveTier(profileTier || tier);
  const limit = _tierLimit(eff);
  const today = state.total_cost_cny || 0;
  const remaining = (limit === Infinity)
    ? Infinity
    : Math.max(0, limit - today);
  const softWarn = (limit !== Infinity)
    && today >= limit * SOFT_WARN_FRACTION
    && today < limit;
  const dev = !!(costBudget.isDevMode && costBudget.isDevMode());
  let gateState = 'OK';
  if (limit !== Infinity) {
    const ratio = today / limit;
    if (ratio >= HARD_BLOCK_FRACTION)      gateState = 'HARD_BLOCK_110';
    else if (ratio >= SOFT_BLOCK_FRACTION) gateState = 'SOFT_BLOCK_100';
    else if (ratio >= WARN_FRACTION)       gateState = 'WARN_90';
  } else {
    gateState = 'OK_UNLIMITED';
  }
  return {
    ok: limit === Infinity ? true : gateState !== 'HARD_BLOCK_110',
    today_cost_cny: Number(today.toFixed(6)),
    remaining_cny: (limit === Infinity) ? null : Number(remaining.toFixed(6)),
    limit_cny: (limit === Infinity) ? null : limit,
    unlimited: limit === Infinity,
    soft_warn: softWarn,
    gate_state: gateState,
    tier: eff,
    requested_tier: tier,
    profile_tier: profileTier || null,
    dev_mode: dev,
  };
}

/**
 * BudgetExceeded error class — surfaces a structured error the router can
 * turn into a UI-friendly toast without leaking provider details.
 */
class BudgetExceededError extends Error {
  constructor(reason, details = {}) {
    super(reason);
    this.name = 'BudgetExceededError';
    this.code = 'BUDGET_EXCEEDED';
    this.details = details;
  }
}

/**
 * Pre-call gate. Combines:
 *   1. Daily ¥ ceiling (this module)
 *   2. Per-lesson call cap (cost-budget.js)
 *
 * @param {string} userId
 * @param {{tier?: string, slug?: string, lessonIdx?: number,
 *          capability?: string, estimated_cost_cny?: number}} plannedCall
 * @throws {BudgetExceededError} if either gate fails
 * @returns {{ok: true, shield: object}}
 */
function enforceShield(userId, plannedCall = {}) {
  // checkCashflowShield resolves the *real* tier (profile > caller-supplied).
  // We pass plannedCall.tier in, and read back the resolved tier on `shield.tier`.
  const shield = checkCashflowShield(userId, plannedCall.tier);
  const tier = shield.tier; // canonical lowercase id
  const est = Number(plannedCall.estimated_cost_cny || 0);

  // BYOK (incl. dev-mode auto-promote) = user-paid keys. Track but never block.
  // Unlimited tier (shield.unlimited === true) also bypasses the daily ceiling.
  const isUnlimited = tier === 'byok' || shield.unlimited === true;
  if (!isUnlimited) {
    const remaining = Number(shield.remaining_cny);
    const projected = (shield.today_cost_cny || 0) + (est || 0);
    const limit = Number(shield.limit_cny);
    const projectedRatio = limit > 0 ? projected / limit : 0;
    // Hard ceiling at 110% — runaway-loop circuit breaker. Pre-call gate must
    // refuse so even an in-flight overspend cannot pierce this.
    if (projectedRatio >= HARD_BLOCK_FRACTION || shield.gate_state === 'HARD_BLOCK_110') {
      throw new BudgetExceededError(
        `daily cost hard ceiling reached (${tier}: ¥${shield.today_cost_cny.toFixed(2)}/¥${shield.limit_cny} ≥ 110%)`,
        { reason: 'hard_ceiling', shield, tier, planned: plannedCall, projectedRatio },
      );
    }
    // Soft block 100-110%: allowed only when BYOK fallback is available (caller
    // supplies plannedCall.byok_fallback === true after prompting user). Without
    // fallback, surface SOFT_BLOCK so caller can show the prompt.
    if (projectedRatio >= SOFT_BLOCK_FRACTION) {
      if (plannedCall.byok_fallback !== true) {
        throw new BudgetExceededError(
          `daily cost ceiling reached, BYOK fallback required (${tier}: ¥${shield.today_cost_cny.toFixed(2)}/¥${shield.limit_cny})`,
          { reason: 'daily_ceiling', shield, tier, planned: plannedCall,
            gate_state: 'SOFT_BLOCK_100', byok_fallback_available: true },
        );
      }
      // BYOK fallback acknowledged → proceed but mark.
    } else if (!shield.ok || est > remaining) {
      throw new BudgetExceededError(
        `daily cost ceiling reached (${tier}: ¥${shield.today_cost_cny}/¥${shield.limit_cny})`,
        { reason: 'daily_ceiling', shield, tier, planned: plannedCall },
      );
    }
  }

  // Per-lesson cap check (cost-budget.js). cost-budget.js currently keys its
  // table by TitleCase ('Pro' / 'Founders' / 'BYOK') — only Pro/Founders/BYOK
  // have per-lesson caps. Basic/Free fall back to Pro caps for now (their
  // daily ¥ cap above is the dominant constraint anyway).
  if (plannedCall.slug && typeof plannedCall.lessonIdx === 'number' && plannedCall.capability) {
    const legacyTier = ({
      founders: 'Founders',
      pro:      'Pro',
      byok:     'BYOK',
      basic:    'Pro', // no per-lesson cap row yet; daily ¥15 is the gate
      free:     'Pro', // same — daily ¥5 dominates
    })[tier] || 'Pro';
    const exceed = costBudget.wouldExceedBudget(
      plannedCall.slug,
      plannedCall.lessonIdx,
      plannedCall.capability,
      legacyTier,
    );
    if (exceed && !isUnlimited) {
      throw new BudgetExceededError(
        `per-lesson cap reached (${tier} / ${plannedCall.capability} on lesson ${plannedCall.lessonIdx})`,
        { reason: 'lesson_cap', tier, planned: plannedCall },
      );
    }
  }

  return { ok: true, shield };
}

/**
 * Append a charge to the daily shield state. Called *after* the LLM call
 * succeeds (cost-budget.js writes the per-lesson line; shield.js writes
 * the daily total). Returns the new state.
 */
function recordCharge(userId, costCny) {
  const state = _readState(userId);
  // Date rollover — if state.day !== today, start a fresh state.
  const today = _today();
  if (state.day !== today) {
    state.day = today;
    state.total_cost_cny = 0;
    state.soft_warn_emitted = false;
  }
  state.total_cost_cny = Number(((state.total_cost_cny || 0) + (costCny || 0)).toFixed(6));
  state.last_call_ts = Date.now();
  _writeState(state);
  return state;
}

/**
 * Soft warning — emitted (idempotently per day) when daily spend ≥ 80%
 * of the tier limit. Caller renders a non-blocking UI toast.
 */
function notifyExceedSoft(userId, tier = 'pro') {
  const shield = checkCashflowShield(userId, tier);
  if (!shield.soft_warn) return { emitted: false, shield };
  const state = _readState(userId);
  if (state.soft_warn_emitted) return { emitted: false, shield, deduped: true };
  state.soft_warn_emitted = true;
  _writeState(state);
  const pct = (shield.limit_cny && shield.limit_cny > 0)
    ? Math.round(100 * shield.today_cost_cny / shield.limit_cny)
    : 0;
  return {
    emitted: true,
    shield,
    message: `今日已用 ¥${shield.today_cost_cny} / ¥${shield.limit_cny} (${pct}%). 接近今日上限.`,
  };
}

// Daily reset metadata — user-local midnight from system timezone. UI uses
// `next_reset_ms` for countdown surface; smoke verifies key stability across a
// synthetic clock advance.
function getResetInfo() {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return {
    today_key: _today(),
    next_reset_ms: tomorrow.getTime(),
    next_reset_iso: tomorrow.toISOString(),
    timezone_offset_min: now.getTimezoneOffset(),
  };
}

module.exports = {
  MAX_DAILY_COST_CNY,
  SOFT_WARN_FRACTION,
  WARN_FRACTION,
  SOFT_BLOCK_FRACTION,
  HARD_BLOCK_FRACTION,
  BudgetExceededError,
  checkCashflowShield,
  enforceShield,
  recordCharge,
  notifyExceedSoft,
  getResetInfo,
  // v1.0 boot-8 — tier-cap cache surface (main.js invalidates on tier change)
  resolveCachedTier,
  clearTierCache,
};
