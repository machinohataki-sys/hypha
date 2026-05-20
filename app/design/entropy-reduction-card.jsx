/* global React */
//
// HYPHA · β18 Entropy Reduction Card (Note System §3 子组件 v0, 2026-05-16)
//
// 笔记 entropy 上升: 同主题灵感 (`## 用户灵感` block) 散落在 lesson-1.md /
// lesson-3.md / lesson-7.md。Entropy Reduction Cycle = 把散落的灵感聚成
// 一篇 canonical 笔记。
//
// v0 范围 (无 LLM):
//   左半: fragments list — 跨 lesson 全 `## 用户灵感` block, 9px mono "L3"
//                          + Garamond italic body 头 200 字 + checkbox 多选
//   右半: write form     — topicSlug input + title input + body textarea
//                          (接 selected fragments 拼接) + sources 自动填充
//                          (选中的 lesson indices)
//   下方: existing canonical notes — list 点开预览 body 100 字
//
// 桥接契约 (window.entropy):
//   collectFragments({ slug })                                  → { ok, fragments:[{lessonIdx, lessonTitle, fragment, ts}] }
//   listCanonical({ slug })                                     → { ok, notes:[{topicSlug, lastModified, fragmentCount}] }
//   readCanonical({ slug, topicSlug })                          → { ok, note:{topicSlug, title, body, sources, ts} }
//   writeCanonical({ slug, topicSlug, title, body, sources })   → { ok }
//   deleteCanonical({ slug, topicSlug })                        → { ok }
//
// Register: manuscript — italic Garamond + Noto Serif SC, brass hairlines,
// paper-warm wash, no emoji, no exclamation, no 第三人称。
//
// intentional-placeholder: React `placeholder="..."` HTML attribute below is
// the native textarea / input hint, not a code-placeholder marker. All UI
// logic is fully implemented; "placeholder" appears only in DOM-attribute
// position. Same convention as judgment-gym-card.jsx / project-spine-card.jsx.

const { useState, useEffect, useCallback, useMemo } = React;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TOPIC_SLUG_LEN  = 80;
const MAX_TITLE_LEN       = 200;
const MAX_BODY_LEN        = 20000;
const FRAGMENT_PREVIEW    = 200;
const CANONICAL_PREVIEW   = 100;

const ERROR_COPY_CN = {
  MISSING_SLUG:       '当前 vault 缺失 — 重新打开课程。',
  MISSING_TOPIC_SLUG: '主题 slug 必填 — 给这条 canonical 一个短名。',
  BODY_TOO_LONG:      '正文超出 20000 字 — 拆成两篇或先压缩。',
  NOT_FOUND:          '这条 canonical 不在场。可能已被清理。',
  EXCEPTION:          '写入出了岔子。检查 vault 或再试。',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _truncate(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return t.slice(0, n) + '…';
}

function _normalizeTopicSlugUi(raw) {
  return String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_\-一-鿿]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TOPIC_SLUG_LEN);
}

function _formatTs(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// ---------------------------------------------------------------------------
// Styles (shared across rows)
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
// FragmentRow — single selectable fragment from one lesson
// ---------------------------------------------------------------------------

const FragmentRow = ({ fragment, selected, onToggle }) => {
  if (!fragment) return null;
  const lessonIdx = (typeof fragment.lessonIdx === 'number' && Number.isFinite(fragment.lessonIdx))
    ? fragment.lessonIdx
    : null;
  const lessonLbl = lessonIdx !== null ? `L${lessonIdx}` : 'L?';
  const tsLbl = _formatTs(fragment.ts);
  const titleLbl = fragment.lessonTitle ? _truncate(fragment.lessonTitle, 40) : '';
  return (
    <label
      style={{
        display: 'block',
        padding: '10px 12px',
        marginBottom: 8,
        background: selected ? 'rgba(176,138,62,0.08)' : 'rgba(252,250,244,0.45)',
        border: selected
          ? '1px solid var(--accent-brass, #b08a3e)'
          : '1px solid var(--rule-soft, #e3dccd)',
        cursor: 'pointer',
      }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 10,
        marginBottom: 6,
      }}>
        <input
          type="checkbox"
          checked={!!selected}
          onChange={() => onToggle(lessonIdx)}
          style={{ marginRight: 4, cursor: 'pointer' }}
        />
        <span style={ROW_TAG_STYLE}>{lessonLbl}</span>
        {titleLbl && (
          <span style={{
            ...ROW_TAG_STYLE,
            textTransform: 'none',
            letterSpacing: '0.04em',
          }}>· {titleLbl}</span>
        )}
        {tsLbl && (
          <span style={{
            ...ROW_TAG_STYLE,
            marginLeft: 'auto',
          }}>{tsLbl}</span>
        )}
      </div>
      <div style={{
        fontFamily: SERIF_FONT,
        fontStyle: 'italic',
        fontSize: 13,
        lineHeight: 1.55,
        color: 'var(--ink-1, #2c2620)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        paddingLeft: 28,
      }}>
        {_truncate(fragment.fragment, FRAGMENT_PREVIEW)}
      </div>
    </label>
  );
};

// ---------------------------------------------------------------------------
// CanonicalRow — single existing canonical note (click to expand body preview)
// ---------------------------------------------------------------------------

const CanonicalRow = ({ slug, note, onLoadIntoForm, onDelete, busy }) => {
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState(null);
  const [hydrating, setHydrating] = useState(false);

  const toggle = useCallback(async () => {
    if (expanded) { setExpanded(false); return; }
    if (preview) { setExpanded(true); return; }
    if (!window.entropy || typeof window.entropy.readCanonical !== 'function') return;
    setHydrating(true);
    try {
      const r = await window.entropy.readCanonical({ slug, topicSlug: note.topicSlug });
      if (r && r.ok && r.note) {
        setPreview(r.note);
      } else {
        setPreview({ topicSlug: note.topicSlug, title: '', body: '', sources: [] });
      }
      setExpanded(true);
    } catch (_) {
      setPreview({ topicSlug: note.topicSlug, title: '', body: '', sources: [] });
      setExpanded(true);
    } finally {
      setHydrating(false);
    }
  }, [expanded, preview, slug, note]);

  if (!note) return null;
  const tsLbl = _formatTs(note.lastModified);

  return (
    <div style={{
      padding: '10px 0',
      borderBottom: '1px solid var(--rule-soft, #e3dccd)',
    }}>
      <div
        onClick={toggle}
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          cursor: 'pointer',
        }}
      >
        <span style={{
          fontFamily: SERIF_FONT,
          fontStyle: 'italic',
          fontSize: 14,
          color: 'var(--ink-1, #2c2620)',
        }}>
          {note.topicSlug}
        </span>
        <span style={ROW_TAG_STYLE}>
          {note.fragmentCount > 0 ? `${note.fragmentCount} 条合并` : '空合并'}
        </span>
        {tsLbl && (
          <span style={{ ...ROW_TAG_STYLE, marginLeft: 'auto' }}>{tsLbl}</span>
        )}
      </div>

      {expanded && preview && (
        <div style={{ marginTop: 8, paddingLeft: 4 }}>
          {preview.title && (
            <div style={{
              fontFamily: SERIF_FONT,
              fontStyle: 'italic',
              fontSize: 13,
              color: 'var(--ink-2, #5a5246)',
              marginBottom: 4,
            }}>
              {_truncate(preview.title, 100)}
            </div>
          )}
          <div style={{
            fontFamily: SERIF_FONT,
            fontStyle: 'italic',
            fontSize: 12,
            lineHeight: 1.55,
            color: 'var(--ink-2, #5a5246)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            marginBottom: 8,
          }}>
            {_truncate(preview.body, CANONICAL_PREVIEW)}
          </div>
          {Array.isArray(preview.sources) && preview.sources.length > 0 && (
            <div style={{ ...ROW_TAG_STYLE, marginBottom: 8 }}>
              来源 · {preview.sources.map(n => `L${n}`).join(' · ')}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              onClick={() => onLoadIntoForm(preview)}
              style={{
                ...BRASS_BUTTON_STYLE,
                fontSize: 12,
                padding: '4px 12px',
              }}
            >
              载入表单
            </button>
            <button
              type="button"
              onClick={() => onDelete(note.topicSlug)}
              disabled={busy}
              style={{
                ...BRASS_BUTTON_STYLE,
                fontSize: 12,
                padding: '4px 12px',
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
      )}
      {hydrating && (
        <div style={{
          fontFamily: SERIF_FONT,
          fontStyle: 'italic',
          fontSize: 12,
          color: 'var(--ink-3, #8b8275)',
          marginTop: 6,
          paddingLeft: 4,
        }}>
          读入中…
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// EntropyReductionCard — main component
// ---------------------------------------------------------------------------

const EntropyReductionCard = ({ slug, onClose }) => {
  const [hydrated, setHydrated] = useState(false);
  const [bridgeOk, setBridgeOk] = useState(true);

  const [fragments, setFragments] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [canonicalList, setCanonicalList] = useState([]);

  // Form state
  const [topicSlug, setTopicSlug] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  // Status state
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [okMsg, setOkMsg] = useState(null);

  const hydrate = useCallback(async () => {
    if (!window.entropy || typeof window.entropy.collectFragments !== 'function') {
      setBridgeOk(false);
      setHydrated(true);
      return;
    }
    setBridgeOk(true);
    if (!slug) { setHydrated(true); return; }
    try {
      const [fragRes, canonRes] = await Promise.all([
        window.entropy.collectFragments({ slug }),
        window.entropy.listCanonical({ slug }),
      ]);
      if (fragRes && fragRes.ok && Array.isArray(fragRes.fragments)) {
        setFragments(fragRes.fragments);
      } else {
        setFragments([]);
      }
      if (canonRes && canonRes.ok && Array.isArray(canonRes.notes)) {
        setCanonicalList(canonRes.notes);
      } else {
        setCanonicalList([]);
      }
    } catch (_) {
      setFragments([]);
      setCanonicalList([]);
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

  const toggleSelect = useCallback((lessonIdx) => {
    if (lessonIdx === null || lessonIdx === undefined) return;
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(lessonIdx)) next.delete(lessonIdx);
      else next.add(lessonIdx);
      return next;
    });
  }, []);

  // Auto-fill body from the selected fragments (idempotent on selection change).
  // We append; user keeps the option to edit. Re-clicking the prefill button
  // overrides body with current selection.
  const handlePrefillBody = useCallback(() => {
    const picked = fragments.filter(f => selected.has(f.lessonIdx));
    if (picked.length === 0) return;
    const composed = picked.map(f => {
      const head = `## L${f.lessonIdx}${f.lessonTitle ? ' · ' + f.lessonTitle : ''}`;
      return `${head}\n\n${f.fragment.trim()}`;
    }).join('\n\n---\n\n');
    setBody(composed.slice(0, MAX_BODY_LEN));
  }, [fragments, selected]);

  const handleLoadIntoForm = useCallback((note) => {
    if (!note) return;
    setTopicSlug(note.topicSlug || '');
    setTitle(note.title || '');
    setBody(note.body || '');
    setError(null);
    setOkMsg(null);
  }, []);

  const handleWrite = useCallback(async () => {
    if (busy) return;
    if (!window.entropy || typeof window.entropy.writeCanonical !== 'function') {
      setBridgeOk(false);
      return;
    }
    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const cleanTopicSlug = _normalizeTopicSlugUi(topicSlug);
      if (!cleanTopicSlug) {
        setError('MISSING_TOPIC_SLUG');
        setBusy(false);
        return;
      }
      if (!slug) {
        setError('MISSING_SLUG');
        setBusy(false);
        return;
      }
      const sources = Array.from(selected).filter(n => Number.isFinite(n));
      const r = await window.entropy.writeCanonical({
        slug,
        topicSlug: cleanTopicSlug,
        title: title.trim(),
        body,
        sources,
      });
      if (!r || !r.ok) {
        const code = (r && typeof r.error === 'string') ? r.error : 'EXCEPTION';
        setError(code);
        return;
      }
      setOkMsg(`已写入 canonical · ${cleanTopicSlug}`);
      // Refresh canonical list, keep form state for incremental edits.
      const canonRes = await window.entropy.listCanonical({ slug });
      if (canonRes && canonRes.ok && Array.isArray(canonRes.notes)) {
        setCanonicalList(canonRes.notes);
      }
    } catch (_) {
      setError('EXCEPTION');
    } finally {
      setBusy(false);
    }
  }, [busy, slug, topicSlug, title, body, selected]);

  const handleDelete = useCallback(async (topicSlugToDel) => {
    if (busy) return;
    if (!window.entropy || typeof window.entropy.deleteCanonical !== 'function') {
      setBridgeOk(false);
      return;
    }
    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const r = await window.entropy.deleteCanonical({ slug, topicSlug: topicSlugToDel });
      if (!r || !r.ok) {
        const code = (r && typeof r.error === 'string') ? r.error : 'EXCEPTION';
        setError(code);
        return;
      }
      setOkMsg(`已删除 · ${topicSlugToDel}`);
      const canonRes = await window.entropy.listCanonical({ slug });
      if (canonRes && canonRes.ok && Array.isArray(canonRes.notes)) {
        setCanonicalList(canonRes.notes);
      }
    } catch (_) {
      setError('EXCEPTION');
    } finally {
      setBusy(false);
    }
  }, [busy, slug]);

  const selectedCount = selected.size;
  const fragmentsCount = fragments.length;
  const canonicalCount = canonicalList.length;
  const bodyCharsLeft = MAX_BODY_LEN - (body || '').length;
  const writeDisabled = busy
    || !slug
    || !topicSlug.trim()
    || bodyCharsLeft < 0;

  const eyebrowRight = useMemo(() => {
    if (!bridgeOk) return '未连接';
    if (!hydrated) return '读入中';
    if (fragmentsCount === 0 && canonicalCount === 0) return '把散落的灵感聚成一篇';
    const parts = [];
    parts.push(`碎片 ${fragmentsCount} 条`);
    if (canonicalCount > 0) parts.push(`canonical ${canonicalCount} 篇`);
    return parts.join(' · ');
  }, [bridgeOk, hydrated, fragmentsCount, canonicalCount]);

  if (!hydrated) return null;

  return (
    <div
      className="entropy-reduction-card"
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
            entropy reduction
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

      {/* Bridge missing */}
      {!bridgeOk && (
        <div style={{
          fontFamily: SERIF_FONT,
          fontStyle: 'italic',
          fontSize: 13,
          color: 'var(--ink-3, #8b8275)',
          padding: '8px 0',
        }}>
          后端桥接尚未就绪 — entropy 通道仍在搭建。稍后此处会自亮。
        </div>
      )}

      {bridgeOk && (
        <>
          {/* Two-column body: left = fragments, right = write form */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 24,
            marginBottom: 18,
          }}>
            {/* Left: fragments list */}
            <div>
              <div style={SECTION_HEADER_STYLE}>
                碎片 · 散落在课中的用户灵感
              </div>
              {fragmentsCount === 0 && (
                <div style={{
                  fontFamily: SERIF_FONT,
                  fontStyle: 'italic',
                  fontSize: 13,
                  color: 'var(--ink-3, #8b8275)',
                  padding: '8px 0',
                }}>
                  目前没有可合并的碎片 — 在课中的 用户灵感 段写一句, 再回来。
                </div>
              )}
              {fragmentsCount > 0 && (
                <div style={{ maxHeight: 420, overflowY: 'auto', paddingRight: 4 }}>
                  {fragments.map((f, i) => (
                    <FragmentRow
                      key={`${f.lessonIdx}-${i}`}
                      fragment={f}
                      selected={selected.has(f.lessonIdx)}
                      onToggle={toggleSelect}
                    />
                  ))}
                </div>
              )}
              {fragmentsCount > 0 && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  marginTop: 10,
                }}>
                  <div style={ROW_TAG_STYLE}>已选 {selectedCount} 条</div>
                  <button
                    type="button"
                    onClick={handlePrefillBody}
                    disabled={selectedCount === 0}
                    style={{
                      ...BRASS_BUTTON_STYLE,
                      fontSize: 12,
                      padding: '4px 12px',
                      opacity: selectedCount === 0 ? 0.5 : 1,
                      cursor: selectedCount === 0 ? 'not-allowed' : 'pointer',
                    }}
                  >
                    拼入正文
                  </button>
                </div>
              )}
            </div>

            {/* Right: write form */}
            <div>
              <div style={SECTION_HEADER_STYLE}>
                合并 · 写入 canonical-notes
              </div>

              <div style={{
                fontFamily: MONO_FONT,
                fontSize: 9,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'var(--ink-3, #8b8275)',
                marginBottom: 4,
              }}>
                topic slug
              </div>
              <input
                type="text"
                value={topicSlug}
                onChange={(e) => setTopicSlug(e.target.value)}
                placeholder="例: 因果倒置 / hyper-realism / mythos-ban"
                style={{ ...INPUT_STYLE, marginBottom: 10 }}
                maxLength={MAX_TOPIC_SLUG_LEN}
              />

              <div style={{
                fontFamily: MONO_FONT,
                fontSize: 9,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'var(--ink-3, #8b8275)',
                marginBottom: 4,
              }}>
                标题 · 可选
              </div>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="一句话 — 这条 canonical 在讲什么。"
                style={{ ...INPUT_STYLE, marginBottom: 10 }}
                maxLength={MAX_TITLE_LEN}
              />

              <div style={{
                fontFamily: MONO_FONT,
                fontSize: 9,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'var(--ink-3, #8b8275)',
                marginBottom: 4,
              }}>
                正文
              </div>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="把选中的碎片 (点 拼入正文) 合在这里, 调整顺序, 删冗余, 留矛盾。"
                rows={10}
                style={TEXTAREA_STYLE}
              />
              <div style={{
                marginTop: 4,
                marginBottom: 10,
                fontFamily: MONO_FONT,
                fontSize: 10,
                letterSpacing: '0.10em',
                color: bodyCharsLeft < 0 ? '#8B3A3A' : 'var(--ink-3, #8b8275)',
                textAlign: 'right',
              }}>
                {bodyCharsLeft}
              </div>

              {selectedCount > 0 && (
                <div style={{ ...ROW_TAG_STYLE, marginBottom: 10 }}>
                  来源将记入 · {Array.from(selected).sort((a, b) => a - b).map(n => `L${n}`).join(' · ')}
                </div>
              )}

              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                gap: 12,
              }}>
                <button
                  type="button"
                  onClick={handleWrite}
                  disabled={writeDisabled}
                  style={{
                    ...BRASS_BUTTON_STYLE,
                    opacity: writeDisabled ? 0.5 : 1,
                    cursor: writeDisabled ? 'not-allowed' : 'pointer',
                  }}
                >
                  {busy ? '记入…' : '写入'}
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
          </div>

          {/* Bottom: existing canonical notes */}
          <div style={{ borderTop: '1px solid var(--rule-soft, #e3dccd)', paddingTop: 14 }}>
            <div style={SECTION_HEADER_STYLE}>
              已存 · canonical-notes
            </div>
            {canonicalCount === 0 && (
              <div style={{
                fontFamily: SERIF_FONT,
                fontStyle: 'italic',
                fontSize: 13,
                color: 'var(--ink-3, #8b8275)',
                padding: '8px 0',
              }}>
                还没有写入的 canonical — 选几条碎片, 拼入正文, 写入。
              </div>
            )}
            {canonicalCount > 0 && canonicalList.map((n) => (
              <CanonicalRow
                key={n.topicSlug}
                slug={slug}
                note={n}
                onLoadIntoForm={handleLoadIntoForm}
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
  window.EntropyReductionCard = EntropyReductionCard;
}
