/* global React, Brand, Watercolor, Icon */
// HYPHA · Onboarding wizard — 阶 2 极简屏 (2026-05-17 Machino sweep)
//
// Form down to: 4 必填/软 + 1 可选. Cut 8 fields (current_level / days_committed /
// learning_model / teacher_persona / frontier_topics / core_competencies /
// forbidden_drifts / 第 N 视情况) — these now live in the AI Socratic intake
// turn fired right before lesson 0 (see app/lib/socratic-onboarding.js).
//
// Downstream payload contract is preserved: every cut field still rides along
// with a sentinel value (null / 'auto' / []) so main.js / agent.js / pedagogy
// keep their existing reads intact. The Socratic patch then writes back into
// state.json + agent.json once user answers.
//
// Defaults baked in: provider="glm", model="glm-5.1" — settings UI overrides.
//
// intentional-placeholder: every `placeholder="..."` is the standard HTML form
// hint, NOT a marker for unfinished code.

const { useState, useEffect } = React;

// ===== Module-level constants =====

// 2026-05-17 user 二修: STYLE (老师怎么讲 / 苏格拉底 / Karpathy) 和 STRUCTURE
// (课时怎么组织 / 题型 / 叙事 / 论证) 是两个**正交维度**。前者是 teacher_persona,
// 后者是 user_intent → pedagogy.md Layer 5 PRODUCTION SCAFFOLD slot template。
//
// onboarding 选 STRUCTURE — 它决定 lesson arc 形态, 直接影响每节课结构。
// STYLE 默认 auto-derive (main.js derivePersona), Socratic intake 第 1 节前问。
//
// 4 chip 覆盖 4 个清晰**结构**, 每个有 "适合" 用例避免歧义:
//   - 题型 = 知识点列举 + 答题套路   → 考研 / 资格证 / 复习
//   - 叙事 = 钩子 + 机制 + 类比      → 兴趣 / 写小说 / 给人讲
//   - 论证 = claim + 反驳 + 推进     → 论文 / 评论 / 思辨
//   - 复盘 = Feynman 教回 + 关系网    → 已学过的网密化 / 整理
const PEDAGOGY_STRUCTURES = [
  { id: "考研", label: "题型 · 考试结构", desc: "高密度 KP + 答题套路 · 适合 考研 / 资格证 / 期末复习" },
  { id: "兴趣", label: "叙事 · 故事结构", desc: "钩子 + 机制示例 + 日常类比 · 适合 兴趣学 / 写小说 / 给人讲" },
  { id: "论文", label: "论证 · 推进结构", desc: "claim + 反驳 + 推进 · 适合 论文 / 评论 / 思辨写作" },
  { id: "复盘", label: "复盘 · 整理结构", desc: "Feynman 教回 + 1 关键→3 关系→1 反例 · 适合 已学过的网密化" },
];

const DEADLINE_CHOICES = [
  { id: "none",  label: "没有,慢慢来", desc: "未设具体死线 · 默认 Growth 节奏" },
  { id: "date",  label: "有,具体日期 →", desc: "锁 Exam 节奏 · 反向倒推每周节奏" },
];

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

// ===== ChipRow — serif chip selector, italic-on-active, ochre underline =====
// Quieter than RadioChips' hard bg flip. Mirrors Scene B demo's .chip pattern.
const ChipRow = ({ value, options, onChange }) => (
  <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
    {options.map(opt => {
      const active = value === opt.id;
      return (
        <button
          key={opt.id}
          onClick={() => onChange(opt.id)}
          className="serif"
          style={{
            padding: "8px 16px",
            fontSize: 14.5,
            fontStyle: active ? "italic" : "normal",
            color: active ? "var(--ink)" : "var(--ink-3)",
            background: active ? "rgba(180,140,80,.10)" : "transparent",
            border: active ? "1px solid var(--ochre-2)" : "1px solid var(--rule-soft, var(--rule))",
            borderRadius: 999,
            cursor: "pointer",
            transition: "color .25s ease, border-color .25s ease, background .25s ease, font-style .25s ease",
          }}>
          {opt.label}
        </button>
      );
    })}
  </div>
);

// ===== Onboarding screen =====
// 2026-05-17 — accept `createError` prop so silent bounce-back (e.g. Goal
// Guardian absurd verdict) shows the user WHY they got returned to onboarding.
// Without this, an absurd/strained-cancel returns user here with zero context.
const OnboardingScreen = ({ onComplete, createError }) => {
  // 2026-05-17 三修 (user: section 标题"说一句"但分 2 框自相矛盾, 合一):
  //   north_star_goal    — 一句话, 含目的 + 产物。main_creation 从此镜像
  //   pedagogy_structure — 4 chip (题型 / 叙事 / 论证 / 复盘) · 课时结构
  //   deadline_mode      — soft chip · drives learning_model
  //   bookIds            — 可选
  // teacher_persona (STYLE): 默认 null → main.js derivePersona 或 Socratic intake 填。
  // 2026-05-17 三修: north_star 一句话, main_creation 从中镜像 (downstream 兼容)。
  const [form, setForm] = useState({
    north_star_goal: "",
    pedagogy_structure: "",           // 4 chip · pedagogy.md PRODUCTION SCAFFOLD slot
    deadline_mode: "none",            // soft: 'none' | 'date' — drives learning_model
    deadline: "",                     // YYYY-MM-DD when deadline_mode==='date'
  });

  // W6.1 Book Grounding — optional reference book picker.
  const [bookIds, setBookIds] = useState([]);
  const [availableBooks, setAvailableBooks] = useState([]);
  const [booksLoading, setBooksLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fn = window.ptor && window.ptor.libraryList;
        if (typeof fn !== "function") {
          if (!cancelled) { setAvailableBooks([]); setBooksLoading(false); }
          return;
        }
        const r = await fn();
        if (cancelled) return;
        const books = (r && Array.isArray(r.books)) ? r.books : [];
        setAvailableBooks(books);
      } catch (_) {
        if (!cancelled) setAvailableBooks([]);
      } finally {
        if (!cancelled) setBooksLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const toggleBook = (id) => {
    setBookIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const set = (k) => (v) => setForm(f => ({ ...f, [k]: v }));
  const setEvt = (k) => (e) => set(k)(e.target.value);

  // Valid when 4 required slots filled. Deadline date is only required when
  // deadline_mode === 'date'; 'none' is a complete soft-answer.
  // 2026-05-17 三修 — main_creation 不再单独字段, 由 north_star_goal 镜像。
  const valid =
    form.north_star_goal.trim() &&
    form.pedagogy_structure &&
    (form.deadline_mode === "none" || (form.deadline_mode === "date" && form.deadline));

  const submit = () => {
    if (!valid) return;
    // deadline soft-question → learning_model derivation.
    //   "没有,慢慢来" → Growth + deadline=null
    //   "有,具体日期"   → Exam + deadline=YYYY-MM-DD
    const hasDeadline = form.deadline_mode === "date";
    const learningModelResolved = hasDeadline ? "Exam" : "Growth";

    const payload = {
      provider: "glm",   // default, switchable via settings
      model: "glm-5.1",  // default, switchable via settings
      goalContract: {
        north_star_goal: form.north_star_goal.trim(),
        // 2026-05-17 三修 — 镜像 north_star 让 downstream Track A/B 锚仍有值。
        // 未来可让 LLM 拆 north_star 句子里抽 "产物" 子串, v0 直接用全句。
        main_creation: form.north_star_goal.trim(),
        // 2026-05-17 二修 — pedagogy_structure 来自 chip pick · 映射到 backend
        // user_intent (pedagogy.md Layer 5 PRODUCTION SCAFFOLD enum). teacher_persona
        // (STYLE) 留 null → main.js derivePersona 或 Socratic intake Q2 填。
        user_intent: form.pedagogy_structure,
        teacher_persona: null,
        teacher_persona_explicit: false,
        learning_model: learningModelResolved,
        learning_model_explicit: hasDeadline, // user signed off when they said "有 deadline"
        deadline: hasDeadline ? form.deadline : null,
        // ── Cut fields: payload sentinels preserve downstream contract ──
        // Socratic intake (app/lib/socratic-onboarding.js) writes real values
        // back via socratic:start once the user answers, before lesson 0.
        current_level: null,
        days: null,
        days_explicit: false,
        core_competencies: [],
        forbidden_drifts: [],         // socratic Q3 will populate
        frontier_topics: [],
      },
      // W6.1 Book Grounding — optional reference book ids.
      bookIds: Array.isArray(bookIds) ? bookIds.slice() : [],
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

      {/* 2026-05-17 — silent bounce-back error display. Goal Guardian absurd
          verdict / strained-cancel previously returned user here with no UI
          feedback. Now: oxblood-tone left rule + italic Garamond message at
          the top, visible until user submits again. */}
      {createError && (
        <div style={{
          position: "relative", zIndex: 2,
          maxWidth: 720, margin: "0 auto 32px",
          padding: "14px 20px",
          background: "rgba(122, 58, 58, 0.08)",
          borderLeft: "2px solid #7a3a3a",
          color: "var(--ink, #29261b)",
          fontStyle: "italic",
          fontSize: 14,
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
        }}>
          <div className="mono" style={{ fontSize: 10.5, letterSpacing: ".12em", color: "#7a3a3a", marginBottom: 6 }}>
            上次提交未通过 ·  原因
          </div>
          {createError}
        </div>
      )}

      {/* Brand top-left — onboarding scale */}
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
          你想学什么。
        </div>
        <div className="t-quote">
          一句话告诉 HYPHA,她替你把剩下的问出来。
        </div>
        <div className="serif" style={{
          color: "var(--tabac, var(--ink-3))",
          fontSize: 10,
          fontStyle: "italic",
          lineHeight: 1.5,
          marginTop: 6,
          paddingTop: 8,
          borderTop: "1px solid var(--rule-soft, var(--rule))",
        }}>
          表单结束后,HYPHA 会在第 1 节课开始前,用 1-2 轮顺手聊补完你的状态 / 教师风格 / 不希望被带偏的方向。不一次收齐。
        </div>
      </div>

      {/* Single section, 4 fields */}
      <div className="col" style={{
        maxWidth: 760, margin: "0 auto",
        gap: 24, position: "relative", zIndex: 2,
      }}>

        <Section eyebrow="Step 1 · 极简表单" title="把你的北极星说一句。">

          {/* 北极星 — 一句话, 含目的 + 产物。
              2026-05-17 三修: 上一版分 2 框 (north_star + main_creation) 与 section
              标题 "把你的北极星说一句" 自相矛盾。合一 — 让 user 写一句 sentence,
              backend main_creation 镜像 north_star_goal (downstream pedagogy 仍读)。 */}
          <div className="col gap-8">
            <FieldLabel
              label="北极星 *"
              hint="一句话 — 把目的 + 产物写在一起。HYPHA 会锁定。"
            />
            <input
              value={form.north_star_goal}
              onChange={setEvt("north_star_goal")}
              placeholder="成为 AI Builder, 做一个能帮人解释论文的 agent"
              style={{ ...inputStyle, fontSize: 16 }}
            />
            <div className="t-tiny" style={{ color: "var(--ink-3)", marginTop: 4, fontStyle: "italic" }}>
              举例: 写一部兼具网文与诺奖文学的小说 · 把 transformer 数学吃透并能在白板上推导
            </div>
          </div>

          {/* Pedagogy structure — required, 4 chip (课时结构, 不是老师 style) */}
          <div className="col gap-8">
            <FieldLabel
              label="课时结构 *"
              hint="每节课怎么组织 — 题型 / 叙事 / 论证 / 复盘. 老师风格(苏格拉底/Karpathy 等)第 1 节前 HYPHA 会单独问"
            />
            <ChipRow
              value={form.pedagogy_structure}
              options={PEDAGOGY_STRUCTURES}
              onChange={(id) => setForm(f => ({ ...f, pedagogy_structure: id }))}
            />
            {form.pedagogy_structure && (
              <div className="t-tiny" style={{ color: "var(--ink-3)", marginTop: 4, fontStyle: "italic" }}>
                {PEDAGOGY_STRUCTURES.find(x => x.id === form.pedagogy_structure)?.desc}
              </div>
            )}
          </div>

          {/* Deadline soft question — chip → maybe date */}
          <div className="col gap-8">
            <FieldLabel
              label="有截止日期吗"
              hint="没有就跳过 — HYPHA 默认 Growth 节奏"
            />
            <ChipRow
              value={form.deadline_mode}
              options={DEADLINE_CHOICES}
              onChange={(id) => {
                if (id === "none") {
                  setForm(f => ({ ...f, deadline_mode: "none", deadline: "" }));
                } else {
                  setForm(f => ({ ...f, deadline_mode: "date" }));
                }
              }}
            />
            {form.deadline_mode === "date" && (
              <input
                type="date"
                value={form.deadline}
                onChange={setEvt("deadline")}
                style={{ ...inputStyle, maxWidth: 220, marginTop: 8 }}
              />
            )}
            <div className="t-tiny" style={{ color: "var(--ink-3)", marginTop: 4, fontStyle: "italic" }}>
              {DEADLINE_CHOICES.find(x => x.id === form.deadline_mode)?.desc}
            </div>
          </div>

          {/* W6.1 Book Grounding — optional */}
          <div className="col gap-8">
            <FieldLabel
              label="手上有参考书吗 (可选)"
              hint="HYPHA 会先把每本书消化成结构化地基, 再用地基约束课程结构. 跳过 = 从 frontier 和经典 syllabus 里抓."
            />
            {booksLoading ? (
              <div className="t-tiny mono" style={{ color: "var(--ink-3)" }}>(载入 Library…)</div>
            ) : availableBooks.length === 0 ? (
              <div className="t-tiny" style={{ color: "var(--ink-3)", fontStyle: "italic" }}>
                Library 暂无上传书目. 跳过 → 课程仍可生成. 或先在 Library 上传后再回来.
              </div>
            ) : (
              <div className="col gap-6" style={{
                padding: "10px 12px",
                border: "1px solid var(--rule)",
                borderRadius: 8,
                background: "rgba(255,255,255,.5)",
                maxHeight: 220,
                overflowY: "auto",
              }}>
                {availableBooks.map(b => {
                  const checked = bookIds.includes(b.id);
                  return (
                    <label key={b.id} className="row gap-8" style={{
                      alignItems: "flex-start",
                      cursor: "pointer",
                      padding: "6px 8px",
                      borderRadius: 4,
                      background: checked ? "rgba(180,140,80,.08)" : "transparent",
                      transition: "background .15s ease",
                    }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleBook(b.id)}
                        style={{ marginTop: 4, accentColor: "var(--ochre)" }}
                      />
                      <div className="col gap-2" style={{ flex: 1 }}>
                        <div className="serif" style={{ fontSize: 14, color: "var(--ink)" }}>
                          {b.title || b.id}
                        </div>
                        {b.author && (
                          <div className="t-tiny" style={{ color: "var(--ink-3)" }}>
                            {b.author}
                          </div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
            {bookIds.length > 0 && (
              <div className="t-tiny mono" style={{ color: "var(--ink-2)", marginTop: 4 }}>
                已选 {bookIds.length} 本 — HYPHA 会先建 Grounding Profile, 再生成骨架.
              </div>
            )}
          </div>
        </Section>

        {/* CTA */}
        <Section eyebrow="Step 2 · Begin" title="目标本身就是课程生成规则。">
          <div className="t-quote">
            HYPHA 不会让你提前填 12 个字段。她会在第 1 节课前,顺手把剩下的问出来。
          </div>
          <div className="row gap-12" style={{ marginTop: 4, flexWrap: "wrap" }}>
            <button className="btn btn-primary" onClick={submit} disabled={!valid}
              style={{
                opacity: valid ? 1 : 0.4,
                cursor: valid ? "pointer" : "not-allowed",
              }}>
              <Icon name="compass" size={14} /> 开始 →
            </button>
            {!valid && (
              <div className="t-small" style={{ color: "var(--ink-3)", alignSelf: "center" }}>
                填北极星 + 产物形态 + 是否有截止日期,即可开始。
              </div>
            )}
          </div>
        </Section>
      </div>
    </div>
  );
};

Object.assign(window, { OnboardingScreen });
