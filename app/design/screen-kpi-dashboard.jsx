/* global React */
// HYPHA · W4.2 KPI Dashboard — Closed Beta KPI screen.
//
// Renders the 5 KPI from BLUEPRINT §20 v1.0:
//   1. completion rate          (60% gate)
//   2. artifact rate            (40% gate)
//   3. product pool conversion  (transfer → seed → accepted)
//   4. companion satisfaction   (0-100 score)
//   5. payment willingness      (survey card — only after 7-day path closes)
//
// Reads window.ptor.kpi.aggregate(slug) once on mount + on slug change. The
// payment survey radio component below writes back via
// window.ptor.kpi.surveyPayment.
//
// Register (千金 manuscript):
//   - Garamond italic for h1 / KPI headlines, roman for body counters
//   - JetBrains Mono only for ratios + small evidence ts
//   - No progress bars, no gauges, no modal, no gamification
//   - 5 cards in a calm 2x3 grid (5th card may sit alone on bottom row)
//   - Numbers ARE the visual — gates render as inline "0.43 · gate 0.60" lines
//
// Props: { slug, onBack }

const { useState, useEffect, useCallback, useMemo } = React;

// ---------------------------------------------------------------------------
// Gates per BLUEPRINT §20. UI surfaces them as the inline "gate" caption next
// to each rate — never as a green/red traffic light (千金 register).
// ---------------------------------------------------------------------------
const GATE_COMPLETION = 0.60;
const GATE_ARTIFACT = 0.40;
const GATE_PAYMENT = 0.30;
// Pool / companion KPI have no fixed v1.0 gate — they are qualitative
// signals per blueprint ("用户认为 Product Pool 增强...") and we display
// the absolute count instead.

// ---------------------------------------------------------------------------
// Small format helpers
// ---------------------------------------------------------------------------

function _fmtPct(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '—';
  return (rate * 100).toFixed(0) + '%';
}

function _fmtRatio(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '—';
  return rate.toFixed(2);
}

function _fmtShortStamp(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.valueOf())) return '';
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mm}-${dd}`;
  } catch (_) { return ''; }
}

// ---------------------------------------------------------------------------
// Card primitive — every KPI uses this same frame so the grid reads as one
// page, not five competing widgets. Header is mono eyebrow; body is Garamond.
// ---------------------------------------------------------------------------
const KPICard = ({ eyebrow, headline, gateLine, children }) => (
  <section style={{
    padding: '22px 24px 24px',
    border: '1px solid var(--rule-soft)',
    borderRadius: 3,
    background: 'rgba(244,239,228,0.40)',
    fontFamily: 'EB Garamond, "Noto Serif SC", serif',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    minHeight: 220,
  }}>
    <div className="mono" style={{
      fontSize: 10,
      letterSpacing: '0.16em',
      textTransform: 'uppercase',
      color: 'var(--ink-3)',
    }}>
      {eyebrow}
    </div>
    <div className="serif italic" style={{
      fontSize: 36,
      lineHeight: 1.05,
      color: 'var(--ink)',
      fontWeight: 400,
    }}>
      {headline}
    </div>
    {gateLine && (
      <div className="mono" style={{
        fontSize: 11,
        color: 'var(--ink-3)',
        letterSpacing: '0.06em',
      }}>
        {gateLine}
      </div>
    )}
    <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
  </section>
);

// ---------------------------------------------------------------------------
// 1. Completion rate card — micro-trace of which days landed.
// ---------------------------------------------------------------------------
const CompletionCard = ({ data }) => {
  if (!data) return <KPICard eyebrow="完成率 · 7-day" headline="—" />;
  const { rate, days_completed, total, evidence_chain } = data;
  const dayChips = Array.from({ length: total }, (_, i) => {
    const hit = (evidence_chain || []).find((e) => e.day === i);
    return (
      <span
        key={i}
        title={hit ? `Day ${i + 1} · ${_fmtShortStamp(hit.ts)} · ${hit.source}` : `Day ${i + 1} · 未完成`}
        style={{
          display: 'inline-block',
          width: 28,
          height: 10,
          borderRadius: 1,
          marginRight: 6,
          background: hit ? 'var(--ink-1)' : 'transparent',
          border: '1px solid var(--ink-1)',
          opacity: hit ? 1 : 0.35,
        }}
      />
    );
  });
  const gate = `${_fmtRatio(rate)} · gate ${GATE_COMPLETION.toFixed(2)}`;
  return (
    <KPICard
      eyebrow="完成率 · 7-day"
      headline={_fmtPct(rate)}
      gateLine={gate}
    >
      <div style={{
        fontSize: 13,
        color: 'var(--ink-2)',
        marginBottom: 10,
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      }}>
        {days_completed} / {total} 天 落地
      </div>
      <div className="row" style={{ alignItems: 'center' }}>
        {dayChips}
      </div>
    </KPICard>
  );
};

// ---------------------------------------------------------------------------
// 2. Artifact rate card — counter + list of last 3 qualifying artifacts.
// ---------------------------------------------------------------------------
const ArtifactCard = ({ data }) => {
  if (!data) return <KPICard eyebrow="作品产出率" headline="—" />;
  const { rate, artifacts, qualifying_count, total_attempts } = data;
  const recent = (artifacts || []).slice(-3).reverse();
  return (
    <KPICard
      eyebrow="作品产出率 · Level ≥ 3"
      headline={_fmtPct(rate)}
      gateLine={`${qualifying_count} / ${total_attempts} · gate ${GATE_ARTIFACT.toFixed(2)}`}
    >
      {recent.length === 0 && (
        <div style={{
          fontSize: 13, fontStyle: 'italic', color: 'var(--ink-3)',
          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
        }}>
          尚无 applied_task / product_spark / public_output 留痕。
        </div>
      )}
      {recent.length > 0 && (
        <ul style={{
          listStyle: 'none', padding: 0, margin: 0,
          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
        }}>
          {recent.map((a, i) => (
            <li key={i} style={{
              fontSize: 13,
              lineHeight: 1.7,
              color: 'var(--ink-2)',
              borderBottom: i < recent.length - 1 ? '1px solid var(--rule-soft)' : 'none',
              padding: '4px 0',
            }}>
              <span style={{ color: 'var(--ink)' }}>{a.type}</span>
              <span className="mono" style={{ fontSize: 10, marginLeft: 8, color: 'var(--ink-3)' }}>
                {a.source} · {_fmtShortStamp(a.ts)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </KPICard>
  );
};

// ---------------------------------------------------------------------------
// 3. Product Pool conversion card — small funnel rendered as 4 vertical lines.
// ---------------------------------------------------------------------------
const ProductPoolCard = ({ data }) => {
  if (!data) return <KPICard eyebrow="Product Pool 转化" headline="—" />;
  const {
    rate, lesson_count, transfer_triggered_count,
    spark_seed_count, spark_accepted_count, spark_implemented_count,
  } = data;
  const rows = [
    { label: 'lesson',     n: lesson_count },
    { label: 'transfer',   n: transfer_triggered_count },
    { label: 'seed',       n: spark_seed_count },
    { label: 'accepted',   n: spark_accepted_count },
    { label: 'implemented', n: spark_implemented_count },
  ];
  return (
    <KPICard
      eyebrow="Product Pool 转化"
      headline={`${spark_accepted_count}`}
      gateLine={`accepted / lesson = ${_fmtRatio(rate)}`}
    >
      <div className="col" style={{
        gap: 4,
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      }}>
        {rows.map((r, i) => (
          <div key={r.label} className="row" style={{
            alignItems: 'baseline',
            gap: 12,
            fontSize: 13,
            color: 'var(--ink-2)',
          }}>
            <span className="mono" style={{
              width: 88,
              fontSize: 10,
              letterSpacing: '0.08em',
              color: 'var(--ink-3)',
              textTransform: 'uppercase',
            }}>
              {r.label}
            </span>
            <span style={{ color: 'var(--ink)' }}>{r.n}</span>
            {i < rows.length - 1 && (
              <span style={{ color: 'var(--ink-4)', flex: 1, textAlign: 'center' }}>↓</span>
            )}
          </div>
        ))}
      </div>
    </KPICard>
  );
};

// ---------------------------------------------------------------------------
// 4. Companion satisfaction card — score + 3 component stats.
// ---------------------------------------------------------------------------
const CompanionCard = ({ data }) => {
  if (!data) return <KPICard eyebrow="Companion 满意度" headline="—" />;
  const { score, expression_count, dismissed_count, settings_disabled } = data;
  const verdict = settings_disabled
    ? '已关闭 · 视为 -50'
    : (score >= 70 ? '在场陪伴 · 不打扰'
      : (score >= 40 ? '中性' : '低信号 / 高干扰'));
  return (
    <KPICard
      eyebrow="Companion 满意度"
      headline={`${score}`}
      gateLine={verdict}
    >
      <div className="col" style={{
        gap: 6,
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
        fontSize: 13,
        color: 'var(--ink-2)',
      }}>
        <div className="row gap-8">
          <span className="mono" style={{ width: 110, fontSize: 10, letterSpacing: '0.08em', color: 'var(--ink-3)' }}>
            EXPRESSIONS
          </span>
          <span style={{ color: 'var(--ink)' }}>{expression_count}</span>
        </div>
        <div className="row gap-8">
          <span className="mono" style={{ width: 110, fontSize: 10, letterSpacing: '0.08em', color: 'var(--ink-3)' }}>
            DISMISSED
          </span>
          <span style={{ color: 'var(--ink)' }}>{dismissed_count}</span>
        </div>
        <div className="row gap-8">
          <span className="mono" style={{ width: 110, fontSize: 10, letterSpacing: '0.08em', color: 'var(--ink-3)' }}>
            SETTINGS
          </span>
          <span style={{ color: 'var(--ink)' }}>{settings_disabled ? '已关闭' : '在场'}</span>
        </div>
      </div>
    </KPICard>
  );
};

// ---------------------------------------------------------------------------
// 5. Payment willingness card — radio + freetext, only one-shot.
// ---------------------------------------------------------------------------
const PaymentCard = ({ data, slug, completionRate, onSurveyed }) => {
  const initial = (data && data.raw_willing) || '';
  const initialText = (data && data.free_text) || '';
  const [willing, setWilling] = useState(initial);
  const [freeText, setFreeText] = useState(initialText);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setWilling((data && data.raw_willing) || '');
    setFreeText((data && data.free_text) || '');
  }, [data, slug]);

  const eligible = (completionRate || 0) >= GATE_COMPLETION;
  const alreadyAnswered = Boolean(initial);

  const handleSubmit = useCallback(async (val) => {
    if (!slug) return;
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const api = window.ptor && window.ptor.kpi;
      if (!api || typeof api.surveyPayment !== 'function') {
        throw new Error('kpi.surveyPayment IPC unavailable');
      }
      const res = await api.surveyPayment(slug, val, freeText);
      if (!res || res.ok === false) {
        throw new Error((res && res.error) || '调研保存失败');
      }
      setWilling(val);
      if (typeof onSurveyed === 'function') onSurveyed();
    } catch (err) {
      setError((err && err.message) || '调研保存失败');
    } finally {
      setSubmitting(false);
    }
  }, [slug, submitting, freeText, onSurveyed]);

  const options = [
    { value: 'yes',    label: '愿意' },
    { value: 'maybe',  label: '不确定' },
    { value: 'no',     label: '暂不' },
    { value: 'skipped', label: '跳过' },
  ];

  const headline = willing
    ? (willing === 'yes' ? '愿意' : willing === 'no' ? '暂不' : willing === 'maybe' ? '不确定' : '跳过')
    : (eligible ? '请作答' : '7 天后再问');

  return (
    <KPICard
      eyebrow="付费意愿调研"
      headline={headline}
      gateLine={alreadyAnswered ? '已记录 · 不再追问' : null}
    >
      {!eligible && !alreadyAnswered && (
        <div style={{
          fontSize: 13, fontStyle: 'italic', color: 'var(--ink-3)',
          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
        }}>
          完成 7 天主路径后, 这里会出现一次性的 1 句调研。
        </div>
      )}
      {(eligible || alreadyAnswered) && (
        <div className="col" style={{
          gap: 10,
          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
        }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {options.map((opt) => {
              const active = willing === opt.value;
              return (
                <button
                  key={opt.value}
                  onClick={() => handleSubmit(opt.value)}
                  disabled={submitting || alreadyAnswered}
                  style={{
                    padding: '6px 14px',
                    fontSize: 12,
                    fontFamily: 'EB Garamond, "Noto Serif SC", serif',
                    color: active ? 'var(--paper)' : 'var(--ink-2)',
                    background: active ? 'var(--ink-1)' : 'transparent',
                    border: '1px solid ' + (active ? 'var(--ink-1)' : 'var(--rule-soft)'),
                    borderRadius: 2,
                    cursor: alreadyAnswered ? 'default' : (submitting ? 'wait' : 'pointer'),
                    opacity: alreadyAnswered && !active ? 0.4 : 1,
                    letterSpacing: '0.04em',
                  }}>
                  {opt.label}
                </button>
              );
            })}
          </div>
          <textarea
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            // intentional-placeholder: React DOM textarea `placeholder` attribute is
            // load-bearing guidance copy (千金 register), not deferred work.
            placeholder="一句话, 何处值得 / 不值得付费 (可选)"
            disabled={alreadyAnswered}
            maxLength={300}
            rows={2}
            style={{
              width: '100%',
              padding: '8px 10px',
              fontFamily: 'EB Garamond, "Noto Serif SC", serif',
              fontSize: 13,
              color: 'var(--ink)',
              background: alreadyAnswered ? 'rgba(244,239,228,0.6)' : 'var(--paper, #f4efe4)',
              border: '1px solid var(--rule-soft)',
              borderRadius: 2,
              resize: 'vertical',
              lineHeight: 1.55,
            }}
          />
          {error && (
            <div style={{ fontSize: 12, color: '#8B3A3A' }}>{error}</div>
          )}
        </div>
      )}
    </KPICard>
  );
};

// ---------------------------------------------------------------------------
// Overall score strip — bottom-of-page consolidated line.
// ---------------------------------------------------------------------------
const OverallStrip = ({ score, generatedAt }) => (
  <div className="row" style={{
    padding: '20px 36px',
    borderTop: '1px solid var(--rule-soft)',
    alignItems: 'baseline',
    gap: 16,
    fontFamily: 'EB Garamond, "Noto Serif SC", serif',
    background: 'rgba(244,239,228,0.55)',
  }}>
    <span className="mono" style={{
      fontSize: 10,
      letterSpacing: '0.16em',
      textTransform: 'uppercase',
      color: 'var(--ink-3)',
    }}>
      OVERALL · weighted
    </span>
    <span className="serif italic" style={{
      fontSize: 28,
      color: 'var(--ink)',
    }}>
      {Number.isFinite(score) ? score : '—'}
    </span>
    <span style={{ flex: 1 }} />
    <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>
      {generatedAt ? new Date(generatedAt).toLocaleString() : ''}
    </span>
  </div>
);

// ---------------------------------------------------------------------------
// Top bar — slug + 7-day progress line (W4.1 visible re-use). Mirrors the
// spark-pool sticky bar so the surfaces feel of one piece.
// ---------------------------------------------------------------------------
const TopBar = ({ slug, completion, onBack, busy, onRefresh }) => (
  <div className="row gap-16" style={{
    padding: '20px 36px',
    alignItems: 'baseline',
    borderBottom: '1px solid var(--rule-soft)',
    background: 'linear-gradient(180deg, rgba(244,239,228,.92), rgba(244,239,228,.5))',
    position: 'sticky', top: 0, zIndex: 5,
    backdropFilter: 'blur(6px)',
    fontFamily: 'EB Garamond, "Noto Serif SC", serif',
  }}>
    {onBack && (
      <button onClick={onBack} className="btn btn-ghost" style={{ fontSize: 13 }}>
        返回
      </button>
    )}
    <div className="col gap-2" style={{ marginLeft: 6 }}>
      <span className="mono" style={{
        fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.12em',
      }}>
        KPI · {slug || '—'}
      </span>
      <h1 className="serif italic" style={{
        fontSize: 22, margin: 0, fontWeight: 400, color: 'var(--ink)',
      }}>
        Closed Beta · 指标
      </h1>
    </div>
    <span style={{ flex: 1 }} />
    {completion && (
      <span className="mono" style={{
        fontSize: 11, color: 'var(--ink-3)', letterSpacing: '0.04em',
      }}>
        7-DAY · {completion.days_completed} / {completion.total}
      </span>
    )}
    <button
      onClick={onRefresh}
      disabled={busy}
      style={{
        padding: '6px 14px',
        fontSize: 12,
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
        color: 'var(--ink-2)',
        background: 'transparent',
        border: '1px solid var(--rule-soft)',
        borderRadius: 2,
        cursor: busy ? 'wait' : 'pointer',
        letterSpacing: '0.04em',
      }}>
      {busy ? '读取中…' : '刷新'}
    </button>
  </div>
);

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------
const KPIDashboardScreen = ({ slug, onBack }) => {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!slug) return;
    setBusy(true);
    setError(null);
    try {
      const api = window.ptor && window.ptor.kpi;
      if (!api || typeof api.aggregate !== 'function') {
        throw new Error('kpi.aggregate IPC unavailable — preload bridge missing');
      }
      const res = await api.aggregate(slug);
      if (!res || res.ok === false) {
        throw new Error((res && res.error) || 'KPI 聚合失败');
      }
      // Two shapes accepted: bare aggregate object OR { ok, kpi: aggregate }.
      const payload = res.kpi || res;
      setData(payload);
    } catch (err) {
      setError((err && err.message) || 'KPI 聚合失败');
    } finally {
      setBusy(false);
    }
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  // ESC → onBack — mirrors spark-pool conventions. Renderer wraps lessonFullBleed
  // surfaces so this listener is only live while the screen is mounted.
  useEffect(() => {
    if (typeof onBack !== 'function') return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        const tgt = e.target;
        const tag = tgt && tgt.tagName;
        const isEditable = tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || (tgt && tgt.isContentEditable);
        if (!isEditable) onBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  const completionRate = data && data.completion ? data.completion.rate : 0;

  if (!slug) {
    return (
      <div className="col gap-16" style={{
        padding: '60px 60px', maxWidth: 720, margin: '0 auto',
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      }}>
        <h1 className="serif italic" style={{ fontSize: 28, margin: 0, fontWeight: 400 }}>
          KPI
        </h1>
        <p style={{ fontSize: 14, color: 'var(--ink-2)' }}>
          没有 slug — 先在 Home 选一门课程再进 KPI 面板。
        </p>
        {onBack && (
          <button onClick={onBack} className="btn btn-ghost" style={{ fontSize: 13, alignSelf: 'flex-start' }}>
            返回
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="fade-in" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopBar
        slug={slug}
        completion={data && data.completion}
        onBack={onBack}
        busy={busy}
        onRefresh={load}
      />

      {error && (
        <div style={{
          padding: '16px 36px',
          color: '#8B3A3A',
          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
          fontSize: 14,
          borderBottom: '1px solid var(--rule-soft)',
        }}>
          {error}
        </div>
      )}

      <div style={{
        flex: 1,
        padding: '28px 36px 60px',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        gap: 18,
        alignContent: 'start',
      }}>
        <CompletionCard data={data && data.completion} />
        <ArtifactCard data={data && data.artifacts} />
        <ProductPoolCard data={data && data.productPool} />
        <CompanionCard data={data && data.companion} />
        <PaymentCard
          data={data && data.payment}
          slug={slug}
          completionRate={completionRate}
          onSurveyed={load}
        />
      </div>

      <OverallStrip
        score={data && data.overall_score}
        generatedAt={data && data.generated_at}
      />
    </div>
  );
};

window.KPIDashboardScreen = KPIDashboardScreen;
