# Adaptive UX Personal Forks · Spec

> Wave 8.3 — implements BLUEPRINT §20 v3.0. Each user can fork the UX
> sub-layer (verbosity, persona, companion, cadence, language, theme tilt)
> without breaking the manuscript-register main line (cream + brass + italic
> Garamond). Manuscript invariants are constitution-locked: they are NOT
> user-tunable, and any preference attempting to flip one is rejected by
> the `register-guardrail` validator before it ever reaches the renderer.

## 1. Preference fields

| Key | Type | Default | Notes |
|---|---|---|---|
| `density` | enum `terse` / `balanced` / `verbose` | `balanced` | Verbosity of lesson body prose; render-modifier rewrites at T3_MID. |
| `persona_id` | string | `mycelium-professor` | One of the base 12 (`personas.js`) or a user fork id. |
| `companion_enabled` | bool | `true` | When false, `CompanionPresence` returns null and `companion.isEnabled()` returns false. |
| `companion_tone` | enum `alien-quiet` / `friendly` | `alien-quiet` | Never SaaS-friendly; both are sub-registers of the alien lexicon. |
| `language` | enum `zh` / `en` / `mixed` | `zh` | Adaptive render targets; canonical zh stays untouched. |
| `cadence_intensity` | enum `slow` / `normal` / `intense` | `normal` | `applyCadenceIntensity` multiplies cadence-engine day spacing (×1.5 / ×1 / ×0.66). |
| `notification_level` | enum `silent` / `minimal` / `standard` | `minimal` | `screen-lesson-chat` suppresses non-blocking banners when silent. |
| `font_size` | enum `small` / `medium` / `large` | `medium` | Tilts body font scale; never replaces the serif stack. |
| `color_temperature` | enum `warm` / `neutral` / `cool` | `warm` | Adjusts within cream/brass range, never overrides palette. |
| `spark_auto_propose` | bool | `true` | Spark engine auto-suggests on `/finish`. |
| `flywheel_publish_prompts` | bool | `true` | Surfaces Track-B publish prompts after lessons. |

## 2. Manuscript-register invariants (constitution lock)

`register-guardrail.js :: MANUSCRIPT_REGISTER_INVARIANTS` declares:

- `no_emoji_decoration` — no emoji as decoration; any pref key matching `/emoji/i` set to true is rejected.
- `no_exclamation_mark` — no exclamation marks in system output (except inside a user direct quote).
- `no_saas_vocabulary` — no progress bars, badges, streaks, levels, XP meters.
- `no_third_person` — system copy addresses 你 (peer-level), never "用户...".
- `italic_garamond_locked` — italic = decoration register; action labels stay roman; font stack fixed.
- `cream_brass_palette` — cream paper + brass hairlines + ink primary; `color_temperature` tilts within range, never replaces.

`validatePreferences(prefs)` returns `{ ok, reasons[] }`; the IPC `ux:validate`
exposes it to the UI. The "Test register guardrail" button in
`screen-ux-settings.jsx` injects a known-forbidden combination
(`emoji=true`, `badges=true`, `third_person_address=true`) and asserts
the validator rejects it — a live smoke of the guardrail.

Cross-pref combo rules:

- `cadence_intensity=intense` + `notification_level=silent` + `companion_enabled=false` is rejected as a `dead_surface` — the user would have no signal that anything changed.

## 3. Persona fork flow

`forkPersona(basePersonaId, overrides)` writes a file to
`vault/.persona-wisdom/<base>-<slugified-name>.md` (path reserved by
blueprint v0.5.1). Frontmatter carries `id`, `base`, `label`, `short`,
`domain`, `voice_clamps[]`, `forbidden[]`, `style_examples[]`,
`created_at`. Body = base persona prompt + optional `customInstructions`.

The base 12 in `app/lib/personas.js` are **never mutated**. Forks are an
overlay layer the agent loader (v0.5.1+) will consult when `persona_id`
is not one of the base 12. `listForkedPersonas()` returns fork meta;
`deleteForkedPersona(forkId)` removes a fork file (base 12 still
unreachable from this surface).

## 4. Render-time application

`render-modifier.js`:

- `applyDensity(text, density)` — terse drops trailing sentences/parens (~50% cut), balanced is identity, verbose appends anchor placeholders (mocked at T3_MID; real call deferred to wave-9 plumbing).
- `applyLanguage(text, language)` — zh/mixed identity; en mocked.
- `applyCadenceIntensity(plan, intensity)` — scales `days` and `milestones[].day` by ×1.5 (slow) / ×1 (normal) / ×0.66 (intense), without mutating input.
- `composeAllModifiers(text, prefs|slug)` — sequential density → language.

## 5. Integration points

| File | Touch | Behavior |
|---|---|---|
| `app/lib/lesson-body-generator.js` | accepts `slug` arg; success path calls `_applyAdaptive` to rewrite prose-bearing body fields | applies `density` + `language` to `thesis`, `canonical_example`, `exit_proof`, `note_connection` |
| `app/lib/cadence-engine.js` | reads `input.cadenceIntensity`; passes through `applyCadenceIntensity` on result | scales day counts when intensity ≠ `normal` |
| `app/lib/companion/index.js` | `isEnabled()` short-circuits to false when `companion_enabled=false`; new `preferredTone()` getter | preference overrides legacy `settings.companion.enabled` |
| `app/design/companion-presence.jsx` | loads `ux.loadPrefs`; returns `null` when `companion_enabled=false` | hides surface entirely |
| `app/design/screen-lesson-chat.jsx` | loads `ux.loadPrefs`; gates error banner on `notification_level !== 'silent'` | silent mode suppresses non-blocking error toast |

## 6. Relations

- **W3.5 Companion**: `companion_enabled` + `companion_tone` ride on top of
  the Companion contract YAML. Disabling does not break the contract; the
  surface is simply not rendered and `isEnabled()` returns false.
- **`personas.js` (base 12)**: read-only base. Forks are an overlay in
  `vault/.persona-wisdom/`. The agent loader (v0.5.1+) will resolve forks
  before falling back to the base 12.
- **`app/colors_and_type.css`**: locked. `color_temperature` tilts within
  the cream/brass range via CSS variable nudges; the palette itself is
  not replaceable.

## 7. IPC surface

| Channel | Args | Returns |
|---|---|---|
| `ux:loadPrefs` | `{ slug? }` | `{ ok, preferences, source }` |
| `ux:updatePref` | `{ slug?, key, value }` | `{ ok, preferences, error? }` |
| `ux:reset` | `{ slug? }` | `{ ok, preferences }` |
| `ux:forkPersona` | `{ basePersonaId, overrides }` | `{ ok, fork_id, file, base }` |
| `ux:listForks` | `{}` | `{ ok, forks }` |
| `ux:deleteFork` | `{ forkId }` | `{ ok }` |
| `ux:validate` | `{ prefs }` | `{ ok, reasons }` |
| `ux:applySafely` | `{ prefs }` | `{ ok, sanitized, error?, reasons? }` |
| `ux:applyDensity` | `{ text, density }` | `{ ok, text }` |
| `ux:applyLanguage` | `{ text, language }` | `{ ok, text }` |
| `ux:applyCadenceIntensity` | `{ plan, intensity }` | `{ ok, plan }` |

Renderer surface: `window.ptor.ux.*` mirrors every channel.

## 8. Storage

- Global: `<vault>/data/profile.json` under key `ux_preferences`.
- Per-slug override: `<vault>/<slug>/ux-prefs.json` (flat key/value).
- Resolution: defaults → global → slug override.

## 9. Out of scope (deferred to wave 9+)

- Real T3_MID rewrite calls behind `applyDensity` / `applyLanguage` (currently mocked).
- Agent loader consulting `vault/.persona-wisdom/` (file-side substrate is shipped; loader read-side is v0.5.1).
- Theme-variable injection from `color_temperature` into CSS (UI exposes the control; CSS bridge is wave-9).
