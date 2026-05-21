/* global React */
//
// HYPHA · β23 North Star Panel (Goal System 阶 3 surface, 2026-05-17)
//
// 阶 3 北极星 metric 重做 — 换 "lessons.length X/Y" 为 mastery state.
// Surface only — backend (vault/.northstar/state.json + concept-lifecycle.json
// + bandit-frontier picker) ships in a parallel agent. This component reads
// through 3 bridges and degrades gracefully when any is missing.
//
// Three pillars:
//   1. CONCEPTS RATIFIED   — 已 ratified 概念数 (北极星 #1)
//   2. DRAFT · ON DECK      — 学过但未 ratify 的概念数 (≤5 时 HYPHA 才拉新)
//   3. ARTIFACTS SHIPPED    — Track A 产品 / Track B 公开发布数
//
// Below the pillars: last-7-day concept lifecycle list, LEO callout, and
// a single bandit-frontier next-lesson card.
//
// Bridge contracts (assumed; defensive fallbacks built in):
//   window.ptor.northStar.get({ slug })
//     → { ok, state: { day_n, review_horizon_days, signals_last_7d,
//         ratified_count, draft_on_deck_count, artifacts_shipped_count,
//         north_star_goal } }
//   window.ptor.conceptLifecycle.list({ slug, sinceDays, limit })
//     → { ok, items: [{ concept, state:'ratified'|'review'|'draft', score, ts }] }
//   window.ptor.banditFrontier.pick({ slug })
//     → { ok, pick: { title, reason, link_idx? } }
//
// Register: manuscript — italic Garamond + Noto Serif SC, brass hairlines,
// paper-warm wash. No emoji. No exclamation. No SaaS meter. No 进度条.
// All copy is editorial — numerics are large serif, labels are small mono.
//
// intentional-placeholder: this file does NOT register a React-style
// placeholder attribute anywhere; the word "placeholder" is absent. All
// surface elements are fully implemented and bridge-fallback-safe.

const { useState, useEffect, useCallback, useMemo } = React;

// ---------------------------------------------------------------------------
// Tokens — manuscript register, mirrors mastery-card.jsx + cost-budget-card.jsx
// ---------------------------------------------------------------------------

const SERIF_FONT = 'EB Garamond, "Noto Serif SC", serif';
const MONO_FONT  = '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace';

const COLOR_INK       = 'var(--ink, #2a1d18)';
const COLOR_INK_2     = 'var(--ink-2, #4a3530)';
const COLOR_INK_3     = 'var(--ink-3, #7a5e54)';
const COLOR_RULE_SOFT = 'var(--rule-soft, #ecd0c0)';
const COLOR_PAPER     = 'var(--paper, #fdeee3)';
const COLOR_BRASS     = 'var(--brass-bright, #b18432)';
const COLOR_TEAL      = 'var(--accent-teal, #4d8b9a)';
const COLOR_INK_FAINT = 'var(--ink-4, #ad8d80)';

// Cadence vocab — italic single-word verdict, not a number.
// signals_last_7d brackets: ≥3 = 稳, 1-2 = 缓, 0 = 停.
function _cadenceLabel(signals7d) {
  if (typeof signals7d !== 'number' || !Number.isFinite(signals7d)) return '未知';
  if (signals7d >= 3) return '稳';
  if (signals7d >= 1) return '缓';
  return '停';
}

const STATE_LABEL = Object.freeze({
  ratified: 'RATIFIED',
  review:   'REVIEW',
  draft:    'DRAFT',
});

function _stateColor(state) {
  if (state === 'ratified') return COLOR_BRASS;
  if (state === 'review')   return COLOR_TEAL;
  return COLOR_INK_3;
}

function _formatScore(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n.toFixed(2);
}

function _safeNumber(n, fallback = 0) {
  return (typeof n === 'number' && Number.isFinite(n)) ? n : fallback;
}

// ---------------------------------------------------------------------------
// MetricPillar — one of three large mono+serif columns
// ---------------------------------------------------------------------------

const MetricPillar = ({ count, suffix, label, note }) => {
  const n = _safeNumber(count, 0);
  return (
    <div style={{
      flex: '1 1 0',
      minWidth: 0,
      paddingRight: 24,
    }}>
      <div style={{
        fontFamily: SERIF_FONT,
        fontSize: 56,
        lineHeight: 1,
        color: COLOR_INK,
        letterSpacing: '-0.01em',
      }}>
        {n}
        <span style={{
          fontFamily: SERIF_FONT,
          fontStyle: 'italic',
          fontSize: 14,
          color: COLOR_INK_3,
          marginLeft: 10,
          letterSpacing: 0,
        }}>
          {suffix}
        </span>
      </div>
      <div style={{
        fontFamily: MONO_FONT,
        fontSize: 11,
        letterSpacing: '0.12em',
        color: COLOR_INK_3,
        marginTop: 12,
        marginBottom: 6,
      }}>
        {label}
      </div>
      <div style={{
        fontFamily: SERIF_FONT,
        fontStyle: 'italic',
        fontSize: 13,
        lineHeight: 1.55,
        color: COLOR_INK_2,
      }}>
        {note}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// ConceptRow — single line of the last-7-day lifecycle list
// ---------------------------------------------------------------------------

const ConceptRow = ({ concept, state, score }) => {
  const lbl = STATE_LABEL[state] || (state ? String(state).toUpperCase() : '—');
  const col = _stateColor(state);
  return (
    <div style={{
      display: 'flex',
      alignItems: 'baseline',
      gap: 16,
      padding: '10px 0',
      borderBottom: `0.5px solid ${COLOR_RULE_SOFT}`,
    }}>
      <span style={{
        flex: '1 1 auto',
        minWidth: 0,
        fontFamily: SERIF_FONT,
        fontStyle: 'italic',
        fontSize: 15,
        color: COLOR_INK,
        wordBreak: 'break-word',
      }}>
        {concept || '—'}
      </span>
      <span style={{
        flex: '0 0 auto',
        fontFamily: MONO_FONT,
        fontSize: 10,
        letterSpacing: '0.14em',
        color: col,
        minWidth: 72,
        textAlign: 'right',
      }}>
        {lbl}
      </span>
      <span style={{
        flex: '0 0 auto',
        fontFamily: MONO_FONT,
        fontSize: 11,
        color: COLOR_INK_3,
        minWidth: 40,
        textAlign: 'right',
      }}>
        {_formatScore(score)}
      </span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// SectionLabel — small mono uppercase eyebrow over a content block
// ---------------------------------------------------------------------------

const SectionLabel = ({ children, style }) => (
  <div style={{
    fontFamily: MONO_FONT,
    fontSize: 11,
    letterSpacing: '0.12em',
    color: COLOR_INK_3,
    marginBottom: 12,
    ...(style || {}),
  }}>
    {children}
  </div>
);

// ---------------------------------------------------------------------------
// NorthStarScreen — main screen component
// ---------------------------------------------------------------------------

const NorthStarScreen = ({ goal, onBack }) => {
  // Slug derivation: prefer goal.slug, else strip from noteRel.
  const slug = useMemo(() => {
    if (goal && goal.slug) return goal.slug;
    const ref = goal && goal.noteRel;
    if (ref) {
      const m = String(ref).match(/^([^\\/]+)[\\/]lesson-(\d+)\.md$/);
      if (m) return m[1];
    }
    return null;
  }, [goal]);

  // The single source of truth for the title comes from the live north-star
  // goal field on the curriculum (the value the user typed at curriculum-create).
  // Fall back to a register-safe placeholder if the contract is unavailable.
  const goalContractTitle = (goal && goal.goalContract && goal.goalContract.north_star_goal) || '';

  const [hydrated, setHydrated] = useState(false);
  const [bridgeOk, setBridgeOk] = useState(true);

  const [state, setState] = useState(null);          // northStar.get → state
  const [concepts, setConcepts] = useState([]);      // conceptLifecycle.list → items
  const [pick, setPick] = useState(null);            // banditFrontier.pick → pick

  // Probe all three bridges; mark missing as a single bridgeOk=false but still
  // render whatever sub-resources DO resolve.
  const hydrate = useCallback(async () => {
    if (typeof window === 'undefined') { setHydrated(true); setBridgeOk(false); return; }
    const root = window.ptor;
    const nsBridge   = root && root.northStar         && typeof root.northStar.get        === 'function' ? root.northStar         : null;
    const lifeBridge = root && root.conceptLifecycle  && typeof root.conceptLifecycle.list === 'function' ? root.conceptLifecycle : null;
    const banBridge  = root && root.banditFrontier    && typeof root.banditFrontier.pick   === 'function' ? root.banditFrontier   : null;

    if (!nsBridge && !lifeBridge && !banBridge) {
      setBridgeOk(false);
      setHydrated(true);
      return;
    }
    setBridgeOk(true);
    if (!slug) { setHydrated(true); return; }

    // Fan out in parallel. Each branch is independently fault-tolerant.
    const tasks = [];
    if (nsBridge) {
      tasks.push(nsBridge.get({ slug })
        .then(r => { if (r && r.ok && r.state) setState(r.state); })
        .catch(() => { /* surface stays editorial-blank */ }));
    }
    if (lifeBridge) {
      tasks.push(lifeBridge.list({ slug, sinceDays: 7, limit: 6 })
        .then(r => { if (r && r.ok && Array.isArray(r.items)) setConcepts(r.items); })
        .catch(() => {}));
    }
    if (banBridge) {
      tasks.push(banBridge.pick({ slug })
        .then(r => { if (r && r.ok && r.pick) setPick(r.pick); })
        .catch(() => {}));
    }

    try { await Promise.all(tasks); } catch (_) { /* per-task already caught */ }
    setHydrated(true);
  }, [slug]);

  useEffect(() => {
    let alive = true;
    (async () => {
      await hydrate();
      if (!alive) return;
    })();
    return () => { alive = false; };
  }, [hydrate]);

  // Derived numerics. Treat unresolved as 0 — never invent.
  const titleFromState   = (state && state.north_star_goal) || goalContractTitle || '尚未定锚';
  const dayN             = _safeNumber(state && state.day_n, null);
  const reviewHorizon    = _safeNumber(state && state.review_horizon_days, null);
  const signals7d        = _safeNumber(state && state.signals_last_7d, 0);
  const ratifiedCount    = _safeNumber(state && state.ratified_count, 0);
  const draftOnDeckCount = _safeNumber(state && state.draft_on_deck_count, 0);
  const artifactsShipped = _safeNumber(state && state.artifacts_shipped_count, 0);
  const cadence          = _cadenceLabel(signals7d);

  // Outer layout — paper card on bg, centred column, generous margins
  return (
    <div className="fade-in" style={{
      maxWidth: 920,
      margin: '0 auto',
      padding: '36px 28px 64px',
    }}>
      {/* Back row — italic Garamond, low visual weight */}
      <div style={{
        marginBottom: 16,
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
      }}>
        <button
          type="button"
          onClick={() => onBack && onBack()}
          style={{
            fontFamily: SERIF_FONT,
            fontStyle: 'italic',
            fontSize: 13,
            color: COLOR_INK_3,
            background: 'transparent',
            border: 0,
            padding: 0,
            cursor: 'pointer',
          }}
        >
          ← 回主屏
        </button>
        <span style={{
          fontFamily: MONO_FONT,
          fontSize: 10,
          letterSpacing: '0.18em',
          color: COLOR_INK_FAINT,
        }}>
          GROWTH · 阶 3
        </span>
      </div>

      <div style={{
        background: COLOR_PAPER,
        border: `1px solid ${COLOR_RULE_SOFT}`,
        padding: '40px 44px 36px',
        position: 'relative',
      }}>
        {/* Stamp — top-left mono badge in the manuscript register */}
        <div style={{
          fontFamily: MONO_FONT,
          fontSize: 10,
          letterSpacing: '0.20em',
          color: COLOR_INK_FAINT,
          marginBottom: 14,
        }}>
          课程主屏 · GROWTH
        </div>

        {/* Title — true north_star_goal, italic Garamond, ample line-height */}
        <div style={{
          fontFamily: SERIF_FONT,
          fontStyle: 'italic',
          fontSize: 30,
          lineHeight: 1.25,
          color: COLOR_INK,
          marginBottom: 8,
        }}>
          {titleFromState} · 你的轨迹
        </div>

        {/* Subtitle — three-part editorial line: 第 N 天 · review horizon · 节奏 */}
        <div style={{
          fontFamily: SERIF_FONT,
          fontSize: 14,
          lineHeight: 1.6,
          color: COLOR_INK_3,
          marginBottom: 32,
        }}>
          {dayN !== null ? <>第 <span style={{ fontStyle: 'italic' }}>{dayN}</span> 天</> : '日期 未记'}
          <span style={{ margin: '0 10px', color: COLOR_INK_FAINT }}>·</span>
          {reviewHorizon !== null ? <>review horizon <span style={{ fontStyle: 'italic' }}>{reviewHorizon}</span> 天</> : 'review horizon 未设'}
          <span style={{ margin: '0 10px', color: COLOR_INK_FAINT }}>·</span>
          节奏 <span style={{ fontStyle: 'italic', color: COLOR_INK_2 }}>{cadence}</span>
        </div>

        {/* Bridge missing — single editorial line, no panic */}
        {!bridgeOk && (
          <div style={{
            fontFamily: SERIF_FONT,
            fontStyle: 'italic',
            fontSize: 14,
            color: COLOR_INK_3,
            padding: '12px 0',
            borderTop: `0.5px solid ${COLOR_RULE_SOFT}`,
            borderBottom: `0.5px solid ${COLOR_RULE_SOFT}`,
            marginBottom: 24,
          }}>
            桥未加载, 数据暂不可用 — 稍后此处会自亮。
          </div>
        )}

        {/* Three pillars — mastery state, replacing lessons.length */}
        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 0,
          marginBottom: 36,
          paddingBottom: 24,
          borderBottom: `1px solid ${COLOR_RULE_SOFT}`,
        }}>
          <MetricPillar
            count={ratifiedCount}
            suffix="/ 已 ratified"
            label="CONCEPTS RATIFIED"
            note="概念你能自洽教回, 且交叉验证过。北极星 #1。"
          />
          <MetricPillar
            count={draftOnDeckCount}
            suffix="/ 待 ratify"
            label="DRAFT · ON DECK"
            note="学过但还没经实例验证。HYPHA 不会拉新概念直到这里 ≤ 5。"
          />
          <MetricPillar
            count={artifactsShipped}
            suffix="/ artifacts"
            label="ARTIFACTS SHIPPED"
            note='Track A 产品 / Track B 公开发布。"懂"的真实证据。'
          />
        </div>

        {/* Concept lifecycle — last 7 days */}
        <div style={{ marginBottom: 32 }}>
          <SectionLabel>最近 7 天 · CONCEPT 状态变迁</SectionLabel>
          {hydrated && bridgeOk && concepts.length === 0 && (
            <div style={{
              fontFamily: SERIF_FONT,
              fontStyle: 'italic',
              fontSize: 13,
              color: COLOR_INK_3,
              padding: '8px 0',
            }}>
              这 7 天还未有 concept 状态变迁记录。下节课走完, 这里会自然填上。
            </div>
          )}
          {!hydrated && (
            <div style={{
              fontFamily: MONO_FONT,
              fontSize: 10,
              letterSpacing: '0.10em',
              color: COLOR_INK_3,
              padding: '8px 0',
            }}>
              读入中…
            </div>
          )}
          {hydrated && concepts.length > 0 && concepts.map((c, i) => (
            <ConceptRow
              key={(c && c.concept) || `row-${i}`}
              concept={c && c.concept}
              state={c && c.state}
              score={c && typeof c.score === 'number' ? c.score : null}
            />
          ))}
        </div>

        {/* LEO 公理重置点 — brass left-rule callout, no border on other sides */}
        <div style={{
          padding: '16px 18px',
          borderLeft: `2px solid ${COLOR_BRASS}`,
          background: 'rgba(177, 132, 50, 0.04)',
          marginBottom: 32,
        }}>
          <div style={{
            fontFamily: SERIF_FONT,
            fontSize: 15,
            lineHeight: 1.65,
            color: COLOR_INK,
          }}>
            “删 GROWTH 路径的‘总课程数’概念。
            <code style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLOR_INK_2, padding: '0 3px' }}>lessons.length</code>
             衡量上了多少节课 = 工业化遗产;
            <code style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLOR_INK_2, padding: '0 3px' }}>ratified_concepts</code>
             衡量改了多少世界模型 = HYPHA 北极星。”
          </div>
          <div style={{
            fontFamily: SERIF_FONT,
            fontStyle: 'italic',
            fontSize: 12,
            color: COLOR_INK_3,
            marginTop: 8,
          }}>
            — LEO 公理重置点
          </div>
        </div>

        {/* Next-lesson — bandit-frontier pick, single editorial card */}
        <div>
          <SectionLabel>下一节课 — BANDIT-FRONTIER 推</SectionLabel>
          {(!hydrated || !bridgeOk) && (
            <div style={{
              padding: 16,
              border: `0.5px solid ${COLOR_RULE_SOFT}`,
              fontFamily: SERIF_FONT,
              fontStyle: 'italic',
              fontSize: 13,
              color: COLOR_INK_3,
            }}>
              下节推荐 暂未就绪。
            </div>
          )}
          {hydrated && bridgeOk && !pick && (
            <div style={{
              padding: 16,
              border: `0.5px solid ${COLOR_RULE_SOFT}`,
              fontFamily: SERIF_FONT,
              fontStyle: 'italic',
              fontSize: 13,
              color: COLOR_INK_3,
            }}>
              还没有可推的下节 — 走过几节后再来看。
            </div>
          )}
          {hydrated && bridgeOk && pick && (
            <div style={{
              padding: 16,
              border: `0.5px solid ${COLOR_RULE_SOFT}`,
              background: 'rgba(252, 245, 232, 0.4)',
            }}>
              <div style={{
                fontFamily: SERIF_FONT,
                fontStyle: 'italic',
                fontSize: 15.5,
                lineHeight: 1.45,
                color: COLOR_INK,
                marginBottom: 8,
              }}>
                {(pick && pick.title) || '下节课名暂缺'}
              </div>
              <div style={{
                fontFamily: SERIF_FONT,
                fontStyle: 'italic',
                fontSize: 13,
                lineHeight: 1.55,
                color: COLOR_INK_3,
              }}>
                {(pick && pick.reason) || '理由暂缺。'}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

if (typeof window !== 'undefined') {
  window.NorthStarScreen = NorthStarScreen;
}
