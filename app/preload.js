'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('windowControls', {
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  close: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onMaximizeChange: (cb) => {
    const handler = (_e, isMax) => cb(isMax);
    ipcRenderer.on('window:maximizeChanged', handler);
    return () => ipcRenderer.removeListener('window:maximizeChanged', handler);
  },
});

// vc — terminal bridge mirrors production ptor/app/preload.js exactly.
// Renderer module (lib/vc-renderer.js) reads window.vc — keep this surface stable.
// ClientMsg tags: text | paste | key | resize | scroll | scroll_top | scroll_bottom
//                 | redraw | viewport_lock | mouse  (see vc/core/src/main.rs)
// CoreMsg tags:   ready | grid_diff | cursor | alt_screen | title | exit | warning
contextBridge.exposeInMainWorld('vc', {
  send: (msg) => ipcRenderer.invoke('vc:send', msg),
  onMessage: (cb) => {
    const listener = (_e, msg) => cb(msg);
    ipcRenderer.on('vc:msg', listener);
    return () => ipcRenderer.removeListener('vc:msg', listener);
  },
  onFatal: (cb) => {
    const listener = (_e, msg) => cb(msg);
    ipcRenderer.on('vc:fatal', listener);
    return () => ipcRenderer.removeListener('vc:fatal', listener);
  },
});

contextBridge.exposeInMainWorld('ptor', {
  vault: {
    list:  ()         => ipcRenderer.invoke('vault:list'),
    read:  (rel)      => ipcRenderer.invoke('vault:read', rel),
    write: (rel, body)=> ipcRenderer.invoke('vault:write', rel, body),
    root:  ()         => ipcRenderer.invoke('vault:root'),
    // CRUD — destructive ops (delete) require UI-side confirmation.
    del:    (rel)            => ipcRenderer.invoke('vault:delete', rel),
    rename: (oldRel, newRel) => ipcRenderer.invoke('vault:rename', oldRel, newRel),
    mkdir:  (rel)            => ipcRenderer.invoke('vault:mkdir', rel),
    // backlinks(rel) → [{ rel, label, excerpt }, ...]. Notes containing
    // [[wikilink]] referencing the target. Per user 2026-04-29 "Obsidian
    // 灵魂": bidirectional links are the substrate of compounding vault.
    backlinks: (rel)         => ipcRenderer.invoke('vault:backlinks', rel),
    // Import (Bear / Obsidian / Notion-export → vault)
    pickFolder:    ()                          => ipcRenderer.invoke('vault:pick-folder'),
    importScan:    (sourcePath)                => ipcRenderer.invoke('vault:import-scan', sourcePath),
    importRun:     (sourcePath, subdir, sessionId) => ipcRenderer.invoke('vault:import-run', { sourcePath, subdir, sessionId }),
    importCancel:  (sessionId)                 => ipcRenderer.invoke('vault:import-cancel', sessionId),
    onImportProgress: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('vault:import-progress', handler);
      return () => ipcRenderer.removeListener('vault:import-progress', handler);
    },
  },
  corpus: {
    // strengths() returns { 'folder/file.md': 0.873, ... } for ranking RecallDashboard.
    // Empty object on backend failure (corpus is optional).
    strengths: () => ipcRenderer.invoke('corpus:strengths'),
    // meta(rel) → { strength, citeCount, recallCount, lastCiteTs } | null
    // Per-note signals for the footer chip. Null on backend failure.
    meta: (rel) => ipcRenderer.invoke('corpus:meta', rel),
    // similar(rel, k=3) → [{ rel, score }, ...] co-citation top-k from
    // event-log. Empty array if no co-citations or backend failure.
    similar: (rel, k) => ipcRenderer.invoke('corpus:similar', rel, k),
    // agentTrace(rel, limit=10) → [{ ts, op, agent_id, meta?, sim?, weight? }, ...]
    // Reverse-chronological agent events for this note. Powers AGENT-TRACE
    // RIBBON in col-3 (per /tr 2026-04-29 council).
    agentTrace: (rel, limit) => ipcRenderer.invoke('corpus:agent-trace', rel, limit),
  },
  // V2 LLM Wiki — concept-level articles + graph walk (replaces v1 RAG paragraph
  // search). All calls are no-op safe if wiki-index.json is missing.
  wiki: {
    // rebuild(sessionId?) → { ok, ok_count, fail_count, errors[], elapsedMs }.
    // Long-running; subscribe to onRebuildProgress before invoking.
    rebuild: (sessionId) => ipcRenderer.invoke('wiki:rebuild', { sessionId }),
    rebuildAbort: (sessionId) => ipcRenderer.invoke('wiki:rebuild-abort', sessionId),
    // status() → { ok, vaultRoot, articleCount, updatedAt, sampleSlugs }
    status: () => ipcRenderer.invoke('wiki:status'),
    // lookup(query, k=8) → { ok, hits: [{slug, score, title, abstract, concepts, links_to}] }
    lookup: (query, k) => ipcRenderer.invoke('wiki:lookup', query, k),
    // distillOne(rel) → { ok, slug, abstract, concepts, links_to } | { ok:false, error }
    distillOne: (rel) => ipcRenderer.invoke('wiki:distill-one', rel),
    // onRebuildProgress((payload) => void) — payload = { sessionId, rel?, status, slug?, error?, total?, ok_count?, fail_count? }
    onRebuildProgress: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('wiki:rebuild-progress', handler);
      return () => ipcRenderer.removeListener('wiki:rebuild-progress', handler);
    },
  },
  shell: {
    // Open URL in user's default browser (NOT in Electron webview). Used by
    // DeepenCallout synth links to prevent in-app navigation hijack.
    openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  },
  llm: {
    // run(templateName, vars, requestId) → Promise<{ok, exitCode}|{error}>.
    // Stream chunks arrive on 'llm:chunk' events; subscribe via onChunk first.
    run: (templateName, vars, requestId) => ipcRenderer.invoke('llm:run', { templateName, vars, requestId }),
    abort: (requestId) => ipcRenderer.invoke('llm:abort', requestId),
    // onChunk((payload) => void) — payload = { requestId, text }. Returns unsubscribe fn.
    onChunk: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('llm:chunk', handler);
      return () => ipcRenderer.removeListener('llm:chunk', handler);
    },
    // 7-stage deepen pipeline (Path B). Resolves with { ok, synth, ctx } or { ok:false, error }.
    // onDeepenProgress streams stage events: { requestId, stage, status, text?, error?, label? }.
    deepen: (selection, noteRel, style, lang, direction, requestId) =>
      ipcRenderer.invoke('llm:deepen', { selection, noteRel, style, lang, direction, requestId }),
    deepenAbort: (requestId) => ipcRenderer.invoke('llm:deepen-abort', requestId),
    // quick(...) — single-call flash (~10s). Resolves with { ok, text } or { ok:false, error }.
    // Streams chunks on the same 'llm:deepen-progress' channel (stage='quick').
    // Aborted via the same deepenAbort(requestId) since it shares _deepenAbort map.
    quick: (selection, noteRel, lang, direction, requestId) =>
      ipcRenderer.invoke('llm:quick', { selection, noteRel, lang, direction, requestId }),
    // Hypha lesson — Socratic tutor turn. Streams chunks via the existing
    // llm:deepen-progress channel (DeepenCallout listener already wired).
    lesson: (args) => ipcRenderer.invoke('llm:lesson', args),
    lessonAbort: (requestId) => ipcRenderer.invoke('llm:lesson-abort', requestId),
    lessonSessions: (rel) => ipcRenderer.invoke('lesson:sessions', { rel }),
    lessonTranscript: (rel, sessionFile) => ipcRenderer.invoke('lesson:transcript', { rel, sessionFile }),
    lessonContinueFrom: (rel, sourceSessionFile) => ipcRenderer.invoke('lesson:continueFrom', { rel, sourceSessionFile }),
    onDeepenProgress: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('llm:deepen-progress', handler);
      return () => ipcRenderer.removeListener('llm:deepen-progress', handler);
    },
  },
  // Hypha-specific extensions on top of ptor namespace.
  hypha: {
    curriculumClarify: (args) => ipcRenderer.invoke('curriculum:clarify', args || {}),
    curriculumCreate: (topic, level, opts) => ipcRenderer.invoke('curriculum:create', { topic, level, ...(opts || {}) }),
    curriculumList: () => ipcRenderer.invoke('curriculum:list'),
    // Lacquer Loop W7 Chain Planner.
    chainClarify: (goal) => ipcRenderer.invoke('chain:clarify', { goal }),
    chainCreate: (args) => ipcRenderer.invoke('chain:create', args || {}),
    // Smart Gate (council 2026-05-01 option B): runs feasibility classifiers
    // after Learn-flow Q&A; renderer interrupts curriculum-create if tier is
    // nearly-impossible. proposePrereqs called only on user request.
    feasibilityGate: (args) => ipcRenderer.invoke('feasibility:gate', args || {}),
    chainProposePrereqs: (args) => ipcRenderer.invoke('chain:propose-prereqs', args || {}),
    onChainProgress: (cb) => {
      if (typeof cb !== 'function') return () => {};
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('hypha:chain-progress', handler);
      return () => ipcRenderer.removeListener('hypha:chain-progress', handler);
    },
    finish: (rel, userInsight, opts) => ipcRenderer.invoke('lesson:finish', { rel, userInsight, ...(opts || {}) }),
    settingsGet: () => ipcRenderer.invoke('settings:get'),
    settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
    settingsTest: () => ipcRenderer.invoke('settings:test'),
    providers: () => ipcRenderer.invoke('providers:list'),
    personas: () => ipcRenderer.invoke('personas:list'),
    agentGet: (slug) => ipcRenderer.invoke('agent:get', { slug }),
    agentSet: (slug, profile) => ipcRenderer.invoke('agent:set', { slug, profile }),
    // User identity — name + avatar (data-URL). Stored at vault/data/profile.json.
    profileGet: () => ipcRenderer.invoke('profile:get'),
    profileSet: (patch) => ipcRenderer.invoke('profile:set', patch),
    // Concept Atlas Phase A.1 — substrate layer.
    // atlasGet(rel) → returns atlas object (or empty default if no atlas yet).
    // atlasAppendTurn(rel, role, text) → after each tutor/user turn streams
    //   complete; calls extractAtlasDelta + persists. Returns updated atlas + delta.
    // atlasEditState(rel, term, newState) → user manual override (escape hatch).
    atlasGet: (rel) => ipcRenderer.invoke('atlas:get', { rel }),
    atlasAppendTurn: (rel, role, text) => ipcRenderer.invoke('atlas:append-turn', { rel, role, text }),
    atlasEditState: (rel, term, newState) => ipcRenderer.invoke('atlas:edit-state', { rel, term, newState }),
    // 金句 (Golden Quotes) — drag-tear extraction from tutor messages.
    quoteAdd: (rel, payload) => ipcRenderer.invoke('quote:add', { rel, payload: payload || {} }),
    quoteAddInsight: (rel, quoteId, insight) => ipcRenderer.invoke('quote:add-insight', { rel, quoteId, insight }),
    quoteDelete: (rel, quoteId) => ipcRenderer.invoke('quote:delete', { rel, quoteId }),
    // Phase 3.1 — Settled-Signal Goal Adaptation. Renderer fires after
    // lesson:finish resolves (fresh mode); main process reads atlas, computes
    // settled_count, rewrites next locked lessons' learn_goal in BASIC/DEEP.
    lessonsAdapt: (rel) => ipcRenderer.invoke('lessons:adapt-after-finish', { rel }),
    // Phase 3.3 — adaptation audit & revert. List walks all curricula's
    // adaptations.jsonl; revert restores earliest pre-adaptation goal/title.
    adaptationsList: () => ipcRenderer.invoke('lesson-adaptations:list'),
    adaptationsRevert: (slug, affectedIdx) => ipcRenderer.invoke('lesson-adaptations:revert', { slug, affectedIdx }),
    adaptationsWeeklySummary: (slug) => ipcRenderer.invoke('lesson-adaptations:weekly-summary', { slug }),
    onCurriculumProgress: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('curriculum:progress', handler);
      return () => ipcRenderer.removeListener('curriculum:progress', handler);
    },
  },
});
