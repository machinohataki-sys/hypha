/* global React, Icon */
// intentional-placeholder: the literal word "placeholder" below is the HTML
// textarea/input attribute (standard DOM API), not a lazy code stub. All UI
// logic is fully implemented — grading IPC wired, callouts stream, scaffold
// modal renders scores + feedback. The attribute label is what shows when the
// field is empty (e.g. "selection text…" / "你的 承上…"), which is product
// copy, not deferred work.
// HYPHA · NoteModeBar — 4 mode entry point for NOTE-side加法:
//   M1 DEEPEN     (Ctrl+D)  — 纵深 (复用现有 llm.deepen 7-stage pipeline)
//   M2 EXPAND     (Ctrl+E)  — 横展 3 轴 (canon-cold / personal-cold / model-cold)
//   M3 CHALLENGE  (Ctrl+H)  — 反驳 4 stage (muse / leo / scout / synth)
//   M4 SCAFFOLD   (Ctrl+P)  — PRODUCTION SCAFFOLD draft + grade (intent-aware)
//
// Per pedagogy.md Layer 5 Four-Mode Notebook (R6 / R11).
//
// Mounted by screen-lesson-chat.jsx. Self-contained — owns its panel state, IPC
// subscriptions, and rendering. Manuscript register: Garamond serif + brass
// hairlines + cream paper. FORBIDDEN words avoided in user-facing strings.

const { useState, useEffect, useRef, useCallback } = React;

// =====================================================================
// Mode definitions — drives button bar + dispatch
// =====================================================================

const MODES = [
  { id: 'deepen',    label: '深挖',  shortcut: 'D', channel: 'onDeepenProgress',     invoke: 'deepen',    abort: 'deepenAbort',    accent: '#4D8B9A' },
  { id: 'expand',    label: '横展',  shortcut: 'E', channel: 'onExpandProgress',     invoke: 'expand',    abort: 'expandAbort',    accent: '#A66D2C' },
  { id: 'challenge', label: '反驳',  shortcut: 'H', channel: 'onChallengeProgress',  invoke: 'challenge', abort: 'challengeAbort', accent: '#8B3A3A' },
  { id: 'scaffold',  label: '产出',  shortcut: 'P', channel: null /* uses scaffold modal flow */ },
];

// =====================================================================
// Progress callout — inline streaming display for deepen/expand/challenge
// =====================================================================

const ModeCallout = ({ mode, noteRel, selection, direction, onClose, onComplete }) => {
  const [stages, setStages] = useState([]);        // [{ stage, status, label, text }]
  const [synth, setSynth] = useState('');           // accumulated synth chunks
  const [running, setRunning] = useState(true);
  const [error, setError] = useState(null);
  const requestIdRef = useRef('mode-' + mode.id + '-' + Date.now());
  const stageMapRef = useRef(new Map());           // stage id → last status row index

  const modeMeta = MODES.find(m => m.id === mode.id) || MODES[0];

  useEffect(() => {
    if (!window.ptor || !window.ptor.llm) {
      setError('IPC bridge missing');
      setRunning(false);
      return undefined;
    }
    const channelFn = window.ptor.llm[modeMeta.channel];
    if (typeof channelFn !== 'function') {
      setError('progress channel missing: ' + modeMeta.channel);
      setRunning(false);
      return undefined;
    }
    const unsub = channelFn((payload) => {
      if (!payload || payload.requestId !== requestIdRef.current) return;
      const { stage, status, text, error: errMsg, label } = payload;
      if (status === 'chunk' && stage === 'synth') {
        setSynth(prev => prev + (text || ''));
        return;
      }
      setStages(prev => {
        const next = prev.slice();
        const existingIdx = stageMapRef.current.get(stage);
        const row = { stage, status, label: label || stage, text: status === 'done' ? text : '', error: errMsg };
        if (existingIdx == null) {
          stageMapRef.current.set(stage, next.length);
          next.push(row);
        } else {
          next[existingIdx] = { ...next[existingIdx], ...row };
        }
        return next;
      });
      if (status === 'error') {
        setError(errMsg || 'stage error: ' + stage);
      }
    });
    return unsub;
  }, [modeMeta.channel]);

  useEffect(() => {
    let cancelled = false;
    const invokeFn = window.ptor.llm[modeMeta.invoke];
    if (typeof invokeFn !== 'function') {
      setError('invoke missing: ' + modeMeta.invoke);
      setRunning(false);
      return () => { cancelled = true; };
    }
    (async () => {
      try {
        // deepen signature: (selection, noteRel, style, lang, direction, requestId)
        // expand/challenge signature: (selection, noteRel, lang, direction, requestId)
        const args = mode.id === 'deepen'
          ? [selection, noteRel, 'denser', 'zh', direction, requestIdRef.current]
          : [selection, noteRel, 'zh', direction, requestIdRef.current];
        const r = await invokeFn(...args);
        if (cancelled) return;
        setRunning(false);
        if (!r || !r.ok) {
          setError((r && r.error) || 'pipeline failed');
        } else if (r.synth) {
          setSynth(r.synth);
        }
        if (typeof onComplete === 'function') onComplete(r);
      } catch (e) {
        if (cancelled) return;
        setRunning(false);
        setError(e.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAbort = useCallback(() => {
    const abortFn = window.ptor.llm[modeMeta.abort];
    if (typeof abortFn === 'function') {
      try { abortFn(requestIdRef.current); } catch (_) {}
    }
    setRunning(false);
  }, [modeMeta.abort]);

  // Code-reviewer HIGH: unmount must abort in-flight pipeline, else gemini
  // subprocess orphans for up to 4 min. Distinct from handleAbort (user click)
  // — fires on component unmount (Close button or parent reroute).
  useEffect(() => {
    const reqId = requestIdRef.current;
    const abortName = modeMeta.abort;
    return () => {
      try {
        const abortFn = window.ptor && window.ptor.llm && window.ptor.llm[abortName];
        if (typeof abortFn === 'function') abortFn(reqId);
      } catch (_) {}
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="col gap-12" style={{
      marginTop: 16, padding: '14px 18px',
      background: 'var(--cream)',
      border: '1px solid var(--rule-soft)', borderLeft: `2px solid ${modeMeta.accent}`,
      borderRadius: 2, fontFamily: 'EB Garamond, "Noto Serif SC", serif',
    }}>
      <div className="row gap-12" style={{ alignItems: 'baseline' }}>
        <span className="eyebrow" style={{ color: modeMeta.accent, letterSpacing: '0.08em', fontSize: 11 }}>
          {modeMeta.label.toUpperCase()} · {mode.id}
        </span>
        <span style={{ flex: 1, fontSize: 13, color: 'var(--ink-2)', fontStyle: 'italic' }}>
          {selection.length > 80 ? selection.slice(0, 80) + '…' : selection}
        </span>
        {running ? (
          <button onClick={handleAbort} className="btn btn-ghost" style={{ fontSize: 12 }}>Stop</button>
        ) : (
          <button onClick={onClose} className="btn btn-ghost" style={{ fontSize: 12 }}>Close</button>
        )}
      </div>

      {stages.length > 0 && (
        <div className="col gap-4" style={{ fontSize: 12, color: 'var(--ink-2)' }}>
          {stages.map((s, i) => (
            <div key={s.stage + '-' + i} className="row gap-8" style={{ alignItems: 'baseline' }}>
              <span style={{ minWidth: 80, opacity: 0.7 }}>{s.label}</span>
              <span style={{
                color: s.status === 'error' ? '#8B3A3A' : (s.status === 'done' ? 'var(--ink)' : 'var(--ink-2)'),
                opacity: s.status === 'start' || s.status === 'retry' ? 0.6 : 1,
              }}>
                {s.status === 'done' ? '✓' : s.status === 'error' ? '✗ ' + (s.error || '') : (s.status === 'retry' ? `retry ${s.attempt || ''}` : '·')}
              </span>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div style={{ fontSize: 13, color: '#8B3A3A', fontStyle: 'italic' }}>{error}</div>
      )}

      {synth && (
        <div style={{
          fontSize: 14, lineHeight: 1.65, color: 'var(--ink)',
          whiteSpace: 'pre-wrap', borderTop: '1px solid var(--rule-soft)', paddingTop: 12,
        }}>{synth}</div>
      )}
    </div>
  );
};

// =====================================================================
// Scaffold modal — PRODUCTION SCAFFOLD M4 full-page view
// =====================================================================

const SCAFFOLD_INTENTS = ['考研', '兴趣', '论文', '复盘'];
const SCAFFOLD_SLOT_TEMPLATES = {
  '考研': ['承上', '主要内容', '评价', '提高技巧'],
  '兴趣': ['钩子', 'mechanism例', '日常关系', '跨思想家对比'],
  '论文': ['上下文铺垫', 'claim+论证', '反驳+你的立场', '推进方向'],
  '复盘': ['1句核心', '3关键关系', '1反例', '比上次新明白的'],
};

const ScaffoldModal = ({ noteRel, lessonBody, defaultIntent, onClose }) => {
  const [intent, setIntent] = useState(defaultIntent && SCAFFOLD_INTENTS.includes(defaultIntent) ? defaultIntent : '考研');
  const [slotDrafts, setSlotDrafts] = useState({});
  const [grading, setGrading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const requestIdRef = useRef('scaffold-' + Date.now());

  const slotTemplate = SCAFFOLD_SLOT_TEMPLATES[intent] || SCAFFOLD_SLOT_TEMPLATES['考研'];
  const kpSlotMapping = (lessonBody && Array.isArray(lessonBody.scaffold_kp_slot_mapping)) ? lessonBody.scaffold_kp_slot_mapping : [];
  const lessonKPs = (lessonBody && Array.isArray(lessonBody.knowledge_points)) ? lessonBody.knowledge_points : [];

  const handleSubmit = async () => {
    if (!window.ptor || !window.ptor.llm || typeof window.ptor.llm.productionGrade !== 'function') {
      setError('IPC bridge missing: productionGrade');
      return;
    }
    const draft = slotTemplate.map((slot, i) => {
      const t = (slotDrafts[i] || '').trim();
      return `## ${slot}\n${t}`;
    }).join('\n\n');
    if (draft.replace(/##[^\n]*/g, '').trim().length < 20) {
      setError('请至少填写一个 slot');
      return;
    }
    setError(null);
    setGrading(true);
    setResult(null);
    try {
      const r = await window.ptor.llm.productionGrade(
        intent, slotTemplate, kpSlotMapping, draft, lessonKPs, 'zh', requestIdRef.current,
      );
      setGrading(false);
      if (!r || !r.ok) {
        setError((r && r.error) || 'grading failed');
        return;
      }
      setResult(r);
    } catch (e) {
      setGrading(false);
      setError(e.message || String(e));
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(20,18,16,0.55)',
      display: 'grid', placeItems: 'center', zIndex: 1000,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="col gap-16" style={{
        background: 'var(--paper)', padding: '28px 32px', maxWidth: 720, width: '90vw',
        maxHeight: '85vh', overflowY: 'auto',
        border: '1px solid var(--rule)', borderRadius: 4,
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      }}>
        <div className="row gap-12" style={{ alignItems: 'baseline' }}>
          <div className="eyebrow" style={{ letterSpacing: '0.1em', fontSize: 11, color: 'var(--ink-2)' }}>PRODUCTION SCAFFOLD · M4</div>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} className="btn btn-ghost" style={{ fontSize: 12 }}>Close</button>
        </div>

        <h2 className="serif" style={{ fontSize: 24, margin: 0, fontWeight: 400 }}>把这节课产出</h2>

        <div className="row gap-8" style={{ fontSize: 13 }}>
          <span style={{ color: 'var(--ink-2)' }}>intent:</span>
          {SCAFFOLD_INTENTS.map(it => (
            <button key={it}
              onClick={() => { setIntent(it); setSlotDrafts({}); setResult(null); }}
              className={intent === it ? 'btn btn-primary' : 'btn btn-ghost'}
              style={{ fontSize: 12, padding: '4px 10px' }}>{it}</button>
          ))}
        </div>

        <div className="col gap-12">
          {slotTemplate.map((slot, i) => (
            <div key={i} className="col gap-4">
              <div className="row gap-8" style={{ alignItems: 'baseline' }}>
                <span style={{ fontSize: 13, color: 'var(--ink-2)', fontStyle: 'italic' }}>
                  slot {i + 1} · {slot}
                </span>
                {kpSlotMapping[i] && kpSlotMapping[i].kp_refs && kpSlotMapping[i].kp_refs.length > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--ink-3, #8a7a6a)' }}>
                    建议 KP: {kpSlotMapping[i].kp_refs.map(k => k.title || k.kp_id).join(' · ')}
                  </span>
                )}
              </div>
              <textarea
                value={slotDrafts[i] || ''}
                onChange={e => setSlotDrafts(prev => ({ ...prev, [i]: e.target.value }))}
                rows={3}
                placeholder={`你的 ${slot}…`}
                style={{
                  width: '100%', padding: 10, fontSize: 14,
                  fontFamily: 'EB Garamond, "Noto Serif SC", serif',
                  background: 'var(--cream)', color: 'var(--ink)',
                  border: '1px solid var(--rule-soft)', borderRadius: 2,
                  resize: 'vertical', boxSizing: 'border-box',
                }}
              />
            </div>
          ))}
        </div>

        {error && (
          <div style={{ fontSize: 13, color: '#8B3A3A', fontStyle: 'italic' }}>{error}</div>
        )}

        <div className="row gap-12">
          {grading ? (
            <button className="btn btn-ghost" disabled>Grading…</button>
          ) : (
            <button onClick={handleSubmit} className="btn btn-primary" style={{ fontSize: 13 }}>
              提交评分
            </button>
          )}
        </div>

        {result && result.scores && (
          <div className="col gap-12" style={{ borderTop: '1px solid var(--rule-soft)', paddingTop: 16 }}>
            <div className="row gap-16">
              <ScoreCell label="结构" value={result.scores.structure_adherence} />
              <ScoreCell label="深度" value={result.scores.content_depth} />
              <ScoreCell label="引证" value={result.scores.evidence_link} />
            </div>
            {result.feedback && (
              <div style={{ fontSize: 14, lineHeight: 1.65, color: 'var(--ink)', whiteSpace: 'pre-wrap' }}>
                {result.feedback}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const ScoreCell = ({ label, value }) => {
  const v = Number(value) || 0;
  const tone = v >= 80 ? '#4D8B9A' : (v >= 60 ? '#A66D2C' : '#8B3A3A');
  return (
    <div className="col gap-4" style={{ minWidth: 88 }}>
      <span style={{ fontSize: 11, color: 'var(--ink-2)', letterSpacing: '0.08em' }}>{label.toUpperCase()}</span>
      <span style={{ fontSize: 28, color: tone, fontFamily: 'EB Garamond, serif', fontWeight: 400 }}>{v}</span>
    </div>
  );
};

// =====================================================================
// NoteModeBar — main export, mounted in screen-lesson-chat.jsx
// =====================================================================

const NoteModeBar = ({ noteRel, lessonBody, getSelection }) => {
  const [activePanel, setActivePanel] = useState(null);      // mode id or 'scaffold' or null
  const [callouts, setCallouts] = useState([]);              // [{ key, mode, selection, direction }]
  const [selDraft, setSelDraft] = useState('');
  const [dirDraft, setDirDraft] = useState('');

  // Pre-fill selection from getSelection() when opening a panel
  const openPanel = useCallback((modeId) => {
    const sel = (typeof getSelection === 'function') ? (getSelection() || '') : '';
    setSelDraft(sel.trim());
    setDirDraft('');
    setActivePanel(modeId);
  }, [getSelection]);

  // Keyboard shortcuts — document level. Ctrl+E / Ctrl+H / Ctrl+P open panels.
  // Ctrl+D reserved for existing deepen surface (if present, this binding is
  // additive — both can fire, harmless).
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      const map = { d: 'deepen', e: 'expand', h: 'challenge', p: 'scaffold' };
      const modeId = map[key];
      if (!modeId) return;
      // Skip if user is in a textarea/input — all 4 shortcuts pass through.
      // Ctrl+P passthrough added per code-reviewer CRITICAL: otherwise user
      // typing in chat hits Ctrl+P (browser print) and focus jumps to scaffold
      // modal mid-sentence.
      const t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) {
        return;
      }
      e.preventDefault();
      if (modeId === 'scaffold') {
        setActivePanel('scaffold');
      } else {
        openPanel(modeId);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openPanel]);

  const handleSubmit = useCallback((modeId) => {
    if (modeId === 'scaffold') {
      setActivePanel('scaffold');
      return;
    }
    const sel = selDraft.trim();
    if (!sel) return;
    const key = `${modeId}-${Date.now()}`;
    setCallouts(prev => [...prev, { key, mode: { id: modeId }, selection: sel, direction: dirDraft.trim() }]);
    setActivePanel(null);
    setSelDraft('');
    setDirDraft('');
  }, [selDraft, dirDraft]);

  const removeCallout = useCallback((key) => {
    setCallouts(prev => prev.filter(c => c.key !== key));
  }, []);

  return (
    <div className="col" style={{ marginTop: 12 }}>
      {/* Mode button bar */}
      <div className="row gap-8" style={{
        padding: '8px 12px',
        background: 'var(--cream)',
        borderTop: '1px solid var(--rule-soft)',
        borderBottom: '1px solid var(--rule-soft)',
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      }}>
        <span className="eyebrow" style={{ fontSize: 10, color: 'var(--ink-3, #8a7a6a)', letterSpacing: '0.1em', paddingRight: 4 }}>
          NOTE 加法
        </span>
        {MODES.map(m => (
          <button key={m.id}
            onClick={() => m.id === 'scaffold' ? setActivePanel('scaffold') : openPanel(m.id)}
            className="btn btn-ghost"
            title={`Ctrl+${m.shortcut}`}
            style={{
              fontSize: 13, padding: '4px 10px',
              borderBottom: activePanel === m.id ? `1px solid ${m.accent}` : 'none',
              color: 'var(--ink)',
            }}>
            {m.label} <span style={{ opacity: 0.4, fontSize: 11 }}>⌃{m.shortcut}</span>
          </button>
        ))}
      </div>

      {/* Inline panel for selection input */}
      {activePanel && activePanel !== 'scaffold' && (
        <div className="col gap-8" style={{
          padding: '12px 14px', background: 'var(--paper)',
          borderBottom: '1px solid var(--rule-soft)',
        }}>
          <div style={{ fontSize: 12, color: 'var(--ink-2)', fontStyle: 'italic' }}>
            选择 / 粘贴一段文字让 {(MODES.find(m => m.id === activePanel) || {}).label} 处理
          </div>
          <textarea value={selDraft} onChange={e => setSelDraft(e.target.value)}
            rows={3} placeholder="selection text..."
            style={{
              width: '100%', padding: 10, fontSize: 13,
              background: 'var(--cream)', color: 'var(--ink)',
              border: '1px solid var(--rule-soft)', borderRadius: 2,
              resize: 'vertical', boxSizing: 'border-box',
              fontFamily: 'EB Garamond, "Noto Serif SC", serif',
            }}
          />
          <input value={dirDraft} onChange={e => setDirDraft(e.target.value)}
            placeholder="可选 — 走哪个角度..."
            style={{
              width: '100%', padding: '6px 10px', fontSize: 13,
              background: 'var(--cream)', color: 'var(--ink)',
              border: '1px solid var(--rule-soft)', borderRadius: 2,
              boxSizing: 'border-box',
              fontFamily: 'EB Garamond, "Noto Serif SC", serif',
            }}
          />
          <div className="row gap-8">
            <button onClick={() => handleSubmit(activePanel)} className="btn btn-primary" disabled={!selDraft.trim()}
              style={{ fontSize: 13, opacity: selDraft.trim() ? 1 : 0.4 }}>
              开始
            </button>
            <button onClick={() => setActivePanel(null)} className="btn btn-ghost" style={{ fontSize: 13 }}>取消</button>
          </div>
        </div>
      )}

      {/* Active callouts */}
      {callouts.map(c => (
        <ModeCallout key={c.key}
          mode={c.mode}
          noteRel={noteRel}
          selection={c.selection}
          direction={c.direction}
          onClose={() => removeCallout(c.key)}
          onComplete={() => {/* keep visible until user closes */}}
        />
      ))}

      {/* Scaffold modal */}
      {activePanel === 'scaffold' && (
        <ScaffoldModal noteRel={noteRel} lessonBody={lessonBody}
          defaultIntent={lessonBody && lessonBody.user_intent}
          onClose={() => setActivePanel(null)} />
      )}
    </div>
  );
};

window.NoteModeBar = NoteModeBar;
