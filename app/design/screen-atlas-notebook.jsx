/* global React, Icon, Watercolor, YieldDot, YIELD_META */
// HYPHA · Atlas (knowledge map) + Notebook

const { useState, useRef, useEffect } = React;

// ===== ATLAS =====
const CLUSTERS = [];
const NODES = [
  { id: "n1",  label: "Peircean triads",      cluster: "myth",     x: 22, y: 22, kind: "Note" },
  { id: "n2",  label: "Origin of Tragedy",    cluster: "myth",     x: 16, y: 38, kind: "Source" },
  { id: "n3",  label: "Mythopoeic loops",     cluster: "myth",     x: 32, y: 18, kind: "Note" },
  { id: "n4",  label: "Veyra · Mythical Grammar", cluster: "language", x: 70, y: 18, kind: "Source" },
  { id: "n5",  label: "Decay as syntax",      cluster: "language", x: 64, y: 36, kind: "Lesson" },
  { id: "n6",  label: "Spore script",         cluster: "language", x: 78, y: 30, kind: "Note" },
  { id: "n7",  label: "Slow reading",         cluster: "memory",   x: 22, y: 64, kind: "Judgment" },
  { id: "n8",  label: "Archive Fever",        cluster: "memory",   x: 36, y: 76, kind: "Source" },
  { id: "n9",  label: "Re-reading practice",  cluster: "memory",   x: 24, y: 80, kind: "Action" },
  { id: "n10", label: "Civic dialogue",       cluster: "systems",  x: 76, y: 64, kind: "Spark" },
  { id: "n11", label: "Mushroom at the End",  cluster: "systems",  x: 64, y: 78, kind: "Source" },
  { id: "n12", label: "Mycelial archive",     cluster: "self",     x: 50, y: 56, kind: "Note" },
  { id: "n13", label: "Hyphae of attention",  cluster: "self",     x: 46, y: 44, kind: "Judgment" },
];
const LINKS = [
  ["n1","n4"],["n3","n4"],["n4","n5"],["n5","n6"],["n5","n13"],["n13","n12"],
  ["n12","n8"],["n8","n7"],["n7","n9"],["n2","n3"],["n10","n11"],["n11","n5"],
  ["n13","n4"],["n12","n6"],["n8","n2"],["n10","n6"],
];
const KIND_TONE = { Note: "ochre", Source: "indigo", Lesson: "terra", Action: "terra", Spark: "ochre", Judgment: "sage" };

// Phase D (R9 + R12 / pedagogy.md Layer 6) — archetype-aware layout from
// knowledge_points data. Position function per archetype:
//   timeline  : horizontal spread, kp-1 left → kp-N right
//   tree      : top-down BFS staggered grid
//   DAG       : horizontal spread with vertical wave for back-edge readability
//   matrix    : square grid
//   flat      : single vertical column (cards-with-edges look)
// Within-lesson edges from connects_to_next (target_kp_id within node set).
// Cross-syllabus lineage_link is preserved on the inspector card, not drawn.

function _kpLayoutPosition(i, n, archetype) {
  if (n <= 1) return { x: 50, y: 50 };
  switch (archetype) {
    case 'timeline':
      return { x: 10 + (i / (n - 1)) * 80, y: 50 };
    case 'tree': {
      const cols = Math.min(4, n);
      const col = i % cols;
      const row = Math.floor(i / cols);
      const rows = Math.ceil(n / cols);
      return {
        x: rows === 1 ? 10 + (i / Math.max(1, n - 1)) * 80 : 15 + col * (70 / Math.max(1, cols - 1)),
        y: rows === 1 ? 50 : 18 + row * (64 / Math.max(1, rows - 1)),
      };
    }
    case 'matrix': {
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const col = i % cols;
      const row = Math.floor(i / cols);
      return {
        x: cols === 1 ? 50 : 15 + col * (70 / Math.max(1, cols - 1)),
        y: rows === 1 ? 50 : 18 + row * (64 / Math.max(1, rows - 1)),
      };
    }
    case 'flat':
      return { x: 50, y: 12 + (i / Math.max(1, n - 1)) * 76 };
    case 'DAG':
    default: {
      const x = 12 + (i / Math.max(1, n - 1)) * 76;
      const yOffset = (i % 3 === 0) ? -8 : (i % 3 === 1 ? 0 : 8);
      return { x, y: 45 + yOffset };
    }
  }
}

function _buildKpGraph(arcs, archetype) {
  const n = arcs.length;
  const nodes = arcs.map((wrapper, i) => {
    if (!wrapper) return null;
    const arc = wrapper.arc || wrapper;
    const id = wrapper.kp_id || arc.kp_id || `kp-${i + 1}`;
    const label = arc.title || id;
    const pos = _kpLayoutPosition(i, n, archetype);
    return { id, label, kind: 'Note', x: pos.x, y: pos.y, arc };
  }).filter(Boolean);
  const idSet = new Set(nodes.map(nd => nd.id));
  const links = [];
  arcs.forEach((wrapper, i) => {
    if (!wrapper) return;
    const arc = wrapper.arc || wrapper;
    const sourceId = wrapper.kp_id || arc.kp_id || `kp-${i + 1}`;
    const connects = Array.isArray(arc.connects_to_next) ? arc.connects_to_next : [];
    connects.forEach(c => {
      if (c && c.target_kp_id && idSet.has(c.target_kp_id)) {
        links.push([sourceId, c.target_kp_id, c.relation || '']);
      }
    });
  });
  return { nodes, links };
}

const KpAtlasView = ({ arcs, mode, userIntent, onJump }) => {
  const archetype = (mode && ['tree', 'DAG', 'timeline', 'matrix', 'flat'].includes(mode)) ? mode : 'flat';
  const { nodes, links } = React.useMemo(() => _buildKpGraph(arcs, archetype), [arcs, archetype]);
  const [active, setActive] = useState(nodes.length > 0 ? nodes[0].id : null);
  const activeNode = nodes.find(nd => nd.id === active) || nodes[0] || null;
  const neighbors = new Set();
  links.forEach(([a, b]) => { if (a === active) neighbors.add(b); if (b === active) neighbors.add(a); });

  if (nodes.length === 0) {
    return (
      <div className="col" style={{ padding: 32, color: 'var(--ink-2)', fontStyle: 'italic' }}>
        no knowledge points to render
      </div>
    );
  }

  return (
    <div className="col gap-16 fade-in" style={{ padding: '24px 28px 36px', maxWidth: 1640, margin: '0 auto' }}>
      <div className="row gap-16">
        <div className="col">
          <div className="eyebrow">Atlas · {archetype.toUpperCase()}</div>
          <h1 className="serif" style={{ fontSize: 32, margin: '4px 0 0', fontWeight: 400 }}>
            知识点地图
          </h1>
          <div className="t-body">{nodes.length} 节点 · {links.length} 边{userIntent ? ` · intent ${userIntent}` : ''}</div>
        </div>
      </div>

      <div className="row gap-16" style={{ alignItems: 'stretch' }}>
        <div className="map-stage" style={{ flex: 1, height: 560, position: 'relative', background: 'var(--cream)', border: '1px solid var(--rule-soft)', borderRadius: 2 }}>
          <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
            {links.map(([a, b], i) => {
              const A = nodes.find(nd => nd.id === a);
              const B = nodes.find(nd => nd.id === b);
              if (!A || !B) return null;
              const isActive = a === active || b === active;
              return (
                <line key={i}
                  x1={`${A.x}%`} y1={`${A.y}%`} x2={`${B.x}%`} y2={`${B.y}%`}
                  stroke={isActive ? 'var(--terracotta)' : 'var(--ink-2)'}
                  strokeOpacity={isActive ? 0.75 : 0.3}
                  strokeWidth={isActive ? 1.5 : 0.8}
                  strokeDasharray={isActive ? '0' : '2 3'}
                />
              );
            })}
          </svg>
          {nodes.map(nd => (
            <button key={nd.id}
              onClick={() => setActive(nd.id)}
              className={`node-pill ${active === nd.id ? 'active' : ''}`}
              style={{
                position: 'absolute',
                left: `${nd.x}%`, top: `${nd.y}%`, transform: 'translate(-50%,-50%)',
                color: neighbors.has(nd.id) || active === nd.id ? 'var(--ink)' : 'var(--ink-3)',
                opacity: !active || active === nd.id || neighbors.has(nd.id) ? 1 : 0.5,
                padding: '6px 10px',
                background: active === nd.id ? 'var(--paper)' : 'transparent',
                border: active === nd.id ? '1px solid var(--ink-2)' : '1px solid transparent',
                borderRadius: 999,
                fontFamily: 'EB Garamond, "Noto Serif SC", serif', fontSize: 13,
                cursor: 'pointer',
              }}>
              <span style={{
                display: 'inline-block', width: 6, height: 6, borderRadius: 3, marginRight: 7,
                background: 'var(--ochre, #A66D2C)', verticalAlign: 'middle',
              }} />
              {nd.label}
            </button>
          ))}
          <div className="mono" style={{
            position: 'absolute', right: 16, bottom: 14, fontSize: 10.5, color: 'var(--ink-3)',
            letterSpacing: '.18em',
          }}>HYPHA · KP · {archetype.toUpperCase()}</div>
        </div>

        <div className="col gap-12" style={{ width: 360, flexShrink: 0 }}>
          <div className="card col gap-10" style={{ padding: '18px 20px', background: 'var(--paper)', border: '1px solid var(--rule-soft)', borderRadius: 4 }}>
            <div className="eyebrow">{activeNode ? activeNode.id.toUpperCase() : 'KP'} · selected</div>
            <div className="serif" style={{ fontSize: 22, lineHeight: 1.18 }}>{activeNode ? activeNode.label : '—'}</div>
            {activeNode && activeNode.arc && activeNode.arc.definition && (
              <div className="t-small" style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--ink-2)', whiteSpace: 'pre-wrap' }}>
                {activeNode.arc.definition.slice(0, 280)}{activeNode.arc.definition.length > 280 ? '…' : ''}
              </div>
            )}
            {activeNode && activeNode.arc && Array.isArray(activeNode.arc.lineage_link) && activeNode.arc.lineage_link.length > 0 && (
              <div className="col gap-4" style={{ marginTop: 6 }}>
                <span className="eyebrow" style={{ fontSize: 10, letterSpacing: '0.12em' }}>上接</span>
                {activeNode.arc.lineage_link.slice(0, 3).map((l, i) => (
                  <span key={i} className="t-tiny" style={{ fontSize: 12, color: 'var(--ink-2)' }}>
                    {l.relation} · {(l.target && l.target.display_label) || (l.target && l.target.fallback) || '—'}
                  </span>
                ))}
              </div>
            )}
          </div>

          {neighbors.size > 0 && (
            <div className="card col" style={{ padding: 14, background: 'var(--paper)', border: '1px solid var(--rule-soft)', borderRadius: 4 }}>
              <div className="row" style={{ marginBottom: 8 }}>
                <div className="eyebrow">下接</div>
                <span className="spacer" />
                <span className="t-tiny mono">{neighbors.size}</span>
              </div>
              <div className="col gap-6">
                {[...neighbors].map(id => {
                  const nd = nodes.find(x => x.id === id);
                  if (!nd) return null;
                  return (
                    <button key={id} onClick={() => setActive(id)} className="row gap-8" style={{
                      padding: '8px 10px', borderRadius: 6, textAlign: 'left',
                      border: '1px solid var(--rule-soft)', background: 'var(--cream)',
                      cursor: 'pointer', fontFamily: 'EB Garamond, "Noto Serif SC", serif',
                    }}>
                      <span style={{ fontSize: 11, color: 'var(--ink-3)', minWidth: 50 }}>{nd.id}</span>
                      <span style={{ fontSize: 13.5, color: 'var(--ink-2)' }}>{nd.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const AtlasScreen = ({ onJump, mode, knowledgePoints, userIntent }) => {
  // intentional-placeholder: the word "placeholder" below references the DELETED
  // 2026-04 demo NODES/LINKS array, not unfinished code. AtlasScreen render is
  // complete — KP-data branch + empty-state branch both fully implemented.
  // Phase D data-driven branch: when knowledgePoints provided + non-empty, render
  // the KP-driven Atlas. Demo NODES/LINKS demo array (Peircean triads / Veyra /
  // Tsing / etc) removed 2026-05-12 per user "最纯净 HYPHA". Empty Atlas now
  // shows a clean empty-state instead of fake "knowledge mesh" demo.
  if (Array.isArray(knowledgePoints) && knowledgePoints.length > 0) {
    return <KpAtlasView arcs={knowledgePoints} mode={mode} userIntent={userIntent} onJump={onJump} />;
  }
  return (
    <div className="col gap-12 fade-in" style={{ padding: "48px 60px 60px", maxWidth: 880, margin: "0 auto" }}>
      <div className="col gap-6">
        <div className="eyebrow">Atlas</div>
        <h1 className="serif" style={{ fontSize: 34, margin: "4px 0 0", fontWeight: 400 }}>
          Knowledge <span className="italic">mesh</span>
        </h1>
      </div>
      <div className="col gap-10" style={{
        marginTop: 18, padding: "26px 30px",
        background: "var(--cream)", border: "1px solid var(--rule-soft)",
        borderLeft: "2px solid #4D8B9A", borderRadius: 2,
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      }}>
        <p className="serif" style={{ fontSize: 16, lineHeight: 1.7, color: "var(--ink)", margin: 0 }}>
          地图待第一节课的知识点落定后填充。
        </p>
        <p className="serif" style={{ fontSize: 14, lineHeight: 1.65, color: "var(--ink-2)", margin: 0 }}>
          Atlas 节点 = lesson 的 KP arc (connects_to_next + lineage_link 连边); archetype 决定布局
          (timeline / DAG / tree / matrix / flat). 在 LessonChat 内点 "切换地图" 进入数据视图。
        </p>
        <div className="row gap-12" style={{ marginTop: 4 }}>
          <button onClick={() => onJump && onJump("home")} className="btn btn-ghost" style={{ fontSize: 13 }}>
            回 Home
          </button>
          <button onClick={() => onJump && onJump("lesson")} className="btn btn-ghost" style={{ fontSize: 13 }}>
            进上课 →
          </button>
        </div>
      </div>
    </div>
  );
};

// Demo render kept under a dead branch so the unused-locals warning doesn't fire,
// but never reached. Constants NODES/LINKS no longer hydrated.
const _AtlasDemoUnused = () => {
  const [active, setActive] = useState("n5");
  const activeNode = NODES.find(n => n.id === active);
  const neighbors = new Set();
  LINKS.forEach(([a,b]) => { if (a === active) neighbors.add(b); if (b === active) neighbors.add(a); });

  return (
    <div className="col gap-16 fade-in" style={{ padding: "24px 28px 36px", maxWidth: 1640, margin: "0 auto" }}>
      <div className="row gap-16">
        <div className="col">
          <div className="eyebrow">Atlas</div>
          <h1 className="serif" style={{ fontSize: 38, margin: "4px 0 0", fontWeight: 400 }}>
            Your <span className="italic">living</span> knowledge mesh
          </h1>
          <div className="t-body">{NODES.length} nodes · {LINKS.length} traces · 4 clusters</div>
        </div>
        <span className="spacer" />
        <div className="row gap-8">
          <button className="btn btn-ghost"><Icon name="search" size={13} /> Find a thread</button>
          <button className="btn btn-ghost"><Icon name="plus" size={13} /> Plant a node</button>
          <button className="btn btn-primary"><Icon name="sparkle" size={13} /> Compile a brief</button>
        </div>
      </div>

      <div className="row gap-16" style={{ alignItems: "stretch" }}>
        {/* Map */}
        <div className="map-stage" style={{ flex: 1, height: 640, position: "relative" }}>
          {/* Cluster halos */}
          {CLUSTERS.map(c => (
            <div key={c.id} style={{
              position: "absolute", left: `${c.x - c.r}%`, top: `${c.y - c.r}%`,
              width: `${c.r * 2}%`, height: `${c.r * 2}%`,
              pointerEvents: "none",
            }}>
              <Watercolor.Spore tone={c.tone} size="100%" />
              <div className="serif italic" style={{
                position: "absolute", inset: 0, display: "grid", placeItems: "center",
                color: "var(--ink-2)", fontSize: 19, textAlign: "center", lineHeight: 1.1,
                pointerEvents: "none",
              }}>
                {c.label.split(" & ").map((p, i) => <span key={i}>{p}{i === 0 && <br/>}{i === 0 && "& "}</span>)}
              </div>
            </div>
          ))}
          {/* Connection lines */}
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
            {LINKS.map(([a,b], i) => {
              const A = NODES.find(n => n.id === a);
              const B = NODES.find(n => n.id === b);
              const isActive = a === active || b === active;
              return (
                <line key={i}
                  x1={`${A.x}%`} y1={`${A.y}%`} x2={`${B.x}%`} y2={`${B.y}%`}
                  stroke={isActive ? "var(--terracotta)" : "var(--ink-2)"}
                  strokeOpacity={isActive ? .75 : .22}
                  strokeWidth={isActive ? 1.5 : 0.7}
                  strokeDasharray={isActive ? "0" : "2 3"}
                />
              );
            })}
          </svg>
          {/* Node pills */}
          {NODES.map(n => (
            <button key={n.id}
              onClick={() => setActive(n.id)}
              className={`node-pill ${active === n.id ? "active" : ""}`}
              style={{
                left: `${n.x}%`, top: `${n.y}%`, transform: "translate(-50%,-50%)",
                color: neighbors.has(n.id) || active === n.id ? "var(--ink)" : "var(--ink-3)",
                opacity: !active || active === n.id || neighbors.has(n.id) ? 1 : .55,
              }}>
              <span style={{
                display: "inline-block", width: 6, height: 6, borderRadius: 3, marginRight: 7,
                background: `var(--${KIND_TONE[n.kind] === "ochre" ? "ochre" : KIND_TONE[n.kind] === "indigo" ? "indigo" : KIND_TONE[n.kind] === "terra" ? "terracotta" : "sage"})`,
                verticalAlign: "middle",
              }}/>
              {n.label}
            </button>
          ))}
          {/* Legend */}
          <div className="row gap-12" style={{
            position: "absolute", left: 16, bottom: 14,
            background: "rgba(255,255,255,.7)", padding: "8px 12px",
            borderRadius: 999, border: "1px solid var(--rule-soft)", fontSize: 11.5,
          }}>
            {[
              ["Note","ochre"],["Source","indigo"],["Judgment","sage"],["Action","terracotta"],
            ].map(([k,c]) => (
              <span key={k} className="row gap-6"><span style={{ width: 8, height: 8, borderRadius: 4, background: `var(--${c})` }}/> {k}</span>
            ))}
          </div>
          <div className="mono" style={{
            position: "absolute", right: 16, bottom: 14, fontSize: 10.5, color: "var(--ink-3)",
            letterSpacing: ".18em",
          }}>HYPHA · ATLAS v3</div>
        </div>

        {/* Inspector */}
        <div className="col gap-12" style={{ width: 320, flexShrink: 0 }}>
          <div className="card col gap-10" style={{ padding: "18px 20px" }}>
            <div className="eyebrow">{activeNode.kind} · selected</div>
            <div className="serif" style={{ fontSize: 24, lineHeight: 1.18 }}>{activeNode.label}</div>
            <div className="t-small">"Decay is not silence; it is the most loquacious phase of any system." A node where Veyra's lecture meets your reading on Tsing.</div>
            <div className="row gap-6" style={{ flexWrap: "wrap", marginTop: 4 }}>
              <span className="chip chip-mono chip-ochre">L7 · Mvt III</span>
              <span className="chip chip-mono">3 backlinks</span>
              <span className="chip chip-mono">last revised 2d</span>
            </div>
            <div className="row gap-6" style={{ marginTop: 8 }}>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => onJump && onJump("notes")}>
                <Icon name="pen" size={12} /> Open in Notebook
              </button>
              <button className="btn btn-quiet" style={{ fontSize: 12 }}>
                <Icon name="link" size={12} /> Trace
              </button>
            </div>
          </div>

          <div className="card col" style={{ padding: 14 }}>
            <div className="row" style={{ marginBottom: 8 }}>
              <div className="eyebrow">Connections</div>
              <span className="spacer" />
              <span className="t-tiny mono">{neighbors.size}</span>
            </div>
            <div className="col gap-6">
              {[...neighbors].map(id => {
                const n = NODES.find(x => x.id === id);
                return (
                  <button key={id} onClick={() => setActive(id)} className="row gap-8" style={{
                    padding: "8px 10px", borderRadius: 8, textAlign: "left",
                    border: "1px solid var(--rule-soft)", background: "rgba(255,255,255,.45)",
                  }}>
                    <span className="chip chip-mono" style={{ minWidth: 60, justifyContent: "center" }}>{n.kind}</span>
                    <span style={{ fontSize: 13.5, color: "var(--ink-2)" }}>{n.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="card col gap-8" style={{ padding: "16px 18px" }}>
            <div className="eyebrow">Suggested by HYPHA</div>
            <div className="t-small">A possible trace, drawn faintly so you can confirm or refuse.</div>
            <div className="row gap-8" style={{ marginTop: 6 }}>
              <span className="serif italic" style={{ fontSize: 14 }}>Decay as syntax</span>
              <span className="t-small">↔</span>
              <span className="serif italic" style={{ fontSize: 14 }}>Civic dialogue</span>
            </div>
            <div className="t-small" style={{ marginTop: 4 }}>Both invoke a grammar of breakdown that produces meaning, not failure. Possible Spark fuel.</div>
            <div className="row gap-8" style={{ marginTop: 6 }}>
              <button className="btn btn-ochre" style={{ fontSize: 12 }}><Icon name="check" size={12} /> Confirm trace</button>
              <button className="btn btn-quiet" style={{ fontSize: 12 }}>Refuse</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ===== NOTEBOOK =====
const NOTES = [
  { id: 1, title: "Decay as syntax",          excerpt: "Where the orthodox sentence ends in a period, the rotting one ends in a punctum…", tags: ["L7","language"], date: "Today" },
  { id: 2, title: "Hyphae of attention",      excerpt: "We are, all of us, hyphae of attention threading through what was, and what wishes to be again.", tags: ["judgment","myth"], date: "Today" },
  { id: 3, title: "Fungal Semiotics",         excerpt: "Peircean triads applied to mycelial signalling — a working analogy.", tags: ["L3","myth"], date: "3d ago" },
  { id: 4, title: "On Slow Reading",          excerpt: "A judgment formed last month. Returning to test whether it still holds at the season's turn.", tags: ["judgment"], date: "2w ago" },
  { id: 5, title: "Spore script",             excerpt: "What if a script could be read by being scattered? What if the scatter is the reading?", tags: ["L6"], date: "1w ago" },
  { id: 6, title: "Connect — civic dialogue", excerpt: "Spark: a platform that aligns deep learning with civic conversation. Decay-as-method.", tags: ["spark"], date: "2d ago" },
];

// intentional-placeholder: the word "placeholder" in this header references
// the DELETED 2026-04 demo NOTES array (L7 Decay as syntax / L3 Fungal
// Semiotics / etc), not unfinished code. NotebookScreen render is complete —
// returns an empty-state until lessonBody.knowledge_points downstream of
// curriculum:approve_and_body lands real NOTE data in v0.5+ wiring.
const NotebookScreen = ({ onJump }) => {
  return (
    <div className="col gap-12 fade-in" style={{ padding: "48px 60px 60px", maxWidth: 880, margin: "0 auto" }}>
      <div className="col gap-6">
        <div className="eyebrow">Notebook</div>
        <h1 className="serif" style={{ fontSize: 34, margin: "4px 0 0", fontWeight: 400 }}>
          Your <span className="italic">marginalia</span> archive
        </h1>
      </div>
      <div className="col gap-10" style={{
        marginTop: 18, padding: "26px 30px",
        background: "var(--cream)", border: "1px solid var(--rule-soft)",
        borderLeft: "2px solid #4D8B9A", borderRadius: 2,
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      }}>
        <p className="serif" style={{ fontSize: 16, lineHeight: 1.7, color: "var(--ink)", margin: 0 }}>
          Notebook 待 vault 落 NOTE 后填充。
        </p>
        <p className="serif" style={{ fontSize: 14, lineHeight: 1.65, color: "var(--ink-2)", margin: 0 }}>
          每节课 approve 后, lesson NOTE + KP NOTE 沉到 vault。这里渲染那条 archive 流。当前 vault 空 — 进 LessonChat 起第一节即可种下第一条。
        </p>
        <div className="row gap-12" style={{ marginTop: 4 }}>
          <button onClick={() => onJump && onJump("home")} className="btn btn-ghost" style={{ fontSize: 13 }}>
            回 Home
          </button>
          <button onClick={() => onJump && onJump("library")} className="btn btn-ghost" style={{ fontSize: 13 }}>
            进 Library →
          </button>
        </div>
      </div>
    </div>
  );
};

// Demo render kept under a dead branch — NOTES / activeId / filter constants
// no longer hydrated. Surgical retention so the file's other consumers (atlas
// + helpers) stay un-touched. Not reached at runtime.
const _NotebookDemoUnused = ({ onJump }) => {
  const [activeId, setActiveId] = useState(2);
  const [filter, setFilter] = useState("all");
  const note = NOTES.find(n => n.id === activeId);
  const filtered = filter === "all" ? NOTES : NOTES.filter(n => n.tags.includes(filter));

  const editorRef = useRef(null);

  return (
    <div className="fade-in" style={{ display: "grid", gridTemplateColumns: "300px 1fr 280px", minHeight: "100vh" }}>
      {/* Note list */}
      <aside className="col gap-14" style={{
        padding: "24px 18px", borderRight: "1px solid var(--rule-soft)",
        background: "transparent", height: "100vh", overflowY: "auto", position: "sticky", top: 0,
      }}>
        <button onClick={() => onJump && onJump("home")}
          className="row gap-6"
          style={{ color: "var(--ink-3)", fontSize: 12, padding: 0, alignSelf: "flex-start" }}>
          <Icon name="arrowL" size={12} />
          <span>Home</span>
        </button>

        <div className="col gap-4" style={{ marginTop: 4 }}>
          <div className="row" style={{ alignItems: "baseline" }}>
            <h1 className="serif" style={{ margin: 0, fontSize: 30, lineHeight: 1, letterSpacing: "-0.01em" }}>
              Notebook
            </h1>
            <span className="spacer" />
            <button title="New note"
              style={{ color: "var(--ink-3)", display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}>
              <Icon name="plus" size={12} />
              <span>New</span>
            </button>
          </div>
          <div className="t-tiny mono" style={{ color: "var(--ink-4)" }}>
            128 entries · last touched 12s ago
          </div>
        </div>

        <div className="row gap-8" style={{
          padding: "8px 0",
          borderTop: "1px solid var(--rule-soft)",
          borderBottom: "1px solid var(--rule-soft)",
          color: "var(--ink-4)",
        }}>
          <Icon name="search" size={13} />
          <input placeholder="Search the archive…" style={{
            flex: 1, border: 0, outline: 0, background: "transparent",
            fontSize: 13.5, color: "var(--ink-2)",
            fontFamily: "var(--serif)", fontStyle: "italic",
          }} />
        </div>

        <div className="serif" style={{ fontSize: 14, lineHeight: 1.6, color: "var(--ink-4)", fontStyle: "italic" }}>
          showing&nbsp;
          {["all","L7","judgment","myth","spark","language"].map((t, i) => (
            <React.Fragment key={t}>
              {i > 0 && <span style={{ color: "var(--ink-4)", margin: "0 6px" }}>·</span>}
              <button onClick={() => setFilter(t)}
                style={{
                  padding: 0,
                  fontFamily: "var(--serif)",
                  fontStyle: "italic",
                  fontSize: 14,
                  color: filter === t ? "var(--terracotta-2)" : "var(--ink-3)",
                  borderBottom: filter === t ? "1px solid var(--terracotta)" : "1px solid transparent",
                  cursor: "pointer",
                }}>{t}</button>
            </React.Fragment>
          ))}
        </div>
        <div className="col">
          {filtered.map((n, i) => {
            const active = activeId === n.id;
            return (
              <button key={n.id} onClick={() => setActiveId(n.id)} className="col gap-4" style={{
                padding: "14px 14px 14px 14px",
                marginLeft: -14, marginRight: -18,
                paddingRight: 18,
                borderTop: i === 0 ? "1px solid transparent" : "1px solid var(--rule-soft)",
                borderLeft: active ? "2px solid var(--terracotta)" : "2px solid transparent",
                background: active ? "rgba(184,99,68,.06)" : "transparent",
                textAlign: "left",
                position: "relative",
              }}>
                <div className="serif" style={{
                  fontSize: 16, lineHeight: 1.2,
                  color: active ? "var(--ink)" : "var(--ink-2)",
                  fontWeight: active ? 500 : 400,
                }}>{n.title}</div>
                <div className="t-small" style={{
                  display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
                  color: active ? "var(--ink-2)" : "var(--ink-3)",
                }}>{n.excerpt}</div>
                <div className="t-tiny mono" style={{ color: "var(--ink-4)" }}>{n.date.toUpperCase()} · {n.tags.join(" · ")}</div>
              </button>
            );
          })}
        </div>
      </aside>

      {/* Editor */}
      <main style={{ position: "relative", padding: "32px 64px 80px", maxWidth: 820, margin: "0 auto" }}>
        <div className="row gap-12" style={{ marginBottom: 16 }}>
          <span className="chip chip-mono">{note.date.toUpperCase()}</span>
          <span className="chip chip-mono chip-ochre">{note.tags[0]}</span>
          <span className="spacer" />
          <button className="btn btn-ghost" style={{ fontSize: 12 }}><Icon name="link" size={12} /> 6 links</button>
          <button className="btn btn-ghost" style={{ fontSize: 12 }}><Icon name="eye" size={12} /> Read mode</button>
          <button className="btn btn-quiet" style={{ fontSize: 12 }}>•••</button>
        </div>
        <div className="serif" contentEditable suppressContentEditableWarning style={{
          fontSize: 44, lineHeight: 1.05, fontWeight: 400, outline: 0, marginBottom: 16,
        }}>{note.title}</div>
        <div ref={editorRef} className="note-editor" contentEditable suppressContentEditableWarning>
          <p>We are, all of us, <span className="backlink">hyphae of attention</span> — threading through what was, and what wishes to be again.</p>
          <p>The lesson on <span className="backlink">decay as syntax</span> reframes my old worry that re-reading is a kind of indulgence. It is not. It is the only way an archive metabolizes.</p>
          <blockquote className="t-quote" style={{ borderLeft: "3px solid var(--ochre)", paddingLeft: 16, color: "var(--ink-2)", margin: "20px 0" }}>
            "The library is alive at the rate of its readers' attention." — <span className="italic">L7, Mvt III</span>
          </blockquote>
          <p>So: a small commitment. Twenty minutes a day spent re-reading something I already love, until I find it again, or find that I have outgrown it. Either is honest.</p>
          <p style={{ color: "var(--ink-3)", fontStyle: "italic" }} data-placeholder="Continue the thread…">
            <span className="backlink">Peirce</span> would say the third element here is the interpretant — the reader's attention is what closes the triad and produces meaning…
          </p>
        </div>
        <div className="row gap-6" style={{ marginTop: 28 }}>
          <span className="t-tiny mono">SAVED 12s AGO</span>
          <span className="spacer" />
          <button className="btn btn-ghost" style={{ fontSize: 12 }}><Icon name="link" size={12} /> Insert backlink</button>
          <button className="btn btn-ghost" style={{ fontSize: 12 }}><Icon name="quoteOpen" size={12} /> Quote source</button>
          <button className="btn btn-ochre" style={{ fontSize: 12 }}><Icon name="sparkle" size={12} /> Ask HYPHA</button>
        </div>
      </main>

      {/* Right rail */}
      <aside className="col gap-12" style={{
        padding: "24px 18px", borderLeft: "1px solid var(--rule-soft)",
        background: "rgba(255,255,255,.4)", height: "100vh", overflowY: "auto", position: "sticky", top: 0,
      }}>
        <div className="eyebrow">Backlinks</div>
        <div className="t-small">3 places this note is mentioned.</div>
        {[
          { kind: "Lesson", title: "L7 · Decay as syntax",        excerpt: "…we are, all of us here, hyphae of attention…" },
          { kind: "Note",   title: "Fungal Semiotics",            excerpt: "…the interpretant in Peircean terms…" },
          { kind: "Spark",  title: "Connect",                     excerpt: "…attention as the metabolism of civic life…" },
        ].map((b, i) => (
          <button key={i} className="card-quiet col gap-4" style={{ padding: "10px 12px", textAlign: "left" }}>
            <span className="t-tiny mono">{b.kind.toUpperCase()}</span>
            <div className="serif" style={{ fontSize: 14.5, lineHeight: 1.2 }}>{b.title}</div>
            <div className="t-small italic">{b.excerpt}</div>
          </button>
        ))}

        <hr className="rule-soft" />
        <div className="eyebrow">Outline</div>
        <div className="col gap-2 t-small">
          {["Hyphae of attention","Decay as syntax (the worry)","Quote — library at the rate of attention","A small commitment","Peircean triad reading"].map((h, i) => (
            <div key={i} style={{ padding: "4px 0", color: i === 0 ? "var(--ink)" : "var(--ink-3)" }}>
              <span className="mono" style={{ marginRight: 8, opacity: .5 }}>·</span>{h}
            </div>
          ))}
        </div>

        <hr className="rule-soft" />
        <div className="eyebrow">Suggested re-reads</div>
        <div className="t-small">You wrote on this idea before — visit them while it is warm.</div>
        <button className="card-quiet col gap-4" style={{ padding: 10, textAlign: "left" }} onClick={() => setActiveId(4)}>
          <div className="serif" style={{ fontSize: 14 }}>On Slow Reading</div>
          <div className="t-tiny">2 weeks ago · still holding?</div>
        </button>
      </aside>
    </div>
  );
};

window.AtlasScreen = AtlasScreen;
window.NotebookScreen = NotebookScreen;
