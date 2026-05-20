/* global React */
// HYPHA · W8.2 Learning Commons Flywheel — dashboard surface.
//
// Renders the four-step funnel (Note → Spark → Pack → Commons → Lesson)
// with the live count per step + a "propose N" action per step that
// dispatches into the W8.2 IPC bridge. A radial Health Gauge anchors the
// page header so the user sees at a glance whether the flywheel is
// turning.
//
// Props: { slug, onBack }
//
// Register (千金 manuscript):
//   - EB Garamond italic for titles + step verbs, roman for counts
//   - brass-bright underlines for actionable rows; warm cream paper field
//   - no emoji, no SaaS gamification (no percentages with confetti),
//     no exclamation marks. The gauge is a signal, not a trophy.
//   - cool teal (E-78 lesson learned) reserved for "Commons" emphasis —
//     the only place a cool tone appears, justified because Commons is
//     the only "public" hop.

const { useState, useEffect, useCallback, useMemo } = React;

// ---------------------------------------------------------------------------
// Step palette — warm by default; teal only on Commons step.
// ---------------------------------------------------------------------------

const STEPS = [
  {
    key: 'note',
    title: 'Note',
    subtitle: 'utility ≥ 70 · age ≥ 7d · cited ≥ 2',
    accent: '#6b5028',   // brass
  },
  {
    key: 'spark',
    title: 'Spark',
    subtitle: 'cluster ≥ 5 same module · or ≥ 3 accepted',
    accent: '#7a5a1d',
  },
  {
    key: 'pack',
    title: 'Pack',
    subtitle: 'scan · license · stage locally',
    accent: '#7a4a1a',
  },
  {
    key: 'commons',
    title: 'Commons',
    subtitle: 'public hop · cite, never duplicate',
    accent: '#3f6a72',   // teal — the only cool tone (W8.2 spec §6)
  },
  {
    key: 'lesson',
    title: 'Lesson',
    subtitle: 'COMMONS HINTS injected ahead of LIBRARY_EVIDENCE',
    accent: '#6b5028',
  },
];

// ---------------------------------------------------------------------------
// Health Gauge — semicircular arc, 0..100. Bars beneath show 5 components.
// Pure inline SVG, no external dep. The gauge READS as a manuscript figure,
// not a UI widget — thin brass hairline + serif numerals only.
// ---------------------------------------------------------------------------

const HealthGauge = ({ score, components }) => {
  const safeScore = Math.max(0, Math.min(100, Number(score) || 0));
  // Semicircle: angle 0 = left (180°), angle 100 = right (0°).
  const angle = Math.PI * (1 - safeScore / 100);
  const cx = 80, cy = 80, r = 60;
  const endX = cx + r * Math.cos(angle);
  const endY = cy - r * Math.sin(angle);
  const arc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${endX.toFixed(2)} ${endY.toFixed(2)}`;
  const trackArc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;

  return (
    <div className="row gap-24" style={{ alignItems: 'center' }}>
      <svg width={160} height={92} viewBox="0 0 160 92" style={{ flexShrink: 0 }}>
        <path d={trackArc} stroke="var(--rule-soft)" strokeWidth={2} fill="none" />
        <path d={arc} stroke="#7a5a1d" strokeWidth={3} fill="none" strokeLinecap="round" />
        <text
          x={80}
          y={70}
          textAnchor="middle"
          fontFamily='"EB Garamond", "Noto Serif SC", serif'
          fontStyle="italic"
          fontSize={28}
          fill="var(--ink-1)">
          {safeScore}
        </text>
      </svg>
      <div style={{ flex: 1 }}>
        <div style={{
          fontFamily: '"EB Garamond", "Noto Serif SC", serif',
          fontStyle: 'italic',
          fontSize: 14,
          color: 'var(--ink-2)',
          marginBottom: 8,
          letterSpacing: '0.04em',
        }}>
          Flywheel health — diagnostic, not gatekeeping
        </div>
        <div className="col gap-4">
          {(components ? Object.keys(components) : []).map((k) => (
            <ComponentBar key={k} label={k} value={Math.round(components[k] || 0)} />
          ))}
        </div>
      </div>
    </div>
  );
};

const ComponentBar = ({ label, value }) => (
  <div className="row gap-8" style={{ alignItems: 'center' }}>
    <div style={{
      flex: '0 0 140px',
      fontSize: 11,
      fontFamily: '"JetBrains Mono", monospace',
      color: 'var(--ink-2)',
      letterSpacing: '0.04em',
    }}>{label}</div>
    <div style={{
      flex: 1,
      height: 4,
      background: 'var(--rule-soft)',
      borderRadius: 1,
      overflow: 'hidden',
    }}>
      <div style={{
        width: `${Math.max(0, Math.min(100, value))}%`,
        height: '100%',
        background: '#7a5a1d',
      }} />
    </div>
    <div style={{
      flex: '0 0 32px',
      textAlign: 'right',
      fontSize: 11,
      fontFamily: '"JetBrains Mono", monospace',
      color: 'var(--ink-2)',
    }}>{value}</div>
  </div>
);

// ---------------------------------------------------------------------------
// Step card — title + count + subtitle + action button
// ---------------------------------------------------------------------------

const StepCard = ({ step, count, busy, onAction, actionLabel }) => (
  <div style={{
    flex: '1 1 0',
    minWidth: 0,
    padding: '20px 16px',
    background: 'var(--paper)',
    border: '1px solid var(--rule-soft)',
    borderTop: `2px solid ${step.accent}`,
    borderRadius: 2,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  }}>
    <div style={{
      fontFamily: '"EB Garamond", "Noto Serif SC", serif',
      fontStyle: 'italic',
      fontSize: 22,
      letterSpacing: '0.02em',
      color: 'var(--ink-1)',
    }}>{step.title}</div>
    <div style={{
      fontFamily: '"EB Garamond", "Noto Serif SC", serif',
      fontSize: 36,
      lineHeight: 1,
      color: step.accent,
    }}>
      {count != null ? count : '—'}
    </div>
    <div style={{
      fontSize: 11,
      fontFamily: '"JetBrains Mono", monospace',
      color: 'var(--ink-3)',
      letterSpacing: '0.04em',
      lineHeight: 1.5,
    }}>{step.subtitle}</div>
    {onAction && actionLabel ? (
      <button
        onClick={onAction}
        disabled={busy}
        style={{
          marginTop: 6,
          padding: '6px 12px',
          fontSize: 12,
          fontFamily: '"EB Garamond", "Noto Serif SC", serif',
          color: busy ? 'var(--ink-3)' : 'var(--paper)',
          background: busy ? 'var(--rule-soft)' : step.accent,
          border: 'none',
          borderRadius: 2,
          cursor: busy ? 'wait' : 'pointer',
          letterSpacing: '0.04em',
          alignSelf: 'flex-start',
        }}>
        {actionLabel}
      </button>
    ) : null}
  </div>
);

const FunnelArrow = () => (
  <div style={{
    flex: '0 0 auto',
    padding: '0 8px',
    display: 'flex',
    alignItems: 'center',
    color: 'var(--ink-3)',
    fontFamily: '"EB Garamond", "Noto Serif SC", serif',
    fontSize: 24,
  }}>→</div>
);

// ---------------------------------------------------------------------------
// Main — FlywheelDashboard
// ---------------------------------------------------------------------------

const FlywheelDashboardScreen = (props) => {
  const slug = props && props.slug ? String(props.slug) : null;
  const onBack = props && typeof props.onBack === 'function' ? props.onBack : null;

  const fw = useMemo(() => (
    (typeof window !== 'undefined' && window.ptor && window.ptor.flywheel) || null
  ), []);

  const [health, setHealth] = useState({ score: 0, components: {} });
  const [metrics, setMetrics] = useState({});
  const [busy, setBusy] = useState(false);
  const [bridgeError, setBridgeError] = useState(null);
  const [eventLog, setEventLog] = useState([]); // recent action receipts

  const refresh = useCallback(async () => {
    if (!slug || !fw || typeof fw.health !== 'function') {
      setBridgeError('flywheel bridge unavailable');
      return;
    }
    setBridgeError(null);
    try {
      const h = await fw.health(slug);
      if (h && h.ok) {
        setHealth({ score: h.score || 0, components: h.components || {} });
        setMetrics((h.report && h.report.metrics) || {});
      } else {
        setBridgeError((h && h.error) || 'health call returned not-ok');
      }
    } catch (err) {
      setBridgeError(err && err.message ? err.message : 'health failed');
    }
  }, [slug, fw]);

  useEffect(() => { refresh(); }, [refresh]);

  // ESC → onBack
  useEffect(() => {
    if (!onBack) return undefined;
    const handler = (e) => {
      if (e.key !== 'Escape') return;
      const tgt = e.target;
      const tag = tgt && tgt.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      onBack();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onBack]);

  const logEvent = useCallback((msg) => {
    setEventLog(prev => [
      { ts: new Date().toISOString(), msg },
      ...prev.slice(0, 9),
    ]);
  }, []);

  const handleProposeSparks = useCallback(async () => {
    if (!fw || typeof fw.batchNoteToSpark !== 'function') return;
    setBusy(true);
    try {
      const res = await fw.batchNoteToSpark(slug);
      logEvent(`note→spark scan: scanned=${res.scanned || 0} eligible=${(res.eligible || []).length}`);
      await refresh();
    } catch (err) {
      logEvent(`note→spark failed: ${err.message || err}`);
    } finally { setBusy(false); }
  }, [fw, slug, refresh, logEvent]);

  const handleProposePack = useCallback(async () => {
    if (!fw || typeof fw.proposeBlueprintTemplate !== 'function') return;
    setBusy(true);
    try {
      const res = await fw.proposeBlueprintTemplate(slug);
      logEvent(res.ok
        ? `blueprint→pack template ready: ${res.packId}`
        : `blueprint→pack failed: ${res.error}`);
      await refresh();
    } catch (err) {
      logEvent(`blueprint→pack failed: ${err.message || err}`);
    } finally { setBusy(false); }
  }, [fw, slug, refresh, logEvent]);

  const handlePublishStaged = useCallback(async () => {
    if (!fw || typeof fw.listStaged !== 'function') return;
    setBusy(true);
    try {
      const res = await fw.listStaged();
      const count = (res && res.packs) ? res.packs.length : 0;
      logEvent(`staging dir holds ${count} pack(s) — inspect for PR`);
      await refresh();
    } catch (err) {
      logEvent(`list staged failed: ${err.message || err}`);
    } finally { setBusy(false); }
  }, [fw, refresh, logEvent]);

  const handleFindCommons = useCallback(async () => {
    if (!fw || typeof fw.findCommons !== 'function' || !slug) return;
    setBusy(true);
    try {
      const res = await fw.findCommons(slug, slug, { topK: 3 });
      const count = (res && res.packs) ? res.packs.length : 0;
      logEvent(`commons→lesson probe: ${count} relevant pack(s) (source=${res && res.source || '—'})`);
      await refresh();
    } catch (err) {
      logEvent(`commons probe failed: ${err.message || err}`);
    } finally { setBusy(false); }
  }, [fw, slug, refresh, logEvent]);

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--paper)',
      padding: '32px 40px',
      overflow: 'auto',
    }}>
      {/* Header */}
      <div className="row" style={{ alignItems: 'baseline', marginBottom: 24 }}>
        <h1 style={{
          fontFamily: '"EB Garamond", "Noto Serif SC", serif',
          fontStyle: 'italic',
          fontWeight: 400,
          fontSize: 32,
          letterSpacing: '0.01em',
          margin: 0,
          color: 'var(--ink-1)',
        }}>
          Learning Commons Flywheel
        </h1>
        <div style={{ flex: 1 }} />
        {onBack ? (
          <button
            onClick={onBack}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontFamily: '"EB Garamond", "Noto Serif SC", serif',
              color: 'var(--ink-2)',
              background: 'transparent',
              border: '1px solid var(--rule-soft)',
              borderRadius: 2,
              cursor: 'pointer',
              letterSpacing: '0.04em',
            }}>
            Back
          </button>
        ) : null}
      </div>

      <div style={{
        fontFamily: '"EB Garamond", "Noto Serif SC", serif',
        fontSize: 13,
        color: 'var(--ink-2)',
        marginBottom: 24,
        maxWidth: 720,
        lineHeight: 1.6,
      }}>
        Note → Spark → Pack → Commons → Lesson. The loop closes only when a public Pack
        feeds back into another user's Lesson skeleton. Health is diagnostic, not a gate —
        a low score means the flywheel hasn't started turning yet, not that it can't.
      </div>

      {/* Health Gauge */}
      <div style={{
        padding: '20px 24px',
        background: 'var(--paper)',
        border: '1px solid var(--rule-soft)',
        borderRadius: 2,
        marginBottom: 32,
      }}>
        <HealthGauge score={health.score} components={health.components} />
      </div>

      {/* Bridge error banner */}
      {bridgeError ? (
        <div style={{
          padding: '10px 14px',
          background: '#f4e6d8',
          border: '1px solid #c8a070',
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 11,
          color: '#7a3a32',
          marginBottom: 24,
          letterSpacing: '0.04em',
        }}>
          flywheel bridge: {bridgeError}
        </div>
      ) : null}

      {/* Funnel */}
      <div className="row" style={{ alignItems: 'stretch', marginBottom: 32, flexWrap: 'nowrap' }}>
        <StepCard
          step={STEPS[0]}
          count={metrics.notes_eligible_count}
          busy={busy}
          onAction={handleProposeSparks}
          actionLabel="scan notes" />
        <FunnelArrow />
        <StepCard
          step={STEPS[1]}
          count={metrics.sparks_proposed}
          busy={busy}
          onAction={null}
          actionLabel={null} />
        <FunnelArrow />
        <StepCard
          step={STEPS[2]}
          count={metrics.packs_proposed}
          busy={busy}
          onAction={handleProposePack}
          actionLabel="template blueprint" />
        <FunnelArrow />
        <StepCard
          step={STEPS[3]}
          count={metrics.packs_published}
          busy={busy}
          onAction={handlePublishStaged}
          actionLabel="list staged" />
        <FunnelArrow />
        <StepCard
          step={STEPS[4]}
          count={metrics.commons_consumed_in_lesson}
          busy={busy}
          onAction={handleFindCommons}
          actionLabel="probe commons" />
      </div>

      {/* Event log — what we just did */}
      {eventLog.length > 0 ? (
        <div style={{
          padding: '14px 18px',
          background: 'var(--paper)',
          border: '1px solid var(--rule-soft)',
          borderRadius: 2,
        }}>
          <div style={{
            fontFamily: '"EB Garamond", "Noto Serif SC", serif',
            fontStyle: 'italic',
            fontSize: 13,
            color: 'var(--ink-2)',
            marginBottom: 8,
            letterSpacing: '0.04em',
          }}>
            Recent actions
          </div>
          <div className="col gap-4">
            {eventLog.map((evt, i) => (
              <div key={i} style={{
                fontSize: 11,
                fontFamily: '"JetBrains Mono", monospace',
                color: 'var(--ink-2)',
                letterSpacing: '0.02em',
              }}>
                <span style={{ color: 'var(--ink-3)' }}>{evt.ts.slice(11, 19)}</span>
                {'  '}
                {evt.msg}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};

window.FlywheelDashboardScreen = FlywheelDashboardScreen;
