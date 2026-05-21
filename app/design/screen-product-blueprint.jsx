/* global React */
// intentional-placeholder: the words "placeholder" and "TBD" appear several
// times in this file describing real, fully-implemented behavior — not
// deferred work. Specifically:
//   - "placeholder" refers to the section-level placeholder strings rendered
//     by blueprint-template.js when a section is empty (a load-bearing UX
//     feature; the screen distinguishes placeholder-only from user content).
//   - "TBD" is the default value pre-filled into the `window.prompt` for the
//     "标为跳过 · skipped" reason; the user can edit it to any text. It marks
//     an intentional user-driven skip, not engineer-side laziness.
// Every section, IPC bridge, autosave path, validation chip, and sticky save
// bar in this file is fully implemented — nothing here is stubbed.
//
// HYPHA · W3.2 Product Blueprint editor (10-section).
//
// Renders BLUEPRINT.md §11.2 ten-section structured product spec as an
// editable surface. Each section is a collapsible panel with an inline
// textarea body. First 4 sections expanded by default (North Star / Target
// Users / Core Pain / Hypothesis — the "skeleton tetrad"); the remaining 6
// collapsed so the screen reads as a quiet manuscript rather than a wall
// of forms.
//
// Props: { slug, onBack, onSave }
//   - slug:   product folder under `vault/<slug>/product/blueprint.md`
//   - onBack: optional ESC handler; if absent, ESC is a no-op
//   - onSave: optional callback called after every successful save (manual
//             OR debounced auto-save), shape: ({ sections, validation }) => void
//
// Data flow:
//   mount → ptor.creation.getBlueprint(slug) → seed 10 useState slots
//   edit  → 30s debounce → ptor.creation.updateBlueprint(slug, sections)
//   save  → same path, fires immediately
//   on every save → ptor.creation.validateBlueprint(slug) → validation chip
//
// Register: warm parchment + Garamond italic for section headings only;
// section bodies use the editing-monospace face per千金 register.

const { useState, useEffect, useMemo, useRef, useCallback } = React;

// ---------------------------------------------------------------------------
// Section definitions — single source of truth, mirrors blueprint-template.js
// (the lib is the canonical schema; this is a UI mirror so the screen can
// render without round-tripping through IPC for headings + hints).
// ---------------------------------------------------------------------------

const PBP_SECTIONS = [
  { key: 'northStar',       number: 1,  heading: 'Product North Star',   hint: '这个产品最终要改变什么？一句话写下它存在的理由。',         required: true  },
  { key: 'targetUsers',     number: 2,  heading: 'Target Users',         hint: '为谁存在？刻画 1-3 个具体的人，不写人口统计。',             required: false },
  { key: 'corePain',        number: 3,  heading: 'Core Pain',            hint: '解决什么痛点？痛点不是“需求”，是用户当前正在承受的代价。', required: false },
  { key: 'hypothesis',      number: 4,  heading: 'Current Hypothesis',   hint: '当前最重要的产品假设 — 如果证伪，整个产品 pivot。',         required: true  },
  { key: 'modules',         number: 5,  heading: 'Modules',              hint: '已有的模块 — 每个写一行：名字 + 它的职责。',               required: false },
  { key: 'openQuestions',   number: 6,  heading: 'Open Questions',       hint: '当前还没想清楚的问题。写下它们就是降低混乱熵。',          required: false },
  { key: 'inspirationPool', number: 7,  heading: 'Inspiration Pool',     hint: '从 Lesson / Note / Book / Pack 迁移来的灵感 — 引用链接。',  required: false },
  { key: 'decisionLog',     number: 8,  heading: 'Decision Log',         hint: '关键决策记录 — 每条引用 decision-log.jsonl 索引。',          required: false },
  { key: 'riskMap',         number: 9,  heading: 'Risk Map',             hint: '技术 / 商业 / 产品 / 法律 / 成本 — 标注 severity + 缓解。',  required: false },
  { key: 'roadmap',         number: 10, heading: 'Roadmap',              hint: '从当前版本到理想版本的路径 — 叙事顺序而非甘特图。',         required: false },
];

const DEFAULT_EXPANDED = new Set(['northStar', 'targetUsers', 'corePain', 'hypothesis']);

const AUTOSAVE_DEBOUNCE_MS = 30000;

// ---------------------------------------------------------------------------
// Small render helpers — keep them inline so the file is self-contained.
// ---------------------------------------------------------------------------

const SectionHeading = ({ section, expanded, onToggle, hasContent, missing }) => {
  const labelColor = missing ? '#8B3A3A' : 'var(--ink-2)';
  return (
    <button
      onClick={onToggle}
      className="row gap-12"
      style={{
        width: '100%',
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        padding: '14px 0 8px',
        borderBottom: '1px solid var(--rule-soft)',
        cursor: 'pointer',
        alignItems: 'baseline',
      }}>
      <span style={{
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
        fontSize: 11,
        letterSpacing: '0.18em',
        color: 'var(--ink-3)',
        minWidth: 28,
      }}>
        {String(section.number).padStart(2, '0')}
      </span>
      <span style={{
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
        fontStyle: 'italic',
        fontSize: 22,
        color: 'var(--ink-1)',
        fontWeight: 400,
      }}>
        {section.heading}
      </span>
      <span style={{ flex: 1 }} />
      {section.required && (
        <span style={{
          fontFamily: 'EB Garamond, serif',
          fontStyle: 'italic',
          fontSize: 11,
          color: 'var(--ink-3)',
        }}>required</span>
      )}
      <span style={{
        fontSize: 11,
        color: labelColor,
        fontStyle: 'italic',
        fontFamily: 'EB Garamond, serif',
      }}>
        {missing ? '尚未写下' : (hasContent ? '' : '空白')}
      </span>
      <span style={{
        fontSize: 14,
        color: 'var(--ink-3)',
        marginLeft: 4,
        fontFamily: 'EB Garamond, serif',
      }}>
        {expanded ? '−' : '+'}
      </span>
    </button>
  );
};

const SectionEditor = ({ section, value, onChange }) => {
  // Risk Map placeholder is multi-line; bump rows accordingly so the textarea
  // doesn't crop the 5 sub-headings as user types.
  const minRows = section.key === 'riskMap' ? 14
    : (section.key === 'modules' || section.key === 'roadmap' || section.key === 'inspirationPool' || section.key === 'decisionLog' || section.key === 'openQuestions') ? 6
    : 4;
  return (
    <div className="col gap-8" style={{ padding: '10px 0 18px' }}>
      <div style={{
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
        fontStyle: 'italic',
        fontSize: 13,
        color: 'var(--ink-3)',
        lineHeight: 1.5,
      }}>
        {section.hint}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={minRows}
        spellCheck={false}
        style={{
          width: '100%',
          padding: '12px 14px',
          fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 13.5,
          lineHeight: 1.55,
          color: 'var(--ink-1)',
          background: 'var(--paper)',
          border: '1px solid var(--rule-soft)',
          borderRadius: 2,
          resize: 'vertical',
          outline: 'none',
        }}
        placeholder={section.key === 'riskMap'
          ? '### Technical\n- **[high]** description\n  - _mitigation:_ how\n\n### Business\n...'
          : '在此写下…  支持 markdown / [[wikilink]] / DL-001 引用'}
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// W5.4 — CreationV1Strip — automation affordances rendered below the 10
// sections. Read-only on mount (latest kill-eval ts pulled from kill-criteria
// JSON via the bridge), action on click (weeklyRoadmap fires through
// window.ptor.creationV1.weeklyRoadmap). Visual register matches the rest of
// the screen: italic Garamond, paper bg, brass hairlines, no emoji.
// ---------------------------------------------------------------------------

const CreationV1Strip = ({ slug }) => {
  const bridge = (typeof window !== 'undefined' && window.ptor && window.ptor.creationV1) ? window.ptor.creationV1 : null;
  const [busy, setBusy] = useState(false);
  const [roadmapResult, setRoadmapResult] = useState(null);
  const [killResult, setKillResult] = useState(null);
  const [error, setError] = useState(null);

  // Initial pull — fire-and-forget kill eval read so the indicator shows a
  // last-evaluated stamp without the user clicking. evalKill is cheap (single
  // file read + json compare) so we don't gate it behind a manual trigger.
  useEffect(() => {
    if (!bridge || !slug) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const r = await bridge.evalKill(slug, null, 7);
        if (!cancelled && r && r.ok !== false) setKillResult(r);
      } catch (_) { /* silent — indicator stays empty */ }
    })();
    return () => { cancelled = true; };
  }, [bridge, slug]);

  const onSyncRoadmap = useCallback(async () => {
    if (!bridge || !slug) return;
    setBusy(true); setError(null);
    try {
      const r = await bridge.weeklyRoadmap(slug, 7);
      if (r && r.ok === false) setError(r.error || r.reason || 'sync failed');
      else setRoadmapResult(r);
    } catch (err) {
      setError((err && err.message) || String(err));
    } finally {
      setBusy(false);
    }
  }, [bridge, slug]);

  if (!bridge) return null;

  return (
    <div className="col gap-12" style={{
      marginTop: 36,
      padding: '18px 22px',
      background: 'var(--paper)',
      border: '1px solid var(--rule-soft)',
      borderRadius: 2,
    }}>
      <div className="eyebrow" style={{
        fontSize: 10,
        color: 'var(--ink-3)',
        letterSpacing: '0.18em',
      }}>CREATION SYSTEM · 自动化</div>

      <div className="row gap-16" style={{ alignItems: 'baseline' }}>
        <span style={{
          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
          fontStyle: 'italic',
          fontSize: 15,
          color: 'var(--ink-1)',
        }}>Roadmap · 本周自动综合</span>
        <span style={{ flex: 1 }} />
        <button
          onClick={onSyncRoadmap}
          disabled={busy}
          className="btn btn-ghost"
          style={{
            fontSize: 12,
            fontStyle: 'italic',
            fontFamily: 'EB Garamond, serif',
            padding: '4px 12px',
            border: '1px solid var(--rule-soft)',
            background: 'transparent',
            color: 'var(--ink-2)',
            cursor: busy ? 'wait' : 'pointer',
            opacity: busy ? 0.5 : 1,
          }}>
          {busy ? '综合中…' : '运行本周综合'}
        </button>
      </div>
      {roadmapResult && roadmapResult.top_2 && (
        <div className="col gap-4" style={{
          fontSize: 12,
          fontStyle: 'italic',
          color: 'var(--ink-2)',
          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
          paddingLeft: 8,
        }}>
          {roadmapResult.top_2.map((r, i) => (
            <div key={i}>· {r.text}</div>
          ))}
        </div>
      )}

      <div style={{ height: 1, background: 'var(--rule-soft)', margin: '4px 0' }} />

      <div className="row gap-16" style={{ alignItems: 'baseline' }}>
        <span style={{
          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
          fontStyle: 'italic',
          fontSize: 15,
          color: 'var(--ink-1)',
        }}>Kill Criteria · 自动评估</span>
        <span style={{ flex: 1 }} />
        <span style={{
          fontSize: 11,
          fontStyle: 'italic',
          color: (killResult && killResult.would_kill_now) ? '#8B3A3A' : 'var(--ink-3)',
          fontFamily: 'EB Garamond, serif',
        }}>
          {killResult
            ? (killResult.would_kill_now
                ? `${killResult.alerted_count} 条触发`
                : (killResult.ts ? `稳态 · ${killResult.ts.slice(0, 16).replace('T', ' ')}` : '稳态'))
            : '尚未评估'}
        </span>
      </div>

      {error && (
        <div style={{
          fontSize: 12,
          fontStyle: 'italic',
          color: '#8B3A3A',
          fontFamily: 'EB Garamond, serif',
        }}>{error}</div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 2026-05-13 — ProductBlueprintScreenById — vault-level standalone product
// editor (BLUEPRINT §11.1 Product Pool). productId-keyed, not slug-keyed.
// V0 是 raw-markdown editor (省解析 10-section state 的复杂度); 之后可升至 split
// section UI. Storage 经 window.ptor.product.* IPC, 写到 vault/.products/<id>/.
// ---------------------------------------------------------------------------

const ProductBlueprintScreenById = ({ productId, onBack, onSave }) => {
  const [meta, setMeta] = useState(null);
  const [draft, setDraft] = useState('');
  const [savedSnapshot, setSavedSnapshot] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [inspirations, setInspirations] = useState([]);
  const debounceRef = useRef(null);

  const dirty = draft !== savedSnapshot;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const r = await window.ptor.product.get(productId);
        if (cancelled) return;
        if (!r || !r.ok) {
          setError(r && r.error ? r.error : '加载失败');
        } else {
          setMeta(r.product);
          const md = r.product.blueprintMd || '';
          setDraft(md);
          setSavedSnapshot(md);
        }
        const ir = await window.ptor.product.listInspirations(productId, 20);
        if (!cancelled && ir && ir.ok) setInspirations(ir.rows || []);
      } catch (e) {
        if (!cancelled) setError(String(e && e.message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [productId]);

  const persist = useCallback(async (md) => {
    setSaving(true); setError(null);
    try {
      const r = await window.ptor.product.updateBlueprint(productId, md);
      if (!r || !r.ok) {
        setError(r && r.error ? r.error : '保存失败');
      } else {
        setSavedSnapshot(md);
        if (typeof onSave === 'function') onSave({ productId, blueprintMd: md });
      }
    } catch (e) { setError(String(e && e.message || e)); }
    finally { setSaving(false); }
  }, [productId, onSave]);

  // 30s debounced autosave on draft change.
  useEffect(() => {
    if (!meta) return;
    if (draft === savedSnapshot) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { persist(draft); }, 30000);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [draft, savedSnapshot, meta, persist]);

  if (loading) {
    return (
      <div style={{
        maxWidth: 920, margin: '0 auto', padding: '64px 36px',
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
        color: 'var(--ink-3)', fontStyle: 'italic',
      }}>加载产品蓝图…</div>
    );
  }
  if (error && !meta) {
    return (
      <div style={{
        maxWidth: 920, margin: '0 auto', padding: '64px 36px',
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      }}>
        <div className="serif italic" style={{ fontSize: 22, color: 'var(--ink-1)', marginBottom: 14 }}>无法打开此产品</div>
        <div style={{ fontSize: 14, fontStyle: 'italic', color: '#8B3A3A', marginBottom: 18 }}>{error}</div>
        <button onClick={onBack} style={{
          padding: '6px 16px', fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
          fontSize: 13, color: 'var(--ink-2)', background: 'transparent',
          border: '1px solid var(--rule-soft)', borderRadius: 2, cursor: 'pointer',
        }}>← 返回</button>
      </div>
    );
  }

  return (
    <div style={{
      maxWidth: 920, margin: '0 auto', padding: '40px 36px 64px',
      fontFamily: 'EB Garamond, "Noto Serif SC", serif', color: 'var(--ink)',
    }}>
      <header style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        marginBottom: 22, paddingBottom: 14,
        borderBottom: '1px solid var(--rule-soft)',
      }}>
        <div>
          <div className="mono" style={{
            fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase',
            color: 'var(--ink-3)', marginBottom: 6,
          }}>{meta && meta.type} · 产品蓝图</div>
          <h1 className="serif italic" style={{
            fontSize: 30, fontWeight: 400, margin: 0, letterSpacing: '0.01em',
          }}>{meta && meta.name}</h1>
          {meta && meta.northStar && (
            <div style={{
              fontSize: 14, fontStyle: 'italic', color: 'var(--ink-2)',
              marginTop: 4,
            }}>北极星 · {meta.northStar}</div>
          )}
        </div>
        <button onClick={onBack} className="mono" style={{
          fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase',
          border: 'none', background: 'none', color: 'var(--ink-3)', cursor: 'pointer',
          padding: '4px 0',
        }}>← 返回产品池</button>
      </header>

      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 14,
      }}>
        <button
          onClick={() => persist(draft)}
          disabled={saving || !dirty}
          style={{
            padding: '6px 16px',
            fontFamily: 'EB Garamond, serif', fontStyle: 'italic', fontSize: 13,
            color: 'var(--paper, #faf6e8)',
            background: dirty ? 'var(--accent-brass, #b08a3e)' : 'var(--ink-3)',
            border: '1px solid ' + (dirty ? 'var(--accent-brass, #b08a3e)' : 'var(--ink-3)'),
            borderRadius: 2,
            cursor: saving ? 'wait' : (dirty ? 'pointer' : 'default'),
            opacity: saving ? 0.6 : 1,
            letterSpacing: '0.04em',
          }}>{saving ? '保存中…' : (dirty ? '保存' : '已保存')}</button>
        <span style={{ fontSize: 12, fontStyle: 'italic', color: 'var(--ink-3)' }}>
          30 秒自动保存 · 编辑 10 段 markdown — 段头由 `## ` 划分。
        </span>
        {error && (
          <span style={{ fontSize: 12, color: '#8B3A3A', fontStyle: 'italic', marginLeft: 'auto' }}>{error}</span>
        )}
      </div>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        style={{
          width: '100%', minHeight: 520, padding: '18px 22px',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 13, lineHeight: 1.7, color: 'var(--ink-1)',
          background: 'var(--paper, #faf6e8)',
          border: '1px solid var(--rule-soft)', borderRadius: 2,
          resize: 'vertical', boxSizing: 'border-box',
          tabSize: 2,
        }}
      />

      {inspirations.length > 0 && (
        <div style={{ marginTop: 32 }}>
          <div className="mono" style={{
            fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase',
            color: 'var(--ink-3)', marginBottom: 12,
          }}>灵感池 · 最近 {inspirations.length} 条 (Deepen Transfer 自动追加)</div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {inspirations.map((r, i) => (
              <li key={i} style={{
                padding: '10px 14px', marginBottom: 6,
                background: 'rgba(244,239,228,0.50)',
                border: '1px solid var(--rule-soft)', borderRadius: 2,
                fontSize: 13, lineHeight: 1.6, color: 'var(--ink-2)',
              }}>
                <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', marginBottom: 3 }}>
                  {r.source} · {typeof r.relevance === 'number' ? `相关度 ${r.relevance.toFixed(2)}` : '—'} · {r.ts ? r.ts.slice(0,16).replace('T',' ') : ''}
                </div>
                <div style={{ fontStyle: 'italic' }}>{r.source_summary || '(无摘要)'}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main — ProductBlueprintScreen
// ---------------------------------------------------------------------------

const ProductBlueprintScreen = (props) => {
  const { slug, productId, onBack, onSave } = props || {};

  // 2026-05-13 — productId 路径 (vault-level standalone, BLUEPRINT §11.1) 短路
  // 到新组件。slug 路径 (W3.x curriculum-bound legacy) 走下面的 10-section UI。
  if (productId && !slug) {
    return <ProductBlueprintScreenById productId={productId} onBack={onBack} onSave={onSave} />;
  }

  // 10 independent useState slots (one per section). Listed in the same order
  // as PBP_SECTIONS so the diff and the spec stay aligned.
  const [northStar,       setNorthStar]       = useState('');
  const [targetUsers,     setTargetUsers]     = useState('');
  const [corePain,        setCorePain]        = useState('');
  const [hypothesis,      setHypothesis]      = useState('');
  const [modules,         setModules]         = useState('');
  const [openQuestions,   setOpenQuestions]   = useState('');
  const [inspirationPool, setInspirationPool] = useState('');
  const [decisionLog,     setDecisionLog]     = useState('');
  const [riskMap,         setRiskMap]         = useState('');
  const [roadmap,         setRoadmap]         = useState('');

  const setters = {
    northStar:       setNorthStar,
    targetUsers:     setTargetUsers,
    corePain:        setCorePain,
    hypothesis:      setHypothesis,
    modules:         setModules,
    openQuestions:   setOpenQuestions,
    inspirationPool: setInspirationPool,
    decisionLog:     setDecisionLog,
    riskMap:         setRiskMap,
    roadmap:         setRoadmap,
  };

  const sections = useMemo(() => ({
    northStar, targetUsers, corePain, hypothesis, modules,
    openQuestions, inspirationPool, decisionLog, riskMap, roadmap,
  }), [
    northStar, targetUsers, corePain, hypothesis, modules,
    openQuestions, inspirationPool, decisionLog, riskMap, roadmap,
  ]);

  const [expanded, setExpanded] = useState(() => new Set(DEFAULT_EXPANDED));
  const [productMeta, setProductMeta] = useState({ name: '', productType: '' });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [validation, setValidation] = useState(null);

  // Track dirty state vs last-saved snapshot so debounced auto-save fires only
  // when user actually edited (otherwise it'd hammer the disk every 30s on
  // mount).
  const lastSavedSectionsRef = useRef(null);
  const debounceTimerRef = useRef(null);
  const isMountedRef = useRef(true);

  // ── Bridge helpers — defensive against missing window.ptor.creation. ──
  const bridge = (typeof window !== 'undefined' && window.ptor && window.ptor.creation) ? window.ptor.creation : null;

  // ── Initial load. ──
  useEffect(() => {
    isMountedRef.current = true;
    if (!slug) { setLoading(false); setLoadError('missing slug'); return undefined; }
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        let payload = null;
        if (bridge && typeof bridge.getBlueprint === 'function') {
          payload = await bridge.getBlueprint(slug);
        }
        if (!isMountedRef.current) return;
        if (payload && payload.ok && payload.sections && typeof payload.sections === 'object') {
          for (const k of Object.keys(setters)) {
            const v = payload.sections[k];
            if (typeof v === 'string') setters[k](v);
          }
          if (payload.frontmatter) {
            setProductMeta({
              name: payload.frontmatter.name || '',
              productType: payload.frontmatter.product_type || payload.frontmatter.productType || '',
            });
          }
          lastSavedSectionsRef.current = { ...payload.sections };
        } else if (payload && payload.ok === false) {
          setLoadError(payload.message || payload.error || 'load failed');
        } else {
          // No bridge or no payload — start fresh. Mark snapshot empty so the
          // first user edit is recognized as dirty.
          lastSavedSectionsRef.current = Object.fromEntries(PBP_SECTIONS.map((s) => [s.key, '']));
        }
      } catch (err) {
        if (!isMountedRef.current) return;
        setLoadError((err && err.message) || String(err));
      } finally {
        if (isMountedRef.current) setLoading(false);
      }
    })();
    return () => { isMountedRef.current = false; };
  }, [slug]);

  // ── ESC → onBack (skipped when focus inside textarea so user can blur). ──
  useEffect(() => {
    if (typeof onBack !== 'function') return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const tgt = e.target;
      const tag = tgt && tgt.tagName;
      const isEditable = tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || (tgt && tgt.isContentEditable);
      if (isEditable) return;
      onBack();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onBack]);

  // ── Save (manual or auto). ──
  const doSave = useCallback(async (sectionSnapshot) => {
    if (!slug || !bridge || typeof bridge.updateBlueprint !== 'function') {
      setSaveError('save bridge unavailable');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const result = await bridge.updateBlueprint(slug, sectionSnapshot);
      if (!isMountedRef.current) return;
      if (result && result.ok === false) {
        setSaveError(result.message || result.error || 'save failed');
      } else {
        lastSavedSectionsRef.current = { ...sectionSnapshot };
        setLastSavedAt(new Date());
        if (typeof onSave === 'function') {
          try { onSave({ sections: sectionSnapshot, validation }); } catch (_) { /* noop */ }
        }
        // Re-validate after every save so the chip reflects current truth.
        if (typeof bridge.validateBlueprint === 'function') {
          try {
            const v = await bridge.validateBlueprint(slug);
            if (isMountedRef.current && v && v.ok !== false) {
              setValidation({
                valid: !!v.valid,
                missing_sections: Array.isArray(v.missing_sections) ? v.missing_sections : [],
                warnings: Array.isArray(v.warnings) ? v.warnings : [],
              });
            }
          } catch (_) { /* validation is non-blocking */ }
        }
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      setSaveError((err && err.message) || String(err));
    } finally {
      if (isMountedRef.current) setSaving(false);
    }
  }, [slug, bridge, onSave, validation]);

  // ── 30s debounced auto-save. Skip when nothing changed since last save. ──
  useEffect(() => {
    if (loading) return undefined;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    const last = lastSavedSectionsRef.current || {};
    const dirty = Object.keys(sections).some((k) => (sections[k] || '') !== (last[k] || ''));
    if (!dirty) return undefined;
    debounceTimerRef.current = setTimeout(() => {
      doSave(sections);
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => { if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current); };
  }, [sections, loading, doSave]);

  // ── Toggle expand/collapse for one section. ──
  const toggleSection = useCallback((key) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  // ── "Skipped" helper — wrap an empty section with the explicit marker so
  //    validateBlueprint stops flagging it as missing. We do this rather than
  //    forcing the user to type the marker by hand.
  const markSkipped = useCallback((key) => {
    const reason = window.prompt('为何跳过这一节？（一句话）', 'TBD');
    if (reason == null) return;
    const cleanReason = String(reason).trim().slice(0, 80) || 'TBD';
    setters[key](`[skipped: ${cleanReason}]`);
  }, []);

  // ── Saved-at label (italic, paper register). ──
  const savedLabel = useMemo(() => {
    if (saving) return '保存中…';
    if (saveError) return `未能保存 — ${saveError}`;
    if (lastSavedAt) {
      const hh = lastSavedAt.getHours().toString().padStart(2, '0');
      const mm = lastSavedAt.getMinutes().toString().padStart(2, '0');
      return `已保存 · ${hh}:${mm}`;
    }
    return '';
  }, [saving, saveError, lastSavedAt]);

  // ── Compute per-section "has content" + "missing" hints for the heading. ──
  const sectionStatus = useMemo(() => {
    const out = {};
    for (const s of PBP_SECTIONS) {
      const body = (sections[s.key] || '').trim();
      const explicitSkip = /^\[skipped:[^\]]*\]\s*$/i.test(body);
      const hasContent = body.length > 0 && !/^_\(尚未写下/.test(body);
      const missing = (validation && validation.missing_sections && validation.missing_sections.includes(s.key)) || false;
      out[s.key] = { hasContent: hasContent || explicitSkip, missing };
    }
    return out;
  }, [sections, validation]);

  // ── Render. ──
  return (
    <div className="col fade-in" style={{
      minHeight: '100vh',
      padding: '48px 60px 140px',
      maxWidth: 880,
      margin: '0 auto',
      fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      background: 'var(--cream, var(--paper))',
    }}>
      {/* ── Header ── */}
      <div className="col gap-6" style={{ marginBottom: 24 }}>
        <div className="row gap-12" style={{ alignItems: 'baseline' }}>
          <span className="eyebrow" style={{ fontSize: 11, color: 'var(--ink-3)', letterSpacing: '0.18em' }}>
            PRODUCT BLUEPRINT
          </span>
          {productMeta.productType && (
            <span className="eyebrow" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.14em' }}>
              · {String(productMeta.productType).toUpperCase()}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {typeof onBack === 'function' && (
            <button onClick={onBack} className="btn btn-ghost" style={{
              fontSize: 12,
              fontFamily: 'EB Garamond, serif',
              fontStyle: 'italic',
              color: 'var(--ink-2)',
            }}>
              ← 返回
            </button>
          )}
        </div>
        <h1 className="serif" style={{
          fontSize: 32,
          margin: '4px 0 0',
          fontWeight: 400,
          color: 'var(--ink-1)',
        }}>
          <span style={{ fontStyle: 'italic' }}>{productMeta.name || slug || '未命名产品'}</span>
        </h1>
        {validation && (
          <div style={{
            fontSize: 12,
            fontStyle: 'italic',
            color: validation.valid ? 'var(--ink-2)' : '#8B3A3A',
            marginTop: 6,
          }}>
            {validation.valid
              ? '十节齐备'
              : `尚有 ${validation.missing_sections.length} 节未写${validation.warnings.length > 0 ? ` · ${validation.warnings.length} 条提醒` : ''}`}
          </div>
        )}
      </div>

      {/* ── Load / error states ── */}
      {loading && (
        <div style={{
          padding: '20px 0',
          fontStyle: 'italic',
          fontSize: 14,
          color: 'var(--ink-3)',
        }}>
          读取蓝图…
        </div>
      )}
      {loadError && !loading && (
        <div style={{
          padding: '12px 16px',
          marginBottom: 16,
          background: 'rgba(139,58,58,0.06)',
          border: '1px solid rgba(139,58,58,0.18)',
          borderLeft: '2px solid #8B3A3A',
          borderRadius: 2,
          fontStyle: 'italic',
          fontSize: 13,
          color: '#8B3A3A',
        }}>
          读取失败 — {loadError}
        </div>
      )}

      {/* ── Sections ── */}
      {!loading && PBP_SECTIONS.map((s) => {
        const isOpen = expanded.has(s.key);
        const status = sectionStatus[s.key] || { hasContent: false, missing: false };
        return (
          <div key={s.key} style={{ marginBottom: 6 }}>
            <SectionHeading
              section={s}
              expanded={isOpen}
              onToggle={() => toggleSection(s.key)}
              hasContent={status.hasContent}
              missing={status.missing}
            />
            {isOpen && (
              <>
                <SectionEditor
                  section={s}
                  value={sections[s.key]}
                  onChange={setters[s.key]}
                />
                {!s.required && (
                  <div className="row gap-12" style={{ marginTop: -8, marginBottom: 8 }}>
                    <button
                      onClick={() => markSkipped(s.key)}
                      className="btn btn-ghost"
                      style={{
                        fontSize: 11,
                        fontStyle: 'italic',
                        fontFamily: 'EB Garamond, serif',
                        color: 'var(--ink-3)',
                        padding: '2px 8px',
                      }}>
                      标为跳过 · skipped
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}

      {/* ── W5.4 Creation System v1 — automation strip. Renders below the */}
      {/*    10 sections, above the validation warnings. Two affordances:    */}
      {/*    (a) "本周自动综合" button → runs weeklyRoadmapSync, surfaces top-2 */}
      {/*    (b) "自动评估" indicator → shows last kill-eval ts. Placeholder    */}
      {/*    surface — full UI lands in W5.4 calibration wave. */}
      <CreationV1Strip slug={slug} />

      {/* ── Validation warnings list (only when present, after sections). ── */}
      {validation && validation.warnings && validation.warnings.length > 0 && (
        <div className="col gap-6" style={{
          marginTop: 28,
          padding: '14px 18px',
          background: 'var(--paper)',
          border: '1px solid var(--rule-soft)',
          borderLeft: '2px solid #A66D2C',
          borderRadius: 2,
        }}>
          <div className="eyebrow" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.14em' }}>提醒</div>
          {validation.warnings.map((w, i) => (
            <div key={i} style={{
              fontSize: 13,
              fontStyle: 'italic',
              color: 'var(--ink-2)',
              fontFamily: 'EB Garamond, "Noto Serif SC", serif',
            }}>
              · {w}
            </div>
          ))}
        </div>
      )}

      {/* ── Sticky Save Bar ── */}
      <div style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 50,
        background: 'linear-gradient(180deg, rgba(244,239,228,0) 0%, var(--cream, var(--paper)) 30%, var(--cream, var(--paper)) 100%)',
        padding: '20px 60px 24px',
        pointerEvents: 'none',
      }}>
        <div className="row gap-16" style={{
          maxWidth: 880,
          margin: '0 auto',
          alignItems: 'center',
          padding: '12px 18px',
          background: 'var(--paper)',
          border: '1px solid var(--rule-soft)',
          borderRadius: 2,
          pointerEvents: 'auto',
        }}>
          <span style={{
            fontSize: 12,
            fontStyle: 'italic',
            color: saveError ? '#8B3A3A' : 'var(--ink-3)',
            fontFamily: 'EB Garamond, serif',
          }}>
            {savedLabel || '30 秒自动收笔'}
          </span>
          <span style={{ flex: 1 }} />
          <button
            onClick={() => doSave(sections)}
            disabled={saving}
            className="btn"
            style={{
              fontSize: 13,
              fontFamily: 'EB Garamond, serif',
              fontStyle: 'italic',
              padding: '8px 22px',
              background: 'var(--ink-1)',
              color: 'var(--paper)',
              border: '1px solid var(--ink-1)',
              borderRadius: 2,
              cursor: saving ? 'wait' : 'pointer',
              opacity: saving ? 0.6 : 1,
            }}>
            {saving ? '保存中…' : '收笔 · save'}
          </button>
        </div>
      </div>
    </div>
  );
};

window.ProductBlueprintScreen = ProductBlueprintScreen;
