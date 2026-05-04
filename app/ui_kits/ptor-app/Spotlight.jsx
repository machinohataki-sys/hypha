// Spotlight — v0158 — global overlay for invoking agents.
//
// Trigger: Ctrl+; / Cmd+; (registered in App.jsx).
// Per agent-sovereign architecture: Hypha = pure dispatcher. Spotlight just
// reads input, parses @agent prefix, calls window.ptor.agent.invoke, streams
// response back via onChunk. NO prompts injected by Spotlight itself.
//
// Syntax:
//   "what is X"                  → invoke default agent (default-tutor on first launch)
//   "@agentName what is X"       → invoke that specific agent
//   "@list"                      → show agent list inline (no LLM call)
//   "@new"                       → reserved for v0158b AgentManager open
//
// State machine:
//   closed → open (Ctrl+;) → input → submit → streaming → done → close (Esc) or new input

function Spotlight() {
  const [open, setOpen] = React.useState(false);
  const [input, setInput] = React.useState('');
  const [agents, setAgents] = React.useState([]);
  const [currentAgent, setCurrentAgent] = React.useState('default-tutor');
  const [streaming, setStreaming] = React.useState(false);
  const [output, setOutput] = React.useState('');
  const [error, setError] = React.useState(null);
  const [done, setDone] = React.useState(false);
  const [showList, setShowList] = React.useState(false);
  // v0158h — current note rel passed in by App's spotlight-open event so the
  // user can ask "explain this paragraph" without manual context paste.
  const [activeRel, setActiveRel] = React.useState(null);
  const requestIdRef = React.useRef(null);
  const inputRef = React.useRef(null);
  const unsubRef = React.useRef(null);
  // v0158h — typewriter buffer: accumulate chunks in ref, flush to React state
  // once per animation frame (16ms) instead of per-chunk. Combined with main-side
  // 50ms batch, this brings perceived render to terminal-like smoothness.
  const outputBufRef = React.useRef('');
  const rafRef = React.useRef(null);

  // Open overlay: fetch agents list, focus input.
  React.useEffect(() => {
    const onOpen = (e) => {
      setOpen(true);
      setInput('');
      setOutput('');
      setError(null);
      setDone(false);
      setShowList(false);
      setActiveRel((e && e.detail && e.detail.activeRel) || null);
      // Fetch agents (auto-seeds default-tutor if vault empty)
      if (window.ptor && window.ptor.agent && window.ptor.agent.list) {
        window.ptor.agent.list().then(r => {
          if (r && r.ok) {
            setAgents(r.agents || []);
            if ((r.agents || []).indexOf(currentAgent) < 0 && r.agents && r.agents.length > 0) {
              setCurrentAgent(r.agents[0]);
            }
          }
        }).catch(() => {});
      }
    };
    window.addEventListener('hypha:spotlight-open', onOpen);
    return () => window.removeEventListener('hypha:spotlight-open', onOpen);
  }, [currentAgent]);

  // Esc / backdrop click closes
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        // If streaming, abort first
        if (streaming && requestIdRef.current && window.ptor && window.ptor.agent) {
          window.ptor.agent.abort(requestIdRef.current);
        }
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, streaming]);

  // Autofocus input when opened
  React.useEffect(() => {
    if (open && inputRef.current) {
      requestAnimationFrame(() => { inputRef.current && inputRef.current.focus(); });
    }
  }, [open]);

  // Cleanup chunk listener + raf on unmount
  React.useEffect(() => {
    return () => {
      if (unsubRef.current) { try { unsubRef.current(); } catch (_) {} }
      if (rafRef.current) { try { cancelAnimationFrame(rafRef.current); } catch (_) {} }
    };
  }, []);

  const submit = () => {
    const text = input.trim();
    if (!text) return;

    // Parse @prefix
    let agentName = currentAgent;
    let userMsg = text;
    const prefixMatch = text.match(/^@(\S+)\s*(.*)$/s);
    if (prefixMatch) {
      const prefix = prefixMatch[1];
      const rest = prefixMatch[2].trim();
      if (prefix === 'list') {
        setShowList(true);
        setInput('');
        return;
      }
      if (prefix === 'new') {
        // intentional-placeholder: v0158a is the MVP (spotlight + invoke + auto-seed
        // default-tutor agent). AgentManager UI for creating custom agents is the
        // discrete v0158b deliverable per plan 2026-05-04 — wait for user feedback
        // on v0158a before building creation flow. Manual workaround: user can
        // create vault/.agents/<name>/{system-prompt.md, config.json} by hand.
        setError('@new — agent creation UI deferred to v0158b. Manual workaround: create vault/.agents/<name>/system-prompt.md, then it appears in @list.');
        return;
      }
      if (agents.indexOf(prefix) >= 0) {
        agentName = prefix;
        setCurrentAgent(prefix);
        userMsg = rest || '...';
      } else {
        setError(`unknown agent: @${prefix}. Type @list to see available.`);
        return;
      }
    }

    if (!window.ptor || !window.ptor.agent) {
      setError('window.ptor.agent bridge missing — restart Hypha');
      return;
    }

    // Reset for new invocation
    setOutput('');
    outputBufRef.current = '';
    setError(null);
    setDone(false);
    setStreaming(true);
    setShowList(false);

    const reqId = 'spot_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    requestIdRef.current = reqId;

    const flushBuf = () => {
      rafRef.current = null;
      const buf = outputBufRef.current;
      setOutput(buf);
    };

    // Subscribe to chunks for this request
    if (unsubRef.current) { try { unsubRef.current(); } catch (_) {} }
    unsubRef.current = window.ptor.agent.onChunk((p) => {
      if (!p || p.requestId !== reqId) return;
      if (p.stage === 'chunk' && p.text) {
        outputBufRef.current += p.text;
        if (!rafRef.current) rafRef.current = requestAnimationFrame(flushBuf);
      } else if (p.stage === 'done') {
        if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
        setOutput(outputBufRef.current);  // final flush
        setStreaming(false);
        setDone(true);
      } else if (p.stage === 'error') {
        if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
        setOutput(outputBufRef.current);
        setStreaming(false);
        setError(p.error || 'invocation failed');
      }
    });

    window.ptor.agent.invoke(agentName, userMsg, reqId, 'spotlight', activeRel)
      .then(r => {
        setStreaming(false);
        if (r && r.ok) {
          setDone(true);
          if (r.text && !output) setOutput(r.text);  // fallback if chunks didn't arrive
        } else {
          setError((r && r.error) || 'invocation failed');
        }
      })
      .catch(err => {
        setStreaming(false);
        setError(String(err && err.message || err));
      });

    setInput('');
  };

  // Markdown render — reuse marked + DOMPurify globals (loaded by NoteView path)
  const outputHtml = React.useMemo(() => {
    if (!output) return '';
    if (typeof window.marked === 'undefined' || typeof window.DOMPurify === 'undefined') {
      const esc = output.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
      return esc.split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
    }
    try {
      const raw = window.marked.parse(output, { gfm: true, breaks: false });
      return window.DOMPurify.sanitize(raw, {
        ALLOWED_TAGS: ['p', 'em', 'strong', 'ul', 'ol', 'li', 'blockquote', 'a', 'code', 'pre', 'br', 'h1', 'h2', 'h3', 'h4'],
        ALLOWED_ATTR: ['href', 'target', 'rel'],
      });
    } catch (e) { return output; }
  }, [output]);

  if (!open) return null;

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        background: 'var(--bg-modal-backdrop, rgba(0,0,0,0.55))',
        backdropFilter: 'blur(8px) saturate(0.85)',
        WebkitBackdropFilter: 'blur(8px) saturate(0.85)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '12vh 24px 24px',
        animation: 'spot-fade-in 200ms ease-out',
      }}
    >
      <style>{`
        @keyframes spot-fade-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes spot-rise {
          from { opacity: 0; transform: translateY(-12px); }
          to { opacity: 1; transform: none; }
        }
        @keyframes spot-blink { 50% { opacity: 0.2; } }
        .spot-card {
          width: 100%; max-width: 720px;
          background: var(--bg-modal-card, #f5efe2);
          border-radius: 8px;
          padding: 0;
          box-shadow:
            inset 0 1px 0 color-mix(in srgb, var(--brass-bright) 22%, transparent),
            0 0 0 1px color-mix(in srgb, var(--brass-mid) 8%, transparent),
            0 32px 88px -16px rgba(0,0,0,0.55),
            0 6px 16px rgba(0,0,0,0.18);
          animation: spot-rise 280ms cubic-bezier(0.22, 1, 0.36, 1);
          font-family: "EB Garamond", "Noto Serif SC", serif;
          color: var(--ink-primary);
          display: flex; flex-direction: column;
          max-height: 76vh;
          overflow: hidden;
        }
        .spot-header {
          padding: 14px 22px 10px;
          border-bottom: 1px solid color-mix(in srgb, var(--brass-mid) 22%, transparent);
          display: flex; align-items: baseline; gap: 12px;
          font-size: 13px; color: var(--ink-faint); font-style: italic;
        }
        .spot-agent-tag {
          font-style: normal;
          color: var(--brass-bright);
          font-family: "JetBrains Mono", monospace;
          font-size: 12px;
          letter-spacing: 0.02em;
        }
        .spot-input {
          width: 100%;
          background: transparent;
          border: none;
          outline: none;
          padding: 18px 22px 14px;
          font-family: inherit;
          font-size: 19px;
          color: var(--ink-title);
          font-style: italic;
          letter-spacing: 0.005em;
        }
        .spot-input::placeholder { color: var(--ink-faint); opacity: 0.7; }
        .spot-status {
          padding: 6px 22px;
          font-size: 13px;
          color: var(--ink-faint);
          font-style: italic;
          display: flex; gap: 12px; align-items: baseline;
        }
        .spot-status-dot {
          color: var(--brass-mid);
          animation: spot-blink 1.1s step-end infinite;
        }
        .spot-output {
          flex: 1; min-height: 0;
          overflow-y: auto;
          padding: 8px 22px 22px;
          font-size: 17px; line-height: 1.7;
          color: var(--ink-primary);
        }
        .spot-output p { margin: 0 0 0.95em; }
        .spot-output p:last-child { margin-bottom: 0; }
        .spot-output strong { color: var(--ink-title); font-weight: 600; }
        .spot-output em { font-style: italic; color: var(--ink-muted); }
        .spot-output ul, .spot-output ol { margin: 0.5em 0 1em; padding-left: 1.4em; }
        .spot-output li { margin: 0.3em 0; }
        .spot-output blockquote {
          margin: 0.8em 0;
          padding: 0.2em 0 0.2em 14px;
          border-left: 2px solid color-mix(in srgb, var(--brass-mid) 35%, transparent);
          color: var(--ink-muted); font-style: italic;
        }
        .spot-output code {
          font-family: "JetBrains Mono", monospace;
          font-size: 14px;
          background: color-mix(in srgb, var(--brass-mid) 12%, transparent);
          padding: 1px 6px; border-radius: 3px;
        }
        .spot-cursor {
          display: inline-block; width: 1ch;
          color: var(--brass-mid);
          animation: spot-blink 1.1s step-end infinite;
        }
        .spot-error {
          padding: 8px 22px 18px;
          font-style: italic; font-size: 14.5px;
          color: var(--verdict-flag, #c46a5d);
        }
        .spot-list {
          padding: 8px 22px 18px;
          font-size: 14.5px;
        }
        .spot-list-item {
          padding: 4px 0;
          font-family: "JetBrains Mono", monospace;
          font-size: 13px;
          color: var(--ink-muted);
          cursor: pointer;
        }
        .spot-list-item:hover { color: var(--brass-bright); }
        .spot-list-item.active { color: var(--brass-bright); font-weight: 600; }
        .spot-help {
          padding: 6px 22px 12px;
          font-size: 12px; color: var(--ink-faint);
          font-style: italic;
          border-top: 1px solid color-mix(in srgb, var(--brass-mid) 18%, transparent);
        }
        .spot-help-key {
          font-family: "JetBrains Mono", monospace;
          font-style: normal;
          background: color-mix(in srgb, var(--brass-mid) 14%, transparent);
          padding: 1px 5px;
          border-radius: 2px;
          margin: 0 2px;
        }
      `}</style>
      <div className="spot-card">
        <div className="spot-header">
          <span>spotlight · invoking</span>
          <span className="spot-agent-tag">@{currentAgent}</span>
          {agents.length > 0 && (
            <span style={{ marginLeft: 'auto', fontSize: 12 }}>
              {agents.length} agent{agents.length === 1 ? '' : 's'} in vault
            </span>
          )}
        </div>
        <input
          ref={inputRef}
          className="spot-input"
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={streaming ? 'streaming…' : (activeRel
            ? `ask @${currentAgent} about ${activeRel} · prefix @other-agent to switch`
            : `ask @${currentAgent} anything · prefix @other-agent to switch · @list to see all`)}
          disabled={streaming}
        />
        {streaming && (
          <div className="spot-status">
            <span>thinking</span>
            <span className="spot-status-dot">●</span>
          </div>
        )}
        {showList && (
          <div className="spot-list">
            <div style={{ marginBottom: 8, color: 'var(--ink-faint)', fontStyle: 'italic' }}>
              available agents (click to switch):
            </div>
            {agents.length === 0 && (
              <div style={{ fontStyle: 'italic', color: 'var(--ink-faint)' }}>
                no agents yet. default-tutor will be auto-seeded on first invocation.
              </div>
            )}
            {agents.map(name => (
              <div
                key={name}
                className={`spot-list-item${name === currentAgent ? ' active' : ''}`}
                onClick={() => {
                  setCurrentAgent(name);
                  setShowList(false);
                  if (inputRef.current) inputRef.current.focus();
                }}
              >
                @{name}
              </div>
            ))}
          </div>
        )}
        {outputHtml && (
          <div className="spot-output">
            <span dangerouslySetInnerHTML={{ __html: outputHtml }} />
            {streaming && <span className="spot-cursor">▍</span>}
          </div>
        )}
        {error && <div className="spot-error">× {error}</div>}
        <div className="spot-help">
          <span className="spot-help-key">enter</span> send ·{' '}
          <span className="spot-help-key">esc</span> close ·{' '}
          <span className="spot-help-key">@name</span> switch agent ·{' '}
          <span className="spot-help-key">@list</span> show all
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Spotlight });
