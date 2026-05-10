// V0.5 E0 D11-D14 Phase 1 — TupleSubstrateView (real evaluator IPC consumer)
// Replaces chat metaphor with Instance / Response / Verdict layout.
// D5 = live IPC scaffold (slug/lessonIdx contract). D11 swap to per-topic
// evaluator IPC: nextInstance(topic) → {item, candidate}; submitResponse
// (itemId, candidateId, responseText) → {verified, exec_result, recorded}.
// Manuscript register (inline only): cream paper, brass hairlines, italic
// Garamond labels, oxblood verdict-fail, brass-bright verdict-pass. No emoji.

const React = window.React;
const { useState, useEffect, useCallback } = React;

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
  },
  empty: { padding: '40px 0', color: 'var(--ink-3)', fontFamily: SERIF, fontStyle: 'italic', fontSize: 15 },
  col: {
    display: 'flex', flexDirection: 'column', gap: 10, padding: 16, minHeight: 240,
    borderTop: '1px solid var(--rule-soft)', borderBottom: '1px solid var(--rule-soft)',
  },
  label: { fontFamily: SERIF, fontStyle: 'italic', fontSize: 13, color: 'var(--ink-3)', letterSpacing: '.04em' },
  anchor: { fontFamily: MONO, fontSize: 11, color: 'var(--ink-3)', letterSpacing: '.06em' },
  body: { fontFamily: SERIF, fontSize: 15, lineHeight: 1.55, color: 'var(--ink)', whiteSpace: 'pre-wrap' },
  placeholder: { fontFamily: SERIF, fontStyle: 'italic', fontSize: 13, color: 'var(--ink-3)' },
  input: {
    width: '100%', minHeight: 180, padding: 12, border: '1px solid var(--rule-soft)',
    background: 'transparent', fontFamily: SERIF, fontSize: 15, lineHeight: 1.55,
    color: 'var(--ink)', resize: 'vertical', outline: 'none',
  },
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

const InstanceColumn = ({ instance, syllabusAnchor }) => (
  <div style={S.col}>
    <div style={S.label}>Instance</div>
    {syllabusAnchor && <div style={S.anchor}>{syllabusAnchor}</div>}
    <div style={S.body}>{instance || ''}</div>
  </div>
);

const ResponseColumn = ({ value, onChange, onSubmit, disabled }) => {
  const blocked = disabled || !(value && value.trim());
  return (
    <div style={S.col}>
      <div style={S.label}>Response</div>
      <textarea
        style={S.input}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
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

  const fetchNext = useCallback(async () => {
    setLoadError(null);
    const evaluator = window.ptor && window.ptor.evaluator;
    const next = evaluator && evaluator.nextInstance;
    if (typeof next !== 'function') { setBridgeMissing(true); return; }
    if (!effectiveTopic) {
      setLoadError('no topic provided');
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
    }
  }, [effectiveTopic]);

  useEffect(() => {
    if (!effectiveTopic) return;
    fetchNext();
  }, [effectiveTopic, fetchNext]);

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
  if (loadError) return <div style={S.empty}>Could not load next instance: <code>{loadError}</code>.</div>;
  if (exhausted) return <div style={S.empty}>All instances rated for this topic.</div>;
  if (!item || !candidate) {
    return (
      <div style={S.empty}>
        Loading next instance for <code>{effectiveTopic || '<topic>'}</code>
        {lessonIdx != null ? <> · lesson {lessonIdx}</> : null} ...
      </div>
    );
  }

  return (
    <div
      style={S.substrate}
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
      {verified && (
        <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', paddingTop: 8 }}>
          <button style={S.submit} onClick={fetchNext}>Next instance</button>
        </div>
      )}
    </div>
  );
};

window.TupleSubstrateView = TupleSubstrateView;
