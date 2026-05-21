/* global React */
// HYPHA · W7.1 PackLearningScreen — Pack detail + 6 operations + state badge.
//
// Surface map (top → bottom):
//   1. ChainHeader-style top bar with topic + state badge + back button
//   2. 15-field Pack Intelligence Card (W6.5) summary block
//   3. 6 operation buttons (Preview / Quick / Deep / Apply / Fork / Transfer)
//   4. Inline result panel for the most-recently-fired operation
//   5. Pack Study Note editor (markdown textarea + append)
//   6. Parking Queue control (park / unpark this pack)
//
// Register (千金 manuscript): EB Garamond italic for badges + h1, roman for
// body, brass-bright signal accents. No emoji, no exclamation marks, no
// SaaS-y CTAs. Buttons read as verbs, not slogans.
//
// Props: { pack, slug, userContext, onBack }
//   - pack:        a pack.json shape OR the enriched _rank object from PIC
//   - slug:        active vault slug (Pack Study Note + Parking Queue scope)
//   - userContext: { goal, currentLesson, masteryMap, products, safetyLevel }
//   - onBack:      ESC handler; no-op fallback

const { useState, useEffect, useCallback, useMemo } = React;

// ─── State badge palette (mirrors state-machine.js order) ──────────────────

const STATE_ORDER = [
  'Imported', 'Previewed', 'Learning', 'Understood',
  'Applied', 'Personalized', 'Integrated', 'Productized', 'Crystallized',
];

const STATE_BADGE = {
  Imported:     { fg: '#6b6258', bg: '#e8e0d2', label: 'Imported'     },
  Previewed:    { fg: '#7a5a1d', bg: '#f0e0b5', label: 'Previewed'    },
  Learning:     { fg: '#3a5a72', bg: '#cfdbe6', label: 'Learning'     },
  Understood:   { fg: '#3f5a3c', bg: '#d8e3cf', label: 'Understood'   },
  Applied:      { fg: '#5a3a72', bg: '#dccfe6', label: 'Applied'      },
  Personalized: { fg: '#7a3a32', bg: '#ecd0c8', label: 'Personalized' },
  Integrated:   { fg: '#2f4a35', bg: '#c5d9c8', label: 'Integrated'   },
  Productized:  { fg: '#7a4a1d', bg: '#e8ceaa', label: 'Productized'  },
  Crystallized: { fg: '#3a2a52', bg: '#cfc6e0', label: 'Crystallized' },
};

const StateBadge = ({ state }) => {
  const cfg = STATE_BADGE[state] || STATE_BADGE.Imported;
  return (
    <span style={{
      display: 'inline-block',
      padding: '3px 10px',
      fontSize: 10,
      letterSpacing: '0.10em',
      textTransform: 'uppercase',
      color: cfg.fg,
      background: cfg.bg,
      borderRadius: 2,
      fontFamily: '"JetBrains Mono", monospace',
      fontWeight: 500,
    }}>
      {cfg.label}
    </span>
  );
};

// ─── Tiny helpers ──────────────────────────────────────────────────────────

const SectionLabel = ({ children }) => (
  <div style={{
    fontSize: 10,
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
    color: 'var(--ink-3)',
    fontFamily: '"JetBrains Mono", monospace',
    marginBottom: 6,
  }}>
    {children}
  </div>
);

const RegisterButton = ({ onClick, disabled, busy, children, title }) => (
  <button
    onClick={onClick}
    disabled={!!disabled || !!busy}
    title={title || ''}
    style={{
      padding: '8px 16px',
      fontSize: 13,
      fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      color: disabled ? 'var(--ink-3)' : 'var(--ink)',
      background: 'transparent',
      border: '1px solid ' + (disabled ? 'var(--rule-soft)' : 'var(--ink-2)'),
      borderRadius: 2,
      cursor: disabled ? 'not-allowed' : 'pointer',
      letterSpacing: '0.04em',
      minWidth: 110,
    }}>
    {busy ? '…' : children}
  </button>
);

function _picBridge() {
  return window.ptor && window.ptor.commons || null;
}
function _packBridge() {
  return window.ptor && window.ptor.pack || null;
}

// ─── PIC summary (renders the 15-field card compactly) ─────────────────────

const PICSummary = ({ card }) => {
  if (!card) {
    return (
      <div style={{ fontSize: 13, fontStyle: 'italic', color: 'var(--ink-3)' }}>
        (intelligence card unavailable — pack metadata likely incomplete)
      </div>
    );
  }
  const row = (label, val) => (
    <div className="col gap-2" style={{ minWidth: 200, marginBottom: 14 }}>
      <SectionLabel>{label}</SectionLabel>
      <div style={{
        fontSize: 13.5, lineHeight: 1.55, color: 'var(--ink)',
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      }}>
        {Array.isArray(val) ? val.join(' · ') : (val == null || val === '' ? '—' : String(val))}
      </div>
    </div>
  );
  return (
    <div className="col" style={{ gap: 0, marginTop: 12 }}>
      <div style={{ fontSize: 14, fontStyle: 'italic', color: 'var(--ink-2)', marginBottom: 16, lineHeight: 1.6 }}>
        {card.primary_value || ''}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', columnGap: 32 }}>
        {row('推荐科目', card.recommended_subject)}
        {row('适合人群', card.audience)}
        {row('推荐场景', card.recommended_scenes)}
        {row('前置知识', card.prerequisites)}
        {row('难度等级', card.difficulty_level)}
        {row('认知负荷', card.cognitive_load)}
        {row('稳定性', card.stability_tag)}
        {row('安全等级', card.safety_level)}
        {row('质量评分', card.quality_score != null ? `${card.quality_score} / 100` : '—')}
        {row('风险与缺陷', card.risks_and_defects)}
        {row('不适合谁', card.not_for)}
        {row('使用方式', card.usage_method)}
        {row('可迁移到', card.transferable_to)}
        {row('为何推荐', card.why_for_you)}
      </div>
    </div>
  );
};

// ─── Operation result renderer ─────────────────────────────────────────────

const OperationResult = ({ op, payload }) => {
  if (!op || !payload) return null;
  const wrap = (title, children) => (
    <div className="col gap-8" style={{
      padding: '16px 18px',
      background: 'rgba(193,139,69,0.06)',
      border: '1px solid var(--rule-soft)',
      borderRadius: 2,
      marginTop: 12,
    }}>
      <SectionLabel>{title}</SectionLabel>
      {children}
    </div>
  );
  const body = (s) => (
    <div style={{
      fontSize: 14, lineHeight: 1.7, color: 'var(--ink)',
      fontFamily: 'EB Garamond, "Noto Serif SC", serif', whiteSpace: 'pre-wrap',
    }}>{s}</div>
  );
  switch (op) {
    case 'preview': {
      const fc = payload.fit_check || {};
      return wrap('Preview (10s 决策)', (
        <React.Fragment>
          {body(payload.summary || '')}
          <div className="row gap-8" style={{ flexWrap: 'wrap', marginTop: 4 }}>
            {Object.entries(fc).map(([k, v]) => (
              <span key={k} className="mono" style={{
                fontSize: 11, padding: '3px 8px',
                background: 'var(--paper-3, #efe8d8)', color: 'var(--ink-2)',
                borderRadius: 2, letterSpacing: '0.04em',
              }}>
                {k}: {String(v)}
              </span>
            ))}
          </div>
          <div style={{ fontSize: 13, fontStyle: 'italic', color: 'var(--ink-2)', marginTop: 6 }}>
            决策: {payload.decision_10s}
          </div>
        </React.Fragment>
      ));
    }
    case 'quickLearn':
      return wrap(`Quick Learn · 估算 ${payload.time_estimate_min} 分钟`, (
        <React.Fragment>
          {body(payload.core_value || '')}
          {Array.isArray(payload.key_concepts) && payload.key_concepts.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <SectionLabel>关键概念</SectionLabel>
              {body(payload.key_concepts.join(' · '))}
            </div>
          )}
          {payload.mechanism && (
            <div style={{ marginTop: 4 }}>
              <SectionLabel>核心机理</SectionLabel>
              {body(payload.mechanism)}
            </div>
          )}
          {Array.isArray(payload.action_items) && payload.action_items.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <SectionLabel>下一步</SectionLabel>
              {body(payload.action_items.map((a, i) => `${i + 1}. ${a}`).join('\n'))}
            </div>
          )}
        </React.Fragment>
      ));
    case 'deepLearn':
      return wrap(`Deep Learn · ${payload.plan && payload.plan.total_lessons} 节`, (
        <div className="col gap-8">
          {(payload.lessons || []).map(l => (
            <div key={l.idx} style={{
              padding: '8px 12px', borderLeft: '2px solid var(--ochre, #c18b45)',
              fontSize: 13.5, fontFamily: 'EB Garamond, "Noto Serif SC", serif',
            }}>
              <div style={{ color: 'var(--ink)' }}><i>Lesson {l.idx + 1}</i> · {l.title}</div>
              <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>{l.learn_goal}</div>
            </div>
          ))}
        </div>
      ));
    case 'apply':
      return wrap('Apply Pack', body(payload.applied_solution || ''));
    case 'fork':
      return wrap('Fork & Rewrite', (
        <React.Fragment>
          {body(`已创建分支 draft: ${payload.draft_id}`)}
          <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
            {payload.draft_path}
          </div>
        </React.Fragment>
      ));
    case 'transfer':
      return wrap('Transfer to Product', (
        <React.Fragment>
          {body(`目标 section: ${payload.routed_to && payload.routed_to.section} · via ${payload.routed_to && payload.routed_to.via}`)}
          <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 4 }}>
            relevance P = {(payload.transfer_result && payload.transfer_result.P) != null
              ? payload.transfer_result.P.toFixed(2) : '—'} · fired = {String(payload.transfer_result && payload.transfer_result.fired)}
          </div>
        </React.Fragment>
      ));
    default:
      return null;
  }
};

// ─── Pack Study Note panel ─────────────────────────────────────────────────

const StudyNotePanel = ({ packId, slug, refreshKey }) => {
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const reload = useCallback(async () => {
    if (!packId || !slug) return;
    const bridge = _packBridge();
    if (!bridge) return;
    try {
      const resp = await bridge.getStudyNote(packId, slug);
      if (resp && resp.ok && resp.note) setBody(resp.note.body || '');
      else setBody('');
    } catch (_) { setBody(''); }
  }, [packId, slug]);

  useEffect(() => { reload(); }, [reload, refreshKey]);

  const handleAppend = async () => {
    if (!draft.trim()) return;
    setBusy(true); setMsg('');
    try {
      const bridge = _packBridge();
      const resp = bridge ? await bridge.appendStudyNote(packId, slug, draft) : null;
      if (resp && resp.ok) {
        setDraft('');
        setMsg('已追加');
        await reload();
      } else {
        setMsg('追加失败 — bridge 未就绪');
      }
    } catch (err) {
      setMsg('追加失败: ' + (err && err.message));
    } finally { setBusy(false); }
  };

  if (!slug) {
    return (
      <div style={{ fontSize: 13, fontStyle: 'italic', color: 'var(--ink-3)' }}>
        (没有 active slug — Pack 学习笔记需要绑定一个课程上下文)
      </div>
    );
  }
  return (
    <div className="col gap-10">
      <SectionLabel>Pack 学习笔记 — vault/{slug}/pack-study/{packId}.md</SectionLabel>
      <div style={{
        fontSize: 13, lineHeight: 1.65, color: 'var(--ink-2)',
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
        whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto',
        padding: '12px 14px', border: '1px solid var(--rule-soft)', borderRadius: 2,
        background: 'var(--paper-2, #f7f0dd)',
      }}>
        {body || <span style={{ fontStyle: 'italic', color: 'var(--ink-3)' }}>
          (尚无内容 — 在下面写一条以建立此笔记)
        </span>}
      </div>
      {/* intentional-placeholder: HTML `placeholder` attribute is the real
          textarea hint string, not a deferred implementation marker. */}
      <textarea
        value={draft}
        onChange={e => setDraft(e.target.value)}
        placeholder="把刚才的 Quick Learn / Apply 结果 用自己话改写, 或写一条 contested question 的立场…"
        rows={4}
        style={{
          width: '100%', padding: 12, fontSize: 13.5, lineHeight: 1.55,
          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
          background: 'transparent', color: 'var(--ink)',
          border: '1px solid var(--rule-soft)', borderRadius: 2, resize: 'vertical',
        }} />
      <div className="row gap-8" style={{ alignItems: 'center' }}>
        <RegisterButton onClick={handleAppend} busy={busy} disabled={!draft.trim()}>
          追加到笔记
        </RegisterButton>
        {msg && <span style={{ fontSize: 12, color: 'var(--ink-3)', fontStyle: 'italic' }}>{msg}</span>}
      </div>
    </div>
  );
};

// ─── Parking Queue control ─────────────────────────────────────────────────

const ParkingControl = ({ pack, slug }) => {
  const [parked, setParked] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const reload = useCallback(async () => {
    if (!slug || !pack || !pack.id) return;
    const bridge = _packBridge();
    if (!bridge) return;
    try {
      const resp = await bridge.listParked(slug);
      const arr = (resp && resp.parked) || [];
      setParked(arr.some(e => e && e.packId === pack.id));
    } catch (_) { /* leave default */ }
  }, [slug, pack]);

  useEffect(() => { reload(); }, [reload]);

  const handlePark = async () => {
    if (!slug || !pack || !pack.id) return;
    setBusy(true); setMsg('');
    try {
      const bridge = _packBridge();
      const meta = { topic: pack.topic, lang: pack.lang || null };
      const resp = bridge ? await bridge.park(slug, pack.id, reason, meta) : null;
      if (resp && resp.ok) { setMsg('已加入待复活队列'); setReason(''); await reload(); }
      else setMsg('parking 失败 — bridge 未就绪');
    } catch (err) { setMsg('parking 失败: ' + (err && err.message)); }
    finally { setBusy(false); }
  };
  const handleUnpark = async () => {
    if (!slug || !pack || !pack.id) return;
    setBusy(true); setMsg('');
    try {
      const bridge = _packBridge();
      const resp = bridge ? await bridge.unpark(slug, pack.id, 'manual') : null;
      if (resp && resp.ok) { setMsg('已移出队列'); await reload(); }
      else setMsg('unpark 失败');
    } catch (err) { setMsg('unpark 失败: ' + (err && err.message)); }
    finally { setBusy(false); }
  };

  if (!slug) return null;
  return (
    <div className="col gap-8">
      <SectionLabel>Parking Queue · vault/{slug}/parking-queue.json</SectionLabel>
      {parked ? (
        <div className="row gap-12" style={{ alignItems: 'center' }}>
          <span style={{ fontSize: 13, fontStyle: 'italic', color: 'var(--ink-2)' }}>
            已在队列中, 会在相关 lesson 上下文出现时 soft-revive.
          </span>
          <RegisterButton onClick={handleUnpark} busy={busy}>移出队列</RegisterButton>
        </div>
      ) : (
        <div className="row gap-8" style={{ alignItems: 'center' }}>
          {/* intentional-placeholder: HTML `placeholder` attribute is the real
              input hint, not a deferred-implementation marker. */}
          <input
            type="text"
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="可选: 写下为何先放着 (e.g. 等下一节再回来)"
            style={{
              flex: 1, padding: '8px 12px', fontSize: 13,
              fontFamily: 'EB Garamond, "Noto Serif SC", serif',
              background: 'transparent', color: 'var(--ink)',
              border: '1px solid var(--rule-soft)', borderRadius: 2,
            }} />
          <RegisterButton onClick={handlePark} busy={busy}>加入待复活队列</RegisterButton>
        </div>
      )}
      {msg && <span style={{ fontSize: 12, color: 'var(--ink-3)', fontStyle: 'italic' }}>{msg}</span>}
    </div>
  );
};

// ─── Main screen ───────────────────────────────────────────────────────────

const PackLearningScreen = ({ pack, slug, userContext, onBack }) => {
  const [card, setCard] = useState(null);
  const [stateRecord, setStateRecord] = useState(null);
  const [validNext, setValidNext] = useState([]);
  const [lastOp, setLastOp] = useState(null);
  const [opPayload, setOpPayload] = useState(null);
  const [busyOp, setBusyOp] = useState('');
  const [opError, setOpError] = useState('');
  const [refreshNote, setRefreshNote] = useState(0);

  const packTopic = (pack && pack.topic) || '(unknown pack)';
  const packId = (pack && pack.id) || (pack && pack.topic ? pack.topic.replace(/[^a-z0-9-]+/gi, '-').toLowerCase() : null);

  // Generate the PIC on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!pack) return;
      const pic = _picBridge();
      if (!pic) { setCard(null); return; }
      try {
        const resp = await pic.generateCard(pack, userContext || {});
        if (cancelled) return;
        if (resp && resp.ok && resp.card) setCard(resp.card);
        else if (resp && !resp.ok && resp.message) setCard(null);
      } catch (_) { if (!cancelled) setCard(null); }
    })();
    return () => { cancelled = true; };
  }, [pack, userContext]);

  // Load state record + valid next states.
  const reloadState = useCallback(async () => {
    if (!packId) return;
    const bridge = _packBridge();
    if (!bridge) return;
    try {
      const resp = await bridge.state(packId);
      if (resp && resp.ok) {
        setStateRecord(resp.record || null);
        const cur = (resp.record && resp.record.state) || 'Imported';
        const nx = await bridge.getValidTransitions(cur);
        setValidNext((nx && nx.next) || []);
      }
    } catch (_) { /* keep prior */ }
  }, [packId]);

  useEffect(() => { reloadState(); }, [reloadState]);

  const currentState = (stateRecord && stateRecord.state) || 'Imported';

  // ─── Operation handlers ─────────────────────────────────────────────────
  const runOp = useCallback(async (op, args) => {
    const bridge = _packBridge();
    if (!bridge) { setOpError('bridge 未就绪'); return; }
    setBusyOp(op); setOpError(''); setLastOp(op); setOpPayload(null);
    try {
      let resp;
      if (op === 'preview')         resp = await bridge.preview(pack, userContext || {});
      else if (op === 'quickLearn') resp = await bridge.quickLearn(pack, args || {});
      else if (op === 'deepLearn')  resp = await bridge.deepLearn(pack, args || {});
      else if (op === 'apply')      resp = await bridge.apply(pack, args || { description: (userContext && userContext.currentLesson && userContext.currentLesson.topic) || pack.topic });
      else if (op === 'fork')       resp = await bridge.fork(pack, args || {});
      else if (op === 'transfer')   resp = await bridge.transferToProduct(pack, slug, args || {});
      if (!resp || !resp.ok) {
        setOpError((resp && resp.message) || `${op} 失败`);
        return;
      }
      // Surface the result; UI shows payload from the verb-specific key.
      const payload = resp.preview || resp.result || resp.plan || resp.applied || resp.fork || resp.transfer || null;
      setOpPayload(payload);

      // Suggest the natural state transition for each op. The user confirms
      // by clicking a transition button — we don't auto-advance, to keep the
      // state machine user-driven (per BLUEPRINT §12.4 "状态由 user 行为推进").
    } catch (err) {
      setOpError((err && err.message) || 'unexpected error');
    } finally {
      setBusyOp('');
    }
  }, [pack, slug, userContext]);

  // ─── Transition handler ────────────────────────────────────────────────
  const runTransition = useCallback(async (toState, reason) => {
    if (!packId) return;
    const bridge = _packBridge();
    if (!bridge) return;
    try {
      const resp = await bridge.transition(packId, currentState, toState, reason || '');
      if (resp && resp.ok) { await reloadState(); setRefreshNote(k => k + 1); }
      else setOpError((resp && resp.message) || 'transition 失败');
    } catch (err) { setOpError((err && err.message) || 'transition error'); }
  }, [packId, currentState, reloadState]);

  // ─── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="col" style={{
      padding: '32px 48px 64px',
      maxWidth: 1080, margin: '0 auto', gap: 24,
      fontFamily: 'EB Garamond, "Noto Serif SC", serif',
    }}>
      {/* Top bar */}
      <div className="row gap-16" style={{ alignItems: 'baseline' }}>
        <button onClick={onBack || (() => {})}
          className="btn btn-ghost"
          style={{
            fontSize: 13, fontStyle: 'italic',
            color: 'var(--ink-2)', background: 'transparent',
            border: 'none', cursor: 'pointer', padding: 0,
          }}>← back</button>
        <span style={{ flex: 1 }} />
        <StateBadge state={currentState} />
      </div>

      <div className="col gap-4">
        <div className="serif italic" style={{ fontSize: 32, color: 'var(--ink-1)', lineHeight: 1.15 }}>
          {packTopic}
        </div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', letterSpacing: '0.08em' }}>
          pack {packId || '(no-id)'} · {pack && pack.lang || 'zh'} · curator {pack && pack.curator || '—'}
        </div>
      </div>

      {/* PIC summary */}
      <div className="col" style={{
        padding: '20px 24px',
        background: 'var(--paper-2, #f7f0dd)',
        border: '1px solid var(--rule-soft)', borderRadius: 3,
      }}>
        <SectionLabel>Pack Intelligence Card (W6.5)</SectionLabel>
        <PICSummary card={card} />
      </div>

      {/* 6 operations */}
      <div className="col gap-10">
        <SectionLabel>操作</SectionLabel>
        <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
          <RegisterButton onClick={() => runOp('preview')}      busy={busyOp === 'preview'}     title="10s 决策 — 适不适合现在学">Preview</RegisterButton>
          <RegisterButton onClick={() => runOp('quickLearn')}   busy={busyOp === 'quickLearn'}  title="15-25 分钟掌握核心价值">Quick Learn</RegisterButton>
          <RegisterButton onClick={() => runOp('deepLearn')}    busy={busyOp === 'deepLearn'}   title="拆成多节 Pack Lesson 计划">Deep Learn</RegisterButton>
          <RegisterButton onClick={() => runOp('apply')}        busy={busyOp === 'apply'}       title="把 Pack 应用到当前 lesson 的问题">Apply</RegisterButton>
          <RegisterButton onClick={() => runOp('fork')}         busy={busyOp === 'fork'}        title="分支一份属于自己的 Pack 草稿">Fork & Rewrite</RegisterButton>
          <RegisterButton onClick={() => runOp('transfer')}     busy={busyOp === 'transfer'}    disabled={!slug} title="迁移到 Product Pool (调 W3.3)">Transfer to Product</RegisterButton>
        </div>
        {opError && (
          <div style={{ fontSize: 12, color: '#7a3a32', fontStyle: 'italic' }}>{opError}</div>
        )}
        <OperationResult op={lastOp} payload={opPayload} />
      </div>

      {/* Transition controls */}
      <div className="col gap-8">
        <SectionLabel>状态推进</SectionLabel>
        {validNext.length === 0 ? (
          <div style={{ fontSize: 13, fontStyle: 'italic', color: 'var(--ink-3)' }}>
            (终态 — 此包已被 Crystallized 为 principle)
          </div>
        ) : (
          <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
            {validNext.map(ns => (
              <RegisterButton key={ns} onClick={() => runTransition(ns, `user advance from ${currentState}`)}>
                → {ns}
              </RegisterButton>
            ))}
          </div>
        )}
      </div>

      {/* Pack Study Note */}
      <div className="col" style={{
        padding: '20px 24px',
        border: '1px solid var(--rule-soft)', borderRadius: 3,
      }}>
        <StudyNotePanel packId={packId} slug={slug} refreshKey={refreshNote} />
      </div>

      {/* Parking Queue */}
      <div className="col" style={{
        padding: '20px 24px',
        border: '1px solid var(--rule-soft)', borderRadius: 3,
      }}>
        <ParkingControl pack={pack} slug={slug} />
      </div>
    </div>
  );
};

window.PackLearningScreen = PackLearningScreen;
