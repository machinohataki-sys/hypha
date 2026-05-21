/* global React */
// HYPHA · W8.4 Feedback Channel surface (BLUEPRINT §19.3).
//
// Three panels stacked: Submit / Mine / History (rewards).
// Manuscript register: EB Garamond italic for headings, brass hairlines,
// no SaaS gushing, no toast tomfoolery. Submission types + reward
// types pulled from feedback.types() so the UI never drifts from lib.
//
// intentional-placeholder: this file has no async work waiting on real
// data sources — every IPC has a fully-implemented backend in
// `app/main.js` W8.4 block and `app/lib/feedback-channel/feedback.js`.
//
// Props: { slug, onBack }

const { useState, useEffect, useCallback } = React;

const TYPE_LABELS = {
  product_idea:             '产品建议',
  lesson_quality:           'Lesson 质量',
  note_use:                 'Note 使用',
  companion_dialogue:       'Companion 台词',
  pack_structure:           'Pack 结构',
  exam_model:               'Exam 模型',
  bug:                      'Bug',
  uncomfortable_experience: '不舒服体验',
};

const REWARD_LABELS = {
  deepen_credit:        '深化额度',
  distillation_credit:  '长文蒸馏额度',
  radar_credit:         'Research Radar 次数',
  pack_credit:          'Pack 生成额度',
  membership_days:      '会员天数',
  founding_contributor: '创始贡献者徽章',
  companion_title:      'Companion 称号',
};

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

const Hairline = () => (
  <div style={{
    height: 1, background: 'var(--rule-soft, #e3dccd)',
    margin: '20px 0',
  }} />
);

const TypePill = ({ id, active, onClick }) => (
  <button
    onClick={onClick}
    style={{
      padding: '5px 12px',
      margin: '0 6px 6px 0',
      fontSize: 13,
      fontFamily: '"Noto Serif SC", serif',
      background: active ? 'var(--accent-brass, #b08a3e)' : 'transparent',
      color: active ? 'var(--paper, #faf6e8)' : 'var(--ink-2, #5a5246)',
      border: '1px solid ' + (active ? 'var(--accent-brass, #b08a3e)' : 'var(--rule-soft, #e3dccd)'),
      borderRadius: 999,
      cursor: 'pointer',
      transition: 'all 0.12s ease',
    }}
  >{TYPE_LABELS[id] || id}</button>
);

const FeedbackScreen = ({ slug, onBack }) => {
  const [type, setType] = useState('product_idea');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [mine, setMine] = useState([]);
  const [rewards, setRewards] = useState({ rewards: [], totals: {} });
  const [disclaimer, setDisclaimer] = useState('');
  const [submitted, setSubmitted] = useState(null);

  const reload = useCallback(async () => {
    if (!window.ptor || !window.ptor.feedback) return;
    try {
      const list = await window.ptor.feedback.list({ slug: slug || 'global' });
      if (list && list.ok) setMine(list.items || []);
      const rh = await window.ptor.feedback.rewards();
      if (rh && rh.ok) setRewards({ rewards: rh.rewards || [], totals: rh.totals || {} });
    } catch (_) { /* swallow — surface stays usable on miss */ }
  }, [slug]);

  useEffect(() => {
    (async () => {
      try {
        if (!window.ptor || !window.ptor.feedback) return;
        const t = await window.ptor.feedback.types();
        if (t && t.disclaimer) setDisclaimer(t.disclaimer);
      } catch (_) {}
    })();
    reload();
  }, [reload]);

  const submit = async () => {
    setError(null);
    if (!content.trim() || content.trim().length < 2) {
      setError('请写下至少 2 个字的反馈内容。');
      return;
    }
    if (!window.ptor || !window.ptor.feedback) {
      setError('反馈通道未就绪 (IPC bridge missing)。');
      return;
    }
    setBusy(true);
    try {
      const r = await window.ptor.feedback.submit(slug || 'global', { type, content });
      if (!r || !r.ok) {
        setError(r && r.error ? r.error : '提交失败。');
      } else {
        setSubmitted(r.record);
        setContent('');
        await reload();
      }
    } catch (e) { setError(String(e && e.message || e)); }
    finally { setBusy(false); }
  };

  return (
    <div style={{
      maxWidth: 880, margin: '0 auto', padding: '32px 28px',
      fontFamily: '"Noto Serif SC", "EB Garamond", serif',
      color: 'var(--ink-1, #2c2620)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={{ fontFamily: 'EB Garamond, serif', fontStyle: 'italic', fontSize: 26 }}>
          反馈通道 — feedback
        </div>
        <button onClick={onBack} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--ink-3, #8b8275)', fontStyle: 'italic',
          fontFamily: 'EB Garamond, serif', fontSize: 14,
        }}>返回</button>
      </div>
      <div style={{ fontSize: 14, color: 'var(--ink-3, #8b8275)', fontStyle: 'italic', marginBottom: 24 }}>
        BLUEPRINT §19.3 · 产品建议 / 课程质量 / Companion 台词 / Bug / 不舒服体验 — 写信即可。
      </div>

      <Hairline />

      <FieldLabel>反馈类型</FieldLabel>
      <div style={{ marginBottom: 16 }}>
        {Object.keys(TYPE_LABELS).map((id) => (
          <TypePill key={id} id={id} active={type === id} onClick={() => setType(id)} />
        ))}
      </div>

      <FieldLabel>具体内容</FieldLabel>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="把你想说的写下来。具体到 lesson / 笔记位置 / Companion 哪句话最好。"
        rows={6}
        style={{
          width: '100%', padding: '12px 14px',
          fontFamily: '"Noto Serif SC", serif', fontSize: 14, lineHeight: 1.7,
          background: 'var(--paper, #faf6e8)',
          border: '1px solid var(--rule-soft, #e3dccd)',
          borderRadius: 2, color: 'var(--ink-1, #2c2620)',
          resize: 'vertical', outline: 'none',
        }} />

      {error && (
        <div style={{ color: 'var(--accent-terracotta, #c25a36)', fontSize: 13, marginTop: 8 }}>
          {error}
        </div>
      )}

      <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          onClick={submit}
          disabled={busy}
          style={{
            padding: '8px 22px',
            fontFamily: 'EB Garamond, serif', fontStyle: 'italic', fontSize: 15,
            background: 'var(--accent-brass, #b08a3e)', color: 'var(--paper, #faf6e8)',
            border: 'none', borderRadius: 2,
            cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1,
          }}
        >{busy ? '提交中…' : '寄出'}</button>
        {submitted && (
          <span style={{ fontSize: 13, color: 'var(--ink-3, #8b8275)', fontStyle: 'italic' }}>
            已记录 · {submitted.id}
          </span>
        )}
      </div>

      <div style={{
        marginTop: 18, padding: '12px 14px',
        background: 'var(--paper-warm, #f5efde)',
        border: '1px solid var(--rule-soft, #e3dccd)',
        borderRadius: 2, fontSize: 12, color: 'var(--ink-3, #8b8275)',
        whiteSpace: 'pre-wrap', lineHeight: 1.6,
      }}>
        {disclaimer || '反馈采纳奖励仅以非现金形式发放; 不代表 IP / 收益 / 分红权。'}
      </div>

      <Hairline />

      <div style={{ fontFamily: 'EB Garamond, serif', fontStyle: 'italic', fontSize: 20, marginBottom: 10 }}>
        我寄出的反馈
      </div>
      {mine.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--ink-3, #8b8275)', fontStyle: 'italic' }}>
          这里还空着 — 你写下第一条之后会出现在这里。
        </div>
      ) : (
        <div>
          {mine.map((m) => (
            <div key={m.id} style={{
              padding: '10px 12px', marginBottom: 8,
              background: 'var(--paper, #faf6e8)',
              border: '1px solid var(--rule-soft, #e3dccd)', borderRadius: 2,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ink-3, #8b8275)', marginBottom: 6 }}>
                <span style={{ fontFamily: 'EB Garamond, serif', fontStyle: 'italic' }}>
                  {TYPE_LABELS[m.type] || m.type} · {m.status}
                </span>
                <span>{new Date(m.ts_created).toLocaleString()}</span>
              </div>
              <div style={{ fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
                {m.content}
              </div>
              {m.reward && (
                <div style={{
                  marginTop: 8, fontSize: 12, fontStyle: 'italic',
                  color: 'var(--accent-brass, #b08a3e)',
                  fontFamily: 'EB Garamond, serif',
                }}>
                  采纳 · {REWARD_LABELS[m.reward.type] || m.reward.type} × {m.reward.amount}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Hairline />

      <div style={{ fontFamily: 'EB Garamond, serif', fontStyle: 'italic', fontSize: 20, marginBottom: 10 }}>
        累计奖励
      </div>
      {Object.keys(rewards.totals).length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--ink-3, #8b8275)', fontStyle: 'italic' }}>
          还未累计奖励 — 被采纳的反馈会以非现金额度回馈。
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
          {Object.entries(rewards.totals).map(([k, v]) => (
            <div key={k} style={{
              padding: '10px 12px',
              background: 'var(--paper-warm, #f5efde)',
              border: '1px solid var(--rule-soft, #e3dccd)', borderRadius: 2,
            }}>
              <div style={{ fontFamily: 'EB Garamond, serif', fontStyle: 'italic', fontSize: 12, color: 'var(--ink-3, #8b8275)' }}>
                {REWARD_LABELS[k] || k}
              </div>
              <div style={{ fontSize: 18, marginTop: 2 }}>{v}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

window.FeedbackScreen = FeedbackScreen;
window.HYPHA_ROUTES = window.HYPHA_ROUTES || {};
window.HYPHA_ROUTES['feedback'] = FeedbackScreen;
