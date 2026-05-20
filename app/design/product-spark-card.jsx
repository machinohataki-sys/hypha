/* global React */
//
// HYPHA · Product Spark Card (v0.3 Creation System surface, 2026-05-14)
//
// Mounts inside the lesson screen below DecisionLedgerCard. Reads the
// per-curriculum spark log maintained by the Creation System
// (Machino-α2 backend: window.ptor.creation.sparkList; Machino-β2
// /finish auto-extract writes sparks.jsonl post-session).
//
// Surface contract:
//   - Renders only when at least one spark exists for slug
//   - Manuscript register: italic EB Garamond + Noto Serif SC on cream paper,
//     brass hairline rules, no emoji, no exclamation, no marketing slang
//   - core_transfer leads the row in italic Garamond 15.5pt
//   - possible_actions joined with " · " separator, tabac roman 8.5pt
//   - state rendered as small badge with editorial register-faithful styling
//   - All text renders through React text nodes (no dangerouslySetInnerHTML)
//
// refreshTrigger contract:
//   - Bump from parent after /finish so the card refetches the latest
//     sparks written by Machino-β2.

const SPARK_PALETTE = {
  ink:      '#2A1F12',  // 墨水
  tabac:    '#5C4E36',  // 棕褐
  brass:    '#B8A372',  // 黄铜分割线
  cream:    '#F4EBD9',  // 奶油背景
  oxblood:  '#6E2D2D',  // 已落实 warning (非 red)
  seed:     '#5C4E36',  // 萌芽 = tabac
  accepted: '#6B4423',  // 已接受 深棕
  rejected: '#8A7F6E',  // 已搁置 灰 (微 line-through)
};

// State 中文化 + 配色映射. Keeps register coherent without leaking
// raw English enums into the manuscript.
const STATE_MAP = {
  Seed:        { label: '萌芽',   color: SPARK_PALETTE.seed,     style: 'plain' },
  Considered:  { label: '在考虑', color: SPARK_PALETTE.ink,      style: 'underline' },
  Accepted:    { label: '已接受', color: SPARK_PALETTE.accepted, style: 'italic' },
  Rejected:    { label: '已搁置', color: SPARK_PALETTE.rejected, style: 'strike' },
  Implemented: { label: '已落实', color: SPARK_PALETTE.oxblood,  style: 'bold' },
};

// Compact ts formatter — "MM-DD HH:mm" in roman 8.5pt. Defensive: bad
// input returns empty string so the row still renders without breaking.
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

// Pull display text out of a spark row regardless of upstream shape.
// Machino-α2 has not locked the field name; accept the most likely
// keys without falling through to JSON.stringify (register violation).
function _coreTransfer(s) {
  if (!s || typeof s !== 'object') return '';
  if (typeof s.core_transfer === 'string' && s.core_transfer.trim()) return s.core_transfer.trim();
  if (typeof s.transfer === 'string' && s.transfer.trim()) return s.transfer.trim();
  if (typeof s.text === 'string' && s.text.trim()) return s.text.trim();
  if (typeof s.summary === 'string' && s.summary.trim()) return s.summary.trim();
  return '';
}

function _possibleActions(s) {
  if (!s || typeof s !== 'object') return [];
  const raw = s.possible_actions || s.actions || s.next_steps;
  if (Array.isArray(raw)) {
    return raw
      .map(a => (typeof a === 'string' ? a.trim() : ''))
      .filter(a => a.length > 0);
  }
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  return [];
}

function _stateKey(s) {
  if (!s || typeof s !== 'object') return 'Seed';
  const raw = (typeof s.state === 'string' ? s.state : 'Seed').trim();
  if (Object.prototype.hasOwnProperty.call(STATE_MAP, raw)) return raw;
  return 'Seed';
}

// Defensive prediction extractor (mirrors decision-ledger-card). Returns
// null on absent / malformed shape so SparkRow silently skips the block
// for v0.3 pre-prediction sparks.
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

// Deadline formatter — same color tiers as ledger card:
//   daysUntil > 7   → tabac (calm)
//   0 < daysUntil ≤ 7 → oxblood italic (临近)
//   daysUntil ≤ 0   → faded gray + line-through 整块 (留痕)
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

function _autoKilledMarker(row) {
  if (!row || typeof row !== 'object') return false;
  const meta = row._meta;
  if (!meta || typeof meta !== 'object') return false;
  if (typeof meta.auto_killed_at === 'string' && meta.auto_killed_at.trim()) return true;
  if (meta.auto_killed === true) return true;
  return false;
}

const PredictionBlock = ({ prediction }) => {
  if (!prediction) return null;
  const { claim, falsifier, deadline } = prediction;
  const deadlineMeta = _formatDeadline(deadline);
  const expired = deadlineMeta && deadlineMeta.strike;
  const baseFont = '"EB Garamond", "Noto Serif SC", serif';
  const blockStyle = {
    marginTop: 8,
    paddingTop: 8,
    paddingLeft: 12,
    borderLeft: `2px solid ${SPARK_PALETTE.brass}60`,
    opacity: expired ? 0.7 : 1,
    textDecoration: expired ? 'line-through' : 'none',
    textDecorationColor: expired ? '#8A7F6E' : undefined,
  };
  return (
    <div className="prediction-block" style={blockStyle}>
      {claim ? (
        <div
          style={{
            fontFamily: baseFont,
            fontStyle: 'italic',
            fontSize: 13,
            lineHeight: 1.65,
            color: SPARK_PALETTE.ink,
            marginBottom: 4,
          }}
        >
          <span style={{ color: SPARK_PALETTE.tabac, marginRight: 6 }}>预测落实效果:</span>
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
            color: SPARK_PALETTE.tabac,
            marginBottom: 4,
          }}
        >
          <span style={{ marginRight: 6 }}>证伪条件:</span>
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
          <span style={{ marginRight: 6 }}>复查截止:</span>
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
        color: SPARK_PALETTE.tabac,
        marginLeft: 6,
      }}
    >
      (自动)
    </span>
  );
};

const StateBadge = ({ stateKey }) => {
  const meta = STATE_MAP[stateKey] || STATE_MAP.Seed;
  const base = {
    fontFamily: '"EB Garamond", "Noto Serif SC", serif',
    fontSize: 11.5,
    letterSpacing: '0.04em',
    color: meta.color,
    background: 'transparent',
    padding: 0,
  };
  if (meta.style === 'italic') {
    return (
      <span style={{ ...base, fontStyle: 'italic' }} title={stateKey}>
        {meta.label}
      </span>
    );
  }
  if (meta.style === 'underline') {
    return (
      <span
        style={{
          ...base,
          borderBottom: `1px solid ${SPARK_PALETTE.brass}`,
          paddingBottom: 1,
        }}
        title={stateKey}
      >
        {meta.label}
      </span>
    );
  }
  if (meta.style === 'strike') {
    return (
      <span style={{ ...base, textDecoration: 'line-through' }} title={stateKey}>
        {meta.label}
      </span>
    );
  }
  if (meta.style === 'bold') {
    return (
      <span style={{ ...base, fontWeight: 600 }} title={stateKey}>
        {meta.label}
      </span>
    );
  }
  return (
    <span style={base} title={stateKey}>
      {meta.label}
    </span>
  );
};

const SparkRow = ({ row }) => {
  const text = _coreTransfer(row);
  if (!text) return null;
  const ts = _formatTs(row && row.ts);
  const actions = _possibleActions(row);
  const stateKey = _stateKey(row);
  const prediction = _predictionMeta(row);
  const autoKilled = _autoKilledMarker(row);

  return (
    <div
      className="spark-row"
      style={{
        padding: '12px 0',
        borderBottom: `1px solid ${SPARK_PALETTE.brass}40`,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 16,
          marginBottom: 8,
        }}
      >
        <div
          style={{
            flex: '1 1 auto',
            fontFamily: '"EB Garamond", "Noto Serif SC", serif',
            fontStyle: 'italic',
            fontSize: 15.5,
            lineHeight: 1.7,
            color: SPARK_PALETTE.ink,
          }}
        >
          {text}
        </div>
        {ts ? (
          <div
            style={{
              flex: '0 0 auto',
              fontFamily: '"EB Garamond", "Noto Serif SC", serif',
              fontStyle: 'normal',
              fontSize: 8.5,
              letterSpacing: '0.06em',
              color: SPARK_PALETTE.tabac,
              whiteSpace: 'nowrap',
            }}
          >
            {ts}
          </div>
        ) : null}
      </div>

      {actions.length > 0 ? (
        <div
          style={{
            fontFamily: '"EB Garamond", "Noto Serif SC", serif',
            fontStyle: 'normal',
            fontSize: 8.5,
            letterSpacing: '0.04em',
            color: SPARK_PALETTE.tabac,
            lineHeight: 1.6,
            marginBottom: 4,
          }}
        >
          <span style={{ fontStyle: 'italic', marginRight: 6 }}>可能动作:</span>
          <span>{actions.join(' · ')}</span>
        </div>
      ) : null}

      <div
        style={{
          fontFamily: '"EB Garamond", "Noto Serif SC", serif',
          fontStyle: 'normal',
          fontSize: 8.5,
          letterSpacing: '0.04em',
          color: SPARK_PALETTE.tabac,
          lineHeight: 1.6,
        }}
      >
        <span style={{ fontStyle: 'italic', marginRight: 6 }}>状态:</span>
        <StateBadge stateKey={stateKey} />
        <AutoKilledHint visible={autoKilled} />
      </div>
      <PredictionBlock prediction={prediction} />
    </div>
  );
};

// Machino-β6 (2026-05-14) — skip reason 中文化 for spark extractor.
// Maps the `skipped` field emitted by main.js `creation:sparks-extracted`
// event into a readable editorial sentence. Returns '' for unknown
// codes so caller can fall through to a generic phrase.
function _skipReasonZh(code) {
  if (typeof code !== 'string' || !code.trim()) return '';
  switch (code) {
    case 'too-short':
      return '对话太短,没抽到灵感';
    case 'llm-error':
      return '模型调用失败';
    case 'no-extracts':
      return '对话里没出现可迁移的灵感(纯接受信息,无创作启发)';
    case 'no-slug':
      return '课程 slug 缺失,系统跳过';
    default:
      return '';
  }
}

// Skipped hint card — small editorial register-faithful surface that
// surfaces an empty-result reason from /finish so an empty spark list
// does not silently read as "no inspiration happened". Padding 12
// (half of the data card's 24) to read as a margin note.
const SkippedHint = ({ reason, label }) => {
  const zh = _skipReasonZh(reason);
  return (
    <div
      className="product-spark-skipped"
      style={{
        marginTop: 20,
        padding: 12,
        background: SPARK_PALETTE.cream,
        borderTop: `1px solid ${SPARK_PALETTE.brass}`,
        borderBottom: `1px solid ${SPARK_PALETTE.brass}`,
        fontFamily: '"EB Garamond", "Noto Serif SC", serif',
        lineHeight: 1.7,
      }}
    >
      <div
        style={{
          fontStyle: 'italic',
          fontSize: 11,
          letterSpacing: '0.04em',
          color: SPARK_PALETTE.tabac,
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
          color: SPARK_PALETTE.ink,
        }}
      >
        {zh || reason}
      </div>
    </div>
  );
};

const ProductSparkCard = ({ slug, refreshTrigger }) => {
  const { useState, useEffect } = React;
  const [sparks, setSparks] = useState([]);
  const [loading, setLoading] = useState(true);
  // Machino-α5 (2026-05-14) — bumped by main-process events when the
  // spark extractor or kill-watcher writes/refutes rows.
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Machino-β6 (2026-05-14) — last skipped reason from the most recent
  // matching `creation:sparks-extracted` event. Null on success or pre-
  // event. Drives the empty-state hint so failures are visible.
  const [lastSkipped, setLastSkipped] = useState(null);

  useEffect(() => {
    if (!slug) { setLoading(false); return undefined; }
    let mounted = true;
    (async () => {
      try {
        const creation = window.ptor && window.ptor.creation;
        if (!creation || typeof creation.sparkList !== 'function') {
          // Backend bridge not yet on window (Machino-α2 still wiring) —
          // silent: card stays hidden rather than surfacing a dev error.
          if (mounted) { setSparks([]); setLoading(false); }
          return;
        }
        const s = await creation.sparkList(slug, { limit: 5 });
        if (!mounted) return;
        // IPC envelope: {ok, rows:[...]}. Fallback to raw array for forward-compat.
        setSparks(Array.isArray(s && s.rows) ? s.rows : (Array.isArray(s) ? s : []));
        setLoading(false);
      } catch (_) {
        if (mounted) { setSparks([]); setLoading(false); }
      }
    })();
    return () => { mounted = false; };
  }, [slug, refreshTrigger, refreshNonce]);

  // Machino-α5 — subscribe to spark-extracted + kill-watch-done events.
  useEffect(() => {
    if (!slug) return undefined;
    const creation = window.ptor && window.ptor.creation;
    if (!creation) return undefined;
    const offFns = [];
    if (typeof creation.onSparksExtracted === 'function') {
      const off = creation.onSparksExtracted((payload) => {
        if (payload && payload.slug === slug) {
          // Machino-β6 — record skip reason on every matching event.
          setLastSkipped(payload.skipped || null);
          setRefreshNonce((n) => n + 1);
        }
      });
      if (typeof off === 'function') offFns.push(off);
    }
    if (typeof creation.onKillWatchDone === 'function') {
      const off = creation.onKillWatchDone(() => setRefreshNonce((n) => n + 1));
      if (typeof off === 'function') offFns.push(off);
    }
    return () => { offFns.forEach((fn) => { try { fn(); } catch (_) {} }); };
  }, [slug]);

  // Silent on first paint + absent backend.
  if (loading) return null;
  // Machino-β6 — empty list + skipped reason = render margin-note hint
  // so users see why nothing was extracted.
  if (sparks.length === 0) {
    if (lastSkipped) {
      return <SkippedHint reason={lastSkipped} label="本节未生成" />;
    }
    return null;
  }

  return (
    <div
      className="product-spark-card"
      style={{
        marginTop: 20,
        padding: 24,
        background: SPARK_PALETTE.cream,
        borderTop: `1px solid ${SPARK_PALETTE.brass}`,
        borderBottom: `1px solid ${SPARK_PALETTE.brass}`,
        fontFamily: '"EB Garamond", "Noto Serif SC", serif',
        lineHeight: 1.7,
      }}
    >
      <div
        className="spark-header"
        style={{
          fontStyle: 'italic',
          fontSize: 13.5,
          letterSpacing: '0.04em',
          color: SPARK_PALETTE.tabac,
          marginBottom: 14,
          paddingBottom: 8,
          borderBottom: `1px solid ${SPARK_PALETTE.brass}`,
        }}
      >
        灵感
      </div>

      <div className="spark-section">
        {sparks.map((s, i) => (
          <SparkRow key={(s && s.ts) || `s-${i}`} row={s} />
        ))}
      </div>
    </div>
  );
};

// Expose globally so screen-lesson-chat.jsx (loaded after this file in
// HYPHA.html) can render <ProductSparkCard /> without an import.
if (typeof window !== 'undefined') {
  window.ProductSparkCard = ProductSparkCard;
}
