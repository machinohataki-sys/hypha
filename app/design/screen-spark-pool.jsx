/* global React */
// HYPHA · W3.4 Product Spark Pool — list + detail surface.
//
// Renders all sparks under `vault/<slug>/product/sparks/` with a 5-state
// filter tab strip, a left-side card list, and a right-side detail panel
// that exposes the legal state transitions for the currently-selected
// spark. Pure UI — every mutation flows through the wired IPC at
// window.ptor.spark.{list,get,transition}.
//
// Props: { slug, onBack }
//   - slug:    product folder under vault/<slug>/product/sparks/
//   - onBack:  ESC handler; falls back to no-op
//
// Register (千金 manuscript):
//   - Garamond italic for h1 + state badges, roman for body
//   - brass-bright accents (state badge colors are signal not ornament)
//   - no emoji, no exclamation marks, no SaaS gamification

const { useState, useEffect, useCallback, useMemo } = React;

// ---------------------------------------------------------------------------
// Constants — mirror product-spark.js exports. UI mirror so the screen
// renders without an extra IPC round-trip for the schema.
// ---------------------------------------------------------------------------

const SPARK_STATES = ['seed', 'considered', 'accepted', 'rejected', 'implemented'];

const STATE_LEGAL_NEXT = {
  seed:        ['considered', 'rejected'],
  considered:  ['accepted',   'rejected'],
  accepted:    ['implemented','rejected'],
  rejected:    [],
  implemented: [],
};

const TERMINAL = new Set(['rejected', 'implemented']);

// Badge colors — chosen for legibility on the warm parchment ground. Not
// decorative. The five hues are the same family as the existing harness /
// confession / drift palette so the screen reads as part of the same world.
const STATE_BADGE = {
  seed:        { fg: '#6b6258', bg: '#e8e0d2', label: 'seed'        },
  considered:  { fg: '#7a5a1d', bg: '#f0e0b5', label: 'considered'  },
  accepted:    { fg: '#3f5a3c', bg: '#d8e3cf', label: 'accepted'    },
  rejected:    { fg: '#7a3a32', bg: '#ecd0c8', label: 'rejected'    },
  implemented: { fg: '#3a5a72', bg: '#cfdbe6', label: 'implemented' },
};

const STATE_VERB = {
  considered:  'Consider',
  accepted:    'Accept',
  rejected:    'Reject',
  implemented: 'Implement',
};

const FILTER_OPTIONS = [
  { value: '',            label: 'All'         },
  { value: 'seed',        label: 'Seed'        },
  { value: 'considered',  label: 'Considered'  },
  { value: 'accepted',    label: 'Accepted'    },
  { value: 'rejected',    label: 'Rejected'    },
  { value: 'implemented', label: 'Implemented' },
];

// ---------------------------------------------------------------------------
// Small format helpers
// ---------------------------------------------------------------------------

function _truncate(s, n) {
  const t = String(s || '').trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1) + '…';
}

function _shortStamp(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.valueOf())) return String(iso);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  } catch (_) {
    return String(iso);
  }
}

function _sourceLine(spark) {
  const src = spark && spark.source;
  if (!src) return '';
  const type = src.type || '';
  const ref = src.ref || '';
  if (!type && !ref) return '';
  return `${type}${type && ref ? ' · ' : ''}${ref}`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const StateBadge = ({ state }) => {
  const cfg = STATE_BADGE[state] || STATE_BADGE.seed;
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      fontSize: 10,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      color: cfg.fg,
      background: cfg.bg,
      borderRadius: 2,
      fontFamily: '"JetBrains Mono", monospace',
      fontWeight: 500,
    }}>
      {cfg.label}
    </span>
  );
};

const FilterTabs = ({ value, onChange }) => (
  <div className="row gap-4" style={{ flexWrap: 'wrap' }}>
    {FILTER_OPTIONS.map((opt) => {
      const active = opt.value === value;
      return (
        <button
          key={opt.value || 'all'}
          onClick={() => onChange(opt.value)}
          style={{
            padding: '6px 14px',
            fontSize: 12,
            fontFamily: 'EB Garamond, "Noto Serif SC", serif',
            color: active ? 'var(--paper)' : 'var(--ink-2)',
            background: active ? 'var(--ink-1)' : 'transparent',
            border: '1px solid ' + (active ? 'var(--ink-1)' : 'var(--rule-soft)'),
            borderRadius: 2,
            cursor: 'pointer',
            letterSpacing: '0.04em',
          }}>
          {opt.label}
        </button>
      );
    })}
  </div>
);

const SparkCard = ({ spark, selected, onSelect }) => {
  const transfer = _truncate(spark && spark.core_transfer, 110);
  const srcLine = _sourceLine(spark);
  return (
    <button
      onClick={() => onSelect(spark.spark_id)}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '14px 16px',
        background: selected ? 'rgba(193,139,69,0.12)' : 'transparent',
        border: '1px solid ' + (selected ? 'var(--ochre, #c18b45)' : 'var(--rule-soft)'),
        borderRadius: 3,
        marginBottom: 10,
        cursor: 'pointer',
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      }}>
      <div className="row gap-8" style={{ alignItems: 'baseline', marginBottom: 6 }}>
        <StateBadge state={spark.state} />
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>
          {_shortStamp(spark.created_at)}
        </span>
      </div>
      <div style={{
        fontSize: 14,
        lineHeight: 1.55,
        color: 'var(--ink)',
        marginBottom: 6,
        whiteSpace: 'pre-wrap',
      }}>
        {transfer || <span style={{ color: 'var(--ink-3)', fontStyle: 'italic' }}>(no transfer recorded)</span>}
      </div>
      {srcLine && (
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.04em' }}>
          {srcLine}
        </div>
      )}
    </button>
  );
};

const SectionLabel = ({ children }) => (
  <div className="eyebrow" style={{
    fontSize: 10,
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
    color: 'var(--ink-3)',
    fontFamily: '"JetBrains Mono", monospace',
    marginBottom: 4,
  }}>
    {children}
  </div>
);

const SectionRow = ({ label, children }) => (
  <div className="col gap-4" style={{ marginBottom: 16 }}>
    <SectionLabel>{label}</SectionLabel>
    <div style={{
      fontSize: 14,
      lineHeight: 1.7,
      color: 'var(--ink)',
      fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      whiteSpace: 'pre-wrap',
    }}>
      {children}
    </div>
  </div>
);

const TransitionsTable = ({ transitions }) => {
  if (!Array.isArray(transitions) || transitions.length === 0) {
    return (
      <div style={{
        fontSize: 13,
        fontStyle: 'italic',
        color: 'var(--ink-3)',
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      }}>
        (no transitions — spark still at initial state)
      </div>
    );
  }
  return (
    <table style={{
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: 12,
      fontFamily: 'EB Garamond, "Noto Serif SC", serif',
    }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--rule-soft)' }}>
          <th style={{ textAlign: 'left', padding: '6px 8px', color: 'var(--ink-3)', fontWeight: 400 }}>from</th>
          <th style={{ textAlign: 'left', padding: '6px 8px', color: 'var(--ink-3)', fontWeight: 400 }}>to</th>
          <th style={{ textAlign: 'left', padding: '6px 8px', color: 'var(--ink-3)', fontWeight: 400 }}>when</th>
          <th style={{ textAlign: 'left', padding: '6px 8px', color: 'var(--ink-3)', fontWeight: 400 }}>reason</th>
        </tr>
      </thead>
      <tbody>
        {transitions.map((t, i) => (
          <tr key={i} style={{ borderBottom: '1px solid var(--rule-soft)' }}>
            <td style={{ padding: '6px 8px', color: 'var(--ink-2)' }}>{t.from}</td>
            <td style={{ padding: '6px 8px', color: 'var(--ink)' }}>{t.to}</td>
            <td className="mono" style={{ padding: '6px 8px', color: 'var(--ink-3)', fontSize: 11 }}>
              {_shortStamp(t.ts)}
            </td>
            <td style={{ padding: '6px 8px', color: 'var(--ink-2)', fontStyle: 'italic' }}>
              {t.reason || '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const TransitionControls = ({ spark, busy, onTransition }) => {
  const legal = STATE_LEGAL_NEXT[spark.state] || [];
  if (legal.length === 0) {
    return (
      <div style={{
        fontSize: 12,
        fontStyle: 'italic',
        color: 'var(--ink-3)',
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      }}>
        {TERMINAL.has(spark.state) ? `已 ${spark.state} — 终态` : '无可用 transition'}
      </div>
    );
  }
  return (
    <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
      {legal.map((nextState) => {
        const verb = STATE_VERB[nextState] || nextState;
        const isReject = nextState === 'rejected';
        return (
          <button
            key={nextState}
            onClick={() => onTransition(nextState)}
            disabled={busy}
            style={{
              padding: '8px 18px',
              fontSize: 12,
              fontFamily: 'EB Garamond, "Noto Serif SC", serif',
              letterSpacing: '0.04em',
              color: isReject ? 'var(--ink-2)' : 'var(--paper)',
              background: isReject ? 'transparent' : 'var(--ink-1)',
              border: '1px solid ' + (isReject ? 'var(--rule-soft)' : 'var(--ink-1)'),
              borderRadius: 2,
              cursor: busy ? 'wait' : 'pointer',
              opacity: busy ? 0.5 : 1,
            }}>
            {verb}
          </button>
        );
      })}
    </div>
  );
};

const SparkDetail = ({ spark, busy, onTransition, transitionError }) => {
  if (!spark) {
    return (
      <div style={{
        padding: 32,
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
        fontStyle: 'italic',
        color: 'var(--ink-3)',
        fontSize: 14,
      }}>
        从左侧选一条 spark 查看详情。
      </div>
    );
  }
  const src = spark.source || {};
  return (
    <div className="col" style={{ padding: '28px 32px', maxWidth: 640 }}>
      <div className="row gap-12" style={{ alignItems: 'baseline', marginBottom: 18 }}>
        <h2 className="serif italic" style={{
          fontSize: 22,
          margin: 0,
          fontWeight: 400,
          color: 'var(--ink)',
        }}>
          Spark detail
        </h2>
        <span style={{ flex: 1 }} />
        <StateBadge state={spark.state} />
      </div>

      <div className="mono" style={{
        fontSize: 10,
        color: 'var(--ink-3)',
        letterSpacing: '0.06em',
        marginBottom: 18,
      }}>
        {spark.spark_id} · {_shortStamp(spark.created_at)}
      </div>

      <SectionRow label="来源 · source">
        <div className="row gap-12" style={{ flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--ink-2)' }}>type</span>
          <span>{src.type || '—'}</span>
        </div>
        <div className="row gap-12" style={{ flexWrap: 'wrap', marginTop: 4 }}>
          <span style={{ color: 'var(--ink-2)' }}>ref</span>
          <span className="mono" style={{ fontSize: 12 }}>{src.ref || '—'}</span>
        </div>
        {src.label && (
          <div className="row gap-12" style={{ flexWrap: 'wrap', marginTop: 4 }}>
            <span style={{ color: 'var(--ink-2)' }}>label</span>
            <span>{src.label}</span>
          </div>
        )}
      </SectionRow>

      <SectionRow label="关联产品 · related product">
        {spark.related_product || <span style={{ color: 'var(--ink-3)', fontStyle: 'italic' }}>(unspecified)</span>}
      </SectionRow>

      <SectionRow label="核心迁移 · core transfer">
        {spark.core_transfer || <span style={{ color: 'var(--ink-3)', fontStyle: 'italic' }}>(no transfer recorded)</span>}
      </SectionRow>

      <SectionRow label="影响模块 · affected modules">
        {Array.isArray(spark.affected_modules) && spark.affected_modules.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {spark.affected_modules.map((m, i) => (
              <li key={i} style={{ marginBottom: 2 }}>{m}</li>
            ))}
          </ul>
        ) : (
          <span style={{ color: 'var(--ink-3)', fontStyle: 'italic' }}>(none flagged)</span>
        )}
      </SectionRow>

      <SectionRow label="可能动作 · possible actions">
        {Array.isArray(spark.possible_actions) && spark.possible_actions.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {spark.possible_actions.map((a, i) => (
              <li key={i} style={{ marginBottom: 4 }}>{a}</li>
            ))}
          </ul>
        ) : (
          <span style={{ color: 'var(--ink-3)', fontStyle: 'italic' }}>(no actions proposed yet)</span>
        )}
      </SectionRow>

      <SectionRow label="风险 · risk">
        {spark.risk || <span style={{ color: 'var(--ink-3)', fontStyle: 'italic' }}>(risk not yet articulated)</span>}
      </SectionRow>

      <SectionRow label="状态记录 · transitions">
        <TransitionsTable transitions={spark.transitions} />
      </SectionRow>

      <div style={{
        marginTop: 8,
        paddingTop: 18,
        borderTop: '1px solid var(--rule-soft)',
      }}>
        <SectionLabel>下一步 · next</SectionLabel>
        <div style={{ marginTop: 8 }}>
          <TransitionControls spark={spark} busy={busy} onTransition={onTransition} />
        </div>
        {transitionError && (
          <div style={{
            marginTop: 12,
            fontSize: 12,
            color: '#8B3A3A',
            fontFamily: 'EB Garamond, "Noto Serif SC", serif',
          }}>
            {transitionError}
          </div>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main — SparkPoolScreen
// ---------------------------------------------------------------------------

const SparkPoolScreen = (props) => {
  const slug = props && props.slug ? String(props.slug) : null;
  const onBack = props && typeof props.onBack === 'function' ? props.onBack : null;

  const [sparks, setSparks] = useState([]);
  const [selected, setSelected] = useState(null);
  const [selectedSpark, setSelectedSpark] = useState(null);
  const [filter, setFilter] = useState('');
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [transitionError, setTransitionError] = useState(null);

  const sparkApi = useMemo(() => (
    (typeof window !== 'undefined' && window.ptor && window.ptor.spark) || null
  ), []);

  // Load list — fires on mount + filter change. Defensive: tolerates the
  // IPC bridge being absent (renders empty + a one-line error).
  useEffect(() => {
    if (!slug) { setListLoading(false); return undefined; }
    if (!sparkApi || typeof sparkApi.list !== 'function') {
      setListError('spark bridge unavailable');
      setListLoading(false);
      return undefined;
    }
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    (async () => {
      try {
        const filterState = filter || undefined;
        const result = await sparkApi.list(slug, filterState);
        if (cancelled) return;
        const list = Array.isArray(result) ? result : (result && Array.isArray(result.sparks) ? result.sparks : []);
        setSparks(list);
        // Keep selection if still in the filtered set; else pick first.
        if (list.length > 0) {
          const stillThere = selected && list.find(s => s.spark_id === selected);
          if (!stillThere) setSelected(list[0].spark_id);
        } else {
          setSelected(null);
        }
      } catch (err) {
        if (!cancelled) {
          setListError((err && err.message) ? err.message : 'list failed');
          setSparks([]);
        }
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // selected intentionally NOT a dep — we don't want to re-fetch the list
    // each time the user clicks a card. We re-evaluate selection inside the
    // effect from the freshly-fetched list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, filter, sparkApi]);

  // Hydrate full spark detail when selection changes. The list response
  // already carries the full spark shape, but we re-fetch on selection so
  // the detail panel reflects the latest disk state (cheap, file-backed).
  useEffect(() => {
    if (!slug || !selected) { setSelectedSpark(null); return undefined; }
    if (!sparkApi || typeof sparkApi.get !== 'function') {
      const fallback = sparks.find(s => s.spark_id === selected) || null;
      setSelectedSpark(fallback);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await sparkApi.get(slug, selected);
        if (cancelled) return;
        const spark = (result && result.spark) || result;
        setSelectedSpark(spark || null);
      } catch (_) {
        if (!cancelled) {
          // Fall back to the list snapshot — better than empty.
          const fallback = sparks.find(s => s.spark_id === selected) || null;
          setSelectedSpark(fallback);
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, selected, sparkApi]);

  // ESC → onBack. Skip when focus is inside a text field.
  useEffect(() => {
    if (!onBack) return undefined;
    const handler = (e) => {
      if (e.key !== 'Escape') return;
      const tgt = e.target;
      const tag = tgt && tgt.tagName;
      const isEditable = tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || (tgt && tgt.isContentEditable);
      if (isEditable) return;
      onBack();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onBack]);

  // Transition click → IPC → re-fetch list + detail. Optimistic UI is
  // deliberately avoided — the lib enforces the state machine and we want
  // any rejected transition to surface as a typed error.
  const handleTransition = useCallback(async (nextState) => {
    if (!slug || !selected || !sparkApi || typeof sparkApi.transition !== 'function') return;
    setBusy(true);
    setTransitionError(null);
    try {
      // Surface a tiny prompt for reason — optional but useful for the audit
      // trail. Cancelling falls through as empty reason.
      let reason = '';
      try {
        const ans = window.prompt('记一句迁移理由 (可空)', '');
        reason = (ans == null) ? '' : String(ans);
      } catch (_) { /* prompt unavailable in some shells */ }
      await sparkApi.transition(slug, selected, nextState, { reason });
      // Re-fetch list to pick up new state + filter; re-hydrate detail.
      const filterState = filter || undefined;
      const list = await sparkApi.list(slug, filterState);
      const arr = Array.isArray(list) ? list : (list && Array.isArray(list.sparks) ? list.sparks : []);
      setSparks(arr);
      const stillThere = arr.find(s => s.spark_id === selected);
      if (stillThere) {
        const fresh = await sparkApi.get(slug, selected);
        setSelectedSpark((fresh && fresh.spark) || fresh || stillThere);
      } else {
        // Spark left the filtered view (e.g. user filter=seed and just moved
        // to considered). Drop selection.
        setSelected(arr.length ? arr[0].spark_id : null);
      }
    } catch (err) {
      const msg = (err && err.message) ? err.message : 'transition failed';
      setTransitionError(msg);
    } finally {
      setBusy(false);
    }
  }, [slug, selected, sparkApi, filter]);

  // Render: full-page two-column layout with sticky top filter strip.
  if (!slug) {
    return (
      <div className="col gap-16" style={{
        padding: '60px 60px', maxWidth: 720, margin: '0 auto',
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      }}>
        <h1 className="serif italic" style={{ fontSize: 28, margin: 0, fontWeight: 400 }}>
          Sparks
        </h1>
        <p style={{ fontSize: 14, color: 'var(--ink-2)' }}>
          没有 product slug — 先在 Home 选一门课程再进 Spark Pool。
        </p>
        {onBack && (
          <button onClick={onBack} className="btn btn-ghost" style={{ fontSize: 13, alignSelf: 'flex-start' }}>
            返回
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="fade-in" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <div className="row gap-16" style={{
        padding: '20px 36px',
        alignItems: 'baseline',
        borderBottom: '1px solid var(--rule-soft)',
        background: 'linear-gradient(180deg, rgba(244,239,228,.92), rgba(244,239,228,.5))',
        position: 'sticky', top: 0, zIndex: 5,
        backdropFilter: 'blur(6px)',
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      }}>
        {onBack && (
          <button onClick={onBack} className="btn btn-ghost" style={{ fontSize: 13 }}>
            返回
          </button>
        )}
        <div className="col gap-2" style={{ marginLeft: 6 }}>
          <span className="mono" style={{
            fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.12em',
          }}>
            SPARK POOL · {slug}
          </span>
          <h1 className="serif italic" style={{
            fontSize: 22, margin: 0, fontWeight: 400, color: 'var(--ink)',
          }}>
            Sparks
          </h1>
        </div>
        <span style={{ flex: 1 }} />
        <FilterTabs value={filter} onChange={setFilter} />
      </div>

      {/* Body — two columns */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Left: list */}
        <div style={{
          width: 380,
          flexShrink: 0,
          overflowY: 'auto',
          padding: '20px 20px 60px',
          borderRight: '1px solid var(--rule-soft)',
          background: 'rgba(244,239,228,0.4)',
        }}>
          {listLoading && (
            <div style={{
              fontStyle: 'italic',
              color: 'var(--ink-3)',
              fontSize: 13,
              fontFamily: 'EB Garamond, "Noto Serif SC", serif',
              padding: 12,
            }}>
              loading sparks…
            </div>
          )}
          {listError && (
            <div style={{
              color: '#8B3A3A',
              fontSize: 13,
              fontFamily: 'EB Garamond, "Noto Serif SC", serif',
              padding: 12,
            }}>
              {listError}
            </div>
          )}
          {!listLoading && !listError && sparks.length === 0 && (
            <div style={{
              fontStyle: 'italic',
              color: 'var(--ink-3)',
              fontSize: 13,
              fontFamily: 'EB Garamond, "Noto Serif SC", serif',
              padding: 12,
            }}>
              {filter ? `(no sparks in ${filter})` : '(no sparks yet — 在 lesson 末 confirm transfer 即创建一条)'}
            </div>
          )}
          {sparks.map((s) => (
            <SparkCard
              key={s.spark_id}
              spark={s}
              selected={s.spark_id === selected}
              onSelect={setSelected}
            />
          ))}
        </div>

        {/* Right: detail */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <SparkDetail
            spark={selectedSpark}
            busy={busy}
            onTransition={handleTransition}
            transitionError={transitionError}
          />
        </div>
      </div>
    </div>
  );
};

window.SparkPoolScreen = SparkPoolScreen;
