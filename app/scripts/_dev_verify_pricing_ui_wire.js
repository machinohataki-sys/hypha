'use strict';
// Pricing v3 UI wire — smoke gate (v0.5.0-bootstrap-3 P7).
//
// Verifies the 2 surface JSX files compile clean + carry the wire identifiers,
// and that the loyalty-engine module's exported API has not regressed since
// _dev_verify_pricing_loyalty.js (the 10/10 backend gate).
//
// 5 checks:
//   PU1  course-trust-panel.jsx esbuild compile clean
//   PU2  screen-ux-settings.jsx esbuild compile clean
//   PU3  course-trust-panel.jsx references queryTier identifier
//   PU4  screen-ux-settings.jsx references setFounderPurchase identifier
//   PU5  loyalty-engine API shape unchanged (regression guard)
//
// Run:  node app/scripts/_dev_verify_pricing_ui_wire.js
// Exit: 0 = all PASS, 1 = any FAIL.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PANEL_REL = 'app/design/course-trust-panel.jsx';
const SETTINGS_REL = 'app/design/screen-ux-settings.jsx';
const PANEL_ABS = path.join(ROOT, PANEL_REL);
const SETTINGS_ABS = path.join(ROOT, SETTINGS_REL);
const ENGINE_REL = '../lib/pricing/loyalty-engine';

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

function esbuildCheck(relPath) {
  // --bundle=false → single-file syntax + JSX validation only; no module resolution.
  // --loader:.jsx=jsx ensures JSX is parsed (default for .jsx ext but explicit).
  // Pipe stdout/stderr; throw on non-zero. Output to /dev/null (NUL on win32).
  const out = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const cmd = [
    'npx', '--no-install', 'esbuild',
    '"' + relPath.replace(/\\/g, '/') + '"',
    '--loader:.jsx=jsx',
    '--bundle=false',
    '--log-level=error',
    '> ' + out,
  ].join(' ');
  try {
    execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
    return { ok: true };
  } catch (err) {
    const stderr = (err && err.stderr && err.stderr.toString()) || '';
    return { ok: false, error: stderr.split('\n').slice(0, 5).join(' | ') || (err.message || String(err)) };
  }
}

// ---------------------------------------------------------------------------
// PU1 — course-trust-panel.jsx esbuild compile clean
// ---------------------------------------------------------------------------
{
  const r = esbuildCheck(PANEL_REL);
  check(
    'PU1 course-trust-panel.jsx esbuild compile clean',
    r.ok,
    r.error
  );
}

// ---------------------------------------------------------------------------
// PU2 — screen-ux-settings.jsx esbuild compile clean
// ---------------------------------------------------------------------------
{
  const r = esbuildCheck(SETTINGS_REL);
  check(
    'PU2 screen-ux-settings.jsx esbuild compile clean',
    r.ok,
    r.error
  );
}

// ---------------------------------------------------------------------------
// PU3 — course-trust-panel.jsx references queryTier identifier
// ---------------------------------------------------------------------------
{
  let src = '';
  try { src = fs.readFileSync(PANEL_ABS, 'utf-8'); } catch (e) {
    check('PU3 course-trust-panel.jsx references queryTier', false, 'read failed: ' + e.message);
  }
  if (src) {
    const hasQuery = src.indexOf('queryTier') !== -1;
    const hasPricingTier = src.indexOf('PricingTierChip') !== -1;
    const hasBridgePath = src.indexOf('window.ptor.hypha.pricing') !== -1;
    check(
      'PU3 course-trust-panel.jsx references queryTier + PricingTierChip + bridge path',
      hasQuery && hasPricingTier && hasBridgePath,
      'queryTier=' + hasQuery + ' chip=' + hasPricingTier + ' bridge=' + hasBridgePath
    );
  }
}

// ---------------------------------------------------------------------------
// PU4 — screen-ux-settings.jsx references setFounderPurchase identifier
// ---------------------------------------------------------------------------
{
  let src = '';
  try { src = fs.readFileSync(SETTINGS_ABS, 'utf-8'); } catch (e) {
    check('PU4 screen-ux-settings.jsx references setFounderPurchase', false, 'read failed: ' + e.message);
  }
  if (src) {
    const hasSetter = src.indexOf('setFounderPurchase') !== -1;
    const hasPanel = src.indexOf('FoundersPurchasePanel') !== -1;
    const hasBridge = src.indexOf('pricingBridge') !== -1;
    check(
      'PU4 screen-ux-settings.jsx references setFounderPurchase + FoundersPurchasePanel + pricingBridge',
      hasSetter && hasPanel && hasBridge,
      'setter=' + hasSetter + ' panel=' + hasPanel + ' bridge=' + hasBridge
    );
  }
}

// ---------------------------------------------------------------------------
// PU5 — loyalty-engine API shape unchanged (regression guard)
// ---------------------------------------------------------------------------
{
  let lib;
  try { lib = require(ENGINE_REL); } catch (e) {
    check('PU5 loyalty-engine importable', false, e.message);
  }
  if (lib) {
    const requiredExports = [
      'TIERS', 'PRICING', 'PRO_LOYALTY_CURVE', 'FOUNDERS_LOYALTY_CURVE',
      'FOUNDERS_PERKS', 'queryTier', 'setFounderPurchase',
      'computeYearsSince', 'pickFromCurve',
    ];
    const missing = requiredExports.filter(k => !(k in lib));
    const tierKeysOk = lib.TIERS
      && lib.TIERS.FREE === 'free'
      && lib.TIERS.BASIC === 'basic'
      && lib.TIERS.PRO === 'pro'
      && lib.TIERS.FOUNDERS === 'founders'
      && lib.TIERS.BYOK === 'byok';
    const queryTierFn = typeof lib.queryTier === 'function';
    const setFounderFn = typeof lib.setFounderPurchase === 'function';
    // Sanity smoke — empty profile → free tier, monthly 0.
    let runtimeOk = false;
    try {
      const r = lib.queryTier({});
      runtimeOk = (r && r.tier === 'free' && r.monthly_cny === 0);
    } catch (_) { /* runtimeOk stays false */ }
    check(
      'PU5 loyalty-engine API shape + TIERS enum + queryTier runtime unchanged',
      missing.length === 0 && tierKeysOk && queryTierFn && setFounderFn && runtimeOk,
      'missing=' + JSON.stringify(missing) +
      ' tierKeys=' + tierKeysOk +
      ' queryTierFn=' + queryTierFn +
      ' setFounderFn=' + setFounderFn +
      ' runtime=' + runtimeOk
    );
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('');
console.log('───────────────────────────────────────');
console.log('pricing-ui-wire smoke: ' + pass + ' PASS / ' + fail + ' FAIL  (' + pass + '/' + (pass + fail) + ')');
if (fail > 0) {
  console.log('');
  console.log('Failures:');
  for (const f of failures) {
    console.log('  - ' + f.label + (f.detail ? '  — ' + f.detail : ''));
  }
  process.exit(1);
}
process.exit(0);
