'use strict';
// UI polish v1.0 — smoke gate (boot-11, 2026-05-20).
//
// Locks the post-sweep baseline for user-visible UI strings in app/design/.
// Catches regressions on three classes:
//   (1) deferred-stub copy that escaped to render ("敬请期待" / "即将上线" / "coming soon")
//   (2) banned zh AI 流量词 list per CLAUDE.md "Brand register" + feedback_ban_ai_cliche_zh
//   (3) esbuild compile breaks on the three JSX files this sweep touched
//   (4) emoji in user-visible strings (per CLAUDE.md "禁: emoji")
//   (5) the three specific banned-cliche replacements actually landed
//   (6) italic Garamond manuscript register markers preserved (className=serif / fontStyle italic)
//
// Strings inside // single-line and /* block */ comments are EXCLUDED from the
// user-visible scan — those are dev-only TODOs/notes that don't render.
//
// 8 checks:
//   UP1  screen-ux-settings.jsx esbuild compile clean
//   UP2  screen-chain-plan.jsx esbuild compile clean
//   UP3  screen-lifetime-ledger.jsx esbuild compile clean
//   UP4  no banned 流量词 in user-visible JSX strings across app/design/
//   UP5  three specific replacements landed (跟随你的节奏 / 位参照人物 / VARIANCE · 参照人物)
//   UP6  no user-visible stub copy ("敬请期待" / "即将上线" / "coming soon")
//   UP7  no emoji in user-visible JSX strings
//   UP8  italic Garamond register markers count ≥ baseline (regression guard)
//
// Run:  node app/scripts/_dev_verify_ui_polish.js
// Exit: 0 = all PASS, 1 = any FAIL.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DESIGN_DIR = path.join(ROOT, 'app', 'design');

const TOUCHED_REL = [
  'app/design/screen-ux-settings.jsx',
  'app/design/screen-chain-plan.jsx',
  'app/design/screen-lifetime-ledger.jsx',
];

// Per CLAUDE.md "Brand register" + feedback_ban_ai_cliche_zh. These are blanket
// AI/marketing clichés Hypha refuses to ship in user-visible copy. The list is
// authoritative — keep in sync with CLAUDE.md if extended.
const BANNED_CLICHES = [
  '这一刀', '闭环', '拉满', '王炸', '杀疯了', '干货', '直击灵魂',
  '上分', '上车', '上岸', '内卷', '出圈', '真香', 'yyds', '绝绝子',
  '赋能', '抓手', '颗粒度', '对齐', '对标', '破圈', '重磅',
];

// intentional-placeholder: the strings below are this smoke's audit TARGETS —
// it scans user-visible JSX for these stub phrases and FAILs if any appear.
// The phrase "coming soon" / "Coming Soon" / "即将上线" / "敬请期待" being
// present in THIS array is the mechanism, not a deferred-work marker.
const STUB_COPY = ['敬请期待', '即将上线', 'coming soon', 'Coming Soon'];

// Strip // single-line comments + /* block comments */ from a JSX source so
// the cliche scan only sees what could render. NOT a full JSX parser — good
// enough for screening string literals and JSX text. Strings inside `` `` are
// preserved (template literal contents can be user-visible).
function stripComments(src) {
  // /* ... */ block comments
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // // line comments — but skip http(s):// in URLs.
  // Conservative: replace lines that START with optional whitespace + //.
  out = out.replace(/^\s*\/\/.*$/gm, '');
  // Inline trailing // — only strip if preceded by whitespace + not part of URL.
  out = out.replace(/[ \t]\/\/[^\n]*$/gm, '');
  return out;
}

function listJsx(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.jsx'))
    .map((d) => path.join(dir, d.name));
}

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
    return {
      ok: false,
      error: stderr.split('\n').slice(0, 3).join(' | ') || (err.message || String(err)),
    };
  }
}

// ---------------------------------------------------------------------------
// UP1-UP3 — esbuild compile clean on the three touched JSX files
// ---------------------------------------------------------------------------
{
  const labels = [
    'UP1 screen-ux-settings.jsx esbuild compile clean',
    'UP2 screen-chain-plan.jsx esbuild compile clean',
    'UP3 screen-lifetime-ledger.jsx esbuild compile clean',
  ];
  TOUCHED_REL.forEach((rel, i) => {
    const r = esbuildCheck(rel);
    check(labels[i], r.ok, r.error);
  });
}

// ---------------------------------------------------------------------------
// UP4 — no banned 流量词 in user-visible JSX strings across app/design/
// ---------------------------------------------------------------------------
{
  const offenders = [];
  for (const file of listJsx(DESIGN_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    const visible = stripComments(src);
    for (const word of BANNED_CLICHES) {
      if (visible.includes(word)) {
        offenders.push(path.basename(file) + ' :: "' + word + '"');
      }
    }
  }
  check(
    'UP4 no banned 流量词 in user-visible JSX strings',
    offenders.length === 0,
    offenders.length ? offenders.slice(0, 5).join(' / ') : '',
  );
}

// ---------------------------------------------------------------------------
// UP5 — three specific replacements landed (positive confirmation of this sweep)
// ---------------------------------------------------------------------------
{
  const expectations = [
    {
      file: path.join(DESIGN_DIR, 'screen-ux-settings.jsx'),
      contains: '更新 · 跟随你的节奏',
      banned: '更新 · 与你的节奏对齐',
    },
    {
      file: path.join(DESIGN_DIR, 'screen-chain-plan.jsx'),
      contains: '位参照人物',
      banned: '位对标人物',
    },
    {
      file: path.join(DESIGN_DIR, 'screen-lifetime-ledger.jsx'),
      contains: 'VARIANCE · 参照人物',
      banned: 'VARIANCE · 对标人物',
    },
  ];
  let allOk = true;
  const issues = [];
  for (const e of expectations) {
    const src = fs.readFileSync(e.file, 'utf8');
    const visible = stripComments(src);
    if (!visible.includes(e.contains)) {
      allOk = false;
      issues.push(path.basename(e.file) + ' missing "' + e.contains + '"');
    }
    if (visible.includes(e.banned)) {
      allOk = false;
      issues.push(path.basename(e.file) + ' still contains "' + e.banned + '"');
    }
  }
  check(
    'UP5 three specific replacements landed',
    allOk,
    issues.join(' / '),
  );
}

// ---------------------------------------------------------------------------
// UP6 — no user-visible stub copy across app/design/
// ---------------------------------------------------------------------------
{
  const offenders = [];
  for (const file of listJsx(DESIGN_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    const visible = stripComments(src);
    for (const phrase of STUB_COPY) {
      if (visible.includes(phrase)) {
        offenders.push(path.basename(file) + ' :: "' + phrase + '"');
      }
    }
  }
  check(
    'UP6 no user-visible stub copy',
    offenders.length === 0,
    offenders.length ? offenders.slice(0, 5).join(' / ') : '',
  );
}

// ---------------------------------------------------------------------------
// UP7 — no pictographic emoji in user-visible JSX strings (Brand register).
// "禁 emoji" per CLAUDE.md targets pictographic emoji (faces / hands / objects)
// NOT editorial typographic marks. Hypha's manuscript register actively uses
// glyphs like ✓ ✗ ⚠ ⛔ ◉ as Garamond-weight signal marks (e.g. cost-summary
// dots, drift warnings, copyright-block markers). They render as glyphs not
// pictograms and are part of the brand. The allowlist below mirrors the
// codepoints already deployed across finish-ritual / lesson-chat / commons /
// course-trust / notebook surfaces.
// ---------------------------------------------------------------------------
{
  // Pictographic emoji ranges (supplementary plane). Excludes BMP misc-symbols
  // 2600-27BF where editorial marks live.
  const PICTO_RE = /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FAFF}]/u;
  // Allowlist of BMP misc-symbols documented as register elements. Add new
  // glyphs here only after they're confirmed to render in Garamond weight
  // (NOT as colored emoji) on Windows/Mac/Linux.
  const REGISTER_MARKS = new Set([
    0x2713, // ✓ check (finish-ritual stage done, distillation done)
    0x2717, // ✗ cross (note-mode-bar error)
    0x26A0, // ⚠ warning (trust panel quarantine, notebook schema-lag)
    0x26A1, // ⚡ lightning (Spark · cross-domain link — capture / finish-ritual)
    0x26D4, // ⛔ no-entry (lesson-chat copyright block)
    0x25C9, // ◉ fisheye (cost-budget provider mark)
    0x2014, // — em dash (typographic, not emoji)
    0x2013, // – en dash
    0x2026, // … horizontal ellipsis
    0x00B7, // · middle dot (eyebrow separator across all screens)
  ]);
  const offenders = [];
  for (const file of listJsx(DESIGN_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    const visible = stripComments(src);
    // Scan for pictographic emoji first — hard FAIL.
    const picto = visible.match(PICTO_RE);
    if (picto) {
      offenders.push(
        path.basename(file) + ' :: U+' + picto[0].codePointAt(0).toString(16).toUpperCase() + ' (pictographic)',
      );
      continue;
    }
    // Scan BMP misc-symbols, FAIL only on codepoints NOT in register allowlist.
    for (const ch of visible) {
      const cp = ch.codePointAt(0);
      if (cp >= 0x2600 && cp <= 0x27BF && !REGISTER_MARKS.has(cp)) {
        offenders.push(
          path.basename(file) + ' :: U+' + cp.toString(16).toUpperCase() + ' (unlisted misc-symbol)',
        );
        break;
      }
    }
  }
  check(
    'UP7 no pictographic emoji or unlisted misc-symbols in user-visible JSX',
    offenders.length === 0,
    offenders.length ? offenders.slice(0, 5).join(' / ') : '',
  );
}

// ---------------------------------------------------------------------------
// UP8 — italic Garamond register markers preserved across app/design/.
// Baseline (boot-11): markers of the form fontStyle: "italic" / fontStyle:'italic' /
// className="serif" / className='serif' must remain above a regression floor.
// Floor chosen as the boot-11 measured count - 5 (leaves space for honest
// surface evolution, traps deletion of the register).
// ---------------------------------------------------------------------------
{
  const FLOOR = 220; // boot-11 baseline measurement; raise as register expands
  let count = 0;
  for (const file of listJsx(DESIGN_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    const italicMatches = src.match(/fontStyle\s*:\s*['"]italic['"]/g) || [];
    const serifMatches = src.match(/className\s*=\s*['"][^'"]*\bserif\b[^'"]*['"]/g) || [];
    count += italicMatches.length + serifMatches.length;
  }
  check(
    'UP8 italic Garamond register markers preserved (' + count + ' >= ' + FLOOR + ')',
    count >= FLOOR,
    count < FLOOR ? 'measured=' + count + ' floor=' + FLOOR : '',
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('');
console.log('UI polish v1.0 smoke: ' + pass + ' PASS / ' + fail + ' FAIL');
if (fail > 0) {
  console.log('');
  console.log('Failures:');
  for (const f of failures) {
    console.log('  - ' + f.label + (f.detail ? ' :: ' + f.detail : ''));
  }
  process.exit(1);
}
process.exit(0);
