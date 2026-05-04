// AskCard — 2026-04-28 council redesign (AENY polish, Muse counter deferred to v0.2).
// Council ONE_PATH (hybrid): keep AskCard as v0.1 modal but compress to a single
// editorial card — kill template name, file name, stopwatch, Pin-as-new button.
// Source preview: 14px italic top+bottom hairline (no SaaS left-border blockquote).
// Stream: 19px Garamond 1.74, markdown via marked + DOMPurify (white-listed tags).
// Card uses --bg-modal-card token (day+night auto-aware), 14px capsule buttons
// matching ImportDialog. v0.2 will refactor to zero-chrome inline callout (Muse).

function AskCard({ template, selection, noteRel, onClose, onPin, onAppend }) {
  const [text, setText] = React.useState('');
  const [done, setDone] = React.useState(false);
  const [error, setError] = React.useState(null);
  const requestIdRef = React.useRef('req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));

  React.useEffect(() => {
    let mounted = true;
    if (!window.ptor || !window.ptor.llm) {
      setError('ptor.llm bridge missing'); setDone(true); return;
    }
    const unsub = window.ptor.llm.onChunk(({ requestId, text: chunk }) => {
      if (!mounted) return;
      if (requestId !== requestIdRef.current) return;
      setText(t => t + chunk);
    });
    // v0150 — deepen template routes through provider-aware llm:deepen-popover
    // (honors user's chosen LLM + injects vault context). Other templates
    // (legacy) keep using the gemini-only llm:run path.
    const useDeepenPopover = (template === 'deepen' && typeof window.ptor.llm.deepenPopover === 'function');
    const callP = useDeepenPopover
      ? window.ptor.llm.deepenPopover(selection, noteRel || '', requestIdRef.current)
      : window.ptor.llm.run(template, { SELECTION: selection, NOTE_REL: noteRel || '' }, requestIdRef.current);
    callP
      .then(res => {
        if (!mounted) return;
        if (res && res.error) setError(res.error);
        else if (res && res.ok === false) setError(useDeepenPopover ? 'deepen failed' : `gemini exit ${res.exitCode}: ${res.stderr || ''}`);
        setDone(true);
      })
      .catch(err => { if (mounted) { setError(String(err && err.message || err)); setDone(true); } });
    return () => {
      mounted = false; unsub();
      // v0150 — deepenPopover shares _deepenAbort map with the 7-stage pipeline,
      // so abort via deepenAbort. Legacy llm.run path uses the original llm.abort.
      if (useDeepenPopover) { try { window.ptor.llm.deepenAbort && window.ptor.llm.deepenAbort(requestIdRef.current); } catch (_) {} }
      else { try { window.ptor.llm.abort(requestIdRef.current); } catch (_) {} }
    };
  }, [template, selection, noteRel]);

  // Esc closes
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Markdown render — reuse window.marked + window.DOMPurify (already loaded by NoteView).
  // White-list keeps: strong, em, p, ul, ol, li, blockquote, br. No headings (deepen
  // output is paragraph-scale, not document), no code (gemini rarely returns inline
  // code for prose), no links (avoid prompt-injection click-jacks), no img.
  const html = React.useMemo(() => {
    if (!text) return '';
    if (typeof window.marked === 'undefined' || typeof window.DOMPurify === 'undefined') {
      // Graceful fallback — escape + para break.
      const esc = text.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
      return esc.split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
    }
    try {
      const raw = window.marked.parse(text, { gfm: true, breaks: false });
      return window.DOMPurify.sanitize(raw, {
        ALLOWED_TAGS: ['p', 'strong', 'em', 'ul', 'ol', 'li', 'blockquote', 'br'],
        ALLOWED_ATTR: [],
      });
    } catch (e) {
      return text;
    }
  }, [text]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'var(--bg-modal-backdrop)',
        backdropFilter: 'blur(8px) saturate(0.85)',
        WebkitBackdropFilter: 'blur(8px) saturate(0.85)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 32,
        animation: 'ask-fade-in 320ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <style>{`
        @keyframes ask-fade-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes ask-rise {
          from { opacity: 0; transform: translateY(10px) scale(0.985); }
          to   { opacity: 1; transform: none; }
        }
        @keyframes ask-blink { 50% { opacity: 0.15; } }

        .ask-card-source {
          font-family: "EB Garamond", "Noto Serif SC", "Cormorant Garamond", serif;
          font-size: 14px;
          font-style: italic;
          line-height: 1.6;
          color: var(--ink-faint);
          padding: 16px 0;
          margin: 0 0 26px;
          border-top: 1px solid color-mix(in srgb, var(--brass-mid) 22%, transparent);
          border-bottom: 1px solid color-mix(in srgb, var(--brass-mid) 22%, transparent);
          max-height: 84px; overflow: hidden;
          position: relative;
        }
        .ask-card-source::after {
          content: ''; position: absolute;
          left: 0; right: 0; bottom: 1px; height: 28px;
          background: linear-gradient(to bottom, transparent, var(--bg-modal-card));
          pointer-events: none;
        }
        .ask-card-thinking {
          font-family: "EB Garamond", "Noto Serif SC", serif;
          font-style: italic;
          font-size: 16px;
          color: var(--ink-faint);
          text-align: center;
          padding: 28px 0;
          letter-spacing: 0.005em;
        }
        .ask-card-thinking-dot {
          display: inline-block; width: 1ch;
          animation: ask-blink 1.1s step-end infinite;
        }
        .ask-card-stream {
          font-family: "EB Garamond", "Noto Serif SC", "Source Han Serif SC", serif;
          font-size: 19px;
          line-height: 1.74;
          color: var(--ink-primary);
          word-break: break-word;
        }
        .ask-card-stream p { margin: 0 0 0.95em; }
        .ask-card-stream p:last-child { margin-bottom: 0; }
        .ask-card-stream strong { color: var(--ink-title); font-weight: 500; }
        .ask-card-stream em { font-style: italic; color: var(--ink-muted); }
        .ask-card-stream ul, .ask-card-stream ol { margin: 0.5em 0 1em; padding-left: 1.4em; }
        .ask-card-stream li { margin: 0.3em 0; }
        .ask-card-stream blockquote {
          margin: 0.8em 0;
          padding: 0.2em 0 0.2em 14px;
          border-left: 2px solid color-mix(in srgb, var(--brass-mid) 35%, transparent);
          color: var(--ink-muted);
          font-style: italic;
        }
        .ask-card-cursor {
          display: inline-block;
          width: 1ch;
          color: var(--brass-mid);
          animation: ask-blink 1.1s step-end infinite;
          margin-left: 1px;
        }

        .ask-card-btn {
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
        .ask-card-btn:hover:not(:disabled) {
          color: var(--ink-title);
          background: color-mix(in srgb, var(--brass-mid) 11%, transparent);
        }
        .ask-card-btn:disabled { opacity: 0.32; cursor: not-allowed; }
        .ask-card-btn.primary {
          color: var(--brass-bright);
          background: color-mix(in srgb, var(--brass-mid) 11%, transparent);
        }
        .ask-card-btn.primary:hover:not(:disabled) {
          background: color-mix(in srgb, var(--brass-mid) 18%, transparent);
          color: var(--ink-title);
        }
        .ask-card-btn.ghost {
          background: transparent;
          color: var(--ink-muted);
          opacity: 0.78;
          padding-left: 14px; padding-right: 14px;
        }
        .ask-card-btn.ghost:hover:not(:disabled) {
          background: color-mix(in srgb, var(--brass-mid) 4%, transparent);
          color: var(--ink-title);
          opacity: 1;
        }
      `}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 480,
          maxHeight: 'min(76vh, 720px)',
          background: 'var(--bg-modal-card)',
          borderRadius: 6,
          padding: '40px 44px 30px',
          boxShadow:
            'inset 0 1px 0 color-mix(in srgb, var(--brass-bright) 22%, transparent), ' +
            '0 0 0 1px color-mix(in srgb, var(--brass-mid) 8%, transparent), ' +
            '0 32px 88px -16px rgba(0, 0, 0, 0.55), ' +
            '0 6px 16px rgba(0, 0, 0, 0.18)',
          display: 'flex', flexDirection: 'column',
          animation: 'ask-rise 320ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        {/* Source — what the user selected. Italic Garamond, top+bottom hairline,
            faded bottom edge if longer than 84px. No left blockquote bar. */}
        <div className="ask-card-source">
          {selection.length > 240 ? selection.slice(0, 240).trimEnd() + '…' : selection}
        </div>

        {/* Stream — markdown rendered if marked + DOMPurify available, escape fallback else.
            Thinking placeholder italic centered while empty. Error inline italic flag-color. */}
        <div style={{ flex: 1, minHeight: 60, maxHeight: '50vh', overflow: 'auto', padding: '2px 2px 12px', marginBottom: 26 }}>
          {!text && !error && !done && (
            <div className="ask-card-thinking">
              a moment<span className="ask-card-thinking-dot">…</span>
            </div>
          )}
          {text && (
            <div className="ask-card-stream">
              <span dangerouslySetInnerHTML={{ __html: html }} />
              {!done && <span className="ask-card-cursor">▍</span>}
            </div>
          )}
          {error && (
            <div style={{
              color: 'var(--verdict-flag, #c46a5d)', fontStyle: 'italic',
              fontSize: 14, marginTop: 10, fontFamily: '"EB Garamond", serif',
            }}>{error}</div>
          )}
        </div>

        {/* Actions — 2 buttons (was 3). Pin-as-new merged into Keep (= append).
            v0.2 will reintroduce Pin via Cmd+Shift+Enter shortcut + zero-chrome callout refactor. */}
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button className="ask-card-btn ghost" onClick={onClose}>Discard</button>
          <button
            className="ask-card-btn primary"
            disabled={!text || !done}
            onClick={() => onAppend && onAppend(text, template)}
            title="Append to current note"
          >
            Keep
          </button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { AskCard });
