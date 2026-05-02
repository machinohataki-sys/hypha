# PTOR — UI Kit

Visual recreation of the PTOR Electron app, themed to the **千金视角** brand spec. This is **not** a recreation of shipped UI — no codebase or Figma was provided. The kit interprets the brief: terminal-first, frosted glass on espresso, brass accents, restrained voice.

## What's here

`index.html` — the canonical interactive view: a PTOR session with vault sidebar, terminal (the product surface), case-file reading pane, and a quiz overlay.

## Components

| File | Exports | Notes |
|---|---|---|
| `PTorWindow.jsx` | `PTorWindow`, `PTorTrafficLights` | Espresso-themed window chrome — replaces the light macOS starter |
| `Primitives.jsx` | `GlassPanel`, `Hairline`, `Micro`, `VerdictStamp`, `ModeChip`, `Button` | The atomic surfaces & marks |
| `VaultTree.jsx` | `VaultTree` | Folder/file sidebar with active state |
| `Terminal.jsx` | `Terminal`, `TerminalLine` | The terminal pane — strong glass, mono, prompt + trace lines |
| `Panels.jsx` | `CaseFilePanel`, `QuizCard` | Reading pane for a verified note + spring-entrance quiz overlay |
| `App.jsx` | `PTorApp` | Wires everything; mock verify + quiz flow |

## Try it

- Type `verify <claim>` → terminal traces a check, lands a verdict
- Type `quiz` → opens the quiz card (spring entrance)
- Click any note in the vault → case file updates with that note's verdict + body
- Click `commit answer` or `dismiss` to close the quiz

## Caveats

- The verify/quiz logic is a fake stub — there is no LLM, no Markdown parser, no spaced-repetition queue.
- Selected files in the vault are illustrative; the real product has thousands of notes.
- This kit copies the brand spec (radii, blur, palette) but does **not** copy real PTOR components — replace when source is available.
