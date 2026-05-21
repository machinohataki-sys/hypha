/* global React, Brand, Watercolor, Icon, CourseTrustPanel */
// HYPHA · Lesson screen — sub-step E (v0.1) [DEPRECATED v0.3 — TRANSITION SURFACE]
//
// ⚠ Architecture note (2026-05-08): this surface renders a 6-field Lesson
// Skeleton + 3-field static body and submits a textarea for scoring. That
// model is wrong per BLUEPRINT §6.1 (12-field schema covered THROUGH chat
// turns) + §8.1 Cadence (turn-by-turn loop, not body-then-submit).
//
// The trust stack itself self-flagged this surface's intro_prose / closing_prose
// as ornamentation in production runs. v0.3 replaces this with LessonChat
// (NoteView.jsx) driven by the 8-state state-machine in app/lib/hypha-learn/
// + learn-{start,turn}.txt prompts. v0.2 trust stack components migrate
// from "body audit" to "per-turn intercept" (Auditable Reasoning Summary,
// Confession Layer, Gap Detector, scoreMicroProof, Persona Coherence).
//
// DO NOT add new features here. Bug fixes only. Replacement surface tracked
// in plan file fluffy-hugging-swan.md → "v0.3 Architecture Pivot" section.
//
// Schema rendered (frozen, v0.1, do not extend):
//   { objective, prerequisite_check, hook_concrete, path[], micro_proof{stimulus, expected_signal, fail_mode}, next_lesson_seed }

const { useState, useEffect } = React;

// Phase E (2026-05-08): Provider health badge — single dot in the page header
// that surfaces LLM router state without breaking the manuscript register.
// Polls the main process every 30s for getProviderHealth(); stays silent if the
// preload bridge is missing (older builds, screenshot mode).
const HealthBadge = () => {
  const [health, setHealth] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!window.hypha || typeof window.hypha.getProviderHealth !== 'function') return undefined;
    let alive = true;
    const tick = async () => {
      try {
        const r = await window.hypha.getProviderHealth();
        if (alive && r && r.ok) setHealth(r.report);
      } catch (_) { /* leave stale snapshot */ }
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  if (!health) return null;
  const states = Object.values(health).map(h => h.state);
  const anyDegraded = states.some(s => s === 'degraded');
  const allHealthy = states.every(s => s === 'healthy');
  const dotColor = anyDegraded ? 'var(--terracotta-2)' : (allHealthy ? '#789563' : '#c89c3e');
  const summary = anyDegraded ? 'A provider is offline' : (allHealthy ? 'All providers healthy' : 'Recovering');
  return (
    <div style={{ position: 'relative', marginRight: 14, lineHeight: 0 }}
         onClick={() => setOpen(o => !o)} title={summary}>
      <div style={{ width: 9, height: 9, borderRadius: '50%', background: dotColor,
                    boxShadow: '0 0 0 1.5px rgba(255,255,255,.7)', cursor: 'default' }} />
      {open && (
        <div className="card-quiet" style={{
          position: 'absolute', top: 18, right: -4, padding: '10px 14px',
          fontSize: 11, minWidth: 220, zIndex: 10, lineHeight: 1.4,
        }}>
          <div className="t-small mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em', marginBottom: 6 }}>
            llm router
          </div>
          {Object.entries(health).map(([id, h]) => {
            const c = h.state === 'healthy' ? '#789563'
                    : h.state === 'degraded' ? 'var(--terracotta-2)' : '#c89c3e';
            return (
              <div key={id} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', color: 'var(--ink-2)' }}>
                <span>{id.replace('-direct', '')}</span>
                <span style={{ color: c }}>{h.state}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const PageFrame = ({ children, onBack, harnessResult, onDeepAuditRequested }) => (
  <div className="fade-in" style={{
    minHeight: "100vh",
    padding: "40px 60px 80px",
    position: "relative",
    overflow: "hidden",
  }}>
    {/* Watercolor wash decoration top-right */}
    <div style={{
      position: "absolute",
      top: -120, right: -200,
      width: 700, height: 500,
      opacity: 0.4,
      pointerEvents: "none",
      zIndex: 0,
    }}>
      <Watercolor.Wash tone="ochre" />
    </div>

    {/* Brand + Back */}
    <div className="row" style={{
      marginBottom: 32, position: "relative", zIndex: 2, alignItems: "center",
    }}>
      <Brand />
      <span className="spacer" />
      {typeof CourseTrustPanel === 'function' && (
        <CourseTrustPanel harnessResult={harnessResult} onDeepAuditRequested={onDeepAuditRequested} />
      )}
      <HealthBadge />
      {onBack && (
        <button onClick={onBack} className="row gap-8 btn btn-ghost" style={{ fontSize: 13 }}>
          <Icon name="arrowL" size={13} /> Back to home
        </button>
      )}
    </div>

    <div className="col" style={{
      maxWidth: 760, margin: "0 auto",
      position: "relative", zIndex: 2,
    }}>
      {children}
    </div>
  </div>
);

const LoadingState = () => (
  <div className="col gap-12 rise-in" style={{ padding: "60px 0" }}>
    <div className="eyebrow">Compiling lesson skeleton…</div>
    <div className="t-h1 serif" style={{ fontWeight: 400, fontSize: 42 }}>
      The architect is at the table.
    </div>
    <div className="t-quote">
      A few seconds — the plan must commit to one falsifiable bet before any prose is written.
    </div>
  </div>
);

const ErrorState = ({ error, onRetry, onBack }) => (
  <div className="col gap-16 rise-in" style={{ padding: "40px 0" }}>
    <div className="eyebrow" style={{ color: "var(--terracotta-2)" }}>Generation failed</div>
    <div className="t-h2 serif" style={{ fontWeight: 400 }}>
      The lesson skeleton did not compile.
    </div>
    <div className="card-quiet col gap-8" style={{ padding: 22 }}>
      <div className="t-small mono" style={{ color: "var(--ink-3)", letterSpacing: ".08em" }}>
        {error.error || "UNKNOWN"}
      </div>
      <div className="t-body" style={{ color: "var(--ink-2)" }}>
        {error.message || "No diagnostic message."}
      </div>
    </div>
    <div className="row gap-12">
      {onRetry && (
        <button onClick={onRetry} className="btn btn-primary">
          <Icon name="sparkle" size={13} /> Try again
        </button>
      )}
      {onBack && (
        <button onClick={onBack} className="btn btn-ghost">
          Return to onboarding
        </button>
      )}
    </div>
  </div>
);

const PlanField = ({ eyebrow, children }) => (
  <div className="col gap-8">
    <div className="eyebrow">{eyebrow}</div>
    {children}
  </div>
);

const RomanList = ({ items }) => (
  <ol className="col gap-12" style={{ listStyle: "none", padding: 0, margin: 0 }}>
    {items.map((item, i) => (
      <li key={i} className="row gap-12" style={{ alignItems: "flex-start" }}>
        <span className="serif italic" style={{
          width: 28, fontSize: 17, color: "var(--ink-3)", flexShrink: 0,
          lineHeight: 1.4,
        }}>
          {["i", "ii", "iii", "iv", "v", "vi"][i] || (i + 1)}
        </span>
        <div className="t-body-l serif" style={{ flex: 1, lineHeight: 1.5, color: "var(--ink)" }}>
          {item}
        </div>
      </li>
    ))}
  </ol>
);

const LoadedPlan = ({ plan, goal }) => {
  // Body fetch state: idle / loading / loaded / error
  const [bodyState, setBodyState] = useState("idle");
  const [body, setBody] = useState(null);
  const [bodyError, setBodyError] = useState(null);

  // Micro proof capture state
  const [proofText, setProofText] = useState("");
  // scoring lifecycle: idle | pending | done | error
  const [scoring, setScoring] = useState("idle");
  const [scoreResult, setScoreResult] = useState(null);
  const [scoreError, setScoreError] = useState(null);

  // Note-deposit state. Auto-fires once scoring resolves; null until persistence
  // completes. Shape: { ok: true, path, lessonId, slug } | { ok:false, error, message }.
  const [noteSaved, setNoteSaved] = useState(null);

  // Positive Feedback state — sub-step J (v0.1, 微反馈 only per BLUEPRINT §8.3).
  // Auto-fires after noteSaved set. Shape: { ok, type, message } | { ok:false, error, message }.
  const [feedback, setFeedback] = useState(null);

  const beginLesson = () => {
    if (!window.hypha || !window.hypha.generateLessonBody) {
      setBodyError({ error: "NO_BRIDGE", message: "window.hypha.generateLessonBody missing." });
      setBodyState("error");
      return;
    }
    setBodyState("loading");
    setBodyError(null);
    window.hypha.generateLessonBody({
      plan,
      goalContract: goal?.goalContract,
      audience: goal?.goalContract?.current_level || "self-directed adult learner",
      learnerState: { known: [], unknown: goal?.goalContract?.core_competencies || [] },
    }).then(r => {
      if (r && r.ok && r.body) {
        setBody(r.body);
        setBodyState("loaded");
      } else {
        setBodyError(r || { error: "UNKNOWN", message: "no response" });
        setBodyState("error");
      }
    }).catch(err => {
      setBodyError({ error: "EXCEPTION", message: err.message });
      setBodyState("error");
    });
  };

  const submitProof = () => {
    if (!window.hypha || !window.hypha.scoreMicroProof) {
      setScoreError({ error: "NO_BRIDGE", message: "window.hypha.scoreMicroProof missing." });
      setScoring("error");
      return;
    }
    setScoring("pending");
    setScoreError(null);
    setScoreResult(null);
    setNoteSaved(null);
    setFeedback(null);
    // G3 paste-detection requires the assistant content the user just saw —
    // the lesson body. We harvest intro_prose + each path_prose[i].prose +
    // closing_prose into a string array. Without this, scoring.detectPaste()
    // gets `[]` and silently passes pasted LLM output as production evidence.
    // (Diagnosis confirmed 2026-05-08: lesson body is never logged to session
    // jsonl, so main.js can't harvest it server-side — must be passed from here.)
    const lessonText = [
      body && body.intro_prose,
      ...((body && Array.isArray(body.path_prose) ? body.path_prose : [])
        .map(p => p && p.prose)
        .filter(Boolean)),
      body && body.closing_prose,
    ].filter(Boolean);
    window.hypha.scoreMicroProof({ plan, response: proofText, recentAssistantMessages: lessonText }).then(r => {
      if (r && r.ok && r.result) {
        setScoreResult(r.result);
        setScoring("done");
        // Auto-deposit lesson note. Silent persistence per BLUEPRINT §9.1.
        if (window.hypha && window.hypha.depositLessonNote) {
          window.hypha.depositLessonNote({
            plan, body, response: proofText, scoreResult: r.result,
            goalContract: goal && goal.goalContract,
          }).then(noteResult => setNoteSaved(noteResult || { ok: false, error: "EMPTY", message: "no response" }))
            .catch(err => setNoteSaved({ ok: false, error: "EXCEPTION", message: err.message }));
        }
        // Compose Positive Feedback — sub-step J (v0.1). Pure rule-based,
        // no LLM. Per BLUEPRINT §8.3: 能力证据回显, 转化可修复路径.
        if (window.hypha && window.hypha.composeFeedback) {
          window.hypha.composeFeedback({ scoreResult: r.result, plan })
            .then(fb => setFeedback(fb || { ok: false, error: "EMPTY", message: "no response" }))
            .catch(err => setFeedback({ ok: false, error: "EXCEPTION", message: err.message }));
        }
      } else {
        setScoreError(r || { error: "UNKNOWN", message: "no response" });
        setScoring("error");
      }
    }).catch(err => {
      setScoreError({ error: "EXCEPTION", message: err.message });
      setScoring("error");
    });
  };

  // Build a step_id → prose lookup so a path-prose entry can be rendered
  // beneath the matching plan.path[i] item without forcing index alignment.
  const proseByStepId = (body && Array.isArray(body.path_prose))
    ? body.path_prose.reduce((acc, item, i) => {
        const key = (item && item.step_id !== undefined && item.step_id !== null) ? String(item.step_id) : String(i);
        acc[key] = item.prose;
        return acc;
      }, {})
    : {};

  return (
  <div className="col rise-in" style={{ gap: 32 }}>
    {/* Header */}
    <div className="col gap-12">
      <div className="eyebrow">
        Lesson skeleton · {goal?.goalContract?.learning_model || "Growth"}
      </div>
      <h1 className="t-display serif" style={{ margin: 0, fontWeight: 400, fontSize: 44, lineHeight: 1.1 }}>
        {plan.objective}
      </h1>
      {plan.prerequisite_check && (
        <div className="row gap-8" style={{ marginTop: 4 }}>
          <span className="chip chip-mono">PREREQ</span>
          <span className="t-small" style={{ color: "var(--ink-2)" }}>
            {plan.prerequisite_check}
          </span>
        </div>
      )}
    </div>

    {/* Hook */}
    <div className="card-quiet" style={{ padding: "22px 26px" }}>
      <div className="t-quote serif italic" style={{ fontSize: 19, lineHeight: 1.5, color: "var(--ink-2)" }}>
        {plan.hook_concrete}
      </div>
    </div>

    {/* Path — with optional path_prose rendered beneath each step once body loads */}
    <PlanField eyebrow="Path · what you will do">
      <ol className="col gap-16" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {(plan.path || []).map((item, i) => {
          const prose = proseByStepId[String(i)];
          return (
            <li key={i} className="col gap-8">
              <div className="row gap-12" style={{ alignItems: "flex-start" }}>
                <span className="serif italic" style={{
                  width: 28, fontSize: 17, color: "var(--ink-3)", flexShrink: 0,
                  lineHeight: 1.4,
                }}>
                  {["i", "ii", "iii", "iv", "v", "vi"][i] || (i + 1)}
                </span>
                <div className="t-body-l serif" style={{ flex: 1, lineHeight: 1.5, color: "var(--ink)" }}>
                  {item}
                </div>
              </div>
              {prose && (
                <div className="card-quiet" style={{ padding: "14px 18px", marginLeft: 40 }}>
                  <div className="serif italic" style={{ fontSize: 15, lineHeight: 1.6, color: "var(--ink-2)" }}>
                    {prose}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </PlanField>

    {/* Micro Proof — plan view (stimulus / pass / fail) */}
    <PlanField eyebrow="Micro proof · evidence you produce">
      <div className="card-quiet col gap-12" style={{ padding: 22 }}>
        <div>
          <div className="t-tiny mono" style={{ color: "var(--ink-3)", letterSpacing: ".08em" }}>STIMULUS</div>
          <div className="t-body-l serif" style={{ marginTop: 4, lineHeight: 1.4 }}>
            {plan.micro_proof?.stimulus}
          </div>
        </div>
        <hr className="rule-soft" style={{ margin: 0 }} />
        <div>
          <div className="t-tiny mono" style={{ color: "var(--sage-2)", letterSpacing: ".08em" }}>PASS PATTERN</div>
          <div className="t-body" style={{ marginTop: 4, color: "var(--ink-2)" }}>
            {plan.micro_proof?.expected_signal}
          </div>
        </div>
        <div>
          <div className="t-tiny mono" style={{ color: "var(--terracotta-2)", letterSpacing: ".08em" }}>FAIL MODE</div>
          <div className="t-body" style={{ marginTop: 4, color: "var(--ink-2)" }}>
            {plan.micro_proof?.fail_mode}
          </div>
        </div>
      </div>
    </PlanField>

    {/* Begin lesson — gate that swaps in body + capture below */}
    {bodyState === "idle" && (
      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={beginLesson} className="btn btn-primary row gap-8">
          <Icon name="sparkle" size={13} /> Begin lesson
        </button>
      </div>
    )}

    {bodyState === "loading" && (
      <div className="serif italic" style={{ marginTop: 8, fontSize: 15, color: "var(--ink-2)" }}>
        Composing the lesson body…
      </div>
    )}

    {bodyState === "error" && bodyError && (
      <div className="card-quiet col gap-8" style={{ padding: 18, marginTop: 8 }}>
        <div className="t-tiny mono" style={{ color: "var(--terracotta-2)", letterSpacing: ".08em" }}>
          BODY · {bodyError.error || "UNKNOWN"}
        </div>
        <div className="t-body" style={{ color: "var(--ink-2)" }}>
          {bodyError.message || "No diagnostic message."}
        </div>
        <div className="row">
          <button onClick={beginLesson} className="btn btn-ghost row gap-8" style={{ fontSize: 13 }}>
            <Icon name="sparkle" size={13} /> Try again
          </button>
        </div>
      </div>
    )}

    {/* Lesson body — intro prose only here; path_prose was woven into the path list above. */}
    {bodyState === "loaded" && body && (
      <div className="col gap-24" style={{ marginTop: 8 }}>
        {body.intro_prose && (
          <p className="t-body-l serif" style={{ margin: 0, lineHeight: 1.7, color: "var(--ink)" }}>
            {body.intro_prose}
          </p>
        )}

        {body.closing_prose && (
          <p className="t-body serif" style={{ margin: 0, lineHeight: 1.7, color: "var(--ink-2)" }}>
            {body.closing_prose}
          </p>
        )}
      </div>
    )}

    {/* Micro proof capture — appears once body has loaded */}
    {bodyState === "loaded" && body && (
      <PlanField eyebrow="Micro proof · paste your evidence">
        <div className="card-quiet col gap-12" style={{ padding: 22 }}>
          <div>
            <div className="t-tiny mono" style={{ color: "var(--ink-3)", letterSpacing: ".08em" }}>STIMULUS</div>
            <div className="serif italic" style={{ marginTop: 4, fontSize: 16, lineHeight: 1.5, color: "var(--ink-2)" }}>
              {plan.micro_proof?.stimulus}
            </div>
          </div>
          <textarea
            value={proofText}
            onChange={e => setProofText(e.target.value)}
            rows={8}
            placeholder="Paste your response, code, derivation, or short paragraph."
            className="mono"
            style={{
              width: "100%",
              padding: "12px 14px",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              fontSize: 13,
              lineHeight: 1.55,
              color: "var(--ink)",
              background: "var(--cream)",
              border: "1px solid var(--rule-soft)",
              borderRadius: 4,
              resize: "vertical",
              boxSizing: "border-box",
            }}
          />
          <div className="row gap-12" style={{ alignItems: "center" }}>
            <button
              onClick={submitProof}
              disabled={!proofText.trim() || scoring === "pending"}
              className="btn btn-primary row gap-8"
              style={{ opacity: (proofText.trim() && scoring !== "pending") ? 1 : 0.4 }}
            >
              <Icon name="sparkle" size={13} /> {scoring === "done" ? "Re-score" : "Submit proof"}
            </button>
            {scoring === "pending" && (
              <span className="serif italic" style={{ fontSize: 14, color: "var(--ink-3)" }}>
                Scoring micro proof…
              </span>
            )}
          </div>

          {/* Scoring result — pass / fail card. Baseline-only verdict per AMD-1;
              LLM signal surfaces as risk chip + reason text for monitoring. */}
          {scoring === "done" && scoreResult && (
            <div className="col gap-10" style={{ marginTop: 4 }}>
              <div className="row gap-12" style={{ alignItems: "center", flexWrap: "wrap" }}>
                {scoreResult.passed ? (
                  <span className="chip chip-sage" style={{ letterSpacing: ".06em" }}>
                    PASS · evidence_type={scoreResult.evidence_type}
                  </span>
                ) : (
                  <span className="chip chip-terra" style={{ letterSpacing: ".06em" }}>
                    FAIL · pattern not matched
                  </span>
                )}
                {scoreResult.passed && scoreResult.false_positive_risk && (
                  <span className="serif italic" style={{ fontSize: 13, color: "var(--ink-3)" }}>
                    false_positive_risk: {scoreResult.false_positive_risk}
                  </span>
                )}
              </div>

              {!scoreResult.passed && (
                <div className="card-quiet col gap-8" style={{ padding: 16 }}>
                  {scoreResult.llm_signal && scoreResult.llm_signal.reason && (
                    <div className="serif italic" style={{ fontSize: 14, lineHeight: 1.55, color: "var(--ink-2)" }}>
                      {scoreResult.llm_signal.reason}
                    </div>
                  )}
                  {Array.isArray(scoreResult.baseline_check?.regex_hits) && (
                    <div className="row gap-8" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
                      <span className="t-tiny mono" style={{ color: "var(--ink-3)", letterSpacing: ".08em" }}>HITS</span>
                      <span className="mono" style={{ fontSize: 12, color: "var(--ink-2)" }}>
                        {scoreResult.baseline_check.regex_hits.length === 0
                          ? "—"
                          : scoreResult.baseline_check.regex_hits.join(" · ")}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {scoring === "error" && scoreError && (
            <div className="card-quiet col gap-8" style={{ padding: 16, marginTop: 4 }}>
              <div className="t-tiny mono" style={{ color: "var(--terracotta-2)", letterSpacing: ".08em" }}>
                SCORING · {scoreError.error || "UNKNOWN"}
              </div>
              <div className="t-body" style={{ color: "var(--ink-2)" }}>
                {scoreError.message || "No diagnostic message."}
              </div>
            </div>
          )}

          {/* Note-deposit chip — silent persistence to vault/<slug>/lesson-N.md.
              Idle until scoring resolves, then italic "Saving…", then a path chip
              on success, or a terra chip on failure. */}
          {scoring === "done" && noteSaved === null && (
            <div className="serif italic" style={{ marginTop: 4, fontSize: 13, color: "var(--ink-3)" }}>
              Saving lesson note…
            </div>
          )}
          {scoring === "done" && noteSaved && noteSaved.ok && (
            <div className="row" style={{ marginTop: 4 }}>
              <span className="chip chip-mono" style={{ letterSpacing: ".06em" }}>
                NOTE → {noteSaved.slug ? `vault/${noteSaved.slug}/lesson-${noteSaved.lessonId}.md` : noteSaved.path}
              </span>
            </div>
          )}
          {scoring === "done" && noteSaved && !noteSaved.ok && (
            <div className="row" style={{ marginTop: 4 }}>
              <span className="chip chip-terra" style={{ letterSpacing: ".06em" }}>
                Note save failed: {noteSaved.error || "UNKNOWN"}
              </span>
            </div>
          )}

          {/* Positive Feedback — sub-step J (v0.1, 微反馈 only).
              Rule-based, no LLM. Tone tracks scoring outcome via card-quiet
              + per-type accent on the eyebrow. Per BLUEPRINT §8.3:
              证据回显, 不空夸, 转化可修复路径. */}
          {scoring === "done" && feedback === null && (
            <div className="serif italic" style={{ marginTop: 4, fontSize: 13, color: "var(--ink-3)" }}>
              Composing feedback…
            </div>
          )}
          {scoring === "done" && feedback && feedback.ok && feedback.type === "pass" && (
            <div className="card-quiet col gap-8" style={{ padding: 16, marginTop: 4 }}>
              <div className="t-tiny mono" style={{ color: "var(--sage-2)", letterSpacing: ".08em" }}>
                POSITIVE FEEDBACK · 通过
              </div>
              <div className="serif italic" style={{ fontSize: 14, lineHeight: 1.6, color: "var(--ink)" }}>
                {feedback.message}
              </div>
            </div>
          )}
          {scoring === "done" && feedback && feedback.ok && feedback.type === "fp_risk" && (
            <div className="card-quiet col gap-8" style={{ padding: 16, marginTop: 4 }}>
              <div className="t-tiny mono" style={{ color: "var(--ochre-2)", letterSpacing: ".08em" }}>
                POSITIVE FEEDBACK · 形状通过模式存疑
              </div>
              <div className="serif italic" style={{ fontSize: 14, lineHeight: 1.6, color: "var(--ink)" }}>
                {feedback.message}
              </div>
            </div>
          )}
          {scoring === "done" && feedback && feedback.ok && feedback.type === "fail" && (
            <div className="card-quiet col gap-8" style={{ padding: 16, marginTop: 4 }}>
              <div className="t-tiny mono" style={{ color: "var(--terracotta-2)", letterSpacing: ".08em" }}>
                POSITIVE FEEDBACK · 修复路径
              </div>
              <div className="serif italic" style={{ fontSize: 14, lineHeight: 1.6, color: "var(--ink)" }}>
                {feedback.message}
              </div>
            </div>
          )}
          {scoring === "done" && feedback && !feedback.ok && (
            <div className="row" style={{ marginTop: 4 }}>
              <span className="chip chip-mono" style={{ letterSpacing: ".06em" }}>
                feedback failed: {feedback.error || "UNKNOWN"}
              </span>
            </div>
          )}
        </div>
      </PlanField>
    )}

    {/* Next */}
    <div className="row gap-12" style={{ alignItems: "center", paddingTop: 12, borderTop: "1px solid var(--rule-soft)" }}>
      <div className="t-tiny mono" style={{ color: "var(--ink-3)", letterSpacing: ".08em" }}>NEXT</div>
      <div className="serif italic" style={{ fontSize: 15, color: "var(--ink-2)" }}>
        {plan.next_lesson_seed}
      </div>
    </div>
  </div>
  );
};

const LessonScreen = ({ goal, onBack }) => {
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!goal) {
      setError({ error: "NO_GOAL", message: "No goal supplied. Return to onboarding to set one." });
      setLoading(false);
      return;
    }
    if (!window.hypha || !window.hypha.generateLessonPlan) {
      setError({ error: "NO_BRIDGE", message: "window.hypha bridge missing. Restart Electron after preload changes." });
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setPlan(null);

    window.hypha.generateLessonPlan({
      goalContract: goal.goalContract,
      audience: goal.goalContract?.current_level || "self-directed adult learner",
      learnerState: { known: [], unknown: goal.goalContract?.core_competencies || [] },
    }).then(r => {
      if (cancelled) return;
      if (r && r.ok) {
        setPlan(r.plan);
      } else {
        setError(r || { error: "UNKNOWN", message: "no response" });
      }
      setLoading(false);
    }).catch(err => {
      if (cancelled) return;
      setError({ error: "EXCEPTION", message: err.message });
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [goal, generation]);

  return (
    <PageFrame onBack={onBack}>
      {loading && <LoadingState />}
      {!loading && error && (
        <ErrorState
          error={error}
          onRetry={() => setGeneration(g => g + 1)}
          onBack={onBack}
        />
      )}
      {!loading && !error && plan && <LoadedPlan plan={plan} goal={goal} />}
    </PageFrame>
  );
};

window.LessonScreen = LessonScreen;
