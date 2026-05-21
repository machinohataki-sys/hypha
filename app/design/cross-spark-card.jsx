/* global React */
//
// HYPHA · Cross-Spark Card (γ14 surface, 2026-05-15)
//
// 课程的"横向回声" — 召唤 3 道跨域共鸣放在 LessonChat footer 区, 让用户看见
// 当前概念在其他 archetype / persona 里被怎么撞击。
//
// β14 后端契约 (同回合 ship, 可能晚到):
//   window.ptor.crossSpark.generateForConcept({ slug, concept, k=3, dryRun })
//     → { ok, sparks:[{
//         source_id, anchor, resonance_claim, surprise_score,
//         source_type:'persona'|'lesson',
//         display_name?, archetype?, slug?
//       }], candidatesUsed, llmAttempts }
//     | { ok:false, error:'NO_LLM_KEY'|'NO_CANDIDATES'|'LLM_PARSE'|'EXCEPTION' }
//
//   window.ptor.crossSpark.listForConcept({ slug, limit=50 })
//     → { ok:true, rows:[{ ts, concept, source_archetype, sparks:[...] }] }
//
// 防御: bridge 不存在 (β14 还在 ship) → "Cross-Spark · 未连接" 灰态, !crash。
//
// Behavior:
//   1. mount → list({slug, limit:1}). 最近 1 行 concept === 当前 concept →
//      直接 render (不再 generate)。
//   2. 否则按钮 "召唤 3 道共鸣" 显式触发 generate(诚实, !自动后台跑 — LLM 花钱)。
//   3. error state UI 显, !silent。NO_LLM_KEY / NO_CANDIDATES 编辑性中文提示。
//
// Register: manuscript — italic Garamond + Noto Serif SC, brass hairlines,
// paper-warm wash, no emoji, no exclamation, no 第三人称。

const { useState, useEffect, useCallback } = React;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ARCHETYPE_LABEL_CN = {
  TECH:        '技术',
  HUMANITIES:  '人文',
  'LANG-ACQ':  '语言',
  MINDSET:     '心法',
  EXAM:        '应试',
  CRAFT:       '手艺',
};

const ERROR_COPY_CN = {
  NO_LLM_KEY:    '尚未配置可调用的模型 — 去 设置 接入一个再试。',
  NO_CANDIDATES: '还没有足够的 persona 蒸馏积累, 共鸣无处对照。先去 persona 蒸馏抓几个再来。',
  LLM_PARSE:     '模型这次返回没读懂, 再试一次通常就好。',
  EXCEPTION:     '召唤出了岔子。检查一下 vault 与桥接, 或再点一次。',
};

// 0.0–1.0 → 1–5 颗 ●
function _surpriseDots(score) {
  const s = typeof score === 'number' && Number.isFinite(score) ? score : 0;
  const clamped = Math.max(0, Math.min(1, s));
  const filled = Math.max(1, Math.min(5, Math.round(clamped * 5)));
  return '●'.repeat(filled) + '○'.repeat(5 - filled);
}

function _sourceLabel(spark) {
  if (!spark || typeof spark !== 'object') return '';
  if (spark.source_type === 'persona') {
    return spark.display_name || spark.source_id || 'persona';
  }
  if (spark.source_type === 'lesson') {
    const slug = spark.slug || '';
    // source_id pattern: "<slug>:lesson-<idx>" — extract idx if shape matches.
    let idx = null;
    if (typeof spark.source_id === 'string') {
      const m = spark.source_id.match(/lesson-(\d+)/);
      if (m) idx = m[1];
    }
    if (slug && idx != null) return `${slug} · lesson-${idx}`;
    if (slug) return slug;
    return spark.source_id || 'lesson';
  }
  return spark.source_id || '';
}

// ---------------------------------------------------------------------------
// SparkRow
// ---------------------------------------------------------------------------

const SparkRow = ({ spark }) => {
  if (!spark || typeof spark !== 'object') return null;
  const archetypeLbl = spark.archetype
    ? (ARCHETYPE_LABEL_CN[spark.archetype] || spark.archetype)
    : null;
  const sourceLbl = _sourceLabel(spark);
  const anchor = typeof spark.anchor === 'string' ? spark.anchor.trim() : '';
  const claim = typeof spark.resonance_claim === 'string' ? spark.resonance_claim.trim() : '';

  return (
    <div style={{
      padding: '12px 0',
      borderBottom: '1px solid var(--rule-soft, #e3dccd)',
      display: 'flex',
      gap: 14,
      alignItems: 'flex-start',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
          fontSize: 10,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--ink-3, #8b8275)',
          marginBottom: 4,
        }}>
          {archetypeLbl ? `${archetypeLbl} · ${sourceLbl}` : sourceLbl}
        </div>
        {anchor && (
          <div style={{
            fontFamily: 'EB Garamond, "Noto Serif SC", serif',
            fontStyle: 'italic',
            fontSize: 16,
            lineHeight: 1.5,
            color: 'var(--ink-1, #2c2620)',
            marginBottom: 4,
          }}>
            {anchor}
          </div>
        )}
        {claim && (
          <div style={{
            fontFamily: '"Noto Serif SC", "EB Garamond", serif',
            fontSize: 13,
            lineHeight: 1.6,
            color: 'var(--ink-2, #5a5246)',
          }}>
            {claim}
          </div>
        )}
      </div>
      <div
        title={`surprise ${(typeof spark.surprise_score === 'number' ? spark.surprise_score.toFixed(2) : '0')}`}
        style={{
          fontFamily: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
          fontSize: 14,
          letterSpacing: '0.04em',
          color: 'var(--accent-brass, #b08a3e)',
          flexShrink: 0,
          paddingTop: 18,
        }}
      >
        {_surpriseDots(spark.surprise_score)}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// CrossSparkCard
// ---------------------------------------------------------------------------

const CrossSparkCard = ({ slug, concept, onClose }) => {
  const [sparks, setSparks] = useState(null);   // null = not yet attempted; [] = empty success
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [bridgeOk, setBridgeOk] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  // γ15 (2026-05-15) — auto-fire surface flag. Flipped on when an inbound
  // `cross-spark:fired` event has re-hydrated this card for the current
  // slug+concept; swaps the manual "召唤 3 道共鸣" CTA copy for a passive
  // "自动召唤 · /finish 时" label. User can still re-summon manually.
  const [autoFired, setAutoFired] = useState(false);

  // Shared hydrate path — used by mount-time bootstrap AND by the auto-fire
  // event listener. Reads the latest jsonl row for {slug} and adopts it when
  // it matches the current {concept}. Returns the row count so callers can
  // decide what to flag.
  const hydrateFromJsonl = useCallback(async () => {
    const cs = window.ptor && window.ptor.crossSpark;
    if (!cs || typeof cs.listForConcept !== 'function') return 0;
    if (!slug) return 0;
    try {
      const r = await cs.listForConcept({ slug, limit: 1 });
      const rows = (r && r.ok && Array.isArray(r.rows)) ? r.rows : [];
      const latest = rows[0];
      if (latest
          && typeof latest.concept === 'string'
          && concept
          && latest.concept.trim() === String(concept).trim()
          && Array.isArray(latest.sparks)
          && latest.sparks.length > 0) {
        setSparks(latest.sparks);
        return latest.sparks.length;
      }
    } catch (_) { /* swallow — caller decides */ }
    return 0;
  }, [slug, concept]);

  // β14 bridge probe + hydrate from list({slug, limit:1}).
  useEffect(() => {
    let alive = true;
    const probe = () => {
      const cs = window.ptor && window.ptor.crossSpark;
      const ok = !!(cs && typeof cs.listForConcept === 'function' && typeof cs.generateForConcept === 'function');
      return { ok, cs };
    };
    const { ok } = probe();
    if (!ok) {
      setBridgeOk(false);
      setHydrated(true);
      return undefined;
    }
    setBridgeOk(true);
    if (!slug) { setHydrated(true); return undefined; }

    (async () => {
      await hydrateFromJsonl();
      if (alive) setHydrated(true);
    })();
    return () => { alive = false; };
  }, [slug, concept, hydrateFromJsonl]);

  // γ15 (2026-05-15) — listen for `cross-spark:fired` dispatched by /finish
  // auto-fire path in screen-lesson-chat.jsx. When the event matches this
  // card's slug+concept, re-hydrate from jsonl (auto-fire just appended a
  // row) and flip autoFired so the header swaps to the passive label.
  useEffect(() => {
    const onFired = (e) => {
      if (!e || !e.detail) return;
      if (e.detail.slug !== slug) return;
      if (String(e.detail.concept || '').trim() !== String(concept || '').trim()) return;
      (async () => {
        const n = await hydrateFromJsonl();
        if (n > 0) setAutoFired(true);
      })();
    };
    window.addEventListener('cross-spark:fired', onFired);
    return () => window.removeEventListener('cross-spark:fired', onFired);
  }, [slug, concept, hydrateFromJsonl]);

  const handleGenerate = useCallback(async () => {
    if (busy) return;
    if (!slug || !concept) {
      setError('EXCEPTION');
      return;
    }
    const cs = window.ptor && window.ptor.crossSpark;
    if (!cs || typeof cs.generate !== 'function') {
      setBridgeOk(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await cs.generateForConcept({ slug, concept, k: 3 });
      if (!r || !r.ok) {
        const code = (r && typeof r.error === 'string') ? r.error : 'EXCEPTION';
        setError(code);
        return;
      }
      const arr = Array.isArray(r.sparks) ? r.sparks : [];
      setSparks(arr);
    } catch (err) {
      setError('EXCEPTION');
    } finally {
      setBusy(false);
    }
  }, [busy, slug, concept]);

  // Render: not-yet-hydrated returns nothing to avoid flicker.
  if (!hydrated) return null;

  return (
    <div
      className="cross-spark-card"
      style={{
        marginTop: 20,
        marginBottom: 18,
        padding: '18px 22px',
        background: 'rgba(244,239,228,0.30)',
        border: '1px solid var(--rule-soft, #e3dccd)',
        fontFamily: '"Noto Serif SC", "EB Garamond", serif',
        color: 'var(--ink-1, #2c2620)',
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        marginBottom: 10,
        paddingBottom: 8,
        borderBottom: '1px solid var(--rule-soft, #e3dccd)',
      }}>
        <div>
          <div style={{
            fontFamily: 'EB Garamond, "Noto Serif SC", serif',
            fontStyle: 'italic',
            fontSize: 17,
            letterSpacing: '0.02em',
            color: 'var(--ink-1, #2c2620)',
          }}>
            Cross-Spark
          </div>
          <div style={{
            fontFamily: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--ink-3, #8b8275)',
            marginTop: 2,
          }}>
            {bridgeOk
              ? (autoFired ? '自动召唤 · /finish 时' : '本课在他处的回声')
              : '未连接'}
          </div>
        </div>
        {typeof onClose === 'function' && (
          <button
            type="button"
            onClick={onClose}
            title="收起"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--ink-3, #8b8275)',
              fontFamily: 'EB Garamond, serif',
              fontStyle: 'italic',
              fontSize: 13,
              cursor: 'pointer',
              padding: '2px 6px',
            }}
          >
            收起
          </button>
        )}
      </div>

      {/* Bridge missing — gray state */}
      {!bridgeOk && (
        <div style={{
          fontFamily: 'EB Garamond, serif',
          fontStyle: 'italic',
          fontSize: 13,
          color: 'var(--ink-3, #8b8275)',
          padding: '8px 0',
        }}>
          后端桥接尚未就绪 — Cross-Spark 通道仍在搭建。稍后此处会自亮。
        </div>
      )}

      {/* Bridge OK — actionable region */}
      {bridgeOk && (
        <>
          {/* Empty + idle (no prior sparks, not busy, no error) → CTA */}
          {sparks === null && !busy && !error && (
            <div style={{ padding: '6px 0 2px' }}>
              <div style={{
                fontFamily: '"Noto Serif SC", "EB Garamond", serif',
                fontSize: 13,
                lineHeight: 1.6,
                color: 'var(--ink-2, #5a5246)',
                marginBottom: 12,
              }}>
                这一课的核心命题, 在其他人 / 其他课里被怎么撞击。点下方按钮唤起 3 道横向共鸣。
              </div>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={!slug || !concept}
                style={{
                  fontFamily: 'EB Garamond, serif',
                  fontStyle: 'italic',
                  fontSize: 13,
                  padding: '7px 18px',
                  background: 'transparent',
                  border: '1px solid var(--accent-brass, #b08a3e)',
                  color: 'var(--accent-brass, #b08a3e)',
                  cursor: (!slug || !concept) ? 'not-allowed' : 'pointer',
                  opacity: (!slug || !concept) ? 0.5 : 1,
                  letterSpacing: '0.02em',
                }}
              >
                召唤 3 道共鸣
              </button>
              {(!slug || !concept) && (
                <div style={{
                  marginTop: 6,
                  fontFamily: 'EB Garamond, serif',
                  fontStyle: 'italic',
                  fontSize: 12,
                  color: 'var(--ink-3, #8b8275)',
                }}>
                  ({!slug ? '尚无 slug' : '尚无 concept'} — 进到具体一课再来。)
                </div>
              )}
            </div>
          )}

          {/* Busy */}
          {busy && (
            <div style={{
              fontFamily: 'EB Garamond, serif',
              fontStyle: 'italic',
              fontSize: 14,
              color: 'var(--ink-2, #5a5246)',
              padding: '10px 0',
            }}>
              正在听其他域的回声…
            </div>
          )}

          {/* Error */}
          {!busy && error && (
            <div style={{ padding: '6px 0' }}>
              <div style={{
                fontFamily: 'EB Garamond, serif',
                fontStyle: 'italic',
                fontSize: 13,
                color: '#8B3A3A',
                marginBottom: 10,
              }}>
                {ERROR_COPY_CN[error] || ERROR_COPY_CN.EXCEPTION}
              </div>
              {error !== 'NO_CANDIDATES' && (
                <button
                  type="button"
                  onClick={handleGenerate}
                  style={{
                    fontFamily: 'EB Garamond, serif',
                    fontStyle: 'italic',
                    fontSize: 13,
                    padding: '6px 16px',
                    background: 'transparent',
                    border: '1px solid var(--ink-2, #5a5246)',
                    color: 'var(--ink-2, #5a5246)',
                    cursor: 'pointer',
                  }}
                >
                  再试一次
                </button>
              )}
            </div>
          )}

          {/* Empty success — no sparks returned despite OK envelope */}
          {!busy && !error && Array.isArray(sparks) && sparks.length === 0 && (
            <div style={{ padding: '6px 0' }}>
              <div style={{
                fontFamily: 'EB Garamond, serif',
                fontStyle: 'italic',
                fontSize: 13,
                color: 'var(--ink-3, #8b8275)',
                marginBottom: 10,
              }}>
                这次没找到合适的横向回声 — 等其他课 / persona 多积累一些, 再来。
              </div>
              <button
                type="button"
                onClick={handleGenerate}
                style={{
                  fontFamily: 'EB Garamond, serif',
                  fontStyle: 'italic',
                  fontSize: 13,
                  padding: '6px 16px',
                  background: 'transparent',
                  border: '1px solid var(--ink-2, #5a5246)',
                  color: 'var(--ink-2, #5a5246)',
                  cursor: 'pointer',
                }}
              >
                再召唤
              </button>
            </div>
          )}

          {/* Sparks */}
          {!busy && !error && Array.isArray(sparks) && sparks.length > 0 && (
            <div>
              {sparks.map((s, i) => (
                <SparkRow key={(s && s.source_id) ? `${s.source_id}-${i}` : `s-${i}`} spark={s} />
              ))}
              <div style={{
                marginTop: 10,
                display: 'flex',
                justifyContent: 'flex-end',
              }}>
                <button
                  type="button"
                  onClick={handleGenerate}
                  title="重新召唤(会再调用一次模型)"
                  style={{
                    fontFamily: 'EB Garamond, serif',
                    fontStyle: 'italic',
                    fontSize: 12,
                    padding: '4px 12px',
                    background: 'transparent',
                    border: '1px solid var(--rule-soft, #e3dccd)',
                    color: 'var(--ink-3, #8b8275)',
                    cursor: 'pointer',
                  }}
                >
                  再召唤
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

if (typeof window !== 'undefined') {
  window.CrossSparkCard = CrossSparkCard;
}
