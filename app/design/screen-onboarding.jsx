/* global React, Brand, Watercolor, Icon */
// HYPHA · Onboarding wizard (v0.1 sub-step A)
//
// Collects the user's Goal Contract (blueprint § 3.1 8 fields) and emits payload
// via onComplete(payload). Provider + model are NOT exposed here — they are
// switch-anytime concerns (Cursor-style), handled by a settings UI elsewhere.
// Defaults baked in: provider="glm", model="glm-5.1" — overridable later.
//
// Pure UI + React state. No LLM call, no vault write, no IPC. Sub-steps D+ wire those.
//
// intentional-placeholder: every `placeholder="..."` in this file is the standard
// HTML input attribute (form UX hint text), NOT a marker for unfinished code.

const { useState } = React;

const LEARNING_MODELS = [
  { id: "Exam",   label: "Exam",   desc: "Maximize exam performance within scope and deadline" },
  { id: "Growth", label: "Growth", desc: "Long-term shift in understanding, judgment, and creation" },
  { id: "Hybrid", label: "Hybrid", desc: "Both — ratio adapts to deadline pressure" },
];

const DISCIPLINE_MODES = [
  { id: "gentle", label: "Gentle" },
  { id: "guided", label: "Guided" },
  { id: "strict", label: "Strict" },
];

// ===== Tag input — Enter to add, Backspace to remove last =====
const TagInput = ({ value, onChange, placeholder }) => {
  const [draft, setDraft] = useState("");
  const onKey = (e) => {
    if (e.key === "Enter" && draft.trim()) {
      e.preventDefault();
      onChange([...value, draft.trim()]);
      setDraft("");
    } else if (e.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  return (
    <div className="row gap-6" style={{
      flexWrap: "wrap",
      padding: "8px 10px",
      border: "1px solid var(--rule)",
      borderRadius: 8,
      background: "rgba(255,255,255,.5)",
      minHeight: 42,
    }}>
      {value.map((tag, i) => (
        <span key={i} className="chip chip-mono" style={{
          display: "inline-flex", alignItems: "center", gap: 6,
        }}>
          {tag}
          <button onClick={() => onChange(value.filter((_, j) => j !== i))}
            style={{
              background: "none", border: 0, cursor: "pointer",
              color: "var(--ink-3)", padding: 0, fontSize: 14, lineHeight: 1,
            }}>×</button>
        </span>
      ))}
      <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey}
        placeholder={value.length === 0 ? placeholder : ""}
        style={{
          flex: 1, minWidth: 140, border: 0, outline: 0,
          background: "transparent", fontSize: 14, fontFamily: "var(--sans)",
          color: "var(--ink)",
        }} />
    </div>
  );
};

// ===== Serif segmented — italic-on-active + sliding ochre underline =====
// Replaces the earlier RadioChips' hard bg flip with a quieter literary register.
const SerifSegmented = ({ value, options, onChange }) => (
  <div className="row" style={{
    gap: 0,
    borderBottom: "1px solid var(--rule-soft)",
    flexWrap: "wrap",
  }}>
    {options.map(opt => {
      const active = value === opt.id;
      return (
        <button key={opt.id} onClick={() => onChange(opt.id)}
          className="serif"
          style={{
            padding: "10px 18px",
            fontSize: 16,
            fontStyle: active ? "italic" : "normal",
            color: active ? "var(--ink)" : "var(--ink-3)",
            background: "transparent",
            border: 0,
            borderBottom: active ? "2px solid var(--ochre-2)" : "2px solid transparent",
            cursor: "pointer",
            transition: "color .25s ease, border-color .25s ease, font-style .25s ease",
            marginBottom: -1,
          }}>
          {opt.label}
        </button>
      );
    })}
  </div>
);

// ===== Module-level constants — hoisted out of OnboardingScreen so re-render keeps stable references (prevents 30-input subtree unmount/remount on each keystroke) =====

const inputStyle = {
  padding: "10px 12px",
  border: "1px solid var(--rule)",
  borderRadius: 8,
  background: "rgba(255,255,255,.5)",
  fontSize: 14,
  fontFamily: "var(--sans)",
  color: "var(--ink)",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const Section = ({ eyebrow, title, children }) => (
  <div className="card-quiet rise-in" style={{
    padding: "28px 32px",
    display: "flex", flexDirection: "column", gap: 20,
    position: "relative",
  }}>
    <div className="col gap-6">
      <div className="eyebrow">{eyebrow}</div>
      <div className="t-h2 serif" style={{ fontWeight: 400 }}>{title}</div>
    </div>
    {children}
  </div>
);

const FieldLabel = ({ label, hint }) => (
  <div className="col gap-4">
    <div className="t-small mono" style={{ color: "var(--ink-2)", letterSpacing: ".06em" }}>{label}</div>
    {hint && <div className="t-tiny" style={{ color: "var(--ink-3)" }}>{hint}</div>}
  </div>
);

// ===== Onboarding screen =====
const OnboardingScreen = ({ onComplete }) => {
  // Defaults: provider/model are switch-anytime, baked in here. Settings UI (later) overrides.
  const [form, setForm] = useState({
    north_star_goal: "",
    current_level: "",
    learning_model: "Growth",
    deadline: "",
    main_creation: "",
    core_competencies: [],
    forbidden_drifts: [],
    discipline_mode: "guided",
  });

  const set = (k) => (v) => setForm(f => ({ ...f, [k]: v }));
  const setEvt = (k) => (e) => set(k)(e.target.value);

  const valid = form.north_star_goal.trim() &&
                form.main_creation.trim() &&
                form.learning_model;

  const submit = () => {
    if (!valid) return;
    const payload = {
      provider: "glm",   // default, switchable via settings UI in later sub-step
      model: "glm-5.1",  // default, same
      goalContract: {
        north_star_goal: form.north_star_goal.trim(),
        current_level: form.current_level.trim(),
        learning_model: form.learning_model,
        deadline: form.deadline || null,
        main_creation: form.main_creation.trim(),
        core_competencies: form.core_competencies,
        forbidden_drifts: form.forbidden_drifts,
        discipline_mode: form.discipline_mode,
      },
    };
    console.log("[onboarding] submit", payload);
    onComplete(payload);
  };

  return (
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

      {/* Brand top-left — onboarding scale (larger than standard sidebar Brand) */}
      <div className="row gap-20" style={{
        marginBottom: 56, position: "relative", zIndex: 2, alignItems: "center",
      }}>
        <Watercolor.BrandMark size={56} />
        <div className="col" style={{ lineHeight: 1 }}>
          <div className="serif" style={{ fontSize: 32, letterSpacing: ".22em", fontWeight: 500 }}>HYPHA</div>
          <div className="t-small mono" style={{ marginTop: 10, letterSpacing: ".26em", color: "var(--ink-3)" }}>
            A PRIVATE UNIVERSITY
          </div>
        </div>
      </div>

      {/* Title block */}
      <div className="col gap-12" style={{
        maxWidth: 760, margin: "0 auto 32px",
        position: "relative", zIndex: 2,
      }}>
        <div className="eyebrow">Welcome</div>
        <div className="t-h1 serif" style={{ fontSize: 48, fontWeight: 400, lineHeight: 1.05 }}>
          Begin your <span className="italic">private university</span>.
        </div>
        <div className="t-quote">
          Three small choices, then your first lesson.
        </div>
      </div>

      {/* 3 sections */}
      <div className="col" style={{
        maxWidth: 760, margin: "0 auto",
        gap: 24, position: "relative", zIndex: 2,
      }}>

        {/* ===== Section 1 — Goal Contract ===== */}
        <Section eyebrow="Step 1 · Goal Contract" title="What is your north star?">
          <div className="col gap-8">
            <FieldLabel label="North star goal *" hint="Required — the highest-level outcome HYPHA will lock onto" />
            <input value={form.north_star_goal} onChange={setEvt("north_star_goal")}
              placeholder="成为 AI Builder" style={inputStyle} />
          </div>

          <div className="col gap-8">
            <FieldLabel label="Current level" hint="Where you start from" />
            <input value={form.current_level} onChange={setEvt("current_level")}
              placeholder="零基础 / mid / advanced" style={inputStyle} />
          </div>

          <div className="col gap-8">
            <FieldLabel label="Learning model *" hint="Exam = scope + deadline · Growth = long-term · Hybrid = both" />
            <SerifSegmented
              value={form.learning_model}
              options={LEARNING_MODELS.map(m => ({ id: m.id, label: m.label }))}
              onChange={set("learning_model")}
            />
            <div className="t-tiny" style={{ color: "var(--ink-3)", marginTop: 4 }}>
              {LEARNING_MODELS.find(m => m.id === form.learning_model)?.desc}
            </div>
          </div>

          <div className="col gap-8">
            <FieldLabel label="Deadline" hint={
              form.learning_model === "Growth"
                ? "Optional — Growth mode flows without a hard date"
                : "Exam date or self-imposed milestone"
            } />
            <input type="date" value={form.deadline} onChange={setEvt("deadline")} style={inputStyle} />
          </div>

          <div className="col gap-8">
            <FieldLabel label="Main creation *" hint="Required — the product/work this learning will feed" />
            <input value={form.main_creation} onChange={setEvt("main_creation")}
              placeholder="HYPHA / 我的论文 / 我的小说" style={inputStyle} />
          </div>

          <div className="col gap-8">
            <FieldLabel label="Core competencies" hint="Press Enter to add — what skills serve the goal" />
            <TagInput value={form.core_competencies} onChange={set("core_competencies")}
              placeholder="AI 基础理解, Agent 思维, 产品判断…" />
          </div>

          <div className="col gap-8">
            <FieldLabel label="Forbidden drifts" hint="Press Enter to add — what HYPHA must NOT slip into" />
            <TagInput value={form.forbidden_drifts} onChange={set("forbidden_drifts")}
              placeholder="空泛聊天, 过多黑话, 无行动证明…" />
          </div>

          <div className="col gap-8">
            <FieldLabel label="Discipline mode" hint="How firmly HYPHA pulls you back when you drift" />
            <SerifSegmented value={form.discipline_mode} options={DISCIPLINE_MODES} onChange={set("discipline_mode")} />
          </div>
        </Section>

        {/* ===== Section 2 — Begin ===== */}
        <Section eyebrow="Step 2 · Begin" title="Goal is the curriculum.">
          <div className="t-quote">
            目标本身就是课程生成规则。
          </div>
          <div className="row gap-12" style={{ marginTop: 4, flexWrap: "wrap" }}>
            <button className="btn btn-primary" onClick={submit} disabled={!valid}
              style={{
                opacity: valid ? 1 : 0.4,
                cursor: valid ? "pointer" : "not-allowed",
              }}>
              <Icon name="compass" size={14} /> Begin your first lesson
            </button>
            {!valid && (
              <div className="t-small" style={{ color: "var(--ink-3)", alignSelf: "center" }}>
                Fill north star, main creation, and learning model to continue.
              </div>
            )}
          </div>
        </Section>
      </div>
    </div>
  );
};

Object.assign(window, { OnboardingScreen });
