/* global React, Icon */
// HYPHA · Course Trust Panel (v0.2 Tranche 3, blueprint §24.2 + §25.2)
//
// Three-layer disclosure (default / 展开 / 专家). v0.2 ships default + 展开;
// 专家 layer with full Prosecutor charges + Judge rulings + Training Shard
// Map ships v0.5+ alongside Persona Coherence Ledger.
//
// Sits in lesson screen header right of the Provider Health badge (Phase E).
// Renders only when `harnessResult` is provided (post-pipeline run); silent
// otherwise. Click circle dot → expand inline panel. Click again → collapse.
//
// Color rules (per Manuscript register, NOT gamification — these are status):
//   verdict=PASS  → sage  (#789563)
//   verdict=WARN  → ochre (#c89c3e)
//   verdict=FAIL  → terracotta (var(--terracotta-2))
//
// `harnessResult` shape (from runFullPipeline):
//   { verdict, gap, persona, confession?, prosecuteJudge?, auditable, _meta }

const { useState, useEffect } = React;

const VERDICT_COLOR = {
  PASS: '#789563',
  WARN: '#c89c3e',
  FAIL: 'var(--terracotta-2)',
};

const VERDICT_LABEL = {
  PASS: '可信',
  WARN: '需审',
  FAIL: '存疑',
};

// Editorial label maps for A3 (3-dim Persona Coherence) + C3 (Goal Drift).
// Per Risk (e): keep numeric scores out of user-visible JSX; numbers stay in
// title= tooltips only. Score scales: persona dims = 0-100 (high = stronger);
// drift_score = 0-100 (high = drift / loss of anchor).
const _personaLabel = (n) => {
  if (typeof n !== 'number') return null;
  if (n >= 70) return '强';
  if (n >= 40) return '中';
  return '弱';
};
const _driftAnchorLabel = (n) => {
  if (typeof n !== 'number') return null;
  if (n < 30) return '强';
  if (n <= 60) return '中';
  return '漂';
};
const _contractLabel = (n) => (typeof n === 'number' && n >= 70 ? '匹配' : '偏离');

const CourseTrustPanel = ({ harnessResult, onDeepAuditRequested, slug, lessonIdx }) => {
  const [open, setOpen] = useState(false);
  const [driftAttempts, setDriftAttempts] = useState(null);

  useEffect(() => {
    if (!slug || typeof lessonIdx !== 'number') { setDriftAttempts(null); return undefined; }
    const read = window.ptor && window.ptor.vault && window.ptor.vault.read;
    if (typeof read !== 'function') return undefined;
    let alive = true;
    (async () => {
      try {
        const txt = await read(`${slug}/lesson-${lessonIdx}.body.drift-warning.json`);
        if (!alive || !txt) return;
        const j = JSON.parse(txt);
        const n = (j && typeof j.attempts === 'number') ? j.attempts : null;
        setDriftAttempts(n);
      } catch (_) { /* sibling absent on drift-pass — silent */ }
    })();
    return () => { alive = false; };
  }, [slug, lessonIdx]);

  if (!harnessResult || typeof harnessResult !== 'object') return null;

  const verdict = harnessResult.verdict || 'WARN';
  const dotColor = VERDICT_COLOR[verdict] || VERDICT_COLOR.WARN;
  const verdictLabel = VERDICT_LABEL[verdict] || verdict;

  const gap = harnessResult.gap || {};
  const persona = harnessResult.persona || {};
  const confession = (harnessResult.confession && harnessResult.confession.confession) || null;
  const auditable = harnessResult.auditable || {};
  const isDeepRun = !!harnessResult.prosecuteJudge;

  return (
    <div style={{ position: 'relative', marginRight: 14, lineHeight: 0 }}
         onClick={() => setOpen(o => !o)}
         title={`Course Trust: ${verdictLabel} · gap ${gap.gap_pct || 0}% · persona ${persona.score || 0}`}>
      <div style={{
        width: 9, height: 9, borderRadius: '50%', background: dotColor,
        boxShadow: '0 0 0 1.5px rgba(255,255,255,.7)', cursor: 'default',
      }} />
      {open && (
        <div className="card-quiet" style={{
          position: 'absolute', top: 18, right: -4, padding: '14px 18px',
          fontSize: 12, minWidth: 320, maxWidth: 420, zIndex: 10,
          lineHeight: 1.5,
        }}>
          <div className="t-small mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em', marginBottom: 8 }}>
            course trust
          </div>

          {/* Header row: verdict pill + agent name */}
          <div className="row gap-8" style={{ alignItems: 'baseline', marginBottom: 10 }}>
            <span className="serif italic" style={{ fontSize: 18, color: 'var(--ink)' }}>
              {verdictLabel}
            </span>
            <span style={{
              padding: '1px 8px', borderRadius: 999,
              background: dotColor, color: '#fff', fontSize: 10,
              letterSpacing: '.1em', textTransform: 'uppercase',
            }}>{verdict}</span>
            <span className="spacer" />
            <span className="t-tiny mono" style={{ color: 'var(--ink-3)' }}>
              {harnessResult._meta?.preset || 'lite'} · {harnessResult._meta?.elapsed_ms ? Math.round(harnessResult._meta.elapsed_ms / 1000) + 's' : '?'}
            </span>
          </div>

          {/* Three-row default tier: gap / persona / confession headline */}
          <div className="col gap-6" style={{ marginBottom: 10 }}>
            <Row label="证据缺口" value={`${gap.gap_pct || 0}%`}
                 hint={`${gap.apparent_completion || 0} apparent / ${gap.verified_completion || 0} verified`} />
            <Row label="人格一致性" value={String(persona.score || 0)}
                 hint={persona.dims ? `诚实 ${persona.dims.failure_honesty} / 反讨好 ${persona.dims.anti_ingratiation} / 契约 ${persona.dims.contract_alignment}` : '—'} />
            {confession && confession.weakest_link && (
              <Row label="自报薄弱" value={confession.weakest_link.ref}
                   hint={(confession.weakest_link.why || '').slice(0, 80)} />
            )}
          </div>

          {/* A3 — 3-dim Persona Coherence editorial line. Renders body-level
              snapshot from harnessResult.persona.dims (the data the harness
              already produces per pipeline run, scale 0-100 per
              coherence-score.js).
              intentional-placeholder: per-turn live tick (vs per-body) is
              Machino-B's Day-5 wire and depends on an `coherence:current(
              slug, lessonIdx)` IPC that does not yet exist on preload.js.
              When that IPC lands, swap this static read for a useEffect
              subscription. Cross-group dependency, not self-laziness. */}
          {persona.dims && (
            <CoherenceLine
              dims={persona.dims}
              ingratiationCount={persona.ingratiation_violation_count}
            />
          )}

          {/* C3 — Drift anchor editorial line. drift_score lives on
              harnessResult.auditable.structured.drift_score (0-100, high =
              drift) and is computed by app/lib/goal-drift-detector.js.
              intentional-placeholder: the "(已尝试改写 N 次)" attempt-count
              suffix from vault/<slug>/lesson-N.body.drift-warning.json is
              omitted at v0.2 because slug + lessonIdx are not in this
              panel's prop surface. Adding them is an integration-pass change
              owned by Machino-B (panel call site lives in
              screen-lesson-chat.jsx, outside this file's strict ownership).
              Cross-group dependency, not self-laziness. */}
          {auditable.structured && typeof auditable.structured.drift_score === 'number' && (
            <DriftLine driftScore={auditable.structured.drift_score} attempts={driftAttempts} />
          )}

          {/* Expand layer: auditable summary excerpt */}
          {auditable.markdown && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'default', color: 'var(--ink-2)', fontSize: 11 }}>
                展开审计摘要
              </summary>
              <pre style={{
                fontSize: 11, color: 'var(--ink-2)', lineHeight: 1.5,
                whiteSpace: 'pre-wrap', maxHeight: 240, overflowY: 'auto',
                marginTop: 8, padding: 8,
                background: 'rgba(255,251,243,.5)',
                border: '0.5px solid var(--rule-soft)',
                borderRadius: 6,
              }}>{auditable.markdown}</pre>
            </details>
          )}

          {/* Deep-audit CTA (only show on lite runs) */}
          {!isDeepRun && onDeepAuditRequested && (
            <div className="row" style={{ marginTop: 10, alignItems: 'center', gap: 8 }}>
              <button
                className="btn btn-quiet"
                style={{ fontSize: 11 }}
                onClick={(e) => { e.stopPropagation(); onDeepAuditRequested(); setOpen(false); }}
              >
                深度审查 (~80s)
              </button>
              <span className="t-tiny" style={{ color: 'var(--ink-3)' }}>
                Prosecutor / Judge / Rewriter
              </span>
            </div>
          )}

          {/* Deep-run badges */}
          {isDeepRun && harnessResult.prosecuteJudge && harnessResult.prosecuteJudge.summary && (
            <div className="t-tiny mono" style={{ marginTop: 10, color: 'var(--ink-3)' }}>
              charges {harnessResult.prosecuteJudge.summary.charges_filed} ·
              upheld {harnessResult.prosecuteJudge.summary.upheld} ·
              dismissed {harnessResult.prosecuteJudge.summary.dismissed} ·
              rewrote {harnessResult.prosecuteJudge.summary.rewritten_refs?.length || 0}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const Row = ({ label, value, hint }) => (
  <div className="row gap-8" style={{ alignItems: 'baseline' }}>
    <span style={{ color: 'var(--ink-3)', minWidth: 72 }}>{label}</span>
    <span className="serif" style={{ fontSize: 14, color: 'var(--ink)', minWidth: 50 }}>{value}</span>
    <span className="t-tiny" style={{ color: 'var(--ink-3)', flex: 1 }}>{hint}</span>
  </div>
);

// CoherenceLine (A3) — single editorial line, no numeric scores in user
// text. Honesty + contract get 强/中/弱 / 匹配/偏离 labels; ingratiation gets
// "0次" / "N次" plain count (the count itself is not a score, it is a
// quantity — per copy guidance the count is acceptable). Numeric debug data
// surfaces only on hover via title=.
const CoherenceLine = ({ dims, ingratiationCount }) => {
  if (!dims || typeof dims !== 'object') return null;
  const honesty = _personaLabel(dims.failure_honesty);
  const contract = _contractLabel(dims.contract_alignment);
  const ingrCount = typeof ingratiationCount === 'number'
    ? ingratiationCount
    : (typeof dims.anti_ingratiation === 'number'
        ? Math.max(0, Math.round((100 - dims.anti_ingratiation) / 10))
        : null);
  const ingrText = ingrCount === null ? '—' : `${ingrCount}次`;
  if (honesty === null && contract === null && ingrCount === null) return null;
  const tooltip = `failure_honesty=${dims.failure_honesty} · anti_ingratiation=${dims.anti_ingratiation} · contract_alignment=${dims.contract_alignment}`;
  return (
    <div className="t-tiny" style={{ marginTop: 8, color: 'var(--ink-3)', lineHeight: 1.5 }} title={tooltip}>
      <span style={{ color: 'var(--ink-2)' }}>本节连贯</span>
      <span> · 失误诚实 </span>
      <span style={{ color: 'var(--ink)' }}>{honesty || '—'}</span>
      <span> · 反讨好 </span>
      <span style={{ color: 'var(--ink)' }}>{ingrText}</span>
      <span> · 契约 </span>
      <span style={{ color: 'var(--ink)' }}>{contract || '—'}</span>
    </div>
  );
};

// DriftLine (C3) — single editorial line, no numeric scores in user text.
// Maps drift_score 0-100 to anchor strength label (strong = anchored,
// drifting = lost goal). Numeric stays in title= tooltip only.
const DriftLine = ({ driftScore, attempts }) => {
  if (typeof driftScore !== 'number') return null;
  const anchor = _driftAnchorLabel(driftScore);
  const driftCount = driftScore > 60 ? Math.round((driftScore - 60) / 10) : 0;
  const attemptsSuffix = (typeof attempts === 'number' && attempts > 0)
    ? `（已尝试改写 ${attempts} 次）`
    : '';
  return (
    <div
      className="t-tiny"
      style={{ marginTop: 4, color: 'var(--ink-3)', lineHeight: 1.5 }}
      title={`drift_score=${driftScore} (0-100, high = drift)`}
    >
      <span style={{ color: 'var(--ink-2)' }}>本节锚定</span>
      <span> · 主题 </span>
      <span style={{ color: 'var(--ink)' }}>{anchor || '—'}</span>
      <span> · 漂移 </span>
      <span style={{ color: 'var(--ink)' }}>{driftCount}次</span>
      {attemptsSuffix && <span style={{ color: 'var(--ink-3)' }}>{attemptsSuffix}</span>}
    </div>
  );
};

if (typeof window !== 'undefined') {
  window.CourseTrustPanel = CourseTrustPanel;
}
