'use strict';

// userProfile.js — HERMES-style file-based user profile.
//
// Per /tr council 2026-05-02 + Explore agents 1-3 synthesis: Hypha already
// has a rich personalization corpus (用户灵感 layer in lessons + atlas concept
// frequency + chain goal + golden quotes). This module compresses that corpus
// into a 4-section markdown profile that gets injected into every tutor
// system prompt as <USER_PROFILE>. No new persistence required — the vault
// IS the memory store.
//
// 4 sections (matching frontier convention from ChatGPT Memory + Claude
// CLAUDE.md + Hermes USER.md):
//   STYLE         — observed preferences (length, jargon, language)
//   GRAVITATION   — concepts user keeps returning to (atlas occurrence + 金句)
//   VOICE         — user's own phrasing patterns (extracted from 见解 corpus)
//   PROJECT       — current chain ultimate goal + lesson position
//
// File: <vault>/.hypha/user-profile.md
// Token budget: ~500-800 tokens for the formatForPrompt() output.
// Privacy: stays in vault, no telemetry, gitignorable.

const fs = require('fs');
const path = require('path');

const PROFILE_DIR = '.hypha';
const PROFILE_FILE = 'user-profile.md';
const TOKEN_BUDGET = 800; // approx 4 chars/token English, 1.5 chars/token CJK
const CHAR_BUDGET = TOKEN_BUDGET * 3; // conservative

// Section order matters — STYLE first because it's the most actionable for
// the LLM (hard rules about register/length).
const SECTIONS = ['STYLE', 'GRAVITATION', 'VOICE', 'PROJECT'];

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------
function profilePath(vaultRoot) {
  return path.join(vaultRoot, PROFILE_DIR, PROFILE_FILE);
}

function ensureProfileDir(vaultRoot) {
  const dir = path.join(vaultRoot, PROFILE_DIR);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Parser — markdown sections to structured object
// ---------------------------------------------------------------------------
// Profile.md format:
//   # User Profile (<vaultName>)
//   _last updated: <iso>_
//
//   ## STYLE
//   - line 1
//   - line 2
//
//   ## GRAVITATION
//   - line 1
//   ...
//
function parseProfile(md) {
  const sections = { STYLE: [], GRAVITATION: [], VOICE: [], PROJECT: [] };
  if (!md || typeof md !== 'string') return { sections, meta: { empty: true } };
  const lines = md.split(/\r?\n/);
  let cur = null;
  let meta = { empty: false };
  for (const line of lines) {
    const m = line.match(/^##\s+([A-Z]+)\s*$/);
    if (m && SECTIONS.includes(m[1])) { cur = m[1]; continue; }
    if (line.startsWith('_last updated:')) {
      const isoMatch = line.match(/_last updated:\s*([\d\-T:.Z+]+)_/);
      if (isoMatch) meta.lastUpdated = isoMatch[1];
      continue;
    }
    if (cur && line.startsWith('- ')) {
      sections[cur].push(line.slice(2).trim());
    }
  }
  return { sections, meta };
}

function serializeProfile(sections, vaultName) {
  const now = new Date().toISOString();
  const parts = [
    `# User Profile (${vaultName || 'vault'})`,
    `_last updated: ${now}_`,
    '',
  ];
  for (const k of SECTIONS) {
    parts.push(`## ${k}`);
    const lines = sections[k] || [];
    if (lines.length === 0) {
      parts.push('_(no signal yet)_');
    } else {
      for (const l of lines) parts.push(`- ${l}`);
    }
    parts.push('');
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// loadProfile — read profile.md, return parsed sections (or empty if absent)
// ---------------------------------------------------------------------------
function loadProfile(vaultRoot) {
  const md = readSafe(profilePath(vaultRoot));
  return parseProfile(md);
}

// ---------------------------------------------------------------------------
// formatForPrompt — render the profile as a system-prompt block.
// Returns an empty string if profile is fully empty (so the prompt has zero
// added weight when there's nothing to say). On overflow, oldest/longest
// lines are dropped.
// ---------------------------------------------------------------------------
function formatForPrompt(profile) {
  if (!profile || !profile.sections || profile.meta?.empty) return '';
  const sections = profile.sections;
  const total = SECTIONS.reduce((n, k) => n + (sections[k]?.length || 0), 0);
  if (total === 0) return '';

  const parts = [
    '═══ USER PROFILE (built from this vault\'s lesson corpus — adapt your register accordingly) ═══',
  ];
  for (const k of SECTIONS) {
    const lines = sections[k] || [];
    if (lines.length === 0) continue;
    parts.push(`${k}:`);
    for (const l of lines) parts.push(`  · ${l}`);
  }
  parts.push('══════════════════════════════════════════════════════════════════════════');
  let block = parts.join('\n');
  // Hard cap: trim oldest STYLE first if over budget
  if (block.length > CHAR_BUDGET) {
    block = block.slice(0, CHAR_BUDGET) + '\n  …(truncated)…';
  }
  return block + '\n';
}

// ---------------------------------------------------------------------------
// Cold-start derivation — read the vault's existing corpus + return a
// freshly-derived profile. NO LLM CALL — purely heuristic extraction from:
//   - 用户灵感 sections in last N lessons (VOICE seed)
//   - atlas concepts seen in ≥2 lessons (GRAVITATION)
//   - chain.json ultimate goal (PROJECT)
//   - lesson finish rate, language detection (STYLE)
// ---------------------------------------------------------------------------
function coldStartFromVault(vaultRoot, opts) {
  const o = opts || {};
  const lessonNotes = Array.isArray(o.lessonNotes) ? o.lessonNotes : [];
  const atlases = Array.isArray(o.atlases) ? o.atlases : [];
  const chains = Array.isArray(o.chains) ? o.chains : [];

  const sections = { STYLE: [], GRAVITATION: [], VOICE: [], PROJECT: [] };

  // STYLE — language + apparent reading depth from 见解 lengths
  const insights = [];
  const insightLengths = [];
  const cjkChars = { count: 0, total: 0 };
  for (const note of lessonNotes) {
    const body = note?.body || '';
    if (!body) continue;
    // extract 用户灵感 section
    const m = body.match(/##\s*用户灵感[\s\S]*?(?=\n##\s|$)/);
    if (m) {
      const slice = m[0].replace(/^##\s*用户灵感/, '').trim();
      if (slice && slice.length > 30) {
        insights.push(slice);
        insightLengths.push(slice.length);
      }
    }
    cjkChars.total += body.length;
    cjkChars.count += (body.match(/[一-鿿]/g) || []).length;
  }
  if (cjkChars.total > 0) {
    const cjkRatio = cjkChars.count / cjkChars.total;
    if (cjkRatio > 0.3) {
      sections.STYLE.push('user thinks in mixed CJK/English; respond in matching register, prefer 中文 when topic is naturally Chinese');
    }
  }
  if (insightLengths.length >= 2) {
    const avgLen = insightLengths.reduce((a, b) => a + b, 0) / insightLengths.length;
    if (avgLen > 600) {
      sections.STYLE.push('user writes long, structured 见解 — they tolerate (and reward) depth + paragraphs over short bullets');
    } else if (avgLen < 150) {
      sections.STYLE.push('user keeps 见解 brief — favor short, dense replies over long expositions');
    }
  }

  // GRAVITATION — concepts that appear across multiple atlases
  const conceptCount = new Map();
  for (const atlas of atlases) {
    const concepts = atlas?.concepts || {};
    for (const term of Object.keys(concepts)) {
      conceptCount.set(term, (conceptCount.get(term) || 0) + 1);
    }
  }
  const recurring = [...conceptCount.entries()]
    .filter(([_, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  for (const [term, n] of recurring) {
    sections.GRAVITATION.push(`"${term}" — appears in ${n} lessons; user keeps returning here, reference back when relevant`);
  }

  // VOICE — extract distinctive phrases from 见解 corpus
  // Heuristic: phrases of 3-6 chars that appear ≥2 times across distinct lessons.
  // Skip common stop phrases.
  if (insights.length >= 2) {
    const phraseCount = new Map();
    const stopWords = new Set(['这个', '那个', '一个', '一些', '什么', '怎么', '可以', '应该', '需要', '比如', '所以', '但是', '然后', '因为']);
    for (const ins of insights) {
      const ngrams = ins.match(/[一-鿿]{3,5}/g) || [];
      const seen = new Set();
      for (const ng of ngrams) {
        if (stopWords.has(ng)) continue;
        if (seen.has(ng)) continue;
        seen.add(ng);
        phraseCount.set(ng, (phraseCount.get(ng) || 0) + 1);
      }
    }
    const distinctive = [...phraseCount.entries()]
      .filter(([_, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);
    for (const [phrase, n] of distinctive) {
      sections.VOICE.push(`uses "${phrase}" as a natural connector (×${n}) — mirror the rhythm, do NOT copy the phrase literally`);
    }
  }

  // PROJECT — current chain ultimate goal
  for (const chain of chains) {
    if (chain && chain.ultimateGoal) {
      sections.PROJECT.push(`chain "${chain.slug || 'untitled'}" → ultimate goal: ${chain.ultimateGoal}`);
    }
  }

  return { sections, meta: { coldStart: true, generatedAt: new Date().toISOString() } };
}

// ---------------------------------------------------------------------------
// writeProfile — persist to disk
// ---------------------------------------------------------------------------
function writeProfile(vaultRoot, profile, vaultName) {
  ensureProfileDir(vaultRoot);
  const md = serializeProfile(profile.sections || {}, vaultName);
  fs.writeFileSync(profilePath(vaultRoot), md, 'utf8');
  return md;
}

// ---------------------------------------------------------------------------
// applyDiff — idempotent merge of structured diff onto existing profile
// Diff schema (one entry per section, all optional):
//   { STYLE: [{add: "<line text>", confidence: 0..1}],
//     GRAVITATION: [{add, confidence}],
//     VOICE: [{add, confidence}],
//     PROJECT: [{replace: "<line text>", confidence}] }
// Each entry may use add | replace | remove keys. Only auto-applies entries
// whose confidence is >= minConfidence (default 0.7); others are returned
// in `deferred` for the user-visible dashboard to ratify.
// ---------------------------------------------------------------------------
function applyDiff(profile, diff, opts) {
  const o = opts || {};
  const minConfidence = (typeof o.minConfidence === 'number') ? o.minConfidence : 0.7;
  const sections = { ...profile.sections };
  const accepted = { STYLE: 0, GRAVITATION: 0, VOICE: 0, PROJECT: 0 };
  const deferred = { STYLE: [], GRAVITATION: [], VOICE: [], PROJECT: [] };
  for (const k of SECTIONS) {
    if (!Array.isArray(diff[k])) continue;
    if (!sections[k]) sections[k] = [];
    for (const entry of diff[k]) {
      if (!entry || typeof entry !== 'object') continue;
      const conf = (typeof entry.confidence === 'number') ? entry.confidence : 1;
      if (conf < minConfidence) {
        deferred[k].push(entry);
        continue;
      }
      if (entry.add && !sections[k].includes(entry.add)) {
        sections[k].push(entry.add);
        accepted[k]++;
      } else if (entry.replace) {
        sections[k] = [entry.replace];
        accepted[k]++;
      } else if (entry.remove) {
        sections[k] = sections[k].filter(l => l !== entry.remove);
        accepted[k]++;
      }
    }
  }
  return { sections, accepted, deferred };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  loadProfile,
  formatForPrompt,
  coldStartFromVault,
  writeProfile,
  applyDiff,
  parseProfile,
  serializeProfile,
  profilePath,
  SECTIONS,
};
