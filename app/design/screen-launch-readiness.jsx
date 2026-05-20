/* global React */
// HYPHA · W8.1 Launch Readiness — Public Launch pre-flight panel.
//
// Renders the three W8.1 surfaces in a single screen:
//   1. 20-item §20 v2.4 checklist grid (top)
//   2. Cross-W1→W7 integration chain map (middle, lists broken chains)
//   3. Anti-promise self-scan on the locked positioning + free-text scan
//      (bottom)
//
// Register (千金 manuscript, per ptor-design/colors_and_type.css):
//   - EB Garamond italic for h1 + headlines, roman for counters/eyebrows
//   - JetBrains Mono for ratios + small evidence ts only
//   - status dots are character glyphs (●○◐) — no traffic-light colors
//   - 5-card grid, calm spacing, no progress bars / modals / gamification
//   - 失败 surfaces report 灰色斜体 reason line; pass surfaces report nothing
//
// Reads window.ptor.launch.fullReport() once on mount + on "rerun" click.
// All side-effect IPCs are read-only (no writes); the panel is safe to
// open from any context (home / lesson / notebook).
//
// Props: { onBack }

const { useState, useEffect, useCallback } = React;

// ---------------------------------------------------------------------------
// Status glyphs. Per register: dots replace traffic-light colors. ● = full /
// pass, ◐ = partial-ship (lib-only or placeholder), ○ = fail.
// ---------------------------------------------------------------------------

function _statusGlyph(item) {
  if (!item) return '○';
  if (!item.ok) return '○';
  if (item.ship_level === 'F') return '●';
  if (item.ship_level === 'P') return '◐';
  return '◐';
}

function _statusColor(item) {
  if (!item) return 'var(--ink-3)';
  if (!item.ok) return '#8B3A3A';
  if (item.ship_level === 'F') return 'var(--ink)';
  return 'var(--ink-2)';
}

function _fmtShortStamp(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.valueOf())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  } catch (_) { return ''; }
}

// ---------------------------------------------------------------------------
// TopBar — slug-less (W8.1 is app-global, not per-course).
// ---------------------------------------------------------------------------

const TopBar = ({ onBack, busy, onRerun, overallOk, generatedAt }) => (
  <div className="row gap-12" style={{
    alignItems: 'baseline',
    padding: '32px 36px 18px',
    borderBottom: '1px solid var(--rule-soft)',
    fontFamily: 'EB Garamond, "Noto Serif SC", serif',
  }}>
    {onBack && (
      <button onClick={onBack} className="btn btn-ghost" style={{
        fontSize: 13, marginRight: 8, letterSpacing: '0.04em',
      }} title="ESC">
        返回
      </button>
    )}
    <h1 className="serif italic" style={{
      fontSize: 28, margin: 0, fontWeight: 400, color: 'var(--ink)',
    }}>
      Launch Readiness
    </h1>
    <span className="mono" style={{
      fontSize: 10, letterSpacing: '0.16em',
      color: 'var(--ink-3)', marginLeft: 4, textTransform: 'uppercase',
    }}>
      §20 v2.4 · public launch gate
    </span>
    <div style={{ flex: 1 }} />
    <span className="mono" style={{
      fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.06em',
    }}>
      {generatedAt ? _fmtShortStamp(generatedAt) : '—'}
    </span>
    <span style={{
      fontSize: 13, fontStyle: 'italic',
      color: overallOk == null ? 'var(--ink-3)' : (overallOk ? 'var(--ink)' : '#8B3A3A'),
    }}>
      {overallOk == null ? '—' : (overallOk ? 'pass' : 'fail')}
    </span>
    <button onClick={onRerun} disabled={busy} className="btn btn-ghost" style={{
      fontSize: 12, padding: '6px 14px',
      letterSpacing: '0.04em',
      cursor: busy ? 'wait' : 'pointer',
    }}>
      {busy ? '运行中…' : '运行完整 verifier'}
    </button>
  </div>
);

// ---------------------------------------------------------------------------
// Checklist grid — 20 items in a 4-column responsive grid.
// ---------------------------------------------------------------------------

const ChecklistGrid = ({ report }) => {
  if (!report) return null;
  return (
    <section style={{ padding: '24px 36px 8px' }}>
      <div className="mono" style={{
        fontSize: 10, letterSpacing: '0.16em', color: 'var(--ink-3)',
        marginBottom: 6, textTransform: 'uppercase',
      }}>
        §20 v2.4 · 20 必须项
      </div>
      <div style={{
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
        fontSize: 14, color: 'var(--ink-2)', marginBottom: 18,
      }}>
        {report.passed} / {report.total} · {report.pct}%
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: 12,
      }}>
        {report.items.map((it, idx) => (
          <article key={it.id} style={{
            padding: '14px 16px',
            border: '1px solid var(--rule-soft)',
            borderRadius: 3,
            background: 'rgba(244,239,228,0.32)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            minHeight: 88,
          }}>
            <div style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
              fontFamily: 'EB Garamond, "Noto Serif SC", serif',
            }}>
              <span style={{
                fontSize: 16,
                color: _statusColor(it),
                lineHeight: 1,
              }}>
                {_statusGlyph(it)}
              </span>
              <span className="mono" style={{
                fontSize: 10, letterSpacing: '0.06em', color: 'var(--ink-3)',
              }}>
                {String(idx + 1).padStart(2, '0')}
              </span>
              <span style={{
                fontSize: 14, color: 'var(--ink)',
                fontStyle: it.ok ? 'normal' : 'italic',
              }}>
                {it.name}
              </span>
            </div>
            <div className="mono" style={{
              fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.04em',
            }}>
              {it.blueprint_ref} · ship={it.ship_level}
            </div>
            {it.reason && (
              <div style={{
                fontFamily: 'EB Garamond, "Noto Serif SC", serif',
                fontSize: 12,
                color: it.ok ? 'var(--ink-3)' : '#8B3A3A',
                fontStyle: 'italic',
                lineHeight: 1.45,
              }}>
                {it.reason}
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
};

// ---------------------------------------------------------------------------
// Integration chain map — list with evidence + collapsible broken-chain
// section.
// ---------------------------------------------------------------------------

const ChainMap = ({ report }) => {
  if (!report) return null;
  const broken = report.broken_chains || [];
  return (
    <section style={{ padding: '24px 36px 8px', borderTop: '1px solid var(--rule-soft)' }}>
      <div className="mono" style={{
        fontSize: 10, letterSpacing: '0.16em', color: 'var(--ink-3)',
        marginBottom: 6, textTransform: 'uppercase',
      }}>
        Cross-W1→W7 Integration Chains
      </div>
      <div style={{
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
        fontSize: 14, color: 'var(--ink-2)', marginBottom: 14,
      }}>
        {report.chain_count - broken.length} / {report.chain_count} 链路连通
        {broken.length > 0 && ' · ' + broken.length + ' 断'}
      </div>
      <ul style={{
        listStyle: 'none', padding: 0, margin: 0,
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      }}>
        {(report.chains || []).map((c) => (
          <li key={c.chain} style={{
            padding: '10px 0',
            borderBottom: '1px solid var(--rule-soft)',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
          }}>
            <span style={{
              fontSize: 14,
              color: c.ok ? 'var(--ink)' : '#8B3A3A',
              lineHeight: 1.2,
              flexShrink: 0,
            }}>
              {c.ok ? '●' : '○'}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="mono" style={{
                fontSize: 11, color: 'var(--ink-1)', letterSpacing: '0.04em',
              }}>
                {c.chain}
              </div>
              <div style={{
                fontSize: 12,
                color: c.ok ? 'var(--ink-2)' : '#8B3A3A',
                fontStyle: c.ok ? 'normal' : 'italic',
                lineHeight: 1.6,
                marginTop: 2,
              }}>
                {c.evidence}
              </div>
              {!c.ok && c.reason && (
                <div style={{
                  fontSize: 12, color: '#8B3A3A', fontStyle: 'italic', marginTop: 2,
                }}>
                  → {c.reason}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
};

// ---------------------------------------------------------------------------
// Anti-Promise panel — locked positioning + free-text scan area.
// ---------------------------------------------------------------------------

const AntiPromisePanel = ({ positioning, scan, onScan, busy }) => {
  const [draft, setDraft] = useState('');
  const [scanResult, setScanResult] = useState(null);

  const runScan = useCallback(async () => {
    if (typeof onScan !== 'function') return;
    const result = await onScan(draft);
    setScanResult(result);
  }, [onScan, draft]);

  return (
    <section style={{ padding: '24px 36px 60px', borderTop: '1px solid var(--rule-soft)' }}>
      <div className="mono" style={{
        fontSize: 10, letterSpacing: '0.16em', color: 'var(--ink-3)',
        marginBottom: 6, textTransform: 'uppercase',
      }}>
        §20 Anti-Promise Scan
      </div>
      {positioning && (
        <div style={{ marginBottom: 18 }}>
          <div style={{
            fontFamily: 'EB Garamond, "Noto Serif SC", serif',
            fontSize: 13, fontStyle: 'italic', color: 'var(--ink-2)',
            marginBottom: 6,
          }}>
            发布定位 · v2.4 locked
          </div>
          <blockquote style={{
            margin: 0,
            padding: '12px 16px',
            borderLeft: '2px solid var(--brass-bright, #b08440)',
            fontFamily: 'EB Garamond, "Noto Serif SC", serif',
            fontSize: 14, lineHeight: 1.7, color: 'var(--ink)',
            background: 'rgba(244,239,228,0.40)',
          }}>
            {positioning}
          </blockquote>
          {scan && (
            <div style={{
              fontFamily: 'EB Garamond, "Noto Serif SC", serif',
              fontSize: 13, marginTop: 8,
              color: scan.clean ? 'var(--ink-2)' : '#8B3A3A',
              fontStyle: 'italic',
            }}>
              {scan.clean
                ? '定位文本通过 · 0 违项'
                : '定位文本违 §20 · ' + (scan.violations || []).length + ' 违项'}
            </div>
          )}
        </div>
      )}

      <div style={{
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
        fontSize: 13, fontStyle: 'italic', color: 'var(--ink-2)', marginBottom: 6,
      }}>
        自由文本 scan · 用于 W8.4 文案 / Donate 引导 / 发布物料
      </div>
      {/* intentional-placeholder: the `placeholder=` attribute below is the
          HTML textarea hint text the user sees before typing. It is product
          copy, not unfinished implementation. */}
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="粘贴公开文案 / Donate 说明 / 发布 tweet 草稿…"
        rows={5}
        style={{
          width: '100%',
          padding: '10px 12px',
          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
          fontSize: 14, color: 'var(--ink)',
          background: 'rgba(244,239,228,0.40)',
          border: '1px solid var(--rule-soft)',
          borderRadius: 3,
          resize: 'vertical',
          letterSpacing: '0.01em',
        }}
      />
      <div className="row gap-12" style={{ marginTop: 10, alignItems: 'center' }}>
        <button onClick={runScan} disabled={busy || !draft} className="btn btn-ghost" style={{
          fontSize: 12, letterSpacing: '0.04em',
          cursor: (busy || !draft) ? 'not-allowed' : 'pointer',
          opacity: (!draft) ? 0.5 : 1,
        }}>
          运行 anti-promise 扫描
        </button>
        {scanResult && (
          <span style={{
            fontFamily: 'EB Garamond, "Noto Serif SC", serif',
            fontSize: 13,
            color: scanResult.clean ? 'var(--ink-2)' : '#8B3A3A',
            fontStyle: 'italic',
          }}>
            {scanResult.clean
              ? '通过 · 0 违项'
              : '违 ' + (scanResult.high_count || 0) + ' high · ' + (scanResult.medium_count || 0) + ' medium'}
          </span>
        )}
      </div>
      {scanResult && !scanResult.clean && (
        <ul style={{
          listStyle: 'none', padding: 0, margin: '12px 0 0',
          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
        }}>
          {(scanResult.violations || []).map((v) => (
            <li key={v.id} style={{
              padding: '8px 0',
              borderBottom: '1px solid var(--rule-soft)',
            }}>
              <div style={{ fontSize: 13, color: 'var(--ink)' }}>
                <span className="mono" style={{
                  fontSize: 10, marginRight: 8, color: v.severity === 'high' ? '#8B3A3A' : 'var(--ink-3)',
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                }}>
                  {v.severity}
                </span>
                {v.label}
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-3)', fontStyle: 'italic', marginTop: 2 }}>
                {v.reason}
              </div>
              {(v.matches || []).slice(0, 2).map((m, i) => (
                <div key={i} className="mono" style={{
                  fontSize: 11, color: 'var(--ink-2)', marginTop: 2, letterSpacing: '0.02em',
                }}>
                  · {m.snippet}
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

// ---------------------------------------------------------------------------
// Main screen.
// ---------------------------------------------------------------------------

const LaunchReadinessScreen = ({ onBack }) => {
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const api = window.ptor && window.ptor.launch;
      if (!api || typeof api.fullReport !== 'function') {
        throw new Error('launch.fullReport IPC unavailable — preload bridge missing');
      }
      const res = await api.fullReport();
      if (!res || res.ok === false) {
        throw new Error((res && (res.message || res.error)) || 'launch fullReport 失败');
      }
      setReport(res.report || res);
    } catch (err) {
      setError((err && err.message) || 'launch fullReport 失败');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ESC → onBack (mirrors kpi-dashboard / spark-pool convention).
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

  const onAntiPromiseScan = useCallback(async (content) => {
    try {
      const api = window.ptor && window.ptor.launch;
      if (!api || typeof api.antiPromise !== 'function') {
        return { clean: false, error: 'launch.antiPromise IPC unavailable' };
      }
      const res = await api.antiPromise(content);
      return (res && res.scan) || res || { clean: true };
    } catch (err) {
      return { clean: false, error: (err && err.message) || String(err) };
    }
  }, []);

  return (
    <div className="fade-in" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopBar
        onBack={onBack}
        busy={busy}
        onRerun={load}
        overallOk={report ? report.overall_ok : null}
        generatedAt={report && report.generated_at}
      />

      {error && (
        <div style={{
          padding: '16px 36px',
          color: '#8B3A3A',
          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
          fontSize: 14, fontStyle: 'italic',
          borderBottom: '1px solid var(--rule-soft)',
        }}>
          {error}
        </div>
      )}

      <ChecklistGrid report={report && report.checklist} />
      <ChainMap     report={report && report.integration} />
      <AntiPromisePanel
        positioning={report && report.positioning && report.positioning.line}
        scan={report && report.positioning && report.positioning.scan}
        onScan={onAntiPromiseScan}
        busy={busy}
      />
    </div>
  );
};

window.LaunchReadinessScreen = LaunchReadinessScreen;
