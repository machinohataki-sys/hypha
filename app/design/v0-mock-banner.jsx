/* global React */
//
// HYPHA · v0 Mock Banner — small "v0 模板输出" stamp for shipped-but-mocked
// payloads. Renders an italic Garamond tag in the corner of any card whose
// data envelope was tagged by `app/lib/v0-mock-marker.js#tagMockOutput`.
//
// Usage:
//   <V0MockBanner payload={body.product_transfer} />
//   <V0MockBanner payload={companionExpressionEnvelope} />
//   <V0MockBanner payload={recommendation} compact />
//
// Visual register (manuscript band):
//   - italic EB Garamond, 9.5pt, faded #8A7F6E
//   - no background, no border (kept low-attention so it doesn't compete
//     with the surrounding manuscript-grade card content)
//   - hover (title=) reveals the `_mock_reason` string from the marker
//
// Pure render — no IPC, no state. Reads window._isMockOutput +
// window._getMockReason exposed via preload contextBridge. When the marker
// is absent (real LLM-derived payload), the component renders nothing.

const _MOCK_FALLBACK_KEY = '_hypha_mock';
const _MOCK_FALLBACK_VALUE = 'v0-template-output';

function _bridgeIsMockOutput(payload) {
  // Prefer the contextBridge-exposed predicate (handles future tag-value
  // migrations centrally). Fall back to flat key/value compare so a renderer
  // without the bridge still degrades gracefully (no crash, just shows
  // banner whenever the inline tag is present).
  try {
    if (typeof window !== 'undefined' && typeof window._isMockOutput === 'function') {
      return !!window._isMockOutput(payload);
    }
  } catch (_) { /* renderer not yet initialized */ }
  return !!(payload
    && typeof payload === 'object'
    && payload[_MOCK_FALLBACK_KEY] === _MOCK_FALLBACK_VALUE);
}

function _bridgeGetMockReason(payload) {
  try {
    if (typeof window !== 'undefined' && typeof window._getMockReason === 'function') {
      const r = window._getMockReason(payload);
      if (r) return r;
    }
  } catch (_) { /* renderer not yet initialized */ }
  if (payload && typeof payload === 'object' && typeof payload._mock_reason === 'string') {
    return payload._mock_reason;
  }
  return '';
}

const V0MockBanner = ({ payload, compact, style: styleOverride }) => {
  if (!_bridgeIsMockOutput(payload)) return null;
  const reason = _bridgeGetMockReason(payload) || '';

  // Default: top-right absolutely-positioned chip. `compact` mode collapses
  // to inline-block so callers can drop it into a flex row without absolute
  // positioning side-effects.
  const baseStyle = {
    fontFamily: '"EB Garamond", "Noto Serif SC", serif',
    fontStyle: 'italic',
    fontSize: 9.5,
    color: '#8A7F6E',
    letterSpacing: '0.04em',
    userSelect: 'none',
    cursor: 'help',
  };

  const positioned = compact
    ? { ...baseStyle, display: 'inline-block' }
    : {
        ...baseStyle,
        position: 'absolute',
        top: 6,
        right: 8,
        pointerEvents: 'auto',
      };

  const finalStyle = styleOverride ? { ...positioned, ...styleOverride } : positioned;

  return React.createElement('span', {
    className: 'hypha-v0-mock-banner',
    style: finalStyle,
    title: reason || 'v0 模板输出 (未接 LLM)',
    'aria-label': 'v0 模板输出',
    'data-mock-reason': reason || '',
  }, 'v0 模板输出');
};

if (typeof window !== 'undefined') {
  window.V0MockBanner = V0MockBanner;
}
