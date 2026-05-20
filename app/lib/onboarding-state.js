'use strict';
// HYPHA · Onboarding state utilities (2026-05-20 boot-7)
//
// Two purposes — both reachable from main.js IPC handlers + the dev-verify
// smoke without spinning up Electron:
//
//   1. isFirstLaunch / markOnboarded — pure functions over vault/data/profile.json.
//      The OnboardingScreen submit handler in app.jsx now fires a profile:set
//      with onboarded_at; markOnboarded performs the same write idempotently
//      from main-process code paths (e.g. CLI bootstrap, test harness).
//
//   2. validateApiKey — pure-fn shape-only validator for BYOK. NOT a network
//      check (defer to a real ping when the user chooses to test). Catches the
//      most common day-1 mistakes (paste-mangled key, wrong provider prefix,
//      whitespace bake-in) before curriculum:create is called.
//
// Why pure functions + vault accessor injection: keeps the smoke harness
// hermetic — no Electron, no IPC, no fs side-effects unless caller passes a
// concrete vault. Mirrors `app/lib/anti-slop/concept-ledger.js` v0.4.12 style.
//
// Surface contract:
//   isFirstLaunch(vaultAccessor)      → boolean
//   loadProfile(vaultAccessor)        → profile object | null
//   markOnboarded(vaultAccessor, p)   → { ok, profile }
//   validateApiKey(provider, key)     → { ok, hint }
//   coerceSeed(payload)               → { topic, level, archetype, ... }
//
// vaultAccessor shape: { exists(rel), readJSON(rel, def), writeJSON(rel, obj), appendJSONL?(rel, row) }
// Same shape as `app/lib/vault.js`. Passing null falls back to a no-op shim
// so smoke can test the pure logic alone.

const PROFILE_REL  = 'data/profile.json';
const HISTORY_REL  = 'data/profile.history.jsonl';

// Shape-only check. Real network validation is deferred to a separate
// `byok:test` IPC the user can fire when they choose. These prefixes cover
// the providers in app/lib/providers.js + the cn-cloud trio.
const KEY_PREFIX_BY_PROVIDER = {
  claude:           ['sk-ant-'],
  openai:           ['sk-'],
  glm:              ['sk-', '.'],           // zhipuai: sometimes "<id>.<secret>"
  deepseek:         ['sk-'],
  kimi:             ['sk-'],
  'hypha-managed':  [],                     // server token, may be any shape
};

const MIN_KEY_LEN = 16;
const MAX_KEY_LEN = 512;

function _noopVault() {
  return {
    exists: () => false,
    readJSON: (_r, d) => d,
    writeJSON: () => {},
    appendJSONL: () => {},
  };
}

function _resolveVault(v) {
  if (!v || typeof v !== 'object') return _noopVault();
  return {
    exists:      typeof v.exists      === 'function' ? v.exists      : () => false,
    readJSON:    typeof v.readJSON    === 'function' ? v.readJSON    : (_r, d) => d,
    writeJSON:   typeof v.writeJSON   === 'function' ? v.writeJSON   : () => {},
    appendJSONL: typeof v.appendJSONL === 'function' ? v.appendJSONL : () => {},
  };
}

/**
 * loadProfile — read vault/data/profile.json or return null if missing/empty.
 * Pure-fn equivalent of main.js _hyphaSettings()'s profile read; does NOT
 * trigger history-restore (caller owns that recovery decision).
 */
function loadProfile(vaultAccessor) {
  const v = _resolveVault(vaultAccessor);
  if (!v.exists(PROFILE_REL)) return null;
  const cur = v.readJSON(PROFILE_REL, null);
  if (!cur || typeof cur !== 'object') return null;
  return cur;
}

/**
 * isFirstLaunch — true when profile.json does NOT exist OR exists but lacks
 * an `onboarded_at` timestamp. Empty {name, about} alone does NOT count as
 * first-launch (user may have updated identity without completing onboarding).
 * The `onboarded_at` field is the canonical signal.
 */
function isFirstLaunch(vaultAccessor) {
  const p = loadProfile(vaultAccessor);
  if (!p) return true;
  if (!p.onboarded_at) return true;
  return false;
}

/**
 * markOnboarded — idempotent. Writes `onboarded_at` (ISO 8601) + an optional
 * role tag from the onboarding payload, preserving any name/about/tutorName
 * the user already saved. Appends a row to history.jsonl for resilience.
 *
 * @param {object} vaultAccessor — see _resolveVault
 * @param {object} payload — { role?: string, north_star_goal?: string,
 *                             pedagogy_structure?: string, ... }
 * @returns {{ ok: boolean, profile: object }}
 */
function markOnboarded(vaultAccessor, payload = {}) {
  const v = _resolveVault(vaultAccessor);
  const cur = loadProfile(v) || {};
  const now = new Date().toISOString();
  const next = {
    ...cur,
    onboarded_at: cur.onboarded_at || now,            // do NOT overwrite once set
    onboarded_role:        cur.onboarded_role        || (payload && payload.role        ? String(payload.role).slice(0, 80)        : ''),
    first_goal_seed:       cur.first_goal_seed       || (payload && payload.north_star_goal ? String(payload.north_star_goal).slice(0, 280) : ''),
    first_pedagogy:        cur.first_pedagogy        || (payload && payload.pedagogy_structure ? String(payload.pedagogy_structure).slice(0, 32) : ''),
    name:      cur.name      || '',
    about:     cur.about     || '',
    tutorName: cur.tutorName || '',
    updatedAt: now,
  };
  v.writeJSON(PROFILE_REL, next);
  try {
    v.appendJSONL(HISTORY_REL, {
      ts: now,
      onboarded_at: next.onboarded_at,
      onboarded_role: next.onboarded_role,
      first_goal_seed: next.first_goal_seed,
      first_pedagogy: next.first_pedagogy,
      name: next.name,
      about: next.about,
      tutorName: next.tutorName,
    });
  } catch (_) { /* non-fatal */ }
  return { ok: true, profile: next };
}

/**
 * validateApiKey — shape-only. Returns { ok, hint }. NOT a network ping.
 * Hint is a user-facing single sentence (zh, manuscript register, no AI cliches).
 */
function validateApiKey(provider, key) {
  const prov = String(provider || '').toLowerCase();
  const k = String(key == null ? '' : key);
  if (!prov) {
    return { ok: false, hint: '未指定 provider。' };
  }
  if (prov === 'hypha-managed') {
    // Cloud token can be empty — server resolves on sign-in.
    return { ok: true, hint: '' };
  }
  if (!k) {
    return { ok: false, hint: '密钥为空。可先跳过 — 进入应用后在 Settings 内填。' };
  }
  if (k.length < MIN_KEY_LEN) {
    return { ok: false, hint: `密钥过短 (${k.length} 位) — 多半是粘贴时截断。` };
  }
  if (k.length > MAX_KEY_LEN) {
    return { ok: false, hint: '密钥过长 — 多半粘进了周围引号或额外字符。' };
  }
  if (/\s/.test(k)) {
    return { ok: false, hint: '密钥含空白字符或换行 — PowerShell `>>` 连行常见,删后重试。' };
  }
  const allowed = KEY_PREFIX_BY_PROVIDER[prov];
  if (!Array.isArray(allowed)) {
    // Unknown provider — accept but flag.
    return { ok: true, hint: '未知 provider, 已接受密钥形状。' };
  }
  if (allowed.length === 0) {
    return { ok: true, hint: '' };
  }
  const matchesPrefix = allowed.some(pfx => k.startsWith(pfx) || (pfx === '.' && k.includes('.')));
  if (!matchesPrefix) {
    return { ok: false, hint: `${prov} 密钥前缀应为 ${allowed.join(' 或 ')} — 检查是否粘错 provider。` };
  }
  return { ok: true, hint: '' };
}

/**
 * coerceSeed — pull the minimum viable seed fields out of an onboarding
 * payload so the Goal Crystallizer can pre-fill. Returns null on absurd input.
 * Pure — no I/O.
 */
function coerceSeed(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const gc = (payload.goalContract && typeof payload.goalContract === 'object') ? payload.goalContract : payload;
  const topic = String(gc.north_star_goal || '').trim();
  if (!topic) return null;
  return {
    topic,
    level:               String(gc.current_level       || '').trim() || null,
    pedagogy_structure:  String(gc.user_intent         || gc.pedagogy_structure || '').trim() || null,
    learning_model:      String(gc.learning_model      || '').trim() || 'Growth',
    deadline:            String(gc.deadline            || '').trim() || null,
    teacher_persona:     gc.teacher_persona || null,
    bookIds:             Array.isArray(payload.bookIds) ? payload.bookIds.slice() : [],
  };
}

module.exports = {
  isFirstLaunch,
  loadProfile,
  markOnboarded,
  validateApiKey,
  coerceSeed,
  // exposed for smoke
  PROFILE_REL,
  HISTORY_REL,
};
