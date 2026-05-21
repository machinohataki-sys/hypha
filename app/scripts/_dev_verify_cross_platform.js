#!/usr/bin/env node
'use strict';
/**
 * _dev_verify_cross_platform.js
 *
 * Audit cross-platform footguns in HYPHA app code: hardcoded paths,
 * process.env.HOME fallbacks (empty on Windows), spawn() shell flags,
 * require() casing, .gitattributes presence, etc. Read-only — never
 * mutates files.
 *
 * Usage: node app/scripts/_dev_verify_cross_platform.js
 * Exit:  0 if all pass, 1 if any fail.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const APP_LIB = path.join(ROOT, 'app', 'lib');
const APP_MAIN = path.join(ROOT, 'app', 'main.js');
const APP_AGENT = path.join(ROOT, 'app', 'agent.js');
const SCRIPTS_DIR = path.join(ROOT, 'app', 'scripts');
const GITATTRIBUTES = path.join(ROOT, '.gitattributes');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

// Walk all .js files under a dir (skip vendor/, __tests__/, node_modules).
function walk(dir, acc) {
  acc = acc || [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/^(node_modules|vendor|__tests__|\.git)$/.test(e.name)) continue;
      walk(full, acc);
    } else if (e.isFile() && /\.js$/.test(e.name)) {
      acc.push(full);
    }
  }
  return acc;
}

const libFiles = walk(APP_LIB);

// Strip line comments + block comments + string literals (best-effort) so
// matches against violation patterns only fire on actual code, not docs.
function stripCommentsAndStrings(src) {
  let out = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1') // line comments (avoid http://)
    .replace(/'(?:\\.|[^'\\])*'/g, "''")  // single-quoted strings
    .replace(/"(?:\\.|[^"\\])*"/g, '""')  // double-quoted strings
    .replace(/`(?:\\.|[^`\\])*`/g, '``'); // template strings
  return out;
}

// --- T1: No raw `process.env.HOME` fallback without os.homedir() sibling.
//
// process.env.HOME is empty on Windows; correct pattern is os.homedir() (or
// at minimum process.env.USERPROFILE) with a platform-aware default.
{
  const offenders = [];
  for (const f of libFiles.concat([APP_MAIN, APP_AGENT])) {
    let src; try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const code = stripCommentsAndStrings(src);
    // Look for "process.env.HOME" not paired with os.homedir() in same file.
    if (/process\.env\.HOME\b/.test(code) && !/os\.homedir\s*\(/.test(src)) {
      offenders.push(path.relative(ROOT, f));
    }
  }
  // Also scan scripts dir (where backfill scripts were the actual bug).
  for (const f of walk(SCRIPTS_DIR)) {
    let src; try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const code = stripCommentsAndStrings(src);
    if (/process\.env\.HOME\b/.test(code) && !/os\.homedir\s*\(/.test(src)) {
      offenders.push(path.relative(ROOT, f));
    }
  }
  record('T1 process.env.HOME usage paired with os.homedir() fallback', offenders.length === 0,
    offenders.length ? offenders.join(', ') : 'no unpaired HOME usage');
}

// --- T2: No hardcoded user-home absolute paths in app/lib code.
//
// Patterns like '/Users/foo' (macOS), '/home/foo' (Linux), 'C:\\Users\\foo'
// (Windows) hardcode developer environment + break for end-users.
{
  const re = /(['"])(?:\/Users\/|\/home\/[a-z]|C:\\\\Users\\\\|C:\\\\\\\\Users)/i;
  const offenders = [];
  for (const f of libFiles) {
    let src; try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    // Match in raw source (path literals are inside strings).
    if (re.test(src)) offenders.push(path.relative(ROOT, f));
  }
  record('T2 no hardcoded user-home paths in app/lib', offenders.length === 0,
    offenders.length ? offenders.join(', ') : '0 occurrences');
}

// --- T3: app.getPath('userData') used; no '%APPDATA%' raw paths in main/agent.
//
// Electron's app.getPath('userData') is the canonical cross-platform user-data
// dir (Win = %APPDATA%, Mac = ~/Library/Application Support, Linux = ~/.config).
{
  let src; try { src = fs.readFileSync(APP_MAIN, 'utf8'); } catch { src = ''; }
  const usesGetPath = /app\.getPath\(\s*['"]userData['"]\s*\)/.test(src);
  // Hardcoded windows-only userData would be a sin.
  const hardcoded = /['"]%APPDATA%/.test(src) || /['"]\$\{APPDATA\}/.test(src);
  record('T3 app.getPath(userData) used in main.js (no hardcoded %APPDATA%)',
    usesGetPath && !hardcoded,
    `usesGetPath=${usesGetPath}, hardcoded=${hardcoded}`);
}

// --- T4: .gitattributes exists + declares LF default + binary asset patterns.
{
  let src = null;
  try { src = fs.readFileSync(GITATTRIBUTES, 'utf8'); } catch (_) {}
  const ok = !!src
    && /text=auto\s+eol=lf/.test(src)
    && /\*\.png\s+binary/.test(src)
    && /\*\.bat\s+text\s+eol=crlf/.test(src);
  record('T4 .gitattributes present + LF default + binary patterns', ok,
    ok ? `${src.split('\n').length} lines` : 'missing or malformed');
}

// --- T5: All spawn(...) calls in app/lib + app/main.js declare shell flag
//         explicitly when invoking non-absolute binaries (i.e., PATH lookup).
//
// On Windows, spawn('npm', ...) without shell:true fails (npm is a .cmd
// shim). Either {shell: process.platform === 'win32'} or explicit shell:true.
// Calls to absolute paths (e.g., compiled binary at known path) are exempt.
{
  const offenders = [];
  const filesToCheck = libFiles.concat([APP_MAIN, APP_AGENT]);
  for (const f of filesToCheck) {
    let src; try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    // Find spawn(<quoted binary name>, ...) — only string-literal binaries are
    // PATH-resolved and so need shell on win32. spawn(varBin, ...) where bin
    // is a known absolute path is exempt (e.g. vc-core in main.js).
    const re = /spawn\s*\(\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      // Walk forward up to 600 chars for accompanying shell flag.
      const window = src.slice(m.index, m.index + 600);
      const hasShellFlag = /shell\s*:\s*(true|process\.platform\s*===\s*['"]win32['"]|onWin)/.test(window);
      if (!hasShellFlag) {
        offenders.push(`${path.relative(ROOT, f)}: spawn('${m[1]}')`);
      }
    }
  }
  record('T5 spawn() of PATH binaries declares shell flag', offenders.length === 0,
    offenders.length ? offenders.slice(0, 3).join(' | ') : 'all spawn calls compliant');
}

// --- T6: require() statements match file casing exactly (Linux case-sensitive).
//
// Sample-test the first 200 require statements in app/lib + main.js. On
// Windows + macOS (HFS+/APFS default) require('./Foo') resolves to ./foo;
// on Linux ext4 it doesn't, breaking the build silently.
{
  const offenders = [];
  let scanned = 0;
  const filesToCheck = libFiles.slice(0, 80).concat([APP_MAIN]);
  for (const f of filesToCheck) {
    let src; try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const dir = path.dirname(f);
    const re = /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      scanned++;
      if (scanned > 200) break;
      const relReq = m[1];
      // Try resolve with .js suffix + as dir/index.js.
      const candidates = [relReq, relReq + '.js', path.join(relReq, 'index.js')];
      let resolved = null;
      for (const c of candidates) {
        const abs = path.resolve(dir, c);
        if (fs.existsSync(abs)) { resolved = abs; break; }
      }
      if (!resolved) continue; // likely conditional require or missing peer — skip
      // Compare each path segment of resolved to actual on-disk casing.
      // On case-insensitive FS, existsSync passes even if case mismatches; use
      // readdirSync to verify exact casing of the leaf.
      const parent = path.dirname(resolved);
      const leaf = path.basename(resolved);
      let actualLeaf = null;
      try {
        const entries = fs.readdirSync(parent);
        actualLeaf = entries.find(e => e.toLowerCase() === leaf.toLowerCase()) || null;
      } catch { continue; }
      if (actualLeaf && actualLeaf !== leaf) {
        offenders.push(`${path.relative(ROOT, f)}: require('${relReq}') → on-disk '${actualLeaf}'`);
      }
    }
    if (scanned > 200) break;
  }
  record('T6 require() casing matches on-disk (sampled 200)',
    offenders.length === 0,
    offenders.length ? offenders.slice(0, 3).join(' | ') : `${scanned} requires sampled, 0 mismatches`);
}

// --- T7: path.posix usage restricted to URL-style paths (EPUB hrefs, pack rel).
//
// path.posix forces forward-slash join even on Windows — correct ONLY for
// content that is platform-neutral (URLs, ZIP entries, manifest hrefs, etc.).
// Misuse on filesystem paths breaks Windows. Whitelist known-good files.
{
  const whitelist = new Set([
    'app/lib/converters/native-epub.js',     // EPUB OPF hrefs (URL-style)
    'app/lib/commons/pack-distiller.js',     // pack relPath inside .hypha-pack zip
    'app/lib/importer.js',                   // vault-relative path is URL-style, final disk-join uses path.join(vaultRoot, ...)
  ]);
  const offenders = [];
  for (const f of libFiles) {
    let src; try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const code = stripCommentsAndStrings(src);
    if (/path\.posix\b/.test(code)) {
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      if (!whitelist.has(rel)) offenders.push(rel);
    }
  }
  record('T7 path.posix usage limited to URL/zip whitelist', offenders.length === 0,
    offenders.length ? offenders.join(', ') : 'no surprise path.posix usage');
}

// --- T8: No literal backslash separator joined into filesystem paths in code.
//
// Patterns like `vault + '\\' + slug` or `dir + '\\notes\\'` hardcode Windows
// separators. Allowed: backslash inside slug-validators (`includes('\\')`),
// inside regexes, or inside string-scrub helpers (telemetry). Heuristic: flag
// only when literal '\\' appears next to a path-joining operator (+) on a
// line that also references a path-ish var (root/dir/path/file/abs).
{
  const offenders = [];
  for (const f of libFiles) {
    let src; try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      // Match `<something> + '\\' + <something>` or `'\\' + var` patterns
      // where the join is clearly building a filesystem path.
      const joinRe = /\+\s*['"]\\\\['"]\s*\+|['"]\\\\['"]\s*\+\s*[a-z]/i;
      // Exclude lines that are obviously slug-validators (`.includes(`).
      const isValidator = /\.includes\s*\(\s*['"]\\\\['"]\s*\)/.test(ln);
      // Exclude regex character class context.
      const isRegex = /\/[^\/]*\\\\[^\/]*\//.test(ln);
      const isPathish = /\b(root|dir|path|file|abs|rel|src|dst)\b/i.test(ln);
      if (joinRe.test(ln) && !isValidator && !isRegex && isPathish) {
        offenders.push(`${path.relative(ROOT, f)}:${i + 1}`);
      }
    }
  }
  record('T8 no literal "\\\\" path-joins in app/lib', offenders.length === 0,
    offenders.length ? offenders.slice(0, 3).join(' | ') : '0 literal-backslash joins');
}

// --- Summary
const passed = results.filter(r => r.ok).length;
const total = results.length;
console.log(`\n${passed}/${total} tests passed.`);
if (passed !== total) {
  console.log('\nFailed:');
  for (const r of results) if (!r.ok) console.log(`  - ${r.name}: ${r.detail}`);
  process.exit(1);
}
process.exit(0);
