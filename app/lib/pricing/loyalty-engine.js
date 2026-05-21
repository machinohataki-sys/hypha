'use strict';
// Pricing v3 loyalty engine — pure JS, no external deps.
//
// Per CLAUDE.md §"Pricing v3 (2026-05-08, Founders Path E)":
//   founder_purchased_at + years_since drives Pro discount tier.
//   General Pro:  ¥99 (Y0-1) → ¥80 (Y1-3) → ¥69 floor (Y3+)
//   Founders:    ¥99 (Y0-1) → ¥69 (Y1-2) → ¥49 (Y2-3) → ¥29 floor (Y3+)
//
// This slice ships the pure decision function. IPC + profile.json schema
// mutation are deferred to the backend mega agent (do NOT add here).
//
// Inputs:
//   profileSnapshot = subset of vault/data/profile.json, fields:
//     { byok_enabled?: bool,
//       founder_purchased_at?: ISO8601,
//       pro_started_at?: ISO8601,
//       basic_started_at?: ISO8601 }
//   opts.refMs = override "now" for deterministic tests.
//
// Output shape:
//   { tier, monthly_cny, pricing_floor, perks[],
//     years_since?, founder_purchased_at?, pro_started_at?, basic_started_at?,
//     status? }
//
// Priority order (highest first): BYOK → Founders → Pro → Basic → Free.

const TIERS = Object.freeze({
  FREE: 'free',
  BASIC: 'basic',
  PRO: 'pro',
  FOUNDERS: 'founders',
  BYOK: 'byok',
});

const PRICING = Object.freeze({
  [TIERS.FREE]: 0,
  [TIERS.BASIC]: 39,
  [TIERS.BYOK]: 0,
});

const PRO_LOYALTY_CURVE = Object.freeze([
  Object.freeze({ min_years: 0, max_years: 1, monthly_cny: 99 }),
  Object.freeze({ min_years: 1, max_years: 3, monthly_cny: 80 }),
  Object.freeze({ min_years: 3, max_years: Infinity, monthly_cny: 69 }),
]);

const FOUNDERS_LOYALTY_CURVE = Object.freeze([
  Object.freeze({ min_years: 0, max_years: 1, monthly_cny: 99 }),
  Object.freeze({ min_years: 1, max_years: 2, monthly_cny: 69 }),
  Object.freeze({ min_years: 2, max_years: 3, monthly_cny: 49 }),
  Object.freeze({ min_years: 3, max_years: Infinity, monthly_cny: 29 }),
]);

const FOUNDERS_PERKS = Object.freeze([
  'founding_contributor_badge',
  'early_access_features',
  'roadmap_voting_rights',
  'monthly_office_hours_invite',
]);

// v1.0 boot-8 (2026-05-20) — per-tier daily ¥ ceiling. Wired into
// cashflow-shield/shield.js via getTierDailyCap() so the daily cap follows
// the user's tier instead of a hard-coded constant.
//
// Conventions:
//   - keys MATCH `TIERS` ids (lowercase) — loyalty engine is the source of
//     truth for tier id casing. shield._tierLimit normalises legacy
//     TitleCase ("Pro" → "pro") to keep backward compat.
//   - null  = unlimited at the platform level (BYOK — user pays own keys).
//   - dev-mode bypass continues to live in shield (HYPHA_DEV / NODE_ENV) —
//     not duplicated here; this table is the consumer ceiling.
//
// Rationale per ceiling:
//   founders  ¥50/d — 永久席位 鼓励重度使用，与 ¥499 价值锚一致
//   pro       ¥30/d — 正式订阅 工作日全日 ~30 课计划余量
//   basic     ¥15/d — 入门 ¥39/月 单课强度
//   free      ¥5/d  — 试用最低体感 (1-2 课/日 ceiling)
//   byok      null  — 用户自付 provider, 平台不限 (telemetry 仍 track)
const TIER_DAILY_CAPS_CNY = Object.freeze({
  [TIERS.FOUNDERS]: 50,
  [TIERS.PRO]:      30,
  [TIERS.BASIC]:    15,
  [TIERS.FREE]:     5,
  [TIERS.BYOK]:     null, // unlimited — caller treats as Infinity
});

/**
 * Return the daily ¥ cap for a tier id (case-insensitive).
 * Unknown tier → most-restrictive (Free ¥5). null = unlimited (BYOK).
 *
 * @param {string} tierId  — 'founders' | 'pro' | 'basic' | 'free' | 'byok'
 * @returns {number|null}
 */
function getTierDailyCap(tierId) {
  if (typeof tierId !== 'string' || tierId.length === 0) {
    return TIER_DAILY_CAPS_CNY[TIERS.FREE];
  }
  const key = tierId.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(TIER_DAILY_CAPS_CNY, key)) {
    return TIER_DAILY_CAPS_CNY[key];
  }
  // Unknown tier — fail safe to most-restrictive (Free ¥5). Never throw.
  return TIER_DAILY_CAPS_CNY[TIERS.FREE];
}

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Compute years elapsed since an ISO timestamp.
 * Returns 0 for null/invalid/future timestamps (defensive — never negative).
 *
 * @param {string|null|undefined} timestampISO
 * @param {number} [refMs=Date.now()]
 * @returns {number}
 */
function computeYearsSince(timestampISO, refMs = Date.now()) {
  if (!timestampISO || typeof timestampISO !== 'string') return 0;
  const t = Date.parse(timestampISO);
  if (!Number.isFinite(t)) return 0;
  if (t > refMs) return 0;
  return (refMs - t) / MS_PER_YEAR;
}

/**
 * Pick the monthly_cny matching `years` from a sorted loyalty curve.
 * Falls through to the last band's value if years exceeds all bounds
 * (the last band is the floor; max_years=Infinity).
 *
 * @param {ReadonlyArray<{min_years:number,max_years:number,monthly_cny:number}>} curve
 * @param {number} years
 * @returns {number}
 */
function pickFromCurve(curve, years) {
  for (const band of curve) {
    if (years >= band.min_years && years < band.max_years) {
      return band.monthly_cny;
    }
  }
  return curve[curve.length - 1].monthly_cny;
}

/**
 * Resolve the active tier + monthly price + floor + perks for a profile.
 * Pure function. Does not read disk, does not mutate input.
 *
 * @param {object|null|undefined} profileSnapshot
 * @param {{refMs?: number}} [opts]
 * @returns {{
 *   tier: string,
 *   monthly_cny: number,
 *   pricing_floor: number,
 *   perks: string[],
 *   years_since?: number,
 *   founder_purchased_at?: string,
 *   pro_started_at?: string,
 *   basic_started_at?: string,
 *   status?: string,
 * }}
 */
function queryTier(profileSnapshot, opts = {}) {
  if (!profileSnapshot || typeof profileSnapshot !== 'object') {
    return {
      tier: TIERS.FREE,
      monthly_cny: 0,
      pricing_floor: 0,
      perks: [],
      status: 'no_profile',
    };
  }
  const refMs = Number.isFinite(opts.refMs) ? opts.refMs : Date.now();

  // BYOK takes priority — user runs on their own keys.
  if (profileSnapshot.byok_enabled === true) {
    return {
      tier: TIERS.BYOK,
      monthly_cny: 0,
      pricing_floor: 0,
      perks: ['own_api_keys'],
    };
  }

  // Founders — most aggressive loyalty curve, plus perks.
  if (profileSnapshot.founder_purchased_at) {
    const years = computeYearsSince(profileSnapshot.founder_purchased_at, refMs);
    const monthly = pickFromCurve(FOUNDERS_LOYALTY_CURVE, years);
    return {
      tier: TIERS.FOUNDERS,
      monthly_cny: monthly,
      pricing_floor: FOUNDERS_LOYALTY_CURVE[FOUNDERS_LOYALTY_CURVE.length - 1].monthly_cny,
      perks: FOUNDERS_PERKS.slice(),
      founder_purchased_at: profileSnapshot.founder_purchased_at,
      years_since: years,
    };
  }

  // Pro — gentler loyalty curve, no perks.
  if (profileSnapshot.pro_started_at) {
    const years = computeYearsSince(profileSnapshot.pro_started_at, refMs);
    const monthly = pickFromCurve(PRO_LOYALTY_CURVE, years);
    return {
      tier: TIERS.PRO,
      monthly_cny: monthly,
      pricing_floor: PRO_LOYALTY_CURVE[PRO_LOYALTY_CURVE.length - 1].monthly_cny,
      perks: [],
      pro_started_at: profileSnapshot.pro_started_at,
      years_since: years,
    };
  }

  // Basic — flat ¥39, no loyalty discount.
  if (profileSnapshot.basic_started_at) {
    return {
      tier: TIERS.BASIC,
      monthly_cny: PRICING[TIERS.BASIC],
      pricing_floor: PRICING[TIERS.BASIC],
      perks: [],
      basic_started_at: profileSnapshot.basic_started_at,
    };
  }

  // Free fallback.
  return {
    tier: TIERS.FREE,
    monthly_cny: 0,
    pricing_floor: 0,
    perks: [],
  };
}

/**
 * Return a NEW profile object with founder_purchased_at set.
 * Does NOT mutate the input. Caller persists via existing profile writer
 * (backend mega agent owns the IPC + disk write — not this slice).
 *
 * @param {object|null|undefined} profileSnapshot
 * @param {string} [timestampISO=new Date().toISOString()]
 * @returns {object|null}
 */
function setFounderPurchase(profileSnapshot, timestampISO) {
  if (!profileSnapshot || typeof profileSnapshot !== 'object') return null;
  const ts = typeof timestampISO === 'string' && timestampISO.length > 0
    ? timestampISO
    : new Date().toISOString();
  return Object.assign({}, profileSnapshot, { founder_purchased_at: ts });
}

module.exports = {
  TIERS,
  PRICING,
  PRO_LOYALTY_CURVE,
  FOUNDERS_LOYALTY_CURVE,
  FOUNDERS_PERKS,
  TIER_DAILY_CAPS_CNY,
  queryTier,
  setFounderPurchase,
  getTierDailyCap,
  computeYearsSince,
  pickFromCurve,
};
