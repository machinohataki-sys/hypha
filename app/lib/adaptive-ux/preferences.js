'use strict';

// Wave 8.3 — Adaptive UX Personal Forks · User preferences schema.
//
// Per BLUEPRINT §20 v3.0: each user can fork the UX sub-layer (density /
// persona / companion / language / cadence intensity / notifications /
// font size / color temperature / spark auto-propose / flywheel publish
// prompts) WITHOUT touching the manuscript register main line.
//
// Storage:
//   global  → <vault>/data/profile.json :: ux_preferences
//   per-slug → <vault>/<slug>/ux-prefs.json   (override layer)
//
// Resolution order (slug given): slug override -> global -> schema default.

const fs = require('node:fs');
const path = require('node:path');
const vault = require('../vault');

// ── Schema ────────────────────────────────────────────────────────────────

const UX_PREFERENCES_SCHEMA = Object.freeze({
  density: {
    type: 'enum',
    values: ['terse', 'balanced', 'verbose'],
    default: 'balanced',
    description: 'Verbosity of lesson bodies and explanations.',
  },
  persona_id: {
    type: 'string',
    default: 'mycelium-professor',
    description: 'Persona / character contract id. Base 12 + fork ids.',
  },
  companion_enabled: {
    type: 'bool',
    default: true,
    description: 'Whether the Myco Companion presence layer is active.',
  },
  companion_tone: {
    type: 'enum',
    values: ['alien-quiet', 'friendly'],
    default: 'alien-quiet',
    description: 'Tone register for the Companion (never SaaS-friendly).',
  },
  language: {
    type: 'enum',
    values: ['zh', 'en', 'mixed'],
    default: 'zh',
    description: 'Primary rendering language for adaptive output.',
  },
  cadence_intensity: {
    type: 'enum',
    values: ['slow', 'normal', 'intense'],
    default: 'normal',
    description: 'Multiplier applied to cadence-engine day spacing.',
  },
  notification_level: {
    type: 'enum',
    values: ['silent', 'minimal', 'standard'],
    default: 'minimal',
    description: 'How much in-app surfacing of state changes.',
  },
  font_size: {
    type: 'enum',
    values: ['small', 'medium', 'large'],
    default: 'medium',
    description: 'Body-prose font-size scale, never overrides serif stack.',
  },
  color_temperature: {
    type: 'enum',
    values: ['warm', 'neutral', 'cool'],
    default: 'warm',
    description: 'Tint adjustment within cream/brass register range.',
  },
  spark_auto_propose: {
    type: 'bool',
    default: true,
    description: 'Whether the spark engine auto-proposes new sparks on finish.',
  },
  flywheel_publish_prompts: {
    type: 'bool',
    default: true,
    description: 'Whether to surface Track-B publish prompts after lessons.',
  },
});

const PREF_KEYS = Object.freeze(Object.keys(UX_PREFERENCES_SCHEMA));

function defaultPreferences() {
  const out = {};
  for (const key of PREF_KEYS) out[key] = UX_PREFERENCES_SCHEMA[key].default;
  return out;
}

// ── IO helpers ────────────────────────────────────────────────────────────

function _vaultRoot() {
  try { return vault.resolveRoot(); }
  catch (_) { return path.resolve(__dirname, '..', '..', '..', 'data'); }
}

function _globalPath() {
  return path.join(_vaultRoot(), 'data', 'profile.json');
}

function _slugPath(slug) {
  if (!slug || typeof slug !== 'string') return null;
  return path.join(_vaultRoot(), slug, 'ux-prefs.json');
}

function _readJSON(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

function _writeJSON(file, obj) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

// ── Validation (light-touch; register-guardrail does the deep check) ─────

function isValidPref(key, value) {
  const spec = UX_PREFERENCES_SCHEMA[key];
  if (!spec) return false;
  if (spec.type === 'bool') return typeof value === 'boolean';
  if (spec.type === 'enum') return spec.values.includes(value);
  if (spec.type === 'string') return typeof value === 'string' && value.length > 0;
  return false;
}

function _merge(base, layer) {
  const out = { ...base };
  if (!layer || typeof layer !== 'object') return out;
  for (const key of PREF_KEYS) {
    if (layer[key] !== undefined && isValidPref(key, layer[key])) {
      out[key] = layer[key];
    }
  }
  return out;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Load resolved preferences for a slug (optional).
 * Order: defaults → global profile.ux_preferences → slug override.
 *
 * @param {string} [slug]
 * @returns {{ preferences: object, source: { global: boolean, slug: boolean } }}
 */
function loadUserPreferences(slug) {
  let prefs = defaultPreferences();
  const source = { global: false, slug: false };

  const globalDoc = _readJSON(_globalPath());
  if (globalDoc && globalDoc.ux_preferences) {
    prefs = _merge(prefs, globalDoc.ux_preferences);
    source.global = true;
  }

  if (slug) {
    const slugDoc = _readJSON(_slugPath(slug));
    if (slugDoc && typeof slugDoc === 'object') {
      prefs = _merge(prefs, slugDoc);
      source.slug = true;
    }
  }

  return { preferences: prefs, source };
}

/**
 * Update a single preference key. If slug is falsy, writes to global profile.
 *
 * @param {string|null} slug
 * @param {string} key
 * @param {*} value
 * @returns {{ ok: boolean, preferences: object, error?: string }}
 */
function updateUserPreference(slug, key, value) {
  if (!PREF_KEYS.includes(key)) {
    return { ok: false, error: `unknown_pref_key:${key}`, preferences: loadUserPreferences(slug).preferences };
  }
  if (!isValidPref(key, value)) {
    return { ok: false, error: `invalid_value_for:${key}`, preferences: loadUserPreferences(slug).preferences };
  }

  if (slug) {
    const file = _slugPath(slug);
    const current = _readJSON(file) || {};
    current[key] = value;
    _writeJSON(file, current);
  } else {
    const file = _globalPath();
    const doc = _readJSON(file) || {};
    doc.ux_preferences = doc.ux_preferences || {};
    doc.ux_preferences[key] = value;
    _writeJSON(file, doc);
  }

  return { ok: true, preferences: loadUserPreferences(slug).preferences };
}

/**
 * Reset preferences. If slug is falsy, clears the global override (returns
 * to schema defaults). If slug given, removes the per-slug override file
 * (slug falls back to global).
 *
 * @param {string|null} slug
 */
function resetToDefault(slug) {
  if (slug) {
    const file = _slugPath(slug);
    if (file && fs.existsSync(file)) {
      try { fs.unlinkSync(file); } catch (_) {}
    }
  } else {
    const file = _globalPath();
    const doc = _readJSON(file) || {};
    if (doc.ux_preferences) {
      delete doc.ux_preferences;
      _writeJSON(file, doc);
    }
  }
  return { ok: true, preferences: loadUserPreferences(slug).preferences };
}

module.exports = {
  UX_PREFERENCES_SCHEMA,
  PREF_KEYS,
  defaultPreferences,
  isValidPref,
  loadUserPreferences,
  updateUserPreference,
  resetToDefault,
};
