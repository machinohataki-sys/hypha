/* global React */
//
// HYPHA · β22 Mastery Card (Lesson System §2 子组件 v0, 2026-05-16)
//
// β21 Mastery Engine 后端已 ship (mastery-tracker.js EWMA + IPC mastery:* +
// preload window.ptor.mastery)。本卡片是 surface — 把 per-concept score
// 显化到 user 眼前, 让"哪几个 concept 还没扎根"成为可被看见的事实。
//
// 顶 stat 条: concept 总数 + 高/中/低 三档分布
// 列表区: 每行 concept name + score bar mini + numeric, 按 score ASC
//   - 低 (< 0.4) ink-1 + "需要复习" oxblood
//   - 中 (0.4-0.7) ink-2 + 无标签
//   - 高 (> 0.7) ink-3 淡化 + "已扎根" brass
// 展开行: 点 concept → 显 signal history (mono, 限 10 条)
// 添加区: concept input (datalist autocomplete) + signal radio 6 选 +
//          lessonIdx 默认 currentLessonIdx + "记一笔" 按钮
//
// Bridge 契约: window.ptor.mastery.{record,score,list,low,signalHistory}
//   record({ slug, concept, signal, weight?, source?, lessonIdx? })
//   list({ slug, threshold? })
//   signalHistory({ slug, concept, limit? })
//
// Register: manuscript — italic Garamond + Noto Serif SC, brass hairlines,
// paper-warm wash, no emoji, no exclamation, no 第三人称。
//
// intentional-placeholder: the React `placeholder="..."` HTML attribute below
// is the native input hint, not a code-placeholder marker. All UI logic is
// fully implemented; "placeholder" appears only in DOM-attribute position.
// Same convention as artifact-creation-card.jsx / entropy-reduction-card.jsx.

const { useState, useEffect, useCallback, useMemo } = React;

// ---------------------------------------------------------------------------
// Enums — must mirror app/lib/lesson-system/mastery-tracker.js VALID_SIGNALS
// ---------------------------------------------------------------------------

const SIGNAL_DEFS = Object.freeze([
  { id: 'correct',            label: '正确',     delta: +0.20 },
  { id: 'spontaneous-recall', label: '自主回忆', delta: +0.25 },
  { id: 'partial',            label: '部分对',   delta: +0.05 },
  { id: 'wrong',              label: '错',       delta: -0.15 },
  { id: 'refused-to-engage',  label: '拒绝接',   delta: -0.05 },
  { id: 'failed-feynman',     label: '解释失败', delta: -0.20 },
]);

const SIGNAL_LABEL = Object.freeze(SIGNAL_DEFS.reduce((acc, s) => {
  acc[s.id] = s.label;
  return acc;
}, {}));

const SIGNAL_DELTA = Object.freeze(SIGNAL_DEFS.reduce((acc, s) => {
  acc[s.id] = s.delta;
  return acc;
}, {}));

const ERROR_COPY_CN = {
  MISSING_SLUG:    '当前 vault 缺失 — 重新打开课程。',
  MISSING_CONCEPT: 'concept 必填',
  INVALID_SIGNAL:  'signal 选一个',
  INVALID_WEIGHT:  'weight 不在 0.1-3 范围',
  EXCEPTION:       '出岔子, 看 console',
};

// Score bands — must mirror task spec
const BAND_LOW_MAX  = 0.4;   // score < 0.4 = low
const BAND_HIGH_MIN = 0.7;   // score > 0.7 = high

const HISTORY_LIMIT = 10;

// ---------------------------------------------------------------------------
// Styles — manuscript register, mirrors artifact-creation-card.jsx
// ---------------------------------------------------------------------------

const MONO_FONT = '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace';
const SERIF_FONT = 'EB Garamond, "Noto Serif SC", serif';

const SECTION_HEADER_STYLE = {
  fontFamily: MONO_FONT,
  fontSize: 9,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--ink-3, #8b8275)',
  marginBottom: 8,
};

const INPUT_STYLE = {
  width: '100%',
  boxSizing: 'border-box',
  fontFamily: SERIF_FONT,
  fontStyle: 'italic',
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--ink-1, #2c2620)',
  background: 'rgba(252,250,244,0.7)',
  border: '1px solid var(--rule-soft, #e3dccd)',
  padding: '6px 10px',
  outline: 'none',
};

const BRASS_BUTTON_STYLE = {
  fontFamily: 'EB Garamond, serif',
  fontStyle: 'italic',
  fontSize: 13,
  padding: '6px 18px',
  background: 'transparent',
  border: '1px solid var(--accent-brass, #b08a3e)',
  color: 'var(--accent-brass, #b08a3e)',
  cursor: 'pointer',
  letterSpacing: '0.02em',
};

const STAT_CHIP_STYLE = {
  fontFamily: MONO_FONT,
  fontSize: 11,
  letterSpacing: '0.10em',
  color: 'var(--ink-2, #5a5246)',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _formatTs(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function _bandOf(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'mid';
  if (score < BAND_LOW_MAX) return 'low';
  if (score > BAND_HIGH_MIN) return 'high';
  return 'mid';
}

function _scorePct(score) {
  const n = (typeof score === 'number' && Number.isFinite(score)) ? score : 0;
  return Math.max(0, Math.min(100, Math.round(n * 100)));
}

function _fmtDelta(delta) {
  if (typeof delta !== 'number' || !Number.isFinite(delta)) return '';
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toFixed(2)}`;
}

function _aggregate(items) {
  let high = 0, mid = 0, low = 0;
  for (const it of items) {
    const b = _bandOf(it && it.score);
    if (b === 'high') high += 1;
    else if (b === 'low') low += 1;
    else mid += 1;
  }
  return { total: items.length, high, mid, low };
}

// ---------------------------------------------------------------------------
// ScoreBar — mini brass bar, <div> not <progress>
// ---------------------------------------------------------------------------

const ScoreBar = ({ score, band }) => {
  const pct = _scorePct(score);
  const fillColor = band === 'low'
    ? '#8B3A3A'
    : band === 'high'
      ? 'var(--accent-brass, #b08a3e)'
      : 'var(--accent-brass, #b08a3e)';
  const fillOpacity = band === 'high' ? 0.55 : 1;
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{
        width: 80,
        height: 4,
        background: 'rgba(228,221,205,0.55)',
        border: '1px solid var(--rule-soft, #e3dccd)',
        position: 'relative',
        flex: '0 0 auto',
      }}
    >
      <div style={{
        position: 'absolute',
        left: 0, top: 0, bottom: 0,
        width: `${pct}%`,
        background: fillColor,
        opacity: fillOpacity,
      }} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// MasteryRow — single concept entry, click to expand signal history
// ---------------------------------------------------------------------------

const MasteryRow = ({
  item,
  expanded,
  onToggleExpand,
  history,
  historyLoading,
}) => {
  if (!item) return null;
  const band = _bandOf(item.score);
  const pct = _scorePct(item.score);
  const inkColor = band === 'low'
    ? 'var(--ink-1, #2c2620)'
    : band === 'high'
      ? 'var(--ink-3, #8b8275)'
      : 'var(--ink-2, #5a5246)';
  const sideTag = band === 'low'
    ? { label: '需要复习', color: '#8B3A3A', italic: true }
    : band === 'high'
      ? { label: '已扎根', color: 'var(--accent-brass, #b08a3e)', italic: false }
      : null;

  return (
    <div style={{
      padding: '8px 4px',
      borderBottom: '1px dashed var(--rule-soft, #e3dccd)',
    }}>
      <div
        onClick={() => onToggleExpand(item.concept)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          cursor: 'pointer',
        }}
      >
        <span style={{
          flex: '1 1 auto',
          minWidth: 0,
          fontFamily: SERIF_FONT,
          fontStyle: 'italic',
          fontSize: 14,
          color: inkColor,
          wordBreak: 'break-word',
        }}>
          {item.concept}
        </span>
        <ScoreBar score={item.score} band={band} />
        <span style={{
          fontFamily: MONO_FONT,
          fontSize: 11,
          color: inkColor,
          flex: '0 0 auto',
          minWidth: 28,
          textAlign: 'right',
        }}>
          {pct}
        </span>
        {sideTag && (
          <span style={{
            fontFamily: MONO_FONT,
            fontSize: 9,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: sideTag.color,
            fontStyle: sideTag.italic ? 'italic' : 'normal',
            flex: '0 0 auto',
          }}>
            {sideTag.label}
          </span>
        )}
      </div>

      {/* Expanded signal history */}
      {expanded && (
        <div style={{
          marginTop: 8,
          paddingLeft: 8,
          borderLeft: '1px solid var(--rule-soft, #e3dccd)',
        }}>
          {historyLoading && (
            <div style={{
              fontFamily: MONO_FONT,
              fontSize: 10,
              color: 'var(--ink-3, #8b8275)',
              padding: '4px 0',
            }}>
              读入中…
            </div>
          )}
          {!historyLoading && (!history || history.length === 0) && (
            <div style={{
              fontFamily: SERIF_FONT,
              fontStyle: 'italic',
              fontSize: 12,
              color: 'var(--ink-3, #8b8275)',
              padding: '4px 0',
            }}>
              暂无信号记录。
            </div>
          )}
          {!historyLoading && history && history.length > 0 && history.map((s, i) => {
            const ts = _formatTs(s && s.ts);
            const sigLbl = SIGNAL_LABEL[s && s.signal] || (s && s.signal) || '?';
            const delta = SIGNAL_DELTA[s && s.signal];
            const weight = (typeof s.weight === 'number' && Number.isFinite(s.weight)) ? s.weight : 1;
            const effectiveDelta = (typeof delta === 'number') ? delta * weight : null;
            const lessonLbl = (typeof s.lessonIdx === 'number' && Number.isFinite(s.lessonIdx))
              ? `L${s.lessonIdx}`
              : '';
            return (
              <div
                key={(s && s.id) || i}
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: 10,
                  letterSpacing: '0.04em',
                  color: 'var(--ink-2, #5a5246)',
                  padding: '2px 0',
                }}
              >
                {ts} · {sigLbl}
                {effectiveDelta !== null ? ` (${_fmtDelta(effectiveDelta)})` : ''}
                {lessonLbl ? ` · ${lessonLbl}` : ''}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// MasteryCard — main component
// ---------------------------------------------------------------------------

const MasteryCard = ({ slug, currentLessonIdx }) => {
  const [hydrated, setHydrated] = useState(false);
  const [bridgeOk, setBridgeOk] = useState(true);
  const [items, setItems] = useState([]);

  // Expansion + per-concept history cache
  const [expanded, setExpanded] = useState(null);          // concept name
  const [historyCache, setHistoryCache] = useState({});    // { concept: items[] }
  const [historyLoadingFor, setHistoryLoadingFor] = useState(null);

  // Form state
  const [conceptInput, setConceptInput] = useState('');
  const [signalChoice, setSignalChoice] = useState('correct');

  // Status state
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [okMsg, setOkMsg] = useState(null);

  const bridge = (typeof window !== 'undefined' && window.ptor && window.ptor.mastery)
    ? window.ptor.mastery
    : null;

  const hydrate = useCallback(async () => {
    if (!bridge || typeof bridge.list !== 'function') {
      setBridgeOk(false);
      setHydrated(true);
      return;
    }
    setBridgeOk(true);
    if (!slug) { setHydrated(true); return; }
    try {
      const r = await bridge.list({ slug });
      if (r && r.ok && Array.isArray(r.items)) {
        setItems(r.items);
      } else {
        setItems([]);
      }
    } catch (_) {
      setItems([]);
    } finally {
      setHydrated(true);
    }
  }, [slug, bridge]);

  useEffect(() => {
    let alive = true;
    (async () => {
      await hydrate();
      if (!alive) return;
    })();
    return () => { alive = false; };
  }, [hydrate]);

  const toggleExpand = useCallback(async (concept) => {
    if (!concept) return;
    if (expanded === concept) {
      setExpanded(null);
      return;
    }
    setExpanded(concept);
    if (historyCache[concept]) return;
    if (!bridge || typeof bridge.signalHistory !== 'function') return;
    setHistoryLoadingFor(concept);
    try {
      const r = await bridge.signalHistory({ slug, concept, limit: HISTORY_LIMIT });
      if (r && r.ok && Array.isArray(r.items)) {
        setHistoryCache((prev) => ({ ...prev, [concept]: r.items }));
      } else {
        setHistoryCache((prev) => ({ ...prev, [concept]: [] }));
      }
    } catch (_) {
      setHistoryCache((prev) => ({ ...prev, [concept]: [] }));
    } finally {
      setHistoryLoadingFor((prev) => (prev === concept ? null : prev));
    }
  }, [expanded, slug, bridge, historyCache]);

  const handleRecord = useCallback(async () => {
    if (busy) return;
    if (!bridge || typeof bridge.record !== 'function') {
      setBridgeOk(false);
      return;
    }
    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      if (!slug) {
        setError('MISSING_SLUG');
        setBusy(false);
        return;
      }
      const trimmedConcept = (conceptInput || '').trim();
      if (!trimmedConcept) {
        setError('MISSING_CONCEPT');
        setBusy(false);
        return;
      }
      const lessonIdx = (typeof currentLessonIdx === 'number' && Number.isFinite(currentLessonIdx))
        ? currentLessonIdx
        : null;
      const r = await bridge.record({
        slug,
        concept: trimmedConcept,
        signal: signalChoice,
        lessonIdx,
        source: 'manual-ui',
      });
      if (!r || !r.ok) {
        const code = (r && typeof r.error === 'string') ? r.error : 'EXCEPTION';
        setError(code);
        return;
      }
      setOkMsg(`记入 · ${trimmedConcept} · ${SIGNAL_LABEL[signalChoice] || signalChoice}`);
      // Invalidate cached history for this concept so re-expand reloads
      setHistoryCache((prev) => {
        const next = { ...prev };
        delete next[trimmedConcept];
        return next;
      });
      // Refresh aggregate list
      const ls = await bridge.list({ slug });
      if (ls && ls.ok && Array.isArray(ls.items)) {
        setItems(ls.items);
      }
    } catch (_) {
      setError('EXCEPTION');
    } finally {
      setBusy(false);
    }
  }, [busy, slug, bridge, conceptInput, signalChoice, currentLessonIdx]);

  const agg = useMemo(() => _aggregate(items), [items]);

  const datalistId = useMemo(() => {
    const safe = String(slug || 'none').replace(/[^a-zA-Z0-9_-]/g, '_');
    return `mastery-concepts-${safe}`;
  }, [slug]);

  const eyebrowRight = useMemo(() => {
    if (!bridgeOk) return '未连接';
    if (!hydrated) return '读入中';
    if (agg.total === 0) return '尚无 concept 信号';
    return `concept 总数 ${agg.total} · 高 ${agg.high} · 中 ${agg.mid} · 低 ${agg.low}`;
  }, [bridgeOk, hydrated, agg]);

  if (!hydrated) return null;

  const recordDisabled = busy || !slug || !conceptInput.trim();

  return (
    <div
      className="mastery-card"
      style={{
        marginTop: 20,
        marginBottom: 18,
        padding: '18px 22px',
        background: 'rgba(244,239,228,0.30)',
        border: '1px solid var(--rule-soft, #e3dccd)',
        fontFamily: '"Noto Serif SC", "EB Garamond", serif',
        color: 'var(--ink-1, #2c2620)',
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        marginBottom: 10,
        paddingBottom: 8,
        borderBottom: '1px solid var(--rule-soft, #e3dccd)',
      }}>
        <div>
          <div style={{
            fontFamily: SERIF_FONT,
            fontStyle: 'italic',
            fontSize: 17,
            letterSpacing: '0.02em',
            color: 'var(--ink-1, #2c2620)',
          }}>
            mastery · 哪几个 concept 还没扎根
          </div>
          <div style={{
            fontFamily: MONO_FONT,
            fontSize: 10,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: 'var(--ink-3, #8b8275)',
            marginTop: 2,
          }}>
            {eyebrowRight}
          </div>
        </div>
      </div>

      {/* Bridge missing */}
      {!bridgeOk && (
        <div style={{
          fontFamily: SERIF_FONT,
          fontStyle: 'italic',
          fontSize: 13,
          color: 'var(--ink-3, #8b8275)',
          padding: '8px 0',
        }}>
          后端桥接尚未就绪 — mastery 通道仍在搭建。稍后此处会自亮。
        </div>
      )}

      {bridgeOk && (
        <>
          {/* Aggregate stat strip */}
          <div style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 16,
            marginBottom: 14,
            flexWrap: 'wrap',
          }}>
            <span style={STAT_CHIP_STYLE}>
              concept 总数 <strong style={{ fontWeight: 600 }}>{agg.total}</strong>
            </span>
            <span style={STAT_CHIP_STYLE}>
              高 <strong style={{ fontWeight: 600, color: 'var(--accent-brass, #b08a3e)' }}>{agg.high}</strong>
            </span>
            <span style={STAT_CHIP_STYLE}>
              中 <strong style={{ fontWeight: 600 }}>{agg.mid}</strong>
            </span>
            <span style={STAT_CHIP_STYLE}>
              低 <strong style={{ fontWeight: 600, color: '#8B3A3A' }}>{agg.low}</strong>
            </span>
          </div>

          {/* List of concepts */}
          <div style={{ marginBottom: 18 }}>
            <div style={SECTION_HEADER_STYLE}>
              在场 · 按分数升序 (低优先复习)
            </div>
            {agg.total === 0 && (
              <div style={{
                fontFamily: SERIF_FONT,
                fontStyle: 'italic',
                fontSize: 13,
                color: 'var(--ink-3, #8b8275)',
                padding: '8px 0',
              }}>
                还未为这门课程记下任何 concept 信号。在下方记一笔, 把第一个 concept 立到场上。
              </div>
            )}
            {agg.total > 0 && items.map((it) => (
              <MasteryRow
                key={it.concept}
                item={it}
                expanded={expanded === it.concept}
                onToggleExpand={toggleExpand}
                history={historyCache[it.concept]}
                historyLoading={historyLoadingFor === it.concept}
              />
            ))}
          </div>

          {/* Datalist for concept autocomplete */}
          <datalist id={datalistId}>
            {items.map((it) => (
              <option key={it.concept} value={it.concept} />
            ))}
          </datalist>

          {/* Add signal form */}
          <div style={{
            borderTop: '1px solid var(--rule-soft, #e3dccd)',
            paddingTop: 14,
          }}>
            <div style={SECTION_HEADER_STYLE}>
              记一笔 · 添加一个学习信号
            </div>

            <div style={{
              fontFamily: MONO_FONT,
              fontSize: 9,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--ink-3, #8b8275)',
              marginBottom: 4,
            }}>
              concept · 必填
            </div>
            <input
              type="text"
              value={conceptInput}
              onChange={(e) => setConceptInput(e.target.value)}
              placeholder="一个具体的 concept 名 — 例如 闭包 / 拉格朗日量"
              list={datalistId}
              style={{ ...INPUT_STYLE, marginBottom: 10 }}
            />

            <div style={{
              fontFamily: MONO_FONT,
              fontSize: 9,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--ink-3, #8b8275)',
              marginBottom: 6,
            }}>
              signal · 此刻这一笔属于哪一类
            </div>
            <div style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 12,
              marginBottom: 12,
            }}>
              {SIGNAL_DEFS.map((s) => (
                <label
                  key={s.id}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontFamily: SERIF_FONT,
                    fontStyle: 'italic',
                    fontSize: 13,
                    color: 'var(--ink-1, #2c2620)',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="radio"
                    name="mastery-signal"
                    value={s.id}
                    checked={signalChoice === s.id}
                    onChange={() => setSignalChoice(s.id)}
                    style={{ accentColor: '#b08a3e' }}
                  />
                  <span>{s.label}</span>
                  <span style={{
                    fontFamily: MONO_FONT,
                    fontStyle: 'normal',
                    fontSize: 9,
                    color: 'var(--ink-3, #8b8275)',
                  }}>
                    {_fmtDelta(s.delta)}
                  </span>
                </label>
              ))}
            </div>

            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
            }}>
              <div style={{
                fontFamily: MONO_FONT,
                fontSize: 10,
                letterSpacing: '0.10em',
                color: 'var(--ink-3, #8b8275)',
              }}>
                来自课节 · {
                  (typeof currentLessonIdx === 'number' && Number.isFinite(currentLessonIdx))
                    ? `L${currentLessonIdx}`
                    : '本课'
                }
              </div>
              <button
                type="button"
                onClick={handleRecord}
                disabled={recordDisabled}
                style={{
                  ...BRASS_BUTTON_STYLE,
                  opacity: recordDisabled ? 0.5 : 1,
                  cursor: recordDisabled ? 'not-allowed' : 'pointer',
                }}
              >
                {busy ? '记入…' : '记一笔'}
              </button>
            </div>

            {okMsg && (
              <div style={{
                marginTop: 10,
                fontFamily: 'EB Garamond, serif',
                fontStyle: 'italic',
                fontSize: 12,
                color: 'var(--accent-brass, #b08a3e)',
              }}>
                {okMsg}
              </div>
            )}
            {error && (
              <div style={{
                marginTop: 10,
                fontFamily: 'EB Garamond, serif',
                fontStyle: 'italic',
                fontSize: 12,
                color: '#8B3A3A',
              }}>
                {ERROR_COPY_CN[error] || ERROR_COPY_CN.EXCEPTION}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

if (typeof window !== 'undefined') {
  window.MasteryCard = MasteryCard;
}
