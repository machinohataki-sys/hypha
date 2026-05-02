// Center column tab bar + LiveTerminal. Theme-token driven.

const TABS = [
  { id: 'verify', label: 'verify' },
  { id: 'quiz',   label: 'quiz'   },
  { id: 'case',   label: 'case'   },
  { id: 'follow', label: 'follow' },
  { id: 'graph',  label: 'graph'  },
];

function TabBar({ active, onSelect }) {
  return (
    <div style={{
      display: 'flex', gap: 0, padding: '0 18px',
      borderBottom: '1px solid var(--border-soft)',
    }}>
      {TABS.map(t => {
        const on = active === t.id;
        return (
          <TabBarItem key={t.id} on={on} label={t.label} onClick={() => onSelect(t.id)} />
        );
      })}
    </div>
  );
}

// Tab item — selected state by type contrast only (color + weight).
// No underline / pill / dot. Per Muse 2026-04-28 council:
// - chrome rectangles (1px lines, fills, pills) = web-app register, not editorial
// - type contrast (ink-title 500 vs ink-faint 400) = ≥3:1 SNR across 5 tabs,
//   eye scans and finds the bright one without chrome help
// - hover on unselected: bridge color (ink-primary), subtle, 180ms
function TabBarItem({ on, label, onClick }) {
  const [hover, setHover] = React.useState(false);
  const color = on
    ? 'var(--ink-title)'
    : (hover ? 'var(--ink-primary)' : 'var(--ink-faint)');
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '12px 18px 11px', cursor: 'pointer',
        // Cormorant Garamond + smcp OT feature → real small-caps glyphs
        // (EB Garamond v5.2.7 lacks smcp; Cormorant ships them). Lowercase
        // text triggers the OT substitution. Single-family discipline broken
        // by 1 font (only used on tab labels + folio counter), justified by
        // smcp requirement.
        fontFamily: '"Cormorant Garamond", "EB Garamond", Georgia, serif',
        fontFeatureSettings: '"smcp"',
        fontSize: 13.5,
        letterSpacing: '0.04em',
        fontWeight: on ? 500 : 400,
        color,
        transition: 'color 180ms',
      }}
    >
      {label}
    </div>
  );
}

// LiveTerminal — thin DOM host for the production canvas-based vc-renderer
// (lib/vc-renderer.js, ported verbatim from /e/victor/ptor/app/vc-renderer.js).
//
// The production renderer is 1300 lines of canvas/IME/selection/scrollback,
// reused as-is. This component does only two jobs:
//   1. mount the 4 DOM elements vc-renderer.js needs (#terminal-container,
//      #term canvas, #term-input textarea, #term-composition + selection-layer)
//   2. load lib/vc-renderer.js once, then call window.startVcRenderer()
//      after the DOM is in place
//
// All grid rendering / cursor / IME / wheel / Ctrl+C / vim alt-screen /
// scrollback comes from production.

function LiveTerminal() {
  // The whole component is a thin DOM host. We don't drive React state from
  // CoreMsg events — vc-renderer.js owns the canvas + pixel buffer + grid +
  // cursor + selection. React only renders the static scaffolding.
  React.useEffect(() => {
    // 1) Inject the production CSS once (keep it scoped to terminal IDs so
    //    nothing collides with the rest of PTOR).
    if (!document.getElementById('vc-renderer-style')) {
      const s = document.createElement('style');
      s.id = 'vc-renderer-style';
      s.textContent = `
        #terminal-container {
          flex: 1;
          padding: 12px 10px 8px;
          position: relative;
          overflow: hidden;
          background: var(--terminal-bg, #1a1a1a);
        }
        #terminal-container > canvas#term {
          display: block;
          width: 100%;
          height: 100%;
          outline: none;
        }
        #term-input {
          position: absolute;
          top: 12px; left: 10px; right: 10px; bottom: 8px;
          background: transparent;
          color: transparent;
          caret-color: transparent;
          border: none; outline: none; resize: none;
          font-family: "JetBrains Mono", "Cascadia Mono", Consolas, monospace;
          font-size: 14px;
          padding: 0; margin: 0;
          opacity: 0;
          z-index: 20;
          white-space: pre;
          overflow: hidden;
          user-select: none;
          /* Canvas owns mouse — textarea is keyboard-only. */
          pointer-events: none;
        }
        /* intentional-placeholder: real CSS ::placeholder pseudo-element for HTML input, not a code stub */
        #term-input::placeholder { color: transparent; }
        #term-input::selection { background: transparent; color: transparent; }
        .vc-selection-layer {
          position: absolute;
          inset: 0;
          pointer-events: none;
          z-index: 15;
          will-change: transform, opacity;
          isolation: isolate;
        }
        .vc-selection-rect {
          position: absolute;
          background: rgba(126, 211, 255, 0.22);
          border-top: 1px solid rgba(126, 211, 255, 0.45);
          border-bottom: 1px solid rgba(126, 211, 255, 0.45);
          mix-blend-mode: screen;
        }
        .vc-composition {
          position: absolute;
          display: none;
          background: rgba(126, 211, 255, 0.18);
          color: #cfefff;
          border: 1px solid rgba(126, 211, 255, 0.55);
          padding: 1px 4px;
          border-radius: 3px;
          font-family: "JetBrains Mono", "Cascadia Mono", Consolas, monospace;
          font-size: 14px;
          pointer-events: none;
          z-index: 55;
          white-space: pre;
          user-select: none;
        }
        .vc-composition.show { display: inline-block; }
      `;
      document.head.appendChild(s);
    }

    // 2) Load lib/vc-renderer.js once. Idempotent — calling startVcRenderer()
    //    twice is a no-op (guarded inside).
    const start = () => {
      if (typeof window.startVcRenderer === 'function') {
        try { window.startVcRenderer(); } catch (e) { console.error('[vc-renderer] init failed', e); }
      }
    };

    if (window.startVcRenderer) {
      start();
    } else if (!document.getElementById('vc-renderer-script')) {
      const s = document.createElement('script');
      s.id = 'vc-renderer-script';
      s.src = '../../lib/vc-renderer.js';
      s.onload = start;
      s.onerror = () => console.error('[vc-renderer] script load failed');
      document.body.appendChild(s);
    } else {
      // Script tag exists but not loaded yet — poll briefly.
      const t = setInterval(() => {
        if (window.startVcRenderer) { clearInterval(t); start(); }
      }, 60);
      setTimeout(() => clearInterval(t), 4000);
    }
  }, []);

  return (
    <div style={{
      width: '100%', height: '100%', minWidth: 0,
      display: 'flex', flexDirection: 'column',
      background: 'var(--terminal-bg)',
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '8px 18px',
        fontFamily: '"JetBrains Mono", monospace', fontSize: 11,
        letterSpacing: '0.06em',
        color: 'var(--ink-faint)',
        borderBottom: '1px solid var(--border-soft)',
        flexShrink: 0,
      }}>
        terminal
      </div>
      {/* Production vc-renderer.js binds via these IDs. Order matters:
          canvas underlay → selection layer → composition (highest z). */}
      <div id="terminal-container">
        <canvas id="term" tabIndex={-1}></canvas>
        <textarea
          id="term-input"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          aria-hidden="true"
        />
        <div id="term-composition" className="vc-composition"></div>
        <div id="term-selection-layer" className="vc-selection-layer"></div>
      </div>
    </div>
  );
}

Object.assign(window, { TabBar, TABS, LiveTerminal });
