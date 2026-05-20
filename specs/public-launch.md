# Public Launch — W8.1 Launch Readiness Spec

> Per BLUEPRINT.md §20 v2.4 / ROADMAP.md v2.4. W8.1 stream owns the
> pre-flight verifier; W8.2 (Flywheel) / W8.3 (Adaptive UX) / W8.4
> (Donate + Feedback) ship the specific user-facing capabilities. This
> spec documents the gate, not the capabilities themselves.

## 1 · Purpose

`launch-readiness` is the single pre-flight gate the Public Launch must
clear before HYPHA goes to a broader audience. Three layers:

1. **20-item §20 v2.4 capability checklist** — every blueprint-locked
   "必须具备" item must load and present its expected lib surface.
2. **Cross-W1→W7 integration verifier** — six dependency chains across
   waves must be wired (require() proven, IPC proven), not stubbed.
3. **§20 anti-promise scanner** — public-facing copy is scanned against
   the blueprint-locked "不承诺" list before ship.

The composition runs in three places: the `node scripts/launch-readiness.js`
CLI (CI gate), the `launch:fullReport` IPC (UI gate), and the
`screen-launch-readiness.jsx` panel (human gate).

## 2 · 20-Item Checklist (BLUEPRINT §20 v2.4 verbatim)

Order matches the blueprint sentence. Each item carries a probe that
loads its module and checks the expected exports, then upgrades the
ship-level (L → P → F) based on main.js IPC wiring and UI file presence.

| #  | id                  | blueprint § | probe module                          | ship marker                                         |
| -- | ------------------- | ----------- | ------------------------------------- | --------------------------------------------------- |
| 1  | lesson_stable       | §6.1 / §6.4 | `lesson-schema-v2.js`                 | validateLessonV2 + body IPCs + lesson UI screen     |
| 2  | goal_contract       | §3.1        | `goal-guardian.js`                    | assessGuardianState + decideIntervention + STATES   |
| 3  | mode_router         | §3.2        | `feasibility.js`                      | classifyFeasibility + proposePlans + tierFor        |
| 4  | quality_harness     | §6.4        | `lesson-quality-harness.js`           | runFullPipeline + VERDICT_THRESHOLDS                |
| 5  | jargon_firewall     | §6.2        | `jargon-firewall.js`                  | checkJargon + BANNED_EN + BANNED_ZH                 |
| 6  | learning_evidence   | §7.1        | `anti-illusion/index.js`              | detect / gate + capture finish ritual IPC           |
| 7  | mastery_map         | §7.2        | `scoring.js`                          | scoreMicroProof + score IPC                         |
| 8  | positive_feedback   | §8.3        | `positive-feedback.js`                | composePositiveFeedback + feedback:compose IPC      |
| 9  | note_core           | §9 / §10    | `web-note-engine/index.js`            | graph + capture IPCs + notebook UI                  |
| 10 | living_note         | §10.2       | `living-note/states.js`               | LIFE_STATES + transitionNoteState + dead-notes UI   |
| 11 | creation_system     | §11         | `creation-system-v1/index.js`         | runCreationSystemV1Cycle + 16 creation IPCs + UI    |
| 12 | cadence_system      | §8.1 / §8.2 | `cadence-engine.js`                   | computeCadence + CADENCE_MODES + 6 cadence IPCs     |
| 13 | companion           | §9 / §17    | `companion/index.js`                  | companionRespond + 11 companion IPCs + presence UI  |
| 14 | api_governance      | §17.1 / §17.2 | `llm/index.js`                      | executeChat + listProviders + getProviderHealth     |
| 15 | cheap_router        | §17.2       | `llm/cheap-router.js`                 | runCheapTask + TASK                                 |
| 16 | library_grounding   | §4 / §5     | `library.js`                          | listBooks + addBook + queryLibrary + library UI     |
| 17 | basic_commons       | §12         | `commons/security-layer.js`           | scanPack + sanitize + safetyLevel + commons IPCs    |
| 18 | privacy             | §17.3       | `vault.js`                            | list + read + write + vault IPCs (no telemetry)     |
| 19 | feedback_channel    | §20 v2.4    | (W8.4 owns; KPI placeholder pre-W8.4) | `feedback-channel.js` OR KPI survey fallback        |
| 20 | donate              | §20 v2.4    | (W8.4 owns; standing-red pre-W8.4)    | `donate.js`                                         |

Ship levels:
- **L** = lib-only — module loads, expected exports present, no IPC yet
- **P** = partial — at least one main.js IPC handler matches the channel pattern
- **F** = full — ≥2 main.js IPCs **and** the UI screen file exists

Overall PASS gate is `passed >= 19` (item 20 is W8.4-owned and expected
red in W8.1's slice; the coordinator merges with W8.4 once that stream
lands).

## 3 · Cross-W1→W7 Integration Chains

Six required cross-wave wires. Each is checked via static grep + (where
applicable) runtime require, never by mocking.

| #  | chain                                                          | producer module                          | consumer surface(s)                              |
| -- | -------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------- |
| 1  | W2.1 cadence-engine → W2.2 assignment-cadence                  | `cadence-engine.js`                      | `assignment.js`, `creation-system-v1/cadence-hook.js` |
| 2  | W3.3 product-transfer → W3.4 product-spark                     | `product-transfer.js`, `product-spark.js`| `creation-system-v1/{auto-transfer,spark-priority,auto-roadmap-sync}.js` |
| 3  | W4.1 scenario → W1+W2+W3 fan-in                                | `integrations/seven-day-growth.js`       | requires cadence-engine + assignment-cadence + product-transfer + product-spark |
| 4  | W5.1 cheap-router ← {W5.2/W5.3/W6.3/W7.4}                      | `llm/cheap-router.js`                    | `llm/context-packer.js`, `llm/router.js`, `research-radar/radar.js`, `cross-spark/engine.js` |
| 5  | W7.3 citation-system ← {W6.1/W3.4/W6.3/W3.5}                   | `citation-system/index.js`               | `lesson-body-generator.js`, `product-spark.js`, `research-radar/auto-actions.js`, `web-note-engine/graph.js` |
| 6  | W5.1 cheap-router → main.js IPC                                | `llm/cheap-router.js`                    | `main.js` require                               |

A chain is `ok` when the static evidence (grep hits) crosses its
threshold (3-of-4 fan-out for chains 3/4/5; 1-of-N require for chains
1/2/6).

## 4 · Anti-Promise Word List (BLUEPRINT §20 v2.4 不承诺)

| zh                    | en                          | severity |
| --------------------- | --------------------------- | -------- |
| 全学科覆盖            | every subject / all fields  | high     |
| 替代大学 / 取代大学   | replaces university         | high     |
| 全自动成才 / 完全自动 | fully automatic learning    | high     |
| 无限模型 / 永久免费   | unlimited model / unlimited tokens | high |
| 全部真题 / 真题全集   | all real exams              | high     |
| 复杂宠物 / 宠物养成   | virtual pet leveling        | high     |
| 团队项目管理          | team project management     | high     |
| zh 流量词 (干货/拉满/王炸/yyds…)    | -                           | medium   |
| sycophantic (great question! / amazing AI)  | -                | medium   |

The scanner is regex-based, locale-aware, and reports up to 5
representative matches per rule with ±16 char context snippets. Medium-
severity hits (流量词 / sycophantic) do not block launch by themselves
but are surfaced for editorial review.

## 5 · Locked v2.4 Positioning Line

> HYPHA：AI 时代的私人大学。它不是给你更多资料，而是为你的目标生成学习路径，并逼你把知识转化为能力证据和真实作品。菌类星人不是宠物，而是陪你让知识长成菌丝的异星陪读者。

This sentence is the single quotable positioning. It is mirrored at
`scripts/_launch-positioning.js` and the launch-readiness CLI scans it
on every run — drift between the spec and the constant fails the gate.

## 6 · Surfaces

### CLI

```
node scripts/launch-readiness.js              # markdown report on stdout
node scripts/launch-readiness.js --ci         # exit 1 on any FAIL
node scripts/launch-readiness.js --verbose    # show broken-chain reasons
node scripts/launch-readiness.js --json       # raw envelope
node scripts/launch-readiness.js --scan <p>   # anti-promise scan a file
```

### IPC

`launch:checklist` · `launch:verify` · `launch:antiPromise` ·
`launch:fullReport` — all read-only, all return `{ ok, ...envelope }`.

### Renderer

`window.ptor.launch.{checklist,verify,antiPromise,fullReport}` from
`app/preload.js`, consumed by `app/design/screen-launch-readiness.jsx`.

## 7 · Relationship to other W8.x streams

| stream | owns                                                                 | overlap with W8.1                                                                 |
| ------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| W8.1   | launch checklist + integration verifier + anti-promise scanner       | **this spec**                                                                     |
| W8.2   | Learning Commons Flywheel (`flywheel:*` IPCs, blueprint §20 v2.5)    | none directly; W8.2 is post-launch (v2.5)                                         |
| W8.3   | Adaptive UX Personal Forks (`ux:*` IPCs)                             | none directly; W8.3 emits register-guardrail before write — orthogonal            |
| W8.4   | Donate + Feedback Channel (and Cashflow Shield / Cost Budget)        | **owns items 19 + 20** of the checklist; W8.1 expects partial-ship until W8.4 lands |

## 8 · Relationship to W4.2 KPI Dashboard

`launch-readiness` (W8.1) and `kpi-dashboard` (W4.2) are **distinct
gates** that both feed the same release decision:

- **Launch Readiness (W8.1)** — *pre-flight*. Asks: "does the v2.4
  blueprint surface area exist as code?" Boolean gate; runs in CI; no
  user data required.
- **KPI Dashboard (W4.2)** — *post-flight*. Asks: "is the v2.4 surface
  area producing the expected user outcomes?" Operational metric;
  requires real users and event-log history; surfaces five rates
  (completion / artifact / pool conversion / companion satisfaction /
  payment willingness).

The release coordinator should clear both gates before flipping a
public-launch switch. W8.1 is necessary, not sufficient.

## 9 · Anti-Promise Discipline (binding)

Public-facing copy MUST pass `scanForOverpromises()` before publish.
This includes: donate copy, feedback-channel copy, release-note draft,
landing-page hero, Twitter thread draft, Substack post draft. The W8.4
stream MUST import `app/lib/launch-readiness/anti-promise-check` and run
it on its final copy before commit. CI gates this on the
`scripts/launch-readiness.js --ci` invocation.

## 10 · Out of Scope (W8.1)

- No live LLM calls (probe is static + module-load based)
- No vault writes, no user-data reads
- No KPI computation (W4.2 owns)
- No actual Donate / Feedback implementation (W8.4 owns)
- No CommonsPack quality validation (W8.2 / commons spec owns)
- No persona-coherence audit (P8 owns; orthogonal to launch gate)

## 11 · Future Migration (post-W8.4 merge)

When W8.4 ships `feedback-channel.js` and `donate.js`, the W8.1 probes
for items 19 + 20 will auto-upgrade to PASS without further edits —
both probes already look for the lib first and fall through to the
placeholder branch only when missing. No coordination required beyond
W8.4 landing the libs at their expected paths.
