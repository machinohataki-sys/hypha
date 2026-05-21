/* global React, Brand, Watercolor, Icon, CourseTrustPanel, DecisionLedgerCard, ProductSparkCard, RoadmapCard, NoteReactivationCard, NoteEdgeCard, PersonaWisdomStatus, CrossSparkCard, ProjectSpineCard, JudgmentGymCard, EntropyReductionCard, ArtifactCreationCard, CostBudgetCard, MasteryCard */
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
// 2026-05-13 — defensive strip for legacy visible state-tag headers
// ("— 引子 —" / "— 探查 —" / etc.) that LLM may still emit from training even
// after prompt update. Strips on its own line + adjacent blank lines.
const STRIP_VISIBLE_STATE_RE = /^[ \t]*—\s*(?:引子|探查|再探|校核|延展|串联|收纳)\s*—[ \t]*\n+/gm;

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
  return text
    .replace(STRIP_TAG_RE, '')
    .replace(STRIP_VISIBLE_STATE_RE, '');
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

// W1.2 micro-judge badges — 3 chips (drift / generic / jargon) in PageFrame
// top band. Calls window.ptor.judge.all in effect; renders "—" grey before
// data lands so lesson chat is never blocked. lessonBody hydration belongs to
// the consumer screen (placeholder until trust panel passes it down).
// intentional-placeholder: lessonBody prop pass-through wired through PageFrame
// but not yet supplied at every PageFrame callsite — green-field for v0.4.1.
const JudgeBadges = ({ slug, lessonIdx, lessonBody, goalContract, audienceLevel }) => {
  const [scores, setScores] = useState(null);
  useEffect(() => {
    if (!window.ptor || !window.ptor.judge || typeof window.ptor.judge.all !== 'function') return undefined;
    if (!lessonBody) return undefined;
    let alive = true;
    (async () => {
      try {
        const ctx = {
          goalContract: goalContract || null,
          audience_level: audienceLevel || '中级',
          topic: (goalContract && goalContract.north_star_goal) || '',
          slug,
          idx: lessonIdx,
        };
        const r = await window.ptor.judge.all(lessonBody, ctx);
        if (alive && r && r.ok) setScores(r.result);
      } catch (_) { /* leave stale snapshot — badge stays "—" */ }
    })();
    return () => { alive = false; };
  }, [slug, lessonIdx, lessonBody, goalContract, audienceLevel]);

  const Badge = ({ icon, label, score, fail, warn }) => {
    let color = 'var(--ink-3)';
    let text = '—';
    if (typeof score === 'number') {
      text = String(score);
      if (score < fail) color = 'var(--terracotta-2)';
      else if (score < warn) color = '#c89c3e';
      else color = '#789563';
    }
    return (
      <div title={`${label}: ${typeof score === 'number' ? score : 'pending'}`}
           style={{ display: 'flex', alignItems: 'center', gap: 4, marginRight: 10,
                    fontSize: 11, color: 'var(--ink-2)', lineHeight: 1 }}>
        <span style={{ fontSize: 10, opacity: 0.7, letterSpacing: '.04em' }}>{icon}</span>
        <span className="mono" style={{ color, minWidth: 18, textAlign: 'right' }}>{text}</span>
      </div>
    );
  };

  // Phase C.6.2 (2026-05-17) — collapse all-OK state to a single muted dot.
  // The 3-chip row was visual noise on the >90% of lessons where every judge
  // passes; only failures + warnings deserve attention. We treat "OK" as
  // `score >= 60` across all three judges (matches the green threshold used
  // in Badge above: drift warn=60, generic warn=55, jargon warn=50 — using
  // the strictest cutoff guarantees no warn/fail leaks into the muted dot).
  // Tooltip surfaces the underlying axes so an attentive reader can verify.
  const _val = (k) => scores && scores[k] && scores[k].score;
  const _ok = (k) => typeof _val(k) === 'number' && _val(k) >= 60;
  const allOK = scores && _ok('drift') && _ok('generic') && _ok('jargon');
  if (allOK) {
    return (
      <span
        title={`质量 ✓ · drift ${_val('drift')} / anti-generic ${_val('generic')} / jargon ${_val('jargon')}`}
        style={{
          display: 'inline-block',
          width: 6, height: 6, borderRadius: '50%',
          background: 'var(--ink-3)', opacity: 0.4,
          marginRight: 8,
        }}
      />
    );
  }

  return (
    <div className="row" style={{ alignItems: 'center', marginRight: 8 }}>
      <Badge icon="drift" label="goal drift"   score={scores && scores.drift   && scores.drift.score}   fail={35} warn={60} />
      <Badge icon="gen"   label="anti-generic" score={scores && scores.generic && scores.generic.score} fail={30} warn={55} />
      <Badge icon="jrg"   label="jargon"       score={scores && scores.jargon  && scores.jargon.score}  fail={25} warn={50} />
    </div>
  );
};

// W2.1 Cadence Card — display-only rhythm panel parallel to JudgeBadges.
// Reads window.ptor.cadence.compute(...) on lesson load. Does NOT block any
// user action — surfaces cadence_mode, next-lesson-type hint, days-remaining
// (Exam), and a "rest suggested" notice. See specs/lesson-cadence.md.
const CADENCE_COLORS = {
  deep:     '#4a6e54',  // 深绿 — 时间充足 / 深学
  balanced: '#7a8a4a',  // 橄榄 — 平衡
  compress: '#c89c3e',  // 琥珀 — 紧迫
  final:    '#a44a3a',  // 砖红 — 终压
  invalid:  'var(--ink-3)',
};
const CADENCE_LABELS = {
  deep:     '深学',
  balanced: '均衡',
  compress: '压缩',
  final:    '终压',
  invalid:  '—',
};
const NEXT_LESSON_HINTS = {
  new:               '下一课 · 新课',
  review:            '下一课 · 复习日',
  integration:       '下一课 · 整合日',
  final_compression: '下一课 · 终压',
};

const CadenceCard = ({ slug, lessonIdx, goalType, learningScore, confusionLevel, milestoneProgress, reviewNodesDue, daysRemaining, totalLessons }) => {
  const [decision, setDecision] = useState(null);
  useEffect(() => {
    if (!window.ptor || !window.ptor.cadence || typeof window.ptor.cadence.compute !== 'function') return undefined;
    if (!goalType) return undefined;
    let alive = true;
    (async () => {
      try {
        const r = await window.ptor.cadence.compute({
          goalType,
          lessonIdx: typeof lessonIdx === 'number' ? lessonIdx : 0,
          learningScore: typeof learningScore === 'number' ? learningScore : 70,
          confusionLevel: typeof confusionLevel === 'number' ? confusionLevel : 0.2,
          milestoneProgress: typeof milestoneProgress === 'number' ? milestoneProgress : 0,
          reviewNodesDue: typeof reviewNodesDue === 'number' ? reviewNodesDue : 0,
          daysRemaining: typeof daysRemaining === 'number' ? daysRemaining : null,
          totalLessons: typeof totalLessons === 'number' ? totalLessons : undefined,
        });
        if (alive && r && r.ok) setDecision(r.result);
      } catch (_) { /* leave silent — UI shows nothing on failure */ }
    })();
    return () => { alive = false; };
  }, [slug, lessonIdx, goalType, learningScore, confusionLevel, milestoneProgress, reviewNodesDue, daysRemaining, totalLessons]);

  if (!decision || decision.cadence_mode === 'invalid') return null;
  const color = CADENCE_COLORS[decision.cadence_mode] || 'var(--ink-3)';
  const label = CADENCE_LABELS[decision.cadence_mode] || '—';
  const hint  = NEXT_LESSON_HINTS[decision.next_lesson_type] || '';
  return (
    <div className="row" style={{ alignItems: 'center', gap: 10, marginRight: 12,
                                  fontSize: 11, color: 'var(--ink-2)', lineHeight: 1 }}
         title={decision.rationale || ''}>
      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                     background: color }} />
      <span className="mono" style={{ color, letterSpacing: '.04em' }}>{label}</span>
      {decision.days_remaining != null && goalType === 'Exam' && (
        <span style={{ opacity: 0.65 }}>· 剩 {decision.days_remaining} 天</span>
      )}
      <span style={{ opacity: 0.65 }}>· {hint}</span>
      {decision.rest_required && (
        <span style={{ color: 'var(--ink-3)', fontStyle: 'italic', opacity: 0.8 }}>
          · 建议休息一下
        </span>
      )}
    </div>
  );
};

// W2.3 GuardianBadge — chip rendering guardian_state with manuscript-register
// editorial line. Garamond italic, color-coded by state. No modal, no popup.
// When state === 'high_energy' the badge gains a small inline capture prompt
// "📓" that delegates to W1.5 capture:start. Default trust posture — when
// guardianState is null / 'on_track' / missing, badge is invisible to keep
// the manuscript surface uncluttered.
const GUARDIAN_TONE = {
  on_track:    { color: '#4a8a52', label: '在轨', italic: false },
  drifting:    { color: '#b58b3a', label: '旁支提醒', italic: true },
  frustrated:  { color: '#c87633', label: '稍稍放慢', italic: true },
  self_doubt:  { color: '#a8434f', label: '稳住一半', italic: true },
  distracted:  { color: '#6b6b8a', label: '回主线', italic: true },
  high_energy: { color: '#4d8b9a', label: '记下灵感', italic: true },
};
const GuardianBadge = ({ state, action, onCaptureClick }) => {
  if (!state || state === 'on_track') return null;
  const tone = GUARDIAN_TONE[state] || GUARDIAN_TONE.drifting;
  const showCapture = state === 'high_energy' && typeof onCaptureClick === 'function';
  return (
    <span className="row gap-6" style={{
      fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      fontStyle: tone.italic ? 'italic' : 'normal',
      fontSize: 13,
      color: tone.color,
      border: `1px solid ${tone.color}`,
      borderRadius: 12,
      padding: '2px 10px',
      background: 'rgba(255, 255, 250, 0.55)',
      letterSpacing: '0.02em',
    }} title={`guardian_state=${state} · action=${action || 'none'}`}>
      <span>{tone.label}</span>
      {showCapture && (
        <button
          onClick={onCaptureClick}
          className="btn btn-ghost"
          style={{ padding: '0 4px', fontSize: 12, fontStyle: 'normal', color: tone.color }}
          title="W1.5 Capture — 把这个灵感记到 vault"
        >◇</button>
      )}
    </span>
  );
};

const PageFrame = ({ children, onBack, onOpenNotebook, harnessResult, onDeepAuditRequested, slug, lessonIdx, lessonBody, goalContract, audienceLevel, cadenceCtx, guardianState, guardianAction, onGuardianCapture }) => (
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
      <JudgeBadges slug={slug} lessonIdx={lessonIdx} lessonBody={lessonBody} goalContract={goalContract} audienceLevel={audienceLevel} />
      <GuardianBadge state={guardianState} action={guardianAction} onCaptureClick={onGuardianCapture} />
      {cadenceCtx && (
        <CadenceCard
          slug={slug}
          lessonIdx={lessonIdx}
          goalType={cadenceCtx.goalType}
          learningScore={cadenceCtx.learningScore}
          confusionLevel={cadenceCtx.confusionLevel}
          milestoneProgress={cadenceCtx.milestoneProgress}
          reviewNodesDue={cadenceCtx.reviewNodesDue}
          daysRemaining={cadenceCtx.daysRemaining}
          totalLessons={cadenceCtx.totalLessons}
        />
      )}
      <HealthBadge />
      {typeof PersonaWisdomStatus === 'function' && slug && (
        <PersonaWisdomStatus slug={slug} lessonIdx={lessonIdx} />
      )}
      {/* 2026-05-17 — 顶栏 "📓 笔记" button removed per user feedback:
          /finish 走完后本节笔记自动整理进对应 module (atlas + dual-layer
          distill 已 ship), 顶栏手动入口重复 + 误导 ("以为要手动整理"). 死亡
          笔记审查仍可从 NotebookScreen 侧入口走, 不影响该路径. */}
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

// =====================================================================
// AssignmentBadge — W2.2 Cadence Level 1-5 indicator (placeholder UI).
//
// Renders a small mono chip next to ChainHeader showing current assignment
// level. Hover reveals level_name + trigger_reasons. Color escalates with
// level (brass-bright deepens 1→5). Placeholder — wires real data when
// finish-ritual emits assignment:level-decided event (W2.2 + W3.x).
// =====================================================================

const LEVEL_LABEL_CN = {
  1: '微证 · L1',
  2: '小练 · L2',
  3: '应用 · L3',
  4: '产品 · L4',
  5: '公开 · L5',
};
const LEVEL_TONE = {
  1: 'var(--ink-3)',
  2: 'var(--ink-2)',
  3: 'var(--brass)',
  4: 'var(--brass-bright)',
  5: 'var(--terracotta-2)',
};

const AssignmentBadge = ({ level, levelName, triggerReasons }) => {
  const lv = (level >= 1 && level <= 5) ? level : 1;
  const label = LEVEL_LABEL_CN[lv];
  const tooltip = `${levelName || ''}${(triggerReasons && triggerReasons.length) ? '  ·  ' + triggerReasons.join(' / ') : ''}`.trim();
  return (
    <span
      className="chip chip-mono"
      title={tooltip || label}
      style={{ color: LEVEL_TONE[lv], letterSpacing: '.08em' }}
    >
      {label}
    </span>
  );
};

// W3.1 Creation Pool — ProductBadge surfaces whether the current goal is
// bound to a Product Pool. Two states:
//   - bound:   brass "Product · <name>" chip, click-through reserved for W3.2
//   - unbound: muted "未绑定 Product" chip + invisible until UI prompt lands
// Reads `creation:isBound` then `creation:get` (cheap, returns frontmatter
// only). Surface only — no mutations from this scaffold. Owner of bind flow
// is W3.2 Product Blueprint editor (this stream's IPC is what it calls).
const ProductBadge = ({ slug }) => {
  const [bound, setBound] = useState(null);   // null = loading, false = unbound, object = bound metadata
  useEffect(() => {
    if (!slug) { setBound(false); return; }
    const creation = window.ptor && window.ptor.creation;
    if (!creation || typeof creation.isBound !== 'function') { setBound(false); return; }
    let alive = true;
    (async () => {
      try {
        const r = await creation.isBound(slug);
        if (!alive) return;
        if (!r || !r.bound) { setBound(false); return; }
        const got = await creation.get(slug);
        if (!alive) return;
        if (got && got.ok) setBound(got); else setBound(false);
      } catch (_) { if (alive) setBound(false); }
    })();
    return () => { alive = false; };
  }, [slug]);
  if (bound === null) return null;   // hide during initial load to avoid flicker
  // Phase C.6.1 (2026-05-17) — hide the "未绑定 Product" chip until the W3.2
  // editor surface ships. The placeholder shouted noise on every lesson
  // header for courses that simply pre-date the Product Pool flow; removing
  // it returns the chip row to a calm baseline. ProductBadge still renders
  // the bound state below — surface re-emerges the moment binding happens.
  if (bound === false) return null;
  const name = bound.product_name || '(未命名)';
  const typeLabel = bound.product_type ? ` · ${bound.product_type}` : '';
  return (
    <span className="chip chip-mono" style={{ color: 'var(--brass)', letterSpacing: '.06em' }}
      title={`北极星: ${bound.north_star || '(未填)'}\n绑定于: ${bound.bound_at || ''}`}>
      Product · {name}{typeLabel}
    </span>
  );
};

// Phase C.5d (2026-05-17) — ledger entry chip on ChainHeader. Reads the
// per-chain weekly self-report ledger (Agent A's `window.lifetime` bridge)
// to decide whether the current ISO week has been reported. Two states:
//   - reported: muted "ledger" pill, soft rule border
//   - needs-report: brass-ochre pill with a 5px dot — invites the user to
//     post this week's honest count
// Click dispatches `hypha:open-lifetime` (Agent B route case), mirroring the
// north-star pattern at app.jsx:309 so no prop-drilling is required. Hidden
// when chainSlug is absent (legacy lessons / pre-chain notes) OR when the
// preload bridge has not loaded — silent no-op never blocks chat.
function _ledgerIsoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const wk = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week: wk };
}

const LedgerBadge = ({ chainSlug, onClick }) => {
  const [needsReport, setNeedsReport] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!chainSlug || !window.lifetime || typeof window.lifetime.getLedger !== 'function') return undefined;
    let alive = true;
    Promise.resolve()
      .then(() => window.lifetime.getLedger({ slug: chainSlug }))
      .then((r) => {
        if (!alive) return;
        setReady(true);
        const latest = r && r.latestWeek;
        if (!latest) { setNeedsReport(true); return; }
        const m = /^(\d{4})-W(\d{2})$/.exec(String(latest));
        if (!m) { setNeedsReport(false); return; }
        const { year: nowY, week: nowW } = _ledgerIsoWeek(new Date());
        const latestY = Number(m[1]);
        const latestW = Number(m[2]);
        // ISO weeks are 52-or-53; cross-year compare via (year * 53 + week) is
        // tight enough for the "≥ 1 week gap" check we actually need.
        const weekGap = (nowY - latestY) * 53 + (nowW - latestW);
        setNeedsReport(weekGap >= 1);
      })
      .catch(() => { /* silent — header is decorative, never block chat */ });
    return () => { alive = false; };
  }, [chainSlug]);

  if (!chainSlug) return null;
  if (!window.lifetime || typeof window.lifetime.getLedger !== 'function') return null;
  if (!ready) return null;

  const dotColor = needsReport ? 'var(--ochre-2, #a86918)' : 'var(--ink-3)';
  const borderColor = needsReport ? '1px solid var(--ochre-2, #a86918)' : '1px solid var(--rule-soft)';
  const fg = needsReport ? 'var(--ochre-2, #a86918)' : 'var(--ink-3)';

  return (
    <button
      type="button"
      onClick={onClick}
      className="row gap-6"
      style={{
        alignItems: 'center',
        fontSize: 11.5,
        padding: '3px 10px',
        background: 'transparent',
        color: fg,
        border: borderColor,
        borderRadius: 999,
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
        letterSpacing: '0.02em',
        cursor: 'pointer',
      }}
      title={needsReport ? '本周尚未自报 — 点开 lifetime ledger' : '查看 lifetime ledger'}
    >
      {needsReport && (
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: dotColor, display: 'inline-block' }} />
      )}
      <span>ledger</span>
    </button>
  );
};

const ChainHeader = ({ goal, noteRel, lessonBody, assignmentLevel, assignmentLevelName, assignmentTriggerReasons }) => {
  const [chainData, setChainData] = useState(null);
  const [linksState, setLinksState] = useState(null);
  const [lessonFm, setLessonFm] = useState(null);
  // β23 — north-star summary (ratified / draft / artifacts). Read lazily;
  // null until bridge resolves; renders nothing if any number is missing.
  const [northStarSummary, setNorthStarSummary] = useState(null);

  useEffect(() => {
    if (!noteRel) return;
    const slug = String(noteRel).split(/[\\/]/)[0];
    if (!slug) return;
    if (!window.ptor || !window.ptor.northStar || typeof window.ptor.northStar.get !== 'function') return;
    let alive = true;
    window.ptor.northStar.get({ slug })
      .then((r) => {
        if (!alive) return;
        if (r && r.ok && r.state) {
          const s = r.state;
          // Only render when all three counts resolved as finite numbers.
          if (Number.isFinite(s.ratified_count) && Number.isFinite(s.draft_on_deck_count) && Number.isFinite(s.artifacts_shipped_count)) {
            setNorthStarSummary({
              ratified: s.ratified_count,
              draft:    s.draft_on_deck_count,
              artifacts: s.artifacts_shipped_count,
            });
          }
        }
      })
      .catch(() => { /* link is decorative — never block chat */ });
    return () => { alive = false; };
  }, [noteRel]);

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
        {/* W3.1 Creation Pool — Product Pool binding indicator. Slug derived
            from noteRel ("<slug>/lesson-N.md" → "<slug>"). Renders nothing
            during isBound resolution to avoid layout flicker. */}
        {noteRel && <ProductBadge slug={String(noteRel).split(/[\\/]/)[0]} />}
        {noteRel && (
          <LedgerBadge
            chainSlug={String(noteRel).split(/[\\/]/)[0]}
            onClick={() => {
              try { window.dispatchEvent(new CustomEvent('hypha:open-lifetime')); } catch (_) { /* listener may not be mounted yet — silent */ }
            }}
          />
        )}
        {assignmentLevel && (
          <AssignmentBadge
            level={assignmentLevel}
            levelName={assignmentLevelName}
            triggerReasons={assignmentTriggerReasons}
          />
        )}
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
      {/* β23 — inline link to North Star Panel (Goal System 阶 3). Brass hairline,
          italic Garamond, dispatches a window event so it doesn't need setRoute
          prop-drilled here. Renders only after north-star bridge resolves all
          three counts as finite numbers. */}
      {northStarSummary && (
        <button
          type="button"
          onClick={() => { try { window.dispatchEvent(new CustomEvent('hypha:open-north-star')); } catch (_) {} }}
          style={{
            alignSelf: 'flex-start',
            marginTop: 2,
            fontFamily: 'EB Garamond, "Noto Serif SC", serif',
            fontSize: 12.5,
            color: 'var(--ink-3)',
            background: 'transparent',
            border: 0,
            borderBottom: '0.5px solid var(--brass-bright, #b18432)',
            padding: '0 0 1px',
            cursor: 'pointer',
            letterSpacing: '0.02em',
          }}
        >
          查看 ratified {northStarSummary.ratified} · draft {northStarSummary.draft} · artifacts {northStarSummary.artifacts} →
        </button>
      )}
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
        {/* 2026-05-13 — state chip ("— 引子 —" / "— 探查 —") removed per user.
            STATE_LABELS + STATE_TOOLTIPS kept in module for future use (e.g.
            settings toggle) but chip not rendered. state machine routing
            unaffected — state is still extracted from <!--state:--> markers
            in stripStateMarkers + drives next-turn prompt selection. */}
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

// 2026-05-13 — 跨学科 + 判断力 standalone screens retired; their two highest-
// signal moves (Leo-style 第一性原理 reframe + Cross-Spark 换学科视角) now
// live as inline reframe pills here. Click = submit a canonical reframe
// turn to the tutor. Lower friction than navigating to a separate screen,
// and lands precisely where 卡住 happens.
const REFRAME_PROMPTS = Object.freeze({
  first_principle:
    '暂停。请把刚才的内容剥回第一性原理 — 去掉所有术语 / 定义 / 引用 / 类比, ' +
    '只留可被观察到的现象与不可还原的约束, 再从那里重新走一遍这一段。',
  cross_spark:
    '用一个与当前学科完全不同的领域 (物理 / 生物 / 经济 / 历史 / 数学之一) 类比刚才的概念。' +
    '不是举例, 是问 — 那个领域怎么组织同样的张力？这能否反过来重新切分这里的问题？',
});

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

  const fireReframe = useCallback((key) => {
    const prompt = REFRAME_PROMPTS[key];
    if (!prompt || disabled || streaming) return;
    onSubmit(prompt);
    setDraft('');
  }, [onSubmit, disabled, streaming]);

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
      <div className="row gap-12" style={{ alignItems: 'center' }}>
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
        <span style={{ flex: 1 }} />
        <span style={{
          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
          fontStyle: 'italic', fontSize: 12,
          color: 'var(--ink-3)', letterSpacing: '0.04em',
        }}>卡住时 ·</span>
        <button
          type="button"
          onClick={() => fireReframe('first_principle')}
          disabled={disabled || streaming}
          title="把当前段剥回第一性原理 (judgment-gym 内嵌入口)"
          style={{
            padding: '4px 12px',
            fontFamily: 'EB Garamond, serif', fontSize: 12,
            color: 'var(--ink-2)',
            background: 'transparent',
            border: '1px solid var(--rule-soft)',
            borderRadius: 999,
            cursor: (disabled || streaming) ? 'not-allowed' : 'pointer',
            opacity: (disabled || streaming) ? 0.5 : 1,
            letterSpacing: '0.04em',
          }}
        >用第一性原理 reframe</button>
        <button
          type="button"
          onClick={() => fireReframe('cross_spark')}
          disabled={disabled || streaming}
          title="换学科视角重切 (cross-spark 内嵌入口)"
          style={{
            padding: '4px 12px',
            fontFamily: 'EB Garamond, serif', fontSize: 12,
            color: 'var(--ink-2)',
            background: 'transparent',
            border: '1px solid var(--rule-soft)',
            borderRadius: 999,
            cursor: (disabled || streaming) ? 'not-allowed' : 'pointer',
            opacity: (disabled || streaming) ? 0.5 : 1,
            letterSpacing: '0.04em',
          }}
        >换学科视角</button>
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

      {/* W7.3 Citation footnotes + trust badges + copyright boundary warning.
          Reads body.evidence_cite[] post-W7.3 annotation: each row carries
          _trust_score (0-100) + _risk_level (low/medium/high/block). Trust
          color tier: green ≥75 · brass 50-74 · orange 25-49 · red <25.
          Placeholder-quality rendering — final visual tune lives in the next
          design pass; this surfaces the data so the panel can't be empty. */}
      {Array.isArray(body.evidence_cite) && body.evidence_cite.length > 0 && (() => {
        const cites = body.evidence_cite;
        const worstRisk = cites.reduce((acc, c) => {
          const order = { low: 0, medium: 1, high: 2, block: 3 };
          return (order[c._risk_level] || 0) > (order[acc] || 0) ? (c._risk_level || acc) : acc;
        }, 'low');
        const _trustColor = (s) => {
          const n = Number(s);
          if (!Number.isFinite(n)) return 'var(--ink-3)';
          if (n >= 75) return '#3f7a3f';
          if (n >= 50) return 'var(--brass-1, #8a6a1f)';
          if (n >= 25) return '#b3651d';
          return '#a83a3a';
        };
        return (
          <div className="col gap-6" style={{ marginTop: 4 }}>
            <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em' }}>引用 · 来源</div>
            <ul className="col gap-4" style={{ paddingLeft: 16, margin: 0 }}>
              {cites.slice(0, 6).map((c, i) => {
                const label = c.book_title || c.title || c.pack_id || c.book_id || `cite-${i}`;
                const score = Number.isFinite(Number(c._trust_score)) ? c._trust_score : null;
                return (
                  <li key={i} className="t-tiny" style={{ color: 'var(--ink-2)', listStyle: 'circle' }}>
                    <span>{String(label).slice(0, 60)}</span>
                    {score != null && (
                      <span
                        title={`Trust ${score} / 100 · ${c.cite_type || 'cite'}${c._risk_level ? ' · risk ' + c._risk_level : ''}`}
                        style={{ marginLeft: 8, fontFamily: 'monospace', fontSize: 10, color: _trustColor(score) }}
                      >trust·{score}</span>
                    )}
                  </li>
                );
              })}
            </ul>
            {(worstRisk === 'high' || worstRisk === 'block') && (
              <div
                role="alert"
                style={{
                  marginTop: 6,
                  padding: '8px 12px',
                  borderLeft: `3px solid ${worstRisk === 'block' ? '#a83a3a' : '#b3651d'}`,
                  background: worstRisk === 'block' ? 'rgba(168, 58, 58, 0.05)' : 'rgba(179, 101, 29, 0.05)',
                }}
              >
                <div className="t-tiny mono" style={{ color: worstRisk === 'block' ? '#a83a3a' : '#b3651d', letterSpacing: '.04em' }}>
                  {worstRisk === 'block' ? '⛔ 版权边界 · 不可公开' : '⚠ 版权边界 · 高风险'}
                </div>
                <div className="t-tiny" style={{ color: 'var(--ink-2)', marginTop: 4, lineHeight: 1.5 }}>
                  本节引用接近替代原文。仅作私人学习; 公开发布前请改为短引文 + 链回原书.
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* W3.3 Product Transfer — body.product_transfer object (post-fill from
          product-transfer.js when P ≥ 0.6 against the user's Product Pool).
          String form (LLM's 1-sentence prep hint) is intentionally NOT rendered
          here; it lives in the LESSON BRIEF tutor-side only. Only the post-fill
          object surfaces the full 4-line callout (1 insight + 3 impacts + 1
          risk) inline at lesson schema slot #10 per blueprint §11.3. */}
      {body && body.product_transfer && typeof body.product_transfer === 'object' && body.product_transfer.content && (
        <div style={{
          position: 'relative',
          marginTop: 4,
          padding: '14px 16px',
          border: '1px solid var(--brass-2, #b8923a)',
          borderRadius: 4,
          background: 'rgba(184, 146, 58, 0.04)',
        }}>
          {/* v0 mock marker — when product-transfer module return is tagged
              (T4_JUDGE 未上线 path), render italic "v0 模板输出" stamp top-right.
              Hover (title=) shows _mock_reason. Component returns null when
              the real LLM call lands and the tag is removed. JSX cannot
              namespace through window.X directly so we hoist into a local. */}
          {(() => {
            const Banner = (typeof window !== 'undefined') ? window.V0MockBanner : null;
            return Banner ? <Banner payload={body.product_transfer} /> : null;
          })()}
          <div
            className="serif italic"
            style={{ fontSize: 15, color: 'var(--brass-1, #8a6a1f)', letterSpacing: '.02em', marginBottom: 6 }}
            title={`P=${typeof body.product_transfer.P === 'number' ? body.product_transfer.P.toFixed(2) : 'n/a'} · section=${body.product_transfer.suggested_section || 'general'}`}
          >迁移到你的产品 / 作品</div>
          <div className="t-small" style={{ color: 'var(--ink-2)', whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>
            {String(body.product_transfer.content).replace(/^##\s*迁移到你的产品.*\n+/m, '').trim()}
          </div>
          {/* W3.4 spark routing — placeholder button. When W3.4 ships, this
              calls window.ptor.spark.createFromTransfer({ slug, lessonIdx,
              content, suggested_section }). Today it's wired but no-ops
              gracefully when window.ptor.spark is absent.
              intentional-placeholder: W3.4 spark module is a parallel-ship
              dependency (not yet on disk). The button is structurally wired
              against the eventual surface; today it silently no-ops so the
              UI render is testable + the spark-create path drops in cleanly
              once that wave lands. */}
          <div className="row gap-8" style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--rule-soft)' }}>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12, color: 'var(--brass-1, #8a6a1f)' }}
              onClick={() => {
                try {
                  const sparkApi = window && window.ptor && window.ptor.spark;
                  if (sparkApi && typeof sparkApi.createFromTransfer === 'function') {
                    sparkApi.createFromTransfer({
                      content: body.product_transfer.content,
                      suggested_section: body.product_transfer.suggested_section,
                      P: body.product_transfer.P,
                    });
                  }
                } catch (_) { /* W3.4 not shipped yet — silent */ }
              }}
            >确认迁移到 spark</button>
            <span className="t-tiny mono" style={{ color: 'var(--ink-3)' }}>
              {body.product_transfer.mocked ? '占位文案 · 待 T4_JUDGE 上线后落地' : ''}
            </span>
          </div>
        </div>
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

// UserUrlRecommendation — 2026-05-12. User pastes URLs / book mentions, clicks
// 推荐, parent receives parsed URL list, pre-fills the existing feedback draft
// with a structured "请把下面 URL 加进 harvest" prefix + calls onRequestModify
// so the existing regen pipeline picks them up. No new IPC needed — leverages
// the existing curriculum:regenerate-skeleton flow.
const UserUrlRecommendation = ({ onSubmit, disabled }) => {
  const [draft, setDraft] = React.useState('');
  const handleSubmit = () => {
    const urls = draft
      .split(/[\s,，;；\n]+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
    if (urls.length === 0) return;
    onSubmit(urls);
    setDraft('');
  };
  return (
    <div className="col gap-8" style={{ marginTop: 8 }}>
      <div className="t-tiny" style={{ color: 'var(--ink-3)' }}>
        每行 1 个 URL, 或用空格/逗号/分号分隔. 提交后会用既有 regen 流走一遍, 把这些资源拉进 harvest 再生成骨架.
      </div>
      <textarea
        value={draft}
        onChange={e => setDraft(e.target.value)}
        rows={3}
        placeholder="https://plato.stanford.edu/entries/spinoza/&#10;https://...&#10;..."
        className="mono"
        style={{
          width: '100%', padding: '8px 10px',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 12, lineHeight: 1.5,
          color: 'var(--ink)', background: 'var(--cream)',
          border: '1px solid var(--rule-soft)', borderRadius: 4,
          resize: 'vertical', boxSizing: 'border-box',
        }}
        disabled={disabled}
      />
      <div className="row gap-12">
        <button onClick={handleSubmit} disabled={disabled || !draft.trim()} className="btn btn-ghost"
          style={{ fontSize: 12, opacity: (disabled || !draft.trim()) ? 0.4 : 1 }}>
          推荐这些 — 重生成骨架
        </button>
      </div>
    </div>
  );
};

const SkeletonPreviewCard = ({
  skeleton,
  harvestSummary,
  sources,
  topic,
  goalContract,
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

  // 2026-05-13 — render derivation reasoning for lesson count. Mirrors backend
  // agent.deriveLessonTarget: days × intent_density, floor 1.0/day.
  // Shown as marginalia + a "节数不对? 改时长" hint linking back to 需要修改.
  const countDerivation = (() => {
    if (!goalContract) return null;
    const intent = goalContract.user_intent;
    let days = Number(goalContract.days);
    let daysSource = 'days';
    if (!Number.isFinite(days) || days < 1) {
      // try deadline
      const dl = goalContract.deadline;
      if (dl) {
        const ms = Date.parse(dl);
        if (Number.isFinite(ms)) {
          const diff = Math.ceil((ms - Date.now()) / 86400000);
          if (diff >= 1) { days = diff; daysSource = `deadline ${dl}`; }
        }
      }
    }
    if (!Number.isFinite(days) || days < 1) return null;
    const DENSITY = { '考研': 1.5, '论文': 1.2, '兴趣': 1.0, '复盘': 1.0 };
    const density = (intent && DENSITY[intent]) || 1.0;
    const target = Math.max(2, Math.min(200, Math.round(days * density)));
    const intentLabel = intent || '默认';
    return {
      target,
      reasoning: `${days} 天 (${daysSource}) × ${intentLabel}/${density} = ${target} 节`,
      actualCount: skeleton.length,
      drift: skeleton.length !== target ? Math.abs(skeleton.length - target) : 0,
    };
  })();

  // R-LIB Day 6 (2026-05-12) — fetch per-book rollup + community pack hint
  // cached by the last harvest() for this topic. Both render as first-class
  // 📚 cards above the flat source list, surfacing D/P/R hit breakdown +
  // chapter TOC so user sees WHICH book chapters informed the skeleton.
  const [libraryRollup, setLibraryRollup] = React.useState(null);
  const [communityHint, setCommunityHint] = React.useState(null);
  React.useEffect(() => {
    if (!topic || !window.ptor) return;
    let cancelled = false;
    (async () => {
      try {
        const [rRes, hRes] = await Promise.all([
          window.ptor.libraryRollupForTopic ? window.ptor.libraryRollupForTopic(topic) : null,
          window.ptor.communityHintForTopic ? window.ptor.communityHintForTopic(topic) : null,
        ]);
        if (!cancelled) {
          if (rRes && rRes.ok) setLibraryRollup(rRes.rollup);
          if (hRes && hRes.ok) setCommunityHint(hRes.hint);
        }
      } catch (_) { /* silent — degrade to flat source list */ }
    })();
    return () => { cancelled = true; };
  }, [topic]);
  const regenExhausted = regenAttempts >= SKELETON_REGEN_MAX;
  const layer1N = harvestSummary && typeof harvestSummary.layer1_courses_n === 'number' ? harvestSummary.layer1_courses_n : 0;
  const layer3N = harvestSummary && typeof harvestSummary.layer3_papers_n === 'number' ? harvestSummary.layer3_papers_n : 0;
  const layer4N = harvestSummary && typeof harvestSummary.layer4_posts_n === 'number' ? harvestSummary.layer4_posts_n : 0;
  const daemonAvailable = !!(harvestSummary && harvestSummary.daemon_available);
  // Group sources by layer + dedicated buckets for library / community per
  // 2026-05-12 user request "显示具体参考了哪几个网站, library 中的哪些书,
  // 社区中的什么内容". library/community pulled out of `legacy` so user sees
  // them as first-class buckets, not hidden in generic "其他".
  const sourcesByLayer = (() => {
    if (!Array.isArray(sources)) return null;
    const buckets = { layer1: [], layer3: [], layer4: [], library: [], community: [], legacy: [] };
    for (const s of sources) {
      if (!s) continue;
      const type = (s.sourceType || s.source_type || '').toString().toLowerCase();
      const layer = (s.layer || s.tier || s.source_layer || '').toString().toLowerCase();
      if (type === 'library' || (s.url || '').startsWith('library://')) buckets.library.push(s);
      else if (type === 'forum-anchor' || type === 'community' || type === 'hn' || layer.indexOf('4') >= 0 || layer === 'community') buckets.community.push(s);
      else if (layer.indexOf('1') >= 0 || layer === 'layer1' || layer === 'canonical') buckets.layer1.push(s);
      else if (layer.indexOf('3') >= 0 || layer === 'layer3' || layer === 'frontier') buckets.layer3.push(s);
      else if (layer.indexOf('4') >= 0) buckets.layer4.push(s);
      else buckets.legacy.push(s);
    }
    return buckets;
  })();

  return (
    <div className="card-quiet col gap-12" style={{ padding: '18px 22px', marginBottom: 18, lineHeight: 1.55 }}>
      <div className="t-small mono" style={{ color: 'var(--ink-3)', letterSpacing: '.08em' }}>
        本节备课 · 满意即开始上课, 不满意请说哪里要改
      </div>

      {/* 2026-05-13 — Lesson count derivation marginalia. Shows the math user
          can audit ("100 天 × 考研 1.5 = 150 节") so they trust the count is
          computed not random. Drift warning if generated count differs from
          derived target. Links back to 需要修改 for adjustment. */}
      {countDerivation && (
        <div className="col gap-4" style={{
          padding: '8px 12px',
          borderLeft: `2px solid ${countDerivation.drift > 0 ? '#A35F47' : '#A66D2C'}`,
          background: `rgba(${countDerivation.drift > 0 ? '163,95,71' : '166,109,44'},0.04)`,
        }}>
          <div className="row gap-8" style={{ alignItems: 'baseline' }}>
            <span className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em' }}>节数估算</span>
            <span className="serif italic" style={{ fontSize: 14, color: 'var(--ink-2)' }}>
              {countDerivation.reasoning}
            </span>
          </div>
          {countDerivation.drift > 0 && (
            <div className="t-tiny" style={{ color: '#A35F47', fontStyle: 'italic' }}>
              实出 {countDerivation.actualCount} 节, 与估算差 {countDerivation.drift} 节. 想改时长 → 按 "需要修改"
            </div>
          )}
        </div>
      )}

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

      {/* R-LIB Day 6 — Per-book rollup card. Replaces flat library chunk list
          with book-level aggregate showing D/P/R hit breakdown + chapter TOC.
          Anchors skeleton in actual book structure (combats Galileo-skip bug). */}
      {libraryRollup && libraryRollup.length > 0 && (
        <div className="col gap-8" style={{ marginTop: 4 }}>
          <div className="t-tiny mono" style={{ color: '#A66D2C', letterSpacing: '.06em' }}>
            你的书架 · {libraryRollup.length} 本书参与了骨架设计
          </div>
          {libraryRollup.map((b, i) => {
            const vecSpan = (b.direct_hits > 0 ? 1 : 0) + (b.prereq_hits > 0 ? 1 : 0) + (b.related_hits > 0 ? 1 : 0);
            const isPrereqOnly = b.direct_hits === 0 && b.prereq_hits > 0;
            return (
              <div key={b.book_id || i} className="col gap-4" style={{ padding: '8px 12px', borderLeft: '2px solid #A66D2C', background: 'rgba(166,109,44,0.04)' }}>
                <div className="row gap-8" style={{ alignItems: 'baseline' }}>
                  <span className="serif" style={{ fontSize: 14, color: 'var(--ink)' }}>{b.book_title || '(未命名书籍)'}</span>
                  {b.book_author && <span className="t-tiny" style={{ color: 'var(--ink-3)' }}>· {b.book_author}</span>}
                  {vecSpan >= 2 && <span className="t-tiny mono" style={{ color: '#A66D2C', marginLeft: 'auto' }}>多向量命中</span>}
                </div>
                <div className="t-tiny mono" style={{ color: 'var(--ink-3)' }}>
                  hits · direct={b.direct_hits} / prereq={b.prereq_hits} / related={b.related_hits}
                  {isPrereqOnly && <span style={{ marginLeft: 6, fontStyle: 'italic' }}>(prereq context only — 前置概念锚)</span>}
                </div>
                {Array.isArray(b.toc) && b.toc.length > 0 && (
                  <details>
                    <summary className="t-tiny mono" style={{ color: 'var(--ink-3)', cursor: 'pointer', letterSpacing: '.06em' }}>
                      展开 全部 {b.toc.length} 节
                    </summary>
                    <ul className="col gap-2" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {b.toc.map((t, ti) => (
                        <li key={ti} className="t-small" style={{ color: 'var(--ink-2)' }}>
                          {t.title}
                          {t.type && t.type !== 'narrative' && (
                            <span className="t-tiny mono" style={{ marginLeft: 6, color: '#A66D2C' }}>[{t.type}]</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* R-LIB Day 6 — Community pack hint card. Pack-suggested chapters +
          contested questions surfaced when a curated pack matched the topic. */}
      {communityHint && Array.isArray(communityHint.packs_used) && communityHint.packs_used.length > 0 && (
        <div className="col gap-8" style={{ marginTop: 4 }}>
          <div className="t-tiny mono" style={{ color: '#8B6A4D', letterSpacing: '.06em' }}>
            社区包 · {communityHint.packs_used.length} 个 hypha-packs 命中
          </div>
          {communityHint.packs_used.map((pack, i) => {
            const packSyllabus = (communityHint.syllabus_skeleton || []).filter(s => s.pack_id === pack.id);
            return (
              <div key={pack.id || i} className="col gap-4" style={{ padding: '8px 12px', borderLeft: '2px solid #8B6A4D', background: 'rgba(139,106,77,0.04)' }}>
                <div className="row gap-8" style={{ alignItems: 'baseline' }}>
                  <span className="serif" style={{ fontSize: 14, color: 'var(--ink)' }}>{pack.id}</span>
                  <span className="t-tiny" style={{ color: 'var(--ink-3)' }}>· curator: {pack.curator}</span>
                  <span className="t-tiny" style={{ color: 'var(--ink-3)' }}>· ratified: {pack.ratified_count}</span>
                  {pack.stale && <span className="t-tiny mono" style={{ color: '#A35F47', marginLeft: 6 }}>[stale >12mo]</span>}
                </div>
                {packSyllabus.length > 0 && (
                  <ul className="col gap-2" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {packSyllabus.slice(0, 6).map((c, ci) => (
                      <li key={ci} className="t-small" style={{ color: 'var(--ink-2)' }}>
                        {c.chapter}
                        {Array.isArray(c.kp_candidates) && c.kp_candidates.length > 0 && (
                          <span className="t-tiny" style={{ marginLeft: 6, color: 'var(--ink-3)' }}>· {c.kp_candidates.slice(0, 4).join(', ')}{c.kp_candidates.length > 4 ? '…' : ''}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
          {Array.isArray(communityHint.contested_questions) && communityHint.contested_questions.length > 0 && (
            <div className="t-tiny" style={{ color: 'var(--ink-3)', fontStyle: 'italic', paddingLeft: 12 }}>
              {communityHint.contested_questions.length} 个争议问题 → CHALLENGE 模式 seed
            </div>
          )}
        </div>
      )}

      {/* Sources — open by default per user request 2026-05-12. Buckets:
          经典课程 / 前沿研究 / 社区 / Library (你的书架) / 其他. Per-source row
          shows title + URL (clickable) + author (library) + 30-char excerpt. */}
      {sourcesByLayer && (sourcesByLayer.layer1.length + sourcesByLayer.layer3.length + sourcesByLayer.layer4.length + sourcesByLayer.library.length + sourcesByLayer.community.length + sourcesByLayer.legacy.length > 0) && (
        <div className="col gap-10">
          <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em' }}>
            参考了 · {sourcesByLayer.layer1.length + sourcesByLayer.layer3.length + sourcesByLayer.layer4.length + sourcesByLayer.library.length + sourcesByLayer.community.length + sourcesByLayer.legacy.length} 条
          </div>
          {[
            ['library', 'Library · 你的书架', sourcesByLayer.library, '#A66D2C'],
            ['layer1', '经典课程', sourcesByLayer.layer1, '#4D8B9A'],
            ['layer3', '前沿研究', sourcesByLayer.layer3, '#4D8B9A'],
            ['community', '社区讨论' + (!daemonAvailable && layer4N === 0 ? ' (daemon down)' : ''), sourcesByLayer.community, '#8B6A4D'],
            ['layer4', '社区 (Layer 4)', sourcesByLayer.layer4, '#8B6A4D'],
            ['legacy', '其他 web 源', sourcesByLayer.legacy, '#666'],
          ].filter(([_id, _label, items]) => items.length > 0).map(([id, label, items, color]) => (
            <div key={id}>
              <div className="t-tiny mono" style={{ color: color, letterSpacing: '.06em', marginBottom: 4 }}>
                {label} ({items.length})
              </div>
              <ul className="col gap-4" style={{ paddingLeft: 18, margin: 0 }}>
                {items.slice(0, 8).map((s, i) => {
                  const title = String(s.title || s.id || s.book_title || s.chunk_title || `源 ${i + 1}`).slice(0, 120);
                  const url = s.url || '';
                  const author = s.book_author || s.author || '';
                  const excerpt = String(s.excerpt || s.snippet || '').slice(0, 180);
                  return (
                    <li key={i} className="t-small" style={{ color: 'var(--ink-2)' }}>
                      <div>
                        <span style={{ color: 'var(--ink)' }}>{title}</span>
                        {author && <span style={{ marginLeft: 6, color: 'var(--ink-3)', fontSize: 11 }}>· {author}</span>}
                      </div>
                      {url && !url.startsWith('library://') && (
                        <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', wordBreak: 'break-all' }}>{url}</div>
                      )}
                      {excerpt && (
                        <div style={{ fontSize: 12, color: 'var(--ink-2)', fontStyle: 'italic', marginTop: 1 }}>{excerpt}{(s.excerpt || s.snippet || '').length > 180 ? '…' : ''}</div>
                      )}
                    </li>
                  );
                })}
                {items.length > 8 && (
                  <li className="t-tiny" style={{ color: 'var(--ink-3)', fontStyle: 'italic' }}>… 还有 {items.length - 8} 条</li>
                )}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* 推荐网站 — 2026-05-12 user request: 用户能补 URL 给 LLM 加进 harvest.
          Pastes URL list, clicks 推荐, opens feedback textarea pre-filled with
          a structured prefix → existing regen pipeline picks up the URLs as
          part of skeleton modify feedback. */}
      {!feedbackOpen && (
        <details>
          <summary className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em', cursor: 'pointer' }}>
            ＋ 你还想推荐什么网站 / 资料?
          </summary>
          <UserUrlRecommendation
            onSubmit={(urls) => {
              const lines = urls.map(u => '- ' + u).join('\n');
              const prefilled = `请把下面用户推荐的资源加进 harvest, 重新生成骨架:\n${lines}\n\n(可选额外反馈: )`;
              onFeedbackDraftChange(prefilled);
              onRequestModify();
            }}
            disabled={regenerating || regenExhausted}
          />
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

const LessonChat = ({ goal, noteRel: propNoteRel, onBack, onYield, onOpenNotebook }) => {
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
  // v0.3 Creation System surface (Machino-γ, 2026-05-14) — bumped after each
  // /finish so DecisionLedgerCard refetches decisionList + assumptionList
  // (Machino-β extracts new decisions inside _fanOutPostSession). Avoids
  // wiring a renderer-side ipcRenderer.on('decisions-extracted') subscription
  // until that event lands in preload.js.
  const [finishCount, setFinishCount] = useState(0);
  // v0.2 Surface Finishing B3+B4 (Machino-A, 2026-05-08) — pre-lesson body
  // artifact (thesis / canonical_example / common_misconceptions / exit_proof
  // / mechanism / jargon / note_connection / optionally confession_markdown).
  // Read once per noteRel change; ChainHeader renders thesis (B3); /finish
  // slash handler reuses the cached body for confession surface (B4) without
  // a second IPC. Defensive: legacy lessons + IPC failures yield null silently.
  const [lessonBody, setLessonBody] = useState(null);
  // W8.3 Adaptive UX — notification_level gates secondary UI noise. Modes:
  // 'silent'   → suppress non-blocking error/info toasts; only fatal banners
  // 'minimal'  → default behavior (existing surface)
  // 'standard' → render every state row + spark proposal inline
  const [notificationLevel, setNotificationLevel] = useState('minimal');
  useEffect(() => {
    if (!(window.ptor && window.ptor.ux)) return;
    let cancelled = false;
    const slugFromRel = (() => {
      const m = noteRel && String(noteRel).match(/^([^\\/]+)[\\/]/);
      return m ? m[1] : null;
    })();
    window.ptor.ux.loadPrefs(slugFromRel).then(r => {
      if (!cancelled && r && r.ok && r.preferences && r.preferences.notification_level) {
        setNotificationLevel(r.preferences.notification_level);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [noteRel]);
  // W1.4 Misconception Engine — runtime callout state. Populated after the
  // user's reply walks into a known wrong-prior (detect IPC fires after the
  // user turn is added). UI renders a small editorial callout under the
  // tutor's next response inviting a 1-2 turn repair. `null` = no callout.
  // Shape: { category, severity, text, repair_prompt, expected_user_action }.
  const [misconceptionCallout, setMisconceptionCallout] = useState(null);
  // W2.3 Goal Guardian — runtime state shown as a GuardianBadge in PageFrame.
  // Populated after each user turn via window.ptor.guardian.assess (fire-and-
  // forget). UI renders the badge inline next to JudgeBadges; spark state
  // surfaces a small 📓 button that fires W1.5 capture:start. Default = null
  // (badge hidden). Per specs/goal-guardian.md §6.
  const [guardianState, setGuardianState] = useState(null);   // 'frustrated' | 'self_doubt' | ...
  const [guardianAction, setGuardianAction] = useState(null); // 'lower_difficulty' | ...
  // W1.3 Anti-Illusion gate state. Populated when /finish detects a
  // learning-illusion in the user's exit_proof reply; renders a micro-task
  // block that blocks the next-lesson nav until the user posts a real
  // attempt. Shape (subset of GateResult):
  //   { allowed:false, reason, required_action, micro_task:{ id, prompt, ... } }
  // null = no block. The gate IS purely advisory at the UI layer right now;
  // we surface the micro-task as a system message + a dismiss button. Full
  // hard-block of "Next Lesson" button binds in W1.3.1 once that surface
  // ships in the cadence engine.
  const [illusionGate, setIllusionGate] = useState(null);
  const [illusionMicroAnswer, setIllusionMicroAnswer] = useState('');
  // v0.4.13 Track A/B Exit Ramp (2026-05-19) — after /finish writes the note,
  // surface 3 choices: Track A (作品化) / Track B (给真人讲明白) / Skip
  // (仅私下学习). Per specs/track-a-b-social-sandbox.md MVP. Render block sits
  // INLINE (not modal) at the same render layer as the illusion gate so the
  // /finish digest still scrolls above it. Bridge:
  //   window.ptor.hypha.trackSetExitRamp(slug, lessonIdx, track, url?, note?)
  // → { ok, entry, error }. If bridge absent, surface a soft toast turn + skip.
  const [exitRampVisible, setExitRampVisible] = useState(false);
  // W2.4 Repair Pipeline callout. Populated when W2.3 Goal Guardian
  // assesses state ∈ {confused, frustrated, self_doubt} (placeholder
  // wiring — Guardian assessment surfaces via window.ptor.guardian once
  // W2.3 ships). Shape: { type:'confusion'|'motivation'|'self_doubt',
  // assessment_summary }. The callout is INLINE (not a modal); the user
  // picks → window.ptor.repair.run(...) → repair_turn + choices render.
  const [repairCallout, setRepairCallout] = useState(null);
  const [repairResult, setRepairResult] = useState(null);
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

  // W5.3 Living Note Reactivation — surface inline candidates when an older
  // note is semantically close to the active lesson body. Low visual weight:
  // brass-toned callout under ChainHeader, no modal. Click → onOpenNotebook
  // (existing prop) routes to the note. Per BLUEPRINT §10.2: do not review
  // notes, call them — the user reading the surface IS the reactivation.
  const [livingNoteCandidates, setLivingNoteCandidates] = useState([]);

  // W7.1 Pack revival — same shape as Living Note Reactivation but for parked
  // community Packs (BLUEPRINT §12.5 Parking Queue). Calls pack.suggestRevival
  // with the running lesson context; renders below the note callout as an
  // even-lower-visual-weight row. NO push notifications — the surface is
  // queried on each lessonBody change, not on a timer.
  const [packRevivalCandidates, setPackRevivalCandidates] = useState([]);
  useEffect(() => {
    if (!lessonSlug) { setLivingNoteCandidates([]); return undefined; }
    const reactivate = window.ptor && window.ptor.livingnote && window.ptor.livingnote.reactivate;
    if (typeof reactivate !== 'function') return undefined;
    let alive = true;
    (async () => {
      try {
        // queryText derived from lesson thesis + canonical example when body
        // is loaded; falls back to the most recent assistant turn.
        let queryText = '';
        if (lessonBody) {
          queryText = [
            lessonBody.thesis || '',
            lessonBody.canonical_example || '',
            lessonBody.mechanism || '',
          ].filter(Boolean).join('\n');
        }
        if (!queryText && Array.isArray(turnsRef.current)) {
          const tail = turnsRef.current.filter(t => t.role === 'assistant').slice(-1)[0];
          if (tail && tail.text) queryText = String(tail.text).slice(0, 1200);
        }
        if (!queryText) { if (alive) setLivingNoteCandidates([]); return; }
        const r = await reactivate(lessonSlug, 'lesson_active', { queryText, limit: 3 });
        if (!alive) return;
        if (r && r.ok && Array.isArray(r.candidates)) {
          // Skip self — current lesson note shouldn't reactivate itself.
          const filtered = r.candidates.filter(c => {
            if (!c || !c.path) return false;
            if (noteRel && c.path.endsWith(noteRel.replace(/\\/g, '/'))) return false;
            return true;
          });
          setLivingNoteCandidates(filtered.slice(0, 3));
        }
      } catch (_) { /* decorative — never block chat */ }
    })();
    return () => { alive = false; };
  }, [lessonSlug, lessonIdxNum, lessonBody, noteRel]);

  // W7.1 Pack revival — query parking-queue for parked packs relevant to the
  // running lesson body. Mirrors the Living Note effect: queryText derived
  // from thesis + canonical_example + mechanism, falls back to most-recent
  // assistant turn. Embed-stub ranks (W5.1); Jaccard fallback when absent.
  useEffect(() => {
    if (!lessonSlug) { setPackRevivalCandidates([]); return undefined; }
    const revive = window.ptor && window.ptor.pack && window.ptor.pack.suggestRevival;
    if (typeof revive !== 'function') return undefined;
    let alive = true;
    (async () => {
      try {
        let queryText = '';
        if (lessonBody) {
          queryText = [
            lessonBody.thesis || '',
            lessonBody.canonical_example || '',
            lessonBody.mechanism || '',
          ].filter(Boolean).join('\n');
        }
        if (!queryText && Array.isArray(turnsRef.current)) {
          const tail = turnsRef.current.filter(t => t.role === 'assistant').slice(-1)[0];
          if (tail && tail.text) queryText = String(tail.text).slice(0, 1200);
        }
        if (!queryText) { if (alive) setPackRevivalCandidates([]); return; }
        const r = await revive(lessonSlug, { text: queryText }, { topK: 3 });
        if (!alive) return;
        if (r && r.ok && Array.isArray(r.candidates)) {
          setPackRevivalCandidates(r.candidates.slice(0, 3));
        } else {
          setPackRevivalCandidates([]);
        }
      } catch (_) { /* decorative — never block chat */ }
    })();
    return () => { alive = false; };
  }, [lessonSlug, lessonIdxNum, lessonBody]);

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
      // Machino-γ 2026-05-14: bump after extractor runs so DecisionLedgerCard
      // refetches the latest decisions / assumptions written by Machino-β.
      setFinishCount(c => c + 1);
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
      // TODO Machino-E7 (2026-05-14, anchor-verify hint): when
      //   conf._verify && conf._verify.anchor_verify_verified === false
      // is true, append an oxblood-italic 9pt suffix "(锚未在记录中找到)"
      // to the line below so the user sees that the confession may be the
      // LLM self-fooling. Anchor list = conf._verify.missing_anchors. This
      // is a separate UI patch (touches Course Trust Panel styling) and
      // is intentionally NOT shipped in this round to keep diff scoped to
      // the verification module + confession.js integration only.
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

      // 2026-05-19 — /finish 走完后, 自动调 lesson:finish IPC 写完整 dual-layer
      // 笔记 (synthesizeNote 在 main.js L7793 — 课程基础 + 用户灵感 段落整理).
      // 旧 /finish 只 render 在 chat 的诊断卡片 ("LLM 乱码"), ! 写文件 ! 进 Notebook.
      // 现:
      //   (a) call lesson.finish → vault/<slug>/lesson-<N>.md 写实
      //   (b) chat 提示 "📓 本节笔记已存档 · 按 N 查看"
      //   (c) 'n' keyboard shortcut fires onOpenNotebook (handler 见 useEffect 下)
      try {
        const lessonBridge = window.ptor && window.ptor.lesson;
        if (lessonBridge && typeof lessonBridge.finish === 'function' && noteRel) {
          // 2026-05-19 v0.4.5 — userInsight aggregation. Old: last-turn only
          // (often "对" / "ok" / "嗯" → bare insight). New: aggregate ALL user
          // turns ≥10 chars across this session, join paragraphs, cap 3000 chars.
          // Gives synthesizeNote real material for the dual-layer 用户灵感 段.
          const userInsight = turnsRef.current
            .filter(t => t.role === 'user')
            .map(t => stripStateMarkers(t.text || '').trim())
            .filter(x => x && x.length > 10)
            .join('\n\n')
            .slice(0, 3000);

          // 2026-05-19 v0.4.5 — pacing violation detection via preload bridge
          // (canonical lib at app/lib/hypha-learn/state-machine.js). Bridge is
          // pure-function sync exposure, no IPC roundtrip.
          try {
            const stateHistory = turnsRef.current
              .filter(t => t.role === 'assistant')
              .map(t => {
                const m = String(t.text || '').match(/<!--\s*state\s*:\s*([A-Z_]+)\s*-->/i);
                return m ? m[1].toUpperCase() : null;
              })
              .filter(Boolean);

            const sm = window.ptor && window.ptor.stateMachine;
            const detectorResult = (sm && typeof sm.detectPacingViolations === 'function')
              ? sm.detectPacingViolations(stateHistory)
              : { ok: true, violations: [] };

            if (detectorResult && Array.isArray(detectorResult.violations) && detectorResult.violations.length > 0) {
              const lines = detectorResult.violations.map((v, i) => {
                const tag = v.type === 'VERIFY_TO_EXTEND_SKIP_APPLY' ? 'VERIFY→EXTEND 跳 APPLY'
                  : v.type === 'APPLY_COUNT_EXCEEDED' ? 'APPLY 超 ceiling'
                  : v.type === 'LESSON_TOO_SHORT' ? '课时太短 "死板速通"'
                  : v.type;
                return `  ${i + 1}. [${tag}] ${v.msg}`;
              }).join('\n');
              sysTurn('【pacing 检测 v0.4.5】本节有 ' + detectorResult.violations.length + ' 项 spec 偏离:\n' +
                lines + '\n(诊断信息, 不阻塞. 教学侧调整在 learn-turn.txt v0.4.5)');
            }
          } catch (err) {
            console.error('[pacing detector] bridge call failed:', err);
          }

          // v0.4.6 (2026-05-19) → v0.4.7 — 1-retry on transient failure with
          // structured error-code awareness.
          //   - substring match: timeout/empty/network/fetch/econnreset/abort/5xx/429
          //   - structured code: err.code in {ETIMEDOUT, ECONNRESET, ENETUNREACH,
          //     EAI_AGAIN, EPIPE}, err.status in {429, 502, 503, 504, 522, 524}
          // Non-transient errors (auth/BAD_INPUT/UNKNOWN_SCHEMA) fail-fast no retry.
          const TRANSIENT_RE = /timeout|empty|network|fetch|econnreset|abort|5\d{2}|429|enetunreach|eai_again|ehostunreach|epipe/i;
          const TRANSIENT_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED', 'ECONNREFUSED', 'EHOSTDOWN']);
          // v0.4.8 — TRANSIENT_STATUS: comprehensive 5xx + Cloudflare extensions.
          //   408 Request Timeout / 425 Too Early / 429 Rate Limit
          //   500-504 Generic 5xx / 507-511 LB-class
          //   520-527 Cloudflare server-side errors / 530 origin DNS error
          //   598-599 nginx proprietary timeouts
          const TRANSIENT_STATUS = new Set([
            408, 425, 429,
            500, 502, 503, 504, 507, 508, 510, 511,
            520, 521, 522, 523, 524, 525, 526, 527, 530,
            598, 599,
          ]);
          const isTransient = (errSource) => {
            if (!errSource) return false;
            const msg = typeof errSource === 'string' ? errSource
              : String((errSource.error || errSource.message || ''));
            if (TRANSIENT_RE.test(msg)) return true;
            const code = errSource.code || (errSource.cause && errSource.cause.code);
            if (code && TRANSIENT_CODES.has(String(code).toUpperCase())) return true;
            const status = errSource.status || (errSource.cause && errSource.cause.status);
            if (typeof status === 'number' && TRANSIENT_STATUS.has(status)) return true;
            return false;
          };
          let finishRes = null;
          let attemptIdx = 0;
          const maxAttempts = 2;
          while (attemptIdx < maxAttempts) {
            attemptIdx++;
            try {
              finishRes = await lessonBridge.finish(noteRel, userInsight, {
                sessionFile: sessionFile || null,
                mode: 'fresh',
              });
              if (finishRes && finishRes.ok) break;
              if (attemptIdx < maxAttempts && isTransient(finishRes)) {
                const errStr = String((finishRes && (finishRes.error || finishRes.message)) || '');
                sysTurn(`(笔记存档遇瞬时问题 [${errStr.slice(0, 40)}] · 1.5s 后重试)`);
                await new Promise((r) => setTimeout(r, 1500));
                continue;
              }
              break;
            } catch (innerErr) {
              if (attemptIdx < maxAttempts && isTransient(innerErr)) {
                const msg = String((innerErr && innerErr.message) || innerErr);
                sysTurn(`(笔记存档遇瞬时问题 [${msg.slice(0, 40)}] · 1.5s 后重试)`);
                await new Promise((r) => setTimeout(r, 1500));
                continue;
              }
              throw innerErr;
            }
          }
          if (finishRes && finishRes.ok) {
            sysTurn('· 本节笔记已存档 · 按 N (或返回首页 → NOTEBOOK) 打开完整笔记.');
          } else {
            const reason = (finishRes && (finishRes.error || finishRes.message)) || 'unknown';
            sysTurn(`(笔记自动存档失败: ${reason} — 请手动从 NOTEBOOK 重写, 或重新 /finish.)`);
          }
        }
      } catch (e) {
        sysTurn(`(笔记自动存档失败: ${(e && e.message) || e} — 请手动从 NOTEBOOK 重写.)`);
      }

      // W1.3 Anti-Illusion gate. Run AFTER the summary card so the user has
      // seen the "weakest link" surface. Picks the LAST user turn (their
      // exit_proof answer) and asks the gate to decide whether to block the
      // next-lesson jump. We fail open (`allowed=true`) on any IPC error so
      // a missing bridge / detector crash never strands the learner.
      try {
        const illusionBridge = window.ptor && window.ptor.illusion;
        if (illusionBridge && typeof illusionBridge.gate === 'function' && lessonBody) {
          const lastUser = [...turnsRef.current].reverse().find(t => t.role === 'user');
          const userExitProofAnswer = lastUser && typeof lastUser.text === 'string'
            ? stripStateMarkers(lastUser.text).trim()
            : '';
          const recentTurns = turnsRef.current
            .filter(t => t.role === 'user' || t.role === 'assistant')
            .slice(-6)
            .map(t => ({ role: t.role, text: stripStateMarkers(t.text || '') }));
          const gateRes = await illusionBridge.gate(
            { lessonKP: lessonBody, exitProof: lessonBody.exit_proof || '', userExitProofAnswer },
            { priorResponses: recentTurns, actionLog: [] },
          );
          if (gateRes && gateRes.ok && gateRes.result && gateRes.result.allowed === false) {
            setIllusionGate(gateRes.result);
            // Telemetry — events.jsonl row through whatever surface exists.
            // Direct file writes go through main; here we surface a hint line
            // in the chat so the user knows why the gate fired.
            const evidence = (gateRes.result.detection && Array.isArray(gateRes.result.detection.evidence))
              ? gateRes.result.detection.evidence.slice(0, 2).join(' · ')
              : '';
            sysTurn(`【先别急着下一课】检测到学习幻觉 (${gateRes.result.reason}). 请在下方做一个 30 秒小任务再继续. ${evidence ? '— ' + evidence : ''}`);
          }
        }
      } catch (_) { /* fail open — gate is advisory in v0 */ }

      // γ14+ Cross-Spark auto-fire (2026-05-15) — after /finish main flow
      // (summary card + illusion gate) silently kick the cross-spark generator
      // so the user sees 3 横向回声 next time they look at the footer band
      // without having to click 召唤. Fail-silent: bridge missing, LLM key
      // absent, or candidate pool empty all degrade to the existing manual CTA
      // surface. Not awaited — /finish itself never blocks on this.
      try {
        const concept = (lessonBody && typeof lessonBody.thesis === 'string' && lessonBody.thesis.trim())
          ? lessonBody.thesis.trim()
          : ((goal && goal.goalContract && goal.goalContract.north_star_goal)
              || (goal && goal.topic)
              || '');
        if (concept && lessonSlug && window.ptor && window.ptor.crossSpark
            && typeof window.ptor.crossSpark.generateForConcept === 'function') {
          window.ptor.crossSpark.generateForConcept({ slug: lessonSlug, concept, k: 3 })
            .then((r) => {
              if (r && r.ok && Array.isArray(r.sparks) && r.sparks.length > 0) {
                window.dispatchEvent(new CustomEvent('cross-spark:fired', {
                  detail: { slug: lessonSlug, concept, count: r.sparks.length },
                }));
              }
            })
            .catch(() => {});
        }
      } catch (_) { /* fail-silent — auto-fire never blocks /finish */ }

      // v0.4.13 — Track A/B Exit Ramp surface. ADDITIONAL to the /finish digest,
      // not replacement: surface after the digest card + illusion gate + spark
      // auto-fire so the user has read the summary first. Bridge presence check
      // is inside the click handler — surface even if bridge absent so the user
      // sees the prompt (handler will soft-fail with a toast).
      setExitRampVisible(true);

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
      // W1.4 Misconception detection — fire-and-forget pre-screen. Runs in
      // parallel with the tutor stream so detection latency does not delay
      // the response. When triggered, the callout banner appears under the
      // assistant's reply once it lands. lessonBody supplies the wrong-prior
      // bank + lesson context for the repair prompt. Safe no-op when the
      // bridge is missing (legacy build) or no body has been generated.
      (async () => {
        try {
          const bridge = window.ptor && window.ptor.hypha && window.ptor.hypha.misconception;
          if (!bridge || typeof bridge.detect !== 'function') return;
          if (!lessonBody || !Array.isArray(lessonBody.common_misconceptions)) return;
          if (!lessonSlug || !Number.isFinite(lessonIdxNum)) return;
          // Build classified misconception bank on the fly. The vault sidecar
          // is the long-term home; renderer-side classification keeps the
          // hook self-contained until W1.4-followup wires the auto-write.
          const kpId = `lesson-${lessonIdxNum}`;
          const bank = (lessonBody.common_misconceptions || []).map((t, i) => ({
            id: `${kpId}-mc-${i + 1}`,
            kp_id: kpId,
            text: t,
            severity: 'medium',
            cue_phrases: String(t || '').split(/[。.!?;；，,—–]+/).map(c => c.trim()).filter(c => c.length >= 4).slice(0, 4),
          }));
          const det = await bridge.detect(text, bank);
          if (!det || !det.ok || !det.triggered) return;
          const ctx = {
            thesis: lessonBody.thesis,
            canonical_example: lessonBody.canonical_example,
            exit_proof: lessonBody.exit_proof,
          };
          const rep = await bridge.repair(det.triggered, ctx);
          if (!rep || !rep.ok) return;
          setMisconceptionCallout({
            category: det.triggered.category || 'surface_understanding',
            severity: det.triggered.severity || 'medium',
            text: det.triggered.text || '',
            confidence: det.confidence || 0,
            repair_prompt: rep.repair_prompt || '',
            expected_user_action: rep.expected_user_action || 'text_explain',
          });
        } catch (_) { /* detection is decorative — never break the chat */ }
      })();

      // W2.3 Goal Guardian — fire-and-forget affect+state assessment.
      // Runs in parallel with the tutor stream so guardian latency does not
      // delay the response. State drives the PageFrame GuardianBadge only;
      // tutor system prompt injection happens server-side in agent.js
      // streamTurn (parallel path, no race — both read the same userMsg).
      (async () => {
        try {
          const gBridge = window.ptor && window.ptor.guardian;
          if (!gBridge || typeof gBridge.assess !== 'function') return;
          const recentUser = [...turns, { role: 'user', text }]
            .filter(t => t && t.role === 'user')
            .slice(-3)
            .map(t => ({ role: 'user', text: t.text || '' }));
          const r = await gBridge.assess({
            userTrace: { recentTurns: recentUser },
            currentLesson: lessonBody || null,
            goalContract: (lessonBody && lessonBody.goalContract) || null,
            slug: lessonSlug || null,
            lessonIdx: Number.isFinite(lessonIdxNum) ? lessonIdxNum : null,
          });
          if (r && r.ok && r.result) {
            setGuardianState(r.result.state || null);
            setGuardianAction(r.result.guardian_action || null);
          }
        } catch (_) { /* guardian is decorative — never break the chat */ }
      })();
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

        // v0.4.10 (2026-05-19) — pacing realtime detector. Per-turn version of
        // the /finish-time batch check. Fires immediately when this turn's
        // state declares VERIFY→EXTEND skip-APPLY (v0.4.5 spec violation —
        // surface VERIFY counted as deep understanding without transfer-test).
        // Soft warning, ! hard-block. Realtime feedback teaches the user
        // (and tutor self-correction loop) that the lesson is racing.
        try {
          if (currentState === 'VERIFY' && parsed && parsed.state === 'EXTEND') {
            setTurns(prev => [...prev, {
              id: _newTurnId(),
              role: 'system',
              text: '【pacing v0.4.5 实时】本轮 VERIFY → EXTEND 跳过 APPLY (transfer-test). Surface VERIFY ≠ deep understanding · 建议下轮让学生 apply 概念到新案例后再 EXTEND.',
            }]);
          }
        } catch (_) { /* pacing detector best-effort */ }

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
  // V0.5 E0 D5 — kernel swap. When state.json declares verification_channel
  // (root-level: applies to all lessons; or per-lesson on lessonPlan[idx]),
  // LessonChat renders <TupleSubstrateView /> instead of the chat metaphor.
  // Legacy chat path UNCHANGED when this stays null. Accepted values:
  // 'code' | 'sealed_rubric' | 'proof'. Wiring: D6 ships preload.js +
  // main.js IPC (window.ptor.evaluator.{nextInstance,submitResponse}); D6
  // also adds <script src="screen-tuple-substrate.jsx"> to HYPHA.html.
  const [verificationChannel, setVerificationChannel] = useState(null);
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
          // V0.5 E0 D5 — kernel-swap detection. Root verification_channel wins;
          // per-lesson slot override possible. Whitelisted to known channels so
          // a malformed state.json can't smuggle arbitrary strings into the swap.
          const KNOWN_CHANNELS = ['code', 'sealed_rubric', 'proof'];
          let vc = null;
          if (s) {
            const slotChannel = (lessonIdxNum != null
              && Array.isArray(s.lessonPlan)
              && s.lessonPlan[lessonIdxNum]
              && s.lessonPlan[lessonIdxNum].verification_channel) || null;
            const rootChannel = s.verification_channel || null;
            const candidate = slotChannel || rootChannel;
            if (candidate && KNOWN_CHANNELS.indexOf(candidate) !== -1) vc = candidate;
          }
          setVerificationChannel(vc);
        } catch (err) {
          setPreviewLessonTitles([]); setSkeletonPlan(null); setVerificationChannel(null);
          console.warn('[lesson-chat] state.json parse failed:', err && err.message);
        }
        try {
          const arr = sourcesTxt ? JSON.parse(sourcesTxt) : null;
          setPreviewTopSources(Array.isArray(arr) ? arr.slice(0, 5) : []);
          if (Array.isArray(arr)) setHarvestSources(prev => prev || arr);
        } catch (_) { setPreviewTopSources([]); }
      } catch (_) {}
    })();
    return () => { alive = false; };
  }, [lessonSlug, lessonIdxNum]);

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
  // Phase C entry — wraps onOpenNotebook so it always fires with the live
  // noteRel (post curriculum-create), not the stale prop value.
  const handleOpenNotebook = useCallback(() => {
    if (typeof onOpenNotebook !== 'function') return;
    onOpenNotebook(noteRel || propNoteRel || null);
  }, [onOpenNotebook, noteRel, propNoteRel]);

  // 2026-05-19 — Keyboard shortcut: 'n' / 'N' (no modifier) → open notebook.
  // Guards against firing while user is typing in input/textarea/contenteditable.
  // Replaces the removed "📓 笔记" header button (2026-05-17 removal). Without
  // a shortcut user had no fast-path from Lesson Chat → current lesson's note.
  useEffect(() => {
    const onKey = (e) => {
      if (!e || (e.key !== 'n' && e.key !== 'N')) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      // Don't fire while typing
      const t = e.target;
      if (t && (
        t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.isContentEditable
      )) return;
      if (typeof onOpenNotebook !== 'function') return;
      if (!(noteRel || propNoteRel)) return;
      e.preventDefault();
      handleOpenNotebook();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [handleOpenNotebook, onOpenNotebook, noteRel, propNoteRel]);

  if (bridgeMissing) {
    return (
      <PageFrame onBack={onBack} onOpenNotebook={typeof onOpenNotebook === 'function' ? handleOpenNotebook : undefined}>
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
    <PageFrame onBack={onBack} onOpenNotebook={typeof onOpenNotebook === 'function' ? handleOpenNotebook : undefined} slug={lessonSlug} lessonIdx={lessonIdxNum} harnessResult={trustResult && trustResult.latest ? {
      // Read latest turn's signals for the trust panel; aggregates available
      // via trustResult.history / .minCoherence / .pasteDetectedAny per
      // MEOW Gate B Patch 3 rolling-history accumulation.
      score: trustResult.latest.score,
      persona: trustResult.latest.persona,
      minCoherence: trustResult.minCoherence,
      pasteDetectedAny: trustResult.pasteDetectedAny,
    } : null}
    guardianState={guardianState}
    guardianAction={guardianAction}
    onGuardianCapture={async () => {
      // W2.3 spark capture — kicks W1.5 capture:start. UI surface; backend
      // handles vault path + sidecar. Badge state clears on close to avoid
      // a stale 📓 lingering after the capture session ends.
      try {
        if (window.ptor && window.ptor.capture && typeof window.ptor.capture.start === 'function') {
          await window.ptor.capture.start({ source: 'guardian_spark', context: { slug: lessonSlug, lessonIdx: lessonIdxNum } });
        }
      } catch (_) { /* capture optional */ }
      setGuardianState(null);
      setGuardianAction(null);
    }}
    >
      {/* α11 Living Note Reactivation banner (2026-05-15) — listens for
          note:reactivation-found broadcast emitted by main.js post-body
          auto-scan. Slim top banner above ChainHeader; renders 1-3
          candidates whose transfer_point is re-activated by this lesson.
          Self-hides when payload.slug !== current slug OR candidates is
          empty OR user dismisses via ×. */}
      {typeof NoteReactivationCard === 'function' && lessonSlug && (
        <NoteReactivationCard slug={lessonSlug} lessonIdx={lessonIdxNum} />
      )}

      <ChainHeader goal={goal} noteRel={noteRel} lessonBody={lessonBody} />

      {/* W5.3 Living Note Reactivation — inline brass callout for relevant
          older notes. Low visual weight, no modal. Clicking a row routes to
          the notebook surface so the user can re-engage in the actual reading
          context (not a flashcard popup). Hidden when no candidates clear
          the relevance threshold. */}
      {livingNoteCandidates && livingNoteCandidates.length > 0 && (
        <div className="col gap-6" style={{
          margin: '8px 0 12px',
          padding: '10px 14px',
          borderLeft: '2px solid #A66D2C',
          background: 'rgba(166, 109, 44, 0.05)',
          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
        }}>
          <div className="t-tiny mono" style={{ color: '#8B7355', letterSpacing: '.08em' }}>
            旧笔记复活 · 这节课与你过去的笔记相关
          </div>
          {livingNoteCandidates.map((c, i) => (
            <button
              key={c.path || i}
              className="row gap-8"
              onClick={() => {
                if (typeof onOpenNotebook === 'function' && c.path) {
                  // Strip vault root prefix so onOpenNotebook receives a vault-relative path.
                  const rel = c.path.replace(/\\/g, '/').split(/\/(?=[^\/]+\/[^\/]+\.md$)/).pop() || c.path;
                  onOpenNotebook(rel);
                }
              }}
              style={{
                background: 'transparent', border: 'none', padding: '4px 0',
                textAlign: 'left', cursor: 'pointer',
                fontFamily: 'EB Garamond, "Noto Serif SC", serif',
                fontSize: 14, color: 'var(--ink)',
              }}
            >
              <span className="serif" style={{ color: '#8B7355' }}>{c.title}</span>
              <span className="t-tiny mono" style={{ color: 'var(--ink-3)', marginLeft: 8 }}>
                {c.state} · {Math.round((c.relevance || 0) * 100)}%
              </span>
              <span style={{ marginLeft: 12, color: 'var(--ink-2)' }}>{c.reason}</span>
            </button>
          ))}
        </div>
      )}

      {/* W7.1 Pack revival — even lower visual weight than the Living Note
          callout. One line per parked pack with reason + score. Click opens
          the Pack Learning surface via the global __hyphaOpenPack hook so the
          user can decide to actually pick it up (or leave it parked). Hidden
          when no candidates clear the relevance floor. */}
      {packRevivalCandidates && packRevivalCandidates.length > 0 && (
        <div className="col gap-4" style={{
          margin: '6px 0 10px',
          padding: '8px 14px',
          borderLeft: '1px dashed var(--ink-3)',
          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
        }}>
          <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.08em' }}>
            待复活的 Pack · 与这节课相关
          </div>
          {packRevivalCandidates.map((c, i) => {
            const entry = (c && c.entry) || {};
            const meta = entry.meta || {};
            return (
              <button
                key={entry.packId || i}
                className="row gap-8"
                onClick={() => {
                  if (typeof window.__hyphaOpenPack === 'function') {
                    // Re-hydrate a minimal pack shape from the parking entry
                    // metadata. The Pack Learning screen tolerates a thin
                    // pack — PIC degrades to the algorithmic fields, the 6
                    // operations still wire against pack.topic + id.
                    window.__hyphaOpenPack({
                      id: entry.packId,
                      topic: meta.topic || entry.packId,
                      lang: meta.lang || 'zh',
                    });
                  }
                }}
                style={{
                  background: 'transparent', border: 'none', padding: '2px 0',
                  textAlign: 'left', cursor: 'pointer',
                  fontFamily: 'EB Garamond, "Noto Serif SC", serif',
                  fontSize: 13.5, color: 'var(--ink-2)',
                }}
              >
                <span className="serif">{meta.topic || entry.packId}</span>
                <span className="t-tiny mono" style={{ color: 'var(--ink-3)', marginLeft: 8 }}>
                  {Math.round((c.score || 0) * 100)}% · {c.basis}
                </span>
                {entry.reason && (
                  <span style={{ marginLeft: 12, color: 'var(--ink-3)', fontStyle: 'italic' }}>{entry.reason}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

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
          topic={(goal && goal.goalContract && goal.goalContract.north_star_goal) || null}
          goalContract={(goal && goal.goalContract) || null}
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

      {turns.length === 0 && !lessonBody && !skeletonPlan && !genProgress && !verificationChannel && (
        <div className="serif italic" style={{ marginBottom: 20, fontSize: 15, color: 'var(--ink-2)' }}>
          Type your first message to begin. The tutor opens with a probing question — answer in your own words. Type <span className="mono">/help</span> for commands.
        </div>
      )}

      {/* V0.5 E0 D5 — kernel swap. When state.json declares verification_channel,
          render TupleSubstrateView (Instance / Response / Verdict) instead of
          the chat transcript. Legacy chat path runs UNCHANGED for absent channel.
          window.TupleSubstrateView is registered by screen-tuple-substrate.jsx;
          if HYPHA.html script-tag wiring (D6 scope) is missing, fall back to a
          manuscript-register banner explaining the pending wiring. */}
      {verificationChannel ? (
        (() => {
          const TupleView = window.TupleSubstrateView;
          return TupleView ? (
            <TupleView slug={lessonSlug} lessonIdx={lessonIdxNum} />
          ) : (
          <div
            className="serif italic"
            style={{
              marginTop: 16,
              padding: '20px 0',
              borderTop: '1px solid #a98b3a',
              borderBottom: '1px solid #a98b3a',
              color: 'var(--ink-2)',
              fontSize: 14,
              lineHeight: 1.6,
            }}
          >
            evaluator IPC pending — verification channel “{verificationChannel}” declared, but
            <span className="mono"> window.TupleSubstrateView</span> is not yet loaded
            (D6 wiring adds <span className="mono">screen-tuple-substrate.jsx</span> to HYPHA.html).
          </div>
          );
        })()
      ) : (
        <TranscriptList
          turns={turns}
          streamingTurnId={streamingTurnId}
          currentStreamState={streamState}
          onAbort={handleAbort}
        />
      )}

      {/* W1.4 Misconception Callout — surfaces when the user's reply walks
          into a known wrong-prior. Editorial register (manuscript voice, no
          alarm color), inline-dismissible. The repair_prompt is the tutor-
          side hint; we only show the human-readable label here. */}
      {misconceptionCallout && (
        <div
          className="card-quiet col gap-8"
          style={{ padding: 14, marginTop: 10, borderLeft: '2px solid var(--brass-bright, #b8893a)' }}
        >
          <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.08em' }}>
            MISCONCEPTION · {String(misconceptionCallout.category || '').replace(/_/g, ' ')} · {misconceptionCallout.severity}
          </div>
          <div className="serif" style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--ink-2)' }}>
            你刚才那一步, 似乎踩在了一个常见的歧路上 —— 让我们花一两轮把它修一下.
          </div>
          <div className="serif" style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--ink-3)', fontStyle: 'italic' }}>
            {String(misconceptionCallout.text || '').slice(0, 200)}
          </div>
          <div className="row gap-8">
            <button
              type="button"
              className="t-tiny mono"
              style={{ background: 'transparent', border: '1px solid var(--ink-3)', padding: '4px 10px', cursor: 'pointer' }}
              onClick={() => setMisconceptionCallout(null)}
            >
              已了解 / 跳过
            </button>
          </div>
        </div>
      )}

      {/* W2.4 Repair Pipeline callout. Triggered by W2.3 Goal Guardian
          when state ∈ {confused, frustrated, self_doubt}. INLINE (not a
          modal) — manuscript register, brass hairline, no alarm color.
          Two states:
            1. callout (Guardian flagged) — pick a repair, no result yet
            2. result (pipeline ran)      — render repair_turn + choices
          See specs/repair-pipelines.md + BLUEPRINT §3.4. */}
      {(repairCallout || repairResult) && (
        <div
          className="card-quiet col gap-10"
          style={{ padding: 16, marginTop: 12, borderLeft: '2px solid var(--brass-bright, #b8893a)' }}
        >
          <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.08em' }}>
            REPAIR · {String((repairResult && repairResult.type) || (repairCallout && repairCallout.type) || '').replace(/_/g, ' ')}
          </div>
          {!repairResult && repairCallout && (
            <div className="col gap-8">
              <div className="serif" style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--ink-2)' }}>
                {repairCallout.assessment_summary || '刚才那一步, 我看出了一个具体的修法路径 —— 是否启动?'}
              </div>
              <div className="row gap-8">
                <button
                  type="button"
                  className="t-tiny mono"
                  style={{ background: 'transparent', border: '1px solid var(--ink-3)', padding: '4px 10px', cursor: 'pointer' }}
                  onClick={async () => {
                    try {
                      const bridge = window.ptor && window.ptor.repair;
                      if (!bridge || typeof bridge.run !== 'function') return;
                      const args = {
                        slug: lessonSlug,
                        recentTurns: turns.slice(-8),
                        lessonContext: lessonBody
                          ? { thesis: lessonBody.thesis, canonical_example: lessonBody.canonical_example }
                          : {},
                        ...(repairCallout.args || {}),
                      };
                      const r = await bridge.run({ type: repairCallout.type, args });
                      if (r && r.ok) setRepairResult(r);
                    } catch (_) { /* never crash chat */ }
                  }}
                >
                  启动修法
                </button>
                <button
                  type="button"
                  className="t-tiny mono"
                  style={{ background: 'transparent', border: '1px solid var(--ink-3)', padding: '4px 10px', cursor: 'pointer' }}
                  onClick={() => setRepairCallout(null)}
                >
                  暂时跳过
                </button>
              </div>
            </div>
          )}
          {repairResult && (
            <div className="col gap-10">
              <div
                className="serif"
                style={{ fontSize: 13, lineHeight: 1.65, color: 'var(--ink)', whiteSpace: 'pre-wrap' }}
              >
                {(repairResult.result && (repairResult.result.repair_turn || repairResult.result.recovery_turn)) || ''}
              </div>
              <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
                {Array.isArray(repairResult.result && (repairResult.result.choices || repairResult.result.actions || repairResult.result.rest_options))
                  ? (repairResult.result.choices || repairResult.result.actions || repairResult.result.rest_options).map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className="t-tiny mono"
                        style={{ background: 'transparent', border: '1px solid var(--ink-3)', padding: '4px 10px', cursor: 'pointer' }}
                        onClick={() => {
                          setRepairResult(null);
                          setRepairCallout(null);
                        }}
                      >
                        {c.label || c.id}
                      </button>
                    ))
                  : null}
              </div>
            </div>
          )}
        </div>
      )}

      {error && notificationLevel !== 'silent' && (
        // W8.3 — under notification_level=silent, suppress this banner.
        <div className="card-quiet col gap-8" style={{ padding: 16, marginTop: 12 }}>
          <div className="t-tiny mono" style={{ color: 'var(--terracotta-2)', letterSpacing: '.08em' }}>
            {error.error || 'UNKNOWN'}
          </div>
          <div className="t-body" style={{ color: 'var(--ink-2)' }}>
            {error.message || 'No diagnostic message.'}
          </div>
        </div>
      )}

      {/* W1.3 Anti-Illusion micro-task block. Renders only when /finish's
          gate eval flagged a learning-illusion. The block is INLINE (not a
          modal) so the user can't accidentally dismiss it; "完成 + 继续"
          re-runs the gate against the new answer, "暂时跳过" surfaces the
          override but writes a `bypass` event so we can audit how often it
          gets pressed. micro_task.prompt is a deterministic template today
          (T4_JUDGE wiring deferred to W1.3.1). */}
      {illusionGate && illusionGate.micro_task && (
        <div className="card-quiet col gap-12" style={{ padding: 22, marginTop: 20, borderLeft: '3px solid var(--ochre-2, #B07A2C)' }}>
          <div className="t-tiny mono" style={{ color: 'var(--ochre-2, #B07A2C)', letterSpacing: '.08em' }}>
            ANTI-ILLUSION · 30 秒小任务
          </div>
          <div className="serif" style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--ink)' }}>
            {illusionGate.micro_task.prompt}
          </div>
          <textarea
            value={illusionMicroAnswer}
            onChange={e => setIllusionMicroAnswer(e.target.value)}
            rows={3}
            placeholder="一句具体的话, 必须有时间地点或对象..."
            style={{
              width: '100%', padding: '10px 12px',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: 13, lineHeight: 1.55,
              color: 'var(--ink)', background: 'var(--cream)',
              border: '1px solid var(--rule-soft)', borderRadius: 4,
              resize: 'vertical', boxSizing: 'border-box',
            }}
          />
          <div className="row gap-12" style={{ alignItems: 'center' }}>
            <button
              className="btn btn-primary"
              style={{ fontSize: 13, opacity: illusionMicroAnswer.trim().length < 8 ? 0.4 : 1 }}
              disabled={illusionMicroAnswer.trim().length < 8}
              onClick={async () => {
                // Re-eval the gate using the micro-task answer as the new
                // exit_proof. Pass-through unblocks; still-failing keeps the
                // block + bumps the prompt to a misconception_repair surface.
                try {
                  const bridge = window.ptor && window.ptor.illusion;
                  if (!bridge || !lessonBody) {
                    setIllusionGate(null);
                    setIllusionMicroAnswer('');
                    return;
                  }
                  const r = await bridge.gate(
                    { lessonKP: lessonBody, exitProof: illusionGate.micro_task.prompt, userExitProofAnswer: illusionMicroAnswer.trim() },
                    { actionLog: [] },
                  );
                  if (r && r.ok && r.result && r.result.allowed) {
                    setIllusionGate(null);
                    setIllusionMicroAnswer('');
                    setTurns(prev => [...prev, { id: _newTurnId(), role: 'system', text: '【小任务通过】可以继续下一课.' }]);
                  } else if (r && r.ok && r.result && r.result.allowed === false) {
                    setIllusionGate(r.result);
                    setIllusionMicroAnswer('');
                  } else {
                    setIllusionGate(null);
                    setIllusionMicroAnswer('');
                  }
                } catch (_) {
                  setIllusionGate(null);
                  setIllusionMicroAnswer('');
                }
              }}
            >完成 + 继续</button>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 13, color: 'var(--ink-3)' }}
              onClick={() => {
                setTurns(prev => [...prev, { id: _newTurnId(), role: 'system', text: `【暂时跳过】记录为 ${illusionGate.reason} bypass.` }]);
                setIllusionGate(null);
                setIllusionMicroAnswer('');
              }}
            >暂时跳过</button>
            <span className="spacer" />
            <span className="t-tiny mono" style={{ color: 'var(--ink-3)' }}>
              {illusionGate.reason} · {illusionGate.required_action}
            </span>
          </div>
        </div>
      )}

      {/* v0.4.13 Track A/B Exit Ramp — 3 choices after /finish writes the note.
          INLINE block, same register as the illusion gate above. roman action
          labels (per feedback_italic_decoration_only). Brass accent strip on
          the left edge to mark this as a ritual decision surface, not a chat
          turn. Each handler validates URL prefix + soft-fails on bridge miss. */}
      {exitRampVisible && (
        <div className="card-quiet col gap-12" style={{ padding: 22, marginTop: 20, borderLeft: '3px solid var(--brass-mid, #9B7A3F)' }}>
          <div className="t-tiny mono" style={{ color: 'var(--brass-mid, #9B7A3F)', letterSpacing: '.08em' }}>
            离场仪式 · 本节结束
          </div>
          <div className="serif" style={{ fontSize: 14, lineHeight: 1.65, color: 'var(--ink)' }}>
            选一条出路:
            <div style={{ marginTop: 8, paddingLeft: 12, color: 'var(--ink-2)' }}>
              <div style={{ marginBottom: 4 }}>
                <span style={{ color: 'var(--terracotta-1, #B4593A)', fontWeight: 500 }}>Track A</span>
                <span> · 把本节作品化 (code / doc / post URL)</span>
              </div>
              <div style={{ marginBottom: 4 }}>
                <span style={{ color: 'var(--terracotta-1, #B4593A)', fontWeight: 500 }}>Track B</span>
                <span> · 给真人讲明白 (thread / video URL)</span>
              </div>
              <div>
                <span style={{ color: 'var(--ink-3)' }}>Skip</span>
                <span> · 仅私下学习</span>
              </div>
            </div>
          </div>
          <div className="row gap-12" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary"
              style={{ fontSize: 13 }}
              onClick={async () => {
                // Track A — artifact 作品化. Prompt for URL + note. Cancel on URL
                // prompt = abort (toast). Cancel on note = treat as no-note.
                const url = window.prompt('Artifact URL (留空 = 承诺将来交付)', '');
                if (url === null) {
                  setTurns(prev => [...prev, { id: _newTurnId(), role: 'system', text: '取消, 未记录.' }]);
                  return;
                }
                const trimmedUrl = url.trim();
                if (trimmedUrl && !/^https?:\/\//i.test(trimmedUrl)) {
                  setTurns(prev => [...prev, { id: _newTurnId(), role: 'system', text: 'URL 须以 http:// 或 https:// 开头.' }]);
                  return;
                }
                const note = window.prompt('一句话承诺 (可选)', '');
                if (note === null) {
                  setTurns(prev => [...prev, { id: _newTurnId(), role: 'system', text: '取消, 未记录.' }]);
                  return;
                }
                const trimmedNote = note.trim();
                try {
                  const bridge = window.ptor && window.ptor.hypha && window.ptor.hypha.trackSetExitRamp;
                  if (typeof bridge !== 'function') {
                    setTurns(prev => [...prev, { id: _newTurnId(), role: 'system', text: 'exit ramp 桥接未连 · 本次跳过.' }]);
                    setExitRampVisible(false);
                    return;
                  }
                  const r = await bridge(lessonSlug, lessonIdxNum, 'A', trimmedUrl || null, trimmedNote || null);
                  if (r && r.ok) {
                    setTurns(prev => [...prev, { id: _newTurnId(), role: 'system', text: '已设 Track A · 作品化.' }]);
                  } else {
                    const reason = (r && (r.error || r.message)) || 'unknown';
                    setTurns(prev => [...prev, { id: _newTurnId(), role: 'system', text: `Track A 记录失败: ${reason}.` }]);
                  }
                } catch (e) {
                  setTurns(prev => [...prev, { id: _newTurnId(), role: 'system', text: `Track A 记录失败: ${(e && e.message) || e}.` }]);
                }
                setExitRampVisible(false);
              }}
            >Track A</button>
            <button
              className="btn btn-primary"
              style={{ fontSize: 13 }}
              onClick={async () => {
                // Track B — 给真人讲明白. Same shape as Track A handler, swap
                // copy + track tag. Publication URL field; cancel handling same.
                const url = window.prompt('Publication URL — thread / video (留空 = 承诺将来交付)', '');
                if (url === null) {
                  setTurns(prev => [...prev, { id: _newTurnId(), role: 'system', text: '取消, 未记录.' }]);
                  return;
                }
                const trimmedUrl = url.trim();
                if (trimmedUrl && !/^https?:\/\//i.test(trimmedUrl)) {
                  setTurns(prev => [...prev, { id: _newTurnId(), role: 'system', text: 'URL 须以 http:// 或 https:// 开头.' }]);
                  return;
                }
                const note = window.prompt('一句话承诺 (可选)', '');
                if (note === null) {
                  setTurns(prev => [...prev, { id: _newTurnId(), role: 'system', text: '取消, 未记录.' }]);
                  return;
                }
                const trimmedNote = note.trim();
                try {
                  const bridge = window.ptor && window.ptor.hypha && window.ptor.hypha.trackSetExitRamp;
                  if (typeof bridge !== 'function') {
                    setTurns(prev => [...prev, { id: _newTurnId(), role: 'system', text: 'exit ramp 桥接未连 · 本次跳过.' }]);
                    setExitRampVisible(false);
                    return;
                  }
                  const r = await bridge(lessonSlug, lessonIdxNum, 'B', trimmedUrl || null, trimmedNote || null);
                  if (r && r.ok) {
                    setTurns(prev => [...prev, { id: _newTurnId(), role: 'system', text: '已设 Track B · 给真人讲.' }]);
                  } else {
                    const reason = (r && (r.error || r.message)) || 'unknown';
                    setTurns(prev => [...prev, { id: _newTurnId(), role: 'system', text: `Track B 记录失败: ${reason}.` }]);
                  }
                } catch (e) {
                  setTurns(prev => [...prev, { id: _newTurnId(), role: 'system', text: `Track B 记录失败: ${(e && e.message) || e}.` }]);
                }
                setExitRampVisible(false);
              }}
            >Track B</button>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 13, color: 'var(--ink-3)' }}
              onClick={async () => {
                // Skip — record as 'skip' so the audit knows the user saw the
                // ramp + opted out (vs never reached it). No prompts.
                try {
                  const bridge = window.ptor && window.ptor.hypha && window.ptor.hypha.trackSetExitRamp;
                  if (typeof bridge !== 'function') {
                    setTurns(prev => [...prev, { id: _newTurnId(), role: 'system', text: 'exit ramp 桥接未连 · 本次跳过.' }]);
                    setExitRampVisible(false);
                    return;
                  }
                  const r = await bridge(lessonSlug, lessonIdxNum, 'skip');
                  if (r && r.ok) {
                    setTurns(prev => [...prev, { id: _newTurnId(), role: 'system', text: '已记 skip.' }]);
                  } else {
                    const reason = (r && (r.error || r.message)) || 'unknown';
                    setTurns(prev => [...prev, { id: _newTurnId(), role: 'system', text: `skip 记录失败: ${reason}.` }]);
                  }
                } catch (e) {
                  setTurns(prev => [...prev, { id: _newTurnId(), role: 'system', text: `skip 记录失败: ${(e && e.message) || e}.` }]);
                }
                setExitRampVisible(false);
              }}
            >Skip</button>
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

      {/* v0.3 Creation System surface (Machino-γ, 2026-05-14) — decision +
          assumption ledger. Mounts below the post-session audit. Self-hides
          when the slug has no ledger entries OR the Creation bridge is not
          yet on window.ptor (Machino-α still wiring). refreshTrigger bumps
          on every /finish so the card pulls newly-extracted rows from
          Machino-β. Defensive: typeof check matches the rest of HYPHA's
          screen-script render guards (e.g. CourseTrustPanel above). */}
      {typeof DecisionLedgerCard === 'function' && lessonSlug && (
        <DecisionLedgerCard slug={lessonSlug} refreshTrigger={finishCount} />
      )}

      {/* v0.3 Creation System surface (Machino-γ2, 2026-05-14) — product
          spark log. Mounts directly below the decision ledger. Self-hides
          when sparkList is empty OR window.ptor.creation.sparkList is not
          yet wired (Machino-α2 in flight). refreshTrigger bumps on every
          /finish so the card pulls newly-extracted sparks from Machino-β2. */}
      {typeof ProductSparkCard === 'function' && lessonSlug && (
        <ProductSparkCard slug={lessonSlug} refreshTrigger={finishCount} />
      )}

      {/* v0.3 Creation System surface (Machino-β4, 2026-05-14) — weekly
          roadmap. Mounts directly below the product spark card. Self-hides
          when the slug has no roadmap markdown OR
          window.ptor.creation.roadmapGetLatest is not yet wired (Machino-α4
          in flight). refreshTrigger bumps on every /finish so the card
          pulls the latest weekly sync. */}
      {typeof RoadmapCard === 'function' && lessonSlug && (
        <RoadmapCard slug={lessonSlug} refreshTrigger={finishCount} />
      )}

      {/* γ11 Web Note Engine surface (2026-05-15) — typed-edge neighbors for
          the current (slug, noteIdx). Reads window.ptor.notes.getNeighbors
          on mount; self-hides when both incoming and outgoing are empty.
          Renders edge type 中文化 (cites→引用 / contradicts→反驳 /
          extends→延伸 / triggered-by→触发 / related→相关) + direction
          symbol (outgoing →, incoming ←, related ⇄). Clicking the
          lesson-N anchor dispatches `hypha:open-lesson` for app.jsx routing. */}
      {typeof NoteEdgeCard === 'function' && lessonSlug && typeof lessonIdxNum === 'number' && (
        <NoteEdgeCard slug={lessonSlug} noteIdx={lessonIdxNum} />
      )}

      {/* γ14 Cross-Spark Card (2026-05-15) — 召唤 3 道跨域共鸣 anchored to the
          current lesson thesis (or goal label as fallback). Mounts directly
          after NoteEdgeCard since both are "lateral connection" surfaces in
          the lesson footer band. Reads window.ptor.crossSpark.{list,generate}
          per the β14 contract; gracefully renders a gray "未连接" state when
          the bridge has not yet been wired by the parallel β14 backend ship.
          NOT auto-fired — user must click 召唤 (LLM call costs money). */}
      {typeof CrossSparkCard === 'function' && lessonSlug && (
        <CrossSparkCard
          slug={lessonSlug}
          concept={
            (lessonBody && typeof lessonBody.thesis === 'string' && lessonBody.thesis.trim())
              ? lessonBody.thesis.trim()
              : ((goal && goal.goalContract && goal.goalContract.north_star_goal)
                  || (goal && goal.topic)
                  || '')
          }
        />
      )}

      {/* α16 Project Spine Card (Growth System §28 子组件 v0, 2026-05-16) —
          跨课程持续追踪的项目骨架事件流。5 kind: decision / hypothesis /
          open-question / building-on / revisit-later。user-driven 记录, 非
          LLM-derived。Mounts directly after CrossSparkCard since both are
          lateral / growth surfaces in the lesson footer band. Reads
          window.ptor.projectSpine.{list,add} per the α16 backend contract;
          gracefully renders a gray "未连接" state when the bridge is absent. */}
      {typeof window.ProjectSpineCard === 'function' && lessonSlug && (
        <ProjectSpineCard
          slug={lessonSlug}
          currentLessonIdx={typeof lessonIdxNum === 'number' ? lessonIdxNum : null}
          currentLessonTitle={
            (lessonBody && typeof lessonBody.thesis === 'string' && lessonBody.thesis.trim())
              ? lessonBody.thesis.trim()
              : ''
          }
        />
      )}

      {/* β17 Judgment Gym Card (Growth System §28 子组件 v0, 2026-05-16) —
          判断练习场。课程内遇到的 contestable claim 沉淀, 在更冷的时间点
          (≥3 天) 让 user 重新判断一次, 记录前后判断 + 理由差。Anti-LLM-
          hypnosis 训练场。Mounts after ProjectSpineCard since both are
          lateral growth surfaces in the lesson footer band. Reads
          window.ptor.judgmentGym.{add,due,rejudge} per the β17 backend
          contract; gracefully renders gray "未连接" state when the bridge
          is absent. */}
      {typeof window.JudgmentGymCard === 'function' && lessonSlug && (
        <JudgmentGymCard
          slug={lessonSlug}
          currentLessonIdx={typeof lessonIdxNum === 'number' ? lessonIdxNum : null}
          currentLessonTitle={
            (lessonBody && typeof lessonBody.thesis === 'string' && lessonBody.thesis.trim())
              ? lessonBody.thesis.trim()
              : ''
          }
        />
      )}

      {/* β18 · Entropy Reduction Card (Note System §3 v0, 2026-05-16).
          同主题灵感散落跨课 (lesson-1 / lesson-3 / lesson-7) → 选择碎片 →
          合并到 data/<slug>/canonical-notes/<topicSlug>.md。Manual merge,
          v0 无 LLM。Bridge: window.entropy.{collectFragments,listCanonical,
          readCanonical,writeCanonical,deleteCanonical}. Renders gray
          "未连接" 态 if bridge absent. Mounts after JudgmentGymCard since
          both are lateral entropy-management surfaces in the lesson footer. */}
      {typeof window.EntropyReductionCard === 'function' && lessonSlug && (
        <EntropyReductionCard slug={lessonSlug} />
      )}

      {/* β19 · Artifact Creation Card (Growth System §28 v0, 2026-05-16).
          每节课结束后 user 登记一件具体可被人用的 artifact (essay / code-repo /
          tweet-thread / substack-post / xhs-post / video-script / slide-deck /
          other), 系统追踪 planned → in-progress → drafted → published →
          committed | iterate 状态流。Track A 路径 — 学习的真正信号 = 造出可
          被人用的产物。Bridge: window.artifact.{create,transition,list,get,
          delete}. Renders gray "未连接" 态 if bridge absent. Mounts after
          EntropyReductionCard since both are lateral growth surfaces in the
          lesson footer band. */}
      {typeof window.ArtifactCreationCard === 'function' && lessonSlug && (
        <ArtifactCreationCard
          slug={lessonSlug}
          currentLessonIdx={typeof lessonIdxNum === 'number' ? lessonIdxNum : null}
          currentLessonTitle={
            (lessonBody && typeof lessonBody.thesis === 'string' && lessonBody.thesis.trim())
              ? lessonBody.thesis.trim()
              : ''
          }
        />
      )}

      {/* α22 Cost Budget Card (Infrastructure §16 v0 UI, 2026-05-16). Per-curriculum
          月 budget 跟踪 + soft 警告 (90% warn / 100% over / 110% over-110). Bridge:
          window.ptor.costBudget.{set,status,history,record}. Renders gray "未连接"
          态 if bridge absent. Mounted after ArtifactCreationCard since both are
          footer-band surfaces — artifact = output 信号, budget = input 节制. */}
      {typeof window.CostBudgetCard === 'function' && lessonSlug && (
        <CostBudgetCard slug={lessonSlug} />
      )}

      {/* β22 Mastery Card (Lesson System §2 v0 UI, 2026-05-16). Per-concept
          mastery EWMA score (0-1) 列表 — 高 (>0.7) / 中 (0.4-0.7) / 低 (<0.4)
          三档显化, 点行展开 signal history (limit 10), 底部添加 signal 闭环
          (concept input + 6 signal radio + "记一笔" button)。Bridge:
          window.ptor.mastery.{record,score,list,low,signalHistory}. Renders
          gray "未连接" 态 if bridge absent. Mounted after CostBudgetCard since
          all three (artifact / budget / mastery) form the lesson footer audit
          band — artifact = output 信号, budget = input 节制, mastery = 内化深度. */}
      {typeof window.MasteryCard === 'function' && lessonSlug && (
        <MasteryCard
          slug={lessonSlug}
          currentLessonIdx={typeof lessonIdxNum === 'number' ? lessonIdxNum : null}
        />
      )}

      {/* Phase D (R12 narrative arc + R14 content overview default + R9 map
          toggle) — render KP linear cards above the mode bar when a kp-arc.json
          sidecar exists for this lesson. Show map overlay handled inside the
          component. Cards render only after skeleton approve so the data is
          actually generated downstream of curriculum:approve_and_body.
          2026-05-13 — REMOVED from lesson screen per user: "Lesson 模块只该上课;
          NOTE 加法 (深挖/横展/反驳/产出) 应在 NOTE 模块". KP cards + 4-mode bar
          relocated to NotebookScreen / NoteView. Lesson chat stays pure tutor
          turn. NoteModeBar.jsx + knowledge-point-cards.jsx are unchanged — only
          the mount point moved. */}

      {/* Composer hidden when kernel-swap is active OR skeleton is in approval
          phase (2026-05-12 user request: 生成骨架 vs 上课分两阶段, 不一生成
          骨架就开始上课). Approval gate = skeletonPlan has scope_in AND user
          hasn't clicked 开始上课 yet. */}
      {!verificationChannel && !(skeletonPlan && skeletonPlan.length > 0 && skeletonPlan[0] && skeletonPlan[0].scope_in && !skeletonApproved) && (
        <Composer
          onSubmit={handleSubmit}
          onAbort={handleAbort}
          disabled={false}
          streaming={streaming}
        />
      )}
    </PageFrame>
  );
};

window.LessonChat = LessonChat;
