/* global React */
// HYPHA · W6.3 Research Radar Dashboard — BLUEPRINT §15 + ROADMAP v1.7
//
// Single surface for subscriptions, manual run trigger, and report review.
// Renders three columns on wide screens, stacks on narrow:
//   1. Subscriptions panel — list, add, remove, manual run
//   2. Reports list — most recent first, click to inspect
//   3. Report detail — synthesis paragraph + signals + spark candidates
//
// Register (千金 manuscript):
//   - Garamond italic for titles, roman for body
//   - No emoji, no exclamation marks, no SaaS gamification
//   - Cream / brass / ochre palette consistent with existing surfaces
//
// Anti-feed discipline (blueprint binding):
//   - No badge counts, no "X new" indicators, no notifications
//   - User explicitly visits this surface to read; never pushed at them
//
// Props: { slug, onBack }
//
// intentional-placeholder: every `placeholder="..."` in this file is the
// standard HTML <input> placeholder attribute (form UX hint text shown when
// the field is empty), NOT a marker for unfinished code. Same convention as
// screen-onboarding.jsx line 11-12.

const { useState, useEffect, useCallback } = React;

// ---------------------------------------------------------------------------
// Constants — mirror radar.js exports
// ---------------------------------------------------------------------------

const SOURCE_OPTIONS = [
  { id: 'arxiv',            label: 'arXiv',            hint: '论文 · canonical research' },
  { id: 'huggingface',      label: 'Hugging Face',     hint: '模型 / 数据集' },
  { id: 'github',           label: 'GitHub',           hint: 'trending repos · build-able' },
  { id: 'semantic-scholar', label: 'Semantic Scholar', hint: '引用图 · citation graph' },
];

const FREQUENCY_OPTIONS = [
  { id: 'daily',  label: 'Daily',  hint: 'Every 24h cycle' },
  { id: 'weekly', label: 'Weekly', hint: 'Once a week (6-day floor)' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _shortDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.valueOf())) return String(iso);
    return d.toISOString().slice(0, 10);
  } catch (_) {
    return String(iso);
  }
}

function _truncate(s, n) {
  const t = String(s || '').trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1) + '…';
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const SubscribeForm = ({ slug, onAdded }) => {
  const [topic, setTopic] = useState('');
  const [frequency, setFrequency] = useState('weekly');
  const [sources, setSources] = useState(['arxiv', 'huggingface']);
  const [keywords, setKeywords] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const toggleSource = (src) => {
    setSources(prev => prev.includes(src) ? prev.filter(s => s !== src) : [...prev, src]);
  };

  const submit = async () => {
    setErr('');
    if (!topic.trim()) { setErr('topic required'); return; }
    if (sources.length === 0) { setErr('pick at least one source'); return; }
    setBusy(true);
    try {
      const filterKeywords = keywords.split(',').map(s => s.trim()).filter(Boolean);
      const r = window.ptor && window.ptor.radar
        ? await window.ptor.radar.subscribe(slug, topic.trim(), { frequency, sources, filter_keywords: filterKeywords })
        : { ok: false, error: 'radar bridge unavailable' };
      if (!r || !r.ok) { setErr(r && r.error ? String(r.error) : 'subscribe failed'); return; }
      setTopic('');
      setKeywords('');
      if (typeof onAdded === 'function') onAdded();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, border: '1px solid var(--rule)', borderRadius: 8, background: 'rgba(255,255,255,.45)' }}>
      <div style={{ fontFamily: 'EB Garamond, "Noto Serif SC", serif', fontStyle: 'italic', fontSize: 18, color: 'var(--ink)' }}>
        新订阅主题
      </div>
      <input
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        placeholder="例如: diffusion models · agent harness · 拓扑数据分析"
        style={{ padding: '8px 10px', border: '1px solid var(--rule)', borderRadius: 6, fontSize: 14, fontFamily: 'var(--sans)', background: 'rgba(255,255,255,.6)', color: 'var(--ink)' }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontSize: 12, color: 'var(--ink-2)', letterSpacing: '.06em' }}>FREQUENCY</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {FREQUENCY_OPTIONS.map(opt => {
            const active = frequency === opt.id;
            return (
              <button key={opt.id} onClick={() => setFrequency(opt.id)}
                title={opt.hint}
                style={{
                  padding: '6px 12px', borderRadius: 6, cursor: 'pointer',
                  fontSize: 13, fontFamily: 'EB Garamond, serif',
                  fontStyle: active ? 'italic' : 'normal',
                  border: active ? '1px solid var(--ochre-2)' : '1px solid var(--rule)',
                  background: active ? 'rgba(184,134,11,.08)' : 'transparent',
                  color: active ? 'var(--ink)' : 'var(--ink-2)',
                }}>
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontSize: 12, color: 'var(--ink-2)', letterSpacing: '.06em' }}>SOURCES</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {SOURCE_OPTIONS.map(opt => {
            const active = sources.includes(opt.id);
            return (
              <button key={opt.id} onClick={() => toggleSource(opt.id)}
                title={opt.hint}
                style={{
                  padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
                  fontSize: 12, fontFamily: 'var(--sans)',
                  border: active ? '1px solid var(--ochre-2)' : '1px solid var(--rule)',
                  background: active ? 'rgba(184,134,11,.08)' : 'transparent',
                  color: active ? 'var(--ink)' : 'var(--ink-3)',
                }}>
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontSize: 12, color: 'var(--ink-2)', letterSpacing: '.06em' }}>FILTER KEYWORDS (comma-separated, optional)</div>
        <input
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          placeholder="transformer, scaling laws"
          style={{ padding: '6px 10px', border: '1px solid var(--rule)', borderRadius: 6, fontSize: 13, fontFamily: 'var(--sans)', background: 'rgba(255,255,255,.6)', color: 'var(--ink)' }}
        />
      </div>
      {err ? <div style={{ fontSize: 12, color: '#7a3a32' }}>{err}</div> : null}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={submit} disabled={busy || !topic.trim()}
          style={{
            padding: '7px 16px', borderRadius: 6, cursor: busy ? 'wait' : 'pointer',
            fontSize: 14, fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
            border: '1px solid var(--ochre-2)',
            background: busy ? 'rgba(0,0,0,.04)' : 'rgba(184,134,11,.12)',
            color: 'var(--ink)',
            opacity: busy || !topic.trim() ? 0.5 : 1,
          }}>
          {busy ? 'Subscribing…' : 'Subscribe'}
        </button>
      </div>
    </div>
  );
};

const SubscriptionRow = ({ sub, onRun, onRemove, runningTopic }) => {
  const running = runningTopic === sub.topic;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 12, border: '1px solid var(--rule)', borderRadius: 6, background: 'rgba(255,255,255,.4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div style={{ fontFamily: 'EB Garamond, "Noto Serif SC", serif', fontSize: 16, color: 'var(--ink)' }}>
          {sub.topic}
        </div>
        <div style={{ fontSize: 11, color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>
          {sub.frequency} · {(sub.sources || []).length} sources
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>
        Last run: {sub.last_run ? _shortDate(sub.last_run) : 'never'}
        {sub.filter_keywords && sub.filter_keywords.length > 0
          ? ` · filters: ${sub.filter_keywords.join(', ')}`
          : ''}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button onClick={() => onRun(sub.topic)} disabled={running}
          style={{
            padding: '4px 10px', borderRadius: 4, cursor: running ? 'wait' : 'pointer',
            fontSize: 12, fontFamily: 'var(--sans)',
            border: '1px solid var(--rule)', background: 'transparent', color: 'var(--ink-2)',
          }}>
          {running ? 'Running…' : 'Run now'}
        </button>
        <button onClick={() => onRemove(sub.topic)}
          style={{
            padding: '4px 10px', borderRadius: 4, cursor: 'pointer',
            fontSize: 12, fontFamily: 'var(--sans)',
            border: '1px solid var(--rule)', background: 'transparent', color: 'var(--ink-3)',
          }}>
          Remove
        </button>
      </div>
    </div>
  );
};

const ReportListItem = ({ report, active, onSelect }) => (
  <button onClick={() => onSelect(report)}
    style={{
      textAlign: 'left', padding: 10, borderRadius: 6, cursor: 'pointer',
      border: active ? '1px solid var(--ochre-2)' : '1px solid var(--rule)',
      background: active ? 'rgba(184,134,11,.06)' : 'rgba(255,255,255,.35)',
      display: 'flex', flexDirection: 'column', gap: 2,
    }}>
    <div style={{ fontFamily: 'EB Garamond, "Noto Serif SC", serif', fontSize: 14, color: 'var(--ink)' }}>
      {report.topic}
    </div>
    <div style={{ fontSize: 11, color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>
      {report.date} · {Array.isArray(report.items) ? report.items.length : 0} signals
    </div>
  </button>
);

const ReportDetail = ({ slug, report, onSparkPromoted }) => {
  const [spawning, setSpawning] = useState(null);
  const [storeBusy, setStoreBusy] = useState(false);
  const [feedback, setFeedback] = useState('');

  if (!report) {
    return (
      <div style={{ padding: 24, color: 'var(--ink-3)', fontFamily: 'EB Garamond, serif', fontStyle: 'italic', fontSize: 14 }}>
        Pick a report on the left to read.
      </div>
    );
  }

  const promoteSpark = async (candidate) => {
    setSpawning(candidate.title);
    setFeedback('');
    try {
      const r = window.ptor && window.ptor.radar
        ? await window.ptor.radar.triggerSpark(slug, candidate, { topic: report.topic, date: report.date })
        : { ok: false, error: 'radar bridge unavailable' };
      if (r && r.ok) {
        setFeedback(`Spark seeded: ${r.spark_id}`);
        if (typeof onSparkPromoted === 'function') onSparkPromoted(r.spark_id);
      } else {
        setFeedback(`Promotion failed: ${r && r.error}`);
      }
    } finally {
      setSpawning(null);
    }
  };

  const storeAsNote = async () => {
    setStoreBusy(true);
    setFeedback('');
    try {
      const r = window.ptor && window.ptor.radar
        ? await window.ptor.radar.storeAsNote(slug, report)
        : { ok: false, error: 'radar bridge unavailable' };
      if (r && r.ok) {
        setFeedback(r.deduped ? `Already stored as note ${r.node_id}` : `Stored as note ${r.node_id}`);
      } else {
        setFeedback(`Store failed: ${r && r.error}`);
      }
    } finally {
      setStoreBusy(false);
    }
  };

  const items = Array.isArray(report.items) ? report.items : [];
  const sparks = Array.isArray(report.product_spark_candidates) ? report.product_spark_candidates : [];
  const actions = Array.isArray(report.action_items) ? report.action_items : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={{ fontFamily: 'EB Garamond, "Noto Serif SC", serif', fontStyle: 'italic', fontSize: 22, color: 'var(--ink)' }}>
          {report.topic}
        </div>
        <div style={{ fontSize: 12, color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>
          {report.date}
        </div>
      </div>
      {report.synthesis_paragraph ? (
        <div style={{ fontFamily: 'EB Garamond, "Noto Serif SC", serif', fontSize: 15, lineHeight: 1.7, color: 'var(--ink)', borderLeft: '2px solid var(--ochre-2)', paddingLeft: 14 }}>
          {report.synthesis_paragraph}
        </div>
      ) : null}

      {items.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--ink-2)', letterSpacing: '.08em', fontFamily: 'var(--mono)' }}>SIGNALS</div>
          {items.map((it, i) => (
            <div key={i} style={{ padding: '8px 10px', borderLeft: '1px solid var(--rule)', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ fontSize: 13, color: 'var(--ink)' }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)', marginRight: 6 }}>[{it.source}]</span>
                {it.title}
              </div>
              {it.summary_short ? <div style={{ fontSize: 12, color: 'var(--ink-2)' }}>{it.summary_short}</div> : null}
              {it.potential_implication ? (
                <div style={{ fontSize: 12, color: 'var(--ink-3)', fontStyle: 'italic' }}>
                  {it.potential_implication}
                </div>
              ) : null}
              {it.url ? (
                <a href={it.url} target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: 11, color: 'var(--ochre-2)', fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>
                  {_truncate(it.url, 80)}
                </a>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {actions.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--ink-2)', letterSpacing: '.08em', fontFamily: 'var(--mono)' }}>NEXT MOVES</div>
          {actions.map((a, i) => (
            <div key={i} style={{ fontSize: 13, color: 'var(--ink)' }}>
              <span style={{ fontFamily: 'EB Garamond, serif', fontStyle: 'italic', marginRight: 6 }}>{a.verb}</span>
              {a.detail}
              {a.ties_to_lesson ? <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--ink-3)' }}>(ties to lesson)</span> : null}
            </div>
          ))}
        </div>
      ) : null}

      {sparks.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--ink-2)', letterSpacing: '.08em', fontFamily: 'var(--mono)' }}>PRODUCT SPARK CANDIDATES</div>
          {sparks.map((s, i) => (
            <div key={i} style={{ padding: 10, border: '1px solid var(--rule)', borderRadius: 6, background: 'rgba(255,255,255,.4)' }}>
              <div style={{ fontFamily: 'EB Garamond, "Noto Serif SC", serif', fontSize: 14, color: 'var(--ink)' }}>{s.title}</div>
              {s.core_transfer ? <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 4 }}>{s.core_transfer}</div> : null}
              {s.risk ? <div style={{ fontSize: 11, color: 'var(--ink-3)', fontStyle: 'italic', marginTop: 4 }}>Risk: {s.risk}</div> : null}
              <div style={{ marginTop: 8 }}>
                <button onClick={() => promoteSpark(s)} disabled={spawning === s.title}
                  style={{
                    padding: '4px 12px', borderRadius: 4, cursor: spawning === s.title ? 'wait' : 'pointer',
                    fontSize: 12, fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
                    border: '1px solid var(--ochre-2)', background: 'rgba(184,134,11,.06)', color: 'var(--ink)',
                  }}>
                  {spawning === s.title ? 'Seeding…' : 'Seed as spark'}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button onClick={storeAsNote} disabled={storeBusy}
          style={{
            padding: '5px 12px', borderRadius: 4, cursor: storeBusy ? 'wait' : 'pointer',
            fontSize: 12, fontFamily: 'var(--sans)',
            border: '1px solid var(--rule)', background: 'transparent', color: 'var(--ink-2)',
          }}>
          {storeBusy ? 'Storing…' : 'Store as note'}
        </button>
      </div>

      {feedback ? (
        <div style={{ fontSize: 12, color: 'var(--ink-3)', fontFamily: 'EB Garamond, serif', fontStyle: 'italic' }}>
          {feedback}
        </div>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

const RadarDashboardScreen = ({ slug, onBack }) => {
  const [subs, setSubs] = useState([]);
  const [reports, setReports] = useState([]);
  const [selectedReport, setSelectedReport] = useState(null);
  const [runningTopic, setRunningTopic] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!slug || !window.ptor || !window.ptor.radar) return;
    try {
      const subsResp = await window.ptor.radar.list(slug);
      if (subsResp && subsResp.ok) setSubs(subsResp.subscriptions || []);
      const repsResp = await window.ptor.radar.listAll(slug);
      if (repsResp && repsResp.ok) setReports(repsResp.reports || []);
    } catch (err) {
      setError(String(err && err.message || err));
    }
  }, [slug]);

  useEffect(() => { refresh(); }, [refresh, refreshTick]);

  const runOne = async (topic) => {
    setRunningTopic(topic);
    setError('');
    try {
      const r = await window.ptor.radar.run(slug, topic);
      if (!r || !r.ok) setError(`Run failed: ${r && r.error}`);
      setRefreshTick(t => t + 1);
    } catch (err) {
      setError(String(err && err.message || err));
    } finally {
      setRunningTopic(null);
    }
  };

  const removeSub = async (topic) => {
    await window.ptor.radar.unsubscribe(slug, topic);
    setRefreshTick(t => t + 1);
  };

  const onAdded = () => setRefreshTick(t => t + 1);

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--paper, #f6f1e6)', color: 'var(--ink)' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '18px 28px', borderBottom: '1px solid var(--rule)' }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', letterSpacing: '.1em', fontFamily: 'var(--mono)' }}>RESEARCH RADAR</div>
          <div style={{ fontFamily: 'EB Garamond, "Noto Serif SC", serif', fontStyle: 'italic', fontSize: 24, marginTop: 2 }}>
            {slug || 'no slug'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
            前沿不是 feed — 它会出现在下一堂课的引文里，或长成 Product Spark.
          </div>
        </div>
        {onBack ? (
          <button onClick={onBack}
            style={{
              padding: '6px 14px', borderRadius: 4, cursor: 'pointer',
              fontSize: 13, fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
              border: '1px solid var(--rule)', background: 'transparent', color: 'var(--ink-2)',
            }}>
            ← back
          </button>
        ) : null}
      </div>

      {error ? (
        <div style={{ padding: '8px 28px', fontSize: 12, color: '#7a3a32', borderBottom: '1px solid var(--rule)' }}>
          {error}
        </div>
      ) : null}

      {/* 3-column grid */}
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) minmax(220px, 1fr) minmax(360px, 2fr)', minHeight: 0 }}>
        {/* Col 1: subscriptions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, borderRight: '1px solid var(--rule)', overflowY: 'auto' }}>
          <SubscribeForm slug={slug} onAdded={onAdded} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 11, color: 'var(--ink-2)', letterSpacing: '.08em', fontFamily: 'var(--mono)', marginTop: 6 }}>SUBSCRIPTIONS</div>
            {subs.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--ink-3)', fontStyle: 'italic', fontFamily: 'EB Garamond, serif' }}>
                没有订阅 — radar 静默至首个 topic 加入。
              </div>
            ) : subs.map(sub => (
              <SubscriptionRow key={sub.topic} sub={sub} onRun={runOne} onRemove={removeSub} runningTopic={runningTopic} />
            ))}
          </div>
        </div>

        {/* Col 2: reports list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16, borderRight: '1px solid var(--rule)', overflowY: 'auto' }}>
          <div style={{ fontSize: 11, color: 'var(--ink-2)', letterSpacing: '.08em', fontFamily: 'var(--mono)' }}>FRONTIER REPORTS</div>
          {reports.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--ink-3)', fontStyle: 'italic', fontFamily: 'EB Garamond, serif' }}>
              还没有报告。
            </div>
          ) : reports.map((r, i) => (
            <ReportListItem key={`${r.topic}-${r.date}-${i}`} report={r}
              active={selectedReport && selectedReport.topic === r.topic && selectedReport.date === r.date}
              onSelect={setSelectedReport}
            />
          ))}
        </div>

        {/* Col 3: report detail */}
        <div style={{ overflowY: 'auto' }}>
          <ReportDetail slug={slug} report={selectedReport} onSparkPromoted={() => { /* hook-point for parent toast */ }} />
        </div>
      </div>
    </div>
  );
};

window.RadarDashboardScreen = RadarDashboardScreen;
