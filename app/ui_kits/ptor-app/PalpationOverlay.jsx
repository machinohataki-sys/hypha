// PalpationOverlay — Victor's PROVENANCE-PALPATION gesture (per /tr 2026-04-29).
// Long-press 500ms+ on a note summons this strata-overlay revealing the
// THANGKA-LEDGER atoms (read tier / time-since-write / read count). Hidden by
// default — discoverable, !announced. Release dismisses (or Esc).
//
// Spirit: "the system shows you yourself, restraint = it does so without
// asking permission". User must HOLD to look; the overlay is not a panel,
// it's a touchable ledger glance.

function PalpationOverlay({ tier, readCount, mtime, onDismiss }) {
  // Esc key dismisses (insurance against pointer-up not firing on edge cases)
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onDismiss && onDismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  // Format time-since-write — italic Garamond meta, lowercase, no padding.
  const timeSince = React.useMemo(() => {
    if (!mtime) return null;
    const ms = Date.now() - new Date(mtime).getTime();
    const d = ms / 86400000;
    if (d < 1) return 'today';
    if (d < 30) return `${Math.floor(d)} days ago`;
    if (d < 365) return `${Math.floor(d / 30)} months ago`;
    return `${Math.floor(d / 365)} years ago`;
  }, [mtime]);

  const tierLabel = tier
    ? `tier ${tier} of 4`
    : 'dormant — unread';

  const readsLabel = readCount === 0 ? 'no reads yet'
    : readCount === 1 ? 'read once'
    : `read ${readCount} times`;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 900,
        background: 'var(--bg-modal-backdrop)',
        backdropFilter: 'blur(10px) saturate(0.85)',
        WebkitBackdropFilter: 'blur(10px) saturate(0.85)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        animation: 'palpation-fade-in 200ms cubic-bezier(0.22, 1, 0.36, 1)',
        pointerEvents: 'none',  // hold-and-look: overlay never captures pointer
      }}
    >
      <style>{`
        @keyframes palpation-fade-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes palpation-rise {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: none; }
        }
        .palpation-strata { display: flex; flex-direction: column; gap: 4px; }
        .palpation-stratum {
          width: 220px; height: 2px;
          transition: background 600ms ease-out;
          opacity: 0.32;
        }
        .palpation-stratum.active {
          height: 3px;
          opacity: 1;
          box-shadow: 0 0 12px 1px currentColor;
        }
        .palpation-meta {
          font-family: "EB Garamond", "Noto Serif SC", serif;
          font-style: italic;
          font-size: 14px;
          letter-spacing: 0.04em;
          line-height: 1.7;
          color: var(--ink-muted);
          text-align: center;
          margin-top: 24px;
        }
        .palpation-meta strong {
          color: var(--brass-bright);
          font-weight: 400;
          font-style: normal;
        }
      `}</style>
      <div
        style={{
          padding: '40px 48px',
          animation: 'palpation-rise 280ms cubic-bezier(0.22, 1, 0.36, 1)',
          textAlign: 'center',
        }}
      >
        {/* 4-stratum ladder — top = highest tier (most accumulated).
            Current tier glows; others sit at 0.32 opacity. tier=null = all dormant. */}
        <div className="palpation-strata">
          {[1, 2, 3, 4].map(t => (
            <div
              key={t}
              className={'palpation-stratum' + (tier === t ? ' active' : '')}
              style={{
                background: `var(--rim-brass-tier-${t})`,
                color: `var(--rim-brass-tier-${t})`,
              }}
            />
          ))}
        </div>

        <div className="palpation-meta">
          <strong>{tierLabel}</strong><br />
          {readsLabel}
          {timeSince ? <span> · written {timeSince}</span> : null}
          <br />
          <span style={{ opacity: 0.5, fontSize: 12 }}>release to dismiss</span>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { PalpationOverlay });
