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

const AtlasScreen = ({ onJump }) => {
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

const NotebookScreen = ({ onJump }) => {
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
