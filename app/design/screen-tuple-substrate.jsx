// V0.5 E0 D11-D14 Phase 1 — TupleSubstrateView (real evaluator IPC consumer)
// V0.5 E0 D15-D18 Phase 2 ζ — UX states atop Phase 1 IPC consumption.
// Replaces chat metaphor with Instance / Response / Verdict layout.
// D5 = live IPC scaffold (slug/lessonIdx contract). D11 swap to per-topic
// evaluator IPC: nextInstance(topic) → {item, candidate}; submitResponse
// (itemId, candidateId, responseText) → {verified, exec_result, recorded}.
// D15 ζ adds: empty / loading / error states, Cmd+Enter submit, auto-refetch
// after submit, brass progress indicator (rated / n_items · κ).
// Manuscript register (inline only): cream paper, brass hairlines, italic
// Garamond labels, oxblood verdict-fail, brass-bright verdict-pass. No emoji.

const React = window.React;
const { useState, useEffect, useCallback, useRef } = React;

const SERIF = '"EB Garamond", "Noto Serif SC", serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const BRASS = '#a98b3a';

const S = {
  substrate: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)',
    gap: 16,
    padding: '20px 0',
    borderTop: '1px solid var(--rule-soft)',
    transition: 'opacity 300ms ease-out',
  },
  empty: { padding: '40px 0', color: 'var(--ink-3)', fontFamily: SERIF, fontStyle: 'italic', fontSize: 15 },
  emptyExhausted: {
    padding: '60px 0', textAlign: 'center', color: BRASS,
    fontFamily: SERIF, fontStyle: 'italic', fontSize: 17, letterSpacing: '.04em',
    borderTop: `1px solid ${BRASS}`, borderBottom: `1px solid ${BRASS}`,
  },
  progress: {
    fontFamily: SERIF, fontStyle: 'italic', fontSize: 13, color: BRASS,
    letterSpacing: '.06em', padding: '8px 0 12px 0',
    borderBottom: '1px solid var(--rule-soft)',
  },
  col: {
    display: 'flex', flexDirection: 'column', gap: 10, padding: 16, minHeight: 240,
    borderTop: '1px solid var(--rule-soft)', borderBottom: '1px solid var(--rule-soft)',
  },
  label: { fontFamily: SERIF, fontStyle: 'italic', fontSize: 13, color: 'var(--ink-3)', letterSpacing: '.04em' },
  anchor: { fontFamily: MONO, fontSize: 11, color: 'var(--ink-3)', letterSpacing: '.06em' },
  body: { fontFamily: SERIF, fontSize: 15, lineHeight: 1.55, color: 'var(--ink)', whiteSpace: 'pre-wrap' },
  placeholder: { fontFamily: SERIF, fontStyle: 'italic', fontSize: 13, color: 'var(--ink-3)' },
  // Loading skeleton: 3 dim cream lines breathing at 0.6 opacity. No spinner —
  // manuscript register prefers the absence of the column over a glyph.
  skeletonLine: {
    height: 14, background: 'var(--ink-3)', opacity: 0.18, borderRadius: 1,
    animation: 'tupleSkelPulse 1.4s ease-in-out infinite',
  },
  skeletonShort: { width: '60%' },
  // Oxblood-italic error line atop InstanceColumn body.
  errorLine: {
    fontFamily: SERIF, fontStyle: 'italic', fontSize: 13, color: 'var(--terracotta-2)',
    lineHeight: 1.5, paddingBottom: 4, borderBottom: '1px solid var(--terracotta-2)',
  },
  input: {
    width: '100%', minHeight: 180, padding: 12, border: '1px solid var(--rule-soft)',
    background: 'transparent', fontFamily: SERIF, fontSize: 15, lineHeight: 1.55,
    color: 'var(--ink)', resize: 'vertical', outline: 'none',
  },
  hint: {
    fontFamily: SERIF, fontStyle: 'italic', fontSize: 12, color: 'var(--ink-3)',
    letterSpacing: '.04em', marginTop: 2,
  },
  hintKey: { fontFamily: SERIF, fontStyle: 'italic', color: BRASS },
  submit: {
    alignSelf: 'flex-start', padding: '8px 16px', border: '1px solid var(--ink-3)',
    background: 'transparent', fontFamily: SERIF, fontSize: 14, color: 'var(--ink)',
    cursor: 'pointer', letterSpacing: '.04em',
  },
  submitBlocked: { cursor: 'not-allowed', color: 'var(--ink-3)', borderColor: 'var(--rule-soft)' },
  pass: { borderTopColor: BRASS, borderBottomColor: BRASS },
  fail: { borderTopColor: 'var(--terracotta-2)', borderBottomColor: 'var(--terracotta-2)' },
  flag: { fontFamily: SERIF, fontStyle: 'italic', fontSize: 16, letterSpacing: '.06em' },
  channel: { fontFamily: MONO, fontSize: 11, color: 'var(--ink-3)', letterSpacing: '.06em' },
  reason: { fontFamily: SERIF, fontStyle: 'italic', fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5 },
  // Per-feature breakdown — italic claim with brass-bright (hit) / oxblood
  // (miss) feature id flag. Sealed-rubric channel only; code-cell items leave
  // per_feature empty so the block renders nothing.
  featureList: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 },
  featureRow: {
    display: 'grid', gridTemplateColumns: '40px 1fr', gap: 10, alignItems: 'baseline',
    fontFamily: SERIF, fontSize: 13, lineHeight: 1.5,
  },
  featureFlagHit: { fontFamily: MONO, fontSize: 11, color: BRASS, letterSpacing: '.04em' },
  featureFlagMiss: { fontFamily: MONO, fontSize: 11, color: 'var(--terracotta-2)', letterSpacing: '.04em' },
  featureClaim: { fontStyle: 'italic', color: 'var(--ink-2)' },
  featureClaimMiss: { fontStyle: 'italic', color: 'var(--ink-3)', textDecoration: 'line-through solid var(--rule-soft)' },
  hits: { fontFamily: MONO, fontSize: 11, color: 'var(--ink-2)', letterSpacing: '.04em', marginTop: 6 },
};

// Inject keyframes once. Cheap global so we don't bloat each instance render.
if (typeof document !== 'undefined' && !document.getElementById('tuple-substrate-kf')) {
  const styleEl = document.createElement('style');
  styleEl.id = 'tuple-substrate-kf';
  styleEl.textContent = `
    @keyframes tupleSkelPulse { 0%, 100% { opacity: 0.12 } 50% { opacity: 0.32 } }
    @keyframes tupleBrassFlash { 0% { opacity: 0.55 } 100% { opacity: 1 } }
  `;
  document.head.appendChild(styleEl);
}

const InstanceColumn = ({ instance, syllabusAnchor, errorLine }) => (
  <div style={S.col}>
    <div style={S.label}>Instance</div>
    {errorLine && <div style={S.errorLine}>evaluator IPC failed: {errorLine}</div>}
    {syllabusAnchor && <div style={S.anchor}>{syllabusAnchor}</div>}
    <div style={S.body}>{instance || ''}</div>
  </div>
);

// LoadingInstanceColumn — 3 dim cream skeleton lines while the initial IPC
// fetch is in flight. Replaces InstanceColumn body, not the whole 3-col grid,
// so the surrounding chrome stays stable.
const LoadingInstanceColumn = () => (
  <div style={S.col}>
    <div style={S.label}>Instance</div>
    <div style={S.skeletonLine} />
    <div style={S.skeletonLine} />
    <div style={{ ...S.skeletonLine, ...S.skeletonShort }} />
  </div>
);

const ResponseColumn = ({ value, onChange, onSubmit, disabled }) => {
  const blocked = disabled || !(value && value.trim());
  // Cmd+Enter (mac) / Ctrl+Enter (win/linux): submit when textarea focused.
  // Native textarea Enter inserts newline; modifier+Enter is the published
  // shortcut. Render the keysym below as italic Garamond ⌘ glyph.
  const onKeyDown = (e) => {
    if (e.key !== 'Enter') return;
    if (!(e.metaKey || e.ctrlKey)) return;
    if (blocked) return;
    e.preventDefault();
    onSubmit();
  };
  return (
    <div style={S.col}>
      <div style={S.label}>Response</div>
      <textarea
        style={S.input}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Your response here. Strict match against sealed rubric."
        disabled={disabled}
        rows={12}
      />
      <button
        style={{ ...S.submit, ...(blocked ? S.submitBlocked : null) }}
        onClick={onSubmit}
        disabled={blocked}
      >
        Submit
      </button>
      <div style={S.hint}>
        <span style={S.hintKey}>⌘</span> + Enter to submit
      </div>
    </div>
  );
};

// VerdictColumn — renders the structured `verified` payload from
// evaluator:submitResponse. Two channels arrive in distinct shapes:
//   sealed_rubric / feature_substring: per_feature[] populated, exec_result null
//   code:                              per_feature empty, exec_result populated
// Both share predicted_pass + channel; rendering branches on what is present.
const VerdictColumn = ({ verified, exec_result }) => {
  if (!verified) {
    // intentional-placeholder: empty-state is the manuscript-register
    // equivalent of an awaiting slot, not a TODO.
    return (
      <div style={S.col}>
        <div style={S.label}>Verdict</div>
        <div style={S.placeholder}>awaiting submission</div>
      </div>
    );
  }
  const tint = verified.predicted_pass ? S.pass : S.fail;
  const flagColor = verified.predicted_pass ? BRASS : 'var(--terracotta-2)';
  const channelLabel = verified.channel || 'unknown';
  const featureRows = Array.isArray(verified.per_feature) ? verified.per_feature : [];
  const featuresHit = Array.isArray(verified.features_hit) ? verified.features_hit : [];
  const threshold = verified.threshold;

  return (
    <div style={{ ...S.col, ...tint }}>
      <div style={S.label}>Verdict</div>
      <div style={{ ...S.flag, color: flagColor }}>
        {verified.predicted_pass ? 'pass' : 'fail'}
      </div>
      <div style={S.channel}>channel: {channelLabel}</div>

      {featureRows.length > 0 && (
        <div style={S.featureList}>
          {featureRows.map((f) => (
            <div key={f.id} style={S.featureRow}>
              <span style={f.hit ? S.featureFlagHit : S.featureFlagMiss}>
                {f.id} {f.hit ? 'hit' : 'miss'}
              </span>
              <span style={f.hit ? S.featureClaim : S.featureClaimMiss}>
                {(f.statement || f.claim || f.matched_phrasing || '').toString()}
              </span>
            </div>
          ))}
        </div>
      )}

      {featureRows.length > 0 && (
        <div style={S.hits}>
          {featuresHit.length}/{featureRows.length} features hit
          {threshold != null ? ` · threshold ${threshold}` : ''}
        </div>
      )}

      {exec_result && (
        <div style={S.hits}>
          exit {exec_result.exit_code != null ? exec_result.exit_code : '—'}
          {Number.isFinite(exec_result.runtime_ms) ? ` · ${exec_result.runtime_ms}ms` : ''}
          {exec_result.hash_match != null ? ` · hash ${exec_result.hash_match ? 'match' : 'mismatch'}` : ''}
        </div>
      )}
      {exec_result && exec_result.stderr_excerpt && (
        <div style={S.reason}>{exec_result.stderr_excerpt}</div>
      )}

      {verified.reason && <div style={S.reason}>{verified.reason}</div>}
    </div>
  );
};

// ProgressLine — italic Garamond brass row at top of view. Shape:
//   "<rated>/<n_items> · κ <0.71|—>"
// Rated count = items where rater_a sidecar covers ≥ 1 candidate (loader-
// merged). κ comes from evaluator:irrCompute(topic). κ rendered as em-dash
// when below kappa_n threshold or unreported.
const ProgressLine = ({ rated, total, kappa }) => {
  if (!total) return null;
  const kappaStr = (kappa != null && Number.isFinite(kappa)) ? kappa.toFixed(2) : '—';
  return (
    <div style={S.progress}>
      {rated}/{total} · κ {kappaStr}
    </div>
  );
};

// Self-contained: fetches its own instance + manages its own verdict state.
//
// IPC contract (window.ptor.evaluator):
//   nextInstance(topic) → {ok, item, candidate, exhausted?, error?}
//     item        = full golden-set item (id, instance, verification_channel,
//                   answer_features, syllabus_anchor, etc.)
//     candidate   = single candidate_response object {id, text, ...}
//     exhausted   = true when no unrated (item, candidate) pair remains
//   submitResponse(itemId, candidateId, responseText) →
//     {ok, verified: {channel, predicted_pass, features_hit, per_feature,
//                     threshold, reason?}, exec_result, recorded, error?}
//   irrCompute(topic) →
//     {ok, kappa, kappa_n, n_items, n_double_coded, error?}
//
// Topic source: the `topic` prop is canonical. For backward-compat with the
// D5 contract that passed (slug, lessonIdx), `slug` is accepted as a fallback
// and treated as the topic identifier.
const TupleSubstrateView = ({ topic, slug, lessonIdx }) => {
  const effectiveTopic = topic || slug || null;

  const [item, setItem] = useState(null);
  const [candidate, setCandidate] = useState(null);
  const [verified, setVerified] = useState(null);
  const [execResult, setExecResult] = useState(null);
  const [response, setResponse] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [bridgeMissing, setBridgeMissing] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [loadError, setLoadError] = useState(null);
  // ζ additions: initial-load skeleton flag, brass-flash transition flag,
  // progress (rated/n_items + kappa). `loading` differs from `!item` after
  // submission re-fetch so the existing 3-col stays mounted.
  const [initialLoading, setInitialLoading] = useState(true);
  const [transitioning, setTransitioning] = useState(false);
  const [progress, setProgress] = useState({ rated: 0, total: 0, kappa: null });
  const flashTimerRef = useRef(null);

  // refreshProgress — pulls fresh κ + counts. Called on mount and after each
  // submit. Failures degrade silently to console.warn (never silent-catch:
  // log + leave previous state). Counts come from items.rater_a presence
  // (golden-loader merges sidecars at read time).
  const refreshProgress = useCallback(async () => {
    if (!effectiveTopic) return;
    const evaluator = window.ptor && window.ptor.evaluator;
    const irr = evaluator && evaluator.irrCompute;
    if (typeof irr !== 'function') return;
    try {
      const r = await irr(effectiveTopic);
      if (r && r.ok) {
        // n_items = total. rated count is not a distinct field in the IRR
        // envelope; closest proxy = n_double_coded for "fully rated by both"
        // OR the loader's own rater_a coverage. We use n_items (total) and
        // expose rated as the count derived from nextInstance walk: when
        // exhausted=true, rated === total. Otherwise we approximate via
        // (n_items - 1) when an item is fetched? — no, too brittle.
        // Instead: rated count is computed by golden-loader.rater_a_coverage
        // if present; fall back to n_double_coded (lower bound).
        const total = Number.isFinite(r.n_items) ? r.n_items : 0;
        const rated = Number.isFinite(r.rater_a_n) ? r.rater_a_n
          : (Number.isFinite(r.n_double_coded) ? r.n_double_coded : 0);
        setProgress({
          rated,
          total,
          kappa: Number.isFinite(r.kappa) ? r.kappa : null,
        });
      } else {
        console.warn('[tuple-substrate] irrCompute returned error:', r && r.error);
      }
    } catch (err) {
      console.warn('[tuple-substrate] irrCompute failed:', err && err.message);
    }
  }, [effectiveTopic]);

  const fetchNext = useCallback(async () => {
    setLoadError(null);
    const evaluator = window.ptor && window.ptor.evaluator;
    const next = evaluator && evaluator.nextInstance;
    if (typeof next !== 'function') {
      setBridgeMissing(true);
      setInitialLoading(false);
      return;
    }
    if (!effectiveTopic) {
      setLoadError('no topic provided');
      setInitialLoading(false);
      return;
    }
    try {
      const r = await next(effectiveTopic);
      if (r && r.ok && r.item && r.candidate) {
        setItem(r.item);
        setCandidate(r.candidate);
        setResponse('');
        setVerified(null);
        setExecResult(null);
        setExhausted(false);
      } else if (r && r.ok && r.exhausted) {
        setItem(null);
        setCandidate(null);
        setExhausted(true);
      } else {
        setItem(null);
        setCandidate(null);
        setLoadError((r && r.error) || 'no instance returned');
      }
    } catch (err) {
      console.warn('[tuple-substrate] nextInstance failed:', err && err.message);
      setLoadError(err && err.message ? err.message : 'fetch failed');
    } finally {
      setInitialLoading(false);
    }
  }, [effectiveTopic]);

  useEffect(() => {
    if (!effectiveTopic) {
      setInitialLoading(false);
      return;
    }
    setInitialLoading(true);
    fetchNext();
    refreshProgress();
  }, [effectiveTopic, fetchNext, refreshProgress]);

  // Cleanup flash timer on unmount to avoid setState-after-unmount warnings.
  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
  }, []);

  const handleSubmit = async () => {
    if (!response || !response.trim() || !item || !candidate) return;
    const evaluator = window.ptor && window.ptor.evaluator;
    const submit = evaluator && evaluator.submitResponse;
    if (typeof submit !== 'function') { setBridgeMissing(true); return; }
    setSubmitting(true);
    try {
      const r = await submit(item.id, candidate.id, response);
      if (r && r.ok && r.verified) {
        setVerified(r.verified);
        setExecResult(r.exec_result || null);
        // Auto-fetch next pair after a brief brass-flash transition. The
        // verdict stays visible during the 300ms window so the rater sees
        // the result before the next instance loads.
        setTransitioning(true);
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => {
          setTransitioning(false);
          fetchNext();
          refreshProgress();
        }, 300);
      } else {
        setVerified({
          channel: 'unknown',
          predicted_pass: false,
          features_hit: [],
          per_feature: [],
          reason: (r && r.error) || 'evaluator returned no verdict',
        });
      }
    } catch (err) {
      console.warn('[tuple-substrate] submitResponse failed:', err && err.message);
      setVerified({
        channel: 'unknown',
        predicted_pass: false,
        features_hit: [],
        per_feature: [],
        reason: err && err.message ? err.message : 'submission failed',
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (bridgeMissing) {
    return (
      <div style={{ ...S.empty, borderTop: `1px solid ${BRASS}`, padding: '20px 0' }}>
        evaluator IPC pending — window.ptor.evaluator.{'{'}nextInstance, submitResponse{'}'} not yet exposed.
      </div>
    );
  }
  // ζ: brass-italic exhausted empty-state replaces the 3-col entirely.
  if (exhausted) {
    return (
      <>
        <ProgressLine rated={progress.rated} total={progress.total} kappa={progress.kappa} />
        <div style={S.emptyExhausted}>
          本卷已尽 · No more instances for &lt;{effectiveTopic || 'topic'}&gt;
        </div>
      </>
    );
  }
  // ζ: initial-load skeleton path. Renders 3-col scaffold with skeleton in
  // InstanceColumn instead of the empty "Loading..." line. Once the first
  // fetch resolves, this branch falls through to the live render below.
  if (initialLoading && !item) {
    return (
      <>
        <ProgressLine rated={progress.rated} total={progress.total} kappa={progress.kappa} />
        <div style={S.substrate}>
          <LoadingInstanceColumn />
          <div style={S.col}>
            <div style={S.label}>Response</div>
            <div style={S.placeholder}>awaiting instance</div>
          </div>
          <div style={S.col}>
            <div style={S.label}>Verdict</div>
            <div style={S.placeholder}>awaiting submission</div>
          </div>
        </div>
      </>
    );
  }
  // ζ: oxblood error line embedded in InstanceColumn (does not blank
  // surrounding chrome). Distinct from bridgeMissing (entire bridge gone) and
  // exhausted (no work left). Renders even when item is null.
  if (loadError) {
    return (
      <>
        <ProgressLine rated={progress.rated} total={progress.total} kappa={progress.kappa} />
        <div style={S.substrate}>
          <InstanceColumn instance="" syllabusAnchor={null} errorLine={loadError} />
          <div style={S.col}>
            <div style={S.label}>Response</div>
            <div style={S.placeholder}>blocked — fix evaluator first</div>
          </div>
          <div style={S.col}>
            <div style={S.label}>Verdict</div>
            <div style={S.placeholder}>—</div>
          </div>
        </div>
      </>
    );
  }
  if (!item || !candidate) {
    return (
      <div style={S.empty}>
        Loading next instance for <code>{effectiveTopic || '<topic>'}</code>
        {lessonIdx != null ? <> · lesson {lessonIdx}</> : null} ...
      </div>
    );
  }

  // Brass-flash transition: 300ms opacity bump on the 3-col after submit.
  // Render the verdict during the flash so the rater sees the outcome.
  const substrateStyle = transitioning
    ? { ...S.substrate, animation: 'tupleBrassFlash 300ms ease-out' }
    : S.substrate;

  return (
    <>
      <ProgressLine rated={progress.rated} total={progress.total} kappa={progress.kappa} />
      <div
        style={substrateStyle}
        data-topic={effectiveTopic || ''}
        data-item-id={item.id || ''}
        data-candidate-id={candidate.id || ''}
      >
        <InstanceColumn instance={item.instance} syllabusAnchor={item.syllabus_anchor} />
        <ResponseColumn
          value={response}
          onChange={setResponse}
          onSubmit={handleSubmit}
          disabled={submitting || !!verified}
        />
        <VerdictColumn verified={verified} exec_result={execResult} />
        {verified && !transitioning && (
          <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', paddingTop: 8 }}>
            <button style={S.submit} onClick={() => { fetchNext(); refreshProgress(); }}>Next instance</button>
          </div>
        )}
      </div>
    </>
  );
};

window.TupleSubstrateView = TupleSubstrateView;
