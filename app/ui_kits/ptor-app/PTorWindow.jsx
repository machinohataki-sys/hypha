// PTOR window — Electron unified titlebar (no traffic lights).
// Reads CSS theme tokens; works for both night and day.

function WindowControls() {
  const [maxed, setMaxed] = React.useState(false);
  React.useEffect(() => {
    if (!window.windowControls) return;
    window.windowControls.isMaximized().then(setMaxed);
    const unsub = window.windowControls.onMaximizeChange(setMaxed);
    return unsub;
  }, []);

  if (typeof window === 'undefined' || !window.windowControls) return null;

  const baseBtn = {
    width: 46, height: 42, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
    color: 'var(--ink-muted)',
    transition: 'background-color 160ms cubic-bezier(0.22,1,0.36,1), color 160ms',
    WebkitAppRegion: 'no-drag',
  };

  const hover = (e, closeBtn) => {
    e.currentTarget.style.backgroundColor = closeBtn
      ? 'rgba(196, 106, 93, 0.85)'
      : 'rgba(213, 178, 138, 0.10)';
    e.currentTarget.style.color = closeBtn ? '#f2e6da' : 'var(--brass-bright)';
  };
  const unhover = (e) => {
    e.currentTarget.style.backgroundColor = 'transparent';
    e.currentTarget.style.color = 'var(--ink-muted)';
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', height: 42, WebkitAppRegion: 'no-drag', marginRight: -18 }}>
      <button title="Minimize" aria-label="Minimize"
        style={baseBtn}
        onClick={() => window.windowControls.minimize()}
        onMouseEnter={(e) => hover(e, false)} onMouseLeave={unhover}>
        <svg width="14" height="14" viewBox="0 0 12 12" fill="none">
          <line x1="2.5" y1="6" x2="9.5" y2="6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
        </svg>
      </button>
      <button title={maxed ? 'Restore' : 'Maximize'} aria-label={maxed ? 'Restore' : 'Maximize'}
        style={baseBtn}
        onClick={() => window.windowControls.toggleMaximize()}
        onMouseEnter={(e) => hover(e, false)} onMouseLeave={unhover}>
        {maxed ? (
          <svg width="14" height="14" viewBox="0 0 12 12" fill="none">
            <rect x="3.5" y="2" width="6.5" height="6.5" stroke="currentColor" strokeWidth="1" fill="none"/>
            <rect x="2" y="3.5" width="6.5" height="6.5" stroke="currentColor" strokeWidth="1" fill="var(--bg-base)"/>
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 12 12" fill="none">
            <rect x="2.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" fill="none"/>
          </svg>
        )}
      </button>
      <button title="Close" aria-label="Close"
        style={baseBtn}
        onClick={() => window.windowControls.close()}
        onMouseEnter={(e) => hover(e, true)} onMouseLeave={unhover}>
        <svg width="14" height="14" viewBox="0 0 12 12" fill="none">
          <line x1="3" y1="3" x2="9" y2="9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
          <line x1="9" y1="3" x2="3" y2="9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
        </svg>
      </button>
    </div>
  );
}

// ViewModeWordmark — the italic Garamond word = current view mode. Click to
// toggle. min-width locks the slot so toggling note(4ch)→atlas(5ch) doesn't
// reflow the rest of the titlebar (same NIGHT/DAY width-shift problem we
// fixed on the theme toggle). Hover = brass-bright + a tiny brass underline
// hint that materializes only on hover (千金: discoverable, not announced).
function ViewModeWordmark({ viewMode, onToggle }) {
  const [hovered, setHovered] = React.useState(false);
  // viewMode now has 3 states: evolution / recall / colophon. Earlier the word
  // collapsed all non-evolution to 'recall', so opening the colophon (settings)
  // displayed "recall" in the titlebar even though the page below was the
  // colophon prose — pure label/state desync. Render the actual mode.
  // 'colophon' is the internal codename for the settings page; surface the
  // user-facing word "settings" instead — that's what the user clicks to get
  // here ("the settings entry") and what they expect to read in the titlebar.
  const word = viewMode === 'colophon' ? 'settings'
             : viewMode === 'recall'   ? 'recall'
             : 'evolution';
  // Colophon is a leaf surface (no toggle target) — clicking it should just
  // close back to wherever you came from. We surface this by disabling the
  // toggle in colophon mode; Esc remains the canonical way out.
  const clickable = viewMode !== 'colophon';
  return (
    <button
      onClick={clickable ? onToggle : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={
        viewMode === 'colophon' ? 'colophon — press Esc to leave'
        : `switch to ${viewMode === 'evolution' ? 'recall' : 'evolution'} view`
      }
      style={{
        background: 'transparent', border: 'none', padding: 0,
        cursor: clickable ? 'pointer' : 'default',
        display: 'inline-flex', alignItems: 'baseline', justifyContent: 'flex-start',
        minWidth: 90,
        WebkitAppRegion: 'no-drag',
        position: 'relative',
      }}
    >
      <span style={{
        fontFamily: '"EB Garamond", "Cormorant Garamond", Georgia, serif', fontStyle: 'italic',
        fontSize: 20, letterSpacing: '0',
        // Comment-vs-code drift fixed 2026-04-28: comment said "brass-bright"
        // but code had teal. Per feedback_brass_default_teal_justify: brass.
        color: (clickable && hovered) ? 'var(--brass-bright)' : 'var(--ink-title)',
        transition: 'color 220ms cubic-bezier(0.22,1,0.36,1)',
      }}>
        {word}
      </span>
      {/* underline removed — chrome hairlines under italic Garamond word read
          web-app, not editorial. Hover color shift (ink-title → brass-bright)
          alone signals affordance. Animated draw-in was nice but it was
          chrome-rectangle in disguise (Muse council 2026-04-28). */}
    </button>
  );
}

function ImmersionGlyph({ immersed, onToggle }) {
  const [hovered, setHovered] = React.useState(false);
  return (
    <button
      onClick={onToggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={immersed ? 'restore panels' : 'enter Lesezimmer'}
      style={{
        background: 'transparent', border: 'none', cursor: 'pointer',
        padding: '0 10px', display: 'inline-flex', alignItems: 'center',
        height: 30,
        WebkitAppRegion: 'no-drag',
      }}
    >
      <svg width="24" height="14" viewBox="0 0 24 14" fill="none" overflow="visible">
        {/* Left rail — slight delay before right (mass propagation, 30ms stagger) */}
        <rect x="2" y="2" width="3" height="10" rx="0.5"
              fill="var(--brass-mid)"
              style={{
                opacity: immersed ? 0 : (hovered ? 0.78 : 0.45),
                transform: immersed ? 'translateX(-6px) scaleX(0.7)' : 'translateX(0) scaleX(1)',
                transformOrigin: '0% 50%',
                transition: 'opacity 380ms cubic-bezier(0.34, 1.4, 0.64, 1), transform 420ms cubic-bezier(0.34, 1.4, 0.64, 1)',
              }}/>
        {/* Center — gentle scale "breath" on toggle (the room expanding to fill) */}
        <rect x="8" y="2" width="8" height="10" rx="0.5"
              fill="var(--brass-mid)"
              style={{
                opacity: hovered ? 1 : 0.82,
                transform: immersed ? 'scaleX(1.18)' : 'scaleX(1)',
                transformOrigin: '50% 50%',
                transition: 'opacity 200ms, transform 460ms cubic-bezier(0.34, 1.56, 0.64, 1)',
              }}/>
        {/* Right rail — same stagger mirrored, 60ms after left (door swings out heavier) */}
        <rect x="19" y="2" width="3" height="10" rx="0.5"
              fill="var(--brass-mid)"
              style={{
                opacity: immersed ? 0 : (hovered ? 0.78 : 0.45),
                transform: immersed ? 'translateX(6px) scaleX(0.7)' : 'translateX(0) scaleX(1)',
                transformOrigin: '100% 50%',
                transition: 'opacity 380ms cubic-bezier(0.34, 1.4, 0.64, 1) 60ms, transform 420ms cubic-bezier(0.34, 1.4, 0.64, 1) 60ms',
              }}/>
      </svg>
    </button>
  );
}

function PTorWindow({ width = '100%', height = '100%', children, onHome, immersed, onToggleImmersion, viewMode = 'note', onToggleView }) {
  const fullBleed = width === '100%' && height === '100%';
  return (
    <div style={{
      width, height,
      borderRadius: fullBleed ? 0 : 18,
      overflow: 'hidden', position: 'relative',
      background: 'var(--bg-page)',
      backgroundColor: 'var(--bg-base)',
      boxShadow: fullBleed ? 'none' : '0 0 0 1px var(--border-hairline), var(--shadow-modal)',
      fontFamily: '"EB Garamond", "Noto Serif SC", "Cormorant Garamond", Georgia, serif',
      color: 'var(--ink-primary)',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        height: 42, padding: '0 18px', display: 'flex', alignItems: 'center', gap: 12,
        borderBottom: '1px solid var(--border-soft)',
        background: 'var(--glass-light)',
        backdropFilter: 'var(--glass-blur)',
        WebkitBackdropFilter: 'var(--glass-blur)',
        flexShrink: 0,
        WebkitAppRegion: 'drag',
      }}>
        {/* Brand-fades-into-state: P-monogram (always-on home) + state wordmark
            (clickable mode toggle). Per 2026-04-27 atlas council: brand exists
            on the launcher icon and Lesezimmer whisper; INSIDE the app the
            titlebar surface should carry STATE, not BRAND repetition.
            The italic Garamond word IS the mode (note ↔ atlas). */}
        <div
          onClick={onHome}
          aria-label="home"
          style={{
            display: 'inline-flex', alignItems: 'center',
            cursor: onHome ? 'pointer' : 'default',
            WebkitAppRegion: 'no-drag',
            marginRight: 10,
          }}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <line x1="6.5" y1="4" x2="6.5" y2="16"
                  stroke="var(--brass-bright)" strokeWidth="1.6" strokeLinecap="round"/>
            <path d="M6.5 4 Q14.6 4 14.6 8 Q14.6 11.6 8.4 11.6"
                  stroke="var(--brass-bright)" strokeWidth="1.6" strokeLinecap="round" fill="none"/>
            {/* the period-dot is the brand's one teal — borrowed from her manicure */}
            <circle cx="10.4" cy="7.6" r="1" fill="var(--accent-teal)"/>
          </svg>
        </div>
        <ViewModeWordmark viewMode={viewMode} onToggle={onToggleView} />
        <div style={{ flex: 1 }} />
        {viewMode === 'evolution' && onToggleImmersion && (
          <div style={{ WebkitAppRegion: 'no-drag', display: 'inline-flex', marginRight: 22 }}>
            <ImmersionGlyph immersed={immersed} onToggle={onToggleImmersion} />
          </div>
        )}
        <div style={{ WebkitAppRegion: 'no-drag', display: 'inline-flex', marginRight: 8 }}>
          <ThemeToggle />
        </div>
        <WindowControls />
      </div>
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  );
}
Object.assign(window, { PTorWindow });
