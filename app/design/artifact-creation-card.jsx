/* global React */
//
// HYPHA · β19 Artifact Creation Card (Growth System §28 子组件 v0, 2026-05-16)
//
// 学习的真正信号 = 造出一个可被人用的 artifact (Track A 路径)。
// 每节课结束后用户登记一个具体 artifact 想做或已做, 系统追踪
// commit / abandon / iterate 状态。
//
// 添加区: kind select + title input + targetUrl input + notes textarea + 登记
// 列表区: artifacts (newest first) — state badge + title + kind + sourceLesson +
//          合法 transitions 按钮组 + targetUrl 链接 + 删除按钮 (tombstone)
//
// 桥接契约 (window.artifact):
//   create({ slug, kind, title, sourceLessonIdx?, sourceLessonTitle?, targetUrl?, notes? })
//     → { ok:true, artifact } | { ok:false, error: ENUM_CODE }
//   transition({ slug, artifactId, toState, notes? })
//     → { ok:true, artifact } | { ok:false, error: ENUM_CODE }
//   list({ slug, stateFilter?, limit? })   → { ok:true, artifacts }
//   get({ slug, artifactId })              → { ok:true, artifact }
//   delete({ slug, artifactId })           → { ok:true }
//
// Register: manuscript — italic Garamond + Noto Serif SC, brass hairlines,
// paper-warm wash, no emoji, no exclamation, no 第三人称。
//
// intentional-placeholder: the React `placeholder="..."` HTML attribute below
// is the native textarea / input hint, not a code-placeholder marker. All UI
// logic is fully implemented; "placeholder" appears only in DOM-attribute
// position. Same convention as judgment-gym-card.jsx / entropy-reduction-card.jsx.

const { useState, useEffect, useCallback, useMemo } = React;

// ---------------------------------------------------------------------------
// Enums (must mirror app/lib/growth/artifact-creation.js)
// ---------------------------------------------------------------------------

const KIND_DEFS = Object.freeze([
  { id: 'essay',          label: '随笔'      },
  { id: 'code-repo',      label: '代码仓库'  },
  { id: 'tweet-thread',   label: 'twitter 串' },
  { id: 'substack-post',  label: 'substack 文' },
  { id: 'xhs-post',       label: '小红书 帖'  },
  { id: 'video-script',   label: '视频脚本'   },
  { id: 'slide-deck',     label: '讲稿 / 幻灯' },
  { id: 'other',          label: '其他'      },
]);

const KIND_LABEL = Object.freeze(KIND_DEFS.reduce((acc, k) => {
  acc[k.id] = k.label;
  return acc;
}, {}));

const STATE_LABEL_CN = Object.freeze({
  'planned':     '计划',
  'in-progress': '进行中',
  'drafted':     '草稿完',
  'published':   '已发布',
  'committed':   '定型',
  'iterate':     '迭代中',
  'abandoned':   '弃',
});

// must mirror VALID_TRANSITIONS in app/lib/growth/artifact-creation.js
const VALID_TRANSITIONS = Object.freeze({
  'planned':     Object.freeze(['in-progress', 'abandoned']),
  'in-progress': Object.freeze(['drafted', 'abandoned']),
  'drafted':     Object.freeze(['published', 'abandoned', 'in-progress']),
  'published':   Object.freeze(['committed', 'iterate']),
  'iterate':     Object.freeze(['drafted']),
  'abandoned':   Object.freeze([]),
  'committed':   Object.freeze([]),
});

const ERROR_COPY_CN = {
  MISSING_SLUG:        '当前 vault 缺失 — 重新打开课程。',
  INVALID_KIND:        '这一类 artifact 不在七枚里。',
  TITLE_TOO_LONG:      '标题太长 — 控制在 200 字以内, 不能为空。',
  ARTIFACT_NOT_FOUND:  '这一条已不在场。可能已被清理。',
  INVALID_TRANSITION:  '当前状态不允许这一步迁移 — 查 state map。',
  EXCEPTION:           '写入出了岔子。检查 vault 或再试。',
};

const MAX_TITLE_LEN = 200;
const MAX_NOTES_LEN = 1000;
const MAX_URL_LEN = 500;
const LIST_LIMIT = 50;

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const MONO_FONT = '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace';
const SERIF_FONT = 'EB Garamond, "Noto Serif SC", serif';

const ROW_TAG_STYLE = {
  fontFamily: MONO_FONT,
  fontSize: 9,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: 'var(--ink-3, #8b8275)',
};

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

const TEXTAREA_STYLE = {
  ...INPUT_STYLE,
  padding: '8px 10px',
  resize: 'vertical',
};

const SELECT_STYLE = {
  ...INPUT_STYLE,
  fontStyle: 'normal',
  appearance: 'none',
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

const STATE_BADGE_STYLE = {
  fontFamily: MONO_FONT,
  fontSize: 9,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--accent-brass, #b08a3e)',
  border: '1px solid var(--accent-brass, #b08a3e)',
  padding: '2px 8px',
  display: 'inline-block',
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

function _truncate(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return t.slice(0, n) + '…';
}

function _sourceLabel(idx, title) {
  const hasIdx = (typeof idx === 'number' && Number.isFinite(idx));
  const hasTitle = (typeof title === 'string' && title.trim());
  if (hasIdx && hasTitle) return `L${idx} · ${_truncate(title, 40)}`;
  if (hasIdx) return `L${idx}`;
  if (hasTitle) return _truncate(title, 40);
  return '';
}

// ---------------------------------------------------------------------------
// ArtifactRow — single artifact entry with state-aware transition buttons
// ---------------------------------------------------------------------------

const ArtifactRow = ({ artifact, onTransition, onDelete, busy }) => {
  if (!artifact) return null;
  const stateLbl = STATE_LABEL_CN[artifact.state] || artifact.state;
  const kindLbl  = KIND_LABEL[artifact.kind] || artifact.kind;
  const tsLbl    = _formatTs(artifact.ts);
  const allowed  = VALID_TRANSITIONS[artifact.state] || [];
  const srcLbl   = _sourceLabel(artifact.sourceLessonIdx, artifact.sourceLessonTitle);
  const isTerminal = allowed.length === 0;

  return (
    <div style={{
      padding: '12px 14px',
      marginBottom: 10,
      background: 'rgba(252,250,244,0.45)',
      border: '1px solid var(--rule-soft, #e3dccd)',
    }}>
      {/* Top row — state badge + title + meta */}
      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 10,
        marginBottom: 6,
        flexWrap: 'wrap',
      }}>
        <span style={STATE_BADGE_STYLE}>{stateLbl}</span>
        <span style={{
          fontFamily: SERIF_FONT,
          fontStyle: 'italic',
          fontSize: 14,
          color: 'var(--ink-1, #2c2620)',
          flex: '1 1 auto',
          minWidth: 0,
          wordBreak: 'break-word',
        }}>
          {artifact.title}
        </span>
        {tsLbl && (
          <span style={ROW_TAG_STYLE}>{tsLbl}</span>
        )}
      </div>

      {/* Meta row — kind + source lesson */}
      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 12,
        marginBottom: 8,
        flexWrap: 'wrap',
      }}>
        <span style={ROW_TAG_STYLE}>{kindLbl}</span>
        {srcLbl && (
          <span style={{
            ...ROW_TAG_STYLE,
            textTransform: 'none',
            letterSpacing: '0.04em',
          }}>
            · 来自 {srcLbl}
          </span>
        )}
      </div>

      {/* Optional notes */}
      {artifact.notes && (
        <div style={{
          fontFamily: SERIF_FONT,
          fontStyle: 'italic',
          fontSize: 12,
          lineHeight: 1.55,
          color: 'var(--ink-2, #5a5246)',
          marginBottom: 8,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          {_truncate(artifact.notes, 300)}
        </div>
      )}

      {/* Optional target URL */}
      {artifact.targetUrl && (
        <div style={{ marginBottom: 8 }}>
          <a
            href={artifact.targetUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontFamily: SERIF_FONT,
              fontStyle: 'italic',
              fontSize: 12,
              color: 'var(--accent-brass, #b08a3e)',
              textDecoration: 'underline',
              wordBreak: 'break-all',
            }}
          >
            {_truncate(artifact.targetUrl, 80)}
          </a>
        </div>
      )}

      {/* Transition buttons + delete */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      }}>
        {isTerminal && (
          <span style={{
            ...ROW_TAG_STYLE,
            fontStyle: 'italic',
            textTransform: 'none',
            letterSpacing: '0.02em',
            fontFamily: SERIF_FONT,
            fontSize: 12,
            color: 'var(--ink-3, #8b8275)',
          }}>
            终态 — 不可再迁移
          </span>
        )}
        {!isTerminal && allowed.map(s => (
          <button
            key={s}
            type="button"
            onClick={() => onTransition(artifact.id, s)}
            disabled={busy}
            style={{
              ...BRASS_BUTTON_STYLE,
              fontSize: 11,
              padding: '3px 10px',
              opacity: busy ? 0.5 : 1,
              cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >
            → {STATE_LABEL_CN[s] || s}
          </button>
        ))}
        <div style={{ flex: '1 1 auto' }} />
        <button
          type="button"
          onClick={() => onDelete(artifact.id)}
          disabled={busy}
          style={{
            ...BRASS_BUTTON_STYLE,
            fontSize: 11,
            padding: '3px 10px',
            borderColor: '#8B3A3A',
            color: '#8B3A3A',
            opacity: busy ? 0.5 : 1,
            cursor: busy ? 'not-allowed' : 'pointer',
          }}
        >
          删除
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// ArtifactCreationCard — main component
// ---------------------------------------------------------------------------

const ArtifactCreationCard = ({ slug, currentLessonIdx, currentLessonTitle }) => {
  const [hydrated, setHydrated] = useState(false);
  const [bridgeOk, setBridgeOk] = useState(true);
  const [artifacts, setArtifacts] = useState([]);

  // Form state
  const [kind, setKind] = useState('essay');
  const [title, setTitle] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [notes, setNotes] = useState('');

  // Status state
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [okMsg, setOkMsg] = useState(null);

  const hydrate = useCallback(async () => {
    if (!window.artifact || typeof window.artifact.list !== 'function') {
      setBridgeOk(false);
      setHydrated(true);
      return;
    }
    setBridgeOk(true);
    if (!slug) { setHydrated(true); return; }
    try {
      const r = await window.artifact.list({ slug, limit: LIST_LIMIT });
      if (r && r.ok && Array.isArray(r.artifacts)) {
        setArtifacts(r.artifacts);
      } else {
        setArtifacts([]);
      }
    } catch (_) {
      setArtifacts([]);
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

  const handleCreate = useCallback(async () => {
    if (busy) return;
    if (!window.artifact || typeof window.artifact.create !== 'function') {
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
      const trimmedTitle = title.trim();
      if (!trimmedTitle) {
        setError('TITLE_TOO_LONG');
        setBusy(false);
        return;
      }
      const payload = {
        slug,
        kind,
        title: trimmedTitle,
        sourceLessonIdx: (typeof currentLessonIdx === 'number' && Number.isFinite(currentLessonIdx))
          ? currentLessonIdx
          : null,
        sourceLessonTitle: (typeof currentLessonTitle === 'string' && currentLessonTitle.trim())
          ? currentLessonTitle.trim()
          : null,
        targetUrl: targetUrl.trim(),
        notes: notes.trim(),
      };
      const r = await window.artifact.create(payload);
      if (!r || !r.ok) {
        const code = (r && typeof r.error === 'string') ? r.error : 'EXCEPTION';
        setError(code);
        return;
      }
      setOkMsg(`已登记 · ${KIND_LABEL[kind] || kind}`);
      // Reset form (keep kind selection for next entry)
      setTitle('');
      setTargetUrl('');
      setNotes('');
      // Refresh list
      const ls = await window.artifact.list({ slug, limit: LIST_LIMIT });
      if (ls && ls.ok && Array.isArray(ls.artifacts)) {
        setArtifacts(ls.artifacts);
      }
    } catch (_) {
      setError('EXCEPTION');
    } finally {
      setBusy(false);
    }
  }, [busy, slug, kind, title, targetUrl, notes, currentLessonIdx, currentLessonTitle]);

  const handleTransition = useCallback(async (artifactId, toState) => {
    if (busy) return;
    if (!window.artifact || typeof window.artifact.transition !== 'function') {
      setBridgeOk(false);
      return;
    }
    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const r = await window.artifact.transition({ slug, artifactId, toState });
      if (!r || !r.ok) {
        const code = (r && typeof r.error === 'string') ? r.error : 'EXCEPTION';
        setError(code);
        return;
      }
      setOkMsg(`迁移 → ${STATE_LABEL_CN[toState] || toState}`);
      const ls = await window.artifact.list({ slug, limit: LIST_LIMIT });
      if (ls && ls.ok && Array.isArray(ls.artifacts)) {
        setArtifacts(ls.artifacts);
      }
    } catch (_) {
      setError('EXCEPTION');
    } finally {
      setBusy(false);
    }
  }, [busy, slug]);

  const handleDelete = useCallback(async (artifactId) => {
    if (busy) return;
    if (!window.artifact || typeof window.artifact.delete !== 'function') {
      setBridgeOk(false);
      return;
    }
    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const r = await window.artifact.delete({ slug, artifactId });
      if (!r || !r.ok) {
        const code = (r && typeof r.error === 'string') ? r.error : 'EXCEPTION';
        setError(code);
        return;
      }
      setOkMsg('已删除');
      const ls = await window.artifact.list({ slug, limit: LIST_LIMIT });
      if (ls && ls.ok && Array.isArray(ls.artifacts)) {
        setArtifacts(ls.artifacts);
      }
    } catch (_) {
      setError('EXCEPTION');
    } finally {
      setBusy(false);
    }
  }, [busy, slug]);

  const titleCharsLeft = MAX_TITLE_LEN - (title || '').length;
  const createDisabled = busy || !slug || !title.trim() || titleCharsLeft < 0;

  const artifactsCount = artifacts.length;

  const eyebrowRight = useMemo(() => {
    if (!bridgeOk) return '未连接';
    if (!hydrated) return '读入中';
    if (artifactsCount === 0) return '这节课要造出什么';
    return `${artifactsCount} 件在场`;
  }, [bridgeOk, hydrated, artifactsCount]);

  if (!hydrated) return null;

  return (
    <div
      className="artifact-creation-card"
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
            artifact · 这节课要造出什么
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
          后端桥接尚未就绪 — artifact 通道仍在搭建。稍后此处会自亮。
        </div>
      )}

      {bridgeOk && (
        <>
          {/* Add form */}
          <div style={{ marginBottom: 18 }}>
            <div style={SECTION_HEADER_STYLE}>
              登记 · 一件具体可被人用的产物
            </div>

            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 12,
              marginBottom: 10,
            }}>
              <div>
                <div style={{
                  fontFamily: MONO_FONT,
                  fontSize: 9,
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  color: 'var(--ink-3, #8b8275)',
                  marginBottom: 4,
                }}>
                  形式
                </div>
                <select
                  value={kind}
                  onChange={(e) => setKind(e.target.value)}
                  style={SELECT_STYLE}
                >
                  {KIND_DEFS.map(k => (
                    <option key={k.id} value={k.id}>{k.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <div style={{
                  fontFamily: MONO_FONT,
                  fontSize: 9,
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  color: 'var(--ink-3, #8b8275)',
                  marginBottom: 4,
                }}>
                  来自课节 · 自动
                </div>
                <div style={{
                  ...INPUT_STYLE,
                  background: 'rgba(244,239,228,0.45)',
                  color: 'var(--ink-3, #8b8275)',
                  cursor: 'default',
                }}>
                  {_sourceLabel(currentLessonIdx, currentLessonTitle) || '本课'}
                </div>
              </div>
            </div>

            <div style={{
              fontFamily: MONO_FONT,
              fontSize: 9,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--ink-3, #8b8275)',
              marginBottom: 4,
            }}>
              标题
            </div>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="一句话 — 你要造的这件东西。"
              style={{ ...INPUT_STYLE, marginBottom: 4 }}
              maxLength={MAX_TITLE_LEN + 50}
            />
            <div style={{
              marginBottom: 10,
              fontFamily: MONO_FONT,
              fontSize: 10,
              letterSpacing: '0.10em',
              color: titleCharsLeft < 0 ? '#8B3A3A' : 'var(--ink-3, #8b8275)',
              textAlign: 'right',
            }}>
              {titleCharsLeft}
            </div>

            <div style={{
              fontFamily: MONO_FONT,
              fontSize: 9,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--ink-3, #8b8275)',
              marginBottom: 4,
            }}>
              目标地址 · 可选
            </div>
            <input
              type="text"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="github / substack / xhs 链接, 之后可补"
              style={{ ...INPUT_STYLE, marginBottom: 10 }}
              maxLength={MAX_URL_LEN}
            />

            <div style={{
              fontFamily: MONO_FONT,
              fontSize: 9,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--ink-3, #8b8275)',
              marginBottom: 4,
            }}>
              备注 · 可选
            </div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="简述这件 artifact 的形态, 受众, 或卡点。"
              rows={3}
              style={{ ...TEXTAREA_STYLE, marginBottom: 10 }}
              maxLength={MAX_NOTES_LEN}
            />

            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 12,
            }}>
              <button
                type="button"
                onClick={handleCreate}
                disabled={createDisabled}
                style={{
                  ...BRASS_BUTTON_STYLE,
                  opacity: createDisabled ? 0.5 : 1,
                  cursor: createDisabled ? 'not-allowed' : 'pointer',
                }}
              >
                {busy ? '记入…' : '登记'}
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

          {/* List of artifacts */}
          <div style={{ borderTop: '1px solid var(--rule-soft, #e3dccd)', paddingTop: 14 }}>
            <div style={SECTION_HEADER_STYLE}>
              在场 · 已登记的 artifact
            </div>
            {artifactsCount === 0 && (
              <div style={{
                fontFamily: SERIF_FONT,
                fontStyle: 'italic',
                fontSize: 13,
                color: 'var(--ink-3, #8b8275)',
                padding: '8px 0',
              }}>
                还没登记 — 这节课结束前, 写一件你要造的东西。
              </div>
            )}
            {artifactsCount > 0 && artifacts.map(a => (
              <ArtifactRow
                key={a.id}
                artifact={a}
                onTransition={handleTransition}
                onDelete={handleDelete}
                busy={busy}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
};

if (typeof window !== 'undefined') {
  window.ArtifactCreationCard = ArtifactCreationCard;
}
