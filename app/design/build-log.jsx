/* global React */
// HYPHA · Build Log Screen (2026-05-17)
//
// Replaces the single-line spinner during curriculum:create with an
// append-only list of every pipeline stage + its actual result artifact.
// Each row = mono timestamp · italic stage label · click to expand the
// payload (top5 sources / digest preview / syllabus preview / critique
// findings / lesson 0 hook + KP titles).
//
// Per user 2026-05-17: "创造课程的过程中要把每一步和其结果都列出来"。
// Per feedback_course_gen_slow_visible: 5-15 min visible harvest = 信任建立.
//
// Manuscript register: cream paper, brass hairlines, italic Garamond stage
// labels, mono timestamps. No emoji, no progress bar, no SaaS-y meters.
//
// Props:
//   topic         — string, pending curriculum slug
//   currentStage  — string, humanized label of the most recent stage
//   log           — array of { stage, label, ts, payload }
//   error         — string|null, error message if pipeline failed

const { useEffect, useRef, useState, useMemo } = React;

// ──────────────────────────────────────────────────────────────────────
// Time formatting
// ──────────────────────────────────────────────────────────────────────

function _ts(ms) {
  try {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch (_) { return "--:--:--"; }
}

function _elapsed(firstTs, ts) {
  if (!firstTs || !ts) return "";
  const sec = Math.max(0, Math.round((ts - firstTs) / 1000));
  if (sec < 60) return `+${sec}s`;
  const m = Math.floor(sec / 60); const s = sec % 60;
  return `+${m}m${s.toString().padStart(2, "0")}s`;
}

// ──────────────────────────────────────────────────────────────────────
// Stage-specific payload renderers — each returns JSX or null
// ──────────────────────────────────────────────────────────────────────

function PayloadHarvestDone({ payload }) {
  const top5 = Array.isArray(payload && payload.top5) ? payload.top5 : [];
  if (top5.length === 0) {
    return (
      <div style={{ fontStyle: "italic", color: "var(--ink-3, #7a6e58)", fontSize: 13 }}>
        共 {payload.sourceCount || 0} 个源 · 详情未传
      </div>
    );
  }
  return (
    <div className="col gap-6" style={{ marginTop: 8 }}>
      <div className="mono" style={{ fontSize: 10.5, letterSpacing: ".12em", color: "var(--ink-3, #7a6e58)" }}>
        前 5 个源 (共 {payload.sourceCount || top5.length})
      </div>
      {top5.map((s, i) => (
        <div key={i} className="row gap-12" style={{ alignItems: "baseline", paddingLeft: 10, borderLeft: "1.5px solid var(--brass-dim, #8b6a4d)" }}>
          <span style={{ fontStyle: "italic", color: "var(--ink, #29261b)", fontSize: 14, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title || "(untitled)"}</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--ink-3, #7a6e58)" }}>{s.domain || s.kind || "—"}</span>
        </div>
      ))}
    </div>
  );
}

function PayloadDigestDone({ payload }) {
  const preview = (payload && payload.preview) || "";
  return (
    <div className="col gap-6" style={{ marginTop: 8 }}>
      <div className="mono" style={{ fontSize: 10.5, letterSpacing: ".12em", color: "var(--ink-3, #7a6e58)" }}>
        digest 头 {Math.min(500, preview.length)} 字 · 全文 {payload.digest_chars || 0} 字
      </div>
      <div style={{ fontStyle: "italic", color: "var(--ink-2, #4a4232)", fontSize: 13.5, lineHeight: 1.55, padding: "10px 14px", background: "var(--paper-warm, #f1eadb)", borderLeft: "2px solid var(--brass-dim, #8b6a4d)" }}>
        {preview || "(empty)"}
      </div>
    </div>
  );
}

function PayloadSyllabusPreview({ payload }) {
  const items = Array.isArray(payload && payload.syllabus_preview) ? payload.syllabus_preview : [];
  if (items.length === 0) {
    return (
      <div style={{ fontStyle: "italic", color: "var(--ink-3, #7a6e58)", fontSize: 13 }}>
        共 {payload.lesson_count || 0} 节 · 标题未传
      </div>
    );
  }
  return (
    <div className="col gap-4" style={{ marginTop: 8 }}>
      <div className="mono" style={{ fontSize: 10.5, letterSpacing: ".12em", color: "var(--ink-3, #7a6e58)" }}>
        前 {items.length} 节 (共 {payload.lesson_count || items.length})
      </div>
      {items.map((it, i) => (
        <div key={i} className="row gap-10" style={{ alignItems: "baseline" }}>
          <span className="mono" style={{ fontSize: 11, color: "var(--ink-3, #7a6e58)", minWidth: 28 }}>{String(it.idx + 1).padStart(2, "0")}</span>
          <span style={{ fontStyle: "italic", color: "var(--ink, #29261b)", fontSize: 14, flex: 1 }}>{it.title || "(untitled)"}</span>
          {it.phase && <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3, #7a6e58)", letterSpacing: ".08em" }}>· {it.phase}</span>}
        </div>
      ))}
    </div>
  );
}

function PayloadCritiqueDone({ payload }) {
  const total = payload.findings_total || 0;
  const cols = [
    { name: "浪师", role: "找缺漏 / 跨域", preview: Array.isArray(payload.lung_preview)  ? payload.lung_preview  : [] },
    { name: "谬师", role: "拆框架 / Feynman", preview: Array.isArray(payload.muse_preview)  ? payload.muse_preview  : [] },
    { name: "侦师", role: "验引证 / 包",     preview: Array.isArray(payload.scout_preview) ? payload.scout_preview : [] },
  ];
  return (
    <div className="col gap-10" style={{ marginTop: 8 }}>
      <div className="mono" style={{ fontSize: 10.5, letterSpacing: ".12em", color: "var(--ink-3, #7a6e58)" }}>
        三师共找 {total} 处 {payload.refined ? "· 已整合改稿" : "· 未改稿"}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
        {cols.map((c, i) => (
          <div key={i} className="col gap-4" style={{ paddingLeft: 10, borderLeft: "1px solid var(--rule-soft, rgba(120,90,60,.25))" }}>
            <div style={{ fontSize: 13, color: "var(--ink, #29261b)" }}>
              <span style={{ fontStyle: "italic" }}>{c.name}</span>
              <span className="mono" style={{ fontSize: 10, color: "var(--ink-3, #7a6e58)", marginLeft: 6, letterSpacing: ".08em" }}>· {c.role}</span>
            </div>
            {c.preview.length === 0 ? (
              <div style={{ fontStyle: "italic", color: "var(--ink-3, #7a6e58)", fontSize: 12.5 }}>(无发现 / 未传文本)</div>
            ) : (
              c.preview.map((f, fi) => (
                <div key={fi} style={{ fontStyle: "italic", color: "var(--ink-2, #4a4232)", fontSize: 12.5, lineHeight: 1.45 }}>
                  · {f}
                </div>
              ))
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PayloadBody0Done({ payload }) {
  const hook = payload && payload.hook;
  const kps = Array.isArray(payload && payload.kp_titles) ? payload.kp_titles : [];
  return (
    <div className="col gap-8" style={{ marginTop: 8 }}>
      <div className="mono" style={{ fontSize: 10.5, letterSpacing: ".12em", color: "var(--ink-3, #7a6e58)" }}>
        第 1 节钩子 + 知识点 ({payload.kp_count || kps.length})
      </div>
      {hook && (
        <div style={{ fontStyle: "italic", color: "var(--ink, #29261b)", fontSize: 14, padding: "8px 14px", background: "var(--paper-warm, #f1eadb)", borderLeft: "2px solid var(--brass-bright, #b18432)" }}>
          {hook}
        </div>
      )}
      <div className="col gap-3">
        {kps.map((t, i) => (
          <div key={i} className="row gap-8" style={{ alignItems: "baseline" }}>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3, #7a6e58)", minWidth: 24 }}>KP{i + 1}</span>
            <span style={{ fontStyle: "italic", color: "var(--ink-2, #4a4232)", fontSize: 13.5 }}>{t || "(untitled)"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PayloadLessonCountDerived({ payload }) {
  return (
    <div className="col gap-4" style={{ marginTop: 8 }}>
      <div style={{ fontStyle: "italic", color: "var(--ink, #29261b)", fontSize: 15 }}>
        目标节数: {payload.target || "?"}
      </div>
      <div style={{ fontStyle: "italic", color: "var(--ink-3, #7a6e58)", fontSize: 13, lineHeight: 1.55 }}>
        {payload.reasoning || "(no reasoning provided)"}
      </div>
    </div>
  );
}

function PayloadFeasibilityAssessed({ payload }) {
  const verdictMap = {
    feasible: { tone: "var(--brass-bright, #b18432)", label: "可行 · 正常节奏" },
    strained: { tone: "var(--brass-bright, #b18432)", label: "紧张 · scope 偏密, 仍设计" },
    absurd:   { tone: "var(--brass-bright, #b18432)", label: "极远 · micro-curriculum, 仍设计" },
  };
  const v = verdictMap[payload.verdict] || { tone: "var(--ink-3, #7a6e58)", label: payload.verdict || "?" };
  const sg = payload.suggestions || {};
  return (
    <div className="col gap-8" style={{ marginTop: 8 }}>
      <div className="row gap-10" style={{ alignItems: "baseline" }}>
        <span className="mono" style={{ fontSize: 10.5, letterSpacing: ".12em", color: "var(--ink-3, #7a6e58)" }}>判定</span>
        <span style={{ fontStyle: "italic", color: v.tone, fontSize: 15 }}>{v.label}</span>
      </div>
      {payload.headline && (
        <div style={{ fontStyle: "italic", color: "var(--ink, #29261b)", fontSize: 14, padding: "8px 14px", background: "var(--paper-warm, #f1eadb)", borderLeft: "2px solid " + v.tone }}>
          {payload.headline}
        </div>
      )}
      {payload.reasoning && (
        <div style={{ fontStyle: "italic", color: "var(--ink-2, #4a4232)", fontSize: 13.5, lineHeight: 1.55 }}>
          {payload.reasoning}
        </div>
      )}
      {(sg.tighten_scope || sg.extend_deadline || sg.steel_man_intent) && (
        <div className="col gap-4" style={{ paddingTop: 6 }}>
          {sg.tighten_scope && (
            <div className="row gap-8" style={{ alignItems: "baseline" }}>
              <span className="mono" style={{ fontSize: 10.5, letterSpacing: ".08em", color: "var(--ink-3, #7a6e58)", minWidth: 90 }}>缩 scope</span>
              <span style={{ fontStyle: "italic", color: "var(--ink-2, #4a4232)", fontSize: 13 }}>{sg.tighten_scope}</span>
            </div>
          )}
          {sg.extend_deadline && (
            <div className="row gap-8" style={{ alignItems: "baseline" }}>
              <span className="mono" style={{ fontSize: 10.5, letterSpacing: ".08em", color: "var(--ink-3, #7a6e58)", minWidth: 90 }}>扩 deadline</span>
              <span style={{ fontStyle: "italic", color: "var(--ink-2, #4a4232)", fontSize: 13 }}>{sg.extend_deadline}</span>
            </div>
          )}
          {sg.steel_man_intent && (
            <div className="row gap-8" style={{ alignItems: "baseline" }}>
              <span className="mono" style={{ fontSize: 10.5, letterSpacing: ".08em", color: "var(--ink-3, #7a6e58)", minWidth: 90 }}>真正想要</span>
              <span style={{ fontStyle: "italic", color: "var(--ink-2, #4a4232)", fontSize: 13 }}>{sg.steel_man_intent}</span>
            </div>
          )}
        </div>
      )}
      {payload.math && (
        <div className="row gap-12" style={{ alignItems: "baseline", paddingTop: 6 }}>
          <span className="mono" style={{ fontSize: 10, color: "var(--ink-3, #7a6e58)", letterSpacing: ".08em" }}>
            数学锚: 需 {payload.math.estimated_hours_needed || "?"}h · 时间 {payload.math.available_hours_in_deadline || "?"}h · 比 {(payload.math.feasibility_ratio || 0).toFixed(2)}
          </span>
        </div>
      )}
      <div style={{ fontStyle: "italic", color: "var(--ink-3, #7a6e58)", fontSize: 12.5, paddingTop: 6 }}>
        HYPHA 继续设计课程 — 数学是参考, ! 上限。
      </div>
    </div>
  );
}

function PayloadArchetypeDone({ payload }) {
  return (
    <div className="col gap-4" style={{ marginTop: 8 }}>
      <div className="mono" style={{ fontSize: 11, color: "var(--ink-3, #7a6e58)", letterSpacing: ".12em" }}>
        题型 archetype
      </div>
      <div style={{ fontStyle: "italic", color: "var(--ink, #29261b)", fontSize: 15 }}>
        {payload.archetype || "?"}
        {payload.reused ? <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3, #7a6e58)", marginLeft: 10 }}>· 复用 pre-harvest 结果</span> : null}
      </div>
    </div>
  );
}

function PayloadGeneric({ payload }) {
  if (!payload || typeof payload !== "object") return null;
  const skip = new Set(["stage", "topic"]);
  const keys = Object.keys(payload).filter(k => !skip.has(k));
  if (keys.length === 0) return null;
  return (
    <div className="col gap-3" style={{ marginTop: 6 }}>
      {keys.map((k, i) => {
        let v = payload[k];
        if (typeof v === "object" && v !== null) v = JSON.stringify(v).slice(0, 160);
        else v = String(v).slice(0, 240);
        return (
          <div key={i} className="row gap-10" style={{ alignItems: "baseline" }}>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3, #7a6e58)", letterSpacing: ".08em", minWidth: 110 }}>{k}</span>
            <span style={{ fontStyle: "italic", color: "var(--ink-2, #4a4232)", fontSize: 13 }}>{v}</span>
          </div>
        );
      })}
    </div>
  );
}

// Map stage → specific renderer (else fall back to PayloadGeneric)
function _renderPayloadFor(stage, payload) {
  switch (stage) {
    case "feasibility:assessed":    return <PayloadFeasibilityAssessed payload={payload} />;
    case "harvest:done":            return <PayloadHarvestDone payload={payload} />;
    case "designing-digest-done":   return <PayloadDigestDone payload={payload} />;
    case "designing-seed-done":     return <PayloadSyllabusPreview payload={payload} />;
    case "critique:done":           return <PayloadCritiqueDone payload={payload} />;
    case "body-0:done":             return <PayloadBody0Done payload={payload} />;
    case "lesson-count-derived":    return <PayloadLessonCountDerived payload={payload} />;
    case "designing-archetype":
    case "designing-archetype-done": return <PayloadArchetypeDone payload={payload} />;
    default:                        return <PayloadGeneric payload={payload} />;
  }
}

// ──────────────────────────────────────────────────────────────────────
// LogRow — single entry. Click to expand/collapse.
// ──────────────────────────────────────────────────────────────────────

function LogRow({ entry, firstTs, isLast }) {
  const [expanded, setExpanded] = useState(false);
  const hasPayload = entry.payload && typeof entry.payload === "object"
    && Object.keys(entry.payload).filter(k => k !== "stage" && k !== "topic").length > 0;
  return (
    <div className="col gap-2" style={{
      padding: "10px 16px",
      borderBottom: isLast ? "none" : "0.5px solid var(--rule-soft, rgba(120,90,60,.25))",
    }}>
      <div
        className="row gap-12"
        style={{ alignItems: "baseline", cursor: hasPayload ? "pointer" : "default" }}
        onClick={() => { if (hasPayload) setExpanded(e => !e); }}
      >
        <span className="mono" style={{ fontSize: 11, color: "var(--ink-3, #7a6e58)", letterSpacing: ".06em", minWidth: 72 }}>
          {_ts(entry.ts)}
        </span>
        <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3, #7a6e58)", minWidth: 50 }}>
          {_elapsed(firstTs, entry.ts)}
        </span>
        <span style={{ fontStyle: "italic", color: "var(--ink, #29261b)", fontSize: 14.5, flex: 1 }}>
          {entry.label || entry.stage}
        </span>
        {hasPayload && (
          <span className="mono" style={{ fontSize: 11, color: "var(--brass-dim, #8b6a4d)" }}>
            {expanded ? "▾ 收" : "▸ 展开"}
          </span>
        )}
      </div>
      {expanded && hasPayload && (
        <div style={{ paddingLeft: 134 }}>
          {_renderPayloadFor(entry.stage, entry.payload)}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// BuildLogScreen — top-level surface during isCreatingCurriculum
// ──────────────────────────────────────────────────────────────────────

const BuildLogScreen = ({ topic, currentStage, log, error }) => {
  const scrollRef = useRef(null);
  const firstTs = useMemo(() => (Array.isArray(log) && log.length > 0 ? log[0].ts : null), [log]);

  // Auto-scroll to bottom on new entries.
  useEffect(() => {
    if (!scrollRef.current) return;
    try { scrollRef.current.scrollTop = scrollRef.current.scrollHeight; } catch (_) {}
  }, [log.length]);

  return (
    <div className="fade-in col" style={{
      minHeight: "100vh",
      padding: "60px 32px 80px",
      gap: 24,
      alignItems: "center",
      background: "var(--paper, #fbf6e9)",
      color: "var(--ink, #29261b)",
    }}>
      <div className="col gap-8" style={{ alignItems: "center", maxWidth: 760, width: "100%" }}>
        <div className="serif italic" style={{ fontSize: 32, lineHeight: 1.2, color: "var(--ink, #29261b)" }}>
          正在备课
        </div>
        <div className="mono t-small" style={{ color: "var(--ink-3, #7a6e58)", letterSpacing: ".12em", fontSize: 11 }}>
          {topic || "(unnamed)"}
        </div>
        <div className="mono t-small" style={{ color: "var(--ink-2, #4a4232)", fontSize: 12, letterSpacing: ".06em", minHeight: 18 }}>
          {currentStage || "starting…"}
        </div>
        <div className="mono" style={{ color: "var(--ink-3, #7a6e58)", fontSize: 10.5, letterSpacing: ".12em", marginTop: 4 }}>
          {log.length} 步已记录 · 点击行展开看结果
        </div>
      </div>

      <div
        ref={scrollRef}
        style={{
          maxWidth: 880,
          width: "100%",
          maxHeight: "60vh",
          overflowY: "auto",
          background: "var(--paper, #fbf6e9)",
          border: "0.5px solid var(--rule-soft, rgba(120,90,60,.25))",
        }}
      >
        {log.length === 0 ? (
          <div style={{ padding: "40px 20px", textAlign: "center", fontStyle: "italic", color: "var(--ink-3, #7a6e58)", fontSize: 14 }}>
            HYPHA 正在打开网,等第一批源进来…
          </div>
        ) : (
          log.map((entry, i) => (
            <LogRow key={i} entry={entry} firstTs={firstTs} isLast={i === log.length - 1} />
          ))
        )}
      </div>

      {error && (
        <div style={{
          maxWidth: 720,
          padding: "12px 16px",
          background: "rgba(122, 58, 58, 0.08)",
          borderLeft: "2px solid var(--oxblood, #7a3a3a)",
          color: "var(--ink, #29261b)",
          fontStyle: "italic",
          fontSize: 14,
        }}>
          {error}
        </div>
      )}
    </div>
  );
};

if (typeof window !== "undefined") {
  window.BuildLogScreen = BuildLogScreen;
}
