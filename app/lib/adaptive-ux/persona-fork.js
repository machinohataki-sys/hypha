'use strict';

// Wave 8.3 — Persona fork layer.
//
// Per BLUEPRINT §20 v3.0 + v0.5.1 reserved path: users may fork a base
// persona (from `personas.js`) into a custom one stored at
//   <vault>/.persona-wisdom/<custom_id>.md
//
// Forks NEVER mutate `personas.js` (read-only base of 12). They are an
// overlay layer that the agent loader can consult when persona_id is not
// one of the base 12.

const fs = require('node:fs');
const path = require('node:path');
const vault = require('../vault');
const { PERSONAS } = require('../personas');

const FORK_DIR_NAME = '.persona-wisdom';

function _forkDir() {
  let root;
  try { root = vault.resolveRoot(); }
  catch (_) { root = path.resolve(__dirname, '..', '..', '..', 'data'); }
  return path.join(root, FORK_DIR_NAME);
}

function _ensureForkDir() {
  const dir = _forkDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function _slugifyId(name) {
  return String(name || 'forked')
    .toLowerCase()
    .replace(/[^\w\-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'forked';
}

function _frontmatter(meta) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${JSON.stringify(item)}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function _baseOrThrow(basePersonaId) {
  const base = PERSONAS.find(p => p.id === basePersonaId);
  if (!base) {
    throw new Error(`unknown_base_persona:${basePersonaId}`);
  }
  return base;
}

/**
 * Fork a base persona into a user-custom persona stored in vault/.persona-wisdom/.
 *
 * @param {string} basePersonaId - id from personas.js (e.g. 'karpathy')
 * @param {object} overrides - { name?, voice_clamps?[], forbidden?[], style_examples?[], short?, customInstructions? }
 * @returns {{ ok: boolean, fork_id: string, file: string, base: string }}
 */
function forkPersona(basePersonaId, overrides = {}) {
  const base = _baseOrThrow(basePersonaId);
  const dir = _ensureForkDir();

  const name = overrides.name || `${base.label} · fork`;
  const fork_id = `${base.id}-${_slugifyId(overrides.name || `fork-${Date.now()}`)}`;
  const file = path.join(dir, `${fork_id}.md`);

  const meta = {
    id: fork_id,
    base: base.id,
    label: name,
    short: overrides.short || base.short,
    domain: base.domain,
    voice_clamps: Array.isArray(overrides.voice_clamps) ? overrides.voice_clamps : [],
    forbidden: Array.isArray(overrides.forbidden) ? overrides.forbidden : [],
    style_examples: Array.isArray(overrides.style_examples) ? overrides.style_examples : [],
    created_at: new Date().toISOString(),
  };

  const body = [
    _frontmatter(meta),
    '',
    '# Base register',
    '',
    base.prompt,
    '',
    overrides.customInstructions ? '# User overrides\n\n' + overrides.customInstructions : '',
  ].filter(Boolean).join('\n');

  fs.writeFileSync(file, body, 'utf8');
  return { ok: true, fork_id, file, base: base.id };
}

/**
 * List all user-forked personas. Returns an array of fork-meta records.
 *
 * @returns {Array<{ id, base, label, short, domain, file }>}
 */
function listForkedPersonas() {
  const dir = _forkDir();
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  const out = [];
  for (const entry of entries) {
    const file = path.join(dir, entry);
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!m) continue;
      const fm = {};
      for (const line of m[1].split(/\r?\n/)) {
        const mm = line.match(/^(\w+):\s*(.+)$/);
        if (!mm) continue;
        try { fm[mm[1]] = JSON.parse(mm[2]); }
        catch (_) { fm[mm[1]] = mm[2]; }
      }
      out.push({
        id: fm.id || path.basename(entry, '.md'),
        base: fm.base || null,
        label: fm.label || fm.id || entry,
        short: fm.short || '',
        domain: fm.domain || 'generic',
        file,
      });
    } catch (_) { /* skip malformed */ }
  }
  return out;
}

/**
 * Read a single fork's full body (useful for agent injection).
 */
function readForkedPersona(forkId) {
  const file = path.join(_forkDir(), `${forkId}.md`);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

/**
 * Delete a user fork. Base personas are untouched.
 */
function deleteForkedPersona(forkId) {
  const file = path.join(_forkDir(), `${forkId}.md`);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    return { ok: true };
  }
  return { ok: false, error: 'fork_not_found' };
}

module.exports = {
  forkPersona,
  listForkedPersonas,
  readForkedPersona,
  deleteForkedPersona,
  FORK_DIR_NAME,
};
