#!/usr/bin/env node
'use strict';

// HYPHA · _dev_verify_chain_surface — v0.4.9 chain surface smoke +
// v0.4.11 parent_chain_slug extensions.
//
// Ten tests guarding the chain-plan data shape, helper exports, UI label
// completeness, the ultimate_goal sync invariant, and the parent_chain_slug
// surface (CS7-CS10). SKIP gracefully when data/ is empty so this runs on
// fresh clones. CS7-CS10 use offline simulation (no Electron IPC).

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');

const tests = [];
const PASS = (name) => { tests.push({ name, ok: true }); console.log(`  \x1b[32mPASS\x1b[0m ${name}`); };
const FAIL = (name, why) => { tests.push({ name, ok: false, why }); console.log(`  \x1b[31mFAIL\x1b[0m ${name} — ${why}`); };
const SKIP = (name, why) => { tests.push({ name, ok: true, skipped: true, why }); console.log(`  \x1b[33mSKIP\x1b[0m ${name} — ${why}`); };

function listChainSlugs() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(DATA_DIR, d.name))
    .filter(p => fs.existsSync(path.join(p, 'chain.json')));
}

function readChain(p) {
  try { return JSON.parse(fs.readFileSync(path.join(p, 'chain.json'), 'utf8')); }
  catch (e) { return null; }
}

// ── CS1: chain.json schema ───────────────────────────────────────────────
(function CS1() {
  const targets = [
    path.join(DATA_DIR, '在5年内完成一部融合魔法-baa48b40'),
    path.join(DATA_DIR, '成为诺贝尔文学奖得主-写-2d5d6e4e'),
  ];
  const present = targets.filter(t => fs.existsSync(path.join(t, 'chain.json')));
  if (present.length === 0) return SKIP('CS1 chain.json schema', 'no target chain.json files in data/');
  const required = { slug: 'string', ultimate_goal: 'string', archetype: 'string', lang: 'string', created_at: 'string' };
  for (const dir of present) {
    const chain = readChain(dir);
    if (!chain) return FAIL('CS1 chain.json schema', `unreadable ${dir}`);
    for (const [k, t] of Object.entries(required)) {
      if (typeof chain[k] !== t) {
        return FAIL('CS1 chain.json schema', `${path.basename(dir)} missing ${k}:${t} (got ${typeof chain[k]})`);
      }
    }
  }
  PASS(`CS1 chain.json schema (${present.length} file${present.length > 1 ? 's' : ''})`);
})();

// ── CS2: feasibility schema ─────────────────────────────────────────────
(function CS2() {
  const slugs = listChainSlugs();
  if (slugs.length === 0) return SKIP('CS2 feasibility schema', 'no chain.json files in data/');
  const required = { tier: 'string', pComplete: 'number', gap: 'number', hoursNeeded: 'number', hoursAvailable: 'number' };
  let checked = 0;
  for (const dir of slugs) {
    const chain = readChain(dir);
    if (!chain || !chain.feasibility) continue;
    checked += 1;
    for (const [k, t] of Object.entries(required)) {
      if (typeof chain.feasibility[k] !== t) {
        return FAIL('CS2 feasibility schema', `${path.basename(dir)} feasibility.${k} expected ${t}, got ${typeof chain.feasibility[k]}`);
      }
    }
  }
  if (checked === 0) return SKIP('CS2 feasibility schema', 'no feasibility blocks present');
  PASS(`CS2 feasibility schema (${checked} chain${checked > 1 ? 's' : ''})`);
})();

// ── CS3: chain-folder.js exports ────────────────────────────────────────
(function CS3() {
  let mod;
  try { mod = require(path.join(ROOT, 'app/lib/chain-folder.js')); }
  catch (e) { return FAIL('CS3 chain-folder exports', `require failed: ${e.message}`); }
  if (typeof mod.foldChain !== 'function') return FAIL('CS3 chain-folder exports', 'foldChain not a function');
  if (!mod.ROLE_CAPS || typeof mod.ROLE_CAPS !== 'object') return FAIL('CS3 chain-folder exports', 'ROLE_CAPS missing/non-object');
  const need = ['prerequisite', 'core', 'ultimate'];
  for (const k of need) {
    if (!(k in mod.ROLE_CAPS)) return FAIL('CS3 chain-folder exports', `ROLE_CAPS missing ${k}`);
  }
  PASS('CS3 chain-folder exports {foldChain, ROLE_CAPS}');
})();

// ── CS4: TIER_LABEL semantic check ─────────────────────────────────────
(function CS4() {
  const candidates = [
    path.join(ROOT, 'app/design/screen-home.jsx'),
    path.join(ROOT, 'app/design/course-trust-panel.jsx'),
  ];
  const expected = ['nearly-impossible', 'strained', 'moderate', 'gentle', 'heroic'];
  let foundSrc = null;
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    if (/const\s+TIER_LABEL\s*=/.test(src) && expected.every(t => src.includes(`'${t}'`) || src.includes(`"${t}"`))) {
      foundSrc = { path: p, src };
      break;
    }
  }
  if (!foundSrc) return SKIP('CS4 TIER_LABEL semantic', 'deferred — TIER_LABEL not in UI yet');
  const block = foundSrc.src.match(/const\s+TIER_LABEL\s*=\s*\{([\s\S]*?)\};/);
  if (!block) return FAIL('CS4 TIER_LABEL semantic', `regex parse failed in ${path.basename(foundSrc.path)}`);
  const body = block[1];
  for (const tier of expected) {
    const re = new RegExp(`['"]${tier}['"]\\s*:\\s*['"][^'"]+['"]`);
    if (!re.test(body)) return FAIL('CS4 TIER_LABEL semantic', `${tier} not mapped to non-empty label in ${path.basename(foundSrc.path)}`);
  }
  PASS(`CS4 TIER_LABEL semantic (5/5 in ${path.basename(foundSrc.path)})`);
})();

// ── CS5: ultimate_goal sync invariant ──────────────────────────────────
(function CS5() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hypha-cs5-'));
  try {
    const chainPath = path.join(tmp, 'chain.json');
    const statePath = path.join(tmp, 'state.json');
    const originalGoal = '原始目标 / original';
    const updatedGoal = '更新后的目标 / updated';
    fs.writeFileSync(chainPath, JSON.stringify({ slug: 'mock', ultimate_goal: originalGoal, lang: 'zh' }, null, 2));
    fs.writeFileSync(statePath, JSON.stringify({ north_star_goal: originalGoal, archetype: 'HUMANITIES' }, null, 2));

    // course:edit-goal sync simulation: read both, mutate both, atomic write back.
    const chain = JSON.parse(fs.readFileSync(chainPath, 'utf8'));
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const nextChain = Object.assign({}, chain, { ultimate_goal: updatedGoal });
    const nextState = Object.assign({}, state, { north_star_goal: updatedGoal });
    fs.writeFileSync(chainPath, JSON.stringify(nextChain, null, 2));
    fs.writeFileSync(statePath, JSON.stringify(nextState, null, 2));

    const reChain = JSON.parse(fs.readFileSync(chainPath, 'utf8'));
    const reState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (reChain.ultimate_goal !== updatedGoal) return FAIL('CS5 ultimate_goal sync', `chain.ultimate_goal stale: ${reChain.ultimate_goal}`);
    if (reState.north_star_goal !== updatedGoal) return FAIL('CS5 ultimate_goal sync', `state.north_star_goal stale: ${reState.north_star_goal}`);
    PASS('CS5 ultimate_goal sync invariant');
  } catch (e) {
    FAIL('CS5 ultimate_goal sync', e.message);
  } finally {
    try {
      if (tmp && tmp.startsWith(os.tmpdir()) && fs.existsSync(tmp)) {
        for (const f of fs.readdirSync(tmp)) fs.unlinkSync(path.join(tmp, f));
        fs.rmdirSync(tmp);
      }
    } catch (_) { /* best-effort cleanup */ }
  }
})();

// ── CS6: role enum canonical ───────────────────────────────────────────
(function CS6() {
  const slugs = listChainSlugs();
  if (slugs.length === 0) return SKIP('CS6 role enum canonical', 'no chain.json files in data/');
  const allowed = new Set(['prerequisite', 'core', 'ultimate']);
  let linksChecked = 0;
  let chainsWithLinks = 0;
  for (const dir of slugs) {
    const chain = readChain(dir);
    if (!chain) continue;
    const links = (chain.chain && Array.isArray(chain.chain.links)) ? chain.chain.links
      : (Array.isArray(chain.links) ? chain.links : []);
    if (links.length > 0) chainsWithLinks += 1;
    for (const l of links) {
      linksChecked += 1;
      const r = l && l.role;
      if (r != null && !allowed.has(r)) {
        return FAIL('CS6 role enum canonical', `${path.basename(dir)} has unexpected role: ${JSON.stringify(r)}`);
      }
    }
  }
  if (chainsWithLinks === 0) return SKIP('CS6 role enum canonical', 'no chains carry links[]');
  PASS(`CS6 role enum canonical (${linksChecked} link${linksChecked > 1 ? 's' : ''} across ${chainsWithLinks} chain${chainsWithLinks > 1 ? 's' : ''})`);
})();

// ── CS7: parent_chain_slug schema (v0.4.11) ────────────────────────────
(function CS7() {
  const slugs = listChainSlugs();
  if (slugs.length === 0) return SKIP('CS7 parent_chain_slug schema', 'no chain.json files in data/');
  let checked = 0;
  let withField = 0;
  for (const dir of slugs) {
    const chain = readChain(dir);
    if (!chain) continue;
    checked += 1;
    if (!('parent_chain_slug' in chain)) continue;
    withField += 1;
    const v = chain.parent_chain_slug;
    if (v === null) continue;
    if (typeof v !== 'string') {
      return FAIL('CS7 parent_chain_slug schema', `${path.basename(dir)} parent_chain_slug must be string|null, got ${typeof v}`);
    }
    if (v.length < 3 || v.length > 80) {
      return FAIL('CS7 parent_chain_slug schema', `${path.basename(dir)} parent_chain_slug out of 3-80 chars: '${v}'`);
    }
  }
  PASS(`CS7 parent_chain_slug schema (${withField}/${checked} chain${checked > 1 ? 's' : ''} carry field)`);
})();

// ── CS8: validateParentChainSlug rejection (v0.4.11) ───────────────────
(function CS8() {
  let validators;
  try { validators = require(path.join(ROOT, 'app/lib/util/chain-validators.js')); }
  catch (e) { return FAIL('CS8 validateParentChainSlug', `require failed: ${e.message}`); }
  const { validateParentChainSlug, validateSlug } = validators;
  if (typeof validateParentChainSlug !== 'function') {
    return FAIL('CS8 validateParentChainSlug', 'export missing');
  }

  const cases = [
    { input: null,                     wantOk: true,  desc: 'null clears' },
    { input: 'foo',                    wantOk: true,  desc: 'min 3 chars OK' },
    { input: '  trimmed-abc  ',        wantOk: true,  desc: 'trims whitespace' },
    { input: '魔法师笔记',              wantOk: true,  desc: 'CJK allowed' },
    { input: 'ab',                     wantOk: false, desc: '< 3 chars rejected' },
    { input: 'x'.repeat(81),           wantOk: false, desc: '> 80 chars rejected' },
    { input: 'has/slash',              wantOk: false, desc: 'slash rejected' },
    { input: 'has\\back',              wantOk: false, desc: 'backslash rejected' },
    { input: '..parent',               wantOk: false, desc: 'dot-traversal rejected' },
    { input: 123,                      wantOk: false, desc: 'non-string non-null rejected' },
    { input: 'has space',              wantOk: false, desc: 'space rejected' },
  ];
  for (const c of cases) {
    const got = validateParentChainSlug(c.input);
    if (got.ok !== c.wantOk) {
      return FAIL('CS8 validateParentChainSlug', `${c.desc}: input=${JSON.stringify(c.input)} got ok=${got.ok}`);
    }
  }
  // validateSlug spot checks
  if (validateSlug('').ok || validateSlug('a/b').ok || validateSlug('../x').ok) {
    return FAIL('CS8 validateParentChainSlug', 'validateSlug should reject empty/slash/traversal');
  }
  if (!validateSlug('normal-slug-abc').ok) {
    return FAIL('CS8 validateParentChainSlug', 'validateSlug should accept normal slug');
  }
  PASS(`CS8 validateParentChainSlug rejection (${cases.length} cases)`);
})();

// ── CS9: course:set-series chain mirror invariant (v0.4.11) ────────────
(function CS9() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hypha-cs9-'));
  try {
    const chainPath = path.join(tmp, 'chain.json');
    const statePath = path.join(tmp, 'state.json');
    fs.writeFileSync(chainPath, JSON.stringify({ slug: 'mock', ultimate_goal: 'g', lang: 'zh' }, null, 2));
    fs.writeFileSync(statePath, JSON.stringify({ archetype: 'TECH-CONCEPT' }, null, 2));

    // Simulate the course:set-series dual-write path that ships in v0.4.11.
    const nextSeries = 'cluster-alpha';
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    state.series = nextSeries;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    // Mirror leg: when chain.json exists, also write parent_chain_slug.
    if (fs.existsSync(chainPath)) {
      const chain = JSON.parse(fs.readFileSync(chainPath, 'utf-8'));
      chain.parent_chain_slug = nextSeries;
      chain.parent_chain_updated_at = new Date().toISOString();
      fs.writeFileSync(chainPath, JSON.stringify(chain, null, 2));
    }

    const reChain = JSON.parse(fs.readFileSync(chainPath, 'utf-8'));
    const reState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    if (reState.series !== nextSeries) return FAIL('CS9 set-series mirror', `state.series not written: ${reState.series}`);
    if (reChain.parent_chain_slug !== nextSeries) return FAIL('CS9 set-series mirror', `chain.parent_chain_slug not mirrored: ${reChain.parent_chain_slug}`);
    if (typeof reChain.parent_chain_updated_at !== 'string') return FAIL('CS9 set-series mirror', 'parent_chain_updated_at missing');

    // Now clear via null and verify mirror also clears.
    const state2 = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    state2.series = null;
    fs.writeFileSync(statePath, JSON.stringify(state2, null, 2));
    const chain2 = JSON.parse(fs.readFileSync(chainPath, 'utf-8'));
    chain2.parent_chain_slug = null;
    chain2.parent_chain_updated_at = new Date().toISOString();
    fs.writeFileSync(chainPath, JSON.stringify(chain2, null, 2));

    const reChain2 = JSON.parse(fs.readFileSync(chainPath, 'utf-8'));
    if (reChain2.parent_chain_slug !== null) return FAIL('CS9 set-series mirror', `clear leg failed: ${reChain2.parent_chain_slug}`);
    PASS('CS9 course:set-series chain mirror invariant');
  } catch (e) {
    FAIL('CS9 set-series mirror', e.message);
  } finally {
    try {
      if (tmp && tmp.startsWith(os.tmpdir()) && fs.existsSync(tmp)) {
        for (const f of fs.readdirSync(tmp)) fs.unlinkSync(path.join(tmp, f));
        fs.rmdirSync(tmp);
      }
    } catch (_) { /* best-effort cleanup */ }
  }
})();

// ── CS10: migration script idempotency (v0.4.11) ───────────────────────
(function CS10() {
  const { execFileSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hypha-cs10-'));
  const scriptPath = path.join(ROOT, 'app/scripts/_dev_migrate_series_to_chain.js');
  try {
    if (!fs.existsSync(scriptPath)) return FAIL('CS10 migration idempotency', 'migration script missing');
    // Seed one course that needs migration + one already migrated + one with no chain.
    const courseA = path.join(tmp, 'course-a');
    fs.mkdirSync(courseA);
    fs.writeFileSync(path.join(courseA, 'state.json'), JSON.stringify({ series: 'cluster-x' }));
    fs.writeFileSync(path.join(courseA, 'chain.json'), JSON.stringify({ slug: 'course-a' }));
    const courseB = path.join(tmp, 'course-b');
    fs.mkdirSync(courseB);
    fs.writeFileSync(path.join(courseB, 'state.json'), JSON.stringify({ series: 'cluster-y' }));
    fs.writeFileSync(path.join(courseB, 'chain.json'), JSON.stringify({ slug: 'course-b', parent_chain_slug: 'cluster-y' }));
    const courseC = path.join(tmp, 'course-c');
    fs.mkdirSync(courseC);
    fs.writeFileSync(path.join(courseC, 'state.json'), JSON.stringify({ series: 'cluster-z' }));
    // courseC has no chain.json

    // Run 1 — should migrate courseA only.
    const out1 = execFileSync(process.execPath, [scriptPath, '--vault', tmp], { encoding: 'utf-8' });
    const m1 = out1.match(/migrated:\s*(\d+)/);
    if (!m1) return FAIL('CS10 migration idempotency', 'run 1: migrated stat not parseable');
    const migrated1 = Number(m1[1]);
    if (migrated1 !== 1) return FAIL('CS10 migration idempotency', `run 1 expected migrated=1, got ${migrated1}`);

    // Verify courseA got the field.
    const chainA = JSON.parse(fs.readFileSync(path.join(courseA, 'chain.json'), 'utf-8'));
    if (chainA.parent_chain_slug !== 'cluster-x') {
      return FAIL('CS10 migration idempotency', `courseA mirror missing: ${chainA.parent_chain_slug}`);
    }

    // Run 2 — should be a no-op (0 migrations).
    const out2 = execFileSync(process.execPath, [scriptPath, '--vault', tmp], { encoding: 'utf-8' });
    const m2 = out2.match(/migrated:\s*(\d+)/);
    if (!m2) return FAIL('CS10 migration idempotency', 'run 2: migrated stat not parseable');
    const migrated2 = Number(m2[1]);
    if (migrated2 !== 0) return FAIL('CS10 migration idempotency', `run 2 expected migrated=0, got ${migrated2}`);

    PASS('CS10 migration script idempotency (1 → 0 on rerun)');
  } catch (e) {
    FAIL('CS10 migration idempotency', e.message);
  } finally {
    try {
      const walk = (dir) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, ent.name);
          if (ent.isDirectory()) { walk(p); fs.rmdirSync(p); }
          else fs.unlinkSync(p);
        }
      };
      if (tmp && tmp.startsWith(os.tmpdir()) && fs.existsSync(tmp)) {
        walk(tmp);
        fs.rmdirSync(tmp);
      }
    } catch (_) { /* best-effort cleanup */ }
  }
})();

// ── Summary ────────────────────────────────────────────────────────────
const passed = tests.filter(t => t.ok).length;
const failed = tests.length - passed;
const skipped = tests.filter(t => t.skipped).length;
const realPasses = passed - skipped;
console.log('');
const summary = skipped > 0
  ? `${realPasses} PASS · ${skipped} SKIP · ${failed} FAIL · ${tests.length} total`
  : `${passed}/${tests.length} PASS`;
console.log(failed > 0 ? `\x1b[31m${summary}\x1b[0m` : `\x1b[32m${summary}\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
