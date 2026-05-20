/* global React */
//
// HYPHA · W3.6 Companion Presence — UI hook for trigger fires.
//
// Owns three responsibilities, all narrow:
//   1. Render the most recent companion expression as a low-attention
//      Garamond italic toast in the corner (3-second auto-dismiss).
//   2. Surface a debug-only "Last 20 fires" panel when the user holds
//      the ⌥ key while clicking the presence dot.
//   3. Listen for trigger events so the renderer doesn't have to.
//
// The presence dot itself stays minimal — manuscript register, no chrome.
// All text comes from W3.5 tone-engine via window.ptor.companion (W3.6
// boundary: we never compose the spore-language ourselves here).

const CompanionPresence = ({ slug }) => {
  const { useState, useEffect, useCallback, useRef } = React;

  const [expression, setExpression] = useState(null);  // { text, tone, ts, mock?, mockReason? }
  const [history, setHistory] = useState([]);          // last 20 fires
  const [showHistory, setShowHistory] = useState(false);
  // W8.3 Adaptive UX — companion_enabled preference hides the entire surface.
  const [companionEnabled, setCompanionEnabled] = useState(true);
  const dismissTimerRef = useRef(null);

  useEffect(() => {
    if (!(window.ptor && window.ptor.ux)) return;
    let cancelled = false;
    window.ptor.ux.loadPrefs(slug || null).then(r => {
      if (!cancelled && r && r.ok && r.preferences) {
        setCompanionEnabled(r.preferences.companion_enabled !== false);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [slug]);

  // Auto-dismiss 3 seconds after a new expression lands.
  useEffect(() => {
    if (!expression) return undefined;
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = setTimeout(() => setExpression(null), 3000);
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, [expression]);

  // Receive trigger events. W3.5 will (when shipped) push these through a
  // window-level CustomEvent so any surface can pick them up without an
  // explicit subscription. Until then we poll the history on slug-change.
  useEffect(() => {
    const handler = (evt) => {
      const detail = evt && evt.detail;
      if (!detail || !detail.text) return;
      // v0 mock marker carries through the envelope when companionRespond
      // (tone-engine path) was deterministic-template. detail.mock is the
      // tagged envelope; detail.mockReason is the human reason. Both
      // optional — when Gemma 3 4B ships in v0.8 the upstream stops
      // setting them and the toast banner disappears automatically.
      setExpression({
        text: detail.text,
        tone: detail.tone || 'neutral',
        ts: Date.now(),
        mock: detail.mock || null,
        mockReason: detail.mockReason || '',
      });
    };
    window.addEventListener('companion:expression', handler);
    return () => window.removeEventListener('companion:expression', handler);
  }, []);

  const refreshHistory = useCallback(async () => {
    if (!slug) return;
    try {
      const r = await window.ptor.companion.history(slug, 20);
      if (r && r.ok) setHistory(r.fires || []);
    } catch (_) { /* debug panel is advisory */ }
  }, [slug]);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  const onPresenceClick = (evt) => {
    if (evt && evt.altKey) {
      setShowHistory((v) => !v);
      refreshHistory();
    }
  };

  if (!companionEnabled) return null;  // W8.3 — user opted out via UX prefs.

  return (
    React.createElement('div', { className: 'hypha-companion-presence' },
      // Toast — only renders when there's an active expression.
      expression && React.createElement('div', {
        className: 'hypha-companion-toast',
        style: {
          position: 'fixed',
          right: '24px',
          bottom: '40px',
          maxWidth: '320px',
          padding: '12px 16px',
          background: 'rgba(244, 238, 225, 0.96)',  // cream
          border: '1px solid rgba(120, 96, 64, 0.18)',
          borderRadius: '2px',
          fontFamily: '"EB Garamond", "Noto Serif SC", serif',
          fontStyle: 'italic',
          fontSize: '14px',
          color: '#3a2f20',
          lineHeight: 1.5,
          letterSpacing: '0.01em',
          boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
          zIndex: 9999,
        },
      },
        expression.text,
        // v0 mock marker — tone-engine ships deterministic templates until
        // T2_LOCAL Gemma 3 4B (v0.8). When the envelope is tagged, render
        // the italic "v0 模板输出" stamp inline; when Gemma swap lands and
        // the upstream stops setting mock=, the banner disappears.
        (typeof window !== 'undefined' && typeof window.V0MockBanner === 'function')
          ? React.createElement(window.V0MockBanner, {
              payload: expression.mock || { _hypha_mock: 'v0-template-output', _mock_reason: expression.mockReason || 'companion tone-engine v0' },
              compact: true,
              style: { marginLeft: 10, display: 'inline-block' },
            })
          : null
      ),

      // Presence dot — Alt+click to toggle history panel.
      React.createElement('button', {
        className: 'hypha-companion-dot',
        onClick: onPresenceClick,
        title: '菌类星人 · alt-click 查看最近 20 次',
        style: {
          position: 'fixed',
          right: '24px',
          bottom: '16px',
          width: '10px',
          height: '10px',
          padding: 0,
          border: 'none',
          borderRadius: '50%',
          background: expression ? '#a8845c' : 'rgba(168, 132, 92, 0.32)',
          cursor: 'pointer',
          zIndex: 9998,
          transition: 'background 600ms ease-out',
        },
      }),

      // Debug history panel — alt-click only. Shows last 20 fires.
      showHistory && React.createElement('div', {
        className: 'hypha-companion-history',
        style: {
          position: 'fixed',
          right: '24px',
          bottom: '40px',
          width: '320px',
          maxHeight: '60vh',
          overflowY: 'auto',
          padding: '12px 16px',
          background: 'rgba(244, 238, 225, 0.98)',
          border: '1px solid rgba(120, 96, 64, 0.24)',
          borderRadius: '2px',
          fontFamily: '"EB Garamond", "Noto Serif SC", serif',
          fontSize: '13px',
          color: '#3a2f20',
          zIndex: 9997,
        },
      },
        React.createElement('div', {
          style: { fontStyle: 'italic', marginBottom: '8px', opacity: 0.7 },
        }, `近 ${history.length} 次菌丝活动`),
        history.length === 0 && React.createElement('div', {
          style: { opacity: 0.5 },
        }, '尚未有任何触发'),
        history.map((f, i) => React.createElement('div', {
          key: `${f.ts}-${i}`,
          style: {
            padding: '4px 0',
            borderBottom: i < history.length - 1
              ? '1px dotted rgba(120, 96, 64, 0.18)' : 'none',
          },
        },
          React.createElement('span', { style: { fontVariant: 'small-caps', opacity: 0.65 } }, f.type),
          React.createElement('span', { style: { opacity: 0.45, marginLeft: '8px', fontSize: '11px' } },
            (f.ts || '').slice(11, 16))
        ))
      )
    )
  );
};

// Imperative API for surfaces that want to push a companion expression
// programmatically (e.g. W3.5 expression engine after companionRespond
// resolves). Fires a window CustomEvent so the listener above renders it.
function pushCompanionExpression(text, tone, opts) {
  if (!text) return;
  // Accept optional { mock, mockReason } so callers that have the full
  // companionRespond envelope can propagate the v0 marker into the toast
  // banner. Legacy 2-arg callsites stay valid — marker simply absent.
  const mock = opts && opts.mock ? opts.mock : null;
  const mockReason = opts && opts.mockReason ? opts.mockReason : '';
  try {
    window.dispatchEvent(new CustomEvent('companion:expression', {
      detail: { text, tone: tone || 'neutral', mock, mockReason },
    }));
  } catch (_) { /* no DOM — silent */ }
}

if (typeof window !== 'undefined') {
  window.CompanionPresence = CompanionPresence;
  window.pushCompanionExpression = pushCompanionExpression;
}
