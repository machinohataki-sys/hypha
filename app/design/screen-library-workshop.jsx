/* global React, Icon, Watercolor, YieldDot, YIELD_META */
// HYPHA · Library + Workshop (Sparks) + Onboarding

const { useState, useEffect } = React;

// ===== LIBRARY =====
const SHELF = [
{ id: "s1", title: "Mythical Grammar and the Poetics of Entanglement", author: "L. Veyra", year: 2019, tone: "ochre", type: "Treatise", hl: 14, status: "reading" },
{ id: "s2", title: "The Mushroom at the End of the World", author: "A. Tsing", year: 2015, tone: "indigo", type: "Field Study", hl: 22, status: "reading" },
{ id: "s3", title: "Archive Fever", author: "J. Derrida", year: 1995, tone: "terra", type: "Essay", hl: 8, status: "queued" },
{ id: "s4", title: "The Origin of Tragedy", author: "F. Nietzsche", year: 1872, tone: "sage", type: "Treatise", hl: 31, status: "read" },
{ id: "s5", title: "On Photography", author: "S. Sontag", year: 1977, tone: "plum", type: "Essays", hl: 5, status: "queued" },
{ id: "s6", title: "The Poetics of Space", author: "G. Bachelard", year: 1958, tone: "indigo", type: "Treatise", hl: 19, status: "read" },
{ id: "s7", title: "Lectures on the Will to Know", author: "M. Foucault", year: 1971, tone: "ochre", type: "Lectures", hl: 11, status: "queued" },
{ id: "s8", title: "The Order of Time", author: "C. Rovelli", year: 2017, tone: "terra", type: "Essay", hl: 9, status: "reading" }];


const LibraryScreen = () => {
  const [view, setView] = useState("shelf");
  const [active, setActive] = useState("s1");
  const book = SHELF.find((b) => b.id === active);
  return (
    <div className="col gap-20 fade-in" style={{ padding: "24px 36px 48px", maxWidth: 1640, margin: "0 auto" }}>
      <div className="row gap-16">
        <div className="col">
          <div className="eyebrow">Library</div>
          <h1 className="serif" style={{ fontSize: 38, margin: "4px 0 0", fontWeight: 400 }}>
            Sources you keep <span className="italic">close</span>
          </h1>
          <div className="t-body">{SHELF.length} primary works · 132 highlights · 41 marginalia</div>
        </div>
        <span className="spacer" />
        <div className="row gap-6">
          <button className={`chip chip-mono ${view === "shelf" ? "chip-ochre" : ""}`} onClick={() => setView("shelf")}>Shelf</button>
          <button className={`chip chip-mono ${view === "table" ? "chip-ochre" : ""}`} onClick={() => setView("table")}>Index</button>
          <button className={`chip chip-mono ${view === "high" ? "chip-ochre" : ""}`} onClick={() => setView("high")}>Highlights</button>
        </div>
        <button className="btn btn-primary"><Icon name="plus" size={13} /> Add a source</button>
      </div>

      <div className="row gap-20" style={{ alignItems: "flex-start" }}>
        {/* Main view */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {view === "shelf" &&
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 18 }}>
              {SHELF.map((b) =>
            <button key={b.id} onClick={() => setActive(b.id)} className="col gap-8" style={{
              textAlign: "left",
              padding: 0,
              borderRadius: 14
            }}>
                  <div className="wc-stage" style={{
                position: "relative",
                aspectRatio: "3/4",
                borderRadius: 8,
                overflow: "hidden",
                boxShadow: active === b.id ? "0 0 0 2px var(--terracotta), 0 18px 40px rgba(40,30,15,.18)" : "var(--shadow-1)",
                border: "1px solid var(--rule-soft)",
                background: "var(--paper)",
                transition: "transform .2s, box-shadow .2s"
              }}
              onMouseEnter={(e) => e.currentTarget.style.transform = "translateY(-3px)"}
              onMouseLeave={(e) => e.currentTarget.style.transform = "none"}>
                
                    <div style={{ position: "absolute", inset: 0, opacity: .9 }}>
                      <Watercolor.Wash tone={b.tone} />
                    </div>
                    <div style={{ position: "absolute", inset: "auto 0 0 0", padding: "16px 14px", background: "linear-gradient(0deg, rgba(251,247,237,.96), rgba(251,247,237,0))" }}>
                      <div className="t-tiny mono" style={{ letterSpacing: ".18em" }}>{b.type.toUpperCase()} · {b.year}</div>
                      <div className="serif" style={{ fontSize: 17, lineHeight: 1.15, marginTop: 4 }}>{b.title}</div>
                      <div className="t-small italic" style={{ marginTop: 2 }}>{b.author}</div>
                    </div>
                    {b.status === "reading" &&
                <div style={{ position: "absolute", top: 10, left: 10 }}>
                        <span className="chip chip-mono chip-ochre">Reading</span>
                      </div>
                }
                  </div>
                  <div className="t-tiny mono">{b.hl} HIGHLIGHTS · {b.status.toUpperCase()}</div>
                </button>
            )}
            </div>
          }
          {view === "table" &&
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              {SHELF.map((b, i) =>
            <button key={b.id} onClick={() => setActive(b.id)} className="row gap-16" style={{
              padding: "14px 20px", borderTop: i ? "1px solid var(--rule-soft)" : "none",
              textAlign: "left", width: "100%",
              background: active === b.id ? "rgba(200,146,62,.08)" : "transparent"
            }}>
                  <div className="wc-stage" style={{ width: 36, height: 48, borderRadius: 4, overflow: "hidden", flexShrink: 0 }}>
                    <Watercolor.Wash tone={b.tone} />
                  </div>
                  <div className="col" style={{ flex: 1 }}>
                    <div className="serif" style={{ fontSize: 17 }}>{b.title}</div>
                    <div className="t-small italic">{b.author} · {b.year}</div>
                  </div>
                  <span className="chip chip-mono">{b.type}</span>
                  <span className="t-small mono" style={{ width: 100, textAlign: "right" }}>{b.hl} HIGHLIGHTS</span>
                  <span className={`chip chip-mono ${b.status === "reading" ? "chip-ochre" : b.status === "read" ? "chip-sage" : ""}`} style={{ minWidth: 80, justifyContent: "center" }}>{b.status}</span>
                </button>
            )}
            </div>
          }
          {view === "high" &&
          <div className="col gap-12">
              {[
            { src: "Mythical Grammar", page: "p. 117", quote: "The library is alive at the rate of its readers' attention. Without us, it sleeps. With us, it ferments.", tone: "ochre" },
            { src: "Mushroom at the End", page: "p. 23", quote: "Disturbance is what makes companion species possible — including us.", tone: "indigo" },
            { src: "Archive Fever", page: "p. 9", quote: "Nothing is less reliable, nothing is less clear today than the word 'archive'.", tone: "terra" },
            { src: "Origin of Tragedy", page: "p. 41", quote: "The chorus does not commemorate; it metabolizes the catastrophe in song.", tone: "sage" },
            { src: "Poetics of Space", page: "p. 8", quote: "The house shelters daydreaming, the house protects the dreamer.", tone: "indigo" }].
            map((h, i) =>
            <div key={i} className="card row gap-16" style={{ padding: 18, alignItems: "stretch" }}>
                  <div className="wc-stage" style={{ width: 4, borderRadius: 4, overflow: "hidden", flexShrink: 0, background: `var(--${h.tone === "ochre" ? "ochre" : h.tone === "indigo" ? "indigo" : h.tone === "terra" ? "terracotta" : "sage"})` }} />
                  <div className="col gap-6" style={{ flex: 1 }}>
                    <div className="t-quote">"{h.quote}"</div>
                    <div className="t-small mono">{h.src.toUpperCase()} · {h.page.toUpperCase()}</div>
                  </div>
                  <div className="row gap-6" style={{ alignItems: "center" }}>
                    <button className="btn-square" title="Open in lesson"><Icon name="compass" size={14} /></button>
                    <button className="btn-square" title="Insert into note"><Icon name="pen" size={14} /></button>
                  </div>
                </div>
            )}
            </div>
          }
        </div>

        {/* Inspector */}
        <div className="col gap-12" style={{ width: 320, flexShrink: 0, position: "sticky", top: 24 }}>
          <div className="card wc-stage" style={{ padding: "20px 22px", overflow: "hidden", position: "relative" }}>
            <div style={{ position: "absolute", inset: 0, opacity: .35 }}>
              <Watercolor.Wash tone={book.tone} />
            </div>
            <div style={{ position: "relative" }}>
              <div className="t-tiny mono">{book.type.toUpperCase()} · {book.year}</div>
              <div className="serif" style={{ fontSize: 26, lineHeight: 1.1, marginTop: 6 }}>{book.title}</div>
              <div className="t-body italic" style={{ marginTop: 4 }}>{book.author}</div>
              <div className="row gap-6" style={{ marginTop: 12, flexWrap: "wrap" }}>
                <span className="chip chip-mono chip-ochre">{book.hl} highlights</span>
                <span className="chip chip-mono">12 backlinks</span>
                <span className="chip chip-mono">3 lessons</span>
              </div>
              <div className="row gap-8" style={{ marginTop: 14 }}>
                <button className="btn btn-primary" style={{ fontSize: 12.5 }}><Icon name="play" size={12} /> Continue reading</button>
                <button className="btn btn-ghost" style={{ fontSize: 12.5 }}><Icon name="quote" size={12} /> Marginalia</button>
              </div>
            </div>
          </div>

          <div className="card col gap-8" style={{ padding: "16px 18px" }}>
            <div className="eyebrow">Pulled into your work</div>
            <div className="t-small">Three lessons cite this source.</div>
            {["L7 · Decay as syntax", "L3 · Fungal Semiotics", "L5 · The mycelial archive"].map((l, i) =>
            <div key={i} className="row gap-10" style={{ padding: "8px 0", borderTop: i ? "1px solid var(--rule-soft)" : "none" }}>
                <Icon name="compass" size={14} />
                <span style={{ fontSize: 13.5 }}>{l}</span>
                <span className="spacer" />
                <Icon name="chev" size={12} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>);

};

// ===== WORKSHOP (Sparks) =====
const SPARKS = [
{ id: 1, kind: "Connect", title: "Civic dialogue platform", tone: "terra", desc: "A platform that aligns deep learning with civic conversation. Each thread metabolizes a primary source into a public stance.", stage: "drafting" },
{ id: 2, kind: "Question", title: "How might decay be weaponized in a mythic narrative?", tone: "indigo", desc: "Open inquiry. Three citations, one sketch, no judgment yet.", stage: "open" },
{ id: 3, kind: "Create", title: "A myth that begins with the end", tone: "ochre", desc: "An essay-fiction that opens at decomposition and runs the river backward to seed.", stage: "writing" },
{ id: 4, kind: "Build", title: "A reading ritual app", tone: "sage", desc: "Twenty minutes. A bell. A passage. A two-line response. Ship by autumn.", stage: "scoping" }];


const WorkshopScreen = ({ onJump }) =>
<div className="col gap-20 fade-in" style={{ padding: "24px 36px 56px", maxWidth: 1640, margin: "0 auto" }}>
    <div className="row gap-16">
      <div className="col">
        <div className="eyebrow">Workshop</div>
        <h1 className="serif" style={{ fontSize: 38, margin: "4px 0 0", fontWeight: 400 }}>
          Where learning becomes <span className="italic">work</span>.
        </h1>
        <div className="t-body">Sparks are the artefacts your studies want to become. Each is fed by Evidence, shaped by Judgment, propelled by Action.</div>
      </div>
      <span className="spacer" />
      <button className="btn btn-primary"><Icon name="plus" size={13} /> Plant a Spark</button>
    </div>

    {/* Yield ledger */}
    <div className="row gap-12">
      {Object.keys(YIELD_META).map((k) =>
    <div key={k} className={`yield-${k} card row gap-12`} style={{
      flex: 1, padding: "14px 18px", alignItems: "center",
      borderColor: "var(--y-fill)", borderWidth: "1px 1px 1px 4px", borderStyle: "solid",
      background: "var(--paper)"
    }}>
          <YieldDot kind={k} size={36} />
          <div className="col" style={{ flex: 1 }}>
            <div className="t-tiny mono" style={{ letterSpacing: ".18em", fontFamily: "serif" }}>{YIELD_META[k].label.toUpperCase()}</div>
            <div className="serif" style={{ fontSize: 22 }}>{[86, 34, 12, 7][["evidence", "judgment", "action", "work"].indexOf(k)]}</div>
            <div className="t-tiny">{YIELD_META[k].desc}</div>
          </div>
        </div>
    )}
    </div>

    <div className="row" style={{ alignItems: "baseline", gap: 12 }}>
      <div className="eyebrow">Active Sparks</div>
      <span className="t-small">{SPARKS.length} in flight · sorted by warmth</span>
      <span className="spacer" />
      <button className="btn btn-quiet" style={{ fontSize: 12 }}><Icon name="palette" size={13} /> Sort by yield</button>
    </div>

    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 18 }}>
      {SPARKS.map((s) =>
    <div key={s.id} className="card wc-stage col gap-12" style={{
      padding: "20px 22px", position: "relative", overflow: "hidden", minHeight: 240
    }}>
          <div style={{ position: "absolute", right: -50, top: -60, width: 220, height: 220, opacity: .55 }}>
            <Watercolor.Spore tone={s.tone} size={220} />
          </div>
          <div className="row gap-8" style={{ position: "relative", zIndex: 1 }}>
            <span className="chip chip-mono chip-terra" style={{ fontFamily: "serif" }}>{s.kind}</span>
            <span className="chip chip-mono" style={{ textTransform: "uppercase", fontFamily: "serif" }}>{s.stage}</span>
            <span className="spacer" />
            <span className="t-tiny mono">SPARK · {String(s.id).padStart(2, "0")}</span>
          </div>
          <div className="serif" style={{ fontSize: 26, lineHeight: 1.15, position: "relative", zIndex: 1 }}>{s.title}</div>
          <div className="t-body" style={{ position: "relative", zIndex: 1, maxWidth: 460 }}>{s.desc}</div>

          <div className="row gap-16" style={{ marginTop: "auto", position: "relative", zIndex: 1 }}>
            <YieldRow counts={[5, 2, 1, 0]} />
            <span className="spacer" />
            <button className="btn btn-ghost" style={{ fontSize: 12 }}><Icon name="eye" size={12} /> Open</button>
          </div>
        </div>
    )}
    </div>
  </div>;


const YieldRow = ({ counts }) =>
<div className="row gap-8">
    {Object.keys(YIELD_META).map((k, i) =>
  <div key={k} className="row gap-4">
        <YieldDot kind={k} size={20} />
        <span className="t-tiny mono" style={{ minWidth: 14 }}>{counts[i]}</span>
      </div>
  )}
  </div>;


// ===== ONBOARDING =====
const ONBOARDING_STEPS = [
{ eyebrow: "Step I · Convocation", title: "What do you wish to know?",
  sub: "HYPHA compiles a private university around a single question, held over time. Begin with one." },
{ eyebrow: "Step II · Materials", title: "What books, papers, and notes have you brought?",
  sub: "We will treat them as the soil. You may add more later." },
{ eyebrow: "Step III · Compilation", title: "Compiling your private syllabus…",
  sub: "Eight lectures, four yields each. Composed for you, in this season." },
{ eyebrow: "Step IV · Convocation", title: "Welcome to HYPHA.",
  sub: "Your first lesson awaits." }];


const OnboardingScreen = ({ onComplete }) => {
  const [step, setStep] = useState(0);
  const [goal, setGoal] = useState("How decay produces meaning, and what that asks of attention.");
  const [tags, setTags] = useState(["Philosophy", "Mycology", "Poetics", "Ritual"]);
  const [materials, setMaterials] = useState([
  { name: "Mythical Grammar — L. Veyra", kind: "Book", on: true },
  { name: "The Mushroom at the End of the World", kind: "Book", on: true },
  { name: "Archive Fever — J. Derrida", kind: "Essay", on: true },
  { name: "My reading log (last 6 months)", kind: "Notes", on: true },
  { name: "A folder of voice memos", kind: "Audio", on: false }]
  );
  useEffect(() => {
    if (step === 2) {
      const t = setTimeout(() => setStep(3), 2400);
      return () => clearTimeout(t);
    }
  }, [step]);

  const s = ONBOARDING_STEPS[step];

  return (
    <div className="scrim">
      <div className="col gap-20" style={{ width: "min(720px, 92vw)", padding: 32, position: "relative", zIndex: 2 }}>
        <div className="row gap-12">
          <Watercolor.BrandMark size={28} />
          <div className="serif" style={{ letterSpacing: ".22em", fontSize: 18 }}>HYPHA</div>
          <span className="spacer" />
          <span className="t-tiny mono" style={{ letterSpacing: ".18em", color: "rgba(236,228,207,.6)" }}>EST. MMXXVI</span>
        </div>

        <div className="row gap-6" style={{ alignItems: "center" }}>
          {ONBOARDING_STEPS.map((_, i) =>
          <div key={i} style={{ flex: i < ONBOARDING_STEPS.length - 1 ? 1 : 0, display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{
              width: 10, height: 10, borderRadius: 5,
              background: i <= step ? "var(--ochre)" : "rgba(236,228,207,.2)",
              border: i === step ? "2px solid #ece4cf" : "none"
            }} />
              {i < ONBOARDING_STEPS.length - 1 && <div style={{ flex: 1, height: 1, background: i < step ? "var(--ochre)" : "rgba(236,228,207,.2)" }} />}
            </div>
          )}
        </div>

        <div className="col gap-12 rise-in" key={step}>
          <div className="t-tiny mono" style={{ letterSpacing: ".22em", color: "rgba(236,228,207,.7)" }}>{s.eyebrow.toUpperCase()}</div>
          <h1 className="serif" style={{ fontSize: 44, margin: 0, fontWeight: 400, color: "#ece4cf", lineHeight: 1.1 }}>
            {s.title}
          </h1>
          <div className="t-body-l" style={{ color: "rgba(236,228,207,.75)" }}>{s.sub}</div>
        </div>

        {step === 0 &&
        <div className="col gap-12 rise-in">
            <div style={{
            borderBottom: "1px solid rgba(236,228,207,.25)", paddingBottom: 8
          }}>
              <textarea value={goal} onChange={(e) => setGoal(e.target.value)}
            placeholder="Begin with a question you have held for years…"
            style={{
              width: "100%", minHeight: 70, border: 0, outline: 0, background: "transparent",
              color: "#ece4cf", fontFamily: "var(--serif)", fontSize: 26, lineHeight: 1.4,
              fontStyle: "italic", resize: "none"
            }} />
            </div>
            <div className="row gap-6" style={{ flexWrap: "wrap" }}>
              {tags.map((t) =>
            <span key={t} className="chip chip-mono" style={{
              background: "rgba(200,146,62,.18)", borderColor: "rgba(200,146,62,.4)", color: "#e2b878"
            }}>{t} <Icon name="plus" size={10} /></span>
            )}
              <span className="t-small" style={{ color: "rgba(236,228,207,.5)", marginLeft: 6 }}>HYPHA suggests these threads</span>
            </div>
          </div>
        }

        {step === 1 &&
        <div className="col gap-8 rise-in">
            {materials.map((m, i) =>
          <button key={i} onClick={() => setMaterials((arr) => arr.map((x, j) => j === i ? { ...x, on: !x.on } : x))}
          className="row gap-12" style={{
            padding: "12px 14px", borderRadius: 10,
            border: m.on ? "1px solid var(--ochre)" : "1px solid rgba(236,228,207,.18)",
            background: m.on ? "rgba(200,146,62,.10)" : "transparent",
            color: "#ece4cf", textAlign: "left"
          }}>
                <div style={{
              width: 18, height: 18, borderRadius: 4,
              border: m.on ? "1px solid var(--ochre)" : "1px solid rgba(236,228,207,.4)",
              background: m.on ? "var(--ochre)" : "transparent",
              color: "#1c211e", display: "grid", placeItems: "center"
            }}>
                  {m.on && <Icon name="check" size={11} stroke={2} />}
                </div>
                <span className="serif" style={{ fontSize: 17, flex: 1 }}>{m.name}</span>
                <span className="chip chip-mono" style={{ background: "transparent", borderColor: "rgba(236,228,207,.18)", color: "rgba(236,228,207,.7)" }}>{m.kind}</span>
              </button>
          )}
            <button className="t-small" style={{ marginTop: 6, color: "rgba(236,228,207,.6)", textAlign: "left" }}>
              + Drop a folder, paste a URL, or connect a notes app
            </button>
          </div>
        }

        {step === 2 &&
        <div className="col gap-12 rise-in" style={{ marginTop: 12 }}>
            <div className="bloom" style={{ position: "relative", height: 240 }}>
              <Watercolor.Mycelium seed={7} opacity={1} />
            </div>
            <div className="col gap-6">
              {[
            "Reading your goal · 'decay → meaning'",
            "Cross-referencing 4 sources · Veyra, Tsing, Derrida, Nietzsche",
            "Composing 8 lectures · 4 yields each",
            "Tuning the cadence to your reading speed (240 wpm)"].
            map((line, i) =>
            <div key={i} className="row gap-10 t-small" style={{ color: "rgba(236,228,207,.85)" }}>
                  <span className="mono" style={{ color: "var(--ochre)" }}>›</span>
                  <span style={{
                animation: `fadeIn .6s ${i * .35}s both ease`
              }}>{line}</span>
                </div>
            )}
            </div>
          </div>
        }

        {step === 3 &&
        <div className="col gap-12 rise-in">
            <div className="card wc-stage col gap-8" style={{
            padding: 22, background: "rgba(255,255,255,.05)",
            borderColor: "rgba(236,228,207,.18)", color: "#ece4cf",
            position: "relative", overflow: "hidden"
          }}>
              <div style={{ position: "absolute", right: -40, top: -60, width: 220, height: 220, opacity: .35 }}>
                <Watercolor.Spore tone="ochre" size={220} />
              </div>
              <div className="t-tiny mono" style={{ color: "rgba(236,228,207,.6)" }}>THE LANGUAGE OF DECAY · ARC ONE</div>
              <div className="serif" style={{ fontSize: 28, lineHeight: 1.15 }}>Lecture 1 · Etymologies of Rot</div>
              <div className="t-small" style={{ color: "rgba(236,228,207,.7)" }}>Prof. L. Veyra · 38 min · 4 yields</div>
            </div>
          </div>
        }

        <div className="row gap-8" style={{ marginTop: 8 }}>
          {step > 0 && step < 2 &&
          <button onClick={() => setStep((s) => s - 1)} className="btn btn-quiet" style={{ color: "rgba(236,228,207,.7)" }}>
              <Icon name="arrowL" size={13} /> Back
            </button>
          }
          <span className="spacer" />
          {step < 2 &&
          <button onClick={() => setStep((s) => s + 1)} className="btn btn-ochre">
              {step === 0 ? "Bring my materials" : "Compile my syllabus"} <Icon name="arrow" size={13} />
            </button>
          }
          {step === 3 &&
          <button onClick={onComplete} className="btn btn-ochre">
              Begin Lecture I <Icon name="arrow" size={13} />
            </button>
          }
        </div>
      </div>
    </div>);

};

window.LibraryScreen = LibraryScreen;
window.WorkshopScreen = WorkshopScreen;
window.OnboardingScreen = OnboardingScreen;