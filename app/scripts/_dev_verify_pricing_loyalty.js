'use strict';
// Pricing v3 loyalty engine — smoke gate.
//
// Created 2026-05-19. Verifies app/lib/pricing/loyalty-engine.js ships
// the locked loyalty curves (per CLAUDE.md §"Pricing v3 ... Founders
// implementation hook") before the backend mega agent wires IPC +
// profile.json schema mutation.
//
// 10 cases: LP1 empty → Free, LP2 BYOK priority, LP3-LP6 Founders curve,
// LP7-LP9 Pro curve, LP10 setFounderPurchase immutability.
//
// Run:  node app/scripts/_dev_verify_pricing_loyalty.js
// Exit: 0 = all PASS, 1 = any FAIL.

const engine = require('../lib/pricing/loyalty-engine');

const {
  TIERS,
  queryTier,
  setFounderPurchase,
  computeYearsSince,
} = engine;

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail) {
  if (ok) {
    pass += 1;
    console.log('PASS  ' + label);
  } else {
    fail += 1;
    failures.push({ label, detail });
    console.log('FAIL  ' + label + (detail ? '  — ' + detail : ''));
  }
}

// Anchor "now" so curve math is deterministic across runs.
const NOW = Date.parse('2026-05-19T00:00:00Z');
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

function isoYearsAgo(years) {
  return new Date(NOW - years * MS_PER_YEAR).toISOString();
}

// ---------------------------------------------------------------------------
// LP1 — empty / null profile → Free tier
// ---------------------------------------------------------------------------
{
  const a = queryTier(null, { refMs: NOW });
  const b = queryTier(undefined, { refMs: NOW });
  const c = queryTier({}, { refMs: NOW });
  check(
    'LP1 empty/null/undefined profile → Free tier',
    a.tier === TIERS.FREE && a.monthly_cny === 0 &&
    b.tier === TIERS.FREE && b.monthly_cny === 0 &&
    c.tier === TIERS.FREE && c.monthly_cny === 0,
    'got tiers=' + [a.tier, b.tier, c.tier].join(',')
  );
}

// ---------------------------------------------------------------------------
// LP2 — BYOK profile → BYOK tier (priority over everything)
// ---------------------------------------------------------------------------
{
  const profile = {
    byok_enabled: true,
    // these should ALL be ignored — BYOK wins.
    founder_purchased_at: isoYearsAgo(2),
    pro_started_at: isoYearsAgo(5),
    basic_started_at: isoYearsAgo(1),
  };
  const r = queryTier(profile, { refMs: NOW });
  check(
    'LP2 BYOK priority over founders+pro+basic',
    r.tier === TIERS.BYOK && r.monthly_cny === 0 && r.pricing_floor === 0,
    'got tier=' + r.tier + ' monthly=' + r.monthly_cny
  );
}

// ---------------------------------------------------------------------------
// LP3 — Founders year 0 → ¥99
// ---------------------------------------------------------------------------
{
  const profile = { founder_purchased_at: isoYearsAgo(0.3) };
  const r = queryTier(profile, { refMs: NOW });
  check(
    'LP3 Founders year 0.3 → ¥99',
    r.tier === TIERS.FOUNDERS && r.monthly_cny === 99 && r.pricing_floor === 29,
    'got monthly=' + r.monthly_cny + ' floor=' + r.pricing_floor
  );
}

// ---------------------------------------------------------------------------
// LP4 — Founders year 1.5 → ¥69
// ---------------------------------------------------------------------------
{
  const profile = { founder_purchased_at: isoYearsAgo(1.5) };
  const r = queryTier(profile, { refMs: NOW });
  check(
    'LP4 Founders year 1.5 → ¥69',
    r.tier === TIERS.FOUNDERS && r.monthly_cny === 69,
    'got monthly=' + r.monthly_cny + ' years=' + r.years_since
  );
}

// ---------------------------------------------------------------------------
// LP5 — Founders year 2.5 → ¥49
// ---------------------------------------------------------------------------
{
  const profile = { founder_purchased_at: isoYearsAgo(2.5) };
  const r = queryTier(profile, { refMs: NOW });
  check(
    'LP5 Founders year 2.5 → ¥49',
    r.tier === TIERS.FOUNDERS && r.monthly_cny === 49,
    'got monthly=' + r.monthly_cny + ' years=' + r.years_since
  );
}

// ---------------------------------------------------------------------------
// LP6 — Founders year 4 → ¥29 floor + perks present
// ---------------------------------------------------------------------------
{
  const profile = { founder_purchased_at: isoYearsAgo(4) };
  const r = queryTier(profile, { refMs: NOW });
  const hasPerks = Array.isArray(r.perks) && r.perks.length === 4 &&
    r.perks.includes('founding_contributor_badge') &&
    r.perks.includes('early_access_features') &&
    r.perks.includes('roadmap_voting_rights') &&
    r.perks.includes('monthly_office_hours_invite');
  check(
    'LP6 Founders year 4 → ¥29 floor + 4 perks',
    r.tier === TIERS.FOUNDERS &&
    r.monthly_cny === 29 &&
    r.pricing_floor === 29 &&
    hasPerks,
    'got monthly=' + r.monthly_cny + ' perks=' + JSON.stringify(r.perks)
  );
}

// ---------------------------------------------------------------------------
// LP7 — Pro year 0 → ¥99
// ---------------------------------------------------------------------------
{
  const profile = { pro_started_at: isoYearsAgo(0.4) };
  const r = queryTier(profile, { refMs: NOW });
  check(
    'LP7 Pro year 0.4 → ¥99',
    r.tier === TIERS.PRO && r.monthly_cny === 99 && r.pricing_floor === 69 &&
    Array.isArray(r.perks) && r.perks.length === 0,
    'got monthly=' + r.monthly_cny + ' floor=' + r.pricing_floor
  );
}

// ---------------------------------------------------------------------------
// LP8 — Pro year 2 → ¥80
// ---------------------------------------------------------------------------
{
  const profile = { pro_started_at: isoYearsAgo(2) };
  const r = queryTier(profile, { refMs: NOW });
  check(
    'LP8 Pro year 2 → ¥80',
    r.tier === TIERS.PRO && r.monthly_cny === 80,
    'got monthly=' + r.monthly_cny + ' years=' + r.years_since
  );
}

// ---------------------------------------------------------------------------
// LP9 — Pro year 5 → ¥69 floor
// ---------------------------------------------------------------------------
{
  const profile = { pro_started_at: isoYearsAgo(5) };
  const r = queryTier(profile, { refMs: NOW });
  check(
    'LP9 Pro year 5 → ¥69 floor',
    r.tier === TIERS.PRO && r.monthly_cny === 69 && r.pricing_floor === 69,
    'got monthly=' + r.monthly_cny + ' floor=' + r.pricing_floor
  );
}

// ---------------------------------------------------------------------------
// LP10 — setFounderPurchase returns NEW object, leaves original immutable
// ---------------------------------------------------------------------------
{
  const original = { pro_started_at: isoYearsAgo(1), name: 'tester' };
  const originalKeys = Object.keys(original).slice().sort();
  const next = setFounderPurchase(original, '2026-05-19T00:00:00Z');

  const isNewRef = next !== original;
  const originalUnchanged =
    !Object.prototype.hasOwnProperty.call(original, 'founder_purchased_at') &&
    Object.keys(original).slice().sort().join(',') === originalKeys.join(',') &&
    original.name === 'tester' &&
    original.pro_started_at !== undefined;
  const nextHasField = next && next.founder_purchased_at === '2026-05-19T00:00:00Z';
  const nextCarriesOldFields = next && next.name === 'tester' && next.pro_started_at !== undefined;

  // Bonus: setFounderPurchase(null) → null (defensive)
  const nullResult = setFounderPurchase(null) === null;

  check(
    'LP10 setFounderPurchase returns new object + original immutable + null-safe',
    isNewRef && originalUnchanged && nextHasField && nextCarriesOldFields && nullResult,
    'newRef=' + isNewRef + ' origClean=' + originalUnchanged +
    ' nextField=' + nextHasField + ' carryFields=' + nextCarriesOldFields +
    ' nullSafe=' + nullResult
  );

  // Cross-check: queryTier on `next` now picks Founders, not Pro.
  const tierAfter = queryTier(next, { refMs: NOW }).tier;
  if (tierAfter !== TIERS.FOUNDERS) {
    console.log('       NOTE  cross-check: queryTier(next).tier=' + tierAfter + ' (expected founders) — Founders priority over Pro per LP2 contract');
  }
}

// ---------------------------------------------------------------------------
// Bonus diagnostic — computeYearsSince edge cases (not counted in 10/10)
// ---------------------------------------------------------------------------
{
  const futureISO = new Date(NOW + 1e10).toISOString();
  const ok =
    computeYearsSince(null, NOW) === 0 &&
    computeYearsSince('', NOW) === 0 &&
    computeYearsSince('not-a-date', NOW) === 0 &&
    computeYearsSince(futureISO, NOW) === 0;
  if (!ok) {
    console.log('NOTE  computeYearsSince edge cases drifted — not counted in 10/10 but worth investigating');
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('');
console.log('───────────────────────────────────────');
console.log('pricing-loyalty smoke: ' + pass + ' PASS / ' + fail + ' FAIL  (' + pass + '/' + (pass + fail) + ')');
if (fail > 0) {
  console.log('');
  console.log('Failures:');
  for (const f of failures) {
    console.log('  - ' + f.label + (f.detail ? '  — ' + f.detail : ''));
  }
  process.exit(1);
}
process.exit(0);
