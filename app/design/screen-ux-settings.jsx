/* global React */
// HYPHA · Wave 8.3 — UX Settings screen (Adaptive UX Personal Forks).
//
// Per BLUEPRINT §20 v3.0. Surfaces the 11 user-tunable preferences plus
// the persona-fork sub-area. Manuscript register invariants are enforced
// server-side (register-guardrail.js) — UI mirrors them by exposing only
// the safe options and surfacing the validator on a "Test register
// guardrail" button.
//
// Cream paper + brass hairlines + italic Garamond display + roman labels.
// No emoji, no exclamation, no SaaS-y meters.
//
// Props: { slug, onBack }

const { useState, useEffect, useCallback, useMemo } = React;

// =====================================================================
// Helpers
// =====================================================================

const BASE_PERSONAS = [
  { id: 'socratic',  label: '苏格拉底式' },
  { id: 'feynman',   label: '费曼式' },
  { id: 'malan',     label: 'David Malan · CS50' },
  { id: 'karpathy',  label: 'Andrej Karpathy · 从零手搓' },
  { id: 'sanderson', label: 'Brandon Sanderson · 结构叙事' },
  { id: 'sapolsky',  label: 'Robert Sapolsky · 时间倒流' },
  { id: 'oxman',     label: 'Neri Oxman · 物质生态' },
  { id: 'sandel',    label: 'Michael Sandel · 思想压力' },
  { id: 'strang',    label: 'Gilbert Strang · 空间几何' },
  { id: 'lewin',     label: 'Walter Lewin · 极限实验' },
  { id: 'damodaran', label: 'Aswath Damodaran · 数据×叙事' },
  { id: 'mycelium-professor', label: '菌丝教师 (default)' },
];

const PREF_LAYOUT = [
  { key: 'density',                   label: '密度',     kind: 'radio',  options: ['terse', 'balanced', 'verbose'], note: '课程主体的繁简度。' },
  { key: 'language',                  label: '语言',     kind: 'radio',  options: ['zh', 'en', 'mixed'], note: '主要呈现语种。' },
  { key: 'cadence_intensity',         label: '节奏',     kind: 'radio',  options: ['slow', 'normal', 'intense'], note: '日程稀疏程度。' },
  { key: 'notification_level',        label: '提示密度', kind: 'radio',  options: ['silent', 'minimal', 'standard'], note: '界面层提示量。' },
  { key: 'font_size',                 label: '字号',     kind: 'radio',  options: ['small', 'medium', 'large'], note: '正文字号档。' },
  { key: 'color_temperature',         label: '色温',     kind: 'radio',  options: ['warm', 'neutral', 'cool'], note: '在 cream 内微调，不改主色。' },
  { key: 'companion_tone',            label: '陪伴语气', kind: 'radio',  options: ['alien-quiet', 'friendly'], note: '永不切到 SaaS 客服腔。' },
  { key: 'companion_enabled',         label: '启用陪伴', kind: 'toggle', note: '关闭则 Myco Companion 隐藏。' },
  { key: 'spark_auto_propose',        label: '灵感自荐', kind: 'toggle', note: '收束时自动提议新 spark。' },
  { key: 'flywheel_publish_prompts',  label: '发布提示', kind: 'toggle', note: '课后引导 Track-B 真人讲述。' },
  { key: 'persona_id',                label: '人格',     kind: 'persona', note: '蒸馏当代专家 corpus 的 register。' },
];

function bridge() {
  return (typeof window !== 'undefined' && window.ptor && window.ptor.ux) || null;
}

// v0.5.0-bootstrap-3 — Pricing v3 loyalty engine bridge accessor.
// Routes to window.ptor.hypha.pricing.{queryTier,setFounderPurchase}.
function pricingBridge() {
  if (typeof window === 'undefined') return null;
  const p = window.ptor && window.ptor.hypha && window.ptor.hypha.pricing;
  return p || null;
}

// Tier display labels — mirrors course-trust-panel.jsx TIER_DISPLAY (kept in sync).
const PRICING_TIER_LABEL = {
  founders: '永久席位',
  pro: '正式',
  basic: '入门',
  byok: '自带钥匙',
  free: '免费',
};

// =====================================================================
// Atomic controls — all roman labels, cream paper, brass hairlines
// =====================================================================

const RadioRow = ({ pref, value, onChange }) => (
  <div className="row gap-12" style={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
    {pref.options.map(opt => {
      const active = value === opt;
      return (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          style={{
            background: active ? 'var(--paper-warm, #f1eadb)' : 'transparent',
            border: '0.5px solid var(--rule-soft, rgba(120,90,60,.25))',
            borderBottom: active ? '1px solid var(--brass-bright, #b18432)' : '0.5px solid var(--rule-soft, rgba(120,90,60,.25))',
            color: active ? 'var(--ink, #29261b)' : 'var(--ink-2, #4a4232)',
            fontFamily: 'inherit',
            fontStyle: 'normal',
            fontSize: 13,
            padding: '4px 12px',
            cursor: 'pointer',
            letterSpacing: '.02em',
          }}
        >
          {opt}
        </button>
      );
    })}
  </div>
);

const ToggleRow = ({ value, onChange }) => (
  <button
    onClick={() => onChange(!value)}
    style={{
      background: value ? 'var(--paper-warm, #f1eadb)' : 'transparent',
      border: '0.5px solid var(--rule-soft, rgba(120,90,60,.25))',
      borderBottom: value ? '1px solid var(--brass-bright, #b18432)' : '0.5px solid var(--rule-soft, rgba(120,90,60,.25))',
      color: 'var(--ink, #29261b)',
      fontFamily: 'inherit',
      fontSize: 13,
      padding: '4px 14px',
      cursor: 'pointer',
      minWidth: 80,
    }}
  >
    {value ? '开' : '关'}
  </button>
);

const PersonaPicker = ({ value, onChange, forks }) => (
  <select
    value={value}
    onChange={e => onChange(e.target.value)}
    style={{
      background: 'transparent',
      border: '0.5px solid var(--rule-soft, rgba(120,90,60,.25))',
      color: 'var(--ink, #29261b)',
      fontFamily: 'inherit',
      fontSize: 13,
      padding: '4px 10px',
      maxWidth: 320,
    }}
  >
    <optgroup label="基础人格 (12)">
      {BASE_PERSONAS.map(p => (
        <option key={p.id} value={p.id}>{p.label}</option>
      ))}
    </optgroup>
    {forks && forks.length > 0 && (
      <optgroup label="用户分支">
        {forks.map(f => (
          <option key={f.id} value={f.id}>{f.label}</option>
        ))}
      </optgroup>
    )}
  </select>
);

const PrefRow = ({ pref, value, onChange, forks }) => (
  <div
    className="col gap-4"
    style={{
      padding: '14px 0',
      borderBottom: '0.5px solid var(--rule-soft, rgba(120,90,60,.18))',
    }}
  >
    <div className="row gap-12" style={{ alignItems: 'baseline' }}>
      <span
        className="serif"
        style={{
          fontSize: 15,
          color: 'var(--ink, #29261b)',
          minWidth: 110,
          fontStyle: 'italic',
        }}
      >
        {pref.label}
      </span>
      {pref.kind === 'radio'   && <RadioRow pref={pref} value={value} onChange={onChange} />}
      {pref.kind === 'toggle'  && <ToggleRow value={!!value} onChange={onChange} />}
      {pref.kind === 'persona' && <PersonaPicker value={value} onChange={onChange} forks={forks} />}
    </div>
    {pref.note && (
      <div
        style={{
          fontSize: 12,
          color: 'var(--ink-3, #7a6e58)',
          fontStyle: 'italic',
          marginLeft: 122,
          maxWidth: 520,
        }}
      >
        {pref.note}
      </div>
    )}
  </div>
);

// =====================================================================
// Persona fork sub-area
// =====================================================================

const PersonaForkPanel = ({ forks, onCreated, onDeleted }) => {
  const [base, setBase] = useState('mycelium-professor');
  const [name, setName] = useState('');
  const [clamps, setClamps] = useState('');
  const [forbidden, setForbidden] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const create = useCallback(async () => {
    const b = bridge();
    if (!b) { setMsg('桥未加载'); return; }
    setBusy(true);
    setMsg(null);
    try {
      const r = await b.forkPersona(base, {
        name: name.trim() || undefined,
        voice_clamps: clamps.split('\n').map(s => s.trim()).filter(Boolean),
        forbidden: forbidden.split('\n').map(s => s.trim()).filter(Boolean),
      });
      if (r && r.ok) {
        setMsg(`已创建 ${r.fork_id}`);
        setName(''); setClamps(''); setForbidden('');
        if (onCreated) onCreated();
      } else {
        setMsg(r && r.error ? r.error : '创建失败');
      }
    } catch (e) {
      setMsg(String(e && e.message || e));
    } finally {
      setBusy(false);
    }
  }, [base, name, clamps, forbidden, onCreated]);

  const remove = useCallback(async (forkId) => {
    const b = bridge();
    if (!b) return;
    await b.deleteFork(forkId);
    if (onDeleted) onDeleted();
  }, [onDeleted]);

  return (
    <div className="col gap-12" style={{ marginTop: 24 }}>
      <div
        className="serif"
        style={{
          fontStyle: 'italic',
          fontSize: 17,
          color: 'var(--ink, #29261b)',
          borderBottom: '0.5px solid var(--brass-bright, #b18432)',
          paddingBottom: 4,
        }}
      >
        人格分支
      </div>
      <div className="col gap-8" style={{ paddingTop: 8 }}>
        <div className="row gap-12" style={{ alignItems: 'baseline' }}>
          <span style={{ fontSize: 13, minWidth: 80, color: 'var(--ink-2, #4a4232)' }}>基础</span>
          <select
            value={base}
            onChange={e => setBase(e.target.value)}
            style={{
              background: 'transparent',
              border: '0.5px solid var(--rule-soft, rgba(120,90,60,.25))',
              fontFamily: 'inherit', fontSize: 13, padding: '3px 8px',
            }}
          >
            {BASE_PERSONAS.filter(p => p.id !== 'mycelium-professor').map(p => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>
        <div className="row gap-12" style={{ alignItems: 'baseline' }}>
          <span style={{ fontSize: 13, minWidth: 80, color: 'var(--ink-2, #4a4232)' }}>名称</span>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            // intentional-placeholder: HTML input placeholder attribute (UX hint text, not unfinished code)
            placeholder="给你的分支起个名"
            style={{
              background: 'transparent',
              border: '0.5px solid var(--rule-soft, rgba(120,90,60,.25))',
              fontFamily: 'inherit', fontSize: 13, padding: '3px 8px',
              minWidth: 260,
            }}
          />
        </div>
        <div className="row gap-12" style={{ alignItems: 'flex-start' }}>
          <span style={{ fontSize: 13, minWidth: 80, color: 'var(--ink-2, #4a4232)', marginTop: 4 }}>语气钳</span>
          <textarea
            value={clamps}
            onChange={e => setClamps(e.target.value)}
            // intentional-placeholder: HTML textarea placeholder attribute (UX hint text, not unfinished code)
            placeholder={'每行一条。例：\n保持低音量\n不写排比'}
            rows={3}
            style={{
              background: 'transparent',
              border: '0.5px solid var(--rule-soft, rgba(120,90,60,.25))',
              fontFamily: 'inherit', fontSize: 13, padding: '4px 8px',
              minWidth: 360,
            }}
          />
        </div>
        <div className="row gap-12" style={{ alignItems: 'flex-start' }}>
          <span style={{ fontSize: 13, minWidth: 80, color: 'var(--ink-2, #4a4232)', marginTop: 4 }}>禁词</span>
          <textarea
            value={forbidden}
            onChange={e => setForbidden(e.target.value)}
            // intentional-placeholder: HTML textarea placeholder attribute (UX hint text, not unfinished code)
            placeholder={'每行一个禁用短语'}
            rows={3}
            style={{
              background: 'transparent',
              border: '0.5px solid var(--rule-soft, rgba(120,90,60,.25))',
              fontFamily: 'inherit', fontSize: 13, padding: '4px 8px',
              minWidth: 360,
            }}
          />
        </div>
        <div className="row gap-12" style={{ alignItems: 'baseline' }}>
          <span style={{ minWidth: 80 }} />
          <button
            disabled={busy}
            onClick={create}
            className="btn btn-ghost"
            style={{
              border: '0.5px solid var(--brass-bright, #b18432)',
              color: 'var(--ink, #29261b)',
              fontFamily: 'inherit',
              fontSize: 13,
              padding: '4px 16px',
              background: 'transparent',
              cursor: busy ? 'wait' : 'pointer',
            }}
          >
            {busy ? '正在分叉' : '建立分支'}
          </button>
          {msg && (
            <span style={{ fontSize: 12, color: 'var(--ink-3, #7a6e58)', fontStyle: 'italic' }}>{msg}</span>
          )}
        </div>
      </div>
      {forks && forks.length > 0 && (
        <div className="col gap-4" style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--ink-3, #7a6e58)', letterSpacing: '.05em' }}>
            现有分支 {forks.length}
          </div>
          {forks.map(f => (
            <div
              key={f.id}
              className="row gap-12"
              style={{
                padding: '8px 0',
                borderBottom: '0.5px solid var(--rule-soft, rgba(120,90,60,.18))',
                alignItems: 'baseline',
              }}
            >
              <span className="serif" style={{ fontStyle: 'italic', fontSize: 14 }}>{f.label}</span>
              <span style={{ fontSize: 12, color: 'var(--ink-3, #7a6e58)' }}>基于 {f.base}</span>
              <span style={{ flex: 1 }} />
              <button
                onClick={() => remove(f.id)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--ink-3, #7a6e58)',
                  fontFamily: 'inherit',
                  fontSize: 12,
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  textUnderlineOffset: 3,
                }}
              >
                移除
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// =====================================================================
// Founders 购买 — v0.5.0-bootstrap-3 (Pricing v3 surface)
// =====================================================================
//
// Reads pricing.queryTier() on mount, renders:
//   - FREE / BASIC / PRO / BYOK → "购买 Founders 永久席位 · 当前 ¥99 限时" button
//   - FOUNDERS → "Founders Year N · 续费价 ¥XX" readonly w/ floor reminder
// Click button → window.confirm → setFounderPurchase(new Date().toISOString())
// → reload tier. Editorial register: italic Garamond label + roman mono value.

// v1.0 boot-8 — per-tier daily ¥ cap row. Mirrors the editorial register
// (italic Garamond label + mono value). Cap source = loyalty-engine, surfaced
// via shield:check IPC. Renders even on FREE / BASIC so the user sees what
// they would gain by upgrading. BYOK renders "不限".
const DailyCapRow = ({ tier }) => {
  const [budget, setBudget] = useState(null);
  useEffect(() => {
    const fn = window.ptor && window.ptor.shield && window.ptor.shield.check;
    if (typeof fn !== 'function') return undefined;
    let alive = true;
    (async () => {
      try {
        const r = await fn('local', null);
        if (!alive || !r || !r.ok) return;
        setBudget({
          today: typeof r.today_cost_cny === 'number' ? r.today_cost_cny : 0,
          limit: r.limit_cny,
          remaining: r.remaining_cny,
          unlimited: r.unlimited === true,
        });
      } catch (_) { /* shield IPC absent — silent */ }
    })();
    return () => { alive = false; };
  }, [tier]);
  let valueLine;
  if (!budget) {
    valueLine = '加载中';
  } else if (budget.unlimited) {
    valueLine = '不限 (自带钥匙)';
  } else {
    valueLine =
      `¥${Number(budget.today || 0).toFixed(2)} / ¥${Number(budget.limit || 0).toFixed(0)}`
      + ` · 剩余 ¥${Number(budget.remaining || 0).toFixed(2)}`;
  }
  return (
    <div
      className="row gap-12"
      style={{
        alignItems: 'baseline',
        padding: '14px 0',
        borderBottom: '0.5px solid var(--rule-soft, rgba(120,90,60,.18))',
      }}
    >
      <span
        className="serif"
        style={{
          fontSize: 15, color: 'var(--ink, #29261b)',
          minWidth: 110, fontStyle: 'italic',
        }}
      >
        今日预算
      </span>
      <span
        className="mono"
        style={{
          fontSize: 13,
          color: 'var(--ink-2, #4a4232)',
          letterSpacing: '.04em',
        }}
        title={`tier ${tier} daily cap from loyalty-engine.getTierDailyCap`}
      >
        {valueLine}
      </span>
    </div>
  );
};

const FoundersPurchasePanel = () => {
  const [tier, setTier] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  // v0.5.0-bootstrap-6 — payment rails 3-step state.
  //   phase: 'idle' (no intent) → 'pending' (qr/url displayed, polling) → 'verified' (will reload tier)
  const [provider, setProvider] = useState('wechat');
  const [phase, setPhase] = useState('idle');
  const [intent, setIntent] = useState(null);

  const reloadTier = useCallback(async () => {
    const p = pricingBridge();
    if (!p || typeof p.queryTier !== 'function') {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const r = await p.queryTier();
      if (r && r.ok) {
        setTier({
          tier: r.tier || 'free',
          monthly_cny: typeof r.monthly_cny === 'number' ? r.monthly_cny : 0,
          pricing_floor: typeof r.pricing_floor === 'number' ? r.pricing_floor : 0,
          years_since: typeof r.years_since === 'number' ? r.years_since : null,
          founder_purchased_at: r.founder_purchased_at || null,
        });
      }
    } catch (e) {
      setMsg(String(e && e.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reloadTier(); }, [reloadTier]);

  // Step 1 — create the intent + flip into 'pending' phase. QR / URL render
  // in the UI. Stub backend auto-verifies after 2s; user just waits.
  const onStartPayment = useCallback(async () => {
    const p = pricingBridge();
    if (!p || typeof p.createPayment !== 'function') {
      setMsg('桥未加载');
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await p.createPayment({ sku: 'founders', provider });
      if (r && r.ok && r.intent_id) {
        setIntent(r);
        setPhase('pending');
        setMsg('测试支付 · 2 秒自动确认 (v1.1+ 接真 SDK)');
      } else {
        setMsg((r && r.error) || '创建支付意图失败');
      }
    } catch (e) {
      setMsg(String(e && e.message || e));
    } finally {
      setBusy(false);
    }
  }, [provider]);

  // Step 2 — poll verify, then commit Founders status. Pending phase only.
  useEffect(() => {
    if (phase !== 'pending' || !intent || !intent.intent_id) return;
    let cancelled = false;
    const p = pricingBridge();
    if (!p || typeof p.verifyPayment !== 'function') return;
    const tick = async () => {
      try {
        const v = await p.verifyPayment(intent.intent_id);
        if (cancelled) return;
        if (v && v.verified === true) {
          // Commit Founders flip via the gated handler.
          const commitR = (typeof p.setFounderPurchase === 'function')
            ? await p.setFounderPurchase({ intent_id: intent.intent_id })
            : null;
          if (cancelled) return;
          if (commitR && commitR.ok) {
            setPhase('verified');
            setIntent(null);
            setMsg('已记入 Founders · 永久席位');
            await reloadTier();
          } else {
            setMsg((commitR && commitR.error) || '提交失败');
            setPhase('idle');
          }
          return;
        }
        if (v && (v.state === 'expired' || v.state === 'failed')) {
          setMsg(`支付${v.state === 'expired' ? '已过期' : '失败'} · 请重试`);
          setPhase('idle');
          setIntent(null);
          return;
        }
      } catch (e) {
        if (!cancelled) setMsg(String(e && e.message || e));
      }
    };
    // Poll every 800ms — stub auto-verifies at 2s so 3 polls covers it.
    const id = setInterval(tick, 800);
    tick();
    return () => { cancelled = true; clearInterval(id); };
  }, [phase, intent, reloadTier]);

  const onCancelPayment = useCallback(() => {
    setPhase('idle');
    setIntent(null);
    setMsg(null);
  }, []);

  if (loading) {
    return (
      <div className="col gap-12" style={{ paddingTop: 32 }}>
        <div
          className="serif"
          style={{
            fontStyle: 'italic', fontSize: 22, letterSpacing: '.01em',
            color: 'var(--ink, #29261b)',
          }}
        >
          Founders 购买
        </div>
        <div style={{ fontSize: 12, color: 'var(--ink-3, #7a6e58)', fontStyle: 'italic' }}>
          读取席位状态中
        </div>
      </div>
    );
  }

  if (!tier) {
    // Bridge missing — render heading + soft note, do not crash.
    return (
      <div className="col gap-12" style={{ paddingTop: 32 }}>
        <div
          className="serif"
          style={{
            fontStyle: 'italic', fontSize: 22, letterSpacing: '.01em',
            color: 'var(--ink, #29261b)',
          }}
        >
          Founders 购买
        </div>
        <div style={{ fontSize: 12, color: 'var(--ink-3, #7a6e58)', fontStyle: 'italic' }}>
          席位桥未加载，购买暂不可用。
        </div>
      </div>
    );
  }

  const isFounder = tier.tier === 'founders';
  const tierLabel = PRICING_TIER_LABEL[tier.tier] || tier.tier;
  const yearN = (typeof tier.years_since === 'number')
    ? Math.floor(tier.years_since) : 0;

  return (
    <div className="col gap-12" style={{ paddingTop: 32 }}>
      <div
        className="serif"
        style={{
          fontStyle: 'italic', fontSize: 22, letterSpacing: '.01em',
          color: 'var(--ink, #29261b)',
        }}
      >
        Founders 购买
      </div>
      <div style={{ fontSize: 13, color: 'var(--ink-2, #4a4232)', maxWidth: 520, fontStyle: 'italic' }}>
        Founders 是一次性 ¥499 永久席位，附带终身阶梯折扣 (¥99 → ¥69 → ¥49 → ¥29 楼板)、
        路线投票、月度 office hour 名额、早期 feature 访问。资格性、非订阅。
      </div>

      <div
        className="row gap-12"
        style={{
          alignItems: 'baseline',
          padding: '14px 0',
          borderBottom: '0.5px solid var(--rule-soft, rgba(120,90,60,.18))',
        }}
      >
        <span
          className="serif"
          style={{
            fontSize: 15, color: 'var(--ink, #29261b)',
            minWidth: 110, fontStyle: 'italic',
          }}
        >
          当前席位
        </span>
        <span
          className="mono"
          style={{
            fontSize: 13,
            color: isFounder ? 'var(--terracotta-1, #A66D2C)' : 'var(--ink-2, #4a4232)',
            letterSpacing: '.04em',
          }}
        >
          {tierLabel.toUpperCase()}
          {isFounder && ` · Year ${yearN} · 续费价 ¥${tier.monthly_cny}/月 · 楼板 ¥${tier.pricing_floor}`}
          {!isFounder && tier.tier === 'pro' && ` · Year ${yearN} · 月费 ¥${tier.monthly_cny}`}
          {!isFounder && tier.tier === 'basic' && ` · 月费 ¥${tier.monthly_cny}`}
          {!isFounder && tier.tier === 'byok' && ` · ¥0 自带钥匙`}
          {!isFounder && tier.tier === 'free' && ` · 课金 ¥99/月起`}
        </span>
      </div>

      <DailyCapRow tier={tier.tier} />

      {!isFounder && phase === 'idle' && (
        <div className="col gap-12">
          {/* Provider radio — manuscript register, brass hairlines. */}
          <div className="row gap-12" style={{ alignItems: 'baseline' }}>
            <span
              className="serif"
              style={{
                fontSize: 13,
                color: 'var(--ink-2, #4a4232)',
                minWidth: 80,
                fontStyle: 'italic',
              }}
            >
              支付渠道
            </span>
            {[
              { id: 'wechat', label: '微信支付' },
              { id: 'stripe', label: 'Stripe' },
            ].map(opt => {
              const active = provider === opt.id;
              return (
                <button
                  key={opt.id}
                  onClick={() => setProvider(opt.id)}
                  style={{
                    background: active ? 'var(--paper-warm, #f1eadb)' : 'transparent',
                    border: '0.5px solid var(--rule-soft, rgba(120,90,60,.25))',
                    borderBottom: active ? '1px solid var(--brass-bright, #b18432)' : '0.5px solid var(--rule-soft, rgba(120,90,60,.25))',
                    color: 'var(--ink, #29261b)',
                    fontFamily: 'inherit',
                    fontSize: 13,
                    padding: '4px 12px',
                    cursor: 'pointer',
                    letterSpacing: '.02em',
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <div className="row gap-12" style={{ alignItems: 'baseline' }}>
            <button
              disabled={busy}
              onClick={onStartPayment}
              className="btn btn-ghost"
              style={{
                border: '0.5px solid var(--brass-bright, #b18432)',
                color: 'var(--ink, #29261b)',
                fontFamily: 'inherit',
                fontSize: 13,
                padding: '4px 16px',
                background: 'transparent',
                cursor: busy ? 'wait' : 'pointer',
                letterSpacing: '.02em',
              }}
            >
              {busy ? '正在生成意图' : '购买 Founders 永久席位 · ¥499'}
            </button>
            <span style={{ fontSize: 11, color: 'var(--ink-3, #7a6e58)', fontStyle: 'italic' }}>
              测试支付 · 2 秒自动确认 (v1.1+ 接真 SDK)
            </span>
            {msg && (
              <span style={{ fontSize: 12, color: 'var(--ink-3, #7a6e58)', fontStyle: 'italic' }}>
                {msg}
              </span>
            )}
          </div>
        </div>
      )}

      {!isFounder && phase === 'pending' && intent && (
        <div
          className="col gap-8"
          style={{
            padding: '14px 16px',
            background: 'var(--paper-warm, #f1eadb)',
            border: '0.5px solid var(--rule-soft, rgba(120,90,60,.25))',
            borderLeft: '1px solid var(--brass-bright, #b18432)',
            maxWidth: 520,
          }}
        >
          <div
            className="serif"
            style={{ fontStyle: 'italic', fontSize: 15, color: 'var(--ink, #29261b)' }}
          >
            支付意图 · {intent.provider === 'wechat' ? '微信' : 'Stripe'}
          </div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3, #7a6e58)', letterSpacing: '.04em' }}>
            {intent.intent_id} · ¥{intent.amount_cny}
          </div>
          {intent.qr_code && (
            <div
              className="mono"
              style={{
                fontSize: 11,
                color: 'var(--ink-2, #4a4232)',
                padding: '8px 12px',
                background: 'var(--paper, #fbf6e9)',
                border: '0.5px solid var(--rule-soft, rgba(120,90,60,.2))',
                wordBreak: 'break-all',
              }}
            >
              {intent.qr_code}
            </div>
          )}
          {intent.payment_url && (
            <div
              className="mono"
              style={{
                fontSize: 11,
                color: 'var(--ink-2, #4a4232)',
                padding: '8px 12px',
                background: 'var(--paper, #fbf6e9)',
                border: '0.5px solid var(--rule-soft, rgba(120,90,60,.2))',
                wordBreak: 'break-all',
              }}
            >
              {intent.payment_url}
            </div>
          )}
          <div className="row gap-12" style={{ alignItems: 'baseline', paddingTop: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--ink-3, #7a6e58)', fontStyle: 'italic' }}>
              等待确认 · 测试支付约 2 秒
            </span>
            <span style={{ flex: 1 }} />
            <button
              onClick={onCancelPayment}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--ink-3, #7a6e58)',
                fontFamily: 'inherit',
                fontSize: 12,
                cursor: 'pointer',
                textDecoration: 'underline',
                textUnderlineOffset: 3,
              }}
            >
              取消
            </button>
          </div>
          {msg && (
            <div style={{ fontSize: 12, color: 'var(--ink-3, #7a6e58)', fontStyle: 'italic' }}>
              {msg}
            </div>
          )}
        </div>
      )}

      {isFounder && (
        <div style={{ fontSize: 12, color: 'var(--ink-3, #7a6e58)', fontStyle: 'italic', maxWidth: 520 }}>
          席位已购入。续费走阶梯折扣，年限到达后自动降至 ¥{tier.pricing_floor}/月 楼板。
          {tier.founder_purchased_at && ` 购入于 ${tier.founder_purchased_at.slice(0, 10)}。`}
        </div>
      )}
    </div>
  );
};

// =====================================================================
// Update panel (v1.0 boot-8 — electron-updater surface)
// =====================================================================
//
// Surfaces:
//   - "当前版本" line — roman mono, reads via window.updater.current()
//   - Button "检查更新" — manual check, bypasses skip/cooldown
//   - Status line — "已是最新版" / "发现新版本 X.Y.Z" / "下载中 42%" / "已下载，重启安装"
//   - On available: 3-button row "下载 / 跳过此版 / 稍后提醒"
//   - On downloaded: button "现在重启并安装"
//   - Subtle hint: "更新永远需要你确认。不会强制重启。"
//
// Bridge: window.updater.{check,download,install,current,state,skipVersion,remindLater,onEvent}.
// User consent is the only path to install — onEvent listener just keeps state live.

const UpdatePanel = () => {
  const [current, setCurrent] = useState('—');
  const [updState, setUpdState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const updBridge = () => (typeof window !== 'undefined' ? window.updater : null);

  const reload = useCallback(async () => {
    const b = updBridge();
    if (!b) return;
    try {
      const c = await b.current();
      if (c && c.ok) setCurrent(c.version);
      const s = await b.state();
      if (s && s.ok) setUpdState(s.state);
    } catch (_) { /* best-effort */ }
  }, []);

  useEffect(() => {
    reload();
    const b = updBridge();
    if (!b || typeof b.onEvent !== 'function') return undefined;
    const off = b.onEvent((evt) => {
      // Push events: { type, version?, progress?, error? }
      setUpdState((prev) => {
        const next = Object.assign({}, prev || {});
        if (evt.type === 'checking')      next.status = 'checking';
        if (evt.type === 'available')     { next.status = 'available'; next.latestVersion = evt.version; }
        if (evt.type === 'not-available') { next.status = 'not-available'; }
        if (evt.type === 'progress')      { next.status = 'downloading'; next.progress = evt.progress; }
        if (evt.type === 'downloaded')    { next.status = 'downloaded'; next.latestVersion = evt.version; next.progress = null; }
        if (evt.type === 'error')         { next.status = 'error'; next.error = evt.error; }
        return next;
      });
    });
    return () => { try { off && off(); } catch (_) {} };
  }, [reload]);

  const onCheck = useCallback(async () => {
    const b = updBridge();
    if (!b) { setMsg('桥未加载'); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await b.check({ silent: false });
      if (!r.ok) setMsg(r.error || '检查失败');
      else if (r.status === 'dev-skipped') setMsg('开发模式 · 不检查');
      else if (r.status === 'not-available') setMsg('已是最新版');
      else if (r.status === 'cooldown') setMsg('稍后再问');
      await reload();
    } catch (e) {
      setMsg(e.message || '检查失败');
    } finally {
      setBusy(false);
    }
  }, [reload]);

  const onDownload = useCallback(async () => {
    const b = updBridge();
    if (!b) return;
    setBusy(true); setMsg(null);
    try {
      const r = await b.download();
      if (!r.ok) setMsg(r.error || '下载失败');
    } catch (e) {
      setMsg(e.message || '下载失败');
    } finally {
      setBusy(false);
    }
  }, []);

  const onInstall = useCallback(async () => {
    const b = updBridge();
    if (!b) return;
    setBusy(true); setMsg('准备重启…');
    try {
      const r = await b.install();
      if (!r.ok) setMsg(r.error || '安装失败');
    } catch (e) {
      setMsg(e.message || '安装失败');
    } finally {
      setBusy(false);
    }
  }, []);

  const onSkip = useCallback(async () => {
    const b = updBridge();
    if (!b || !updState || !updState.latestVersion) return;
    try { await b.skipVersion(updState.latestVersion); setMsg('已跳过 ' + updState.latestVersion); } catch (_) {}
    await reload();
  }, [updState, reload]);

  const onRemind = useCallback(async () => {
    const b = updBridge();
    if (!b) return;
    try { await b.remindLater(); setMsg('24 小时内不再提示'); } catch (_) {}
    await reload();
  }, [reload]);

  const status = (updState && updState.status) || 'idle';
  const isDev = !!(updState && updState.dev);
  const latest = updState && updState.latestVersion;
  const progress = updState && updState.progress;
  const pct = progress && typeof progress.percent === 'number'
    ? Math.max(0, Math.min(100, Math.round(progress.percent))) : null;

  const statusLine = (() => {
    if (isDev) return '开发模式 · 不检查更新';
    if (status === 'checking') return '检查中…';
    if (status === 'downloading' && pct !== null) return `下载中 ${pct}%`;
    if (status === 'downloaded') return latest ? `${latest} 已下载，待重启安装` : '已下载，待重启安装';
    if (status === 'available') return latest ? `发现新版本 ${latest}` : '发现新版本';
    if (status === 'not-available') return '已是最新版';
    if (status === 'error') return (updState && updState.error) || '检查失败';
    return '尚未检查';
  })();

  return (
    <div className="col gap-12" style={{ paddingTop: 32 }}>
      <div
        className="serif"
        style={{
          fontStyle: 'italic',
          fontSize: 22,
          letterSpacing: '.01em',
          color: 'var(--ink, #29261b)',
        }}
      >
        更新 · 跟随你的节奏
      </div>
      <div style={{ fontSize: 13, color: 'var(--ink-2, #4a4232)', maxWidth: 520, fontStyle: 'italic' }}>
        Hypha 不会自己重启。新版本会在后台下载好，等你下次空闲再问一次。你的笔记与课程在 %APPDATA%\Hypha\data 自留，更新不动它们。
      </div>

      <div
        className="row"
        style={{
          padding: '14px 0',
          borderBottom: '0.5px solid var(--rule-soft, rgba(120,90,60,.18))',
          alignItems: 'baseline',
          gap: 12,
        }}
      >
        <span
          className="serif"
          style={{
            fontSize: 15,
            color: 'var(--ink, #29261b)',
            minWidth: 110,
            fontStyle: 'italic',
          }}
        >
          当前版本
        </span>
        <span className="mono" style={{ fontSize: 13, color: 'var(--ink-2, #4a4232)', letterSpacing: '.05em' }}>
          {current}
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={onCheck}
          disabled={busy}
          style={{
            background: 'transparent',
            border: '0.5px solid var(--brass-bright, #b18432)',
            color: busy ? 'var(--ink-3, #7a6e58)' : 'var(--ink, #29261b)',
            fontFamily: 'inherit', fontSize: 13,
            padding: '4px 14px', cursor: busy ? 'wait' : 'pointer',
          }}
        >
          检查更新
        </button>
      </div>

      <div
        className="row"
        style={{
          padding: '12px 0',
          borderBottom: '0.5px solid var(--rule-soft, rgba(120,90,60,.18))',
          alignItems: 'baseline',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <span
          className="serif"
          style={{ fontSize: 15, color: 'var(--ink, #29261b)', minWidth: 110, fontStyle: 'italic' }}
        >
          状态
        </span>
        <span style={{ fontSize: 13, color: 'var(--ink-2, #4a4232)' }}>
          {statusLine}
        </span>
        <span style={{ flex: 1 }} />
        {status === 'available' && (
          <div className="row gap-12" style={{ alignItems: 'baseline' }}>
            <button
              onClick={onDownload} disabled={busy}
              style={{
                background: 'var(--paper-warm, #f1eadb)',
                border: '0.5px solid var(--brass-bright, #b18432)',
                borderBottom: '1px solid var(--brass-bright, #b18432)',
                color: 'var(--ink, #29261b)',
                fontFamily: 'inherit', fontSize: 13,
                padding: '4px 14px', cursor: 'pointer',
              }}
            >
              下载
            </button>
            <button
              onClick={onSkip}
              style={{
                background: 'transparent', border: 'none',
                color: 'var(--ink-3, #7a6e58)',
                fontFamily: 'inherit', fontSize: 13,
                padding: '4px 0', cursor: 'pointer',
                textDecoration: 'underline', textUnderlineOffset: 3,
              }}
            >
              跳过此版
            </button>
            <button
              onClick={onRemind}
              style={{
                background: 'transparent', border: 'none',
                color: 'var(--ink-3, #7a6e58)',
                fontFamily: 'inherit', fontSize: 13,
                padding: '4px 0', cursor: 'pointer',
                textDecoration: 'underline', textUnderlineOffset: 3,
              }}
            >
              稍后提醒
            </button>
          </div>
        )}
        {status === 'downloaded' && (
          <button
            onClick={onInstall} disabled={busy}
            style={{
              background: 'var(--paper-warm, #f1eadb)',
              border: '0.5px solid var(--brass-bright, #b18432)',
              borderBottom: '1px solid var(--brass-bright, #b18432)',
              color: 'var(--ink, #29261b)',
              fontFamily: 'inherit', fontSize: 13,
              padding: '4px 14px', cursor: 'pointer',
            }}
          >
            现在重启并安装
          </button>
        )}
      </div>

      {msg && (
        <div style={{ fontSize: 12, color: 'var(--ink-3, #7a6e58)', fontStyle: 'italic' }}>
          {msg}
        </div>
      )}
    </div>
  );
};

// =====================================================================
// Diagnostics panel (v1.0 boot-7 — local-first error tracker)
// =====================================================================
//
// Surfaces:
//   - Toggle "本地记录错误" (default ON, no network, anonymized payload only
//     if explicit consent — see panel copy).
//   - Toggle "允许匿名上报" — UI disabled label "(v1.1+ 即将上线)", reads false.
//   - Button "导出错误报告" → calls telemetry.export, opens save dialog,
//     writes file to user-chosen path.
//   - Health badge: italic Garamond glyph + numeric badge (0-100).
//
// Bridge: window.ptor.telemetry.{getConsent,setConsent,export,health}.
// All operations are local-only — no fetch / XHR / network from this panel.

const DiagnosticsPanel = () => {
  const [consent, setConsent] = useState(false);
  const [health, setHealth] = useState(1.0);
  const [counts, setCounts] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const tBridge = () => {
    if (typeof window === 'undefined') return null;
    const t = window.ptor && window.ptor.telemetry;
    return t || null;
  };

  const reload = useCallback(async () => {
    const b = tBridge();
    if (!b) return;
    try {
      const c = await b.getConsent();
      setConsent(!!(c && c.consent));
      const h = await b.health();
      if (h && typeof h.score === 'number') setHealth(h.score);
      if (h && h.counts) setCounts(h.counts);
    } catch (_) { /* best-effort */ }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const onToggleConsent = useCallback(async (next) => {
    const b = tBridge();
    if (!b) { setMsg('桥未加载'); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await b.setConsent(next);
      if (r && r.ok) {
        setConsent(!!next);
        setMsg(next ? '已开启 (本地匿名记录)' : '已关闭');
      } else {
        setMsg((r && r.error) || '操作失败');
      }
    } catch (e) {
      setMsg(e.message || '操作失败');
    } finally {
      setBusy(false);
    }
  }, []);

  const onExport = useCallback(async () => {
    const b = tBridge();
    if (!b) { setMsg('桥未加载'); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await b.export();
      if (r && r.ok && r.path) setMsg(`已写到 ${r.path}`);
      else setMsg((r && r.error) || '导出失败');
      await reload();
    } catch (e) {
      setMsg(e.message || '导出失败');
    } finally {
      setBusy(false);
    }
  }, [reload]);

  const healthGlyph = health >= 0.9 ? '稳' : health >= 0.6 ? '常' : health >= 0.3 ? '弱' : '损';
  const healthColor = health >= 0.9
    ? 'var(--brass-bright, #b18432)'
    : health >= 0.6
      ? 'var(--ink-2, #4a4232)'
      : health >= 0.3
        ? 'var(--ink-3, #7a6e58)'
        : '#a14242';

  return (
    <div className="col gap-12" style={{ paddingTop: 32 }}>
      <div
        className="serif"
        style={{
          fontStyle: 'italic',
          fontSize: 22,
          letterSpacing: '.01em',
          color: 'var(--ink, #29261b)',
        }}
      >
        诊断数据 · 只留在本机
      </div>
      <div style={{ fontSize: 13, color: 'var(--ink-2, #4a4232)', maxWidth: 520, fontStyle: 'italic' }}>
        错误与崩溃只写入本机 vault/.hypha/。路径、姓名、长段文字会先替成 &lt;vault&gt; / &lt;redacted&gt; 再落地。
        软件不会主动上报；遇到 bug 用「导出错误报告」拿到一份可粘贴的文件再决定发不发。
      </div>

      <div
        className="row"
        style={{
          padding: '14px 0',
          borderBottom: '0.5px solid var(--rule-soft, rgba(120,90,60,.18))',
          alignItems: 'baseline',
          gap: 12,
        }}
      >
        <span
          className="serif"
          style={{
            fontSize: 15,
            color: 'var(--ink, #29261b)',
            minWidth: 110,
            fontStyle: 'italic',
          }}
        >
          本地记录错误
        </span>
        <ToggleRow value={consent} onChange={onToggleConsent} />
        <span style={{ fontSize: 12, color: 'var(--ink-3, #7a6e58)', fontStyle: 'italic' }}>
          关闭时只记数量，不留任何 payload。
        </span>
      </div>

      {/* boot-11 UI polish (2026-05-20): the "允许匿名上报" row was a disabled
          stub showing a "即将上线" label. Per CLAUDE.md "若功能未真就绪 → 隐藏"
          (Lens 9 SURGICAL) the row is now gated behind a feature flag that
          stays off until the cloud channel actually ships in v1.1+. When the
          IPC + transport land, flip `cloudReportReady` to `true` (or read it
          from a capability probe) — surface restores as-is. */}
      {/* eslint-disable-next-line no-constant-condition */}
      {false && (
        <div
          className="row"
          style={{
            padding: '14px 0',
            borderBottom: '0.5px solid var(--rule-soft, rgba(120,90,60,.18))',
            alignItems: 'baseline',
            gap: 12,
            opacity: 0.55,
          }}
        >
          <span
            className="serif"
            style={{
              fontSize: 15,
              color: 'var(--ink, #29261b)',
              minWidth: 110,
              fontStyle: 'italic',
            }}
          >
            允许匿名上报
          </span>
          <button
            disabled
            style={{
              background: 'transparent',
              border: '0.5px dashed var(--rule-soft, rgba(120,90,60,.35))',
              color: 'var(--ink-3, #7a6e58)',
              fontFamily: 'inherit',
              fontSize: 13,
              padding: '4px 14px',
              cursor: 'not-allowed',
              minWidth: 80,
            }}
          >
            关
          </button>
          <span style={{ fontSize: 12, color: 'var(--ink-3, #7a6e58)', fontStyle: 'italic' }}>
            opt-in only. surface 待云通道就绪后启用。
          </span>
        </div>
      )}

      <div className="row" style={{ alignItems: 'baseline', gap: 16, paddingTop: 4 }}>
        <button
          onClick={onExport}
          disabled={busy}
          style={{
            background: 'transparent',
            border: '0.5px solid var(--brass-bright, #b18432)',
            color: 'var(--ink, #29261b)',
            fontFamily: 'inherit',
            fontSize: 13,
            padding: '4px 14px',
            cursor: busy ? 'wait' : 'pointer',
          }}
        >
          导出错误报告
        </button>
        <span style={{ flex: 1 }} />
        <span
          className="serif"
          style={{
            fontStyle: 'italic',
            fontSize: 13,
            color: 'var(--ink-3, #7a6e58)',
          }}
          title={counts ? `errors_total=${counts.error_total || 0}` : ''}
        >
          健康
        </span>
        <span
          style={{
            display: 'inline-block',
            minWidth: 42,
            padding: '2px 10px',
            border: `0.5px solid ${healthColor}`,
            color: healthColor,
            fontSize: 12,
            letterSpacing: '.04em',
            textAlign: 'center',
          }}
        >
          {healthGlyph} · {Math.round(health * 100)}
        </span>
      </div>

      {msg && (
        <div style={{ fontSize: 12, color: 'var(--ink-3, #7a6e58)', fontStyle: 'italic' }}>{msg}</div>
      )}
    </div>
  );
};

// =====================================================================
// v1.0 boot-9 (2026-05-20) — Companion 本地模型 surface (T2_LOCAL scaffold)
// =====================================================================
//
// Reads window.ptor.hypha.companion.localStatus() to surface the current
// model state. v1.0 always reports capability_available:false + ready:false,
// so the body renders "Companion 本地模型 · 未下载 (v1.1+ 可用)" and the
// download button stays disabled with a tooltip. Once v1.1+ flips the
// capability flag, the same component lights up without code changes.
//
// Manuscript register: italic Garamond heading + roman status line + brass-
// hairline disabled button + small note for RAM.

const LocalModelPanel = () => {
  const [status, setStatus] = useState(null);
  const [msg, setMsg] = useState(null);

  const cBridge = () => {
    if (typeof window === 'undefined') return null;
    const c = window.ptor && window.ptor.hypha && window.ptor.hypha.companion;
    return c || null;
  };

  const reload = useCallback(async () => {
    const b = cBridge();
    if (!b || typeof b.localStatus !== 'function') return;
    try {
      const r = await b.localStatus();
      if (r && r.ok && r.status) setStatus(r.status);
    } catch (_) { /* best-effort */ }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const onDownloadClick = useCallback(async () => {
    const b = cBridge();
    if (!b || typeof b.localDownload !== 'function') return;
    try {
      const r = await b.localDownload();
      // v1.0 returns ok:false + status:'not_implemented_v1.0' — surface
      // the message verbatim. v1.1+ will switch to a progress-event channel.
      if (r && r.message) setMsg(r.message);
      else if (r && r.status) setMsg(r.status);
      else setMsg('下载尚未上线');
    } catch (e) {
      setMsg((e && e.message) || '下载尚未上线');
    }
  }, []);

  const ready = !!(status && status.ready);
  const capAvailable = !!(status && status.capability_available);
  const sizeMb = (status && status.model_size_mb) || 4096;
  const ramMb = status && status.ram_available_mb;
  const hasRam = typeof ramMb === 'number' && Number.isFinite(ramMb);

  const statusLine = capAvailable && ready
    ? `Companion 本地模型 · 已就绪 · ${status.model_name}`
    : `Companion 本地模型 · 未下载 (v1.1+ 可用)`;

  return (
    <div className="col gap-12" style={{ paddingTop: 32 }}>
      <div
        className="serif"
        style={{
          fontStyle: 'italic',
          fontSize: 22,
          letterSpacing: '.01em',
          color: 'var(--ink, #29261b)',
        }}
      >
        本地模型 · 把陪伴留在桌前
      </div>
      <div style={{ fontSize: 13, color: 'var(--ink-2, #4a4232)', maxWidth: 520, fontStyle: 'italic' }}>
        启用后, 菌类星人的措辞由本机模型生成, 思绪不离开你这台机器。
        v1.0 走云端转译; v1.1+ 会把这条线接到本机 Gemma 3 4B。
      </div>

      <div
        className="row gap-12"
        style={{ marginTop: 8, alignItems: 'baseline', fontSize: 13 }}
      >
        <span
          style={{
            color: 'var(--ink, #29261b)',
            fontFamily: 'inherit',
            letterSpacing: '.01em',
          }}
        >
          {statusLine}
        </span>
        <span style={{ flex: 1 }} />
        {hasRam && (
          <span style={{ color: 'var(--ink-3, #7a6e58)', fontSize: 12, fontStyle: 'italic' }}>
            可用内存 {Math.floor(ramMb / 1024)} GB
          </span>
        )}
      </div>

      <div className="row gap-12" style={{ marginTop: 12, alignItems: 'baseline' }}>
        <button
          type="button"
          onClick={onDownloadClick}
          disabled={!capAvailable}
          title={capAvailable ? '开始下载本地模型' : '本地模型尚未就绪'}
          className="btn btn-ghost"
          style={{
            background: 'transparent',
            border: '0.5px solid var(--brass-bright, #b18432)',
            color: capAvailable ? 'var(--ink, #29261b)' : 'var(--ink-3, #7a6e58)',
            fontFamily: 'inherit',
            fontSize: 13,
            padding: '4px 14px',
            cursor: capAvailable ? 'pointer' : 'not-allowed',
            opacity: capAvailable ? 1 : 0.6,
          }}
        >
          下载 {Math.round(sizeMb / 1024)} GB 模型
        </button>
        <span style={{ color: 'var(--ink-3, #7a6e58)', fontSize: 12, fontStyle: 'italic' }}>
          需要 8 GB 内存
        </span>
        <span style={{ flex: 1 }} />
        {msg && (
          <span style={{ fontSize: 12, color: 'var(--ink-3, #7a6e58)', fontStyle: 'italic' }}>
            {msg}
          </span>
        )}
      </div>
    </div>
  );
};

// =====================================================================
// Main screen
// =====================================================================

const UxSettingsScreen = ({ slug, onBack }) => {
  const [prefs, setPrefs] = useState(null);
  const [source, setSource] = useState(null);
  const [forks, setForks] = useState([]);
  const [guardMsg, setGuardMsg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState(slug ? 'slug' : 'global');

  const reload = useCallback(async () => {
    const b = bridge();
    if (!b) { setLoading(false); return; }
    setLoading(true);
    try {
      const effectiveSlug = scope === 'slug' ? slug : null;
      const r = await b.loadPrefs(effectiveSlug);
      if (r && r.ok) {
        setPrefs(r.preferences);
        setSource(r.source);
      }
      const fr = await b.listForks();
      if (fr && fr.ok) setForks(fr.forks || []);
    } finally {
      setLoading(false);
    }
  }, [scope, slug]);

  useEffect(() => { reload(); }, [reload]);

  const onChange = useCallback(async (key, value) => {
    const b = bridge();
    if (!b || !prefs) return;
    const candidate = { ...prefs, [key]: value };
    const verdict = await b.validate(candidate);
    if (verdict && verdict.ok === false) {
      setGuardMsg(`守门 拒绝：${(verdict.reasons || []).join('、')}`);
      return;
    }
    setGuardMsg(null);
    const effectiveSlug = scope === 'slug' ? slug : null;
    const r = await b.updatePref(effectiveSlug, key, value);
    if (r && r.ok) setPrefs(r.preferences);
  }, [prefs, scope, slug]);

  const onReset = useCallback(async () => {
    const b = bridge();
    if (!b) return;
    const effectiveSlug = scope === 'slug' ? slug : null;
    const r = await b.reset(effectiveSlug);
    if (r && r.ok) {
      setPrefs(r.preferences);
      setGuardMsg(scope === 'slug' ? '本课偏好已重置回全局' : '全局偏好已重置回默认');
    }
  }, [scope, slug]);

  const onTestGuardrail = useCallback(async () => {
    const b = bridge();
    if (!b || !prefs) return;
    // Inject a forbidden key to verify the validator rejects it.
    const evil = { ...prefs, emoji: true, badges: true, third_person_address: true };
    const verdict = await b.validate(evil);
    if (verdict && verdict.ok === false) {
      setGuardMsg(`守门 工作正常：${(verdict.reasons || []).slice(0, 3).join('、')}`);
    } else {
      setGuardMsg('守门 异常：违规组合未被拒绝。');
    }
  }, [prefs]);

  const hasOverride = useMemo(
    () => !!(source && (scope === 'slug' ? source.slug : source.global)),
    [source, scope]
  );

  if (loading) {
    return (
      <div
        className="col"
        style={{
          padding: 40, color: 'var(--ink-3, #7a6e58)',
          fontStyle: 'italic', fontSize: 14,
        }}
      >
        读取偏好中
      </div>
    );
  }

  if (!prefs) {
    return (
      <div className="col" style={{ padding: 40 }}>
        <div style={{ fontStyle: 'italic', color: 'var(--ink-3, #7a6e58)' }}>
          桥未加载，偏好暂不可用。
        </div>
        {onBack && (
          <button onClick={onBack} className="btn btn-ghost" style={{ marginTop: 16 }}>
            返回
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className="col gap-16"
      style={{
        padding: '32px 40px',
        maxWidth: 760,
        margin: '0 auto',
        background: 'var(--paper, #fbf6e9)',
        color: 'var(--ink, #29261b)',
        minHeight: '100vh',
      }}
    >
      <div className="row gap-12" style={{ alignItems: 'baseline' }}>
        {onBack && (
          <button
            onClick={onBack}
            className="btn btn-ghost"
            style={{
              background: 'transparent', border: 'none',
              color: 'var(--ink-3, #7a6e58)', fontFamily: 'inherit',
              fontSize: 13, padding: 0, cursor: 'pointer',
            }}
          >
            ← 返回
          </button>
        )}
        <span style={{ flex: 1 }} />
        <span className="t-tiny mono" style={{ color: 'var(--ink-3, #7a6e58)', letterSpacing: '.08em' }}>
          {hasOverride ? '已覆盖' : '默认'}
        </span>
      </div>

      <div
        className="serif"
        style={{
          fontStyle: 'italic',
          fontSize: 26,
          letterSpacing: '.01em',
          color: 'var(--ink, #29261b)',
        }}
      >
        体感偏好
      </div>
      <div style={{ fontSize: 13, color: 'var(--ink-2, #4a4232)', maxWidth: 520, fontStyle: 'italic' }}>
        以下偏好仅塑造你眼前的子层。主基调（cream / brass / Garamond 斜体）由手稿基线锁定，不在此处可调。
      </div>

      {slug && (
        <div className="row gap-12" style={{ alignItems: 'baseline', paddingTop: 8 }}>
          <span style={{ fontSize: 13, color: 'var(--ink-2, #4a4232)', minWidth: 80 }}>作用域</span>
          <button
            onClick={() => setScope('global')}
            style={{
              background: scope === 'global' ? 'var(--paper-warm, #f1eadb)' : 'transparent',
              border: '0.5px solid var(--rule-soft, rgba(120,90,60,.25))',
              borderBottom: scope === 'global' ? '1px solid var(--brass-bright, #b18432)' : '0.5px solid var(--rule-soft, rgba(120,90,60,.25))',
              fontSize: 13, padding: '4px 12px', cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            全局
          </button>
          <button
            onClick={() => setScope('slug')}
            style={{
              background: scope === 'slug' ? 'var(--paper-warm, #f1eadb)' : 'transparent',
              border: '0.5px solid var(--rule-soft, rgba(120,90,60,.25))',
              borderBottom: scope === 'slug' ? '1px solid var(--brass-bright, #b18432)' : '0.5px solid var(--rule-soft, rgba(120,90,60,.25))',
              fontSize: 13, padding: '4px 12px', cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            本课
          </button>
        </div>
      )}

      <div className="col" style={{ marginTop: 8 }}>
        {PREF_LAYOUT.map(pref => (
          <PrefRow
            key={pref.key}
            pref={pref}
            value={prefs[pref.key]}
            onChange={v => onChange(pref.key, v)}
            forks={forks}
          />
        ))}
      </div>

      <div className="row gap-12" style={{ marginTop: 12, alignItems: 'baseline' }}>
        <button
          onClick={onTestGuardrail}
          className="btn btn-ghost"
          style={{
            background: 'transparent',
            border: '0.5px solid var(--brass-bright, #b18432)',
            color: 'var(--ink, #29261b)',
            fontFamily: 'inherit',
            fontSize: 13,
            padding: '4px 14px',
            cursor: 'pointer',
          }}
        >
          检测手稿守门
        </button>
        <button
          onClick={onReset}
          className="btn btn-ghost"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--ink-3, #7a6e58)',
            fontFamily: 'inherit',
            fontSize: 13,
            padding: '4px 0',
            cursor: 'pointer',
            textDecoration: 'underline',
            textUnderlineOffset: 3,
          }}
        >
          重置 {scope === 'slug' ? '本课偏好' : '全局偏好'}
        </button>
        <span style={{ flex: 1 }} />
        {guardMsg && (
          <span style={{ fontSize: 12, color: 'var(--ink-3, #7a6e58)', fontStyle: 'italic' }}>
            {guardMsg}
          </span>
        )}
      </div>

      <PersonaForkPanel
        forks={forks}
        onCreated={reload}
        onDeleted={reload}
      />

      {/* v0.5.0-bootstrap-3 — Pricing v3 Founders 购买 surface. Reads
          pricing.queryTier + writes pricing.setFounderPurchase via
          window.ptor.hypha.pricing bridge. Editorial register: italic
          Garamond heading + roman mono tier line + brass-hairline button. */}
      <FoundersPurchasePanel />

      {/* v1.0 boot-8 (2026-05-20) — Update surface (electron-updater).
          Reads/writes via window.updater.*; no force-restart, always user-
          consent. Dev mode renders "开发模式 · 不检查更新" as status. Skip-
          version + remind-later persist to profile.json.auto_update.* so
          state survives restarts. Live progress via update:event push. */}
      <UpdatePanel />

      {/* v1.0 boot-7 (2026-05-20) — Diagnostics surface (local-first only).
          Tracker writes to vault/.hypha/local-errors.jsonl. No network. v1.1+
          may add an opt-in "send report" cloud channel; today the second
          toggle is rendered DISABLED with a "即将上线" label so consent UX
          stays consistent. Manuscript register: italic Garamond heading +
          roman tier line + brass-hairline buttons. */}
      <DiagnosticsPanel />

      {/* v1.0 boot-9 (2026-05-20) — Companion 本地模型 (T2_LOCAL scaffold).
          Reads window.ptor.hypha.companion.localStatus(); v1.0 surfaces
          "未下载 · v1.1+ 可用" with disabled download button. v1.1+ flip
          activates the same component without code edits. */}
      <LocalModelPanel />

      {/* 2026-05-16 consolidation — α19 Privacy Memory mount.
          Card is a global surface (not per-slug); lives at the bottom of ux-settings
          so user reaches it via 偏好 → 隐私. window.PrivacyMemoryCard is exported by
          privacy-memory-card.jsx and loaded via HYPHA.html script tag. */}
      {typeof window !== 'undefined' && typeof window.PrivacyMemoryCard === 'function' && (
        <div className="col gap-12" style={{ paddingTop: 32 }}>
          <div
            className="serif"
            style={{
              fontStyle: 'italic',
              fontSize: 22,
              letterSpacing: '.01em',
              color: 'var(--ink, #29261b)',
            }}
          >
            隐私 · 不让出去的话
          </div>
          <div style={{ fontSize: 13, color: 'var(--ink-2, #4a4232)', maxWidth: 520, fontStyle: 'italic' }}>
            在此画一道线 — 姓名、地点、雇主、某段经历。它们会在任何课堂消息离开你之前被替成 `&lt;redacted:label&gt;`。
          </div>
          {React.createElement(window.PrivacyMemoryCard)}
        </div>
      )}
    </div>
  );
};

if (typeof window !== 'undefined') {
  window.UxSettingsScreen = UxSettingsScreen;
}
