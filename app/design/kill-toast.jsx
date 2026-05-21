/* global React */
//
// HYPHA · Kill Toast (creation system surface, 2026-05-14, Machino-C7)
//
// Mounts at the App root (fixed top-right) and listens for the
// `creation:kill-watch-done` broadcast emitted by main.js after each
// kill-watcher sweep (startup auto-sweep 60s after whenReady + manual
// sweep via creation:killWatch:sweep IPC).
//
// When the broadcast carries refuted/rejected/flagged > 0, a single toast
// surfaces the auto-purge so the user knows that the system just changed
// state on their behalf. Manuscript register: cream paper, brass hairline,
// ink primary text, tabac caption. No emoji, no exclamation.
//
// Lifecycle:
//   - 5s auto-dismiss (paused on hover)
//   - "我知道了"  → immediate close
//   - "查看详情"  → routes via window.__hyphaOpenSparkPool /
//                   __hyphaOpenDecisions (best-effort, falls back to
//                   broadcasting a routing intent the App layer can catch)
//
// Defensive payload reader:
//   summary.refuted etc.       (flat shape — current main.js, both startup
//                               and manual paths use this)
//   summary.by_kind.<*>.length (alternate shape — kill-watcher.js raw
//                               return; defended for forward-compat)

const KILL_TOAST_PALETTE = {
  ink:    '#2A1F12',  // 墨水
  ink2:   '#4a3530',  // 主文 (alt)
  tabac:  '#5C4E36',  // 棕褐 (副文 / 按钮)
  brass:  '#B8A372',  // 黄铜 hairline
  cream:  '#F4EBD9',  // 奶油背景
};

function _readSummary(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const s = payload.summary;
  if (!s || typeof s !== 'object') return null;
  // Prefer flat shape (main.js current emit). Fall through to by_kind for
  // raw kill-watcher.js summary in case a future caller forwards it as-is.
  if (s.by_kind && typeof s.by_kind === 'object') {
    const bk = s.by_kind;
    return {
      refuted:  Array.isArray(bk.assumptions_refuted) ? bk.assumptions_refuted.length : (Number(s.refuted) || 0),
      rejected: Array.isArray(bk.sparks_rejected)     ? bk.sparks_rejected.length     : (Number(s.rejected) || 0),
      flagged:  Array.isArray(bk.decisions_flagged)   ? bk.decisions_flagged.length   : (Number(s.flagged) || 0),
    };
  }
  return {
    refuted:  Number(s.refuted)  || 0,
    rejected: Number(s.rejected) || 0,
    flagged:  Number(s.flagged)  || 0,
  };
}

function _formatStamp(d) {
  // Editorial timestamp: YYYY-MM-DD HH:MM, local time. Defensive on Date.
  const dd = d instanceof Date ? d : new Date();
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return (
    dd.getFullYear() + '-' +
    pad(dd.getMonth() + 1) + '-' +
    pad(dd.getDate()) + ' ' +
    pad(dd.getHours()) + ':' +
    pad(dd.getMinutes())
  );
}

const KillToast = () => {
  const [entry, setEntry] = React.useState(null); // { refuted, rejected, flagged, source, stamp, key }
  const [visible, setVisible] = React.useState(false);
  const [hovering, setHovering] = React.useState(false);
  const timerRef = React.useRef(null);

  // Subscribe once on mount to creation:kill-watch-done. Defensive against
  // missing window.ptor / preload mismatch — onKillWatchDone may be absent in
  // legacy builds or screenshot mode.
  React.useEffect(() => {
    if (!window.ptor || !window.ptor.creation || typeof window.ptor.creation.onKillWatchDone !== 'function') {
      return undefined;
    }
    const off = window.ptor.creation.onKillWatchDone((payload) => {
      const counts = _readSummary(payload);
      if (!counts) return;
      const { refuted, rejected, flagged } = counts;
      if (refuted + rejected + flagged <= 0) return;
      const source = (payload && payload.source) === 'manual' ? 'manual' : 'startup';
      setEntry({
        refuted, rejected, flagged, source,
        stamp: _formatStamp(new Date()),
        key: Date.now(),
      });
      setVisible(true);
    });
    return () => { try { off(); } catch (_) {} };
  }, []);

  // 5s auto-dismiss with hover pause. Restart timer whenever a new entry
  // surfaces or the user stops hovering.
  React.useEffect(() => {
    if (!visible || !entry) return undefined;
    if (hovering) return undefined;
    timerRef.current = setTimeout(() => {
      setVisible(false);
    }, 5000);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [visible, hovering, entry && entry.key]);

  // Clear entry shortly after fade-out so the next broadcast can mount fresh.
  React.useEffect(() => {
    if (visible) return undefined;
    if (!entry) return undefined;
    const t = setTimeout(() => setEntry(null), 400);
    return () => clearTimeout(t);
  }, [visible, entry]);

  if (!entry) return null;

  // "查看详情": best-effort route. We don't own setRoute here; we surface a
  // window-level intent the App layer can consume. The cmd-K palette path is
  // a safe fallback that always exists when this component is mounted.
  const handleDetails = () => {
    setVisible(false);
    try {
      // Priority: spark-pool when sparks rejected, else decision-ledger surface
      // (currently lives inside the lesson screen post-audit card).
      const detail = {
        refuted: entry.refuted,
        rejected: entry.rejected,
        flagged: entry.flagged,
      };
      const ev = new CustomEvent('hypha:kill-toast:details', { detail });
      window.dispatchEvent(ev);
    } catch (_) { /* no-op */ }
  };

  const handleDismiss = () => {
    setVisible(false);
  };

  const sourceLabel = entry.source === 'manual' ? '你主动触发' : '启动时';

  // Compose lines defensively — only render non-zero counts so the card stays
  // tight when only one kind fired.
  const lines = [];
  if (entry.refuted > 0)  lines.push(`${entry.refuted} 条假设到期未验证 · 已标推翻`);
  if (entry.rejected > 0) lines.push(`${entry.rejected} 个灵感到期未推进 · 已标搁置`);
  if (entry.flagged > 0)  lines.push(`${entry.flagged} 条决策到期未复查 · 已标需复查`);

  // Container styles. Fade in/out via opacity + transform; honors hover-pause.
  const containerStyle = {
    position: 'fixed',
    top: 16,
    right: 16,
    maxWidth: 360,
    zIndex: 9999,
    background: KILL_TOAST_PALETTE.cream,
    border: `1px solid ${KILL_TOAST_PALETTE.brass}`,
    borderRadius: 2,
    padding: '14px 18px 12px 18px',
    boxShadow: '0 8px 24px rgba(40,30,15,.14), 0 1px 2px rgba(40,30,15,.06)',
    fontFamily: 'EB Garamond, "Noto Serif SC", Georgia, serif',
    color: KILL_TOAST_PALETTE.ink,
    opacity: visible ? 1 : 0,
    transform: visible ? 'translateY(0)' : 'translateY(-6px)',
    transition: 'opacity 320ms ease, transform 320ms ease',
    pointerEvents: visible ? 'auto' : 'none',
  };

  const captionStyle = {
    fontFamily: 'EB Garamond, "Noto Serif SC", Georgia, serif',
    fontStyle: 'italic',
    fontSize: 11,
    lineHeight: 1.4,
    color: KILL_TOAST_PALETTE.ink,
    marginBottom: 8,
    letterSpacing: '0.01em',
  };

  const lineStyle = {
    fontFamily: 'EB Garamond, "Noto Serif SC", Georgia, serif',
    fontStyle: 'normal',
    fontSize: 12,
    lineHeight: 1.55,
    color: KILL_TOAST_PALETTE.ink,
    margin: 0,
    padding: 0,
  };

  const actionRowStyle = {
    marginTop: 10,
    paddingTop: 8,
    borderTop: `1px solid ${KILL_TOAST_PALETTE.brass}`,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  };

  const buttonStyle = {
    fontFamily: 'EB Garamond, "Noto Serif SC", Georgia, serif',
    fontStyle: 'normal',
    fontSize: 10,
    color: KILL_TOAST_PALETTE.tabac,
    background: 'transparent',
    border: 'none',
    padding: '4px 2px',
    cursor: 'pointer',
    letterSpacing: '0.04em',
  };

  return (
    <div
      role="status"
      aria-live="polite"
      style={containerStyle}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <div style={captionStyle}>
        系统刚自动巡查 ({entry.stamp}) · {sourceLabel}
      </div>
      {lines.map((line, idx) => (
        <p key={idx} style={lineStyle}>{line}</p>
      ))}
      <div style={actionRowStyle}>
        <button
          type="button"
          onClick={handleDetails}
          style={buttonStyle}
        >
          查看详情
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          style={buttonStyle}
        >
          我知道了
        </button>
      </div>
    </div>
  );
};

// Expose to global so app.jsx (which loads after this script tag) can render
// it via a typeof guard, matching the convention used by other surfaces.
window.KillToast = KillToast;
