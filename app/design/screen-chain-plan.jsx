/* global React */
//
// HYPHA · Chain Plan screen (2026-05-17, Machino Gap 1)
//
// Renders the multi-link chain plan returned by chain:create. User reaches
// this screen when route-goal classifies the goal as ambitious (difficulty
// >= 0.7 AND conservative_years >= 3) and chain:create resolves with an
// `ok:true` plan. The legacy ChainPlannerView in ptor-app/ stays put — this
// is the new design/ surface (cream paper / brass / Garamond manuscript
// register), mounted from app.jsx route case 'chain-plan'.
//
// Props:
//   slug          — string, chain meta-folder slug
//   plan          — object, chain.data from chain:create (full chainData)
//   buildLog      — array of { stage, label, ts, payload }, build-log rows
//                   carried over from the create pipeline so the user keeps
//                   visible trace of how the plan was assembled.
//   onAcceptChain — async () → void, fires chain:accept then chain:start
//   onCancel      — () → void, return to onboarding to redesign
//
// Register: italic EB Garamond + Noto Serif SC on cream paper, brass hair-
// lines, manuscript cadence. State chips render at rest; hover lifts a
// brass top-rule (tokonoma footer pattern). No emoji, no exclamation marks,
// no encouragement copy, no third-person.

const { useState, useMemo } = React;

// ─────────────────────────────────────────────────────────────────────
// Phase C · 5-axis output target schema (mirrors app/lib/lifetime-ledger/
// axes.js — kept duplicated client-side so the JSX can render w/o IPC).
// Backend remains source of truth; if it changes, update both.
// ─────────────────────────────────────────────────────────────────────

const AXIS_LABEL = {
  learn:    "学",
  practice: "练",
  produce:  "产",
  read:     "读",
  reflect:  "反",
};

const AXIS_UNIT_DEFAULT = {
  learn:    "节理论课",
  practice: "小时",
  produce:  "部",
  read:     "本",
  reflect:  "次",
};

// Axis register — manuscript palette w/ explicit fallbacks so missing
// CSS variables degrade to legible ink-on-cream rather than transparent.
const AXIS_COLOR = {
  learn:    "var(--ink-2, #4a3530)",
  practice: "var(--brass-bright, #b58b3a)",
  produce:  "#c25a36",
  read:     "var(--ochre-2, #a86918)",
  reflect:  "var(--cream-2, #b9a073)",
};

const ARCHETYPE_AXIS_SET = {
  "HUMANITIES":   ["learn", "practice", "produce", "read", "reflect"],
  "TECH-CONCEPT": ["learn", "practice", "produce", "reflect"],
  "TECH-PROC":    ["learn", "practice", "produce", "reflect"],
  "LANG-ACQ":     ["learn", "practice"],
  "DECL-MASS":    ["learn", "practice"],
  "MINDSET":      ["learn", "practice"],
};

function _axesForArchetype(archetype) {
  return ARCHETYPE_AXIS_SET[archetype] || ["learn", "practice"];
}

function _readArchetype(plan) {
  if (!plan) return null;
  return plan.archetype
    || (plan.chain && plan.chain.archetype)
    || (plan.inputs && plan.inputs.archetype)
    || null;
}

// Walk `link.output_targets[]` (Phase C schema: array of {axis, count, unit})
// and sum count per axis across all links. Tolerant of missing field — Agent
// A's planChain may not have populated it yet for legacy chains; in that case
// the header renders nothing.
function _sumOutputTargets(links) {
  const out = {};
  for (const link of links || []) {
    const targets = link && Array.isArray(link.output_targets)
      ? link.output_targets : [];
    for (const t of targets) {
      if (!t || typeof t.axis !== "string") continue;
      const n = Number(t.count);
      if (!Number.isFinite(n) || n <= 0) continue;
      out[t.axis] = (out[t.axis] || 0) + n;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// AxisMatrixHeader — under-banner panel rendering cumulative target per
// axis. Top-3 axes (by count) shown at rest; remaining axes collapse
// behind a quiet "+ N 轴" button (manuscript reveal, ! popup).
// ─────────────────────────────────────────────────────────────────────

function AxisMatrixHeader({ axes, archetype }) {
  const [open, setOpen] = useState(false);
  const archetypeAxes = _axesForArchetype(archetype);
  const present = archetypeAxes.filter(a => (axes && axes[a] > 0));
  if (present.length === 0) return null;

  // Order by count desc so top-3 surfaces the dominant axes; ties keep
  // archetype order as secondary anchor.
  const ordered = [...present].sort((a, b) => (axes[b] || 0) - (axes[a] || 0));
  const top3 = ordered.slice(0, 3);
  const rest = ordered.slice(3);

  const Row = ({ axis }) => (
    <div className="row gap-12" style={{ alignItems: "baseline" }}>
      <span style={{
        display: "inline-block", width: 6, height: 6, borderRadius: 3,
        background: AXIS_COLOR[axis] || "var(--ink-3)",
        marginRight: 2,
      }} />
      <span className="serif" style={{
        minWidth: 28, color: "var(--ink-3)",
        fontStyle: "italic", fontSize: 14,
      }}>
        {AXIS_LABEL[axis] || axis}
      </span>
      <span className="serif" style={{ fontSize: 17, color: "var(--ink)" }}>
        {axes[axis]}
      </span>
      <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
        {AXIS_UNIT_DEFAULT[axis] || ""}
      </span>
    </div>
  );

  return (
    <div style={{
      marginTop: 6, paddingTop: 12,
      borderTop: "1px solid var(--rule-soft)",
    }}>
      <div className="mono" style={{
        fontSize: 10.5, letterSpacing: ".14em",
        color: "var(--ink-3)", textTransform: "uppercase",
        marginBottom: 8,
      }}>
        累计目标量 · 5 轴
      </div>
      <div className="col gap-4">
        {top3.map(a => <Row key={a} axis={a} />)}
        {rest.length > 0 && !open && (
          <button
            className="btn btn-ghost"
            onClick={() => setOpen(true)}
            style={{
              fontSize: 11, alignSelf: "flex-start",
              color: "var(--ink-3)", padding: "4px 0",
              border: "none", background: "transparent",
              fontStyle: "italic",
            }}>
            + {rest.length} 轴
          </button>
        )}
        {open && rest.map(a => <Row key={a} axis={a} />)}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// AxisBarStack — flex-1 weighted segments inside an 8px brass strip.
// Each segment's width is proportional to its axis count relative to
// the link's max axis. Tooltip carries the full axis · count · unit
// list so hover gives the exact breakdown without expanding the row.
// ─────────────────────────────────────────────────────────────────────

function AxisBarStack({ targets }) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return (
      <span style={{ fontSize: 10, color: "var(--ink-3)" }}>—</span>
    );
  }
  const max = Math.max(...targets.map(t => Number(t && t.count) || 0), 1);
  const tip = targets
    .map(t => `${AXIS_LABEL[t.axis] || t.axis}: ${t.count}${t.unit ? " " + t.unit : ""}`)
    .join("  ·  ");
  return (
    <div className="row gap-2" style={{
      width: 96, height: 8,
      alignItems: "stretch",
    }} title={tip}>
      {targets.map((t, i) => {
        const n = Number(t && t.count) || 0;
        if (n <= 0) return null;
        return (
          <div key={i} style={{
            flex: n / max,
            background: AXIS_COLOR[t.axis] || "var(--ink-3)",
            minWidth: 2,
          }} />
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Field readers — chain.json has nested shape: { chain: { links: [...] },
// ultimate_goal, feasibility:{tier}, inputs:{timeWeeks, dailyHours,
// difficulty}, tier (pacing) }. Defensive readers cover legacy shapes.
// ─────────────────────────────────────────────────────────────────────

function _readLinks(plan) {
  if (!plan) return [];
  if (Array.isArray(plan.links)) return plan.links;
  if (plan.chain && Array.isArray(plan.chain.links)) return plan.chain.links;
  return [];
}

function _readUltimateGoal(plan) {
  if (!plan) return "";
  return plan.ultimate_goal || (plan.chain && plan.chain.ultimate_goal) || "";
}

function _readConservativeYears(plan) {
  // Sum duration_weeks across all links → years (1 dp). Falls back to
  // feasibility.years if the field exists, else 0.
  const links = _readLinks(plan);
  const weekSum = links.reduce((s, l) => s + (Number(l && l.duration_weeks) || 0), 0);
  if (weekSum > 0) return Number((weekSum / 52).toFixed(1));
  const fy = plan && plan.feasibility && Number(plan.feasibility.years_p50);
  if (Number.isFinite(fy)) return Number(fy.toFixed(1));
  return 0;
}

function _readTier(plan) {
  return (plan && plan.tier) || "moderate";
}

function _readFeasibilityVerdict(plan) {
  const v = plan && plan.feasibility && plan.feasibility.tier;
  if (v === "easy") return "可行";
  if (v === "possible") return "紧张但可设计";
  if (v === "nearly-impossible") return "极远 — 仍可设计";
  return "";
}

// ─────────────────────────────────────────────────────────────────────
// RerouteBanner (boot-6, 2026-05-20) — surfaced when chain-folder emits
// status='NEEDS_REROUTE' (total lessons > HARD_CAP 60). Renders three
// options the user can take BEFORE pressing Accept:
//   (a) split into prerequisite chain → onProposePrereqs()
//   (b) lower density (refuse + re-plan) → onLowerDensity()
//   (c) accept anyway → onAcceptAnyway() (delegates to onAcceptChain)
//
// Register: oxblood hairline (#7a3a3a) — same band the error band uses,
// italic Garamond body, mono eyebrow. NOT a popup; sits inline above the
// stage list so the user reads it as part of the plan, not as a blocker.
// ─────────────────────────────────────────────────────────────────────

function RerouteBanner({ reason, options, busy, onProposePrereqs, onLowerDensity, onAcceptAnyway }) {
  if (!options || !Array.isArray(options) || options.length === 0) return null;
  const total = reason && Number(reason.total_after);
  const cap = reason && Number(reason.hard_cap);

  const optById = Object.fromEntries(
    options.map(o => [o && o.id, o]).filter(([k]) => k)
  );
  const splitOpt = optById['split-prereq'];
  const lowerOpt = optById['lower-density'];
  const acceptOpt = optById['accept-partial'];

  return (
    <div style={{
      maxWidth: 920, margin: '0 auto 28px',
      padding: '18px 24px 20px',
      background: 'rgba(122, 58, 58, 0.06)',
      borderLeft: '2px solid #7a3a3a',
      position: 'relative', zIndex: 2,
    }}>
      <div className="mono" style={{
        fontSize: 10.5, letterSpacing: '.14em',
        color: '#7a3a3a', textTransform: 'uppercase',
        marginBottom: 6,
      }}>
        超出推荐范围 · 需要重新规划
      </div>
      <div className="serif" style={{
        fontSize: 15, color: 'var(--ink)', lineHeight: 1.6,
        fontStyle: 'italic', marginBottom: 14,
      }}>
        {Number.isFinite(total) && Number.isFinite(cap) ? (
          <>当前计划累计 <span style={{ fontStyle: 'normal' }}>{total}</span> 节, 超过单链上限 <span style={{ fontStyle: 'normal' }}>{cap}</span> 节. 这通常意味着目标过宽 — HYPHA 推荐先拆分, 否则课程深度会被强行压缩.</>
        ) : (
          <>当前计划超过单链上限. HYPHA 推荐先拆分目标, 再生成完整课程链.</>
        )}
      </div>
      <div className="col gap-8">
        {splitOpt && (
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={onProposePrereqs}
            style={{
              textAlign: 'left', padding: '10px 14px',
              borderTop: '1px solid var(--rule-soft)',
              borderRight: 'none', borderBottom: 'none', borderLeft: 'none',
              background: 'transparent', cursor: busy ? 'wait' : 'pointer',
              color: 'var(--ink)',
            }}>
            <div className="serif" style={{ fontSize: 14.5, lineHeight: 1.5 }}>{splitOpt.label}</div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 3, fontStyle: 'italic' }}>{splitOpt.rationale}</div>
          </button>
        )}
        {lowerOpt && (
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={onLowerDensity}
            style={{
              textAlign: 'left', padding: '10px 14px',
              borderTop: '1px solid var(--rule-soft)',
              borderRight: 'none', borderBottom: 'none', borderLeft: 'none',
              background: 'transparent', cursor: busy ? 'wait' : 'pointer',
              color: 'var(--ink)',
            }}>
            <div className="serif" style={{ fontSize: 14.5, lineHeight: 1.5 }}>{lowerOpt.label}</div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 3, fontStyle: 'italic' }}>{lowerOpt.rationale}</div>
          </button>
        )}
        {acceptOpt && (
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={onAcceptAnyway}
            style={{
              textAlign: 'left', padding: '10px 14px',
              borderTop: '1px solid var(--rule-soft)',
              borderRight: 'none', borderBottom: 'none', borderLeft: 'none',
              background: 'transparent', cursor: busy ? 'wait' : 'pointer',
              color: 'var(--ink-2)',
            }}>
            <div className="serif" style={{ fontSize: 13.5, lineHeight: 1.5, fontStyle: 'italic' }}>{acceptOpt.label}</div>
            <div style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 3 }}>{acceptOpt.rationale}</div>
          </button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Stage row — one chain link, hover lifts brass top-rule
// ─────────────────────────────────────────────────────────────────────

const ROLE_LABEL_ZH = {
  prerequisite: "前置",
  core: "核心",
  ultimate: "终极",
};
const roleLabel = (r) => ROLE_LABEL_ZH[r] || r || "未知";

function StageRow({ idx, link, total, axisP50Warnings }) {
  const [hover, setHover] = useState(false);
  const role = (link && link.role) || "core";
  const roleLabelText = roleLabel(role);
  const lessons = Number(link && link.lessons_count) || 0;
  const weeks = Number(link && link.duration_weeks) || 0;
  const title = (link && link.topic) || "(无 题)";
  const exit = (link && link.exit_criterion) || "";
  const rationale = (link && link.rationale) || "";

  // 2026-05-17 Phase C Gap 2 (MEOW BLOCKER fix) — surface axis_p50 anchor
  // mismatches. axisP50Warnings is the chain-level array filtered to this
  // link's idx. Each entry = {axis, target_count, p50_value, ratio}. Renders
  // a gray dot + tooltip when LLM's frontier p50 disagrees > 3x with its
  // own output_targets count — signals "数值参考" not deterministic.
  const linkWarnings = Array.isArray(axisP50Warnings)
    ? axisP50Warnings.filter(w => w && w.link_idx === idx)
    : [];

  // State machine: idx 0 starts pending (chain:accept lazy-commits all). UI
  // here is pre-accept, so every link reads as "未启" — actual active/done
  // markers ship after chain:start runs and links-state.json updates.
  const stateLabel = "未启";

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative",
        padding: "20px 24px 22px",
        borderBottom: "1px solid var(--rule-soft)",
        background: hover ? "rgba(180,140,80,.04)" : "transparent",
        transition: "background .25s ease",
      }}>
      {/* Hover top-rule (brass hairline) — tokonoma footer pattern. */}
      <div style={{
        position: "absolute",
        top: 0, left: 24, right: 24, height: 1,
        background: "var(--ochre-2, #a86918)",
        opacity: hover ? 0.6 : 0,
        transition: "opacity .25s ease",
      }} />

      <div className="row gap-16" style={{ alignItems: "baseline" }}>
        {/* Serial — mono numeral */}
        <div className="mono" style={{
          minWidth: 36, fontSize: 13, color: "var(--ink-3)",
          letterSpacing: ".08em",
        }}>
          {String(idx + 1).padStart(2, "0")}/{String(total).padStart(2, "0")}
        </div>

        {/* Title + role chip */}
        <div className="col gap-6" style={{ flex: 1, minWidth: 0 }}>
          <div className="row gap-10" style={{ alignItems: "baseline" }}>
            <span className="serif" style={{
              fontSize: 19, color: "var(--ink)", fontWeight: 400,
              lineHeight: 1.3,
            }}>
              {title}
            </span>
            <span className="mono" style={{
              fontSize: 10, letterSpacing: ".14em",
              color: role === "ultimate" ? "var(--ochre-2, #a86918)" : "var(--ink-3)",
              padding: "2px 6px",
              border: `1px solid ${role === "ultimate" ? "var(--ochre-2, #a86918)" : "var(--rule)"}`,
              textTransform: "uppercase",
            }}>
              {roleLabelText}
            </span>
          </div>

          {exit && (
            <div className="serif" style={{
              fontSize: 14.5, color: "var(--ink-2)", lineHeight: 1.55,
              fontStyle: "italic",
            }}>
              <span style={{ color: "var(--ink-3)", fontStyle: "normal" }}>
                完成时你能 —{" "}
              </span>
              {exit}
            </div>
          )}

          {rationale && hover && (
            <div style={{
              fontSize: 12.5, color: "var(--ink-3)", lineHeight: 1.5,
              marginTop: 2, paddingTop: 6,
              borderTop: "1px dashed var(--rule-soft)",
            }}>
              {rationale}
            </div>
          )}
        </div>

        {/* Right column — duration + lesson count + axis mini-bar + state.
            AxisBarStack ride between "lessons" and "state" so the eye reads:
            duration → curriculum size → output-mix proportions → status. */}
        <div className="col gap-4" style={{
          minWidth: 110, textAlign: "right",
          alignItems: "flex-end",
        }}>
          <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-2)", letterSpacing: ".04em" }}>
            {weeks > 0 ? `${weeks.toFixed(0)} 周` : "—"}
          </div>
          <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)", letterSpacing: ".04em" }}>
            约 {lessons || "?"} 节
          </div>
          <div className="row gap-6" style={{ marginTop: 4, marginBottom: 2, alignItems: 'center', justifyContent: 'flex-end' }}>
            <AxisBarStack targets={link && link.output_targets} />
            {linkWarnings.length > 0 && (
              <span
                title={'数值参考 · LLM frontier_axis_p50 与 output_targets 不一致:\n' +
                  linkWarnings.map(w => `  ${w.axis}: 目标 ${w.target_count} · 标杆估 ${w.p50_value} · 比 ${w.ratio}`).join('\n')}
                style={{
                  display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
                  background: 'var(--ink-3)', opacity: 0.45,
                }} />
            )}
          </div>
          <div className="mono" style={{
            fontSize: 10, color: "var(--ink-3)",
            letterSpacing: ".12em", textTransform: "uppercase",
            marginTop: 2,
          }}>
            · {stateLabel} ·
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// ChainPlanScreen — primary export
// ─────────────────────────────────────────────────────────────────────

const ChainPlanScreen = ({ slug, plan, routeInfo, buildLog, onAcceptChain, onCancel, rerouteEnvelope, onProposePrereqs, onLowerDensity }) => {
  const links = useMemo(() => _readLinks(plan), [plan]);
  const ultimateGoal = useMemo(() => _readUltimateGoal(plan), [plan]);
  const phaseCount = links.length;
  // MEOW MID-1 (2026-05-17) — three numbers used to read as parallel facts
  // but had orthogonal meaning. Pull each from a distinct source so the UI
  // can label them separately:
  //   horizonYears   — frontier-grounded estimate from route-goal (p75 of
  //                    benchmark people; falls back to chain.feasibility
  //                    or sum(duration_weeks)/52 if route data missing)
  //   totalLessons   — sum(link.lessons_count): the actual curriculum size
  //                    HYPHA will generate across all stages
  //   phaseCount     — how many staged links the chain is broken into
  const horizonYears = useMemo(() => {
    if (routeInfo && Number.isFinite(Number(routeInfo.conservative_years))) {
      return Number(routeInfo.conservative_years);
    }
    return _readConservativeYears(plan);
  }, [routeInfo, plan]);
  const totalLessons = useMemo(() => links.reduce(
    (s, l) => s + (Number(l && l.lessons_count) || 0), 0
  ), [links]);
  // Phase C — sum per-axis target counts across all links + read archetype.
  // Tolerant of missing output_targets (legacy chains): summedAxes ends up {}
  // and AxisMatrixHeader renders nothing.
  const summedAxes = useMemo(() => _sumOutputTargets(links), [links]);
  const archetype = useMemo(() => _readArchetype(plan) || "HUMANITIES", [plan]);
  // Phase C Gap 2 (MEOW BLOCKER) — chain-level axis_p50 anchor mismatches
  // produced by agent.js planChain._auditAxisP50. Lives on chainData
  // (plan.axis_p50_warnings) or under plan.chain. Each entry =
  // {link_idx, axis, target_count, p50_value, ratio}.
  const axisP50Warnings = useMemo(() => {
    if (!plan) return [];
    if (Array.isArray(plan.axis_p50_warnings)) return plan.axis_p50_warnings;
    if (plan.chain && Array.isArray(plan.chain.axis_p50_warnings)) return plan.chain.axis_p50_warnings;
    return [];
  }, [plan]);

  const evidenceCases = useMemo(() => {
    if (!routeInfo || !Array.isArray(routeInfo.evidence)) return [];
    return routeInfo.evidence.slice(0, 3).map(c => {
      const name = (c && c.name) || '';
      const yrs = (c && Number.isFinite(Number(c.years))) ? Number(c.years)
        : (c && c.start_year && c.achieve_year) ? Number(c.achieve_year) - Number(c.start_year)
        : null;
      return { name, years: yrs };
    }).filter(c => c.name);
  }, [routeInfo]);
  const tier = _readTier(plan);
  const verdict = _readFeasibilityVerdict(plan);

  // boot-6 (2026-05-20) — NEEDS_REROUTE surface. Two trigger paths:
  //   (1) rerouteEnvelope prop — caller forwards the chain:create envelope
  //       fields { needs_reroute, reroute_options, reroute_reason } directly.
  //   (2) plan.fold.status === 'NEEDS_REROUTE' fallback — for callers that
  //       still pass the legacy chainData shape without the envelope flags.
  //       We synthesize default reroute_options client-side so the banner
  //       still surfaces (defensive — main.js post-boot-6 always sends them).
  const needsReroute = useMemo(() => {
    if (rerouteEnvelope && rerouteEnvelope.needs_reroute === true) return true;
    const foldStatus = plan && plan.fold && plan.fold.status;
    return foldStatus === 'NEEDS_REROUTE';
  }, [rerouteEnvelope, plan]);

  const rerouteOptions = useMemo(() => {
    if (rerouteEnvelope && Array.isArray(rerouteEnvelope.reroute_options)) {
      return rerouteEnvelope.reroute_options;
    }
    if (!needsReroute) return null;
    // Synthesized fallback — same three options main.js boot-6 emits.
    return [
      { id: 'split-prereq',   label: '拆分前置链 — 先掌握基础, 再回到当前目标', ipc: 'chain:propose-prereqs', rationale: '当前计划超过单链上限; 推荐先走前置链.' },
      { id: 'lower-density',  label: '降低课时密度 — 让 HYPHA 重排, 每阶段更少节', ipc: 'chain:refuse',          rationale: '保留目标, 重新规划以收敛在上限之内.' },
      { id: 'accept-partial', label: '仍然接受 — 我了解这超过推荐范围',           ipc: 'chain:accept',          rationale: '锁定当前计划; HYPHA 不再阻拦.' },
    ];
  }, [rerouteEnvelope, needsReroute]);

  const rerouteReason = useMemo(() => {
    if (rerouteEnvelope && rerouteEnvelope.reroute_reason) return rerouteEnvelope.reroute_reason;
    if (!needsReroute) return null;
    const totalAfter = (plan && plan.fold && Number(plan.fold.total_after)) || totalLessons;
    const hardCap = (plan && plan.fold && Number(plan.fold.hard_cap)) || 60;
    const softCap = (plan && plan.fold && Number(plan.fold.soft_cap)) || null;
    const mode = (plan && plan.fold && plan.fold.mode) || null;
    return { total_after: totalAfter, hard_cap: hardCap, soft_cap: softCap, mode };
  }, [rerouteEnvelope, needsReroute, plan, totalLessons]);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [logOpen, setLogOpen] = useState(false);

  const accept = async () => {
    if (busy) return;
    setErr(null);
    setBusy(true);
    try {
      if (typeof onAcceptChain !== "function") {
        throw new Error("onAcceptChain handler missing");
      }
      await onAcceptChain();
    } catch (e) {
      setErr((e && e.message) || "accept failed");
      setBusy(false);
    }
  };

  // boot-6 — reroute handlers. Each guards against missing parent callback
  // (the surface still surfaces info even if the route doesn't wire IPC
  // proxies yet — banner stays informational). Errors land in the same `err`
  // band the accept flow uses.
  const proposePrereqs = async () => {
    if (busy) return;
    setErr(null);
    setBusy(true);
    try {
      if (typeof onProposePrereqs === "function") {
        await onProposePrereqs();
      } else {
        throw new Error('拆分前置链 handler 未接入 — 请回到上一屏');
      }
    } catch (e) {
      setErr((e && e.message) || 'propose-prereqs failed');
      setBusy(false);
    }
  };

  const lowerDensity = async () => {
    if (busy) return;
    setErr(null);
    setBusy(true);
    try {
      if (typeof onLowerDensity === "function") {
        await onLowerDensity();
      } else {
        throw new Error('降低密度 handler 未接入 — 请回到上一屏');
      }
    } catch (e) {
      setErr((e && e.message) || 'lower-density failed');
      setBusy(false);
    }
  };

  // Defensive — if the parent passes empty plan, render a quiet stub so the
  // route is recoverable rather than throwing.
  if (!plan || links.length === 0) {
    return (
      <div className="fade-in" style={{
        minHeight: "100vh", padding: "60px 80px",
        background: "var(--paper)", color: "var(--ink)",
        fontFamily: "var(--serif)",
      }}>
        <div className="col gap-16" style={{ maxWidth: 720, margin: "0 auto" }}>
          <div className="eyebrow">Chain Plan</div>
          <div className="t-h2 serif" style={{ fontStyle: "italic", fontWeight: 400 }}>
            未收到规划 — 请回到上一屏重试。
          </div>
          <div>
            <button className="btn btn-ghost" onClick={onCancel}>← 回去重新设计</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in" style={{
      minHeight: "100vh",
      padding: "48px 60px 96px",
      background: "var(--paper)",
      color: "var(--ink)",
      position: "relative",
      overflow: "hidden",
    }}>
      {/* Top banner — goal + phase count + years */}
      <div className="col gap-12" style={{
        maxWidth: 920, margin: "0 auto 36px",
        position: "relative", zIndex: 2,
      }}>
        <div className="row gap-12" style={{ alignItems: "baseline" }}>
          <div className="eyebrow">CHAIN PLAN</div>
          <div className="mono" style={{
            fontSize: 10.5, color: "var(--ink-3)", letterSpacing: ".12em",
          }}>
            {slug || "·"}
          </div>
        </div>

        <div className="t-h1 serif" style={{
          fontSize: 38, fontWeight: 400, lineHeight: 1.1,
          fontStyle: "italic",
        }}>
          {ultimateGoal || "你的目标"}
        </div>

        {/* MEOW MID-1 — three numbers were reading as parallel facts; relabel
            with distinct semantic anchors:
              目标地平线 = frontier-grounded p75 estimate (years to achieve, ! deterministic)
              分阶段     = chain-link count (HYPHA staging granularity)
              累计课时   = sum(lessons_count) across stages (real curriculum size) */}
        <div className="row gap-24" style={{
          alignItems: "baseline", flexWrap: "wrap",
          paddingTop: 6,
        }}>
          <div className="col gap-2">
            <div className="mono" style={{
              fontSize: 10, letterSpacing: ".14em",
              color: "var(--ink-3)", textTransform: "uppercase",
            }}>目标地平线</div>
            <div className="serif" style={{ fontSize: 22, color: "var(--ink)" }}>
              {horizonYears > 0 ? horizonYears : "—"}
              <span style={{ fontSize: 14, color: "var(--ink-3)" }}> 年</span>
            </div>
          </div>
          <div className="col gap-2">
            <div className="mono" style={{
              fontSize: 10, letterSpacing: ".14em",
              color: "var(--ink-3)", textTransform: "uppercase",
            }}>分阶段</div>
            <div className="serif" style={{ fontSize: 22, color: "var(--ink)" }}>
              {phaseCount} <span style={{ fontSize: 14, color: "var(--ink-3)" }}>段</span>
            </div>
          </div>
          <div className="col gap-2">
            <div className="mono" style={{
              fontSize: 10, letterSpacing: ".14em",
              color: "var(--ink-3)", textTransform: "uppercase",
            }}>累计课时</div>
            <div className="serif" style={{ fontSize: 22, color: "var(--ink)" }}>
              {totalLessons > 0 ? totalLessons : "—"}
              <span style={{ fontSize: 14, color: "var(--ink-3)" }}> 节</span>
            </div>
          </div>
          <div className="col gap-2">
            <div className="mono" style={{
              fontSize: 10, letterSpacing: ".14em",
              color: "var(--ink-3)", textTransform: "uppercase",
            }}>节奏</div>
            <div className="serif" style={{ fontSize: 18, color: "var(--ink)", fontStyle: "italic" }}>
              {tier === "gentle" ? "缓" : tier === "heroic" ? "激" : "稳"}
            </div>
          </div>
          {verdict && (
            <div className="col gap-2">
              <div className="mono" style={{
                fontSize: 10, letterSpacing: ".14em",
                color: "var(--ink-3)", textTransform: "uppercase",
              }}>评估</div>
              <div className="serif" style={{ fontSize: 16, color: "var(--ink-2)", fontStyle: "italic" }}>
                {verdict}
              </div>
            </div>
          )}
        </div>

        {/* MEOW MID-1 — frontier-grounded evidence anchors: show 3 benchmark
            people + their actual years so the "目标地平线 N 年" doesn't read
            as a deterministic oracle. p75 = 75th percentile across the
            scout-collected case-trajectory sources. */}
        {evidenceCases.length > 0 && (
          <div style={{
            marginTop: 4,
            fontSize: 12, color: "var(--ink-3)",
            lineHeight: 1.6,
            fontStyle: "italic",
          }}>
            基于 {evidenceCases.length} 位参照人物 ·{" "}
            {evidenceCases.map((c, i) => (
              <span key={i}>
                {c.name}{c.years != null ? ` ${c.years}年` : ""}
                {i < evidenceCases.length - 1 ? " / " : ""}
              </span>
            ))}{" "}· p75 · 你可能更快或更慢
          </div>
        )}

        {/* Phase C · 5-axis matrix — cumulative target counts summed across
            stages. Surfaces "this chain asks ~600 hours of practice + 35 books
            of reading + 30 written pieces" at a glance so the user knows the
            real shape of the commitment, not just total weeks/lessons. */}
        <AxisMatrixHeader axes={summedAxes} archetype={archetype} />

        <div className="t-quote" style={{
          marginTop: 8, paddingTop: 12,
          borderTop: "1px solid var(--rule-soft)",
          maxWidth: 680,
        }}>
          这是一条慢路。每一阶段都有它自己的 literature 与 exit. 你可以接受现在的规划,
          也可以回去把目标重写一遍。HYPHA 会把每一阶段拆成 daily lessons。
        </div>
      </div>

      {/* boot-6 (2026-05-20) — NEEDS_REROUTE banner. Sits above the stage list
          so the user sees the cap signal BEFORE scanning the plan. Three quiet
          buttons (split / lower density / accept anyway) make the path forward
          explicit — silent over-cap accept = the bug we're closing. */}
      {needsReroute && (
        <RerouteBanner
          reason={rerouteReason}
          options={rerouteOptions}
          busy={busy}
          onProposePrereqs={proposePrereqs}
          onLowerDensity={lowerDensity}
          onAcceptAnyway={accept}
        />
      )}

      {/* Stage list */}
      <div style={{
        maxWidth: 920, margin: "0 auto",
        background: "var(--cream, var(--paper))",
        border: "1px solid var(--rule)",
        position: "relative", zIndex: 2,
      }}>
        <div style={{
          padding: "12px 24px",
          borderBottom: "1px solid var(--rule)",
          background: "rgba(255,255,255,.35)",
        }}>
          <div className="mono" style={{
            fontSize: 10.5, color: "var(--ink-3)",
            letterSpacing: ".14em", textTransform: "uppercase",
          }}>
            STAGES — {phaseCount} LINKS
          </div>
        </div>
        {links.map((link, i) => (
          <StageRow
            key={i}
            idx={i}
            link={link}
            total={phaseCount}
            axisP50Warnings={axisP50Warnings}
          />
        ))}
      </div>

      {/* Build log drawer — collapsed by default. Lets the user re-read how
          the plan was harvested without leaving the screen. */}
      {Array.isArray(buildLog) && buildLog.length > 0 && (
        <div style={{
          maxWidth: 920, margin: "24px auto 0",
          position: "relative", zIndex: 2,
        }}>
          <button
            onClick={() => setLogOpen(o => !o)}
            className="mono"
            style={{
              fontSize: 10.5, letterSpacing: ".14em",
              color: "var(--ink-3)", textTransform: "uppercase",
              background: "transparent", border: "none",
              cursor: "pointer", padding: "6px 0",
            }}>
            {logOpen ? "− 收起规划过程" : `+ 展开规划过程 · ${buildLog.length} 步`}
          </button>
          {logOpen && (
            <div className="col gap-4" style={{
              marginTop: 8, padding: "14px 18px",
              border: "1px solid var(--rule-soft)",
              background: "rgba(255,255,255,.35)",
              maxHeight: 260, overflowY: "auto",
            }}>
              {buildLog.map((row, i) => (
                <div key={i} className="row gap-10" style={{ alignItems: "baseline" }}>
                  <span className="mono" style={{
                    fontSize: 10.5, color: "var(--ink-3)",
                    letterSpacing: ".04em", minWidth: 64,
                  }}>
                    {row && row.stage || "—"}
                  </span>
                  <span className="serif" style={{
                    fontSize: 13, color: "var(--ink-2)",
                    fontStyle: "italic", lineHeight: 1.45,
                  }}>
                    {(row && row.label) || ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Error band — oxblood hairline, italic, persistent until next click. */}
      {err && (
        <div style={{
          maxWidth: 920, margin: "20px auto 0",
          padding: "10px 18px",
          background: "rgba(122, 58, 58, 0.08)",
          borderLeft: "2px solid #7a3a3a",
          color: "var(--ink, #29261b)",
          fontStyle: "italic", fontSize: 13.5, lineHeight: 1.55,
          position: "relative", zIndex: 2,
        }}>
          <span className="mono" style={{
            fontSize: 10, letterSpacing: ".12em",
            color: "#7a3a3a", marginRight: 8,
          }}>
            ACCEPT FAILED
          </span>
          {err}
        </div>
      )}

      {/* Footer — accept primary, cancel ghost. */}
      <div style={{
        maxWidth: 920, margin: "32px auto 0",
        position: "relative", zIndex: 2,
      }}>
        <div className="row gap-16" style={{
          alignItems: "center", flexWrap: "wrap",
          paddingTop: 20,
          borderTop: "1px solid var(--rule)",
        }}>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={accept}
            style={{
              fontSize: 14, padding: "10px 22px",
              opacity: busy ? 0.55 : 1,
              cursor: busy ? "wait" : "pointer",
            }}>
            {busy ? "接入中 …" : "接受并开始第一阶段"}
          </button>
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={onCancel}
            style={{
              fontSize: 13, padding: "10px 18px",
            }}>
            回去重新设计
          </button>
          <span style={{ flex: 1 }} />
          <span className="t-small" style={{
            color: "var(--ink-3)", fontStyle: "italic",
            maxWidth: 360, textAlign: "right",
          }}>
            接受 = 锁定 covenant + 把所有阶段写入 vault. 第一阶段当下进入 daily lessons; 其余以待激活的占位形态停在树里。
          </span>
        </div>
      </div>
    </div>
  );
};

// Window-expose so app.jsx route 'chain-plan' picks it up via the same
// typeof guard pattern other design surfaces use.
if (typeof window !== "undefined") {
  window.ChainPlanScreen = ChainPlanScreen;
}
