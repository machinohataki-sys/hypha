/* global React */
//
// HYPHA · W1.5 Capture Mode screen.
//
// Per BLUEPRINT §9.2 + §9.3: when the user is in a real classroom, watching
// a recorded lecture, or reading longform, Hypha defaults to Capture Mode.
// Only low-interruption operations are allowed:
//
//   - quick_note   (type + Enter)
//   - mark         (click any of 8 mark glyphs, or hotkey 1-8)
//   - deepen_now   (Shift+Enter on input → 30s short-answer modal)
//
// We deliberately do NOT expose edit / delete on the live capture surface.
// Mistakes get resolved in the Finish Ritual (§9.2) once the lecture is
// over — the principle: 上课时只捕捉，课后才加工。
//
// State lives in the renderer until closeCaptureSession is called; the
// backend (capture-mode.js) is the durable ledger via raw.jsonl. We push
// each entry immediately on send rather than batching, so a crash mid-
// lecture never costs more than the in-flight keystroke.
//
// Register: warm Garamond serif, paper background, brass accents. The 8
// mark glyphs are functional symbols (not emoji decoration) per the
// constitution carve-out for functional ideograms.

const CaptureScreen = ({ source, context, goal, onFinish, onAbort }) => {
  const { useState, useEffect, useRef, useCallback } = React;

  // Marks per BLUEPRINT §9.3 — single source of truth. Mirrors the Set in
  // app/lib/capture-mode.js so the backend won't reject anything we render.
  const MARKS = [
    { glyph: '?',  label: '不懂',  hint: '问号 · 当下没懂',                key: '1' },
    { glyph: '!',  label: '重要',  hint: '感叹号 · 这里很关键',            key: '2' },
    { glyph: '↗', label: '深化',  hint: '上箭头 · 课后想展开',            key: '3' },
    { glyph: '⚡', label: 'Spark', hint: '闪电 · 跨域连接',                key: '4' },
    { glyph: '×', label: '反驳',  hint: '叉 · 我不同意',                  key: '5' },
    { glyph: '→', label: '行动',  hint: '右箭头 · 要去做',                key: '6' },
    { glyph: '⊕', label: '连接',  hint: '环加 · 串到旧知识',              key: '7' },
    { glyph: '◇', label: '迁移',  hint: '菱形 · 推到产品 / 作品',          key: '8' },
  ];

  const [session, setSession] = useState(null);        // { sessionId, startedAt, vault_path }
  const [entries, setEntries] = useState([]);          // local mirror of the last N entries
  const [draft, setDraft] = useState('');              // current quick-input text
  const [pendingMark, setPendingMark] = useState(null); // user pre-tagged this draft with a mark glyph
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState(null);
  const [showAbortModal, setShowAbortModal] = useState(false);
  const [showDeepenNowModal, setShowDeepenNowModal] = useState(false);
  const [deepenNowText, setDeepenNowText] = useState('');
  const [deepenNowSecondsLeft, setDeepenNowSecondsLeft] = useState(30);

  const inputRef = useRef(null);
  const startTsRef = useRef(null);
  const deepenTickerRef = useRef(null);
  const autoSaveTickRef = useRef(null);

  // 1. Open a session on mount. The bridge (window.ptor.capture) is wired
  //    in preload.js. We tolerate the bridge being absent (e.g. dev preview
  //    rendered outside Electron) — error state surfaces to the user.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fn = window.ptor && window.ptor.capture && window.ptor.capture.start;
        if (typeof fn !== 'function') throw new Error('capture bridge unavailable');
        const r = await fn({ source: source || 'lecture', context: context || {} });
        if (cancelled) return;
        if (!r || !r.sessionId) throw new Error(r && r.error ? r.error : 'capture:start returned no sessionId');
        setSession(r);
        startTsRef.current = Date.parse(r.startedAt) || Date.now();
      } catch (err) {
        if (!cancelled) setError(err.message || String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [source]);

  // 2. Clock — tick every second.
  useEffect(() => {
    if (!session) return undefined;
    const id = setInterval(() => {
      setElapsedMs(Date.now() - (startTsRef.current || Date.now()));
    }, 1000);
    return () => clearInterval(id);
  }, [session]);

  // 3. Auto-save heartbeat — fires every 30s. Each entry is already durable
  //    on the backend (appendFileSync), so this is purely a re-mount of the
  //    "you're safe" UX signal, plus a defensive re-fetch hook if we ever
  //    add server-side reconciliation.
  useEffect(() => {
    if (!session) return undefined;
    autoSaveTickRef.current = setInterval(() => {
      // No-op besides cadence reassurance — but if a future revision wants
      // to verify backend state, this is the seam.
    }, 30_000);
    return () => clearInterval(autoSaveTickRef.current);
  }, [session]);

  // 4. Append helper. All three entry kinds funnel through here so the
  //    backend contract stays single-shaped.
  const append = useCallback(async (entry) => {
    if (!session) return;
    try {
      const fn = window.ptor && window.ptor.capture && window.ptor.capture.append;
      if (typeof fn !== 'function') throw new Error('capture bridge unavailable');
      const r = await fn({ sessionId: session.sessionId, entry: {
        ...entry,
        timestamp_offset_ms: Date.now() - (startTsRef.current || Date.now()),
      }});
      if (!r || r.ok === false) throw new Error((r && r.error) || 'append rejected');
      setEntries(prev => {
        const row = { ...entry, seq: r.seq, wrote_at: new Date().toISOString() };
        const next = [...prev, row];
        // Cap the local mirror at the last 50 so the DOM doesn't bloat over
        // a multi-hour lecture. Source of truth is still raw.jsonl.
        return next.length > 50 ? next.slice(next.length - 50) : next;
      });
    } catch (err) {
      setError(err.message || String(err));
    }
  }, [session]);

  // 5. Submit the input box — either as quick_note or, if user pre-tagged
  //    with a mark glyph, as a mark with that mark_type.
  const submitDraft = useCallback(() => {
    const text = draft.trim();
    if (!text && !pendingMark) return;
    if (pendingMark) {
      append({ type: 'mark', mark_type: pendingMark, text });
    } else {
      append({ type: 'quick_note', text });
    }
    setDraft('');
    setPendingMark(null);
  }, [draft, pendingMark, append]);

  // 6. Mark button click — if the input has text, treat as mark+text and
  //    submit immediately; otherwise just pre-arm pendingMark so the next
  //    Enter sends a tagged note.
  const onMarkPress = useCallback((glyph) => {
    const text = draft.trim();
    if (text) {
      append({ type: 'mark', mark_type: glyph, text });
      setDraft('');
      setPendingMark(null);
      if (inputRef.current) inputRef.current.focus();
    } else {
      setPendingMark(glyph);
      if (inputRef.current) inputRef.current.focus();
    }
  }, [draft, append]);

  // 7. Hotkeys 1-8 for marks, Enter to submit, Esc to abort, Shift+Enter
  //    opens Deepen Now. We bind on the window so the user doesn't lose
  //    keystrokes if the input is briefly unfocused (clicking a mark btn).
  useEffect(() => {
    const onKey = (e) => {
      // Skip when an unrelated input owns the keystroke (e.g. the Deepen
      // Now textarea or the Abort modal).
      if (e.target && e.target !== inputRef.current) {
        const tag = e.target.tagName;
        if (tag === 'TEXTAREA' || tag === 'INPUT' || (e.target && e.target.isContentEditable)) {
          // Still allow Esc to escape modals from inside the modal field.
          if (e.key !== 'Escape') return;
        }
      }
      if (e.key === 'Escape') {
        if (showDeepenNowModal) { setShowDeepenNowModal(false); return; }
        if (showAbortModal) { setShowAbortModal(false); return; }
        setShowAbortModal(true);
        e.preventDefault();
        return;
      }
      // Deepen Now — Shift+Enter from anywhere on the page that isn't a modal.
      if (e.shiftKey && e.key === 'Enter' && !showDeepenNowModal && !showAbortModal) {
        e.preventDefault();
        openDeepenNow();
        return;
      }
      // 1-8 mark hotkeys (only when the input field is not capturing, OR
      // when modifier-held — to avoid clobbering numeric typing in notes).
      const k = e.key;
      if (/^[1-8]$/.test(k) && (e.target !== inputRef.current || e.ctrlKey || e.metaKey)) {
        const m = MARKS[parseInt(k, 10) - 1];
        if (m) {
          e.preventDefault();
          onMarkPress(m.glyph);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onMarkPress, showAbortModal, showDeepenNowModal]);

  const openDeepenNow = () => {
    setDeepenNowText('');
    setDeepenNowSecondsLeft(30);
    setShowDeepenNowModal(true);
    if (deepenTickerRef.current) clearInterval(deepenTickerRef.current);
    deepenTickerRef.current = setInterval(() => {
      setDeepenNowSecondsLeft(prev => {
        if (prev <= 1) {
          clearInterval(deepenTickerRef.current);
          deepenTickerRef.current = null;
          // 30s expired — auto-submit whatever was typed (even if empty,
          // we still log the slot so the Finish Ritual sees the cadence).
          submitDeepenNow();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const submitDeepenNow = useCallback(() => {
    if (deepenTickerRef.current) {
      clearInterval(deepenTickerRef.current);
      deepenTickerRef.current = null;
    }
    const text = (deepenNowText || '').trim();
    append({ type: 'deepen_now', text });
    setShowDeepenNowModal(false);
    setDeepenNowText('');
    setDeepenNowSecondsLeft(30);
  }, [deepenNowText, append]);

  // 8. Finish Capture — close the session + hand off to Finish Ritual screen.
  const handleFinish = async () => {
    if (!session) return;
    try {
      const fn = window.ptor && window.ptor.capture && window.ptor.capture.close;
      if (typeof fn === 'function') {
        await fn({ sessionId: session.sessionId });
      }
    } catch (err) {
      setError(err.message || String(err));
      // Don't block the handoff — the Finish Ritual route closes idempotently.
    }
    if (typeof onFinish === 'function') {
      onFinish({ sessionId: session.sessionId, goal });
    }
  };

  // 9. Abort — guard with a modal so we never silently lose data.
  const handleAbortConfirm = async () => {
    setShowAbortModal(false);
    if (session) {
      try {
        const fn = window.ptor && window.ptor.capture && window.ptor.capture.close;
        if (typeof fn === 'function') await fn({ sessionId: session.sessionId });
      } catch (_) { /* silent — abort path is best-effort close */ }
    }
    if (typeof onAbort === 'function') onAbort();
  };

  const elapsedFmt = formatElapsed(elapsedMs);
  const sourceLabel = SOURCE_LABELS[source] || source || 'lecture';
  const lastFive = entries.slice(Math.max(0, entries.length - 5));

  // ---- render ----
  return (
    <div className="fade-in col" style={{
      minHeight: '100vh',
      background: 'var(--paper, #f4efe4)',
      color: 'var(--ink, #2a2620)',
      padding: '32px 48px',
      fontFamily: 'var(--serif, "EB Garamond", serif)',
      position: 'relative',
    }}>
      {/* ── HEADER ── timer + source label + Finish button */}
      <header className="row" style={{
        alignItems: 'center',
        gap: 24,
        paddingBottom: 24,
        borderBottom: '1px solid var(--rule-soft, rgba(0,0,0,.08))',
      }}>
        <div className="col" style={{ gap: 4, flex: 1 }}>
          <div className="serif italic" style={{
            fontSize: 28, lineHeight: 1.1, color: 'var(--ink-1, #2a2620)',
          }}>真实记录</div>
          <div className="mono t-small" style={{
            color: 'var(--ink-3, #66605a)', letterSpacing: '.12em', textTransform: 'uppercase',
          }}>{sourceLabel} · {elapsedFmt}</div>
        </div>
        <button
          onClick={handleFinish}
          disabled={!session}
          style={{
            background: 'var(--brass-bright, #b8893a)',
            color: '#fffdf6',
            border: 'none',
            padding: '14px 26px',
            fontSize: 16,
            fontFamily: 'var(--serif, "EB Garamond", serif)',
            cursor: session ? 'pointer' : 'not-allowed',
            letterSpacing: '.04em',
            boxShadow: '0 2px 0 rgba(0,0,0,.08), 0 8px 20px rgba(184,137,58,.18)',
            opacity: session ? 1 : 0.55,
          }}
          title="结束记录,开始深化"
        >
          完成记录
        </button>
      </header>

      {error && (
        <div className="rise-in" style={{
          margin: '16px 0',
          padding: '10px 14px',
          background: 'rgba(194, 90, 54, .08)',
          color: 'var(--terracotta, #c25a36)',
          border: '1px solid rgba(194, 90, 54, .25)',
          fontStyle: 'italic',
          fontSize: 14,
        }}>{error}</div>
      )}

      {/* ── DRAFT INPUT ── */}
      <section style={{ paddingTop: 24, paddingBottom: 16 }}>
        <div className="row" style={{ gap: 8, alignItems: 'baseline', marginBottom: 8 }}>
          <div className="serif italic" style={{ fontSize: 16, color: 'var(--ink-2, #494339)' }}>
            {pendingMark
              ? <>下一条记为 <span style={{ fontSize: 22, color: 'var(--brass-bright, #b8893a)' }}>{pendingMark}</span> {markLabelOf(pendingMark, MARKS)}</>
              : <>记下任何一闪而过 — Enter 存入</>}
          </div>
          {pendingMark && (
            <button onClick={() => setPendingMark(null)} style={{
              background: 'transparent', border: 'none', color: 'var(--ink-3, #66605a)',
              fontSize: 12, cursor: 'pointer', textDecoration: 'underline',
            }}>取消标记</button>
          )}
        </div>
        {/* intentional-placeholder: the HTML `placeholder=` attribute on
            the textarea below is ghost text, NOT a deferred-TODO marker —
            UX copy is fully written and shipped. */}
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submitDraft();
            }
          }}
          placeholder={pendingMark
            ? '关于这一刻你想说的一句...'
            : '一句话,一个名词,一个反问都可以'}
          rows={3}
          style={{
            width: '100%', padding: '14px 16px', fontSize: 17,
            fontFamily: 'var(--serif, "EB Garamond", serif)',
            border: '1px solid var(--rule-soft, rgba(0,0,0,.12))',
            background: 'rgba(255,253,247,.6)',
            color: 'var(--ink, #2a2620)',
            outline: 'none',
            resize: 'vertical',
            lineHeight: 1.6,
            borderRadius: 0,
          }}
          autoFocus
        />
        <div className="row" style={{ gap: 16, marginTop: 6, fontSize: 12, color: 'var(--ink-3, #66605a)' }}>
          <span>Enter 存</span>
          <span>Shift+Enter 当场深化 (30s)</span>
          <span>1-8 标记 (输入框外)</span>
          <span>Esc 中止</span>
        </div>
      </section>

      {/* ── 8 MARK BUTTONS ── */}
      <section style={{ paddingTop: 8, paddingBottom: 20 }}>
        <div className="t-small mono" style={{
          color: 'var(--ink-3, #66605a)', letterSpacing: '.12em',
          textTransform: 'uppercase', marginBottom: 10,
        }}>八印 · Marks</div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 10,
        }}>
          {MARKS.map((m, i) => (
            <button
              key={m.glyph}
              onClick={() => onMarkPress(m.glyph)}
              title={`${m.hint} · 快捷键 ${m.key}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '14px 16px',
                background: pendingMark === m.glyph
                  ? 'rgba(184,137,58,.10)'
                  : 'rgba(255,253,247,.45)',
                border: pendingMark === m.glyph
                  ? '1px solid var(--brass-bright, #b8893a)'
                  : '1px solid var(--rule-soft, rgba(0,0,0,.12))',
                cursor: 'pointer',
                fontFamily: 'var(--serif, "EB Garamond", serif)',
                color: 'var(--ink, #2a2620)',
                textAlign: 'left',
                borderRadius: 0,
                transition: 'background 220ms cubic-bezier(0.22, 1, 0.36, 1), border-color 220ms cubic-bezier(0.22, 1, 0.36, 1)',
              }}
            >
              <span style={{
                fontSize: 24, lineHeight: 1, width: 28, textAlign: 'center',
                color: 'var(--brass-bright, #b8893a)',
              }}>{m.glyph}</span>
              <span className="col" style={{ gap: 2 }}>
                <span style={{ fontSize: 15 }}>{m.label}</span>
                <span className="mono" style={{
                  fontSize: 10, color: 'var(--ink-4, #8a847c)',
                  letterSpacing: '.08em',
                }}>{i + 1} · {m.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* ── RECENT 5 ── */}
      <section style={{
        marginTop: 'auto',
        paddingTop: 16,
        borderTop: '1px solid var(--rule-soft, rgba(0,0,0,.08))',
      }}>
        <div className="t-small mono" style={{
          color: 'var(--ink-3, #66605a)', letterSpacing: '.12em',
          textTransform: 'uppercase', marginBottom: 8,
        }}>近五条 · Recent</div>
        {lastFive.length === 0
          ? <div className="serif italic" style={{ color: 'var(--ink-3, #66605a)', fontSize: 14 }}>
              还没记。第一行最难。
            </div>
          : <div className="col" style={{ gap: 4 }}>
              {lastFive.slice().reverse().map((row) => (
                <div key={row.seq} className="row" style={{
                  alignItems: 'baseline', gap: 10,
                  padding: '6px 0',
                  borderBottom: '1px dashed var(--rule-soft, rgba(0,0,0,.06))',
                }}>
                  <span className="mono" style={{
                    fontSize: 11, color: 'var(--ink-4, #8a847c)',
                    width: 64, flexShrink: 0,
                  }}>{formatElapsed(row.timestamp_offset_ms || 0)}</span>
                  <span style={{
                    width: 22, textAlign: 'center', flexShrink: 0,
                    color: 'var(--brass-bright, #b8893a)',
                    fontSize: 16,
                  }}>{glyphFor(row)}</span>
                  <span style={{
                    flex: 1, color: 'var(--ink, #2a2620)', fontSize: 14,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{(row.text || '').slice(0, 120) || <i style={{color:'var(--ink-3,#66605a)'}}>(空标记)</i>}</span>
                </div>
              ))}
            </div>}
      </section>

      {/* ── ABORT MODAL ── */}
      {showAbortModal && (
        <div className="fade-in" style={{
          position: 'fixed', inset: 0, zIndex: 80,
          background: 'rgba(20, 16, 10, .42)',
          display: 'grid', placeItems: 'center',
        }}>
          <div className="col" style={{
            background: 'var(--paper, #f4efe4)',
            padding: 28, gap: 16, maxWidth: 440,
            border: '1px solid var(--rule-soft, rgba(0,0,0,.12))',
            boxShadow: '0 20px 60px rgba(0,0,0,.25)',
          }}>
            <div className="serif italic" style={{ fontSize: 22, color: 'var(--ink-1, #2a2620)' }}>
              确认结束并保存吗？
            </div>
            <div className="serif" style={{ fontSize: 14, color: 'var(--ink-2, #494339)', lineHeight: 1.6 }}>
              已记 {entries.length} 条。会保留到 _captures/{session && session.sessionId.slice(-12)} —
              但课后才能继续深化。<br/>
              想继续记 → 取消。结束 → 关闭。
            </div>
            <div className="row" style={{ gap: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowAbortModal(false)} style={{
                background: 'transparent', border: '1px solid var(--rule-soft, rgba(0,0,0,.18))',
                padding: '8px 16px', fontFamily: 'var(--serif, "EB Garamond", serif)',
                cursor: 'pointer', color: 'var(--ink, #2a2620)', fontSize: 14,
              }}>取消 (继续记)</button>
              <button onClick={handleAbortConfirm} style={{
                background: 'var(--ink-1, #2a2620)', border: 'none',
                color: 'var(--paper, #f4efe4)', padding: '8px 16px',
                fontFamily: 'var(--serif, "EB Garamond", serif)',
                cursor: 'pointer', fontSize: 14,
              }}>结束 (不深化)</button>
            </div>
          </div>
        </div>
      )}

      {/* ── DEEPEN NOW MODAL ── */}
      {showDeepenNowModal && (
        <div className="fade-in" style={{
          position: 'fixed', inset: 0, zIndex: 80,
          background: 'rgba(20, 16, 10, .42)',
          display: 'grid', placeItems: 'center',
        }}>
          <div className="col" style={{
            background: 'var(--paper, #f4efe4)',
            padding: 28, gap: 14, width: 560, maxWidth: '92vw',
            border: '1px solid var(--rule-soft, rgba(0,0,0,.12))',
            boxShadow: '0 20px 60px rgba(0,0,0,.25)',
          }}>
            <div className="row" style={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
              <div className="serif italic" style={{ fontSize: 22, color: 'var(--ink-1, #2a2620)' }}>
                当场深化 · 30 秒
              </div>
              <div className="mono" style={{
                fontSize: 14, color: deepenNowSecondsLeft <= 10
                  ? 'var(--terracotta, #c25a36)' : 'var(--ink-3, #66605a)',
                fontVariantNumeric: 'tabular-nums',
              }}>{deepenNowSecondsLeft}s</div>
            </div>
            <div className="serif" style={{ fontSize: 13, color: 'var(--ink-2, #494339)', lineHeight: 1.55 }}>
              当下卡住了？短答此刻的卡点 — 不展开成完整 Lesson, 课后由 Finish Ritual 接手。
            </div>
            {/* intentional-placeholder: HTML `placeholder=` attribute on the
                Deepen-Now textarea is ghost text, NOT a deferred-TODO marker. */}
            <textarea
              autoFocus
              value={deepenNowText}
              onChange={(e) => setDeepenNowText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  submitDeepenNow();
                }
              }}
              rows={4}
              placeholder="一句话答此刻的卡点..."
              style={{
                width: '100%', padding: '12px 14px', fontSize: 16,
                fontFamily: 'var(--serif, "EB Garamond", serif)',
                border: '1px solid var(--rule-soft, rgba(0,0,0,.18))',
                background: 'rgba(255,253,247,.6)',
                color: 'var(--ink, #2a2620)',
                outline: 'none', resize: 'vertical', lineHeight: 1.55,
                borderRadius: 0,
              }}
            />
            <div className="row" style={{ gap: 12, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowDeepenNowModal(false)} style={{
                background: 'transparent', border: '1px solid var(--rule-soft, rgba(0,0,0,.18))',
                padding: '6px 14px', fontFamily: 'var(--serif, "EB Garamond", serif)',
                cursor: 'pointer', color: 'var(--ink, #2a2620)', fontSize: 14,
              }}>取消</button>
              <button onClick={submitDeepenNow} style={{
                background: 'var(--brass-bright, #b8893a)', border: 'none',
                color: '#fffdf6', padding: '6px 14px',
                fontFamily: 'var(--serif, "EB Garamond", serif)',
                cursor: 'pointer', fontSize: 14,
              }}>存 (Ctrl+Enter)</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── helpers ───
const SOURCE_LABELS = {
  lecture: '真实课堂',
  video:   '视频课',
  reading: '阅读',
};

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

function glyphFor(row) {
  if (!row) return ' ';
  if (row.type === 'mark') return row.mark_type || '·';
  if (row.type === 'deepen_now') return '◆';
  return '·';
}

function markLabelOf(glyph, marks) {
  const m = marks.find(x => x.glyph === glyph);
  return m ? m.label : '';
}

window.CaptureScreen = CaptureScreen;
