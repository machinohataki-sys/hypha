/* global React */
// HYPHA · Distillation Progress (W6.2 §5.1).
//
// 7-phase progress dashboard. Drives `window.ptor.hypha.distill.book(bookId)`
// then polls `distill:status` for the in-progress visualization. On complete,
// navigates to screen-book-spark-pack.

const { useState, useEffect, useCallback } = React;

const PHASE_LABELS = [
  { n: 1, label: '建图',     desc: '目录 · 作者核心问题 · 全书结构 · 关键章节' },
  { n: 2, label: '章节拆解', desc: '本章核心问题 · 核心判断 · 论证链 · 隐藏前提 · Spark 候选' },
  { n: 3, label: '跨章节合并', desc: '问题去重 · 机制提炼 · 重复观点压缩 · 高价值 Spark 拣选' },
  { n: 4, label: '前沿化',   desc: '与 AI / Agent / 教育 / 产品 / 创业 / 社会结构连接' },
  { n: 5, label: '反向批判', desc: '作者高估 · 低估 · 过时观点 · 可被 AI 时代重写' },
  { n: 6, label: '个人化',   desc: '击中目标 · 不同意 · 可迁移 · 可执行' },
  { n: 7, label: 'Spark Pack', desc: '15-field 输出 · 可导出 Commons' },
];

const DistillationProgressScreen = ({ bookId, bookTitle, onComplete, onCancel }) => {
  const [status, setStatus] = useState(null); // { last_phase, complete, error }
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  // Poll status while running. Distill runs synchronously inside main process
  // and returns when all 7 phases are written — but on UIs with slow LLM
  // calls (production), the status file is updated phase-by-phase, so polling
  // surfaces real-time progress to the user.
  useEffect(() => {
    if (!running || !bookId) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await window.ptor.hypha.distill.status(bookId);
        if (cancelled) return;
        if (r && r.ok) setStatus(r.status);
      } catch (_) { /* polling is best-effort */ }
    };
    const id = setInterval(tick, 1000);
    tick();
    return () => { cancelled = true; clearInterval(id); };
  }, [running, bookId]);

  const handleStart = useCallback(async () => {
    if (!bookId) return;
    setRunning(true);
    setError(null);
    try {
      const r = await window.ptor.hypha.distill.book(bookId, { resume: true });
      if (!r || !r.ok) {
        setError((r && r.error) || 'distill failed');
        setRunning(false);
        return;
      }
      setStatus(r.status || { complete: true, last_phase: 7 });
      setRunning(false);
      if (typeof onComplete === 'function') onComplete(r);
    } catch (e) {
      setError(e.message || String(e));
      setRunning(false);
    }
  }, [bookId, onComplete]);

  const lastPhase = (status && status.last_phase) || 0;
  const complete = !!(status && status.complete);

  return (
    <div className="col gap-20 fade-in" style={{ padding: '32px 40px 60px', maxWidth: 760, margin: '0 auto' }}>
      <div className="col">
        <div className="eyebrow">Distillation</div>
        <h1 className="serif" style={{ fontSize: 32, margin: '4px 0 0', fontWeight: 400 }}>
          <span className="italic">蒸馏</span> {bookTitle || bookId}
        </h1>
        <div className="t-body" style={{ marginTop: 6, color: 'var(--ink-2)' }}>
          一本书蒸馏一次. 7 阶段顺序进行, 中途可关闭, 重启自动续跑.
        </div>
      </div>

      {error && (
        <div style={{
          padding: '10px 14px', background: 'rgba(139,58,58,0.08)',
          border: '1px solid rgba(139,58,58,0.3)', borderRadius: 2,
          fontSize: 13, color: '#8B3A3A', whiteSpace: 'pre-wrap',
        }}>{error}</div>
      )}

      <div className="col gap-10">
        {PHASE_LABELS.map(p => {
          const done = p.n <= lastPhase;
          const active = running && p.n === lastPhase + 1;
          return (
            <div key={p.n} className="row gap-14" style={{
              padding: '12px 16px',
              background: done ? 'var(--paper)' : 'var(--cream)',
              border: '1px solid var(--rule-soft)',
              borderLeft: done ? '2px solid #4D8B9A' : active ? '2px solid #B89968' : '2px solid var(--rule-soft)',
              borderRadius: 2,
              alignItems: 'baseline',
            }}>
              <span className="serif" style={{ fontSize: 18, width: 28, color: 'var(--ink-2)' }}>{p.n}</span>
              <div className="col gap-2" style={{ flex: 1, minWidth: 0 }}>
                <span className="serif" style={{ fontSize: 16, color: 'var(--ink)' }}>
                  {p.label}
                  {active && p.n === 2 && status && status.phase2_total > 0 ? (
                    <span className="italic" style={{ marginLeft: 8, color: '#B89968', fontSize: 13 }}>
                      {status.phase2_done || 0} / {status.phase2_total} 章
                    </span>
                  ) : active && (
                    <span className="italic" style={{ marginLeft: 8, color: '#B89968', fontSize: 13 }}>进行中…</span>
                  )}
                  {done && <span style={{ marginLeft: 8, color: '#4D8B9A', fontSize: 12 }}>✓</span>}
                </span>
                <span className="t-tiny" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{p.desc}</span>
                {active && p.n === 2 && status && status.phase2_current_title && (
                  <span className="t-tiny italic" style={{ fontSize: 11, color: 'var(--ink-2)', marginTop: 2 }}>
                    正在拆: {status.phase2_current_title}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="row gap-12" style={{ marginTop: 8 }}>
        {!complete && (
          <button onClick={handleStart} disabled={running}
            className="btn btn-primary"
            style={{ fontSize: 14, opacity: running ? 0.5 : 1 }}>
            {running ? '蒸馏中…' : (lastPhase > 0 ? '继续蒸馏' : '开始蒸馏')}
          </button>
        )}
        {complete && (
          <button onClick={() => onComplete && onComplete({ ok: true, book_id: bookId, status })}
            className="btn btn-primary" style={{ fontSize: 14 }}>
            查看 Book Spark Pack
          </button>
        )}
        <button onClick={onCancel} className="btn btn-ghost" style={{ fontSize: 13, color: 'var(--ink-2)' }}>
          返回
        </button>
      </div>
    </div>
  );
};

window.DistillationProgressScreen = DistillationProgressScreen;
