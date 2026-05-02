// ImportDialog — 2026-04-28 council redesign (night editorial minimalist).
// Verdict on previous version: "调暗的 web modal", card bg 与底同明度 = 沉成洞,
// + 32% backdrop 漏背景 chrome, + pill button SaaS 词汇.
// Counter (this version): bg 深 1-2 档浮成"物", 顶 brass hairline = 唯一材质 cue,
// 方角 6px, max-width 420 信纸感, backdrop 70% 黑 + blur 8px, title 30px normal
// (CJK 弃 italic), 砍掉所有 simulated material (noise / gradient / text-shadow).

function ImportDialog({ open, onClose, onComplete }) {
  const [phase, setPhase] = React.useState('pick');
  const [sourcePath, setSourcePath] = React.useState(null);
  const [scan, setScan] = React.useState(null);
  const [progress, setProgress] = React.useState({ current: 0, total: 0, currentFile: null });
  const [result, setResult] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [sessionId] = React.useState(() => 'imp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));

  React.useEffect(() => {
    if (!open) return;
    if (!window.ptor || !window.ptor.vault || !window.ptor.vault.onImportProgress) return;
    const unsub = window.ptor.vault.onImportProgress((p) => {
      if (p.sessionId !== sessionId) return;
      setProgress(p);
    });
    return unsub;
  }, [open, sessionId]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape' && phase !== 'running') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, phase, onClose]);

  const pickFolder = async () => {
    setError(null);
    try {
      const p = await window.ptor.vault.pickFolder();
      if (!p) return;
      setSourcePath(p);
      setPhase('scanning');
      const s = await window.ptor.vault.importScan(p);
      if (s.error) { setError(s.error); setPhase('pick'); return; }
      setScan(s);
      setPhase('preview');
    } catch (e) { setError(String(e.message || e)); setPhase('pick'); }
  };

  const runImport = async () => {
    setPhase('running');
    setProgress({ current: 0, total: scan.total, currentFile: null });
    try {
      const r = await window.ptor.vault.importRun(sourcePath, undefined, sessionId);
      setResult(r);
      setPhase('done');
      if (onComplete) onComplete(r);
    } catch (e) { setError(String(e.message || e)); setPhase('done'); }
  };

  const cancelImport = async () => {
    if (!window.ptor || !window.ptor.vault) return;
    await window.ptor.vault.importCancel(sessionId);
  };

  if (!open) return null;
  // ReactDOM.createPortal lifts overlay out of any transform-ancestor (App grid +
  // VaultTree contain transform/willChange rules that trap position:fixed children
  // — verified 2026-04-28: card was clamped to 200px in vault rail width.)
  const _renderPortal = (node) => (typeof ReactDOM !== 'undefined' && ReactDOM.createPortal)
    ? ReactDOM.createPortal(node, document.body)
    : node;

  // Soft format hint, no raw markdown/html jargon
  const sourceHint = scan && (() => {
    if (scan.detected === 'markdown')   return 'Bear · Obsidian · or markdown notes';
    if (scan.detected === 'notion-html') return 'Notion HTML export';
    if (scan.detected === 'mixed')      return 'mixed sources';
    if (scan.detected === 'empty')      return 'nothing found';
    return '';
  })();

  // 短路径展示
  const prettyPath = (p) => {
    if (!p) return '';
    const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length <= 4) return p;
    return parts[0] + '/…/' + parts.slice(-2).join('/');
  };

  // 文件名去 ext + 截断
  const niceCurrentFile = (p) => {
    if (!p) return '';
    const last = p.split('/').pop() || p;
    return last.replace(/\.(md|markdown|html?|HTM)$/i, '');
  };

  return _renderPortal(
    <div
      onClick={() => { if (phase !== 'running') onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'var(--bg-modal-backdrop)',
        backdropFilter: 'blur(8px) saturate(0.85)',
        WebkitBackdropFilter: 'blur(8px) saturate(0.85)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 32,
        animation: 'imp-fade 320ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <style>{`
        @keyframes imp-fade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes imp-rise { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: none } }
        @keyframes imp-line { from { opacity: 0 } to { opacity: 1 } }

        .imp-title-zh {
          font-family: "EB Garamond", "Noto Serif SC", "Source Han Serif SC", "Cormorant Garamond", Georgia, serif;
          font-style: normal;
          font-weight: 500;
          font-size: 30px;
          line-height: 1.22;
          letter-spacing: 0.005em;
          color: var(--ink-title);
          margin: 0 0 14px;
        }
        .imp-deck {
          font-family: "EB Garamond", "Noto Serif SC", serif;
          font-weight: 400;
          font-size: 15px;
          line-height: 1.72;
          color: var(--ink-muted);
          max-width: 32ch;
          margin: 0 0 30px;
        }
        .imp-aside {
          font-family: "EB Garamond", "Noto Serif SC", serif;
          font-style: italic;
          font-size: 14px;
          line-height: 1.55;
          color: var(--ink-muted);
          opacity: 0.85;
        }
        .imp-faint-mono {
          font-family: "JetBrains Mono", monospace;
          font-size: 10.5px;
          letter-spacing: 0.02em;
          color: var(--ink-faint);
        }
        .imp-prose {
          font-family: "EB Garamond", "Noto Serif SC", serif;
          font-size: 16px; line-height: 1.7;
          color: var(--ink-primary);
        }
        /* Buttons — option A "软胶囊": 14px 圆角 + 无边框 + 极淡 brass 填充.
           方角 3px 太死板 (用户 2026-04-28 反馈), pill 999px 太 SaaS 套话.
           14px 是临界值: 软到不再"棱角分明", 又不到"药丸"程度. */
        .imp-btn {
          font-family: "EB Garamond", "Noto Serif SC", serif;
          font-weight: 400;
          font-size: 13.5px;
          letter-spacing: 0.05em;
          padding: 11px 24px;
          background: color-mix(in srgb, var(--brass-mid) 5%, transparent);
          border: none;
          border-radius: 0;
          color: var(--ink-muted);
          cursor: pointer;
          transition: color 280ms cubic-bezier(0.22, 1, 0.36, 1),
                      background 280ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        .imp-btn:hover:not(:disabled) {
          color: var(--ink-title);
          background: color-mix(in srgb, var(--brass-mid) 11%, transparent);
        }
        .imp-btn:disabled { opacity: 0.32; cursor: not-allowed; }
        .imp-btn.primary {
          color: var(--brass-bright);
          background: color-mix(in srgb, var(--brass-mid) 11%, transparent);
        }
        .imp-btn.primary:hover:not(:disabled) {
          background: color-mix(in srgb, var(--brass-mid) 18%, transparent);
          color: var(--ink-title);
        }
        .imp-btn.ghost {
          background: transparent;
          color: var(--ink-muted);
          opacity: 0.78;
          padding-left: 14px; padding-right: 14px;
        }
        .imp-btn.ghost:hover:not(:disabled) {
          background: color-mix(in srgb, var(--brass-mid) 4%, transparent);
          color: var(--ink-title);
          opacity: 1;
        }
        .imp-current-line {
          animation: imp-line 380ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        .imp-dot {
          display: inline-block;
          width: 5px; height: 5px;
          border-radius: 50%;
          background: var(--brass-bright);
          opacity: 0.85;
          margin-right: 10px;
          vertical-align: middle;
        }
      `}</style>

      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 420,
          // Card bg differs by mode: night = deeper than --bg-base ("浮成物"),
          // day = lighter than --bg-base (raised paper). Token defined per mode
          // in colors_and_type.css.
          background: 'var(--bg-modal-card)',
          borderRadius: 6,
          padding: '52px 52px 36px',
          // Top 1px brass hairline (inset highlight) + soft brass edge + deep
          // drop shadow. Shadow rgba is mode-agnostic (always darker than card).
          boxShadow:
            'inset 0 1px 0 color-mix(in srgb, var(--brass-bright) 22%, transparent), ' +
            '0 0 0 1px color-mix(in srgb, var(--brass-mid) 8%, transparent), ' +
            '0 36px 96px -12px rgba(0, 0, 0, 0.55), ' +
            '0 8px 24px rgba(0, 0, 0, 0.22)',
          display: 'flex', flexDirection: 'column',
          animation: 'imp-rise 360ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        {/* PHASE: pick */}
        {phase === 'pick' && (
          <>
            <h1 className="imp-title-zh">Bring notes in</h1>
            <p className="imp-deck">
              Anything you wrote in Bear, Obsidian or Notion can come along, untouched.
            </p>
            {error && (
              <p className="imp-aside" style={{ color: 'rgba(196, 106, 93, 0.92)', marginBottom: 14 }}>
                {error}
              </p>
            )}
            <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
              <button className="imp-btn ghost" onClick={onClose}>Later</button>
              <button className="imp-btn primary" onClick={pickFolder}>Choose</button>
            </div>
          </>
        )}

        {/* PHASE: scanning */}
        {phase === 'scanning' && (
          <>
            <h1 className="imp-title-zh">Looking…</h1>
            <p className="imp-faint-mono" style={{ marginTop: -6 }}>
              {prettyPath(sourcePath)}
            </p>
          </>
        )}

        {/* PHASE: preview */}
        {phase === 'preview' && scan && (
          <>
            <h1 className="imp-title-zh">
              {scan.total > 0 ? `Found ${scan.total}` : 'Nothing found'}
            </h1>
            <p className="imp-deck">
              {scan.total > 0
                ? <>From <em style={{ color: 'var(--brass-bright)', fontStyle: 'italic', opacity: 0.92 }}>{sourceHint}</em>. Originals stay; only a copy joins.</>
                : <>Try another folder.</>
              }
            </p>
            <p className="imp-faint-mono" style={{ marginTop: -18, marginBottom: 26 }}>
              {prettyPath(sourcePath)}
            </p>
            <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
              <button className="imp-btn ghost" onClick={() => { setScan(null); setSourcePath(null); setPhase('pick'); }}>
                Another
              </button>
              <button className="imp-btn ghost" onClick={onClose}>Cancel</button>
              <button className="imp-btn primary" onClick={runImport} disabled={scan.total === 0}>
                Yes
              </button>
            </div>
          </>
        )}

        {/* PHASE: running */}
        {phase === 'running' && (
          <>
            <h1 className="imp-title-zh">Bringing in…</h1>
            <p
              className="imp-prose imp-current-line"
              key={progress.currentFile || progress.current}
              style={{
                fontStyle: 'italic',
                color: 'var(--ink-muted)',
                minHeight: '1.7em',
                marginBottom: 8,
              }}
            >
              {progress.currentFile ? niceCurrentFile(progress.currentFile) : <span style={{ opacity: 0.5 }}>a moment</span>}
            </p>
            <p className="imp-faint-mono" style={{ marginBottom: 30 }}>
              {progress.current} · {progress.total}
            </p>
            <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
              <button className="imp-btn ghost" onClick={cancelImport}>Stop</button>
            </div>
          </>
        )}

        {/* PHASE: done */}
        {phase === 'done' && result && (
          <>
            <h1 className="imp-title-zh">
              <span className="imp-dot" />
              {result.aborted
                ? 'Stopped'
                : (result.imported || []).length > 0
                  ? 'Here.'
                  : 'Nothing arrived'}
            </h1>
            <p className="imp-deck">
              {result.aborted
                ? <>{(result.imported || []).length} brought over. Rest can wait.</>
                : (result.imported || []).length > 0
                  ? <>{(result.imported || []).length} notes joined.</>
                  : <>No notes were found in that folder.</>
              }
            </p>
            {result.errors && result.errors.length > 0 && (
              <details style={{ marginBottom: 18 }}>
                <summary
                  className="imp-aside"
                  style={{ cursor: 'pointer', color: 'rgba(196, 106, 93, 0.85)' }}
                >
                  {result.errors.length} couldn't make it
                </summary>
                <div
                  className="imp-faint-mono"
                  style={{
                    maxHeight: 140, overflow: 'auto',
                    marginTop: 10, padding: '10px 14px',
                    background: 'color-mix(in srgb, var(--ink-title) 10%, transparent)',
                    borderRadius: 3,
                    lineHeight: 1.7,
                  }}
                >
                  {result.errors.map((e, i) => (
                    <div key={i}>
                      {e.file} <span style={{ opacity: 0.55 }}>— {e.error}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
            <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
              <button className="imp-btn primary" onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { ImportDialog });
