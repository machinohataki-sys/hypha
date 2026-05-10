// AntechamberCard — pre-read prediction during lesson generation wait.
//
// Per /tr council 2026-05-02: Hypha's 30-90s lesson-gen wait is repurposed
// from dead time to pedagogical first move. User sees lesson title + learn
// goal already (we have those before generation starts), and gets one open-
// ended question: "predict the central claim before any source loads."
//
// Backed by: Roediger & Karpicke 2006 retrieval practice (d=0.80-1.13),
// McDaniel generation effect (d=0.40), Sinha & Kapur 2021 productive-failure
// meta-analysis (g=0.36). Prediction-error encoding (Kapur) maximized when
// comparison happens at lesson END, not lesson opening — so this card just
// captures, doesn't reveal.
//
// Props:
//   waitType: 'lesson-gen' | 'chain-create' | 'harvest' (currently only
//             lesson-gen is wired; others defer)
//   topic: string (e.g. "YC training")
//   learnGoal: string (e.g. "understand startup hypothesis testing")
//   stage: 'harvesting' | 'designing' | 'writing-lessons' | 'done' | 'error'
//   sourceCount: number (live count during harvesting)
//   onPredict: (text: string) => void — called on submit (or empty on skip)
//   visible: boolean — true while gen in flight; false fades out

function AntechamberCard({ waitType, topic, learnGoal, stage, sourceCount, onPredict, visible }) {
  const [draft, setDraft] = React.useState('');
  const [submitted, setSubmitted] = React.useState(false);
  const taRef = React.useRef(null);

  // Autofocus on mount when card becomes visible.
  React.useEffect(() => {
    if (!visible) return;
    const id = setTimeout(() => { try { taRef.current && taRef.current.focus(); } catch (_) {} }, 280);
    return () => clearTimeout(id);
  }, [visible]);

  // Submit handler — called by Enter or button click. Empty draft = skip.
  const submit = React.useCallback(() => {
    if (submitted) return;
    setSubmitted(true);
    if (typeof onPredict === 'function') onPredict((draft || '').trim());
  }, [draft, onPredict, submitted]);

  // Keyboard: Cmd/Ctrl+Enter submits.
  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setSubmitted(true);
      if (typeof onPredict === 'function') onPredict('');
    }
  };

  // Stage-specific copy.
  const stageLabel = (() => {
    if (stage === 'harvesting') return sourceCount > 0 ? `gathering · ${sourceCount} sources so far` : 'gathering sources…';
    if (stage === 'designing') return 'shaping the lesson';
    if (stage === 'designing-heartbeat') return 'still shaping…';
    if (stage === 'writing-lessons') return 'writing the lesson body';
    if (stage === 'done') return 'ready';
    if (stage === 'error') return 'something went sideways';
    return 'forging…';
  })();

  // The opening copy is genre-aware: declarative-sounding goals get a
  // "predict the claim" prompt; procedural goals get "try the move first".
  // Heuristic: presence of action verbs ("solve", "build", "implement",
  // "compute", "derive") suggests procedural.
  const isProcedural = /(solve|build|implement|compute|derive|train|fit|run|deploy|配置|搭建|实现|计算|推导)/i.test(learnGoal || '');
  const promptText = isProcedural
    ? '在你看任何步骤之前 — 你会怎么先动手做这个? 一两句, 哪怕是错的方向也写下来.'
    : '在你看任何史料之前 — 你猜这节课的核心点是什么? 一句话, 哪怕是错的也写下来.';
  const rationale = isProcedural
    ? '· 你的尝试会在课程结束后和正解对照 — 错位本身就是最好的学习信号'
    : '· 你的猜测会在课程结束后和正解对照 — 落差本身就是最好的学习信号';

  return (
    <div
      role="region"
      aria-label="pre-read prediction"
      style={{
        position: 'relative',
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(-8px)',
        transition: visible
          ? 'opacity 320ms cubic-bezier(0.22, 1, 0.36, 1) 80ms, transform 320ms cubic-bezier(0.22, 1, 0.36, 1) 80ms'
          : 'opacity 240ms cubic-bezier(0.4, 0, 0.2, 1), transform 240ms cubic-bezier(0.4, 0, 0.2, 1)',
        pointerEvents: visible ? 'auto' : 'none',
        maxWidth: 640,
        margin: '24px auto',
        padding: '28px 36px 24px',
        background: 'color-mix(in srgb, var(--brass-bright) 4%, transparent)',
        borderRadius: 2,
        boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--brass-mid) 26%, transparent)',
        fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
      }}
    >
      <div style={{
        fontFamily: '"Cormorant Garamond", "EB Garamond", Georgia, serif',
        fontStyle: 'italic', fontWeight: 500,
        fontSize: 12.5, letterSpacing: '0.2em',
        textTransform: 'uppercase',
        color: 'var(--brass-bright)',
        marginBottom: 14,
      }}>while we forge · {stageLabel}</div>

      <div style={{
        fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
        fontStyle: 'italic',
        fontSize: 17,
        lineHeight: 1.55,
        color: 'var(--ink-title)',
        marginBottom: 6,
      }}>{topic || 'this lesson'}</div>

      {learnGoal && (
        <div style={{
          fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
          fontStyle: 'italic',
          fontSize: 14.5,
          lineHeight: 1.55,
          color: 'var(--ink-muted)',
          marginBottom: 18,
          opacity: 0.85,
        }}>{learnGoal}</div>
      )}

      <div style={{
        fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
        fontStyle: 'normal',
        fontSize: 15.5,
        lineHeight: 1.6,
        color: 'var(--ink-primary)',
        marginBottom: 10,
      }}>{promptText}</div>

      {/* intentional-placeholder: real HTML <textarea> placeholder attribute (input hint), not a TODO stub */}
      <textarea
        ref={taRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={submitted}
        placeholder={submitted ? '' : 'your guess… (cmd+enter to submit · esc to skip)'}
        style={{
          width: '100%',
          minHeight: 80,
          padding: '12px 14px',
          fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
          fontStyle: 'italic',
          fontSize: 16,
          lineHeight: 1.5,
          color: 'var(--ink-title)',
          background: submitted
            ? 'color-mix(in srgb, var(--brass-mid) 3%, transparent)'
            : 'color-mix(in srgb, var(--bg-base) 85%, transparent)',
          border: 'none',
          borderBottom: submitted
            ? '1px solid color-mix(in srgb, var(--brass-bright) 40%, transparent)'
            : '1px solid color-mix(in srgb, var(--brass-mid) 28%, transparent)',
          outline: 'none',
          resize: 'vertical',
          transition: 'border-color 220ms cubic-bezier(0.22, 1, 0.36, 1), background 220ms',
        }}
      />

      <div style={{
        marginTop: 10,
        fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
        fontStyle: 'italic',
        fontSize: 12.5,
        color: 'var(--ink-faint)',
        lineHeight: 1.5,
        display: 'flex', alignItems: 'baseline', gap: 18,
      }}>
        <span>{rationale}</span>
        <span style={{ flex: 1 }} />
        {!submitted && (
          <>
            <button
              type="button"
              onClick={() => { setDraft(''); submit(); }}
              style={{
                background: 'transparent', border: 'none', padding: 0,
                fontFamily: 'inherit', fontStyle: 'italic', fontSize: 12.5,
                color: 'var(--ink-faint)', cursor: 'pointer',
                borderBottom: '1px solid transparent',
                transition: 'border-color 200ms, color 200ms',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderBottomColor = 'var(--ink-muted)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderBottomColor = 'transparent'; }}
            >skip</button>
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim()}
              style={{
                background: 'transparent', border: 'none', padding: 0,
                fontFamily: 'inherit', fontStyle: 'italic', fontSize: 12.5,
                color: draft.trim() ? 'var(--brass-bright)' : 'var(--ink-faint)',
                cursor: draft.trim() ? 'pointer' : 'not-allowed',
                borderBottom: '1px solid transparent',
                transition: 'border-color 200ms, color 200ms',
              }}
              onMouseEnter={e => { if (draft.trim()) e.currentTarget.style.borderBottomColor = 'var(--brass-bright)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderBottomColor = 'transparent'; }}
            >submit →</button>
          </>
        )}
        {submitted && (
          <span style={{ fontStyle: 'italic', color: 'var(--brass-mid)' }}>
            {draft.trim() ? '· kept · we\'ll compare at lesson end' : '· skipped · the lesson awaits'}
          </span>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { AntechamberCard });
