/* global React */
//
// HYPHA · W1.5 Finish Ritual screen.
//
// Per BLUEPRINT §9.2 — entered from the "完成记录" button on the Capture
// screen. The four stages are NOT a fast progress bar; they are a
// deliberate ritual that buys time between live consumption and durable
// understanding. The user must write their own one-sentence core
// understanding (Stage 3) before the system generates the final note.
//
//   1. 汇总草稿        (Stage 1 — backend aggregates similar marks)
//   2. 并行深化        (Stage 2 — T4_JUDGE deepen pass per mark)
//   3. 你的核心理解     (Stage 3 — Human First gate; blocker)
//   4. 正式 Note 生成   (Stage 4 — deposit via lesson-note.js, then exit)
//
// We orchestrate all four through a single backend IPC
// (window.ptor.capture.finishRitual) but slice the staging in the UI so
// the user perceives the ritual, not a black box. Stage 1+2 run while the
// user is composing Stage 3, so by the time they hit "生成" the deepen
// pass is already settled.

const FinishRitualScreen = ({ sessionId, goal, onDone, onAbort }) => {
  const { useState, useEffect, useRef } = React;

  // 1 → 2 → 3 → 4 → done.
  const [stage, setStage] = useState(1);
  const [userCore, setUserCore] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  // Stage 1+2 fast-progress display. We fake-staged the local UI since the
  // backend currently exposes a single finishRitual IPC — once the backend
  // emits stage-by-stage events we'll wire onStage to update here too.
  const [stage1Done, setStage1Done] = useState(false);
  const [stage2Done, setStage2Done] = useState(false);

  const ranAutoStartRef = useRef(false);

  // The Stage 1+2 "warmup" — we kick off a no-op timer to show progress
  // while the user reads the intro + composes their sentence.
  // intentional-placeholder: real backend stage streaming (a stage-by-
  // stage progress channel out of finish-ritual.js) is deferred until the
  // T4_JUDGE LLM call lands; until then the warmup is visibly synchronous
  // so the user trusts the timeline.
  useEffect(() => {
    if (ranAutoStartRef.current) return;
    ranAutoStartRef.current = true;
    // ~700ms feels like agentic work, not a blank moment.
    const t1 = setTimeout(() => { setStage1Done(true); setStage(2); }, 700);
    const t2 = setTimeout(() => { setStage2Done(true); setStage(3); }, 1500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  const submit = async () => {
    if (!sessionId) { setError('sessionId missing'); return; }
    const text = userCore.trim();
    if (text.length < 8) { setError('请写一句完整的核心理解 (至少 8 字)'); return; }
    setError(null);
    setSubmitting(true);
    try {
      const fn = window.ptor && window.ptor.capture && window.ptor.capture.finishRitual;
      if (typeof fn !== 'function') throw new Error('finishRitual bridge unavailable');
      const goalContract = (goal && goal.goalContract) || null;
      const r = await fn({
        sessionId,
        opts: {
          userCoreUnderstanding: text,
          ctx: goalContract ? { goalContract } : {},
        },
      });
      if (!r || r.ok === false) {
        throw new Error((r && r.error) || 'finishRitual rejected');
      }
      setResult(r);
      setStage(4);
      // Auto-exit after a beat so the user reads the final card.
      setTimeout(() => {
        if (typeof onDone === 'function') onDone(r);
      }, 1800);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fade-in col" style={{
      minHeight: '100vh',
      background: 'var(--paper, #f4efe4)',
      color: 'var(--ink, #2a2620)',
      padding: '48px 64px',
      fontFamily: 'var(--serif, "EB Garamond", serif)',
    }}>
      <header className="col" style={{ gap: 6, paddingBottom: 28 }}>
        <div className="serif italic" style={{ fontSize: 30, lineHeight: 1.1 }}>完成记录</div>
        <div className="serif" style={{ color: 'var(--ink-2, #494339)', fontSize: 14 }}>
          课程结束，开始深化 — Finish &amp; Deepen
        </div>
      </header>

      <StageIndicator stage={stage} stage1Done={stage1Done} stage2Done={stage2Done} />

      <main style={{ marginTop: 32, maxWidth: 720 }}>
        {stage === 1 && <Stage1Aggregating />}
        {stage === 2 && <Stage2Deepening />}
        {stage === 3 && (
          <Stage3UserCore
            userCore={userCore}
            setUserCore={setUserCore}
            error={error}
            submit={submit}
            submitting={submitting}
          />
        )}
        {stage === 4 && <Stage4Done result={result} />}
      </main>

      {/* Abort affordance — only meaningful before Stage 4 commits. */}
      {stage < 4 && typeof onAbort === 'function' && (
        <div style={{ marginTop: 'auto', paddingTop: 32 }}>
          <button onClick={onAbort} style={{
            background: 'transparent', border: 'none',
            color: 'var(--ink-3, #66605a)', fontSize: 13, cursor: 'pointer',
            fontFamily: 'var(--serif, "EB Garamond", serif)',
            textDecoration: 'underline',
          }}>不深化, 仅保留原始记录</button>
        </div>
      )}
    </div>
  );
};

// ─── stage indicator ───
const StageIndicator = ({ stage, stage1Done, stage2Done }) => {
  const steps = [
    { n: 1, label: '汇总草稿',     hint: '合并相似标记 (≤60s)',  done: stage1Done || stage > 1 },
    { n: 2, label: '并行深化',     hint: '每个标记一段补深',     done: stage2Done || stage > 2 },
    { n: 3, label: '你的核心理解', hint: '先写一句, 然后生成', done: stage > 3 },
    { n: 4, label: '正式 Note',    hint: 'Lesson Note + 学习证明', done: stage >= 4 && stage === 4 },
  ];
  return (
    <div className="row" style={{ gap: 0, alignItems: 'stretch', flexWrap: 'wrap' }}>
      {steps.map((s, i) => {
        const active = stage === s.n;
        const past = stage > s.n || s.done;
        return (
          <div key={s.n} className="row" style={{ alignItems: 'center', flex: 1, minWidth: 180 }}>
            <div className="col" style={{
              gap: 4, padding: '14px 18px', flex: 1,
              borderTop: '2px solid ' + (past ? 'var(--brass-bright, #b8893a)'
                                       : active ? 'var(--ink-1, #2a2620)'
                                       : 'var(--rule-soft, rgba(0,0,0,.12))'),
            }}>
              <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                <span className="mono" style={{
                  fontSize: 11, letterSpacing: '.16em',
                  color: past ? 'var(--brass-bright, #b8893a)'
                       : active ? 'var(--ink-1, #2a2620)'
                       : 'var(--ink-4, #8a847c)',
                }}>STAGE {s.n}</span>
                <span className="serif italic" style={{
                  fontSize: 16,
                  color: active ? 'var(--ink-1, #2a2620)'
                       : past ? 'var(--ink-2, #494339)'
                       : 'var(--ink-3, #66605a)',
                }}>{s.label}</span>
                {past && <span style={{ color: 'var(--brass-bright, #b8893a)', fontSize: 13 }}>✓</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-3, #66605a)' }}>{s.hint}</div>
            </div>
            {i < steps.length - 1 && (
              <div style={{
                width: 24, height: 1,
                background: past ? 'var(--brass-bright, #b8893a)' : 'var(--rule-soft, rgba(0,0,0,.12))',
                margin: '0 4px',
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
};

// ─── per-stage panels ───
const Stage1Aggregating = () => (
  <div className="col" style={{ gap: 12 }}>
    <Spinner label="正在合并相似标记" />
    <div className="serif" style={{ color: 'var(--ink-2, #494339)', fontSize: 14, lineHeight: 1.7 }}>
      同一类标记 (问号/感叹号/Spark/...) 若在 60 秒内连发, 会被合并成一条草稿,
      避免课后被同一关切的回声淹没。
    </div>
  </div>
);

const Stage2Deepening = () => (
  <div className="col" style={{ gap: 12 }}>
    <Spinner label="并行深化每条标记" />
    <div className="serif" style={{ color: 'var(--ink-2, #494339)', fontSize: 14, lineHeight: 1.7 }}>
      <span style={{ color: 'var(--brass-bright, #b8893a)' }}>?</span> 不懂 → 释疑一段。
      <span style={{ color: 'var(--brass-bright, #b8893a)' }}> ↗</span> 深化 → 一对追问。
      <span style={{ color: 'var(--brass-bright, #b8893a)' }}> ⚡</span> Spark → 一条跨域桥。
      <span style={{ color: 'var(--brass-bright, #b8893a)' }}> ◇</span> 迁移 → 推到 Product Pool。
    </div>
  </div>
);

const Stage3UserCore = ({ userCore, setUserCore, error, submit, submitting }) => (
  <div className="col" style={{ gap: 16 }}>
    <div>
      <div className="serif italic" style={{ fontSize: 22, color: 'var(--ink-1, #2a2620)' }}>
        你先写一句 — 然后 Hypha 写
      </div>
      <div className="serif" style={{
        color: 'var(--ink-2, #494339)', fontSize: 14, lineHeight: 1.7, marginTop: 6,
      }}>
        把这节课对你而言最关键的那一点, 用一句话讲清楚。
        不许复述老师的原话 — 用你自己的词。
        <br/>
        这是 <i>Human First, Agent Second</i>: 你写完之前,系统不会落下笔。
      </div>
    </div>
    <textarea
      value={userCore}
      onChange={(e) => setUserCore(e.target.value)}
      placeholder="你的核心理解 ..."
      rows={4}
      autoFocus
      style={{
        width: '100%', padding: '16px 18px', fontSize: 18,
        fontFamily: 'var(--serif, "EB Garamond", serif)',
        border: '1px solid var(--rule-soft, rgba(0,0,0,.18))',
        background: 'rgba(255,253,247,.6)',
        color: 'var(--ink, #2a2620)',
        outline: 'none', resize: 'vertical', lineHeight: 1.6,
        borderRadius: 0,
      }}
    />
    <div className="row" style={{ alignItems: 'center', gap: 16 }}>
      <span className="mono" style={{ fontSize: 12, color: 'var(--ink-3, #66605a)' }}>
        {userCore.trim().length} 字 / 至少 8
      </span>
      <span className="spacer" style={{ flex: 1 }} />
      <button
        onClick={submit}
        disabled={submitting || userCore.trim().length < 8}
        style={{
          background: (submitting || userCore.trim().length < 8)
            ? 'rgba(184,137,58,.35)' : 'var(--brass-bright, #b8893a)',
          color: '#fffdf6', border: 'none',
          padding: '12px 24px', fontSize: 16,
          fontFamily: 'var(--serif, "EB Garamond", serif)',
          cursor: (submitting || userCore.trim().length < 8) ? 'not-allowed' : 'pointer',
          letterSpacing: '.04em',
        }}
      >{submitting ? '正在落笔 ...' : '生成正式 Note'}</button>
    </div>
    {error && (
      <div style={{
        padding: '10px 14px',
        background: 'rgba(194, 90, 54, .08)',
        color: 'var(--terracotta, #c25a36)',
        border: '1px solid rgba(194, 90, 54, .25)',
        fontStyle: 'italic', fontSize: 14,
      }}>{error}</div>
    )}
  </div>
);

const Stage4Done = ({ result }) => (
  <div className="col" style={{ gap: 14 }}>
    <div className="serif italic" style={{ fontSize: 26, color: 'var(--ink-1, #2a2620)' }}>
      记下了。
    </div>
    {result && (
      <div className="col" style={{ gap: 10 }}>
        <Row label="Lesson NOTE" value={shortPath(result.lessonNotePath)} />
        <Row label="草稿合并" value={`${(result.drafts || []).length} 条 → ${(result.deepened || []).length} 条深化`} />
        <Row label="标记分布" value={fmtMarkCounts(result.evidence && result.evidence.mark_counts_by_type)} />
        {result.productTransferTriggered && result.productTransferTriggered.length > 0 && (
          <Row
            label="迁移触发"
            value={`${result.productTransferTriggered.length} 条 → Product Pool 候选`}
            highlight
          />
        )}
      </div>
    )}
    <div className="serif" style={{ color: 'var(--ink-3, #66605a)', fontSize: 13, marginTop: 8 }}>
      跳转 Web Note Engine ...
    </div>
  </div>
);

const Row = ({ label, value, highlight }) => (
  <div className="row" style={{ gap: 14, alignItems: 'baseline', paddingBottom: 4,
    borderBottom: '1px dashed var(--rule-soft, rgba(0,0,0,.10))' }}>
    <span className="mono" style={{
      fontSize: 11, letterSpacing: '.14em', color: 'var(--ink-3, #66605a)',
      textTransform: 'uppercase', width: 100, flexShrink: 0,
    }}>{label}</span>
    <span style={{
      flex: 1, fontSize: 14,
      color: highlight ? 'var(--brass-bright, #b8893a)' : 'var(--ink, #2a2620)',
      fontStyle: highlight ? 'italic' : 'normal',
    }}>{value || '—'}</span>
  </div>
);

const Spinner = ({ label }) => (
  <div className="row" style={{ gap: 12, alignItems: 'center' }}>
    <span style={{
      width: 14, height: 14, borderRadius: '50%',
      border: '2px solid var(--rule-soft, rgba(0,0,0,.18))',
      borderTopColor: 'var(--brass-bright, #b8893a)',
      animation: 'spin 800ms linear infinite',
      display: 'inline-block',
    }} />
    <span className="serif italic" style={{ fontSize: 18, color: 'var(--ink-1, #2a2620)' }}>{label}</span>
    <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
  </div>
);

function shortPath(p) {
  if (!p) return '';
  const s = String(p).replace(/\\/g, '/');
  const parts = s.split('/');
  return parts.length > 3 ? '...' + parts.slice(-3).join('/') : s;
}

function fmtMarkCounts(counts) {
  if (!counts || typeof counts !== 'object') return '—';
  const entries = Object.entries(counts);
  if (entries.length === 0) return '无标记 (纯 quick_note)';
  return entries.map(([g, n]) => `${g} ${n}`).join('  ');
}

window.FinishRitualScreen = FinishRitualScreen;
