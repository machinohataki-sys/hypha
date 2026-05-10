/* global React, Brand, Watercolor, Icon, CourseTrustPanel */
// HYPHA · v0.3 LessonChat — interactive 8-state chat surface
//
// Replaces screen-lesson.jsx's static skeleton + textarea-submit model with
// turn-by-turn Socratic teaching driven by the existing state-machine in
// app/lib/hypha-learn/. Per BLUEPRINT §6.1 (12-field schema covered THROUGH
// chat turns) + §8.1 Cadence (Generate→Learn→ExplainBack→ActionProof→...).
//
// IPC bridges used:
//   window.ptor.llm.lesson(args)              — request a lesson turn (preload.js:156)
//   window.ptor.llm.onDeepenProgress(cb)      — chunk stream listener (preload.js:162)
//   window.ptor.llm.lessonAbort(requestId)    — cancel in-flight turn
//   window.ptor.llm.lessonSessions(rel)       — list prior sessions
//   window.ptor.llm.lessonContinueFrom(...)   — fork a session (unused in C-1, reserved)
//   window.ptor.hypha.curriculumCreate(topic, level, opts) — auto-create
//                                              curriculum on first turn when
//                                              onboarding payload lacks noteRel
//   window.hypha.scoreMicroProof              — trust stack per-turn
//   window.hypha.computePersonaCoherence      — trust stack per-turn
//   window.hypha.generateConfession           — trust stack post-session
//   window.hypha.auditableSummary             — trust stack post-session
//
// Bridges are dual: window.ptor.* is legacy chat infra (stable, shipped pre-v0.1);
// window.hypha.* is v0.1+ trust stack. v0.4 consolidation deferred (out of scope).

const { useState, useEffect, useRef, useCallback, useMemo } = React;

// =====================================================================
// Mirrored from app/lib/hypha-learn/state-machine.js
// (CommonJS module unloadable in Electron renderer w/ context isolation;
// keep regex + labels in sync. Last sync: 2026-05-08.)
// =====================================================================

const STATES = {
  HOOK: 'HOOK', EXPOSE: 'EXPOSE', EXPOSE_PRIME: 'EXPOSE_PRIME',
  VERIFY: 'VERIFY', EXTEND: 'EXTEND', CONNECT: 'CONNECT',
  LATCH: 'LATCH', END: 'END',
};

const STATE_LABELS = {
  HOOK:         '— 引子 —',
  EXPOSE:       '— 探查 —',
  EXPOSE_PRIME: '— 再探 —',
  VERIFY:       '— 校核 —',
  EXTEND:       '— 延展 —',
  CONNECT:      '— 串联 —',
  LATCH:        '— 收纳 —',
  END:          '',
};

// MIRROR-INVARIANT: keep byte-identical with state-machine.js:52-54.
// On any drift, run `node app/scripts/check-regex-mirror.cjs` (CI-friendly,
// exits 1 on diff) — added 2026-05-08 per MEOW Gate A Patch 3.
const STATE_TAG_RE = /<!--\s*state\s*:\s*([A-Za-z_]+)\s*-->/gi;
const NEXT_TAG_RE  = /<!--\s*next\s*:\s*([A-Za-z_]+)\s*-->/gi;
const STRIP_TAG_RE = /<!--\s*(?:state|next)\s*:\s*[A-Za-z_]+\s*-->/gi;

function _normalize(name) {
  if (!name || typeof name !== 'string') return null;
  const upper = name.trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(STATES, upper) ? upper : null;
}

function _findLast(text, re) {
  if (!text || typeof text !== 'string') return null;
  re.lastIndex = 0;
  let last = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    last = m[1];
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return last;
}

function parseStateMarker(text) {
  return {
    state: _normalize(_findLast(text, STATE_TAG_RE)),
    next:  _normalize(_findLast(text, NEXT_TAG_RE)),
  };
}

function stripStateMarkers(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(STRIP_TAG_RE, '');
}

// =====================================================================
// PageFrame — duplicated from screen-lesson.jsx (will dedupe in v0.4).
// =====================================================================

const HealthBadge = () => {
  const [health, setHealth] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!window.hypha || typeof window.hypha.getProviderHealth !== 'function') return undefined;
    let alive = true;
    const tick = async () => {
      try {
        const r = await window.hypha.getProviderHealth();
        if (alive && r && r.ok) setHealth(r.report);
      } catch (_) { /* leave stale snapshot */ }
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  if (!health) return null;
  const states = Object.values(health).map(h => h.state);
  const anyDegraded = states.some(s => s === 'degraded');
  const allHealthy = states.every(s => s === 'healthy');
  const dotColor = anyDegraded ? 'var(--terracotta-2)' : (allHealthy ? '#789563' : '#c89c3e');
  const summary = anyDegraded ? 'A provider is offline' : (allHealthy ? 'All providers healthy' : 'Recovering');
  return (
    <div style={{ position: 'relative', marginRight: 14, lineHeight: 0 }}
         onClick={() => setOpen(o => !o)} title={summary}>
      <div style={{ width: 9, height: 9, borderRadius: '50%', background: dotColor,
                    boxShadow: '0 0 0 1.5px rgba(255,255,255,.7)', cursor: 'default' }} />
      {open && (
        <div className="card-quiet" style={{
          position: 'absolute', top: 18, right: -4, padding: '10px 14px',
          fontSize: 11, minWidth: 220, zIndex: 10, lineHeight: 1.4,
        }}>
          <div className="t-small mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em', marginBottom: 6 }}>
            llm router
          </div>
          {Object.entries(health).map(([id, h]) => {
            const c = h.state === 'healthy' ? '#789563'
                    : h.state === 'degraded' ? 'var(--terracotta-2)' : '#c89c3e';
            return (
              <div key={id} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', color: 'var(--ink-2)' }}>
                <span>{id.replace('-direct', '')}</span>
                <span style={{ color: c }}>{h.state}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const PageFrame = ({ children, onBack, harnessResult, onDeepAuditRequested, slug, lessonIdx }) => (
  <div className="fade-in" style={{
    minHeight: "100vh", padding: "40px 60px 80px",
    position: "relative", overflow: "hidden",
  }}>
    <div style={{
      position: "absolute", top: -120, right: -200,
      width: 700, height: 500, opacity: 0.4,
      pointerEvents: "none", zIndex: 0,
    }}>
      <Watercolor.Wash tone="ochre" />
    </div>
    <div className="row" style={{ marginBottom: 32, position: "relative", zIndex: 2, alignItems: "center" }}>
      <Brand />
      <span className="spacer" />
      {typeof CourseTrustPanel === 'function' && (
        <CourseTrustPanel harnessResult={harnessResult} onDeepAuditRequested={onDeepAuditRequested} slug={slug} lessonIdx={lessonIdx} />
      )}
      <HealthBadge />
      {onBack && (
        <button onClick={onBack} className="row gap-8 btn btn-ghost" style={{ fontSize: 13 }}>
          <Icon name="arrowL" size={13} /> Back to home
        </button>
      )}
    </div>
    <div className="col" style={{ maxWidth: 760, margin: "0 auto", position: "relative", zIndex: 2 }}>
      {children}
    </div>
  </div>
);

// =====================================================================
// ChainHeader — Phase C-4 chain-progress data binding (2026-05-08).
//
// Reads vault state to surface "Chain: <ultimate goal> · Link iii of vi ·
// Lesson 14 of 50 · <role>" inline above the transcript. Defensive: every
// vault read can fail or return null, every field can be missing — render
// progressively. If noteRel is null (fresh-start path), render minimal
// label-only header. If chain.json is absent (single curriculum, no chain),
// omit the chain row + only show "Lesson N · <goalLabel>".
//
// Data sources:
//   vault/<slug>/chain.json           — chain.links[] + ultimate_goal
//   vault/<slug>/links-state.json     — per-link {idx, slug, status, role}
//   noteRel (<slug>/lesson-NN.md)     — lesson_idx + total_lessons via fm
// =====================================================================

const ROLE_TONE = {
  prerequisite: 'chip-mono',
  core:         'chip-mono',
  ultimate:     'chip-mono',
};
const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii'];

const ChainHeader = ({ goal, noteRel, lessonBody }) => {
  const [chainData, setChainData] = useState(null);
  const [linksState, setLinksState] = useState(null);
  const [lessonFm, setLessonFm] = useState(null);

  useEffect(() => {
    if (!noteRel || !window.ptor || !window.ptor.vault || typeof window.ptor.vault.read !== 'function') return;
    let alive = true;
    const load = async () => {
      try {
        const slug = String(noteRel).split(/[\\/]/)[0];
        if (!slug) return;
        const [note, chainResp, linksResp] = await Promise.all([
          window.ptor.vault.read(noteRel).catch(() => null),
          window.ptor.vault.read(`${slug}/chain.json`).catch(() => null),
          window.ptor.vault.read(`${slug}/links-state.json`).catch(() => null),
        ]);
        if (!alive) return;
        if (note && note.frontmatter) setLessonFm(note.frontmatter);
        if (chainResp && chainResp.body) {
          try { setChainData(JSON.parse(chainResp.body)); } catch (_) { /* malformed json — silently skip */ }
        }
        if (linksResp && linksResp.body) {
          try { setLinksState(JSON.parse(linksResp.body)); } catch (_) { /* same */ }
        }
      } catch (_) { /* header is decorative — never block chat */ }
    };
    load();
    return () => { alive = false; };
  }, [noteRel]);

  // Progressive derivation — null/undefined-tolerant.
  const goalLabel = (chainData && chainData.ultimate_goal)
    || (goal && goal.goalContract && goal.goalContract.north_star_goal)
    || 'Lesson';
  const lessonIdx = (lessonFm && Number.isFinite(Number(lessonFm.lesson_idx))) ? Number(lessonFm.lesson_idx) : null;
  const totalLessons = (lessonFm && Number.isFinite(Number(lessonFm.total_lessons))) ? Number(lessonFm.total_lessons) : null;

  const links = (linksState && Array.isArray(linksState.links)) ? linksState.links
    : (chainData && chainData.chain && Array.isArray(chainData.chain.links)) ? chainData.chain.links
    : null;
  const totalLinks = links ? links.length : null;
  const activeLinkIdx = (links || []).findIndex(l => l && l.status === 'active');
  const linkIdx = (activeLinkIdx >= 0) ? activeLinkIdx : null;
  const linkRole = (linkIdx !== null && links && links[linkIdx]) ? String(links[linkIdx].role || '').toLowerCase() : null;
  const inChain = totalLinks !== null && totalLinks > 0;
  const foldStatus = chainData && chainData.fold && chainData.fold.status;
  const foldRerouteWarning = foldStatus === 'NEEDS_REROUTE';

  // v0.2 Surface Finishing B3 (2026-05-08, Machino-A) — thesis-as-prep-evidence.
  // When the pre-lesson body artifact (vault/<slug>/lesson-N.body.json) carries
  // a non-empty thesis field, surface it as the topmost editorial line so the
  // user SEES the tutor "did its prep" before any chat begins. Falls through
  // silently for legacy lessons (body absent / thesis empty / IPC unavailable).
  // Register: t-tiny mono lead in ink-3 + serif italic body in ink — matches
  // the manuscript register established by goalLabel below; NOT a panel/badge.
  const thesisText = (lessonBody && typeof lessonBody.thesis === 'string') ? lessonBody.thesis.trim() : '';

  return (
    <div className="col gap-6" style={{ marginBottom: 24, paddingBottom: 16, borderBottom: '1px solid var(--rule-soft)' }}>
      {thesisText && (
        <div className="col gap-4" style={{ marginBottom: 6 }}>
          <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.08em' }}>
            今天这一课只回答 —
          </div>
          <div className="serif italic" style={{ fontSize: 18, lineHeight: 1.45, color: 'var(--ink)' }}>
            {thesisText}
          </div>
        </div>
      )}
      <div className="row gap-12" style={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
        <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.08em' }}>LESSON · CHAT</div>
        {foldRerouteWarning && (
          <span className="chip chip-mono" style={{ color: 'var(--terracotta-2)', letterSpacing: '.06em' }}>
            chain too broad · suggests reroute
          </span>
        )}
      </div>
      <div className="serif italic" style={{ fontSize: 17, lineHeight: 1.4, color: 'var(--ink-2)' }}>
        {goalLabel}
      </div>
      <div className="row gap-12 t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em', flexWrap: 'wrap' }}>
        {/* v0.3.1 Patch 6: humanize chain header. "Link iii of vi · prerequisite"
            became "第 3 节 / 共 6 节  ·  基础课". Roman numerals + role enum
            were dev jargon — learner-readable copy now. */}
        {inChain && linkIdx !== null && (
          <span>第 {linkIdx + 1} 节 / 共 {totalLinks} 节</span>
        )}
        {lessonIdx !== null && (
          <span>本节进度 {lessonIdx + 1}{totalLessons ? ` / ${totalLessons}` : ''}</span>
        )}
        {linkRole && (
          <span className={`chip ${ROLE_TONE[linkRole] || 'chip-mono'}`} style={{ letterSpacing: '.06em' }}>
            {linkRole === 'prerequisite' ? '基础课' : linkRole === 'core' ? '深入课' : linkRole === 'ultimate' ? '目标课' : linkRole}
          </span>
        )}
        {noteRel && !inChain && lessonIdx === null && (
          <span>{noteRel}</span>
        )}
      </div>
    </div>
  );
};

// =====================================================================
// ChatBubble — assistant: serif italic on cream card; user: mono small;
// system: dimmer mono. State chip ABOVE assistant body when present.
// =====================================================================

// v0.3.1 Patch 2: STATE_TOOLTIPS — explanatory hover text for the otherwise
// opaque pedagogy labels. Surfaces what each phase actually does so the
// learner can read the chip as a guide, not as jargon.
const STATE_TOOLTIPS = {
  HOOK:         '老师在抛出一个具体问题, 把抽象主题落到能看见的东西',
  EXPOSE:       '老师在用提问探探你已知什么, 不直接讲',
  EXPOSE_PRIME: '上次答得没到位, 老师换个角度再问一次',
  VERIFY:       '老师在测你是不是真懂 — 看回答有没有正命中',
  EXTEND:       '你过了校核, 老师把概念延展到更难一层',
  CONNECT:      '把这节学到的和你已知的串起来',
  LATCH:        '抓住一个关键点, 准备进下一节',
  END:          '本节结束',
};

const ChatBubble = ({ role, text, state, streaming, onAbort }) => {
  const visible = stripStateMarkers(text || '');
  if (role === 'assistant') {
    return (
      <div className="col gap-6" style={{ marginBottom: 18 }}>
        {state && STATE_LABELS[state] && (
          // v0.3.1 Patch 2: state chip with explanatory tooltip on hover.
          // Pedagogy terms ("探查" / "校核") are opaque on first sight; the
          // tooltip surfaces what the chat is doing in plain language.
          <div
            className="t-tiny mono"
            style={{ color: 'var(--ink-3)', letterSpacing: '.08em', cursor: 'help' }}
            title={STATE_TOOLTIPS[state] || ''}
          >
            {STATE_LABELS[state]}
          </div>
        )}
        <div className="card-quiet" style={{ padding: '16px 20px' }}>
          <div className="serif" style={{ fontSize: 15, lineHeight: 1.65, color: 'var(--ink)', whiteSpace: 'pre-wrap' }}>
            {visible}
            {streaming && (
              <>
                <span style={{ opacity: 0.35 }}> ▍</span>
                {/* v0.3.1 Patch 7: inline abort button. Clicking calls the
                    parent-supplied onAbort to cancel the in-flight stream. */}
                {typeof onAbort === 'function' && (
                  <button
                    onClick={onAbort}
                    className="btn btn-ghost"
                    style={{ marginLeft: 12, fontSize: 11, padding: '2px 10px', verticalAlign: 'middle' }}
                  >
                    停止
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    );
  }
  if (role === 'user') {
    return (
      <div className="col gap-4" style={{ marginBottom: 18, alignItems: 'flex-end' }}>
        <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.08em' }}>YOU</div>
        <div style={{
          padding: '12px 16px', maxWidth: '78%',
          background: 'var(--cream)', borderRadius: 4,
          border: '1px solid var(--rule-soft)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 13, lineHeight: 1.55, color: 'var(--ink)',
          whiteSpace: 'pre-wrap',
        }}>{visible}</div>
      </div>
    );
  }
  // system
  return (
    <div className="col gap-4" style={{ marginBottom: 14 }}>
      <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.08em' }}>SYSTEM</div>
      <div className="serif italic" style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--ink-2)' }}>
        {visible}
      </div>
    </div>
  );
};

const TranscriptList = ({ turns, streamingTurnId, currentStreamState, onAbort }) => (
  <div className="col">
    {turns.map(t => (
      <ChatBubble
        key={t.id}
        role={t.role}
        text={t.text}
        state={t.role === 'assistant' ? (t.id === streamingTurnId ? currentStreamState : t.state) : null}
        streaming={t.id === streamingTurnId}
        onAbort={t.id === streamingTurnId ? onAbort : undefined}
      />
    ))}
  </div>
);

// =====================================================================
// Composer — textarea + submit. Slash commands intercepted before submit.
// =====================================================================

const Composer = ({ onSubmit, onAbort, disabled, streaming }) => {
  const [draft, setDraft] = useState('');
  const ref = useRef(null);

  const handleSubmit = useCallback(() => {
    const txt = draft.trim();
    if (!txt) return;
    onSubmit(txt);
    setDraft('');
  }, [draft, onSubmit]);

  const handleKey = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="col gap-8" style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--rule-soft)' }}>
      <textarea
        ref={ref}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={handleKey}
        rows={3}
        disabled={disabled}
        placeholder="Ask, answer, or type /help…   (Ctrl+Enter to send)"
        className="mono"
        style={{
          width: '100%', padding: '12px 14px',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 13, lineHeight: 1.55,
          color: 'var(--ink)', background: 'var(--cream)',
          border: '1px solid var(--rule-soft)', borderRadius: 4,
          resize: 'vertical', boxSizing: 'border-box',
        }}
      />
      <div className="row gap-12">
        {streaming ? (
          <button onClick={onAbort} className="btn btn-ghost row gap-8" style={{ fontSize: 13 }}>
            <Icon name="x" size={13} /> Stop
          </button>
        ) : (
          <button onClick={handleSubmit} disabled={disabled || !draft.trim()}
                  className="btn btn-primary row gap-8"
                  style={{ opacity: (!disabled && draft.trim()) ? 1 : 0.4 }}>
            <Icon name="sparkle" size={13} /> Send
          </button>
        )}
      </div>
    </div>
  );
};

// =====================================================================
// Trust stack fan-out helpers — defensive, silent on failure.
// =====================================================================

function _synthPseudoPlan(goal) {
  const gc = (goal && goal.goalContract) || {};
  return {
    objective: gc.north_star_goal || 'Make progress on the learning goal.',
    micro_proof: {
      stimulus: 'Self-explain in your own words.',
      expected_signal: 'Original prose pointing at concrete instance, not paraphrased model output.',
      fail_mode: 'Verbatim paraphrase of assistant text.',
    },
    path: [],
  };
}

async function _fanOutPerTurn({ goal, lastUserMsg, recentAssistantMessages, lastAssistantText }) {
  if (!window.hypha) return null;
  const pseudoPlan = _synthPseudoPlan(goal);
  const out = { score: null, persona: null };
  try {
    if (typeof window.hypha.scoreMicroProof === 'function' && lastUserMsg) {
      const r = await window.hypha.scoreMicroProof({
        plan: pseudoPlan,
        response: lastUserMsg,
        recentAssistantMessages,
      });
      if (r && r.ok) out.score = r.result;
    }
  } catch (_) { /* trust stack failure must not block teaching */ }
  try {
    if (typeof window.hypha.computePersonaCoherence === 'function' && lastAssistantText) {
      const r = await window.hypha.computePersonaCoherence({
        // MEOW Gate B Patch 1 (2026-05-08): handler reads `agent_id`, not
        // `contract`. Previous `contract:` field was silently ignored — the
        // handler always loaded mycelium-professor by default. Fixed.
        outputText: lastAssistantText,
        agent_id: 'mycelium-professor',
        mode: 'turn',
      });
      if (r && r.ok) out.persona = r.result;
    }
  } catch (_) {}
  return out;
}

async function _fanOutPostSession({ goal, transcript }) {
  if (!window.hypha) return null;
  const pseudoPlan = _synthPseudoPlan(goal);
  const out = { confession: null, summary: null, gap: null };
  try {
    if (typeof window.hypha.generateConfession === 'function') {
      const r = await window.hypha.generateConfession({
        // MEOW Gate B Patch 1 (2026-05-08): handler reads `agent_id`, not
        // `characterContract` (the lib expects characterContract OBJECT, but
        // the IPC handler does the loadContract internally from agent_id).
        // Passing a STRING under characterContract caused silent rejection
        // swallowed by the catch(_) below — confession path was dead.
        plan: pseudoPlan, transcript,
        agent_id: 'mycelium-professor',
      });
      if (r && r.ok) out.confession = r.confession || r.result;
    }
  } catch (_) {}
  try {
    if (typeof window.hypha.computeGap === 'function') {
      const r = await window.hypha.computeGap({
        plan: pseudoPlan, transcript,
      });
      if (r && r.ok) out.gap = r.result || r.gap || r;
    }
  } catch (_) {}
  try {
    if (typeof window.hypha.auditableSummary === 'function') {
      const r = await window.hypha.auditableSummary({
        plan: pseudoPlan, transcript,
      });
      // MEOW Gate B Patch 2 (2026-05-08): composeAuditableSummary returns
      // `{markdown, structured}` per auditable-summary.js. The IPC handler
      // spreads `...out`, so renderer sees `r.markdown` not `r.summary`.
      // Previously this read was forever falsy and the summary card never
      // rendered. Read `r.markdown` first, fallback to legacy keys.
      if (r && r.ok) out.summary = r.markdown || r.summary || r.result;
    }
  } catch (_) {}
  return out;
}

// =====================================================================
// MultiChannelProgress — per-layer harvest progress card (v0.3, 2026-05-09).
//
// Replaces the v0.2.1 1-line spinner with a multi-channel card that surfaces
// SUBSTANTIVE per-source counts during the 5-15 min heavy harvest stage. Per
// `feedback_course_gen_slow_visible.md`: visibility IS the feature; opaque
// fast generation reads as LLM拍脑袋, slow visible labor builds trust.
//
// Stage→layer mapping (consumed by _reduceProgressEvent below):
//   layer1:start / layer1:scrape:<courseId> / layer1:done   → layers.layer1
//   layer3:arxiv:start / layer3:arxiv / layer3:arxiv:paper /
//     layer3:arxiv:done (and same for openreview /
//     papers_with_code / hf_papers / semantic_scholar)      → layers.layer3
//   layer4:twitter:start / layer4:twitter:done /
//     layer4:fallback_used (and same per platform)          → layers.layer4
//   legacy:start / curate:start / design:start              → layers.{legacy,
//                                                              curate, design}
//   done                                                    → completed=true
//
// v0.2.1 GEN_STAGES is kept (legacy single-stage create still emits them) and
// folded under layers.legacy.* so they don't get lost when the backend uses
// the older path.
// =====================================================================

const GEN_STAGES = [
  { key: 'harvesting',          label: '采集知识源' },
  { key: 'designing-archetype', label: '判定课程原型' },
  { key: 'designing-digest',    label: '提炼源摘要' },
  { key: 'designing-seed',      label: '设计大纲与首课' },
  { key: 'writing-lessons',     label: '为每节课写结构' },
  { key: 'writing-body-0',      label: '备首课 (论点 + 范例 + 误解 + Feynman)' },
  { key: 'done',                label: '课程就绪' },
];
const _GEN_KEYS = GEN_STAGES.map(s => s.key);
// Done-event aliases mark the completion of a started step but are not
// listed standalone — they advance the matching start key to done.
const _GEN_DONE_ALIAS = {
  'designing-archetype-done': 'designing-archetype',
  'designing-digest-done':    'designing-digest',
  'designing-seed-done':      'designing-seed',
};

// Initial multi-channel layered state shape — used by setGenProgress on create
// kickoff. Matches the orchestrator-spec state shape exactly.
const _LAYER3_KEYS = ['arxiv', 'openreview', 'papers_with_code', 'hf_papers', 'semantic_scholar'];
const _LAYER4_KEYS = ['twitter', 'reddit', 'producthunt'];

const _initialLayers = () => ({
  layer1: { status: 'pending', counts: { courses: 0 }, fallback_used: false, anchors: [] },
  layer3: { status: 'pending', counts: Object.fromEntries(_LAYER3_KEYS.map(k => [k, 0])) },
  layer4: { status: 'pending', counts: Object.fromEntries(_LAYER4_KEYS.map(k => [k, 0])), fallback_used: false },
  legacy: { status: 'pending', counts: { total: 0 }, currentKey: null },
  curate: { status: 'pending' },
  design: { status: 'pending' },
});

// Pure reducer: map an event payload onto a new genProgress state. Defensive
// on unknown stages (silently no-op) so backend evolution doesn't crash UI.
function _reduceProgressEvent(prev, p) {
  if (!prev || !p || !p.stage) return prev;
  const stage = String(p.stage);
  const layers = { ...prev.layers };
  const setLayer = (k, patch) => { layers[k] = { ...layers[k], ...patch }; };
  // 'done' = global completion across all paths.
  if (stage === 'done') {
    return { ...prev, layers, active: false, completed: true };
  }
  if (stage === 'error') {
    return { ...prev, layers, active: false, error: p.error || '生成失败' };
  }
  // Layer 1 canonical
  if (stage === 'layer1:start') { setLayer('layer1', { status: 'active' }); return { ...prev, layers }; }
  if (stage === 'layer1:done')  {
    setLayer('layer1', {
      status: 'done',
      counts: { courses: typeof p.count === 'number' ? p.count : (layers.layer1.counts.courses || 0) },
      fallback_used: !!p.fallback_used,
      anchors: Array.isArray(p.anchors) ? p.anchors.slice(0, 6) : (layers.layer1.anchors || []),
    });
    return { ...prev, layers };
  }
  if (stage.indexOf('layer1:scrape:') === 0) {
    const id = stage.slice('layer1:scrape:'.length);
    const anchors = Array.isArray(layers.layer1.anchors) ? layers.layer1.anchors.slice() : [];
    if (id && anchors.indexOf(id) === -1 && anchors.length < 8) anchors.push(id);
    setLayer('layer1', { status: 'active', anchors });
    return { ...prev, layers };
  }
  // Layer 3 frontier — per-source channels
  if (stage === 'layer3:start') { setLayer('layer3', { status: 'active' }); return { ...prev, layers }; }
  if (stage === 'layer3:done')  { setLayer('layer3', { status: 'done' });   return { ...prev, layers }; }
  if (/^layer3:(arxiv|openreview|papers_with_code|hf_papers|semantic_scholar):start$/.test(stage)) {
    setLayer('layer3', { status: 'active' });
    return { ...prev, layers };
  }
  if (/^layer3:(arxiv|openreview|papers_with_code|hf_papers|semantic_scholar):done$/.test(stage)) {
    const src = stage.split(':')[1];
    if (typeof p.count === 'number') {
      const counts = { ...layers.layer3.counts, [src]: p.count };
      setLayer('layer3', { status: 'active', counts });
    }
    return { ...prev, layers };
  }
  if (/^layer3:(arxiv|openreview|papers_with_code|hf_papers|semantic_scholar)(:paper)?$/.test(stage)) {
    const src = stage.split(':')[1];
    const counts = { ...layers.layer3.counts };
    counts[src] = (counts[src] || 0) + 1;
    setLayer('layer3', { status: 'active', counts });
    return { ...prev, layers };
  }
  // Layer 4 community
  if (stage === 'layer4:start') { setLayer('layer4', { status: 'active' }); return { ...prev, layers }; }
  if (stage === 'layer4:done')  { setLayer('layer4', { status: 'done' });   return { ...prev, layers }; }
  if (/^layer4:(twitter|reddit|producthunt):start$/.test(stage)) {
    setLayer('layer4', { status: 'active' });
    return { ...prev, layers };
  }
  if (/^layer4:(twitter|reddit|producthunt):done$/.test(stage)) {
    const src = stage.split(':')[1];
    if (typeof p.count === 'number') {
      const counts = { ...layers.layer4.counts, [src]: p.count };
      setLayer('layer4', { status: 'active', counts });
    }
    return { ...prev, layers };
  }
  if (stage === 'layer4:fallback_used') {
    setLayer('layer4', { fallback_used: true });
    return { ...prev, layers };
  }
  // Legacy single-stage create (v0.2.1) — fold under layers.legacy
  if (stage === 'legacy:start') { setLayer('legacy', { status: 'active' }); return { ...prev, layers }; }
  if (stage === 'legacy:done')  { setLayer('legacy', { status: 'done' });   return { ...prev, layers }; }
  // Curate / design phases
  if (stage === 'curate:start') { setLayer('curate', { status: 'active' }); return { ...prev, layers }; }
  if (stage === 'curate:done')  { setLayer('curate', { status: 'done' });   return { ...prev, layers }; }
  if (stage === 'design:start') { setLayer('design', { status: 'active' }); return { ...prev, layers }; }
  if (stage === 'design:done')  { setLayer('design', { status: 'done' });   return { ...prev, layers }; }
  // body_ready signals end of Stage 2 — do not mutate layered state, the
  // Stage-2 spinner subscriber handles transition to __begin__.
  if (stage === 'body_ready') return prev;
  // v0.2.1 GEN_STAGES legacy compat — fold these under layers.legacy.currentKey
  // so the older backend path still surfaces something sensible.
  if (_GEN_KEYS.indexOf(stage) >= 0 || _GEN_DONE_ALIAS[stage]) {
    const aliasOf = _GEN_DONE_ALIAS[stage];
    const stageKey = aliasOf || stage;
    const counts = { total: (layers.legacy.counts.total || 0) + (aliasOf ? 0 : 1) };
    setLayer('legacy', { status: 'active', currentKey: stageKey, counts });
    return { ...prev, layers };
  }
  return prev;
}

// Status ink + word — editorial register, no glyph badges.
const _statusInk = (status, failed) => {
  if (failed) return 'var(--terracotta-2)';
  if (status === 'done')   return 'var(--ink-2)';
  if (status === 'active') return 'var(--ink)';
  if (status === 'failed') return 'var(--terracotta-2)';
  return 'var(--ink-3)';
};

const MultiChannelProgress = ({ progress, onStop }) => {
  if (!progress) return null;
  const cancelling = !!progress.cancelling;
  const failed = !!progress.error;
  // Once successfully completed, stay quiet — SkeletonPreviewCard / PreviewCard
  // takes over. Failed and cancelled states still render so the user sees the
  // outcome.
  if (progress.completed && !failed) return null;
  if (!progress.active && !failed) return null;

  const layers = progress.layers || _initialLayers();
  const elapsedSec = progress.startedAt
    ? Math.max(0, Math.round((Date.now() - progress.startedAt) / 1000))
    : 0;
  const elapsedLabel = elapsedSec >= 60
    ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
    : `${elapsedSec}s`;

  // Layer 3 inline summary — show sources with count > 0 OR currently active
  const layer3Items = _LAYER3_KEYS
    .map(k => ({ k, label: ({
      arxiv: 'arXiv',
      openreview: 'OpenReview',
      papers_with_code: 'PwC',
      hf_papers: 'HF',
      semantic_scholar: 'SemSch',
    })[k] || k, n: (layers.layer3.counts || {})[k] || 0 }))
    .filter(it => it.n > 0);
  const layer3Sum = layer3Items.reduce((s, it) => s + it.n, 0);

  // Layer 4 inline summary
  const layer4Items = _LAYER4_KEYS
    .map(k => ({ k, label: ({
      twitter: 'Twitter',
      reddit: 'Reddit',
      producthunt: 'PH',
    })[k] || k, n: (layers.layer4.counts || {})[k] || 0 }))
    .filter(it => it.n > 0);
  const layer4Sum = layer4Items.reduce((s, it) => s + it.n, 0);

  return (
    <div className="card-quiet col gap-10" style={{ padding: '14px 18px', marginBottom: 16, lineHeight: 1.5 }}>
      <div className="row gap-12" style={{ alignItems: 'baseline' }}>
        <span className="serif italic" style={{ fontSize: 14, color: failed ? 'var(--terracotta-2)' : 'var(--ink-2)' }}>
          {failed
            ? `生成出错 — ${progress.error}`
            : (cancelling ? '正在停止 ...' : '正在备课')}
        </span>
        <span className="t-tiny mono" style={{ color: 'var(--ink-3)' }}>
          {elapsedLabel} / 5-15 min
        </span>
        <span className="spacer" />
        {progress.active && !cancelling && !failed && (
          <button onClick={onStop} className="btn btn-ghost row gap-6" style={{ fontSize: 12 }}>
            <Icon name="x" size={11} /> 停止
          </button>
        )}
      </div>

      <div style={{ borderTop: '1px solid var(--rule-soft)', marginTop: 2 }} />

      {/* Layer 1 · canonical courses */}
      <div className="row gap-10" style={{ alignItems: 'baseline' }}>
        <span className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em', minWidth: 92 }}>
          Layer 1 · 经典课程
        </span>
        <span className="t-small" style={{ color: _statusInk(layers.layer1.status, failed) }}>
          {layers.layer1.status === 'done'
            ? `${layers.layer1.counts.courses || 0} 门 anchor`
            : (layers.layer1.status === 'active' ? '抓取中 ...' : '待启动')}
          {layers.layer1.fallback_used && (
            <span className="t-tiny" style={{ color: 'var(--ink-3)', marginLeft: 8 }}>(降级到搜索)</span>
          )}
        </span>
        {Array.isArray(layers.layer1.anchors) && layers.layer1.anchors.length > 0 && (
          <span className="t-tiny mono" style={{ color: 'var(--ink-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {layers.layer1.anchors.slice(0, 3).join(' / ')}
          </span>
        )}
      </div>

      {/* Layer 3 · frontier research */}
      <div className="row gap-10" style={{ alignItems: 'baseline' }}>
        <span className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em', minWidth: 92 }}>
          Layer 3 · 前沿研究
        </span>
        <span className="t-small" style={{ color: _statusInk(layers.layer3.status, failed) }}>
          {layers.layer3.status === 'pending'
            ? '待启动'
            : (layer3Sum === 0 && layers.layer3.status === 'active'
                ? '搜索中 ...'
                : `${layer3Sum} 篇`)}
        </span>
        {layer3Items.length > 0 && (
          <span className="t-tiny mono" style={{ color: 'var(--ink-3)' }}>
            {layer3Items.map(it => `${it.label} ${it.n}`).join(' / ')}
          </span>
        )}
      </div>

      {/* Layer 4 · community */}
      <div className="row gap-10" style={{ alignItems: 'baseline' }}>
        <span className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em', minWidth: 92 }}>
          Layer 4 · 社区讨论
        </span>
        <span className="t-small" style={{ color: _statusInk(layers.layer4.status, failed) }}>
          {layers.layer4.status === 'pending'
            ? '待启动'
            : (layer4Sum === 0 && layers.layer4.status === 'active'
                ? '抓取中 ...'
                : `${layer4Sum} 条`)}
          {layers.layer4.fallback_used && (
            <span className="t-tiny" style={{ color: 'var(--ink-3)', marginLeft: 8 }}>(daemon down 降级搜索)</span>
          )}
        </span>
        {layer4Items.length > 0 && (
          <span className="t-tiny mono" style={{ color: 'var(--ink-3)' }}>
            {layer4Items.map(it => `${it.label} ${it.n}`).join(' / ')}
          </span>
        )}
      </div>

      {/* Legacy / 既有渠道 */}
      {(layers.legacy.status !== 'pending' || (layers.legacy.counts.total || 0) > 0) && (
        <div className="row gap-10" style={{ alignItems: 'baseline' }}>
          <span className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em', minWidth: 92 }}>
            其他 · 既有渠道
          </span>
          <span className="t-small" style={{ color: _statusInk(layers.legacy.status, failed) }}>
            {layers.legacy.status === 'done'
              ? `${layers.legacy.counts.total || 0} 条`
              : (layers.legacy.status === 'active'
                  ? (layers.legacy.currentKey
                      ? ((GEN_STAGES.find(s => s.key === layers.legacy.currentKey) || {}).label || '采集中 ...')
                      : '采集中 ...')
                  : '待启动')}
          </span>
        </div>
      )}

      {/* Curate + design footer line — once any of these activate */}
      {(layers.curate.status !== 'pending' || layers.design.status !== 'pending') && (
        <div className="row gap-12" style={{ alignItems: 'baseline', borderTop: '1px solid var(--rule-soft)', paddingTop: 8, marginTop: 2 }}>
          <span className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em' }}>
            {layers.design.status === 'active'
              ? '课程链路设计中 ...'
              : (layers.curate.status === 'active'
                  ? '整理 / 去重 / 排序 ...'
                  : (layers.design.status === 'done' ? '链路就绪' : '准备链路 ...'))}
          </span>
        </div>
      )}
    </div>
  );
};

// =====================================================================
// PreviewCard — content-review gate before tutor opens.
// 2026-05-09 (v0.2.1, post-team-mode user critique): user said "LLM 把所有
//步骤生成好后最后一步直接给用户看，问用户是否满意，满意开始上课，不满意
//则问有哪里需要修改的地方". Renders the lesson-0.body.json prep artifact
// with 2 buttons; the auto-begin __begin__ sentinel is gated behind 开始上课.
// User can iterate up to 3 times via 需要修改; the regen IPC re-runs
// generateLessonBodyV2 with the prior body + free-text feedback.
// =====================================================================

const PREVIEW_REGEN_MAX = 3;

const PreviewCard = ({
  body,
  lessonTitles,
  topSources,
  regenAttempts,
  regenerating,
  feedbackOpen,
  feedbackDraft,
  onFeedbackDraftChange,
  onApprove,
  onRequestModify,
  onSubmitModify,
  onCloseFeedback,
}) => {
  if (!body) return null;
  const thesis = (body.thesis || '').trim();
  const canonical = (body.canonical_example || '').trim();
  const misconceptions = Array.isArray(body.common_misconceptions) ? body.common_misconceptions : [];
  const exitProof = (body.exit_proof || '').trim();
  const jargon = Array.isArray(body.jargon_list) ? body.jargon_list : [];
  const noteConn = (body.note_connection || '').trim();
  const regenExhausted = regenAttempts >= PREVIEW_REGEN_MAX;
  return (
    <div className="card-quiet col gap-12" style={{ padding: '18px 22px', marginBottom: 18, lineHeight: 1.55 }}>
      <div className="t-small mono" style={{ color: 'var(--ink-3)', letterSpacing: '.08em' }}>
        本节备课 · 满意即开始上课, 不满意请说哪里要改
      </div>

      {/* Thesis — the one-sentence anchor */}
      <div>
        <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em', marginBottom: 4 }}>论点</div>
        {thesis
          ? <div className="serif italic" style={{ fontSize: 17, color: 'var(--ink)' }}>{thesis}</div>
          : <div className="t-small" style={{ color: 'var(--ink-3)' }}>（缺）</div>}
      </div>

      {/* Canonical example */}
      {canonical && (
        <div>
          <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em', marginBottom: 4 }}>典范</div>
          <div className="t-body" style={{ color: 'var(--ink-2)' }}>{canonical}</div>
        </div>
      )}

      {/* Common misconceptions */}
      {misconceptions.length > 0 && (
        <div>
          <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em', marginBottom: 4 }}>常见误解 · 修正</div>
          <ul className="col gap-4" style={{ paddingLeft: 18, margin: 0 }}>
            {misconceptions.map((m, i) => (
              <li key={i} className="t-small" style={{ color: 'var(--ink-2)' }}>{String(m).trim()}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Exit proof — Feynman test */}
      {exitProof && (
        <div>
          <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em', marginBottom: 4 }}>下课检验</div>
          <div className="t-small" style={{ color: 'var(--ink-2)' }}>{exitProof}</div>
        </div>
      )}

      {/* Jargon list (compact) */}
      {jargon.length > 0 && (
        <div>
          <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em', marginBottom: 4 }}>术语</div>
          <div className="t-tiny mono" style={{ color: 'var(--ink-2)' }}>{jargon.map(j => String(j).trim()).join(' · ')}</div>
        </div>
      )}

      {/* Note connection */}
      {noteConn && (
        <div className="t-tiny" style={{ color: 'var(--ink-3)', fontStyle: 'italic' }}>{noteConn}</div>
      )}

      {/* Lesson plan titles */}
      {Array.isArray(lessonTitles) && lessonTitles.length > 0 && (
        <details>
          <summary className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em', cursor: 'pointer' }}>课程链路 ({lessonTitles.length} 节)</summary>
          <ol className="col gap-4" style={{ paddingLeft: 22, marginTop: 6 }}>
            {lessonTitles.map((t, i) => (
              <li key={i} className="t-small" style={{ color: 'var(--ink-2)' }}>{String(t || '').trim() || <span style={{ color: 'var(--ink-3)' }}>（待落笔）</span>}</li>
            ))}
          </ol>
        </details>
      )}

      {/* Top sources */}
      {Array.isArray(topSources) && topSources.length > 0 && (
        <details>
          <summary className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em', cursor: 'pointer' }}>源 (前 {Math.min(topSources.length, 5)})</summary>
          <ul className="col gap-4" style={{ paddingLeft: 22, marginTop: 6 }}>
            {topSources.slice(0, 5).map((s, i) => (
              <li key={i} className="t-small" style={{ color: 'var(--ink-2)' }}>
                {String(s.title || `源 ${i + 1}`).slice(0, 100)}
                {s.url && <span className="t-tiny mono" style={{ color: 'var(--ink-3)', marginLeft: 6 }}>({String(s.url).slice(0, 60)})</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Action row */}
      {!feedbackOpen && (
        <div className="row gap-12" style={{ marginTop: 4, paddingTop: 10, borderTop: '1px solid var(--rule-soft)', alignItems: 'center' }}>
          <button onClick={onApprove} className="btn btn-primary row gap-8" disabled={regenerating} style={{ fontSize: 13, opacity: regenerating ? 0.4 : 1 }}>
            <Icon name="sparkle" size={13} /> 开始上课
          </button>
          <button onClick={onRequestModify} className="btn btn-ghost" disabled={regenerating || regenExhausted} style={{ fontSize: 13, opacity: (regenerating || regenExhausted) ? 0.4 : 1 }}>
            需要修改
          </button>
          <span className="spacer" />
          {regenerating && <span className="t-tiny mono" style={{ color: 'var(--ink-3)' }}>正在重写 ...</span>}
          {regenAttempts > 0 && !regenerating && (
            <span className="t-tiny mono" style={{ color: 'var(--ink-3)' }}>已修改 {regenAttempts} / {PREVIEW_REGEN_MAX}</span>
          )}
          {regenExhausted && !regenerating && (
            <span className="t-tiny" style={{ color: 'var(--terracotta-2)' }}>已尝试 {PREVIEW_REGEN_MAX} 次, 直接开始或重新创建课程</span>
          )}
        </div>
      )}

      {/* Feedback textarea */}
      {feedbackOpen && (
        <div className="col gap-8" style={{ marginTop: 4, paddingTop: 10, borderTop: '1px solid var(--rule-soft)' }}>
          <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em' }}>
            告诉它哪里要改 (例: "论点太抽象, 改成具体场景" / "误解写错了, 应该是 ___" / "典范换成 2008 雷曼")
          </div>
          <textarea
            value={feedbackDraft}
            onChange={e => onFeedbackDraftChange(e.target.value)}
            rows={3}
            placeholder="点哪里要改, 越具体越好 ..."
            className="mono"
            style={{
              width: '100%', padding: '10px 12px',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: 13, lineHeight: 1.55,
              color: 'var(--ink)', background: 'var(--cream)',
              border: '1px solid var(--rule-soft)', borderRadius: 4,
              resize: 'vertical', boxSizing: 'border-box',
            }}
            disabled={regenerating}
          />
          <div className="row gap-12" style={{ alignItems: 'center' }}>
            <button onClick={onSubmitModify} className="btn btn-primary row gap-8" disabled={regenerating || !feedbackDraft.trim()}
                    style={{ fontSize: 13, opacity: (regenerating || !feedbackDraft.trim()) ? 0.4 : 1 }}>
              <Icon name="sparkle" size={13} /> 重写
            </button>
            <button onClick={onCloseFeedback} className="btn btn-ghost" disabled={regenerating} style={{ fontSize: 13 }}>
              收回
            </button>
            <span className="spacer" />
            {regenerating && <span className="t-tiny mono" style={{ color: 'var(--ink-3)' }}>正在重写 ...</span>}
          </div>
        </div>
      )}
    </div>
  );
};

// =====================================================================
// SkeletonPreviewCard — v0.3 skeleton-level approval gate (2026-05-09).
//
// Replaces the v0.2.1 body-only PreviewCard for new courses (where state.json
// lessonPlan[i].scope_in is present per Machino-D output). v0.2.1 PreviewCard
// kept for legacy courses without the scope fields.
//
// Per project_hypha_v03_2stage_gen.md: skeleton is more decision-load-bearing
// than first body. User commits to the LESSON PLAN (划分清楚边界 per
// blueprint mandate) before any body lands. 3 attempts cap on regen via free-
// text feedback; on approve, fires Stage 2 (curriculumApproveAndBody).
// =====================================================================

const SKELETON_REGEN_MAX = 3;

const SkeletonPreviewCard = ({
  skeleton,
  harvestSummary,
  sources,
  regenAttempts,
  regenerating,
  feedbackOpen,
  feedbackDraft,
  onApprove,
  onRequestModify,
  onSubmitModify,
  onFeedbackDraftChange,
  onCloseFeedback,
}) => {
  if (!skeleton || !Array.isArray(skeleton) || skeleton.length === 0) return null;
  const regenExhausted = regenAttempts >= SKELETON_REGEN_MAX;
  const layer1N = harvestSummary && typeof harvestSummary.layer1_courses_n === 'number' ? harvestSummary.layer1_courses_n : 0;
  const layer3N = harvestSummary && typeof harvestSummary.layer3_papers_n === 'number' ? harvestSummary.layer3_papers_n : 0;
  const layer4N = harvestSummary && typeof harvestSummary.layer4_posts_n === 'number' ? harvestSummary.layer4_posts_n : 0;
  const daemonAvailable = !!(harvestSummary && harvestSummary.daemon_available);
  // Group sources by layer when sources is a flat array with .layer / .source
  // metadata; defensive on shape variation.
  const sourcesByLayer = (() => {
    if (!Array.isArray(sources)) return null;
    const buckets = { layer1: [], layer3: [], layer4: [], legacy: [] };
    for (const s of sources) {
      if (!s) continue;
      const layer = (s.layer || s.tier || s.source_layer || '').toString().toLowerCase();
      if (layer.indexOf('1') >= 0 || layer === 'layer1' || layer === 'canonical') buckets.layer1.push(s);
      else if (layer.indexOf('3') >= 0 || layer === 'layer3' || layer === 'frontier') buckets.layer3.push(s);
      else if (layer.indexOf('4') >= 0 || layer === 'layer4' || layer === 'community') buckets.layer4.push(s);
      else buckets.legacy.push(s);
    }
    return buckets;
  })();

  return (
    <div className="card-quiet col gap-12" style={{ padding: '18px 22px', marginBottom: 18, lineHeight: 1.55 }}>
      <div className="t-small mono" style={{ color: 'var(--ink-3)', letterSpacing: '.08em' }}>
        本节备课 · 满意即开始上课, 不满意请说哪里要改
      </div>

      {/* Course skeleton — lesson list with scope per row */}
      <div className="col gap-10">
        <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em' }}>课程链路</div>
        <ol className="col gap-12" style={{ paddingLeft: 22, margin: 0 }}>
          {skeleton.map((slot, i) => {
            const title = (slot && (slot.title || slot.learn_goal || slot.learnGoal) || '').toString().trim() || `第 ${i + 1} 节`;
            const learnGoal = (slot && (slot.learn_goal || slot.learnGoal) || '').toString().trim();
            const scopeIn = (slot && slot.scope_in || '').toString().trim();
            const scopeOut = (slot && slot.scope_out || '').toString().trim();
            const prereq = (slot && slot.prerequisite || '').toString().trim();
            return (
              <li key={i} className="col gap-4" style={{ color: 'var(--ink-2)' }}>
                <div className="serif" style={{ fontSize: 15, color: 'var(--ink)' }}>{title}</div>
                {learnGoal && (
                  <div className="t-small" style={{ color: 'var(--ink-2)' }}>
                    <span className="t-tiny mono" style={{ color: 'var(--ink-3)', marginRight: 8 }}>学得到</span>
                    {learnGoal}
                  </div>
                )}
                {scopeIn && (
                  <div className="t-small" style={{ color: 'var(--ink-2)' }}>
                    <span className="t-tiny mono" style={{ color: 'var(--ink-3)', marginRight: 8 }}>涵盖</span>
                    {scopeIn}
                  </div>
                )}
                {scopeOut && (
                  <div className="t-small" style={{ color: 'var(--ink-2)' }}>
                    <span className="t-tiny mono" style={{ color: 'var(--ink-3)', marginRight: 8 }}>不涵盖</span>
                    {scopeOut}
                  </div>
                )}
                {prereq && (
                  <div className="t-small" style={{ color: 'var(--ink-2)' }}>
                    <span className="t-tiny mono" style={{ color: 'var(--ink-3)', marginRight: 8 }}>先得会</span>
                    {prereq}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      {/* Sources — collapsible, grouped by layer */}
      {sourcesByLayer && (sourcesByLayer.layer1.length > 0 || sourcesByLayer.layer3.length > 0 || sourcesByLayer.layer4.length > 0 || sourcesByLayer.legacy.length > 0) && (
        <details>
          <summary className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em', cursor: 'pointer' }}>
            源 · {sourcesByLayer.layer1.length + sourcesByLayer.layer3.length + sourcesByLayer.layer4.length + sourcesByLayer.legacy.length} 条
          </summary>
          <div className="col gap-10" style={{ paddingLeft: 18, marginTop: 8 }}>
            {sourcesByLayer.layer1.length > 0 && (
              <div>
                <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em', marginBottom: 4 }}>
                  Layer 1 · 经典课程 ({sourcesByLayer.layer1.length})
                </div>
                <ul className="col gap-4" style={{ paddingLeft: 18, margin: 0 }}>
                  {sourcesByLayer.layer1.slice(0, 5).map((s, i) => (
                    <li key={i} className="t-small" style={{ color: 'var(--ink-2)' }}>
                      {String(s.title || s.id || `源 ${i + 1}`).slice(0, 100)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {sourcesByLayer.layer3.length > 0 && (
              <div>
                <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em', marginBottom: 4 }}>
                  Layer 3 · 前沿研究 ({sourcesByLayer.layer3.length})
                </div>
                <ul className="col gap-4" style={{ paddingLeft: 18, margin: 0 }}>
                  {sourcesByLayer.layer3.slice(0, 5).map((s, i) => (
                    <li key={i} className="t-small" style={{ color: 'var(--ink-2)' }}>
                      {String(s.title || `源 ${i + 1}`).slice(0, 100)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {sourcesByLayer.layer4.length > 0 && (
              <div>
                <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em', marginBottom: 4 }}>
                  Layer 4 · 社区讨论 ({sourcesByLayer.layer4.length}){!daemonAvailable && layer4N === 0 && <span className="t-tiny" style={{ color: 'var(--ink-3)', marginLeft: 6 }}>(daemon down — 降级到搜索)</span>}
                </div>
                <ul className="col gap-4" style={{ paddingLeft: 18, margin: 0 }}>
                  {sourcesByLayer.layer4.slice(0, 5).map((s, i) => (
                    <li key={i} className="t-small" style={{ color: 'var(--ink-2)' }}>
                      {String(s.title || s.snippet || `源 ${i + 1}`).slice(0, 100)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {sourcesByLayer.legacy.length > 0 && (
              <div>
                <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em', marginBottom: 4 }}>
                  其他 · 既有渠道 ({sourcesByLayer.legacy.length})
                </div>
                <ul className="col gap-4" style={{ paddingLeft: 18, margin: 0 }}>
                  {sourcesByLayer.legacy.slice(0, 5).map((s, i) => (
                    <li key={i} className="t-small" style={{ color: 'var(--ink-2)' }}>
                      {String(s.title || `源 ${i + 1}`).slice(0, 100)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
      )}

      {/* Harvest summary inline — when no sources array but we have counts */}
      {!sourcesByLayer && harvestSummary && (layer1N > 0 || layer3N > 0 || layer4N > 0) && (
        <div className="t-tiny mono" style={{ color: 'var(--ink-3)' }}>
          源 · Layer 1: {layer1N} 门 / Layer 3: {layer3N} 篇 / Layer 4: {layer4N} 条{!daemonAvailable && <span style={{ marginLeft: 6 }}>(daemon down)</span>}
        </div>
      )}

      {/* Action row */}
      {!feedbackOpen && (
        <div className="row gap-12" style={{ marginTop: 4, paddingTop: 10, borderTop: '1px solid var(--rule-soft)', alignItems: 'center' }}>
          <button onClick={onApprove} className="btn btn-primary row gap-8" disabled={regenerating} style={{ fontSize: 13, opacity: regenerating ? 0.4 : 1 }}>
            <Icon name="sparkle" size={13} /> 开始上课
          </button>
          <button onClick={onRequestModify} className="btn btn-ghost" disabled={regenerating || regenExhausted} style={{ fontSize: 13, opacity: (regenerating || regenExhausted) ? 0.4 : 1 }}>
            需要修改
          </button>
          <span className="spacer" />
          {regenerating && <span className="t-tiny mono" style={{ color: 'var(--ink-3)' }}>正在重写 ...</span>}
          {regenAttempts > 0 && !regenerating && (
            <span className="t-tiny mono" style={{ color: 'var(--ink-3)' }}>已修改 {regenAttempts} / {SKELETON_REGEN_MAX}</span>
          )}
          {regenExhausted && !regenerating && (
            <span className="t-tiny" style={{ color: 'var(--terracotta-2)' }}>已尝试 {SKELETON_REGEN_MAX} 次, 直接开始或重新创建课程</span>
          )}
        </div>
      )}

      {/* Feedback textarea */}
      {feedbackOpen && (
        <div className="col gap-8" style={{ marginTop: 4, paddingTop: 10, borderTop: '1px solid var(--rule-soft)' }}>
          <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em' }}>
            告诉它哪里要改 (例: "第 2 节范围太窄, 加上前苏格拉底" / "顺序错了, 应该先讲 X 再讲 Y" / "缺一节关于 ___ 的")
          </div>
          <textarea
            value={feedbackDraft}
            onChange={e => onFeedbackDraftChange(e.target.value)}
            rows={3}
            placeholder="点哪里要改, 越具体越好 ..."
            className="mono"
            style={{
              width: '100%', padding: '10px 12px',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: 13, lineHeight: 1.55,
              color: 'var(--ink)', background: 'var(--cream)',
              border: '1px solid var(--rule-soft)', borderRadius: 4,
              resize: 'vertical', boxSizing: 'border-box',
            }}
            disabled={regenerating}
          />
          <div className="row gap-12" style={{ alignItems: 'center' }}>
            <button onClick={onSubmitModify} className="btn btn-primary row gap-8" disabled={regenerating || !feedbackDraft.trim()}
                    style={{ fontSize: 13, opacity: (regenerating || !feedbackDraft.trim()) ? 0.4 : 1 }}>
              <Icon name="sparkle" size={13} /> 重写
            </button>
            <button onClick={onCloseFeedback} className="btn btn-ghost" disabled={regenerating} style={{ fontSize: 13 }}>
              收回
            </button>
            <span className="spacer" />
            {regenerating && <span className="t-tiny mono" style={{ color: 'var(--ink-3)' }}>正在重写 ...</span>}
          </div>
        </div>
      )}
    </div>
  );
};

// =====================================================================
// Top component — LessonChat
// =====================================================================

let _turnIdSeq = 0;
const _newTurnId = () => `t-${Date.now()}-${++_turnIdSeq}`;

const LessonChat = ({ goal, noteRel: propNoteRel, onBack, onYield }) => {
  // Locally-owned noteRel — onboarding payload typically lacks it; we mirror
  // propNoteRel on mount and adopt curriculum-create output on first message.
  const [noteRel, setNoteRel] = useState(propNoteRel || null);
  useEffect(() => { if (propNoteRel && propNoteRel !== noteRel) setNoteRel(propNoteRel); /* eslint-disable-line */ }, [propNoteRel]);
  const [turns, setTurns] = useState([]);
  const [sessionFile, setSessionFile] = useState(null);
  const [currentState, setCurrentState] = useState(STATES.HOOK);
  const [streaming, setStreaming] = useState(false);
  const [streamingTurnId, setStreamingTurnId] = useState(null);
  const [streamState, setStreamState] = useState(null);
  const [error, setError] = useState(null);
  const [bridgeMissing, setBridgeMissing] = useState(false);
  const [postSessionResult, setPostSessionResult] = useState(null);
  const [trustResult, setTrustResult] = useState(null);
  // v0.2 Surface Finishing B3+B4 (Machino-A, 2026-05-08) — pre-lesson body
  // artifact (thesis / canonical_example / common_misconceptions / exit_proof
  // / mechanism / jargon / note_connection / optionally confession_markdown).
  // Read once per noteRel change; ChainHeader renders thesis (B3); /finish
  // slash handler reuses the cached body for confession surface (B4) without
  // a second IPC. Defensive: legacy lessons + IPC failures yield null silently.
  const [lessonBody, setLessonBody] = useState(null);
  // v0.2.1 — race fix. lessonBody starts null and the fetch IPC is async, but
  // the auto-begin useEffect runs synchronously on noteRel commit. Without
  // this flag, auto-begin reads lessonBody=null (still loading), the preview
  // gate evaluates false, __begin__ fires, bootBegunRef locks, and the
  // preview never gets a chance to render. lessonBodyLoaded flips true once
  // the fetch resolves (success or absent), which is the cue for auto-begin
  // to consult the gate condition with real data.
  const [lessonBodyLoaded, setLessonBodyLoaded] = useState(false);

  // v0.3 — MultiChannelProgress state. Layered shape (see _initialLayers):
  //   { active, completed, cancelling, error, startedAt,
  //     layers: { layer1, layer3, layer4, legacy, curate, design } }
  // Each layer carries status + counts (per-source for layer3/4) + optional
  // fallback flags. Reduced via _reduceProgressEvent on each progress emit.
  const [genProgress, setGenProgress] = useState(null);
  const cancelTopicRef = useRef(null);
  // v0.2.1 — preview-and-approve. previewApproved gates the auto-begin
  // useEffect so the tutor doesn't open until the user reviews the prep
  // artifact (lessonBody) and clicks 开始上课. Legacy courses without a
  // body.json bypass the gate (lessonBody stays null → guard short-circuits).
  // regenAttempts caps iteration at PREVIEW_REGEN_MAX = 3.
  const [previewApproved, setPreviewApproved] = useState(false);
  const [regenAttempts, setRegenAttempts] = useState(0);
  const [regenerating, setRegenerating] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackDraft, setFeedbackDraft] = useState('');

  // v0.3 — skeleton-level approve gate. skeletonPlan holds the lessonPlan
  // array with new fields (scope_in / scope_out / prerequisite) parsed from
  // state.json after Stage 1 (curriculumHarvestAndSkeleton) returns. When
  // present (lessonPlan[0].scope_in field set), the SkeletonPreviewCard
  // renders + auto-begin blocks until skeletonApproved=true. Legacy courses
  // without scope_in fall through to v0.2.1 PreviewCard / lessonBody path.
  const [skeletonPlan, setSkeletonPlan] = useState(null);
  const [harvestSummary, setHarvestSummary] = useState(null);
  const [harvestSources, setHarvestSources] = useState(null);
  const [skeletonApproved, setSkeletonApproved] = useState(false);
  const [skeletonRegenAttempts, setSkeletonRegenAttempts] = useState(0);
  const [skeletonRegenerating, setSkeletonRegenerating] = useState(false);
  const [skeletonFeedbackOpen, setSkeletonFeedbackOpen] = useState(false);
  const [skeletonFeedbackDraft, setSkeletonFeedbackDraft] = useState('');
  // Stage 2 mini-spinner — flips active when user clicks 开始上课, drops to
  // false on body_ready event. The auto-begin useEffect picks up after.
  const [body2Spinning, setBody2Spinning] = useState(false);

  const requestIdRef = useRef(null);
  const accRef = useRef('');
  const turnsRef = useRef(turns);
  useEffect(() => { turnsRef.current = turns; }, [turns]);

  // Bridge presence check on mount.
  useEffect(() => {
    const ok = window.ptor && window.ptor.llm && typeof window.ptor.llm.lesson === 'function';
    if (!ok) setBridgeMissing(true);
  }, []);

  // v0.2 Surface Finishing C3 hydration (2026-05-09, integration pass) —
  // derive slug + lessonIdx from noteRel for CourseTrustPanel, so its DriftLine
  // can read vault/<slug>/lesson-<idx>.body.drift-warning.json and surface
  // "(已尝试改写 N 次)". Same regex Machino-A uses below for body load.
  const { slug: lessonSlug, lessonIdx: lessonIdxNum } = useMemo(() => {
    if (!noteRel) return { slug: null, lessonIdx: null };
    const m = String(noteRel).match(/^([^\\/]+)[\\/]lesson-(\d+)\.md$/);
    if (!m) return { slug: null, lessonIdx: null };
    const idx = Number(m[2]);
    return { slug: m[1] || null, lessonIdx: Number.isFinite(idx) ? idx : null };
  }, [noteRel]);

  // v0.2 Surface Finishing B3 (2026-05-08, Machino-A) — load pre-lesson body
  // artifact via the lessonBodyGet bridge. Parses slug + lesson idx from
  // noteRel (canonical: <slug>/lesson-<N>.md). On any failure (IPC missing /
  // legacy lesson without artifact / parse miss) the state stays null; the
  // ChainHeader thesis row + /finish confession line both gracefully hide /
  // fall back to placeholder. Per plan: a single fetch backs both surfaces.
  useEffect(() => {
    if (!noteRel) { setLessonBody(null); setLessonBodyLoaded(true); return undefined; }
    setLessonBodyLoaded(false);  // v0.2.1 — reset on noteRel change so auto-begin gate waits
    let alive = true;
    (async () => {
      try {
        const get = window.ptor && window.ptor.hypha && window.ptor.hypha.lessonBodyGet;
        if (typeof get !== 'function') { if (alive) setLessonBodyLoaded(true); return; }
        const m = String(noteRel).match(/^([^\\/]+)[\\/]lesson-(\d+)\.md$/);
        if (!m) { if (alive) setLessonBodyLoaded(true); return; }
        const slug = m[1];
        const idx = Number(m[2]);
        if (!slug || !Number.isFinite(idx)) { if (alive) setLessonBodyLoaded(true); return; }
        const r = await get(slug, idx);
        if (!alive) return;
        if (r && r.ok && r.body) setLessonBody(r.body);
        else setLessonBody(null);
        setLessonBodyLoaded(true);  // v0.2.1 — gate cue: fetch resolved
      } catch (_) { if (alive) setLessonBodyLoaded(true); /* artifact is decorative — never block chat */ }
    })();
    return () => { alive = false; };
  }, [noteRel]);

  // 2026-05-08 (post-MEOW Gate B + first npm-start feedback): the LLM opens
  // with HOOK per learn-start.txt:28+89, the user does NOT have to type
  // anything to start. Two scenarios on mount:
  //   (a) noteRel arrived from props (curriculum already exists) → fire __begin__
  //   (b) noteRel missing but goal.goalContract present → auto-create curriculum
  //       on mount (NOT waiting for user input), then on noteRel commit fire __begin__
  // The __begin__ sentinel is consumed by handleSubmit + agent.js:2002 which
  // injects "[Lesson start. Begin with your first question.]" so the LLM
  // initiates the lesson per the HOOK contract.
  const bootBegunRef = useRef(false);
  const bootTriedCreateRef = useRef(false);
  useEffect(() => {
    if (bridgeMissing || streaming) return;
    if (bootBegunRef.current) return;
    // v0.2.1 hotfix 2026-05-09 — only USER/ASSISTANT turns indicate user is
    // mid-conversation. System turns (e.g. the "正在为你生成课程..." curriculum-
    // create banner) are informational and must not block auto-begin. Prior
    // gate `turns.length > 0` froze the page after my v0.2.1 removed the
    // !noteRel-branch replay setTimeout — sysTurn was in turns, useEffect
    // returned early, __begin__ never fired.
    if (turns.some(t => t.role === 'user' || t.role === 'assistant')) return;
    // v0.2.1 — preview-and-approve gate. When body.json exists (new courses
    // post Day-1 ship), block auto-begin until user clicks 开始上课. Legacy
    // courses without body.json (lessonBody === null) bypass the gate —
    // preserves Day-0 behavior. lessonBodyLoaded guards against the race
    // where auto-begin runs sync on noteRel commit BEFORE the IPC await
    // resolves — without this, the gate evaluates with stale lessonBody=null.
    if (noteRel && !lessonBodyLoaded) return;
    if (lessonBody && !previewApproved) return;
    // v0.3 — skeleton-level gate. When state.json carries lessonPlan with
    // scope_in field (new 2-stage flow output), block auto-begin on the
    // skeleton approval first. After approve, Stage 2 fires + body_ready
    // unblocks body2Spinning + the lessonBody path falls through naturally.
    if (skeletonPlan && skeletonPlan.length > 0 && skeletonPlan[0] && skeletonPlan[0].scope_in && !skeletonApproved) return;
    // Stage 2 mini-spinner active = waiting for body_ready event; don't fire
    // __begin__ yet.
    if (body2Spinning) return;
    if (noteRel) {
      // Scenario (a): we have a note. Fire whatever's been held (user-typed
      // text held during preview gate, OR auto-begin sentinel if nothing was
      // typed). pendingFirstMsgRef may be null at first mount with prop noteRel.
      bootBegunRef.current = true;
      const held = pendingFirstMsgRef.current;
      pendingFirstMsgRef.current = null;
      const msg = held || '__begin__';
      setTimeout(() => { try { handleSubmitRef.current && handleSubmitRef.current(msg); } catch (_) {} }, 0);
      return;
    }
    // Scenario (b): no note yet — auto-create curriculum mount-triggered, not
    // user-message-triggered. Requires goal.goalContract to exist.
    if (bootTriedCreateRef.current) return;
    if (!goal || !goal.goalContract || !goal.goalContract.north_star_goal) return;
    if (creatingCurriculumRef.current) return;
    bootTriedCreateRef.current = true;
    // Reuse the curriculum-create flow inside handleSubmit by passing the
    // sentinel — handleSubmit handles the !noteRel branch (auto-create +
    // replay). After create, this useEffect re-fires for scenario (a); the
    // preview gate above blocks until previewApproved.
    pendingFirstMsgRef.current = '__begin__';
    setTimeout(() => { try { handleSubmitRef.current && handleSubmitRef.current('__begin__'); } catch (_) {} }, 0);
  }, [bridgeMissing, noteRel, streaming, turns.length, goal, lessonBody, lessonBodyLoaded, previewApproved, skeletonPlan, skeletonApproved, body2Spinning]);

  // Subscribe to streaming chunks once. Filter on stage='lesson' + matching requestId.
  useEffect(() => {
    if (!window.ptor || !window.ptor.llm || typeof window.ptor.llm.onDeepenProgress !== 'function') return undefined;
    const unsub = window.ptor.llm.onDeepenProgress((payload) => {
      if (!payload || payload.stage !== 'lesson') return;
      if (!requestIdRef.current || payload.requestId !== requestIdRef.current) return;
      const status = payload.status;
      if (status === 'start') {
        accRef.current = '';
      } else if (status === 'chunk') {
        accRef.current += (payload.text || '');
        const parsed = parseStateMarker(accRef.current);
        if (parsed.state) setStreamState(parsed.state);
        const acc = accRef.current;
        const tid = streamingTurnId;
        if (tid) {
          setTurns(prev => prev.map(t => t.id === tid ? { ...t, text: acc } : t));
        }
      } else if (status === 'regen') {
        accRef.current = '';
        const tid = streamingTurnId;
        if (tid) setTurns(prev => prev.map(t => t.id === tid ? { ...t, text: '' } : t));
      } else if (status === 'aborted') {
        // stream cleanup happens in submit's await path
      }
    });
    return unsub;
  }, [streamingTurnId]);

  // ----- Slash command dispatcher -----
  // Zero-arg contract: every supported slash maps to a fixed bridge call with
  // no user-supplied arguments. MEOW Gate A Patch 2 (2026-05-08) deleted the
  // unused `arg` parsing var to lock this contract structurally — future
  // maintainers cannot accidentally pass renderer text into claude-cli.
  const handleSlash = useCallback(async (rawCmd) => {
    const [cmd] = rawCmd.trim().slice(1).split(/\s+/);
    const sysTurn = (text) => setTurns(prev => [...prev, { id: _newTurnId(), role: 'system', text }]);

    if (cmd === 'help') {
      sysTurn(
        '老师会先开课, 你只需回答提问. 支持的指令:\n' +
        '  /help              本列表\n' +
        '  /restart           重开本节, 旧记录存档保留\n' +
        '  /finish            结束本节 + 看学习总结 (今天搞清/还差/下一步)\n' +
        '  Ctrl+Enter         发送'
      );
      return;
    }

    if (cmd === 'restart') {
      setSessionFile(null);
      setTurns([]);
      setCurrentState(STATES.HOOK);
      setStreamState(null);
      setError(null);
      setPostSessionResult(null);
      setTrustResult(null);
      // v0.3.1 Patch 8: humanize. Tell the user history is preserved + frame
      // the action in user terms ("re-open this lesson" not "fork session").
      sysTurn('好的, 这节课重开. 之前的对话记录已存档在 vault, 不会丢. 下一条消息开始新的 transcript.');
      return;
    }

    if (cmd === 'finish') {
      const transcript = turnsRef.current
        .filter(t => t.role === 'user' || t.role === 'assistant')
        .map(t => ({ role: t.role, text: stripStateMarkers(t.text || '') }));
      sysTurn('收尾中: 总结这节课的学习成果 + 还差什么 + 下一步建议 ...');
      const r = await _fanOutPostSession({ goal, transcript });
      setPostSessionResult(r);
      // v0.3.1 Patch 3: render learner-view 3-section card instead of
      // dev-metadata digest. Pulls from existing trust-stack outputs:
      //   "搞清的"   ← auditable-summary structured.understood / claims
      //   "还差的"   ← confession.unverified_claims + speculative_claims
      //   "下一步"  ← confession.deepen_recommendation
      // Trust metadata (gap_pct / coherence) demoted to a tail line for the
      // technically-curious user; default surface is the 3-section card.
      // Defensive: any field can be missing — fall back to markdown raw.
      const sections = [];
      const conf = r && r.confession;
      const summary = r && r.summary;  // markdown string (per Gate B Patch 2)
      const gap = r && r.gap;
      // 搞清的 — try summary.structured.understood, fall back to first lines of markdown
      let understood = null;
      if (typeof summary === 'object' && summary && Array.isArray(summary.understood)) {
        understood = summary.understood;
      }
      // 还差的 — combine confession unverified + speculative
      const stillNeed = [];
      if (conf && Array.isArray(conf.unverified_claims)) stillNeed.push(...conf.unverified_claims);
      if (conf && Array.isArray(conf.speculative_claims)) stillNeed.push(...conf.speculative_claims);
      // 下一步
      const nextStep = (conf && typeof conf.deepen_recommendation === 'string') ? conf.deepen_recommendation : null;

      if (understood && understood.length > 0) {
        sections.push('【今天搞清的】\n' + understood.map((u, i) => `  ${i + 1}. ${typeof u === 'string' ? u : (u && u.text) || JSON.stringify(u)}`).join('\n'));
      }
      if (stillNeed.length > 0) {
        sections.push('【还需要补的】\n' + stillNeed.slice(0, 5).map((s, i) => `  ${i + 1}. ${typeof s === 'string' ? s : JSON.stringify(s)}`).join('\n'));
      }
      if (nextStep) {
        sections.push('【下一步建议】\n  ' + nextStep);
      }
      // v0.2 Surface Finishing B4 (2026-05-08, Machino-A) — confession line.
      // Anti-Slop Layer P0 surface: tutor admits where THIS lesson's argument
      // was thinnest. One-line digest sourced in priority order:
      //   (1) lessonBody.confession_markdown if Day-1 body schema includes it
      //   (2) confession.weakest_link.why from generateConfession (the actual
      //       lib output per app/lib/anti-slop/confession.js exports)
      //   (3) placeholder "待录" + TODO note if neither path returned data
      // Truncated to <=80 chars to keep the inline card scannable; the heavy
      // postSessionResult panel below renders the full confession blob.
      // TODO Machino-B: if confession IPC is not yet auto-firing, wire it via
      // app/main.js `lesson:generateConfession` so this surface stops needing
      // the placeholder fallback for non-corpus-supplied bodies.
      let weakest = '';
      if (lessonBody && typeof lessonBody.confession_markdown === 'string' && lessonBody.confession_markdown.trim()) {
        weakest = lessonBody.confession_markdown.trim();
      } else if (conf && conf.weakest_link && typeof conf.weakest_link.why === 'string' && conf.weakest_link.why.trim()) {
        weakest = conf.weakest_link.why.trim();
      }
      if (weakest.length > 80) weakest = weakest.slice(0, 78) + '…';
      sections.push('【本节最弱处】\n  ' + (weakest || '待录'));
      // Tail line for the technically-curious — demoted, not headline
      const tail = [];
      if (gap && typeof gap.gap_pct === 'number') tail.push(`证据缺口 ${gap.gap_pct}%`);
      if (r && r.latest && r.latest.persona && typeof r.latest.persona.score === 'number') tail.push(`人格连贯 ${r.latest.persona.score}`);

      if (sections.length === 0 && typeof summary === 'string' && summary.trim()) {
        // Fallback when structured fields aren't populated — show raw markdown.
        sections.push('【今天的笔记】\n' + summary.trim());
      }

      const card = sections.length > 0
        ? sections.join('\n\n') + (tail.length > 0 ? `\n\n— ${tail.join(' · ')} —` : '')
        : '本节结束. (信任栈离线 — 无法生成总结.)';
      sysTurn(card);
      return;
    }

    // /login /logout /status removed 2026-05-08 — claude-cli path retired in
    // v0.1, the bridges are still in preload.js but the slashes shouldn't
    // surface in user-facing /help. If the user types one, fall through to
    // the unknown-command branch.

    sysTurn(`Unknown command: /${cmd}. Type /help for the list.`);
  }, [goal, lessonBody]);

  // ----- Submit handler -----
  const creatingCurriculumRef = useRef(false);
  // v0.3.1 Patch 1: hold the user's first message while curriculum-create
  // runs, then replay it once noteRel is committed.
  const pendingFirstMsgRef = useRef(null);
  const handleSubmit = useCallback(async (text) => {
    if (text.startsWith('/')) {
      await handleSlash(text);
      return;
    }
    if (bridgeMissing) {
      setError({ error: 'NO_BRIDGE', message: 'window.ptor.llm.lesson is missing. Restart Electron after preload changes.' });
      return;
    }
    // 2026-05-08: onboarding payload doesn't carry noteRel by default. Auto-
    // create the curriculum on first user message instead of dead-ending the
    // user with "Return to onboarding".
    //
    // v0.3.1 Patch 1: capture the original user text in a ref BEFORE kicking
    // off curriculum-create, then replay it as a real submit once noteRel is
    // set. Previously the user had to re-type their first message — a hostile
    // UX that contradicted the "auto-create" promise.
    //
    // v0.3.1 Patch 4: subscribe to `curriculum:progress` events emitted by
    // main.js _runCurriculumCreate (line 2063 progress emit) so the wait
    // shows real stages (classifying / planning-chain / writing-lessons)
    // instead of one stuck line.
    if (!noteRel) {
      if (creatingCurriculumRef.current) return;  // re-entrancy guard
      // v0.3 — prefer the 2-stage Heavy Harvest bridge when Machino-E has
      // shipped it. Falls back to v0.2.1 single-stage curriculumCreate when
      // the bridge isn't yet on window.ptor.hypha (defensive: parallel ship).
      const harvestAndSkeleton = window.ptor && window.ptor.hypha && window.ptor.hypha.curriculumHarvestAndSkeleton;
      const create = window.ptor && window.ptor.hypha && window.ptor.hypha.curriculumCreate;
      const useV3 = typeof harvestAndSkeleton === 'function';
      const createFn = useV3 ? harvestAndSkeleton : create;
      if (typeof createFn !== 'function') {
        setError({ error: 'NO_NOTE', message: 'Cannot auto-create curriculum: bridge missing. Restart Electron.' });
        return;
      }
      creatingCurriculumRef.current = true;
      pendingFirstMsgRef.current = text;  // Patch 1: hold for replay
      const sysTurn = (msg) => setTurns(prev => [...prev, { id: _newTurnId(), role: 'system', text: msg }]);
      sysTurn(useV3
        ? '正在为你备课, 大约 5-15 分钟. 比起一闪生成, 慢一点是为了把链路打牢.'
        : '正在为你生成课程, 一次性准备 (约 30-60 秒)...');
      // v0.3 multi-channel state shape — replaces the v0.2.1 statuses/timings
      // map. Reducer in MultiChannelProgress takes care of per-event update.
      setGenProgress({
        active: true,
        completed: false,
        cancelling: false,
        error: null,
        startedAt: Date.now(),
        layers: _initialLayers(),
      });
      let unsubProgress = null;
      try {
        if (window.ptor && window.ptor.hypha && typeof window.ptor.hypha.onCurriculumProgress === 'function') {
          unsubProgress = window.ptor.hypha.onCurriculumProgress((p) => {
            if (!p || !p.stage) return;
            // Skip parent-only labels; sub-stages carry the actual signal.
            if (p.stage === 'designing') return;
            setGenProgress(prev => prev ? _reduceProgressEvent(prev, p) : prev);
          });
        }
      } catch (_) {}
      try {
        const topic = (goal && goal.goalContract && goal.goalContract.north_star_goal) || text.slice(0, 60);
        cancelTopicRef.current = topic;
        const level = (goal && goal.goalContract && goal.goalContract.current_level) || 'self-directed adult learner';
        const r = await createFn(topic, level, { goalContract: goal && goal.goalContract, lesson_mode: 'learn' });
        // v0.4.4 cancel path: backend _hyphaCancelCheck returned { ok:false,
        // cancelled:true } and already vault.del'd the partial slug. Don't
        // route through setError — cancellation is intentional, not failure.
        if (r && r.ok === false && r.cancelled) {
          pendingFirstMsgRef.current = null;
          setGenProgress(prev => prev ? { ...prev, active: false, cancelling: false, error: '已停止生成 (vault partial slug 已清理)' } : prev);
          return;
        }
        const newNoteRel = r && r.ok && (Array.isArray(r.lessonRels) ? r.lessonRels[0] : r.firstLessonRel);
        if (newNoteRel) {
          setNoteRel(newNoteRel);
          if (typeof onYield === 'function') onYield(newNoteRel);
          // v0.3 — capture skeleton-flow metadata when the new bridge ran. The
          // useEffect that watches noteRel will load lessonPlan from state.json
          // and SkeletonPreviewCard will render. Stage 2 (curriculumApproveAndBody)
          // fires from handleSkeletonApprove. For legacy bridge, no skeleton
          // data lands and the v0.2.1 PreviewCard path takes over via lessonBody.
          if (useV3) {
            if (r.harvest_summary) setHarvestSummary(r.harvest_summary);
            if (Array.isArray(r.sources)) setHarvestSources(r.sources);
          }
        } else {
          pendingFirstMsgRef.current = null;
          setError({ error: 'CREATE_FAILED', message: (r && r.error) || 'Curriculum create returned no lessonRels.' });
          setGenProgress(prev => prev ? { ...prev, active: false, error: (r && r.error) || '创建失败' } : prev);
        }
      } catch (err) {
        pendingFirstMsgRef.current = null;
        setError({ error: 'CREATE_EXCEPTION', message: err.message });
        setGenProgress(prev => prev ? { ...prev, active: false, error: err.message } : prev);
      } finally {
        try { if (unsubProgress) unsubProgress(); } catch (_) {}
        creatingCurriculumRef.current = false;
      }
      return;
    }

    // 2026-05-08: __begin__ is the auto-fire sentinel from the mount-triggered
    // auto-begin (LLM goes first per learn-start.txt). Don't add a user turn —
    // the user didn't say anything; LLM is opening with HOOK.
    const isBeginSentinel = (text === '__begin__');
    const asstTurn = { id: _newTurnId(), role: 'assistant', text: '', state: currentState };
    if (isBeginSentinel) {
      setTurns(prev => [...prev, asstTurn]);
    } else {
      const userTurn = { id: _newTurnId(), role: 'user', text };
      setTurns(prev => [...prev, userTurn, asstTurn]);
    }
    setStreamingTurnId(asstTurn.id);
    setStreamState(currentState);
    setStreaming(true);
    setError(null);
    accRef.current = '';

    const requestId = `lesson-${Date.now()}`;
    requestIdRef.current = requestId;

    try {
      const r = await window.ptor.llm.lesson({
        noteRel,
        userMsg: text,
        requestId,
        sessionFile,
        currentState,
      });

      const finalText = (r && r.text) || accRef.current || '';
      const parsed = parseStateMarker(finalText);
      const nextState = (r && r.nextState) || parsed.next || parsed.state || currentState;

      if (r && r.ok) {
        if (r.sessionFile) setSessionFile(r.sessionFile);
        setTurns(prev => prev.map(t => t.id === asstTurn.id
          ? { ...t, text: finalText, state: parsed.state || t.state }
          : t));
        setCurrentState(nextState);

        // Trust stack per-turn fan-out (gated by experiments flag).
        let perTurnEnabled = false;
        try {
          const flag = goal && goal.experiments && goal.experiments.trustStackPerTurn;
          if (flag) perTurnEnabled = true;
          // settingsGet lives on window.ptor.hypha (Hypha settings IPC was
          // exposed under the `ptor` bridge in preload.js, not the `hypha`
          // bridge which is trust-stack-only). Phase C-5 fix.
          if (
            !perTurnEnabled &&
            window.ptor &&
            window.ptor.hypha &&
            typeof window.ptor.hypha.settingsGet === 'function'
          ) {
            const s = await window.ptor.hypha.settingsGet();
            if (s && s.experiments && s.experiments.trustStackPerTurn) perTurnEnabled = true;
          }
        } catch (_) {}
        if (perTurnEnabled) {
          const recent = turnsRef.current
            .filter(t => t.role === 'assistant')
            .slice(-3)
            .map(t => stripStateMarkers(t.text || ''));
          const fanOut = await _fanOutPerTurn({
            goal,
            lastUserMsg: text,
            recentAssistantMessages: recent,
            lastAssistantText: stripStateMarkers(finalText),
          });
          // MEOW Gate B Patch 3 (2026-05-08): accumulate per-turn signals into
          // a 10-turn rolling history rather than overwriting (last-turn-wins
          // hid 9 prior FAILs). UI consumers default to `latest` for a single-
          // turn read; aggregates surface paste-detected-any + min coherence
          // across the window so a single bad turn doesn't get masked by the
          // next clean turn.
          if (fanOut) setTrustResult(prev => {
            const history = [...((prev && Array.isArray(prev.history) && prev.history) || []), fanOut].slice(-10);
            const minCoherence = history.reduce((m, t) => {
              const s = t && t.persona && (t.persona.score !== undefined ? t.persona.score : (t.persona.score_overall !== undefined ? t.persona.score_overall : null));
              return (s !== null && s < m) ? s : m;
            }, 100);
            const pasteDetectedAny = history.some(t => t && t.score && t.score.passed === false);
            // v0.3.1 Patch 5: when THIS turn newly trips paste-detect, surface
            // a learner-facing recovery hint (not just a red FAIL chip in the
            // trust panel). Hint says HOW to recover, not just THAT it failed.
            const justFailed = fanOut.score && fanOut.score.passed === false
              && fanOut.score.baseline_check && fanOut.score.baseline_check.paste_detected;
            if (justFailed) {
              setTurns(prev => [...prev, {
                id: _newTurnId(),
                role: 'system',
                text: '刚刚那段似乎是粘贴的助手回复. 用你自己的话重述一次, 哪怕只重述一句 — 这才算真懂的证据.',
              }]);
            }
            return { latest: fanOut, history, minCoherence, pasteDetectedAny };
          });
        }
      } else {
        setError(r || { error: 'UNKNOWN', message: 'No response from lesson IPC.' });
        setTurns(prev => prev.filter(t => t.id !== asstTurn.id));
      }
    } catch (err) {
      setError({ error: 'EXCEPTION', message: err.message });
      setTurns(prev => prev.filter(t => t.id !== asstTurn.id));
    } finally {
      setStreaming(false);
      setStreamingTurnId(null);
      requestIdRef.current = null;
      accRef.current = '';
    }
  }, [bridgeMissing, noteRel, sessionFile, currentState, goal, handleSlash]);

  // v0.3.1 Patch 1: hold a ref to the LATEST handleSubmit so the held-message
  // replay can fire after noteRel commits without capturing a stale closure.
  const handleSubmitRef = useRef(handleSubmit);
  useEffect(() => { handleSubmitRef.current = handleSubmit; }, [handleSubmit]);

  // ----- Abort handler -----
  const handleAbort = useCallback(async () => {
    const rid = requestIdRef.current;
    if (!rid) return;
    try {
      if (window.ptor && window.ptor.llm && typeof window.ptor.llm.lessonAbort === 'function') {
        await window.ptor.llm.lessonAbort(rid);
      }
    } catch (_) {}
    setStreaming(false);
  }, []);

  // v0.3 (extends v0.2 Surface followup) — MultiChannelProgress handlers.
  // handleStopGen calls curriculumCancel(topic). cancelTopicRef holds the
  // topic string captured at create() time. The backend's _hyphaCancelCheck
  // fires at the next await boundary (worst case ~5-10s), at which point
  // create() returns { ok:false, cancelled:true } and the success-path
  // handler flips genProgress to a benign stopped state.
  const handleStopGen = useCallback(async () => {
    const topic = cancelTopicRef.current;
    if (!topic) return;
    setGenProgress(prev => prev ? { ...prev, cancelling: true } : prev);
    try {
      const cancel = window.ptor && window.ptor.hypha && window.ptor.hypha.curriculumCancel;
      if (typeof cancel === 'function') await cancel(topic);
    } catch (_) { /* cancel is best-effort; UI surfaces stopped state via create() return */ }
  }, []);

  // v0.2.1 — Preview approve / modify handlers.
  const handleApprove = useCallback(() => {
    setFeedbackOpen(false);
    setFeedbackDraft('');
    setPreviewApproved(true);
    // The auto-begin useEffect re-fires (previewApproved is in its dep array)
    // and either replays held user text or fires the __begin__ sentinel.
  }, []);
  const handleRequestModify = useCallback(() => {
    setFeedbackOpen(true);
  }, []);
  const handleCloseFeedback = useCallback(() => {
    setFeedbackOpen(false);
    setFeedbackDraft('');
  }, []);
  const handleSubmitModify = useCallback(async () => {
    const fb = feedbackDraft.trim();
    if (!fb || regenerating || !lessonSlug || lessonIdxNum === null) return;
    if (regenAttempts >= PREVIEW_REGEN_MAX) return;
    setRegenerating(true);
    try {
      const regen = window.ptor && window.ptor.hypha && window.ptor.hypha.lessonBodyRegenerate;
      if (typeof regen !== 'function') {
        setError({ error: 'NO_BRIDGE', message: 'lessonBodyRegenerate bridge missing — restart Electron.' });
        return;
      }
      const r = await regen(lessonSlug, lessonIdxNum, fb);
      if (r && r.ok && r.body) {
        setLessonBody(r.body);
        setRegenAttempts(n => n + 1);
        setFeedbackOpen(false);
        setFeedbackDraft('');
      } else {
        setError({ error: 'REGEN_FAILED', message: (r && r.message) || '重写失败' });
      }
    } catch (err) {
      setError({ error: 'REGEN_EXCEPTION', message: err.message });
    } finally {
      setRegenerating(false);
    }
  }, [feedbackDraft, regenerating, lessonSlug, lessonIdxNum, regenAttempts]);

  // v0.3 — Skeleton approve / modify handlers. Approve calls Stage 2
  // (curriculumApproveAndBody) which generates lesson 0 body + emits
  // body_ready. The body2Spinning state mini-spinner waits for that event,
  // then the auto-begin useEffect fires __begin__. Modify calls
  // curriculumRegenerateSkeleton (cap 3 attempts).
  const handleSkeletonApprove = useCallback(async () => {
    if (!lessonSlug) return;
    setSkeletonFeedbackOpen(false);
    setSkeletonFeedbackDraft('');
    // Mark approved BEFORE Stage 2 fires so the gate-condition flips and the
    // auto-begin useEffect can move forward once body2Spinning drops.
    setSkeletonApproved(true);
    const approve = window.ptor && window.ptor.hypha && window.ptor.hypha.curriculumApproveAndBody;
    if (typeof approve !== 'function') {
      // Bridge missing (parallel-ship race). Don't hard-fail — body.json may
      // already exist (legacy backward path) so let auto-begin try directly.
      return;
    }
    setBody2Spinning(true);
    try {
      const r = await approve(lessonSlug, 0);
      if (r && r.ok && r.body) {
        setLessonBody(r.body);
        // Body in hand — drop the spinner so __begin__ fires.
        setBody2Spinning(false);
      } else if (r && r.ok === false && r.cancelled) {
        setBody2Spinning(false);
      } else if (r && !r.ok) {
        setBody2Spinning(false);
        setError({ error: 'BODY_GEN_FAILED', message: (r && r.error) || '生成首课正文失败' });
      }
    } catch (err) {
      setBody2Spinning(false);
      setError({ error: 'BODY_GEN_EXCEPTION', message: err.message });
    }
  }, [lessonSlug]);

  const handleSkeletonRequestModify = useCallback(() => {
    setSkeletonFeedbackOpen(true);
  }, []);
  const handleSkeletonCloseFeedback = useCallback(() => {
    setSkeletonFeedbackOpen(false);
    setSkeletonFeedbackDraft('');
  }, []);
  const handleSkeletonSubmitModify = useCallback(async () => {
    const fb = skeletonFeedbackDraft.trim();
    if (!fb || skeletonRegenerating || !lessonSlug) return;
    if (skeletonRegenAttempts >= SKELETON_REGEN_MAX) return;
    setSkeletonRegenerating(true);
    try {
      const regen = window.ptor && window.ptor.hypha && window.ptor.hypha.curriculumRegenerateSkeleton;
      if (typeof regen !== 'function') {
        setError({ error: 'NO_BRIDGE', message: 'curriculumRegenerateSkeleton bridge missing — restart Electron.' });
        return;
      }
      const r = await regen(lessonSlug, fb);
      if (r && r.ok && Array.isArray(r.lessonPlan)) {
        setSkeletonPlan(r.lessonPlan);
        setSkeletonRegenAttempts(typeof r.regen_count === 'number' ? r.regen_count : (skeletonRegenAttempts + 1));
        setSkeletonFeedbackOpen(false);
        setSkeletonFeedbackDraft('');
      } else {
        setError({ error: 'SKELETON_REGEN_FAILED', message: (r && r.message) || '重写失败' });
      }
    } catch (err) {
      setError({ error: 'SKELETON_REGEN_EXCEPTION', message: err.message });
    } finally {
      setSkeletonRegenerating(false);
    }
  }, [skeletonFeedbackDraft, skeletonRegenerating, lessonSlug, skeletonRegenAttempts]);

  // v0.2.1 — load lesson titles + top sources for PreviewCard from vault.
  // v0.3 — extended to also pull skeletonPlan + harvest_summary from
  // state.json. lessonPlan[i] now carries scope_in / scope_out / prerequisite
  // (Machino-D output). When scope_in is present on slot 0, the
  // SkeletonPreviewCard renders + auto-begin gates on skeletonApproved.
  const [previewLessonTitles, setPreviewLessonTitles] = useState(null);
  const [previewTopSources, setPreviewTopSources] = useState(null);
  useEffect(() => {
    if (!lessonSlug || !window.ptor || !window.ptor.vault || typeof window.ptor.vault.read !== 'function') return undefined;
    let alive = true;
    (async () => {
      try {
        const [stateTxt, sourcesTxt] = await Promise.all([
          window.ptor.vault.read(`${lessonSlug}/state.json`).catch(() => null),
          window.ptor.vault.read(`${lessonSlug}/sources.json`).catch(() => null),
        ]);
        if (!alive) return;
        try {
          const s = stateTxt ? JSON.parse(stateTxt) : null;
          const plan = (s && Array.isArray(s.lessonPlan)) ? s.lessonPlan : [];
          const titles = plan.map(slot => slot.title || slot.learnGoal || '');
          setPreviewLessonTitles(titles);
          // v0.3: detect skeleton via scope_in field on any slot. Capture full
          // plan so SkeletonPreviewCard can render scope rows. Also pull
          // harvest_summary if state.json carries it (Machino-D writes it).
          const hasSkeleton = plan.some(slot => slot && (slot.scope_in || slot.scope_out || slot.prerequisite));
          if (hasSkeleton) setSkeletonPlan(plan);
          else setSkeletonPlan(null);
          if (s && s.harvest_summary && typeof s.harvest_summary === 'object') {
            setHarvestSummary(prev => prev || s.harvest_summary);
          }
        } catch (_) { setPreviewLessonTitles([]); setSkeletonPlan(null); }
        try {
          const arr = sourcesTxt ? JSON.parse(sourcesTxt) : null;
          setPreviewTopSources(Array.isArray(arr) ? arr.slice(0, 5) : []);
          if (Array.isArray(arr)) setHarvestSources(prev => prev || arr);
        } catch (_) { setPreviewTopSources([]); }
      } catch (_) {}
    })();
    return () => { alive = false; };
  }, [lessonSlug]);

  // v0.3 — body_ready listener. Stage 2 (curriculumApproveAndBody) finishes by
  // emitting `body_ready` via onCurriculumProgress; on receipt drop the mini-
  // spinner so the auto-begin useEffect fires __begin__. Defensive: bridge may
  // not exist (parallel ship); skeletonApproved still gates manually.
  useEffect(() => {
    if (!body2Spinning) return undefined;
    if (!window.ptor || !window.ptor.hypha || typeof window.ptor.hypha.onCurriculumProgress !== 'function') return undefined;
    const unsub = window.ptor.hypha.onCurriculumProgress((p) => {
      if (!p || !p.stage) return;
      if (p.stage === 'body_ready' || p.stage === 'body:ready' || p.stage === 'done') {
        setBody2Spinning(false);
      }
    });
    return unsub;
  }, [body2Spinning]);

  // ----- Render -----
  if (bridgeMissing) {
    return (
      <PageFrame onBack={onBack}>
        <div className="col gap-16 rise-in" style={{ padding: '40px 0' }}>
          <div className="eyebrow" style={{ color: 'var(--terracotta-2)' }}>Bridge missing</div>
          <div className="t-h2 serif" style={{ fontWeight: 400 }}>
            The lesson chat bridge is not available.
          </div>
          <div className="card-quiet col gap-8" style={{ padding: 22 }}>
            <div className="t-small mono" style={{ color: 'var(--ink-3)', letterSpacing: '.08em' }}>
              NO_BRIDGE
            </div>
            <div className="t-body" style={{ color: 'var(--ink-2)' }}>
              window.ptor.llm.lesson is undefined. Restart Electron after preload changes.
            </div>
          </div>
        </div>
      </PageFrame>
    );
  }

  return (
    <PageFrame onBack={onBack} slug={lessonSlug} lessonIdx={lessonIdxNum} harnessResult={trustResult && trustResult.latest ? {
      // Read latest turn's signals for the trust panel; aggregates available
      // via trustResult.history / .minCoherence / .pasteDetectedAny per
      // MEOW Gate B Patch 3 rolling-history accumulation.
      score: trustResult.latest.score,
      persona: trustResult.latest.persona,
      minCoherence: trustResult.minCoherence,
      pasteDetectedAny: trustResult.pasteDetectedAny,
    } : null}>
      <ChainHeader goal={goal} noteRel={noteRel} lessonBody={lessonBody} />

      <MultiChannelProgress progress={genProgress} onStop={handleStopGen} />

      {/* v0.3 — skeleton-level approve gate. Renders when state.json carries
          lessonPlan with scope_in / scope_out / prerequisite (Machino-D
          output) AND user hasn't yet clicked 开始上课. Legacy courses without
          scope fields fall through to the v0.2.1 PreviewCard below. */}
      {skeletonPlan && skeletonPlan.length > 0 && skeletonPlan[0] && skeletonPlan[0].scope_in && !skeletonApproved && (
        <SkeletonPreviewCard
          skeleton={skeletonPlan}
          harvestSummary={harvestSummary}
          sources={harvestSources}
          regenAttempts={skeletonRegenAttempts}
          regenerating={skeletonRegenerating}
          feedbackOpen={skeletonFeedbackOpen}
          feedbackDraft={skeletonFeedbackDraft}
          onApprove={handleSkeletonApprove}
          onRequestModify={handleSkeletonRequestModify}
          onSubmitModify={handleSkeletonSubmitModify}
          onFeedbackDraftChange={setSkeletonFeedbackDraft}
          onCloseFeedback={handleSkeletonCloseFeedback}
        />
      )}

      {/* v0.3 — Stage 2 mini-spinner. After 开始上课, briefly waits for
          curriculumApproveAndBody to write body.json + emit body_ready. */}
      {body2Spinning && (
        <div className="row gap-12" style={{ alignItems: 'baseline', padding: '8px 0', marginBottom: 12, borderBottom: '1px solid var(--rule-soft)' }}>
          <span className="serif italic" style={{ fontSize: 14, color: 'var(--ink-2)' }}>备首课中 ...</span>
          <span className="t-tiny mono" style={{ color: 'var(--ink-3)' }}>30-60s</span>
        </div>
      )}

      {/* v0.2.1 — body PreviewCard. Renders for LEGACY courses (no scope_in
          field on lessonPlan slot 0) where lesson-0.body.json already exists
          and user hasn't clicked 开始上课. v0.3 courses skip this — the
          skeleton card drives Stage 2 + body lands AFTER approve, so by the
          time body.json arrives, skeletonApproved is already true. We gate
          this component on "no skeleton present" to avoid double-rendering. */}
      {lessonBody && !previewApproved && !(skeletonPlan && skeletonPlan.length > 0 && skeletonPlan[0] && skeletonPlan[0].scope_in) && (
        <PreviewCard
          body={lessonBody}
          lessonTitles={previewLessonTitles}
          topSources={previewTopSources}
          regenAttempts={regenAttempts}
          regenerating={regenerating}
          feedbackOpen={feedbackOpen}
          feedbackDraft={feedbackDraft}
          onFeedbackDraftChange={setFeedbackDraft}
          onApprove={handleApprove}
          onRequestModify={handleRequestModify}
          onSubmitModify={handleSubmitModify}
          onCloseFeedback={handleCloseFeedback}
        />
      )}

      {turns.length === 0 && !lessonBody && !skeletonPlan && !genProgress && (
        <div className="serif italic" style={{ marginBottom: 20, fontSize: 15, color: 'var(--ink-2)' }}>
          Type your first message to begin. The tutor opens with a probing question — answer in your own words. Type <span className="mono">/help</span> for commands.
        </div>
      )}

      <TranscriptList
        turns={turns}
        streamingTurnId={streamingTurnId}
        currentStreamState={streamState}
        onAbort={handleAbort}
      />

      {error && (
        <div className="card-quiet col gap-8" style={{ padding: 16, marginTop: 12 }}>
          <div className="t-tiny mono" style={{ color: 'var(--terracotta-2)', letterSpacing: '.08em' }}>
            {error.error || 'UNKNOWN'}
          </div>
          <div className="t-body" style={{ color: 'var(--ink-2)' }}>
            {error.message || 'No diagnostic message.'}
          </div>
        </div>
      )}

      {postSessionResult && (
        <div className="card-quiet col gap-12" style={{ padding: 22, marginTop: 20 }}>
          <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.08em' }}>
            LESSON SUMMARY · POST-SESSION AUDIT
          </div>
          {postSessionResult.summary && (
            <div className="serif" style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--ink)' }}>
              {typeof postSessionResult.summary === 'string'
                ? postSessionResult.summary
                : (postSessionResult.summary.text || JSON.stringify(postSessionResult.summary, null, 2))}
            </div>
          )}
          {postSessionResult.confession && (
            <div className="col gap-6">
              <div className="t-tiny mono" style={{ color: 'var(--ochre-2)', letterSpacing: '.08em' }}>CONFESSION</div>
              <div className="serif italic" style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--ink-2)', whiteSpace: 'pre-wrap' }}>
                {typeof postSessionResult.confession === 'string'
                  ? postSessionResult.confession
                  : JSON.stringify(postSessionResult.confession, null, 2)}
              </div>
            </div>
          )}
          {!postSessionResult.summary && !postSessionResult.confession && (
            <div className="serif italic" style={{ fontSize: 13, color: 'var(--ink-3)' }}>
              Post-session audit returned no result (trust stack bridge may be unavailable).
            </div>
          )}
        </div>
      )}

      <Composer
        onSubmit={handleSubmit}
        onAbort={handleAbort}
        disabled={false}
        streaming={streaming}
      />
    </PageFrame>
  );
};

window.LessonChat = LessonChat;
