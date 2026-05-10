// V0.5 E0 D5 — TupleSubstrateView (kernel swap, live IPC)
// Replaces chat metaphor with Instance / Response / Verdict layout when
// state.json declares verification_channel. D5 = live IPC; D6 ships the
// preload.js/main.js bridge + HYPHA.html script tag.
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
  hashes: { fontFamily: MONO, fontSize: 11, color: 'var(--ink-2)', lineHeight: 1.6 },
  reason: { fontFamily: SERIF, fontStyle: 'italic', fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5 },
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

const VerdictColumn = ({ verdict, channel, hashUser, hashExpected }) => {
  if (!verdict) {
    // intentional-placeholder: empty-state is the manuscript-register
    // equivalent of an awaiting slot, not a TODO.
    return (
      <div style={S.col}>
        <div style={S.label}>Verdict</div>
        <div style={S.placeholder}>awaiting submission</div>
      </div>
    );
  }
  const tint = verdict.pass ? S.pass : S.fail;
  const flagColor = verdict.pass ? BRASS : 'var(--terracotta-2)';
  return (
    <div style={{ ...S.col, ...tint }}>
      <div style={S.label}>Verdict</div>
      <div style={{ ...S.flag, color: flagColor }}>{verdict.pass ? 'pass' : 'fail'}</div>
      <div style={S.channel}>channel: {channel || '—'}</div>
      {hashUser && (
        <div style={S.hashes}>
          <div>hash_user: <code>{String(hashUser).slice(0, 16)}…</code></div>
          {hashExpected && <div>hash_expected: <code>{String(hashExpected).slice(0, 16)}…</code></div>}
          <div>match: {hashUser === hashExpected ? 'yes' : 'no'}</div>
        </div>
      )}
      {verdict.reason && <div style={S.reason}>{verdict.reason}</div>}
    </div>
  );
};

// Self-contained: fetches its own instance + manages its own verdict state.
// Expected IPC (D6 main.js wiring):
//   nextInstance(slug, lessonIdx) → { ok, item: { id, instance,
//     syllabus_anchor?, verification_channel, answer_key_hash? }, exhausted? }
//   submitResponse(slug, lessonIdx, itemId, responseText) → { ok,
//     verdict: { pass, hash_user?, reason? } }
const TupleSubstrateView = ({ slug, lessonIdx }) => {
  const [item, setItem] = useState(null);
  const [verdict, setVerdict] = useState(null);
  const [response, setResponse] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [bridgeMissing, setBridgeMissing] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const fetchNext = useCallback(async () => {
    const evaluator = window.ptor && window.ptor.evaluator;
    const next = evaluator && evaluator.nextInstance;
    if (typeof next !== 'function') { setBridgeMissing(true); return; }
    try {
      const r = await next(slug, lessonIdx);
      if (r && r.ok && r.item) {
        setItem(r.item); setVerdict(null); setResponse(''); setExhausted(false);
      } else if (r && r.exhausted) {
        setItem(null); setExhausted(true);
      } else {
        setItem(null);
        setLoadError((r && r.error) || 'no instance returned');
      }
    } catch (err) {
      console.warn('[tuple-substrate] nextInstance failed:', err && err.message);
      setLoadError(err && err.message ? err.message : 'fetch failed');
    }
  }, [slug, lessonIdx]);

  useEffect(() => {
    if (slug == null || lessonIdx == null) return;
    fetchNext();
  }, [slug, lessonIdx, fetchNext]);

  const handleSubmit = async () => {
    if (!response || !response.trim() || !item) return;
    const submit = window.ptor && window.ptor.evaluator && window.ptor.evaluator.submitResponse;
    if (typeof submit !== 'function') { setBridgeMissing(true); return; }
    setSubmitting(true);
    try {
      const r = await submit(slug, lessonIdx, item.id, response);
      if (r && r.ok && r.verdict) setVerdict(r.verdict);
      else setVerdict({ pass: false, reason: (r && r.error) || 'evaluator returned no verdict' });
    } catch (err) {
      console.warn('[tuple-substrate] submitResponse failed:', err && err.message);
      setVerdict({ pass: false, reason: err && err.message ? err.message : 'submission failed' });
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
  if (exhausted) return <div style={S.empty}>All instances verified for this lesson.</div>;
  if (!item) {
    return (
      <div style={S.empty}>
        Loading next instance for <code>{slug || '<slug>'}</code> · lesson {lessonIdx ?? '?'} ...
      </div>
    );
  }

  return (
    <div style={S.substrate} data-slug={slug || ''} data-lesson-idx={lessonIdx != null ? lessonIdx : ''}>
      <InstanceColumn instance={item.instance} syllabusAnchor={item.syllabus_anchor} />
      <ResponseColumn value={response} onChange={setResponse} onSubmit={handleSubmit} disabled={submitting || !!verdict} />
      <VerdictColumn
        verdict={verdict}
        channel={item.verification_channel}
        hashUser={verdict && verdict.hash_user}
        hashExpected={item.answer_key_hash}
      />
      {verdict && (
        <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', paddingTop: 8 }}>
          <button style={S.submit} onClick={fetchNext}>Next instance</button>
        </div>
      )}
    </div>
  );
};

window.TupleSubstrateView = TupleSubstrateView;
