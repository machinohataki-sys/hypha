/* global React */
//
// HYPHA · Decision Ledger Card (v0.3 Creation System surface, 2026-05-14)
//
// Mounts inside the lesson screen below the post-session audit card. Reads
// the per-curriculum decision + assumption logs maintained by the Creation
// System (Machino-α backend: window.ptor.creation.decisionList /
// assumptionList; Machino-β /finish extractor emits decisions-extracted).
//
// Surface contract:
//   - Renders only when at least one decision OR assumption exists for slug
//   - Manuscript register: italic EB Garamond + Noto Serif SC on cream paper,
//     brass hairline rules, no emoji, no exclamation, no marketing slang
//   - Time stamps demoted to roman small caps on the right
//   - Decisions lead with italic "决定" headline; assumptions prefix with
//     "假设:" in tabac brown italic
//   - All text renders through React text nodes (no dangerouslySetInnerHTML);
//     row keys derive from ts so re-render is stable across refresh
//
// refreshTrigger contract:
//   - Bump from parent after /finish (Machino-β fires decisions-extracted
//     post-extraction). When the renderer-side event subscription is wired
//     into preload.js, this card can also self-subscribe; until then the
//     parent's finishCount bump is the canonical refresh path.

const DECISION_PALETTE = {
  ink:      '#2A1F12',  // 墨水
  tabac:    '#5C4E36',  // 棕褐
  brass:    '#B8A372',  // 黄铜分割线
  cream:    '#F4EBD9',  // 奶油背景
  oxblood:  '#6E2D2D',  // 临近警告 (非 red)
  faded:    '#8A7F6E',  // 过期已结案
};

// Pull context / rationale fragments off a row defensively. Machino-α may
// or may not surface these on the decision shape — when absent we render
// nothing rather than synthesizing a fallback string.
function _decisionContext(d) {
  if (!d || typeof d !== 'object') return '';
  if (typeof d.context === 'string' && d.context.trim()) return d.context.trim();
  return '';
}

function _decisionRationale(d) {
  if (!d || typeof d !== 'object') return '';
  if (typeof d.rationale === 'string' && d.rationale.trim()) return d.rationale.trim();
  return '';
}

// Defensive prediction extractor. Returns null when the row carries no
// prediction or the shape is malformed — caller's null-check then skips
// the block entirely (silent compat with v0.3 pre-prediction rows).
function _predictionMeta(row) {
  if (!row || typeof row !== 'object') return null;
  const p = row.prediction;
  if (!p || typeof p !== 'object') return null;
  const claim = typeof p.claim === 'string' && p.claim.trim() ? p.claim.trim() : '';
  const falsifier = typeof p.falsifier === 'string' && p.falsifier.trim() ? p.falsifier.trim() : '';
  const deadline = typeof p.deadline_iso === 'string' && p.deadline_iso.trim() ? p.deadline_iso.trim() : '';
  if (!claim && !falsifier && !deadline) return null;
  return { claim, falsifier, deadline };
}

// Compute deadline display + register color. daysUntil > 7 = tabac (calm);
// 0 < daysUntil ≤ 7 = oxblood italic (临近); daysUntil ≤ 0 = faded gray +
// line-through marker (留痕, 不删). Bad ISO returns null so caller skips
// the deadline line without breaking the block.
function _formatDeadline(deadlineIso) {
  if (!deadlineIso) return null;
  const d = new Date(deadlineIso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const daysUntil = Math.floor((d.getTime() - now.getTime()) / 86400000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const datePart = `${yyyy}-${mm}-${dd}`;
  let phrase;
  let color;
  let italic = false;
  let strike = false;
  if (daysUntil > 7) {
    phrase = `还有 ${daysUntil} 天`;
    color = '#5C4E36';
  } else if (daysUntil > 0) {
    phrase = `还有 ${daysUntil} 天`;
    color = '#6E2D2D';
    italic = true;
  } else if (daysUntil === 0) {
    phrase = '今日截止';
    color = '#6E2D2D';
    italic = true;
  } else {
    phrase = `已过 ${Math.abs(daysUntil)} 天`;
    color = '#8A7F6E';
    strike = true;
  }
  return { text: `${datePart} · ${phrase}`, color, italic, strike, daysUntil };
}

// Auto-killed marker detector. kill-watcher (Machino-β3) may attach
// `_meta.auto_killed_at` (or similar marker fields) when a row was
// transitioned by automated patrol. Silent absence = no marker.
function _autoKilledMarker(row) {
  if (!row || typeof row !== 'object') return false;
  const meta = row._meta;
  if (!meta || typeof meta !== 'object') return false;
  if (typeof meta.auto_killed_at === 'string' && meta.auto_killed_at.trim()) return true;
  if (meta.auto_killed === true) return true;
  return false;
}

// Prediction block renderer — used by both Decision + Assumption rows.
// `hideClaim` collapses the "预测:" line for assumption rows where
// prediction.claim overlaps row.claim (avoid redundancy per spec).
const PredictionBlock = ({ prediction, hideClaim, claimLabel, falsifierLabel, deadlineLabel }) => {
  if (!prediction) return null;
  const { claim, falsifier, deadline } = prediction;
  const deadlineMeta = _formatDeadline(deadline);
  const expired = deadlineMeta && deadlineMeta.strike;
  const baseFont = '"EB Garamond", "Noto Serif SC", serif';
  const blockStyle = {
    marginTop: 8,
    paddingTop: 8,
    paddingLeft: 12,
    borderLeft: `2px solid ${DECISION_PALETTE.brass}60`,
    opacity: expired ? 0.7 : 1,
    textDecoration: expired ? 'line-through' : 'none',
    textDecorationColor: expired ? DECISION_PALETTE.faded : undefined,
  };
  return (
    <div className="prediction-block" style={blockStyle}>
      {!hideClaim && claim ? (
        <div
          style={{
            fontFamily: baseFont,
            fontStyle: 'italic',
            fontSize: 13,
            lineHeight: 1.65,
            color: DECISION_PALETTE.ink,
            marginBottom: 4,
          }}
        >
          <span style={{ color: DECISION_PALETTE.tabac, marginRight: 6 }}>{claimLabel}</span>
          <span>{claim}</span>
        </div>
      ) : null}
      {falsifier ? (
        <div
          style={{
            fontFamily: baseFont,
            fontStyle: 'italic',
            fontSize: 11,
            lineHeight: 1.6,
            color: DECISION_PALETTE.tabac,
            marginBottom: 4,
          }}
        >
          <span style={{ marginRight: 6 }}>{falsifierLabel}</span>
          <span>{falsifier}</span>
        </div>
      ) : null}
      {deadlineMeta ? (
        <div
          style={{
            fontFamily: baseFont,
            fontStyle: deadlineMeta.italic ? 'italic' : 'normal',
            fontSize: 9,
            letterSpacing: '0.04em',
            color: deadlineMeta.color,
            lineHeight: 1.55,
          }}
        >
          <span style={{ marginRight: 6 }}>{deadlineLabel}</span>
          <span>{deadlineMeta.text}</span>
        </div>
      ) : null}
    </div>
  );
};

const AutoKilledHint = ({ visible }) => {
  if (!visible) return null;
  return (
    <span
      style={{
        fontFamily: '"EB Garamond", "Noto Serif SC", serif',
        fontStyle: 'italic',
        fontSize: 9,
        letterSpacing: '0.04em',
        color: DECISION_PALETTE.tabac,
        marginLeft: 6,
      }}
    >
      (自动)
    </span>
  );
};

// Compact ts formatter — "MM-DD HH:mm" in roman 8.5pt. Defensive: bad input
// returns empty string so the row still renders without breaking layout.
function _formatTs(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
  } catch (_) { return ''; }
}

// Pull a display text out of a decision row regardless of upstream shape.
// Machino-α has not locked the field name; we accept the most likely keys
// without falling through to JSON.stringify (which would surface raw braces
// into the manuscript register — a register violation).
function _decisionText(d) {
  if (!d || typeof d !== 'object') return '';
  if (typeof d.decision === 'string' && d.decision.trim()) return d.decision.trim();
  if (typeof d.text === 'string' && d.text.trim()) return d.text.trim();
  if (typeof d.statement === 'string' && d.statement.trim()) return d.statement.trim();
  if (typeof d.summary === 'string' && d.summary.trim()) return d.summary.trim();
  return '';
}

function _assumptionText(a) {
  if (!a || typeof a !== 'object') return '';
  if (typeof a.assumption === 'string' && a.assumption.trim()) return a.assumption.trim();
  if (typeof a.claim === 'string' && a.claim.trim()) return a.claim.trim();
  if (typeof a.text === 'string' && a.text.trim()) return a.text.trim();
  if (typeof a.statement === 'string' && a.statement.trim()) return a.statement.trim();
  return '';
}

const DecisionRow = ({ row }) => {
  const text = _decisionText(row);
  if (!text) return null;
  const ts = _formatTs(row && row.ts);
  const context = _decisionContext(row);
  const rationale = _decisionRationale(row);
  const prediction = _predictionMeta(row);
  const autoKilled = _autoKilledMarker(row);
  return (
    <div
      className="ledger-row"
      style={{
        padding: '10px 0',
        borderBottom: `1px solid ${DECISION_PALETTE.brass}40`,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 16,
        }}
      >
        <div
          style={{
            flex: '1 1 auto',
            fontFamily: '"EB Garamond", "Noto Serif SC", serif',
            fontStyle: 'italic',
            fontSize: 15.5,
            lineHeight: 1.7,
            color: DECISION_PALETTE.ink,
          }}
        >
          {text}
          <AutoKilledHint visible={autoKilled} />
        </div>
        {ts ? (
          <div
            style={{
              flex: '0 0 auto',
              fontFamily: '"EB Garamond", "Noto Serif SC", serif',
              fontStyle: 'normal',
              fontSize: 8.5,
              letterSpacing: '0.06em',
              color: DECISION_PALETTE.tabac,
              whiteSpace: 'nowrap',
            }}
          >
            {ts}
          </div>
        ) : null}
      </div>
      {context ? (
        <div
          style={{
            fontFamily: '"EB Garamond", "Noto Serif SC", serif',
            fontStyle: 'normal',
            fontSize: 11,
            lineHeight: 1.6,
            color: DECISION_PALETTE.tabac,
            marginTop: 4,
          }}
        >
          <span style={{ fontStyle: 'italic', marginRight: 6 }}>背景:</span>
          <span>{context}</span>
        </div>
      ) : null}
      {rationale ? (
        <div
          style={{
            fontFamily: '"EB Garamond", "Noto Serif SC", serif',
            fontStyle: 'normal',
            fontSize: 11,
            lineHeight: 1.6,
            color: DECISION_PALETTE.tabac,
            marginTop: 4,
          }}
        >
          <span style={{ fontStyle: 'italic', marginRight: 6 }}>缘由:</span>
          <span>{rationale}</span>
        </div>
      ) : null}
      <PredictionBlock
        prediction={prediction}
        hideClaim={false}
        claimLabel="预测:"
        falsifierLabel="证伪:"
        deadlineLabel="复查截止:"
      />
    </div>
  );
};

const AssumptionRow = ({ row }) => {
  const text = _assumptionText(row);
  if (!text) return null;
  const ts = _formatTs(row && row.ts);
  const prediction = _predictionMeta(row);
  const autoKilled = _autoKilledMarker(row);
  // If prediction.claim overlaps assumption row text, suppress the
  // duplicated claim line (only show falsifier + deadline).
  const claimOverlap = !!(prediction && prediction.claim && prediction.claim === text);
  return (
    <div
      className="ledger-row"
      style={{
        padding: '10px 0',
        borderBottom: `1px solid ${DECISION_PALETTE.brass}40`,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 16,
        }}
      >
        <div
          style={{
            flex: '1 1 auto',
            fontFamily: '"EB Garamond", "Noto Serif SC", serif',
            fontSize: 13.5,
            lineHeight: 1.7,
            color: DECISION_PALETTE.ink,
          }}
        >
          <span
            style={{
              fontStyle: 'italic',
              color: DECISION_PALETTE.tabac,
              marginRight: 6,
            }}
          >
            假设:
          </span>
          <span>{text}</span>
          <AutoKilledHint visible={autoKilled} />
        </div>
        {ts ? (
          <div
            style={{
              flex: '0 0 auto',
              fontFamily: '"EB Garamond", "Noto Serif SC", serif',
              fontStyle: 'normal',
              fontSize: 8.5,
              letterSpacing: '0.06em',
              color: DECISION_PALETTE.tabac,
              whiteSpace: 'nowrap',
            }}
          >
            {ts}
          </div>
        ) : null}
      </div>
      <PredictionBlock
        prediction={prediction}
        hideClaim={claimOverlap}
        claimLabel="预测:"
        falsifierLabel="证伪:"
        deadlineLabel="复查截止:"
      />
    </div>
  );
};

// Machino-β6 (2026-05-14) — skip reason 中文化. Maps the `skipped` field
// emitted by main.js `creation:decisions-extracted` event into a readable
// editorial sentence. Returns '' for unknown codes so caller can fall
// through to a generic phrase (defensive against future code additions
// in main.js without simultaneous renderer update).
function _skipReasonZh(code) {
  if (typeof code !== 'string' || !code.trim()) return '';
  switch (code) {
    case 'too-short':
      return '对话太短(< 800 字),没抽到决策或假设';
    case 'llm-error':
      return '模型调用失败 — 看 events.jsonl 找 decisions_extracted 行的 error 字段';
    case 'no-extracts':
      return '对话里没出现可抽取的决策/假设(都是被动接受,没有学习者主动判断)';
    case 'no-slug':
      return '课程 slug 缺失,系统跳过';
    default:
      return '';
  }
}

// Skipped hint card — small editorial register-faithful surface that
// surfaces an empty-result reason from /finish so an empty ledger does
// not silently read as "no learning happened". Padding intentionally
// half of the data card (12 vs 24) to read as a margin note, not a
// primary band.
const SkippedHint = ({ reason, label }) => {
  const zh = _skipReasonZh(reason);
  return (
    <div
      className="decision-ledger-skipped"
      style={{
        marginTop: 20,
        padding: 12,
        background: DECISION_PALETTE.cream,
        borderTop: `1px solid ${DECISION_PALETTE.brass}`,
        borderBottom: `1px solid ${DECISION_PALETTE.brass}`,
        fontFamily: '"EB Garamond", "Noto Serif SC", serif',
        lineHeight: 1.7,
      }}
    >
      <div
        style={{
          fontStyle: 'italic',
          fontSize: 11,
          letterSpacing: '0.04em',
          color: DECISION_PALETTE.tabac,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontStyle: 'normal',
          fontSize: 10,
          lineHeight: 1.65,
          color: DECISION_PALETTE.ink,
        }}
      >
        {zh || reason}
      </div>
    </div>
  );
};

const DecisionLedgerCard = ({ slug, refreshTrigger }) => {
  const { useState, useEffect } = React;
  const [decisions, setDecisions] = useState([]);
  const [assumptions, setAssumptions] = useState([]);
  const [loading, setLoading] = useState(true);
  // Machino-α5 (2026-05-14) — bumped by main-process events when the
  // extractor or kill-watcher writes new rows. Replaces the finishCount
  // time-race path (which ran while LLM async-extract was still mid-write).
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Machino-β6 (2026-05-14) — last skipped reason from the most recent
  // matching `creation:decisions-extracted` event. Null when the last
  // extract succeeded (or no event has fired yet). Drives the empty-
  // state hint card so users see why the ledger is empty.
  const [lastSkipped, setLastSkipped] = useState(null);

  useEffect(() => {
    if (!slug) { setLoading(false); return undefined; }
    let mounted = true;
    (async () => {
      try {
        const creation = window.ptor && window.ptor.creation;
        if (!creation || typeof creation.decisionList !== 'function' || typeof creation.assumptionList !== 'function') {
          // Backend bridge not yet on window (Machino-α still wiring) —
          // silent: card stays hidden rather than surfacing a dev error.
          if (mounted) { setDecisions([]); setAssumptions([]); setLoading(false); }
          return;
        }
        const d = await creation.decisionList(slug, { limit: 5 });
        const a = await creation.assumptionList(slug, { limit: 5 });
        if (!mounted) return;
        // IPC envelope: {ok, rows:[...]}. Fallback to raw array for forward-compat.
        setDecisions(Array.isArray(d && d.rows) ? d.rows : (Array.isArray(d) ? d : []));
        setAssumptions(Array.isArray(a && a.rows) ? a.rows : (Array.isArray(a) ? a : []));
        setLoading(false);
      } catch (_) {
        if (mounted) { setDecisions([]); setAssumptions([]); setLoading(false); }
      }
    })();
    return () => { mounted = false; };
  }, [slug, refreshTrigger, refreshNonce]);

  // Machino-α5 — subscribe to main → renderer events. Bumps refreshNonce
  // only when the event's slug matches (decisions/sparks/roadmap are slug-
  // bound; kill-watch is vault-wide so bumps unconditionally).
  useEffect(() => {
    if (!slug) return undefined;
    const creation = window.ptor && window.ptor.creation;
    if (!creation) return undefined;
    const offFns = [];
    if (typeof creation.onDecisionsExtracted === 'function') {
      const off = creation.onDecisionsExtracted((payload) => {
        if (payload && payload.slug === slug) {
          // Machino-β6 — record skip reason on every matching event so
          // subsequent empty-state renders can surface why. null on a
          // successful extract clears any stale prior reason.
          setLastSkipped(payload.skipped || null);
          setRefreshNonce((n) => n + 1);
        }
      });
      if (typeof off === 'function') offFns.push(off);
    }
    if (typeof creation.onKillWatchDone === 'function') {
      // Kill-watcher is vault-wide; refresh unconditionally because purged
      // rows might belong to this slug.
      const off = creation.onKillWatchDone(() => setRefreshNonce((n) => n + 1));
      if (typeof off === 'function') offFns.push(off);
    }
    return () => { offFns.forEach((fn) => { try { fn(); } catch (_) {} }); };
  }, [slug]);

  // Silent on first paint + absent backend. Card is additive otherwise.
  if (loading) return null;
  // Machino-β6 — empty ledger + skipped reason = render a margin-note
  // hint card so users see why nothing was extracted (was: silent null,
  // which made empty-by-failure indistinguishable from empty-by-design).
  if (decisions.length === 0 && assumptions.length === 0) {
    if (lastSkipped) {
      return <SkippedHint reason={lastSkipped} label="本节未生成" />;
    }
    return null;
  }

  return (
    <div
      className="decision-ledger-card"
      style={{
        marginTop: 20,
        padding: 24,
        background: DECISION_PALETTE.cream,
        borderTop: `1px solid ${DECISION_PALETTE.brass}`,
        borderBottom: `1px solid ${DECISION_PALETTE.brass}`,
        fontFamily: '"EB Garamond", "Noto Serif SC", serif',
        lineHeight: 1.7,
      }}
    >
      <div
        className="ledger-header"
        style={{
          fontStyle: 'italic',
          fontSize: 13.5,
          letterSpacing: '0.04em',
          color: DECISION_PALETTE.tabac,
          marginBottom: 14,
          paddingBottom: 8,
          borderBottom: `1px solid ${DECISION_PALETTE.brass}`,
        }}
      >
        本节累积
      </div>

      {decisions.length > 0 ? (
        <div className="ledger-section" style={{ marginBottom: assumptions.length > 0 ? 18 : 0 }}>
          <div
            className="section-label"
            style={{
              fontStyle: 'italic',
              fontSize: 12,
              letterSpacing: '0.08em',
              color: DECISION_PALETTE.tabac,
              marginBottom: 6,
            }}
          >
            决策
          </div>
          {decisions.map((d, i) => (
            <DecisionRow key={(d && d.ts) || `d-${i}`} row={d} />
          ))}
        </div>
      ) : null}

      {assumptions.length > 0 ? (
        <div className="ledger-section">
          <div
            className="section-label"
            style={{
              fontStyle: 'italic',
              fontSize: 12,
              letterSpacing: '0.08em',
              color: DECISION_PALETTE.tabac,
              marginBottom: 6,
            }}
          >
            假设
          </div>
          {assumptions.map((a, i) => (
            <AssumptionRow key={(a && a.ts) || `a-${i}`} row={a} />
          ))}
        </div>
      ) : null}
    </div>
  );
};

// Expose globally so screen-lesson-chat.jsx (loaded after this file in
// HYPHA.html) can render <DecisionLedgerCard /> without an import.
if (typeof window !== 'undefined') {
  window.DecisionLedgerCard = DecisionLedgerCard;
}
