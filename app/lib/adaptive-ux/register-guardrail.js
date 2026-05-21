'use strict';

// Wave 8.3 — Manuscript register guardrail.
//
// Per BLUEPRINT §20 v3.0 + CLAUDE.md "Brand register (constitution-enforced)":
// adaptive UX preferences MUST NOT break the manuscript register main line.
// This module is the validator: every preference write goes through it, and
// any combination that would surface a forbidden form (emoji decoration,
// SaaS-y progress bars, third-person address, italic violations, etc.) is
// rejected before it can reach renderer or generator.
//
// These invariants are constitution-level — they are not user-tunable.

const { UX_PREFERENCES_SCHEMA, isValidPref, PREF_KEYS } = require('./preferences');

// ── Invariants (constitution lock) ────────────────────────────────────────

const MANUSCRIPT_REGISTER_INVARIANTS = Object.freeze({
  no_emoji_decoration: {
    description: 'No emoji as decoration. User-typed emoji in their own copy is OK; system output never injects them.',
    forbidden_keys: ['emoji', 'use_emoji', 'emoji_decoration', 'icons_emoji'],
  },
  no_exclamation_mark: {
    description: 'No exclamation marks in system output (except inside a user direct quote).',
    forbidden_keys: ['enthusiasm_marks', 'exclamation'],
  },
  no_saas_vocabulary: {
    description: 'No progress bars / badges / streaks / levels / gamification.',
    forbidden_keys: ['progress_bar', 'badges', 'streak', 'level_system', 'gamification', 'xp_meter'],
  },
  no_third_person: {
    description: 'Address the user as 你 (peer-level); never refer to "用户..." in copy.',
    forbidden_keys: ['third_person_address'],
  },
  italic_garamond_locked: {
    description: 'Italic = decoration register (titles, marginalia). Action labels must be roman. Font stack fixed.',
    forbidden_keys: ['font_family_override', 'italic_action_labels'],
  },
  cream_brass_palette: {
    description: 'Cream paper + brass hairlines + ink primary. color_temperature only tilts within range, never replaces palette.',
    forbidden_keys: ['theme_palette_override', 'accent_purple', 'accent_neon'],
  },
});

// Forbidden cross-product combinations. A pref combo that surfaces a
// register violation when rendered. Each rule is a predicate; if it returns
// a truthy reason string, the preference set is rejected with that reason.
const COMBO_RULES = [
  // emoji turned on anywhere is a hard violation.
  (prefs) => {
    for (const key of Object.keys(prefs)) {
      const lower = key.toLowerCase();
      if (lower.includes('emoji') && prefs[key]) {
        return `emoji_decoration_forbidden:${key}`;
      }
    }
    return null;
  },
  // SaaS-y keys explicitly turned on.
  (prefs) => {
    for (const inv of Object.values(MANUSCRIPT_REGISTER_INVARIANTS)) {
      for (const key of inv.forbidden_keys) {
        if (key in prefs && prefs[key]) return `forbidden_key_set:${key}`;
      }
    }
    return null;
  },
  // notification_level=standard while companion is fully disabled is allowed
  // but cadence=intense + notification=silent + companion=false produces a
  // dead surface where the user can never tell what changed.
  (prefs) => {
    if (
      prefs.cadence_intensity === 'intense' &&
      prefs.notification_level === 'silent' &&
      prefs.companion_enabled === false
    ) {
      return 'dead_surface:intense_cadence_with_silent_no_companion';
    }
    return null;
  },
  // language=en with persona='socratic' (zh-coded register) is allowed —
  // the persona rewrites itself. No rule here, just a comment for future.
];

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Validate a preference object against manuscript register invariants.
 *
 * @param {object} prefs - candidate preferences (may include keys outside the schema)
 * @returns {{ ok: boolean, reasons: string[] }}
 */
function validatePreferences(prefs) {
  const reasons = [];
  if (!prefs || typeof prefs !== 'object') {
    return { ok: false, reasons: ['prefs_not_object'] };
  }

  // 1. Schema-known keys must hold valid values.
  for (const key of PREF_KEYS) {
    if (key in prefs && !isValidPref(key, prefs[key])) {
      reasons.push(`invalid_value:${key}=${JSON.stringify(prefs[key])}`);
    }
  }

  // 2. Combo rules (cross-pref invariants).
  for (const rule of COMBO_RULES) {
    const reason = rule(prefs);
    if (reason) reasons.push(reason);
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Apply a preference set only if it passes validation. Returns the kept
 * subset (schema-known keys) on success; throws on rejection.
 *
 * @param {object} prefs
 * @returns {object} sanitized preferences
 */
function applyPreferencesSafely(prefs) {
  const verdict = validatePreferences(prefs);
  if (!verdict.ok) {
    const err = new Error(`register_guardrail_rejected: ${verdict.reasons.join(', ')}`);
    err.reasons = verdict.reasons;
    throw err;
  }
  const sanitized = {};
  for (const key of PREF_KEYS) {
    if (key in prefs) sanitized[key] = prefs[key];
  }
  return sanitized;
}

/**
 * Inspect a candidate update without raising. Useful for UI "Test register
 * guardrail" button — returns the structured verdict.
 */
function inspectUpdate(currentPrefs, key, value) {
  const candidate = { ...(currentPrefs || {}), [key]: value };
  return validatePreferences(candidate);
}

module.exports = {
  MANUSCRIPT_REGISTER_INVARIANTS,
  validatePreferences,
  applyPreferencesSafely,
  inspectUpdate,
};
