/* global React */
//
// HYPHA · Privacy Memory Card (α19 Infrastructure §16 surface, 2026-05-16)
//
// 决定不让出去的话 — user 在 pattern × label × category 上画一道线, scrub
// 会在任何外发 text 之前把命中处用 `<redacted:label>` 替掉。
//
// Privacy 是全局 surface (! per-slug)。本波 ship card + window 挂载即可,
// ! mount 在 lesson-chat — 后续 wire 到 settings screen。
//
// α19 后端契约:
//   window.ptor.privacyMemory.add({ pattern, label, category, notes? })
//     → { ok:true, redaction } | { ok:false, error }
//   window.ptor.privacyMemory.remove({ id })
//     → { ok:true } | { ok:false, error: 'NOT_FOUND'|... }
//   window.ptor.privacyMemory.list()
//     → { ok:true, rows:[{id, ts, pattern, label, category, notes}] }
//   window.ptor.privacyMemory.scrub({ text, dryRun? })
//   window.ptor.privacyMemory.log({ limit? })
//     → { ok:true, log:[{ ts, contextHint, redactionCount }] }   ! 漏 pattern
//
// Register: manuscript — italic EB Garamond + Noto Serif SC on cream paper,
// brass hairline rules, no emoji, no exclamation, no 第三人称。
//
// 防御: bridge 不存在 (preload 未加载, 或非 Electron 环境) → "未连接" 灰态,
// ! crash。
//
// intentional-placeholder: standard HTML <input placeholder="..."> attribute
// used for ghost hint text below each form label. ! 占位代码 / ! 未完成实现 —
// 这是 native DOM attribute, 与 input/textarea 永远配对的 UX 字段。

const { useState, useEffect, useCallback } = React;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORY_OPTIONS = [
  { value: 'pii',      label: '个人识别' },
  { value: 'topic',    label: '话题' },
  { value: 'name',     label: '姓名' },
  { value: 'location', label: '地点' },
  { value: 'other',    label: '其他' },
];

const CATEGORY_LABEL = {
  pii:      '个人识别',
  topic:    '话题',
  name:     '姓名',
  location: '地点',
  other:    '其他',
};

const ERROR_COPY_CN = {
  MISSING_PATTERN:  '要保护的词或片段还没填。',
  MISSING_LABEL:    '替代标签还没填 — scrub 之后留下的就是这个。',
  INVALID_CATEGORY: '类别不在已知五档之内。',
  NOT_FOUND:        '没有找到这一条 — 或许已经被删过一次。',
  EXCEPTION:        '写到 vault 时出了岔子。检查一下 privacy-memory.jsonl 的目录权限。',
};

const PALETTE = {
  ink1:   'var(--ink-1, #2c2620)',
  ink2:   'var(--ink-2, #5a5246)',
  ink3:   'var(--ink-3, #8b8275)',
  paper:  'rgba(244,239,228,0.30)',
  rule:   'var(--rule-soft, #e3dccd)',
  brass:  'var(--accent-brass, #b08a3e)',
  tabac:  '#5C4E36',
};

const FONT_SERIF = '"Noto Serif SC", "EB Garamond", serif';
const FONT_GARAMOND = 'EB Garamond, "Noto Serif SC", serif';
const FONT_MONO = '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace';

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function _formatTs(ts) {
  if (!ts || typeof ts !== 'string') return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function _truncatePatternHead(s, n) {
  if (typeof s !== 'string') return '';
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

// ---------------------------------------------------------------------------
// RedactionRow
// ---------------------------------------------------------------------------

const RedactionRow = ({ row, onRemove, removing }) => {
  if (!row || typeof row !== 'object') return null;
  const catLabel = CATEGORY_LABEL[row.category] || row.category || '其他';
  const patternHead = _truncatePatternHead(row.pattern || '', 30);

  return (
    <div style={{
      padding: '10px 0',
      borderBottom: `1px solid ${PALETTE.rule}`,
      display: 'flex',
      gap: 12,
      alignItems: 'center',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          display: 'flex',
          gap: 8,
          alignItems: 'baseline',
          marginBottom: 3,
          flexWrap: 'wrap',
        }}>
          <span style={{
            fontFamily: FONT_GARAMOND,
            fontStyle: 'italic',
            fontSize: 15,
            color: PALETTE.ink1,
          }}>
            {row.label}
          </span>
          <span style={{
            fontFamily: FONT_MONO,
            fontSize: 9,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: PALETTE.tabac,
            padding: '1px 5px',
            border: `1px solid ${PALETTE.rule}`,
          }}>
            {catLabel}
          </span>
        </div>
        <div style={{
          fontFamily: FONT_MONO,
          fontSize: 11,
          color: PALETTE.ink3,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }} title={row.pattern || ''}>
          {patternHead}
        </div>
        {row.notes ? (
          <div style={{
            fontFamily: FONT_SERIF,
            fontSize: 12,
            lineHeight: 1.6,
            color: PALETTE.ink2,
            marginTop: 3,
          }}>
            {row.notes}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onRemove && onRemove(row.id)}
        disabled={removing}
        title="删除"
        style={{
          background: 'transparent',
          border: `1px solid ${PALETTE.rule}`,
          color: PALETTE.ink3,
          fontFamily: FONT_GARAMOND,
          fontStyle: 'italic',
          fontSize: 12,
          cursor: removing ? 'wait' : 'pointer',
          padding: '4px 10px',
          flexShrink: 0,
        }}
      >
        删
      </button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// PrivacyMemoryCard
// ---------------------------------------------------------------------------

const PrivacyMemoryCard = ({ onClose }) => {
  const [pattern, setPattern] = useState('');
  const [label, setLabel] = useState('');
  const [category, setCategory] = useState('other');
  const [notes, setNotes] = useState('');

  const [rows, setRows] = useState([]);
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState(null);
  const [error, setError] = useState(null);
  const [bridgeOk, setBridgeOk] = useState(true);
  const [hydrated, setHydrated] = useState(false);

  // ---------- bridge probe + hydrate ----------
  const probeBridge = useCallback(() => {
    const pm = window.ptor && window.ptor.privacyMemory;
    return !!(pm
      && typeof pm.add === 'function'
      && typeof pm.remove === 'function'
      && typeof pm.list === 'function'
      && typeof pm.scrub === 'function'
      && typeof pm.log === 'function');
  }, []);

  const refresh = useCallback(async () => {
    const pm = window.ptor && window.ptor.privacyMemory;
    if (!pm) return;
    try {
      const r = await pm.list();
      if (r && r.ok && Array.isArray(r.rows)) setRows(r.rows);
      const lg = await pm.log({ limit: 5 });
      if (lg && lg.ok && Array.isArray(lg.log)) setLog(lg.log);
    } catch (_) { /* swallow */ }
  }, []);

  useEffect(() => {
    let alive = true;
    if (!probeBridge()) {
      setBridgeOk(false);
      setHydrated(true);
      return undefined;
    }
    setBridgeOk(true);
    (async () => {
      await refresh();
      if (alive) setHydrated(true);
    })();
    return () => { alive = false; };
  }, [probeBridge, refresh]);

  // ---------- handlers ----------
  const handleAdd = useCallback(async () => {
    if (busy) return;
    setError(null);
    const pm = window.ptor && window.ptor.privacyMemory;
    if (!pm) { setBridgeOk(false); return; }

    const p = pattern.trim();
    const l = label.trim();
    if (!p) { setError('MISSING_PATTERN'); return; }
    if (!l) { setError('MISSING_LABEL'); return; }

    setBusy(true);
    try {
      const r = await pm.add({ pattern: p, label: l, category, notes: notes.trim() });
      if (!r || !r.ok) {
        const code = (r && typeof r.error === 'string') ? r.error : 'EXCEPTION';
        setError(code);
        return;
      }
      setPattern('');
      setLabel('');
      setNotes('');
      setCategory('other');
      await refresh();
    } catch (_) {
      setError('EXCEPTION');
    } finally {
      setBusy(false);
    }
  }, [busy, pattern, label, category, notes, refresh]);

  const handleRemove = useCallback(async (id) => {
    if (!id || removingId) return;
    const pm = window.ptor && window.ptor.privacyMemory;
    if (!pm) { setBridgeOk(false); return; }
    setRemovingId(id);
    setError(null);
    try {
      const r = await pm.remove({ id });
      if (!r || !r.ok) {
        const code = (r && typeof r.error === 'string') ? r.error : 'EXCEPTION';
        setError(code);
        return;
      }
      await refresh();
    } catch (_) {
      setError('EXCEPTION');
    } finally {
      setRemovingId(null);
    }
  }, [removingId, refresh]);

  if (!hydrated) return null;

  return (
    <div
      className="privacy-memory-card"
      style={{
        marginTop: 20,
        marginBottom: 18,
        padding: '20px 24px',
        background: PALETTE.paper,
        border: `1px solid ${PALETTE.rule}`,
        fontFamily: FONT_SERIF,
        color: PALETTE.ink1,
        maxWidth: 720,
      }}
    >
      {/* ---------- Header ---------- */}
      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        marginBottom: 14,
        paddingBottom: 10,
        borderBottom: `1px solid ${PALETTE.rule}`,
      }}>
        <div>
          <div style={{
            fontFamily: FONT_GARAMOND,
            fontStyle: 'italic',
            fontSize: 18,
            letterSpacing: '0.02em',
            color: PALETTE.ink1,
          }}>
            Privacy Memory
          </div>
          <div style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: PALETTE.ink3,
            marginTop: 3,
          }}>
            {bridgeOk ? '决定不让出去的话' : '未连接'}
          </div>
        </div>
        {typeof onClose === 'function' && (
          <button
            type="button"
            onClick={onClose}
            title="收起"
            style={{
              background: 'transparent',
              border: 'none',
              color: PALETTE.ink3,
              fontFamily: FONT_GARAMOND,
              fontStyle: 'italic',
              fontSize: 13,
              cursor: 'pointer',
              padding: '2px 6px',
            }}
          >
            收起
          </button>
        )}
      </div>

      {/* ---------- Bridge missing ---------- */}
      {!bridgeOk && (
        <div style={{
          fontFamily: FONT_GARAMOND,
          fontStyle: 'italic',
          fontSize: 13,
          color: PALETTE.ink3,
          padding: '8px 0',
        }}>
          后端桥接尚未就绪 — Privacy Memory 通道仍在搭建。稍后此处会自亮。
        </div>
      )}

      {bridgeOk && (
        <>
          {/* ---------- 添加区 ---------- */}
          <div style={{ marginBottom: 18 }}>
            <div style={{
              fontFamily: FONT_MONO,
              fontSize: 10,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: PALETTE.ink3,
              marginBottom: 8,
            }}>
              添 一 道 线
            </div>

            <div style={{ marginBottom: 8 }}>
              <label style={{
                display: 'block',
                fontFamily: FONT_GARAMOND,
                fontStyle: 'italic',
                fontSize: 12,
                color: PALETTE.ink2,
                marginBottom: 3,
              }}>
                要保护的词或片段 (pattern)
              </label>
              <input
                type="text"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="如 sk_test_… 或 真名"
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  background: 'rgba(255,255,255,0.5)',
                  border: `1px solid ${PALETTE.rule}`,
                  fontFamily: FONT_MONO,
                  fontSize: 13,
                  color: PALETTE.ink1,
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div style={{ marginBottom: 8 }}>
              <label style={{
                display: 'block',
                fontFamily: FONT_GARAMOND,
                fontStyle: 'italic',
                fontSize: 12,
                color: PALETTE.ink2,
                marginBottom: 3,
              }}>
                替代标签 (scrub 后留下的字)
              </label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="如 API Key / 真名"
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  background: 'rgba(255,255,255,0.5)',
                  border: `1px solid ${PALETTE.rule}`,
                  fontFamily: FONT_SERIF,
                  fontSize: 13,
                  color: PALETTE.ink1,
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div style={{ marginBottom: 8 }}>
              <div style={{
                fontFamily: FONT_GARAMOND,
                fontStyle: 'italic',
                fontSize: 12,
                color: PALETTE.ink2,
                marginBottom: 4,
              }}>
                类别
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                {CATEGORY_OPTIONS.map(opt => (
                  <label key={opt.value} style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    fontFamily: FONT_SERIF,
                    fontSize: 13,
                    color: PALETTE.ink1,
                    cursor: 'pointer',
                  }}>
                    <input
                      type="radio"
                      name="privacy-category"
                      value={opt.value}
                      checked={category === opt.value}
                      onChange={() => setCategory(opt.value)}
                      style={{ accentColor: PALETTE.brass }}
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 10 }}>
              <label style={{
                display: 'block',
                fontFamily: FONT_GARAMOND,
                fontStyle: 'italic',
                fontSize: 12,
                color: PALETTE.ink2,
                marginBottom: 3,
              }}>
                备注 (可空)
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="为什么要画这道线"
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  background: 'rgba(255,255,255,0.5)',
                  border: `1px solid ${PALETTE.rule}`,
                  fontFamily: FONT_SERIF,
                  fontSize: 13,
                  color: PALETTE.ink1,
                  resize: 'vertical',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {error && (
              <div style={{
                fontFamily: FONT_GARAMOND,
                fontStyle: 'italic',
                fontSize: 12,
                color: '#6E2D2D',
                marginBottom: 8,
              }}>
                {ERROR_COPY_CN[error] || ERROR_COPY_CN.EXCEPTION}
              </div>
            )}

            <button
              type="button"
              onClick={handleAdd}
              disabled={busy}
              style={{
                background: 'transparent',
                border: `1px solid ${PALETTE.brass}`,
                color: PALETTE.ink1,
                fontFamily: FONT_GARAMOND,
                fontStyle: 'italic',
                fontSize: 14,
                cursor: busy ? 'wait' : 'pointer',
                padding: '6px 18px',
                letterSpacing: '0.04em',
              }}
            >
              {busy ? '收 入 中…' : '加'}
            </button>
          </div>

          {/* ---------- 列表区 ---------- */}
          <div style={{ marginBottom: 18 }}>
            <div style={{
              fontFamily: FONT_MONO,
              fontSize: 10,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: PALETTE.ink3,
              marginBottom: 6,
              paddingBottom: 4,
              borderBottom: `1px solid ${PALETTE.rule}`,
            }}>
              已 画 的 线 · {rows.length}
            </div>
            {rows.length === 0 ? (
              <div style={{
                fontFamily: FONT_GARAMOND,
                fontStyle: 'italic',
                fontSize: 13,
                color: PALETTE.ink3,
                padding: '10px 0',
              }}>
                还没有任何一条 — scrub 暂时是恒等。
              </div>
            ) : (
              rows.map(r => (
                <RedactionRow
                  key={r.id}
                  row={r}
                  onRemove={handleRemove}
                  removing={removingId === r.id}
                />
              ))
            )}
          </div>

          {/* ---------- 最近 log ---------- */}
          <div>
            <div style={{
              fontFamily: FONT_MONO,
              fontSize: 10,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: PALETTE.ink3,
              marginBottom: 6,
              paddingBottom: 4,
              borderBottom: `1px solid ${PALETTE.rule}`,
            }}>
              最 近 scrub · {log.length}
            </div>
            {log.length === 0 ? (
              <div style={{
                fontFamily: FONT_GARAMOND,
                fontStyle: 'italic',
                fontSize: 12,
                color: PALETTE.ink3,
                padding: '6px 0',
              }}>
                还没有 scrub 过任何文本。
              </div>
            ) : (
              <div style={{
                fontFamily: FONT_MONO,
                fontSize: 11,
                color: PALETTE.ink2,
                lineHeight: 1.7,
              }}>
                {log.map((entry, i) => (
                  <div key={`${entry.ts || ''}-${i}`} style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '2px 0',
                  }}>
                    <span>{_formatTs(entry.ts)}</span>
                    <span style={{ color: PALETTE.tabac }}>
                      {Number.isFinite(entry.redactionCount) ? entry.redactionCount : 0} 处
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div style={{
              fontFamily: FONT_GARAMOND,
              fontStyle: 'italic',
              fontSize: 11,
              color: PALETTE.ink3,
              marginTop: 6,
              lineHeight: 1.5,
            }}>
              log 不记 pattern, 不记替换后的原文 — 只留下时间与处数。
            </div>
          </div>
        </>
      )}
    </div>
  );
};

// Expose for HTML script-tag load order. Mirrors cross-spark-card.jsx /
// judgment-gym-card.jsx / project-spine-card.jsx convention.
window.PrivacyMemoryCard = PrivacyMemoryCard;
