/* global React */
//
// HYPHA · Lifetime Ledger screen (2026-05-17, Phase C · 5b, Machino Agent B)
//
// Per-chain weekly self-report surface. The chain-plan banner shows the
// commitment's total shape (累计目标量 · 5 轴); this screen is the running
// honesty record — user logs THIS WEEK's real numbers per axis, sees the
// gap between commitment and reality, and reads variance against the
// frontier benchmark (p25 / p50 / p75 from `frontier_axis_p50` on the link).
//
// Surface tree:
//   eyebrow + goal title
//   ThisWeekForm      — link picker, per-axis input, free-text note
//   AxisProgressBoard — cumulative / target per axis with brass mini-bar
//   VarianceDashboard — supportive line per axis (节奏在 p50-p75 · 稳)
//   HistoryList       — last 12 weeks, mono cadence
//
// Backend dependencies (built by Agent A, all currently unbridged; this
// screen tolerates missing bridges and shows a quiet "ledger 还未启用" line
// rather than blowing up):
//   window.lifetime.reportWeek({ slug, weekIso, linkIdx, axis_counts, note })
//   window.lifetime.linkProgress({ slug, linkIdx })
//                       → { axes: { learn:{cumulative, target, unit}, ... } }
//   window.lifetime.computeVariance({ chainSlug, linkIdx, axis })
//                       → { band:'p50-p75'|'below-p25'|..., supportiveLine }
//   window.lifetime.getLedger({ slug })
//                       → { entries: [{ ts, weekIso, linkIdx, axis_counts, note }] }
//
// Mount: window.LifetimeLedgerScreen. Route 'lifetime' in app.jsx.
//
// Register strictly mirrors screen-chain-plan.jsx — italic EB Garamond +
// Noto Serif SC, cream paper, brass hairlines, no emoji, no exclamation,
// no third-person, no encouragement copy.
//
// intentional-placeholder: every `placeholder="..."` below is the standard
// HTML form hint attribute (form-input grey ghost text), NOT an unfinished
// implementation marker. Same convention as screen-onboarding.jsx:17.

const { useState, useEffect, useMemo, useCallback } = React;

// ─────────────────────────────────────────────────────────────────────
// Schema mirror — kept in sync with app/lib/lifetime-ledger/axes.js
// and screen-chain-plan.jsx. Update in lockstep when axes change.
// ─────────────────────────────────────────────────────────────────────

const AXIS_LABEL = {
  learn:    "学",
  practice: "练",
  produce:  "产",
  read:     "读",
  reflect:  "反",
};

const AXIS_UNIT_DEFAULT = {
  learn:    "节",
  practice: "小时",
  produce:  "部",
  read:     "本",
  reflect:  "次",
};

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

// Match `app/lib/lifetime-ledger/index.js:_isoWeek` exactly (ISO 8601
// Thursday-anchor). Keeps the UI default-week aligned with how the
// backend stamps the ts when the user omits weekIso. Pure UTC math.
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────
// Bridge helpers — every IPC call is funneled through these so the JSX
// stays clean of typeof-guards and the screen degrades to a quiet state
// when Agent A's window.lifetime.* surface isn't yet on the preload.
// ─────────────────────────────────────────────────────────────────────

function _lifetime() {
  return (typeof window !== "undefined" && window.lifetime) ? window.lifetime : null;
}

async function _safeCall(method, args) {
  const lt = _lifetime();
  if (!lt || typeof lt[method] !== "function") {
    return { ok: false, error: "lifetime bridge missing", missing: true };
  }
  try {
    const r = await lt[method](args || {});
    return r || { ok: false, error: "empty response" };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Input + button styles — mirrors screen-onboarding's inputStyle so
// form chrome stays inside the manuscript register.
// ─────────────────────────────────────────────────────────────────────

const inputStyle = {
  padding: "8px 10px",
  border: "1px solid var(--rule)",
  borderRadius: 4,
  background: "rgba(255,255,255,.55)",
  fontSize: 14,
  fontFamily: "var(--mono, ui-monospace, 'SF Mono', Menlo, monospace)",
  color: "var(--ink)",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const textareaStyle = {
  ...inputStyle,
  fontFamily: "var(--serif)",
  fontSize: 14,
  minHeight: 72,
  lineHeight: 1.55,
  resize: "vertical",
};

// ─────────────────────────────────────────────────────────────────────
// ThisWeekForm — weekly self-report. Renders 2-5 axis inputs based on
// archetype, link selector + ISO-week stamp + note textarea.
// ─────────────────────────────────────────────────────────────────────

function ThisWeekForm({ slug, chainSlug, archetype, links, defaultLinkIdx, onSubmitted }) {
  const axes = useMemo(() => _axesForArchetype(archetype), [archetype]);
  const [linkIdx, setLinkIdx] = useState(
    Number.isFinite(Number(defaultLinkIdx)) ? Number(defaultLinkIdx) : 0
  );
  const [weekIso, setWeekIso] = useState(isoWeek(new Date()));
  const [counts, setCounts] = useState(() => {
    const init = {};
    for (const a of axes) init[a] = "";
    return init;
  });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [doneMsg, setDoneMsg] = useState(null);

  // Re-init counts when archetype-axis set changes (e.g. switching chains
  // through cmd-palette). Without this the form state would carry stale
  // axes from the previous archetype.
  useEffect(() => {
    setCounts(prev => {
      const next = {};
      for (const a of axes) next[a] = (prev && prev[a] != null) ? prev[a] : "";
      return next;
    });
  }, [archetype]);

  const setAxis = (axis) => (e) => {
    const v = e.target.value;
    // allow empty string for blank; otherwise non-negative numeric (decimals
    // ok for hours). Reject letters silently.
    if (v === "" || /^[0-9]+(\.[0-9]+)?$/.test(v)) {
      setCounts(c => ({ ...c, [axis]: v }));
    }
  };

  const submit = async () => {
    if (busy) return;
    setErr(null);
    setDoneMsg(null);
    // Build numeric axis_counts. Drop blanks so the ledger entry doesn't
    // record "0" for fields the user didn't touch this week.
    const axis_counts = {};
    for (const a of axes) {
      const raw = counts[a];
      if (raw === "" || raw == null) continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) continue;
      axis_counts[a] = n;
    }
    if (Object.keys(axis_counts).length === 0 && !note.trim()) {
      setErr("至少填一项 axis 数 或 写一句本周笔记");
      return;
    }
    setBusy(true);
    const r = await _safeCall("reportWeek", {
      slug: chainSlug || slug,
      chainSlug: chainSlug || slug,
      weekIso,
      linkIdx,
      axis_counts,
      note: note.trim(),
    });
    setBusy(false);
    if (r && r.missing) {
      setErr("ledger 还未启用 — 等 backend 接入后即可上报");
      return;
    }
    if (!r || r.ok === false) {
      setErr((r && r.error) || "上报失败");
      return;
    }
    setDoneMsg(`已记录 ${weekIso} · 阶段 ${String(linkIdx + 1).padStart(2, "0")}`);
    // Clear axis inputs but retain linkIdx + weekIso so user can quickly
    // amend if they realize they typo'd. Note also clears.
    const cleared = {};
    for (const a of axes) cleared[a] = "";
    setCounts(cleared);
    setNote("");
    if (typeof onSubmitted === "function") onSubmitted(r);
  };

  return (
    <div className="col gap-16" style={{
      padding: "20px 24px 22px",
      background: "rgba(255,255,255,.35)",
      border: "1px solid var(--rule)",
    }}>
      <div className="row gap-12" style={{ alignItems: "baseline" }}>
        <div className="eyebrow">THIS WEEK</div>
        <div className="mono" style={{
          fontSize: 10.5, color: "var(--ink-3)", letterSpacing: ".12em",
        }}>
          {weekIso}
        </div>
        <span style={{ flex: 1 }} />
        <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)", letterSpacing: ".08em" }}>
          阶段 ·
        </div>
        <select
          value={linkIdx}
          onChange={(e) => setLinkIdx(Number(e.target.value))}
          style={{ ...inputStyle, width: 220, padding: "6px 10px", fontSize: 13 }}>
          {(Array.isArray(links) ? links : []).map((l, i) => (
            <option key={i} value={i}>
              {String(i + 1).padStart(2, "0")} · {(l && l.topic) || "(无 题)"}
            </option>
          ))}
          {(!Array.isArray(links) || links.length === 0) && (
            <option value={0}>00 · 无 链上下文</option>
          )}
        </select>
      </div>

      {/* Per-axis input row — 2-5 axes per archetype. Each row =
          axis dot · italic axis label · mono numeric input · unit hint */}
      <div className="col gap-8">
        {axes.map(a => (
          <div key={a} className="row gap-12" style={{ alignItems: "center" }}>
            <span style={{
              display: "inline-block", width: 6, height: 6, borderRadius: 3,
              background: AXIS_COLOR[a] || "var(--ink-3)",
            }} />
            <span className="serif" style={{
              minWidth: 28, color: "var(--ink-2)", fontStyle: "italic",
              fontSize: 15,
            }}>
              {AXIS_LABEL[a] || a}
            </span>
            <input
              value={counts[a] || ""}
              onChange={setAxis(a)}
              placeholder="0"
              inputMode="decimal"
              style={{ ...inputStyle, width: 120, textAlign: "right" }}
            />
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
              {AXIS_UNIT_DEFAULT[a] || ""}
            </span>
          </div>
        ))}
      </div>

      <div className="col gap-6">
        <div className="mono" style={{
          fontSize: 10.5, color: "var(--ink-3)", letterSpacing: ".12em",
          textTransform: "uppercase",
        }}>
          本周笔记 · 写给自己
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="本周读到 / 写到 / 卡在 / 想清楚的一两件事"
          style={textareaStyle}
        />
      </div>

      {err && (
        <div style={{
          padding: "8px 12px",
          background: "rgba(122, 58, 58, 0.08)",
          borderLeft: "2px solid #7a3a3a",
          color: "var(--ink, #29261b)",
          fontStyle: "italic", fontSize: 13, lineHeight: 1.5,
        }}>
          {err}
        </div>
      )}
      {doneMsg && (
        <div style={{
          padding: "8px 12px",
          background: "rgba(168, 105, 24, 0.08)",
          borderLeft: "2px solid var(--ochre-2, #a86918)",
          color: "var(--ink-2)", fontStyle: "italic", fontSize: 13,
        }}>
          {doneMsg}
        </div>
      )}

      <div className="row" style={{ alignItems: "center" }}>
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={submit}
          style={{
            fontSize: 13.5, padding: "9px 20px",
            opacity: busy ? 0.55 : 1,
            cursor: busy ? "wait" : "pointer",
          }}>
          {busy ? "记账中 …" : "提交本周"}
        </button>
        <span style={{ flex: 1 }} />
        <span className="t-small" style={{
          color: "var(--ink-3)", fontStyle: "italic",
        }}>
          每周一次. 数字写真实的, 不写打算的。
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// AxisProgressBoard — cumulative vs target per axis. Calls
// window.lifetime.linkProgress() per active link; if bridge missing,
// renders only target (from chain plan) with a quiet note.
// ─────────────────────────────────────────────────────────────────────

function AxisProgressBoard({ chainSlug, linkIdx, link, archetype, refreshKey }) {
  const axes = useMemo(() => _axesForArchetype(archetype), [archetype]);
  const [progress, setProgress] = useState(null);
  const [missing, setMissing] = useState(false);

  // Build a target lookup from the link's output_targets so the board has
  // something to render even without the IPC.
  const targets = useMemo(() => {
    const out = {};
    const arr = (link && Array.isArray(link.output_targets)) ? link.output_targets : [];
    for (const t of arr) {
      if (!t || typeof t.axis !== "string") continue;
      out[t.axis] = { count: Number(t.count) || 0, unit: t.unit || AXIS_UNIT_DEFAULT[t.axis] || "" };
    }
    return out;
  }, [link]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await _safeCall("linkProgress", { slug: chainSlug, chainSlug, linkIdx });
      if (cancelled) return;
      if (r && r.missing) { setMissing(true); setProgress(null); return; }
      setMissing(false);
      setProgress((r && r.axes) || (r && r.ok && r.data && r.data.axes) || null);
    })();
    return () => { cancelled = true; };
  }, [chainSlug, linkIdx, refreshKey]);

  return (
    <div style={{
      padding: "20px 24px 22px",
      border: "1px solid var(--rule)",
      background: "rgba(255,255,255,.35)",
    }}>
      <div className="row gap-12" style={{ alignItems: "baseline", marginBottom: 14 }}>
        <div className="eyebrow">PROGRESS · 5 轴</div>
        <span style={{ flex: 1 }} />
        <div className="mono" style={{
          fontSize: 10, color: "var(--ink-3)", letterSpacing: ".14em",
          textTransform: "uppercase",
        }}>
          阶段 {String(linkIdx + 1).padStart(2, "0")}
        </div>
      </div>

      <div className="col gap-10">
        {axes.map(a => {
          const tgt = targets[a];
          const cur = progress && progress[a];
          const cumulative = cur && Number.isFinite(Number(cur.cumulative))
            ? Number(cur.cumulative) : 0;
          const target = (cur && Number.isFinite(Number(cur.target)))
            ? Number(cur.target)
            : (tgt ? tgt.count : 0);
          const unit = (cur && cur.unit) || (tgt && tgt.unit) || AXIS_UNIT_DEFAULT[a] || "";
          if (target <= 0 && cumulative === 0) {
            // Axis not part of this archetype's target. Skip silently —
            // rendering an empty row would mislead about the commitment.
            return null;
          }
          const pct = target > 0 ? Math.min(1, cumulative / target) : 0;
          return (
            <div key={a} className="col gap-4">
              <div className="row gap-12" style={{ alignItems: "baseline" }}>
                <span style={{
                  display: "inline-block", width: 6, height: 6, borderRadius: 3,
                  background: AXIS_COLOR[a] || "var(--ink-3)",
                }} />
                <span className="serif" style={{
                  minWidth: 28, color: "var(--ink-2)", fontStyle: "italic", fontSize: 15,
                }}>
                  {AXIS_LABEL[a] || a}
                </span>
                <span className="mono" style={{
                  fontSize: 13, color: "var(--ink)", letterSpacing: ".04em",
                }}>
                  {cumulative}
                  <span style={{ color: "var(--ink-3)" }}> / {target} </span>
                  <span style={{ color: "var(--ink-3)", fontSize: 11 }}>{unit}</span>
                </span>
                <span style={{ flex: 1 }} />
                <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                  {target > 0 ? `${Math.round(pct * 100)}%` : "—"}
                </span>
              </div>
              <div style={{
                position: "relative", height: 4, width: "100%",
                background: "rgba(0,0,0,.06)",
              }}>
                <div style={{
                  position: "absolute", left: 0, top: 0, bottom: 0,
                  width: `${pct * 100}%`,
                  background: AXIS_COLOR[a] || "var(--ink-3)",
                  transition: "width .35s ease",
                }} />
              </div>
            </div>
          );
        })}
      </div>

      {missing && (
        <div style={{
          marginTop: 14, paddingTop: 12,
          borderTop: "1px dashed var(--rule-soft)",
          fontSize: 12, fontStyle: "italic", color: "var(--ink-3)",
        }}>
          progress 取自 chain 目标 · cumulative 等 backend 接入后显示真实统计
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// VarianceDashboard — one line per axis, calls computeVariance per axis.
// Backend shape (assumed): { band, supportiveLine } | { ok:true, band, line }.
// Falls back to a neutral "等数据" line when bridge missing.
// ─────────────────────────────────────────────────────────────────────

function VarianceDashboard({ chainSlug, linkIdx, archetype, refreshKey }) {
  const axes = useMemo(() => _axesForArchetype(archetype), [archetype]);
  const [rows, setRows] = useState([]);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = [];
      let anyMissing = false;
      for (const a of axes) {
        const r = await _safeCall("computeVariance", {
          chainSlug, slug: chainSlug, linkIdx, axis: a,
        });
        if (cancelled) return;
        if (r && r.missing) {
          anyMissing = true;
          next.push({ axis: a, band: null, line: null });
          continue;
        }
        const band = (r && (r.band || (r.data && r.data.band))) || null;
        const line = (r && (r.supportiveLine || r.line || (r.data && r.data.supportiveLine))) || null;
        // MEOW HIGH 2026-05-17 — surface elapsed_source so user knows whether
        // the band is from wall-clock weeks (chain:start startedAt) or the
        // entry-count approximation (legacy chain, no startedAt). Without
        // this label "p50-p75" reads the same in both cases.
        const elapsedSource = (r && (r.elapsed_source || (r.data && r.data.elapsed_source))) || null;
        next.push({ axis: a, band, line, elapsedSource });
      }
      if (cancelled) return;
      setRows(next);
      setMissing(anyMissing);
    })();
    return () => { cancelled = true; };
  }, [chainSlug, linkIdx, refreshKey, archetype]);

  return (
    <div style={{
      padding: "20px 24px 22px",
      border: "1px solid var(--rule)",
      background: "rgba(255,255,255,.35)",
    }}>
      <div className="eyebrow" style={{ marginBottom: 14 }}>VARIANCE · 参照人物</div>

      <div className="col gap-10">
        {rows.map(({ axis, band, line, elapsedSource }) => (
          <div key={axis} className="row gap-12" style={{ alignItems: "baseline" }}>
            <span style={{
              display: "inline-block", width: 6, height: 6, borderRadius: 3,
              background: AXIS_COLOR[axis] || "var(--ink-3)",
            }} />
            <span className="serif" style={{
              minWidth: 28, color: "var(--ink-3)", fontStyle: "italic", fontSize: 15,
            }}>
              {AXIS_LABEL[axis] || axis}
            </span>
            {band && (
              <span className="mono" style={{
                fontSize: 10.5, letterSpacing: ".08em",
                padding: "2px 6px",
                color: "var(--ink-3)",
                border: "1px solid var(--rule-soft, var(--rule))",
              }}>
                {band}
              </span>
            )}
            {elapsedSource && (
              <span className="mono"
                title={elapsedSource === 'wall-clock'
                  ? '实际墙钟周数 (链 start 后 elapsed)'
                  : '按周自报次数近似 (legacy, 无 startedAt 戳)'}
                style={{
                  fontSize: 9.5, letterSpacing: ".06em",
                  color: "var(--ink-3)", opacity: 0.6,
                }}>
                {elapsedSource === 'wall-clock' ? '实' : '近'}
              </span>
            )}
            <span className="serif" style={{
              fontSize: 14, color: "var(--ink-2)", fontStyle: "italic",
              lineHeight: 1.5, flex: 1,
            }}>
              {line || "等数据"}
            </span>
          </div>
        ))}
      </div>

      {missing && (
        <div style={{
          marginTop: 14, paddingTop: 12,
          borderTop: "1px dashed var(--rule-soft)",
          fontSize: 12, fontStyle: "italic", color: "var(--ink-3)",
        }}>
          variance 等 backend computeVariance 接入后会按周更新
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// HistoryList — last 12 weekly entries. Reads via getLedger; sorts desc.
// ─────────────────────────────────────────────────────────────────────

function HistoryList({ chainSlug, refreshKey }) {
  const [entries, setEntries] = useState([]);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await _safeCall("getLedger", { slug: chainSlug, chainSlug });
      if (cancelled) return;
      if (r && r.missing) { setMissing(true); setEntries([]); return; }
      setMissing(false);
      const arr = (r && Array.isArray(r.entries)) ? r.entries
        : (r && r.data && Array.isArray(r.data.entries)) ? r.data.entries
        : [];
      // Newest first; cap at 12.
      const sorted = [...arr].sort((a, b) => {
        const ta = (a && a.ts) || "";
        const tb = (b && b.ts) || "";
        return tb.localeCompare(ta);
      });
      setEntries(sorted.slice(0, 12));
    })();
    return () => { cancelled = true; };
  }, [chainSlug, refreshKey]);

  if (missing) {
    return (
      <div style={{
        padding: "18px 24px",
        border: "1px dashed var(--rule-soft)",
        background: "transparent",
        fontSize: 12, fontStyle: "italic", color: "var(--ink-3)",
      }}>
        history 等 backend getLedger 接入后会列出最近 12 周的记账
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div style={{
        padding: "18px 24px",
        border: "1px solid var(--rule-soft)",
        background: "rgba(255,255,255,.25)",
        fontSize: 13, fontStyle: "italic", color: "var(--ink-3)",
        lineHeight: 1.55,
      }}>
        还没有记录 — 提交本周后会出现在这里。
      </div>
    );
  }

  return (
    <div style={{
      border: "1px solid var(--rule)",
      background: "rgba(255,255,255,.35)",
    }}>
      <div style={{
        padding: "12px 24px",
        borderBottom: "1px solid var(--rule)",
      }}>
        <div className="mono" style={{
          fontSize: 10.5, color: "var(--ink-3)",
          letterSpacing: ".14em", textTransform: "uppercase",
        }}>
          HISTORY — LAST {entries.length} WEEKS
        </div>
      </div>
      {entries.map((e, i) => {
        const ac = (e && e.axis_counts) || {};
        const parts = Object.entries(ac).map(([axis, n]) =>
          `${AXIS_LABEL[axis] || axis} ${n}${AXIS_UNIT_DEFAULT[axis] ? AXIS_UNIT_DEFAULT[axis] : ""}`
        );
        return (
          <div key={i} style={{
            padding: "14px 24px",
            borderBottom: i < entries.length - 1 ? "1px solid var(--rule-soft)" : "none",
          }}>
            <div className="row gap-12" style={{ alignItems: "baseline" }}>
              <span className="mono" style={{
                fontSize: 11, color: "var(--ink-3)", letterSpacing: ".06em",
                minWidth: 76,
              }}>
                {e.weekIso || "—"}
              </span>
              <span className="mono" style={{
                fontSize: 11, color: "var(--ink-2)", letterSpacing: ".04em",
              }}>
                {parts.length > 0 ? parts.join(" / ") : "—"}
              </span>
            </div>
            {e && e.note && (
              <div className="serif" style={{
                marginTop: 6,
                fontSize: 13.5, color: "var(--ink-2)", fontStyle: "italic",
                lineHeight: 1.55,
              }}>
                {e.note}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// LifetimeLedgerScreen — primary export
// ─────────────────────────────────────────────────────────────────────

const LifetimeLedgerScreen = ({ slug, chainSlug, archetype, onBack }) => {
  // Pull the chain plan so the link picker + targets are populated. Agent
  // A exposes `window.ptor.hypha.chainRead` (existing). If missing, the
  // form still renders with a single "无链上下文" option.
  const [chainData, setChainData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fn = window.ptor && window.ptor.hypha && window.ptor.hypha.chainRead;
        if (typeof fn !== "function") return;
        const r = await fn({ slug: chainSlug || slug });
        if (cancelled) return;
        const data = (r && (r.data || r.chain || r)) || null;
        setChainData(data);
      } catch (_) {
        // Quiet — chainRead is best-effort here; the form survives without.
      }
    })();
    return () => { cancelled = true; };
  }, [chainSlug, slug]);

  const links = useMemo(() => {
    if (!chainData) return [];
    if (Array.isArray(chainData.links)) return chainData.links;
    if (chainData.chain && Array.isArray(chainData.chain.links)) return chainData.chain.links;
    return [];
  }, [chainData]);

  const ultimateGoal = useMemo(() => {
    if (!chainData) return "";
    return chainData.ultimate_goal
      || (chainData.chain && chainData.chain.ultimate_goal)
      || "";
  }, [chainData]);

  const resolvedArchetype = useMemo(() => {
    if (archetype) return archetype;
    if (!chainData) return "HUMANITIES";
    return chainData.archetype
      || (chainData.chain && chainData.chain.archetype)
      || "HUMANITIES";
  }, [archetype, chainData]);

  // Active link — first one in state 'active' if Agent A surfaces state;
  // else fallback to link 0. linkIdx state is local so user can switch
  // freely while reading the dashboard.
  const defaultLinkIdx = useMemo(() => {
    if (!Array.isArray(links)) return 0;
    const ai = links.findIndex(l => l && l.state === "active");
    return ai >= 0 ? ai : 0;
  }, [links]);
  const [linkIdx, setLinkIdx] = useState(defaultLinkIdx);
  useEffect(() => { setLinkIdx(defaultLinkIdx); }, [defaultLinkIdx]);

  // Refresh key bumps after a successful weekly submit so Progress +
  // Variance + History all re-read.
  const [refreshKey, setRefreshKey] = useState(0);
  const onSubmitted = useCallback(() => {
    setRefreshKey(k => k + 1);
  }, []);

  return (
    <div className="fade-in" style={{
      minHeight: "100vh",
      padding: "48px 60px 96px",
      background: "var(--paper)",
      color: "var(--ink)",
      position: "relative",
      overflow: "hidden",
    }}>
      {/* Top banner */}
      <div className="col gap-12" style={{
        maxWidth: 920, margin: "0 auto 32px",
        position: "relative", zIndex: 2,
      }}>
        <div className="row gap-12" style={{ alignItems: "baseline" }}>
          <div className="eyebrow">LIFETIME · LEDGER</div>
          <div className="mono" style={{
            fontSize: 10.5, color: "var(--ink-3)", letterSpacing: ".12em",
          }}>
            {(chainSlug || slug) || "·"}
          </div>
          <span style={{ flex: 1 }} />
          {typeof onBack === "function" && (
            <button
              className="btn btn-ghost"
              onClick={onBack}
              style={{ fontSize: 12, padding: "6px 14px" }}>
              ← 返回
            </button>
          )}
        </div>

        <div className="t-h1 serif" style={{
          fontSize: 32, fontWeight: 400, lineHeight: 1.15,
          fontStyle: "italic",
        }}>
          {ultimateGoal || "你的目标"}
        </div>

        <div className="t-quote" style={{
          marginTop: 4, paddingTop: 10,
          borderTop: "1px solid var(--rule-soft)",
          maxWidth: 680,
        }}>
          每周写一次. 数字是真实投入, 不是计划. 这本账册比任何笔记都更诚实地告诉你: 这条慢路你走得怎样。
        </div>
      </div>

      {/* Form + dashboards */}
      <div className="col gap-20" style={{
        maxWidth: 920, margin: "0 auto",
        position: "relative", zIndex: 2,
      }}>
        <ThisWeekForm
          slug={slug}
          chainSlug={chainSlug || slug}
          archetype={resolvedArchetype}
          links={links}
          defaultLinkIdx={linkIdx}
          onSubmitted={onSubmitted}
        />

        <div className="row gap-20" style={{ alignItems: "stretch", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 360 }}>
            <AxisProgressBoard
              chainSlug={chainSlug || slug}
              linkIdx={linkIdx}
              link={links[linkIdx]}
              archetype={resolvedArchetype}
              refreshKey={refreshKey}
            />
          </div>
          <div style={{ flex: 1, minWidth: 360 }}>
            <VarianceDashboard
              chainSlug={chainSlug || slug}
              linkIdx={linkIdx}
              archetype={resolvedArchetype}
              refreshKey={refreshKey}
            />
          </div>
        </div>

        <HistoryList
          chainSlug={chainSlug || slug}
          refreshKey={refreshKey}
        />
      </div>
    </div>
  );
};

// Window-expose so app.jsx route 'lifetime' picks it up via the same
// typeof guard pattern the other design surfaces use.
if (typeof window !== "undefined") {
  window.LifetimeLedgerScreen = LifetimeLedgerScreen;
}
