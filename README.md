# Hypha — Private University Operating System

> For self-directed learners breaking industrial education and knowledge monopoly.
>
> Internal codename: `ptor2`. Public brand: **Hypha**.

Hypha is the 4th agent category alongside image / code / workflow agents.

**North star** (see [BLUEPRINT.md](./BLUEPRINT.md) for full spec): a goal-locked, evidence-driven, cadence-controlled, note-revival, entropy-reducing, creation-feedback, commons-replenishing private university OS with a low-disturbance companion layer.

You input a learning intent. Hypha harvests top sources (Nobel-rich uni / GitHub / HN), synthesizes a sequential pseudo-curriculum, and runs each lesson as a Socratic dialog. Each session auto-distills into a dual-layer note: course foundation + your insights. Knowledge then flows back into your own creation pool — the things you are actually building.

**Minimum loop**: `Goal → Lesson → Evidence → Note → Feedback → Next Lesson`.

**Ideal loop**: `Goal Contract → Mode Router → Bibliography Grounding → Curriculum / Library / Commons / Research Radar → Dynamic Lesson → Live Capture → Learning Evidence → Mastery Map → Living Note Reactivation → Creation Pool → Product Spark → Pack → Commons → Better Next Lesson`.

See [ROADMAP.md](./ROADMAP.md) for the v0.1 → v3.0 evolution path.

## Run

```bash
npm install
export HYPHA_DEFAULT_GLM_KEY="your_glm_key_here"
npm start
```

Alpha builds ship with Victor's GLM 5 token baked-in. When Victor revokes the alpha token, the settings modal will prompt you to paste your own GLM / OpenAI / Anthropic key.

## Architecture

Five source files, ~170 LOC of feature code. No bundler, no React, no DB, no backend.

```
src/
  main.js       Electron main process + IPC handlers
  preload.js    contextBridge to renderer
  index.html    3-pane shell
  renderer.js   vanilla DOM event wiring
  style.css     minimal brass register
  agent.js      LLM prompts (harvest / sequence / lesson / distill / state)
  lib/
    vault.js    file-system helpers (lifted from ptor-design)
    reinforce.js Ebbinghaus decay math (lifted from legacy ptor2 corpus)

data/             ← gitignored, per-user
  notes/{topic}-{idx}.md
  curricula/{topic}/{sequence.json,state.json,sources/,sessions/}
  events.jsonl
  settings.json
```

## Forge artifact

Product passed all 4 forge phases on 2026-04-29. See `E:/victor/.claude/drive/forge/hypha-NOTE-AGENT-20260429.md`.

## License

UNLICENSED — private project.
