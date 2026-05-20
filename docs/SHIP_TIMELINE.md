# HYPHA — 2026-05 Ship Sprint Timeline

> Plain-language log of the boot-3 through boot-10 sprint. For per-system ship-% and verifiable smoke counts, see `docs/V1_RELEASE_CHECKLIST.md`. For per-batch code anchors, see `CLAUDE.md`.

This is the narrative — what landed, when, and what was honestly still open at each handoff.

## Sprint shape

8 batches over roughly 36 hours of clock time on 2026-05-19 and 2026-05-20. Each boot inherited a CLAUDE.md snapshot of the prior state, did a fresh grep audit, shipped a focused slice, then rewrote the audit notice to keep the system table honest. Avg ship-% climbed from ~79% (boot-5 baseline) to ~84% (boot-10).

## Per-boot summary

**boot-3 (early 2026-05-19)** — chain multi-link surface + parent_chain_slug canonical schema. Replaced the `state.series` string hack with a real chain field, dual-write migration shim, and Home ULTIMATE row in Trust Panel. Gap at exit: `state.series` strings still in older vaults; one-shot migration script (`_dev_migrate_series_to_chain.js`) prepared but not auto-run.

**boot-4 (2026-05-19 mid)** — anti-slop concept ledger (cross-lesson concept extraction without LLM or vector store) + chain reroute handler + Trust Panel concept-coherence editorial row. Gap at exit: concept extraction was pure-JS heuristic; LLM-driven precision deferred to v0.5.5.

**boot-5 (2026-05-19 late)** — Track A/B exit ramp MVP. Design doc `specs/track-a-b-social-sandbox.md` (607 lines) landed alongside the `app/lib/util/track-ramps.js` validator and 3-button exit ritual in `screen-lesson-chat.jsx`. Gap at exit: URL validation harness deferred; exit ramp is contract-shaped, not URL-enforced.

**boot-6 (2026-05-20 early)** — three independent shippings folded together: auto-updater wiring, exam T4_JUDGE (`app/lib/exam-system/judge.js`), and the onboarding flow (`screen-onboarding.jsx` + `app/lib/onboarding-state.js`). Smoke count jumped from ~38 to ~46. Gap at exit: T4_JUDGE had an empty-input reroute regression (later fixed); auto-updater needed a real release to test the round-trip download.

**boot-7 (2026-05-20 mid)** — Lifetime Ledger (`app/lib/lifetime-ledger/` × 4 files + 16 IPC + 3 smokes) + Tier-Budget link (cheap-router driven cost gates wired into pricing tier). Gap at exit: Payment rails still contract-validated only; pricing engine generates the gates but no live Stripe/WeChat call ships.

**boot-8 (2026-05-20 mid-late)** — full re-audit of all 10 systems. Caught a real PJR HUMANITIES archetype gate regression at `_dev_verify_full_chain.js` step12. Captured 52 files / ~875 tests / 51 PASS / 1 FAIL as honest baseline. CLAUDE.md system table received fresh LOC + IPC counts via grep-not-memory. Gap at exit: the step12 regression, plus boot-8 still didn't have a single command to re-run every smoke at once.

**boot-9 (2026-05-20 late)** — closed boot-8 step12 PJR regression + shipped the missing pieces: dedicated Growth smoke (`_dev_verify_growth_system.js`, closing boot-8 soft-blocker #3), Evidence Ledger smoke (`_dev_verify_evidence_ledger.js`), graph-RAG smoke (`_dev_verify_graph_rag.js`), and the all-smokes aggregator (`app/scripts/_dev_run_all_smokes.js`). T2_LOCAL scaffold stub also landed (`companion-local-scaffold.js` + smoke). Gap at exit: aggregator's parallel concurrency cap collided with LLM rate limits on 4 specific smokes; surfaced as false-positive sweep failures.

**boot-10 (2026-05-20 close, this batch)** — consolidation pass, no app-code changes. Re-ran `npm run smoke:all`, identified the 4 sweep-race smokes (`creation_system` / `full_chain` / `golden_path_e2e` / `route_goal`), re-ran each standalone to confirm 56/56 PASS in isolation. CLAUDE.md system table refreshed to boot-10 verified numbers. `docs/V1_RELEASE_CHECKLIST.md` rewritten with a new §8 "v1.0 Manual Ship Procedure" 10-step runbook, boot-8 stale blockers resolved, and the sweep-runner concurrency captured as the only outstanding soft blocker. This file (`docs/SHIP_TIMELINE.md`) created as the narrative companion.

## What stayed honest across the sprint

- Every ship-% in the system table is grep-verified, not asserted. When boot-N inherits boot-(N-1)'s numbers, it re-runs `wc -l` and `grep -c` and updates if the count moved.
- Smoke files have stayed alongside the code they verify. No "trust me, it works" — every shipped slice has at least one `_dev_verify_*.js` next to it.
- Gaps are explicit at each handoff, not buried. boot-8's step12 fail was called out in the same audit notice that shipped 51 PASS.
- No marketing language. Trust comes from the file paths and smoke counts, not from the prose.

## What we deferred on purpose

- Mac signing + icon.icns generation — both are operator-action steps, not code work. The `build/README.md` covers the recipe; the team chose to ship Windows-first if needed.
- BYOK Western providers (OpenAI / Anthropic SDK direct) — `claude-cli` passthrough covers the use case in v1.0.
- T2_LOCAL real model wiring — scaffold smoke landed boot-10; model swap to Ollama Gemma 3 4B is a v0.8 slice.
- Live payment rails — contract smoke covers the envelope; live integration is post-v1.0.

## What v1.0 needs that boot-10 didn't ship

See `docs/V1_RELEASE_CHECKLIST.md` §8. Roughly: icon tooling, signing certs, CI secrets, tag push. No remaining code blockers.
