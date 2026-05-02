// Lacquer-cut spiral path for the deepen running disk (V3.5 Muse design).
// Per /tr 2026-04-29 Muse design-lead: the running state is a lacquer-cutting
// master, not a vinyl playback — needle moves outer→inner, carving a permanent
// groove. 33⅓ rpm = 1800ms/rev. Outer 40, inner 20, 12 turns over 360 segments.
function spiralPathD(outerR, innerR, turns, segs) {
  outerR = outerR || 40; innerR = innerR || 20;
  turns = turns || 12; segs = segs || 360;
  const dr = (outerR - innerR) / segs;
  const dt = (turns * 2 * Math.PI) / segs;
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const r = outerR - dr * i;
    const a = dt * i - Math.PI / 2;
    pts.push((r * Math.cos(a)).toFixed(2) + ',' + (r * Math.sin(a)).toFixed(2));
  }
  return 'M' + pts.join(' L');
}

// DeepenCallout — Path B inline callout (V3.3 SOLO redesign).
//
// Per /tr 2026-04-29 council (Lung/Leo/Yogo + Muse VERDICT):
//   1. Drop "agents discussing" framing. The runtime is a sequential lens
//      pipeline with one-voice synth — show that honestly.
//   2. Drop the "1 of 7" lie (V2 fixed STAGE_ORDER). V3 picks 5-6 of 19
//      catalog angles dynamically; UI now reads stages from runtime, not
//      from a frozen array.
//   3. Drop trace toggle. Each ran lens is clickable from a marginalia
//      roster at the top of the done view; click → expands that lens's
//      raw stage output inline.
//   4. Replace freeform "in what direction?" with 5-primitive cognitive
//      dial: 疑 / 扩 / 抵 / 转 / 凝 (DOUBT / EXPAND / GROUND / REFRAME /
//      CRYSTALLIZE). + 方向 reveals freeform fallback.
//   5. Fitts on actions: 留 (keep) becomes brass-bright bold primary;
//      let-go ink-faint italic tertiary; trace removed.
//
// Phases (state machine UNCHANGED, only rendering differs):
//   prompting → 5-key dial OR freeform direction →
//   running   → dynamic stages from runtime, brass progress hairline →
//   done      → synth markdown + lens-roster marginalia w/ click-to-expand
//
// Style is FIXED at session creation (Cmd+D = denser, Cmd+Shift+D = plainer).
// Mid-stream change = wasteful restart; it's a display-only label.

function DeepenCallout({ mode = 'deepen', selection, noteRel, style, lang, autorun, onPersist, onDiscard, onContinue }) {
  const isQuick = mode === 'quick';
  // Hypha — lesson mode reuses Quick's single-flash code path. A 'lesson' bypasses
  // the prompting phase, opens with autorun, calls window.ptor.llm.lesson(),
  // and renders streamed chunks the same way Quick does (synth-style markdown body).
  const isLesson = mode === 'lesson';
  const [followupQ, setFollowupQ] = React.useState('');
  // autorun = continuation session (parent already gathered intent into
  // augmented selection). Skip prompting, go straight to running.
  const [phase, setPhase] = React.useState(autorun ? 'running' : 'prompting'); // prompting | running | done
  const [direction, setDirection] = React.useState('');
  const [showFreeform, setShowFreeform] = React.useState(false);
  const [stages, setStages] = React.useState({});       // slug → { status, text?, label? }
  const [currentStage, setCurrentStage] = React.useState(null);
  const [synthChunks, setSynthChunks] = React.useState('');
  const [done, setDone] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [collapsed, setCollapsed] = React.useState(false);
  const [expandedLens, setExpandedLens] = React.useState(null);  // slug or null — which marginalia card is open
  const [startedAt, setStartedAt] = React.useState(() => Date.now());
  const [tickT, setTickT] = React.useState(Date.now());
  const requestIdRef = React.useRef('dpn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
  const calloutRef = React.useRef(null);
  const promptInputRef = React.useRef(null);

  // V3 catalog labels (kept here as fallback for stage names the runtime
  // sends back; the actual chosen list comes dynamically from `stages` state).
  const STAGE_LABELS = {
    selector: 'choosing angles',
    scout:    'scouting frontier',
    leo:      'first-principles',
    lung:     'cross-domain',
    nancy:    'Bayesian update',
    occam:    'pruning',
    muse:     'attack',
    contradiction: 'self-contradiction',
    'five-whys':   'five-whys',
    counterfactual: 'counterfactual',
    'second-order': '2nd/3rd order',
    empirical: 'empirical',
    isomorphism: 'isomorphism',
    precedent: 'precedent',
    'devils-advocate': "devil's advocate",
    'failure-mode': 'pre-mortem',
    'weakest-link': 'weakest link',
    distill:  'Feynman compression',
    'frame-flip': 'frame flip',
    'leverage-point': 'leverage point',
    synth:    'weaving',
    quick:    'quick',
    writeback: 'evidence writeback',
  };

  // 5-primitive cognitive dial. Each maps to a direction-text that biases
  // the selector toward the relevant catalog angles.
  // (No backend wiring beyond direction-text — selector reads {{DIRECTION}}
  //  and infers via the conditional rules in deepen-selector.txt.)
  const DIAL = [
    { label: 'doubt',    name: 'doubt',    dir: '找出 selection 里可被证伪的点 / 最弱的承重假设 / 需要被攻击的强主张' },
    { label: 'expand',   name: 'expand',   dir: '把 selection 往前推 2-3 阶后果 / 往大里看, 不止当前 1 阶 outcome' },
    { label: 'ground',   name: 'ground',   dir: '落到具体案例 / 数据 / 真情境 / 真历史先例; 不要抽象不要"在...的语境下"' },
    { label: 'reframe',  name: 'reframe',  dir: '换 3 个不兼容的框架重看 selection / 跳出当前默认视角 / 跨域同构' },
    { label: 'compress', name: 'compress', dir: '压缩到承重核心 / Feynman 级通俗化 ≤ 3 段 / 砍冗余留 atom' },
  ];

  // Auto-scroll callout into view on mount.
  React.useEffect(() => {
    if (calloutRef.current) {
      requestAnimationFrame(() => {
        calloutRef.current && calloutRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  }, []);

  // Auto-focus prompt freeform input when revealed.
  React.useEffect(() => {
    if (phase === 'prompting' && showFreeform && promptInputRef.current) {
      promptInputRef.current.focus();
    }
  }, [phase, showFreeform]);

  // Tick clock every second while running (powers M:SS + ago).
  React.useEffect(() => {
    if (phase !== 'running' || done) return;
    const id = setInterval(() => setTickT(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase, done]);

  // Pipeline starts when phase enters 'running'. Direction is captured at
  // that moment; subsequent direction changes are no-ops.
  React.useEffect(() => {
    if (phase !== 'running') return;
    let mounted = true;
    if (!window.ptor || !window.ptor.llm) {
      setError('ptor.llm bridge missing'); setDone(true); return;
    }
    if (isQuick && !window.ptor.llm.quick) {
      setError('ptor.llm.quick bridge missing'); setDone(true); return;
    }
    if (isLesson && !window.ptor.llm.lesson) {
      setError('ptor.llm.lesson bridge missing'); setDone(true); return;
    }
    if (!isQuick && !isLesson && !window.ptor.llm.deepen) {
      setError('ptor.llm.deepen bridge missing'); setDone(true); return;
    }
    setStartedAt(Date.now());
    setTickT(Date.now());
    const unsub = window.ptor.llm.onDeepenProgress((p) => {
      if (!mounted || p.requestId !== requestIdRef.current) return;
      if (p.status === 'start') {
        setCurrentStage(p.stage);
        setStages(s => ({ ...s, [p.stage]: { status: 'running', label: p.label } }));
      } else if (p.status === 'chunk') {
        // V3.9: synth-only chunk streaming. Hypha lesson mode also drips chunks
        // into the synth body (one tutor turn = one streamed answer).
        if (p.stage === 'synth' || p.stage === 'quick' || p.stage === 'lesson') {
          setSynthChunks(t => t + (p.text || ''));
        }
      } else if (p.status === 'done') {
        setStages(s => ({ ...s, [p.stage]: { status: 'done', text: p.text, label: p.label } }));
        if ((p.stage === 'synth' || p.stage === 'quick' || p.stage === 'lesson') && p.text) setSynthChunks(p.text);
      } else if (p.status === 'retry') {
        setStages(s => ({ ...s, [p.stage]: { status: 'retry', attempt: p.attempt, error: p.error, label: STAGE_LABELS[p.stage] || p.label } }));
      } else if (p.status === 'error') {
        setStages(s => ({ ...s, [p.stage]: { status: 'error', error: p.error, label: p.label } }));
      }
    });
    const callP = isLesson
      ? window.ptor.llm.lesson({
          noteRel: noteRel || '',
          userMsg: selection || '__begin__',
          requestId: requestIdRef.current,
        })
      : isQuick
      ? window.ptor.llm.quick(selection, noteRel || '', lang || 'zh', direction, requestIdRef.current)
      : window.ptor.llm.deepen(selection, noteRel || '', style, lang || 'zh', direction, requestIdRef.current);
    callP
      .then(res => {
        if (!mounted) return;
        if (!res.ok) setError(res.error || (isLesson ? 'lesson failed' : isQuick ? 'quick failed' : 'deepen failed'));
        setDone(true);
      })
      .catch(err => { if (mounted) { setError(String(err && err.message || err)); setDone(true); } });
    return () => {
      mounted = false; unsub();
      if (isLesson) { try { window.ptor.llm.lessonAbort && window.ptor.llm.lessonAbort(requestIdRef.current); } catch (_) {} }
      else { window.ptor.llm.deepenAbort(requestIdRef.current); }
    };
  }, [phase, selection, noteRel, style, lang, direction, isQuick, isLesson]);

  // Markdown render (white-listed) — same pipeline as NoteView.
  const synthHtml = React.useMemo(() => {
    if (!synthChunks) return '';
    if (typeof window.marked === 'undefined' || typeof window.DOMPurify === 'undefined') {
      const esc = synthChunks.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
      return esc.split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
    }
    try {
      const raw = window.marked.parse(synthChunks, { gfm: true, breaks: false });
      return window.DOMPurify.sanitize(raw, {
        ALLOWED_TAGS: ['p', 'em', 'strong', 'ul', 'ol', 'li', 'blockquote', 'a', 'code'],
        ALLOWED_ATTR: ['href', 'target', 'rel'],
      });
    } catch (e) { return synthChunks; }
  }, [synthChunks]);

  const elapsedSec = Math.max(0, Math.floor((tickT - startedAt) / 1000));
  const ago = (() => {
    if (phase !== 'running' && phase !== 'done') return '';
    if (elapsedSec < 60) return elapsedSec + 's ago';
    const min = Math.floor(elapsedSec / 60);
    return min + ' min ago';
  })();
  const elapsedFmt = (() => {
    const m = Math.floor(elapsedSec / 60);
    const s = elapsedSec % 60;
    return m + ':' + String(s).padStart(2, '0');
  })();
  // V3.12: todayMMDD const dropped — footer date no longer rendered.

  // V3 dynamic — actual stages that ran/are-running this turn. Selector +
  // synth + writeback are infrastructure, not lenses; filter them out for
  // the lens-roster marginalia. They DO appear in the running progress dots
  // since they ARE work being done.
  const allStageSlugs = Object.keys(stages);
  const lensSlugs = allStageSlugs.filter(s =>
    s !== 'selector' && s !== 'synth' && s !== 'quick' && s !== 'writeback'
  );
  // V3.9 phase-event progress (per user 2026-04-29 "阶段而不是时间"):
  //   - lens stages each contribute 1 unit on `done`
  //   - synth start contributes 0.7 of synth's unit ("开始整理了")
  //   - synth done contributes the remaining 0.3 → snap to 100%
  // selector + writeback are infrastructure (not visible "phases"), excluded.
  // Total = lens count + 1 (the synth phase).
  const lensSlugs_progress = allStageSlugs.filter(s =>
    s !== 'selector' && s !== 'synth' && s !== 'quick' && s !== 'writeback'
  );
  const lensesDone = lensSlugs_progress.filter(s => stages[s] && stages[s].status === 'done').length;
  const synthState = stages.synth || stages.quick || null;
  const synthBonus = synthState
    ? (synthState.status === 'done' ? 1 : (synthState.status === 'running' ? 0.7 : 0))
    : 0;
  const progressTotal = (lensSlugs_progress.length || 1) + 1;  // +1 for synth phase
  const progressDoneCount = lensesDone + (synthBonus >= 1 ? 1 : 0);  // for "N/M" display, count done synth as +1
  const fineProgress = (lensesDone + synthBonus) / progressTotal;

  // Lacquer Loop W7 v1.3 — feed RuntimeSubstrate.a1Cure with deepen progress so
  // any visible VinylSpinner / motion components share the cure-clock with this
  // disk. Pulled from substrate.a2Delta to modulate revolution time within
  // ±15% of nominal 33⅓ rpm (1800ms): high prediction-error → 1500ms (taut),
  // low → 2200ms (slow breath). Subliminal — the disk is supposed to FEEL alive
  // without the user consciously noticing the rate change.
  const substrate = (window.RuntimeSubstrate && window.RuntimeSubstrate.useSubstrate)
    ? window.RuntimeSubstrate.useSubstrate()
    : { a2Delta: 0, motionLevel: 'full' };
  React.useEffect(() => {
    if (!window.RuntimeSubstrate) return;
    if (phase === 'running' && !error) {
      window.RuntimeSubstrate.set({ a1Cure: fineProgress });
    } else if (done) {
      window.RuntimeSubstrate.set({ a1Cure: 1 });
    }
    return () => {
      if (window.RuntimeSubstrate) window.RuntimeSubstrate.set({ a1Cure: 0 });
    };
  }, [phase, fineProgress, done, error]);
  const revMs = (substrate.motionLevel === 'full' && !done && !error)
    ? Math.round(2200 - 700 * Math.max(0, Math.min(1, substrate.a2Delta || 0)))
    : 1800;

  const handleFreeformKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      setPhase('running');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onDiscard && onDiscard();
    }
  };

  const showStatus = phase === 'running' && (!done || (!synthHtml && !error));

  return (
    <div ref={calloutRef} className="deepen-callout">
      <style>{`
        .deepen-callout {
          /* V3.11 (huashu-design lesson 2026-04-29): kill border-radius.
             Rounded card + left-accent border = Material/Tailwind 2020-2024
             cliché flagged in huashu anti-pattern list. Sharp 0 + warm
             paper-stock bg + brass left rule = letterpress block on a
             manuscript page register, not Material card. */
          margin: 32px 0;
          padding: 22px 28px 22px 26px;
          border-left: 3px solid var(--brass-mid);
          background: var(--bg-deepen-card, transparent);
          border-radius: 0;
          font-family: "EB Garamond", "Noto Serif SC", "Source Han Serif SC", serif;
          font-size: 18px; line-height: 1.78;
          color: var(--ink-primary);
          animation: deepen-mount 320ms cubic-bezier(0.22, 1, 0.36, 1);
          position: relative;
        }
        .deepen-callout .deepen-callout {
          border-left-width: 2px;
          border-left-color: color-mix(in srgb, var(--brass-mid) 50%, transparent);
          margin-left: -8px;
        }
        .deepen-callout:has(.deepen-callout .deepen-callout) { display: none; }

        /* PROMPTING — 5-key cognitive dial. + 方向 unfolds freeform input. */
        .deepen-dial-row {
          display: flex; align-items: baseline; gap: 8px;
          padding: 8px 0;
          flex-wrap: wrap;
        }
        .deepen-dial-prompt {
          font-family: "EB Garamond", "Noto Serif SC", serif;
          font-style: italic; font-size: 14.5px;
          color: var(--ink-faint);
          letter-spacing: 0.005em;
          margin-right: 6px;
        }
        .deepen-dial-key {
          font-family: "EB Garamond", "Noto Serif SC", serif;
          font-style: italic; font-weight: 500;
          font-size: 16px; line-height: 1.3;
          color: var(--ink-title);
          background: transparent; border: none; cursor: pointer;
          padding: 4px 10px;
          letter-spacing: 0.005em;
          transition: color 220ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        .deepen-dial-key:hover { color: var(--brass-bright); }
        /* CONTINUE GLYPH — sole non-word affordance in the dial. V3.7 Lung
           verdict 2026-04-29 (替 V3.6 的 ⟶ 箭头, user 嫌丑跳脱出箭头):
           "&c." = medieval et cetera, italic Garamond. Aldus Manutius 1501
           octavo Virgil 用的就是这个 — 抄本时代 reader 把列举之外的部分
           交给训练有素的 apparatus。"and the rest, system picks." Period
           seals the closure (vs bare & 是开放的). Register = scribal
           Lesezimmer, not 20-century clerical etc. Italic survives because
           the glyph IS decoration AND action — established editorial mark. */
        .deepen-dial-etc {
          font-family: "EB Garamond", "Garamond Premier Pro", Garamond, serif;
          font-style: italic;
          font-weight: 500;
          font-size: 16px; line-height: 1.3;
          letter-spacing: 0.01em;
          color: var(--ink-title);
          background: transparent; border: none; cursor: pointer;
          padding: 4px 10px;
          margin: 0 2px;
          opacity: 0.72;
          transition: color 220ms cubic-bezier(0.22, 1, 0.36, 1),
                      opacity 220ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        .deepen-dial-etc:hover,
        .deepen-dial-etc:focus-visible {
          color: var(--brass-bright);
          opacity: 1;
          outline: none;
        }
        .deepen-dial-etc:focus-visible {
          text-decoration: underline;
          text-decoration-thickness: 0.5px;
          text-underline-offset: 3px;
        }
        .deepen-dial-more {
          font-family: "EB Garamond", serif;
          font-style: italic; font-size: 12.5px;
          color: var(--ink-faint);
          background: transparent; border: none; cursor: pointer;
          padding: 4px 0;
          margin-left: auto;
          opacity: 0.78;
        }
        .deepen-dial-more:hover { color: var(--brass-mid); opacity: 1; }
        .deepen-dial-input {
          flex-basis: 100%;
          background: transparent; border: none; outline: none;
          border-bottom: 0.5px solid color-mix(in srgb, var(--brass-mid) 60%, transparent);
          font-family: "EB Garamond", "Noto Serif SC", serif;
          font-style: italic; font-size: 16px;
          color: var(--ink-title);
          padding: 6px 0 4px;
          margin-top: 6px;
        }
        .deepen-dial-input::placeholder { color: var(--ink-faint); opacity: 0.7; }
        .deepen-dial-hint {
          font-family: "EB Garamond", serif;
          font-style: italic; font-size: 11.5px;
          color: var(--ink-faint);
          opacity: 0.65;
          flex-basis: 100%;
          margin-top: 4px;
          letter-spacing: 0.005em;
        }

        /* HEADER — shown during running + done */
        .deepen-header {
          display: flex; flex-wrap: wrap;
          align-items: baseline; column-gap: 12px; row-gap: 4px;
          margin-bottom: 14px;
        }
        .deepen-header-title {
          font-family: "EB Garamond", "Noto Serif SC", serif;
          font-style: italic; font-weight: 500;
          font-size: 17px;
          color: var(--ink-title);
          letter-spacing: 0.005em;
        }
        .deepen-header-dot { color: var(--brass-mid); opacity: 0.6; font-style: normal; }
        .deepen-header-ago {
          font-family: "EB Garamond", serif;
          font-style: italic; font-size: 13.5px;
          color: var(--ink-faint);
          font-variant-numeric: tabular-nums;
        }
        .deepen-header-label {
          font-family: "EB Garamond", serif;
          font-style: italic; font-size: 14px;
          color: var(--ink-faint);
          letter-spacing: 0.005em;
          opacity: 0.85;
          user-select: none;
        }
        .deepen-header-direction {
          font-family: "EB Garamond", "Noto Serif SC", serif;
          font-style: italic; font-size: 13.5px;
          color: var(--ink-muted);
          opacity: 0.85;
          max-width: 28ch;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .deepen-header-meta {
          margin-left: auto;
          display: flex; gap: 18px; align-items: baseline;
        }
        /* Tertiary chips: fold + let-go. Italic, ink-faint. */
        .deepen-header-chip {
          font-family: "EB Garamond", "Noto Serif SC", serif;
          font-style: italic;
          font-size: 14px;
          color: var(--ink-faint);
          letter-spacing: 0.005em;
          background: transparent; border: none; cursor: pointer; padding: 3px 0;
          transition: color 240ms cubic-bezier(0.22, 1, 0.36, 1);
          opacity: 0.78;
        }
        .deepen-header-chip:hover { color: var(--brass-mid); opacity: 1; }
        .deepen-header-chip.danger:hover { color: var(--verdict-flag, #c46a5d); opacity: 1; }
        /* Primary action: keep. Roman bold, brass-bright. (Fitts.) */
        .deepen-header-keep {
          font-family: "EB Garamond", "Noto Serif SC", serif;
          font-style: normal; font-weight: 600;
          font-size: 15px;
          color: var(--brass-bright);
          letter-spacing: 0.01em;
          background: transparent; border: none; cursor: pointer;
          padding: 3px 6px;
          transition: color 200ms;
        }
        .deepen-header-keep:hover { color: var(--ink-title); }

        /* PROGRESS — single brass hairline that fills as stages complete.
           Replaces the old 7-dot row + "1 of 7" lie. */
        /* PROGRESS — V3.5 Muse lacquer-cut design. 88px SVG disk spinning
           33⅓ rpm; spiral cut fills outer→inner as stages complete; on done,
           disk slows + spiral holds then fades. No tonearm (cliché). */
        .deepen-progress {
          display: flex; align-items: center; gap: 18px;
          padding: 6px 0 22px;
        }
        .deepen-disk {
          flex-shrink: 0;
          /* Approx total path length for outerR=40, innerR=20, turns=12, segs=360
             — measured ~380px so dasharray covers the full spiral. */
          --cut-len: 380;
          animation: lacquer-spin 1800ms linear infinite;
          transform-origin: 50% 50%;
        }
        .deepen-disk-stopping {
          animation: lacquer-stop 280ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
        }
        @keyframes lacquer-spin { to { transform: rotate(360deg); } }
        @keyframes lacquer-stop {
          0%   { transform: rotate(0deg); }
          100% { transform: rotate(20deg); }
        }
        .deepen-progress-textcol {
          display: flex; flex-direction: column; gap: 4px;
          flex: 1; min-width: 0;
        }
        .deepen-progress-stage {
          font-family: "EB Garamond", "Noto Serif SC", serif;
          font-style: normal; font-weight: 500;
          font-size: 14.5px; line-height: 1.3;
          letter-spacing: 0.005em;
          color: var(--ink-muted);
          font-feature-settings: "onum" 1, "calt" 1;
        }
        .deepen-progress-stage .tail {
          font-style: italic;
          margin-left: 1px;
          color: var(--brass-mid);
          opacity: 0.7;
        }
        .deepen-progress-meta {
          font-family: "Cormorant Garamond", "EB Garamond", serif;
          font-variant-caps: all-small-caps;
          font-feature-settings: "tnum" 1, "lnum" 1;
          font-size: 12px;
          letter-spacing: 0.06em;
          color: var(--ink-faint);
          opacity: 0.78;
        }
        .deepen-progress-meta-dot {
          color: var(--brass-mid);
          opacity: 0.55;
          font-style: normal;
          margin: 0 6px;
          letter-spacing: 0;
        }
        .deepen-progress.fading {
          animation: deepen-status-fade 280ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }

        /* LENS ROSTER — top of done view. Each ran lens (catalog angle slug)
           is clickable italic Garamond. Click → expands raw stage output
           inline below synth. This is the Talmudic-marginalia move
           (per /tr 2026-04-29 Yogo+Leo convergence). */
        /* STAGE — V3.12 (huashu Pentagram + Aldine 1501): 2-column grid,
           synth body in left column (62ch ragged-right Bringhurst measure),
           lens slugs in right gutter as Tosafot/Aldine marginalia anchors.
           Gutter sits ~96px wide, vertical, italic Garamond — feels like
           commentaries hanging off the page edge, NOT a tab bar. */
        .deepen-stage {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          column-gap: 32px;
          align-items: start;
        }
        .deepen-gutter {
          display: flex; flex-direction: column;
          gap: 6px;
          align-items: flex-start;
          padding-top: 6px;
          min-width: 84px;
          max-width: 120px;
        }
        .deepen-lens-slug {
          display: block;
          font-family: "EB Garamond", "Noto Serif SC", serif;
          font-style: italic;
          font-size: 13px;
          line-height: 1.45;
          color: var(--ink-muted);
          background: transparent; border: none; cursor: pointer;
          padding: 1px 0;
          letter-spacing: 0.005em;
          text-align: left;
          transition: color 200ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        .deepen-lens-slug:hover { color: var(--brass-bright); }
        .deepen-lens-slug.active {
          color: var(--brass-bright);
          font-weight: 500;
        }
        @media (max-width: 720px) {
          /* Narrow callout: stack synth + gutter, gutter becomes horizontal
             pill row at bottom of synth — degrades cleanly. */
          .deepen-stage { grid-template-columns: 1fr; gap: 16px; }
          .deepen-gutter { flex-direction: row; flex-wrap: wrap; max-width: none; padding-top: 12px; gap: 10px; }
        }

        /* LENS EXPANSION — when a lens slug is clicked, the raw stage text
           appears here. Quote-card with brass left rule. */
        .deepen-lens-expanded {
          margin: 0 0 22px;
          padding: 14px 0 14px 18px;
          border-left: 1px solid color-mix(in srgb, var(--brass-mid) 35%, transparent);
          font-family: "EB Garamond", "Noto Serif SC", serif;
          font-size: 15px;
          line-height: 1.62;
          color: var(--ink-muted);
          font-style: italic;
          white-space: pre-wrap;
          animation: deepen-mount 240ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        .deepen-lens-expanded-name {
          display: block;
          font-family: "JetBrains Mono", monospace;
          font-style: normal;
          font-size: 11px;
          letter-spacing: 0.08em;
          color: var(--ink-faint);
          margin-bottom: 8px;
          text-transform: lowercase;
        }

        /* SYNTH — editorial prose, NoteView body register.
           V3.4 (per /tr 2026-04-29 Lung+Leo+Yogo convergence): synth output
           rewritten as 2-4 paragraph essay, no markdown bold-as-section
           headers, no triangle bullet lists. The CSS below treats strong
           as INLINE bold emphasis (not block section header) and ul as
           user-style list (synth shouldn't emit one, but if it does it
           doesn't get the dashboard treatment).
           NOTE: comment text MUST NOT contain backtick chars — this whole
           CSS block lives inside a JS template literal, an unescaped one
           would terminate the template and crash with section-not-defined. */
        .deepen-synth h1, .deepen-synth h2, .deepen-synth h3,
        .deepen-synth h4, .deepen-synth h5, .deepen-synth h6 { display: none; }
        .deepen-synth p {
          margin: 0 0 1.05em; font-size: 18px; line-height: 1.78;
          /* V3.12 (Lung D5 fix): bump synth body to 500 weight. Garamond
             italic at 18px on espresso bg renders too thin in Electron
             Chromium without weight reinforcement. NoteView body uses
             default weight on cream day-mode and reads fine; on dark
             night the stems lose presence. 500 keeps editorial polish. */
          font-weight: 500;
          color: var(--ink-primary);
          /* V3.11 huashu-design typographic refinement: pretty wrap +
             hanging punctuation. Bringhurst Ch. 5 §1. Free win, no JS cost. */
          text-wrap: pretty;
          hanging-punctuation: first last;
        }
        .deepen-synth p:first-child { margin-top: 0; }
        .deepen-synth p:last-child { margin-bottom: 0; }
        /* Inline bold — used for emphasis on 1-2 short phrases per essay,
           NOT as section header. Same register as NoteView body strong. */
        .deepen-synth strong {
          font-weight: 600;
          color: var(--ink-title);
          font-style: normal;
        }
        .deepen-synth em {
          font-style: italic;
          color: var(--hush);
        }
        .deepen-synth ul, .deepen-synth ol {
          margin: 0.6em 0 1.05em; padding-left: 22px;
        }
        .deepen-synth li { margin: 4px 0; font-size: 18px; line-height: 1.74; }
        .deepen-synth ul > li::marker { color: var(--brass-mid); }
        .deepen-synth ol > li::marker { color: var(--brass-mid); }
        .deepen-synth blockquote {
          margin: 14px 0;
          padding: 0.2em 0 0.2em 16px;
          border-left: 1px solid color-mix(in srgb, var(--brass-mid) 35%, transparent);
          color: var(--ink-muted);
          font-style: italic;
          font-size: 16.5px;
        }
        .deepen-synth a {
          color: var(--brass-bright);
          text-decoration: none;
          border-bottom: 1px solid color-mix(in srgb, var(--brass-mid) 50%, transparent);
        }
        .deepen-synth a:hover { color: var(--ink-title); border-bottom-color: var(--brass-bright); }
        .deepen-synth code {
          font-family: "JetBrains Mono", monospace;
          font-size: 14px;
          background: color-mix(in srgb, var(--brass-mid) 12%, transparent);
          padding: 1px 6px; border-radius: 3px;
        }

        .deepen-cursor {
          display: inline-block; width: 1ch;
          color: var(--brass-mid);
          animation: deepen-blink 1.1s step-end infinite;
          margin-left: 1px;
        }
        /* V3.12: .deepen-footer dropped. Header has "ago" already; date
           was redundant per Tufte data-ink. */

        /* CONTINUE — V3.12: just the input. Chips lifted to header,
           hint removed (Hara minimalism — Enter/Shift+Enter discoverable
           on first try). */
        .deepen-continue {
          margin-top: 22px;
          padding-top: 18px;
          border-top: 0.5px solid color-mix(in srgb, var(--brass-mid) 22%, transparent);
        }
        .deepen-continue-input {
          width: 100%;
          background: transparent; border: none; outline: none;
          font-family: "EB Garamond", "Noto Serif SC", serif;
          font-style: italic;
          font-size: 16.5px; line-height: 1.6;
          color: var(--ink-primary);
          letter-spacing: 0.005em;
          padding: 0;
        }
        .deepen-continue-input::placeholder {
          color: var(--ink-faint); opacity: 0.7; font-style: italic;
        }
        .deepen-error {
          color: var(--verdict-flag, #c46a5d);
          font-style: italic;
          font-size: 15px;
          padding: 10px 0;
          font-family: "EB Garamond", serif;
        }

        @keyframes deepen-mount {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes deepen-blink { 50% { opacity: 0.15; } }
        @keyframes deepen-status-fade {
          from { opacity: 1; max-height: 80px; }
          to   { opacity: 0; max-height: 0; padding: 0; margin: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .deepen-callout, .deepen-disk, .deepen-disk-stopping { animation: none; transition: none; }
          .deepen-cursor { animation: none; opacity: 0.5; }
        }
      `}</style>

      {/* PROMPTING — 5-key cognitive dial. */}
      {phase === 'prompting' && !isQuick && (
        <div className="deepen-dial-row">
          {/* V3.11: dropped "deepen it?" prompt label per huashu Hara
              minimalism — the dial speaks for itself; the label was filler. */}
          {DIAL.map(p => (
            <button
              key={p.label}
              className="deepen-dial-key"
              title={p.dir.slice(0, 80)}
              onClick={() => { setDirection(p.dir); setPhase('running'); }}
            >{p.label}</button>
          ))}
          <button
            className="deepen-dial-etc"
            title="and the rest — system picks"
            aria-label="yield direction; let the system choose lenses"
            onClick={() => { setDirection(''); setPhase('running'); }}
          >&amp;c.</button>
          <button
            className="deepen-dial-more"
            onClick={() => setShowFreeform(v => !v)}
          >{showFreeform ? '× hide' : '+ direction'}</button>
          {showFreeform && (
            <input
              ref={promptInputRef}
              type="text"
              className="deepen-dial-input"
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
              onKeyDown={handleFreeformKey}
              placeholder="custom direction, just write, Enter to submit"
            />
          )}
          {showFreeform && (
            <span className="deepen-dial-hint">enter · esc to cancel</span>
          )}
        </div>
      )}

      {/* PROMPTING (quick) — quick path skips dial, goes straight in. */}
      {phase === 'prompting' && isQuick && (
        <div className="deepen-dial-row">
          <span className="deepen-dial-prompt">quick</span>
          <input
            ref={promptInputRef}
            type="text"
            className="deepen-dial-input"
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
            onKeyDown={handleFreeformKey}
            placeholder="one-line question, or just Enter"
            autoFocus
          />
          <span className="deepen-dial-hint">enter · esc to cancel</span>
        </div>
      )}

      {/* HEADER — running + done. */}
      {phase !== 'prompting' && (
        <div className="deepen-header">
          <span className="deepen-header-title">
            {isQuick
              ? (done ? 'asked' : 'asking')
              : (done ? 'deepened' : 'deepening')}
          </span>
          <span className="deepen-header-dot">·</span>
          <span className="deepen-header-ago">{ago}</span>
          {!isQuick && (
            <span className="deepen-header-label">
              {style === 'plainer' ? 'plainer' : 'denser'}
            </span>
          )}
          {isQuick && (
            <span className="deepen-header-label">quick</span>
          )}
          {direction && (
            <span
              className="deepen-header-direction"
              title={direction}
            >→ {direction}</span>
          )}
          <span className="deepen-header-meta">
            {/* V3.12 (huashu Tufte data-ink): 再深/反看 lifted from continue
                row up to header — collapses 3 decision surfaces (header / body
                / continue) into 1 (header). Continue row keeps only the input
                affordance. */}
            {done && synthHtml && onContinue && (
              <button
                className="deepen-header-chip"
                onClick={() => onContinue('deepen', '深一层, 不重复上轮论点, 找上轮没说透的层', synthChunks)}
                title="go deeper — push past this round"
              >go deeper</button>
            )}
            {done && synthHtml && onContinue && (
              <button
                className="deepen-header-chip"
                onClick={() => onContinue('deepen', '从相反角度重看, 挑战上轮结论', synthChunks)}
                title="counter — argue the opposite"
              >counter</button>
            )}
            <button
              className="deepen-header-chip"
              onClick={() => setCollapsed(v => !v)}
              title={collapsed ? 'unfold' : 'fold'}
            >{collapsed ? 'unfold' : 'fold'}</button>
            {done && synthHtml && onPersist && (
              <button
                className="deepen-header-keep"
                onClick={() => onPersist(synthChunks, style)}
                title="keep — write into note"
              >keep</button>
            )}
            {onDiscard && (
              <button
                className="deepen-header-chip danger"
                onClick={onDiscard}
                title="let go — don't save"
              >let go</button>
            )}
          </span>
        </div>
      )}

      {/* PROGRESS — single brass hairline + dynamic stage label. No more
          "1 of 7" lie; uses runtime-reported stage count. Quick path: just
          italic "asking…" + elapsed. */}
      {!collapsed && showStatus && !isQuick && (
        <div className={'deepen-progress' + (done && synthHtml ? ' fading' : '')}>
          <svg
            className={'deepen-disk' + (done ? ' deepen-disk-stopping' : '')}
            width="88" height="88" viewBox="-44 -44 88 88"
            aria-hidden="true"
            style={{ animationDuration: revMs + 'ms' }}
          >
            <circle r="42" fill="var(--bg-deepen-disk, #1a0c08)" />
            <circle r="42" fill="none" stroke="var(--brass-mid)" strokeWidth="0.75" opacity="0.55" />
            <circle r="18" fill="none" stroke="var(--brass-mid)" strokeWidth="0.5"  opacity="0.30" />
            <path
              className="deepen-disk-cut"
              d={spiralPathD(40, 20, 12, 360)}
              fill="none"
              stroke="var(--brass-bright)"
              strokeWidth="0.75"
              strokeLinecap="round"
              opacity="0.92"
              style={{
                strokeDasharray: 'var(--cut-len)',
                strokeDashoffset: `calc(var(--cut-len) * (1 - ${fineProgress}))`,
                transition: 'stroke-dashoffset 280ms cubic-bezier(0.22, 1, 0.36, 1)',
              }}
            />
          </svg>
          <div className="deepen-progress-textcol">
            <span className="deepen-progress-stage">
              {(() => {
                if (error) return 'interrupted';
                if (!currentStage) return (<>starting<span className="tail">…</span></>);
                const cur = stages[currentStage];
                const label = (cur && cur.label) || STAGE_LABELS[currentStage] || currentStage;
                if (cur && cur.status === 'retry') return (<>{label} (retrying)<span className="tail">…</span></>);
                return (<>{label}{!done && <span className="tail">…</span>}</>);
              })()}
            </span>
            {!error && (
              <span className="deepen-progress-meta">
                {progressDoneCount}/{progressTotal}
                <span className="deepen-progress-meta-dot">·</span>
                {elapsedFmt}
              </span>
            )}
          </div>
        </div>
      )}
      {!collapsed && showStatus && isQuick && (
        <div className={'deepen-progress' + (done && synthHtml ? ' fading' : '')}>
          <div className="deepen-progress-textcol">
            <span className="deepen-progress-stage">
              {error ? 'interrupted' : (done ? 'asked' : (<>asking<span className="tail">…</span></>))}
            </span>
            {!error && !done && (
              <span className="deepen-progress-meta">{elapsedFmt}</span>
            )}
          </div>
        </div>
      )}

      {/* SYNTH + GUTTER — V3.12 (huashu Pentagram Info Architecture +
          Aldine 1501 marginalia): synth in center column, lens slugs in
          right gutter as Tosafot-style commentary anchors. Click slug →
          inline expansion below. Drops the old top-bar lens roster (was
          tab-bar cliché per Lung D2). */}
      {!collapsed && phase !== 'prompting' && (synthChunks || error) && (
        <div className="deepen-stage">
          <div className="deepen-synth">
            {synthHtml && <span dangerouslySetInnerHTML={{ __html: synthHtml }} />}
            {!done && synthHtml && <span className="deepen-cursor">▍</span>}
            {error && <div className="deepen-error">{error}</div>}
          </div>
          {done && !isQuick && lensSlugs.length > 0 && (
            <aside className="deepen-gutter">
              {lensSlugs.map(sid => {
                const isActive = expandedLens === sid;
                const s = stages[sid];
                const failed = s && s.status === 'error';
                return (
                  <button
                    key={sid}
                    className={'deepen-lens-slug' + (isActive ? ' active' : '')}
                    onClick={() => setExpandedLens(isActive ? null : sid)}
                    title={STAGE_LABELS[sid] || sid}
                    style={failed ? { color: 'var(--verdict-flag, #c46a5d)' } : undefined}
                  >{sid}</button>
                );
              })}
            </aside>
          )}
        </div>
      )}

      {/* LENS EXPANSION — clicked lens's raw stage output, full-width below. */}
      {!collapsed && done && expandedLens && stages[expandedLens] && stages[expandedLens].text && (
        <div className="deepen-lens-expanded">
          <span className="deepen-lens-expanded-name">{expandedLens} — {STAGE_LABELS[expandedLens] || ''}</span>
          {stages[expandedLens].text}
        </div>
      )}

      {/* CONTINUE — V3.12: just the input. Chips lifted to header. Hint
          dropped (Hara minimalism — Enter/Shift+Enter is discoverable on
          first try, doesn't need a label). */}
      {!collapsed && done && synthHtml && onContinue && (
        <div className="deepen-continue">
          <input
            className="deepen-continue-input"
            type="text"
            placeholder="ask more, or push from another angle…"
            value={followupQ}
            onChange={(e) => setFollowupQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const q = followupQ.trim();
                if (!q) return;
                onContinue(e.shiftKey ? 'deepen' : 'quick', q, synthChunks);
                setFollowupQ('');
              } else if (e.key === 'Escape') {
                setFollowupQ('');
                e.currentTarget.blur();
              }
            }}
          />
        </div>
      )}

      {/* V3.12: footer date dropped. Header already shows "ago" — date was
          redundant per Tufte data-ink. */}
    </div>
  );
}

Object.assign(window, { DeepenCallout });
