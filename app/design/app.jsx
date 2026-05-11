/* global React, ReactDOM, Icon, Watercolor, Brand, Sidebar, Topbar, NAV,
   CommandPalette, HomeScreen, LessonScreen, LessonChat, AtlasScreen, NotebookScreen,
   LibraryScreen, WorkshopScreen, OnboardingScreen, useTweaks, TweaksPanel,
   TweakSection, TweakRadio, TweakColor, TweakSelect */

const { useState, useEffect, useMemo } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "layout": "sidebar",
  "palette": "earth",
  "type": "cormorant_dmsans",
  "density": "regular",
  "theme": "parchment"
}/*EDITMODE-END*/;

const PALETTES = {
  earth: { ochre: "#d18a2e", terracotta: "#c25a36", sage: "#8a9461", indigo: "#6a5b7c" },
  amber: { ochre: "#e0a04a", terracotta: "#d97142", sage: "#a89858", indigo: "#86694a" },
  ember: { ochre: "#d97a2a", terracotta: "#b8412a", sage: "#9c7d3c", indigo: "#7a4a3a" },
  dusk:  { ochre: "#c89148", terracotta: "#a85a3e", sage: "#7d8a6a", indigo: "#5e526e" },
};

const TYPE_PAIRINGS = {
  cormorant_dmsans:  { serif: '"Cormorant Garamond", serif', sans: '"DM Sans", sans-serif',     label: "Cormorant + DM Sans" },
  ebgaramond_inter:  { serif: '"EB Garamond", serif',         sans: '"Manrope", sans-serif',    label: "EB Garamond + Manrope" },
  cardo_mono:        { serif: '"Cardo", serif',               sans: '"IBM Plex Sans", sans-serif', label: "Cardo + Plex" },
};

const App = () => {
  const [route, setRoute] = useState("home");
  const [onboarded, setOnboarded] = useState(false); // v0.1: first-run user must onboard
  const [goal, setGoal] = useState(null); // payload from OnboardingScreen — drives sub-steps D+
  const [cmdOpen, setCmdOpen] = useState(false);
  const [yieldToast, setYieldToast] = useState(null);
  // 2026-05-11 — Phase 0 wire: OnboardingScreen submit now awaits curriculum:create
  // (previously local-state-only, see plan file fluffy-hugging-swan.md §"V0.5 E1 Opening — Path B-3").
  const [isCreatingCurriculum, setIsCreatingCurriculum] = useState(false);
  const [createStage, setCreateStage] = useState("");
  const [createError, setCreateError] = useState(null);
  const [pendingTopic, setPendingTopic] = useState("");
  // 2026-05-08 — vault-aware boot: when vault already holds curricula, skip
  // the OnboardingScreen and land on Home with a resumable list. Forced
  // onboarding-on-every-launch was reported as the #1 entry-friction bug.
  const [courses, setCourses] = useState([]);
  const [bootChecked, setBootChecked] = useState(false);

  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // Boot probe — query existing curricula once on mount. If any exist,
  // skip OnboardingScreen and seed Home with the list. If empty / probe
  // fails, fall through to today's first-launch behaviour.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fn = window.ptor && window.ptor.hypha && window.ptor.hypha.curriculumList;
        if (typeof fn !== 'function') { if (!cancelled) setBootChecked(true); return; }
        const list = await fn();
        if (cancelled) return;
        if (Array.isArray(list) && list.length > 0) {
          // Order: lastIdx desc as a "most recently touched first" proxy.
          const sorted = list.slice().sort((a, b) => (b.lastIdx ?? -1) - (a.lastIdx ?? -1));
          setCourses(sorted);
          setOnboarded(true);
          setRoute("home");
        }
      } catch (_) { /* graceful fallthrough to onboarding */ }
      finally { if (!cancelled) setBootChecked(true); }
    })();
    return () => { cancelled = true; };
  }, []);

  // Resume an existing curriculum from Home. Sets goal so LessonChat /
  // LessonScreen routes have noteRel + a minimal goalContract upstream
  // callers can read.
  const handleResumeCourse = (c) => {
    if (!c) return;
    setGoal({
      noteRel: c.firstLessonRel,
      goalContract: {
        north_star_goal: c.topic || '',
        current_level: 'self-directed adult learner',
      },
    });
    setRoute("lesson");
  };

  // Create a brand-new course from Home — drops back into OnboardingScreen.
  const handleCreateNew = () => {
    setGoal(null);
    setOnboarded(false);
  };

  // Apply tweak side-effects to <html>
  useEffect(() => {
    const root = document.documentElement;
    const p = PALETTES[t.palette] || PALETTES.earth;
    root.style.setProperty("--ochre", p.ochre);
    root.style.setProperty("--terracotta", p.terracotta);
    root.style.setProperty("--sage", p.sage);
    root.style.setProperty("--indigo", p.indigo);

    const tp = TYPE_PAIRINGS[t.type] || TYPE_PAIRINGS.cormorant_dmsans;
    root.style.setProperty("--serif", tp.serif);
    root.style.setProperty("--sans", tp.sans);

    root.dataset.density = t.density === "comfortable" ? "comfortable" : t.density === "compact" ? "compact" : "regular";
    root.dataset.theme = t.theme === "dusk" ? "dusk" : "parchment";
  }, [t.palette, t.type, t.density, t.theme]);

  // Cmd+K
  useEffect(() => {
    const onKey = e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault(); setCmdOpen(o => !o);
      }
      if (e.key === "Escape") setCmdOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ARC = { title: "", completed: 0, total: 0, progress: 0 };
  const USER = { name: "" };

  const handleJump = (cmd) => {
    if (cmd?.kind === "Lesson") setRoute("lesson");
    else if (cmd?.kind === "Note") setRoute("notes");
    else if (cmd?.kind === "Source") setRoute("library");
    else if (cmd?.kind === "Spark" || cmd?.kind === "Action") setRoute("sparks");
    else if (cmd?.kind === "Map") setRoute("map");
  };

  const handleYield = (kind) => {
    setYieldToast(kind);
    setTimeout(() => setYieldToast(null), 2400);
  };

  const lessonFullBleed = route === "lesson" || route === "notes";

  const screen = (() => {
    switch (route) {
      case "home":    return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
      case "lesson":  {
        // v0.3 LessonChat is the primary surface (BLUEPRINT §6.1 12-field via
        // chat turns + §8.1 Cadence). Falls back to legacy LessonScreen
        // (skeleton + textarea, deprecated) if window.LessonChat isn't loaded
        // yet — defensive guard against script-order issues during dev reload.
        const Surface = (typeof window.LessonChat === 'function') ? window.LessonChat : LessonScreen;
        return <Surface goal={goal} noteRel={goal && goal.noteRel} onBack={() => setRoute("home")} onYield={handleYield} />;
      }
      case "map":     return <AtlasScreen onJump={setRoute} />;
      case "notes":   return <NotebookScreen onJump={setRoute} />;
      case "library": return <LibraryScreen />;
      case "sparks":  return <WorkshopScreen onJump={setRoute} />;
      default:        return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
    }
  })();

  if (!onboarded) {
    if (isCreatingCurriculum) {
      return (
        <div className="fade-in col" style={{
          minHeight: "100vh",
          padding: "80px 60px",
          gap: 24,
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
        }}>
          <div className="serif italic" style={{ fontSize: 36, lineHeight: 1.2, color: "var(--ink-1)" }}>
            正在备课
          </div>
          <div className="mono t-small" style={{ color: "var(--ink-3)", letterSpacing: ".15em" }}>
            {pendingTopic}
          </div>
          <div className="mono t-small" style={{ color: "var(--ink-2)", minHeight: 18 }}>
            {createStage || "starting harvest…"}
          </div>
          {createError && (
            <div style={{ color: "var(--terracotta)", maxWidth: 600, textAlign: "center", marginTop: 16 }}>
              {createError}
            </div>
          )}
        </div>
      );
    }
    return <OnboardingScreen onComplete={async (payload) => {
      const gc = (payload && payload.goalContract) || {};
      const topic = (gc.north_star_goal || "").trim();
      const level = (gc.current_level || "").trim();
      if (!topic) {
        setCreateError("north_star_goal is required");
        return;
      }
      setCreateError(null);
      setPendingTopic(topic);
      setIsCreatingCurriculum(true);
      setCreateStage("starting…");

      // Subscribe to curriculum:create:progress events so the user sees stages,
      // not a frozen screen. Defensive — bridge may be absent in some build modes.
      let unsubscribe = null;
      try {
        if (window.ptor && window.ptor.hypha && typeof window.ptor.hypha.onCurriculumProgress === "function") {
          unsubscribe = window.ptor.hypha.onCurriculumProgress((evt) => {
            if (evt && evt.stage) setCreateStage(String(evt.stage));
          });
        }
      } catch (err) {
        console.warn("[onboarding] could not subscribe to curriculum progress", err);
      }

      try {
        const createFn = window.ptor && window.ptor.hypha && window.ptor.hypha.curriculumCreate;
        if (typeof createFn !== "function") {
          throw new Error("curriculumCreate IPC bridge not available");
        }
        const result = await createFn(topic, level, {
          goal: (gc.main_creation || "").trim(),
          lesson_mode: "learn",
          goalContract: gc,
          provider: payload.provider,
          model: payload.model,
        });
        if (!result || result.ok === false) {
          throw new Error((result && result.error) || "curriculum:create returned no result");
        }
        const slug = result.slug || result.topic;
        const noteRel = (Array.isArray(result.lessonRels) && result.lessonRels[0]) || `${slug}/lesson-0`;
        if (!slug) {
          throw new Error("curriculum:create returned no slug — see DevTools console for raw result");
        }
        // Wire downstream LessonChat. noteRel points at lesson-0 so the
        // SkeletonPreviewCard / body PreviewCard renders on the lesson screen.
        setGoal({
          noteRel,
          goalContract: gc,
          slug,
          provider: payload.provider,
          model: payload.model,
        });
        setOnboarded(true);
        setIsCreatingCurriculum(false);
        setRoute("lesson");
      } catch (err) {
        console.error("[onboarding] curriculum:create failed", err);
        setCreateError((err && err.message) ? err.message : "curriculum create failed — see DevTools console");
        // Leave isCreatingCurriculum=true so the user sees the error; they can
        // refresh / restart to retry. Future polish: add a Retry button.
      } finally {
        if (typeof unsubscribe === "function") {
          try { unsubscribe(); } catch (_) {}
        }
      }
    }} />;
  }

  return (
    <>
      {t.layout === "sidebar" ? (
        lessonFullBleed ? (
          <main style={{ minHeight: "100vh" }}>{screen}</main>
        ) : (
        <div className="shell shell-sidebar">
          <Sidebar route={route} setRoute={setRoute} arc={ARC} openCmd={() => setCmdOpen(true)} />
          <div className="col" style={{ minWidth: 0 }}>
            {!lessonFullBleed && (
              <header className="row gap-16" style={{
                padding: "16px 36px",
                borderBottom: "1px solid var(--rule-soft)",
                background: "linear-gradient(180deg, rgba(244,239,228,.92), rgba(244,239,228,.5))",
                backdropFilter: "blur(6px)",
                position: "sticky", top: 0, zIndex: 4,
              }}>
                <Breadcrumb route={route} />
                <span className="spacer" />
                <button className="search" onClick={() => setCmdOpen(true)} style={{ minWidth: 320 }}>
                  <Icon name="search" size={14} />
                  <span style={{ flex: 1, textAlign: "left" }}>Search lessons, notes, sources…</span>
                </button>
                <button className="btn-square" title="Notifications" style={{ position: "relative" }}>
                  <Icon name="bell" size={15} />
                  <span style={{ position: "absolute", top: -4, right: -4, width: 14, height: 14, borderRadius: 7, background: "var(--terracotta)", color: "#fff", fontSize: 9.5, display: "grid", placeItems: "center", fontWeight: 600 }}>4</span>
                </button>
              </header>
            )}
            <div style={{ minWidth: 0 }}>{screen}</div>
          </div>
        </div>
        )
      ) : (
        <div className="shell shell-topbar">
          {!lessonFullBleed && <Topbar route={route} setRoute={setRoute} openCmd={() => setCmdOpen(true)} />}
          <div>{screen}</div>
        </div>
      )}

      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} onJump={handleJump} />

      {yieldToast && (
        <div className="rise-in" style={{
          position: "fixed", bottom: 100, left: "50%", transform: "translateX(-50%)", zIndex: 70,
          background: "var(--ink)", color: "var(--paper)",
          padding: "12px 20px", borderRadius: 999,
          fontSize: 13, display: "flex", alignItems: "center", gap: 10,
          boxShadow: "0 16px 40px rgba(0,0,0,.25)",
        }}>
          <Icon name="check" size={14} stroke={2} />
          <span><span className="serif italic">{yieldToast.charAt(0).toUpperCase() + yieldToast.slice(1)}</span> stitched into your graph · L7</span>
        </div>
      )}

      {/* Tweaks */}
      <TweaksPanel title="Tweaks">
        <TweakSection label="Layout">
          <TweakRadio
            label="Navigation"
            value={t.layout}
            options={[{ value: "sidebar", label: "Sidebar" }, { value: "topbar", label: "Top bar" }]}
            onChange={v => setTweak("layout", v)} />
          <TweakRadio
            label="Density"
            value={t.density}
            options={[{ value: "compact", label: "Compact" }, { value: "regular", label: "Regular" }, { value: "comfortable", label: "Comfy" }]}
            onChange={v => setTweak("density", v)} />
          <TweakRadio
            label="Theme"
            value={t.theme}
            options={[{ value: "parchment", label: "Parchment" }, { value: "dusk", label: "Dusk" }]}
            onChange={v => setTweak("theme", v)} />
        </TweakSection>

        <TweakSection label="Palette">
          <TweakColor
            label="Earth tones"
            value={PALETTES[t.palette] ? [PALETTES[t.palette].ochre, PALETTES[t.palette].terracotta, PALETTES[t.palette].sage, PALETTES[t.palette].indigo] : null}
            options={Object.keys(PALETTES).map(k => [PALETTES[k].ochre, PALETTES[k].terracotta, PALETTES[k].sage, PALETTES[k].indigo])}
            onChange={v => {
              const keys = Object.keys(PALETTES);
              const idx = keys.findIndex(k => PALETTES[k].ochre === (Array.isArray(v) ? v[0] : v));
              if (idx >= 0) setTweak("palette", keys[idx]);
            }} />
        </TweakSection>

        <TweakSection label="Typography">
          <TweakSelect
            label="Pairing"
            value={t.type}
            options={Object.keys(TYPE_PAIRINGS).map(k => ({ value: k, label: TYPE_PAIRINGS[k].label }))}
            onChange={v => setTweak("type", v)} />
        </TweakSection>

        <TweakSection label="Replay">
          <button className="btn btn-ghost" style={{ fontSize: 12, width: "100%", justifyContent: "center" }}
            onClick={() => { setOnboarded(false); }}>
            <Icon name="sparkle" size={13} /> Replay onboarding
          </button>
        </TweakSection>
      </TweaksPanel>
    </>
  );
};

// ===== Breadcrumb =====
const Breadcrumb = ({ route }) => {
  const map = {
    home:    ["Home"],
    lesson:  ["Lesson", "L7 · The Language of Decay"],
    map:     ["Atlas"],
    notes:   ["Notebook", "Hyphae of attention"],
    library: ["Library"],
    sparks:  ["Workshop"],
  };
  const trail = map[route] || ["Home"];
  return (
    <div className="row gap-8 t-small" style={{ color: "var(--ink-3)" }}>
      <span className="serif italic">HYPHA</span>
      <span style={{ color: "var(--ink-4)" }}>›</span>
      {trail.map((t, i) => (
        <span key={i} style={{ color: i === trail.length - 1 ? "var(--ink)" : "var(--ink-3)" }}>
          {t}
          {i < trail.length - 1 && <span style={{ color: "var(--ink-4)", marginLeft: 8 }}>›</span>}
        </span>
      ))}
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
