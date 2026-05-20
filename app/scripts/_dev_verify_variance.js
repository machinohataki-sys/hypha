'use strict';

// HYPHA · Phase C · variance-vs-frontier smoke (2026-05-17).
//
// Stubs vault with a fixed chain.json containing link.duration_weeks +
// link.frontier_axis_p50, plus a controllable lifetime-ledger.jsonl, then
// drives `varianceVsFrontier()` to verify:
//   (a) leading band when user count >> p50 pro-rated
//   (b) p50-p75 band when user count ≈ p50 pro-rated
//   (c) insufficient_data when frontier_axis_p50 missing
//
// Standalone Node. No Electron required. Exit: 0 PASS / 1 FAIL.

const path = require('node:path');

// ---------------------------------------------------------------------------
// vault shim. Must pre-populate require.cache BEFORE loading the variance
// module so the shim wins over the real vault.js.
// ---------------------------------------------------------------------------

const fakeStore = new Map();    // rel -> array (jsonl entries)
const fakeJSON  = new Map();    // rel -> object (chain.json etc.)

const vaultShim = {
  appendJSONL(rel, entry) {
    const arr = fakeStore.get(rel) || [];
    arr.push(entry);
    fakeStore.set(rel, arr);
  },
  readJSONL(rel) {
    return (fakeStore.get(rel) || []).slice();
  },
  readJSON(rel) {
    return fakeJSON.has(rel) ? fakeJSON.get(rel) : null;
  },
  read(rel) {
    const arr = fakeStore.get(rel);
    if (arr) return { body: arr.map(JSON.stringify).join('\n') + '\n' };
    if (fakeJSON.has(rel)) return { body: JSON.stringify(fakeJSON.get(rel)) };
    return null;
  },
  write(rel, body) {
    try { fakeJSON.set(rel, JSON.parse(body)); }
    catch (_) {
      const arr = String(body).split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch (_) { return null; }
      }).filter(Boolean);
      fakeStore.set(rel, arr);
    }
  },
};

const vaultRealPath = require.resolve(path.join(__dirname, '..', 'lib', 'vault.js'));
require.cache[vaultRealPath] = {
  id: vaultRealPath,
  filename: vaultRealPath,
  loaded: true,
  exports: vaultShim,
};

const variance = require(path.join(__dirname, '..', 'lib', 'lifetime-ledger', 'compute-variance'));
const ledger = require(path.join(__dirname, '..', 'lib', 'lifetime-ledger'));

// ---------------------------------------------------------------------------

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(G('  PASS'), name, detail ? `· ${detail}` : ''); }
  else    { fail += 1; console.log(R('  FAIL'), name, detail ? `· ${detail}` : ''); }
}

// ---------------------------------------------------------------------------

(async () => {
  console.log(Y('lifetime-ledger variance smoke'));
  console.log('────────────────────────────────────────');

  // Fixed test chain. link 0 has frontier; link 1 does not (insufficient_data
  // test). duration_weeks = 10 to make pro-rated arithmetic clean.
  const slug = '__verify_variance__';
  fakeJSON.set(`${slug}/chain.json`, {
    chain: {
      links: [
        {
          topic: 'L0',
          duration_weeks: 10,
          frontier_axis_p50: { learn: 100, practice: 500 },
        },
        {
          topic: 'L1',
          duration_weeks: 8,
          // no frontier_axis_p50 → insufficient_data
        },
      ],
    },
    inputs: { evidence: [{}, {}, {}] },
  });

  // ---- (a) leading band: 5 entries on link 0, learn cumulative=80, expected
  // at 5/10 weeks = 50 → ratio 1.6 → leading.
  for (let w = 0; w < 5; w++) {
    await ledger.appendEntry(slug, { linkIdx: 0, axis_counts: { learn: 16, practice: 50 } });
  }
  const v_lead = await variance.varianceVsFrontier({ chainSlug: slug, linkIdx: 0, axis: 'learn' });
  check('leading band',
    v_lead.band === 'leading',
    `band=${v_lead.band} ratio=${v_lead.ratio?.toFixed(2)} done=${v_lead.userCount}`);
  check('leading supportiveLine present',
    typeof v_lead.supportiveLine === 'string' && v_lead.supportiveLine.length > 5,
    v_lead.supportiveLine);

  // ---- (b) p50-p75 band: practice cumulative = 250 across 5 weeks, expected
  // at 5/10 weeks = 250 → ratio 1.0 → p50-p75.
  const v_p50 = await variance.varianceVsFrontier({ chainSlug: slug, linkIdx: 0, axis: 'practice' });
  check('p50-p75 band',
    v_p50.band === 'p50-p75',
    `band=${v_p50.band} ratio=${v_p50.ratio?.toFixed(2)} done=${v_p50.userCount}`);

  // ---- (c) insufficient_data: link 1 has no frontier_axis_p50.
  await ledger.appendEntry(slug, { linkIdx: 1, axis_counts: { learn: 1 } });
  const v_insuff = await variance.varianceVsFrontier({ chainSlug: slug, linkIdx: 1, axis: 'learn' });
  check('insufficient_data band',
    v_insuff.band === 'insufficient_data',
    `band=${v_insuff.band} reason=${v_insuff.reason}`);
  check('insufficient supportiveLine register-clean',
    typeof v_insuff.supportiveLine === 'string' && !/!|emoji/.test(v_insuff.supportiveLine),
    v_insuff.supportiveLine);

  // ---- (d) defensive: bad args -------------------------------------------
  const v_bad1 = await variance.varianceVsFrontier({});
  check('missing args → insufficient_data',
    v_bad1.band === 'insufficient_data',
    `reason=${v_bad1.reason}`);

  const v_bad2 = await variance.varianceVsFrontier({ chainSlug: slug, linkIdx: 99, axis: 'learn' });
  check('out-of-range linkIdx → insufficient_data',
    v_bad2.band === 'insufficient_data',
    `reason=${v_bad2.reason}`);

  // ---- (e) sampleN passthrough from chain.inputs.evidence ----------------
  check('sampleN reads chain.inputs.evidence',
    v_lead.sampleN === 3,
    `sampleN=${v_lead.sampleN}`);

  console.log('────────────────────────────────────────');
  const total = pass + fail;
  if (fail === 0) { console.log(G(`PASS ${pass}/${total}`)); process.exit(0); }
  else            { console.log(R(`FAIL ${fail}/${total}`)); process.exit(1); }
})().catch((err) => {
  console.error(R('uncaught:'), err && err.stack || err);
  process.exit(2);
});
