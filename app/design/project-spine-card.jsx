/* global React */
//
// HYPHA · α16 Project Spine Card (Growth System §28 子组件 v0, 2026-05-16)
//
// 跨课程持续追踪的"项目骨架"事件流。Lesson footer 区域的记录工具 — user-driven,
// 非 LLM-derived。bridge 不存在 (preload 未挂) → 显 "未连接" 灰态, 不 crash。
//
// 5 kind:
//   decision      决定
//   hypothesis    假设
//   open-question 悬而未决
//   building-on   承接
//   revisit-later 缓期
//
// 桥接契约:
//   window.ptor.projectSpine.add({ slug, kind, content, sourceLessonIdx, sourceLessonTitle, tags })
//     → { ok:true, entry } | { ok:false, error: 'INVALID_KIND'|'TOO_LONG'|'EMPTY_CONTENT'|'EXCEPTION' }
//   window.ptor.projectSpine.list({ slug, limit })
//     → { ok:true, entries:[{ id, ts, kind, content, sourceLessonIdx, sourceLessonTitle, tags, tombstone }] }
//
// Register: manuscript — italic Garamond + Noto Serif SC, brass hairlines,
// paper-warm wash, no emoji, no exclamation, no 第三人称。

const { useState, useEffect, useCallback } = React;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KIND_DEFS = Object.freeze([
  { id: 'decision',      label: '决定'      },
  { id: 'hypothesis',    label: '假设'      },
  { id: 'open-question', label: '悬而未决'  },
  { id: 'building-on',   label: '承接'      },
  { id: 'revisit-later', label: '缓期'      },
]);

const KIND_LABEL = Object.freeze(KIND_DEFS.reduce((acc, k) => {
  acc[k.id] = k.label;
  return acc;
}, {}));

const ERROR_COPY_CN = {
  INVALID_KIND:  '这一类未被认作脊柱事件。',
  TOO_LONG:      '这一条太长 — 控制在 2000 字以内。',
  EMPTY_CONTENT: '内容是空的 — 先写一行。',
  EXCEPTION:     '写入出了岔子。检查 vault 或再试。',
};

const MAX_CONTENT_LEN = 2000;
const VISIBLE_LIMIT = 5;

// ---------------------------------------------------------------------------
// SpineRow
// ---------------------------------------------------------------------------

const SpineRow = ({ entry }) => {
  if (!entry || typeof entry !== 'object') return null;
  const kindLbl = KIND_LABEL[entry.kind] || entry.kind || '';
  const sourceLbl = (typeof entry.sourceLessonIdx === 'number'
                     && typeof entry.sourceLessonTitle === 'string'
                     && entry.sourceLessonTitle.trim())
    ? `L${entry.sourceLessonIdx} · ${entry.sourceLessonTitle.trim()}`
    : (typeof entry.sourceLessonIdx === 'number' ? `L${entry.sourceLessonIdx}` : '');

  return (
    <div style={{
      padding: '10px 0',
      borderBottom: '1px solid var(--rule-soft, #e3dccd)',
      display: 'flex',
      gap: 12,
      alignItems: 'flex-start',
    }}>
      <div style={{
        fontFamily: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
        fontSize: 9,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: 'var(--ink-3, #8b8275)',
        flexShrink: 0,
        minWidth: 60,
        paddingTop: 3,
      }}>
        {kindLbl}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
          fontStyle: 'italic',
          fontSize: 14,
          lineHeight: 1.55,
          color: 'var(--ink-1, #2c2620)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          {entry.content}
        </div>
        {sourceLbl && (
          <div style={{
            marginTop: 4,
            fontFamily: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
            fontSize: 9,
            letterSpacing: '0.12em',
            color: 'var(--ink-3, #8b8275)',
          }}>
            {sourceLbl}
          </div>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// ProjectSpineCard
// ---------------------------------------------------------------------------

const ProjectSpineCard = ({ slug, currentLessonIdx, currentLessonTitle, onClose }) => {
  const [entries, setEntries] = useState([]);
  const [hydrated, setHydrated] = useState(false);
  const [bridgeOk, setBridgeOk] = useState(true);
  const [kind, setKind] = useState('hypothesis');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const hydrateSpine = useCallback(async () => {
    const ps = window.ptor && window.ptor.projectSpine;
    if (!ps || typeof ps.list !== 'function') {
      setBridgeOk(false);
      setHydrated(true);
      return;
    }
    setBridgeOk(true);
    if (!slug) { setHydrated(true); return; }
    try {
      const r = await ps.list({ slug, limit: VISIBLE_LIMIT });
      if (r && r.ok && Array.isArray(r.entries)) {
        setEntries(r.entries);
      } else {
        setEntries([]);
      }
    } catch (_) {
      setEntries([]);
    } finally {
      setHydrated(true);
    }
  }, [slug]);

  useEffect(() => {
    let alive = true;
    (async () => {
      await hydrateSpine();
      if (!alive) return;
    })();
    return () => { alive = false; };
  }, [hydrateSpine]);

  const handleAdd = useCallback(async () => {
    if (busy) return;
    const ps = window.ptor && window.ptor.projectSpine;
    if (!ps || typeof ps.add !== 'function') {
      setBridgeOk(false);
      return;
    }
    const trimmed = (draft || '').trim();
    if (!trimmed) {
      setError('EMPTY_CONTENT');
      return;
    }
    if (!slug) {
      setError('EXCEPTION');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        slug,
        kind,
        content: trimmed,
        sourceLessonIdx: (typeof currentLessonIdx === 'number' && Number.isFinite(currentLessonIdx))
          ? currentLessonIdx
          : null,
        sourceLessonTitle: (typeof currentLessonTitle === 'string' && currentLessonTitle.trim())
          ? currentLessonTitle.trim()
          : null,
        tags: [],
      };
      const r = await ps.add(payload);
      if (!r || !r.ok) {
        const code = (r && typeof r.error === 'string') ? r.error : 'EXCEPTION';
        setError(code);
        return;
      }
      setDraft('');
      await hydrateSpine();
    } catch (err) {
      setError('EXCEPTION');
    } finally {
      setBusy(false);
    }
  }, [busy, draft, kind, slug, currentLessonIdx, currentLessonTitle, hydrateSpine]);

  if (!hydrated) return null;

  const charsLeft = MAX_CONTENT_LEN - (draft || '').length;
  const addDisabled = busy || !slug || !(draft || '').trim() || charsLeft < 0;

  return (
    <div
      className="project-spine-card"
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
            fontFamily: 'EB Garamond, "Noto Serif SC", serif',
            fontStyle: 'italic',
            fontSize: 17,
            letterSpacing: '0.02em',
            color: 'var(--ink-1, #2c2620)',
          }}>
            项目脊柱
          </div>
          <div style={{
            fontFamily: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
            fontSize: 10,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: 'var(--ink-3, #8b8275)',
            marginTop: 2,
          }}>
            {bridgeOk ? '这次学习的骨架' : '未连接'}
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
              color: 'var(--ink-3, #8b8275)',
              fontFamily: 'EB Garamond, serif',
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

      {/* Bridge missing — gray state */}
      {!bridgeOk && (
        <div style={{
          fontFamily: 'EB Garamond, serif',
          fontStyle: 'italic',
          fontSize: 13,
          color: 'var(--ink-3, #8b8275)',
          padding: '8px 0',
        }}>
          后端桥接尚未就绪 — 脊柱通道仍在搭建。稍后此处会自亮。
        </div>
      )}

      {/* Bridge OK — list + composer */}
      {bridgeOk && (
        <>
          {/* Entries list */}
          {entries.length === 0 && (
            <div style={{
              fontFamily: 'EB Garamond, serif',
              fontStyle: 'italic',
              fontSize: 13,
              color: 'var(--ink-3, #8b8275)',
              padding: '8px 0',
            }}>
              脊柱尚空。学的每一段都会有: 决定 / 假设 / 悬而未决 / 承接 / 缓期。
              先记下一条, 让骨架显形。
            </div>
          )}
          {entries.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              {entries.map((e, i) => (
                <SpineRow key={(e && e.id) ? e.id : `e-${i}`} entry={e} />
              ))}
            </div>
          )}

          {/* Composer */}
          <div style={{ paddingTop: 6 }}>
            {/* Kind radio row */}
            <div style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              marginBottom: 10,
            }}>
              {KIND_DEFS.map(k => {
                const active = kind === k.id;
                return (
                  <button
                    key={k.id}
                    type="button"
                    onClick={() => setKind(k.id)}
                    style={{
                      fontFamily: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
                      fontSize: 10,
                      letterSpacing: '0.14em',
                      textTransform: 'uppercase',
                      padding: '4px 10px',
                      background: active ? 'rgba(176,138,62,0.10)' : 'transparent',
                      border: active
                        ? '1px solid var(--accent-brass, #b08a3e)'
                        : '1px solid var(--rule-soft, #e3dccd)',
                      color: active
                        ? 'var(--accent-brass, #b08a3e)'
                        : 'var(--ink-2, #5a5246)',
                      cursor: 'pointer',
                    }}
                  >
                    {k.label}
                  </button>
                );
              })}
            </div>

            {/* Textarea */}
            {/* intentional-placeholder: HTML attribute `placeholder` is the
                native React textarea hint, not a code-placeholder marker. */}
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={`写下一条 ${KIND_LABEL[kind] || ''} — 这次学习的骨架会留下它。`}
              rows={3}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                fontFamily: 'EB Garamond, "Noto Serif SC", serif',
                fontStyle: 'italic',
                fontSize: 13,
                lineHeight: 1.55,
                color: 'var(--ink-1, #2c2620)',
                background: 'rgba(252,250,244,0.7)',
                border: '1px solid var(--rule-soft, #e3dccd)',
                padding: '8px 10px',
                resize: 'vertical',
                outline: 'none',
              }}
            />

            {/* Footer row: chars + add */}
            <div style={{
              marginTop: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}>
              <div style={{
                fontFamily: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
                fontSize: 10,
                letterSpacing: '0.10em',
                color: charsLeft < 0 ? '#8B3A3A' : 'var(--ink-3, #8b8275)',
              }}>
                {charsLeft}
              </div>
              <button
                type="button"
                onClick={handleAdd}
                disabled={addDisabled}
                style={{
                  fontFamily: 'EB Garamond, serif',
                  fontStyle: 'italic',
                  fontSize: 13,
                  padding: '6px 18px',
                  background: 'transparent',
                  border: '1px solid var(--accent-brass, #b08a3e)',
                  color: 'var(--accent-brass, #b08a3e)',
                  cursor: addDisabled ? 'not-allowed' : 'pointer',
                  opacity: addDisabled ? 0.5 : 1,
                  letterSpacing: '0.02em',
                }}
              >
                {busy ? '记入…' : '添加'}
              </button>
            </div>

            {/* Error */}
            {error && (
              <div style={{
                marginTop: 8,
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
  window.ProjectSpineCard = ProjectSpineCard;
}
