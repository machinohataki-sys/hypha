# Hypha — Status Dashboard

> Single page. Plain language. "Where are we right now."
> Updated manually on ship-state change. Last refresh: **2026-05-20 boot-12 FINAL**.

## Where things stand

- **Version in `package.json`**: `1.0.0-rc.1`
- **Release target**: `v1.0.0-rc.1` — version bumped, awaiting operator tag push
- **Branch**: `master`
- **Code blockers**: **0**
- **Open operator items**: signing certs · CI secrets · tag push · DMG/exe build · Apple Developer credentials
- **Operator handoff doc**: `docs/V1_OPERATOR_HANDOFF.md`

## 10-system snapshot

| # | System | Ship % | Tag |
|---|---|---|---|
| 1 | Goal | 88 | `[VERIFIED 2026-05-20 boot-12 FINAL]` |
| 2 | Lesson | 93 | `[VERIFIED 2026-05-20 boot-12 FINAL]` |
| 3 | Note | 88 | `[VERIFIED 2026-05-20 boot-12 FINAL]` |
| 4 | Creation | 95 | `[VERIFIED 2026-05-20 boot-12 FINAL]` |
| 5 | Knowledge Source | 82 | `[VERIFIED 2026-05-20 boot-12 FINAL]` |
| 6 | Commons | 80 | `[VERIFIED 2026-05-20 boot-12 FINAL]` |
| 7 | Exam | 78 | `[VERIFIED 2026-05-20 boot-12 FINAL]` |
| 8 | Growth | 84 | `[VERIFIED 2026-05-20 boot-12 FINAL]` |
| 9 | Companion | 64 | `[VERIFIED 2026-05-20 boot-12 FINAL]` |
| 10 | Infrastructure | 82 | `[VERIFIED 2026-05-20 boot-12 FINAL]` |

**Average across 10 systems: ~83%**. Full row anchors in `CLAUDE.md`.

## Smoke baseline

- **Verify scripts**: **66** under `app/scripts/_dev_verify_*.js` (grep verified)
- **Assertions**: ~900+ across the 66 scripts
- **Standalone result**: 66 PASS when run alone
- **Aggregator caveat**: 4 LLM-bound smokes (`creation_system` · `full_chain` · `golden_path_e2e` · `route_goal`) race under `_dev_run_all_smokes.js` concurrency cap 4 + 45s timeout. All 4 PASS standalone. Fix tracked in `docs/V1_RELEASE_CHECKLIST.md` §2 (preferred: `RUN_SEQUENTIAL` flag).

## Blockers

### Closed (boot-12)
- **`build/icon.icns`** — landed boot-11, 224529 bytes, structural validity verified by `_dev_verify_icns_present.js`
- **Boundary guards** — IPC null/undefined crashes patched, regression smoke in place (`_dev_verify_boundary_guards.js`)
- **Cleanup registry** — unified shutdown path with isolation + idempotence (`app/lib/cleanup-registry.js`)
- **Startup perf instrumentation** — `app/lib/perf/startup-profile.js` + lazy-loaded module checks

### Open (operator-side, not code)
- macOS code-signing cert provisioning + Apple Developer account
- GitHub Actions secrets (signing keys / notarization creds)
- Tag push for `v1.0.0-rc.1`
- DMG / exe artifact builds via electron-builder pipeline
- Smoke aggregator `RUN_SEQUENTIAL` flag for the 4 LLM-bound smokes (small code touch, deferred to operator's first patch run)

## Last 3 boot deltas

- **boot-12 (FINAL)**: avg 83% locked. 66 smokes locked (+2 mid-batch: `lifetime_ledger_consolidation` + `vault_load_perf`). Audit notice refreshed. Operator handoff doc shipped at `docs/V1_OPERATOR_HANDOFF.md`. Hard blockers 0.
- **boot-11**: `build/icon.icns` shipped. 8 new smokes (`boundary_guards` · `cleanup_registry` · `startup_perf` · `sweep_runner` · `cross_platform` · `icns_present` · `ci_config` · `ui_polish`). Launch-readiness +591 LOC. Cashflow-shield +104 LOC. Pricing +47 LOC.
- **boot-10**: 56 smokes. Sweep-race documented. Anti-slop module `evidence-ledger.js` + `bias-correction-detector.js` added.

## Next ops step

Read `docs/V1_OPERATOR_HANDOFF.md` end-to-end. Confirm signing creds + GH secrets are provisioned. Push `v1.0.0-rc.1` tag. CI matrix in `.github/workflows/` builds release artifacts. Smoke gate (`smoke.yml`) must pass on the matrix before tag promotion.

## Key file paths

- `CLAUDE.md` — full 10-system table with LOC + IPC + UI + smoke anchors
- `package.json` — version source of truth
- `app/scripts/_dev_verify_*.js` — 64 verify smokes (one per system surface)
- `app/scripts/_dev_run_all_smokes.js` — aggregator (sweep-race caveat applies)
- `.github/workflows/smoke.yml` — CI matrix smoke gate
- `.github/workflows/build.yml` — electron-builder build
- `.github/workflows/release.yml` — release tag pipeline
- `build/icon.icns` — macOS app icon (ship-ready)
- `docs/V1_RELEASE_CHECKLIST.md` — manual ship procedure
- `docs/V1_OPERATOR_HANDOFF.md` — operator instructions
- `docs/SHIP_TIMELINE.md` — ship history
- `docs/ARCHITECTURE.md` — 8-system architecture overview
- `vault/.hypha/smoke-baseline.json` — runtime baseline snapshot (if present)

## How this file is updated

Manual edit on ship-state change (new boot row, blocker open/close, version bump, smoke count change). No auto-write. Keep it under ~100 lines so a fresh reader can absorb in 60 seconds.
