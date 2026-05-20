/* global React */
// HYPHA · KnowledgePointCards — Phase D Layer 6 Tier 3 (R12 narrative arc render).
//
// Reads `<slug>/lesson-<idx>.kp-arc.json` via `window.ptor.hypha.lessonKpArcsGet`.
// Renders linear KP card flow with 7+1 fields per pedagogy.md Layer 4:
//   - lineage_link[]        — 上接 cross-/within-syllabus
//   - definition            — 200-400 字 formal definition
//   - derivation_chain[]    — ordered claim → mechanism steps
//   - critique_of[]         — vs target_thinker / position / attack
//   - analogy               — conditional, archetype-gated
//   - connects_to_next[]    — within-lesson edges to next KP
//   - intent_use_map        — slot mapping by user intent
//   - paraphrase_prompt     — intent-aware self-test
//
// "切换地图" toggle → ShowMapOverlay mounts <window.AtlasScreen> with KP data +
// archetype mode prop (data-driven render branch added to screen-atlas-notebook).

const { useState, useEffect } = React;

const RELATION_LABELS = {
  prereq: '前置',
  opposite: '对立',
  corollary: '推论',
  'co-construct': '共构',
};

const LINEAGE_RELATION_LABELS = {
  '批判': '批判',
  '类比': '类比',
  '后续被反驳': '后续被反驳',
  '前驱': '前驱',
  '共构': '共构',
};

// =====================================================================
// Single KP card — 7+1 fields, expanded by default
// =====================================================================

const KnowledgePointCard = ({ kpId, arc, userIntent, index }) => {
  const [expanded, setExpanded] = useState(true);
  if (!arc || typeof arc !== 'object') return null;

  const title = arc.title || kpId;
  const def = (typeof arc.definition === 'string') ? arc.definition.trim() : '';
  const lineage = Array.isArray(arc.lineage_link) ? arc.lineage_link : [];
  const derivation = Array.isArray(arc.derivation_chain) ? arc.derivation_chain : [];
  const critique = Array.isArray(arc.critique_of) ? arc.critique_of : [];
  const analogy = (typeof arc.analogy === 'string' && arc.analogy.trim()) ? arc.analogy.trim() : null;
  const connects = Array.isArray(arc.connects_to_next) ? arc.connects_to_next : [];
  const useMap = (arc.intent_use_map && typeof arc.intent_use_map === 'object') ? arc.intent_use_map : {};
  const slots = userIntent && Array.isArray(useMap[userIntent]) ? useMap[userIntent] : [];
  const paraphrase = (typeof arc.paraphrase_prompt === 'string' && arc.paraphrase_prompt.trim()) ? arc.paraphrase_prompt.trim() : null;

  return (
    <div className="col gap-12" style={{
      padding: '18px 22px',
      background: 'var(--paper)',
      border: '1px solid var(--rule-soft)',
      borderLeft: '2px solid #A66D2C',
      borderRadius: 2,
      fontFamily: 'EB Garamond, "Noto Serif SC", serif',
    }}>
      <div className="row gap-12" style={{ alignItems: 'baseline', cursor: 'pointer' }}
        onClick={() => setExpanded(prev => !prev)}>
        <span className="eyebrow" style={{ fontSize: 11, color: 'var(--ink-3, #8a7a6a)', letterSpacing: '0.1em', minWidth: 56 }}>
          {kpId.toUpperCase()}
        </span>
        <h3 className="serif" style={{ fontSize: 22, margin: 0, fontWeight: 400, flex: 1, color: 'var(--ink)' }}>
          {title}
        </h3>
        <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{expanded ? '收起' : '展开'}</span>
      </div>

      {expanded && (
        <div className="col gap-16">
          {/* Lineage — 上接 */}
          {lineage.length > 0 && (
            <KPSection label="上接">
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.6 }}>
                {lineage.map((l, i) => (
                  <li key={i}>
                    <span style={{ color: 'var(--ink-2)', fontStyle: 'italic' }}>
                      {LINEAGE_RELATION_LABELS[l.relation] || l.relation}
                    </span>
                    {' · '}
                    <span style={{ color: 'var(--ink)' }}>
                      {(l.target && l.target.display_label) || (l.target && l.target.fallback) || '—'}
                    </span>
                    {l.target && l.target.syllabus_slug && l.target.syllabus_slug !== '_self' && (
                      <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>
                        {' '}↪ {l.target.syllabus_slug}/lesson-{l.target.lesson_idx}{l.target.kp_id ? '/' + l.target.kp_id : ''}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </KPSection>
          )}

          {/* Definition */}
          {def && (
            <KPSection label="定义">
              <div style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--ink)', whiteSpace: 'pre-wrap' }}>{def}</div>
            </KPSection>
          )}

          {/* Derivation chain */}
          {derivation.length > 0 && (
            <KPSection label="推论链">
              <ol style={{ margin: 0, paddingLeft: 22, fontSize: 14, lineHeight: 1.6, color: 'var(--ink)' }}>
                {derivation.map((s, i) => (
                  <li key={i} style={{ marginBottom: 6 }}>
                    <strong style={{ fontWeight: 500 }}>{s.claim}</strong>
                    <div style={{ fontSize: 12, color: 'var(--ink-2)', fontStyle: 'italic', marginTop: 2 }}>
                      由 {s.follows_from} · {s.mechanism}
                    </div>
                  </li>
                ))}
              </ol>
            </KPSection>
          )}

          {/* Critique */}
          {critique.length > 0 && (
            <KPSection label="批判">
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.6, color: 'var(--ink)' }}>
                {critique.map((c, i) => (
                  <li key={i} style={{ marginBottom: 6 }}>
                    <span style={{ color: '#8B3A3A', fontStyle: 'italic' }}>对 {c.target_thinker}</span>
                    {' · '}{c.target_position}
                    <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 2 }}>{c.attack_summary}</div>
                  </li>
                ))}
              </ul>
            </KPSection>
          )}

          {/* Analogy — only when present */}
          {analogy && (
            <KPSection label="类比">
              <div style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--ink)', fontStyle: 'italic' }}>{analogy}</div>
            </KPSection>
          )}

          {/* Connects to next — 下接 */}
          {connects.length > 0 && (
            <KPSection label="下接">
              <div className="row gap-8" style={{ flexWrap: 'wrap', fontSize: 13 }}>
                {connects.map((c, i) => (
                  <span key={i} style={{
                    padding: '3px 10px', borderRadius: 12,
                    border: '1px solid var(--rule-soft)',
                    background: 'var(--cream)', color: 'var(--ink-2)',
                  }}>
                    → {c.target_kp_id}{' '}
                    <span style={{ color: 'var(--ink-3)', fontSize: 11 }}>
                      {RELATION_LABELS[c.relation] || c.relation}
                    </span>
                  </span>
                ))}
              </div>
            </KPSection>
          )}

          {/* Intent slot mapping — filtered by user_intent */}
          {slots.length > 0 && (
            <KPSection label={`产出 slot · ${userIntent}`}>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.55, color: 'var(--ink-2)' }}>
                {slots.map((s, i) => (
                  <li key={i}>
                    <strong style={{ color: 'var(--ink)' }}>{s.slot_name}</strong>
                    {s.rationale && <span> — {s.rationale}</span>}
                  </li>
                ))}
              </ul>
            </KPSection>
          )}

          {/* Paraphrase prompt */}
          {paraphrase && (
            <div style={{
              fontSize: 13, color: 'var(--ink-2)', fontStyle: 'italic',
              borderTop: '1px dashed var(--rule-soft)', paddingTop: 10,
            }}>
              {paraphrase}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const KPSection = ({ label, children }) => (
  <div className="col gap-4">
    <span className="eyebrow" style={{ fontSize: 10, color: 'var(--ink-3, #8a7a6a)', letterSpacing: '0.12em' }}>
      {label.toUpperCase()}
    </span>
    {children}
  </div>
);

// =====================================================================
// Show map overlay — modal mounting AtlasScreen with KP data
// =====================================================================

const ShowMapOverlay = ({ arcs, visualArchetype, userIntent, onClose }) => {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(20,18,16,0.75)',
      display: 'flex', flexDirection: 'column', zIndex: 1100,
      padding: '24px 32px',
    }} onClick={onClose}>
      <div className="row gap-12" style={{ alignItems: 'baseline', marginBottom: 16 }}>
        <span className="eyebrow" style={{ color: 'var(--paper)', fontSize: 11, letterSpacing: '0.12em' }}>
          ATLAS · {(visualArchetype || 'flat').toUpperCase()}
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={onClose} className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--paper)' }}>关闭</button>
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
};

// =====================================================================
// Main export — fetches KP arcs + renders cards + map toggle
// =====================================================================

const KnowledgePointCards = ({ slug, lessonIdx, userIntent }) => {
  const [state, setState] = useState({ loading: true, arcs: [], visualArchetype: null, fetchedIntent: null, error: null });
  const [mapOpen, setMapOpen] = useState(false);

  useEffect(() => {
    if (!slug || !Number.isFinite(lessonIdx)) {
      setState({ loading: false, arcs: [], visualArchetype: null, fetchedIntent: null, error: null });
      return;
    }
    if (!window.ptor || !window.ptor.hypha || typeof window.ptor.hypha.lessonKpArcsGet !== 'function') {
      setState({ loading: false, arcs: [], visualArchetype: null, fetchedIntent: null, error: 'bridge missing: lessonKpArcsGet' });
      return;
    }
    let cancelled = false;
    setState(prev => ({ ...prev, loading: true, error: null }));
    (async () => {
      try {
        const r = await window.ptor.hypha.lessonKpArcsGet(slug, lessonIdx);
        if (cancelled) return;
        if (!r || !r.ok) {
          setState({ loading: false, arcs: [], visualArchetype: null, fetchedIntent: null, error: (r && r.message) || 'fetch failed' });
          return;
        }
        setState({
          loading: false,
          arcs: r.arcs || [],
          visualArchetype: r.visual_archetype || null,
          fetchedIntent: r.user_intent || null,
          error: null,
        });
      } catch (e) {
        if (cancelled) return;
        setState({ loading: false, arcs: [], visualArchetype: null, fetchedIntent: null, error: e.message || String(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [slug, lessonIdx]);

  if (state.loading) {
    return (
      <div style={{ padding: '12px 0', fontSize: 13, color: 'var(--ink-3)', fontStyle: 'italic' }}>
        知识点 loading…
      </div>
    );
  }
  if (state.error) {
    return (
      <div style={{ padding: '8px 0', fontSize: 12, color: '#8B3A3A', fontStyle: 'italic' }}>
        知识点 fetch 失败: {state.error}
      </div>
    );
  }
  if (!state.arcs || state.arcs.length === 0) return null;

  const effectiveIntent = userIntent || state.fetchedIntent || null;

  return (
    <div className="col gap-12" style={{ marginTop: 20, marginBottom: 12 }}>
      {/* Header row — count + Show map toggle */}
      <div className="row gap-12" style={{
        alignItems: 'baseline', paddingBottom: 8,
        borderBottom: '1px solid var(--rule-soft)',
      }}>
        <span className="eyebrow" style={{ fontSize: 11, color: 'var(--ink-2)', letterSpacing: '0.1em' }}>
          知识点 · {state.arcs.length} 条 · 线性序
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={() => setMapOpen(true)} className="btn btn-ghost" style={{ fontSize: 12 }}
          title="切换地图视图">
          切换地图
        </button>
      </div>

      {/* Linear card flow */}
      {state.arcs.map((wrapper, i) => {
        if (!wrapper) return null;
        const kpId = wrapper.kp_id || (wrapper.arc && wrapper.arc.kp_id) || `kp-${i + 1}`;
        const arc = wrapper.arc || wrapper;
        return (
          <KnowledgePointCard
            key={kpId}
            kpId={kpId}
            arc={arc}
            userIntent={effectiveIntent}
            index={i}
          />
        );
      })}

      {/* Map overlay */}
      {mapOpen && (
        <ShowMapOverlay
          arcs={state.arcs}
          visualArchetype={state.visualArchetype}
          userIntent={effectiveIntent}
          onClose={() => setMapOpen(false)}
        />
      )}
    </div>
  );
};

window.KnowledgePointCards = KnowledgePointCards;
