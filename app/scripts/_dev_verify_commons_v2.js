'use strict';
// HYPHA · Commons v2 push smoke — pushes Commons System ship-% to ~92.
//
// V01: lifecycle field default 'draft' on legacy pack
// V02: lifecycle schema rejects bogus state
// V03: transition draft → ratified writes pack + audit row
// V04: transition ratified → draft refused (frozen)
// V05: transition draft → deprecated allowed; deprecated terminal
// V06: ratify with supersedePriorIds demotes prior ratified to superseded
// V07: license-validator rejects missing license
// V08: license-validator rejects unapproved token
// V09: license-validator accepts approved tokens (PUBLIC_DOMAIN, CC_BY, MIT, Apache-2.0)
// V10: license-validator detects NC upstream vs CC-BY pack (conflict)
// V11: license-validator passes when upstream NC + pack NC (no conflict)
// V12: source-trust-decay applies 0.9× per 90-day window with floor
// V13: source-trust-decay override bypasses decay
// V14: source-trust-decay emits audit jsonl row on score change
// V15: export → tamper bytes → re-import detects hash mismatch (non-strict)
// V16: export → tamper bytes → re-import in strict mode aborts

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'hypha-commons-v2-'));
process.env.HYPHA_DATA = tmpVault;

const { listPacks, loadPack } = require('../lib/commons/pack-loader');
const { validatePack } = require('../lib/commons/pack-schema');
const lifecycle = require('../lib/commons/pack-lifecycle');
const validator = require('../lib/commons/license-validator');
const decay = require('../lib/commons/source-trust-decay');
const exportLib = require('../lib/commons/pack-export');
const importLib = require('../lib/commons/pack-import');

const results = [];
function record(id, label, ok, detail) {
  results.push({ id, label, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${id} ${label}${detail ? ' — ' + detail : ''}`);
}

const packsDir = path.join(tmpVault, '.commons-packs');
fs.mkdirSync(packsDir, { recursive: true });

function writePack(id, extra = {}) {
  const base = {
    id, name: 'V2 Smoke Pack ' + id, version: '1.0.0', archetype: 'MINDSET',
    license: 'MIT', author: 'tester',
    lessons: [{ topic: 'x', role: 'core' }],
    ...extra,
  };
  fs.writeFileSync(path.join(packsDir, `${id}.json`), JSON.stringify(base, null, 2));
  return base;
}

// V01: legacy pack (no lifecycle field) loads as 'draft'
(() => {
  writePack('legacy-no-lifecycle');
  const r = loadPack(tmpVault, 'legacy-no-lifecycle');
  const ok = r.ok && r.pack.lifecycle === 'draft';
  record('V01', 'legacy pack defaults lifecycle to draft on load', ok,
    ok ? '' : `got ${JSON.stringify(r).slice(0, 120)}`);
})();

// V02: schema rejects bogus lifecycle
(() => {
  const pack = {
    id: 'sch-test', name: 'Schema Test', version: '1.0', archetype: 'MINDSET',
    license: 'MIT', author: 'tester', lessons: [{ topic: 'x', role: 'core' }],
    lifecycle: 'bogus-state',
  };
  const r = validatePack(pack);
  const err = (r.errors || []).find(e => e.startsWith('lifecycle:'));
  record('V02', 'schema rejects bogus lifecycle value', !r.ok && !!err,
    !r.ok && !!err ? '' : `r.ok=${r.ok}`);
})();

// V03: transition draft → ratified
(() => {
  writePack('lc-ratify');
  const r = lifecycle.transitionPack(tmpVault, 'lc-ratify', 'ratified', { actor: 'curator', reason: 'review pass' });
  const reloaded = loadPack(tmpVault, 'lc-ratify');
  const auditAfter = lifecycle.listAuditEntries(tmpVault, 'lc-ratify');
  const ok = r.ok && reloaded.ok && reloaded.pack.lifecycle === 'ratified' &&
    reloaded.pack.ratified_at && auditAfter.entries.length === 1 &&
    auditAfter.entries[0].from === 'draft' && auditAfter.entries[0].to === 'ratified';
  record('V03', 'draft→ratified writes pack + audit row', ok,
    ok ? '' : `r=${JSON.stringify(r).slice(0, 100)} entries=${auditAfter.entries.length}`);
})();

// V04: ratified is frozen vs draft (invalid transition back)
(() => {
  const r = lifecycle.transitionPack(tmpVault, 'lc-ratify', 'draft');
  const reloaded = loadPack(tmpVault, 'lc-ratify');
  const ok = !r.ok && r.error === 'INVALID_TRANSITION' &&
    lifecycle.isFrozen(reloaded.pack);
  record('V04', 'ratified pack frozen (no transition back to draft)', ok,
    ok ? '' : `r=${JSON.stringify(r).slice(0, 120)}`);
})();

// V05: draft → deprecated; deprecated terminal
(() => {
  writePack('lc-dep');
  const r1 = lifecycle.transitionPack(tmpVault, 'lc-dep', 'deprecated');
  const r2 = lifecycle.transitionPack(tmpVault, 'lc-dep', 'ratified');
  const ok = r1.ok && r1.pack.lifecycle === 'deprecated' &&
    !r2.ok && r2.error === 'INVALID_TRANSITION';
  record('V05', 'draft→deprecated allowed; deprecated is terminal', ok,
    ok ? '' : `r1=${r1.ok} r2=${JSON.stringify(r2).slice(0, 100)}`);
})();

// V06: ratify with supersedePriorIds demotes
(() => {
  writePack('lc-old');
  lifecycle.transitionPack(tmpVault, 'lc-old', 'ratified');
  writePack('lc-new');
  const r = lifecycle.transitionPack(tmpVault, 'lc-new', 'ratified', {
    supersedePriorIds: ['lc-old'],
    actor: 'curator',
  });
  const old = loadPack(tmpVault, 'lc-old');
  const ok = r.ok && Array.isArray(r.superseded) && r.superseded.includes('lc-old') &&
    old.ok && old.pack.lifecycle === 'superseded' && old.pack.superseded_by === 'lc-new';
  record('V06', 'ratify w/ supersedePriorIds demotes prior ratified pack', ok,
    ok ? '' : `r=${JSON.stringify(r).slice(0, 120)} old=${old.pack && old.pack.lifecycle}`);
})();

// V07: license-validator rejects missing license
(() => {
  const r1 = validator.validatePackLicense({});
  const r2 = validator.validatePackLicense({ license: '' });
  const r3 = validator.validatePackLicense({ license: '   ' });
  const ok = !r1.ok && r1.error === 'LICENSE_MISSING' &&
    !r2.ok && r2.error === 'LICENSE_MISSING' &&
    !r3.ok && r3.error === 'LICENSE_MISSING';
  record('V07', 'license-validator rejects missing/empty license', ok,
    ok ? '' : `r1=${r1.error} r2=${r2.error} r3=${r3.error}`);
})();

// V08: license-validator rejects unapproved token
(() => {
  const r1 = validator.validatePackLicense({ license: 'BS-LICENSE-99' });
  const r2 = validator.validatePackLicense({ license: 'GPL-3.0' });  // approved-canonical excludes GPL by brief
  const r3 = validator.validatePackLicense({ license: 'proprietary' });
  const ok = !r1.ok && r1.error === 'LICENSE_NOT_APPROVED' &&
    !r2.ok && r2.error === 'LICENSE_NOT_APPROVED' &&
    !r3.ok && r3.error === 'LICENSE_NOT_APPROVED';
  record('V08', 'license-validator rejects unapproved tokens', ok,
    ok ? '' : `r1=${r1.error} r2=${r2.error} r3=${r3.error}`);
})();

// V09: license-validator accepts approved tokens
(() => {
  const cases = [
    ['PUBLIC_DOMAIN', 'CC0'],
    ['CC0',           'CC0'],
    ['CC_BY',         'CC-BY'],
    ['CC_BY_SA',      'CC-BY-SA'],
    ['CC_BY_NC',      'CC-BY-NC'],
    ['MIT',           'MIT'],
    ['Apache-2.0',    'Apache-2.0'],
    ['CC-BY-4.0',     'CC-BY'],          // legacy schema-style alias
    ['CC-BY-NC-4.0',  'CC-BY-NC'],       // legacy schema-style alias
  ];
  let allOk = true;
  let firstFail = null;
  for (const [raw, expected] of cases) {
    const r = validator.validatePackLicense({ license: raw });
    if (!r.ok || r.canonical !== expected) {
      allOk = false;
      firstFail = `${raw}→${JSON.stringify(r).slice(0, 80)}`;
      break;
    }
  }
  record('V09', 'license-validator accepts brief vocabulary + legacy aliases', allOk,
    allOk ? '' : firstFail);
})();

// V10: upstream NC vs pack CC-BY → conflict
(() => {
  const pack = { license: 'CC_BY' };
  const upstreams = [{ license: 'CC-BY-NC-4.0', title: 'upstream-source' }];
  const r = validator.detectUpstreamConflict(pack, upstreams);
  const ok = !r.ok && Array.isArray(r.conflicts) && r.conflicts.length === 1 &&
    /NC/i.test(r.conflicts[0].reason);
  record('V10', 'upstream NC vs pack CC-BY → conflict surfaced', ok,
    ok ? '' : `r=${JSON.stringify(r).slice(0, 140)}`);
})();

// V11: upstream NC + pack NC → no conflict
(() => {
  const pack = { license: 'CC_BY_NC' };
  const upstreams = [{ license: 'CC-BY-NC-4.0', title: 'upstream-source' }];
  const r = validator.detectUpstreamConflict(pack, upstreams);
  const ok = r.ok && r.conflicts.length === 0;
  record('V11', 'upstream NC + pack NC → no conflict', ok,
    ok ? '' : `r=${JSON.stringify(r).slice(0, 140)}`);
})();

// V12: trust decay 0.9× per window with floor
(() => {
  const now = Date.parse('2026-05-20T00:00:00Z');
  // 180 days ago = 2 windows passed → 0.81 multiplier
  const verifiedAt = new Date(now - 180 * 24 * 60 * 60 * 1000).toISOString();
  const r1 = decay.applyDecay(0.8, verifiedAt, { now });
  const expected = 0.8 * 0.81;
  const close = Math.abs(r1.trust - expected) < 1e-9;
  // 5-year-old source must hit floor (0.3 × raw)
  const ancientAt = new Date(now - 5 * 365 * 24 * 60 * 60 * 1000).toISOString();
  const r2 = decay.applyDecay(0.8, ancientAt, { now });
  const floorHit = Math.abs(r2.trust - 0.8 * 0.3) < 1e-9;
  const ok = close && r1.windowsPassed === 2 && floorHit;
  record('V12', 'decay = 0.9× per 90-day window, floor at 0.3×raw', ok,
    ok ? '' : `r1.trust=${r1.trust} r1.wp=${r1.windowsPassed} r2.trust=${r2.trust}`);
})();

// V13: override bypasses decay
(() => {
  const verifiedAt = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const r = decay.applyDecay(0.7, verifiedAt, { override: true });
  const ok = r.override === true && r.trust === 0.7 && r.decayFactor === 1;
  record('V13', 'trust_override bypasses decay', ok,
    ok ? '' : `r=${JSON.stringify(r)}`);
})();

// V14: audit emit + read roundtrip
(() => {
  decay.emitAudit(tmpVault, { pack_id: 'lc-ratify', delta: -0.1, reason: 'source decayed' });
  decay.emitAudit(tmpVault, { pack_id: 'lc-other', delta: 0.2, reason: 'reverified' });
  const a1 = decay.readAudit(tmpVault, 'lc-ratify');
  const a2 = decay.readAudit(tmpVault);
  const ok = a1.length === 1 && a1[0].pack_id === 'lc-ratify' && a1[0].reason === 'source decayed' &&
    a2.length === 2;
  record('V14', 'trust audit jsonl emit + filtered read roundtrip', ok,
    ok ? '' : `a1=${a1.length} a2=${a2.length}`);
})();

// V15 + V16: export → tamper → import (hash mismatch detection)
async function tamperTests() {
  // Seed a real slug for export
  const slug = 'v2-export-roundtrip';
  const slugRoot = path.join(tmpVault, slug);
  fs.mkdirSync(slugRoot, { recursive: true });
  fs.writeFileSync(path.join(slugRoot, 'state.json'), JSON.stringify({
    topic: 'tamper test', archetype: 'MINDSET',
  }, null, 2));
  fs.writeFileSync(path.join(slugRoot, 'agent.json'), JSON.stringify({
    persona: 'mycelium-professor', displayName: 'HYPHA',
  }, null, 2));
  fs.writeFileSync(path.join(slugRoot, 'lesson-0.md'),
    '---\ntitle: original lesson\nrole: core\n---\n\n# original lesson\n\nOriginal body bytes.\n');

  const exp = await exportLib.exportPack(slug, { description: 'tamper test', license: 'CC-BY-NC-4.0' });
  if (!exp.ok) {
    record('V15', 'export → tamper → import detects hash mismatch', false, `export failed: ${exp.error}`);
    record('V16', 'strict-mode tamper aborts import', false, 'export failed');
    return;
  }

  // Flip a byte deep in the body — the lesson-0.md body lives well after
  // the manifest + magic + first separator + header. Search for "Original"
  // and corrupt the first character.
  const packBuf = fs.readFileSync(exp.pack_path);
  const needle = Buffer.from('Original body bytes', 'utf-8');
  const idx = packBuf.indexOf(needle);
  if (idx < 0) {
    record('V15', 'export → tamper → import detects hash mismatch', false, 'tamper target byte not found in pack');
    record('V16', 'strict-mode tamper aborts import', false, 'tamper target byte not found');
    return;
  }
  packBuf[idx] = packBuf[idx] ^ 0xff;
  const tamperedPath = exp.pack_path + '.tampered';
  fs.writeFileSync(tamperedPath, packBuf);

  // Non-strict import: still completes, surfaces tampered_files
  const r15 = await importLib.importPack(tamperedPath, { targetSlug: 'v2-tampered-nonstrict' });
  const ok15 = r15.ok && r15.summary && r15.summary.tampered_files >= 1 &&
    /tampered/i.test(r15.summary.hash_verification);
  record('V15', 'tampered import (non-strict) surfaces hash mismatch in summary', ok15,
    ok15 ? `tampered=${r15.summary.tampered_files}` : `r=${JSON.stringify(r15).slice(0, 160)}`);

  // Strict import: aborts
  const r16 = await importLib.importPack(tamperedPath, { targetSlug: 'v2-tampered-strict', strict: true });
  const ok16 = !r16.ok && /strict_mode_tampered/.test(r16.error || '');
  record('V16', 'strict-mode tamper aborts import', ok16,
    ok16 ? '' : `r=${JSON.stringify(r16).slice(0, 160)}`);

  summarize();
}

function summarize() {
  const passed = results.filter(r => r.ok).length;
  const total = results.length;
  console.log(`\n${passed}/${total} PASS`);
  try { fs.rmSync(tmpVault, { recursive: true, force: true }); } catch (_) {}
  process.exit(passed === total ? 0 : 1);
}

tamperTests().catch(err => {
  console.error('tamperTests threw:', err && err.stack || err);
  try { fs.rmSync(tmpVault, { recursive: true, force: true }); } catch (_) {}
  process.exit(2);
});
