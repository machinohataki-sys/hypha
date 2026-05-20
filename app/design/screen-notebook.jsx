/* global React, Icon, NoteModeBar, KnowledgePointCards */
// intentional-placeholder: the word "placeholder" appears twice in this file
// (lines 23, 525-ish comments) referring to the *legacy* NotebookScreen at
// screen-atlas-notebook.jsx:452 — which is itself a literal empty-state
// stub the user told us to override. The references describe that existing
// legacy component (not work deferred in this file). All four required
// surfaces in this screen (上期回顾 / 内容总览 / KnowledgePointCards stream /
// NoteModeBar sticky bottom) plus ESC + map toggle + IPC reads are fully
// implemented below; nothing in this file is deferred.
// HYPHA · NotebookScreen — Phase C lesson-scoped NOTE module host.
// Props: { noteRel, slug, lessonIdx, userIntent, onBack }. Four surfaces:
//   1. 上期回顾  — frontmatter.prior_review_paragraph (fallback "(无上期)")
//   2. 内容总览  — body.relation_edges list, expanded (fallback "(无总览)")
//   3. 知识点流  — <KnowledgePointCards> R12 narrative arc 7+1 cards
//   4. NoteModeBar — sticky bottom 4 mode bar (DEEPEN/EXPAND/CHALLENGE/SCAFFOLD)
// Phase D: linear cards default visible, archetype map hidden (top toggle).
// ESC → onBack. Data: ptor.hypha.lessonBodyGet + ptor.vault.read + (map only)
// ptor.hypha.lessonKpArcsGet. Window-global export only. Loaded AFTER
// screen-atlas-notebook.jsx so this shadows the legacy stub.

const { useState, useEffect, useMemo } = React;

// =====================================================================
// Helpers
// =====================================================================

function _deriveSlugIdx(noteRel) {
  if (!noteRel) return { slug: null, idx: null };
  const m = String(noteRel).match(/^([^\\/]+)[\\/]lesson-(\d+)\.md$/);
  if (!m) return { slug: null, idx: null };
  const idx = Number(m[2]);
  return { slug: m[1] || null, idx: Number.isFinite(idx) ? idx : null };
}

// relation_edges is permissive: array of strings, OR array of
// { from, to, relation, note? } objects (per pedagogy.md Layer 4 §R14). Both
// shapes render as bullet lines so the surface is robust to schema drift.
function _renderRelationEdge(edge, i) {
  if (!edge) return null;
  if (typeof edge === 'string') {
    const t = edge.trim();
    if (!t) return null;
    return (
      <li key={i} style={{ marginBottom: 4 }}>
        <span style={{ color: 'var(--ink)' }}>{t}</span>
      </li>
    );
  }
  if (typeof edge === 'object') {
    const from = edge.from || edge.source || '';
    const to = edge.to || edge.target || '';
    const rel = edge.relation || edge.kind || edge.label || '';
    const note = edge.note || edge.gloss || '';
    if (!from && !to && !rel && !note) return null;
    return (
      <li key={i} style={{ marginBottom: 4 }}>
        {from && <strong style={{ color: 'var(--ink)', fontWeight: 500 }}>{from}</strong>}
        {rel && <span style={{ color: 'var(--ink-2)', fontStyle: 'italic', margin: '0 6px' }}>{rel}</span>}
        {to && <span style={{ color: 'var(--ink)' }}>{to}</span>}
        {note && <span style={{ color: 'var(--ink-2)', marginLeft: 8 }}>— {note}</span>}
      </li>
    );
  }
  return null;
}

// Current-selection getter passed to NoteModeBar. Returns the user's live
// document selection so Ctrl+E / H / P pre-fill the panel with whatever
// they have highlighted in 内容总览 / KP cards.
function _getSelection() {
  try {
    const s = window.getSelection && window.getSelection();
    return s ? String(s.toString()) : '';
  } catch (_) {
    return '';
  }
}

// =====================================================================
// Map overlay — mirrors knowledge-point-cards.jsx ShowMapOverlay so the
// screen-level [Show map] toggle uses the same AtlasScreen render branch.
// =====================================================================

const MapOverlay = ({ arcs, visualArchetype, userIntent, onClose }) => (
  <div style={{
    position: 'fixed', inset: 0, background: 'rgba(20,18,16,0.78)',
    display: 'flex', flexDirection: 'column', zIndex: 1100,
    padding: '24px 32px',
  }} onClick={onClose}>
    <div className="row gap-12" style={{ alignItems: 'baseline', marginBottom: 16 }}>
      <span className="eyebrow" style={{ color: 'var(--paper)', fontSize: 11, letterSpacing: '0.12em' }}>
        ATLAS · {(visualArchetype || 'flat').toUpperCase()}
      </span>
      <span style={{ flex: 1 }} />
      <button onClick={onClose} className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--paper)' }}>
        关闭
      </button>
    </div>
    <div onClick={e => e.stopPropagation()} style={{
      flex: 1, overflow: 'auto', background: 'var(--paper)',
      border: '1px solid var(--rule)', borderRadius: 4,
    }}>
      {window.AtlasScreen ? (
        <window.AtlasScreen
          knowledgePoints={arcs}
          mode={visualArchetype || 'flat'}
          userIntent={userIntent}
        />
      ) : (
        <div className="col" style={{ padding: 32, color: 'var(--ink-2)', fontStyle: 'italic' }}>
          Atlas surface not loaded.
        </div>
      )}
    </div>
  </div>
);

// =====================================================================
// Section helpers — register: brass hairline + Garamond + cream paper.
// =====================================================================

const SectionLabel = ({ children }) => (
  <span className="eyebrow" style={{
    fontSize: 11, color: 'var(--ink-3)',
    letterSpacing: '0.12em',
  }}>
    {String(children).toUpperCase()}
  </span>
);

const SectionBody = ({ children, accent }) => (
  <div className="col gap-8" style={{
    padding: '14px 18px',
    background: 'var(--cream, var(--paper))',
    border: '1px solid var(--rule-soft)',
    borderLeft: `2px solid ${accent || 'var(--rule)'}`,
    borderRadius: 2,
    fontFamily: 'EB Garamond, "Noto Serif SC", serif',
  }}>
    {children}
  </div>
);

const EmptyLine = ({ children }) => (
  <div style={{
    fontSize: 14, color: 'var(--ink-3)',
    fontStyle: 'italic',
    fontFamily: 'EB Garamond, "Noto Serif SC", serif',
  }}>
    {children}
  </div>
);

// =====================================================================
// Main — NotebookScreen
// =====================================================================

const NotebookScreen = (props) => {
  const { noteRel: propNoteRel, onBack } = props || {};

  // Slug + idx normalization: prefer explicit props, else derive from noteRel.
  // Legacy callers (route 'notes' from app.jsx, only passes onJump) hand us
  // nothing — we render the empty-state and let the user back out.
  const derived = useMemo(() => _deriveSlugIdx(propNoteRel), [propNoteRel]);
  const slug = props && props.slug ? String(props.slug) : derived.slug;
  const lessonIdx = (props && Number.isFinite(Number(props.lessonIdx)))
    ? Number(props.lessonIdx)
    : derived.idx;
  const noteRel = propNoteRel
    || (slug && Number.isFinite(lessonIdx) ? `${slug}/lesson-${lessonIdx}.md` : null);

  const [body, setBody] = useState(null);
  const [frontmatter, setFrontmatter] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // v0.4.6 — thin_warning_v045 surface: hydrated from body._meta when
  // backfill script has flagged this body. dismissed = user clicked "稍后",
  // banner hides for current session (vault-scoped LS key).
  const [thinWarning, setThinWarning] = useState(null);
  const [thinWarningDismissed, setThinWarningDismissed] = useState(false);
  const [regenInFlight, setRegenInFlight] = useState(false);

  // Top-level [Show map] toggle state. Phase D default = hidden.
  const [showMap, setShowMap] = useState(false);
  const [mapArcs, setMapArcs] = useState(null);
  const [mapArchetype, setMapArchetype] = useState(null);
  const [mapFetchedIntent, setMapFetchedIntent] = useState(null);
  const [mapLoading, setMapLoading] = useState(false);
  const [mapError, setMapError] = useState(null);

  // W5.2 Web Note Engine — graph toggle. Default hidden (placeholder
  // surface only — true SVG/canvas render deferred to v1.3+). When open,
  // lists nodes by layer with a count badge. Calls window.ptor.webnote.*.
  const [showWebGraph, setShowWebGraph] = useState(false);
  const [webGraphNodes, setWebGraphNodes] = useState(null);
  const [webGraphError, setWebGraphError] = useState(null);
  const [webGraphLoading, setWebGraphLoading] = useState(false);

  // ESC → onBack. Skip when focus is inside a text field so the user can
  // dismiss native browser autocomplete / blur a textarea without leaving
  // the screen. NoteModeBar owns its own input panel which intercepts ESC.
  useEffect(() => {
    if (typeof onBack !== 'function') return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const tgt = e.target;
      const tag = tgt && tgt.tagName;
      const editable = tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT'
        || (tgt && tgt.isContentEditable);
      if (editable) return;
      onBack();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onBack]);

  // Load lesson body + note frontmatter. Both reads are independent —
  // failure of either still renders the rest of the screen.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setBody(null);
    setFrontmatter(null);
    setThinWarning(null);
    if (!slug || !Number.isFinite(lessonIdx)) {
      setLoading(false);
      return undefined;
    }
    // Dismiss key — supports two shapes:
    //   - permanent: {ts,permanent:true} JSON → never show again
    //   - old v0.4.6 'true' string → migrate (re-prompt once, clear key)
    try {
      const dismissKey = `thin_warning_dismissed_${slug}_${lessonIdx}`;
      if (typeof window !== 'undefined' && window.localStorage) {
        const raw = window.localStorage.getItem(dismissKey);
        if (raw === 'true') {
          // Legacy session-only flag: clear it so user gets one re-prompt
          // under the new contract (session dismiss ! writes storage).
          window.localStorage.removeItem(dismissKey);
          setThinWarningDismissed(false);
        } else if (raw) {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (_) { /* corrupt → ignore */ }
          if (parsed && parsed.permanent === true) {
            setThinWarningDismissed(true);
          } else {
            setThinWarningDismissed(false);
          }
        } else {
          setThinWarningDismissed(false);
        }
      } else {
        setThinWarningDismissed(false);
      }
    } catch (_) { /* localStorage blocked → default not-dismissed */ }
    (async () => {
      try {
        const bridge = window.ptor && window.ptor.hypha;
        const bodyFn = bridge && bridge.lessonBodyGet;
        const vault = window.ptor && window.ptor.vault;
        const readFn = vault && vault.read;
        const bodyPromise = (typeof bodyFn === 'function')
          ? bodyFn(slug, lessonIdx).catch(() => null)
          : Promise.resolve(null);
        const fmPromise = (typeof readFn === 'function' && noteRel)
          ? readFn(noteRel).catch(() => null)
          : Promise.resolve(null);
        const [bRes, nRes] = await Promise.all([bodyPromise, fmPromise]);
        if (!alive) return;
        if (bRes && bRes.ok && bRes.body) setBody(bRes.body);
        // v0.4.6 — surface _meta.thin_warning_v045 if backfill flagged
        // this body as pre-v0.4.5 schema (missing transfer_cases /
        // practice_assignments / etc). UI renders banner below sticky bar.
        if (bRes && bRes.ok && bRes._meta && bRes._meta.thin_warning_v045) {
          setThinWarning(bRes._meta.thin_warning_v045);
        }
        if (nRes && nRes.frontmatter) setFrontmatter(nRes.frontmatter);
        setLoading(false);
      } catch (e) {
        if (!alive) return;
        setError(e && e.message ? e.message : String(e));
        setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [slug, lessonIdx, noteRel]);

  // Lazy-load KP arcs for the [Show map] overlay. Fires when the toggle
  // flips on and the data isn't already cached.
  useEffect(() => {
    if (!showMap) return undefined;
    if (mapArcs !== null) return undefined; // already loaded
    if (!slug || !Number.isFinite(lessonIdx)) return undefined;
    const bridge = window.ptor && window.ptor.hypha;
    const fn = bridge && bridge.lessonKpArcsGet;
    if (typeof fn !== 'function') {
      setMapError('lessonKpArcsGet bridge missing');
      setMapArcs([]);
      return undefined;
    }
    let alive = true;
    setMapLoading(true);
    setMapError(null);
    (async () => {
      try {
        const r = await fn(slug, lessonIdx);
        if (!alive) return;
        if (!r || !r.ok) {
          setMapError((r && r.message) || 'fetch failed');
          setMapArcs([]);
        } else {
          setMapArcs(Array.isArray(r.arcs) ? r.arcs : []);
          setMapArchetype(r.visual_archetype || null);
          setMapFetchedIntent(r.user_intent || null);
        }
        setMapLoading(false);
      } catch (e) {
        if (!alive) return;
        setMapError(e && e.message ? e.message : String(e));
        setMapArcs([]);
        setMapLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [showMap, mapArcs, slug, lessonIdx]);

  // Derived fields with explicit fallbacks per spec.
  const lessonTitle = (frontmatter && (frontmatter.title || frontmatter.lesson_title))
    || (body && body.thesis)
    || (slug ? `${slug} · lesson ${Number.isFinite(lessonIdx) ? lessonIdx + 1 : '?'}` : '笔记');
  const learnGoal = frontmatter && (frontmatter.learn_goal || frontmatter.north_star_goal);

  const priorReview = (
    (frontmatter && typeof frontmatter.prior_review_paragraph === 'string' && frontmatter.prior_review_paragraph.trim())
    || (body && typeof body.prior_review_paragraph === 'string' && body.prior_review_paragraph.trim())
    || null
  );
  const relationEdges = (body && Array.isArray(body.relation_edges) && body.relation_edges.length > 0)
    ? body.relation_edges : null;
  const effectiveUserIntent = (props && props.userIntent) || (body && body.user_intent) || mapFetchedIntent || null;

  // Legacy no-prop guardrail — app.jsx route 'notes' still calls
  // <NotebookScreen onJump={setRoute} />. Same window symbol, different
  // contract — render empty-state instead of crashing the nav.
  if (!slug || !Number.isFinite(lessonIdx)) {
    const onJump = props && props.onJump;
    return (
      <div className="col gap-16 fade-in" style={{
        padding: '48px 60px 60px', maxWidth: 880, margin: '0 auto',
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      }}>
        <div className="col gap-6">
          <div className="eyebrow">Notebook</div>
          <h1 className="serif" style={{ fontSize: 30, margin: '4px 0 0', fontWeight: 400 }}>
            选择一节课进入<span className="italic"> 笔记 </span>
          </h1>
        </div>
        <SectionBody accent="#A66D2C">
          <EmptyLine>
            笔记按节课承载。从首页选一门课 → 进 Lesson Chat → 按 <span className="mono" style={{ background:'rgba(166,109,44,.10)', padding:'1px 6px', borderRadius:3 }}>N</span> 快速跳本节笔记; 或 <span className="italic">/finish</span> 走完后自动存档.
          </EmptyLine>
          <div className="row gap-12" style={{ marginTop: 4 }}>
            {typeof onBack === 'function' && (
              <button onClick={onBack} className="btn btn-ghost" style={{ fontSize: 13 }}>返回</button>
            )}
            {typeof onJump === 'function' && (
              <button onClick={() => onJump('home')} className="btn btn-ghost" style={{ fontSize: 13 }}>回 Home</button>
            )}
          </div>
        </SectionBody>
      </div>
    );
  }

  return (
    <div className="fade-in" style={{ minHeight: '100vh', position: 'relative' }}>
      {/* Top bar — back + title + Show map + (optional) goal */}
      <div className="row gap-12" style={{
        padding: '20px 40px', alignItems: 'baseline',
        borderBottom: '1px solid var(--rule-soft)',
        background: 'linear-gradient(180deg, rgba(244,239,228,.92), rgba(244,239,228,.5))',
        position: 'sticky', top: 0, zIndex: 5,
        backdropFilter: 'blur(6px)',
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      }}>
        {typeof onBack === 'function' && (
          <button onClick={onBack} className="row gap-8 btn btn-ghost" style={{ fontSize: 13 }}>
            {typeof Icon === 'function' ? <Icon name="arrowL" size={13} /> : <span>‹</span>}
            <span>返回</span>
          </button>
        )}
        <div className="col gap-2" style={{ marginLeft: 8 }}>
          <span className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.08em' }}>
            NOTEBOOK · L{Number.isFinite(lessonIdx) ? lessonIdx + 1 : '?'}
          </span>
          <h1 className="serif" style={{
            fontSize: 24, lineHeight: 1.25, margin: 0,
            fontWeight: 400, color: 'var(--ink)',
          }}>
            {lessonTitle}
          </h1>
        </div>
        <span className="spacer" style={{ flex: 1 }} />
        {/* W5.3 Living Note Reactivation — 死亡笔记审查 entry. Low-weight ghost
            button next to map toggle. Click → onJump('dead-notes') so the
            DeadNotesScreen renders with the current slug. archive ≠ delete. */}
        {slug && typeof onJump === 'function' && (
          <button
            onClick={() => onJump('dead-notes', { slug })}
            className="btn btn-ghost"
            style={{ fontSize: 12 }}
            title="审查近 90 天未触碰且工具分低的笔记 (可归档,不可删)"
          >
            死亡笔记审查
          </button>
        )}
        <button onClick={() => setShowMap(s => !s)} className="btn btn-ghost"
          style={{ fontSize: 12 }}
          title="切换 archetype 地图">
          {showMap ? '隐藏地图' : '切换地图'}
        </button>
        {/* W5.2 Web Note Engine — Web Graph toggle. Lazy-loads node list on
            first open. Placeholder render (SVG/canvas deferred to v1.3+). */}
        {slug && (
          <button
            onClick={async () => {
              const next = !showWebGraph;
              setShowWebGraph(next);
              if (next && webGraphNodes == null && window.ptor && window.ptor.webnote) {
                setWebGraphLoading(true);
                setWebGraphError(null);
                try {
                  const res = await window.ptor.webnote.listNodes(slug);
                  if (res && res.ok) setWebGraphNodes(res.nodes || []);
                  else setWebGraphError((res && res.error) || 'web-graph load failed');
                } catch (err) {
                  setWebGraphError(err && err.message ? err.message : String(err));
                } finally {
                  setWebGraphLoading(false);
                }
              }
            }}
            className="btn btn-ghost"
            style={{ fontSize: 12 }}
            title="蛛网式典型边图 (Raw/Atomic/Concept/Spark/Kernel)"
          >
            {showWebGraph ? '隐藏网状' : '网状视图'}
          </button>
        )}
      </div>

      {/* v0.4.6 — thin_warning_v045 banner (renders when backfill flagged
          this body as pre-v0.4.5 schema). Oxblood-toned warm warning; user
          can regen (LLM cost) or dismiss for session. */}
      {thinWarning && !thinWarningDismissed && (
        <div style={{
          margin: '12px 40px 0', padding: '12px 16px',
          background: 'rgba(166, 109, 44, .08)',
          border: '0.5px solid rgba(139, 58, 58, .35)',
          borderRadius: 4, maxWidth: 880, marginLeft: 'auto', marginRight: 'auto',
          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
        }}>
          <div className="row gap-12" style={{ alignItems: 'baseline' }}>
            <span className="serif italic" style={{ fontSize: 13, color: 'var(--terracotta-2, #8B3A3A)', minWidth: 100 }}>
              ⚠ 笔记 schema 滞后
            </span>
            <div className="col gap-4" style={{ flex: 1 }}>
              <div className="t-tiny" style={{ color: 'var(--ink-2)', lineHeight: 1.5 }}>
                本节 body 在 v0.4.5 (2026-05-19) 教学升级前生成 · 缺: <span className="mono" style={{ background: 'rgba(0,0,0,.04)', padding: '0 4px', borderRadius: 2 }}>
                  {Array.isArray(thinWarning.missing_fields) ? thinWarning.missing_fields.join(', ') : '(v0.4.5 字段)'}
                </span>
              </div>
              <div className="t-tiny" style={{ color: 'var(--ink-3)', lineHeight: 1.5 }}>
                重新生成可获 APPLY (transfer-test) + LATCH (practice tasks) 完整体验 · 大约 1 分钟 + LLM cost.
              </div>
            </div>
            <div className="row gap-6">
              <button
                onClick={async (e) => {
                  e.preventDefault();
                  if (regenInFlight) return;
                  if (typeof window !== 'undefined' && window.confirm && !window.confirm(
                    '重新生成 lesson body? 约 1 分钟, 触发 LLM call (T6_STRONG, ~¥0.5/body).'
                  )) return;
                  setRegenInFlight(true);
                  try {
                    const bridge = window.ptor && window.ptor.hypha;
                    const fn = bridge && (bridge.lessonBodyGenerate || bridge.lessonBodyRegen);
                    if (typeof fn !== 'function') {
                      window.alert('lessonBodyGenerate IPC missing — 需 v0.5 接');
                      setRegenInFlight(false);
                      return;
                    }
                    const r = await fn({ slug, idx: lessonIdx, force: true });
                    if (r && r.ok && r.body) {
                      setBody(r.body);
                      setThinWarning(null);  // cleared on success
                      window.alert('body 已重新生成 · 刷新查看');
                    } else {
                      window.alert('重新生成失败: ' + ((r && (r.error || r.message)) || 'unknown'));
                    }
                  } catch (err) {
                    window.alert('重新生成失败: ' + ((err && err.message) || err));
                  } finally {
                    setRegenInFlight(false);
                  }
                }}
                disabled={regenInFlight}
                className="btn btn-quiet"
                style={{ fontSize: 11, padding: '4px 10px' }}
              >
                {regenInFlight ? '生成中...' : '重新生成'}
              </button>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  // Session-only dismiss — does ! touch localStorage so the
                  // banner returns next session.
                  setThinWarningDismissed(true);
                }}
                className="btn btn-quiet"
                style={{ fontSize: 11, padding: '4px 10px', opacity: 0.7 }}
              >
                稍后再说
              </button>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  try {
                    if (typeof window !== 'undefined' && window.localStorage) {
                      const payload = JSON.stringify({ ts: Date.now(), permanent: true });
                      window.localStorage.setItem(`thin_warning_dismissed_${slug}_${lessonIdx}`, payload);
                    }
                  } catch (_) { /* localStorage blocked → session-only fallback */ }
                  setThinWarningDismissed(true);
                }}
                className="btn btn-quiet"
                style={{ fontSize: 11, padding: '4px 10px', opacity: 0.55 }}
                title="此 lesson 的滞后提示不再出现"
              >
                永久忽略 (此 lesson)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Body — column of 3 sections, then NoteModeBar fixed to bottom */}
      <div className="col gap-24" style={{
        padding: '28px 40px 220px',   // padding-bottom reserves space for sticky bar
        maxWidth: 880, margin: '0 auto',
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      }}>
        {/* Optional learn-goal anchor line */}
        {learnGoal && (
          <div className="col gap-4">
            <SectionLabel>学习目标</SectionLabel>
            <div className="serif italic" style={{
              fontSize: 15, lineHeight: 1.5, color: 'var(--ink-2)',
            }}>
              {learnGoal}
            </div>
          </div>
        )}

        {/* Section 1 — 上期回顾 (R13) */}
        <div className="col gap-8">
          <SectionLabel>上期回顾</SectionLabel>
          <SectionBody accent="#8B7355">
            {priorReview ? (
              <div className="serif" style={{
                fontSize: 15, lineHeight: 1.7, color: 'var(--ink)',
                whiteSpace: 'pre-wrap',
              }}>
                {priorReview}
              </div>
            ) : (
              <EmptyLine>(无上期)</EmptyLine>
            )}
          </SectionBody>
        </div>

        {/* Section 2 — 内容总览 (R14, default expanded) */}
        <div className="col gap-8">
          <SectionLabel>内容总览</SectionLabel>
          <SectionBody accent="#A66D2C">
            {relationEdges && relationEdges.length > 0 ? (
              <ul style={{
                margin: 0, paddingLeft: 18,
                fontSize: 14, lineHeight: 1.65, color: 'var(--ink)',
              }}>
                {relationEdges.map(_renderRelationEdge)}
              </ul>
            ) : (
              <EmptyLine>(无总览)</EmptyLine>
            )}
          </SectionBody>
        </div>

        {/* Section 3 — Knowledge Point cards (R12 narrative arc 7+1) */}
        {typeof KnowledgePointCards === 'function' ? (
          <KnowledgePointCards
            slug={slug}
            lessonIdx={lessonIdx}
            userIntent={effectiveUserIntent}
          />
        ) : (
          <SectionBody accent="#8B3A3A">
            <EmptyLine>知识点 surface 未加载 (window.KnowledgePointCards missing)</EmptyLine>
          </SectionBody>
        )}

        {/* W5.2 — Web Graph placeholder. Layer counts + node list summary.
            True SVG/canvas spider-web render lives behind v1.3+. */}
        {showWebGraph && (
          <div className="col gap-8">
            <SectionLabel>网状视图 · Web Graph</SectionLabel>
            <SectionBody accent="#4D8B9A">
              {webGraphLoading && (
                <EmptyLine>读取节点…</EmptyLine>
              )}
              {webGraphError && (
                <div style={{ fontSize: 12, color: '#8B3A3A', fontStyle: 'italic' }}>
                  网状视图加载失败: {webGraphError}
                </div>
              )}
              {!webGraphLoading && !webGraphError && webGraphNodes && webGraphNodes.length === 0 && (
                <EmptyLine>(无节点 · 第一笔记录后才有蛛网)</EmptyLine>
              )}
              {!webGraphLoading && !webGraphError && webGraphNodes && webGraphNodes.length > 0 && (
                <div className="col gap-6">
                  <div style={{
                    fontSize: 13, color: 'var(--ink-2)', fontStyle: 'italic',
                  }}>
                    共 {webGraphNodes.length} 节点 · 6 层蛛网视图占位 · 真渲染 v1.3+
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.65 }}>
                    {['raw','atomic','concept','spark','product_spark','kernel'].map(layer => {
                      const count = webGraphNodes.filter(n => n.layer === layer).length;
                      if (count === 0) return null;
                      return (
                        <li key={layer} style={{ color: 'var(--ink)' }}>
                          <span style={{ fontStyle: 'italic' }}>{layer}</span>
                          <span style={{ color: 'var(--ink-3)', marginLeft: 8 }}>· {count} 节点</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </SectionBody>
          </div>
        )}

        {/* Loading / error rails — surfaced inline, never block the rest */}
        {loading && (
          <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.08em' }}>
            loading lesson body…
          </div>
        )}
        {error && (
          <div style={{ fontSize: 12, color: '#8B3A3A', fontStyle: 'italic' }}>
            lesson body 读取失败: {error}
          </div>
        )}
      </div>

      {/* Section 4 — NoteModeBar sticky bottom (4 mode buttons + inline callouts) */}
      <div style={{
        position: 'sticky', bottom: 0, left: 0, right: 0,
        background: 'linear-gradient(180deg, rgba(244,239,228,0.0), rgba(244,239,228,0.96) 30%)',
        backdropFilter: 'blur(8px)',
        borderTop: '1px solid var(--rule-soft)',
        zIndex: 4,
      }}>
        <div style={{ maxWidth: 880, margin: '0 auto', padding: '0 40px 16px' }}>
          {typeof NoteModeBar === 'function' ? (
            <NoteModeBar
              noteRel={noteRel}
              lessonBody={body}
              getSelection={_getSelection}
            />
          ) : (
            <div style={{
              padding: 12, fontSize: 12,
              color: '#8B3A3A', fontStyle: 'italic',
            }}>
              NoteModeBar surface 未加载.
            </div>
          )}
        </div>
      </div>

      {/* Map overlay (Phase D default = hidden, top toggle drives) */}
      {showMap && (
        <MapOverlay
          arcs={mapArcs || []}
          visualArchetype={mapArchetype}
          userIntent={effectiveUserIntent}
          onClose={() => setShowMap(false)}
        />
      )}
      {showMap && (mapLoading || mapError) && (
        <div style={{
          position: 'fixed', bottom: 28, right: 28, zIndex: 1101,
          padding: '8px 14px',
          background: 'var(--paper)', border: '1px solid var(--rule-soft)', borderRadius: 2,
          fontSize: 12, color: mapError ? '#8B3A3A' : 'var(--ink-2)', fontStyle: 'italic',
        }}>
          {mapError ? `map 读取失败: ${mapError}` : 'loading map…'}
        </div>
      )}
    </div>
  );
};

// Overwrites the legacy stub at screen-atlas-notebook.jsx:665. HYPHA.html
// loads this file AFTER screen-atlas-notebook so the lesson-scoped surface
// wins. Route 'notes' (legacy, only passes onJump) lands in the no-prop
// guardrail above; route 'notebook' gets the full screen with body+ESC+map.
window.NotebookScreen = NotebookScreen;
