/* global React */
//
// HYPHA · Note Edge Card (γ11 Web Note Engine surface, 2026-05-15)
//
// Mounts in the lesson screen sidebar / footer band. Reads typed-edge
// neighbors for the current (slug, noteIdx) via the shipped bridge:
//   window.ptor.notes.getNeighbors(slug, noteIdx) → { ok, incoming:[], outgoing:[] }
//
// Each edge: { type, from_idx, to_idx, label, evidence }.
// Five typed edges with 中文化 + direction symbol:
//   cites         → 引用    (outgoing →, incoming ←)
//   contradicts   → 反驳    (outgoing →, incoming ←)
//   extends       → 延伸    (outgoing →, incoming ←)
//   triggered-by  → 触发    (outgoing → "因...触发", incoming ← "触发了 N")
//   related       → 相关    (always ⇄)
//
// Clicking a lesson-N anchor dispatches `hypha:open-lesson` so app.jsx can
// route without prop-drilling setRoute through every card.

const EDGE_PALETTE = {
  ink:    '#2A1F12',
  tabac:  '#5C4E36',
  brass:  '#B8A372',
  cream:  '#F4EBD9',
  faded:  '#8A7F6E',
};

const _baseFont = '"EB Garamond", "Noto Serif SC", serif';

// Type-label map. Single source of truth — adding a new edge type means
// adding one entry here. Unknown types fall through to the raw `type`
// string so we surface untyped edges visibly rather than silently dropping.
const TYPE_LABELS = {
  'cites':        '引用',
  'contradicts':  '反驳',
  'extends':      '延伸',
  'triggered-by': '触发',
  'related':      '相关',
};

// Direction symbol per (type, direction). related is always ⇄.
function _directionSymbol(type, direction) {
  if (type === 'related') return '⇄';
  return direction === 'outgoing' ? '→' : '←';
}

// Extract the peer lesson index for an edge from the renderer's POV.
// For outgoing: peer = edge.to_idx; for incoming: peer = edge.from_idx.
// Returns null when the field is missing / malformed so the row hides
// the lesson anchor gracefully.
function _peerIdx(edge, direction) {
  if (!edge || typeof edge !== 'object') return null;
  const v = direction === 'outgoing' ? edge.to_idx : edge.from_idx;
  return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}

// Extract the human label / evidence snippet. Prefer evidence when present
// because it carries the verbatim 你引用了 / 你延伸了 phrasing.
function _edgeLabel(edge) {
  if (!edge || typeof edge !== 'object') return '';
  if (typeof edge.evidence === 'string' && edge.evidence.trim()) return edge.evidence.trim();
  if (typeof edge.label === 'string' && edge.label.trim()) return edge.label.trim();
  return '';
}

// Truncate the label to 80 chars to keep the side-card tight.
function _truncLabel(s) {
  if (!s) return '';
  if (s.length <= 80) return s;
  return s.slice(0, 79).trim() + '…';
}

function _openLesson(slug, peerIdx) {
  if (peerIdx == null) return;
  try {
    window.dispatchEvent(new CustomEvent('hypha:open-lesson', {
      detail: { slug, lessonIdx: peerIdx },
    }));
  } catch (_) { /* no-op */ }
}

const EdgeRow = ({ edge, direction, slug }) => {
  const type = (edge && typeof edge.type === 'string') ? edge.type : '';
  const typeLbl = TYPE_LABELS[type] || type || '未分类';
  const sym = _directionSymbol(type, direction);
  const peer = _peerIdx(edge, direction);
  const peerLbl = peer != null ? `lesson-${peer}` : null;
  const label = _truncLabel(_edgeLabel(edge));
  return (
    <div style={{
      padding: '6px 0',
      borderBottom: `1px solid ${EDGE_PALETTE.brass}30`,
      fontFamily: _baseFont,
      fontSize: 12.5,
      lineHeight: 1.55,
      color: EDGE_PALETTE.ink,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ color: EDGE_PALETTE.tabac, fontStyle: 'italic' }}>{sym}</span>
        <span style={{ color: EDGE_PALETTE.tabac, fontStyle: 'italic' }}>{typeLbl}</span>
        {peerLbl ? (
          <button
            type="button"
            onClick={() => _openLesson(slug, peer)}
            title={`打开 ${peerLbl}`}
            style={{
              fontFamily: _baseFont,
              fontSize: 12.5,
              fontStyle: 'italic',
              color: EDGE_PALETTE.tabac,
              background: 'transparent',
              border: 'none',
              borderBottom: `1px dotted ${EDGE_PALETTE.brass}`,
              padding: 0,
              cursor: 'pointer',
              letterSpacing: '0.02em',
            }}
          >
            {peerLbl}
          </button>
        ) : null}
        {label ? (
          <span style={{ color: EDGE_PALETTE.ink, opacity: 0.92 }}>· {label}</span>
        ) : null}
      </div>
    </div>
  );
};

const NoteEdgeCard = ({ slug, noteIdx }) => {
  const { useState, useEffect } = React;
  const [incoming, setIncoming] = useState([]);
  const [outgoing, setOutgoing] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!slug || typeof noteIdx !== 'number') { setLoaded(true); return undefined; }
    let alive = true;
    setLoaded(false);
    (async () => {
      try {
        const notes = window.ptor && window.ptor.hypha && window.ptor.hypha.notes;
        if (!notes || typeof notes.getNeighbors !== 'function') {
          if (alive) { setIncoming([]); setOutgoing([]); setLoaded(true); }
          return;
        }
        const r = await notes.getNeighbors(slug, noteIdx);
        if (!alive) return;
        // Defensive envelope unwrap: {ok, incoming, outgoing} OR
        // {incoming, outgoing} OR raw arrays at the root.
        const env = (r && typeof r === 'object') ? r : {};
        const inc = Array.isArray(env.incoming) ? env.incoming : [];
        const out = Array.isArray(env.outgoing) ? env.outgoing : [];
        setIncoming(inc);
        setOutgoing(out);
        setLoaded(true);
      } catch (_) {
        if (alive) { setIncoming([]); setOutgoing([]); setLoaded(true); }
      }
    })();
    return () => { alive = false; };
  }, [slug, noteIdx]);

  if (!loaded) return null;
  const total = incoming.length + outgoing.length;
  if (total === 0) return null;

  return (
    <div
      className="note-edge-card"
      style={{
        marginTop: 20,
        padding: '14px 20px',
        background: EDGE_PALETTE.cream,
        borderTop: `1px solid ${EDGE_PALETTE.brass}`,
        borderBottom: `1px solid ${EDGE_PALETTE.brass}`,
        fontFamily: _baseFont,
      }}
    >
      <div style={{
        fontStyle: 'italic',
        fontSize: 12,
        letterSpacing: '0.06em',
        color: EDGE_PALETTE.tabac,
        marginBottom: 10,
        paddingBottom: 6,
        borderBottom: `1px solid ${EDGE_PALETTE.brass}60`,
      }}>
        连接 ({total} 处)
      </div>
      {outgoing.map((e, i) => (
        <EdgeRow
          key={(e && e.edge_id) ? `o-${e.edge_id}` : `o-${i}`}
          edge={e}
          direction="outgoing"
          slug={slug}
        />
      ))}
      {incoming.map((e, i) => (
        <EdgeRow
          key={(e && e.edge_id) ? `i-${e.edge_id}` : `i-${i}`}
          edge={e}
          direction="incoming"
          slug={slug}
        />
      ))}
    </div>
  );
};

if (typeof window !== 'undefined') {
  window.NoteEdgeCard = NoteEdgeCard;
}
