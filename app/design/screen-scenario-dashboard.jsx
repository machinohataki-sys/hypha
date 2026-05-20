/* global React */
// HYPHA · W4.1 7-Day Growth Path — Scenario Dashboard.
//
// Props: { slug, onBack, onOpenLesson }
//   - slug:           vault slug to show progress for; falls back to first course
//   - onBack:         ESC handler (also bound to header back button)
//   - onOpenLesson:   (dayIdx) => void — host routes to LessonChat for active day
//
// Register (千金 manuscript, per CLAUDE.md):
//   - Garamond italic for day titles + scenario header
//   - roman for status labels (NOT italic — italic is decoration register only)
//   - brass-bright for the ACTIVE day card (no fanfare; this IS the cursor)
//   - terracotta hairline for FAILED; sage hint for DONE; muted ink for LOCKED
//   - no emoji, no toast, no modal, no progress bar percentage, no gamification
//   - dashboard reads scenario-events.jsonl through ptor.scenario.state — no
//     vault.list scan, no client-side polling
//
// Visual scaffold: 7 day cards in a single column. Each card is a horizontal
// row — band of color on the left = status, title in the middle, status word
// on the right. Active card is the only clickable one (clicking jumps to the
// lesson for that day). Locked cards are dimmed but visible (per blueprint:
// the user should see the whole ladder, not just current rung).

const { useState, useEffect, useCallback } = React;

// ---------------------------------------------------------------------------
// Status palette — chosen to match the existing manuscript register in
// app/colors_and_type.css. We map status → 4 muted hues, not Material badges.
// ---------------------------------------------------------------------------

const STATUS = Object.freeze({
  LOCKED:    'locked',
  ACTIVE:    'active',
  DONE:      'done',
  FAILED:    'failed',
});

const STATUS_PALETTE = {
  locked: { band: '#bdb4a3', label: '未启', ink: 'var(--ink-3)', italic: false },
  active: { band: 'var(--brass-bright, #b08440)', label: '当前', ink: 'var(--ink-1)', italic: true },
  done:   { band: '#7a8f5e',                       label: '已成', ink: 'var(--ink-2)', italic: false },
  failed: { band: 'var(--terracotta, #b04a35)',    label: '回看', ink: 'var(--terracotta, #b04a35)', italic: false },
};

// Day-1 status derivation: if state.current_day === dayIdx → ACTIVE.
// If days_completed set contains dayIdx → DONE. Failed (in state) → FAILED.
// Else LOCKED (downstream of current cursor).
function deriveStatus(dayIdx, state) {
  if (!state) return STATUS.LOCKED;
  if (state.current_day == null) return STATUS.LOCKED;
  if (state.current_day >= 7 && dayIdx < 7) return STATUS.DONE;
  if (dayIdx < state.current_day) {
    // anything before cursor that was reported failed stays failed
    if (state.days_failed > 0 && state._failed_set && state._failed_set.has(dayIdx)) {
      return STATUS.FAILED;
    }
    return STATUS.DONE;
  }
  if (dayIdx === state.current_day) return STATUS.ACTIVE;
  return STATUS.LOCKED;
}

const ScenarioDashboardScreen = ({ slug, onBack, onOpenLesson }) => {
  const [plan, setPlan]   = useState([]);
  const [state, setState] = useState(null);
  const [evidence, setEvidence] = useState({});   // { dayIdx: count }
  const [loadErr, setLoadErr] = useState(null);

  const refreshState = useCallback(async () => {
    try {
      const fn = window.ptor && window.ptor.scenario && window.ptor.scenario.state;
      if (typeof fn !== 'function' || !slug) return;
      const r = await fn(slug);
      if (r && r.ok) setState(r.state);
    } catch (e) {
      setLoadErr(String(e && e.message || e));
    }
  }, [slug]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const planFn = window.ptor && window.ptor.scenario && window.ptor.scenario.dayPlan;
        if (typeof planFn !== 'function') {
          setLoadErr('scenario bridge missing — restart app');
          return;
        }
        const r = await planFn();
        if (cancelled) return;
        if (r && r.ok) setPlan(r.plan);
        await refreshState();
      } catch (e) {
        if (!cancelled) setLoadErr(String(e && e.message || e));
      }
    })();
    return () => { cancelled = true; };
  }, [slug, refreshState]);

  // ESC → back
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && typeof onBack === 'function') onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  const handleCardClick = (dayIdx, status) => {
    if (status !== STATUS.ACTIVE) return;
    if (typeof onOpenLesson === 'function') onOpenLesson(dayIdx);
  };

  if (loadErr) {
    return (
      <div style={{ padding: '80px 60px', maxWidth: 720, margin: '0 auto' }}>
        <div className="serif italic" style={{ fontSize: 24, color: 'var(--ink-1)', marginBottom: 16 }}>
          7 天路径 · 暂不可读
        </div>
        <div style={{ color: 'var(--terracotta)', fontSize: 13 }}>{loadErr}</div>
        <button onClick={onBack} style={btnLink}>← 返回</button>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', padding: '64px 60px 96px', background: 'var(--paper, #f4efe4)' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 32 }}>
          <div>
            <div className="serif italic" style={{ fontSize: 30, color: 'var(--ink-1)', lineHeight: 1.2 }}>
              7 天 Growth · AI Builder
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 6, letterSpacing: '.04em' }}>
              {state
                ? `进行中 · 第 ${Math.min((state.current_day || 0) + 1, 7)} 天 · 已成 ${state.days_completed}/7`
                : '加载路径…'}
            </div>
          </div>
          <button onClick={onBack} style={btnLink}>← 返回</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {plan.map((day) => {
            const status = deriveStatus(day.day_idx, state);
            const pal = STATUS_PALETTE[status];
            const isActive = status === STATUS.ACTIVE;
            const evidenceCount = (evidence && evidence[day.day_idx]) || 0;

            return (
              <div
                key={day.day_idx}
                onClick={() => handleCardClick(day.day_idx, status)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '6px 1fr auto',
                  alignItems: 'stretch',
                  gap: 16,
                  padding: '18px 20px',
                  background: isActive ? 'rgba(176, 132, 64, 0.05)' : 'transparent',
                  border: `1px solid ${isActive ? pal.band : 'var(--rule-soft, #d6cfb8)'}`,
                  borderRadius: 2,
                  cursor: isActive ? 'pointer' : 'default',
                  transition: 'background 200ms ease, border-color 200ms ease',
                  opacity: status === STATUS.LOCKED ? 0.55 : 1,
                }}>
                {/* Left band — status hue */}
                <div style={{
                  background: pal.band,
                  borderRadius: 1,
                  alignSelf: 'stretch',
                  marginLeft: -20,    // bleed into card edge
                  marginTop: -18,
                  marginBottom: -18,
                }} />

                {/* Middle — title + theme */}
                <div style={{ minWidth: 0, paddingLeft: 4 }}>
                  <div style={{
                    fontSize: 11,
                    color: 'var(--ink-3)',
                    letterSpacing: '.12em',
                    textTransform: 'uppercase',
                    marginBottom: 4,
                  }}>
                    Day {day.day_idx + 1}
                  </div>
                  <div className={pal.italic ? 'serif italic' : 'serif'} style={{
                    fontSize: 18,
                    color: pal.ink,
                    lineHeight: 1.3,
                    marginBottom: 6,
                  }}>
                    {day.title}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.5 }}>
                    {day.theme}
                  </div>
                  {evidenceCount > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 8, fontStyle: 'italic' }}>
                      留痕 {evidenceCount} 处
                    </div>
                  )}
                </div>

                {/* Right — status label */}
                <div style={{
                  alignSelf: 'center',
                  fontSize: 12,
                  color: pal.ink,
                  letterSpacing: '.08em',
                  textTransform: 'uppercase',
                  fontWeight: isActive ? 500 : 400,
                  minWidth: 48,
                  textAlign: 'right',
                }}>
                  {pal.label}
                </div>
              </div>
            );
          })}
        </div>

        {state && state.current_day >= 7 && (
          <div className="serif italic" style={{
            marginTop: 40,
            padding: '20px 24px',
            border: '1px solid var(--rule-soft, #d6cfb8)',
            fontSize: 15,
            color: 'var(--ink-1)',
            lineHeight: 1.6,
            textAlign: 'center',
          }}>
            七天的最后一天落幕. 接下来你写的, 才是你自己的产物.
          </div>
        )}

        <div style={{ marginTop: 48, fontSize: 11, color: 'var(--ink-3)', letterSpacing: '.04em' }}>
          slug · <span style={{ fontFamily: 'monospace' }}>{slug || '(none)'}</span>
        </div>
      </div>
    </div>
  );
};

const btnLink = {
  background: 'transparent',
  border: 'none',
  color: 'var(--ink-2)',
  fontSize: 13,
  cursor: 'pointer',
  padding: '4px 8px',
  fontFamily: 'inherit',
};

window.ScenarioDashboardScreen = ScenarioDashboardScreen;
