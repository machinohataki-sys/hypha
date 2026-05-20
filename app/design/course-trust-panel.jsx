/* global React, Icon, Tooltip */
// HYPHA · Course Trust Panel (v0.2 Tranche 3, blueprint §24.2 + §25.2)
//
// Three-layer disclosure (default / 展开 / 专家). v0.2 ships default + 展开;
// 专家 layer with full Prosecutor charges + Judge rulings + Training Shard
// Map ships v0.5+ alongside Persona Coherence Ledger.
//
// Sits in lesson screen header right of the Provider Health badge (Phase E).
// Renders only when `harnessResult` is provided (post-pipeline run); silent
// otherwise. Click circle dot → expand inline panel. Click again → collapse.
//
// Color rules (per Manuscript register, NOT gamification — these are status):
//   verdict=PASS  → sage  (#789563)
//   verdict=WARN  → ochre (#c89c3e)
//   verdict=FAIL  → terracotta (var(--terracotta-2))
//
// `harnessResult` shape (from runFullPipeline):
//   { verdict, gap, persona, confession?, prosecuteJudge?, auditable, _meta }

const { useState, useEffect } = React;

const VERDICT_COLOR = {
  PASS: '#789563',
  WARN: '#c89c3e',
  FAIL: 'var(--terracotta-2)',
};

const VERDICT_LABEL = {
  PASS: '可信',
  WARN: '需审',
  FAIL: '存疑',
};

// Editorial label maps for A3 (3-dim Persona Coherence) + C3 (Goal Drift).
// Per Risk (e): keep numeric scores out of user-visible JSX; numbers stay in
// title= tooltips only. Score scales: persona dims = 0-100 (high = stronger);
// drift_score = 0-100 (high = drift / loss of anchor).
const _personaLabel = (n) => {
  if (typeof n !== 'number') return null;
  if (n >= 70) return '强';
  if (n >= 40) return '中';
  return '弱';
};
const _driftAnchorLabel = (n) => {
  if (typeof n !== 'number') return null;
  if (n < 30) return '强';
  if (n <= 60) return '中';
  return '漂';
};
const _contractLabel = (n) => (typeof n === 'number' && n >= 70 ? '匹配' : '偏离');

// v0.4.9 — chain feasibility tier zh display. Keep in sync with
// app/lib/feasibility.js tier enum.
const TIER_LABEL_MAP = {
  'nearly-impossible': '几乎不可能',
  'strained': '紧张',
  'moderate': '适中',
  'gentle': '宽松',
  'heroic': '英雄',
};
function tierLabel(t) { return TIER_LABEL_MAP[t] || t || '未知'; }

// v0.4.9 — chain ULTIMATE row. Renders at TOP of trust panel as ontology anchor:
// what this whole course chain is for + feasibility tier + archetype. Italic
// Garamond terracotta-2 register matches the manuscript voice. Silent null when
// chain absent or ultimate_goal missing.
function ChainUltimateRow({ chain }) {
  if (!chain || !chain.ultimate_goal) return null;
  const goal = chain.ultimate_goal;
  const truncated = goal.length > 80;
  const display = truncated ? goal.slice(0, 78) + '…' : goal;
  const labelSpan = (
    <span style={{
      fontFamily: 'EB Garamond, Noto Serif SC, serif',
      fontStyle: 'italic',
      fontSize: 14,
      color: 'var(--terracotta-2, #8B3A3A)',
      letterSpacing: '.01em',
      lineHeight: 1.4,
    }} title={goal}>
      ULTIMATE · {display}
    </span>
  );
  return (
    <div className="col" style={{
      marginBottom: 12,
      paddingBottom: 8,
      borderBottom: '1px solid var(--hair-3, rgba(180,160,130,0.2))',
    }}>
      {truncated && typeof Tooltip === 'function' ? (
        <Tooltip position="bottom" maxWidth={420} content={goal}>
          {labelSpan}
        </Tooltip>
      ) : labelSpan}
      {chain.feasibility && (
        <span className="mono" style={{
          fontSize: 10,
          color: 'var(--terracotta-1, #A66D2C)',
          marginTop: 3,
          letterSpacing: '.05em',
        }}>
          {tierLabel(chain.feasibility.tier)} · {chain.feasibility.hoursNeeded}h 需 / {chain.feasibility.hoursAvailable}h 有
          {chain.archetype ? ' · ' + chain.archetype : ''}
        </span>
      )}
    </div>
  );
}

// v0.5.0-bootstrap-3 — Pricing tier chip. Renders below the verdict header row
// when window.ptor.hypha.pricing.queryTier resolves. Mono small, terracotta-1
// for paid tiers (Founders/Pro/Basic), muted ink-3 for Free/BYOK.
//
// Display matrix (per loyalty-engine.js Pricing v3):
//   FOUNDERS · Y{floor(years_since)} · ¥{monthly_cny}/月
//   PRO · Y{floor(years_since)} · ¥{monthly_cny}/月
//   BASIC · ¥39/月
//   BYOK · ¥0 自带钥匙
//   FREE · 课金 ¥99/月起
const TIER_DISPLAY = {
  founders: '永久席位',
  pro: '正式',
  basic: '入门',
  byok: '自带钥匙',
  free: '免费',
};
function PricingTierChip({ tier }) {
  if (!tier) return null;
  const isPaid = tier.tier === 'founders' || tier.tier === 'pro' || tier.tier === 'basic';
  const isFree = tier.tier === 'free';
  const isByok = tier.tier === 'byok';
  const label = TIER_DISPLAY[tier.tier] || tier.tier;
  const years = (typeof tier.years_since === 'number')
    ? `Y${Math.floor(tier.years_since)} · ` : '';
  let priceLine;
  if (isFree) priceLine = '课金 ¥99/月起';
  else if (isByok) priceLine = '¥0 自带钥匙';
  else priceLine = `${years}¥${tier.monthly_cny}/月`;
  const color = isPaid ? 'var(--terracotta-1, #A66D2C)' : 'var(--ink-3, #7a6e58)';
  return (
    <div className="t-tiny mono" style={{
      marginTop: -4, marginBottom: 8,
      color, letterSpacing: '.06em', fontSize: 10,
    }} title={`pricing tier: ${tier.tier} · monthly ¥${tier.monthly_cny}${tier.years_since != null ? ' · years_since ' + tier.years_since.toFixed(2) : ''}`}>
      {label.toUpperCase()} · {priceLine}
    </div>
  );
}

// v1.0 boot-8 — daily budget chip. Renders directly under PricingTierChip.
// Display matrix:
//   unlimited (BYOK)      → "今日预算 · 自带钥匙 不限"
//   normal                → "今日预算 · ¥0.42 / ¥30 · 剩余 ¥29.58"
//   soft warn (≥ 80%)     → terracotta color + "(接近上限)"
function DailyBudgetChip({ budget }) {
  if (!budget) return null;
  let line;
  let color = 'var(--ink-3, #7a6e58)';
  if (budget.unlimited) {
    line = '今日预算 · 自带钥匙 不限';
  } else {
    const today = Number(budget.today || 0).toFixed(2);
    const limit = Number(budget.limit || 0).toFixed(0);
    const remaining = Number(budget.remaining || 0).toFixed(2);
    line = `今日预算 · ¥${today} / ¥${limit} · 剩余 ¥${remaining}`;
    if (budget.softWarn) {
      color = 'var(--terracotta-1, #A66D2C)';
      line = line + ' (接近上限)';
    }
  }
  return (
    <div className="t-tiny mono" style={{
      marginTop: -6, marginBottom: 8,
      color, letterSpacing: '.06em', fontSize: 10,
    }} title={`tier ${budget.tier} · today ¥${budget.today} · limit ${budget.unlimited ? '∞' : '¥' + budget.limit}`}>
      {line}
    </div>
  );
}

const CourseTrustPanel = ({ harnessResult, onDeepAuditRequested, slug, lessonIdx }) => {
  const [open, setOpen] = useState(false);
  const [driftAttempts, setDriftAttempts] = useState(null);
  // v0.4.9 — chain ULTIMATE ontology hydration. Source: window.ptor.hypha.chainGet(slug)
  // shipped in parallel by chain-team. Renders at TOP of panel as anchor context
  // before any per-lesson trust signals. Silent-fail if IPC absent or chain.ultimate_goal
  // missing (renders null).
  const [chainData, setChainData] = useState(null);
  // Machino-β8 (2026-05-15) — post-stream anti-slop signals fed by α8.
  // Primary: live 'anti-slop:scan-complete' IPC event (preload bridge).
  // Fallback: latest 'anti_slop_post_stream_scan' row in vault/<slug>/events.jsonl.
  // null = no signal seen yet (renders the "本节未跑诚实复审" note).
  const [antiSlopSignals, setAntiSlopSignals] = useState(null);
  const [antiSlopVerdict, setAntiSlopVerdict] = useState(null);
  // Machino-γ9 (2026-05-15) — archetype hydration. Source priority:
  //   (1) verdict.archetype_used (β9 field, freshest — set by PJR when archetype gate
  //       triggered or even when not, so PJR-aware sessions always carry it)
  //   (2) events.jsonl 'anti_slop_post_stream_scan' row .archetype (β9 will write)
  //   (3) null → renders as "(未声明)"
  // We hold a separate state so live verdict updates don't lose archetype when α8
  // emits a partial signals-only payload.
  const [archetype, setArchetype] = useState(null);
  const [forceRewriteCost, setForceRewriteCost] = useState(null);
  // v0.4.10 (2026-05-19) — Goal-edit history trace. Source = localStorage key
  // `editGoal_history_<slug>` written by screen-home.jsx handleEditGoal +
  // handleEditUltimate. Per-browser, capped at 10 entries upstream.
  const [goalHistory, setGoalHistory] = useState([]);
  const [goalHistoryOpen, setGoalHistoryOpen] = useState(false);
  useEffect(() => {
    if (!slug) { setGoalHistory([]); return; }
    try {
      const raw = localStorage.getItem(`editGoal_history_${slug}`);
      const arr = JSON.parse(raw || '[]');
      setGoalHistory(Array.isArray(arr) ? arr : []);
    } catch (_) { setGoalHistory([]); }
  }, [slug]);

  // v0.5.0-bootstrap-3 — Pricing tier chip. Sourced from window.ptor.hypha.pricing.queryTier()
  // which reads vault/data/profile.json. Silent-null when IPC absent. Mounted once per panel;
  // chip lives in the verdict header row (top-right of expanded card).
  const [pricingTier, setPricingTier] = useState(null);
  useEffect(() => {
    const fn = window.ptor && window.ptor.hypha && window.ptor.hypha.pricing
      && window.ptor.hypha.pricing.queryTier;
    if (typeof fn !== 'function') return undefined;
    let alive = true;
    (async () => {
      try {
        const r = await fn();
        if (!alive || !r || !r.ok) return;
        setPricingTier({
          tier: r.tier || 'free',
          monthly_cny: typeof r.monthly_cny === 'number' ? r.monthly_cny : 0,
          years_since: typeof r.years_since === 'number' ? r.years_since : null,
        });
      } catch (_) { /* queryTier IPC absent — silent */ }
    })();
    return () => { alive = false; };
  }, []);

  // v1.0 boot-8 — daily budget surface. Reads shield:check via the preload
  // bridge (window.ptor.shield.check). Shield reads tier from profile.json
  // server-side, so we pass null userId + null tier hint — shield resolves
  // both from the cache. Silent-null when bridge absent.
  const [dailyBudget, setDailyBudget] = useState(null);
  useEffect(() => {
    const fn = window.ptor && window.ptor.shield && window.ptor.shield.check;
    if (typeof fn !== 'function') return undefined;
    let alive = true;
    (async () => {
      try {
        const r = await fn('local', null);
        if (!alive || !r || !r.ok) return;
        setDailyBudget({
          today: typeof r.today_cost_cny === 'number' ? r.today_cost_cny : 0,
          limit: r.limit_cny,                 // null when unlimited (BYOK)
          remaining: r.remaining_cny,         // null when unlimited
          unlimited: r.unlimited === true,
          tier: r.tier || 'pro',
          softWarn: r.soft_warn === true,
        });
      } catch (_) { /* shield:check IPC absent — silent */ }
    })();
    return () => { alive = false; };
    // Re-poll when pricingTier changes (e.g. after Founders purchase) so the
    // panel reflects the new cap without page reload.
  }, [pricingTier && pricingTier.tier]);

  useEffect(() => {
    if (!slug) { setChainData(null); return undefined; }
    const fn = window.ptor && window.ptor.hypha && window.ptor.hypha.chainGet;
    if (typeof fn !== 'function') return undefined;
    let alive = true;
    (async () => {
      try {
        const r = await fn(slug);
        if (!alive || !r || !r.ok) return;
        if (r.chain && r.chain.ultimate_goal) setChainData(r.chain);
      } catch (_) { /* chainGet IPC absent — silent */ }
    })();
    return () => { alive = false; };
  }, [slug]);

  useEffect(() => {
    if (!slug) { setForceRewriteCost(null); return undefined; }
    const fn = window.ptor && window.ptor.antiSlop && window.ptor.antiSlop.costSummary;
    if (typeof fn !== 'function') return undefined;
    let alive = true;
    (async () => {
      try {
        const r = await fn(slug);
        if (!alive || !r || !r.ok) return;
        setForceRewriteCost({
          calls: r.calls || 0,
          totalCostCNY: r.totalCostCNY || 0,
        });
      } catch (_) { /* costSummary IPC absent — silent */ }
    })();
    return () => { alive = false; };
  }, [slug, antiSlopVerdict]);

  // W7.3 Citation System — % claims grounded coverage. Reads aggregate
  // across all lesson-N.body.json under slug (per-lesson view defers).
  const [citationCoverage, setCitationCoverage] = useState(null);
  useEffect(() => {
    if (!slug) { setCitationCoverage(null); return undefined; }
    const fn = window.ptor && window.ptor.citation && window.ptor.citation.verifyCoverage;
    if (typeof fn !== 'function') return undefined;
    let alive = true;
    (async () => {
      try {
        const r = await fn(slug);
        if (!alive || !r || !r.ok) return;
        setCitationCoverage({
          coverage_pct: typeof r.coverage_pct === 'number' ? r.coverage_pct : 0,
          total_claims: r.total_claims || 0,
          cited_count: r.cited_count || 0,
          sources: r.sources || 0,
          lessons: r.lessons || 0,
          gate_pass_count: r.gate_pass_count || 0,
          gate_fail_count: r.gate_fail_count || 0,
          threshold: typeof r.threshold === 'number' ? r.threshold : 60,
        });
      } catch (_) { /* verifyCoverage IPC absent — silent */ }
    })();
    return () => { alive = false; };
  }, [slug, lessonIdx, antiSlopVerdict]);

  const [conceptLedger, setConceptLedger] = useState(null);
  const [conceptDrift, setConceptDrift] = useState(null);
  const [conceptDriftOpen, setConceptDriftOpen] = useState(false);
  useEffect(() => {
    if (!slug) { setConceptLedger(null); setConceptDrift(null); return undefined; }
    const ledgerFn = window.ptor && window.ptor.antiSlop && window.ptor.antiSlop.conceptLedger;
    const driftFn  = window.ptor && window.ptor.antiSlop && window.ptor.antiSlop.conceptLedgerDetectDrift;
    const scoreFn  = window.ptor && window.ptor.antiSlop && window.ptor.antiSlop.conceptLedgerConsistencyScore;
    if (typeof ledgerFn !== 'function') return undefined;
    let alive = true;
    (async () => {
      try {
        const r = await ledgerFn(slug);
        if (!alive || !r || !r.ok || !r.ledger) return;
        setConceptLedger(r.ledger);
      } catch (_) { /* concept-ledger IPC absent — silent */ }
      // v0.4.14 boot-8 — drift + consistency layered on top of legacy ledger.
      try {
        const [d, s] = await Promise.all([
          (typeof driftFn === 'function') ? driftFn(slug) : Promise.resolve(null),
          (typeof scoreFn === 'function') ? scoreFn(slug) : Promise.resolve(null),
        ]);
        if (!alive) return;
        const drifts = (d && d.ok && Array.isArray(d.drifts)) ? d.drifts : [];
        const score  = (s && s.ok && typeof s.score === 'number') ? s.score : null;
        setConceptDrift({ drifts, score });
      } catch (_) { /* drift IPC absent — silent (legacy ledger row still renders) */ }
    })();
    return () => { alive = false; };
  }, [slug, antiSlopVerdict, lessonIdx]);

  const [exitRampStatus, setExitRampStatus] = useState(null);
  useEffect(() => {
    if (!slug) { setExitRampStatus(null); return undefined; }
    const fn = window.ptor && window.ptor.hypha && window.ptor.hypha.trackGetStatus;
    if (typeof fn !== 'function') return undefined;
    let alive = true;
    (async () => {
      try {
        const r = await fn(slug);
        if (!alive || !r || !r.ok || !r.status) return;
        setExitRampStatus(r.status);
      } catch (_) { /* trackGetStatus IPC absent — silent */ }
    })();
    return () => { alive = false; };
  }, [slug, antiSlopVerdict]);

  // v0.5.0-bootstrap — Track A/B Validation Mass (composite_score from
  // engagement signals). Source: window.ptor.track.validationMass(slug). Silent
  // null when IPC absent OR mass.composite_score === 0.
  const [validationMass, setValidationMass] = useState(null);
  useEffect(() => {
    if (!slug) { setValidationMass(null); return undefined; }
    const fn = window.ptor && window.ptor.track && window.ptor.track.validationMass;
    if (typeof fn !== 'function') return undefined;
    let alive = true;
    (async () => {
      try {
        const r = await fn(slug);
        if (!alive || !r || !r.ok || !r.mass) return;
        setValidationMass(r.mass);
      } catch (_) { /* validationMass IPC absent — silent */ }
    })();
    return () => { alive = false; };
  }, [slug, antiSlopVerdict]);

  // v0.5.0-bootstrap — Commons Pack count. Source: window.ptor.commons.listPacks().
  // Only renders when user has installed >= 1 pack.
  const [packCount, setPackCount] = useState(null);
  useEffect(() => {
    const fn = window.ptor && window.ptor.commons && window.ptor.commons.listPacks;
    if (typeof fn !== 'function') return undefined;
    let alive = true;
    (async () => {
      try {
        const r = await fn();
        if (!alive || !r || !r.ok) return;
        setPackCount(Array.isArray(r.packs) ? r.packs.length : 0);
      } catch (_) { /* listPacks IPC absent — silent */ }
    })();
    return () => { alive = false; };
  }, []);

  // v0.5.0-bootstrap — Knowledge Contamination Graph (Anti-Slop P2).
  // Quarantined lessons surface as terracotta warning row.
  const [contaminationGraph, setContaminationGraph] = useState(null);
  useEffect(() => {
    if (!slug) { setContaminationGraph(null); return undefined; }
    const fn = window.ptor && window.ptor.antiSlop && window.ptor.antiSlop.contaminationGraph;
    if (typeof fn !== 'function') return undefined;
    let alive = true;
    (async () => {
      try {
        const r = await fn(slug);
        if (!alive || !r || !r.ok || !r.graph) return;
        setContaminationGraph(r.graph);
      } catch (_) { /* contaminationGraph IPC absent — silent */ }
    })();
    return () => { alive = false; };
  }, [slug, antiSlopVerdict]);

  useEffect(() => {
    if (!slug || typeof lessonIdx !== 'number') { setDriftAttempts(null); return undefined; }
    const read = window.ptor && window.ptor.vault && window.ptor.vault.read;
    if (typeof read !== 'function') return undefined;
    let alive = true;
    (async () => {
      try {
        const txt = await read(`${slug}/lesson-${lessonIdx}.body.drift-warning.json`);
        if (!alive || !txt) return;
        const j = JSON.parse(txt);
        const n = (j && typeof j.attempts === 'number') ? j.attempts : null;
        setDriftAttempts(n);
      } catch (_) { /* sibling absent on drift-pass — silent */ }
    })();
    return () => { alive = false; };
  }, [slug, lessonIdx]);

  // Machino-β8 — anti-slop signal subscription + events.jsonl fallback.
  // Both paths run in parallel: live event wins when α8 emits; events.jsonl
  // tail catches the most recent post-stream scan when the panel mounts after
  // the scan has already happened (e.g. user reopens the lesson screen). The
  // event handler overwrites events.jsonl state when both fire, since live
  // signals are strictly fresher.
  useEffect(() => {
    if (!slug) { setAntiSlopSignals(null); setAntiSlopVerdict(null); setArchetype(null); return undefined; }
    let cancelled = false;

    // (A) Primary — live IPC event from α8's streamTurn finally block.
    let off = null;
    try {
      const ns = window.ptor && window.ptor.antiSlop;
      if (ns && typeof ns.onScanComplete === 'function') {
        off = ns.onScanComplete((_e, payload) => {
          if (cancelled || !payload || payload.slug !== slug) return;
          if (payload.signals) setAntiSlopSignals(payload.signals);
          if (payload.verdict) setAntiSlopVerdict(payload.verdict);
          // γ9 — archetype lives on verdict.archetype_used (β9 field) primarily,
          // else top-level payload.archetype (some α8 emitters carry it flat).
          const arch = (payload.verdict && payload.verdict.archetype_used)
            || payload.archetype
            || null;
          if (arch) setArchetype(arch);
        });
      }
    } catch (_) { /* live path absent — fall through to events.jsonl */ }

    // (B) Fallback — read vault/<slug>/events.jsonl, find the most recent
    // 'anti_slop_post_stream_scan' row (α8 writes this via _hyphaAppendEvent).
    // We do NOT poll: one read on slug change. Live event covers subsequent
    // turns.
    (async () => {
      try {
        const read = window.ptor && window.ptor.vault && window.ptor.vault.read;
        if (typeof read !== 'function') return;
        const txt = await read(`${slug}/events.jsonl`);
        if (cancelled || !txt) return;
        const lines = txt.split(/\r?\n/).filter(Boolean);
        let last = null;
        for (let i = lines.length - 1; i >= 0; i--) {
          let row;
          try { row = JSON.parse(lines[i]); } catch (_) { continue; }
          if (row && row.op === 'anti_slop_post_stream_scan') { last = row; break; }
        }
        if (!last) return;
        // α8 row shape (per task brief): { ts, op, slug, signals, verdict, has_rewrite, ... }
        // The signal payload may be flattened or nested — handle both.
        const signals = last.signals || {
          citations:  last.citations  || null,
          pedagogy:   last.pedagogy   || null,
          confidence: last.confidence || null,
          illusion:   last.illusion   || null,
        };
        if (!cancelled) {
          setAntiSlopSignals(s => s || signals);
          setAntiSlopVerdict(v => v || (last.verdict || null));
          // γ9 — archetype from events.jsonl row; β9 will write it as either
          // a top-level field or under verdict.archetype_used.
          const archRow = (last.verdict && last.verdict.archetype_used)
            || last.archetype
            || null;
          if (archRow) setArchetype(a => a || archRow);
        }
      } catch (_) { /* events.jsonl absent — silent */ }
    })();

    return () => {
      cancelled = true;
      if (off) { try { off(); } catch (_) {} }
    };
  }, [slug, lessonIdx]);

  // MEOW R5 fix — 当 harnessResult 缺 (trustStackPerTurn flag 未开) 但 anti-slop
  // detector 已经在 streamTurn 跑完 + 写了 signals 时, 仍然渲染一个简化版 dot
  // 只显示诚实复审。否则 4 detector 真接入但 UI 永远不出, 等于 R4 的 backend
  // 孤岛换了形态: detector → IPC ✓ / IPC → state ✓ / state → 屏幕 ✗。
  if (!harnessResult || typeof harnessResult !== 'object') {
    if (!antiSlopSignals) return null;
    return (
      <div style={{ position: 'relative', marginRight: 14, lineHeight: 0 }}
           onClick={() => setOpen(o => !o)}
           title="诚实复审 (Course Trust not evaluated this run)">
        <div style={{
          width: 9, height: 9, borderRadius: '50%',
          background: 'var(--accent-tabac, #5C4E36)',
          boxShadow: '0 0 0 1.5px rgba(255,255,255,.7)', cursor: 'default',
        }} />
        {open && (
          <div className="card-quiet" style={{
            position: 'absolute', top: 18, right: -4, padding: '14px 18px',
            fontSize: 12, minWidth: 320, maxWidth: 420, zIndex: 10, lineHeight: 1.5,
          }}>
            <div className="t-small mono" style={{
              color: 'var(--ink-3)', letterSpacing: '.06em', marginBottom: 8,
            }}>
              诚实复审 · lite
            </div>
            <AntiSlopExpert signals={antiSlopSignals} verdict={antiSlopVerdict} archetype={archetype} />
          </div>
        )}
      </div>
    );
  }

  const verdict = harnessResult.verdict || 'WARN';
  const dotColor = VERDICT_COLOR[verdict] || VERDICT_COLOR.WARN;
  const verdictLabel = VERDICT_LABEL[verdict] || verdict;

  const gap = harnessResult.gap || {};
  const persona = harnessResult.persona || {};
  const confession = (harnessResult.confession && harnessResult.confession.confession) || null;
  const auditable = harnessResult.auditable || {};
  const isDeepRun = !!harnessResult.prosecuteJudge;

  return (
    <div style={{ position: 'relative', marginRight: 14, lineHeight: 0 }}
         onClick={() => setOpen(o => !o)}
         title={`Course Trust: ${verdictLabel} · gap ${gap.gap_pct || 0}% · persona ${persona.score || 0}`}>
      <div style={{
        width: 9, height: 9, borderRadius: '50%', background: dotColor,
        boxShadow: '0 0 0 1.5px rgba(255,255,255,.7)', cursor: 'default',
      }} />
      {open && (
        <div className="card-quiet" style={{
          position: 'absolute', top: 18, right: -4, padding: '14px 18px',
          fontSize: 12, minWidth: 320, maxWidth: 420, zIndex: 10,
          lineHeight: 1.5,
        }}>
          {/* v0.4.9 — chain ULTIMATE ontology row, rendered FIRST so reader sees
              the top-level goal before any per-lesson trust signals. */}
          <ChainUltimateRow chain={chainData} />

          {goalHistory.length > 0 && (
            <GoalHistorySection
              entries={goalHistory}
              open={goalHistoryOpen}
              onToggle={(e) => { e.stopPropagation(); setGoalHistoryOpen(o => !o); }}
            />
          )}

          <div className="t-small mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em', marginBottom: 8 }}>
            course trust
          </div>

          {/* Header row: verdict pill + agent name + pricing tier chip (v0.5.0-bootstrap-3) */}
          <div className="row gap-8" style={{ alignItems: 'baseline', marginBottom: 10 }}>
            <span className="serif italic" style={{ fontSize: 18, color: 'var(--ink)' }}>
              {verdictLabel}
            </span>
            <span style={{
              padding: '1px 8px', borderRadius: 999,
              background: dotColor, color: '#fff', fontSize: 10,
              letterSpacing: '.1em', textTransform: 'uppercase',
            }}>{verdict}</span>
            <span className="spacer" />
            <span className="t-tiny mono" style={{ color: 'var(--ink-3)' }}>
              {harnessResult._meta?.preset || 'lite'} · {harnessResult._meta?.elapsed_ms ? Math.round(harnessResult._meta.elapsed_ms / 1000) + 's' : '?'}
            </span>
          </div>

          {pricingTier && (
            <PricingTierChip tier={pricingTier} />
          )}
          {dailyBudget && (
            <DailyBudgetChip budget={dailyBudget} />
          )}

          {/* Three-row default tier: gap / persona / confession headline */}
          <div className="col gap-6" style={{ marginBottom: 10 }}>
            <Row label="证据缺口" value={`${gap.gap_pct || 0}%`}
                 hint={`${gap.apparent_completion || 0} apparent / ${gap.verified_completion || 0} verified`} />
            <Row label="人格一致性" value={String(persona.score || 0)}
                 hint={persona.dims ? `诚实 ${persona.dims.failure_honesty} / 反讨好 ${persona.dims.anti_ingratiation} / 契约 ${persona.dims.contract_alignment}` : '—'} />
            {confession && confession.weakest_link && (
              <Row label="自报薄弱" value={confession.weakest_link.ref}
                   hint={(confession.weakest_link.why || '').slice(0, 80)} />
            )}
          </div>

          {forceRewriteCost && forceRewriteCost.calls > 0 && (
            <div
              className="t-tiny mono"
              style={{
                marginTop: 4, marginBottom: 8,
                color: 'var(--terracotta-2, #8B3A3A)',
                fontSize: 10, letterSpacing: '.04em',
              }}
              title="累计强制改写次数与估算成本 — 来自 antiSlop.costSummary"
            >
              强制改写 · 本课 {forceRewriteCost.calls} 次 · ~¥{forceRewriteCost.totalCostCNY.toFixed(2)}
            </div>
          )}

          {conceptLedger && conceptLedger.totalUniqueConcepts > 0 && (() => {
            const drifts = (conceptDrift && Array.isArray(conceptDrift.drifts)) ? conceptDrift.drifts : [];
            const score  = (conceptDrift && typeof conceptDrift.score === 'number') ? conceptDrift.score : null;
            const consistencyPct = score === null ? null : Math.round(score * 100);
            const driftColor = drifts.length === 0
              ? 'var(--ink-3)'
              : 'var(--terracotta-2, #8B3A3A)';
            return (
              <div style={{ marginTop: 6 }}>
                <div className="t-tiny" style={{
                  color: driftColor,
                  fontFamily: 'EB Garamond, Noto Serif SC, serif',
                  fontStyle: 'italic',
                  fontSize: 11,
                  lineHeight: 1.45,
                  cursor: drifts.length > 0 ? 'pointer' : 'default',
                }}
                onClick={() => { if (drifts.length > 0) setConceptDriftOpen(o => !o); }}
                title={(() => {
                  const reuse = conceptLedger.crossLessonReuse || [];
                  const lines = [];
                  if (consistencyPct !== null) lines.push(`一致性 ${consistencyPct}% — ${drifts.length} 漂移概念 / ${reuse.length} 复用概念`);
                  if (reuse.length === 0) lines.push('本课所有概念仅在单 lesson 中出现, 无 cross-lesson 复用.');
                  else {
                    lines.push(`Cross-lesson 复用概念 (Top ${Math.min(8, reuse.length)}):`);
                    reuse.slice(0, 8).forEach(r => lines.push(`• ${r.term} → 出现于 lesson-${r.lessons.join(', lesson-')}`));
                  }
                  if (drifts.length > 0) lines.push(`(点击展开 ${drifts.length} 条漂移定义)`);
                  return lines.join('\n');
                })()}>
                  概念
                  {consistencyPct !== null ? ` · ${consistencyPct}% 一致` : ' 一致'}
                  {` · ${conceptLedger.totalUniqueConcepts} 概念 跨 ${conceptLedger.totalLessons} 课`}
                  {conceptLedger.crossLessonReuse && conceptLedger.crossLessonReuse.length > 0 && (
                    <span style={{
                      marginLeft: 6,
                      color: 'var(--terracotta-1, #A66D2C)',
                      fontStyle: 'normal',
                      fontFamily: 'inherit',
                    }}>
                      · {conceptLedger.crossLessonReuse.length} 跨课复用
                    </span>
                  )}
                  {drifts.length > 0 && (
                    <span style={{
                      marginLeft: 6,
                      color: 'var(--terracotta-2, #8B3A3A)',
                      fontStyle: 'normal',
                      fontFamily: 'inherit',
                    }}>
                      · {drifts.length} 漂移
                    </span>
                  )}
                </div>
                {conceptDriftOpen && drifts.length > 0 && (
                  <div style={{
                    marginTop: 6,
                    paddingLeft: 10,
                    borderLeft: '1px solid var(--terracotta-1, #A66D2C)',
                    fontFamily: 'EB Garamond, Noto Serif SC, serif',
                    fontSize: 11,
                    color: 'var(--ink-3)',
                    lineHeight: 1.55,
                  }}>
                    {drifts.slice(0, 6).map((d, i) => (
                      <div key={`drift-${i}`} style={{ marginBottom: 6 }}>
                        <span style={{ fontWeight: 600, color: 'var(--ink-2)' }}>{d.concept}</span>
                        <span style={{ marginLeft: 6, color: 'var(--ink-4)', fontStyle: 'italic' }}>
                          · {d.drift_kind === 'rename' ? '改名' : d.drift_kind === 'narrow' ? '收窄' : d.drift_kind === 'expand' ? '扩张' : '重定义'}
                        </span>
                        <div style={{ marginTop: 2, color: 'var(--ink-4)' }}>
                          {(d.lessons || []).slice(0, 2).map((l, j) => (
                            <div key={`drift-${i}-${j}`} style={{ marginTop: 2 }}>
                              <span style={{ color: 'var(--ink-4)' }}>lesson-{l.idx}: </span>
                              <span style={{ fontStyle: 'italic' }}>{(l.definition || '').slice(0, 120)}{(l.definition || '').length > 120 ? '…' : ''}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    {drifts.length > 6 && (
                      <div style={{ color: 'var(--ink-4)', fontStyle: 'italic' }}>
                        + 余 {drifts.length - 6} 条
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {citationCoverage && citationCoverage.total_claims > 0 && (
            <div className="t-tiny" style={{
              marginTop: 6,
              color: citationCoverage.coverage_pct >= citationCoverage.threshold
                ? 'var(--ink-3)'
                : 'var(--terracotta-2, #8B3A3A)',
              fontFamily: 'EB Garamond, Noto Serif SC, serif',
              fontStyle: 'italic',
              fontSize: 11,
              lineHeight: 1.45,
            }} title={(() => {
              const lines = [
                `${citationCoverage.cited_count} 处引用 / ${citationCoverage.total_claims} claim`,
                `阈值 ${citationCoverage.threshold}% — ${citationCoverage.coverage_pct >= citationCoverage.threshold ? '通过' : '未达'}`,
              ];
              if (citationCoverage.lessons > 1) {
                lines.push(`课程范围: ${citationCoverage.lessons} 课 · 通过 ${citationCoverage.gate_pass_count} / 未达 ${citationCoverage.gate_fail_count}`);
              }
              return lines.join('\n');
            })()}>
              CITATIONS · {citationCoverage.coverage_pct}% claims grounded · {citationCoverage.sources} sources
              {citationCoverage.coverage_pct < citationCoverage.threshold && (
                <span style={{
                  marginLeft: 6,
                  fontStyle: 'normal',
                  fontFamily: 'inherit',
                  letterSpacing: '.04em',
                }}>
                  · 低于 {citationCoverage.threshold}% 阈值
                </span>
              )}
            </div>
          )}

          {exitRampStatus && exitRampStatus.totalRamps > 0 && (
            <div className="t-tiny" style={{
              marginTop: 6,
              color: 'var(--ink-3)',
              fontFamily: 'EB Garamond, Noto Serif SC, serif',
              fontStyle: 'italic',
              fontSize: 11,
              lineHeight: 1.45,
            }} title={(() => {
              const lines = [];
              if (exitRampStatus.lastRampAt) lines.push(`最近 ramp: ${new Date(exitRampStatus.lastRampAt).toLocaleString()}`);
              const recent = (exitRampStatus.entries || []).slice(-5).reverse();
              for (const e of recent) {
                const urlBit = e.artifactUrl ? ` · ${e.artifactUrl}` : '';
                const noteBit = e.commitmentNote ? ` · "${e.commitmentNote}"` : '';
                lines.push(`lesson-${e.lessonIdx} · Track ${e.track}${urlBit}${noteBit}`);
              }
              return lines.join('\n') || '尚无 exit-ramp 记录';
            })()}>
              Exit Ramp · {exitRampStatus.trackACount} 作品化 / {exitRampStatus.trackBCount} 讲给真人 / {exitRampStatus.skipCount} 私学
              {exitRampStatus.trackACount + exitRampStatus.trackBCount > 0 && (
                <span style={{
                  marginLeft: 6,
                  color: 'var(--terracotta-1, #A66D2C)',
                  fontStyle: 'normal',
                  fontFamily: 'inherit',
                }}>
                  · External signal: {exitRampStatus.trackACount + exitRampStatus.trackBCount}/{exitRampStatus.totalRamps}
                </span>
              )}
            </div>
          )}

          {validationMass && validationMass.composite_score > 0 && (
            <div className="t-tiny" style={{
              marginTop: 6,
              color: 'var(--ink-3)',
              fontFamily: 'EB Garamond, Noto Serif SC, serif',
              fontStyle: 'italic',
              fontSize: 11,
            }} title={`comments ${validationMass.comments || 0} × 10 + shares ${validationMass.shares || 0} × 5 + reactions ${validationMass.reactions || 0} × 3 + views ${validationMass.views || 0} × 1`}>
              Validation Mass · {validationMass.composite_score} 分
              <span style={{ marginLeft: 6, color: 'var(--terracotta-1, #A66D2C)', fontStyle: 'normal', fontFamily: 'inherit' }}>
                · {validationMass.entry_count || 0} Track A/B
              </span>
            </div>
          )}

          {packCount !== null && packCount > 0 && (
            <div className="t-tiny" style={{
              marginTop: 6,
              color: 'var(--ink-3)',
              fontFamily: 'EB Garamond, Noto Serif SC, serif',
              fontStyle: 'italic',
              fontSize: 11,
            }}>
              Commons · {packCount} 个 Pack 已装
            </div>
          )}

          {contaminationGraph && (contaminationGraph.quarantined_lessons || []).length > 0 && (
            <div className="t-tiny" style={{
              marginTop: 6,
              color: 'var(--terracotta-2, #8B3A3A)',
              fontFamily: 'EB Garamond, Noto Serif SC, serif',
              fontStyle: 'italic',
              fontSize: 11,
            }} title={contaminationGraph.quarantined_lessons.map(q => `lesson-${q.lesson_idx}: ${q.reason}`).join('\n')}>
              ⚠ Knowledge Contamination · {contaminationGraph.quarantined_lessons.length} lesson quarantined
            </div>
          )}

          {/* A3 — 3-dim Persona Coherence editorial line. Renders body-level
              snapshot from harnessResult.persona.dims (the data the harness
              already produces per pipeline run, scale 0-100 per
              coherence-score.js).
              intentional-placeholder: per-turn live tick (vs per-body) is
              Machino-B's Day-5 wire and depends on an `coherence:current(
              slug, lessonIdx)` IPC that does not yet exist on preload.js.
              When that IPC lands, swap this static read for a useEffect
              subscription. Cross-group dependency, not self-laziness. */}
          {persona.dims && (
            <CoherenceLine
              dims={persona.dims}
              ingratiationCount={persona.ingratiation_violation_count}
            />
          )}

          {/* C3 — Drift anchor editorial line. drift_score lives on
              harnessResult.auditable.structured.drift_score (0-100, high =
              drift) and is computed by app/lib/goal-drift-detector.js.
              intentional-placeholder: the "(已尝试改写 N 次)" attempt-count
              suffix from vault/<slug>/lesson-N.body.drift-warning.json is
              omitted at v0.2 because slug + lessonIdx are not in this
              panel's prop surface. Adding them is an integration-pass change
              owned by Machino-B (panel call site lives in
              screen-lesson-chat.jsx, outside this file's strict ownership).
              Cross-group dependency, not self-laziness. */}
          {auditable.structured && typeof auditable.structured.drift_score === 'number' && (
            <DriftLine driftScore={auditable.structured.drift_score} attempts={driftAttempts} />
          )}

          {/* v0.4.6 (2026-05-19) — Gate-suppressed line. When PJR computed
              verdict.gated_by_archetype === true, the rewrite was technically
              warranted but blocked by ARCHETYPE_GATE. User has no other signal
              this happened — surface here so they can see why anti-slop didn't
              fire (and request manual rewrite once that IPC ships v0.5). */}
          {antiSlopVerdict && antiSlopVerdict.gated_by_archetype === true && (
            <GateSuppressedLine archetype={archetype} slug={slug} lessonIdx={lessonIdx} />
          )}

          {/* Expand layer: auditable summary excerpt */}
          {auditable.markdown && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'default', color: 'var(--ink-2)', fontSize: 11 }}>
                展开审计摘要
              </summary>
              <pre style={{
                fontSize: 11, color: 'var(--ink-2)', lineHeight: 1.5,
                whiteSpace: 'pre-wrap', maxHeight: 240, overflowY: 'auto',
                marginTop: 8, padding: 8,
                background: 'rgba(255,251,243,.5)',
                border: '0.5px solid var(--rule-soft)',
                borderRadius: 6,
              }}>{auditable.markdown}</pre>
            </details>
          )}

          {/* Machino-β8 — Expert tier: 3 post-stream detector signals (citations
              / pedagogy / confidence). Surfaces R4's 3 backend islands so the
              user sees fire signals on their own course. Renders nothing
              destructive: pure read of antiSlopSignals (live event) or the
              latest events.jsonl scan row. */}
          <AntiSlopExpert signals={antiSlopSignals} verdict={antiSlopVerdict} archetype={archetype} />


          {/* Deep-audit CTA (only show on lite runs) */}
          {!isDeepRun && onDeepAuditRequested && (
            <div className="row" style={{ marginTop: 10, alignItems: 'center', gap: 8 }}>
              <button
                className="btn btn-quiet"
                style={{ fontSize: 11 }}
                onClick={(e) => { e.stopPropagation(); onDeepAuditRequested(); setOpen(false); }}
              >
                深度审查 (~80s)
              </button>
              <span className="t-tiny" style={{ color: 'var(--ink-3)' }}>
                Prosecutor / Judge / Rewriter
              </span>
            </div>
          )}

          {/* Deep-run badges */}
          {isDeepRun && harnessResult.prosecuteJudge && harnessResult.prosecuteJudge.summary && (
            <div className="t-tiny mono" style={{ marginTop: 10, color: 'var(--ink-3)' }}>
              charges {harnessResult.prosecuteJudge.summary.charges_filed} ·
              upheld {harnessResult.prosecuteJudge.summary.upheld} ·
              dismissed {harnessResult.prosecuteJudge.summary.dismissed} ·
              rewrote {harnessResult.prosecuteJudge.summary.rewritten_refs?.length || 0}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const Row = ({ label, value, hint }) => (
  <div className="row gap-8" style={{ alignItems: 'baseline' }}>
    <span style={{ color: 'var(--ink-3)', minWidth: 72 }}>{label}</span>
    <span className="serif" style={{ fontSize: 14, color: 'var(--ink)', minWidth: 50 }}>{value}</span>
    <span className="t-tiny" style={{ color: 'var(--ink-3)', flex: 1 }}>{hint}</span>
  </div>
);

// v0.4.6 (2026-05-19) — Anti-slop rewrite gate-suppressed editorial line.
// v0.4.9 wired to real `anti-slop:force-rewrite` IPC (was alert stub).
// Renders when PJR computed verdict.gated_by_archetype === true (per
// prosecute-judge-rewrite.js:557). Tells user: signals fired, rewrite was
// epistemically warranted, but archetype register policy blocked the
// prose-quality rewrite paths (citation/pedagogy axes). Epistemic axes
// (confidence/illusion) get rewritten regardless per v0.4.4 per-axis split.
const GateSuppressedLine = ({ archetype, slug, lessonIdx }) => {
  const arch = archetype || 'register';
  const [inFlight, setInFlight] = useState(false);
  const handleClick = async (e) => {
    e.preventDefault();
    if (inFlight) return;
    if (!slug || !Number.isFinite(lessonIdx)) {
      try { window.alert('上下文缺 slug / lessonIdx — 无法定位 body'); } catch (_) {}
      return;
    }
    // Cost-shield (v0.5 plan unwired) — simple confirm() instead.
    try {
      if (typeof window !== 'undefined' && window.confirm && !window.confirm(
        '强制改写本节 body? 跳过 HUMANITIES register gate, 调 PJR 流水线 (T6_STRONG, ~¥0.5/call, 约 1 分钟).'
      )) return;
    } catch (_) { /* if confirm blocked, proceed defensively */ }
    setInFlight(true);
    try {
      const bridge = window.ptor && window.ptor.antiSlop;
      const fn = bridge && bridge.forceRewrite;
      if (typeof fn !== 'function') {
        try { window.alert('forceRewrite IPC 桥缺 — 需重启 Electron 加载 preload'); } catch (_) {}
        setInFlight(false);
        return;
      }
      const r = await fn(slug, lessonIdx);
      if (r && r.ok && r.wrote) {
        try { window.alert('强制改写完成 · 已写回 body.json · 重开本课刷新查看'); } catch (_) {}
      } else {
        const reason = (r && (r.error || r.message)) || 'unknown';
        try { window.alert('强制改写失败: ' + reason); } catch (_) {}
      }
    } catch (err) {
      try { window.alert('强制改写异常: ' + ((err && err.message) || err)); } catch (_) {}
    } finally {
      setInFlight(false);
    }
  };
  return (
    <div className="row gap-8" style={{ alignItems: 'baseline', marginTop: 6 }}>
      <span style={{ color: 'var(--terracotta-1, #A66D2C)', minWidth: 72 }}>复审策略</span>
      <span className="serif italic" style={{ fontSize: 13, color: 'var(--terracotta-2, #8B3A3A)', minWidth: 50 }}>
        部分跳过
      </span>
      <span
        className="t-tiny"
        style={{ color: 'var(--ink-3)', flex: 1, lineHeight: 1.5 }}
        title={'HUMANITIES (人文/历史/哲学) 课程的语调与论证密度需要保留作者立场, 避免被 anti-slop pipeline 改成中性百科腔. 所以仅 epistemic 检测 ("是否瞎编引用 / 是否信心过度") 触发改写, prose-quality 检测 ("是否教学清晰 / 是否引文充分") 故意保留 — 因为这两个 axis 的"修复"对人文文本是负价值. 点击下方按钮可强制改写全部 axis (含 prose-quality), 但请确认这是你想要的.'}
      >
        鉴于 {arch} register · epistemic 轴 (confidence / illusion) 已强制改; prose-quality 轴 (citation / pedagogy) 故意保留
        {typeof Tooltip === 'function' ? (
          <Tooltip
            position="top"
            maxWidth={320}
            content={'HUMANITIES (人文/历史/哲学) 课程的语调与论证密度需要保留作者立场, 避免被 anti-slop pipeline 改成中性百科腔. 所以仅 epistemic 检测 ("是否瞎编引用 / 是否信心过度") 触发改写, prose-quality 检测 ("是否教学清晰 / 是否引文充分") 故意保留 — 因为这两个 axis 的"修复"对人文文本是负价值. 点击下方按钮可强制改写全部 axis (含 prose-quality), 但请确认这是你想要的.'}
          >
            <span
              style={{
                display: 'inline-block', marginLeft: 5,
                fontSize: 10, color: 'var(--terracotta-1, #A66D2C)',
                cursor: 'help', verticalAlign: 'baseline',
              }}
              title={'HUMANITIES (人文/历史/哲学) 课程的语调与论证密度需要保留作者立场, 避免被 anti-slop pipeline 改成中性百科腔. 所以仅 epistemic 检测 ("是否瞎编引用 / 是否信心过度") 触发改写, prose-quality 检测 ("是否教学清晰 / 是否引文充分") 故意保留 — 因为这两个 axis 的"修复"对人文文本是负价值. 点击下方按钮可强制改写全部 axis (含 prose-quality), 但请确认这是你想要的.'}
            >ⓘ</span>
          </Tooltip>
        ) : (
          <span
            style={{
              display: 'inline-block', marginLeft: 5,
              fontSize: 10, color: 'var(--terracotta-1, #A66D2C)',
              cursor: 'help', verticalAlign: 'baseline',
            }}
            title={'HUMANITIES (人文/历史/哲学) 课程的语调与论证密度需要保留作者立场, 避免被 anti-slop pipeline 改成中性百科腔. 所以仅 epistemic 检测 ("是否瞎编引用 / 是否信心过度") 触发改写, prose-quality 检测 ("是否教学清晰 / 是否引文充分") 故意保留 — 因为这两个 axis 的"修复"对人文文本是负价值. 点击下方按钮可强制改写全部 axis (含 prose-quality), 但请确认这是你想要的.'}
          >ⓘ</span>
        )}
        <button
          onClick={handleClick}
          disabled={inFlight}
          className="btn btn-quiet"
          style={{ fontSize: 10, marginLeft: 10, padding: '1px 8px', opacity: inFlight ? 0.4 : 0.85 }}
          title="跳 HUMANITIES register gate · 调 PJR pipeline · ¥0.5/call"
        >
          {inFlight ? '改写中...' : '请求强制改写'}
        </button>
      </span>
    </div>
  );
};

// CoherenceLine (A3) — single editorial line, no numeric scores in user
// text. Honesty + contract get 强/中/弱 / 匹配/偏离 labels; ingratiation gets
// "0次" / "N次" plain count (the count itself is not a score, it is a
// quantity — per copy guidance the count is acceptable). Numeric debug data
// surfaces only on hover via title=.
const CoherenceLine = ({ dims, ingratiationCount }) => {
  if (!dims || typeof dims !== 'object') return null;
  const honesty = _personaLabel(dims.failure_honesty);
  const contract = _contractLabel(dims.contract_alignment);
  const ingrCount = typeof ingratiationCount === 'number'
    ? ingratiationCount
    : (typeof dims.anti_ingratiation === 'number'
        ? Math.max(0, Math.round((100 - dims.anti_ingratiation) / 10))
        : null);
  const ingrText = ingrCount === null ? '—' : `${ingrCount}次`;
  if (honesty === null && contract === null && ingrCount === null) return null;
  const tooltip = `failure_honesty=${dims.failure_honesty} · anti_ingratiation=${dims.anti_ingratiation} · contract_alignment=${dims.contract_alignment}`;
  return (
    <div className="t-tiny" style={{ marginTop: 8, color: 'var(--ink-3)', lineHeight: 1.5 }} title={tooltip}>
      <span style={{ color: 'var(--ink-2)' }}>本节连贯</span>
      <span> · 失误诚实 </span>
      <span style={{ color: 'var(--ink)' }}>{honesty || '—'}</span>
      <span> · 反讨好 </span>
      <span style={{ color: 'var(--ink)' }}>{ingrText}</span>
      <span> · 契约 </span>
      <span style={{ color: 'var(--ink)' }}>{contract || '—'}</span>
    </div>
  );
};

// DriftLine (C3) — single editorial line, no numeric scores in user text.
// Maps drift_score 0-100 to anchor strength label (strong = anchored,
// drifting = lost goal). Numeric stays in title= tooltip only.
const DriftLine = ({ driftScore, attempts }) => {
  if (typeof driftScore !== 'number') return null;
  const anchor = _driftAnchorLabel(driftScore);
  const driftCount = driftScore > 60 ? Math.round((driftScore - 60) / 10) : 0;
  const attemptsSuffix = (typeof attempts === 'number' && attempts > 0)
    ? `（已尝试改写 ${attempts} 次）`
    : '';
  return (
    <div
      className="t-tiny"
      style={{ marginTop: 4, color: 'var(--ink-3)', lineHeight: 1.5 }}
      title={`drift_score=${driftScore} (0-100, high = drift)`}
    >
      <span style={{ color: 'var(--ink-2)' }}>本节锚定</span>
      <span> · 主题 </span>
      <span style={{ color: 'var(--ink)' }}>{anchor || '—'}</span>
      <span> · 漂移 </span>
      <span style={{ color: 'var(--ink)' }}>{driftCount}次</span>
      {attemptsSuffix && <span style={{ color: 'var(--ink-3)' }}>{attemptsSuffix}</span>}
    </div>
  );
};

// v0.4.10 (2026-05-19) — Goal-edit history trace. Reads
// `editGoal_history_<slug>` from localStorage (written by screen-home.jsx).
// Collapsed accordion by default; expanded shows ts + type + truncated
// old→new. Editorial small register, terracotta-1, mono timestamps.
const GoalHistorySection = ({ entries, open, onToggle }) => {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const trim = (s) => {
    const t = (s == null ? '' : String(s)).trim();
    return t.length > 36 ? t.slice(0, 34) + '…' : t;
  };
  const fmtTs = (iso) => {
    try {
      const d = new Date(iso);
      if (!Number.isFinite(d.getTime())) return iso;
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch (_) { return iso; }
  };
  const typeLabel = (t) => t === 'ultimate' ? 'ULTIMATE' : t === 'north_star' ? '北极星' : (t || '—');
  const ordered = entries.slice().reverse();
  return (
    <div style={{
      marginBottom: 12,
      paddingBottom: 8,
      borderBottom: '1px solid var(--hair-3, rgba(180,160,130,0.2))',
    }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          background: 'transparent', border: 'none', padding: 0,
          fontFamily: 'EB Garamond, Noto Serif SC, serif',
          fontStyle: 'italic',
          fontSize: 11.5,
          color: 'var(--terracotta-1, #A66D2C)',
          letterSpacing: '.04em',
          cursor: 'pointer',
        }}
        title="本地保留最近 10 次目标修改"
      >
        目标修改记录 · {entries.length} 次 {open ? '·收' : '·展'}
      </button>
      {open && (
        <div className="col" style={{ marginTop: 8, gap: 6 }}>
          {ordered.map((e, i) => (
            <div key={i} className="col" style={{ gap: 2 }}>
              <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                <span className="mono" style={{
                  fontSize: 10,
                  color: 'var(--terracotta-1, #A66D2C)',
                  letterSpacing: '.04em',
                }}>{fmtTs(e.ts)}</span>
                <span className="mono" style={{
                  fontSize: 9.5,
                  color: 'var(--ink-3)',
                  letterSpacing: '.06em',
                }}>· {typeLabel(e.type)}</span>
              </div>
              <div style={{
                fontFamily: 'EB Garamond, Noto Serif SC, serif',
                fontStyle: 'italic',
                fontSize: 11.5,
                color: 'var(--ink-2)',
                lineHeight: 1.4,
                paddingLeft: 4,
              }} title={`旧: ${e.oldGoal || ''}\n新: ${e.newGoal || ''}`}>
                {trim(e.oldGoal) || '（空）'} → {trim(e.newGoal) || '（空）'}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// Machino-β8 — Anti-Slop Expert tier. Renders 3 fire-signal rows from the
// post-stream detector sweep that α8 runs in streamTurn's finally block.
// Manuscript register: italic EB Garamond head + roman body, oxblood markers
// when fire, tabac when at rest. No emoji / no exclamations / no 流量词.
//
// Signal shape (per α8 spec):
//   signals.citations  = { total, verified, partial, unverified, no_source, unsourced_allowed?, verifications? }
//   signals.pedagogy   = { total, consistent, loose, inconsistent, unknown }
//   signals.confidence = { total_assertive, with_hedge, without_hedge, leak_count }
//   signals.illusion   = { flags: string[], confidence: number }   (rendered as PJR badge)
//
// Machino-γ9 — archetype awareness. β9 PJR writes verdict.archetype_used +
// verdict.gated_by_archetype. When gated=true, the user is told "课程类型 ·
// X — 系统按 X 标准复审", and PJR rewrite badge is suppressed (no real rewrite
// happened). α9 citation verifier adds 'unsourced_allowed' counts for
// HUMANITIES/LANG-ACQ/MINDSET — those don't count as fire.
const _antiSlopOxblood = '#6E2D2D';
const _antiSlopTabac   = '#5C4E36';

// γ9 — archetype enum → zh display label. Keep in sync with
// app/lib/archetype-templates/<NAME>.json filenames.
const _ARCHETYPE_ZH = {
  'TECH-CONCEPT': '技术概念',
  'TECH-PROC':    '技术过程',
  'LANG-ACQ':     '语言习得',
  'HUMANITIES':   '人文 (文学/哲学/历史)',
  'DECL-MASS':    '陈述性大量',
  'MINDSET':      '心智模式',
};
const _archetypeZh = (a) => {
  if (!a || typeof a !== 'string') return '(未声明)';
  return _ARCHETYPE_ZH[a] || _ARCHETYPE_ZH[a.toUpperCase()] || '(未声明)';
};

const AntiSlopExpert = ({ signals, verdict, archetype }) => {
  // γ9 — archetype is independent of signals: render it even when signals==null
  // (so user sees "本课按 X 标准复审" before any scan fires). When signals
  // missing, fall back to the original empty-state copy.
  const archZh = _archetypeZh(archetype);
  const archStyle = {
    marginTop: 2, fontStyle: 'italic', fontSize: 9.5,
    color: _antiSlopTabac, lineHeight: 1.5,
  };

  if (!signals) {
    return (
      <div style={{ marginTop: 10 }}>
        <div
          className="serif"
          style={{
            fontStyle: 'italic', fontSize: 10,
            color: _antiSlopTabac, lineHeight: 1.5,
          }}
        >
          本节未跑诚实复审 — 可能是 stream 未走 anti-slop hook
        </div>
        {archetype && (
          <div className="serif" style={archStyle}>
            课程类型 · {archZh}
          </div>
        )}
      </div>
    );
  }

  const cit = signals.citations  || null;
  const ped = signals.pedagogy   || null;
  const conf = signals.confidence || null;

  // γ9 — α9 adds unsourced_allowed for HUMANITIES/LANG-ACQ/MINDSET. Those don't
  // count as fire — we only fire on `unverified` (claimed source, fails check).
  const unsourcedAllowed = (cit && typeof cit.unsourced_allowed === 'number')
    ? cit.unsourced_allowed
    : 0;
  const citFire  = !!(cit  && typeof cit.unverified === 'number' && cit.unverified > 0);
  const pedFire  = !!(ped  && (((ped.unknown || 0) + (ped.inconsistent || 0)) > 0));
  const confFire = !!(conf && typeof conf.leak_count === 'number' && conf.leak_count > 0);

  if (!citFire && !pedFire && !confFire) {
    return (
      <div style={{ marginTop: 10 }}>
        <div
          className="serif"
          style={{
            fontStyle: 'italic', fontSize: 11,
            color: _antiSlopTabac, lineHeight: 1.5,
          }}
        >
          诚实复审 · 通过
        </div>
        {archetype && (
          <div className="serif" style={archStyle}>
            课程类型 · {archZh}
          </div>
        )}
      </div>
    );
  }

  // Find the most recent unverified citation for inline example (if any).
  let citExample = '';
  if (citFire && Array.isArray(cit.verifications)) {
    for (let i = cit.verifications.length - 1; i >= 0; i--) {
      const v = cit.verifications[i];
      if (v && (v.verdict === 'unverified' || v.verdict === 'no_source')) {
        const q = (v.quote || v.text || '').toString().trim().slice(0, 40);
        if (q) { citExample = q; break; }
      }
    }
  }

  const rowStyle = {
    fontSize: 11, color: 'var(--ink-2)', lineHeight: 1.5,
    marginTop: 4, fontStyle: 'normal',
  };
  const markerStyle = {
    display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
    background: _antiSlopOxblood, marginRight: 8,
    transform: 'translateY(-1px)',
  };

  // γ9 — archetype gate. β9 PJR sets gated_by_archetype=true when the course's
  // archetype (HUMANITIES / LANG-ACQ / MINDSET) declines forced rewrite even
  // though detectors fired. Render this AFTER the 3 fire rows so user reads the
  // signals first, then sees "system understood it's a literature course".
  const gated = !!(verdict && verdict.gated_by_archetype);

  return (
    <div style={{ marginTop: 10 }}>
      <div
        className="serif"
        style={{
          fontStyle: 'italic', fontSize: 11, color: 'var(--ink)',
          marginBottom: 2,
        }}
      >
        诚实复审（本节，来自后置 detector）
      </div>
      {archetype && (
        <div className="serif" style={archStyle}>
          课程类型 · {archZh}
        </div>
      )}

      {citFire && (
        <div style={rowStyle}>
          <span style={markerStyle} />
          引用校核 · {cit.verified || 0}/{cit.total || 0} 已对照原文 · {cit.unverified} 条无法核实
          {unsourcedAllowed > 0 && (
            <span style={{ color: _antiSlopTabac, marginLeft: 6 }}>
              · {unsourcedAllowed} 条来源未配置 (人文课允许)
            </span>
          )}
          {citExample && (
            <span style={{ color: _antiSlopTabac, marginLeft: 6 }}>
              （如「{citExample}」）
            </span>
          )}
        </div>
      )}

      {/* γ9 — render unsourced-allowed even when no fire (informational, tabac
          marker not oxblood). Only when citFire=false to avoid double-count. */}
      {!citFire && unsourcedAllowed > 0 && (
        <div style={{ ...rowStyle, color: _antiSlopTabac }}>
          <span style={{
            ...markerStyle,
            background: _antiSlopTabac,
          }} />
          引用校核 · {cit.verified || 0}/{cit.total || 0} 已对照 · {unsourcedAllowed} 条来源未配置 (人文课允许)
        </div>
      )}

      {pedFire && (
        <div style={rowStyle}>
          <span style={markerStyle} />
          原则用法 · 本节命名 {ped.total || 0} 处 · 不符定义 {(ped.unknown || 0) + (ped.inconsistent || 0)} 条
        </div>
      )}

      {confFire && (
        <div style={rowStyle}>
          <span style={markerStyle} />
          断言诚实 · {conf.without_hedge || 0}/{conf.total_assertive || 0} 无对冲 · 高泄漏 {conf.leak_count} 处
        </div>
      )}

      {/* γ9 — archetype gate explanation. Rendered ONLY when β9 PJR flags
          gated_by_archetype=true. Tells user "signals 显示但不强制改写", framed as
          "按 X 标准复审" (system understood the register) not "system gave up". */}
      {gated && archetype && (
        <div
          className="serif"
          style={{
            marginTop: 6, fontStyle: 'italic', fontSize: 9.5,
            color: _antiSlopTabac, lineHeight: 1.5,
          }}
        >
          本课按 {archZh} 标准 — signals 显示但不强制改写你的思考
        </div>
      )}

      {/* γ9 — suppress PJR badge when gated_by_archetype: no rewrite actually
          happened, so "落盘版本可能与此处所见不同" would mislead. */}
      {verdict && verdict.needs_rewrite && !gated && (
        <div
          className="serif"
          style={{
            marginTop: 6, fontStyle: 'italic', fontSize: 9.5,
            color: _antiSlopTabac, lineHeight: 1.5,
          }}
        >
          PJR 已介入 {verdict.severity || ''} 级 · 落盘版本可能与此处所见不同
        </div>
      )}
    </div>
  );
};

if (typeof window !== 'undefined') {
  window.CourseTrustPanel = CourseTrustPanel;
}
