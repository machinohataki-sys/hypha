'use strict';

// Hypha — distilled persona corpus loader (β10 reader / γ10 producer).
//
// Reads vault/.persona-wisdom/<personaId>.md and returns the structured
// content blocks plus a status flag, so agent.js can decide whether to
// overlay the distilled wisdom on top of the string-register (`personas.js`
// `prompt` field) baseline.
//
// File format (β10):
//   ---
//   persona: <id>
//   display_name: <name>
//   distilled: <YYYY-MM-DD>            (optional)
//   status: DISTILLED | DISTILLED_HUMAN_DRAFT | WAITING_DISTILL   (optional)
//   contract: <relative path>          (optional)
//   raw_corpus: <relative path>        (optional)
//   ---
//   # <heading>
//
//   <freeform body>
//
//   ## What he is, in one line
//   <prose>
//
//   ## Six load-bearing teaching moves
//   <prose / numbered list>
//
//   ## How he hedges
//   <prose>
//
// Heading set is not rigid across personas; this module captures every
// `## ` slice it finds and passes the heading-keyed map through to the
// renderer, which decides which slices to surface in the system prompt.
//
// The β10 wisdom files at vault/.persona-wisdom/ DO NOT carry a `status`
// field in their frontmatter. We treat the *presence* of the file as the
// status signal — file exists → DISTILLED. `WAITING_DISTILL` is honored
// only when the file is explicitly marked that way (placeholder for α10
// pre-distillation drafts).
//
// Resolution order for the wisdom directory:
//   1. <vault.resolveRoot()>/.persona-wisdom/        (runtime userData path)
//   2. <repo root>/vault/.persona-wisdom/             (β10 source-of-truth)
//
// API:
//   loadPersonaWisdom(personaId) → { status, ... section fields ... } | null
//
//     null  → file absent OR status = 'WAITING_DISTILL' OR parse failed
//     obj   → frontmatter + parsed sections, safe to render into a system
//             prompt overlay block.
//
// Pure / cache-free / no I/O on the hot path beyond a single readFileSync.
// Called once per designLesson invocation. If this proves measurable on a
// trace, add an in-process memo keyed by (personaId, mtime).

const fs = require('node:fs');
const path = require('node:path');

const FILE_EXT = '.md';
const SUBDIR = '.persona-wisdom';

// All section headings we care to surface to the LLM. Captured as raw text
// (no schema enforcement — different personas may use different section
// titles) and passed through to the renderer which decides how to label
// them in the system prompt overlay block.
function _parseSections(body) {
  const sections = {};
  if (typeof body !== 'string' || !body.trim()) return sections;
  // Split on H2 headings (`## ...`). Preserve the heading text as the key.
  // Note: H1 (`# `) headings are treated as the file title and are skipped
  // by this parser; the renderer relies on the H2 slices only.
  const lines = body.split(/\r?\n/);
  let currentHeading = null;
  let buf = [];
  const flush = () => {
    if (currentHeading) {
      const text = buf.join('\n').trim();
      if (text) sections[currentHeading] = text;
    }
    buf = [];
  };
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      flush();
      currentHeading = h2[1].trim();
    } else if (currentHeading) {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

function _parseFrontmatter(text) {
  // Minimal YAML-ish parser, matches vault.js _parseFrontmatter shape.
  if (typeof text !== 'string') return { fm: {}, body: '' };
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) {
      fm[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return { fm, body: m[2] || '' };
}

function _candidatePaths(personaId) {
  const candidates = [];
  // 1. Runtime data root (vault.resolveRoot()). Wrapped in try so a missing
  //    `electron` (test contexts) doesn't poison resolution.
  try {
    const vault = require('../vault');
    if (vault && typeof vault.resolveRoot === 'function') {
      const root = vault.resolveRoot();
      if (root) candidates.push(path.join(root, SUBDIR, `${personaId}${FILE_EXT}`));
    }
  } catch (_) { /* vault unavailable — skip */ }
  // 2. Repo-root vault/ (β10 source-of-truth, where the distilled markdown
  //    is committed). agent.js sits at app/agent.js → repo root is two
  //    levels up from this file (app/lib/personas/load-wisdom.js).
  try {
    const repoVault = path.resolve(__dirname, '..', '..', '..', 'vault');
    candidates.push(path.join(repoVault, SUBDIR, `${personaId}${FILE_EXT}`));
  } catch (_) { /* path resolution shouldn't fail; defensive */ }
  return candidates;
}

function loadPersonaWisdom(personaId) {
  if (!personaId || typeof personaId !== 'string') return null;
  const id = personaId.trim();
  if (!id) return null;

  const candidates = _candidatePaths(id);
  let raw = null;
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        raw = fs.readFileSync(p, 'utf8');
        break;
      }
    } catch (_) { /* try next */ }
  }
  if (raw === null) return null;

  let parsed;
  try {
    parsed = _parseFrontmatter(raw);
  } catch (_) {
    return null;
  }
  const fm = parsed.fm || {};
  // Frontmatter `status` is optional. Treat absence as DISTILLED — the file
  // exists, so distillation has occurred. WAITING_DISTILL is honored as an
  // explicit "do not inject yet" signal.
  const status = (fm.status || 'DISTILLED').toUpperCase();
  if (status === 'WAITING_DISTILL') return null;

  const sections = _parseSections(parsed.body || '');

  return {
    status,
    persona: fm.persona || id,
    display_name: fm.display_name || '',
    distilled: fm.distilled || '',
    contract: fm.contract || '',
    raw_corpus: fm.raw_corpus || '',
    sections,
  };
}

module.exports = { loadPersonaWisdom };
