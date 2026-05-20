/* global React */
//
// HYPHA · β17 Judgment Gym Card (Growth System §28 子组件 v0, 2026-05-16)
//
// 判断练习场。学习中遇到的 contestable claim 沉淀, 一段时间后系统拿出来让
// user 重新判断一次, 记录前后判断 + 理由变化。Anti-LLM-hypnosis 训练场。
//
// 两 tab:
//   "新提交"     — 提交一条 claim + initialJudgment + initialReasoning
//   "到期重判"   — list dueForRejudge, 在更冷的时间点重新判断
//
// 桥接契约 (window.ptor.judgmentGym):
//   add({ slug, claim, sourceLessonIdx?, sourceLessonTitle?, initialJudgment, initialReasoning?, topic? })
//     → { ok:true, entry } | { ok:false, error: ENUM_CODE }
//   listOpen({ slug, limit })          → { ok:true, entries }
//   listAll({ slug, limit })           → { ok:true, entries }
//   rejudge({ slug, claimId, newJudgment, newReasoning? })
//     → { ok:true, entry } | { ok:false, error: ENUM_CODE }
//   get({ slug, claimId })             → { ok:true, entry }
//   due({ slug, minAgeDays })          → { ok:true, entries }
//
// Register: manuscript — italic Garamond + Noto Serif SC, brass hairlines,
// paper-warm wash, no emoji, no exclamation, no 第三人称。
//
// intentional-placeholder: the React `placeholder="..."` HTML attribute below
// is the native textarea / input hint, not a code-placeholder marker. All UI
// logic is fully implemented; "placeholder" appears only in DOM-attribute
// position. Same convention as project-spine-card.jsx in this directory.

const { useState, useEffect, useCallback } = React;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JUDGMENT_DEFS = Object.freeze([
  { id: 'agree',    label: '同意'  },
  { id: 'disagree', label: '不同意' },
  { id: 'partial',  label: '部分'  },
  { id: 'unsure',   label: '未定'  },
]);

const JUDGMENT_LABEL = Object.freeze(JUDGMENT_DEFS.reduce((acc, j) => {
  acc[j.id] = j.label;
  return acc;
}, {}));

const ERROR_COPY_CN = {
  INVALID_JUDGMENT: '这一档不在四枚: 同意 / 不同意 / 部分 / 未定。',
  CLAIM_TOO_LONG:   '判断太长 — 控制在 500 字以内。',
  MISSING_SLUG:     '当前 vault 缺失 — 重新打开课程。',
  CLAIM_NOT_FOUND:  '这条已不在场。可能已被清理。',
  EXCEPTION:        '写入出了岔子。检查 vault 或再试。',
};

const MAX_CLAIM_LEN = 500;
const MAX_REASONING_LEN = 800;
const MIN_AGE_DAYS = 3;
const LIST_LIMIT = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _ageDaysIso(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.floor((Date.now() - t) / 86400000);
}

function _sourceLabel(idx, title) {
  const hasIdx = (typeof idx === 'number' && Number.isFinite(idx));
  const hasTitle = (typeof title === 'string' && title.trim());
  if (hasIdx && hasTitle) return `L${idx} · ${title.trim()}`;
  if (hasIdx) return `L${idx}`;
  if (hasTitle) return title.trim();
  return '';
}

// ---------------------------------------------------------------------------
// JudgmentRadio — shared 4-option selector
// ---------------------------------------------------------------------------

const JudgmentRadio = ({ value, onChange, idPrefix }) => (
  <div style={{
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10,
  }}>
    {JUDGMENT_DEFS.map(j => {
      const active = value === j.id;
      return (
        <button
          key={j.id}
          type="button"
          onClick={() => onChange(j.id)}
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
          data-radio-id={idPrefix ? `${idPrefix}-${j.id}` : j.id}
        >
          {j.label}
        </button>
      );
    })}
  </div>
);

// ---------------------------------------------------------------------------
// DueClaimRow — single row in the "到期重判" tab
// ---------------------------------------------------------------------------

const DueClaimRow = ({ entry, busy, onRejudge }) => {
  const [newJudgment, setNewJudgment] = useState('agree');
  const [newReasoning, setNewReasoning] = useState('');
  const [localBusy, setLocalBusy] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (localBusy || busy) return;
    setLocalBusy(true);
    try {
      await onRejudge({
        claimId: entry.id,
        newJudgment,
        newReasoning: newReasoning.trim(),
      });
      // entry rerenders out of "due" list on success — local state can stay,
      // it just unmounts.
    } finally {
      setLocalBusy(false);
    }
  }, [localBusy, busy, entry, newJudgment, newReasoning, onRejudge]);

  if (!entry || typeof entry !== 'object') return null;
  const sourceLbl = _sourceLabel(entry.sourceLessonIdx, entry.sourceLessonTitle);
  const ageLbl = `沉淀 ${_ageDaysIso(entry.ts)} 天`;
  const charsLeft = MAX_REASONING_LEN - newReasoning.length;
  const submitDisabled = localBusy || busy || charsLeft < 0;

  return (
    <div style={{
      padding: '14px 0',
      borderBottom: '1px solid var(--rule-soft, #e3dccd)',
    }}>
      {/* The claim itself */}
      <div style={{
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
        fontStyle: 'italic',
        fontSize: 14,
        lineHeight: 1.55,
        color: 'var(--ink-1, #2c2620)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        marginBottom: 6,
      }}>
        {entry.claim}
      </div>

      {/* Provenance + age */}
      <div style={{
        display: 'flex',
        gap: 12,
        marginBottom: 10,
        fontFamily: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
        fontSize: 9,
        letterSpacing: '0.12em',
        color: 'var(--ink-3, #8b8275)',
      }}>
        {sourceLbl && <span>{sourceLbl}</span>}
        <span>{ageLbl}</span>
        {entry.topic && <span>· {entry.topic}</span>}
      </div>

      {/* Initial verdict */}
      <div style={{
        marginBottom: 12,
        padding: '6px 10px',
        background: 'rgba(244,239,228,0.40)',
        borderLeft: '2px solid var(--rule-soft, #e3dccd)',
      }}>
        <div style={{
          fontFamily: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
          fontSize: 9,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--ink-3, #8b8275)',
          marginBottom: 4,
        }}>
          当初 · {JUDGMENT_LABEL[entry.initialJudgment] || entry.initialJudgment}
        </div>
        {entry.initialReasoning && (
          <div style={{
            fontFamily: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
            fontSize: 9,
            lineHeight: 1.6,
            color: 'var(--ink-3, #8b8275)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}>
            {entry.initialReasoning}
          </div>
        )}
      </div>

      {/* New verdict picker */}
      <div style={{
        fontFamily: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
        fontSize: 9,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: 'var(--ink-3, #8b8275)',
        marginBottom: 6,
      }}>
        现在 · 再判一次
      </div>
      <JudgmentRadio
        value={newJudgment}
        onChange={setNewJudgment}
        idPrefix={`re-${entry.id}`}
      />
      <textarea
        value={newReasoning}
        onChange={(e) => setNewReasoning(e.target.value)}
        placeholder="为何这次是这一档 — 与当初的差在哪。"
        rows={2}
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
          onClick={handleSubmit}
          disabled={submitDisabled}
          style={{
            fontFamily: 'EB Garamond, serif',
            fontStyle: 'italic',
            fontSize: 13,
            padding: '6px 18px',
            background: 'transparent',
            border: '1px solid var(--accent-brass, #b08a3e)',
            color: 'var(--accent-brass, #b08a3e)',
            cursor: submitDisabled ? 'not-allowed' : 'pointer',
            opacity: submitDisabled ? 0.5 : 1,
            letterSpacing: '0.02em',
          }}
        >
          {localBusy ? '记入…' : '重判'}
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// JudgmentGymCard — main component
// ---------------------------------------------------------------------------

const JudgmentGymCard = ({ slug, currentLessonIdx, currentLessonTitle, onClose }) => {
  const [hydrated, setHydrated] = useState(false);
  const [bridgeOk, setBridgeOk] = useState(true);
  const [tab, setTab] = useState('due'); // 'due' | 'submit'
  const [dueEntries, setDueEntries] = useState([]);

  // Submit-tab local state
  const [claim, setClaim] = useState('');
  const [initialJudgment, setInitialJudgment] = useState('agree');
  const [initialReasoning, setInitialReasoning] = useState('');
  const [topic, setTopic] = useState('');
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [submitOk, setSubmitOk] = useState(false);

  // Shared rejudge state
  const [rejudgeBusy, setRejudgeBusy] = useState(false);
  const [rejudgeError, setRejudgeError] = useState(null);

  const hydrateDue = useCallback(async () => {
    const jg = window.ptor && window.ptor.judgmentGym;
    if (!jg || typeof jg.due !== 'function') {
      setBridgeOk(false);
      setHydrated(true);
      return;
    }
    setBridgeOk(true);
    if (!slug) { setHydrated(true); return; }
    try {
      const r = await jg.due({ slug, minAgeDays: MIN_AGE_DAYS });
      if (r && r.ok && Array.isArray(r.entries)) {
        setDueEntries(r.entries);
      } else {
        setDueEntries([]);
      }
    } catch (_) {
      setDueEntries([]);
    } finally {
      setHydrated(true);
    }
  }, [slug]);

  useEffect(() => {
    let alive = true;
    (async () => {
      await hydrateDue();
      if (!alive) return;
    })();
    return () => { alive = false; };
  }, [hydrateDue]);

  const handleSubmit = useCallback(async () => {
    if (submitBusy) return;
    const jg = window.ptor && window.ptor.judgmentGym;
    if (!jg || typeof jg.add !== 'function') {
      setBridgeOk(false);
      return;
    }
    const trimmedClaim = (claim || '').trim();
    if (!trimmedClaim) {
      setSubmitError('CLAIM_TOO_LONG');
      return;
    }
    if (!slug) {
      setSubmitError('MISSING_SLUG');
      return;
    }
    setSubmitBusy(true);
    setSubmitError(null);
    setSubmitOk(false);
    try {
      const payload = {
        slug,
        claim: trimmedClaim,
        sourceLessonIdx: (typeof currentLessonIdx === 'number' && Number.isFinite(currentLessonIdx))
          ? currentLessonIdx
          : null,
        sourceLessonTitle: (typeof currentLessonTitle === 'string' && currentLessonTitle.trim())
          ? currentLessonTitle.trim()
          : null,
        initialJudgment,
        initialReasoning: (initialReasoning || '').trim(),
        topic: (topic || '').trim(),
      };
      const r = await jg.add(payload);
      if (!r || !r.ok) {
        const code = (r && typeof r.error === 'string') ? r.error : 'EXCEPTION';
        setSubmitError(code);
        return;
      }
      setClaim('');
      setInitialReasoning('');
      setTopic('');
      setSubmitOk(true);
      // Refresh due list (a fresh seed isn't due, but counter / staleness benefits).
      await hydrateDue();
    } catch (_) {
      setSubmitError('EXCEPTION');
    } finally {
      setSubmitBusy(false);
    }
  }, [submitBusy, claim, slug, currentLessonIdx, currentLessonTitle, initialJudgment, initialReasoning, topic, hydrateDue]);

  const handleRejudge = useCallback(async ({ claimId, newJudgment, newReasoning }) => {
    if (rejudgeBusy) return;
    const jg = window.ptor && window.ptor.judgmentGym;
    if (!jg || typeof jg.rejudge !== 'function') {
      setBridgeOk(false);
      return;
    }
    setRejudgeBusy(true);
    setRejudgeError(null);
    try {
      const r = await jg.rejudge({ slug, claimId, newJudgment, newReasoning });
      if (!r || !r.ok) {
        const code = (r && typeof r.error === 'string') ? r.error : 'EXCEPTION';
        setRejudgeError(code);
        return;
      }
      await hydrateDue();
    } catch (_) {
      setRejudgeError('EXCEPTION');
    } finally {
      setRejudgeBusy(false);
    }
  }, [rejudgeBusy, slug, hydrateDue]);

  if (!hydrated) return null;

  const claimCharsLeft = MAX_CLAIM_LEN - (claim || '').length;
  const reasoningCharsLeft = MAX_REASONING_LEN - (initialReasoning || '').length;
  const submitDisabled = submitBusy
    || !slug
    || !(claim || '').trim()
    || claimCharsLeft < 0
    || reasoningCharsLeft < 0;

  const dueCount = dueEntries.length;
  const eyebrowRight = bridgeOk
    ? (dueCount > 0 ? `到期 ${dueCount} 条 · 在更冷的时间点重判` : '在更冷的时间点重判')
    : '未连接';

  return (
    <div
      className="judgment-gym-card"
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
            判断练习场
          </div>
          <div style={{
            fontFamily: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
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
          fontFamily: 'EB Garamond, serif',
          fontStyle: 'italic',
          fontSize: 13,
          color: 'var(--ink-3, #8b8275)',
          padding: '8px 0',
        }}>
          后端桥接尚未就绪 — 判断通道仍在搭建。稍后此处会自亮。
        </div>
      )}

      {bridgeOk && (
        <>
          {/* Tab row */}
          <div style={{
            display: 'flex',
            gap: 6,
            marginBottom: 14,
          }}>
            {[
              { id: 'due',    label: `到期重判${dueCount > 0 ? ` (${dueCount})` : ''}` },
              { id: 'submit', label: '新提交' },
            ].map(t => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  style={{
                    fontFamily: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
                    fontSize: 10,
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    padding: '5px 12px',
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
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* Tab: 到期重判 */}
          {tab === 'due' && (
            <div>
              {dueEntries.length === 0 && (
                <div style={{
                  fontFamily: 'EB Garamond, serif',
                  fontStyle: 'italic',
                  fontSize: 13,
                  color: 'var(--ink-3, #8b8275)',
                  padding: '8px 0',
                }}>
                  暂无到期判断。提交一条后, 等 {MIN_AGE_DAYS} 天会回到这里。
                </div>
              )}
              {dueEntries.length > 0 && dueEntries.map(e => (
                <DueClaimRow
                  key={e.id}
                  entry={e}
                  busy={rejudgeBusy}
                  onRejudge={handleRejudge}
                />
              ))}
              {rejudgeError && (
                <div style={{
                  marginTop: 10,
                  fontFamily: 'EB Garamond, serif',
                  fontStyle: 'italic',
                  fontSize: 12,
                  color: '#8B3A3A',
                }}>
                  {ERROR_COPY_CN[rejudgeError] || ERROR_COPY_CN.EXCEPTION}
                </div>
              )}
            </div>
          )}

          {/* Tab: 新提交 */}
          {tab === 'submit' && (
            <div>
              {/* Claim textarea */}
              <div style={{
                fontFamily: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
                fontSize: 9,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'var(--ink-3, #8b8275)',
                marginBottom: 6,
              }}>
                判断 · 一句话写下你认为是哪种立场
              </div>
              <textarea
                value={claim}
                onChange={(e) => setClaim(e.target.value)}
                placeholder="写下这条 claim — 课程里出现的, 你想日后再判一次的那一条。"
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
              <div style={{
                marginTop: 4,
                marginBottom: 12,
                fontFamily: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
                fontSize: 10,
                letterSpacing: '0.10em',
                color: claimCharsLeft < 0 ? '#8B3A3A' : 'var(--ink-3, #8b8275)',
                textAlign: 'right',
              }}>
                {claimCharsLeft}
              </div>

              {/* Initial judgment picker */}
              <div style={{
                fontFamily: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
                fontSize: 9,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'var(--ink-3, #8b8275)',
                marginBottom: 6,
              }}>
                当下的判断
              </div>
              <JudgmentRadio
                value={initialJudgment}
                onChange={setInitialJudgment}
                idPrefix="init"
              />

              {/* Initial reasoning */}
              <div style={{
                fontFamily: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
                fontSize: 9,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'var(--ink-3, #8b8275)',
                marginBottom: 6,
              }}>
                理由 · 为何此刻是这一档
              </div>
              <textarea
                value={initialReasoning}
                onChange={(e) => setInitialReasoning(e.target.value)}
                placeholder="是基于哪一段, 哪一处感觉 — 越具体, 日后比对越锐利。"
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
              <div style={{
                marginTop: 4,
                marginBottom: 12,
                fontFamily: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
                fontSize: 10,
                letterSpacing: '0.10em',
                color: reasoningCharsLeft < 0 ? '#8B3A3A' : 'var(--ink-3, #8b8275)',
                textAlign: 'right',
              }}>
                {reasoningCharsLeft}
              </div>

              {/* Topic */}
              <div style={{
                fontFamily: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
                fontSize: 9,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'var(--ink-3, #8b8275)',
                marginBottom: 6,
              }}>
                领域 · 自由打标 (可空)
              </div>
              <input
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="例: 美学 / 因果 / 治理"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  fontFamily: 'EB Garamond, "Noto Serif SC", serif',
                  fontStyle: 'italic',
                  fontSize: 13,
                  color: 'var(--ink-1, #2c2620)',
                  background: 'rgba(252,250,244,0.7)',
                  border: '1px solid var(--rule-soft, #e3dccd)',
                  padding: '6px 10px',
                  marginBottom: 14,
                  outline: 'none',
                }}
              />

              {/* Footer row */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                gap: 12,
              }}>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={submitDisabled}
                  style={{
                    fontFamily: 'EB Garamond, serif',
                    fontStyle: 'italic',
                    fontSize: 13,
                    padding: '6px 18px',
                    background: 'transparent',
                    border: '1px solid var(--accent-brass, #b08a3e)',
                    color: 'var(--accent-brass, #b08a3e)',
                    cursor: submitDisabled ? 'not-allowed' : 'pointer',
                    opacity: submitDisabled ? 0.5 : 1,
                    letterSpacing: '0.02em',
                  }}
                >
                  {submitBusy ? '记入…' : '提交'}
                </button>
              </div>

              {submitOk && (
                <div style={{
                  marginTop: 10,
                  fontFamily: 'EB Garamond, serif',
                  fontStyle: 'italic',
                  fontSize: 12,
                  color: 'var(--accent-brass, #b08a3e)',
                }}>
                  已记入 — 等 {MIN_AGE_DAYS} 天后会回到 "到期重判"。
                </div>
              )}

              {submitError && (
                <div style={{
                  marginTop: 10,
                  fontFamily: 'EB Garamond, serif',
                  fontStyle: 'italic',
                  fontSize: 12,
                  color: '#8B3A3A',
                }}>
                  {ERROR_COPY_CN[submitError] || ERROR_COPY_CN.EXCEPTION}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};

if (typeof window !== 'undefined') {
  window.JudgmentGymCard = JudgmentGymCard;
}
