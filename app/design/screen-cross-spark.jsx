/* global React */
// HYPHA · W7.4 Cross-Spark surface — 6-step跨域 spark generator.
//
// Per BLUEPRINT §14.2. Layout:
//   Header  — title + slug context
//   Input   — current-problem textarea + optional domain selector + Generate
//   Result  — 6-step ribbon (source domain → 3 other lenses → tool → spark
//             → constraints → action/artifact) rendered as a vertical reading
//             column. The spark itself is the load-bearing block; the rest
//             frame it.
//   Footer  — two actions: "转 Product Spark" (calls W3.4 via auto-bridge) +
//             "存为 Note" (placeholder — wired when W3.x note IPC adopts the
//             cross-spark snapshot shape).
//
// Props: { slug, onBack }
//
// Register: warm parchment + EB Garamond italic for headings + state hints;
// roman for body + actions. No emoji, no exclamation, no progress bar gushing.

const { useState, useEffect, useCallback, useMemo } = React;

// ---------------------------------------------------------------------------
// Constants — domain registry mirror (4 axes per BLUEPRINT §14.2). Kept here
// so the screen renders without an IPC round-trip for the radio options.
// ---------------------------------------------------------------------------

const DOMAIN_OPTIONS = [
  { value: '',           label: '自动判断' },
  { value: 'literature', label: '文学 / 人文' },
  { value: 'science',    label: '理科' },
  { value: 'engineering',label: '工程 / 产品' },
  { value: 'ai',         label: 'AI / Agent' },
];

const DOMAIN_LABEL_CN = {
  literature:  '文学',
  science:     '理科',
  engineering: '工程',
  ai:          'AI',
};

// ---------------------------------------------------------------------------
// Step ribbon — single-source-of-truth for the 6-step flow rendering.
// ---------------------------------------------------------------------------

const StepRow = ({ index, label, children }) => (
  <div style={{
    padding: '14px 0',
    borderBottom: '1px solid var(--rule-soft, #e3dccd)',
  }}>
    <div style={{
      fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      fontStyle: 'italic',
      fontSize: 13,
      color: 'var(--ink-3, #8b8275)',
      letterSpacing: '0.04em',
      marginBottom: 6,
    }}>
      Step {index} · {label}
    </div>
    <div style={{
      fontFamily: '"Noto Serif SC", "EB Garamond", serif',
      fontSize: 15,
      lineHeight: 1.65,
      color: 'var(--ink-1, #2c2620)',
    }}>
      {children}
    </div>
  </div>
);

const ConstraintRow = ({ c }) => (
  <div style={{
    paddingLeft: 12,
    borderLeft: '2px solid var(--accent-brass, #b08a3e)',
    margin: '6px 0',
    fontSize: 14,
    color: 'var(--ink-2, #5a5246)',
  }}>
    <span style={{
      fontFamily: 'EB Garamond, serif',
      fontStyle: 'italic',
      color: 'var(--ink-3, #8b8275)',
      marginRight: 8,
    }}>{c.kind}</span>
    {c.note}
  </div>
);

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

const CrossSparkScreen = ({ slug, onBack }) => {
  const [problem, setProblem] = useState('');
  const [domain, setDomain] = useState('');
  const [spark, setSpark] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);
  const [sproutResult, setSproutResult] = useState(null);

  // Load history on mount + after a successful generate.
  const reloadHistory = useCallback(async () => {
    if (!slug || !window.ptor || !window.ptor.crossSpark) return;
    try {
      const res = await window.ptor.crossSpark.history(slug);
      if (res && res.ok) setHistory(Array.isArray(res.history) ? res.history : []);
    } catch (_) { /* silent — history is informational */ }
  }, [slug]);

  useEffect(() => { reloadHistory(); }, [reloadHistory]);

  // ESC = onBack.
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape' && typeof onBack === 'function') onBack();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onBack]);

  const handleGenerate = useCallback(async () => {
    if (!problem.trim()) {
      setError('先写一个具体问题 — 越具体, 越能跨域。');
      return;
    }
    setBusy(true);
    setError(null);
    setSproutResult(null);
    try {
      const res = await window.ptor.crossSpark.generate({
        currentProblem: problem.trim(),
        currentDomain: domain || undefined,
        slug,
      });
      if (!res || !res.ok) {
        setError((res && res.error) || '生成失败');
        return;
      }
      setSpark(res.spark);
      reloadHistory();
    } catch (err) {
      setError(err && err.message ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [problem, domain, slug, reloadHistory]);

  const handleAutoSprout = useCallback(async () => {
    if (!spark || !slug) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.ptor.crossSpark.autoCreate(spark, slug);
      setSproutResult(res);
      if (!res || !res.ok) setError(res && res.error || '转 Product Spark 失败');
    } catch (err) {
      setError(err && err.message ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [spark, slug]);

  const handleSaveAsNote = useCallback(() => {
    // intentional-placeholder: note IPC adopts cross-spark snapshot shape in
    // a follow-up wave. For now we surface a confirmation message — the JSONL
    // history already persists the spark, so the artifact is not lost.
    setSproutResult({
      ok: true,
      sprouted: false,
      reason: 'note-write surface 待 W7.x 后续 wave 接入 — 当前 spark 已存入 growth/cross-sparks.jsonl, 可直接 grep 浏览。',
    });
  }, []);

  const stepRows = useMemo(() => {
    if (!spark) return null;
    return (
      <>
        <StepRow index={1} label="源域 · source domain">
          <span style={{ fontFamily: 'EB Garamond, serif', fontStyle: 'italic' }}>
            {DOMAIN_LABEL_CN[spark.source_domain] || spark.source_domain}
          </span>
          <span style={{ color: 'var(--ink-3, #8b8275)', marginLeft: 8, fontSize: 13 }}>
            ({spark.source_problem})
          </span>
        </StepRow>

        <StepRow index={2} label="其它三域镜头 · other lenses">
          {(spark.other_domain_lenses || []).map((l, i) => (
            <div key={i} style={{ marginBottom: 6 }}>
              <span style={{
                fontFamily: 'EB Garamond, serif',
                fontStyle: 'italic',
                color: 'var(--ink-2, #5a5246)',
                marginRight: 8,
              }}>
                {DOMAIN_LABEL_CN[l.domain] || l.domain}
              </span>
              <span>{l.lens}</span>
            </div>
          ))}
        </StepRow>

        <StepRow index={3} label="思维工具 · thinking tool">
          {spark.thinking_tool ? (
            <div>
              <div style={{
                fontFamily: 'EB Garamond, "Noto Serif SC", serif',
                fontStyle: 'italic',
                fontSize: 16,
                marginBottom: 4,
              }}>
                {spark.thinking_tool.name_cn} · {spark.thinking_tool.name_en}
              </div>
              <div style={{ color: 'var(--ink-2, #5a5246)' }}>
                关键追问: {spark.thinking_tool.key_question}
              </div>
            </div>
          ) : <em>(no tool resolved)</em>}
        </StepRow>

        <StepRow index={4} label="新 Spark · new spark">
          <div style={{
            background: 'var(--paper-warm, #f5efde)',
            border: '1px solid var(--rule-soft, #e3dccd)',
            padding: '14px 16px',
            borderRadius: 2,
            fontSize: 15,
            lineHeight: 1.7,
          }}>
            {spark.new_spark}
          </div>
        </StepRow>

        <StepRow index={5} label="现实约束 · constraints">
          {(spark.constraints || []).map((c, i) => <ConstraintRow key={i} c={c} />)}
        </StepRow>

        <StepRow index={6} label="行动 / 作品 · action or artifact">
          <div>
            <span style={{
              fontFamily: 'EB Garamond, serif',
              fontStyle: 'italic',
              color: 'var(--accent-brass, #b08a3e)',
              marginRight: 8,
            }}>
              {(spark.action_or_artifact && spark.action_or_artifact.kind) || '—'}
            </span>
            <span>{spark.action_or_artifact && spark.action_or_artifact.summary}</span>
          </div>
        </StepRow>
      </>
    );
  }, [spark]);

  return (
    <div style={{
      maxWidth: 880,
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
          Cross-Spark
        </div>
        <div style={{ color: 'var(--ink-3, #8b8275)', fontSize: 13 }}>
          文科 给眼界 · 理科 给深度 · 工程 给落地 · AI 给放大 — 让一个问题在四个域之间走一圈, 看它能不能换一种长法。
          {slug && <span style={{ marginLeft: 12, fontStyle: 'italic' }}>slug · {slug}</span>}
        </div>
      </div>

      {/* Input */}
      <div style={{ marginBottom: 24 }}>
        <label style={{
          display: 'block',
          fontStyle: 'italic',
          fontFamily: 'EB Garamond, serif',
          fontSize: 14,
          color: 'var(--ink-2, #5a5246)',
          marginBottom: 6,
        }}>
          当前问题
        </label>
        <textarea
          value={problem}
          onChange={(e) => setProblem(e.target.value)}
          placeholder="写一个具体到能被反驳的问题 — 不要是 topic, 是 a question with stakes."
          rows={4}
          style={{
            width: '100%',
            fontFamily: '"Noto Serif SC", serif',
            fontSize: 15,
            padding: '10px 12px',
            background: 'var(--paper-warm, #f5efde)',
            border: '1px solid var(--rule-soft, #e3dccd)',
            borderRadius: 2,
            color: 'var(--ink-1, #2c2620)',
            lineHeight: 1.6,
          }}
        />
        <div className="row gap-12" style={{ marginTop: 10, display: 'flex', alignItems: 'center' }}>
          <label style={{
            fontStyle: 'italic',
            fontFamily: 'EB Garamond, serif',
            fontSize: 13,
            color: 'var(--ink-3, #8b8275)',
          }}>
            源域:
          </label>
          <select
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            style={{
              fontFamily: '"Noto Serif SC", serif',
              fontSize: 13,
              padding: '4px 10px',
              border: '1px solid var(--rule-soft, #e3dccd)',
              background: 'var(--paper, #faf6e8)',
              borderRadius: 2,
            }}>
            {DOMAIN_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <div style={{ flex: 1 }} />
          <button
            onClick={handleGenerate}
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
              opacity: busy ? 0.6 : 1,
            }}>
            {busy ? '生成中…' : 'Generate Cross Spark'}
          </button>
        </div>
        {error && (
          <div style={{
            marginTop: 10,
            color: '#8B3A3A',
            fontSize: 13,
            fontStyle: 'italic',
          }}>
            {error}
          </div>
        )}
      </div>

      {/* Result ribbon */}
      {spark && (
        <div style={{
          background: 'var(--paper, #faf6e8)',
          border: '1px solid var(--rule-soft, #e3dccd)',
          padding: '8px 20px 18px',
          borderRadius: 2,
          marginBottom: 24,
        }}>
          {stepRows}
        </div>
      )}

      {/* Actions */}
      {spark && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
          <button
            onClick={handleAutoSprout}
            disabled={busy}
            style={{
              fontFamily: 'EB Garamond, serif',
              fontStyle: 'italic',
              fontSize: 13,
              padding: '8px 18px',
              background: 'transparent',
              border: '1px solid var(--accent-brass, #b08a3e)',
              color: 'var(--accent-brass, #b08a3e)',
              borderRadius: 2,
              cursor: busy ? 'wait' : 'pointer',
            }}>
            转 Product Spark
          </button>
          <button
            onClick={handleSaveAsNote}
            disabled={busy}
            style={{
              fontFamily: 'EB Garamond, serif',
              fontStyle: 'italic',
              fontSize: 13,
              padding: '8px 18px',
              background: 'transparent',
              border: '1px solid var(--ink-2, #5a5246)',
              color: 'var(--ink-2, #5a5246)',
              borderRadius: 2,
              cursor: busy ? 'wait' : 'pointer',
            }}>
            存为 Note
          </button>
        </div>
      )}

      {/* Sprout result */}
      {sproutResult && (
        <div style={{
          marginBottom: 24,
          fontSize: 13,
          color: sproutResult.ok ? 'var(--ink-2, #5a5246)' : '#8B3A3A',
          fontStyle: 'italic',
          fontFamily: 'EB Garamond, serif',
        }}>
          {sproutResult.sprouted
            ? `已种入 sparks/${sproutResult.spark_id}.md, state=seed — 去 Spark Pool 推进它。`
            : (sproutResult.reason || sproutResult.error || '')}
        </div>
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
          先前的 Cross-Spark · {history.length}
        </div>
        {history.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--ink-3, #8b8275)', fontStyle: 'italic' }}>
            (空 — 这是这个 slug 的第一条)
          </div>
        )}
        {history.slice(0, 10).map((h) => (
          <div key={h.id} style={{
            padding: '8px 0',
            borderBottom: '1px solid var(--rule-soft, #e3dccd)',
            fontSize: 13,
          }}>
            <span style={{
              fontFamily: 'EB Garamond, serif',
              fontStyle: 'italic',
              color: 'var(--ink-3, #8b8275)',
              marginRight: 10,
            }}>
              {(h.ts || '').slice(0, 16).replace('T', ' ')}
            </span>
            <span style={{ color: 'var(--ink-2, #5a5246)' }}>
              {DOMAIN_LABEL_CN[h.source_domain] || h.source_domain} · {h.thinking_tool_id}
            </span>
            <div style={{ color: 'var(--ink-1, #2c2620)', marginTop: 2 }}>
              {(h.source_problem || '').slice(0, 120)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

window.CrossSparkScreen = CrossSparkScreen;
// Route registration — UI router (renderer-side index.jsx) reads
// window.HYPHA_ROUTES if present and merges with built-ins. Adding a route
// here is the lightest-weight way to surface the screen during development.
window.HYPHA_ROUTES = window.HYPHA_ROUTES || {};
window.HYPHA_ROUTES['cross-spark'] = CrossSparkScreen;
