#!/usr/bin/env node
'use strict';
// HYPHA · v0.3 trust stack recalibration sweep tool (Phase C-6).
//
// Walks vault/<slug>/sessions/L*-*.jsonl read-only, replays each session
// through the structural side of the trust stack (paste similarity, claim
// counts, coherence violations) — pure-JS metrics, NO LLM calls. Emits a
// CSV to stdout suitable for inspection in a spreadsheet to tune thresholds:
//
//   PASTE_SIMILARITY_THRESHOLD   (scoring.js:295, currently 0.70)
//   ingratiation penalty per-turn cap (coherence-score.js:91, currently *5 in turn mode)
//   gap_pct verdict bands (lesson-quality-harness.js, post-session)
//
// Usage:
//   node app/scripts/recalibrate-trust-stack.js
//   node app/scripts/recalibrate-trust-stack.js --vault /custom/vault/path
//   HYPHA_DATA=/path/to/vault node app/scripts/recalibrate-trust-stack.js > sweep.csv
//
// Exit 0 always — diagnostic only. Empty vault prints CSV header + a hint row.
//
// Added 2026-05-08 per Phase C-6 of v0.3 architecture pivot. Complement of
// MEOW Gate B audit (which inspects this script's CSV output).

const fs = require('fs');
const path = require('path');
const { countApparentClaimsFromTranscript } = require('../lib/anti-slop/gap-detector');

const SAMPLE_TRANSCRIPT_LIMIT = 500;  // hard cap turns/session for safety
const PASTE_SIMILARITY_THRESHOLD = 0.70;  // mirror scoring.js current value

// Resolve vault path from --vault arg, HYPHA_DATA env, or default app/data.
function resolveVault() {
  const argIdx = process.argv.indexOf('--vault');
  if (argIdx >= 0 && process.argv[argIdx + 1]) return path.resolve(process.argv[argIdx + 1]);
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) return process.env.HYPHA_DATA;
  return path.resolve(__dirname, '..', '..', 'data');
}

function levenshteinRatio(a, b) {
  if (!a || !b) return 0;
  const sa = String(a).slice(0, 600);
  const sb = String(b).slice(0, 600);
  if (sa === sb) return 1;
  const m = sa.length, n = sb.length;
  if (m === 0 || n === 0) return 0;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = sa[i - 1] === sb[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  const dist = dp[m][n];
  return 1 - (dist / Math.max(m, n));
}

// Per MEOW Gate B Patch 5 (2026-05-08), claim counting now goes through the
// canonical CN-aware + tutor-role-aware countApparentClaimsFromTranscript
// from gap-detector.js. The earlier inline word>4 heuristic counted 2 claims
// for a 28-turn CN session ("yc训练营") — implausibly low because CN content
// has no whitespace and fails word-count filtering.

function readSession(absPath) {
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    return raw.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch (_) { return null; }
    }).filter(Boolean).slice(0, SAMPLE_TRANSCRIPT_LIMIT);
  } catch (_) { return []; }
}

function analyzeSession(absPath, slug, sessionFile) {
  const turns = readSession(absPath);
  const userTurns = turns.filter(t => t && t.role === 'user');
  const assistantTurns = turns.filter(t => t && t.role === 'tutor' || (t && t.role === 'assistant'));
  // Paste detection: for each user turn, max similarity to any prior assistant turn within window of 3.
  let pasteDetectedCount = 0;
  let maxSim = 0;
  let simSum = 0;
  let simSamples = 0;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (!t || t.role !== 'user') continue;
    const window = [];
    for (let j = i - 1; j >= 0 && window.length < 3; j--) {
      if (turns[j] && (turns[j].role === 'tutor' || turns[j].role === 'assistant')) {
        window.unshift(turns[j].text || '');
      }
    }
    let bestSim = 0;
    for (const prior of window) {
      const sim = levenshteinRatio(t.text || '', prior);
      if (sim > bestSim) bestSim = sim;
    }
    simSum += bestSim;
    simSamples++;
    if (bestSim > maxSim) maxSim = bestSim;
    if (bestSim >= PASTE_SIMILARITY_THRESHOLD) pasteDetectedCount++;
  }
  // Use gap-detector lib so the calibration sweep stays in lock-step with
  // the production trust-stack heuristic (Patch 4 made it CN-aware + accept
  // the 'tutor' role that real vault sessions persist).
  const totalClaims = countApparentClaimsFromTranscript(assistantTurns);
  const lessonIdx = (turns[0] && Number.isFinite(Number(turns[0].idx))) ? Number(turns[0].idx) : -1;
  return {
    slug,
    sessionFile,
    lessonIdx,
    turnCountTotal: turns.length,
    turnCountUser: userTurns.length,
    turnCountAssistant: assistantTurns.length,
    pasteDetectedCount,
    pasteSimMax: Number(maxSim.toFixed(3)),
    pasteSimMean: simSamples > 0 ? Number((simSum / simSamples).toFixed(3)) : 0,
    apparentClaims: totalClaims,
  };
}

function* walkSessions(vaultRoot) {
  if (!fs.existsSync(vaultRoot)) return;
  for (const slug of fs.readdirSync(vaultRoot)) {
    const sessionsDir = path.join(vaultRoot, slug, 'sessions');
    if (!fs.existsSync(sessionsDir) || !fs.statSync(sessionsDir).isDirectory()) continue;
    for (const file of fs.readdirSync(sessionsDir)) {
      if (!/^L\d+.*\.jsonl$/.test(file)) continue;
      yield { abs: path.join(sessionsDir, file), slug, sessionFile: file };
    }
  }
}

function main() {
  const vault = resolveVault();
  const cols = ['slug', 'sessionFile', 'lessonIdx', 'turnCountTotal', 'turnCountUser', 'turnCountAssistant', 'pasteDetectedCount', 'pasteSimMax', 'pasteSimMean', 'apparentClaims'];
  console.log(cols.join(','));
  let any = false;
  for (const { abs, slug, sessionFile } of walkSessions(vault)) {
    any = true;
    const r = analyzeSession(abs, slug, sessionFile);
    console.log(cols.map(c => JSON.stringify(r[c] !== undefined ? r[c] : '')).join(','));
  }
  if (!any) {
    process.stderr.write(`# No sessions found under ${vault}/<slug>/sessions/L*.jsonl\n`);
    process.stderr.write(`# Run a real lesson via npm start to populate, then re-run this script.\n`);
  }
  process.exit(0);
}

main();
