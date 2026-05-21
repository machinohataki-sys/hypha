/* global React */
// HYPHA · Tooltip (v0.4.10, 2026-05-19)
//
// Replacement for `title=` HTML attribute. Works on touch (tap shows), keyboard
// (focus shows), and mouse (hover shows). Styled in manuscript register: cream
// paper + brass hairline + ink primary text. Renders via fixed-position div
// anchored to trigger getBoundingClientRect — no portal infra dependency.
//
// Usage:
//   <Tooltip content="HUMANITIES (人文/历史/哲学) 课程的语调...">
//     <span>ⓘ</span>
//   </Tooltip>
//
// content may be a string or a React node. position: 'bottom' (default) | 'top'.
// maxWidth defaults to 280px. Per feedback_italic_decoration_only, the trigger
// stays whatever register the caller renders; the content body uses italic
// Garamond because it is decorative prose, not an action label.
//
// Keep `title={...}` alongside for accessibility fallback (screen readers and
// the rare cursor-only environment without JS); the Tooltip handler suppresses
// the native browser tooltip when JS is live by sitting above z-index 9999.

const { useState, useRef, useEffect, useCallback } = React;

function Tooltip({ content, children, position = 'bottom', maxWidth = 280 }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const [coords, setCoords] = useState({ top: 0, left: 0 });

  // Recompute on open. Use getBoundingClientRect so the popover follows the
  // trigger even after layout shifts. Position 'top' places above; 'bottom'
  // below. Center on x by transform translate(-50%).
  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    let y;
    if (position === 'top') y = rect.top - 6;
    else y = rect.bottom + 6;
    setCoords({ top: y, left: x });
  }, [open, position]);

  // Touch: tap toggles. Mouse: hover toggles. Keyboard: focus/blur toggles.
  const onEnter = useCallback(() => setOpen(true), []);
  const onLeave = useCallback(() => setOpen(false), []);
  const onClick = useCallback((e) => {
    // Don't swallow click for the trigger — just ensure open on touch.
    setOpen((v) => !v);
  }, []);

  return (
    <span
      ref={triggerRef}
      style={{ display: 'inline-block', position: 'relative' }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      onClick={onClick}
      tabIndex={0}
    >
      {children}
      {open && (
        <div
          role="tooltip"
          style={{
            position: 'fixed',
            top: coords.top,
            left: coords.left,
            transform: position === 'top' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
            background: 'var(--paper, var(--bg-card, #F8F4ED))',
            border: '1px solid var(--hair-3, var(--hairline-warm, rgba(180,160,130,0.4)))',
            color: 'var(--ink-2, var(--ink-primary, #3A3530))',
            padding: '8px 12px',
            borderRadius: 4,
            fontSize: 12,
            lineHeight: 1.55,
            fontFamily: 'EB Garamond, "Noto Serif SC", serif',
            fontStyle: 'italic',
            maxWidth: maxWidth,
            boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
            zIndex: 9999,
            pointerEvents: 'none',
            whiteSpace: 'normal',
            letterSpacing: '.005em',
          }}
        >
          {content}
        </div>
      )}
    </span>
  );
}

if (typeof window !== 'undefined') {
  window.Tooltip = Tooltip;
}
