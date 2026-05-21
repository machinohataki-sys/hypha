'use strict';

// Wave 8.3 — Render-time preference modifiers.
//
// Per BLUEPRINT §20 v3.0: at render time, apply the user's adaptive UX
// preferences to lesson text, cadence plans, and language. The heavy work
// (LLM rewrite) is mocked here at T3_MID — wave-9 plumbing replaces the
// mocks with the real capability-class router call.

const { loadUserPreferences } = require('./preferences');

// ── density ───────────────────────────────────────────────────────────────

/**
 * Adjust verbosity of a body of text by density preference.
 *
 *   terse    → cut to ~50% (drop trailing examples, second clauses, parentheticals)
 *   balanced → no change
 *   verbose  → augment with one anchored example per major paragraph (mocked)
 *
 * @param {string} text
 * @param {'terse'|'balanced'|'verbose'} density
 * @returns {string}
 */
function applyDensity(text, density) {
  if (typeof text !== 'string' || !text) return text;
  const d = density || 'balanced';
  if (d === 'balanced') return text;

  if (d === 'terse') {
    // Split into paragraphs; keep the first sentence of each, drop the rest.
    const paragraphs = text.split(/\n{2,}/);
    const kept = paragraphs.map(p => {
      const sentences = p.split(/(?<=[.!?。！？])\s+/);
      // Keep first ~50% of sentences, at least 1.
      const keep = Math.max(1, Math.floor(sentences.length / 2));
      return sentences.slice(0, keep).join(' ').trim();
    }).filter(Boolean);
    return kept.join('\n\n');
  }

  if (d === 'verbose') {
    // Append a short, register-safe anchor line to each paragraph.
    // (mock — real impl calls T3_MID router with a rewrite prompt.)
    const paragraphs = text.split(/\n{2,}/);
    const expanded = paragraphs.map((p, i) => {
      if (!p.trim()) return p;
      return `${p}\n\n— 一个具象例 ${i + 1}：（待详化）`;
    });
    return expanded.join('\n\n');
  }

  return text;
}

// ── language ──────────────────────────────────────────────────────────────

/**
 * Adjust language register.
 *
 *   zh    → as-is (canonical zh register)
 *   en    → translate (mocked — passes through with marker)
 *   mixed → allow code-switching, light cleanup only
 *
 * @param {string} text
 * @param {'zh'|'en'|'mixed'} lang
 * @returns {string}
 */
function applyLanguage(text, lang) {
  if (typeof text !== 'string' || !text) return text;
  const l = lang || 'zh';
  if (l === 'zh' || l === 'mixed') return text;
  if (l === 'en') {
    // Mock: prefix with marker — real impl calls T3_MID translate.
    return `[en-render pending T3_MID] ${text}`;
  }
  return text;
}

// ── cadence intensity ─────────────────────────────────────────────────────

/**
 * Adjust a cadence-engine output's day-spacing by intensity preference.
 *
 *   slow    → multiply day counts by 1.5
 *   normal  → no change
 *   intense → multiply day counts by 0.66 (faster cadence)
 *
 * @param {object} plan - cadence-engine output { days, milestones, ... }
 * @param {'slow'|'normal'|'intense'} intensity
 * @returns {object} new plan (does not mutate input)
 */
function applyCadenceIntensity(plan, intensity) {
  if (!plan || typeof plan !== 'object') return plan;
  const i = intensity || 'normal';
  if (i === 'normal') return plan;
  const factor = i === 'slow' ? 1.5 : (i === 'intense' ? 0.66 : 1.0);
  const next = { ...plan };
  if (typeof plan.days === 'number') {
    next.days = Math.max(1, Math.round(plan.days * factor));
  }
  if (Array.isArray(plan.milestones)) {
    next.milestones = plan.milestones.map(m =>
      m && typeof m === 'object' && typeof m.day === 'number'
        ? { ...m, day: Math.max(1, Math.round(m.day * factor)) }
        : m
    );
  }
  next._intensity_applied = i;
  next._intensity_factor = factor;
  return next;
}

// ── compose all ───────────────────────────────────────────────────────────

/**
 * Apply every relevant text-side modifier in order. Numeric / plan-side
 * modifiers (cadence) must be applied by their own callers since they need
 * a different input shape.
 *
 * @param {string} text
 * @param {object} prefs - either a full preferences object or a slug to look up
 * @returns {string}
 */
function composeAllModifiers(text, prefs) {
  let effective = prefs;
  if (!prefs || typeof prefs !== 'object') {
    effective = loadUserPreferences().preferences;
  } else if (typeof prefs === 'string') {
    effective = loadUserPreferences(prefs).preferences;
  }
  let out = text;
  out = applyDensity(out, effective.density);
  out = applyLanguage(out, effective.language);
  return out;
}

module.exports = {
  applyDensity,
  applyLanguage,
  applyCadenceIntensity,
  composeAllModifiers,
};
