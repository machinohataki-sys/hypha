/* global React, Icon, Watercolor */
// Shared UI components

const { useState, useEffect, useRef } = React;

// ===== Brand =====
const Brand = ({ compact = false }) =>
<div className="row gap-12" style={{ alignItems: "center" }}>
    <Watercolor.BrandMark size={compact ? 24 : 30} />
    <div className="col" style={{ lineHeight: 1 }}>
      <div className="serif" style={{
      fontSize: compact ? 18 : 22, letterSpacing: ".22em", fontWeight: 500
    }}>HYPHA</div>
      {!compact && <div className="t-tiny mono" style={{ marginTop: 5, letterSpacing: ".22em" }}>A PRIVATE UNIVERSITY</div>}
    </div>
  </div>;


// ===== Sidebar nav =====
const NAV = [
{ id: "home", label: "Home", glyph: "home" },
{ id: "library", label: "Library", glyph: "book" },
{ id: "lesson", label: "Lesson", glyph: "compass" },
{ id: "map", label: "Atlas", glyph: "map" },
{ id: "notes", label: "Notebook", glyph: "note" },
{ id: "sparks", label: "Workshop", glyph: "spark" }];


const Sidebar = ({ route, setRoute, arc, openCmd }) =>
<aside className="sidebar">
    <div style={{ padding: "0 6px 4px" }}><Brand /></div>

    <button className="row gap-8" onClick={openCmd} style={{
    margin: "0 4px", padding: "8px 12px",
    border: "1px solid var(--rule)", borderRadius: 999,
    background: "rgba(255,255,255,.5)", color: "var(--ink-3)",
    fontSize: "12.5px", justifyContent: "flex-start"
  }}>
      <Icon name="search" size={14} />
      <span>Search anything…</span>
      <span className="spacer" />
    </button>

    <nav className="col gap-4" style={{ padding: "0 0" }}>
      {NAV.map((n) =>
    <button key={n.id}
    className={`nav-item ${route === n.id ? "active" : ""}`}
    onClick={() => setRoute(n.id)}>
          <span className="nav-glyph"><Icon name={n.glyph} size={18} /></span>
          <span>{n.label}</span>
          {route === n.id && <span className="spacer" />}
          {route === n.id && <Icon name="dot" size={6} stroke={2} />}
        </button>
    )}
    </nav>

    <div className="col gap-8" style={{ marginTop: "auto", padding: "0 6px" }}>
      <hr className="rule-soft" />
      <div className="eyebrow">Current Arc</div>
      <div className="serif" style={{ fontSize: 17, lineHeight: 1.2 }}>{arc.title}</div>
      <div className="bar" style={{ marginTop: 6 }}><i style={{ width: `${arc.progress}%` }} /></div>
      <div className="t-tiny">{arc.completed} of {arc.total} lessons · {arc.progress}%</div>

      <hr className="rule-soft" />
      <div className="row" style={{ alignItems: "center", gap: 14 }}>
        <div style={{
        width: 30, height: 30, borderRadius: "50%",
        border: "1px solid var(--ochre)",
        background: "var(--paper)",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        fontFamily: "var(--serif)", fontStyle: "italic",
        fontSize: 16, color: "var(--terracotta-2)",
        letterSpacing: "-0.02em",
        flexShrink: 0
      }}>D</div>
        <div className="col" style={{ lineHeight: 1.2, minWidth: 0 }}>
          <div className="serif" style={{ fontSize: 14, color: "var(--ink)" }}>Daria</div>
          <div className="t-tiny mono" style={{ color: "var(--ink-4)", letterSpacing: ".06em", fontFamily: "Lato" }}>matriculated · MMXXIV</div>
        </div>
        <span className="spacer" />
      </div>
    </div>
  </aside>;


// ===== Topbar (alternate layout) =====
const Topbar = ({ route, setRoute, openCmd }) =>
<header className="topbar">
    <Brand compact />
    <nav className="row gap-4" style={{ marginLeft: 8 }}>
      {NAV.map((n) =>
    <button key={n.id}
    className={`nav-item ${route === n.id ? "active" : ""}`}
    style={{ padding: "6px 12px" }}
    onClick={() => setRoute(n.id)}>
          <span>{n.label}</span>
        </button>
    )}
    </nav>
    <span className="spacer" />
    <button className="search" onClick={openCmd} style={{ minWidth: 320 }}>
      <Icon name="search" size={14} />
      <span style={{ flex: 1, textAlign: "left" }}>Search anything…</span>
    </button>
    <button className="btn-square" title="Notifications">
      <Icon name="bell" size={15} />
    </button>
    <div className="avatar" style={{ width: 32, height: 32, fontSize: 15 }}>D</div>
  </header>;


// ===== Yield badge (Evidence/Judgment/Action/Work) =====
const YIELD_META = {
  evidence: { label: "Evidence", icon: "flask", desc: "Cited passages & primary sources" },
  judgment: { label: "Judgment", icon: "gavel", desc: "Your stance, distilled" },
  action: { label: "Action", icon: "bolt", desc: "An experiment to run this week" },
  work: { label: "Work", icon: "pen", desc: "An artefact you ship" }
};

const YieldDot = ({ kind, size = 28 }) => {
  const m = YIELD_META[kind];
  return (
    <div className={`yield-${kind}`} style={{
      width: size, height: size, borderRadius: 8,
      background: "var(--y-soft)",
      color: "var(--y-fill)",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0
    }} title={m.label}>
      <Icon name={m.icon} size={Math.round(size * 0.55)} />
    </div>);

};

// ===== Command palette =====
const COMMANDS = [];


const CommandPalette = ({ open, onClose, onJump }) => {
  const [q, setQ] = useState("");
  const ref = useRef();
  useEffect(() => {if (open) setTimeout(() => ref.current?.focus(), 50);else setQ("");}, [open]);
  if (!open) return null;
  const filtered = COMMANDS.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()) || c.kind.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="fade-in" style={{
      position: "fixed", inset: 0, zIndex: 60,
      background: "rgba(20,18,12,.35)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "12vh"
    }} onClick={onClose}>
      <div className="card rise-in" onClick={(e) => e.stopPropagation()} style={{
        width: "min(640px, 92vw)", padding: 0, overflow: "hidden",
        boxShadow: "0 30px 60px rgba(0,0,0,.25)"
      }}>
        <div className="row gap-12" style={{ padding: "16px 18px", borderBottom: "1px solid var(--rule-soft)" }}>
          <Icon name="search" size={16} />
          <input ref={ref} value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search lessons, notes, sources, sparks…"
          style={{ flex: 1, border: 0, outline: 0, background: "transparent", fontSize: 16 }} />
          <kbd className="mono" style={{
            border: "1px solid var(--rule)", borderRadius: 4,
            padding: "1px 5px", fontSize: 10, color: "var(--ink-3)"
          }}>esc</kbd>
        </div>
        <div style={{ maxHeight: "44vh", overflowY: "auto", padding: 6 }}>
          {filtered.length === 0 && <div className="t-small" style={{ padding: 24, textAlign: "center" }}>No results — try "decay", "myth", "spore"</div>}
          {filtered.map((c, i) =>
          <button key={i} onClick={() => {onJump(c);onClose();}}
          className="row gap-12" style={{
            width: "100%", padding: "10px 14px", borderRadius: 8,
            background: "transparent", textAlign: "left"
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = "rgba(0,0,0,.04)"}
          onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
              <Icon name={c.icon} size={15} />
              <span style={{ flex: 1, fontSize: 14 }}>{c.label}</span>
              <span className="chip chip-mono">{c.kind}</span>
            </button>
          )}
        </div>
        <div className="row gap-16" style={{ padding: "10px 16px", borderTop: "1px solid var(--rule-soft)", color: "var(--ink-3)", fontSize: 11.5 }}>
          <span><kbd className="mono">↑↓</kbd> navigate</span>
          <span><kbd className="mono">↵</kbd> open</span>
          <span className="spacer" />
          <span className="mono" style={{ letterSpacing: ".18em" }}>HYPHA · COMMAND</span>
        </div>
      </div>
    </div>);

};

Object.assign(window, { Brand, Sidebar, Topbar, YIELD_META, YieldDot, CommandPalette, NAV });