'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
    // v0.10.2 — Daily note (HERMES-style lesson-free capture surface).
    // Returns { ok, rel } where rel is `daily/YYYY-MM-DD.md`. File is
    // created if absent. Per /tr council 2026-05-02 wiki+gbrain proposal.
    openDaily: ()            => ipcRenderer.invoke('vault:open-daily'),
    // v0.11.0 — wiki:resolve. Resolves [[target]] to a vault entity. Used
    // by NoteView wikilink click handler when basename match fails. Returns
    // { kind, rel?, conceptKey?, exists }. Per /tr 2026-05-02 wiki three-piece (B).
    wikiResolve: (target)    => ipcRenderer.invoke('wiki:resolve', target),
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
    lessonSessionDelete: (rel, sessionFile) => ipcRenderer.invoke('lesson:session-delete', { rel, sessionFile }),
    lessonTranscript: (rel, sessionFile) => ipcRenderer.invoke('lesson:transcript', { rel, sessionFile }),
    lessonContinueFrom: (rel, sourceSessionFile) => ipcRenderer.invoke('lesson:continueFrom', { rel, sourceSessionFile }),
    onDeepenProgress: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('llm:deepen-progress', handler);
      return () => ipcRenderer.removeListener('llm:deepen-progress', handler);
    },
  },
  // v0158 — Agent-Sovereign IPC bridges. Hypha as agent persistence layer:
  // each agent under <vault>/.agents/<name>/ has its own system-prompt + memory.
  agent: {
    list: () => ipcRenderer.invoke('agent:list'),
    load: (name) => ipcRenderer.invoke('agent:load', { name }),
    create: (name, systemPrompt, config) => ipcRenderer.invoke('agent:create', { name, systemPrompt, config }),
    // v0158b — invoke now accepts surface param ('spotlight' | 'lesson' | 'deepen' | 'recall' | 'ask')
    // for token budget enforcement + cross-surface state tracking.
    // v0158h — optional noteRel: when surface='spotlight' and noteRel set, main
    // prepends the note's content as default context (so user can ask about
    // the open note without manual paste).
    invoke: (name, userMsg, requestId, surface, noteRel) => ipcRenderer.invoke('agent:invoke', { name, userMsg, requestId, surface, noteRel }),
    abort: (requestId) => ipcRenderer.invoke('agent:abort', requestId),
    // v0158b auto-migration: scan vault for existing courses, create matching
    // @course-<slug> agents from frontmatter, import old session JSONLs.
    migrateCurricula: () => ipcRenderer.invoke('agent:migrate-curricula'),
    // v0158h — clean ORPHAN user-turns from existing session files (idempotent).
    purgeOrphans: () => ipcRenderer.invoke('agent:purge-orphans'),
    // Stream chunks arrive on 'agent:chunk' events: { requestId, text, stage }
    // stage values: 'start' | 'chunk' | 'done' | 'error'
    onChunk: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('agent:chunk', handler);
      return () => ipcRenderer.removeListener('agent:chunk', handler);
    },
  },
  // v0158c — "Install LLM in Hypha" UX. Replaces "configure provider" mental
  // model with "install / test / uninstall" lifecycle. Wraps existing settings.
  install: {
    status: () => ipcRenderer.invoke('install:status'),
    test: () => ipcRenderer.invoke('install:test'),
    uninstall: () => ipcRenderer.invoke('install:uninstall'),
  },
  // v0158d — CLI install lifecycle (orchestrate npm install + claude login from inside Hypha)
  cli: {
    detect: () => ipcRenderer.invoke('cli:detect'),
    install: () => ipcRenderer.invoke('cli:install'),
    login: () => ipcRenderer.invoke('cli:login'),
    uninstall: () => ipcRenderer.invoke('cli:uninstall'),
    onProgress: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('cli:install-progress', handler);
      return () => ipcRenderer.removeListener('cli:install-progress', handler);
    },
  },
  // Hypha-specific extensions on top of ptor namespace.
  hypha: {
    // v0156 — Anthropic OAuth one-click sign-in. Spawns `claude setup-token`,
    // captures the sk-ant-oat01-... token from stdout, writes to settings.json.
    // Returns { ok, tokenMasked, provider, model } | { ok:false, error }.
    // Progress chunks (claude CLI's interactive prompts / browser-open hint)
    // arrive on 'claude:setup-token-progress' — subscribe via onClaudeSetupTokenProgress.
    claudeSetupToken: () => ipcRenderer.invoke('claude:setup-token'),
    onClaudeSetupTokenProgress: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('claude:setup-token-progress', handler);
      return () => ipcRenderer.removeListener('claude:setup-token-progress', handler);
    },
    curriculumClarify: (args) => ipcRenderer.invoke('curriculum:clarify', args || {}),
    curriculumCreate: (topic, level, opts) => ipcRenderer.invoke('curriculum:create', { topic, level, ...(opts || {}) }),
    curriculumCancel: (topic) => ipcRenderer.invoke('curriculum:cancel', { topic }),
    curriculumList: () => ipcRenderer.invoke('curriculum:list'),
    // v0.5.0 — source-document upload for the curriculum's corpus.
    sourcePick: () => ipcRenderer.invoke('source:pick'),
    sourceExtract: (filePath) => ipcRenderer.invoke('source:extract', { filePath }),
    // For drag-drop files: get filesystem path from a dropped File. Electron
    // 32+ moved this off the File prototype; webUtils.getPathForFile is the
    // supported route under context isolation.
    getDroppedFilePath: (file) => {
      try {
        if (webUtils && typeof webUtils.getPathForFile === 'function') {
          return webUtils.getPathForFile(file);
        }
      } catch (_) {}
      return (file && file.path) || null;
    },
    // Lacquer Loop W7 Chain Planner.
    chainClarify: (goal) => ipcRenderer.invoke('chain:clarify', { goal }),
    chainCreate: (args) => ipcRenderer.invoke('chain:create', args || {}),
    // v0.5.2 chain accept/refuse — see main.js chain:accept / chain:refuse.
    // chainAccept({ slug, covenantSnapshot }) → { ok, firstSlug, lessonRel } | { ok:false, error }
    // chainRefuse({ slug, reason?, checklistFlags? }) → { ok, mode:'reason-recorded'|'cancelled', newPlan? }
    chainAccept: (args) => ipcRenderer.invoke('chain:accept', args || {}),
    // v0.11.1 — chain:repair-stubs. Idempotent re-creation of missing chain
    // link stub folders. Auto-fired by VaultTree when totalLinks > folder
    // count (silent partial-failure self-heal). Returns { ok, repaired,
    // errors }. Per /tr 2026-05-02 chain truncation diagnosis.
    chainRepairStubs: (chainSlug) => ipcRenderer.invoke('chain:repair-stubs', { chainSlug }),
    chainRefuse: (args) => ipcRenderer.invoke('chain:refuse', args || {}),
    // v0.6.5 — after chain:accept (lazy commit), the welcome form's continue
    // button fires chain:start to actually run the first link's curriculum.
    chainStart: (args) => ipcRenderer.invoke('chain:start', args || {}),
    // v0.6.2 — per-curriculum LLM response language override.
    curriculumGetLanguage: (slug) => ipcRenderer.invoke('curriculum:get-language', { slug }),
    curriculumSetLanguage: (slug, language) => ipcRenderer.invoke('curriculum:set-language', { slug, language }),
    // v0.6.1 — chain link transition. Called by NoteView's "advance →" button
    // when the user finishes the last lesson of the current chain link.
    chainAdvance: (args) => ipcRenderer.invoke('chain:advance', args || {}),
    // v0.6.1 — per-lesson re-harvest notification. Subscribe to flash a banner
    // in NoteView when ghost lesson materializes with fresh sources from
    // Tavily / citation graph.
    onLessonReharvestComplete: (cb) => {
      if (typeof cb !== 'function') return () => {};
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('lesson:reharvest-complete', handler);
      return () => ipcRenderer.removeListener('lesson:reharvest-complete', handler);
    },
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
    // v0.6.3 — user-authored custom tutor personas. Built-ins remain immutable.
    personaSaveCustom: (args) => ipcRenderer.invoke('personas:save-custom', args || {}),
    personaDeleteCustom: (id) => ipcRenderer.invoke('personas:delete-custom', { id }),
    agentGet: (slug) => ipcRenderer.invoke('agent:get', { slug }),
    agentSet: (slug, profile) => ipcRenderer.invoke('agent:set', { slug, profile }),
    // User identity — name + avatar (data-URL). Stored at vault/data/profile.json.
    profileGet: () => ipcRenderer.invoke('profile:get'),
    profileSet: (patch) => ipcRenderer.invoke('profile:set', patch),
    // v0.6.0 placement-probe (Lung's PLACEMENT_PROBE — calibrated 5-MCQ baseline
    // overrides prose self-introduction signal). profileProbe generates;
    // profileProbeSubmit tallies + persists into profile.json under `probe`.
    // Renderer holds the full questions structure (with `correct` flags) and
    // sends back per-answer `correct: true|false` triples for tally.
    profileProbe: (args) => ipcRenderer.invoke('profile:probe', args || {}),
    profileProbeSubmit: (args) => ipcRenderer.invoke('profile:probe-submit', args || {}),
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
    // v0.9.0 HERMES-style user profile — file-based, derived from existing
    // vault corpus (用户灵感 + atlas frequency + chain goal). Injected into
    // every tutor system prompt as <USER_PROFILE>. Privacy: stays in vault.
    userProfileGet: () => ipcRenderer.invoke('userProfile:get'),
    userProfileRebuild: () => ipcRenderer.invoke('userProfile:rebuild'),
    // v0.11.2 — pending HERMES reflection observations (confidence < 0.7) +
    // user ratification. ColophonView UserProfilePanel surfaces these.
    userProfilePending: (limit) => ipcRenderer.invoke('userProfile:pending', { limit: limit || 50 }),
    userProfileRatify: (action, entry) => ipcRenderer.invoke('userProfile:ratify', { action, entry }),
    // Phase 3.1 — Settled-Signal Goal Adaptation. Renderer fires after
    // lesson:finish resolves (fresh mode); main process reads atlas, computes
    // settled_count, rewrites next locked lessons' learn_goal in BASIC/DEEP.
    lessonsAdapt: (rel) => ipcRenderer.invoke('lessons:adapt-after-finish', { rel }),
    // v0.11.0 — manual HERMES reflection trigger. Auto-fires after each
    // lesson:finish (fire-and-forget). This handle is for ColophonView's
    // "re-derive from this lesson" button (deferred). Returns the diff +
    // applied/deferred sections so the UI can show what was learned.
    lessonReflect: (rel) => ipcRenderer.invoke('lesson:reflect', { rel }),
    // Phase 3.3 — adaptation audit & revert. List walks all curricula's
    // adaptations.jsonl; revert restores earliest pre-adaptation goal/title.
    adaptationsList: () => ipcRenderer.invoke('lesson-adaptations:list'),
    adaptationsRevert: (slug, affectedIdx) => ipcRenderer.invoke('lesson-adaptations:revert', { slug, affectedIdx }),
    adaptationsWeeklySummary: (slug) => ipcRenderer.invoke('lesson-adaptations:weekly-summary', { slug }),
    // Hypha Cloud — managed-LLM proxy. authOpenLogin opens hypha.studio/login
    // in the user's default browser; user gets a desktop token from the
    // dashboard and pastes it into the colophon. hyphaCloudMe queries the
    // server for current balance + free-quota status.
    authOpenLogin: (url) => ipcRenderer.invoke('auth:open-login', { url }),
    hyphaCloudMe: () => ipcRenderer.invoke('hypha-cloud:me'),
    // v0.2 — Variance Card + Concept Logbook. Variance = latest entry from
    // <slug>/variances.jsonl matching this lesson rel. Logbook = per-concept
    // timeline assembled across all lesson atlases in the curriculum.
    varianceGet: (rel) => ipcRenderer.invoke('variance:get', { rel }),
    conceptLogbook: (slug, conceptId) => ipcRenderer.invoke('concept-logbook:get', { slug, conceptId }),
    atlasCurriculumView: (slug) => ipcRenderer.invoke('atlas:curriculum-view', { slug }),
    onCurriculumProgress: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('curriculum:progress', handler);
      return () => ipcRenderer.removeListener('curriculum:progress', handler);
    },
  },
});
