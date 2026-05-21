/* global React, ReactDOM, Icon, Watercolor, Brand, Sidebar, Topbar, NAV,
   CommandPalette, HomeScreen, LessonScreen, LessonChat, AtlasScreen, NotebookScreen,
   LibraryScreen, WorkshopScreen, OnboardingScreen, useTweaks, TweaksPanel,
   TweakSection, TweakRadio, TweakColor, TweakSelect, KillToast, ToastRoot */

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

// 2026-05-13 — PreconditionEmpty 共享空态. 修 "点 工具按钮 → 静默 fallback 回 Home"
// (10 处 .slug field-name bug + product-blueprint 缺 courses 档). 现在 slug-依赖
// surfaces 在 slug 解析不出时显此卡, 不再消失。Manuscript register: italic Garamond,
// brass accent, ← 返回 + 创建课程 双 CTA。
const PreconditionEmpty = ({ title, reason, cta, onBack, onCreate }) => (
  <div style={{
    maxWidth: 680, margin: '0 auto', padding: '64px 36px',
    fontFamily: 'EB Garamond, "Noto Serif SC", serif',
    color: 'var(--ink)',
    display: 'flex', flexDirection: 'column', gap: 20,
  }}>
    <div className="mono" style={{
      fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase',
      color: 'var(--ink-3)',
    }}>{title}</div>
    <h2 className="serif italic" style={{
      fontSize: 28, fontWeight: 400, lineHeight: 1.25, margin: 0,
      color: 'var(--ink-1)',
    }}>这扇门还差一步</h2>
    <p style={{
      fontSize: 16, lineHeight: 1.7, color: 'var(--ink-2)', margin: 0,
      fontStyle: 'italic',
    }}>{reason}</p>
    <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
      {onCreate && (
        <button
          onClick={onCreate}
          style={{
            padding: '8px 18px',
            fontFamily: 'EB Garamond, serif', fontStyle: 'italic', fontSize: 14,
            color: 'var(--paper, #faf6e8)',
            background: 'var(--accent-brass, #b08a3e)',
            border: '1px solid var(--accent-brass, #b08a3e)',
            borderRadius: 2, cursor: 'pointer',
            letterSpacing: '0.04em',
          }}
        >+ {cta || '创建第一节课程'}</button>
      )}
      <button
        onClick={onBack}
        style={{
          padding: '8px 18px',
          fontFamily: 'EB Garamond, serif', fontStyle: 'italic', fontSize: 14,
          color: 'var(--ink-2)',
          background: 'transparent',
          border: '1px solid var(--rule-soft)',
          borderRadius: 2, cursor: 'pointer',
          letterSpacing: '0.04em',
        }}
      >← 返回</button>
    </div>
  </div>
);

const App = () => {
  const [route, setRoute] = useState("home");
  // 2026-05-12 — default onboarded=true so app always lands on Home (per user
  // request). Empty vault shows HomeScreen's zero-state with "Create new course"
  // CTA, which calls handleCreateNew() → setOnboarded(false) → renders
  // OnboardingScreen explicitly. No more auto-route-to-onboarding on launch.
  const [onboarded, setOnboarded] = useState(true);
  const [goal, setGoal] = useState(null); // payload from OnboardingScreen — drives sub-steps D+
  const [cmdOpen, setCmdOpen] = useState(false);
  const [yieldToast, setYieldToast] = useState(null);
  // 2026-05-11 — Phase 0 wire: OnboardingScreen submit now awaits curriculum:create
  // (previously local-state-only, see plan file fluffy-hugging-swan.md §"V0.5 E1 Opening — Path B-3").
  const [isCreatingCurriculum, setIsCreatingCurriculum] = useState(false);
  const [createStage, setCreateStage] = useState("");
  // 2026-05-17 build-log surface — append-only list of stage events so user
  // sees every step + its result (replaces single-line spinner that overwrote
  // each prior stage). Entry: { stage, label, ts, payload, expanded?: bool }
  const [createLog, setCreateLog] = useState([]);
  const [createError, setCreateError] = useState(null);
  const [pendingTopic, setPendingTopic] = useState("");
  // 2026-05-08 — vault-aware boot: when vault already holds curricula, skip
  // the OnboardingScreen and land on Home with a resumable list. Forced
  // onboarding-on-every-launch was reported as the #1 entry-friction bug.
  const [courses, setCourses] = useState([]);
  const [bootChecked, setBootChecked] = useState(false);
  // Phase C — current notebook target. LessonChat hands us its live noteRel
  // when the user clicks "📓 笔记" so NotebookScreen mounts with the right
  // slug + lessonIdx. Falls back to goal.noteRel for direct cmd-palette jumps.
  const [notebookCtx, setNotebookCtx] = useState(null);
  // W5.3 Living Note Reactivation — slug carried into DeadNotesScreen when
  // user clicks "死亡笔记审查" from the notebook top bar. Set by the onJump
  // callback in the notebook case below; read by the dead-notes case.
  const [deadNotesSlug, setDeadNotesSlug] = useState(null);

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

  // Cmd+K + ESC routing
  useEffect(() => {
    const onKey = e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault(); setCmdOpen(o => !o);
      }
      if (e.key === "Escape") {
        setCmdOpen(false);
        // ESC on 创建课程 (OnboardingScreen) → back to home. Guard 1: only when
        // onboarded=false AND not mid-create (isCreatingCurriculum). Guard 2:
        // skip when target is editable so ESC inside a textarea/input only
        // blurs that field, not nukes the whole form. (2026-05-13 user req)
        if (!onboarded && !isCreatingCurriculum) {
          const tgt = e.target;
          const tag = tgt && tgt.tagName;
          const isEditable = tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || (tgt && tgt.isContentEditable);
          if (!isEditable) {
            setOnboarded(true);
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onboarded, isCreatingCurriculum]);

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

  // W1.5 Capture Mode + Finish Ritual — state.
  // captureSource ∈ {'lecture'|'video'|'reading'}; default to lecture.
  // captureSessionId is set by the Capture screen after backend opens the
  // session, then handed forward to the Finish Ritual route so it knows
  // which raw.jsonl to aggregate.
  const [captureSource, setCaptureSource] = useState("lecture");
  const [captureSessionId, setCaptureSessionId] = useState(null);

  // W3.2 Product Blueprint — slug of the currently-opened product blueprint
  // editor. Set from any surface that can jump into the editor (Home /
  // LessonChat / cmd-palette in future). Falls back to goal.slug when blank.
  const [productBlueprintSlug, setProductBlueprintSlug] = useState(null);

  // 2026-05-13 — Product Registry (vault-level Product Pool, BLUEPRINT §11.1).
  // 工具 → 产品蓝图 进入 list, 选 / 建 产品后 setOpenProductId → 路由进 editor.
  // 与 productBlueprintSlug 并列: legacy slug 路径仍可用 (W3.x curriculum-bound),
  // productId 路径是新 standalone product 路径。
  const [openProductId, setOpenProductId] = useState(null);

  // W7.1 Pack Learning — the pack object the user is currently studying.
  // Set by any surface that routes into 'pack-learning' (Library / Commons
  // browser, future cmd-palette entry). When unset, the route falls back
  // to HomeScreen so the surface stays calm on stale links.
  const [currentPack, setCurrentPack] = useState(null);

  // W6.2 — book context for distillation surfaces. Set by Library's Distill
  // button (which passes { screen, bookId, bookTitle } object payload, not a
  // bare route string). Cleared when navigating away from book-* routes.
  const [bookCtx, setBookCtx] = useState(null);

  // 2026-05-17 Gap 1 — chain plan state. Set by the onboarding submit handler
  // after chain:create returns { ok:true, data:chainData }; consumed by the
  // 'chain-plan' route case which mounts ChainPlanScreen. chainSlug is the
  // chain meta-folder slug so chainAccept + chainStart can target it.
  const [chainPlan, setChainPlan] = useState(null);
  const [chainSlug, setChainSlug] = useState(null);
  // 2026-05-17 MEOW MID-1 — capture route-goal evidence (conservative_years +
  // case-trajectory anchors) so ChainPlanScreen can surface "based on N
  // benchmark people · p75=N y · you may be faster or slower" rather than
  // letting "47y" read as a deterministic oracle.
  const [chainRouteInfo, setChainRouteInfo] = useState(null);

  // Phase E.0/E.1 (2026-05-18) — Library Coverage Gate. Between onboarding
  // submit and chain:create / curriculumCreate. Set when library:coverage
  // returns has_coverage=false; cleared after gate completes (skip/continue).
  // pendingCreation stashes the original form payload so we can resume after
  // user uploads or skips — without round-tripping back through onboarding.
  const [chainGateInfo, setChainGateInfo] = useState(null);
  const [pendingCreation, setPendingCreation] = useState(null);

  // Phase F.1 (2026-05-18) — Goal Crystallizer wizard between onboarding
  // submit and route-goal. Promise-pause pattern: the inline onComplete
  // handler awaits waitForWizardConfirm(), which pushes state for the wizard
  // route to render, then resolves when wizard fires onConfirm/onSkip.
  // wizardResolverRef holds the resolver across renders.
  const [wizardStash, setWizardStash] = useState(null);
  const wizardResolverRef = React.useRef(null);

  const waitForWizardConfirm = React.useCallback(({ draftGoal, archetype }) => {
    return new Promise((resolve) => {
      setWizardStash({ draftGoal, archetype });
      setIsCreatingCurriculum(false);
      // BUGFIX 2026-05-18 — must flip onboarded=true so render gate
      // `if (!onboarded) return <OnboardingScreen/>` at app.jsx:1065 does NOT
      // intercept before the route switch. Without this, setRoute('goal-crystallizer')
      // is silently overridden by OnboardingScreen render → looks like a refresh.
      setOnboarded(true);
      setRoute('goal-crystallizer');
      wizardResolverRef.current = resolve;
    });
  }, []);

  // W7.1 — expose the route-pack setter so upstream surfaces (Library /
  // Commons browser / cmd-palette) can drive a pack into the screen in
  // one call without needing prop drilling. Set on mount, cleared on unmount.
  useEffect(() => {
    window.__hyphaOpenPack = (pack) => {
      setCurrentPack(pack || null);
      setRoute('pack-learning');
    };
    return () => { try { delete window.__hyphaOpenPack; } catch (_) {} };
  }, []);

  // 2026-05-14 (Machino-C7) — KillToast "查看详情" routing intent. The toast
  // dispatches a window-level CustomEvent so it doesn't need setRoute prop-
  // drilled in. Priority: rejected sparks → spark-pool; else flagged
  // decisions → lesson (DecisionLedgerCard lives there); else refuted
  // assumptions → lesson too. Slug derives from the standard chain so the
  // gated routes (spark-pool / lesson) actually render their data.
  useEffect(() => {
    const onDetails = (ev) => {
      const d = (ev && ev.detail) || {};
      const derivedSlug = (() => {
        if (goal && goal.slug) return goal.slug;
        const ref = goal && goal.noteRel;
        if (ref) {
          const m = String(ref).match(/^([^\\/]+)[\\/]lesson-(\d+)\.md$/);
          if (m) return m[1];
        }
        if (Array.isArray(courses) && courses[0] && courses[0].topic) return courses[0].topic;
        return null;
      })();
      if ((d.rejected || 0) > 0 && derivedSlug) {
        setProductBlueprintSlug(derivedSlug);
        setRoute('spark-pool');
        return;
      }
      // refuted / flagged → lesson surface where the ledger cards live
      setRoute('lesson');
    };
    window.addEventListener('hypha:kill-toast:details', onDetails);
    return () => window.removeEventListener('hypha:kill-toast:details', onDetails);
  }, [goal, courses]);

  // β23 North Star Panel — ChainHeader inline link dispatches this event
  // instead of being prop-drilled with setRoute. Same pattern as kill-toast.
  useEffect(() => {
    const onOpen = () => setRoute('north-star');
    window.addEventListener('hypha:open-north-star', onOpen);
    return () => window.removeEventListener('hypha:open-north-star', onOpen);
  }, []);

  // 2026-05-17 Phase C — LedgerBadge in screen-lesson-chat dispatches
  // 'hypha:open-lifetime' to avoid prop drilling. Same pattern as
  // hypha:open-north-star. Without this listener the badge click is silent.
  useEffect(() => {
    const onOpen = () => setRoute('lifetime');
    window.addEventListener('hypha:open-lifetime', onOpen);
    return () => window.removeEventListener('hypha:open-lifetime', onOpen);
  }, []);

  const lessonFullBleed = route === "lesson" || route === "notes" || route === "notebook" || route === "capture" || route === "finishRitual" || route === "product-blueprint" || route === "spark-pool" || route === "kpi-dashboard" || route === "scenario-dashboard" || route === "exam-dashboard" || route === "pack-learning" || route === "flywheel-dashboard" || route === "launch-readiness" || route === "chain-plan" || route === "lifetime";

  const screen = (() => {
    switch (route) {
      case "home":    return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
      case "lesson":  {
        // v0.3 LessonChat is the primary surface (BLUEPRINT §6.1 12-field via
        // chat turns + §8.1 Cadence). Falls back to legacy LessonScreen
        // (skeleton + textarea, deprecated) if window.LessonChat isn't loaded
        // yet — defensive guard against script-order issues during dev reload.
        const Surface = (typeof window.LessonChat === 'function') ? window.LessonChat : LessonScreen;
        return <Surface
          goal={goal}
          noteRel={goal && goal.noteRel}
          onBack={() => setRoute("home")}
          onYield={handleYield}
          onOpenNotebook={(rel) => {
            // Capture the live noteRel from inside LessonChat (may differ
            // from goal.noteRel post curriculum-create). Phase C-3 route.
            const ref = rel || (goal && goal.noteRel) || null;
            if (!ref) return;
            const m = String(ref).match(/^([^\\/]+)[\\/]lesson-(\d+)\.md$/);
            const slug = m ? m[1] : null;
            const lessonIdx = m ? Number(m[2]) : null;
            const userIntent = (goal && goal.goalContract && goal.goalContract.user_intent) || null;
            setNotebookCtx({ noteRel: ref, slug, lessonIdx, userIntent });
            setRoute("notebook");
          }}
        />;
      }
      case "map":     return <AtlasScreen onJump={setRoute} />;
      case "notes":   return <NotebookScreen onJump={setRoute} />;
      case "notebook": {
        const ctx = notebookCtx || (() => {
          const ref = goal && goal.noteRel;
          if (!ref) return null;
          const m = String(ref).match(/^([^\\/]+)[\\/]lesson-(\d+)\.md$/);
          return {
            noteRel: ref,
            slug: m ? m[1] : null,
            lessonIdx: m ? Number(m[2]) : null,
            userIntent: (goal && goal.goalContract && goal.goalContract.user_intent) || null,
          };
        })();
        const Surface = (typeof window.NotebookScreen === 'function') ? window.NotebookScreen : NotebookScreen;
        return <Surface
          noteRel={ctx && ctx.noteRel}
          slug={ctx && ctx.slug}
          lessonIdx={ctx && ctx.lessonIdx}
          userIntent={ctx && ctx.userIntent}
          onBack={() => setRoute("lesson")}
          onJump={(target, payload) => {
            // W5.3 — only route we care about here is dead-notes. Other
            // targets fall back to plain setRoute (no payload required).
            if (target === 'dead-notes') {
              const s = (payload && payload.slug) || (ctx && ctx.slug) || null;
              setDeadNotesSlug(s);
              setRoute('dead-notes');
              return;
            }
            setRoute(target);
          }}
        />;
      }
      case "dead-notes": {
        // W5.3 Living Note Reactivation — death audit. Slug priority:
        // 1. explicit deadNotesSlug (set by the notebook button), 2. goal.slug,
        // 3. derive from noteRel, 4. notebookCtx.slug. Falls back to home if
        // none resolves.
        const derivedSlug = (() => {
          if (deadNotesSlug) return deadNotesSlug;
          if (goal && goal.slug) return goal.slug;
          const ref = goal && goal.noteRel;
          if (ref) {
            const m = String(ref).match(/^([^\\/]+)[\\/]lesson-(\d+)\.md$/);
            if (m) return m[1];
          }
          if (notebookCtx && notebookCtx.slug) return notebookCtx.slug;
          return null;
        })();
        const Surface = (typeof window.DeadNotesScreen === 'function') ? window.DeadNotesScreen : null;
        if (!Surface || !derivedSlug) {
          return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        }
        return <Surface
          slug={derivedSlug}
          onBack={() => setRoute("notebook")}
          onJump={setRoute}
        />;
      }
      case "library": return window.LibraryScreen ? <window.LibraryScreen onJump={(target) => {
        // Distill buttons pass an object { screen, bookId, bookTitle }; all other
        // jumps are bare route strings. Without this destructure, setRoute(obj)
        // stored a non-string → switch fell through to HomeScreen silently.
        if (typeof target === 'string') { setRoute(target); return; }
        if (target && target.screen) {
          setBookCtx({ bookId: target.bookId || null, bookTitle: target.bookTitle || '' });
          setRoute(target.screen);
        }
      }} /> : <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
      case "book-reader": {
        const Surface = (typeof window.BookReaderScreen === 'function') ? window.BookReaderScreen : null;
        if (!Surface || !bookCtx || !bookCtx.bookId) {
          return <PreconditionEmpty
            title="阅读 · 待选书籍"
            reason="返回 library 选一本书，点「阅读」进入 MD 渲染视图。"
            onBack={() => { setBookCtx(null); setRoute('library'); }} />;
        }
        return <Surface
          bookId={bookCtx.bookId}
          bookTitle={bookCtx.bookTitle}
          onBack={() => { setBookCtx(null); setRoute('library'); }} />;
      }
      case "distillation-progress": {
        const Surface = (typeof window.DistillationProgressScreen === 'function') ? window.DistillationProgressScreen : null;
        if (!Surface || !bookCtx || !bookCtx.bookId) {
          return <PreconditionEmpty
            title="蒸馏 · 待选书籍"
            reason="蒸馏需要先在 library 选一本书。返回 library，点击任一本书右侧的 Distill。"
            onBack={() => { setBookCtx(null); setRoute('library'); }} />;
        }
        return <Surface
          bookId={bookCtx.bookId}
          bookTitle={bookCtx.bookTitle}
          onComplete={() => setRoute('book-spark-pack')}
          onCancel={() => { setBookCtx(null); setRoute('library'); }} />;
      }
      case "book-spark-pack": {
        const Surface = (typeof window.BookSparkPackScreen === 'function') ? window.BookSparkPackScreen : null;
        if (!Surface || !bookCtx || !bookCtx.bookId) {
          return <PreconditionEmpty
            title="Book Spark Pack · 待选书籍"
            reason="Spark Pack 需要先选一本已蒸馏的书。返回 library，点击「查看蒸馏」。"
            onBack={() => { setBookCtx(null); setRoute('library'); }} />;
        }
        return <Surface
          bookId={bookCtx.bookId}
          onBack={() => { setBookCtx(null); setRoute('library'); }} />;
      }
      // W8.3 Adaptive UX Personal Forks — settings surface for per-user
      // UX fork sub-layer. slug optional (falls through to global scope).
      case "ux-settings": {
        const Surface = (typeof window.UxSettingsScreen === 'function') ? window.UxSettingsScreen : null;
        if (!Surface) {
          return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        }
        const uxSlug = (goal && goal.slug) || (notebookCtx && notebookCtx.slug) || null;
        return <Surface slug={uxSlug} onBack={() => setRoute("home")} />;
      }
      case "grounding-review": {
        // W6.1 Book Grounding (BLUEPRINT §4) — surfaces Book Grounding Profile
        // + Synthesis BEFORE course skeleton lands. Slug + goal + bookIds come
        // from the goal state set by OnboardingScreen submit.
        const Surface = (typeof window.GroundingReviewScreen === 'function') ? window.GroundingReviewScreen : null;
        const gSlug = goal && goal.slug;
        const gContract = (goal && goal.goalContract) || null;
        const gBookIds = (goal && Array.isArray(goal.bookIds)) ? goal.bookIds : [];
        if (!Surface || !gSlug) {
          return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        }
        return <Surface
          slug={gSlug}
          goalContract={gContract}
          bookIds={gBookIds}
          onBack={() => setRoute("home")}
          onContinue={() => setRoute("lesson")}
        />;
      }
      case "product-blueprint": {
        // 2026-05-13 — list-first 入口 (BLUEPRINT §11.1 Product Pool 是 vault-level
        // standalone, 与课程解耦):
        //   - openProductId 为空 → ProductListScreen (列出所有产品, 创建新产品)
        //   - openProductId 已选 → ProductBlueprintScreen 进入编辑器, 走 productId 路径
        // Legacy slug 路径 (W3.x curriculum-bound) 在 productBlueprintSlug 显式 set
        // 时仍工作 (兼容性, 用于 floating 浮按 / cmd palette 旧调用)。
        const ListSurface = (typeof window.ProductListScreen === 'function') ? window.ProductListScreen : null;
        const EditorSurface = (typeof window.ProductBlueprintScreen === 'function') ? window.ProductBlueprintScreen : null;
        if (!ListSurface && !EditorSurface) {
          return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        }
        // openProductId 优先 — 用户从 list 点击进入产品后, 走 productId 路径。
        if (openProductId && EditorSurface) {
          return <EditorSurface
            productId={openProductId}
            onBack={() => { setOpenProductId(null); /* 返回到 list, route 不动 */ }}
            onSave={() => { /* hook-point: surface a toast. v0.1: silent. */ }}
          />;
        }
        // productBlueprintSlug = legacy 路径 (curriculum-bound W3.x). 当显式 set
        // 时直接进 editor — 用于 W3.x 旧调用 (e.g. lesson-chat ProductBadge).
        if (productBlueprintSlug && EditorSurface) {
          return <EditorSurface
            slug={productBlueprintSlug}
            onBack={() => { setProductBlueprintSlug(null); setRoute("home"); }}
            onSave={() => { /* hook-point. */ }}
          />;
        }
        // 默认 → 列表入口。
        if (ListSurface) {
          return <ListSurface
            onBack={() => setRoute("home")}
            onOpenProduct={(productId) => setOpenProductId(productId)}
          />;
        }
        return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
      }
      case "sparks":  return <WorkshopScreen onJump={setRoute} />;
      case "curriculum-graph": {
        // W6.4 — AI/CS curriculum graph (BLUEPRINT §20 v1.8). 48 knowledge
        // points across 6 layers (foundation → builder). Falls back to home
        // when the bridge isn't loaded (older builds, screenshot mode).
        const Surface = (typeof window.CurriculumGraphScreen === 'function') ? window.CurriculumGraphScreen : null;
        if (!Surface) {
          return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        }
        return <Surface masteredKpIds={[]} onBack={() => setRoute("home")} />;
      }
      case "radar-dashboard": {
        // W6.3 — Research Radar dashboard (BLUEPRINT §15 + ROADMAP v1.7).
        // Subscriptions / reports / manual run / spark-promotion. Slug-
        // resolution mirrors spark-pool / kpi-dashboard.
        const derivedSlug = (() => {
          if (productBlueprintSlug) return productBlueprintSlug;
          if (goal && goal.slug) return goal.slug;
          const ref = goal && goal.noteRel;
          if (ref) {
            const m = String(ref).match(/^([^\\/]+)[\\/]lesson-(\d+)\.md$/);
            if (m) return m[1];
          }
          if (Array.isArray(courses) && courses[0] && courses[0].topic) return courses[0].topic;
          return null;
        })();
        const Surface = (typeof window.RadarDashboardScreen === 'function') ? window.RadarDashboardScreen : null;
        if (!Surface) {
          return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        }
        if (!derivedSlug) {
          return <PreconditionEmpty
            title="前沿雷达"
            reason="前沿雷达扫的是某一课题的最新论文与会议产出 — 还没告诉它你在学什么。先开一节课程, 雷达才知道往哪扫。"
            onBack={() => setRoute("home")}
            onCreate={handleCreateNew}
          />;
        }
        return <Surface slug={derivedSlug} onBack={() => setRoute("home")} />;
      }
      case "spark-pool": {
        // W3.4 — product spark pool (list + detail + state-machine transitions).
        // Slug source priority mirrors product-blueprint route. 2026-05-13 加
        // courses[0].topic fallback + PreconditionEmpty 替静默 Home fallback.
        const derivedSlug = (() => {
          if (productBlueprintSlug) return productBlueprintSlug;
          if (goal && goal.slug) return goal.slug;
          const ref = goal && goal.noteRel;
          if (ref) {
            const m = String(ref).match(/^([^\\/]+)[\\/]lesson-(\d+)\.md$/);
            if (m) return m[1];
          }
          if (Array.isArray(courses) && courses[0] && courses[0].topic) return courses[0].topic;
          return null;
        })();
        const Surface = (typeof window.SparkPoolScreen === 'function') ? window.SparkPoolScreen : null;
        if (!Surface) {
          return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        }
        if (!derivedSlug) {
          return <PreconditionEmpty
            title="Spark 池"
            reason="Spark 池收容你课程里冒出来的火苗 — 还没起课, 火也无处可起。先开一节课程, 让它有处可冒。"
            onBack={() => setRoute("home")}
            onCreate={handleCreateNew}
          />;
        }
        return <Surface slug={derivedSlug} onBack={() => setRoute("home")} />;
      }
      case "flywheel-dashboard": {
        // W8.2 — Learning Commons Flywheel dashboard (Note → Spark → Pack →
        // Commons → Lesson). Slug-resolution mirrors spark-pool exactly so
        // routing pattern stays uniform.
        const derivedSlug = (() => {
          if (productBlueprintSlug) return productBlueprintSlug;
          if (goal && goal.slug) return goal.slug;
          const ref = goal && goal.noteRel;
          if (!ref) return null;
          const m = String(ref).match(/^([^\\/]+)[\\/]lesson-(\d+)\.md$/);
          return m ? m[1] : null;
        })();
        const Surface = (typeof window.FlywheelDashboardScreen === 'function') ? window.FlywheelDashboardScreen : null;
        if (!Surface) {
          return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        }
        if (!derivedSlug) {
          return <PreconditionEmpty
            title="Flywheel · 课程飞轮"
            reason="Flywheel 看的是一节课程在 Note → Spark → Pack → Commons → Lesson 之间的转动 — 还没起轮。先开一节课程, 轮才能转。"
            onBack={() => setRoute("home")}
            onCreate={handleCreateNew}
          />;
        }
        return <Surface slug={derivedSlug} onBack={() => setRoute("home")} />;
      }
      case "kpi-dashboard": {
        // W4.2 — Closed Beta KPI dashboard. Slug-resolution mirrors the
        // spark-pool route exactly (1: productBlueprintSlug, 2: goal.slug,
        // 3: derive from noteRel, 4: first course). Falls back to home
        // when no slug is resolvable (defensive — entry button is only
        // visible when at least one slug exists).
        const derivedSlug = (() => {
          if (productBlueprintSlug) return productBlueprintSlug;
          if (goal && goal.slug) return goal.slug;
          const ref = goal && goal.noteRel;
          if (ref) {
            const m = String(ref).match(/^([^\\/]+)[\\/]lesson-(\d+)\.md$/);
            if (m) return m[1];
          }
          if (Array.isArray(courses) && courses[0] && courses[0].topic) return courses[0].topic;
          return null;
        })();
        const Surface = (typeof window.KPIDashboardScreen === 'function') ? window.KPIDashboardScreen : null;
        if (!Surface) {
          return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        }
        if (!derivedSlug) {
          return <PreconditionEmpty
            title="KPI · 闭测度量"
            reason="KPI 是给一节具体课程的可观测点 — 还没开课, 没有可读的数。先开一节课程, 让 KPI 有据可记。"
            onBack={() => setRoute("home")}
            onCreate={handleCreateNew}
          />;
        }
        return <Surface slug={derivedSlug} onBack={() => setRoute("home")} />;
      }
      case "launch-readiness": {
        // W8.1 — Public Launch readiness panel. App-global (slug-less);
        // reads window.ptor.launch.fullReport() once on mount. Falls back
        // to home when the Surface isn't loaded (defensive).
        const Surface = (typeof window.LaunchReadinessScreen === 'function') ? window.LaunchReadinessScreen : null;
        if (!Surface) {
          return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        }
        return <Surface onBack={() => setRoute("home")} />;
      }
      case "exam-dashboard": {
        // W7.2 — Exam System Alpha. Slug-resolution mirrors kpi-dashboard /
        // spark-pool. Reads window.ptor.exam.* (scope / cadence / errorLog /
        // finalTasks).
        // 2026-05-13 — slug 不再硬卡。"这门考试是 ___" 输入条 (P2 generic
        // exam-type) 设计上**先于** curriculum 声明 — 空 vault 也应可命名考试,
        // 否则点击工具 → 考试 静默 fallback 到 Home, 用户感觉无效。dashboard
        // 内部 load() 已对 !slug 早退, 4-tier ScopeBlock 空态显 "—"。
        const derivedSlug = (() => {
          if (productBlueprintSlug) return productBlueprintSlug;
          if (goal && goal.slug) return goal.slug;
          const ref = goal && goal.noteRel;
          if (ref) {
            const m = String(ref).match(/^([^\\/]+)[\\/]lesson-(\d+)\.md$/);
            if (m) return m[1];
          }
          if (Array.isArray(courses) && courses[0] && courses[0].topic) return courses[0].topic;
          return null;
        })();
        const Surface = (typeof window.ExamDashboardScreen === 'function') ? window.ExamDashboardScreen : null;
        if (!Surface) {
          return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        }
        return <Surface slug={derivedSlug} onBack={() => setRoute("home")} />;
      }
      case "scenario-dashboard": {
        // W4.1 — 7-Day Growth Path (AI Builder) dashboard. Slug-resolution
        // mirrors kpi-dashboard / spark-pool (1: productBlueprintSlug, 2:
        // goal.slug, 3: derive from noteRel, 4: first course). The dashboard
        // reads scenario-events.jsonl via window.ptor.scenario.state — no
        // vault scan, no client-side polling. Clicking the ACTIVE day card
        // routes to LessonChat (lesson route) for that day's lesson body.
        const derivedSlug = (() => {
          if (productBlueprintSlug) return productBlueprintSlug;
          if (goal && goal.slug) return goal.slug;
          const ref = goal && goal.noteRel;
          if (ref) {
            const m = String(ref).match(/^([^\\/]+)[\\/]lesson-(\d+)\.md$/);
            if (m) return m[1];
          }
          if (Array.isArray(courses) && courses[0] && courses[0].topic) return courses[0].topic;
          return null;
        })();
        const Surface = (typeof window.ScenarioDashboardScreen === 'function') ? window.ScenarioDashboardScreen : null;
        if (!Surface || !derivedSlug) {
          return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        }
        return <Surface
          slug={derivedSlug}
          onBack={() => setRoute("home")}
          onOpenLesson={(_dayIdx) => setRoute("lesson")}
        />;
      }
      case "pack-learning": {
        // W7.1 — Pack detail surface (BLUEPRINT §12.4 + §12.5). Reads
        // currentPack state set by upstream surfaces (Library / Commons
        // browser). slug source priority mirrors product-blueprint /
        // spark-pool. Falls back to HomeScreen when either the pack or
        // the screen module is missing (defensive — entry button is only
        // visible when a pack is bound).
        const derivedSlug = (() => {
          if (productBlueprintSlug) return productBlueprintSlug;
          if (goal && goal.slug) return goal.slug;
          const ref = goal && goal.noteRel;
          if (ref) {
            const m = String(ref).match(/^([^\\/]+)[\\/]lesson-(\d+)\.md$/);
            if (m) return m[1];
          }
          if (Array.isArray(courses) && courses[0] && courses[0].topic) return courses[0].topic;
          return null;
        })();
        const Surface = (typeof window.PackLearningScreen === 'function') ? window.PackLearningScreen : null;
        const userContext = {
          goal: (goal && goal.goalContract && goal.goalContract.north_star_goal) || '',
          currentLesson: (goal && goal.goalContract) ? { topic: goal.goalContract.north_star_goal } : null,
          masteryMap: {},
          products: [],
        };
        if (!Surface) {
          return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        }
        if (!currentPack) {
          return <PreconditionEmpty
            title="Pack · 知识包"
            reason="Pack 学习要先在 Library / Commons 选一个包 — 现在没绑定任何包。回 Library 选一个, 或先开一节课程养出可装包的笔记。"
            cta="去 Library 选包"
            onBack={() => setRoute("home")}
            onCreate={() => setRoute("library")}
          />;
        }
        return <Surface
          pack={currentPack}
          slug={derivedSlug}
          userContext={userContext}
          onBack={() => setRoute("home")}
        />;
      }
      case "capture": {
        // W1.5 — true-classroom capture surface. Falls back to a no-op screen
        // if window.CaptureScreen isn't loaded yet (script-order guard).
        const Surface = (typeof window.CaptureScreen === 'function') ? window.CaptureScreen : null;
        if (!Surface) return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        return <Surface
          source={captureSource}
          context={(goal && goal.goalContract) ? { course_slug: goal.slug, lecture_title: goal.goalContract.north_star_goal } : {}}
          goal={goal}
          onFinish={({ sessionId }) => {
            setCaptureSessionId(sessionId);
            setRoute("finishRitual");
          }}
          onAbort={() => {
            setCaptureSessionId(null);
            setRoute("home");
          }}
        />;
      }
      case "finishRitual": {
        const Surface = (typeof window.FinishRitualScreen === 'function') ? window.FinishRitualScreen : null;
        if (!Surface) return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        return <Surface
          sessionId={captureSessionId}
          goal={goal}
          onDone={(result) => {
            // After Finish Ritual lands the lesson note, route to the
            // notebook view of the freshly written note. W5.2 (Web Note
            // Engine) will take over from there once shipped.
            setCaptureSessionId(null);
            if (result && result.lessonNotePath) {
              // Derive a vault-relative noteRel from the absolute path the
              // backend returns. Best-effort — fall back to home on miss.
              const rel = deriveVaultRel(result.lessonNotePath);
              if (rel) {
                setGoal((g) => ({ ...(g || {}), noteRel: rel, slug: result.slug || (g && g.slug) }));
                const m = rel.match(/^([^\\/]+)[\\/]lesson-(\d+)\.md$/);
                if (m) {
                  setNotebookCtx({ noteRel: rel, slug: m[1], lessonIdx: Number(m[2]), userIntent: null });
                  setRoute("notebook");
                  return;
                }
              }
            }
            setRoute("home");
          }}
          onAbort={() => {
            setCaptureSessionId(null);
            setRoute("home");
          }}
        />;
      }
      // W8.4 Feedback Channel — BLUEPRINT §19.3. Voluntary user input routed
      // to a vault-side ledger. Slug derives from goal/courses priority chain
      // shared with kpi-dashboard / spark-pool. Falls back to 'global' so the
      // surface works even when no course is loaded.
      case "feedback": {
        const derivedSlug = (() => {
          if (goal && goal.slug) return goal.slug;
          const ref = goal && goal.noteRel;
          if (ref) {
            const m = String(ref).match(/^([^\\/]+)[\\/]lesson-(\d+)\.md$/);
            if (m) return m[1];
          }
          if (Array.isArray(courses) && courses[0] && courses[0].topic) return courses[0].topic;
          return 'global';
        })();
        const Surface = (typeof window.FeedbackScreen === 'function') ? window.FeedbackScreen : null;
        if (!Surface) return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        return <Surface slug={derivedSlug} onBack={() => setRoute("home")} />;
      }
      // W8.4 Donate — BLUEPRINT §19.2. Tier ladder + non-cash perks ledger.
      case "donate": {
        const Surface = (typeof window.DonateScreen === 'function') ? window.DonateScreen : null;
        if (!Surface) return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        return <Surface userId={'local'} onBack={() => setRoute("home")} />;
      }
      // W8.4 Cost Budget — BLUEPRINT §17.3. Per-lesson cap + daily ¥ ceiling.
      case "cost-budget": {
        const derivedSlug = (() => {
          if (goal && goal.slug) return goal.slug;
          const ref = goal && goal.noteRel;
          if (ref) {
            const m = String(ref).match(/^([^\\/]+)[\\/]lesson-(\d+)\.md$/);
            if (m) return m[1];
          }
          if (Array.isArray(courses) && courses[0] && courses[0].topic) return courses[0].topic;
          return null;
        })();
        const derivedLesson = (() => {
          const ref = goal && goal.noteRel;
          if (ref) {
            const m = String(ref).match(/^([^\\/]+)[\\/]lesson-(\d+)\.md$/);
            if (m) return Number(m[2]);
          }
          return 0;
        })();
        const Surface = (typeof window.CostBudgetScreen === 'function') ? window.CostBudgetScreen : null;
        if (!Surface) return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        return <Surface
          slug={derivedSlug}
          lessonIdx={derivedLesson}
          tier={'Pro'}
          userId={'local'}
          onBack={() => setRoute("home")} />;
      }
      // γ13 Commons — System 6. Browse / export / import .hypha-pack.
      case "commons": {
        const derivedSlug = (() => {
          if (goal && goal.slug) return goal.slug;
          const ref = goal && goal.noteRel;
          if (ref) {
            const m = String(ref).match(/^([^\\/]+)[\\/]lesson-(\d+)\.md$/);
            if (m) return m[1];
          }
          if (Array.isArray(courses) && courses[0] && courses[0].topic) return courses[0].topic;
          return null;
        })();
        const Surface = (typeof window.CommonsScreen === 'function') ? window.CommonsScreen : null;
        if (!Surface) return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        return <Surface currentSlug={derivedSlug} onBack={() => setRoute("home")} />;
      }
      // β23 North Star Panel — Goal System 阶 3. Mastery-state metric replaces
      // lessons.length. Falls back to HomeScreen if the script hasn't loaded.
      case "north-star": {
        const Surface = (typeof window.NorthStarScreen === 'function') ? window.NorthStarScreen : null;
        if (!Surface) return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        return <Surface goal={goal} onBack={() => setRoute("home")} />;
      }
      // 2026-05-17 Gap 1 — chain plan surface. Mounted after chain:create
      // resolves successfully. chainPlan = full chainData (chain.json shape),
      // chainSlug = chain meta-folder slug. Accept fires chain:accept then
      // chain:start; cancel returns to onboarding.
      case "chain-plan": {
        const Surface = (typeof window.ChainPlanScreen === 'function') ? window.ChainPlanScreen : null;
        if (!Surface) {
          return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        }
        return <Surface
          slug={chainSlug}
          plan={chainPlan}
          routeInfo={chainRouteInfo}
          buildLog={createLog}
          onAcceptChain={async () => {
            // chain:accept lazy-commits all links (none active yet); chain:start
            // then activates link 0 by running its curriculum. After start
            // succeeds we set goal + route into the lesson screen so daily
            // lessons begin.
            const acceptFn = window.ptor && window.ptor.hypha && window.ptor.hypha.chainAccept;
            const startFn  = window.ptor && window.ptor.hypha && window.ptor.hypha.chainStart;
            if (typeof acceptFn !== "function" || typeof startFn !== "function") {
              throw new Error("chain accept/start bridge missing");
            }
            const acceptR = await acceptFn({ slug: chainSlug });
            if (!acceptR || acceptR.ok === false) {
              throw new Error((acceptR && acceptR.error) || "chain:accept failed");
            }
            const startR = await startFn({ chainSlug });
            if (!startR || startR.ok === false) {
              throw new Error((startR && startR.error) || "chain:start failed");
            }
            // Seed goal so LessonChat finds noteRel + slug.
            const firstSlug = startR.firstSlug;
            const lessonRel = startR.lessonRel || (firstSlug ? `${firstSlug}/lesson-0.md` : null);
            const ultimateGoal = (chainPlan && (chainPlan.ultimate_goal || (chainPlan.chain && chainPlan.chain.ultimate_goal))) || "";
            setGoal({
              noteRel: lessonRel,
              slug: firstSlug,
              goalContract: {
                north_star_goal: ultimateGoal,
                current_level: 'self-directed adult learner',
              },
            });
            setRoute("lesson");
          }}
          onCancel={() => {
            // Return to onboarding so the user can rewrite the goal.
            setChainPlan(null);
            setChainSlug(null);
            setChainRouteInfo(null);
            setOnboarded(false);
          }}
        />;
      }
      // Phase F.1 (2026-05-18) — Goal Crystallizer wizard surface. Mounts
      // during the Promise-pause in onboarding's onComplete handler. Resolves
      // wizardResolverRef.current() to release the awaiting handler. The wizard
      // itself queries goal:crystallize:questions IPC on mount, then renders
      // accordion-progressive multi-choice flow per Muse design spec.
      case "goal-crystallizer": {
        const Surface = (typeof window.GoalCrystallizerScreen === 'function') ? window.GoalCrystallizerScreen : null;
        if (!Surface || !wizardStash) {
          // No wizard available / no stash → resolve as skipped to unblock handler
          if (wizardResolverRef.current) {
            const r = wizardResolverRef.current;
            wizardResolverRef.current = null;
            r({ skipped: true, crystallized_goal: null, tags: null });
          }
          return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        }
        const _resolveWizard = (result) => {
          setWizardStash(null);
          if (wizardResolverRef.current) {
            const r = wizardResolverRef.current;
            wizardResolverRef.current = null;
            r(result);
          }
        };
        return <Surface
          draftGoal={wizardStash.draftGoal}
          archetype={wizardStash.archetype}
          onConfirm={(result) => _resolveWizard(result)}
          onSkip={() => _resolveWizard({ skipped: true, crystallized_goal: null, tags: null })}
          onCancel={() => _resolveWizard({ cancelled: true })}
        />;
      }
      // Phase E.0/E.1 (2026-05-18) — Library Coverage Gate surface. Mounts
      // when onboarding submit fired library:coverage and got has_coverage=false.
      // chainGateInfo carries {goal, archetype, coverage, recommended};
      // pendingCreation.resumeFn is the closure that resumes chain:create or
      // curriculumCreate after user picks skip or upload-and-continue.
      case "library-gate": {
        const Surface = (typeof window.LibraryGateScreen === 'function') ? window.LibraryGateScreen : null;
        if (!Surface || !chainGateInfo) {
          return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        }
        const _resume = async (mode) => {
          const fn = pendingCreation && pendingCreation.resumeFn;
          // Clear gate state, restore loading UI, then invoke continuation.
          setChainGateInfo(null);
          setIsCreatingCurriculum(true);
          setRoute("create"); // pseudo-route so loading screen shows again
          if (typeof fn === 'function') {
            try { await fn(); }
            catch (e) { console.error('[library-gate] resume failed:', e); }
          }
          setPendingCreation(null);
        };
        return <Surface
          goal={chainGateInfo.goal}
          archetype={chainGateInfo.archetype}
          coverage={chainGateInfo.coverage}
          recommended={chainGateInfo.recommended}
          onSkip={() => _resume('skip')}
          onContinueAfterUpload={(_uploaded) => _resume('upload')}
          onCancel={() => {
            setChainGateInfo(null);
            setPendingCreation(null);
            setIsCreatingCurriculum(false);
            setOnboarded(false);
          }}
        />;
      }
      // Phase C · 5c — Lifetime Ledger surface. Per-chain weekly self-report
      // ledger with axis progress + variance dashboard + history list.
      // Mounts via window.LifetimeLedgerScreen exposed by
      // screen-lifetime-ledger.jsx. archetype is sourced from chainPlan when
      // present, then goal.archetype, then 'HUMANITIES' as the 5-axis default.
      case "lifetime": {
        const Surface = (typeof window.LifetimeLedgerScreen === 'function') ? window.LifetimeLedgerScreen : null;
        if (!Surface) {
          return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
        }
        const archetypeForLedger = (chainPlan && (chainPlan.archetype || (chainPlan.chain && chainPlan.chain.archetype)))
          || (goal && goal.archetype)
          || 'HUMANITIES';
        return <Surface
          slug={goal && goal.slug}
          chainSlug={chainSlug || (goal && goal.slug)}
          archetype={archetypeForLedger}
          onBack={() => setRoute('home')}
        />;
      }
      default:        return <HomeScreen user={USER} arc={ARC} onOpenLesson={() => setRoute("lesson")} onRoute={setRoute} courses={courses} onResumeCourse={handleResumeCourse} onCreateNew={handleCreateNew} />;
    }
  })();

  // 2026-05-18 bugfix: isCreatingCurriculum gate hoisted ABOVE !onboarded.
  // Wizard intercept (waitForWizardConfirm) sets onboarded=true to prevent
  // OnboardingScreen from overlaying the wizard. After wizard confirm,
  // setIsCreatingCurriculum(true) fires but onboarded stays true → the old
  // gate `if (!onboarded)` never caught the loading state → goal-crystallizer
  // case fallback rendered HomeScreen during the 30-60s curriculum:create
  // window. User report: "5 questions then 开始生成 → 直接跳到 HOME页面".
  if (isCreatingCurriculum) {
    // 2026-05-17 — BuildLogScreen loaded via HYPHA.html script tag, exposed
    // on window. Fallback to inline minimal spinner if script tag missing
    // (graceful — never blocks curriculum creation).
    const BuildLog = (typeof window !== "undefined" && window.BuildLogScreen) || null;
    if (BuildLog) {
      return (
        <BuildLog
          topic={pendingTopic}
          currentStage={createStage}
          log={createLog}
          error={createError}
        />
      );
    }
    return (
      <div className="fade-in col" style={{
        minHeight: "100vh", padding: "80px 60px", gap: 24,
        alignItems: "center", justifyContent: "center",
      }}>
        <div className="serif italic" style={{ fontSize: 36, color: "var(--ink-1)" }}>正在备课</div>
        <div className="mono t-small" style={{ color: "var(--ink-3)", letterSpacing: ".15em" }}>{pendingTopic}</div>
        <div className="mono t-small" style={{ color: "var(--ink-2)", minHeight: 18 }}>{createStage || "starting…"}</div>
        {createError && <div style={{ color: "var(--terracotta)", maxWidth: 600, textAlign: "center" }}>{createError}</div>}
      </div>
    );
  }

  if (!onboarded) {
    return <OnboardingScreen createError={createError} onComplete={async (payload) => {
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
      setCreateStage("评估目标可行性…");

      // Phase F.1 (2026-05-18) — Goal Crystallizer wizard intercept.
      // Pause here, render wizard route, resume when user confirms/skips/cancels.
      // The wizard's onConfirm resolves the Promise; we then merge crystallized
      // goal + tags into `gc` so downstream route-goal + library-coverage +
      // chain:create see the SPECIFIC goal (not the fog draft).
      //
      // Phase F.1 Gap 1 fix (2026-05-18) — archetype inferred from goal text
      // via keyword heuristic (! LLM, snappy UX). Wrong archetype = wrong
      // wizard dimensions; previously hard-coded HUMANITIES misfit TECH goals.
      if (typeof waitForWizardConfirm === 'function') {
        try {
          // Lazy-load + infer archetype from goal. Heuristic is regex-only;
          // fallback HUMANITIES if module fails to load.
          let inferredArchetype = 'HUMANITIES';
          try {
            const gcInfer = window.ptor && window.ptor.hypha && window.ptor.hypha.inferArchetype;
            if (typeof gcInfer === 'function') {
              const r = await gcInfer(topic);
              if (r && r.ok && typeof r.archetype === 'string' && r.archetype) {
                inferredArchetype = r.archetype;
              }
            }
          } catch (err) {
            console.warn('[onboarding] inferArchetype failed (non-fatal, defaulting HUMANITIES):', err && err.message);
          }
          const wizardResult = await waitForWizardConfirm({
            draftGoal: topic,
            archetype: inferredArchetype,
          });
          // Re-enter creating UI after wizard returns.
          setIsCreatingCurriculum(true);
          if (wizardResult && wizardResult.cancelled) {
            // User backed out — leave onboarding state intact + abort.
            setIsCreatingCurriculum(false);
            setOnboarded(false);
            setRoute('home');
            return;
          }
          if (wizardResult && !wizardResult.skipped && wizardResult.crystallized_goal) {
            gc.north_star_goal = wizardResult.crystallized_goal;
            gc._crystallized_tags = wizardResult.tags || null;
            setCreateLog(log => log.concat([{
              stage: 'goal:crystallized',
              label: `目标切清 · ${wizardResult.crystallized_goal.slice(0, 40)}${wizardResult.crystallized_goal.length > 40 ? '…' : ''}`,
              ts: Date.now(),
              payload: wizardResult,
            }]));
          } else {
            setCreateLog(log => log.concat([{
              stage: 'goal:wizard-skipped',
              label: '跳过 wizard · 直接用草稿生成',
              ts: Date.now(),
              payload: { skipped: true },
            }]));
          }
        } catch (wizErr) {
          console.warn('[onboarding] wizard intercept failed (non-fatal):', wizErr);
        }
      }
      // 2026-05-17 build-log — reset on each fresh creation so user sees a
      // clean log (not stale entries from a previous failed attempt).
      setCreateLog([{
        stage: "feasibility:start",
        label: "评估目标可行性…",
        ts: Date.now(),
        payload: { topic },
      }]);

      // Machino-δ6 (2026-05-14) — Goal Feasibility Guardian gate. Math anchor
      // (Macnamara/Donner-Hardy) + T4_JUDGE LLM produce a 3-tier verdict:
      //   absurd   → HARD BLOCK; user must rewrite goal before continuing
      //   strained → soft warn via window.confirm; user can override
      //   feasible → silent pass-through
      // Failure mode = fail-open (verdict.ok===false → log + proceed). We do
      // not want a flaky LLM/network to gate course creation entirely;
      // absurd-blocking is a best-effort wall, not a SPOF.
      // 2026-05-17 哲学 pivot — HYPHA = 设计 + 尽一切手段趋近, ! 守门人。
      // user 2026-05-17 ロック: "人类诞生概率 10^-40000, 我们要做的是设计, 然后
      // 尽所有可能性和手段最大程度趋近"。
      //
      // OLD: Goal Guardian = GATE (absurd → hard block / strained → native confirm dialog).
      // NEW: Goal Guardian = INFO (verdict + reasoning 进 BuildLog 第一条作 context,
      //      ! 拦截 user)。下游 designLesson 用 verdict 调 scope 密度, 不拒绝创课。
      // 唯一保留 hard block: north_star_goal 完全空 (UI 已 require, 这是双保险).
      try {
        const guardianFn = window.ptor && window.ptor.creation && window.ptor.creation.goalEvaluate;
        if (typeof guardianFn === "function") {
          const res = await guardianFn(gc);
          if (res && res.ok && res.verdict) {
            const v = res.verdict;
            // 把 guardian verdict 作为 BuildLog 第一条 INFO row, ! 弹窗。
            // 用户看见 HYPHA "知道" 这条路有多长, 但 HYPHA 仍然开始设计。
            setCreateLog(log => log.concat([{
              stage: "feasibility:assessed",
              label: `目标评估完成 · ${v.verdict === "feasible" ? "可行" : v.verdict === "strained" ? "紧张但可设计" : "极远但仍设计"}`,
              ts: Date.now(),
              payload: {
                verdict: v.verdict,
                headline: v.headline,
                reasoning: v.reasoning,
                suggestions: v.suggestions,
                math: v.math,
              },
            }]));
            // 也存进 goalContract 让 designLesson 后续读到, 用来调 scope 密度。
            gc._feasibility = {
              verdict: v.verdict,
              headline: v.headline,
              reasoning: v.reasoning,
              suggestions: v.suggestions,
              math: v.math,
            };
            console.log("[onboarding] feasibility assessed:", v.verdict, "— proceeding (HYPHA designs every path).");
          } else if (res && res.ok === false) {
            console.warn("[onboarding] goal guardian returned error, proceeding:", res.error);
          }
        }
      } catch (guardianErr) {
        console.warn("[onboarding] goal guardian threw, proceeding:", guardianErr && guardianErr.message);
      }

      setCreateStage("starting…");

      // Subscribe to curriculum:create:progress events so the user sees stages,
      // not a frozen screen. Defensive — bridge may be absent in some build modes.
      // 2026-05-13: humanize critique-loop stage strings so user sees readable
      // 三师议课 / 重写 progress (per 三令五申 visible-labor rule).
      const humanizeStage = (evt) => {
        const s = String(evt.stage || '');
        const ext = (k) => (evt && evt[k] != null) ? evt[k] : null;
        const map = {
          'archetype': '认题型',
          'visual_archetype': '视觉骨架',
          'harvest:start': '采集开始',
          'harvest:done': '采集完成',
          'reading-source': '读取上传',
          'curate:done': () => `源材料 · ${ext('sourceCount') || 0} 条`,
          'design:start': '初稿骨架',
          'design:done': () => `初稿 · ${ext('lesson_count') || 0} 节`,
          // 2026-05-17 Pillar 4 — Weaver / Whetstone / Witness 真接入版 (取代
          // 旧 Lung/Muse/Scout 占位)。新事件保留为 critique:start / *:done /
          // critique:done / revise:* — 老 critique:lung:* / critique:muse:* /
          // critique:scout:* / refine:* 也保留, 防遗留路径回退时空 label。
          // 2026-05-17 Gap 3 — multi-round loop labels. critique:round-start /
          // converged / loop-done are emitted by runCritiqueLoop wrapper; the
          // legacy single-round 'critique:start' below still fires once per
          // round from runCritique itself.
          'critique:round-start':  () => `三审第 ${ext('round') || 1}/${ext('max') || 2} 轮启动`,
          'critique:converged':    () => `三审收敛于第 ${ext('round') || 1} 轮 · 骨架通过`,
          'critique:loop-done':    () => `三审总耗 ${ext('total_rounds') || 0} 轮 · ${ext('converged') ? '收敛' : '未收敛'}`,
          'critique:start': () => `三审启动 · Weaver / Whetstone / Witness · ${ext('count') || 3} 路并行`,
          'weaver:done':    () => {
            const samples = ext('samples') || [];
            const sampleStr = samples.length > 0 ? ` · 例: ${String(samples[0] || '').slice(0, 28)}` : '';
            return `Weaver · 漏视角 ${ext('missing_lenses_count') || 0} 个${sampleStr}`;
          },
          'whetstone:done': () => `Whetstone · 弱 KP ${ext('weak_kps_count') || 0} 个 · 高危 ${ext('severity_high_count') || 0}`,
          'witness:done':   () => `Witness · 源/节 ${ext('ratio') || 0} · ${ext('judgment') || '?'}`,
          'critique:done':  () => `三审完毕 · ${ext('will_revise') ? '需修订' : '骨架通过'}`,
          'critique:skipped': '三审 · 略 (无初稿)',
          'critique:failed':  () => `三审异常 · ${ext('error') || '?'} · 继续原 skeleton`,
          'revise:start':     '骨架修订中…',
          'revise:done':      () => `骨架修订完 · ${ext('lessons_changed') || 0} 节 / ${ext('kps_changed') || 0} KP 调整`,
          'revise:failed':    () => `修订失败 · ${ext('reason') || '?'} · 用初稿`,
          // 旧 Lung/Muse/Scout 占位 label (legacy fallback if 旧 agent.js path
          // 误触发, 保 ! 空 label)
          'critique:lung:start':  '浪师 · (legacy)',
          'critique:lung:done':   () => `浪师 · 完 (${ext('findings_n') || 0} 处, legacy)`,
          'critique:muse:start':  '谬师 · (legacy)',
          'critique:muse:done':   () => `谬师 · 完 (${ext('findings_n') || 0} 处, legacy)`,
          'critique:scout:start': '侦师 · (legacy)',
          'critique:scout:done':  () => `侦师 · 完 (${ext('findings_n') || 0} 处, legacy)`,
          'refine:start':         '整合三师 · 重写骨架 (legacy)',
          'refine:done':          () => `重写 · 完 · ${ext('lesson_n') || 0} 节 (legacy)`,
          'refine:skipped':       '重写 · 略 (legacy)',
          'refine:failed':        '重写 · 失败 (legacy)',
          // 2026-05-17 build-log enrichment — humanize stages emitted by
          // _runCurriculumCreate so BuildLogScreen rows have readable labels
          // even before user clicks to expand the payload.
          // 2026-05-17 阶 2 — difficulty scaling signal. Tells user the course
          // size + harvest depth are calibrated to goal difficulty (0-1).
          // 2026-05-17 Pillar 1 — single-vs-chain dispatcher row. Emitted by
          // the renderer itself (synthetic event) before any main.js stage.
          'route:decided':                () => `规划路由 · ${ext('flow') || '?'} · ${ext('reason') || ''}`,
          'difficulty:set':               () => `难度 ${ext('difficulty')} · lesson × ${ext('mult') || ((0.7 + Number(ext('difficulty')) * 1.5).toFixed(2))}`,
          'harvest:difficulty':           () => `源材料预算 · 难度 ${ext('difficulty')}`,
          // 2026-05-17 HYPHA-native scout — 6-维 LLM 驱动 query expansion.
          'scout:start':                  () => `侦察兵出 · 北极星 "${String(ext('northStar') || '').slice(0, 24)}…"`,
          'scout:queries-generated':      () => `第 ${ext('round') || '?'} 轮 · 拟 ${ext('count') || 0} 个搜索角度`,
          'scout:search-round-done':      () => `第 ${ext('round') || '?'} 轮 · 收 ${ext('sourceCount') || 0} 源`,
          'scout:coverage-assessed':      () => `覆盖度评估 · ${ext('willRefine') ? '还差' : '足'} · 缺 ${(ext('gaps') || []).length} 维`,
          'scout:tavily-skipped':         '! Tavily key · 走 Wikipedia + arxiv fallback',
          'scout:assess-error':           () => `评估异常 · ${ext('error') || '?'} · 跳过补搜`,
          'scout:done':                   () => `侦察完毕 · 跑 ${ext('rounds') || 1} 轮 · 共 ${ext('totalSources') || 0} 源`,
          'scout:merged':                 () => `侦察源并入 · +${ext('added') || 0} · 总 ${ext('total') || 0}`,
          'scout:failed':                 () => `侦察失败 · ${ext('error') || '?'} · harvest 源不变`,
          'feasibility:start':            '评估目标可行性…',
          'feasibility:assessed':         () => `目标评估完成 · ${ext('verdict') === 'feasible' ? '可行' : ext('verdict') === 'strained' ? '紧张但可设计' : '极远但仍设计'}`,
          // 2026-05-17 HYPHA Gap 2 — case-trajectory hallucination filter signal.
          // After LLM parses cases from scout sources, a deterministic
          // source-claim consistency filter drops rows whose name/year/url
          // don't appear in actual sources (i.e. LLM completed from training
          // memory). This row tells user how many survived.
          'estimate:hallucination-filtered': () => `案例核验 · 保留 ${ext('kept') || 0} / 共 ${ext('raw') || 0} · 过滤 ${ext('filtered') || 0} 幻觉`,
          'harvesting':                   '采集开始',
          'designing':                    () => `初稿设计 · 源 ${ext('sourceCount') || 0} 条`,
          'designing-archetype':          () => `认题型 · ${ext('reused') ? '复用 pre-harvest' : '开始'}`,
          'designing-archetype-done':     () => `认题型 · 完 · ${ext('archetype') || '?'}`,
          'designing-digest':             'digest · 开始压缩源材料',
          'designing-digest-done':        () => `digest · 完 · ${ext('digest_chars') || 0} 字`,
          'lesson-count-derived':         () => `算节数 · ${ext('target') || '?'} 节`,
          'designing-seed':               '骨架 · 开始',
          'designing-seed-done':          () => `骨架 · 完 · ${ext('lesson_count') || 0} 节`,
          'writing-lessons':              () => `写入 · ${ext('lessonCount') || 0} 节 · ${ext('archetype') || ''}`,
          'writing-body-0':               '写第 1 节 body',
          'body-0:done':                  () => `第 1 节 body · 完 · ${ext('kp_count') || 0} 个 KP`,
          'done':                         () => `课程已就绪 · ${(ext('lessonRels') || []).length} 节`,
          'error':                        () => `失败 · ${ext('error') || '未知'}`,
          // 2026-05-17 Phase B Gap 4 — GraphRAG over Library. Labels for
          // library:graph-progress stream (fired on book upload + manual
          // rebuild). Used by per-book graph-build indicator + build-log.
          'graph-rag:extract:start':      () => `知识图 · 抽取实体启动 · ${ext('chunkCount') || 0} 章节`,
          'graph-rag:extract:batch':      () => `知识图 · 抽取 第 ${(ext('batchIdx') || 0) + 1}/${ext('batchCount') || 1} 批`,
          'graph-rag:extract:done':       () => `知识图 · 抽取完毕 · 节点 ${ext('nodes') || 0} · 边 ${ext('edges') || 0} · LLM 调 ${ext('llmCalls') || 0}`,
          'graph-rag:community:start':    '知识图 · 社区检测启动',
          'graph-rag:community:done':     () => `知识图 · 检出 ${ext('communityCount') || 0} 个语义社区`,
          'graph-rag:community:fallback': () => `知识图 · 社区检测降级 · ${ext('reason') || '?'}`,
          'graph-rag:summarize:start':    '知识图 · 社区摘要启动',
          'graph-rag:summarize:done':     () => `知识图 · 摘要完毕 · ${ext('summaryCount') || 0} 条`,
          'graph-rag:summarize:fallback': () => `知识图 · 摘要降级 · ${ext('reason') || '?'}`,
          'graph-rag:done':               () => `知识图 · 完成 · 节点 ${(ext('stats') || {}).node_count || 0} / 边 ${(ext('stats') || {}).edge_count || 0}`,
          'graph-rag:failed':             () => `知识图 · 失败 · ${ext('error') || '?'} · 回退 BM25`,
          'graph-rag:rebuild:book-start': () => `知识图 · 重建 · 书 ${ext('bookId') || '?'} (共 ${ext('total') || '?'})`,
          'graph-rag:rebuild:done':       () => `知识图 · 重建完毕 · 成功 ${ext('built') || 0} / 失败 ${ext('failed') || 0}`,
        };
        const v = map[s];
        if (typeof v === 'function') return v();
        if (typeof v === 'string') return v;
        return s;
      };
      let unsubscribe = null;
      try {
        if (window.ptor && window.ptor.hypha && typeof window.ptor.hypha.onCurriculumProgress === "function") {
          unsubscribe = window.ptor.hypha.onCurriculumProgress((evt) => {
            if (evt && evt.stage) {
              setCreateStage(humanizeStage(evt));
              // 2026-05-17 build-log — append every event with full payload so
              // user can scroll back + expand. `label` is the same string the
              // legacy spinner shows; `payload` carries the enriched artifact
              // fields (top5 / preview / syllabus_preview / findings_preview /
              // hook + kp_titles) emitted by main.js stages.
              setCreateLog(log => log.concat([{
                stage: evt.stage,
                label: humanizeStage(evt),
                ts: Date.now(),
                payload: evt,
              }]));
            }
          });
        }
      } catch (err) {
        console.warn("[onboarding] could not subscribe to curriculum progress", err);
      }

      // 2026-05-17 Pillar 1 — route ambitious goals to chain plan, not single
      // curriculum. Router lives at app/lib/creation/route-goal.js; threshold
      // = difficulty ≥ 0.7 AND conservative_years ≥ 3. Failures fall back to
      // 'single' (existing behavior), so this is an additive fork — the
      // legacy curriculum:create path stays intact.
      let routeFlow = "single";
      let routeReason = "";
      try {
        const routeFn = window.ptor && window.ptor.hypha && window.ptor.hypha.routeGoal;
        if (typeof routeFn === "function") {
          const r = await routeFn({ goalContract: gc, archetype: null });
          if (r && r.flow) routeFlow = r.flow;
          if (r && r.reason) routeReason = r.reason;
          // MEOW MID-1 — capture evidence + p75 anchors for ChainPlanScreen
          if (r && (r.conservative_years || r.evidence)) {
            setChainRouteInfo({
              difficulty: r.difficulty || null,
              conservative_years: r.conservative_years || null,
              evidence: Array.isArray(r.evidence) ? r.evidence : [],
              estimator_used: !!r.estimator_used,
            });
          }
          // Emit synthetic build-log row so the user can see the routing
          // decision in the BuildLog stream (it does not come from main.js
          // emit so we have to push it ourselves).
          setCreateLog(log => log.concat([{
            stage: "route:decided",
            label: `规划路由 · ${routeFlow} · ${routeReason}`,
            ts: Date.now(),
            payload: { stage: "route:decided", ...(r || {}) },
          }]));
        }
      } catch (routeErr) {
        console.warn("[onboarding] route-goal failed, falling back to single", routeErr);
      }

      // Phase E.0/E.1 (2026-05-18) — Library Coverage Gate. Wrap the
      // chain/single fork so we can run coverage check BEFORE either path
      // fires. If Library doesn't have enough material for the goal, route
      // user to LibraryGateScreen for canonical-source upload (or skip).
      const _proceedCreation = async () => {
      if (routeFlow === "chain") {
        // Ambitious goal → chain plan. chain:create returns
        //   { ok, slug, data: chainData }
        // where chainData has { ultimate_goal, chain:{links:[...]}, tier,
        // feasibility, inputs:{timeWeeks,dailyHours,difficulty}, ... }.
        // Gap 1 (2026-05-17 Machino) — we now capture the plan + route into
        // the new ChainPlanScreen (design/screen-chain-plan.jsx) so the user
        // actually sees the staged chain instead of falling through silently.
        try {
          const chainCreateFn = window.ptor && window.ptor.hypha && window.ptor.hypha.chainCreate;
          if (typeof chainCreateFn !== "function") {
            throw new Error("chainCreate IPC bridge not available");
          }
          const result = await chainCreateFn({
            goal: gc.north_star_goal || (gc.main_creation || "").trim() || topic,
            timeWeeks: Number(gc.timeWeeks) || 52,
            dailyHours: Number(gc.dailyHours) || 2,
            priorConsistency: 0.5,
            failedAttempts: 0,
            answers: [],
            tier: "moderate",
            customLessons: null,
            uploadedSource: null,
          });
          if (result && result.ok && result.data) {
            // Order matters — flip onboarded + route BEFORE clearing
            // isCreatingCurriculum to avoid a one-frame flash of OnboardingScreen
            // (MEOW HIGH 2026-05-17). React batches all three but the dependent
            // render contract is: onboarded=true gates the routed-screen branch,
            // so it must land first.
            setChainPlan(result.data);
            setChainSlug(result.slug || null);
            setOnboarded(true);
            setRoute("chain-plan");
            setIsCreatingCurriculum(false);
            return;
          }
          // chain:create came back with !ok — fall through to single so the
          // user is not stranded. The catch below also handles thrown errors.
          throw new Error((result && result.error) || "chain:create returned no plan");
        } catch (chainErr) {
          console.error("[onboarding] chain:create failed, falling back to single", chainErr);
          // Fall through to single-curriculum path below.
        }
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
        // boot-7 (2026-05-20) — write onboarded_at to vault/data/profile.json
        // so re-launch boot probe skips welcome even if user later deletes the
        // course. Fire-and-forget; failure is non-fatal (lesson screen opens
        // either way, smoke catches regressions).
        try {
          const markFn = window.ptor && window.ptor.hypha && window.ptor.hypha.onboardingMarkComplete;
          if (typeof markFn === 'function') {
            markFn({
              role: level || '',
              north_star_goal: topic,
              pedagogy_structure: gc.user_intent || '',
            }).catch((markErr) => console.warn('[onboarding] mark-complete failed (non-fatal):', markErr));
          }
        } catch (markErr) {
          console.warn('[onboarding] mark-complete threw (non-fatal):', markErr);
        }
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
      }; // end _proceedCreation

      // Phase E.0/E.1 (2026-05-18) — Library Coverage Gate decision.
      // Coverage check is BEST-EFFORT — any failure (no IPC bridge / no
      // graph data / LLM offline) falls through to direct creation so the
      // user is never stranded by a bad coverage probe.
      try {
        const coverageFn = window.ptor && window.ptor.hypha && window.ptor.hypha.libraryCoverage;
        if (typeof coverageFn === "function") {
          const goalForCoverage = gc.north_star_goal || (gc.main_creation || "").trim() || topic;
          const archGuess = (chainRouteInfo && chainRouteInfo.archetype) || null;
          // Phase F.2 — pass crystallized tags so recommendBooks switches to fit-over-popular mode.
          const cov = await coverageFn(goalForCoverage, archGuess, true, gc._crystallized_tags || null);
          setCreateLog(log => log.concat([{
            stage: "library:coverage",
            label: (cov && cov.coverage && cov.coverage.has_coverage)
              ? `Library 覆盖足 · ${cov.coverage.book_count} 本 / ${cov.coverage.hit_count} chunk`
              : `Library 不足 · ${(cov && cov.coverage && cov.coverage.book_count) || 0} 本 / ${(cov && cov.coverage && cov.coverage.hit_count) || 0} chunk · 显推荐书`,
            ts: Date.now(),
            payload: cov,
          }]));
          if (cov && cov.ok && cov.coverage && !cov.coverage.has_coverage) {
            // Stash continuation + route to gate. resumeFn closes over the
            // current creation context (gc / payload / topic / level / routeFlow)
            // so onSkip / onContinueAfterUpload can fire it without re-running
            // onboarding submit.
            setChainGateInfo({
              goal: goalForCoverage,
              archetype: archGuess,
              coverage: cov.coverage,
              recommended: cov.recommended || null,
            });
            setPendingCreation({ resumeFn: _proceedCreation });
            setIsCreatingCurriculum(false);
            setRoute("library-gate");
            return;
          }
        }
      } catch (covErr) {
        console.warn("[onboarding] library:coverage failed (non-fatal):", covErr);
      }
      await _proceedCreation();
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

      {/* W3.2 — Product Blueprint floating entry. Visible on home + lesson +
          notebook surfaces when a slug is resolvable. Anchors bottom-right so
          it doesn't intercept primary content. Per BLUEPRINT §11.2. */}
      {(route === "home" || route === "lesson" || route === "notebook") && (() => {
        const slug = (goal && goal.slug)
          || (goal && goal.noteRel && (String(goal.noteRel).match(/^([^\\/]+)[\\/]lesson-\d+\.md$/) || [])[1])
          || (Array.isArray(courses) && courses[0] && courses[0].topic)
          || null;
        if (!slug) return null;
        return (
          <button
            onClick={() => { setProductBlueprintSlug(slug); setRoute("product-blueprint"); }}
            title={`Product Blueprint · ${slug}`}
            style={{
              position: "fixed",
              bottom: 24,
              right: 24,
              zIndex: 60,
              padding: "10px 16px",
              fontSize: 12,
              fontFamily: 'EB Garamond, "Noto Serif SC", serif',
              fontStyle: "italic",
              color: "var(--paper)",
              background: "var(--ink-1)",
              border: "1px solid var(--ink-1)",
              borderRadius: 2,
              cursor: "pointer",
              boxShadow: "0 8px 24px rgba(0,0,0,.18)",
              letterSpacing: "0.04em",
            }}>
            产品蓝图 · Blueprint
          </button>
        );
      })()}

      {/* W3.4 — Sparks floating entry. Same surface gating + slug-resolution
          as the Blueprint button; anchored just above it so both are
          reachable from home / lesson / notebook. */}
      {(route === "home" || route === "lesson" || route === "notebook") && (() => {
        const slug = (goal && goal.slug)
          || (goal && goal.noteRel && (String(goal.noteRel).match(/^([^\\/]+)[\\/]lesson-\d+\.md$/) || [])[1])
          || (Array.isArray(courses) && courses[0] && courses[0].topic)
          || null;
        if (!slug) return null;
        return (
          <button
            onClick={() => { setProductBlueprintSlug(slug); setRoute("spark-pool"); }}
            title={`Spark Pool · ${slug}`}
            style={{
              position: "fixed",
              bottom: 70,
              right: 24,
              zIndex: 60,
              padding: "10px 16px",
              fontSize: 12,
              fontFamily: 'EB Garamond, "Noto Serif SC", serif',
              fontStyle: "italic",
              color: "var(--ink-1)",
              background: "var(--paper, #f4efe4)",
              border: "1px solid var(--ink-1)",
              borderRadius: 2,
              cursor: "pointer",
              boxShadow: "0 6px 18px rgba(0,0,0,.12)",
              letterSpacing: "0.04em",
            }}>
            Sparks
          </button>
        );
      })()}

      {/* W4.2 — KPI Dashboard floating entry. Same surface gating + slug-
          resolution as the other entries; stacked above Sparks so the three
          surfaces (Blueprint / Sparks / KPI) read as one column anchored
          to the lower-right. Mute italic so it never competes with primary
          content — KPI is observability, not action. */}
      {(route === "home" || route === "lesson" || route === "notebook") && (() => {
        const slug = (goal && goal.slug)
          || (goal && goal.noteRel && (String(goal.noteRel).match(/^([^\\/]+)[\\/]lesson-\d+\.md$/) || [])[1])
          || (Array.isArray(courses) && courses[0] && courses[0].topic)
          || null;
        if (!slug) return null;
        return (
          <button
            onClick={() => { setProductBlueprintSlug(slug); setRoute("kpi-dashboard"); }}
            title={`KPI · ${slug}`}
            style={{
              position: "fixed",
              bottom: 116,
              right: 24,
              zIndex: 60,
              padding: "10px 16px",
              fontSize: 12,
              fontFamily: 'EB Garamond, "Noto Serif SC", serif',
              fontStyle: "italic",
              color: "var(--ink-3)",
              background: "transparent",
              border: "1px solid var(--rule-soft)",
              borderRadius: 2,
              cursor: "pointer",
              letterSpacing: "0.04em",
            }}>
            KPI
          </button>
        );
      })()}

      {/* 2026-05-13 — 7-Day · AI Builder floating entry 砍. Hardcoded preset
          (AI Builder ladder) 占据主流程位置违 manuscript register; 主流程 =
          self-created courses, 7-day demo demoted to optional Quick Start
          template library. Route "scenario-dashboard" 留代码 (cmd palette
          仍可触, in case 模板库 v0.1 接). */}

      {/* 2026-05-14 (Machino-C7) — Kill Toast. Surfaces auto-purge results
          from creation:kill-watch-done so the user sees what the system
          just changed on their behalf. Mounts at App root, fixed top-right. */}
      {typeof KillToast === 'function' && <KillToast />}

      {/* v0.4.10 (2026-05-19) — Unified Toast root. Listens for window
          'hypha:toast' CustomEvents and renders the queue. Replaces 2
          per-screen showToast implementations (screen-home + screen-commons). */}
      {typeof ToastRoot === 'function' && <ToastRoot />}

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
    notebook:["Notebook"],
    library: ["Library"],
    sparks:  ["Workshop"],
    // 2026-05-18 — course-creation flow routes were falling back to "Home"
    // breadcrumb (user reported "点了之后跳回HOME" — content was correct
    // library-gate but breadcrumb mislabeled).
    "library-gate":      ["Library", "覆盖检查"],
    "goal-crystallizer": ["创建课程", "切清目标"],
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

// W1.5 — derive a vault-relative path (slug/lesson-N.md) from the absolute
// path returned by lesson-note.depositLessonNote. Best-effort: walks back
// from the end so a Windows path with `\\` is handled identically to POSIX.
function deriveVaultRel(absPath) {
  if (!absPath) return null;
  const s = String(absPath).replace(/\\/g, '/');
  // Match the canonical tail `…/<slug>/lesson-<N>.md` and keep the last two segments.
  const m = s.match(/([^/]+)\/(lesson-\d+\.md)$/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
