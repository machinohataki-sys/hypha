/* global React, ReactDOM */
// Hypha Lacquer Loop W7 — Learning Chain Planner UI.
// Council-designed (Yogo + Leo + Scout 2026-05-01) feasibility classifier with
// 5-LLM-call pipeline. Self-contained modal: form → loading → result.
// Input language auto-routes output (CN goal → CN chain). Per CLAUDE.md
// 千金 register: italic Garamond, brass palette, no jargon, no model internals.

// Per user feedback 2026-05-01: chain is NOT a process to fill out; it's a
// RESULT computed from welcome-form data already collected (topic + goal +
// timeCommit + clarifications, all in <slug>/state.json or pre-create form
// state). The 7-field form was redundant. The view now accepts `context`
// from the caller and immediately enters loading → result.
function ChainPlannerView({ open, onClose, context }) {
  const [stage, setStage] = React.useState('loading');   // 'loading' | 'result' | 'error'
  const [progressStage, setProgressStage] = React.useState(null);
  const [result, setResult] = React.useState(null);
  const [error, setError] = React.useState(null);

  // v0.5.2 — Accept / Refuse 2-strike state.
  // acceptStage: null | 'loading' | 'error' — accept-button flow.
  // refuseStage: null | 'reason' — refuse 1st-strike opens checklist; 2nd-strike cancels.
  // checklistFlags: array of unchecked assumption ids.
  // refuseReason: free-form textarea value.
  // replanStage: null | 'loading' | 'error' — submitting refusal & re-planning.
  const [acceptStage, setAcceptStage] = React.useState(null);
  const [acceptError, setAcceptError] = React.useState(null);
  const [refuseStage, setRefuseStage] = React.useState(null);
  const [checklistFlags, setChecklistFlags] = React.useState([]);
  const [refuseReason, setRefuseReason] = React.useState('');
  const [replanStage, setReplanStage] = React.useState(null);
  const [replanError, setReplanError] = React.useState(null);

  // Reset on close.
  React.useEffect(() => {
    if (!open) {
      setStage('loading'); setProgressStage(null); setResult(null); setError(null);
      setAcceptStage(null); setAcceptError(null);
      setRefuseStage(null); setChecklistFlags([]); setRefuseReason('');
      setReplanStage(null); setReplanError(null);
    }
  }, [open]);

  // Detect language from welcome-form goal so output matches input register.
  const isCN = !!(context && /[一-龥]/.test(String(context.goal || '') + String(context.topic || '')));
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

  // Map welcome form's timeCommit to chain weeks. Defaults err on the
  // generous side so feasibility verdicts aren't unfairly tight.
  const timeCommitToWeeks = (tc) => {
    switch (tc) {
      case 'a-week':     return 1;
      case 'a-month':    return 4;
      case 'week':       return 1;        // legacy
      case 'month':      return 4;        // legacy
      case '3-months':   return 12;
      case 'open-ended': return 24;
      default:           return 12;
    }
  };

  const submitWithContext = React.useCallback(async (ctx) => {
    if (!ctx) return;
    const goalStr = (ctx.goal || ctx.topic || '').trim();
    if (!goalStr) {
      setError('no goal provided'); setStage('error'); return;
    }
    setStage('loading');
    setProgressStage(null);
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
      // Derive params from welcome-form context. dailyHours / consistency /
      // failedAttempts get sensible defaults — the welcome form did not ask
      // for them, and asking again here is exactly what the user rejected.
      const answers = [];
      if (Array.isArray(ctx.clarifications) && ctx.clarifications.length) {
        for (const cl of ctx.clarifications) {
          if (cl && cl.question && cl.answer) {
            answers.push({ question: cl.question, answer: cl.answer });
          }
        }
      }
      const r = await window.ptor.hypha.chainCreate({
        goal: goalStr,
        timeWeeks: timeCommitToWeeks(ctx.timeCommit),
        dailyHours: 2,
        priorConsistency: 3,
        failedAttempts: 0,
        answers,
      });
      if (unsub) unsub();
      if (r && r.ok) { setResult(r.data); setStage('result'); }
      else { setError((r && r.error) || 'unknown error'); setStage('error'); }
    } catch (e) {
      if (unsub) unsub();
      setError(e.message); setStage('error');
    }
  }, []);

  // Auto-fire on open with context.
  React.useEffect(() => {
    if (open && context) submitWithContext(context);
  }, [open, context, submitWithContext]);

  // ─── Accept / Refuse handlers (v0.5.2) ───────────────────────────────────
  // Accept → fire chain:accept with covenant snapshot, show loader, on success
  // dispatch hypha:open-rel and close modal.
  const handleAccept = React.useCallback(async () => {
    if (!result || !result.slug) return;
    setAcceptStage('loading');
    setAcceptError(null);
    try {
      // Pull a fresh user-profile snapshot so the covenant captures the
      // student's baseline at acceptance time.
      let userProfile = null;
      try {
        if (window.ptor && window.ptor.hypha && window.ptor.hypha.profileGet) {
          const p = await window.ptor.hypha.profileGet();
          userProfile = (p && p.ok) ? (p.data || p.profile || null) : null;
        }
      } catch (_) { userProfile = null; }
      const covenantSnapshot = {
        acceptedAt: new Date().toISOString(),
        userProfile,
        checklistChoices: [],
        freeFormReason: null,
      };
      if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.chainAccept) {
        throw new Error('chainAccept IPC unavailable');
      }
      const r = await window.ptor.hypha.chainAccept({
        slug: result.slug,
        covenantSnapshot,
      });
      if (r && r.ok && r.lessonRel) {
        try {
          window.dispatchEvent(new CustomEvent('hypha:open-rel', { detail: { rel: r.lessonRel } }));
        } catch (_) {}
        setAcceptStage(null);
        if (typeof onClose === 'function') onClose();
      } else {
        setAcceptStage('error');
        setAcceptError((r && r.error) || 'unknown error');
      }
    } catch (e) {
      setAcceptStage('error');
      setAcceptError((e && e.message) || String(e));
    }
  }, [result, onClose]);

  // Refuse-button click. 1st click: open reason stage. 2nd click (already in
  // reason stage): treat as cancel — fire chain:refuse with empty reason, close.
  const handleRefuseClick = React.useCallback(async () => {
    if (!result || !result.slug) return;
    if (refuseStage !== 'reason') {
      setRefuseStage('reason');
      return;
    }
    // 2nd strike — cancel.
    setReplanStage('loading');
    setReplanError(null);
    try {
      if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.chainRefuse) {
        throw new Error('chainRefuse IPC unavailable');
      }
      const r = await window.ptor.hypha.chainRefuse({
        slug: result.slug, reason: null, checklistFlags: [],
      });
      if (r && r.ok && r.mode === 'cancelled') {
        setReplanStage(null);
        if (typeof onClose === 'function') onClose();
      } else {
        setReplanStage('error');
        setReplanError((r && r.error) || 'unknown error');
      }
    } catch (e) {
      setReplanStage('error');
      setReplanError((e && e.message) || String(e));
    }
  }, [result, refuseStage, onClose]);

  // Submit refusal with reason → backend re-plans. On success replace result
  // with the new plan and reset refuse-state so user can Accept/Refuse again.
  const handleSubmitRefusal = React.useCallback(async () => {
    if (!result || !result.slug) return;
    setReplanStage('loading');
    setReplanError(null);
    try {
      if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.chainRefuse) {
        throw new Error('chainRefuse IPC unavailable');
      }
      const r = await window.ptor.hypha.chainRefuse({
        slug: result.slug,
        reason: (refuseReason || '').trim() || null,
        checklistFlags: Array.isArray(checklistFlags) ? checklistFlags : [],
      });
      if (r && r.ok) {
        if (r.mode === 'cancelled') {
          setReplanStage(null);
          if (typeof onClose === 'function') onClose();
          return;
        }
        if (r.newPlan) {
          // Replace current chain result with new plan; reset refuse state.
          setResult(r.newPlan);
          setRefuseStage(null);
          setChecklistFlags([]);
          setRefuseReason('');
          setReplanStage(null);
          return;
        }
        // No newPlan returned but ok — surface as error so user isn't stranded.
        setReplanStage('error');
        setReplanError('backend did not return a new plan');
      } else {
        setReplanStage('error');
        setReplanError((r && r.error) || 'unknown error');
      }
    } catch (e) {
      setReplanStage('error');
      setReplanError((e && e.message) || String(e));
    }
  }, [result, refuseReason, checklistFlags, onClose]);

  // Cancel-this-plan instead → 2nd-strike cancel from inside the reason stage.
  const handleCancelInstead = React.useCallback(async () => {
    if (!result || !result.slug) return;
    setReplanStage('loading');
    setReplanError(null);
    try {
      if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.chainRefuse) {
        throw new Error('chainRefuse IPC unavailable');
      }
      const r = await window.ptor.hypha.chainRefuse({
        slug: result.slug, reason: null, checklistFlags: [],
      });
      if (r && r.ok && r.mode === 'cancelled') {
        setReplanStage(null);
        if (typeof onClose === 'function') onClose();
      } else {
        setReplanStage('error');
        setReplanError((r && r.error) || 'unknown error');
      }
    } catch (e) {
      setReplanStage('error');
      setReplanError((e && e.message) || String(e));
    }
  }, [result, onClose]);

  const toggleChecklistFlag = React.useCallback((id) => {
    setChecklistFlags((prev) => {
      const arr = Array.isArray(prev) ? prev : [];
      return arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id];
    });
  }, []);

  if (!open) return null;

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

  // Form stage was deleted 2026-05-01: chain is a result computed from
  // welcome-form data already collected, not a separate questionnaire.

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
          <button onClick={() => { if (context) submitWithContext(context); else onClose(); }} style={{
            background: 'transparent', border: '1px solid color-mix(in srgb, var(--brass-mid) 38%, transparent)',
            color: 'var(--ink-title)', cursor: 'pointer', padding: '6px 16px',
            fontFamily: '"EB Garamond", serif', fontStyle: 'italic', fontSize: 14, borderRadius: 2,
          }}>{t('重试', 'retry')}</button>
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

          {/* ─── v0.5.2 Accept / Refuse 2-strike ──────────────────────── */}
          {/* Plan-assumption checklist items derived from the current chain.
              User unchecks any that are wrong; backend uses these flags +
              free-form reason to steer the re-plan. */}
          {(() => {
            const planTimeWeeks = (context && timeCommitToWeeks(context.timeCommit)) || null;
            const checklistItems = [
              {
                id: 'time-budget',
                label: t(
                  `时间预算（${planTimeWeeks || '？'} 周）合适`,
                  `Time budget (${planTimeWeeks || '?'} weeks) is right`
                ),
              },
              {
                id: 'prereq-order',
                label: t('前置顺序合理', 'Prerequisite order is right'),
              },
              {
                id: 'final-goal',
                label: t('最终目标的措辞合适', 'Final goal phrasing is right'),
              },
              {
                id: 'scope',
                label: t('范围合适', 'Scope is right'),
              },
            ];

            // Refuse-reason stage: render checklist + textarea + submit/cancel.
            if (refuseStage === 'reason') {
              return (
                <div style={{ marginTop: 22 }}>
                  <div style={{
                    fontStyle: 'italic', fontSize: 14, color: 'var(--ink-muted)',
                    marginBottom: 10, lineHeight: 1.5,
                  }}>
                    {t(
                      '把不合适的项取消勾选，再说一句你想改的方向。',
                      'Uncheck what is wrong, then add a line about what you want changed.'
                    )}
                  </div>

                  {/* Plan-assumption checklist. Items start checked. Unchecking
                      flags the item as wrong → backend uses the flag list to
                      steer planChain on re-run. */}
                  <div style={{ marginBottom: 14 }}>
                    {checklistItems.map((item) => {
                      const flagged = checklistFlags.includes(item.id);
                      const checked = !flagged;
                      return (
                        <label key={item.id} style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '6px 4px', cursor: 'pointer',
                          fontStyle: 'italic', fontSize: 14,
                          color: checked ? 'var(--ink-primary)' : 'var(--ink-faint)',
                          textDecoration: checked ? 'none' : 'line-through',
                          textDecorationColor: 'color-mix(in srgb, var(--ink-faint) 60%, transparent)',
                        }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleChecklistFlag(item.id)}
                            style={{
                              accentColor: 'var(--brass-mid)',
                              width: 14, height: 14, cursor: 'pointer',
                            }}
                          />
                          <span>{item.label}</span>
                        </label>
                      );
                    })}
                  </div>

                  {/* Free-form reason. */}
                  <textarea
                    value={refuseReason}
                    onChange={(e) => setRefuseReason(e.target.value)}
                    placeholder={t('还想说点什么？', 'Anything else to flag?')}
                    rows={3}
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      background: 'color-mix(in srgb, var(--brass-mid) 4%, transparent)',
                      border: '1px solid color-mix(in srgb, var(--brass-mid) 22%, transparent)',
                      borderRadius: 2, padding: '8px 10px',
                      fontFamily: '"EB Garamond", "Noto Serif SC", "Cormorant Garamond", Georgia, serif',
                      fontStyle: 'italic', fontSize: 14,
                      color: 'var(--ink-primary)',
                      resize: 'vertical', outline: 'none',
                    }}
                  />

                  {/* Replan in-flight feedback. */}
                  {replanStage === 'loading' && (
                    <div style={{
                      marginTop: 14, fontStyle: 'italic', fontSize: 14,
                      color: 'var(--ink-muted)', textAlign: 'center',
                    }}>
                      {t('正在重新设计…', 're-planning…')}
                    </div>
                  )}
                  {replanStage === 'error' && (
                    <div style={{
                      marginTop: 12, fontStyle: 'italic', fontSize: 13,
                      color: 'var(--verdict-flag, #c44)',
                    }}>
                      {t('重新设计失败：', 're-plan failed: ')}{replanError || 'unknown'}
                    </div>
                  )}

                  <div style={{
                    marginTop: 18, display: 'flex',
                    justifyContent: 'space-between', alignItems: 'center', gap: 12,
                  }}>
                    <button
                      onClick={handleCancelInstead}
                      disabled={replanStage === 'loading'}
                      style={{
                        background: 'transparent', border: 'none', padding: '4px 0',
                        cursor: replanStage === 'loading' ? 'default' : 'pointer',
                        color: 'var(--ink-faint)',
                        fontFamily: '"EB Garamond", serif',
                        fontStyle: 'italic', fontSize: 13,
                        opacity: replanStage === 'loading' ? 0.5 : 1,
                      }}
                    >{t('改为取消此计划', 'Cancel this plan instead')}</button>

                    <button
                      onClick={handleSubmitRefusal}
                      disabled={replanStage === 'loading'}
                      style={{
                        background: 'color-mix(in srgb, var(--brass-mid) 22%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--brass-mid) 42%, transparent)',
                        borderRadius: 2,
                        cursor: replanStage === 'loading' ? 'default' : 'pointer',
                        color: 'var(--ink-title)',
                        fontFamily: '"EB Garamond", serif',
                        fontStyle: 'italic', fontSize: 14,
                        padding: '7px 18px',
                        opacity: replanStage === 'loading' ? 0.6 : 1,
                      }}
                    >{t('提交并重新设计', 'Submit refusal & re-plan')}</button>
                  </div>
                </div>
              );
            }

            // Default — Accept / Refuse row.
            return (
              <div style={{
                marginTop: 22, display: 'flex',
                justifyContent: 'space-between', alignItems: 'center', gap: 14,
              }}>
                <span style={{
                  fontSize: 12, color: 'var(--ink-faint)', fontStyle: 'italic',
                  flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {t('已存：', 'saved: ')}{result.slug}/chain.json
                </span>

                {/* Accept-flow inline state. */}
                {acceptStage === 'loading' ? (
                  <span style={{
                    fontStyle: 'italic', fontSize: 14, color: 'var(--ink-muted)',
                  }}>{t('正在准备第一节…', 'preparing your first course…')}</span>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
                    {/* Refuse — italic ink-faint, no fill, underline on hover. */}
                    <button
                      onClick={handleRefuseClick}
                      disabled={replanStage === 'loading'}
                      onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
                      style={{
                        background: 'transparent', border: 'none', padding: '4px 2px',
                        cursor: replanStage === 'loading' ? 'default' : 'pointer',
                        color: 'var(--ink-faint)',
                        fontFamily: '"EB Garamond", "Cormorant Garamond", serif',
                        fontStyle: 'italic', fontSize: 14,
                        textDecorationColor: 'color-mix(in srgb, var(--ink-faint) 60%, transparent)',
                        opacity: replanStage === 'loading' ? 0.5 : 1,
                      }}
                    >{t('拒绝', 'Refuse')}</button>

                    {/* Accept — filled brass-bright, italic Garamond. */}
                    <button
                      onClick={handleAccept}
                      disabled={acceptStage === 'loading'}
                      style={{
                        background: 'var(--brass-bright)',
                        border: '1px solid color-mix(in srgb, var(--brass-bright) 75%, var(--ink-title))',
                        borderRadius: 2,
                        cursor: 'pointer',
                        color: 'var(--bg-base)',
                        fontFamily: '"EB Garamond", "Cormorant Garamond", serif',
                        fontStyle: 'italic', fontSize: 15,
                        padding: '8px 22px',
                        boxShadow: 'inset 0 1px 0 color-mix(in srgb, #fff 22%, transparent)',
                      }}
                    >{t('接受', 'Accept')}</button>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Accept error — surfaced inline below the button row. */}
          {acceptStage === 'error' && (
            <div style={{
              marginTop: 12, fontStyle: 'italic', fontSize: 13,
              color: 'var(--verdict-flag, #c44)', textAlign: 'right',
            }}>
              {t('启动失败：', 'failed to start: ')}{acceptError || 'unknown'}
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}

window.ChainPlannerView = ChainPlannerView;
