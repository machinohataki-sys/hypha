/* global React */
// HYPHA · Toast (v0.4.10, 2026-05-19)
//
// Unified toast surface. Single mount point (<ToastRoot/> at App root) +
// global emitter (window.HyphaToast.showToast). Replaces 2 per-screen
// implementations (screen-home.jsx + screen-commons.jsx) with one canonical
// register.
//
// Canonical signature (chosen — see "Variants" below):
//   showToast(kind, text, ms = 2400)
//     - kind: 'ok' | 'err' | 'info' (default 'info')
//     - text: string or React node (italic Garamond is applied by the root)
//     - ms:   auto-dismiss in ms; pass 0 to keep until user closes
//
// Variant A · screen-home.jsx (chosen as canonical)
//   showToast('ok', '已更新', 2400)         — bottom-center, fadeIn, css var theming
//   3-arg with variable duration. Field name `text`.
//
// Variant B · screen-commons.jsx (dropped)
//   showToast('ok', '已导出到 ...')          — top-right, fixed 4200ms, close button
//   Differences from A:
//     * field name `message` not `text`
//     * fixed 4200ms duration (less flexible)
//     * top-right anchor with close-button affordance
//   Mitigations in this canonical:
//     * accepts ms=0 for sticky (replaces close-button use case)
//     * field name normalized to `text`
//     * bottom-center anchor (home wins — more central in user attention)
//
// Migration:
//   screen-home.jsx     — drop local useState + useCallback + JSX block; call
//                         showToast directly (signature already matches).
//   screen-commons.jsx  — drop local useState + InlineToast component; rewrite
//                         calls `showToast('ok', msg)` → no field rename needed
//                         at call sites (was already positional). Close button
//                         affordance dropped.
//
// Lifecycle:
//   ToastRoot listens for `hypha:toast` custom events on window. Each event
//   carries detail = { kind, text, ms, id }. Root keeps an array of active
//   toasts and removes each on its timer.
//
// Usage:
//   // 1. Mount once at App root (see app.jsx alongside <KillToast/>):
//   //      {typeof ToastRoot === 'function' && <ToastRoot />}
//   // 2. Call from anywhere:
//   //      window.HyphaToast.showToast('ok', '已更新');
//   //      window.HyphaToast.showToast('err', '保存失败 · 桥接未连', 3600);

const { useState, useEffect, useCallback } = React;

const TOAST_EVENT = 'hypha:toast';
let _seq = 0;
const _nextId = () => (++_seq);

// Global emitter — anyone can dispatch a toast without holding a ref to the
// root. Same pattern as kill-toast's broadcast IPC.
function showToast(kind, text, ms) {
  if (typeof window === 'undefined') return;
  const k = (kind === 'ok' || kind === 'err' || kind === 'info') ? kind : 'info';
  const t = (text == null) ? '' : text;
  const duration = (typeof ms === 'number' && ms >= 0) ? ms : 2400;
  const detail = { kind: k, text: t, ms: duration, id: _nextId() };
  try {
    window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail }));
  } catch (_) {
    // CustomEvent constructor unavailable (very old WebView) — silent fail is
    // OK; toast is a non-critical surface. Caller's underlying success/error
    // is independent of toast visibility.
  }
}

function ToastRoot() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    const handler = (ev) => {
      const d = ev && ev.detail;
      if (!d || typeof d !== 'object') return;
      const id = d.id || _nextId();
      const entry = { id, kind: d.kind || 'info', text: d.text || '', ms: typeof d.ms === 'number' ? d.ms : 2400 };
      setToasts((prev) => [...prev, entry]);
      if (entry.ms > 0) {
        setTimeout(() => {
          setToasts((prev) => prev.filter((x) => x.id !== id));
        }, entry.ms);
      }
    };
    window.addEventListener(TOAST_EVENT, handler);
    return () => window.removeEventListener(TOAST_EVENT, handler);
  }, []);

  const onDismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 28,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        zIndex: 9500,
        pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => onDismiss(t.id)}
          style={{
            padding: '10px 18px',
            background: t.kind === 'err'
              ? 'color-mix(in srgb, var(--brass-amber, #c89c3e) 14%, var(--bg-card, #fbf6ec))'
              : t.kind === 'ok'
                ? 'color-mix(in srgb, var(--brass-mid, #9a7d68) 10%, var(--bg-card, #fbf6ec))'
                : 'var(--bg-card, #fbf6ec)',
            color: t.kind === 'err'
              ? 'var(--brass-amber, #c89c3e)'
              : 'var(--ink-primary, #2A1F18)',
            border: '1px solid var(--hairline-warm, rgba(180,130,105,0.32))',
            borderRadius: 4,
            fontFamily: 'EB Garamond, "Noto Serif SC", serif',
            fontStyle: 'italic',
            fontSize: 14,
            letterSpacing: '.02em',
            boxShadow: '0 6px 20px color-mix(in srgb, var(--brass-deep, #6b4f35) 20%, transparent)',
            animation: 'fadeIn .25s ease both',
            pointerEvents: 'auto',
            cursor: 'pointer',
            maxWidth: 480,
            lineHeight: 1.4,
          }}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

if (typeof window !== 'undefined') {
  window.HyphaToast = { showToast };
  window.ToastRoot = ToastRoot;
}
