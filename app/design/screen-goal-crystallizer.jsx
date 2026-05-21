/* global React */
// HYPHA · GoalCrystallizerScreen — Phase F.1 (2026-05-18)
//
// Wizard between onboarding submit and chain:create. Turns a fog DRAFT goal
// ("我要成为诺贝尔文学作家") into a SPECIFIC + VERIFIABLE crystallized goal
// via 3-5 multi-choice questions. Each Q has 4 options (D always
// "其他/自己写" inline-expand text field). When all answered, synthesizes
// + shows preview card. User confirms → onConfirm({crystallized_goal, tags}).
//
// Backend already shipped (F.0, 35/35 smoke PASS):
//   window.ptor.hypha.goalCrystallizeQuestions(draftGoal, archetype) → {ok, questions, confidence}
//   window.ptor.hypha.goalCrystallizeSynthesize(draftGoal, archetype, answers) → {ok, crystallized_goal, tags, confidence, notes}
//
// Design lead: Muse (千金 sensibility, accordion-progressive Model C).
// Register: brass (--ochre/--ochre-2) sole chromatic anchor; italic Garamond
// = decoration only; action labels MUST roman; no progress bar; full-band
// skip footer (tokonoma pattern); no celebration micro-copy; errors render
// inline (! silent catch).

const { useState, useEffect, useCallback, useRef } = React;

const QUESTION_TIMEOUT_MS = 30000;

window.GoalCrystallizerScreen = function GoalCrystallizerScreen({
  draftGoal,
  archetype,
  onConfirm,
  onSkip,
  onCancel,
}) {
  const [questions, setQuestions]   = useState(null);     // null = loading, [] = error/zero
  const [answers, setAnswers]       = useState({});        // {qid: {chosen_option: 'a'|'b'|..., chosen_label, implies, custom_text?}}
  const [step, setStep]             = useState(0);         // index of current question
  const [loadingQ, setLoadingQ]     = useState(true);
  const [loadError, setLoadError]   = useState(null);
  const [synthesizing, setSynth]    = useState(false);
  const [synthError, setSynthError] = useState(null);
  const [preview, setPreview]       = useState(null);      // {crystallized_goal, tags, confidence, notes}
  const [revisitWarn, setRevisitWarn] = useState(null);    // qid currently flagged for re-edit warning
  // Phase G.2 (2026-05-18) — 2-stage wizard: broad (3) → deep (5).
  // `deepLoaded` gates synthesize until either deep questions appended OR
  // followup fetch failed (in which case we proceed with broad-only).
  const [deepLoaded, setDeepLoaded] = useState(false);
  const [loadingDeep, setLoadingDeep] = useState(false);
  const [deepError, setDeepError] = useState(null);

  const arch = (archetype && typeof archetype === 'string') ? archetype : 'HUMANITIES';

  // ── Initial load: fetch questions once on mount ────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!window.ptor || !window.ptor.hypha || typeof window.ptor.hypha.goalCrystallizeQuestions !== 'function') {
        if (!cancelled) {
          setLoadError('IPC 未连接 — 多半是 HYPHA 更新后未重启 · 请完全退出再 npm start · 或点下方"跳过, 直接生成"绕过');
          setLoadingQ(false);
        }
        return;
      }
      try {
        const r = await window.ptor.hypha.goalCrystallizeQuestions(draftGoal, arch);
        if (cancelled) return;
        if (r && r.ok && Array.isArray(r.questions) && r.questions.length > 0) {
          setQuestions(r.questions);
          setLoadingQ(false);
        } else {
          setLoadError((r && r.error) || '没拿到问题, 可直接跳过');
          setLoadingQ(false);
        }
      } catch (err) {
        if (cancelled) return;
        setLoadError((err && err.message) || '加载失败');
        setLoadingQ(false);
      }
    })();
    return () => { cancelled = true; };
  }, [draftGoal, arch]);

  // ── Phase G.2: when broad answered, fetch 5 deep follow-up Q + append ──
  // This effect fires when all CURRENT questions are answered AND deep not yet
  // loaded. It calls goalCrystallizeFollowup → appends 5 deep Q to `questions`.
  // After this, the synthesize effect sees 8 questions with 3 answered + 5
  // unanswered → it waits until user finishes deep. If IPC fails, we set
  // deepLoaded=true anyway (proceed with broad-only synth) + show advisory.
  useEffect(() => {
    if (!questions || questions.length === 0) return;
    if (deepLoaded || loadingDeep) return;
    const allCurrentAnswered = questions.every(q => answers[q.id] && _answerValid(answers[q.id]));
    if (!allCurrentAnswered) return;

    let cancelled = false;
    (async () => {
      setLoadingDeep(true);
      setDeepError(null);
      try {
        if (!window.ptor || !window.ptor.hypha || typeof window.ptor.hypha.goalCrystallizeFollowup !== 'function') {
          // No IPC bridge → skip deep, proceed with broad-only synth.
          if (!cancelled) {
            setDeepError('深入问题通道未连接 — 用 3 题直生');
            setDeepLoaded(true);
            setLoadingDeep(false);
          }
          return;
        }
        const broadAnswers = questions.map(q => {
          const a = answers[q.id] || {};
          return {
            question: q.prompt,
            dimension: q.dimension,
            chosen_label: a.custom_text ? a.custom_text : a.chosen_label,
            implies: a.implies,
          };
        });
        const r = await window.ptor.hypha.goalCrystallizeFollowup(draftGoal, arch, broadAnswers);
        if (cancelled) return;
        if (r && r.ok && Array.isArray(r.questions) && r.questions.length > 0) {
          // Append deep questions; do NOT reset step or answers.
          setQuestions(prev => Array.isArray(prev) ? [...prev, ...r.questions] : r.questions);
          setDeepLoaded(true);
          setLoadingDeep(false);
          // Advance step to first deep Q so QuestionCard shows it.
          setStep(prev => Math.max(prev, (questions || []).length));
        } else {
          setDeepError((r && r.error) || '深入问题生成失败, 用 3 题直生');
          setDeepLoaded(true);
          setLoadingDeep(false);
        }
      } catch (err) {
        if (cancelled) return;
        setDeepError((err && err.message) || '深入问题加载异常, 用 3 题直生');
        setDeepLoaded(true);
        setLoadingDeep(false);
      }
    })();
    return () => { cancelled = true; };
    // `loadingDeep` MUST NOT be in deps: same pattern as the synth-effect bug
    // (loadingDeep flips inside effect → cleanup → cancelled → setDeepLoaded
    // never runs → wizard stuck waiting). Guard reads loadingDeep via closure.
  }, [questions, answers, deepLoaded, draftGoal, arch]);

  // ── When all answered AND deep loaded, auto-fire synthesize ──────────
  useEffect(() => {
    if (!questions || questions.length === 0) return;
    if (!deepLoaded) return;  // wait for followup (or its failure) before synth
    const allAnswered = questions.every(q => answers[q.id] && _answerValid(answers[q.id]));
    if (!allAnswered || synthesizing || preview) return;

    let cancelled = false;
    let timeoutId = null;
    (async () => {
      setSynth(true);
      setSynthError(null);
      timeoutId = setTimeout(() => {
        if (cancelled) return;
        setSynthError('合成超时, 请重试');
        setSynth(false);
      }, QUESTION_TIMEOUT_MS);
      try {
        if (!window.ptor || !window.ptor.hypha || typeof window.ptor.hypha.goalCrystallizeSynthesize !== 'function') {
          throw new Error('synthesize 通道未连接');
        }
        const payload = questions.map(q => {
          const a = answers[q.id] || {};
          return {
            question: q.prompt,
            dimension: q.dimension,
            chosen_label: a.custom_text ? a.custom_text : a.chosen_label,
            implies: a.implies,
          };
        });
        const r = await window.ptor.hypha.goalCrystallizeSynthesize(draftGoal, arch, payload);
        if (cancelled) return;
        clearTimeout(timeoutId);
        if (r && r.ok && r.crystallized_goal) {
          setPreview({
            crystallized_goal: r.crystallized_goal,
            tags: r.tags || {},
            confidence: r.confidence,
            notes: r.notes,
          });
          setSynth(false);
        } else {
          setSynthError((r && r.error) || '合成返回为空');
          setSynth(false);
        }
      } catch (err) {
        if (cancelled) return;
        if (timeoutId) clearTimeout(timeoutId);
        setSynthError((err && err.message) || '合成失败');
        setSynth(false);
      }
    })();
    return () => { cancelled = true; if (timeoutId) clearTimeout(timeoutId); };
    // `synthesizing` MUST NOT be in deps: it flips inside the effect itself,
    // which would re-trigger the effect and run the cleanup → setting the
    // in-flight closure's `cancelled = true` so the resolution short-circuits
    // and `setSynth(false)` never runs. Wizard would hang on the pulse forever.
    // The guard `!allAnswered || synthesizing || preview` on entry already
    // prevents double-fire; React-hooks/exhaustive-deps disagreement here is
    // intentional. Bug repro 2026-05-18: "卡在 synthesizing your map…".
    // Phase G.2: also gate on deepLoaded — synth must wait until followup
    // either succeeded (8 Q in questions) or failed (deepError set, broad-only).
  }, [answers, questions, draftGoal, arch, preview, deepLoaded]);

  // ── Answer handlers ────────────────────────────────────────────────
  const recordAnswer = useCallback((q, optId, custom_text) => {
    const opt = q.options.find(o => o.id === optId);
    if (!opt) return;
    const isCustomD = opt.implies === 'custom-input';
    if (isCustomD && (!custom_text || !custom_text.trim())) {
      // pulse handled by chip itself via local state; ! commit without text
      return;
    }
    setAnswers(prev => {
      // Determine if we're re-editing a previously-answered question.
      // If so, drop all answers AT OR AFTER this question's step so trailing
      // dimensions are re-asked — per Muse spec re-edit warning.
      const qIdx = (questions || []).findIndex(qq => qq.id === q.id);
      const next = { ...prev };
      // Re-edit: clear downstream
      if (next[q.id] && qIdx >= 0) {
        (questions || []).forEach((qq, i) => {
          if (i > qIdx) delete next[qq.id];
        });
      }
      next[q.id] = {
        chosen_option: optId,
        chosen_label: opt.label,
        implies: isCustomD ? `custom:${custom_text.trim()}` : opt.implies,
        custom_text: isCustomD ? custom_text.trim() : undefined,
      };
      return next;
    });
    setRevisitWarn(null);
    // Advance step if this question was the current one and we have more
    const qIdx = (questions || []).findIndex(qq => qq.id === q.id);
    if (qIdx >= 0 && qIdx === step && qIdx < (questions || []).length - 1) {
      setStep(qIdx + 1);
    }
    if (preview) setPreview(null);
  }, [questions, step, preview]);

  const reopenAnswered = useCallback((qIdx) => {
    if (!questions) return;
    setRevisitWarn(questions[qIdx].id);
  }, [questions]);

  const confirmRevisit = useCallback((qIdx) => {
    if (!questions) return;
    setStep(qIdx);
    setRevisitWarn(null);
    setPreview(null);
  }, [questions]);

  const cancelRevisit = useCallback(() => setRevisitWarn(null), []);

  const retrySynth = useCallback(() => {
    setSynthError(null);
    // Re-fire effect by nudging: clear answers state ref via shallow copy
    setAnswers(prev => ({ ...prev }));
  }, []);

  const retryLoad = useCallback(() => {
    // Guard: retry useless if IPC bridge itself is missing (preload not loaded).
    // Tell user the truth instead of pretending we'll retry. Skip button still works.
    if (!window.ptor || !window.ptor.hypha || typeof window.ptor.hypha.goalCrystallizeQuestions !== 'function') {
      setLoadError('IPC 未连接 — 多半是 HYPHA 更新后未重启 · 请完全退出再 npm start · 或点下方"跳过, 直接生成"绕过');
      return;
    }
    setLoadError(null);
    setLoadingQ(true);
    setQuestions(null);
    (async () => {
      try {
        const r = await window.ptor.hypha.goalCrystallizeQuestions(draftGoal, arch);
        if (r && r.ok && Array.isArray(r.questions) && r.questions.length > 0) {
          setQuestions(r.questions);
          setLoadingQ(false);
        } else {
          setLoadError((r && r.error) || '没拿到问题, 可直接跳过');
          setLoadingQ(false);
        }
      } catch (err) {
        setLoadError((err && err.message) || '加载失败');
        setLoadingQ(false);
      }
    })();
  }, [draftGoal, arch]);

  // ── Layout ─────────────────────────────────────────────────────────
  const wrapStyle = {
    maxWidth: 760,
    margin: '0 auto',
    padding: '48px 32px',
    display: 'flex',
    flexDirection: 'column',
    gap: 24,
  };

  return (
    <div style={wrapStyle}>
      <EyebrowBanner draftGoal={draftGoal} />

      {loadingQ && (
        <div className="serif" style={{ fontStyle: 'italic', fontSize: 13, color: 'var(--ink-3)' }}>
          正在为你的目标准备问题…
        </div>
      )}

      {loadError && (
        <InlineError message={loadError} onRetry={retryLoad} />
      )}

      {Array.isArray(questions) && questions.length > 0 && !preview && (
        <>
          <DimensionTrace
            questions={questions}
            answers={answers}
            currentStep={step}
            revisitWarn={revisitWarn}
            onReopen={reopenAnswered}
            onConfirmRevisit={confirmRevisit}
            onCancelRevisit={cancelRevisit}
          />

          {step < questions.length && (
            // key={question.id} forces React to remount QuestionCard on step
            // change. Without this, the same component instance is reused
            // across questions → internal state (customText / customExpanded /
            // pulseD) leaks from Q_N into Q_N+1. User repro 2026-05-18: 第 4 题
            // D-option 输入 + 锁定 → step 推进到第 5 题, 但 customExpanded=true
            // 残留, 上一答案文字仍显在新题的 CustomInputInline.
            <QuestionCard
              key={questions[step].id}
              question={questions[step]}
              step={step}
              total={questions.length}
              existingAnswer={answers[questions[step].id]}
              onAnswer={(optId, custom) => recordAnswer(questions[step], optId, custom)}
            />
          )}

          <UpcomingTrail questions={questions} answers={answers} step={step} />

          {loadingDeep && (
            <div className="serif" style={{ fontStyle: 'italic', fontSize: 13, color: 'var(--ink-3)', marginTop: 4 }}>
              基于你前 3 答, 正在加深问题…
            </div>
          )}
          {deepError && (
            <div className="serif" style={{ fontStyle: 'italic', fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>
              · {deepError}
            </div>
          )}
          {synthesizing && <SynthesizingPulse />}
          {synthError && <InlineError message={synthError} onRetry={retrySynth} />}
        </>
      )}

      {preview && (
        <CrystallizedPreview
          preview={preview}
          onConfirm={() => onConfirm({
            crystallized_goal: preview.crystallized_goal,
            tags: preview.tags,
            skipped: false,
          })}
          onEdit={() => setPreview(null)}
        />
      )}

      {/* Footer: cancel (top-left ghost) + skip (full band, tokonoma) */}
      <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 4 }}>
        <button
          type="button"
          onClick={onCancel}
          className="serif"
          style={{
            padding: '8px 18px',
            background: 'transparent',
            border: '1px solid var(--rule-soft)',
            color: 'var(--ink-3)',
            fontStyle: 'italic',
            fontSize: 14,
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          返回修改目标
        </button>
      </div>

      <SkipBand onSkip={() => onConfirm({
        crystallized_goal: draftGoal,
        tags: null,
        skipped: true,
      })} />
    </div>
  );
};

// ─── EyebrowBanner — lift from library-gate, same register ─────────
function EyebrowBanner({ draftGoal }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="mono" style={{ fontSize: 11, letterSpacing: '.14em', color: 'var(--ink-3)', textTransform: 'uppercase' }}>
        goal crystallizer
      </div>
      <div className="serif" style={{ fontStyle: 'italic', fontSize: 28, fontWeight: 400, color: 'var(--ink)', lineHeight: 1.3 }}>
        Before we draw the map.
      </div>
      <div className="serif" style={{ fontStyle: 'italic', fontSize: 18, color: 'var(--ink-2)', paddingLeft: 16, borderLeft: '2px solid var(--ochre-2)', margin: '4px 0' }}>
        {draftGoal || '(no draft)'}
      </div>
      <div className="serif" style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 4 }}>
        切清几个维度之前, 这句话太大了, 课程会失焦.
      </div>
    </div>
  );
}

// ─── DimensionTrace — answered cards collapse to italic stanza ─────
function DimensionTrace({ questions, answers, currentStep, revisitWarn, onReopen, onConfirmRevisit, onCancelRevisit }) {
  const answeredRows = questions
    .map((q, i) => ({ q, i, a: answers[q.id] }))
    .filter(r => r.a && r.i < currentStep);
  if (answeredRows.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}>
      {answeredRows.map(({ q, i, a }) => {
        const isWarn = revisitWarn === q.id;
        return (
          <div key={q.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <button
              type="button"
              onClick={() => onReopen(i)}
              className="serif"
              style={{
                display: 'flex', alignItems: 'baseline', gap: 12,
                padding: '6px 12px 6px 14px',
                background: 'transparent',
                border: 'none',
                borderLeft: '3px solid var(--ochre-2)',
                fontStyle: 'italic',
                fontSize: 13,
                color: 'var(--ink-3)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span>{q.dimension || q.prompt}</span>
              <span style={{ color: 'var(--ink-2)' }}>·</span>
              <span style={{ color: 'var(--ink-2)' }}>{a.custom_text ? a.custom_text : a.chosen_label}</span>
            </button>
            {isWarn && (
              <div className="serif" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '4px 14px', fontStyle: 'italic', fontSize: 12, color: 'var(--ink-3)' }}>
                <span>改这一题会重置后面 {questions.length - 1 - i} 题</span>
                <button type="button" onClick={() => onConfirmRevisit(i)} className="serif" style={{ background: 'transparent', border: 'none', color: 'var(--ochre-2)', fontStyle: 'normal', fontSize: 12, cursor: 'pointer', padding: 0 }}>继续改</button>
                <button type="button" onClick={onCancelRevisit} className="serif" style={{ background: 'transparent', border: 'none', color: 'var(--ink-3)', fontStyle: 'italic', fontSize: 12, cursor: 'pointer', padding: 0 }}>算了</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── QuestionCard — current question + 4 chips ─────────────────────
function QuestionCard({ question, step, total, existingAnswer, onAnswer }) {
  const [customText, setCustomText] = useState(existingAnswer && existingAnswer.custom_text ? existingAnswer.custom_text : '');
  const [customExpanded, setCustomExpanded] = useState(false);
  const [pulseD, setPulseD] = useState(false);

  const opts = Array.isArray(question.options) ? question.options : [];

  const handleChipClick = (opt) => {
    if (opt.implies === 'custom-input') {
      setCustomExpanded(true);
      return;
    }
    setCustomExpanded(false);
    onAnswer(opt.id);
  };

  const handleCommitCustom = () => {
    if (!customText.trim()) {
      setPulseD(true);
      setTimeout(() => setPulseD(false), 240);
      return;
    }
    const dOpt = opts.find(o => o.implies === 'custom-input');
    if (dOpt) onAnswer(dOpt.id, customText.trim());
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '20px 4px 8px' }}>
      <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', letterSpacing: '.08em' }}>
        [{step + 1}/{total}] · {question.dimension || ''}
      </div>
      <div className="serif" style={{ fontSize: 26, color: 'var(--ink)', lineHeight: 1.25 }}>
        {question.prompt}
      </div>
      {question.rationale && (
        <div className="serif" style={{ fontStyle: 'italic', fontSize: 13, color: 'var(--ink-3)' }}>
          {question.rationale}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 6 }}>
        {opts.map((opt) => {
          const isD = opt.implies === 'custom-input';
          const selected = existingAnswer && existingAnswer.chosen_option === opt.id && !customExpanded;
          return (
            <OptionChip
              key={opt.id}
              label={opt.label}
              selected={selected}
              isCustomD={isD}
              pulseError={isD && pulseD}
              onClick={() => handleChipClick(opt)}
            />
          );
        })}
      </div>
      {customExpanded && (
        <CustomInputInline
          value={customText}
          onChange={setCustomText}
          onCommit={handleCommitCustom}
        />
      )}
    </div>
  );
}

// ─── OptionChip — A/B/C/D, all roman serif ─────────────────────────
function OptionChip({ label, selected, isCustomD, pulseError, onClick }) {
  const [hover, setHover] = useState(false);
  const borderColor = pulseError ? 'var(--terracotta)' : (selected || hover) ? 'var(--ochre)' : 'var(--rule-soft)';
  const bg = selected ? 'rgba(209,138,46,0.10)' : hover ? 'rgba(209,138,46,0.05)' : 'transparent';
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="serif"
      style={{
        padding: '12px 14px',
        background: bg,
        border: '1px solid var(--rule-soft)',
        borderLeft: `3px solid ${borderColor}`,
        color: 'var(--ink)',
        fontSize: 15,
        textAlign: 'left',
        cursor: 'pointer',
        borderRadius: 4,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        transition: 'background 160ms, border-left-color 160ms',
        fontWeight: 400,
      }}
    >
      <span style={{ flex: 1 }}>{label}</span>
      {isCustomD && <span style={{ color: 'var(--ink-3)' }}>›</span>}
    </button>
  );
}

// ─── CustomInputInline — D-option text field ──────────────────────
function CustomInputInline({ value, onChange, onCommit }) {
  const inputRef = useRef(null);
  useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);
  return (
    <div style={{ display: 'flex', gap: 10, marginTop: 4, alignItems: 'stretch' }}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, 80))}
        onKeyDown={(e) => { if (e.key === 'Enter') onCommit(); }}
        // intentional-placeholder: standard HTML <input> placeholder attribute is the form-input hint shown when field is empty, NOT an unfinished-code marker. Required for D-option custom-text inline expand per Muse design spec.
        placeholder="自己写一句, ≤30 字"
        className="serif"
        style={{
          flex: 1,
          padding: '10px 14px',
          border: '1px solid var(--rule)',
          borderRadius: 4,
          fontSize: 15,
          fontFamily: 'var(--serif)',
          fontStyle: 'italic',
          background: 'rgba(255,255,255,0.5)',
          color: 'var(--ink)',
          outline: 'none',
        }}
      />
      <button
        type="button"
        onClick={onCommit}
        className="serif"
        style={{
          padding: '0 18px',
          border: '1px solid var(--ochre)',
          background: 'transparent',
          color: 'var(--ink)',
          fontSize: 14,
          cursor: 'pointer',
          borderRadius: 4,
          fontWeight: 400,
        }}
      >
        锁定
      </button>
    </div>
  );
}

// ─── UpcomingTrail — what's still ahead, marginalia register ──────
function UpcomingTrail({ questions, answers, step }) {
  const upcoming = questions
    .map((q, i) => ({ q, i, a: answers[q.id] }))
    .filter(r => r.i > step && !r.a);
  if (upcoming.length === 0) return null;
  return (
    <div className="serif" style={{ fontStyle: 'italic', fontSize: 12, color: 'var(--ink-4)', display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
      {upcoming.map(({ q, i }) => (
        <React.Fragment key={q.id}>
          <span>·</span>
          <span>{q.dimension || `Q${i + 1}`}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

// ─── SynthesizingPulse — brass dot pulse + mono text, no spinner ──
function SynthesizingPulse() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '20px 4px' }}>
      <span style={{
        display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
        background: 'var(--ochre)',
        animation: 'hyphaCrystallizerPulse 1.4s linear infinite',
      }} />
      <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', letterSpacing: '.06em' }}>
        synthesizing your map…
      </span>
      <style>{`@keyframes hyphaCrystallizerPulse { 0%{opacity:.3} 50%{opacity:1} 100%{opacity:.3} }`}</style>
    </div>
  );
}

// ─── CrystallizedPreview — cream card + brass top hairline ────────
function CrystallizedPreview({ preview, onConfirm, onEdit }) {
  const tags = preview.tags || {};
  const tagRows = [
    ['primary_focus', 'primary focus'],
    ['output_form', 'output form'],
    ['timeline', 'timeline'],
    ['current_level', 'current level'],
    ['scale', 'scale'],
    ['domain', 'domain'],
  ].filter(([k]) => tags[k] && String(tags[k]).trim());
  const milestones = Array.isArray(tags.milestones) ? tags.milestones : [];
  return (
    <div style={{
      background: 'rgba(232,196,176,0.10)',
      borderTop: '1px solid var(--ochre)',
      padding: '24px 28px',
      display: 'flex',
      flexDirection: 'column',
      gap: 18,
    }}>
      <div className="mono" style={{ fontSize: 11, letterSpacing: '.14em', color: 'var(--ink-3)', textTransform: 'uppercase', display: 'flex', justifyContent: 'space-between' }}>
        <span>crystallized goal</span>
        {tags.niche_factor && (
          <span style={{ letterSpacing: '.06em' }}>niche · {tags.niche_factor}</span>
        )}
      </div>
      <div className="serif" style={{ fontStyle: 'italic', fontSize: 22, color: 'var(--ink)', lineHeight: 1.4 }}>
        {preview.crystallized_goal}
      </div>

      {tagRows.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 6, columnGap: 12, marginTop: 4 }}>
          {tagRows.map(([k, label]) => (
            <React.Fragment key={k}>
              <div className="serif" style={{ fontStyle: 'italic', fontSize: 13, color: 'var(--ink-3)' }}>{label}</div>
              <div className="serif" style={{ fontSize: 13, color: 'var(--ink-2)' }}>{String(tags[k])}</div>
            </React.Fragment>
          ))}
        </div>
      )}

      {milestones.length > 0 && (
        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid var(--rule-soft)', paddingTop: 12 }}>
          <div className="serif" style={{ fontStyle: 'italic', fontSize: 13, color: 'var(--ink-3)' }}>milestones</div>
          {milestones.map((m, i) => (
            <div key={i} className="serif" style={{ fontSize: 13, color: 'var(--ink-2)', paddingLeft: 12 }}>· {m}</div>
          ))}
        </div>
      )}

      {preview.notes && (
        <div className="serif" style={{ fontStyle: 'italic', fontSize: 12, color: 'var(--ink-3)', borderTop: '1px solid var(--rule-soft)', paddingTop: 10 }}>
          {preview.notes}
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 6 }}>
        <button
          type="button"
          onClick={onEdit}
          className="serif"
          style={{
            padding: '8px 18px',
            background: 'transparent',
            border: '1px solid var(--rule-soft)',
            color: 'var(--ink-2)',
            fontStyle: 'italic',
            fontSize: 14,
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          再调一下
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="serif"
          style={{
            padding: '10px 22px',
            background: 'var(--ink)',
            color: 'var(--paper)',
            border: '1px solid var(--ink)',
            fontSize: 15,
            borderRadius: 4,
            cursor: 'pointer',
            fontWeight: 400,
          }}
        >
          用这个版本继续
        </button>
      </div>
    </div>
  );
}

// ─── SkipBand — full-band footer, tokonoma pattern ────────────────
function SkipBand({ onSkip }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onSkip}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="serif"
      style={{
        width: '100%',
        padding: '20px 28px',
        background: hover ? 'rgba(209,138,46,0.04)' : 'transparent',
        border: 'none',
        borderTop: hover ? '1px solid var(--ochre)' : '1px solid var(--rule-soft)',
        textAlign: 'left',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        cursor: 'pointer',
        marginTop: 12,
        transition: 'background 200ms, border-top-color 200ms',
      }}
    >
      <div style={{ fontSize: 14, color: 'var(--ink-2)', fontWeight: 400 }}>
        跳过这步, 直接生成
      </div>
      <div style={{ fontStyle: 'italic', fontSize: 12, color: 'var(--ink-3)' }}>
        你的草稿原样进入下一步. 课程稳度会更低.
      </div>
    </button>
  );
}

// ─── InlineError — renders, never silent (per silent_catch feedback) ─
function InlineError({ message, onRetry }) {
  return (
    <div className="serif" style={{ display: 'flex', alignItems: 'baseline', gap: 14, padding: '12px 16px', background: 'rgba(194,90,54,0.06)', borderLeft: '3px solid var(--terracotta)' }}>
      <div style={{ fontStyle: 'italic', fontSize: 13, color: 'var(--ink-2)', flex: 1 }}>
        {message}
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="serif"
          style={{ padding: '4px 12px', background: 'transparent', border: '1px solid var(--terracotta)', color: 'var(--ink)', fontSize: 13, cursor: 'pointer', borderRadius: 3 }}
        >
          重试
        </button>
      )}
    </div>
  );
}

// ─── helpers ──────────────────────────────────────────────────────
function _answerValid(a) {
  if (!a || typeof a !== 'object') return false;
  if (a.custom_text !== undefined) return Boolean(a.custom_text && a.custom_text.trim());
  return Boolean(a.chosen_option && a.chosen_label);
}
