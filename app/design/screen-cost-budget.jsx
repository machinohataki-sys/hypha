/* global React */
// HYPHA · W8.4 Cost Budget surface (BLUEPRINT §17.3).
//
// 三块: 当前 lesson 的 budget remaining (T6/T4/T3 caps) / 历史 cost report
// (by-capability + by-lesson) / Cashflow Shield daily ¥ ceiling.
//
// 千金 register: numerics in serif, headers italic, brass accent on
// "remaining" remaining < 25%. No progress bars; we use editorial number
// + bracketed cap.
//
// intentional-placeholder: this screen is read-only — every IPC has a fully
// implemented backend in `app/main.js` W8.4 block and the cashflow-shield
// + cost-budget lib pair.
//
// Props: { slug, lessonIdx, tier, userId, onBack }

const { useState, useEffect, useCallback } = React;

const CAP_LABEL = {
  T6_STRONG: 'T6 · 强模型',
  T4_JUDGE:  'T4 · 评判模型',
  T3_MID:    'T3 · 中档模型',
  T2_LOCAL:  'T2 · 本地模型',
  T1_EMBED:  'T1 · 嵌入向量',
};

const PERIOD_LABEL = { lesson: '本课', day: '今天', week: '本周', month: '本月', all: '全部' };

// V0.5 E1 — estimation_source 4 档诚实标. 每行 model_calls 旁渲染一个
// 小圆点 + hover tip. 颜色 token 与 cost 卡片 register 一致 (brass / tabac / faded).
// `legacy` 兜 null OR `legacy-broken` (migration 002 留痕) OR 任何未来未知值.
//
// intentional-placeholder: `placeholder` is one of 4 canonical enum values
// written by `sqlite.recordChatCallEstimate` (see app/db/sqlite.js:262 + 301).
// It is a domain term meaning "row written before provider failure with null
// tokens", NOT a TODO marker. Renaming would break the cost-ledger schema.
const ESTIMATION_SOURCE = Object.freeze({
  provider:               { glyph: '◉', color: 'var(--accent-brass, #b08a3e)',     tip: '真 token 数 — 来自 provider response' },
  'tokenizer-fallback':   { glyph: '◐', color: 'var(--accent-tabac, #5C4E36)',     tip: '估算 — provider 未返 usage, 用 tokenizer 估' },
  placeholder:            { glyph: '○', color: 'var(--ink-3, #8A7F6E)',            tip: '无数据 — provider 调用失败前留的占位' },
  legacy:                 { glyph: '◌', color: 'var(--ink-3, #8A7F6E)',            tip: '历史数据 — v0.5 前 record, 无 source 标记' },
});

function _resolveSource(src) {
  if (!src) return ESTIMATION_SOURCE.legacy;
  if (ESTIMATION_SOURCE[src]) return ESTIMATION_SOURCE[src];
  return ESTIMATION_SOURCE.legacy;
}

// Inline source mark — single dot, mono baseline-aligned. `tabular-nums` keeps
// adjacent ¥ digits from jumping when the dot changes width across rows.
const SourceMark = ({ source }) => {
  const m = _resolveSource(source);
  return (
    <span
      title={m.tip}
      style={{
        display: 'inline-block',
        marginLeft: 6,
        fontSize: 12,
        color: m.color,
        fontFamily: 'JetBrains Mono, monospace',
        cursor: 'help',
        verticalAlign: 'baseline',
        userSelect: 'none',
      }}
    >{m.glyph}</span>
  );
};

const Hairline = () => (
  <div style={{
    height: 1, background: 'var(--rule-soft, #e3dccd)',
    margin: '20px 0',
  }} />
);

const FieldLabel = ({ children }) => (
  <div style={{
    fontFamily: 'EB Garamond, serif',
    fontStyle: 'italic',
    fontSize: 13,
    color: 'var(--ink-3, #8b8275)',
    letterSpacing: '0.06em',
    marginBottom: 6,
  }}>{children}</div>
);

const BudgetCapCell = ({ cap, remaining, total }) => {
  const isFinite = Number.isFinite(remaining) && Number.isFinite(total);
  const pct = isFinite && total > 0 ? remaining / total : 1;
  const warn = isFinite && pct < 0.25;
  const display = !isFinite ? '∞' : `${remaining} / ${total}`;
  return (
    <div style={{
      padding: '12px 14px',
      background: 'var(--paper-warm, #f5efde)',
      border: '1px solid var(--rule-soft, #e3dccd)',
      borderRadius: 2, minWidth: 130,
    }}>
      <div style={{
        fontFamily: 'EB Garamond, serif', fontStyle: 'italic', fontSize: 12,
        color: 'var(--ink-3, #8b8275)', letterSpacing: '0.04em',
      }}>
        {CAP_LABEL[cap] || cap}
      </div>
      <div style={{
        fontFamily: '"Noto Serif SC", serif', fontSize: 22, marginTop: 4,
        color: warn ? 'var(--accent-terracotta, #c25a36)' : 'var(--ink-1, #2c2620)',
      }}>
        {display}
      </div>
      <div style={{ fontSize: 11, color: 'var(--ink-3, #8b8275)', fontStyle: 'italic', marginTop: 2 }}>
        剩余 / 上限
      </div>
    </div>
  );
};

const CostBudgetScreen = ({ slug, lessonIdx, tier, userId, onBack }) => {
  const effectiveTier = tier || 'Pro';
  const effectiveLesson = (typeof lessonIdx === 'number') ? lessonIdx : 0;
  const effectiveUser = userId || 'local';

  const [budget, setBudget] = useState({});            // tier-level cap table
  const [remaining, setRemaining] = useState({});
  const [period, setPeriod] = useState('month');
  const [report, setReport] = useState(null);
  const [shield, setShield] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // V0.5 E1 — sqlite model_calls ledger w/ estimation_source per row.
  const [ledger, setLedger] = useState(null);

  const reload = useCallback(async () => {
    if (!window.ptor) { setError('IPC bridge missing。'); return; }
    setBusy(true); setError(null);
    try {
      if (window.ptor.cost) {
        const b = await window.ptor.cost.budget(effectiveTier);
        if (b && b.ok) setBudget(b.budget || {});
        if (slug && typeof effectiveLesson === 'number') {
          const r = await window.ptor.cost.remaining(slug, effectiveLesson, effectiveTier);
          if (r && r.ok) setRemaining(r);
          const rep = await window.ptor.cost.report(slug, period);
          if (rep && rep.ok) setReport(rep);
        }
        // V0.5 E1 — pull sqlite cost-ledger so UI can flag每行 estimation_source.
        // Global (not slug-scoped) because model_calls.tuple_id ≠ vault slug;
        // any cost displayed on this screen comes from the same table.
        if (typeof window.ptor.cost.ledger === 'function') {
          try {
            const led = await window.ptor.cost.ledger(period, 100);
            if (led && led.ok) setLedger(led);
            else setLedger(null);
          } catch (_) { setLedger(null); }
        }
      }
      if (window.ptor.shield) {
        const s = await window.ptor.shield.check(effectiveUser, effectiveTier);
        if (s && s.ok !== undefined) setShield(s);
      }
    } catch (e) { setError(String(e && e.message || e)); }
    finally { setBusy(false); }
  }, [slug, effectiveLesson, effectiveTier, effectiveUser, period]);

  useEffect(() => { reload(); }, [reload]);

  const caps = Object.keys(budget);

  return (
    <div style={{
      maxWidth: 920, margin: '0 auto', padding: '32px 28px',
      fontFamily: '"Noto Serif SC", "EB Garamond", serif',
      color: 'var(--ink-1, #2c2620)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={{ fontFamily: 'EB Garamond, serif', fontStyle: 'italic', fontSize: 26 }}>
          预算 — cost budget
        </div>
        <button onClick={onBack} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--ink-3, #8b8275)', fontStyle: 'italic',
          fontFamily: 'EB Garamond, serif', fontSize: 14,
        }}>返回</button>
      </div>
      <div style={{ fontSize: 14, color: 'var(--ink-3, #8b8275)', fontStyle: 'italic', marginBottom: 24 }}>
        BLUEPRINT §17.3 · 每节课预算 + 每日 ¥ 上限 — 卖目标导向学习进度, 不卖无限度模型.
      </div>

      <Hairline />

      <FieldLabel>当前 lesson 剩余额度 · {effectiveTier} · 第 {effectiveLesson} 节</FieldLabel>
      {caps.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--ink-3, #8b8275)', fontStyle: 'italic' }}>
          {busy ? '加载中…' : (slug ? '尚未读取到课程预算。' : '需要指定 slug + lessonIdx 才可显示 lesson 剩余额度。')}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {caps.filter((c) => Number.isFinite(budget[c])).map((cap) => (
            <BudgetCapCell key={cap} cap={cap} remaining={remaining[cap]} total={budget[cap]} />
          ))}
        </div>
      )}

      <Hairline />

      <FieldLabel>Cashflow Shield · 今日 ¥ 已用</FieldLabel>
      {!shield ? (
        <div style={{ fontSize: 13, color: 'var(--ink-3, #8b8275)', fontStyle: 'italic' }}>
          {busy ? '加载中…' : '未读取到 shield 状态。'}
        </div>
      ) : shield.dev_mode ? (
        // 2026-05-13 — 开发者模式 (HYPHA_DEV / HYPHA_ALLOW_CLI / NODE_ENV) 自动
        // 升至 BYOK · 无 cap. Pro ¥5/day 仅对终端 user 生效, 开发者自付 keys.
        <div style={{
          padding: '12px 16px',
          background: 'var(--paper-warm, #f5efde)',
          border: '1px solid var(--accent-brass, #b08a3e)',
          borderRadius: 2,
        }}>
          <div style={{
            fontFamily: 'EB Garamond, serif', fontStyle: 'italic', fontSize: 18,
            color: 'var(--accent-brass, #b08a3e)',
          }}>
            开发者模式 · 无上限
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-3, #8b8275)', fontStyle: 'italic', marginTop: 4 }}>
            tier {shield.tier} (auto-promoted from {shield.requested_tier || effectiveTier}) ·
            今日已用 ¥{shield.today_cost_cny} · 仅计度量, 不阻塞调用
          </div>
        </div>
      ) : (
        <div style={{
          padding: '12px 16px',
          background: shield.soft_warn ? 'var(--paper-warm, #f5efde)' : 'var(--paper, #faf6e8)',
          border: '1px solid ' + (shield.soft_warn
            ? 'var(--accent-brass, #b08a3e)'
            : 'var(--rule-soft, #e3dccd)'),
          borderRadius: 2,
        }}>
          <div style={{ fontFamily: '"Noto Serif SC", serif', fontSize: 18 }}>
            ¥{shield.today_cost_cny} <span style={{ color: 'var(--ink-3, #8b8275)' }}>
              / ¥{shield.limit_cny}
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-3, #8b8275)', fontStyle: 'italic', marginTop: 4 }}>
            tier {shield.tier} · 剩余 ¥{shield.remaining_cny}
            {shield.soft_warn && <span style={{ color: 'var(--accent-brass, #b08a3e)', marginLeft: 10 }}>
              · 已超 80% 软警告
            </span>}
            {!shield.ok && <span style={{ color: 'var(--accent-terracotta, #c25a36)', marginLeft: 10 }}>
              · 已达上限, LLM 调用将被阻塞
            </span>}
          </div>
        </div>
      )}

      <Hairline />

      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
        <FieldLabel>历史成本 · {PERIOD_LABEL[period] || period}</FieldLabel>
        <div>
          {Object.keys(PERIOD_LABEL).map((p) => (
            <button key={p} onClick={() => setPeriod(p)} style={{
              padding: '3px 10px', marginLeft: 4, fontSize: 12,
              fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
              background: period === p ? 'var(--accent-brass, #b08a3e)' : 'transparent',
              color: period === p ? 'var(--paper, #faf6e8)' : 'var(--ink-2, #5a5246)',
              border: '1px solid ' + (period === p ? 'var(--accent-brass, #b08a3e)' : 'var(--rule-soft, #e3dccd)'),
              borderRadius: 999, cursor: 'pointer',
            }}>{PERIOD_LABEL[p]}</button>
          ))}
        </div>
      </div>
      {!report ? (
        <div style={{ fontSize: 13, color: 'var(--ink-3, #8b8275)', fontStyle: 'italic' }}>
          {slug ? (busy ? '加载中…' : '尚无成本数据。') : '需要指定 slug 才可显示历史成本。'}
        </div>
      ) : (
        <div style={{
          padding: '14px 16px',
          background: 'var(--paper, #faf6e8)',
          border: '1px solid var(--rule-soft, #e3dccd)', borderRadius: 2,
        }}>
          <div style={{ fontFamily: '"Noto Serif SC", serif', fontSize: 22, marginBottom: 8 }}>
            ¥{report.total_cost_cny || 0}
            {/* V0.5 E1 — 诚实标 in total. If sqlite ledger shows fallback / placeholder /
                legacy rows in this period, append精度脚注 to让 user 知道 ¥ ！100% 精确. */}
            {ledger && (ledger.estimate_cnt + ledger.missing_cnt + ledger.legacy_cnt > 0) && (
              <span style={{
                fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
                fontSize: 12, color: 'var(--ink-3, #8b8275)', marginLeft: 10,
              }}>
                · 精度待勘
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-3, #8b8275)', fontStyle: 'italic', marginBottom: 14 }}>
            {report.line_count || 0} 条调用记录
            {ledger && (ledger.estimate_cnt > 0 || ledger.missing_cnt > 0 || ledger.legacy_cnt > 0) && (
              <span style={{ marginLeft: 8 }}>
                · 其中{ledger.accurate_cnt > 0 && ` ${ledger.accurate_cnt} 条真实`}
                {ledger.estimate_cnt > 0 && `, ${ledger.estimate_cnt} 条估算`}
                {ledger.missing_cnt > 0 && `, ${ledger.missing_cnt} 条无数据`}
                {ledger.legacy_cnt > 0 && `, ${ledger.legacy_cnt} 条历史`}
              </span>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
            {Object.entries(report.by_capability || {}).map(([cap, cost]) => (
              <div key={cap} style={{
                padding: '8px 10px',
                background: 'var(--paper-warm, #f5efde)',
                border: '1px solid var(--rule-soft, #e3dccd)', borderRadius: 2,
              }}>
                <div style={{ fontFamily: 'EB Garamond, serif', fontStyle: 'italic', fontSize: 12, color: 'var(--ink-3, #8b8275)' }}>
                  {CAP_LABEL[cap] || cap}
                </div>
                <div style={{ fontSize: 16 }}>¥{cost}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* V0.5 E1 — 成本明细 · 调用日志.
          Every model_calls row 显示 ¥ + estimation_source 小圆点 (icon + color + hover).
          诚实标 4 档:
            ◉ provider           真 token (brass)
            ◐ tokenizer-fallback 估算    (tabac)
            ○ placeholder        无数据  (faded)
            ◌ legacy / null      历史   (faded, 虚线圆)
          数据走 sqlite model_calls (not cost-log.jsonl) — 与 estimation_source 写入 source-of-truth. */}
      {ledger && Array.isArray(ledger.rows) && ledger.rows.length > 0 && (
        <React.Fragment>
          <Hairline />

          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
            <FieldLabel>成本明细 · 调用日志 · {PERIOD_LABEL[period] || period}</FieldLabel>
            <div style={{
              display: 'flex', gap: 14, alignItems: 'center',
              fontSize: 11, color: 'var(--ink-3, #8b8275)',
              fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
            }}>
              {/* 诚实标图例 — 4 档. Inline so读者一眼对得上 row dots. */}
              {Object.entries(ESTIMATION_SOURCE).map(([key, m]) => (
                <span key={key} title={m.tip} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ color: m.color, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>
                    {m.glyph}
                  </span>
                  <span>{key === 'tokenizer-fallback' ? '估算' : key === 'provider' ? '真值' : key === 'placeholder' ? '无' : '历史'}</span>
                </span>
              ))}
            </div>
          </div>

          <div style={{
            background: 'var(--paper, #faf6e8)',
            border: '1px solid var(--rule-soft, #e3dccd)', borderRadius: 2,
            overflow: 'hidden',
          }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: '88px 90px 1fr 84px 92px',
              gap: 10,
              padding: '8px 14px',
              borderBottom: '1px solid var(--rule-soft, #e3dccd)',
              background: 'var(--paper-warm, #f5efde)',
              fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
              fontSize: 11, color: 'var(--ink-3, #8b8275)',
              letterSpacing: '0.04em',
            }}>
              <span>时间</span>
              <span>capability</span>
              <span>model · task</span>
              <span style={{ textAlign: 'right' }}>tokens</span>
              <span style={{ textAlign: 'right' }}>¥ · 来源</span>
            </div>
            {ledger.rows.map((r) => {
              const tsLabel = (() => {
                try {
                  const d = new Date(r.ts);
                  if (Number.isNaN(d.valueOf())) return r.ts;
                  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                } catch (_) { return r.ts; }
              })();
              const tokensLabel = (r.input_tokens == null && r.output_tokens == null)
                ? '—'
                : `${r.input_tokens || 0} + ${r.output_tokens || 0}`;
              const costLabel = (r.estimated_cost == null)
                ? '—'
                : `¥${Number(r.estimated_cost).toFixed(4)}`;
              return (
                <div key={r.id} style={{
                  display: 'grid',
                  gridTemplateColumns: '88px 90px 1fr 84px 92px',
                  gap: 10,
                  padding: '6px 14px',
                  borderBottom: '1px solid var(--rule-soft, #e3dccd)',
                  fontSize: 12, color: 'var(--ink-2, #5a5246)',
                  fontFamily: '"JetBrains Mono", monospace',
                  alignItems: 'baseline',
                }}>
                  <span style={{ color: 'var(--ink-3, #8b8275)' }}>{tsLabel}</span>
                  <span style={{ color: 'var(--ink-2, #5a5246)' }}>{r.capability || '—'}</span>
                  <span style={{
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    color: 'var(--ink-1, #2c2620)',
                  }} title={`${r.model_name || '?'} · ${r.task_type || '?'} · ${r.provider_id || '?'}`}>
                    {r.model_name || '?'}<span style={{ color: 'var(--ink-3, #8b8275)' }}> · {r.task_type || '?'}</span>
                  </span>
                  <span style={{ textAlign: 'right', color: 'var(--ink-2, #5a5246)' }}>
                    {tokensLabel}
                  </span>
                  <span style={{ textAlign: 'right', color: 'var(--ink-1, #2c2620)', whiteSpace: 'nowrap' }}>
                    {costLabel}<SourceMark source={r.estimation_source} />
                  </span>
                </div>
              );
            })}
            <div style={{
              padding: '8px 14px',
              fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
              fontSize: 11, color: 'var(--ink-3, #8b8275)',
            }}>
              共 {ledger.total} 条 · 显示 {ledger.rows.length} 条
              {(ledger.estimate_cnt > 0 || ledger.missing_cnt > 0 || ledger.legacy_cnt > 0) && (
                <span> · 其中{ledger.accurate_cnt > 0 && ` ${ledger.accurate_cnt} 条真实`}{ledger.estimate_cnt > 0 && `, ${ledger.estimate_cnt} 条估算`}{ledger.missing_cnt > 0 && `, ${ledger.missing_cnt} 条无数据`}{ledger.legacy_cnt > 0 && `, ${ledger.legacy_cnt} 条历史`}</span>
              )}
            </div>
          </div>
        </React.Fragment>
      )}

      {error && (
        <div style={{
          marginTop: 14, color: 'var(--accent-terracotta, #c25a36)',
          fontSize: 13, fontStyle: 'italic',
        }}>
          {error}
        </div>
      )}
    </div>
  );
};

window.CostBudgetScreen = CostBudgetScreen;
window.HYPHA_ROUTES = window.HYPHA_ROUTES || {};
window.HYPHA_ROUTES['cost-budget'] = CostBudgetScreen;
