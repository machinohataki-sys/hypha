'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// v0 mock marker bridge — exposes the predicate + reason getter to the
// renderer so any UI surface (V0MockBanner.jsx) can render "v0 模板输出"
// next to payloads that came out of a mocked module (product-transfer T4
// jaccard / tone-engine deterministic templates / auto-roadmap-sync
// synthetic filler). Renderer surface intentionally NOT under
// `window.hypha.*` because the banner is cross-cutting (multiple unrelated
// screens consume it). Aliased under both `window._hyphaMock` (namespaced)
// and the three flat `_isMockOutput` / `_getMockReason` / `_MOCK_TAG_KEY`
// shims the v0-mock-banner.jsx contract documents.
//
// sandbox:true + contextIsolation:true forbid direct `window.X = ...` from
// preload — contextBridge.exposeInMainWorld is the only path that lands in
// the renderer's main world.
const { MOCK_TAG_KEY, MOCK_TAG_VALUE, isMockOutput, getMockReason } = require('./lib/v0-mock-marker');

// v0.4.7 (2026-05-19) — pure-function bridge for Hypha Learn state-machine.
// Exposes detectPacingViolations + STATES + TRANSITIONS to renderer so UI
// (screen-lesson-chat) can use canonical pacing detection instead of
// duplicating inline regex. No IPC roundtrip — bridge is sync pure fns.
const _hyphaStateMachine = require('./lib/hypha-learn/state-machine');
const _hyphaRelativeTime = require('./lib/util/relative-time');
contextBridge.exposeInMainWorld('_hyphaMock', {
  isMockOutput,
  getMockReason,
  MOCK_TAG_KEY,
  MOCK_TAG_VALUE,
});
contextBridge.exposeInMainWorld('_isMockOutput', isMockOutput);
contextBridge.exposeInMainWorld('_getMockReason', getMockReason);
contextBridge.exposeInMainWorld('_MOCK_TAG_KEY', MOCK_TAG_KEY);

// HYPHA · sub-step D bridge — Lesson Skeleton generator (v0.1).
//
// ⚠ Naming note (v0.3 pivot): the IPC method `generateLessonPlan` returns a
// per-lesson SKELETON, not curriculum-level Plan (latter = `agent.js:planChain`).
// Method name retained for ABI compat; rename deferred to v0.4+ migration.
//
// Renderer calls window.hypha.generateLessonPlan(payload) and gets back
// { ok, plan } or { ok: false, error, message }. Schema validated server-side.
contextBridge.exposeInMainWorld('hypha', {
  generateLessonPlan: (payload) => ipcRenderer.invoke('lesson:generatePlan', payload),
  generateLessonBody: (payload) => ipcRenderer.invoke('lesson:generateBody', payload),
  scoreMicroProof: (payload) => ipcRenderer.invoke('score:microProof', payload),
  depositLessonNote: (payload) => ipcRenderer.invoke('note:deposit', payload),
  composeFeedback: (payload) => ipcRenderer.invoke('feedback:compose', payload),
  getProviderHealth: () => ipcRenderer.invoke('llm:healthReport'),
  generateConfession: (payload) => ipcRenderer.invoke('lesson:generateConfession', payload),
  computeGap: (payload) => ipcRenderer.invoke('lesson:computeGap', payload),
  computePersonaCoherence: (payload) => ipcRenderer.invoke('persona:computeCoherence', payload),
  prosecuteJudgeRewrite: (payload) => ipcRenderer.invoke('lesson:prosecuteJudgeRewrite', payload),
  auditableSummary: (payload) => ipcRenderer.invoke('lesson:auditableSummary', payload),
  runFullPipeline: (payload) => ipcRenderer.invoke('lesson:runFullPipeline', payload),
  loadQualitySamples: (kind) => ipcRenderer.invoke('lesson:loadQualitySamples', { kind }),
  // W2.2 Assignment Cadence — f(D,S,C,M,R,G,T,P) → Level 1-5 + template + grade.
  assignment: {
    compute: (args) => ipcRenderer.invoke('assignment:compute', args),
    template: (level, opts) => ipcRenderer.invoke('assignment:template', { level, opts }),
    grade: (args) => ipcRenderer.invoke('assignment:grade', args),
  },
});

// Note System §3 v0.5+ — Living Note Reactivation bridge. Renderer-side
// surface (NoteReactivationCard, v0.5.1 ship) calls
// `window.notes.findReactivations(slug, lessonIdx, currentText)` to fetch
// 1-3 candidates, OR subscribes to `note:reactivation-found` via
// `notes.onReactivationFound(cb)` to react to the post-body auto-scan
// emitted by main.js (`lesson:body:generate` non-blocking hook).
contextBridge.exposeInMainWorld('notes', {
  findReactivations: (slug, lessonIdx, currentText) =>
    ipcRenderer.invoke('note:findReactivations', {
      slug,
      currentLessonIdx: lessonIdx,
      currentLessonText: currentText,
    }),
  onReactivationFound: (cb) => {
    const handler = (_e, payload) => { try { cb(payload); } catch (_) {} };
    ipcRenderer.on('note:reactivation-found', handler);
    return () => {
      try { ipcRenderer.removeListener('note:reactivation-found', handler); } catch (_) {}
    };
  },
});

// β18 · Entropy Reduction Cycle v0 — Note System §3 subsystem (2026-05-16).
// Renderer-side surface (EntropyReductionCard, β18 ship) calls
// `window.entropy.<verb>(payload)` to collect `## 用户灵感` fragments across
// lessons + read/write/delete canonical-notes/*.md merges. Pure CRUD over
// data/<slug>/lesson-NN.md (read-only) and data/<slug>/canonical-notes/ (RW).
// No LLM in v0 — manual merge by user; v1+ will layer LLM auto-merge.
contextBridge.exposeInMainWorld('entropy', {
  collectFragments: (payload) => ipcRenderer.invoke('entropy:collect-fragments', payload || {}),
  listCanonical:    (payload) => ipcRenderer.invoke('entropy:list-canonical',    payload || {}),
  readCanonical:    (payload) => ipcRenderer.invoke('entropy:read-canonical',    payload || {}),
  writeCanonical:   (payload) => ipcRenderer.invoke('entropy:write-canonical',   payload || {}),
  deleteCanonical:  (payload) => ipcRenderer.invoke('entropy:delete-canonical',  payload || {}),
});

// β19 · Artifact Creation v0 — Growth System §28 subsystem (2026-05-16).
// Top-level `window.artifact` namespace mirrors window.entropy / window.notes
// (renderer-side cards call window.artifact.<verb>). 7-state state-machine +
// 7-kind enum + append-only jsonl + aggregate-on-read.
//   create:     ({ slug, kind, title, sourceLessonIdx?, sourceLessonTitle?, targetUrl?, notes? })
//                 → { ok:true, artifact } | { ok:false, error }
//   transition: ({ slug, artifactId, toState, notes? })
//                 → { ok:true, artifact } | { ok:false, error: 'INVALID_TRANSITION'|... }
//   list:       ({ slug, stateFilter?, limit? }) → { ok:true, artifacts }
//   get:        ({ slug, artifactId })           → { ok:true, artifact } | { ok:false }
//   delete:     ({ slug, artifactId })           → { ok:true }    (soft tombstone)
// Error codes: MISSING_SLUG / INVALID_KIND / TITLE_TOO_LONG / ARTIFACT_NOT_FOUND /
// INVALID_TRANSITION / EXCEPTION. VALID_TRANSITIONS hardcoded server-side in
// app/lib/growth/artifact-creation.js.
contextBridge.exposeInMainWorld('artifact', {
  create:     (payload) => ipcRenderer.invoke('artifact:create',     payload || {}),
  transition: (payload) => ipcRenderer.invoke('artifact:transition', payload || {}),
  list:       (payload) => ipcRenderer.invoke('artifact:list',       payload || {}),
  get:        (payload) => ipcRenderer.invoke('artifact:get',        payload || {}),
  delete:     (payload) => ipcRenderer.invoke('artifact:delete',     payload || {}),
});

// 2026-05-17 Phase C — lifetime ledger bridge. Mirrors `lifetime:*` IPC
// handlers in main.js. Per-chain 5-axis weekly self-report (HUMANITIES gets
// all 5; TECH archetypes drop "read"; LANG-ACQ/DECL-MASS/MINDSET keep only
// learn+practice). See `app/lib/lifetime-ledger/axes.js`.
contextBridge.exposeInMainWorld('lifetime', {
  getLedger:       (p) => ipcRenderer.invoke('lifetime:get-ledger',       p || {}),
  reportWeek:      (p) => ipcRenderer.invoke('lifetime:report-week',      p || {}),
  computeVariance: (p) => ipcRenderer.invoke('lifetime:compute-variance', p || {}),
  linkProgress:    (p) => ipcRenderer.invoke('lifetime:link-progress',    p || {}),
});

// 阶 3 北极星 metric (2026-05-17) — moved INTO the main `ptor` namespace
// below (see end of `ptor` literal, just after `artifact:` block). Electron's
// contextBridge.exposeInMainWorld throws when called twice with the same
// apiKey, so the new ipcRenderer.invoke bindings live as additional keys on
// the existing ptor object — NOT as a parallel exposure call.

// v1.0 boot-8 (2026-05-20) — electron-updater surface. Renderer reads via
// window.ptor.update.* but it's also exposed as a top-level namespace for
// Settings card discoverability + IPC-handler parity. See `app/lib/auto-updater.js`.
contextBridge.exposeInMainWorld('updater', {
  check:        (opts) => ipcRenderer.invoke('update:check', opts || {}),
  download:     ()     => ipcRenderer.invoke('update:download'),
  install:      ()     => ipcRenderer.invoke('update:install'),
  current:      ()     => ipcRenderer.invoke('update:current'),
  state:        ()     => ipcRenderer.invoke('update:state'),
  skipVersion:  (v)    => ipcRenderer.invoke('update:skip-version', v),
  remindLater:  ()     => ipcRenderer.invoke('update:remind-later'),
  onEvent:      (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('update:event', handler);
    return () => ipcRenderer.removeListener('update:event', handler);
  },
});

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
    // v1.0 boot-7 — vault safety surface. snapshot(tag) → { ok, file, bytes, ts };
    // listSnapshots → { ok, snapshots:[{name,file,ts,tag,bytes}] desc by ts };
    // restoreSnapshot(ts) → { ok, restored_from, pre_restore }; pruneSnapshots(policy)
    // → { ok, kept, pruned }; meta() → { ok, meta:{schema_version,...} | null }.
    snapshot:        (tag)    => ipcRenderer.invoke('vault:snapshot', { tag }),
    listSnapshots:   ()       => ipcRenderer.invoke('vault:list-snapshots'),
    restoreSnapshot: (ts)     => ipcRenderer.invoke('vault:restore-snapshot', { ts }),
    pruneSnapshots:  (policy) => ipcRenderer.invoke('vault:prune-snapshots', policy || {}),
    meta:            ()       => ipcRenderer.invoke('vault:meta'),
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
    // expand(...) — 3-axis lateral exploration (canon-cold / personal-cold / model-cold).
    // Resolves with { ok, synth, ctx } or { ok:false, error }. Streams progress on
    // 'llm:expand-progress' channel via onExpandProgress(cb).
    expand: (selection, noteRel, lang, direction, requestId) =>
      ipcRenderer.invoke('llm:expand', { selection, noteRel, lang, direction, requestId }),
    expandAbort: (requestId) => ipcRenderer.invoke('llm:expand-abort', requestId),
    onExpandProgress: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('llm:expand-progress', handler);
      return () => ipcRenderer.removeListener('llm:expand-progress', handler);
    },
    // challenge(...) — 4-stage adversarial scrutiny (muse / leo / scout / synth).
    // Same { ok, synth, ctx } shape as expand/deepen.
    challenge: (selection, noteRel, lang, direction, requestId) =>
      ipcRenderer.invoke('llm:challenge', { selection, noteRel, lang, direction, requestId }),
    challengeAbort: (requestId) => ipcRenderer.invoke('llm:challenge-abort', requestId),
    onChallengeProgress: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('llm:challenge-progress', handler);
      return () => ipcRenderer.removeListener('llm:challenge-progress', handler);
    },
    // productionGrade(...) — single-call PRODUCTION SCAFFOLD draft grading.
    // Returns { ok, scores: {structure_adherence, content_depth, evidence_link}, feedback }.
    productionGrade: (intent, slotTemplate, kpSlotMapping, studentDraft, lessonKPs, lang, requestId) =>
      ipcRenderer.invoke('llm:production-grade', { intent, slotTemplate, kpSlotMapping, studentDraft, lessonKPs, lang, requestId }),
    productionGradeAbort: (requestId) => ipcRenderer.invoke('llm:production-grade-abort', requestId),
    onProductionProgress: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('llm:production-progress', handler);
      return () => ipcRenderer.removeListener('llm:production-progress', handler);
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
    // 2026-05-15 (MEOW R5 fix) — optional slug + lessonIdx: when caller is in a
    // lesson context (vault-bound sub-agent invocation), pass them so streamTurn
    // can route citation-verifier reads to vault/<slug>/sources.json and
    // events.jsonl writes to vault/<slug>/events.jsonl instead of _global bucket.
    // Vault-agnostic callers (universal council / /tr without active vault) MAY
    // omit both — streamTurn falls through to slug=null and citation-verifier
    // skips (pre-existing behavior preserved).
    invoke: (name, userMsg, requestId, surface, noteRel, slug, lessonIdx) => ipcRenderer.invoke('agent:invoke', { name, userMsg, requestId, surface, noteRel, slug, lessonIdx }),
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
  // v0158m P6 — concept-level overrides. User chips in lesson view 〔已知此概念，
  // 直问〕 / 〔讲一遍再问〕 toggle these. Persistent (skip) vs one-shot (force).
  concept: {
    get: (rel, conceptId) => ipcRenderer.invoke('concept:get', { rel, conceptId }),
    skipPriorInstall: (rel, conceptId) => ipcRenderer.invoke('concept:skip-prior-install', { rel, conceptId }),
    forceExpose: (rel, conceptId) => ipcRenderer.invoke('concept:force-expose', { rel, conceptId }),
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
    // v0158o — slash-command auth dispatch. Used by lesson chat + Spotlight
    // when user types `/login` / `/logout` / `/status`. Same sandbox as lesson
    // dispatch so token state stays consistent across surfaces.
    authLogin: () => ipcRenderer.invoke('cli:auth-login'),
    authLogout: () => ipcRenderer.invoke('cli:auth-logout'),
    authStatus: () => ipcRenderer.invoke('cli:auth-status'),
    // v0158p — OAuth token paste (Anthropic-blessed headless auth path).
    setOauthToken: (token) => ipcRenderer.invoke('claude:set-oauth-token', { token }),
    clearOauthToken: () => ipcRenderer.invoke('claude:clear-oauth-token'),
    onAuthProgress: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('cli:auth-progress', handler);
      return () => ipcRenderer.removeListener('cli:auth-progress', handler);
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
    // Pillar 1 — single-vs-chain dispatcher. Renderer must call this BEFORE
    // curriculumCreate so ambitious goals (difficulty ≥ 0.7 + years ≥ 3) get
    // routed to `chain:create`. Returns { flow, reason, difficulty,
    // conservative_years, evidence, estimator_used, error? }.
    routeGoal: (args) => ipcRenderer.invoke('hypha:route-goal', args || {}),
    // Phase F.1 Gap 1 (2026-05-18) — keyword-based archetype inferrer for wizard.
    // Returns 'HUMANITIES' | 'TECH-CONCEPT' | 'TECH-PROC' | 'LANG-ACQ' | 'DECL-MASS' | 'MINDSET'.
    inferArchetype: (draftGoal) => ipcRenderer.invoke('hypha:infer-archetype', { draftGoal }),
    // boot-7 (2026-05-20) — first-launch detection + onboarded_at persistence + BYOK shape-validation.
    onboardingState: () => ipcRenderer.invoke('onboarding:state'),
    onboardingMarkComplete: (payload) => ipcRenderer.invoke('onboarding:mark-complete', payload || {}),
    onboardingValidateKey: (provider, key) => ipcRenderer.invoke('onboarding:validate-key', { provider, key }),
    curriculumCancel: (topic) => ipcRenderer.invoke('curriculum:cancel', { topic }),
    curriculumList: () => ipcRenderer.invoke('curriculum:list'),
    editCourseGoal: (slug, newGoal) => ipcRenderer.invoke('course:edit-goal', { slug, newGoal }),
    // v0.4.9 — chain.json direct surface. editCourseGoal also syncs chain.json
    // for the legacy state.goalContract path; chainEditUltimate is the new
    // pure-chain editor (no state.goalContract touch).
    chainGet: (slug) => ipcRenderer.invoke('chain:get', { slug }),
    chainEditUltimate: (slug, newGoal) => ipcRenderer.invoke('chain:edit-ultimate', { slug, newGoal }),
    setCourseSeries: (slug, series) => ipcRenderer.invoke('course:set-series', { slug, series }),
    // v0.4.11 — canonical parent-chain setter. Distinct from setCourseSeries
    // (legacy state.series + chain mirror dual-write). This one writes
    // chain.parent_chain_slug only; state.series untouched.
    setParentChain: (slug, parentChainSlug) => ipcRenderer.invoke('course:set-parent-chain', { slug, parentChainSlug }),
    frontierStatus: () => ipcRenderer.invoke('frontier:status'),
    // v0.5.x — 搁置课程 (D · 长按褪去) lane 2026-05-09. Backend at main.js
    // `curriculum:archive / list-deprecated / restore`. Consumed by
    // screen-home.jsx course-row long-press gesture + SetAsideList. All three
    // return {ok, error?} envelope; renderer surfaces failure in italic toast.
    curriculumArchive: (slug) => ipcRenderer.invoke('curriculum:archive', { slug }),
    curriculumListDeprecated: () => ipcRenderer.invoke('curriculum:list-deprecated'),
    curriculumRestore: (trashName) => ipcRenderer.invoke('curriculum:restore', { trashName }),
    // v0.5.2 — Frontier scheduler bridges. Backend persists enabled flag + interval
    // into settings.app; returns {ok, error?, intervalMs?}. Single-verb start/stop.
    frontierCronStart: (opts) => ipcRenderer.invoke('frontier:cron-start', opts || {}),
    frontierCronStop: () => ipcRenderer.invoke('frontier:cron-stop'),
    // v0.3 — 2-stage flow. Renderer drives: harvest_and_skeleton →
    // PreviewCard → (regenerate_skeleton up to 3x) → approve_and_body →
    // tutor opens. See `project_hypha_v03_2stage_gen` memory + main.js v0.3
    // section. Legacy curriculumCreate above stays for chain advance + any
    // pre-v0.3 caller; new code paths use these three.
    curriculumHarvestAndSkeleton: (topic, level, options) =>
      ipcRenderer.invoke('curriculum:harvest_and_skeleton', { topic, level, options: options || {} }),
    curriculumApproveAndBody: (slug, lessonIdx) =>
      ipcRenderer.invoke('curriculum:approve_and_body', { slug, lessonIdx: lessonIdx || 0 }),
    curriculumRegenerateSkeleton: (slug, userFeedback) =>
      ipcRenderer.invoke('curriculum:regenerate_skeleton', { slug, userFeedback }),
    // v0.3 — body-ready + skeleton-regen event subscriptions. PreviewCard
    // listens for body_ready to switch to lesson chat surface; subscribes to
    // skeleton_regenerated to re-render the lesson list after a regen lands.
    onCurriculumBodyReady: (cb) => {
      if (typeof cb !== 'function') return () => {};
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('curriculum:body_ready', handler);
      return () => ipcRenderer.removeListener('curriculum:body_ready', handler);
    },
    onCurriculumSkeletonRegenerated: (cb) => {
      if (typeof cb !== 'function') return () => {};
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('curriculum:skeleton_regenerated', handler);
      return () => ipcRenderer.removeListener('curriculum:skeleton_regenerated', handler);
    },
    // v0.2 Surface Finishing Track B — pre-lesson body v2 (11-field) bridges.
    // generate: produces + persists vault/<slug>/lesson-N.body.json.
    // get: reads existing body.json if present; returns null body when absent.
    lessonBodyGenerate: (args) => ipcRenderer.invoke('lesson:body:generate', args || {}),
    lessonBodyGet: (slug, idx) => ipcRenderer.invoke('lesson:body:get', { slug, idx }),
    // Note System §3 — Web Note Engine. 5 typed edges: cites / contradicts /
    // extends / triggered-by / related. Storage = vault/<slug>/note-edges.jsonl
    // (append-only, soft-delete tombstones). `inferEdges` calls T4_JUDGE
    // against the 5 most recent peer notes and auto-persists matches.
    // v0.5.1 plan: /finish ritual calls `inferEdges` at lesson end.
    // v0.5.2 plan: NoteEdgeCard reads `getNeighbors` for the tag-row UI.
    notes: {
      addEdge:      (slug, edge)              => ipcRenderer.invoke('notes:addEdge',      { slug, edge }),
      listEdges:    (slug, filter)            => ipcRenderer.invoke('notes:listEdges',    { slug, filter: filter || {} }),
      removeEdge:   (slug, edge_id)           => ipcRenderer.invoke('notes:removeEdge',   { slug, edge_id }),
      getNeighbors: (slug, note_idx, type)    => ipcRenderer.invoke('notes:getNeighbors', { slug, note_idx, type }),
      inferEdges:   (slug, lessonIdx, lessonText, settings) =>
                      ipcRenderer.invoke('notes:inferEdges',  { slug, lessonIdx, lessonText, settings: settings || {} }),
    },
    // W1.2 micro-judges (drift / generic / jargon). Each returns { ok, result }
    // where result follows the per-judge schema documented in
    // app/lib/judges/index.js. `all` runs the trio in parallel + emits one
    // events.jsonl row.
    judge: {
      drift:   (args) => ipcRenderer.invoke('lesson:judge:drift',   args || {}),
      generic: (args) => ipcRenderer.invoke('lesson:judge:generic', args || {}),
      jargon:  (args) => ipcRenderer.invoke('lesson:judge:jargon',  args || {}),
      all:     (lessonBody, context) =>
                 ipcRenderer.invoke('lesson:judge:all', { lessonBody, context }),
    },
    // W1.4 Misconception Engine bridge. `list` returns sidecar records
    // (per-KP when kpId given, else all of the lesson). `detect` pre-screens
    // a user reply for known wrong-priors. `repair` produces the tutor-side
    // correction prompt for the next turn. UI surfaces a callout in
    // screen-lesson-chat.jsx when detect returns a triggered record.
    misconception: {
      list: (slug, lessonIdx, kpId) =>
        ipcRenderer.invoke('misconception:list', { slug, lessonIdx, kpId }),
      detect: (userResponse, kpMisconceptions) =>
        ipcRenderer.invoke('misconception:detect', { userResponse, kpMisconceptions }),
      repair: (triggered, lessonContext) =>
        ipcRenderer.invoke('misconception:repair', { triggered, lessonContext }),
    },
    // W2.3 Goal Guardian + Affective Router — see specs/goal-guardian.md.
    //   guardian.assess({ userTrace, goalContract, currentLesson, slug, lessonIdx })
    //     → { state, confidence, guardian_action, evidence, affect }
    //   guardian.intervene(state, currentLesson)
    //     → { intervention_type, prompt_modifier, difficulty_adjust, message,
    //         downstream_repair }
    //   affect.extract(turnText)
    //     → { sentiment, energy, signals, confidence, evidence }
    // Renderer surfaces a GuardianBadge in PageFrame; agent.js streamTurn
    // calls extract + assess after each user turn to wire prompt_modifier
    // into the following tutor system prompt.
    guardian: {
      assess:    (args) => ipcRenderer.invoke('guardian:assess', args || {}),
      intervene: (state, currentLesson) =>
        ipcRenderer.invoke('guardian:intervene', { state, currentLesson }),
    },
    affect: {
      extract: (turnText) => ipcRenderer.invoke('affect:extract', { turnText }),
    },
    // Phase D — fetch the kp-arc.json sidecar (KP narrative arc 7+1 fields per
    // pedagogy.md Layer 4). Returns { ok, arcs, visual_archetype, user_intent, ... }.
    lessonKpArcsGet: (slug, idx) => ipcRenderer.invoke('lesson:kpArcs:get', { slug, idx }),

    // Library (BLUEPRINT System 5) — bibliography + chunk retrieval bridge.
    libraryList: () => ipcRenderer.invoke('library:list'),
    libraryGetBook: (bookId) => ipcRenderer.invoke('library:getBook', { bookId }),
    // Phase E.0 (2026-05-18) — pre-chain coverage gate. Returns
    // { ok, coverage: {has_coverage, hit_count, book_count, ...}, recommended: {books, confidence, notes, mode} | null }.
    // Phase F.2 (2026-05-18) — pass crystallizedTags (from goal:crystallize:synthesize)
    // to switch recommendBooks to fit-over-popular mode (vs default canonical).
    libraryCoverage: (goal, archetype, includeRecommendation, crystallizedTags) =>
      ipcRenderer.invoke('library:coverage', { goal, archetype, includeRecommendation, crystallizedTags }),
    // Phase F.0 (2026-05-18) — Goal Crystallizer. Two-stage:
    //   goalCrystallizeQuestions(draftGoal, archetype) →
    //     { ok, questions: [{id, prompt, dimension, options: [{id, label, implies}]}], confidence }
    //   goalCrystallizeSynthesize(draftGoal, archetype, answers) →
    //     { ok, crystallized_goal, tags: {primary_focus, output_form, current_level, niche_factor, ...}, confidence }
    goalCrystallizeQuestions: (draftGoal, archetype) =>
      ipcRenderer.invoke('goal:crystallize:questions', { draftGoal, archetype }),
    // Phase G.2 (2026-05-18) — 2-stage wizard: after 3 broad answered, fetch
    // 5 instance-level deep questions anchored to broad picks.
    goalCrystallizeFollowup: (draftGoal, archetype, broadAnswers) =>
      ipcRenderer.invoke('goal:crystallize:followup', { draftGoal, archetype, broadAnswers }),
    goalCrystallizeSynthesize: (draftGoal, archetype, answers) =>
      ipcRenderer.invoke('goal:crystallize:synthesize', { draftGoal, archetype, answers }),
    libraryPickAndAdd: () => ipcRenderer.invoke('library:pickAndAdd'),
    markitdownStatus: (fresh) => ipcRenderer.invoke('tool:markitdownStatus', { fresh: !!fresh }),
    libraryRemove: (id) => ipcRenderer.invoke('library:remove', id),
    libraryQuery: (topic, k) => ipcRenderer.invoke('library:query', { topic, k }),
    // Phase B Gap 4 (2026-05-17) — GraphRAG over Library. Manual rebuild
    // bridges + graph-build progress stream (separate from upload progress).
    libraryRebuildGraph: (bookId) => ipcRenderer.invoke('library:rebuildGraph', { bookId }),
    libraryRebuildAllGraphs: () => ipcRenderer.invoke('library:rebuildAllGraphs'),
    onLibraryGraphProgress: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('library:graph-progress', handler);
      return () => ipcRenderer.removeListener('library:graph-progress', handler);
    },
    onLibraryUploadProgress: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('library:upload-progress', handler);
      return () => ipcRenderer.removeListener('library:upload-progress', handler);
    },
    // R-LIB Day 6 — fetch per-book rollup + community hint cached by last harvest()
    libraryRollupForTopic: (topic) => ipcRenderer.invoke('library:rollupForTopic', topic),
    communityHintForTopic: (topic) => ipcRenderer.invoke('community:hintForTopic', topic),
    // Knowledge Source System §5 — archetype-lane priority config preview.
    // Renderer calls this to render a "source kit" hint in the course-create
    // form (HUMANITIES → Gutenberg / Nobel / Tolkien Estate / etc).
    harvest: {
      getLaneConfig: (archetype) =>
        ipcRenderer.invoke('harvest:getLaneConfig', { archetype }),
    },
    // W6.1 Book Grounding (BLUEPRINT §4) — Book Grounding Profile (8 fields)
    // + multi-book Grounding Synthesis (6 fields). Surfaced under
    // window.ptor.grounding.* for GroundingReviewScreen + onboarding picker.
    grounding: {
      buildProfile: (bookId, goalContract, slug, force) =>
        ipcRenderer.invoke('grounding:buildProfile', { bookId, goalContract, slug, force }),
      getProfile: (bookId, slug) =>
        ipcRenderer.invoke('grounding:getProfile', { bookId, slug }),
      refreshAll: (slug, goalContract, bookIds, force) =>
        ipcRenderer.invoke('grounding:refreshAll', { slug, goalContract, bookIds, force }),
      synthesize: (slug, goalContract, bookIds, force) =>
        ipcRenderer.invoke('grounding:synthesize', { slug, goalContract, bookIds, force }),
      getSynthesis: (slug) =>
        ipcRenderer.invoke('grounding:getSynthesis', { slug }),
      runForCourse: (slug, goalContract, bookIds, force) =>
        ipcRenderer.invoke('grounding:runForCourse', { slug, goalContract, bookIds, force }),
      onProgress: (cb) => {
        const handler = (_e, payload) => cb(payload);
        ipcRenderer.on('grounding:progress', handler);
        return () => ipcRenderer.removeListener('grounding:progress', handler);
      },
    },
    // W6.2 Distillation (BLUEPRINT §5.1 + §5.2) — 7-phase pipeline + Book Spark Pack.
    distill: {
      book: (bookId, opts) => ipcRenderer.invoke('distill:book', { bookId, ...(opts || {}) }),
      phase: (bookId, phaseN, opts) => ipcRenderer.invoke('distill:phase', { bookId, phaseN, ...(opts || {}) }),
      status: (bookId) => ipcRenderer.invoke('distill:status', { bookId }),
      getBookSparkPack: (bookId) => ipcRenderer.invoke('distill:getBookSparkPack', { bookId }),
      isDistilled: (bookId) => ipcRenderer.invoke('distill:isDistilled', { bookId }),
      clear: (bookId) => ipcRenderer.invoke('distill:clear', { bookId }),
    },
    book: {
      contextPacket: (bookId, query, budgetTokens) =>
        ipcRenderer.invoke('book:contextPacket', { bookId, query, budgetTokens }),
    },
    // Commons (Day 6) — pack browser, install (deferred), query by topic
    commonsListPacks: () => ipcRenderer.invoke('commons:listPacks'),
    commonsQueryPacks: (topic, lang) => ipcRenderer.invoke('commons:queryPacks', { topic, lang }),
    commonsInstallPack: (packId) => ipcRenderer.invoke('commons:installPack', packId),
    // boot-5 P12 GAP-1 — file picker for .hypha-pack import flow. Required by
    // screen-commons.jsx onClickImport; falling back to sourcePick would offer
    // wrong-extension filter (PDF/MD/TXT) so canonical surface is now wired.
    commonsPickPackFile: () => ipcRenderer.invoke('commons:pickPackFile'),
    // W6.5 Commons full — 15-field Pack Intelligence Card + Security Layer
    // + Source Trust + License Layer. Renderer reads via window.ptor.commons.*
    commons: {
      generateCard:      (pack, userContext) => ipcRenderer.invoke('commons:generateCard',    { pack, userContext }),
      rankPacks:         (packs, userContext) => ipcRenderer.invoke('commons:rankPacks',      { packs, userContext }),
      recommendReason:   (pack, userContext) => ipcRenderer.invoke('commons:recommendReason', { pack, userContext }),
      scanPack:          (packPath) => ipcRenderer.invoke('commons:scanPack',     { packPath }),
      sanitize:          (content)  => ipcRenderer.invoke('commons:sanitize',     { content }),
      safetyLevel:       (scan)     => ipcRenderer.invoke('commons:safetyLevel',  { scan }),
      trustScore:        (pack)     => ipcRenderer.invoke('commons:trustScore',   { pack }),
      parseLicense:      (pack)     => ipcRenderer.invoke('commons:license',      { pack }),
      checkUsage:        (pack, intent) => ipcRenderer.invoke('commons:checkUsage', { pack, intent }),
      // W6.6 Pack Export — bundles vault/<slug>/ → .hypha-pack file.
      exportPack:        (slug, opts) => ipcRenderer.invoke('commons:exportPack', { slug, opts }),
      listExportedPacks: ()           => ipcRenderer.invoke('commons:listExportedPacks'),
      // W6.6 Pack Import (β13) — reverse of exportPack. inspectPack is the
      // manifest-only preview used by the import-confirm modal in screen-commons.jsx.
      importPack:        (packPath, opts) => ipcRenderer.invoke('commons:importPack',  { packPath, opts }),
      inspectPack:       (packPath)       => ipcRenderer.invoke('commons:inspectPack', { packPath }),
      // γ17 Pack Distiller (v0) — editorial preview card, no vault writes.
      distill:           (payload)        => ipcRenderer.invoke('commons:distillPack', payload),
      // boot-5 P12 GAP-2 — deletePack. Removes both <pack_id>.hypha-pack and
      // <pack_id>.manifest.json under vault/.commons/packs/. Closes the
      // intentional-placeholder in screen-commons.jsx onDelete (line 798).
      deletePack:        (packId)         => ipcRenderer.invoke('commons:deletePack', { packId }),
      // Pure-renderer compute; lib has no async side effect so we shim
      // an inline formatter to avoid an unnecessary IPC round-trip.
      formatAttribution: (pack) => {
        if (!pack) return 'Attribution unavailable.';
        const license = pack.license || 'unspecified';
        const author = pack.author || pack.curator || 'Unknown author';
        const topic = pack.topic || pack.id || 'Untitled pack';
        if (String(license).toLowerCase() === 'cc0') {
          return `Pack "${topic}" by ${author} — CC0 (public domain).`;
        }
        return `Pack "${topic}" by ${author}, ${license}.`;
      },
    },
    // W7.3 Citation + Global Trust — global cross-module citation surface
    // (book / pack / paper / web_url / lesson / note / spark). Renderer
    // reads via window.ptor.citation.*. Reuses W6.5 commons internals via
    // the lib orchestrator (see app/lib/citation-system/).
    citation: {
      create:         (args)              => ipcRenderer.invoke('citation:create',         args || {}),
      parse:          (text)              => ipcRenderer.invoke('citation:parse',          { text }),
      render:         (citation, lang)    => ipcRenderer.invoke('citation:render',         { citation, language: lang }),
      format:         (citation)          => ipcRenderer.invoke('citation:format',         { citation }),
      extractURLs:    (text)              => ipcRenderer.invoke('citation:extractURLs',    { text }),
      classifyURL:    (url)               => ipcRenderer.invoke('citation:classifyURL',    { url }),
      scanContent:    (text)              => ipcRenderer.invoke('citation:scanContent',    { text }),
      copyrightRisk:  (args)              => ipcRenderer.invoke('citation:copyrightRisk',  args || {}),
      getBoundary:    (risk)              => ipcRenderer.invoke('citation:getBoundary',    { risk }),
      globalTrust:    (citation, opts)    => ipcRenderer.invoke('citation:globalTrust',    { citation, opts }),
      rank:           (citations, opts)   => ipcRenderer.invoke('citation:rank',           { citations, optsPerCitation: opts }),
      verifyCoverage: (slug, opts)        => ipcRenderer.invoke('citation:verifyCoverage', { slug, ...(opts || {}) }),
    },
    // v0.2.1 — preview-and-approve regen. Frontend PreviewCard "需要修改" path.
    lessonBodyRegenerate: (slug, idx, feedback) => ipcRenderer.invoke('curriculum:body:regenerate', { slug, lessonIdx: idx, userFeedback: feedback }),
    // W3.3 Product Transfer — relevance + auto-trigger bridges. `compute` is a
    // read-only score pull; `trigger` runs the full pipeline + writes events.
    // Bound at window.ptor.transfer.* (renderer reads window.ptor returned by
    // exposeInMainWorld below). UI surfaces the resulting body.product_transfer
    // as "迁移到你的产品" callout (screen-lesson-chat.jsx + screen-notebook.jsx).
    transfer: {
      compute: (args) => ipcRenderer.invoke('transfer:compute', args || {}),
      trigger: (slug, lessonIdx, kpId, options) =>
        ipcRenderer.invoke('transfer:trigger', { slug, lessonIdx, kpId, options }),
    },
    // v0.5.0 — source-document upload for the curriculum's corpus.
    sourcePick: () => ipcRenderer.invoke('source:pick'),
    sourcePickMultiple: () => ipcRenderer.invoke('source:pickMultiple'),
    sourceExtract: (filePath) => ipcRenderer.invoke('source:extract', { filePath }),
    urlFetchBatch: (urls) => ipcRenderer.invoke('url:fetchBatch', { urls }),
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
    // v0158m — JIT-recast notification. main.js fires this from lesson:finish
    // after _materializeNextGhost successfully re-writes L_(n+1) title +
    // learn_goal. NoteView surfaces it as a brief italic Garamond toast.
    onNextLessonRecast: (cb) => {
      if (typeof cb !== 'function') return () => {};
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('hypha:next-lesson-recast', handler);
      return () => ipcRenderer.removeListener('hypha:next-lesson-recast', handler);
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
    // v0.5.1 — Persona Corpus Distillation (string register → structured wisdom).
    personaDistill: (personaId, sourceTexts, opts) => ipcRenderer.invoke('personas:distill', {
      personaId,
      sourceTexts: Array.isArray(sourceTexts) ? sourceTexts : [],
      dryRun: !!(opts && opts.dryRun),
    }),
    personaGetWisdom: (personaId) => ipcRenderer.invoke('personas:getWisdom', { personaId }),
    personaListWisdom: () => ipcRenderer.invoke('personas:listWisdom'),
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
  // V0.5 E0 D11-D14 Phase 1 — evaluator substrate bridges. Consumed by
  // app/design/screen-tuple-substrate.jsx (col-3 tuple substrate view).
  // Single-verb IPCs over per-topic golden-set + per-response verification.
  // nextInstance(topic) → {ok, item, candidate, exhausted?}
  // submitResponse(itemId, candidateId, responseText) → {ok, verified, exec_result, recorded}
  // f1Run(topic, opts) → {ok, result}     (opts.truth_source: 'rater' | 'ground')
  // irrCompute(topic) → {ok, kappa, kappa_n, kappa_interpretation, n_items, n_double_coded}
  evaluator: {
    nextInstance:    (topic)                                  => ipcRenderer.invoke('evaluator:nextInstance', topic),
    submitResponse:  (itemId, candidateId, responseText)      => ipcRenderer.invoke('evaluator:submitResponse', itemId, candidateId, responseText),
    f1Run:           (topic, opts)                            => ipcRenderer.invoke('evaluator:f1Run', topic, opts || {}),
    irrCompute:      (topic)                                  => ipcRenderer.invoke('evaluator:irrCompute', topic),
  },
  // W1.3 Anti-Illusion — learning-illusion detector + next-lesson gate.
  // detect(userResponse, context) → DetectionResult
  // gate(currentLessonState, userTrace) → GateResult { allowed, micro_task? }
  // See BLUEPRINT §7.3 + specs/anti-illusion.md.
  illusion: {
    detect: (userResponse, context)         => ipcRenderer.invoke('illusion:detect', { userResponse, context }),
    gate:   (currentLessonState, userTrace) => ipcRenderer.invoke('illusion:gate', { currentLessonState, userTrace }),
  },
  // W2.1 Cadence Engine — lesson rhythm decision layer.
  // compute(input)   → { cadence_mode, next_lesson_type, rest_required, rationale, ratios, kp_coefficient }
  //   input = { goalType, lessonIdx?, learningScore, confusionLevel,
  //             milestoneProgress, reviewNodesDue, daysRemaining?, totalLessons? }
  // state({ slug })  → cadence-state.json (lastReviewIdx / milestoneCrossed / restCount / ...)
  // advance({ slug, decision, ctx }) → persists state + appends events.jsonl rows
  // See specs/lesson-cadence.md + BLUEPRINT §3.3 + §8.1.
  cadence: {
    compute: (input)         => ipcRenderer.invoke('cadence:compute', input || {}),
    state:   ({ slug } = {}) => ipcRenderer.invoke('cadence:state', { slug }),
    advance: (args)          => ipcRenderer.invoke('cadence:advance', args || {}),
  },
  // W1.5 Capture Mode + Finish Ritual. Backed by app/lib/capture-mode.js +
  // app/lib/finish-ritual.js. All four return { ok:false, error, message }
  // on failure (matches the rest of the hypha IPC envelope contract).
  //   start({ source, context })            → { sessionId, startedAt, vault_path }
  //   append({ sessionId, entry })          → { ok, seq, total }
  //   close({ sessionId })                  → { ok, sessionId, entryCount, durationMs }
  //   finishRitual({ sessionId, opts })     → { ok, lessonNotePath, evidence, ... }
  // See specs/capture-mode.md + BLUEPRINT §9.2 + §9.3.
  capture: {
    start:        (args) => ipcRenderer.invoke('capture:start', args || {}),
    append:       (args) => ipcRenderer.invoke('capture:append', args || {}),
    close:        (args) => ipcRenderer.invoke('capture:close', args || {}),
    finishRitual: (args) => ipcRenderer.invoke('capture:finishRitual', args || {}),
  },
  // W2.4 Repair Pipelines — three micro-intervention streams. Triggered
  // by W2.3 Goal Guardian's state assessment (confused / frustrated /
  // self_doubt). All four return the standard hypha envelope. See
  // specs/repair-pipelines.md + BLUEPRINT §3.4.
  //   confusion(args)  → { ok, repair_turn, expected_action, difficulty_adjust, intervention_id, ... }
  //   motivation(args) → { ok, recovery_turn, rest_offered, evidence_recap, rest_options, ... }
  //   selfDoubt(args)  → { ok, repair_turn, diagnostic, action, actions, playback, ... }
  //   run({ type, args }) → { ok, type, result, tutor_prompt }
  repair: {
    confusion:  (args)                  => ipcRenderer.invoke('repair:confusion', args || {}),
    motivation: (args)                  => ipcRenderer.invoke('repair:motivation', args || {}),
    selfDoubt:  (args)                  => ipcRenderer.invoke('repair:self-doubt', args || {}),
    run:        ({ type, args } = {})   => ipcRenderer.invoke('repair:run', { type, args: args || {} }),
  },
  // W3.6 Companion Triggers — 5 pure detect probes + manual fire + history.
  // Detection helpers expose the same shape as the lib (bool in `detected`).
  // `triggerManual` fires a specific trigger (debug only, dedupe still applies).
  // `history({ slug, limit })` returns reverse-chrono list of fires from
  // vault/<slug>/companion-fired.json. Companion expression text comes from
  // W3.5 companion-respond — this surface only delivers the detection + fire
  // events; UI listens for `companion:fired` window events emitted by main.
  companion: {
    detectLessonComplete:  (args) => ipcRenderer.invoke('companion:detect:lessonComplete',  args || {}),
    detectInterruptResume: (args) => ipcRenderer.invoke('companion:detect:interruptResume', args || {}),
    detectOverGrind:       (args) => ipcRenderer.invoke('companion:detect:overGrind',       args || {}),
    detectFinishCapture:   (args) => ipcRenderer.invoke('companion:detect:finishCapture',   args || {}),
    detectSparkSprout:     (args) => ipcRenderer.invoke('companion:detect:sparkSprout',     args || {}),
    triggerManual:         (triggerType, context) => ipcRenderer.invoke('companion:trigger', { triggerType, context: context || {} }),
    history:               (slug, limit) => ipcRenderer.invoke('companion:history', { slug, limit: limit || 20 }),
    // W3.5 engine surface — direct expression generation, contract introspection,
    // HYPHA→Myco keyword lookup, and the settings on/off flag.
    respond:    (triggerType, context) => ipcRenderer.invoke('companion:respond', { triggerType, context: context || {} }),
    contract:   () => ipcRenderer.invoke('companion:contract'),
    keywordMap: () => ipcRenderer.invoke('companion:keywordMap'),
    enabled:    () => ipcRenderer.invoke('companion:enabled'),
    // v1.0 boot-9 — T2_LOCAL Companion local-model surface (scaffold).
    // Status read returns model_name + size_mb + RAM + expected_path + ready
    // flag. Download stub returns not_implemented_v1.0; Settings UI binds the
    // disabled "下载 4GB 模型" button to it for v1.1+ swap-in.
    localStatus:   () => ipcRenderer.invoke('companion:local-status'),
    localDownload: () => ipcRenderer.invoke('companion:local-download'),
  },
  // W3.1 Creation Pool — one Goal binds one Product per slug, persisted to
  // vault/<slug>/product/. Framework only (bind / get / link / 4 ledger ops);
  // blueprint body editing = W3.2, spark state machine = W3.4, Companion
  // suggestions = W3.5/W3.6 via syncRoadmap.
  //
  // Renderer also listens for `creation:not-bound` events on `ipcRenderer.on`
  // — emitted by main after curriculum:create completes for an unbound slug.
  // ProductBadge in screen-lesson-chat.jsx consumes this to surface a "bind
  // a Product?" prompt.
  creation: {
    // Goal Feasibility Guardian — onboarding gate (Machino-δ6, 2026-05-14).
    // Returns { ok, verdict:{ verdict:'feasible'|'strained'|'absurd', headline,
    //   reasoning, suggestions:{tighten_scope, extend_deadline, steel_man_intent},
    //   math:{estimated_hours_needed, available_hours_in_deadline, feasibility_ratio} } }.
    // Renderer calls this in OnboardingScreen.onComplete BEFORE curriculumCreate.
    goalEvaluate:      (goalContract)                     => ipcRenderer.invoke('creation:goal:evaluate',    { goalContract }),
    bind:              (slug, productConfig)              => ipcRenderer.invoke('creation:bind',             { slug, productConfig }),
    get:               (slug)                              => ipcRenderer.invoke('creation:get',              { slug }),
    isBound:           (slug)                              => ipcRenderer.invoke('creation:isBound',          { slug }),
    linkLesson:        (slug, lessonIdx, relevance, sourceSummary) => ipcRenderer.invoke('creation:linkLesson', { slug, lessonIdx, relevance, sourceSummary }),
    linkNote:          (slug, notePath, relevance, sourceSummary)  => ipcRenderer.invoke('creation:linkNote',   { slug, notePath, relevance, sourceSummary }),
    linkPack:          (slug, packId, relevance, sourceSummary)    => ipcRenderer.invoke('creation:linkPack',   { slug, packId, relevance, sourceSummary }),
    addDecision:       (slug, decision)                    => ipcRenderer.invoke('creation:addDecision',      { slug, decision }),
    addAssumption:     (slug, assumption)                  => ipcRenderer.invoke('creation:addAssumption',    { slug, assumption }),
    updateAssumption:  (slug, id, status, evidence)        => ipcRenderer.invoke('creation:updateAssumption', { slug, id, status, evidence }),
    addKillCriterion:  (slug, criterion)                   => ipcRenderer.invoke('creation:addKillCriterion', { slug, criterion }),
    evalKillCriteria:  (slug, currentMetrics)              => ipcRenderer.invoke('creation:evalKillCriteria', { slug, currentMetrics }),
    syncRoadmap:       (slug, weeklyItems, priority, sourceAgent) => ipcRenderer.invoke('creation:syncRoadmap', { slug, weeklyItems, priority, sourceAgent }),
    // §11.5 Decision Log + §11.6 Assumption Ledger (2026-05-14, slug-bound JSONL).
    // Independent from addDecision/addAssumption above (slug-bound product W3.x).
    // v0.7.1+ migration plan: re-route these to product-bound storage.
    decisionAppend:        (slug, row)                  => ipcRenderer.invoke('decision:append',        { slug, row }),
    decisionList:          (slug, opts)                 => ipcRenderer.invoke('decision:list',          { slug, opts }),
    assumptionAppend:      (slug, row)                  => ipcRenderer.invoke('assumption:append',      { slug, row }),
    assumptionList:        (slug, opts)                 => ipcRenderer.invoke('assumption:list',        { slug, opts }),
    assumptionUpdateState: (slug, id, newState)         => ipcRenderer.invoke('assumption:updateState', { slug, id, newState }),
    // §11.4 Product Spark (slug-bound JSONL, 2026-05-14, sibling to decision/assumption).
    // Channel prefix `creation:spark:*` avoids collision with legacy W3.4 `spark:*` handlers.
    sparkAppend:           (slug, row)                  => ipcRenderer.invoke('creation:spark:append',      { slug, row }),
    sparkList:             (slug, opts)                 => ipcRenderer.invoke('creation:spark:list',        { slug, opts }),
    sparkUpdateState:      (slug, id, newState)         => ipcRenderer.invoke('creation:spark:updateState', { slug, id, newState }),
    // W3.2 Product Blueprint — 10-section structured product spec editor.
    // Per BLUEPRINT.md §11.2 + specs/product-blueprint.md. Three verbs:
    //   getBlueprint(slug)
    //     → { ok, sections:{northStar, targetUsers, corePain, hypothesis,
    //          modules, openQuestions, inspirationPool, decisionLog, riskMap,
    //          roadmap}, frontmatter, markdown } | { ok:true, sections:null }
    //   updateBlueprint(slug, sections)  → { ok } | { ok:false, error, message }
    //   validateBlueprint(slug)
    //     → { ok, valid, missing_sections:[key,...], warnings:[str,...] }
    // Persisted at vault/<slug>/product/blueprint.md.
    getBlueprint:      (slug)             => ipcRenderer.invoke('creation:getBlueprint',      { slug }),
    updateBlueprint:   (slug, sections)   => ipcRenderer.invoke('creation:updateBlueprint',   { slug, sections }),
    validateBlueprint: (slug)             => ipcRenderer.invoke('creation:validateBlueprint', { slug }),
    // §11.7 Kill Watcher — manual full-vault sweep. Returns { ok, summary }
    // where summary = { sweep_ts, slugs_scanned, by_kind:{...}, errors:[] }.
    // Startup auto-sweep runs 60s after app.whenReady() — manual sweep is for
    // the UI "Run Kill Watcher Now" button.
    killWatchSweep:    ()                  => ipcRenderer.invoke('creation:killWatch:sweep'),
    // §11.8 Roadmap Sync — weekly roll-up of decisions / assumptions / sparks
    // / auto-killed rows into a markdown roadmap. Slug-bound. Startup auto-
    // sync fires 120s after app.whenReady() for stale slugs (≥7 days). UI
    // can manually trigger or view history.
    //   roadmapSyncWeekly(slug, opts?) → { ok, summary?, mdPath?, skipped?, error? }
    //   roadmapGetLatest(slug)         → { ok, mdContent, mdPath, generatedAt, weekAnchorDate }
    //   roadmapListWeeks(slug)         → { ok, weeks:[{ weekAnchorDate, mdPath }] }
    roadmapSyncWeekly: (slug, opts)        => ipcRenderer.invoke('creation:roadmap:syncWeekly', { slug, dryRun: !!(opts && opts.dryRun) }),
    roadmapGetLatest:  (slug)              => ipcRenderer.invoke('creation:roadmap:getLatest',  { slug }),
    roadmapListWeeks:  (slug)              => ipcRenderer.invoke('creation:roadmap:listWeeks',  { slug }),
    onNotBound: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('creation:not-bound', handler);
      return () => ipcRenderer.removeListener('creation:not-bound', handler);
    },
    // Machino-α5 (2026-05-14) — post-finish refresh events from main.
    // Each helper returns a cleanup function the card useEffect calls on
    // unmount. Wraps ipcRenderer.on/removeListener inside this preload so
    // the renderer never sees raw ipcRenderer (whitelisted channels only,
    // matching the rest of window.ptor.creation surface).
    //
    // Payload contracts:
    //   creation:decisions-extracted → { slug, lesson_idx, count, assumptionCount, skipped }
    //   creation:sparks-extracted    → { slug, lesson_idx, count, skipped }
    //   creation:kill-watch-done     → { summary:{slugs,refuted,rejected,flagged,errors}, source:'startup'|'manual' }
    //   creation:roadmap-synced      → { slug, weekAnchorDate, mdPath, source:'startup'|'manual' }
    onDecisionsExtracted: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('creation:decisions-extracted', handler);
      return () => ipcRenderer.removeListener('creation:decisions-extracted', handler);
    },
    onSparksExtracted: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('creation:sparks-extracted', handler);
      return () => ipcRenderer.removeListener('creation:sparks-extracted', handler);
    },
    onKillWatchDone: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('creation:kill-watch-done', handler);
      return () => ipcRenderer.removeListener('creation:kill-watch-done', handler);
    },
    onRoadmapSynced: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('creation:roadmap-synced', handler);
      return () => ipcRenderer.removeListener('creation:roadmap-synced', handler);
    },
  },
  // 2026-05-13 — Product Registry (standalone Product Pool, BLUEPRINT §11.1).
  // 与 creation:* 并列 — creation:* 是 curriculum-slug 绑定的 W3.x 旧路径;
  // product:* 是 vault-level standalone product (HYPHA / 论文 / 小说 / 网站 ...)
  // 跨 curriculum 共享。Storage: vault/.products/<productId>/{meta.json,blueprint.md,inspiration-pool.jsonl}.
  product: {
    list:             ()                                 => ipcRenderer.invoke('product:list'),
    create:           ({ name, type, northStar } = {})   => ipcRenderer.invoke('product:create',           { name, type, northStar }),
    get:              (productId)                        => ipcRenderer.invoke('product:get',              { productId }),
    updateBlueprint:  (productId, blueprintMd)           => ipcRenderer.invoke('product:updateBlueprint',  { productId, blueprintMd }),
    listInspirations: (productId, limit)                 => ipcRenderer.invoke('product:listInspirations', { productId, limit }),
    // 2026-05-13 — BLUEPRINT §11.3 cross-product transfer. scan = pure read,
    // returns ranked hits[]; commit = appends top hit to that product's
    // inspiration-pool.jsonl. Renderer is split so user can preview before commit.
    transferScan:     (args = {})                        => ipcRenderer.invoke('product:transferScan',     args || {}),
    transferCommit:   (scanResult)                       => ipcRenderer.invoke('product:transferCommit',   { scanResult }),
  },
  // W3.4 Product Spark — state machine + sparks/*.md CRUD (BLUEPRINT §11.4).
  // 5-state machine: seed → considered → accepted → implemented (terminal);
  // any non-terminal state → rejected (terminal). transition() resolves with
  // { ok:false, error, code } on illegal moves (no throw across IPC boundary).
  spark: {
    create:        (slug, data)               => ipcRenderer.invoke('spark:create',        { slug, data }),
    list:          (slug, filterState)        => ipcRenderer.invoke('spark:list',          { slug, filterState }),
    get:           (slug, sparkId)            => ipcRenderer.invoke('spark:get',           { slug, sparkId }),
    update:        (slug, sparkId, patch)     => ipcRenderer.invoke('spark:update',        { slug, sparkId, patch }),
    transition:    (slug, sparkId, newState, opts) =>
                                                 ipcRenderer.invoke('spark:transition',    { slug, sparkId, newState, opts: opts || {} }),
    archive:       (slug, sparkId)            => ipcRenderer.invoke('spark:archive',       { slug, sparkId }),
    linkBlueprint: (slug, sparkId, section)   => ipcRenderer.invoke('spark:linkBlueprint', { slug, sparkId, section: section || null }),
  },
  // W5.4 Creation System v1 — auto-transfer / weekly roadmap / kill-eval /
  // spark priority + the unified runCycle. Wraps W3.x lib through main.js
  // IPC; same envelope contract as window.ptor.creation / .spark.
  creationV1: {
    autoTransferQueue: (slug, opts)                       => ipcRenderer.invoke('creation_v1:autoTransferQueue', { slug, ...(opts || {}) }),
    runTransferAudit:  (slug, opts)                       => ipcRenderer.invoke('creation_v1:runTransferAudit',  { slug, ...(opts || {}) }),
    weeklyRoadmap:     (slug, days)                       => ipcRenderer.invoke('creation_v1:weeklyRoadmap',     { slug, days }),
    evalKill:          (slug, currentMetrics, lookbackDays) => ipcRenderer.invoke('creation_v1:evalKill',         { slug, currentMetrics, lookbackDays }),
    rankSparks:        (slug, sparks)                     => ipcRenderer.invoke('creation_v1:rankSparks',        { slug, sparks: sparks || null }),
    nextSpark:         (slug)                             => ipcRenderer.invoke('creation_v1:nextSpark',         { slug }),
    runCycle:          (slug, opts)                       => ipcRenderer.invoke('creation_v1:runCycle',          { slug, ...(opts || {}) }),
  },
  // W4.1 7-Day Growth Path — scenario orchestrator that strings W1 (quality
  // harness / anti-illusion / misconception) + W2 (cadence / assignment) + W3
  // (creation pool / transfer / spark / companion) into one AI Builder ladder.
  // Per BLUEPRINT.md §20 v1.0 Closed Beta + specs/seven-day-growth.md.
  // Returns { ok, plan|result|verdict|state, error? } envelope.
  scenario: {
    dayPlan: ()                             => ipcRenderer.invoke('scenario:dayPlan'),
    runDay:  (dayIdx, slug, userState, opts) => ipcRenderer.invoke('scenario:runDay',  { dayIdx, slug, userState: userState || {}, opts: opts || {} }),
    validate:(dayIdx, results)               => ipcRenderer.invoke('scenario:validate', { dayIdx, results }),
    state:   (slug)                          => ipcRenderer.invoke('scenario:state',    { slug }),
    reset:   (slug)                          => ipcRenderer.invoke('scenario:reset',    { slug }),
  },
  // W5.3 Living Note Reactivation — BLUEPRINT §10.2. 9 life states + Utility
  // Score + 8-scene reactivator + Dead-Note Detector + 6-target Crystallizer.
  // Bound at window.ptor.livingnote.* per spec.
  //   state()                                       → { states, transitions }
  //   transition(nodePath, fromState, toState, reason) → { from, to, ts }
  //   utility(noteDataOrArgs)                       → { score, factors } | { ranked }
  //   reactivate(slug, scene, opts)                 → { scene, candidates[] }
  //   detectDead(slug)                              → { dead[] }
  //   archive(slug, dryRun, paths)                  → { dryRun, archived, skipped }
  //   crystallize(slug, noteId, targetType, opts)   → { newNotePath, type, structured_content }
  livingnote: {
    state:       ()                                       => ipcRenderer.invoke('livingnote:state'),
    transition:  (nodePath, fromState, toState, reason)   => ipcRenderer.invoke('livingnote:transition', { nodePath, fromState, toState, reason }),
    utility:     (noteDataOrArgs)                         => ipcRenderer.invoke('livingnote:utility', noteDataOrArgs || {}),
    reactivate:  (slug, scene, opts)                      => ipcRenderer.invoke('livingnote:reactivate', { slug, scene, ...(opts || {}) }),
    detectDead:  (slug)                                   => ipcRenderer.invoke('livingnote:detectDead', { slug }),
    archive:     (slug, dryRun, paths)                    => ipcRenderer.invoke('livingnote:archive', { slug, dryRun, paths }),
    crystallize: (slug, noteId, targetType, opts)         => ipcRenderer.invoke('livingnote:crystallize', { slug, noteId, targetType, ...(opts || {}) }),
  },
  // W7.1 Pack Learning Mode (BLUEPRINT §12.4 + §12.5). 6 ops + 9-state machine
  // + Pack Learning Path + Pack Study Note + Parking Queue. Renderer reads
  // via window.ptor.pack.*. LLM-touching ops are mocked at lib level today —
  // surface contract stays stable across the mock→real swap.
  pack: {
    preview:               (pack, userContext)              => ipcRenderer.invoke('pack:preview',           { pack, userContext: userContext || {} }),
    quickLearn:            (pack, options)                  => ipcRenderer.invoke('pack:quickLearn',        { pack, options: options || {} }),
    deepLearn:             (pack, options)                  => ipcRenderer.invoke('pack:deepLearn',         { pack, options: options || {} }),
    apply:                 (pack, currentProblem)           => ipcRenderer.invoke('pack:apply',             { pack, currentProblem: currentProblem || {} }),
    fork:                  (pack, options)                  => ipcRenderer.invoke('pack:fork',              { pack, options: options || {} }),
    transferToProduct:     (pack, slug, options)            => ipcRenderer.invoke('pack:transferToProduct', { pack, slug, options: options || {} }),
    state:                 (packId)                         => ipcRenderer.invoke('pack:state',             { packId }),
    transition:            (packId, fromState, toState, reason) =>
                                                                ipcRenderer.invoke('pack:transition',       { packId, fromState, toState, reason: reason || '' }),
    getValidTransitions:   (currentState)                   => ipcRenderer.invoke('pack:getValidTransitions', { currentState }),
    buildPath:             (pack, userMastery)              => ipcRenderer.invoke('pack:buildPath',         { pack, userMastery: userMastery || {} }),
    getStudyNote:          (packId, slug)                   => ipcRenderer.invoke('pack:getStudyNote',      { packId, slug }),
    appendStudyNote:       (packId, slug, content)          => ipcRenderer.invoke('pack:appendStudyNote',   { packId, slug, content: content || '' }),
    park:                  (slug, packId, reason, meta)     => ipcRenderer.invoke('pack:park',              { slug, packId, reason: reason || '', meta: meta || {} }),
    listParked:            (slug)                           => ipcRenderer.invoke('pack:listParked',        { slug }),
    unpark:                (slug, packId, reason)           => ipcRenderer.invoke('pack:unpark',            { slug, packId, reason: reason || '' }),
    suggestRevival:        (slug, currentLessonContext, options) =>
                                                                ipcRenderer.invoke('pack:suggestRevival',   { slug, currentLessonContext: currentLessonContext || {}, options: options || {} }),
  },
  // W5.2 Web Note Engine — 6-layer spider-web entropy-reduction graph
  // (BLUEPRINT §10.1). Raw → Atomic → Concept → Spark → Product Spark → Kernel
  // with 13 typed edges (prerequisite/explains/example_of/contradicts/extends/
  // applies_to/analogizes/compresses/operationalizes/sparks/productizes/risks/
  // decides). LLM only sees Context Packets, never the full graph. Pairs with
  // W5.1 cheap-router for Context Packet packing and W5.3 livingnote for
  // dead_node_detected events. Renderer surface intentionally minimal: data
  // primitives, no UI control flow.
  webnote: {
    addNode:          (slug, node)                              => ipcRenderer.invoke('webnote:addNode',          { slug, node }),
    addEdge:          (slug, edge)                              => ipcRenderer.invoke('webnote:addEdge',          { slug, edge }),
    getNode:          (slug, nodeId)                            => ipcRenderer.invoke('webnote:getNode',          { slug, nodeId }),
    listNodes:        (slug, filter)                            => ipcRenderer.invoke('webnote:listNodes',        { slug, filter: filter || {} }),
    getEdges:         (slug, nodeId, direction, filter)         => ipcRenderer.invoke('webnote:getEdges',         { slug, nodeId, direction: direction || 'both', filter: filter || {} }),
    walk:             (slug, startId, opts)                     => ipcRenderer.invoke('webnote:walk',             { slug, startId, opts: opts || {} }),
    merge:            (slug, nodeIds, mergedNode)               => ipcRenderer.invoke('webnote:merge',            { slug, nodeIds, mergedNode }),
    // direction ∈ { raw_to_atomic, atomic_to_concept, to_spark, to_product_spark }
    promote:          (slug, direction, args)                   => ipcRenderer.invoke('webnote:promote',          Object.assign({ slug, direction }, args || {})),
    distillKernel:    (slug, nodeIds, opts)                     => ipcRenderer.invoke('webnote:distillKernel',    { slug, nodeIds, opts: opts || {} }),
    contextPacket:    (slug, queryNodeId, budgetTokens, opts)   => ipcRenderer.invoke('webnote:contextPacket',    { slug, queryNodeId, budgetTokens: budgetTokens || 2000, opts: opts || {} }),
    entropyReduction: (slug, opts)                              => ipcRenderer.invoke('webnote:entropyReduction', { slug, opts: opts || {} }),
  },
  // W4.2 KPI Dashboard — BLUEPRINT §20 v1.0 read-only aggregator + 1-shot
  // payment survey writer. Each verb returns the standard hypha envelope
  // ({ ok, ...payload } on success, { ok:false, error } on failure).
  kpi: {
    completion:    (slug, scenarioName)       => ipcRenderer.invoke('kpi:completion',    { slug, scenarioName }),
    artifacts:     (slug)                     => ipcRenderer.invoke('kpi:artifacts',     { slug }),
    productPool:   (slug)                     => ipcRenderer.invoke('kpi:productPool',   { slug }),
    companion:     (slug)                     => ipcRenderer.invoke('kpi:companion',     { slug }),
    payment:       (slug)                     => ipcRenderer.invoke('kpi:payment',       { slug }),
    aggregate:     (slug)                     => ipcRenderer.invoke('kpi:aggregate',     { slug }),
    surveyPayment: (slug, willing, freeText)  => ipcRenderer.invoke('kpi:surveyPayment', { slug, willing, freeText }),
  },
  // W5.1 Cheap Intelligence Router — BLUEPRINT §17.2 + ROADMAP v1.1.
  // Routes inexpensive tasks (relevance / pack first-pass / note routing /
  // companion state) down the cheapest competent tier:
  //   T0_RULE → T1_EMBED → T2_LOCAL → T3_MID
  // Stubs: BGE-M3 + Gemma Ollama fall back to deterministic mock until v0.8.
  cheap: {
    route:       (task, options)                  => ipcRenderer.invoke('cheap:route',     { task, options: options || {} }),
    run:         (task, input, options)           => ipcRenderer.invoke('cheap:run',       { task, input: input || {}, options: options || {} }),
    embed:       (text)                           => ipcRenderer.invoke('embed:embed',     { text }),
    similar:     (query, candidates, k)           => ipcRenderer.invoke('embed:similar',   { query, candidates: candidates || [], k: k || 5 }),
    local:       (prompt, options)                => ipcRenderer.invoke('local:run',       { prompt, options: options || {} }),
    localReady:  ()                               => ipcRenderer.invoke('local:available'),
    packContext: (args)                           => ipcRenderer.invoke('pack:context',    args || {}),
  },
  // W6.4 Curriculum Graph — BLUEPRINT §20 v1.8 single-domain AI/CS DAG.
  // 48 knowledge points + prereq edges + difficulty / canonical example /
  // assignment types / frontier bridges. All verbs return the standard hypha
  // envelope ({ ok, ...payload } | { ok:false, error }).
  curgraph: {
    load:           ()                                       => ipcRenderer.invoke('curgraph:load'),
    findPath:       (fromKpId, toKpId)                       => ipcRenderer.invoke('curgraph:findPath',       { fromKpId, toKpId }),
    recommendNext:  (masteredKpIds, limit)                   => ipcRenderer.invoke('curgraph:recommendNext',  { masteredKpIds: masteredKpIds || [], limit: limit || 5 }),
    kpForGoal:      (goalText, k)                            => ipcRenderer.invoke('curgraph:kpForGoal',      { goalText, k: k || 3 }),
    frontierBridge: (kpId)                                   => ipcRenderer.invoke('curgraph:frontierBridge', { kpId }),
    buildCustom:    (goalContract, targetTotalLessons)       => ipcRenderer.invoke('curgraph:buildCustom',    { goalContract: goalContract || {}, targetTotalLessons: targetTotalLessons || 16 }),
  },
  // W6.3 Research Radar — BLUEPRINT §15 + ROADMAP v1.7. Periodic frontier
  // harvest with Cheap Router (W5.1) first-pass + T6_STRONG synth. Reports
  // land at vault/<slug>/research-radar/reports/<topic>/<date>.json, auto-
  // mirror into web-note-engine raw layer (W5.2), become citation candidates
  // in lesson body generation, and can promote into Product Sparks (W3.4).
  // Anti-feed principle: never pushes to UI; surfaces only inside existing
  // surfaces (lesson body citations + radar dashboard).
  radar: {
    subscribe:    (slug, topic, options)        => ipcRenderer.invoke('radar:subscribe',          { slug, topic, options: options || {} }),
    unsubscribe:  (slug, topic)                 => ipcRenderer.invoke('radar:unsubscribe',        { slug, topic }),
    list:         (slug)                        => ipcRenderer.invoke('radar:list',               { slug }),
    run:          (slug, topic, opts)           => ipcRenderer.invoke('radar:run',                { slug, topic, opts: opts || {} }),
    runDaily:     (opts)                        => ipcRenderer.invoke('radar:runDaily',           opts || {}),
    getReport:    (slug, topic)                 => ipcRenderer.invoke('radar:report',             { slug, topic }),
    listAll:      (slug)                        => ipcRenderer.invoke('radar:report',             { slug, all: true }),
    formatReport: (report)                      => ipcRenderer.invoke('radar:formatReport',       { report: report || {} }),
    lessonCite:   (slug, lessonIdx)             => ipcRenderer.invoke('radar:lessonCitationHook', { slug, lessonIdx }),
    triggerSpark: (slug, candidate, reportCtx)  => ipcRenderer.invoke('radar:triggerSpark',       { slug, candidate, reportContext: reportCtx || {} }),
    storeAsNote:  (slug, report)                => ipcRenderer.invoke('radar:storeAsNote',        { slug, report }),
  },
  // W7.2 Exam System (Alpha — 考研英语). See specs/exam-model-alpha.md.
  //   scope({slug})                          → { scope }
  //   setScope({slug, customScope})          → { scope }
  //   classifyTopic({topicText, scope?})     → { tier }
  //   tierProgress({slug, completedTopics})  → { progress }
  //   cadence({daysRemaining, currentScopeProgress?, errorAccumulation?})
  //                                          → { cadence: {mode, focus, lesson_split, ...} }
  //   importBank({slug, bankFile})           → { bank_id, item_count, path }
  //   listBanks({slug})                      → { banks: [{bank_id, display_name, item_count, imported_at}] }
  //   bankItem({slug, bankId, itemIdx})      → { item }
  //   tagItem({slug, bankId, itemIdx, patch})→ { item }
  //   diagnose({question, userAnswer, correctAnswer, context?})
  //                                          → { diagnosis: {cause, severity, repair_strategy, mock} }
  //   errorLog({slug, limit?})               → { log: [...] }
  //   appendError({slug, error})             → { error_id }
  //   errorCounts({slug})                    → { counts: {cause: n, ..., _total} }
  //   enterFinal({slug})                     → { entered_at, mode }
  //   finalTasks({slug})                     → { tasks: [{type, display, items}] }
  //   dailyFinal({slug, daysRemaining})      → { valid, plan? | message? }
  //   finalState({slug})                     → { state }
  exam: {
    scope:          (slug, examType)                             => ipcRenderer.invoke('exam:scope',         { slug, examType }),
    setScope:       (slug, customScope)                          => ipcRenderer.invoke('exam:setScope',      { slug, customScope }),
    classifyTopic:  (topicText, scope)                           => ipcRenderer.invoke('exam:classifyTopic', { topicText, scope }),
    tierProgress:   (slug, completedTopics)                      => ipcRenderer.invoke('exam:tierProgress',  { slug, completedTopics }),
    cadence:        (input)                                      => ipcRenderer.invoke('exam:cadence',       input || {}),
    importBank:     (slug, bankFile)                             => ipcRenderer.invoke('exam:importBank',    { slug, bankFile }),
    listBanks:      (slug)                                       => ipcRenderer.invoke('exam:listBanks',     { slug }),
    bankItem:       (slug, bankId, itemIdx)                      => ipcRenderer.invoke('exam:bankItem',      { slug, bankId, itemIdx }),
    tagItem:        (slug, bankId, itemIdx, patch)               => ipcRenderer.invoke('exam:tagItem',       { slug, bankId, itemIdx, patch }),
    diagnose:       (input)                                      => ipcRenderer.invoke('exam:diagnose',      input || {}),
    errorLog:       (slug, limit)                                => ipcRenderer.invoke('exam:errorLog',      { slug, limit }),
    appendError:    (slug, error)                                => ipcRenderer.invoke('exam:appendError',   { slug, error }),
    errorCounts:    (slug)                                       => ipcRenderer.invoke('exam:errorCounts',   { slug }),
    enterFinal:     (slug)                                       => ipcRenderer.invoke('exam:enterFinal',    { slug }),
    finalTasks:     (slug)                                       => ipcRenderer.invoke('exam:finalTasks',    { slug }),
    dailyFinal:     (slug, daysRemaining)                        => ipcRenderer.invoke('exam:dailyFinal',    { slug, daysRemaining }),
    finalState:     (slug)                                       => ipcRenderer.invoke('exam:finalState',    { slug }),
    judgeOpen:      (args)                                       => ipcRenderer.invoke('exam:judge-open',  args || {}),
  },
  // α18 · Final Compression Mode v0 (蓝图 §30) — 与上面 ptor.exam.enterFinal 并存。
  // 本 bridge 用 {ok, state|compressed} envelope + slug-scoped 状态文件,服务
  // screen-exam-dashboard.jsx ScopeBlock 之前的简洁触发栏。
  //   enter({slug, daysRemaining?, examType?})      → {ok, state} | {ok:false, error:'ALREADY_FINAL'|...}
  //   exit({slug})                                   → {ok, state}
  //   state({slug})                                  → {ok, state:{active, enteredAt?, exitedAt?, daysRemaining?, examType?}}
  //   compress({slug, fullScope})                    → {ok, compressed:{must, high_yield_top, dropped}}
  finalCompression: {
    enter:    (p) => ipcRenderer.invoke('final-compression:enter',    p || {}),
    exit:     (p) => ipcRenderer.invoke('final-compression:exit',     p || {}),
    state:    (p) => ipcRenderer.invoke('final-compression:state',    p || {}),
    compress: (p) => ipcRenderer.invoke('final-compression:compress', p || {}),
  },
  // W7.4 Cross-Spark + Thinking Tools (BLUEPRINT §14.2 / §14.3 + ROADMAP v2.3).
  //
  // 2026-05-16 consolidation: W7.4 generate / history / autoCreate kept as a
  // MOCK path (T6_STRONG dispatch + 6-step prompt) — prefer the β14
  // generateForConcept / listForConcept below, which is the archetype ×
  // persona-wisdom × cross-lesson production engine. New UI code MUST use the
  // ForConcept variants. The .listTools / .getTool / .recommendTool entries
  // bridge to the γ18 thinking-tools backend (NOT cross-spark) — accessible
  // via window.ptor.thinkingTools below, this aliasing is retained for
  // backward-compat of any extant caller.
  //   crossSpark.listTools()                                       → { ok, tools }   [legacy alias → thinkingTools.list]
  //   crossSpark.getTool(toolId)                                   → { ok, tool }    [legacy alias → thinkingTools.get]
  //   crossSpark.recommendTool(problem)                            → { ok, recommended }
  //   crossSpark.generate({ currentProblem, currentDomain?, slug? })→ { ok, spark }  [LEGACY MOCK — prefer generateForConcept]
  //   crossSpark.history(slug)                                     → { ok, history } [LEGACY MOCK]
  //   crossSpark.autoCreate(crossSparkResult, slug)                → { ok, sprouted, spark_id? } [LEGACY MOCK]
  crossSpark: {
    listTools:     ()                                             => ipcRenderer.invoke('thinkingtools:list'),
    getTool:       (toolId)                                       => ipcRenderer.invoke('thinkingtools:get',         { toolId }),
    recommendTool: (problem)                                      => ipcRenderer.invoke('thinkingtools:recommend',   { problem }),
    generate:      (args)                                         => ipcRenderer.invoke('crossspark:generate',       args || {}),
    history:       (slug)                                         => ipcRenderer.invoke('crossspark:history',        { slug }),
    autoCreate:    (crossSparkResult, slug)                       => ipcRenderer.invoke('crossspark:autoCreateSpark',{ crossSparkResult, slug }),
    // β14 Growth-System engine (archetype × persona-wisdom × cross-lesson) —
    // distinct IPC channel from W7.4 above. Keys renamed to avoid collision.
    generateForConcept: (payload)                                 => ipcRenderer.invoke('cross-spark:generate',      payload || {}),
    listForConcept:     (payload)                                 => ipcRenderer.invoke('cross-spark:list',          payload || {}),
  },
  // α16 Project Spine (Growth System §28 子组件 v0) — 跨课程持续追踪的项目骨架
  // 事件流。kind ∈ decision/hypothesis/open-question/building-on/revisit-later。
  // user-driven 记录工具, 非 LLM-derived。soft-delete via tombstone row。
  //   projectSpine.add({ slug, kind, content, sourceLessonIdx?, sourceLessonTitle?, tags? })
  //     → { ok:true, entry } | { ok:false, error: ENUM_CODE }
  //   projectSpine.list({ slug, limit?, kindFilter? })
  //     → { ok:true, entries }
  //   projectSpine.remove({ slug, entryId })
  //     → { ok:true, removed:true }
  projectSpine: {
    add:    (payload)                                             => ipcRenderer.invoke('project-spine:add',    payload || {}),
    list:   (payload)                                             => ipcRenderer.invoke('project-spine:list',   payload || {}),
    remove: (payload)                                             => ipcRenderer.invoke('project-spine:remove', payload || {}),
  },
  // β17 Judgment Gym (Growth System §28 子组件 v0, 2026-05-16) — 判断练习场。
  // 学习中遇到的 contestable claim 沉淀, 一段时间后让 user 在更冷的时间点
  // 重新判断一次, 记录前后判断 + 理由变化。Anti-LLM-hypnosis 训练场。
  // judgment ∈ agree/disagree/partial/unsure。append-only + aggregate-on-read。
  //   judgmentGym.add({ slug, claim, sourceLessonIdx?, sourceLessonTitle?, initialJudgment, initialReasoning?, topic? })
  //     → { ok:true, entry } | { ok:false, error: 'INVALID_JUDGMENT'|'CLAIM_TOO_LONG'|'MISSING_SLUG'|'EXCEPTION' }
  //   judgmentGym.listOpen({ slug, limit? })   → { ok:true, entries } — rejudgments.length === 0
  //   judgmentGym.listAll({ slug, limit? })    → { ok:true, entries } — 全部 (含 rejudgments)
  //   judgmentGym.rejudge({ slug, claimId, newJudgment, newReasoning? })
  //     → { ok:true, entry } | { ok:false, error: 'CLAIM_NOT_FOUND'|... }
  //   judgmentGym.get({ slug, claimId })       → { ok:true, entry } | { ok:false, error }
  //   judgmentGym.due({ slug, minAgeDays? })   → { ok:true, entries } — open & age > minAgeDays
  // γ18 Thinking Tools (Growth System §28 子组件 v0, 2026-05-16)
  //   thinkingTools.list()                              → { ok, tools }
  //   thinkingTools.get(toolId)                          → { ok, tool } | { ok:false, error }
  //   thinkingTools.invoke({slug, toolId, problem})      → { ok, invocation } — scaffold-filled + jsonl
  //   thinkingTools.listInvocations({slug, limit?})      → { ok, rows }
  thinkingTools: {
    list:            ()       => ipcRenderer.invoke('thinking-tools:list'),
    get:             (toolId) => ipcRenderer.invoke('thinking-tools:get', { toolId }),
    invoke:          (p)      => ipcRenderer.invoke('thinking-tools:invoke', p || {}),
    listInvocations: (p)      => ipcRenderer.invoke('thinking-tools:listInvocations', p || {}),
  },
  judgmentGym: {
    add:        (payload)                                         => ipcRenderer.invoke('judgment-gym:add',       payload || {}),
    listOpen:   (payload)                                         => ipcRenderer.invoke('judgment-gym:list-open', payload || {}),
    listAll:    (payload)                                         => ipcRenderer.invoke('judgment-gym:list-all',  payload || {}),
    rejudge:    (payload)                                         => ipcRenderer.invoke('judgment-gym:rejudge',   payload || {}),
    get:        (payload)                                         => ipcRenderer.invoke('judgment-gym:get',       payload || {}),
    due:        (payload)                                         => ipcRenderer.invoke('judgment-gym:due',       payload || {}),
  },
  // α19 Privacy Memory (Infrastructure §16 子组件 v0, 2026-05-16) — 决定不让
  // 出去的话。全局 surface (! per-slug), pattern × label × category 锁定后
  // scrub 会在任何外发 text 前用 `<redacted:label>` 替掉。case-insensitive
  // substring 替换, ! regex。log 文件 ! 记 pattern + ! 记 scrubbed text。
  //   privacyMemory.add({ pattern, label, category, notes? })
  //     → { ok:true, redaction } | { ok:false, error: 'INVALID_CATEGORY'|'MISSING_PATTERN'|'MISSING_LABEL'|'EXCEPTION' }
  //   privacyMemory.remove({ id })
  //     → { ok:true } | { ok:false, error: 'NOT_FOUND'|'EXCEPTION' }
  //   privacyMemory.list()
  //     → { ok:true, rows } — active only, tombstoned filtered
  //   privacyMemory.scrub({ text, dryRun? })
  //     → { ok:true, scrubbed, redactionCount, hits:[{label, count}] }
  //   privacyMemory.log({ limit? })
  //     → { ok:true, log:[{ ts, contextHint, redactionCount }] }
  privacyMemory: {
    add:    (p)      => ipcRenderer.invoke('privacy-memory:add',    p || {}),
    remove: (p)      => ipcRenderer.invoke('privacy-memory:remove', p || {}),
    list:   ()       => ipcRenderer.invoke('privacy-memory:list'),
    scrub:  (p)      => ipcRenderer.invoke('privacy-memory:scrub',  p || {}),
    log:    (p)      => ipcRenderer.invoke('privacy-memory:log',    p || {}),
  },
  // β20 Context Packer (Infrastructure §16 子组件 v0, 2026-05-16) — per-lesson
  // 显式 system-prompt token budget。priority-stack greedy pack: required 全注
  // + 余额按 priority ASC 贪婪 + 装不下截尾。char/3.7 近似 token。
  //   contextPacker.estimate(text)
  //     → { ok:true, tokens }
  //   contextPacker.pack({ budget, blocks, policy? })
  //     → { ok:true, decision:{ accepted, totalTokens, budget, overBudget, warnings } }
  //        | { ok:false, error: 'INVALID_BUDGET'|'INVALID_BLOCKS'|'INVALID_POLICY'|'EXCEPTION' }
  //   contextPacker.log({ slug, lessonIdx, budget, blocks, decision, ts? })
  //     → { ok:true } | { ok:false, error: 'MISSING_SLUG'|'EXCEPTION' }
  //   contextPacker.history({ slug, limit? })
  //     → { ok:true, rows } | { ok:false, error: 'MISSING_SLUG'|'EXCEPTION' }
  contextPacker: {
    estimate: (text) => ipcRenderer.invoke('context-packer:estimate', { text }),
    pack:     (p)    => ipcRenderer.invoke('context-packer:pack',     p || {}),
    log:      (p)    => ipcRenderer.invoke('context-packer:log',      p || {}),
    history:  (p)    => ipcRenderer.invoke('context-packer:history',  p || {}),
  },
  // α21 Cost Budget v0 (Infrastructure §16 子组件 v0, 2026-05-16) — per-curriculum
  // 月 budget 跟踪 + soft 警告 (90% warn / 100% over / 110% over-110).
  //   costBudget.set({ slug, budgetUSD })
  //     → { ok:true, budget } | { ok:false, error: 'MISSING_SLUG'|'INVALID_BUDGET'|'EXCEPTION' }
  //   costBudget.status({ slug, month? })
  //     → { ok:true, status:{ slug, month, budgetUSD, spentUSD, remainingUSD,
  //          percentUsed, state:'ok'|'warn-90'|'over-100'|'over-110'|'no-budget',
  //          callCount } }
  //        | { ok:false, error }
  //   costBudget.history({ slug, limit? })
  //     → { ok:true, rows:[{month, totalUSD, callCount}] } | { ok:false, error }
  //   costBudget.record({ slug, costUSD, provider, model, ts? })
  //     → { ok:true } | { ok:false, error: 'MISSING_SLUG'|'INVALID_COST'|'EXCEPTION' }
  costBudget: {
    set:     (p) => ipcRenderer.invoke('cost-budget:set',     p || {}),
    status:  (p) => ipcRenderer.invoke('cost-budget:status',  p || {}),
    history: (p) => ipcRenderer.invoke('cost-budget:history', p || {}),
    record:  (p) => ipcRenderer.invoke('cost-budget:record',  p || {}),
  },
  // α17 Book Router cache (Knowledge Source System §29 子组件 v0). Pure file-ops
  // cache keyed by sha256(file content) — avoids re-extracting same PDF/MD/URL
  // across curricula. Backend at `app/lib/sources/book-router-cache.js`.
  //   bookRouter.lookup({ sha256 })   → { ok, hit, extractedAt?, sourceMeta?, extractedText? }
  //   bookRouter.store({ sha256, filename, sourceType, mimeType, byteSize,
  //                      extractedText, sourceMeta })           → { ok, cacheKey }
  //   bookRouter.list({ limit? })                               → { ok, rows }
  //   bookRouter.purge({ sha256 })                              → { ok }
  bookRouter: {
    lookup: (payload)                                             => ipcRenderer.invoke('book-router:lookup', payload || {}),
    store:  (payload)                                             => ipcRenderer.invoke('book-router:store',  payload || {}),
    list:   (payload)                                             => ipcRenderer.invoke('book-router:list',   payload || {}),
    purge:  (payload)                                             => ipcRenderer.invoke('book-router:purge',  payload || {}),
  },
  // 2026-05-16 consolidation — alias β18 entropy + β19 artifact INSIDE ptor for
  // pattern consistency with cross-spark/project-spine/judgment-gym/etc.
  // Original top-level window.entropy + window.artifact preserved as legacy
  // surface; new callers should use window.ptor.entropy / window.ptor.artifact.
  entropy: {
    collectFragments:   (p) => ipcRenderer.invoke('entropy:collect-fragments', p || {}),
    listCanonical:      (p) => ipcRenderer.invoke('entropy:list-canonical',    p || {}),
    readCanonical:      (p) => ipcRenderer.invoke('entropy:read-canonical',    p || {}),
    writeCanonical:     (p) => ipcRenderer.invoke('entropy:write-canonical',   p || {}),
    deleteCanonical:    (p) => ipcRenderer.invoke('entropy:delete-canonical',  p || {}),
  },
  artifact: {
    create:     (p) => ipcRenderer.invoke('artifact:create',     p || {}),
    transition: (p) => ipcRenderer.invoke('artifact:transition', p || {}),
    list:       (p) => ipcRenderer.invoke('artifact:list',       p || {}),
    get:        (p) => ipcRenderer.invoke('artifact:get',        p || {}),
    delete:     (p) => ipcRenderer.invoke('artifact:delete',     p || {}),
  },
  // v1.0 boot-7 (2026-05-20) — Local-first telemetry bridge.
  //   getConsent / setConsent → profile.json.telemetry_consent (default false)
  //   export → opens save dialog, writes hypha-bug-report-<ts>.json locally
  //   health → { ok, score 0-1, counts }
  // No outbound network calls anywhere in the chain (audited).
  telemetry: {
    getConsent: ()         => ipcRenderer.invoke('telemetry:get-consent'),
    setConsent: (next)     => ipcRenderer.invoke('telemetry:set-consent', !!next),
    export:     ()         => ipcRenderer.invoke('telemetry:export'),
    health:     ()         => ipcRenderer.invoke('telemetry:health'),
  },
  // 阶 2 Socratic intake (2026-05-17) — 3-turn AI 反问 替代 8 砍掉表单字段。
  // Backend: app/lib/socratic-onboarding.js + main.js socratic:* IPC trio.
  // intentional-placeholder: auto-fire wire-up from curriculum:create →
  // socratic.start is intentionally deferred per阶 2 spec (agent 1 honest
  // gap surfaced 2026-05-17). The 3 socratic primitives are exposed here so
  // the renderer can call them manually; merging them into the curriculum-
  // create success flow is left to a future LessonChat surface pass, since
  // it requires UI design for the 3 inline chip-question turns BEFORE lesson
  // 0 streams. Until that ships, callers wire socratic.start/answer/finalize
  // directly from screen-onboarding.jsx onComplete handler if desired; the
  // backend remains usable without auto-fire.
  // Renderer flow: after curriculum:create returns ok, renderer calls
  // socratic.start, ask user the chip choices, then socratic.answer for each,
  // finally socratic.finalize to merge patches into state.json + agent.json.
  socratic: {
    start:    (payload) => ipcRenderer.invoke('socratic:start',    payload || {}),
    answer:   (payload) => ipcRenderer.invoke('socratic:answer',   payload || {}),
    finalize: (payload) => ipcRenderer.invoke('socratic:finalize', payload || {}),
  },
  // 阶 3 北极星 metric (2026-05-17) — concept lifecycle + 3-pillar metrics +
  // bandit-frontier next-lesson picker. Replaces工业 `lessons.length` as the
  // GROWTH-mode progress signal. Backend:
  //   app/lib/lesson-system/concept-lifecycle.js  (state-machine + jsonl)
  //   app/lib/growth/north-star-metrics.js        (3-pillar aggregator)
  //   app/lib/growth/bandit-frontier.js           (explore-exploit picker)
  conceptLifecycle: {
    add:        (payload) => ipcRenderer.invoke('concept-lifecycle:add',        payload || {}),
    transition: (payload) => ipcRenderer.invoke('concept-lifecycle:transition', payload || {}),
    list:       (payload) => ipcRenderer.invoke('concept-lifecycle:list',       payload || {}),
  },
  northStar: {
    get:        (payload) => ipcRenderer.invoke('north-star:get',               payload || {}),
  },
  banditFrontier: {
    pick:       (payload) => ipcRenderer.invoke('bandit-frontier:pick',         payload || {}),
  },
  // W7.4 Judgment Gym (BLUEPRINT §14.4). 5 exercise types: product_proposals /
  // agent_architectures / lessons / packs / explanations. Trains the metrics
  // standard / taste / tradeoff / judgment via paired comparison.
  //   judgment.createExercise(args)                               → { ok, exercise }
  //   judgment.submit(exerciseId, userJudgment, opts?)            → { ok, score, analysis, submission_id }
  //   judgment.history(slug)                                      → { ok, exercises, submissions, stats }
  judgment: {
    createExercise: (args)                                        => ipcRenderer.invoke('judgmentgym:create',  args || {}),
    submit:         (exerciseId, userJudgment, opts)              => ipcRenderer.invoke('judgmentgym:submit',  { exerciseId, userJudgment, ...(opts || {}) }),
    history:        (slug)                                        => ipcRenderer.invoke('judgmentgym:history', { slug }),
  },
  // W8.3 Adaptive UX Personal Forks (BLUEPRINT §20 v3.0). User-side UX
  // fork sub-layer; manuscript register invariants enforced server-side.
  //   ux.loadPrefs(slug?)                       → { ok, preferences, source }
  //   ux.updatePref(slug, key, value)           → { ok, preferences }
  //   ux.reset(slug?)                           → { ok, preferences }
  //   ux.forkPersona(basePersonaId, overrides)  → { ok, fork_id, file, base }
  //   ux.listForks()                            → { ok, forks }
  //   ux.deleteFork(forkId)                     → { ok }
  //   ux.validate(prefs)                        → { ok, reasons }
  //   ux.applySafely(prefs)                     → { ok, sanitized }
  //   ux.applyDensity(text, density)            → { ok, text }
  //   ux.applyLanguage(text, language)          → { ok, text }
  //   ux.applyCadenceIntensity(plan, intensity) → { ok, plan }
  ux: {
    loadPrefs:             (slug)                       => ipcRenderer.invoke('ux:loadPrefs',           { slug }),
    updatePref:            (slug, key, value)           => ipcRenderer.invoke('ux:updatePref',          { slug, key, value }),
    reset:                 (slug)                       => ipcRenderer.invoke('ux:reset',               { slug }),
    forkPersona:           (basePersonaId, overrides)   => ipcRenderer.invoke('ux:forkPersona',         { basePersonaId, overrides }),
    listForks:             ()                           => ipcRenderer.invoke('ux:listForks',           {}),
    deleteFork:            (forkId)                     => ipcRenderer.invoke('ux:deleteFork',          { forkId }),
    validate:              (prefs)                      => ipcRenderer.invoke('ux:validate',            { prefs }),
    applySafely:           (prefs)                      => ipcRenderer.invoke('ux:applySafely',         { prefs }),
    applyDensity:          (text, density)              => ipcRenderer.invoke('ux:applyDensity',        { text, density }),
    applyLanguage:         (text, language)             => ipcRenderer.invoke('ux:applyLanguage',       { text, language }),
    applyCadenceIntensity: (plan, intensity)            => ipcRenderer.invoke('ux:applyCadenceIntensity', { plan, intensity }),
  },
  // W8.4 Feedback Channel — BLUEPRINT §19.3. Voluntary user input → vault
  // ledger → non-cash rewards (额度 / 会员天数 / 徽章 / 称号). Anti-promise
  // hard contract: 不代表 IP / 收益 / 分红权.
  feedback: {
    submit:    (slug, payload)                  => ipcRenderer.invoke('feedback:submit',  { slug, ...(payload || {}) }),
    list:      (filter)                         => ipcRenderer.invoke('feedback:list',    { filter: filter || {} }),
    get:       (id)                             => ipcRenderer.invoke('feedback:get',     { id }),
    accept:    (id, rewardType, rewardAmount)   => ipcRenderer.invoke('feedback:accept',  { id, rewardType, rewardAmount }),
    rewards:   (userId)                         => ipcRenderer.invoke('feedback:rewards', { userId }),
    types:     ()                               => ipcRenderer.invoke('feedback:types'),
  },
  // W8.4 Donate — BLUEPRINT §19.2. Voluntary, non-cash perks only.
  // 不构成投资 / 不承诺现金回报 / 不参与分红 — verifyAntiPromise enforces copy.
  donate: {
    tiers:        ()                            => ipcRenderer.invoke('donate:tiers'),
    record:       (userId, amount, tier)        => ipcRenderer.invoke('donate:record',      { userId, amount, tier }),
    legal:        ()                            => ipcRenderer.invoke('donate:legal'),
    list:         (filter)                      => ipcRenderer.invoke('donate:list',        filter || {}),
    antiPromise:  (content)                     => ipcRenderer.invoke('donate:antiPromise', { content }),
  },
  // W8.4 Cost Budget Engine — BLUEPRINT §17.3. Per-lesson + per-tier
  // capability cap (T6/T4/T3). Sells goal-directed progress, not unlimited AI.
  cost: {
    budget:       (tier)                                  => ipcRenderer.invoke('cost:budget',      { tier }),
    record:       (slug, lessonIdx, capability, tokens)   => ipcRenderer.invoke('cost:record',      { slug, lessonIdx, capability, tokens }),
    remaining:    (slug, lessonIdx, tier)                 => ipcRenderer.invoke('cost:remaining',   { slug, lessonIdx, tier }),
    wouldExceed:  (slug, lessonIdx, capability, tier)     => ipcRenderer.invoke('cost:wouldExceed', { slug, lessonIdx, capability, tier }),
    report:       (slug, period)                          => ipcRenderer.invoke('cost:report',      { slug, period }),
    // V0.5 E1 — sqlite model_calls ledger with estimation_source breakdown.
    // Returns { rows, breakdown, total, accurate_cnt, estimate_cnt, missing_cnt, legacy_cnt }
    // so the UI can flag每行 honesty + show "(其中 N 估算, M 无数据)" footer.
    ledger:       (period, limit)                         => ipcRenderer.invoke('cost:ledger',      { period, limit }),
    // v0.5.0-bootstrap-3 — Pre-flight ¥ estimate per LLM turn. capability ∈
    // T6_STRONG / T4_JUDGE / T3_MID per the router classes; messages capped
    // at 100 items in main to bound predictor cost.
    predict:      (messages, capability, opts)            => ipcRenderer.invoke('cost:predict',     { messages, capability, opts }),
  },
  // β21 Mastery Engine v0 — per-concept understanding EWMA tracker.
  // 把散落学习信号 (correct/wrong/spontaneous-recall/failed-feynman 等) 聚合成 0-1 score。
  // !LLM, !auto-extract, !UI 本波。signal 枚举: correct | partial | wrong |
  // refused-to-engage | spontaneous-recall | failed-feynman.
  mastery: {
    record:        (p) => ipcRenderer.invoke('mastery:record',         p),
    score:         (p) => ipcRenderer.invoke('mastery:score',          p),
    list:          (p) => ipcRenderer.invoke('mastery:list',           p),
    low:           (p) => ipcRenderer.invoke('mastery:low',            p),
    signalHistory: (p) => ipcRenderer.invoke('mastery:signal-history', p),
  },
  // W8.4 Cashflow Shield — daily ¥ ceiling per tier. Anti-runaway against
  // misclick rapid-fire / agent infinite retry / system bug burning money.
  shield: {
    check:       (userId, tier)                           => ipcRenderer.invoke('shield:check',      { userId, tier }),
    enforce:     (userId, plannedCall)                    => ipcRenderer.invoke('shield:enforce',    { userId, plannedCall }),
    notifySoft:  (userId, tier)                           => ipcRenderer.invoke('shield:notifySoft', { userId, tier }),
  },
  // W8.2 Learning Commons Flywheel — Note → Spark → Pack → Commons → Lesson.
  // BLUEPRINT §20 v2.5. All four hops + cycle/health metric tuple.
  flywheel: {
    evalNote:                 (slug, notePath)           => ipcRenderer.invoke('flywheel:eval:note',                  { slug, notePath }),
    proposeNoteToSpark:       (slug, notePath, opts)     => ipcRenderer.invoke('flywheel:propose:noteToSpark',        { slug, notePath, opts: opts || {} }),
    batchNoteToSpark:         (slug)                     => ipcRenderer.invoke('flywheel:batch:noteToSpark',          { slug }),
    evalSparkCluster:         (slug, sparkIds)           => ipcRenderer.invoke('flywheel:eval:sparkCluster',          { slug, sparkIds: sparkIds || [] }),
    proposeSparkToPack:       (slug, sparkIds)           => ipcRenderer.invoke('flywheel:propose:sparkToPack',        { slug, sparkIds: sparkIds || [] }),
    proposeBlueprintTemplate: (slug)                     => ipcRenderer.invoke('flywheel:propose:blueprintTemplate',  { slug }),
    proposeBookPackPublic:    (bookId, slug)             => ipcRenderer.invoke('flywheel:propose:bookSparkPackPublic',{ bookId, slug }),
    publishToCommons:         (pack, options)            => ipcRenderer.invoke('flywheel:publish:packToCommons',      { pack, options: options || {} }),
    listStaged:               ()                         => ipcRenderer.invoke('flywheel:listStaged'),
    unstage:                  (packId)                   => ipcRenderer.invoke('flywheel:unstage',                    { packId }),
    findCommons:              (slug, lessonTopic, opts)  => ipcRenderer.invoke('flywheel:findCommonsForLesson',       { slug, lessonTopic, opts: opts || {} }),
    injectCommons:            (lessonContext, packs)     => ipcRenderer.invoke('flywheel:injectCommons',              { lessonContext: lessonContext || {}, packs: packs || [] }),
    cycle:                    (slug, opts)               => ipcRenderer.invoke('flywheel:cycle',                      { slug, opts: opts || {} }),
    health:                   (slug, opts)               => ipcRenderer.invoke('flywheel:health',                     { slug, opts: opts || {} }),
  },
  // W8.1 Launch Readiness (BLUEPRINT §20 v2.4). Read-only pre-flight surface
  // that integrates W1-W7 modules:
  //   launch.checklist()           → 20-item §20 v2.4 capability gate
  //   launch.verify()              → cross-W1→W7 dependency-chain check
  //   launch.antiPromise(content)  → scan free-text for §20 banned promises
  //   launch.fullReport()          → composed envelope (matches CLI shape)
  launch: {
    checklist:    ()        => ipcRenderer.invoke('launch:checklist'),
    verify:       ()        => ipcRenderer.invoke('launch:verify'),
    antiPromise:  (content) => ipcRenderer.invoke('launch:antiPromise', { content: content || '' }),
    fullReport:   ()        => ipcRenderer.invoke('launch:fullReport'),
  },
  // v0.4 anti-slop — pure-JS detectors callable from renderer for now;
  // v0.4 integration will wire them into agent.js streamTurn finally block.
  antiSlop: {
    detectConfidenceLeak: (text, context) =>
      ipcRenderer.invoke('anti-slop:detect-confidence-leak', { text, context: context || {} }),
    // verifyCitations(slug, text, options?) → { ok, verifications, summary }.
    // Trigram-Jaccard match of every quoted span in `text` against
    // vault/<slug>/sources.json. summary.unverified > 0 = LLM may have
    // fabricated a quote.
    verifyCitations: (slug, text, options) =>
      ipcRenderer.invoke('anti-slop:verify-citations', { slug, text, options: options || {} }),
    // verifyPedagogy(text) → { ok, claims, summary }.
    // Pedagogy-Claim Detector — finds `P[1-6]` / `F[1-3]` ID references and
    // primitive-name mentions (cue-retrieval / productive failure / etc),
    // jaccard-matches surrounding 100-char context against pedagogy.md
    // primitive defs. summary = { total, consistent, loose, inconsistent,
    // unknown }. unknown > 0 OR inconsistent > 0 = LLM may have fabricated
    // a pedagogy justification.
    verifyPedagogy: (text) =>
      ipcRenderer.invoke('anti-slop:verify-pedagogy', { text }),
    // Machino-β8 (2026-05-15) — bridge for post-stream anti-slop scan signal.
    // Machino-α8 owns the emit side (streamTurn finally block emits an
    // 'anti-slop:scan-complete' IPC event with the signal envelope). β8 owns
    // the listen side. We register here pre-emptively so that if α8 ships
    // mid-session the Trust Panel picks the event up without renderer reload.
    // If α8 changes the channel name later, swap this string and the main.js
    // emitter together; the renderer-side API surface stays stable.
    onScanComplete: (cb) => {
      const handler = (e, payload) => { try { cb(e, payload); } catch (_) {} };
      ipcRenderer.on('anti-slop:scan-complete', handler);
      return () => {
        try { ipcRenderer.removeListener('anti-slop:scan-complete', handler); } catch (_) {}
      };
    },
    // v0.4.9 (2026-05-19) — force-rewrite bypassing archetype gate. User-
    // initiated via Trust Panel "请求强制改写". Triggers full PJR pipeline
    // (T6_STRONG, ~¥0.5/call). Cost-shield gate is UI-side confirm() in
    // course-trust-panel.jsx — backend trusts the IPC call when invoked.
    forceRewrite: (slug, lessonIdx) => ipcRenderer.invoke('anti-slop:force-rewrite', { slug, lessonIdx }),
    costSummary: (slug) => ipcRenderer.invoke('anti-slop:cost-summary', { slug: slug || null }),
    // v0.4.12 — cross-lesson concept ledger (no LLM). Returns
    // { ok, ledger: { totalLessons, totalConceptInstances, totalUniqueConcepts,
    //   crossLessonReuse:[{term, lessons:[...]}], firstSeen, lessonsCovered } }.
    conceptLedger: (slug) => ipcRenderer.invoke('anti-slop:concept-ledger', { slug }),
    // v0.4.14 boot-8 — JSONL-backed concept ledger drift + consistency score.
    // detectDrift returns concepts whose definitions diverge across lessons;
    // consistencyScore returns 0..1 across multi-lesson concepts. See
    // app/lib/anti-slop/concept-ledger.js.
    conceptLedgerDetectDrift: (slug) => ipcRenderer.invoke('concept-ledger:detect-drift', { slug }),
    conceptLedgerConsistencyScore: (slug) => ipcRenderer.invoke('concept-ledger:consistency-score', { slug }),
    // v0.4.13 — Track A/B Exit Ramp MVP. At /finish boundary, renderer calls
    // trackSetExitRamp with the user's choice (A ship / B publish / skip).
    // trackGetStatus returns aggregated counts + per-lesson grouping for
    // surfacing in Course Trust Panel / SetAsideList. URL-validation harness
    // defers to v0.5+. See specs/track-a-b-social-sandbox.md.
    trackSetExitRamp: (slug, lessonIdx, track, artifactUrl, commitmentNote) =>
      ipcRenderer.invoke('track:set-exit-ramp', { slug, lessonIdx, track, artifactUrl, commitmentNote }),
    trackGetStatus: (slug) => ipcRenderer.invoke('track:get-status', { slug }),
    // v0.5.0-bootstrap — Knowledge Contamination Graph (Anti-Slop P2). Walks
    // source-failure DAG to mark downstream lessons quarantined. Backend lib
    // (./lib/anti-slop/contamination-graph) ships in parallel; until it lands
    // the IPC returns a `lib-not-ready` stub graph so the UI can wire up.
    contaminationGraph: (slug) => ipcRenderer.invoke('anti-slop:contamination-graph', { slug }),
  },
  // v0.5.0-bootstrap — Track A/B v0.5.0 URL validation surfaces. pingUrl
  // fetches link metadata (title / og:image / status_code) for Track B
  // artifact verification. validationMass aggregates engagement signals
  // (comments / shares / views / reactions) from exit-ramps.jsonl into a
  // composite score that drives the "pushback digest" loop.
  track: {
    pingUrl: (url) => ipcRenderer.invoke('track:ping-url', { url }),
    validationMass: (slug) => ipcRenderer.invoke('track:validation-mass', { slug }),
  },
  // v0.5.0-bootstrap — Commons MVP v0.5. Kebab IPC namespace
  // (commons:list-packs / commons:load-pack) is the NEW v0.5+ pack surface
  // backed by ./lib/commons/pack-loader; distinct from the legacy v0.4
  // camelCase channels (commons:listPacks / installPack) which stay wired
  // for the existing community pack flow.
  commons: {
    listPacks: () => ipcRenderer.invoke('commons:list-packs'),
    loadPack: (packId) => ipcRenderer.invoke('commons:load-pack', { packId }),
  },
  // v0.5.0-bootstrap — Companion v0.1 (Myco 菌类星人). mycoState returns the
  // companion's current tone / expression / boundary status for the given
  // course slug. Backend lib (./lib/companion/myco-state) ships in parallel.
  // v0.5.0-bootstrap-3: composeExpression bridges emotion-state → tone-engine
  // for a single boundary-aware fire (suppressed=true when cooldown/budget).
  companion: {
    mycoState: (slug) => ipcRenderer.invoke('companion:myco-state', { slug }),
    composeExpression: (trigger, sessionContext) => ipcRenderer.invoke('companion:compose-expression', { trigger, sessionContext }),
  },
  // v0.5.0-bootstrap-3 — Pricing v3 loyalty engine. queryTier reads global
  // vault/data/profile.json (no slug); setFounderPurchase atomically writes
  // the Founders timestamp so the discount curve can compute years_since.
  pricing: {
    queryTier: () => ipcRenderer.invoke('pricing:query-tier'),
    // v0.5.0-bootstrap-6 — setFounderPurchase now requires a verified
    // intent_id from the payment rails. Calling shape:
    //   await ptor.hypha.pricing.setFounderPurchase({ intent_id, ts? })
    // ts is optional + advisory only (paid_at from rails wins).
    setFounderPurchase: (args) => {
      // Back-compat: callers passing a bare ISO string get a clear error,
      // not a silent free-Founders flip.
      if (typeof args === 'string') {
        return Promise.resolve({
          ok: false,
          code: 'PAYMENT_NOT_VERIFIED',
          error: 'setFounderPurchase now requires { intent_id, ts? } — use createPayment + verifyPayment first',
        });
      }
      return ipcRenderer.invoke('pricing:set-founder-purchase', args || {});
    },
    createPayment: (args) => ipcRenderer.invoke('pricing:create-payment', args || {}),
    verifyPayment: (intent_id) => ipcRenderer.invoke('pricing:verify-payment', { intent_id }),
    listProviders: () => ipcRenderer.invoke('pricing:list-providers'),
  },
  // v0.4.7 (2026-05-19) — Hypha Learn state-machine pure-function bridge.
  // Single canonical pacing validator (replaces inline duplicate in
  // screen-lesson-chat.jsx). Sync exposure; no IPC roundtrip.
  stateMachine: {
    detectPacingViolations: (history, opts) => _hyphaStateMachine.detectPacingViolations(history, opts),
    STATES: { ..._hyphaStateMachine.STATES },
    STATE_LABELS: { ..._hyphaStateMachine.STATE_LABELS },
    TRANSITIONS: JSON.parse(JSON.stringify(_hyphaStateMachine.TRANSITIONS)),
  },
  util: {
    formatRelativeTime: (ts, opts) => _hyphaRelativeTime.formatRelativeTime(ts, opts),
  },
  // v2-push B1+B2+B3 bridges (2026-05-21). 18 surfaces wired to IPC handlers
  // appended after frontier:status in main.js. Grouped under ptor.v2 so
  // existing namespaces stay untouched.
  v2: {
    companion: {
      coherenceTrend: (args) => ipcRenderer.invoke('companion:coherence-trend', args || {}),
      coherenceLog:   (args) => ipcRenderer.invoke('companion:coherence-log',   args || {}),
    },
    growth: {
      crossSparkStrength: (snippet_a, snippet_b) =>
        ipcRenderer.invoke('growth:cross-spark-strength', { snippet_a, snippet_b }),
      northStarAlert: (args) => ipcRenderer.invoke('growth:north-star-alert', args || {}),
    },
    exam: {
      scopeShrink: (args) => ipcRenderer.invoke('exam:scope-shrink', args || {}),
      judge4Axis:  (args) => ipcRenderer.invoke('exam:judge-4axis',  args || {}),
    },
    commons: {
      lifecycleTransition: (args) => ipcRenderer.invoke('commons:lifecycle-transition', args || {}),
      licenseValidate:     (args) => ipcRenderer.invoke('commons:license-validate',     args || {}),
    },
    creation: {
      dependencyGraphList:     (args) => ipcRenderer.invoke('creation:dependency-graph-list',     args || {}),
      dependencyCascadeEvents: (args) => ipcRenderer.invoke('creation:dependency-cascade-events', args || {}),
    },
    infra: {
      costPreflight:         (args) => ipcRenderer.invoke('infra:cost-preflight',          args || {}),
      lifetimeMonthlyRollup: (args) => ipcRenderer.invoke('infra:lifetime-monthly-rollup', args || {}),
      routerEventsTail:      (args) => ipcRenderer.invoke('infra:router-events-tail',      args || {}),
    },
    coldStart: {
      getPlaybook:     (args) => ipcRenderer.invoke('cold-start:get-playbook',     args || {}),
      classifyPersona: (args) => ipcRenderer.invoke('cold-start:classify-persona', args || {}),
    },
    note: {
      atlasEntropyBadge: (args) => ipcRenderer.invoke('note:atlas-entropy-badge', args || {}),
      atlasDecay:        (args) => ipcRenderer.invoke('note:atlas-decay',         args || {}),
    },
    goal: {
      feasibilityWithConfidence: (args) => ipcRenderer.invoke('goal:feasibility-with-confidence', args || {}),
    },
  },
});
