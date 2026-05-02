/* global React */
// Hypha Lacquer Loop — TutorInkBlot v1.2-REDUX (Ink Reservoir + Stillness Hybrid).
// Plan: C:\Users\32043\.claude\plans\flickering-tickling-koala.md (council 2026-05-01).
//
// REPLACES the v1.2 first-cut (3 baseline rules) which user rejected as visually
// flat. MUSE × LUNG sub-council redesign:
//   - MUSE contribution: typographic single-glyph (Ink Reservoir) — italic
//     Garamond left double quotation mark held at the cursor-insert point
//   - LUNG contribution: Stillness-as-Content for short waits (≤3s) — pure
//     typographic anticipation, no motion
//   - Hybrid: still 0-3000ms; sine breath kicks in beyond, period encoded
//     by substrate.a2Delta (motion-as-signal — period IS the signal)
//
// Visual seam-free handoff: when first chunk arrives the rendered glyph fades
// to 0 over 180ms and the real italic prose paints over the same baseline,
// same font, same style, same color register.
// intentional-placeholder: this component IS the manuscript placeholder mark by
// design — the term "placeholder" is the domain word for the wait UI's role,
// not a stub for unfinished work.
//
// Render rule: mount only while role==='tutor' && streaming. Inside, opacity
// is driven by !hasText. Reduced-motion → static at 0.32 (mid-breath rest pose).

function TutorInkBlot({ streaming, hasText }) {
  const sub = (window.RuntimeSubstrate && window.RuntimeSubstrate.useSubstrate)
    ? window.RuntimeSubstrate.useSubstrate()
    : { a2Delta: 0, motionLevel: 'full' };

  // longWait: turns true after 3s of waiting with no text. Triggers the
  // breath window. Reset whenever streaming/hasText changes.
  const [longWait, setLongWait] = React.useState(false);
  React.useEffect(() => {
    if (streaming && !hasText) {
      const t = setTimeout(() => setLongWait(true), 3000);
      return () => clearTimeout(t);
    }
    setLongWait(false);
  }, [streaming, hasText]);

  if (!streaming) return null;

  // Period from a2Delta: lerp 3000 → 1600 as delta rises (high prediction-error
  // = taut breath; low = slow). Default 2.4s when a2Delta unset.
  const a2 = Math.max(0, Math.min(1, sub.a2Delta || 0));
  const periodMs = Math.round(3000 - 1400 * a2);

  const visible = !hasText;
  const animate = visible && longWait && sub.motionLevel === 'full';

  const style = {
    display: 'inline-block',
    fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
    fontStyle: 'italic',
    fontSize: '1.05em',
    lineHeight: 1,
    color: 'var(--brass-mid)',
    pointerEvents: 'none',
    userSelect: 'none',
    transition: 'opacity 200ms var(--ease-quiet, cubic-bezier(0.4, 0, 0.2, 1))',
  };
  if (animate) {
    style.animation = `hypha-nib-breath ${periodMs}ms ease-in-out infinite`;
  } else {
    // Stillness window OR motionLevel != 'full': hold steady at 0.32.
    // When dissolving (hasText), opacity → 0.
    style.opacity = visible ? 0.32 : 0;
    style.animation = 'none';
  }

  return (
    <span aria-hidden="true" style={style}>{'“'}</span>
  );
}

window.TutorInkBlot = TutorInkBlot;
