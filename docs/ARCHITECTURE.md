# Architecture

> Describes the v0.11.x mainline app surface. For the v0.5-substrate methodology branch and the calibration release, see the root [`README.md`](../README.md).

Electron app. Main process owns IPC + file I/O + LLM calls. Renderer is a React UI.
Vault is a plain folder of markdown + JSON — no database server.

## Process split

```
+---------------------------+        IPC         +---------------------------+
|  Renderer (React, JSX)    |  <-------------->  |  Main (Node.js)           |
|  app/design/              |                    |  app/main.js              |
|  app/ui_kits/ptor-app/    |                    |  app/agent.js             |
|                           |                    |  app/lib/**               |
+---------------------------+                    +---------------------------+
                                                              |
                                                              v
                                                   +---------------------+
                                                   |  vault/<slug>/      |
                                                   |  markdown + jsonl   |
                                                   +---------------------+
```

Renderer never touches disk or LLM directly. Every action goes through a typed IPC name like `curriculum:create`, `lesson:body:get`, `commons:pack-export`. See `app/main.js` for the full handler list.

## Ten systems

Each system lives under `app/lib/<system>/` with its spec under `specs/<system>.md`.

| System | Code | Spec |
|---|---|---|
| Goal | `app/lib/feasibility.js` + `agent.js:designSequence` | `specs/goal-contract.md` |
| Lesson | `app/lib/hypha-learn/` + `app/lib/lesson-body-generator.js` | `specs/anti-slop-layer.md`, `specs/lesson-quality-harness.md` |
| Note | `app/lib/userProfile.js` + vault `lesson-NN.md` | `specs/living-note.md`, `specs/web-note-engine.md` |
| Creation | `app/lib/creation/` + `app/lib/creation-system-v1/` | `specs/creation-system.md` |
| Source | `app/lib/source-extractor.js` + `app/lib/library/` + `app/lib/grounding/` | `specs/bibliography-grounding.md`, `specs/library-distillation.md` |
| Commons | `app/lib/commons/` + `app/lib/commons-packs/` | `specs/commons.md`, `specs/pack-learning.md` |
| Exam | `app/lib/exam-system/` | `specs/exam-system.md`, `specs/exam-model-alpha.md` |
| Growth | `app/lib/growth/` + `app/lib/cross-spark/` | `specs/cross-spark.md`, `specs/seven-day-growth.md` |
| Companion | `app/lib/companion/` | `specs/companion-myco.md`, `specs/companion-emotion-state-layer.md` |
| Infrastructure | `app/lib/llm/` + `app/lib/cashflow-shield/` + `app/lib/feedback-channel/` | `specs/cheap-router.md`, `specs/feedback-donate-cashflow.md` |

## LLM routing

Two layers, do not mix:

- **Capability router** (`app/lib/llm/router.js`) — `executeChat('T6_STRONG' | 'T4_JUDGE' | 'T3_MID', args)` picks GLM / DeepSeek / Kimi by weighted random, retries on 5xx, marks degraded providers, ping-recovers every 5 min
- **Legacy adapter** (`app/lib/anthropic-adapter.js` + `app/lib/providers.js`) — Anthropic SDK + claude-cli passthrough, used by `app/agent.js` for lesson chat / harvest

New callers should use the capability router. `agent.js` migration is deferred.

## Vault layout

```
vault/
├── data/
│   ├── profile.json          # global user profile
│   └── settings.json         # provider keys + vault path
├── .persona-wisdom/          # distilled persona corpus
├── .commons-packs/           # seed knowledge packs
├── .hypha/staging-journal.jsonl  # 3-phase agent writeback staging
└── <topic-slug>/
    ├── state.json            # curriculum state, archetype, language
    ├── chain.json            # chain metadata + parent_chain_slug
    ├── sources.json          # chapter-shaped extracted sources
    ├── agent.json            # per-curriculum persona overrides
    ├── lesson-NN.md          # dual-layer notes
    ├── lesson-NN.body.json   # 11-field pre-generated body
    ├── events.jsonl          # atlas + agent trace events
    └── sessions/
        └── L<idx>-<ts>.jsonl # per-turn transcript + claude session_id
```

Schema versioning: each file's frontmatter or top-level `_schema` field carries a version. Migration scripts live in `app/scripts/_dev_migrate_*.js`.

## Prompts & cross-cutting layers

`app/prompts/` is plain text — `lesson-start.txt` + `lesson-turn.txt` for classic, `learn-start.txt` + `learn-turn.txt` for Hypha Learn with STAKE blocks and state markers. Constitution at `app/lib/hypha-constitution.js`.

Three layers wrap every lesson:

- Anti-Slop (`app/lib/anti-slop/`, spec `specs/anti-slop-layer.md`) — 4 detectors + Prosecutor-Judge-Rewriter loop post-stream
- Persona Coherence (`app/lib/personas/`, spec `specs/persona-coherence-layer.md`) — Character Contract + Anti-Ingratiation scrub + 3-dim score
- Cashflow Shield (`app/lib/cashflow-shield/`) — per-tier daily ceilings, 90 / 100 / 110% gates

## Where to start reading

1. `app/main.js` — IPC handler registry, the surface contract
2. `app/agent.js` — LLM call orchestration
3. `app/lib/hypha-constitution.js` — the ~600 token system prompt
4. `specs/anti-slop-layer.md` — the trust formula
