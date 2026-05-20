/* global React */
// HYPHA · W6.4 Curriculum Graph — BLUEPRINT §20 v1.8 single-domain AI/CS DAG.
//
// Renders the 48-knowledge-point graph as a calm layered list (foundation →
// ML classic → DL → LLM → agent → builder). Hovering a node opens an inline
// detail panel with canonical example, assignment types, and frontier
// bridges. A mastery overlay marks KPs the user has finished (via the
// `masteredKpIds` prop). The graph is intentionally NOT a SVG dependency
// chart — manuscript register prefers ordered prose to spaghetti edges.
//
// Props:
//   { masteredKpIds = [], onSelectKP, onBack }
//
// Backend: window.ptor.curgraph.{load, frontierBridge, recommendNext}.
// Falls back to a quiet empty state if the bridge is missing (older builds).

const { useState, useEffect, useMemo, useCallback } = React;

const REGISTER = {
  paper: '#FBF5E8',        // cream paper
  ink: '#1B1A17',
  inkSoft: '#5C544A',
  inkFaint: '#8B8278',
  brass: '#9C7A3C',
  brassFaint: '#D9C7A3',
  hairline: 'rgba(27, 26, 23, 0.18)',
  hairlineSoft: 'rgba(27, 26, 23, 0.08)',
  highlight: 'rgba(156, 122, 60, 0.10)',
};

const SERIF = "'EB Garamond', 'Noto Serif SC', Georgia, serif";
const MONO = "'JetBrains Mono', 'IBM Plex Mono', Menlo, monospace";

// Difficulty 1-5 → roman numerals; keeps the register dignified.
const DIFF_GLYPH = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V' };

function CurriculumGraphScreen({ masteredKpIds = [], onSelectKP, onBack }) {
  const [graph, setGraph] = useState(null);
  const [error, setError] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [bridgeCache, setBridgeCache] = useState({});

  useEffect(() => {
    let alive = true;
    const fn = window.ptor && window.ptor.curgraph && window.ptor.curgraph.load;
    if (typeof fn !== 'function') {
      setError('curriculum-graph bridge unavailable in this build');
      return undefined;
    }
    fn().then((res) => {
      if (!alive) return;
      if (res && res.ok) setGraph(res.graph);
      else setError((res && res.error) || 'failed to load curriculum graph');
    }).catch((err) => alive && setError(String(err)));
    return () => { alive = false; };
  }, []);

  const masteredSet = useMemo(() => new Set(masteredKpIds), [masteredKpIds]);

  const nodesByLayer = useMemo(() => {
    if (!graph) return [];
    const layers = graph.layers.slice().sort((a, b) => a.order - b.order);
    return layers.map((layer) => ({
      layer,
      nodes: graph.nodes
        .filter((n) => n.layer === layer.id)
        .sort((a, b) => (a.difficulty - b.difficulty) || a.name.localeCompare(b.name)),
    }));
  }, [graph]);

  const onHover = useCallback((nodeId) => {
    setHoveredId(nodeId);
    if (!nodeId || bridgeCache[nodeId]) return;
    const fn = window.ptor && window.ptor.curgraph && window.ptor.curgraph.frontierBridge;
    if (typeof fn !== 'function') return;
    fn(nodeId).then((res) => {
      if (res && res.ok) {
        setBridgeCache((prev) => ({ ...prev, [nodeId]: res.bridge }));
      }
    }).catch(() => { /* swallow — detail panel falls back to local data */ });
  }, [bridgeCache]);

  const hoveredNode = useMemo(() => {
    if (!graph || !hoveredId) return null;
    return graph.nodes.find((n) => n.id === hoveredId) || null;
  }, [graph, hoveredId]);

  // Recommend-next signal: small KP count under the page title.
  const [nextRecs, setNextRecs] = useState([]);
  useEffect(() => {
    const fn = window.ptor && window.ptor.curgraph && window.ptor.curgraph.recommendNext;
    if (typeof fn !== 'function' || !graph) return;
    fn(masteredKpIds, 3).then((res) => {
      if (res && res.ok) setNextRecs(res.recommendations || []);
    }).catch(() => setNextRecs([]));
  }, [graph, masteredKpIds]);

  // ─── Render ──────────────────────────────────────────────────────────────
  return (
    <div style={{
      minHeight: '100vh',
      background: REGISTER.paper,
      color: REGISTER.ink,
      fontFamily: SERIF,
      padding: '48px 64px 96px',
      maxWidth: 980,
      margin: '0 auto',
    }}>
      <header style={{ marginBottom: 36 }}>
        <div style={{
          fontFamily: MONO, fontSize: 10, letterSpacing: '0.18em',
          textTransform: 'uppercase', color: REGISTER.inkFaint, marginBottom: 6,
        }}>
          curriculum graph · AI / CS · v0.1
        </div>
        <h1 style={{
          fontStyle: 'italic', fontWeight: 400, fontSize: 38, letterSpacing: '-0.01em',
          margin: 0, lineHeight: 1.1,
        }}>
          The shape of the field
        </h1>
        <p style={{
          marginTop: 14, fontSize: 16, lineHeight: 1.6, color: REGISTER.inkSoft,
          maxWidth: 640, fontStyle: 'italic',
        }}>
          {graph ? `${graph.nodes.length} knowledge points across ${graph.layers.length} layers, each anchored to a canonical example and a 2026-era frontier bridge.` : 'Loading…'}
        </p>
        {nextRecs.length > 0 && (
          <div style={{
            marginTop: 22, paddingTop: 14, borderTop: `0.5px solid ${REGISTER.hairlineSoft}`,
            fontSize: 13, color: REGISTER.inkSoft,
          }}>
            <span style={{
              fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em',
              textTransform: 'uppercase', color: REGISTER.brass, marginRight: 12,
            }}>open to you next</span>
            {nextRecs.map((n, i) => (
              <span key={n.id}>
                {i > 0 ? ', ' : ''}
                <span style={{ fontStyle: 'italic' }}>{n.name}</span>
              </span>
            ))}
          </div>
        )}
        {onBack && (
          <button
            onClick={onBack}
            style={{
              position: 'absolute', top: 28, left: 32,
              background: 'transparent', border: 'none',
              fontFamily: MONO, fontSize: 11, letterSpacing: '0.12em',
              color: REGISTER.inkFaint, cursor: 'pointer', padding: '4px 10px',
            }}
          >← back</button>
        )}
      </header>

      {error && (
        <div style={{
          padding: '16px 20px', border: `0.5px solid ${REGISTER.hairline}`,
          fontStyle: 'italic', color: REGISTER.inkSoft,
        }}>{error}</div>
      )}

      {!error && nodesByLayer.map(({ layer, nodes }) => (
        <section key={layer.id} style={{ marginTop: 44 }}>
          <div style={{
            display: 'flex', alignItems: 'baseline',
            borderBottom: `0.5px solid ${REGISTER.hairline}`, paddingBottom: 6, marginBottom: 18,
          }}>
            <span style={{
              fontFamily: MONO, fontSize: 10, letterSpacing: '0.18em',
              textTransform: 'uppercase', color: REGISTER.brass, marginRight: 14,
            }}>{String(layer.order + 1).padStart(2, '0')}</span>
            <h2 style={{
              margin: 0, fontWeight: 400, fontStyle: 'italic', fontSize: 22, color: REGISTER.ink,
            }}>{layer.name}</h2>
          </div>

          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {nodes.map((node) => {
              const mastered = masteredSet.has(node.id);
              const hovered = hoveredId === node.id;
              return (
                <li
                  key={node.id}
                  onMouseEnter={() => onHover(node.id)}
                  onMouseLeave={() => onHover(null)}
                  onClick={() => onSelectKP && onSelectKP(node.id)}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '52px 1fr auto',
                    alignItems: 'baseline',
                    padding: '10px 14px',
                    margin: '0 -14px',
                    borderRadius: 2,
                    background: hovered ? REGISTER.highlight : 'transparent',
                    cursor: onSelectKP ? 'pointer' : 'default',
                    transition: 'background 120ms ease',
                    borderLeft: mastered ? `2px solid ${REGISTER.brass}` : '2px solid transparent',
                  }}
                >
                  <span style={{
                    fontFamily: MONO, fontSize: 11, color: REGISTER.inkFaint,
                    letterSpacing: '0.04em',
                  }}>{DIFF_GLYPH[node.difficulty] || node.difficulty}</span>
                  <span style={{
                    fontSize: 16, color: mastered ? REGISTER.brass : REGISTER.ink,
                    fontStyle: mastered ? 'italic' : 'normal',
                  }}>{node.name}</span>
                  <span style={{
                    fontFamily: MONO, fontSize: 10, color: REGISTER.inkFaint,
                    letterSpacing: '0.05em',
                  }}>
                    {(node.prereq_ids && node.prereq_ids.length) ? `← ${node.prereq_ids.length}` : ''}
                  </span>
                  {hovered && (
                    <DetailPanel
                      node={node}
                      bridge={bridgeCache[node.id]}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function DetailPanel({ node, bridge }) {
  return (
    <div style={{
      gridColumn: '1 / span 3',
      marginTop: 12, paddingTop: 12,
      borderTop: `0.5px dashed ${REGISTER.hairline}`,
      fontSize: 14, color: REGISTER.inkSoft,
      lineHeight: 1.55,
    }}>
      <div style={{ marginBottom: 8 }}>
        <span style={{
          fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em',
          textTransform: 'uppercase', color: REGISTER.brass, marginRight: 10,
        }}>canonical example</span>
        <span style={{ fontStyle: 'italic' }}>{node.canonical_example}</span>
      </div>
      {Array.isArray(node.assignment_types) && node.assignment_types.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <span style={{
            fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em',
            textTransform: 'uppercase', color: REGISTER.brass, marginRight: 10,
          }}>assignments</span>
          <span style={{ fontFamily: MONO, fontSize: 12, color: REGISTER.inkSoft }}>
            {node.assignment_types.join(' · ')}
          </span>
        </div>
      )}
      {Array.isArray(node.frontier_bridges) && node.frontier_bridges.length > 0 && (
        <div style={{ marginBottom: 4 }}>
          <span style={{
            fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em',
            textTransform: 'uppercase', color: REGISTER.brass, marginRight: 10,
          }}>frontier bridge</span>
          <span style={{ fontStyle: 'italic' }}>{node.frontier_bridges[0]}</span>
        </div>
      )}
      {bridge && Array.isArray(bridge.recommended_reading) && bridge.recommended_reading.length > 0 && (
        <div>
          <span style={{
            fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em',
            textTransform: 'uppercase', color: REGISTER.brass, marginRight: 10,
          }}>reading</span>
          <span style={{ fontSize: 13 }}>{bridge.recommended_reading[0]}</span>
        </div>
      )}
    </div>
  );
}

if (typeof window !== 'undefined') {
  window.CurriculumGraphScreen = CurriculumGraphScreen;
}
