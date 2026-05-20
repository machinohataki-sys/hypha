/* global React */
//
// HYPHA · α22 Cost Budget Card (Infrastructure §16 子组件 v0 UI, 2026-05-16)
//
// 接 α21 backend (`app/lib/infrastructure/cost-budget.js`) — per-curriculum 月
// budget 跟踪 + soft 警告 (90% warn / 100% over / 110% over-110). 用户在 lesson
// chat 屏 footer band 看本月花了多少, 设定本月上限, 看 6 月历史。
//
// 桥接契约 (window.ptor.costBudget, see preload.js α21 block):
//   set({ slug, budgetUSD })
//     → { ok:true, budget } | { ok:false, error: 'MISSING_SLUG'|'INVALID_BUDGET'|'EXCEPTION' }
//   status({ slug, month? })
//     → { ok:true, status:{ slug, month, budgetUSD, spentUSD, remainingUSD,
//          percentUsed, state:'ok'|'warn-90'|'over-100'|'over-110'|'no-budget',
//          callCount } }
//        | { ok:false, error }
//   history({ slug, limit? })
//     → { ok:true, rows:[{month, totalUSD, callCount}] } | { ok:false, error }
//   record({ slug, costUSD, provider, model, ts? }) — not called from UI
//
// Register: manuscript — italic Garamond + Noto Serif SC, brass hairlines,
// paper-warm wash. No emoji, no exclamation, no 第三人称.
//
// intentional-placeholder: the React `placeholder="..."` HTML attribute below
// is the native input hint, not a code-placeholder marker. All UI logic is
// fully implemented; "placeholder" appears only in DOM-attribute position.
// Same convention as artifact-creation-card.jsx / judgment-gym-card.jsx /
// entropy-reduction-card.jsx.

const { useState, useEffect, useCallback, useMemo } = React;

// ---------------------------------------------------------------------------
// Enums + copy
// ---------------------------------------------------------------------------

const STATE_COPY_CN = Object.freeze({
  'ok':         { text: '还在节制范围内 — 不动声色',           tone: 'ink-2' },
  'warn-90':    { text: '已过 90% — 该收手了',                  tone: 'brass' },
  'over-100':   { text: '超出本月预算 — 已经在烧明月的钱',      tone: 'oxblood' },
  'over-110':   { text: '远超预算 — 该锁就锁',                  tone: 'oxblood' },
  'no-budget':  { text: '未设月度上限',                          tone: 'ink-3' },
});

const ERROR_COPY_CN = Object.freeze({
  INVALID_BUDGET: '金额超 $1000 或 ≤ 0, 改一下',
  MISSING_SLUG:   '当前 vault 缺失 — 重新打开课程',
  INVALID_COST:   '不该走到这',
  EXCEPTION:      '出岔子, 看 console',
});

const HISTORY_LIMIT = 6;
const MAX_BUDGET_USD = 1000;
const MIN_BUDGET_USD = 1;

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const MONO_FONT = '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace';
const SERIF_FONT = 'EB Garamond, "Noto Serif SC", serif';

const EYEBROW_STYLE = {
  fontFamily: MONO_FONT,
  fontSize: 10,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: 'var(--ink-3, #8b8275)',
  marginBottom: 14,
};

const SECTION_HEADER_STYLE = {
  fontFamily: MONO_FONT,
  fontSize: 9,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--ink-3, #8b8275)',
  marginBottom: 8,
};

const BIG_NUMBER_STYLE = {
  fontFamily: SERIF_FONT,
  fontStyle: 'italic',
  fontSize: 28,
  lineHeight: 1.15,
  color: 'var(--accent-brass, #b08a3e)',
  letterSpacing: '0.01em',
};

const BIG_NUMBER_TRAIL_STYLE = {
  fontFamily: SERIF_FONT,
  fontStyle: 'italic',
  fontSize: 16,
  color: 'var(--ink-3, #8b8275)',
  marginLeft: 6,
};

const NUMERIC_LINE_STYLE = {
  fontFamily: SERIF_FONT,
  fontStyle: 'italic',
  fontSize: 13,
  lineHeight: 1.7,
  color: 'var(--ink-2, #5a5246)',
};

const INPUT_STYLE = {
  fontFamily: SERIF_FONT,
  fontStyle: 'italic',
  fontSize: 14,
  color: 'var(--ink-1, #2c2620)',
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid var(--accent-brass, #b08a3e)',
  padding: '4px 6px',
  outline: 'none',
  width: 110,
  textAlign: 'right',
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _toneColor(tone) {
  switch (tone) {
    case 'brass':   return 'var(--accent-brass, #b08a3e)';
    case 'oxblood': return 'var(--accent-oxblood, #8B3A3A)';
    case 'ink-2':   return 'var(--ink-2, #5a5246)';
    case 'ink-3':   return 'var(--ink-3, #8b8275)';
    default:        return 'var(--ink-2, #5a5246)';
  }
}

function _fmtUSD(n) {
  if (!Number.isFinite(n)) return '$0.00';
  return '$' + (Math.round(n * 100) / 100).toFixed(2);
}

function _fmtInt(n) {
  if (!Number.isFinite(n)) return '0';
  return String(Math.round(n));
}

function _validateBudgetInput(raw) {
  const num = parseFloat(raw);
  if (!Number.isFinite(num)) return { ok: false, error: 'INVALID_BUDGET' };
  if (num < MIN_BUDGET_USD) return { ok: false, error: 'INVALID_BUDGET' };
  if (num > MAX_BUDGET_USD) return { ok: false, error: 'INVALID_BUDGET' };
  return { ok: true, value: num };
}

// ---------------------------------------------------------------------------
// HistoryBar — mini 6-month bar chart
// ---------------------------------------------------------------------------

const HistoryBar = ({ rows }) => {
  if (!Array.isArray(rows) || rows.length === 0) {
    return (
      <div style={{
        fontFamily: SERIF_FONT,
        fontStyle: 'italic',
        fontSize: 12,
        color: 'var(--ink-3, #8b8275)',
        padding: '4px 0',
      }}>
        还无历史 — 第一月才开始。
      </div>
    );
  }
  const maxTotal = rows.reduce((m, r) => Math.max(m, Number.isFinite(r.totalUSD) ? r.totalUSD : 0), 0);
  // Render oldest → newest for natural left-to-right reading
  const ordered = rows.slice().reverse();
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, padding: '4px 0' }}>
      {ordered.map((r) => {
        const total = Number.isFinite(r.totalUSD) ? r.totalUSD : 0;
        const calls = Number.isFinite(r.callCount) ? r.callCount : 0;
        const heightPx = maxTotal > 0 ? Math.max(2, Math.round((total / maxTotal) * 40)) : 2;
        return (
          <div key={r.month} style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            flex: '1 1 0',
            minWidth: 40,
          }}>
            <div
              title={`${r.month} · ${_fmtUSD(total)} · ${calls} 次`}
              style={{
                width: '70%',
                height: heightPx,
                background: 'var(--accent-brass, #b08a3e)',
                opacity: 0.7,
              }}
            />
            <div style={{
              fontFamily: MONO_FONT,
              fontSize: 9,
              letterSpacing: '0.08em',
              color: 'var(--ink-3, #8b8275)',
              marginTop: 4,
            }}>
              {r.month}
            </div>
            <div style={{
              fontFamily: MONO_FONT,
              fontSize: 9,
              letterSpacing: '0.04em',
              color: 'var(--ink-3, #8b8275)',
              marginTop: 1,
            }}>
              {_fmtUSD(total)}
            </div>
            <div style={{
              fontFamily: MONO_FONT,
              fontSize: 9,
              letterSpacing: '0.04em',
              color: 'var(--ink-3, #8b8275)',
            }}>
              {calls}次
            </div>
          </div>
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// CostBudgetCard — main component
// ---------------------------------------------------------------------------

const CostBudgetCard = ({ slug, onClose }) => {
  const [hydrated, setHydrated] = useState(false);
  const [bridgeOk, setBridgeOk] = useState(true);
  const [status, setStatus] = useState(null);
  const [history, setHistory] = useState([]);

  // Form state
  const [budgetInput, setBudgetInput] = useState('');
  const [editing, setEditing] = useState(false);

  // Status state
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [okMsg, setOkMsg] = useState(null);

  const hydrate = useCallback(async () => {
    const bridge = (typeof window !== 'undefined' && window.ptor && window.ptor.costBudget) || null;
    if (!bridge || typeof bridge.status !== 'function' || typeof bridge.history !== 'function') {
      setBridgeOk(false);
      setHydrated(true);
      return;
    }
    setBridgeOk(true);
    if (!slug) {
      setHydrated(true);
      return;
    }
    try {
      const sRes = await bridge.status({ slug });
      if (sRes && sRes.ok && sRes.status) {
        setStatus(sRes.status);
        // Seed input with current budget if set
        if (sRes.status.state !== 'no-budget' && Number.isFinite(sRes.status.budgetUSD)) {
          setBudgetInput(String(sRes.status.budgetUSD));
        }
      } else {
        setStatus(null);
      }
      const hRes = await bridge.history({ slug, limit: HISTORY_LIMIT });
      if (hRes && hRes.ok && Array.isArray(hRes.rows)) {
        setHistory(hRes.rows);
      } else {
        setHistory([]);
      }
    } catch (_) {
      setStatus(null);
      setHistory([]);
    } finally {
      setHydrated(true);
    }
  }, [slug]);

  useEffect(() => {
    let alive = true;
    (async () => {
      await hydrate();
      if (!alive) return;
    })();
    return () => { alive = false; };
  }, [hydrate]);

  const handleSet = useCallback(async () => {
    if (busy) return;
    const bridge = (typeof window !== 'undefined' && window.ptor && window.ptor.costBudget) || null;
    if (!bridge || typeof bridge.set !== 'function') {
      setBridgeOk(false);
      return;
    }
    setError(null);
    setOkMsg(null);
    // Frontend validation first
    const v = _validateBudgetInput(budgetInput);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    if (!slug) {
      setError('MISSING_SLUG');
      return;
    }
    setBusy(true);
    try {
      const r = await bridge.set({ slug, budgetUSD: v.value });
      if (!r || !r.ok) {
        const code = (r && typeof r.error === 'string') ? r.error : 'EXCEPTION';
        setError(code);
        return;
      }
      setOkMsg(`本月上限设为 ${_fmtUSD(v.value)}`);
      setEditing(false);
      // Re-hydrate to get fresh status
      await hydrate();
    } catch (_) {
      setError('EXCEPTION');
    } finally {
      setBusy(false);
    }
  }, [busy, slug, budgetInput, hydrate]);

  const stateInfo = useMemo(() => {
    if (!status) return STATE_COPY_CN['no-budget'];
    return STATE_COPY_CN[status.state] || STATE_COPY_CN['no-budget'];
  }, [status]);

  const percent = useMemo(() => {
    if (!status || !Number.isFinite(status.percentUsed)) return 0;
    return status.percentUsed;
  }, [status]);

  const barWidthPct = useMemo(() => {
    if (!status) return 0;
    if (status.state === 'no-budget') return 0;
    const p = Number.isFinite(status.percentUsed) ? status.percentUsed : 0;
    return Math.min(p, 100);
  }, [status]);

  const barColor = useMemo(() => {
    if (!status) return 'var(--ink-3, #8b8275)';
    if (status.state === 'over-100' || status.state === 'over-110') {
      return 'var(--accent-oxblood, #8B3A3A)';
    }
    return 'var(--accent-brass, #b08a3e)';
  }, [status]);

  const hasBudget = status && status.state !== 'no-budget' && Number.isFinite(status.budgetUSD) && status.budgetUSD > 0;

  if (!hydrated) return null;

  return (
    <div
      className="cost-budget-card"
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
      {/* Eyebrow */}
      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        marginBottom: 14,
      }}>
        <div style={EYEBROW_STYLE}>cost budget · 本月花了多少</div>
        {typeof onClose === 'function' && (
          <button
            type="button"
            onClick={onClose}
            style={{
              ...BRASS_BUTTON_STYLE,
              fontSize: 11,
              padding: '2px 10px',
            }}
          >
            收起
          </button>
        )}
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
          未连接 — cost budget 后端桥接尚未就绪。
        </div>
      )}

      {bridgeOk && (
        <>
          {/* Status block */}
          <div style={{ marginBottom: 18 }}>
            {/* Big number */}
            <div style={{ marginBottom: 12 }}>
              <span style={BIG_NUMBER_STYLE}>
                {hasBudget ? _fmtUSD(status.spentUSD) : _fmtUSD(status ? status.spentUSD : 0)}
              </span>
              {hasBudget && (
                <span style={BIG_NUMBER_TRAIL_STYLE}>
                  / {_fmtUSD(status.budgetUSD)}
                </span>
              )}
            </div>

            {/* Progress bar (only when budget set) */}
            {hasBudget && (
              <div style={{
                width: '100%',
                height: 4,
                background: 'var(--ink-3, #8b8275)',
                opacity: 0.25,
                marginBottom: 6,
                position: 'relative',
              }}>
                <div style={{
                  width: `${barWidthPct}%`,
                  height: '100%',
                  background: barColor,
                  opacity: 0.85,
                  transition: 'width 240ms ease',
                }} />
              </div>
            )}

            {/* State editorial line */}
            <div style={{
              fontFamily: SERIF_FONT,
              fontStyle: 'italic',
              fontSize: 14,
              color: _toneColor(stateInfo.tone),
              marginTop: hasBudget ? 4 : 8,
              marginBottom: 12,
            }}>
              {stateInfo.text}
            </div>

            {/* Numeric editorial lines */}
            {status && (
              <div>
                <div style={NUMERIC_LINE_STYLE}>
                  本月调用 {_fmtInt(status.callCount)} 次
                </div>
                {hasBudget && (
                  <div style={NUMERIC_LINE_STYLE}>
                    余额 {_fmtUSD(status.remainingUSD)}
                  </div>
                )}
                {hasBudget && (
                  <div style={NUMERIC_LINE_STYLE}>
                    占用率 {percent}%
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Budget setting block */}
          <div style={{
            borderTop: '1px solid var(--rule-soft, #e3dccd)',
            paddingTop: 14,
            marginBottom: 18,
          }}>
            <div style={SECTION_HEADER_STYLE}>
              {hasBudget ? '本月上限' : '设定本月上限'}
            </div>

            {hasBudget && !editing && (
              <div style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 14,
                flexWrap: 'wrap',
              }}>
                <div style={{
                  fontFamily: SERIF_FONT,
                  fontStyle: 'italic',
                  fontSize: 16,
                  color: 'var(--ink-1, #2c2620)',
                }}>
                  {_fmtUSD(status.budgetUSD)} / 月
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(true);
                    setError(null);
                    setOkMsg(null);
                  }}
                  style={{
                    ...BRASS_BUTTON_STYLE,
                    fontSize: 11,
                    padding: '3px 12px',
                  }}
                >
                  更改 ↻
                </button>
              </div>
            )}

            {(!hasBudget || editing) && (
              <div>
                {!hasBudget && (
                  <div style={{
                    fontFamily: SERIF_FONT,
                    fontStyle: 'italic',
                    fontSize: 13,
                    color: 'var(--ink-3, #8b8275)',
                    marginBottom: 10,
                  }}>
                    给这门课设个月度上限, 烧到 90% 会提醒。
                  </div>
                )}
                <div style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 10,
                  flexWrap: 'wrap',
                }}>
                  <span style={{
                    fontFamily: SERIF_FONT,
                    fontStyle: 'italic',
                    fontSize: 14,
                    color: 'var(--ink-2, #5a5246)',
                  }}>
                    $
                  </span>
                  <input
                    type="number"
                    step="1"
                    min={MIN_BUDGET_USD}
                    max={MAX_BUDGET_USD}
                    value={budgetInput}
                    onChange={(e) => setBudgetInput(e.target.value)}
                    placeholder="50"
                    disabled={busy}
                    style={INPUT_STYLE}
                  />
                  <button
                    type="button"
                    onClick={handleSet}
                    disabled={busy || !budgetInput.trim()}
                    style={{
                      ...BRASS_BUTTON_STYLE,
                      opacity: (busy || !budgetInput.trim()) ? 0.5 : 1,
                      cursor: (busy || !budgetInput.trim()) ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {busy ? '写入…' : (hasBudget ? '更新' : '设定本月上限 $')}
                  </button>
                  {editing && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(false);
                        setError(null);
                        setOkMsg(null);
                        if (status && Number.isFinite(status.budgetUSD)) {
                          setBudgetInput(String(status.budgetUSD));
                        }
                      }}
                      disabled={busy}
                      style={{
                        ...BRASS_BUTTON_STYLE,
                        fontSize: 11,
                        padding: '3px 10px',
                        borderColor: 'var(--ink-3, #8b8275)',
                        color: 'var(--ink-3, #8b8275)',
                      }}
                    >
                      取消
                    </button>
                  )}
                </div>
              </div>
            )}

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
                color: 'var(--accent-oxblood, #8B3A3A)',
              }}>
                {ERROR_COPY_CN[error] || ERROR_COPY_CN.EXCEPTION}
              </div>
            )}
          </div>

          {/* History block */}
          <div style={{
            borderTop: '1px solid var(--rule-soft, #e3dccd)',
            paddingTop: 14,
          }}>
            <div style={SECTION_HEADER_STYLE}>
              历史 · 近 {HISTORY_LIMIT} 月
            </div>
            <HistoryBar rows={history} />
          </div>
        </>
      )}
    </div>
  );
};

if (typeof window !== 'undefined') {
  window.CostBudgetCard = CostBudgetCard;
}
