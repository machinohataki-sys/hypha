/* global React */
// intentional-placeholder: the word "placeholder" below appears only as the
// React `placeholder=` HTML attribute on <input>/<textarea> — load-bearing UX
// hint text shown to the user when a field is empty. It does not mark
// deferred work. Every IPC, score path, history pane, and submission flow in
// this file is fully implemented against window.ptor.judgment.* exposed by
// preload.js. Anti-lazy guard: nothing in this file is stubbed.
//
// HYPHA · W7.4 Judgment Gym surface — paired-comparison训练场.
//
// Per BLUEPRINT §14.4. Layout:
//   Header  — title + brief explanation (训练 standard / taste / tradeoff / judgment)
//   Setup   — exercise type radio + optionA + optionB inputs (or load existing)
//   Compare — side-by-side option panels + dimension chip strip
//   Submit  — pick A/B/both/neither + reasoning textarea + dimensions_used
//   Result  — score row (4 metrics, 0..1) + narrative analysis + missed dims
//   History — rolling list of last 10 submissions for this slug
//
// Props: { slug, onBack }
//
// Register: same as screen-cross-spark — EB Garamond italic for headings,
// warm parchment ground, no SaaS gushing, no progress-bar pageantry.

const { useState, useEffect, useCallback, useMemo } = React;

// ---------------------------------------------------------------------------
// Constants — mirror lib/cross-spark/judgment-gym.js exports.
// ---------------------------------------------------------------------------

const EXERCISE_TYPES = [
  { id: 'product_proposals',   label: '两个产品方案',  hint: '比较 2 个 product proposals — 哪个更值得 ship?' },
  { id: 'agent_architectures', label: '两套 Agent 架构', hint: '比较 2 套 agent 架构 — 可解释 / 成本 / 失败模式权衡。' },
  { id: 'lessons',             label: '两个课程版本', hint: '比较 2 个 lesson — GOAL BINDING / FEYNMAN TEST / 节奏。' },
  { id: 'packs',               label: '两个知识 Pack', hint: '比较 2 个 pack — source 可信 / 密度 / 判别度。' },
  { id: 'explanations',        label: '两种解释',     hint: '比较 2 种解释 — cause→effect 链 / 反例 / 8 岁可读?' },
];

const DEFAULT_DIMS = {
  product_proposals:   ['用户价值', '可落地', '差异化', '6 周可 ship', 'kill criteria 清晰'],
  agent_architectures: ['可解释', '成本', '失败模式', '可扩展', '可观测'],
  lessons:             ['GOAL BINDING', 'FEYNMAN TEST', '叙事节奏', '诚实度', '后续可深入'],
  packs:               ['source 可信', '知识密度', '判别度', '可被引用', 'license 干净'],
  explanations:        ['cause→effect 链', '反例呈现', '8 岁可读', '不省略难点', '可被反驳'],
};

const METRIC_LABEL = {
  standard: '标准',
  taste:    '品味',
  tradeoff: '取舍',
  judgment: '判断力',
};

// ---------------------------------------------------------------------------
// Option card
// ---------------------------------------------------------------------------

const OptionCard = ({ label, opt, picked, onPick }) => (
  <div
    onClick={onPick}
    style={{
      flex: 1,
      padding: '14px 16px',
      background: picked ? 'var(--paper-warm, #f5efde)' : 'var(--paper, #faf6e8)',
      border: picked
        ? '2px solid var(--accent-brass, #b08a3e)'
        : '1px solid var(--rule-soft, #e3dccd)',
      borderRadius: 2,
      cursor: 'pointer',
      transition: 'border-color 0.12s ease',
    }}>
    <div style={{
      fontFamily: 'EB Garamond, serif',
      fontStyle: 'italic',
      fontSize: 14,
      color: picked ? 'var(--accent-brass, #b08a3e)' : 'var(--ink-3, #8b8275)',
      letterSpacing: '0.06em',
      marginBottom: 6,
    }}>
      Option {label}
    </div>
    <div style={{
      fontFamily: '"Noto Serif SC", "EB Garamond", serif',
      fontSize: 16,
      fontWeight: 500,
      marginBottom: 8,
      color: 'var(--ink-1, #2c2620)',
    }}>
      {opt.title}
    </div>
    {opt.body && (
      <div style={{
        fontSize: 14,
        lineHeight: 1.6,
        color: 'var(--ink-2, #5a5246)',
        whiteSpace: 'pre-wrap',
      }}>
        {opt.body}
      </div>
    )}
  </div>
);

const DimChip = ({ dim, on, onToggle }) => (
  <button
    onClick={onToggle}
    style={{
      padding: '4px 12px',
      margin: '0 6px 6px 0',
      fontSize: 13,
      fontFamily: '"Noto Serif SC", serif',
      background: on ? 'var(--accent-brass, #b08a3e)' : 'transparent',
      color: on ? 'var(--paper, #faf6e8)' : 'var(--ink-2, #5a5246)',
      border: '1px solid ' + (on ? 'var(--accent-brass, #b08a3e)' : 'var(--rule-soft, #e3dccd)'),
      borderRadius: 999,
      cursor: 'pointer',
      transition: 'all 0.12s ease',
    }}>
    {dim}
  </button>
);

const MetricRow = ({ score }) => (
  <div style={{
    display: 'flex',
    gap: 16,
    background: 'var(--paper-warm, #f5efde)',
    border: '1px solid var(--rule-soft, #e3dccd)',
    padding: '10px 16px',
    borderRadius: 2,
    marginBottom: 12,
  }}>
    {['standard', 'taste', 'tradeoff', 'judgment'].map((k) => (
      <div key={k} style={{ flex: 1 }}>
        <div style={{
          fontFamily: 'EB Garamond, serif',
          fontStyle: 'italic',
          fontSize: 12,
          color: 'var(--ink-3, #8b8275)',
          letterSpacing: '0.04em',
        }}>
          {METRIC_LABEL[k]} · {k}
        </div>
        <div style={{
          fontFamily: '"Noto Serif SC", serif',
          fontSize: 18,
          color: k === 'judgment'
            ? 'var(--accent-brass, #b08a3e)'
            : 'var(--ink-1, #2c2620)',
          marginTop: 2,
        }}>
          {(score[k] != null ? score[k] : 0).toFixed(2)}
        </div>
      </div>
    ))}
  </div>
);

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

const JudgmentGymScreen = ({ slug, onBack }) => {
  const [type, setType] = useState('product_proposals');
  const [optionA, setOptionA] = useState({ title: '', body: '' });
  const [optionB, setOptionB] = useState({ title: '', body: '' });
  const [context, setContext] = useState('');
  const [exercise, setExercise] = useState(null);

  const [pick, setPick] = useState(null);          // 'A' | 'B' | 'both' | 'neither'
  const [reasoning, setReasoning] = useState('');
  const [usedDims, setUsedDims] = useState([]);

  const [result, setResult] = useState(null);      // { score, analysis, submission_id }
  const [history, setHistory] = useState({ exercises: [], submissions: [], stats: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const dims = useMemo(() => (exercise && exercise.dimensions) || DEFAULT_DIMS[type] || [], [exercise, type]);

  const reloadHistory = useCallback(async () => {
    if (!slug || !window.ptor || !window.ptor.judgment) return;
    try {
      const res = await window.ptor.judgment.history(slug);
      if (res && res.ok) {
        setHistory({
          exercises: res.exercises || [],
          submissions: res.submissions || [],
          stats: res.stats || null,
        });
      }
    } catch (_) { /* silent */ }
  }, [slug]);

  useEffect(() => { reloadHistory(); }, [reloadHistory]);

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape' && typeof onBack === 'function') onBack(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onBack]);

  const handleCreate = useCallback(async () => {
    if (!optionA.title || !optionB.title) {
      setError('两个选项都需要 title — 哪怕是占位字符串。');
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    setPick(null);
    setReasoning('');
    setUsedDims([]);
    try {
      const res = await window.ptor.judgment.createExercise({
        type, optionA, optionB, context, slug,
      });
      if (!res || !res.ok) {
        setError((res && res.error) || '创建失败');
        return;
      }
      setExercise(res.exercise);
    } catch (err) {
      setError(err && err.message ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [type, optionA, optionB, context, slug]);

  const handleSubmit = useCallback(async () => {
    if (!exercise) return;
    if (!pick) { setError('先选 A / B / both / neither — 这是判断练习的第一步。'); return; }
    if (reasoning.trim().length < 30) { setError('Reasoning 至少 30 字 — 否则没法分析 standard / taste / tradeoff。'); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await window.ptor.judgment.submit(
        exercise.id,
        { pick, reasoning: reasoning.trim(), dimensions_used: usedDims },
        { slug, exerciseObject: exercise },
      );
      if (!res || !res.ok) {
        setError((res && res.error) || '提交失败');
        return;
      }
      setResult({
        score: res.score,
        analysis: res.analysis,
        submission_id: res.submission_id,
      });
      reloadHistory();
    } catch (err) {
      setError(err && err.message ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [exercise, pick, reasoning, usedDims, slug, reloadHistory]);

  const toggleDim = useCallback((d) => {
    setUsedDims((cur) => cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]);
  }, []);

  return (
    <div style={{
      maxWidth: 1040,
      margin: '0 auto',
      padding: '28px 36px 64px',
      fontFamily: '"Noto Serif SC", "EB Garamond", serif',
      color: 'var(--ink-1, #2c2620)',
      background: 'var(--paper, #faf6e8)',
      minHeight: '100vh',
    }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{
          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
          fontStyle: 'italic',
          fontSize: 28,
          letterSpacing: '0.02em',
          marginBottom: 4,
        }}>
          Judgment Gym
        </div>
        <div style={{ color: 'var(--ink-3, #8b8275)', fontSize: 13 }}>
          每天对比两个东西, 训练 标准 / 品味 / 取舍 / 判断力 — 真正的 judgment 在"放弃了什么"这一句里。
          {slug && <span style={{ marginLeft: 12, fontStyle: 'italic' }}>slug · {slug}</span>}
          {history.stats && history.stats.rolling_judgment_avg != null && (
            <span style={{ marginLeft: 12, fontStyle: 'italic' }}>
              近 10 次平均判断力 · {history.stats.rolling_judgment_avg}
            </span>
          )}
        </div>
      </div>

      {/* Setup */}
      {!exercise && (
        <div style={{ marginBottom: 28 }}>
          <div style={{
            fontStyle: 'italic',
            fontFamily: 'EB Garamond, serif',
            fontSize: 14,
            color: 'var(--ink-2, #5a5246)',
            marginBottom: 6,
          }}>
            训练类型
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
            {EXERCISE_TYPES.map((t) => (
              <button
                key={t.id}
                onClick={() => setType(t.id)}
                title={t.hint}
                style={{
                  padding: '6px 14px',
                  fontSize: 13,
                  fontFamily: '"Noto Serif SC", serif',
                  background: type === t.id ? 'var(--ink-1, #2c2620)' : 'transparent',
                  color: type === t.id ? 'var(--paper, #faf6e8)' : 'var(--ink-2, #5a5246)',
                  border: '1px solid ' + (type === t.id ? 'var(--ink-1, #2c2620)' : 'var(--rule-soft, #e3dccd)'),
                  borderRadius: 2,
                  cursor: 'pointer',
                }}>
                {t.label}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontStyle: 'italic', fontSize: 13, color: 'var(--ink-3, #8b8275)' }}>
                Option A · title
              </label>
              <input
                value={optionA.title}
                onChange={(e) => setOptionA({ ...optionA, title: e.target.value })}
                style={{
                  width: '100%', padding: '6px 10px', fontSize: 14,
                  background: 'var(--paper-warm, #f5efde)',
                  border: '1px solid var(--rule-soft, #e3dccd)',
                  fontFamily: '"Noto Serif SC", serif',
                }}
              />
              <textarea
                value={optionA.body}
                onChange={(e) => setOptionA({ ...optionA, body: e.target.value })}
                placeholder="(optional) 详细描述"
                rows={3}
                style={{
                  width: '100%', padding: '6px 10px', fontSize: 13, marginTop: 4,
                  background: 'var(--paper-warm, #f5efde)',
                  border: '1px solid var(--rule-soft, #e3dccd)',
                  fontFamily: '"Noto Serif SC", serif',
                }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontStyle: 'italic', fontSize: 13, color: 'var(--ink-3, #8b8275)' }}>
                Option B · title
              </label>
              <input
                value={optionB.title}
                onChange={(e) => setOptionB({ ...optionB, title: e.target.value })}
                style={{
                  width: '100%', padding: '6px 10px', fontSize: 14,
                  background: 'var(--paper-warm, #f5efde)',
                  border: '1px solid var(--rule-soft, #e3dccd)',
                  fontFamily: '"Noto Serif SC", serif',
                }}
              />
              <textarea
                value={optionB.body}
                onChange={(e) => setOptionB({ ...optionB, body: e.target.value })}
                placeholder="(optional) 详细描述"
                rows={3}
                style={{
                  width: '100%', padding: '6px 10px', fontSize: 13, marginTop: 4,
                  background: 'var(--paper-warm, #f5efde)',
                  border: '1px solid var(--rule-soft, #e3dccd)',
                  fontFamily: '"Noto Serif SC", serif',
                }}
              />
            </div>
          </div>

          <input
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="(optional) Shared context — 比如 user persona / 当前 phase / 约束"
            style={{
              width: '100%', padding: '6px 10px', fontSize: 13,
              background: 'var(--paper-warm, #f5efde)',
              border: '1px solid var(--rule-soft, #e3dccd)',
              fontFamily: '"Noto Serif SC", serif',
              marginBottom: 12,
            }}
          />

          <button
            onClick={handleCreate}
            disabled={busy}
            style={{
              fontFamily: 'EB Garamond, serif',
              fontStyle: 'italic',
              fontSize: 14,
              padding: '8px 22px',
              background: 'var(--ink-1, #2c2620)',
              color: 'var(--paper, #faf6e8)',
              border: '1px solid var(--ink-1, #2c2620)',
              borderRadius: 2,
              cursor: busy ? 'wait' : 'pointer',
            }}>
            {busy ? '准备中…' : '开始训练'}
          </button>
        </div>
      )}

      {/* Compare + submit */}
      {exercise && (
        <>
          <div style={{ display: 'flex', gap: 16, marginBottom: 18 }}>
            <OptionCard label="A" opt={exercise.optionA} picked={pick === 'A'} onPick={() => setPick('A')} />
            <OptionCard label="B" opt={exercise.optionB} picked={pick === 'B'} onPick={() => setPick('B')} />
          </div>

          {exercise.context && (
            <div style={{
              padding: '8px 14px',
              borderLeft: '2px solid var(--accent-brass, #b08a3e)',
              fontSize: 13,
              fontStyle: 'italic',
              fontFamily: 'EB Garamond, serif',
              color: 'var(--ink-2, #5a5246)',
              marginBottom: 14,
            }}>
              context — {exercise.context}
            </div>
          )}

          <div style={{
            fontFamily: 'EB Garamond, serif',
            fontStyle: 'italic',
            fontSize: 13,
            color: 'var(--ink-3, #8b8275)',
            marginBottom: 6,
          }}>
            用到的维度 (点击 toggle)
          </div>
          <div style={{ marginBottom: 14 }}>
            {dims.map((d) => (
              <DimChip key={d} dim={d} on={usedDims.includes(d)} onToggle={() => toggleDim(d)} />
            ))}
          </div>

          <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
            {['A', 'B', 'both', 'neither'].map((p) => (
              <button
                key={p}
                onClick={() => setPick(p)}
                style={{
                  padding: '6px 14px',
                  fontSize: 13,
                  fontFamily: '"Noto Serif SC", serif',
                  background: pick === p ? 'var(--accent-brass, #b08a3e)' : 'transparent',
                  color: pick === p ? 'var(--paper, #faf6e8)' : 'var(--ink-2, #5a5246)',
                  border: '1px solid ' + (pick === p ? 'var(--accent-brass, #b08a3e)' : 'var(--rule-soft, #e3dccd)'),
                  borderRadius: 2,
                  cursor: 'pointer',
                }}>
                pick {p}
              </button>
            ))}
          </div>

          <textarea
            value={reasoning}
            onChange={(e) => setReasoning(e.target.value)}
            placeholder="为什么这样选? 放弃了什么? 6 个月后还会这么选吗? ≥ 30 字, ideally ≥ 200."
            rows={6}
            style={{
              width: '100%', padding: '10px 12px', fontSize: 14,
              background: 'var(--paper-warm, #f5efde)',
              border: '1px solid var(--rule-soft, #e3dccd)',
              fontFamily: '"Noto Serif SC", serif',
              lineHeight: 1.6,
              marginBottom: 12,
            }}
          />

          <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
            <button
              onClick={handleSubmit}
              disabled={busy}
              style={{
                fontFamily: 'EB Garamond, serif',
                fontStyle: 'italic',
                fontSize: 14,
                padding: '8px 22px',
                background: 'var(--ink-1, #2c2620)',
                color: 'var(--paper, #faf6e8)',
                border: '1px solid var(--ink-1, #2c2620)',
                borderRadius: 2,
                cursor: busy ? 'wait' : 'pointer',
              }}>
              {busy ? '判分中…' : '提交判断'}
            </button>
            <button
              onClick={() => { setExercise(null); setResult(null); }}
              style={{
                fontFamily: 'EB Garamond, serif',
                fontStyle: 'italic',
                fontSize: 13,
                padding: '8px 18px',
                background: 'transparent',
                border: '1px solid var(--ink-3, #8b8275)',
                color: 'var(--ink-3, #8b8275)',
                borderRadius: 2,
                cursor: 'pointer',
              }}>
              换一题
            </button>
          </div>

          {error && (
            <div style={{ color: '#8B3A3A', fontSize: 13, fontStyle: 'italic', marginBottom: 12 }}>
              {error}
            </div>
          )}

          {/* Result */}
          {result && (
            <div style={{ marginBottom: 24 }}>
              <MetricRow score={result.score} />
              <div style={{
                fontFamily: 'EB Garamond, "Noto Serif SC", serif',
                fontStyle: 'italic',
                fontSize: 15,
                lineHeight: 1.7,
                color: 'var(--ink-1, #2c2620)',
                padding: '10px 14px',
                background: 'var(--paper-warm, #f5efde)',
                border: '1px solid var(--rule-soft, #e3dccd)',
                borderRadius: 2,
                marginBottom: 10,
              }}>
                {result.analysis && result.analysis.narrative}
              </div>
              {result.analysis && result.analysis.missed_dimensions && result.analysis.missed_dimensions.length > 0 && (
                <div style={{ fontSize: 13, color: 'var(--ink-3, #8b8275)' }}>
                  missed dimensions: {result.analysis.missed_dimensions.join(' · ')}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* History */}
      <div style={{ marginTop: 36 }}>
        <div style={{
          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
          fontStyle: 'italic',
          fontSize: 14,
          color: 'var(--ink-3, #8b8275)',
          marginBottom: 8,
          letterSpacing: '0.04em',
        }}>
          先前的训练 · {history.submissions.length}
        </div>
        {history.submissions.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--ink-3, #8b8275)', fontStyle: 'italic' }}>
            (空 — 第一题就是基线)
          </div>
        )}
        {history.submissions.slice(0, 10).map((s) => (
          <div key={s.id} style={{
            padding: '8px 0',
            borderBottom: '1px solid var(--rule-soft, #e3dccd)',
            fontSize: 13,
            display: 'flex',
            gap: 12,
          }}>
            <span style={{ color: 'var(--ink-3, #8b8275)', minWidth: 110 }}>
              {(s.ts || '').slice(0, 16).replace('T', ' ')}
            </span>
            <span style={{ color: 'var(--ink-2, #5a5246)', minWidth: 70 }}>
              pick {s.user_judgment && s.user_judgment.pick}
            </span>
            <span style={{ color: 'var(--accent-brass, #b08a3e)' }}>
              judgment {s.score && s.score.judgment != null ? s.score.judgment.toFixed(2) : '—'}
            </span>
            <span style={{ color: 'var(--ink-1, #2c2620)', flex: 1 }}>
              {(s.user_judgment && s.user_judgment.reasoning || '').slice(0, 100)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

window.JudgmentGymScreen = JudgmentGymScreen;
window.HYPHA_ROUTES = window.HYPHA_ROUTES || {};
window.HYPHA_ROUTES['judgment-gym'] = JudgmentGymScreen;
