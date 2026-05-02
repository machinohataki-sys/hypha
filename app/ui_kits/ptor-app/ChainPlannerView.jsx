/* global React, ReactDOM */
// Hypha Lacquer Loop W7 — Learning Chain Planner UI.
// Council-designed (Yogo + Leo + Scout 2026-05-01) feasibility classifier with
// 5-LLM-call pipeline. Self-contained modal: form → loading → result.
// Input language auto-routes output (CN goal → CN chain). Per CLAUDE.md
// 千金 register: italic Garamond, brass palette, no jargon, no model internals.

function ChainPlannerView({ open, onClose }) {
  const [stage, setStage] = React.useState('form');
  const [progressStage, setProgressStage] = React.useState(null);
  const [goal, setGoal] = React.useState('');
  const [weeks, setWeeks] = React.useState(12);
  const [daily, setDaily] = React.useState(2);
  const [consistency, setConsistency] = React.useState(3);
  const [failed, setFailed] = React.useState(0);
  const [background, setBackground] = React.useState('');
  const [result, setResult] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    if (!open) {
      setStage('form'); setProgressStage(null); setGoal(''); setWeeks(12);
      setDaily(2); setConsistency(3); setFailed(0); setBackground('');
      setResult(null); setError(null);
    }
  }, [open]);

  if (!open) return null;

  const isCN = /[一-龥]/.test(goal);
  const t = (zh, en) => isCN ? zh : en;

  // Lacquer Loop W7 v1.1 — feed RuntimeSubstrate so VinylSpinner / future motion
  // components can etch in time with chain-pipeline progress.
  const CHAIN_STAGE_CURE = {
    'classifying': 0.2,
    'estimating-prior': 0.55,
    'planning-chain': 0.85,
    'done': 1.0,
    'error': 0,
  };

  const submit = async () => {
    if (!goal.trim()) return;
    setStage('loading');
    setError(null);
    let unsub = null;
    try {
      if (window.ptor && window.ptor.hypha && window.ptor.hypha.onChainProgress) {
        unsub = window.ptor.hypha.onChainProgress((p) => {
          if (p && p.stage) {
            setProgressStage(p.stage);
            if (window.RuntimeSubstrate && CHAIN_STAGE_CURE[p.stage] !== undefined) {
              window.RuntimeSubstrate.set({ a1Cure: CHAIN_STAGE_CURE[p.stage] });
            }
          }
        });
      }
      const r = await window.ptor.hypha.chainCreate({
        goal: goal.trim(),
        timeWeeks: Number(weeks),
        dailyHours: Number(daily),
        priorConsistency: Number(consistency),
        failedAttempts: Number(failed),
        answers: background.trim() ? [{ question: '现状背景 / Background', answer: background.trim() }] : [],
      });
      if (unsub) unsub();
      if (r && r.ok) { setResult(r.data); setStage('result'); }
      else { setError((r && r.error) || 'unknown error'); setStage('error'); }
    } catch (e) { if (unsub) unsub(); setError(e.message); setStage('error'); }
  };

  // ─── Layout ───────────────────────────────────────────────────────────────

  const backdrop = {
    position: 'fixed', inset: 0, zIndex: 9000,
    background: 'color-mix(in srgb, var(--bg-base) 75%, transparent)',
    backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 32,
  };
  const panel = {
    width: 'min(720px, 100%)', maxHeight: '92vh', overflow: 'auto',
    background: 'var(--bg-modal-card)',
    border: '1px solid color-mix(in srgb, var(--brass-mid) 22%, transparent)',
    borderRadius: 4,
    boxShadow:
      'inset 0 1px 0 color-mix(in srgb, var(--brass-bright) 18%, transparent), ' +
      '0 24px 48px -8px rgba(0, 0, 0, 0.55), ' +
      '0 6px 16px rgba(0, 0, 0, 0.22)',
    padding: '28px 36px 32px',
    fontFamily: '"EB Garamond", "Noto Serif SC", "Cormorant Garamond", Georgia, serif',
    color: 'var(--ink-primary)',
  };

  const header = (
    <div style={{ marginBottom: 18, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
      <span style={{ fontStyle: 'italic', fontSize: 22, color: 'var(--ink-title)' }}>
        {t('谋一条学习链', 'plan a learning chain')}
      </span>
      <button onClick={onClose} style={{
        background: 'transparent', border: 'none', cursor: 'pointer',
        color: 'var(--ink-faint)', fontFamily: '"EB Garamond", serif',
        fontStyle: 'italic', fontSize: 14, padding: '4px 8px',
      }}>{t('关闭', 'close')}</button>
    </div>
  );

  // ─── Form ────────────────────────────────────────────────────────────────
  if (stage === 'form') {
    const labelStyle = { display: 'block', fontStyle: 'italic', fontSize: 13.5, color: 'var(--ink-faint)', marginBottom: 4, marginTop: 14 };
    const inputStyle = {
      width: '100%', background: 'transparent',
      color: 'var(--ink-title)',
      border: 'none',
      borderBottom: '1px solid color-mix(in srgb, var(--brass-mid) 32%, transparent)',
      fontFamily: '"EB Garamond", "Noto Serif SC", serif',
      fontStyle: 'italic', fontSize: 17,
      padding: '4px 0', outline: 'none',
    };
    const numStyle = { ...inputStyle, fontSize: 15, width: 80, textAlign: 'center' };
    const row = { display: 'flex', gap: 28, marginTop: 10 };
    return (
      <div style={backdrop} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div style={panel}>
          {header}
          <p style={{ fontStyle: 'italic', fontSize: 13.5, color: 'var(--ink-faint)', margin: '0 0 10px', lineHeight: 1.6 }}>
            {t(
              '把一个野心目标拆成可执行的前置链条。先填目标，再答几个问题，看看时间够不够。',
              'turn an ambitious goal into a sequence of bridging steps. answer a few questions, see if time fits.'
            )}
          </p>

          <label style={labelStyle}>{t('终极目标', 'ultimate goal')}</label>
          {/* intentional-placeholder: HTML input hint-text attribute, not a lazy stub */}
          <input autoFocus value={goal} onChange={e => setGoal(e.target.value)}
            placeholder={t('例：拥有YC训练营中的独角兽思想和创意', 'e.g. master transformer architecture from atoms')}
            style={inputStyle} />

          <div style={row}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>{t('时间预算（周）', 'time budget (weeks)')}</label>
              <select value={weeks} onChange={e => setWeeks(Number(e.target.value))} style={numStyle}>
                {[2, 4, 8, 12, 16, 26, 39, 52].map(w => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>{t('每日投入（小时；Newport 上限 4）', 'daily hours (Newport ceiling 4)')}</label>
              <select value={daily} onChange={e => setDaily(Number(e.target.value))} style={numStyle}>
                {[0.5, 1, 1.5, 2, 3, 4, 6, 8].map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
          </div>

          <div style={row}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>{t('过去 60 天每周真正学 >2h 的天数', 'days/week studied >2h (last 60 days)')}</label>
              <select value={consistency} onChange={e => setConsistency(Number(e.target.value))} style={numStyle}>
                {[0, 1, 2, 3, 4, 5, 6, 7].map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>{t('过去对此目标的失败次数', 'prior failed attempts')}</label>
              <select value={failed} onChange={e => setFailed(Number(e.target.value))} style={numStyle}>
                {[0, 1, 2, 3].map(n => <option key={n} value={n}>{n}{n === 3 ? '+' : ''}</option>)}
              </select>
            </div>
          </div>

          <label style={labelStyle}>{t('现状背景（可选；越具体函数越准）', 'starting background (optional; more specific = better)')}</label>
          {/* intentional-placeholder: HTML textarea hint-text attribute, not a lazy stub */}
          <textarea value={background} onChange={e => setBackground(e.target.value)}
            rows={3}
            placeholder={t('例：CS本科毕业，做过2年前端，没碰过 ML 论文，能读英文', 'e.g. CS undergrad, 2y frontend dev, never read ML papers, can read English')}
            style={{ ...inputStyle, fontSize: 14, resize: 'vertical', minHeight: 60, lineHeight: 1.5, fontStyle: 'normal' }} />

          <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end', gap: 16 }}>
            <button onClick={onClose} style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--ink-faint)', fontStyle: 'italic', fontSize: 14,
              fontFamily: '"EB Garamond", serif', padding: '8px 12px',
            }}>{t('取消', 'cancel')}</button>
            <button onClick={submit} disabled={!goal.trim()} style={{
              background: goal.trim() ? 'color-mix(in srgb, var(--brass-mid) 22%, transparent)' : 'transparent',
              border: '1px solid color-mix(in srgb, var(--brass-mid) 38%, transparent)',
              borderRadius: 2, cursor: goal.trim() ? 'pointer' : 'not-allowed',
              color: 'var(--ink-title)', fontStyle: 'italic', fontSize: 15,
              fontFamily: '"EB Garamond", serif', padding: '8px 22px',
              opacity: goal.trim() ? 1 : 0.5,
              transition: 'background 220ms, opacity 220ms',
            }}>{t('开始 →', 'plan →')}</button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Loading ──────────────────────────────────────────────────────────────
  if (stage === 'loading') {
    const stageLabelCN = {
      'classifying': '判定难度与认知负荷…',
      'estimating-prior': '估算起点…',
      'planning-chain': '设计学习链…',
    };
    const stageLabelEN = {
      'classifying': 'classifying difficulty + load…',
      'estimating-prior': 'estimating starting point…',
      'planning-chain': 'designing chain…',
    };
    const label = (isCN ? stageLabelCN : stageLabelEN)[progressStage] || (isCN ? '正在思考…' : 'thinking…');
    return (
      <div style={backdrop}>
        <div style={panel}>
          {header}
          <div style={{ padding: '40px 0', textAlign: 'center', fontStyle: 'italic', fontSize: 16, color: 'var(--ink-muted)' }}>
            {label}
          </div>
        </div>
      </div>
    );
  }

  // ─── Error ────────────────────────────────────────────────────────────────
  if (stage === 'error') {
    return (
      <div style={backdrop}>
        <div style={panel}>
          {header}
          <div style={{ padding: 20, color: 'var(--verdict-flag, #c44)', fontStyle: 'italic' }}>
            {t('生成失败：', 'generation failed: ')}{error || 'unknown'}
          </div>
          <button onClick={() => setStage('form')} style={{
            background: 'transparent', border: '1px solid color-mix(in srgb, var(--brass-mid) 38%, transparent)',
            color: 'var(--ink-title)', cursor: 'pointer', padding: '6px 16px',
            fontFamily: '"EB Garamond", serif', fontStyle: 'italic', fontSize: 14, borderRadius: 2,
          }}>{t('返回', 'back')}</button>
        </div>
      </div>
    );
  }

  // ─── Result ───────────────────────────────────────────────────────────────
  if (stage === 'result' && result) {
    const v = result.feasibility || {};
    const tierColor = v.tier === 'easy' ? 'var(--brass-bright)'
      : v.tier === 'possible' ? 'var(--brass-mid)'
      : 'var(--verdict-flag, #c44)';
    const tierLabel = v.config && v.config.label_zh ? (isCN ? v.config.label_zh : v.tier) : v.tier;
    const gapMult = (v.hoursAvailable > 0) ? Math.round(v.hoursNeeded / v.hoursAvailable) : '∞';
    const adviceCN = {
      'nearly-impossible': '太挤——拉长时间或换更具体目标。',
      'possible': '可达——稳定执行，前置阶段会累。',
      'easy': '时间充裕——可以加深探索或拔目标。',
    };
    const links = (result.chain && result.chain.links) || [];
    const warning = result.chain && result.chain.warning;
    const alts = result.chain && result.chain.alternatives;
    const plans = result.plans || [];
    const liftedPlans = plans.filter(p => p.shape !== 'baseline' && p.classification.tier !== v.tier);
    const roleColor = (role) => role === 'ultimate' ? 'var(--ink-title)' : role === 'core' ? 'var(--brass-mid)' : 'var(--ink-muted)';
    const roleLabelCN = { 'prerequisite': '前置', 'core': '核心', 'ultimate': '终点' };
    const shapeLabelsCN = {
      'compress-target': '降低目标 30%',
      'extend-time': '时间 ×2',
      'intensify-daily': '每日提到 4h',
      'pivot-easier-domain': '换更具体的子领域',
    };

    return (
      <div style={backdrop}>
        <div style={panel}>
          {header}

          {/* Verdict block */}
          <div style={{
            padding: '14px 18px', marginBottom: 18,
            background: 'color-mix(in srgb, ' + tierColor + ' 8%, transparent)',
            border: '1px solid color-mix(in srgb, ' + tierColor + ' 30%, transparent)',
            borderRadius: 3,
          }}>
            <div style={{ fontStyle: 'italic', fontSize: 19, color: tierColor, marginBottom: 6 }}>
              {t('判定：', 'verdict: ')}{tierLabel}
            </div>
            <div style={{ fontSize: 13.5, color: 'var(--ink-muted)', fontStyle: 'italic', lineHeight: 1.6 }}>
              {t(
                `时间需要约 ${v.hoursNeeded} 小时；你能投入约 ${v.hoursAvailable} 小时（缺口 ≈ ${gapMult} 倍）`,
                `~${v.hoursNeeded}h needed / ~${v.hoursAvailable}h available (~${gapMult}x gap)`
              )}
            </div>
            <div style={{ fontSize: 13.5, color: 'var(--ink-muted)', fontStyle: 'italic', marginTop: 2 }}>
              {t('完成率估算约 ', 'est. completion rate ≈ ')}{Math.round((v.pComplete || 0) * 100)}%
            </div>
            <div style={{ fontSize: 13, color: 'var(--ink-faint)', fontStyle: 'italic', marginTop: 8 }}>
              {isCN ? adviceCN[v.tier] : (v.config && v.config.advice)}
            </div>
          </div>

          {/* Lifting plans */}
          {liftedPlans.length > 0 && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontStyle: 'italic', fontSize: 14, color: 'var(--ink-muted)', marginBottom: 6 }}>
                {t('能拉上一档的备选：', 'alternatives that lift the tier:')}
              </div>
              {liftedPlans.map((p, i) => (
                <div key={i} style={{ fontSize: 13.5, color: 'var(--ink-primary)', fontStyle: 'italic', marginLeft: 10 }}>
                  ↑ {isCN ? (shapeLabelsCN[p.shape] || p.shape) : p.shape}
                  <span style={{ color: 'var(--ink-faint)', marginLeft: 8 }}>
                    → {p.classification.config.label_zh}  ({Math.round((p.classification.pComplete || 0) * 100)}%)
                  </span>
                </div>
              ))}
            </div>
          )}
          {plans.length > 0 && liftedPlans.length === 0 && v.tier !== 'easy' && (
            <div style={{
              fontSize: 13, color: 'var(--verdict-flag, #c44)',
              fontStyle: 'italic', marginBottom: 18, lineHeight: 1.5,
            }}>
              {t(
                '没有任何单一调整能把档位拉上去——需要复合（如同时拉时间 + 提目标具体度）。',
                'no single lever changes the tier — needs combined adjustments.'
              )}
            </div>
          )}

          {/* Chain links */}
          <div style={{ fontStyle: 'italic', fontSize: 16, color: 'var(--ink-title)', marginBottom: 10 }}>
            {t('学习链', 'learning chain')}
          </div>
          {links.map((l, i) => (
            <div key={i} style={{
              padding: '10px 14px', marginBottom: 8,
              background: 'color-mix(in srgb, var(--brass-mid) 5%, transparent)',
              borderLeft: '2px solid ' + roleColor(l.role),
            }}>
              <div style={{ fontStyle: 'italic', fontSize: 16, color: roleColor(l.role) }}>
                {(i + 1)}. {l.topic}
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-faint)', fontStyle: 'italic', marginTop: 2 }}>
                {l.duration_weeks}{t('周', 'w')} · {isCN ? (roleLabelCN[l.role] || l.role) : l.role}
              </div>
              {l.rationale && (
                <div style={{ fontSize: 13, color: 'var(--ink-muted)', fontStyle: 'italic', marginTop: 6, lineHeight: 1.5 }}>
                  {t('原因：', 'why: ')}{l.rationale}
                </div>
              )}
              {l.exit_criterion && (
                <div style={{ fontSize: 13, color: 'var(--ink-muted)', fontStyle: 'italic', marginTop: 4, lineHeight: 1.5 }}>
                  {t('过关：', 'exit: ')}{l.exit_criterion}
                </div>
              )}
            </div>
          ))}

          {/* Warning + alternatives */}
          {warning && (
            <div style={{
              marginTop: 14, padding: '10px 14px',
              background: 'color-mix(in srgb, var(--verdict-flag, #c44) 10%, transparent)',
              border: '1px solid color-mix(in srgb, var(--verdict-flag, #c44) 30%, transparent)',
              borderRadius: 3,
              fontSize: 13, color: 'var(--ink-primary)', fontStyle: 'italic', lineHeight: 1.5,
            }}>
              ⚠ {warning}
              {alts && alts.extend_time_to_weeks && (
                <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--ink-muted)' }}>
                  · {t('改 ', 'extend to ')}{alts.extend_time_to_weeks}{t(' 周', ' weeks')}
                </div>
              )}
              {alts && alts.lower_target_to && (
                <div style={{ marginTop: 4, fontSize: 12.5, color: 'var(--ink-muted)' }}>
                  · {t('换目标：', 'lower target: ')}"{alts.lower_target_to}"
                </div>
              )}
            </div>
          )}

          <div style={{ marginTop: 22, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--ink-faint)', fontStyle: 'italic' }}>
              {t('已存：', 'saved: ')}{result.slug}/chain.json
            </span>
            <button onClick={onClose} style={{
              background: 'color-mix(in srgb, var(--brass-mid) 22%, transparent)',
              border: '1px solid color-mix(in srgb, var(--brass-mid) 38%, transparent)',
              borderRadius: 2, cursor: 'pointer',
              color: 'var(--ink-title)', fontStyle: 'italic', fontSize: 14,
              fontFamily: '"EB Garamond", serif', padding: '7px 18px',
            }}>{t('完成', 'done')}</button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

window.ChainPlannerView = ChainPlannerView;
