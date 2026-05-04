// NoteView — reads a vault note via window.ptor.vault.read(rel),
// renders markdown body via marked + DOMPurify.
// Double-click toggles between rendered preview and raw editor.

// Error boundary — catches render errors in DeepenCallout (or any other
// child mounted via portal) so an exception in one component doesn't take
// down the entire NoteView tree (= "Cmd+D 后整个屏幕变背景色" symptom).
// Logs full error + stack to console so DevTools surfaces the actual cause.
class DeepenErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error: error }; }
  componentDidCatch(error, info) {
    console.error('[deepen-error-boundary] DeepenCallout crashed:', error);
    console.error('[deepen-error-boundary] component stack:', info && info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          margin: '32px 0', padding: '14px 18px',
          borderLeft: '3px solid var(--verdict-flag, #c46a5d)',
          background: 'var(--bg-base)',
          fontFamily: '"EB Garamond", "Noto Serif SC", serif',
          fontStyle: 'italic', fontSize: 14, lineHeight: 1.6,
          color: 'var(--verdict-flag, #c46a5d)',
        }}>
          deepen 渲染挂了 — F12 看 console 红字: {String(this.state.error.message || this.state.error)}
        </div>
      );
    }
    return this.props.children;
  }
}

function RecallNoteView({ rel, onBack }) {
  const [body, setBody] = React.useState('');
  const [meta, setMeta] = React.useState(null);
  const [mode, setMode] = React.useState('render'); // 'render' | 'edit'
  const [error, setError] = React.useState(null);
  // Corpus signals (strength + cite count + recall count) — purely decorative
  // footer chip; null until corpus:meta resolves. Refreshes on rel change.
  const [corpus, setCorpus] = React.useState(null);
  // Idle-fade for the back chevron — visible at first, fades after 5s,
  // restores instantly when mouse enters top-left 200×80 corner zone.
  const [chevronVisible, setChevronVisible] = React.useState(true);
  const idleTimerRef = React.useRef(null);
  // ref to scroll container (instant scrollTop=0 on rel change)
  const stageRef = React.useRef(null);
  // ref to .note-page — Web Animations API target for blur fade-in (replaces VT
  // which Chromium silently skipped on every switch — vt.ready never fired,
  // vt.finished in 6-19ms = no animation actually played).
  const notePageRef = React.useRef(null);
  // Tracks last loaded rel so navigations (rel change) trigger animation,
  // but in-place body edits (same rel, different body) don't.
  const prevRelRef = React.useRef(null);
  // Cmd+K — DEPRECATED AskCard浮卡 path (kept for code safety, not invoked).
  // Per 2026-04-28 council Path B: cmd+K creates inline DeepenCallout sessions
  // rendered as React siblings inside .note-page. Sessions are ephemeral
  // per-rel — they clear when user navigates to a different note. User can
  // explicitly persist via 留 chip → vault.write append.
  const [askCard, setAskCard] = React.useState(null);
  const [deepenSessions, setDeepenSessions] = React.useState([]);
  // Clear sessions on rel change (sessions are scoped to current note view)
  React.useEffect(() => { setDeepenSessions([]); }, [rel]);

  // 2026-05-03 v0148 — Recall inline deepen (user pivot from v0147 route-to-chat).
  // User explicit: "不是 ask in chat 而是在当前页面 deepen 然后生成的内容就在
  // 该内容段落正下方就行". Stay on Recall view; mount DeepenCallout INLINE
  // below the source paragraph. Reuses RecallNoteView's existing
  // deepenSessions state + DeepenCallout portal renderer (line 1707) — same
  // mechanism the long-deleted Cmd+K used. Selection-based granularity (not
  // paragraph), pill click triggers DeepenCallout's prompting phase which
  // exposes the 5-key cognitive dial (疑/扩/抵/转/凝) + freeform direction.
  const [recallQuote, setRecallQuote] = React.useState(null);  // { text, x, y }
  React.useEffect(() => {
    let pendingTimer = null;
    const commit = () => {
      try {
        const sel = window.getSelection && window.getSelection();
        if (!sel || sel.isCollapsed) return;
        const text = (sel.toString() || '').trim();
        if (text.length < 2) return;
        let node = sel.anchorNode;
        if (node && node.nodeType === 3) node = node.parentElement;
        let inScope = false;
        while (node && node !== document.body) {
          if (node.classList && node.classList.contains('note-rendered')) {
            inScope = true; break;
          }
          node = node.parentElement;
        }
        if (!inScope) return;
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        setRecallQuote({
          text,
          x: rect.right,
          y: rect.bottom,
        });
      } catch (_) {}
    };
    const onMouseUp = () => {
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(commit, 30);
    };
    const onKeyUp = (e) => {
      if (e.key === 'Shift') {
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = setTimeout(commit, 30);
      }
    };
    // Selection-collapse → dismiss pill (user clicked elsewhere). 200ms
    // debounce so cleared-then-reselected doesn't flicker.
    let collapseTimer = null;
    const onSelChange = () => {
      if (collapseTimer) clearTimeout(collapseTimer);
      collapseTimer = setTimeout(() => {
        try {
          const sel = window.getSelection && window.getSelection();
          if (!sel || sel.isCollapsed) setRecallQuote(null);
        } catch (_) {}
      }, 200);
    };
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('selectionchange', onSelChange);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('selectionchange', onSelChange);
      if (pendingTimer) clearTimeout(pendingTimer);
      if (collapseTimer) clearTimeout(collapseTimer);
    };
  }, []);

  // Esc dismisses the pill without affecting selection.
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && recallQuote) setRecallQuote(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [recallQuote]);

  // Clear pill on rel change (different note, stale pill).
  React.useEffect(() => { setRecallQuote(null); }, [rel]);

  // 2026-05-03 v0148 — Mount DeepenCallout INLINE below the source paragraph.
  // User pivot: stay on Recall, generated content lands directly below the
  // selected paragraph. Mechanism mirrors the original Cmd+K handler that was
  // retired in v0145: walk selection → find block-level ancestor in
  // .note-rendered → insertAdjacentElement('afterend') a deepen-host →
  // setDeepenSessions adds an entry → portal at line 1707 renders
  // DeepenCallout into that host. DeepenCallout's prompting phase exposes
  // the 5-key cognitive dial (疑/扩/抵/转/凝) for direction selection.
  const onDeepenInline = React.useCallback(() => {
    if (!recallQuote || !recallQuote.text) return;
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    // Find source block: walk from selection's end node up to .note-rendered.
    const BLOCK_TAGS = new Set(['P', 'LI', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'TABLE']);
    const range = sel.getRangeAt(0);
    let endNode = range.endContainer;
    if (endNode && endNode.nodeType === 3) endNode = endNode.parentElement;

    let container = null;
    let walk = endNode;
    while (walk && walk !== document.body) {
      if (walk.classList && walk.classList.contains('note-rendered')) {
        container = walk; break;
      }
      walk = walk.parentElement;
    }
    if (!container) return;

    let anchorBlock = endNode;
    while (anchorBlock && anchorBlock !== container && !BLOCK_TAGS.has(anchorBlock.tagName)) {
      anchorBlock = anchorBlock.parentElement;
    }
    if (!anchorBlock || anchorBlock === container || !container.contains(anchorBlock)) {
      anchorBlock = container.lastElementChild || container;
    }

    // Lang detection: ≥20% CJK chars → zh, else en.
    const cjkCount = (recallQuote.text.match(/[一-龥぀-ゟ゠-ヿ]/g) || []).length;
    const lang = (cjkCount / recallQuote.text.length >= 0.2) ? 'zh' : 'en';

    const id = 'dpn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const host = document.createElement('div');
    host.className = 'deepen-host';
    host.setAttribute('data-session-id', id);
    anchorBlock.insertAdjacentElement('afterend', host);

    setDeepenSessions(prev => [...prev, {
      id,
      mode: 'deepen',
      selection: recallQuote.text,
      noteRel: rel,
      style: 'denser',
      lang,
      direction: '',
      host,
    }]);
    setRecallQuote(null);
    // Clear browser selection so the pill doesn't immediately re-fire on
    // the same selection state.
    try { sel.removeAllRanges(); } catch (_) {}
  }, [recallQuote, rel]);

  // v0155 — lifted verbatim from ptor-design/app/ui_kits/ptor-app/NoteView.jsx
  // per user "完全照搬过来 不要自己改动". Same Ctrl+D / Ctrl+Q / Ctrl+Shift+D
  // pattern as NoteView; both surfaces get the keyboard trigger for parity.
  React.useEffect(() => {
    const BLOCK_TAGS = new Set(['P', 'LI', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'TABLE']);
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      let mode;
      if (k === 'd') mode = 'deepen';
      else if (k === 'q') mode = 'quick';
      else return;

      const sel = window.getSelection && window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const txt = (sel.toString() || '').trim();
      if (txt.length < 2) return;
      const noteRendered = document.querySelector('.note-rendered');
      if (!noteRendered || !noteRendered.contains(sel.anchorNode)) return;
      e.preventDefault();

      const range = sel.getRangeAt(0);
      let anchorNode = range.endContainer;
      if (anchorNode.nodeType === 3) anchorNode = anchorNode.parentElement;
      let anchorBlock = anchorNode;
      while (anchorBlock && anchorBlock !== noteRendered && !BLOCK_TAGS.has(anchorBlock.tagName)) {
        anchorBlock = anchorBlock.parentElement;
      }
      if (!anchorBlock || anchorBlock === noteRendered || !noteRendered.contains(anchorBlock)) {
        anchorBlock = noteRendered.lastElementChild || noteRendered;
      }

      const style = (mode === 'deepen' && e.shiftKey) ? 'plainer' : 'denser';
      const cjkCount = (txt.match(/[一-龥぀-ゟ゠-ヿ]/g) || []).length;
      const lang = (cjkCount / txt.length >= 0.2) ? 'zh' : 'en';

      const idPrefix = mode === 'quick' ? 'qck_' : 'dpn_';
      const id = idPrefix + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      const host = document.createElement('div');
      host.className = 'deepen-host';
      host.setAttribute('data-session-id', id);
      anchorBlock.insertAdjacentElement('afterend', host);

      setDeepenSessions(prev => [...prev, { id, mode, selection: txt, noteRel: rel, style, lang, direction: '', host }]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rel]);

  // PROVENANCE-PALPATION (per /tr 2026-04-29 Victor synthesis): long-press 500ms+
  // on note body summons a strata-overlay revealing THANGKA-LEDGER atoms.
  // Hold-to-look gesture — release dismisses. Pointer movement >6px cancels
  // (so users can still drag-select text without triggering palpation).
  const [palpationOpen, setPalpationOpen] = React.useState(false);
  const palpationTimerRef = React.useRef(null);
  const palpationStartRef = React.useRef(null);
  // Close palpation on rel change (gesture is per-note)
  React.useEffect(() => { setPalpationOpen(false); }, [rel]);

  const handlePalpationDown = React.useCallback((e) => {
    if (mode !== 'render') return;        // edit mode owns clicks
    if (e.button !== 0) return;           // primary button only
    if (deepenSessions.length > 0) return; // don't compete with active deepen
    palpationStartRef.current = { x: e.clientX, y: e.clientY };
    clearTimeout(palpationTimerRef.current);
    palpationTimerRef.current = setTimeout(() => {
      setPalpationOpen(true);
    }, 500);
  }, [mode, deepenSessions.length]);

  const handlePalpationMove = React.useCallback((e) => {
    if (!palpationStartRef.current) return;
    const dx = e.clientX - palpationStartRef.current.x;
    const dy = e.clientY - palpationStartRef.current.y;
    if ((dx * dx + dy * dy) > 36) {       // 6px movement = cancel
      clearTimeout(palpationTimerRef.current);
      palpationStartRef.current = null;
    }
  }, []);

  const handlePalpationUp = React.useCallback(() => {
    clearTimeout(palpationTimerRef.current);
    palpationStartRef.current = null;
    setPalpationOpen(false);              // release dismisses
  }, []);

  React.useEffect(() => {
    if (!rel) return;
    setChevronVisible(true);
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setChevronVisible(false), 500);

    const onMove = (e) => {
      const inCorner = e.clientY < 80 && e.clientX < 240;
      if (inCorner) {
        setChevronVisible(true);
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = setTimeout(() => setChevronVisible(false), 500);
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      clearTimeout(idleTimerRef.current);
    };
  }, [rel]);

  React.useEffect(() => {
    if (!rel) { setBody(''); setMeta(null); setError(null); return; }
    if (!window.ptor || !window.ptor.vault) { setError('ptor bridge missing'); return; }
    let cancelled = false;
    setError(null);
    const relChanged = prevRelRef.current !== rel;
    prevRelRef.current = rel;
    const apply = (res) => {
      if (cancelled) return;
      setBody(res.body || '');
      setMeta({ rel: res.rel, mtime: res.mtime, size: res.size, frontmatter: res.frontmatter });
    };
    window.ptor.vault.read(rel).then(res => {
      if (cancelled) return;
      if (!res) { setError('note not found'); return; }
      // flushSync forces React to commit DOM before we read notePageRef.current
      // and start the WAAPI animation. Without it, ref may be stale on first mount
      // (NoteView body/meta state not yet committed).
      ReactDOM.flushSync(() => apply(res));
      if (relChanged) {
        if (stageRef.current) stageRef.current.scrollTop = 0;
        // Web Animations API replaces View Transitions API. Chromium silently
        // skipped startViewTransition() on every switch in this app:
        //   - First mount = only-new transition (no OLD .note-page snapshot) → skip
        //   - rel-prop change = .note-page wrapper box stable, content changes
        //     inside .note-rendered → Chromium decides "no diff" → skip
        // Result: vt.ready never fired, vt.finished in 6-19ms = instant-swap
        // flash. WAAPI runs deterministically — no Chromium heuristics involved.
        const np = notePageRef.current;
        if (np && typeof np.animate === 'function') {
          // Cancel any in-flight animation (rapid switching)
          np.getAnimations().forEach(a => a.cancel());
          // V3.7 (per user 2026-04-29: "失焦动画完全消失了") — 恢复 blur,
          // 但比原 360ms / blur(6px) 略 lighter: 280ms / blur(4px). 仍有
          // "焦点重新对焦"隐喻视觉, 不至 1981 Doherty "等待"区间.
          np.animate(
            [
              { opacity: 0, filter: 'blur(4px)' },
              { opacity: 1, filter: 'blur(0)' },
            ],
            { duration: 280, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
          );
        }
      }
    }).catch(err => {
      if (cancelled) return;
      console.error('[NoteView] read failed', err);
      setError(String(err.message || err));
    });
    return () => { cancelled = true; };
  }, [rel]);

  // Fetch corpus signals (strength / cite / recall) on rel change. Backend
  // returns null on failure, in which case footer just omits the chip.
  React.useEffect(() => {
    setCorpus(null);
    if (!rel || !window.ptor || !window.ptor.corpus || !window.ptor.corpus.meta) return;
    let cancelled = false;
    window.ptor.corpus.meta(rel).then(m => { if (!cancelled) setCorpus(m); }).catch(() => {});
    return () => { cancelled = true; };
  }, [rel]);

  // THANGKA-LEDGER provenance derivation (added 2026-04-29 per /tr council).
  // readCount → 5-tier brass progression; mtime → ink alpha decay over 30d.
  // tier=null → DORMANT (no data-tier attr → transparent rim → bold-as-refusal).
  const provenanceTier = React.useMemo(() => {
    const rc = corpus?.readCount || 0;
    if (rc >= 5) return 1;
    if (rc >= 3) return 2;
    if (rc >= 2) return 3;
    if (rc >= 1) return 4;
    return null;
  }, [corpus]);

  const proseOpacity = React.useMemo(() => {
    if (!corpus?.mtime) return 1;
    const days = (Date.now() - new Date(corpus.mtime).getTime()) / 86400000;
    if (days <= 0) return 1;
    if (days >= 30) return 0.72;
    return 1 - 0.28 * (days / 30);
  }, [corpus]);

  // Strength → editorial qualitative word. The numeric is implied by the word.
  // Buckets per reinforce.js half-life curve: ≥0.7 = recently touched +
  // multiple reinforcements; 0.4-0.7 = decaying; <0.4 = at-risk recall.
  const strengthLabel = React.useMemo(() => {
    if (!corpus || corpus.strength == null) return null;
    const s = corpus.strength;
    if (s >= 0.7) return { word: 'vivid',  pct: Math.round(s * 100) };
    if (s >= 0.4) return { word: 'fading', pct: Math.round(s * 100) };
    return                { word: 'asleep', pct: Math.round(s * 100) };
  }, [corpus]);

  // Strip YAML frontmatter — broadened to handle BOM / leading whitespace /
  // CRLF line endings (Leo flagged this as fallback-leak source 2026-04-27).
  const stripFrontmatter = React.useCallback((src) => {
    if (!src) return '';
    return src.replace(/^﻿?\s*---[\r\n]+[\s\S]*?[\r\n]+---[\r\n]*/, '');
  }, []);

  // Vault title index (basename → { rel, label }) for [[wikilink]] resolution.
  // Per user 2026-04-29 "Obsidian 灵魂": bidirectional links are the
  // compounding substrate, not auto-suggest sidebars.
  // Fix A 卡顿修复 2026-04-29: dep 改 [] (mount once, !每次 nav refetch).
  // 监听 ptor:vault-changed 自定义事件, 让新建 note 后能刷新 (v0.2 main
  // 进程在 vault.write/del/rename 后 broadcast).
  const [vaultTitleIndex, setVaultTitleIndex] = React.useState(null);
  React.useEffect(() => {
    if (!window.ptor || !window.ptor.vault || !window.ptor.vault.list) return;
    let cancelled = false;
    const refresh = () => {
      window.ptor.vault.list().then(r => {
        if (cancelled) return;
        const map = new Map();
        for (const f of r.folders || []) {
          for (const it of f.items || []) {
            const base = (it.label || '').replace(/\.md$/i, '');
            if (base) map.set(base.toLowerCase(), { rel: it.rel, label: base });
          }
        }
        setVaultTitleIndex(map);
      }).catch(() => {});
    };
    refresh();
    const onChange = () => refresh();
    window.addEventListener('ptor:vault-changed', onChange);
    return () => { cancelled = true; window.removeEventListener('ptor:vault-changed', onChange); };
  }, []);

  // Preprocess [[wikilink]] / [[target|alias]] → <a class="wikilink"> HTML.
  // Skips inside fenced code blocks + inline backticks. Resolves target via
  // vaultTitleIndex; broken links get .wikilink-broken styling.
  const preprocessWikilinks = React.useCallback((text, titleMap) => {
    if (!text || !text.includes('[[')) return text;
    // Split by triple-backtick fences. Even idx = prose, odd = code.
    const parts = text.split(/(```[\s\S]*?```)/g);
    return parts.map((p, i) => {
      if (i % 2 === 1) return p; // fenced code, skip
      // Within prose, also skip inline `code`
      return p.replace(/(`[^`\n]+`)|(\[\[([^\]|\n]+?)(?:\|([^\]\n]+?))?\]\])/g,
        (full, code, _link, target, alias) => {
          if (code) return code;
          const t = (target || '').trim();
          const display = (alias || t).trim();
          if (!t) return full;
          const safeDisplay = display.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const safeTarget = t.replace(/"/g, '&quot;').replace(/&/g, '&amp;');
          if (titleMap) {
            const found = titleMap.get(t.toLowerCase());
            if (found) {
              const safeRel = found.rel.replace(/"/g, '&quot;');
              return `<a class="wikilink" data-rel="${safeRel}">${safeDisplay}</a>`;
            }
          }
          return `<a class="wikilink wikilink-broken" data-target="${safeTarget}">${safeDisplay}</a>`;
        });
    }).join('');
  }, []);

  const html = React.useMemo(() => {
    if (mode !== 'render' || !body) return '';
    const stripped = stripFrontmatter(body);
    // Preprocess [[wikilinks]] before marked sees the text. The injected
    // <a> tags pass through marked + DOMPurify (with class/data-rel allowed).
    const withLinks = preprocessWikilinks(stripped, vaultTitleIndex);
    if (typeof window.marked === 'undefined' || typeof window.DOMPurify === 'undefined') {
      // Graceful fallback — escape AND give paragraph rhythm so a parser
      // outage never collapses to wall-of-text.
      const escaped = withLinks.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
      const paras = escaped.split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
      return paras;
    }
    const raw = window.marked.parse(withLinks, { gfm: true, breaks: false });
    return window.DOMPurify.sanitize(raw, {
      ADD_ATTR: ['target', 'class', 'data-rel', 'data-target'],
    });
  }, [body, mode, stripFrontmatter, preprocessWikilinks, vaultTitleIndex]);

  // Click delegation on .note-rendered: catch .wikilink clicks → dispatch
  // ptor:open-rel event (App.jsx listens, calls setActive(rel)).
  // Broken wikilinks (data-target instead of data-rel) flash + ignore for v0.1.
  const handleRenderedClick = React.useCallback((e) => {
    const a = e.target.closest && e.target.closest('a.wikilink');
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    const targetRel = a.getAttribute('data-rel');
    if (targetRel) {
      window.dispatchEvent(new CustomEvent('ptor:open-rel', { detail: targetRel }));
    } else {
      // broken link — gentle flash, no action (v0.2: prompt to create note)
      a.classList.add('wikilink-flash');
      setTimeout(() => a.classList.remove('wikilink-flash'), 600);
    }
  }, []);

  // Backlinks: notes citing this one via [[wikilink]]. Fetched once per rel.
  const [backlinks, setBacklinks] = React.useState([]);
  React.useEffect(() => {
    if (!rel || !window.ptor || !window.ptor.vault || !window.ptor.vault.backlinks) {
      setBacklinks([]); return;
    }
    let cancelled = false;
    window.ptor.vault.backlinks(rel).then(b => {
      if (!cancelled) setBacklinks(Array.isArray(b) ? b : []);
    }).catch(() => { if (!cancelled) setBacklinks([]); });
    return () => { cancelled = true; };
  }, [rel]);

  // Standfirst: first sentence (≤140 chars) extracted from body for the
  // editorial deck. Frontmatter precedence:
  //   1. fm.vision  — for project/blueprint notes (post-2026-04-28 atlas redirect)
  //   2. fm.summary — Leo SCHLEP_PREMIUM L11 hand-written deck
  //   3. first-sentence fallback from body
  const standfirst = React.useMemo(() => {
    const fm = meta && meta.frontmatter;
    if (fm) {
      if ((fm.kind === 'project' || fm.kind === 'blueprint') && fm.vision) return String(fm.vision).trim();
      if (fm.summary) return String(fm.summary).trim();
    }
    if (!body) return '';
    const stripped = stripFrontmatter(body)
      .replace(/^#{1,6}\s.*$/gm, '')   // drop heading lines
      .replace(/^>.*$/gm, '')          // drop quote lines
      .replace(/```[\s\S]*?```/g, '')  // drop fences
      .trim();
    const sentence = stripped.split(/(?<=[.!?。！？])\s+/)[0] || '';
    return sentence.length > 180 ? sentence.slice(0, 180).replace(/\s+\S*$/, '') + '…' : sentence;
  }, [body, meta, stripFrontmatter]);

  // Project apparatus — pillars + open_questions for blueprint-style notes.
  // Per 2026-04-28 redirect (atlas reverted from BlueprintLibrary to Theatrum
  // Stratigraphicum, blueprints absorbed into note): notes with frontmatter
  // `kind: project` or `kind: blueprint` render a diptych here between
  // standfirst and body. Diptych layout when both lists ≥3 (Muse PATH E gate),
  // else stacked. Vision goes into standfirst (handled in standfirst memo).
  const projectHeader = React.useMemo(() => {
    const fm = meta && meta.frontmatter;
    if (!fm) return null;
    if (fm.kind !== 'project' && fm.kind !== 'blueprint') return null;
    const pillars = Array.isArray(fm.pillars) ? fm.pillars : [];
    const open_questions = Array.isArray(fm.open_questions) ? fm.open_questions : [];
    if (pillars.length === 0 && open_questions.length === 0) return null;
    return {
      pillars,
      open_questions,
      useDiptych: pillars.length >= 3 && open_questions.length >= 3,
    };
  }, [meta]);

  // AGENT-TRACE RIBBON (per /tr 2026-04-29 全体议会 + Muse UNATTACKED gift):
  // col-3 显示 council 在该 note 上的历史脚印. PTOR USP — agent_id 字段.
  const [agentTrace, setAgentTrace] = React.useState([]);
  React.useEffect(() => {
    if (!rel || !window.ptor || !window.ptor.corpus || !window.ptor.corpus.agentTrace) {
      setAgentTrace([]); return;
    }
    let cancelled = false;
    window.ptor.corpus.agentTrace(rel, 10)
      .then(t => { if (!cancelled) setAgentTrace(Array.isArray(t) ? t : []); })
      .catch(() => { if (!cancelled) setAgentTrace([]); });
    return () => { cancelled = true; };
  }, [rel]);

  // Vault peers (same-folder neighbors) — render fallback when agentTrace=0.
  // Per user 2026-04-29 "等待council 有什么用" — 用 real peers 代替装饰话术.
  const [vaultPeers, setVaultPeers] = React.useState([]);
  React.useEffect(() => {
    if (!rel || !window.ptor || !window.ptor.vault || !window.ptor.vault.list) {
      setVaultPeers([]); return;
    }
    let cancelled = false;
    window.ptor.vault.list().then(r => {
      if (cancelled) return;
      const folder = rel.split('/').slice(0, -1).join('/') || '';
      const fold = (r.folders || []).find(f => f.folder === folder);
      if (!fold) { setVaultPeers([]); return; }
      const peers = (fold.items || [])
        .filter(it => it.rel !== rel)
        .slice(0, 6);
      setVaultPeers(peers);
    }).catch(() => { if (!cancelled) setVaultPeers([]); });
    return () => { cancelled = true; };
  }, [rel]);

  // COUNCIL_PROVOCATION REVERTED 2026-04-29 per user feedback:
  // "和 WPS 一样输出质量低的时候只会引起反感". Gemini Flash 输出质量
  // 门槛达不到 PTOR 千金 register, 自动 fire 等于硬塞 AI续写, 反感 >
  // 灵感. 留 slot for Claude API 集成日 (用 claude-haiku-4-5 + 严格
  // prompt + manual trigger 模式) — 那时再恢复.
  // 同时撤销 editParagraph + handleEditSelect 追踪 (无 wikilink 也无
  // provocation 后, edit-mode col-3 就剩 deepen breadcrumb + agent-trace
  // + vault-peers fallback, 不需要段位置 state).

  // Format ISO timestamp → "M-D" (no year for current year, "YYYY M-D" else)
  const formatTraceTs = React.useCallback((iso) => {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      const now = new Date();
      const m = d.getMonth() + 1;
      const day = d.getDate();
      if (d.getFullYear() === now.getFullYear()) return `${m}-${day}`;
      return `${String(d.getFullYear()).slice(2)} ${m}-${day}`;
    } catch (_) { return ''; }
  }, []);

  // Format event → human readable op label. Keeps it short for the col-3 strip.
  const formatTraceOp = React.useCallback((ev) => {
    if (!ev) return '';
    const op = ev.op;
    if (op === 'verdict') {
      const klass = { 3: 'held', 2: 'shaky', 1: 'smooth' }[ev.weight] || '';
      return klass ? `verdict ${klass}` : 'verdict';
    }
    if (op === 'cite') {
      const slug = ev.meta && (ev.meta.slug || ev.meta.target);
      return slug ? `cited → ${slug}` : 'cited';
    }
    if (op === 'recall') return 'recalled';
    if (op === 'deepen') return 'deepened';
    if (op === 'read') return 'read';
    if (op === 'write') return 'wrote';
    if (op === 'article_updated') {
      const ct = ev.meta && ev.meta.change_type;
      return ct ? `wiki ${ct}` : 'wiki updated';
    }
    if (op === 'graph_edge_added') return 'linked';
    return op;
  }, []);

  const readingMinutes = React.useMemo(() => {
    if (!body) return 0;
    const words = body.replace(/\s+/g, ' ').trim().split(' ').length;
    const cjkChars = (body.match(/[一-龥]/g) || []).length;
    return Math.max(1, Math.round((words + cjkChars / 1.6) / 220));
  }, [body]);

  const folioDate = React.useMemo(() => {
    if (!meta || !meta.mtime) return '';
    try {
      const d = new Date(meta.mtime);
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${months[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
    } catch (_) { return ''; }
  }, [meta]);

  // V3.5 (per user 2026-04-29): if a deepen session is alive, dblclick
  // would re-render .note-rendered into <textarea>, which destroys the
  // .deepen-host DOM node we DOM-manipulated in earlier — the portal target
  // disappears and the in-flight (or just-landed) deepen synth is wiped
  // before user has decided to keep / let-go. Short-circuit dblclick when
  // any deepen session exists. User must finish (keep/let-go) to re-enable.
  //
  // V3.6 (per user 2026-04-29): on render → edit toggle, find the DOM text
  // node closest to viewport center, locate its substring in the markdown
  // source body, and store as `editCursorOffset` so the textarea-mount
  // effect can place caret + scroll to that position. Without this,
  // dblclick yanks user back to top-of-doc — the original complaint.
  const textareaRef = React.useRef(null);
  const [editCursorOffset, setEditCursorOffset] = React.useState(null);

  const onDoubleClick = React.useCallback(() => {
    if (deepenSessions.length > 0) return;
    if (mode === 'render' && stageRef.current) {
      // Walk rendered DOM, find the BLOCK element (P, H1-6, LI, BLOCKQUOTE, PRE)
      // that contains viewport center. Map back to markdown source by trying
      // multiple anchor lengths — robust to minor formatting diffs (** ** /
      // [link](url) / etc.) between rendered textContent and raw markdown.
      try {
        const stage = stageRef.current;
        const rect = stage.getBoundingClientRect();
        const centerY = rect.top + rect.height / 2;
        const renderedRoot = stage.querySelector('.note-rendered');
        const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE']);
        let bestBlock = null;
        let bestDist = Infinity;
        if (renderedRoot) {
          const blocks = renderedRoot.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre');
          for (const blk of blocks) {
            const r = blk.getBoundingClientRect();
            if (!r.height) continue;
            // Use vertical-center distance; if center is INSIDE the block, dist=0
            let d;
            if (centerY >= r.top && centerY <= r.bottom) d = 0;
            else d = Math.min(Math.abs(centerY - r.top), Math.abs(centerY - r.bottom));
            if (d < bestDist) { bestDist = d; bestBlock = blk; }
          }
        }
        let foundOffset = -1;
        if (bestBlock && body) {
          const text = (bestBlock.textContent || '').trim();
          // Try multiple search anchors — skip leading/trailing chars
          // (markdown formatting like *, _, # may not match rendered text exactly).
          const candidates = [
            text.slice(0, 50),
            text.slice(0, 30),
            text.slice(0, 20),
            text.slice(text.length > 10 ? 5 : 0, 35),
          ].filter(s => s.length >= 8);
          for (const anchor of candidates) {
            const idx = body.indexOf(anchor);
            if (idx >= 0) { foundOffset = idx; break; }
          }
        }
        setEditCursorOffset(foundOffset >= 0 ? foundOffset : 0);
      } catch (_) { setEditCursorOffset(0); }
    }
    setMode(m => m === 'render' ? 'edit' : 'render');
  }, [deepenSessions.length, mode, body]);

  // On entering edit mode: focus textarea, place caret at the saved offset,
  // scroll the stage so the caret line is centered. Auto-grow textarea height
  // to match content (no inner scrollbar — user scrolls the .note-stage
  // container instead, same UX as render mode).
  React.useLayoutEffect(() => {
    if (mode !== 'edit') return;
    const ta = textareaRef.current;
    if (!ta) return;
    // Auto-grow: shrink to measure scrollHeight, then expand
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
    if (editCursorOffset != null) {
      ta.focus();
      ta.setSelectionRange(editCursorOffset, editCursorOffset);
      // Mirror trick — measure exact pixel y of caret by rendering
      // text-up-to-offset in a hidden div with same wrapping rules.
      // More accurate than line-counting (which fails on soft-wrap).
      const stage = stageRef.current;
      if (stage) {
        try {
          const cs = getComputedStyle(ta);
          const mirror = document.createElement('div');
          mirror.style.cssText = [
            'position:absolute', 'left:-99999px', 'top:0',
            'visibility:hidden', 'white-space:pre-wrap', 'word-wrap:break-word',
            'box-sizing:' + cs.boxSizing,
            'width:' + ta.clientWidth + 'px',
            'padding:' + cs.padding,
            'font:' + cs.font,
            'line-height:' + cs.lineHeight,
            'letter-spacing:' + cs.letterSpacing,
            'tab-size:' + cs.tabSize,
          ].join(';');
          mirror.textContent = ta.value.slice(0, editCursorOffset);
          const span = document.createElement('span');
          span.textContent = ta.value.slice(editCursorOffset, editCursorOffset + 1) || '​';
          mirror.appendChild(span);
          document.body.appendChild(mirror);
          const sp = span.getBoundingClientRect();
          const mr = mirror.getBoundingClientRect();
          const caretYInTextarea = sp.top - mr.top;
          document.body.removeChild(mirror);
          // textarea offsetTop relative to stage scroll container
          const taRect = ta.getBoundingClientRect();
          const stageRect = stage.getBoundingClientRect();
          const taTopInStage = (taRect.top - stageRect.top) + stage.scrollTop;
          const targetY = taTopInStage + caretYInTextarea;
          stage.scrollTop = Math.max(0, targetY - stage.clientHeight / 2);
        } catch (_) {
          // Fallback to old line-counting heuristic
          const beforeCursor = (ta.value || '').slice(0, editCursorOffset);
          const lineCount = (beforeCursor.match(/\n/g) || []).length;
          const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 24;
          stage.scrollTop = Math.max(0, ta.offsetTop + lineCount * lineHeight - stage.clientHeight / 2);
        }
      }
    }
  }, [mode, editCursorOffset]);

  // While typing, keep textarea height matched to content (no inner scroll).
  React.useEffect(() => {
    if (mode !== 'edit') return;
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }, [body, mode]);

  // 2026-05-03 v0145 — RecallNoteView no longer has a deepen affordance.
  // Per /tr council 2026-05-03: the deepen verb is retired entirely; the
  // active surface is the LessonChat selection-anchored composer
  // (NoteView.jsx LessonChat). RecallNoteView shows ratified notes
  // (read-only); deepen there can be added in a follow-up iteration if
  // user need is real — currently deferred per Occam.

  // Clean up host divs when rel changes (effect ordering: this runs BEFORE
  // setDeepenSessions([]) clears state on rel change).
  React.useEffect(() => {
    return () => {
      // On unmount or rel change, remove all hosts
      document.querySelectorAll('.deepen-host').forEach(h => h.remove());
    };
  }, [rel]);

  // Persist a finished deepen callout into the current note as markdown callout block.
  // Uses HTML comment markers so reinforce.js / corpus event-log can recognize AI
  // origin and weigh it (v0.2). For v0.1 just appends as ▸ blockquote.
  const onPersistDeepen = React.useCallback(async (sessionId, text, style) => {
    if (!rel || !window.ptor || !window.ptor.vault) return;
    try {
      const cur = await window.ptor.vault.read(rel);
      if (!cur) return;
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const wrap =
        `\n\n<!-- ptor-ai: deepen style=${style} ts=${stamp} -->\n` +
        `> [!deepen]\n` +
        text.split('\n').map(l => '> ' + l).join('\n') +
        `\n<!-- /ptor-ai -->\n`;
      const newBody = (cur.body || '') + wrap;
      await window.ptor.vault.write(rel, newBody);
      setBody(newBody);
    } catch (e) { console.error('[deepen persist] failed', e); }
    // Remove host DOM node + state
    setDeepenSessions(prev => {
      const sess = prev.find(s => s.id === sessionId);
      if (sess && sess.host && sess.host.parentNode) sess.host.parentNode.removeChild(sess.host);
      return prev.filter(s => s.id !== sessionId);
    });
  }, [rel]);

  const onDiscardDeepen = React.useCallback((sessionId) => {
    // S15 interrupt channel (per Scout 2026-04-29 frontier harvest:
    // Leverage Laws 3-channel cost framework). Dismiss MUST also kill the
    // underlying gemini child process, !just remove the UI. Without abort,
    // ✕ leaves the LLM burning tokens to completion. Interrupt is a
    // distinct UX channel from review-after-fact.
    try {
      if (window.ptor && window.ptor.llm && window.ptor.llm.deepenAbort) {
        window.ptor.llm.deepenAbort(sessionId).catch(() => {});
      }
    } catch (_) {}
    setDeepenSessions(prev => {
      const sess = prev.find(s => s.id === sessionId);
      if (sess && sess.host && sess.host.parentNode) sess.host.parentNode.removeChild(sess.host);
      return prev.filter(s => s.id !== sessionId);
    });
  }, []);

  // Continue dialogue: spawn a new deepen/quick session right after the current
  // one's host, with the prior synth augmenting the selection. The follow-up
  // sees: original selection + your last answer + new question/direction —
  // letting it answer "more on X" or "different angle" coherently without
  // re-deriving from scratch.
  const onContinueDeepen = React.useCallback((parentSess, nextMode, direction, priorSynth) => {
    const augmentedSelection =
      `[原选段]\n${parentSess.selection}\n\n` +
      `[上一轮${parentSess.mode === 'quick' ? 'quick' : 'deepen'}的结论]\n${priorSynth || ''}` +
      (direction ? `\n\n[用户继续问 / 方向]\n${direction}` : '');
    const idPrefix = nextMode === 'quick' ? 'qck_' : 'dpn_';
    const id = idPrefix + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const host = document.createElement('div');
    host.className = 'deepen-host';
    host.setAttribute('data-session-id', id);
    // Insert right after the parent's host so it visually nests below
    if (parentSess.host && parentSess.host.parentNode) {
      parentSess.host.parentNode.insertBefore(host, parentSess.host.nextSibling);
    }
    setDeepenSessions(prev => [...prev, {
      id,
      mode: nextMode,
      selection: augmentedSelection,
      noteRel: parentSess.noteRel,
      style: parentSess.style,
      lang: parentSess.lang,
      // direction: empty so DeepenCallout shows the prompt input phase only if
      // user invoked via chip (preset direction); via reply input we already
      // baked it into selection augmentation, so go straight to running.
      direction: '',
      // Skip the prompting phase — augmentation already encodes intent
      autorun: true,
      host,
    }]);
  }, []);

  // 钉为新笔记 — write to inbox/<template>-<originaltitle>-<date>.md.
  const onPinResult = React.useCallback(async (text, template) => {
    if (!window.ptor || !window.ptor.vault) { setAskCard(null); return; }
    const baseTitle = ((rel || 'note').split('/').pop() || 'note').replace(/\.md$/i, '');
    const date = new Date().toISOString().slice(0, 10);
    const slug = `${template}-${baseTitle}-${date}`.replace(/[^\w一-龥\-]+/g, '-').slice(0, 80);
    const newRel = `inbox/${slug}.md`;
    const sel = (askCard && askCard.selection) || '';
    const body =
      `---\nfrom: ${rel}\ntemplate: ${template}\nts: ${new Date().toISOString()}\n---\n\n` +
      `> ${sel.split('\n').join('\n> ')}\n\n${text}\n`;
    try { await window.ptor.vault.write(newRel, body); }
    catch (e) { console.error('[pin] write failed', e); }
    setAskCard(null);
  }, [rel, askCard]);

  // 追加 — append a callout block to current note body, persist + refresh local body.
  const onAppendResult = React.useCallback(async (text, template) => {
    if (!rel || !window.ptor || !window.ptor.vault) { setAskCard(null); return; }
    try {
      const cur = await window.ptor.vault.read(rel);
      if (!cur) { setAskCard(null); return; }
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const callout =
        `\n\n> [!${template}] ${stamp}\n` +
        text.split('\n').map(l => '> ' + l).join('\n') + '\n';
      const newBody = (cur.body || '') + callout;
      await window.ptor.vault.write(rel, newBody);
      setBody(newBody);
    } catch (e) { console.error('[append] write failed', e); }
    setAskCard(null);
  }, [rel]);

  if (!rel) return null;

  if (error) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 36, textAlign: 'center' }}>
        <div style={{
          fontFamily: '"EB Garamond", "Cormorant Garamond", Georgia, serif', fontStyle: 'italic',
          fontSize: 22, color: 'var(--verdict-flag, #c46a5d)', lineHeight: 1.4,
        }}>{error}</div>
      </div>
    );
  }

  // Stale-frame guard: during the async window between rel-change and
  // vault.read resolve, meta/body still reference the PREVIOUS note. Gate
  // every body/meta-derived render on bodyReady so we never paint other
  // notes' content under the new rel for 1-3 frames.
  const bodyReady = meta && meta.rel === rel;
  const fileName = bodyReady ? meta.rel : rel;
  const lastBit = fileName.split('/').pop() || fileName;
  const titleFromFm = bodyReady && meta.frontmatter && (meta.frontmatter.title || meta.frontmatter.id);
  const displayTitle = titleFromFm || lastBit.replace(/\.md$/i, '').replace(/[_-]+/g, ' ');

  // Section-from-rel-path: "AI learn/SAGE_Notes_Day01.md" → "AI learn"
  const folioSection = (rel || '').split('/').slice(0, -1).join(' · ') || 'vault';

  return (
    <div
      ref={stageRef}
      onDoubleClick={onDoubleClick}
      onPointerDown={handlePalpationDown}
      onPointerMove={handlePalpationMove}
      onPointerUp={handlePalpationUp}
      onPointerCancel={handlePalpationUp}
      className="note-stage"
      style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        overflow: 'auto', minHeight: 0,
        position: 'relative',
        scrollbarGutter: 'stable',  /* 预留滚轴空间，content 加载时布局不抖 */
      }}
    >
      <style>{`
        /* ─── 3-col page architecture (Leo's BET, 2026-04-27 council) ───────
           col-1: load-bearing left margin (h2 roman numerals live here)
           col-2: body column, max 62ch (Bringhurst measure floor)
           col-3: right gutter (empty for v1; future home for footnotes / TOC)
        */
        .note-page {
          display: grid;
          /* col-2 = 73ch (黄金分割: 1200 × 0.618 = 742, 减 col-1 80 + gap 28
             ≈ 634px ≈ 73ch). 也在 Bringhurst 50-75ch 阅读测度上限.
             换算: 之前 62ch → 73ch (+18%), 既给写作更多展开空间, 又让
             col-2 / col-3 边界落在黄金分割位置. */
          grid-template-columns:
            clamp(56px, 6vw, 96px)
            min(73ch, calc(100% - 96px))
            1fr;
          column-gap: clamp(20px, 2vw, 36px);
          padding: clamp(40px, 6vh, 72px) clamp(28px, 3vw, 56px) clamp(56px, 8vh, 96px);
          align-content: start;
          max-width: 1200px;
          margin: 0 auto 0 0;  /* anchored LEFT — right cream is intentional MA */
        }
        /* SCOPED VT — opt-in only '.note-page', root explicitly silenced.
           Per Muse + Leo /tr 2026-04-28 P2 emergency:
           - (root) 把整个 <html> 都 transform → sidebar/右 panel 跟着震动 (CDP verified)
           - 修法 (MDN default scoping pattern + Astro 4.5+ production):
             1. :root { view-transition-name: none } → 关掉 default root snapshot
             2. .note-page { view-transition-name: ptor-note } → 仅这棵子树过渡
             3. ::view-transition-group(ptor-note) { animation: none } → 关 size FLIP，note-page 大小本来就一样，size anim 是空 GPU 工作 + 亚像素抖动风险
             4. 残影感保留：不对称 timing (出 320 / 入 280 + 30ms delay)
             5. 移除 scale/translateY — Leo: 那是 root-bug 时代的误诊；scoped 子树内做 transform 会让 title/footer 互相滑动
                = sub-tree shake；Apple Pages 真正机制是 fixed-bounds opacity 残影，不是 transform
           */
        :root { view-transition-name: none; }
        .note-page { contain: layout; position: relative; }

        /* PHASE 4 axis-drift DISABLED 2026-04-29 — possible GPU-pressure source
           causing white-screen on reload. Keep stanza-cut + font (Phase 1+2)
           which are the primary structural changes. Re-enable conservatively
           after diagnosing actual cause from DevTools. */

        /* THANGKA-LEDGER rim — outer ornament driven by per-note provenance.
           data-tier=1..4 from readCount (5+/3-4/2/1); absent = DORMANT (transparent).
           Bold-as-refusal: empty notes look chrome-less; rim accrues only as
           the user re-reads. Pseudo-element so no extra DOM, follows .note-page
           bounding box (= note's actual visual mass, not whole stage). */
        .note-page::before {
          content: '';
          position: absolute;
          inset: clamp(8px, 1.2vh, 18px);
          pointer-events: none;
          border: 1px solid transparent;
          transition: border-color 1200ms cubic-bezier(0.22, 1, 0.36, 1);
          z-index: 0;
        }
        .note-page[data-tier="1"]::before { border-color: var(--rim-brass-tier-1); }
        .note-page[data-tier="2"]::before { border-color: var(--rim-brass-tier-2); }
        .note-page[data-tier="3"]::before { border-color: var(--rim-brass-tier-3); }
        .note-page[data-tier="4"]::before { border-color: var(--rim-brass-tier-4); }
        /* tier-5 / no attribute = transparent (DORMANT default — bold-as-refusal) */

        /* Prose ink fade — mtime > 30d → opacity 0.72.
           Per Leo R1 ΔE math: 1.83σ on first transition, suprathreshold but
           not loud. Title/folio/standfirst stay hard-edged; only body breathes. */
        .note-rendered {
          opacity: var(--note-prose-opacity, 1);
          transition: opacity 1500ms ease-out;
        }
        /* Note: View Transitions API + CSS mount animation both removed.
           Chromium kept silently skipping startViewTransition (vt.ready never
           fired, vt.finished in 6-19ms = no animation). Replaced with Web
           Animations API run from JS in NoteView useEffect — deterministic,
           runs on every rel change including first mount. See WAAPI block in
           NoteView.jsx for the keyframes (kept in JS so we can cancel rapid
           in-flight animations on quick consecutive note clicks). */
        ::view-transition-group(ptor-note) { animation: none; }
        /* Blur defocus — 旧内容 = "视线失焦"，新内容 = "焦点回收".
           emphatic ease-out (Apple-grade) 慢收尾，眼睛把 blur 解读为
           注意力转移而非内容被擦掉。出 280ms / 入 360ms + 60ms delay —
           入场略长 + 略迟，让"焦点回收"有可被感知的稳定感。 */
        ::view-transition-old(ptor-note) {
          animation: 280ms cubic-bezier(0.16, 1, 0.3, 1) both ptor-vt-out;
        }
        ::view-transition-new(ptor-note) {
          animation: 360ms cubic-bezier(0.16, 1, 0.3, 1) 60ms both ptor-vt-in;
        }
        @keyframes ptor-vt-out {
          from { opacity: 1; filter: blur(0); }
          to   { opacity: 0; filter: blur(6px); }
        }
        @keyframes ptor-vt-in {
          from { opacity: 0; filter: blur(6px); }
          to   { opacity: 1; filter: blur(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          ::view-transition-old(ptor-note),
          ::view-transition-new(ptor-note) {
            animation-duration: 1ms;
            animation-delay: 0;
          }
        }
        @media (max-width: 900px) {
          .note-page {
            grid-template-columns: 24px 1fr;
            column-gap: 12px;
            padding: 32px 20px 56px;
          }
        }

        /* 2026-05-03 v0147 — Recall deepen pill fade-in. Matches the
           Lesson-side composer transition register (220ms ease-out 80ms). */
        @keyframes recall-ask-fade-in {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }

        /* ─── Folio (running header — Lung's alcove discipline) ──────────── */
        .note-folio {
          grid-column: 2;
          font-family: "JetBrains Mono", monospace;
          font-size: 10.5px; letter-spacing: 0.06em;
          color: var(--ink-faint);
          padding-bottom: 14px;
          border-bottom: 0.5px solid var(--border-hairline);
          margin-bottom: 32px;
          display: flex; align-items: baseline; gap: 12px;
        }
        .note-folio-section { color: var(--ink-muted); }
        .note-folio-bullet { opacity: 0.5; }

        /* ─── Title + standfirst ─────────────────────────────────────────── */
        .note-title {
          grid-column: 2;
          font-family: "EB Garamond", "Noto Serif SC", "Cormorant Garamond", Georgia, serif;
          font-size: 36px; font-weight: 500;
          line-height: 1.2; letter-spacing: -0.005em;
          color: var(--ink-title);
          margin: 0 0 14px;
        }
        .note-standfirst {
          grid-column: 2;
          font-family: "EB Garamond", "Noto Serif SC", "Cormorant Garamond", Georgia, serif;
          font-style: italic; font-size: 19px; font-weight: 400;
          line-height: 1.55;
          color: var(--ink-muted);
          max-width: 46ch;
          margin: 0 0 28px;
        }
        .note-meta-rule {
          grid-column: 2;
          border: 0; height: 1px;
          background: var(--brass-leaf);
          margin: 0 0 36px;
        }

        /* ─── Body column (62ch measure, ragged-right) ──────────────────── */
        .note-rendered {
          grid-column: 2;
          /* Primary: Source Serif 4 Variable (wght 200-900 + opsz 8-60).
             Phase 3 will drive --stanza-opsz / --stanza-slant from scroll
             intersection. Phase 1 default = static opsz 18 = identical-looking
             to EB Garamond at body size. */
          font-family: var(--font-serif);
          font-feature-settings: "kern" 1, "onum" 1;
          font-optical-sizing: auto;
          /* Removed font-variation-settings 2026-04-29 — Source Serif 4 doesn't
             ship slnt axis (italic is a separate cut, not slnt-axis variant).
             font-optical-sizing: auto handles opsz automatically. Phase 3
             breathing will re-introduce explicit axes via JS-driven approach. */
          font-size: 18px; line-height: 1.62;
          text-align: left;
          color: var(--ink-primary);
          counter-reset: h2counter;
          position: relative;
        }

        /* ─── col-3 MARGINALIA (Aldine 1501 register, 2026-04-29) ─────────
           TOC + signature live in the right gutter. italic Garamond 11pt
           brass faint, sticky as user scrolls col-2. 千金前沿 = 把 col-3
           做成活动 marginalia layer, 不让它当空白 cream right edge. */
        .note-marginalia {
          grid-column: 3;
          grid-row: 1 / span 999;  /* row-1 start, span all 让 sticky 有充足 cell 高度 */
          align-self: start;
          position: sticky;
          top: clamp(40px, 5vh, 60px);
          /* min-height fallback: edit mode 下 textarea 是 1 个 row, grid cell
             高度有限, sticky 没 stick 余地. min-height 强制让 marginalia
             cell 至少够一屏 — sticky 才能在 textarea 滚动时跟手. */
          min-height: calc(100vh - 200px);
          max-height: calc(100vh - 120px);
          overflow-y: auto;
          padding: 4px 0 4px 16px;
          margin-top: clamp(40px, 6vh, 72px);  /* align below folio + title */
          border-left: 1px solid color-mix(in srgb, var(--brass-mid) 16%, transparent);
          font-family: "EB Garamond", "Source Serif 4 Variable", "Noto Serif SC", serif;
          font-style: italic;
          font-size: 12px;
          letter-spacing: 0.04em;
          line-height: 1.7;
          color: var(--ink-faint);
        }

        /* Deepen breadcrumb (edit-mode only, composition-focused).
           列出 active deepen sessions, ● = full deepen, ◌ = quick.
           Click jumps to inline session, ✕ dismisses (calls onDiscardDeepen). */
        .deepen-breadcrumb {
          display: flex; flex-direction: column;
          gap: 3px;
          margin: 4px 0 24px;
          padding: 14px 0;
          border-top: 1px solid color-mix(in srgb, var(--brass-mid) 12%, transparent);
          border-bottom: 1px solid color-mix(in srgb, var(--brass-mid) 12%, transparent);
        }
        .deepen-label {
          font-size: 10px;
          letter-spacing: 0.10em;
          font-style: normal;
          font-weight: 500;
          color: var(--brass-bright);
          margin-bottom: 6px;
          font-feature-settings: "smcp" 1;
          text-transform: lowercase;
        }
        .deepen-item {
          display: flex; align-items: flex-start; gap: 2px;
        }
        .deepen-item > button:first-child {
          flex: 1; min-width: 0;
          text-align: left;
          background: transparent;
          border: 0;
          font: inherit;
          color: var(--ink-faint);
          cursor: pointer;
          padding: 2px 0;
          font-size: 11px;
          line-height: 1.5;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          transition: color 220ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        .deepen-item > button:first-child:hover {
          color: var(--brass-bright);
        }
        .deepen-dot {
          color: var(--brass-mid);
          font-style: normal;
          font-size: 10px;
        }
        .deepen-excerpt { font-style: italic; }
        .deepen-dismiss {
          background: transparent;
          border: 0;
          color: var(--ink-faint);
          cursor: pointer;
          font-size: 13px;
          line-height: 1;
          padding: 4px 4px 4px 4px;
          opacity: 0.32;
          transition: opacity 220ms, color 220ms;
        }
        .deepen-dismiss:hover {
          opacity: 1;
          color: var(--verdict-flag, #c46a5d);
        }
        .note-marginalia::-webkit-scrollbar { width: 4px; }

        /* .toc-marginalia REMOVED 2026-04-29 per user "去除啊, 不要啊"
           — TOC 在长 worldbuilding note 上膨胀到 30+ 条, 把 col-3 全占了.
           Signature + deepen breadcrumb 是更克制的 marginalia 内容. */

        /* AGENT-TRACE RIBBON — col-3 显示 council 历史 events (per /tr
           2026-04-29 议会). 倒序 last 10, agent name brass-bright + smcp,
           timestamp tnum 等宽数字, op 描述 italic faint. */
        .agent-trace-ribbon {
          list-style: none;
          padding: 0;
          margin: 0 0 12px;
          display: flex;
          flex-direction: column;
          gap: 7px;
        }
        .agent-trace-ribbon li {
          display: grid;
          grid-template-columns: minmax(0, auto) auto 1fr;
          column-gap: 8px;
          align-items: baseline;
          font-size: 11px;
          line-height: 1.55;
        }
        .trace-agent {
          font-weight: 500;
          font-style: normal;
          color: var(--brass-bright);
          font-feature-settings: "smcp" 1;
          letter-spacing: 0.05em;
          text-transform: lowercase;
          white-space: nowrap;
        }
        .trace-ts {
          font-feature-settings: "tnum" 1;
          font-style: normal;
          font-size: 10px;
          color: var(--ink-faint);
          opacity: 0.75;
          white-space: nowrap;
        }
        .trace-op {
          color: var(--ink-faint);
          font-style: italic;
          letter-spacing: 0.02em;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        /* Obsidian-style [[wikilinks]] (per user 2026-04-29 "Obsidian 灵魂").
           Resolved via vaultTitleIndex (basename match). Click → dispatch
           ptor:open-rel CustomEvent → App.setActive. Broken links (target
           not in vault) get dotted faint variant + flash on click. */
        .note-rendered .wikilink {
          color: var(--brass-bright);
          text-decoration: none;
          border-bottom: 1px dotted color-mix(in srgb, var(--brass-bright) 50%, transparent);
          cursor: pointer;
          font-style: italic;
          letter-spacing: 0.01em;
          transition: color 200ms cubic-bezier(0.22, 1, 0.36, 1),
                      border-bottom-color 200ms cubic-bezier(0.22, 1, 0.36, 1),
                      background 200ms cubic-bezier(0.22, 1, 0.36, 1);
          padding: 0 1px;
          border-radius: 0;
        }
        .note-rendered .wikilink:hover {
          color: var(--ink-title);
          border-bottom-color: var(--brass-bright);
          background: color-mix(in srgb, var(--brass-bright) 8%, transparent);
        }
        .note-rendered .wikilink-broken {
          color: var(--ink-faint);
          border-bottom-style: dotted;
          border-bottom-color: color-mix(in srgb, var(--verdict-flag, #c46a5d) 32%, transparent);
          opacity: 0.72;
        }
        .note-rendered .wikilink-broken:hover {
          color: var(--verdict-flag, #c46a5d);
          background: transparent;
        }
        .note-rendered .wikilink-flash {
          animation: wikilink-flash 600ms ease-out;
        }
        @keyframes wikilink-flash {
          0%, 100% { background: transparent; }
          30% { background: color-mix(in srgb, var(--verdict-flag, #c46a5d) 18%, transparent); }
        }

        /* Backlinks panel — notes containing [[wikilink]] to THIS note.
           Below body, above footer. Per user 2026-04-29 Obsidian 灵魂. */
        .note-backlinks {
          grid-column: 2;
          margin: clamp(36px, 6vh, 56px) 0 0;
          padding-top: clamp(20px, 3vh, 32px);
          border-top: 1px solid color-mix(in srgb, var(--brass-mid) 22%, transparent);
        }
        .backlinks-label {
          font-family: "EB Garamond", "Source Serif 4 Variable", serif;
          font-style: italic;
          font-size: 12px;
          letter-spacing: 0.08em;
          color: var(--brass-bright);
          margin-bottom: 14px;
          font-feature-settings: "smcp" 1;
          text-transform: lowercase;
          opacity: 0.85;
        }
        .note-backlinks ul {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .note-backlinks button {
          width: 100%;
          text-align: left;
          background: transparent;
          border: 0;
          padding: 8px 0;
          cursor: pointer;
          font: inherit;
          color: inherit;
          display: grid;
          grid-template-columns: minmax(0, auto) 1fr;
          column-gap: 16px;
          align-items: baseline;
          border-bottom: 1px solid transparent;
          transition: border-bottom-color 200ms;
        }
        .note-backlinks button:hover {
          border-bottom-color: color-mix(in srgb, var(--brass-mid) 26%, transparent);
        }
        .backlink-label {
          font-family: "EB Garamond", "Source Serif 4 Variable", serif;
          color: var(--brass-bright);
          font-weight: 500;
          font-size: 14px;
          letter-spacing: 0.02em;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 220px;
        }
        .backlink-excerpt {
          font-family: "EB Garamond", "Source Serif 4 Variable", serif;
          font-style: italic;
          font-size: 12px;
          line-height: 1.55;
          color: var(--ink-faint);
          opacity: 0.78;
          letter-spacing: 0.01em;
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }

        /* Vault peers — same-folder neighbor list. */
        .vault-peers button {
          text-align: left;
          background: transparent;
          border: 0;
          font: inherit;
          color: var(--ink-faint);
          cursor: pointer;
          padding: 3px 0;
          font-size: 11px;
          line-height: 1.55;
          font-style: italic;
          letter-spacing: 0.02em;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          transition: color 220ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        .vault-peers button:hover {
          color: var(--brass-bright);
        }

        /* Vault peers (same-folder neighbors) — render fallback when no
           agent trace. Replaces "session 0 · 等待 council" placeholder. */
        .vault-peers {
          display: flex;
          flex-direction: column;
          gap: 2px;
          margin: 4px 0 12px;
        }
        .hint-label {
          font-size: 10px;
          letter-spacing: 0.10em;
          font-style: normal;
          font-weight: 500;
          color: var(--brass-bright);
          margin-bottom: 6px;
          font-feature-settings: "smcp" 1;
          text-transform: lowercase;
          opacity: 0.75;
        }

        /* STANZA-CUT REVERTED 2026-04-29 per user feedback "1   2   3 你觉得好看么?"
           — 每段加 30-50vh gap 把同一节内连贯论述硬拆成断片, 还引发切笔记卡顿
           (DOMParser per-render + DOM 节点翻倍).
           // intentional-placeholder: layout breakthrough route 待用户重新讨论
           — stanza-per-paragraph 已被否决, 章-section-cut (只在 H1/H2 处大间距)
           或别的方案需要先和用户对齐再实施, 不能默认填入.
           保留: Source Serif 4 字体 (无破坏的视觉换面), THANGKA-LEDGER rim,
           PROVENANCE-PALPATION gesture. 切回原 marked → DOMPurify 直 innerHTML. */

        /* ─── Headings ─────────────────────────────────────────────────── */
        .note-rendered h1, .note-rendered h2, .note-rendered h3,
        .note-rendered h4, .note-rendered h5, .note-rendered h6 {
          font-family: inherit; letter-spacing: 0;
        }
        .note-rendered h1 {
          font-size: 28px; font-weight: 500;
          color: var(--ink-title);
          margin: 1.4em 0 0.4em;
          line-height: 1.22; letter-spacing: -0.004em;
        }
        /* H2 — section START, anchored by hairline rule above (NYT Mag 2024 pattern).
           Weight 600 = Typotheque CJK 500 ≈ Latin 600 parity rule for serif heading.
           Margin top:bottom 2.4em : 0.7em — H2 clearly OWNED by body below
           (was 1.6em : 0.36em which made H2 cling to wrong side, leaving orphan
           air above and starving the section break). */
        .note-rendered h2 {
          counter-increment: h2counter;
          font-family: inherit;
          font-size: 22px;
          font-weight: 600;
          font-style: normal;
          color: var(--ink-title);
          letter-spacing: 0.01em;
          margin: 2.4em 0 0.7em;
          padding-top: 1.1em;
          border-top: 1px solid color-mix(in srgb, var(--brass-mid) 28%, transparent);
          line-height: 1.4;
          position: relative;
        }
        .note-rendered > h2:first-child {
          border-top: none; padding-top: 0; margin-top: 0;
        }
        /* Roman numeral marginalia REMOVED — detached roman is a dying 2024-2026
           editorial form. NYT Mag / New Yorker / Are.na / Heptabase frontier all
           inline-merge or kill it. Personal notes have subjects, not chapters;
           the CSS-counter numeral carried zero semantic info. The hairline rule
           above does the section break instead, costlessly. */
        .note-rendered h2::before { content: none; }
        .note-rendered h3 {
          font-size: 18px; font-weight: 500;
          color: var(--ink-title);
          margin: 1.4em 0 0.28em;
          line-height: 1.32;
          position: relative; padding-left: 14px;
        }
        .note-rendered h3::before {
          content: ''; position: absolute;
          left: 0; top: 0.34em; bottom: 0.34em; width: 2px;
          background: var(--brass-mid);
          border-radius: 1px;
        }
        .note-rendered h4 {
          font-size: 16px; font-weight: 600; color: var(--ink-title);
          margin: 1.2em 0 0.24em;
        }
        .note-rendered h5, .note-rendered h6 {
          font-size: 12.5px; font-weight: 500; color: var(--ink-muted);
          margin: 1em 0 0.24em;
          font-family: "JetBrains Mono", monospace;
          letter-spacing: 0.06em;
        }

        /* ─── Paragraphs (no indent — pick ONE rhythm; vertical air carries) ─ */
        .note-rendered p {
          margin: 0 0 0.95em;
          text-wrap: pretty;
          hanging-punctuation: first last;
        }
        .note-rendered :first-child { margin-top: 0; }

        /* Small-caps lead-in on first paragraph after standfirst (Leo's
           drop-cap alternative — Old Money editorial canon). Applied to
           ::first-line, not a custom span, so it survives reflow. */
        .note-rendered > p:first-of-type::first-line {
          font-variant: small-caps;
          letter-spacing: 0.06em;
          color: var(--ink-title);
        }

        /* ─── Lists ─────────────────────────────────────────────────────── */
        .note-rendered ul, .note-rendered ol {
          margin: 0.6em 0 1.1em;
          padding-left: 28px;
        }
        .note-rendered li { margin: 0.32em 0; line-height: 1.6; }
        .note-rendered ul > li::marker { color: var(--brass-mid); }
        .note-rendered ol > li::marker { color: var(--brass-mid); font-feature-settings: "onum" 1; }

        /* ─── Inline ─────────────────────────────────────────────────────── */
        .note-rendered a {
          color: var(--brass-bright); text-decoration: none;
          border-bottom: 1px solid var(--border-soft);
          transition: border-color 220ms, color 220ms;
        }
        .note-rendered a:hover {
          color: var(--accent-teal);
          border-bottom-color: var(--accent-teal);
        }
        .note-rendered strong { color: var(--ink-title); font-weight: 600; }
        .note-rendered em { font-style: italic; color: var(--hush); }
        /* Heading em: keep italic (user's emphasis intent in markdown like ## *xxx*)
           but DO NOT inherit body em hush color — else heading hierarchy inverts
           when user italicizes the whole heading and title becomes lighter than body. */
        .note-rendered h1 em, .note-rendered h2 em, .note-rendered h3 em,
        .note-rendered h4 em, .note-rendered h5 em, .note-rendered h6 em {
          color: inherit;
        }

        /* ─── Selection halo — the ONE chromatic moment at rest ─────────── */
        .note-rendered ::selection {
          background: var(--accent-teal-soft);
          color: inherit;
        }

        /* ─── Code (allowed to escape measure into right gutter) ────────── */
        .note-rendered code {
          font-family: "JetBrains Mono", "Cascadia Code", monospace;
          font-size: 14px;
          background: var(--code-bg);
          padding: 1px 6px; border-radius: 4px;
          color: var(--code-fg); font-weight: 500;
          font-feature-settings: "tnum" 1, "lnum" 1;
        }
        .note-rendered pre {
          background: var(--bg-base);
          border: 1px solid var(--border-hairline);
          border-radius: 0;
          padding: 14px 18px; margin: 1.2em 0;
          overflow: auto;
          max-width: calc(100% + clamp(24px, 4vw, 80px));
        }
        .note-rendered pre code {
          background: transparent; padding: 0;
          color: var(--ink-primary); font-size: 13.5px;
          line-height: 1.6; font-weight: 400;
        }

        /* ─── Blockquote ────────────────────────────────────────────────── */
        .note-rendered blockquote {
          margin: 1em 0;
          padding: 0.2em 0 0.2em 18px;
          border-left: 2px solid var(--brass-mid);
          color: var(--ink-muted);
          font-style: italic;
          font-size: 18px; line-height: 1.6;
        }
        .note-rendered blockquote p { margin: 0 0 0.4em; }
        .note-rendered blockquote :last-child { margin-bottom: 0; }

        /* ─── Section break ─────────────────────────────────────────────── */
        .note-rendered hr {
          border: 0; height: 1px; margin: 1.6em 0;
          background: var(--border-hairline);
        }

        /* ─── Tables ────────────────────────────────────────────────────── */
        .note-rendered table {
          border-collapse: collapse; margin: 1em 0; font-size: 15px;
          max-width: calc(100% + clamp(24px, 4vw, 80px));
        }
        .note-rendered th, .note-rendered td {
          border-bottom: 1px solid var(--border-soft);
          padding: 9px 14px; text-align: left;
        }
        .note-rendered th {
          color: var(--ink-title); font-weight: 500;
          font-family: "EB Garamond", "Noto Serif SC", "Cormorant Garamond", serif;
          font-style: italic;
          font-size: 14px;
        }
        .note-rendered img { max-width: 100%; border-radius: 0; margin: 0.8em 0; }

        /* ─── Project apparatus (blueprint-style notes) ──────────────────
           Shown when frontmatter.kind === 'project' | 'blueprint'.
           Diptych when both lists ≥3 (Muse PATH E gate); else stacked.
           Mirrors the apparatus from the removed atlas BlueprintPage,
           preserving the single-decoration-per-page rule. */
        .note-project-apparatus {
          grid-column: 2;
          display: grid;
          grid-template-columns: 1fr 1fr;
          column-gap: 5ch;
          align-items: start;
          margin: 0 0 2.4rem;
          position: relative;
        }
        .note-project-apparatus--stacked {
          display: block;
        }
        .note-project-apparatus--diptych::before {
          content: '';
          position: absolute;
          left: 50%; top: 0; bottom: 0;
          width: 1px; background: var(--brass-leaf);
          transform: translateX(-0.5px);
        }
        .note-project-col {
          padding-right: 2ch;
          max-width: 32ch;
        }
        .note-project-apparatus--stacked .note-project-col {
          margin-bottom: 1.6rem;
          padding: 0;
          max-width: 60ch;
        }
        .note-project-col--questions {
          padding-right: 0;
          padding-left: 2ch;
        }
        .note-project-apparatus--stacked .note-project-col--questions {
          padding: 0;
        }
        .note-project-label {
          font-family: "JetBrains Mono", monospace;
          font-size: 10.5px; letter-spacing: 0.06em;
          color: var(--ink-faint);
          margin-bottom: 14px;
        }
        .note-project-apparatus ol {
          padding-left: 28px; margin: 0;
          list-style-type: upper-roman;
          font-family: "EB Garamond", "Noto Serif SC", Georgia, serif;
          font-size: 16px; line-height: 1.4;
          color: var(--ink-primary);
        }
        .note-project-col--questions ol {
          list-style-type: decimal;
        }
        .note-project-col--questions li {
          font-style: italic;
        }
        .note-project-apparatus li {
          margin-bottom: 9px;
          padding-left: 6px;
        }
        @media (max-width: 720px) {
          .note-project-apparatus { grid-template-columns: 1fr; column-gap: 0; row-gap: 1.6rem; }
          .note-project-apparatus--diptych::before { display: none; }
        }

        /* ─── Footer (folio + reading time + date) ──────────────────────── */
        .note-footer {
          grid-column: 2;
          margin-top: 56px;
          padding-top: 18px;
          border-top: 0.5px solid var(--border-hairline);
          font-family: "EB Garamond", "Cormorant Garamond", Georgia, serif;
          font-style: italic;
          font-size: 13px; color: var(--ink-faint);
          opacity: 0.7;
          display: flex; align-items: baseline; gap: 14px;
          letter-spacing: 0;
        }
        .note-footer-edit {
          margin-left: auto;
          font-style: normal; font-family: "JetBrains Mono", monospace;
          font-size: 10px; letter-spacing: 0.04em;
          opacity: 0.55;
        }
      `}</style>
      {/* Back chevron — absolute, single brass nail above the alcove
          (Lung's prescription). Always clickable, idles to 0.10 alpha. */}
      {onBack && (
        <button
          onClick={onBack}
          aria-label="back to recall"
          style={{
            position: 'absolute', top: 22, left: 22, zIndex: 5,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, padding: 0,
            background: 'transparent', border: 'none',
            cursor: 'pointer',
            color: 'var(--ink-faint)',
            opacity: chevronVisible ? 0.62 : 0.10,
            transition: chevronVisible
              ? 'opacity 180ms cubic-bezier(0.22,1,0.36,1), color 200ms cubic-bezier(0.22,1,0.36,1)'
              : 'opacity 3500ms cubic-bezier(0.4, 0, 0.2, 1), color 200ms',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.color = 'var(--accent-teal)';
            e.currentTarget.style.opacity = '0.92';
            setChevronVisible(true);
            clearTimeout(idleTimerRef.current);
          }}
          onMouseLeave={e => {
            e.currentTarget.style.color = 'var(--ink-faint)';
            e.currentTarget.style.opacity = '';
            idleTimerRef.current = setTimeout(() => setChevronVisible(false), 500);
          }}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <path d="M11.5 4.25 L 6.5 9 L 11.5 13.75"
                  stroke="currentColor" strokeWidth="1.4"
                  strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}

      {/* The page — 3-col grid stage (Leo's BET).
          Folio header / title / standfirst / body / footer all sit in col-2.
          NO key={rel} → DOM 不重挂载 → 切换时 .note-rendered 单独 fade，
          scrollbar gutter / page frame 保持 invariant (per Muse + Leo 2026-04-28).

          When !bodyReady (rel changed but vault.read not yet resolved), the
          whole .note-page sits at opacity:0 + blur(6px) — title, body, folio
          all hidden together. The WAAPI fires at flushSync time and animates
          out of this state over 360ms. This makes the blur defocus animation
          the SOLE protagonist of the switch — no bare-title flash, no
          2-stage paint, no parent-layer animation competing. */}
      <div
        ref={notePageRef}
        className="note-page"
        data-tier={provenanceTier ?? undefined}
        style={{
          '--note-prose-opacity': proseOpacity,
          ...(!bodyReady ? { opacity: 0, filter: 'blur(6px)' } : {}),
        }}
      >
        <header className="note-folio">
          <span className="note-folio-section">{folioSection}</span>
          <span className="note-folio-bullet">·</span>
          <span>{(displayTitle || '').toLowerCase()}</span>
        </header>

        <h1 className="note-title">{displayTitle}</h1>

        {bodyReady && standfirst && (
          <p className="note-standfirst">{standfirst}</p>
        )}

        <hr className="note-meta-rule" aria-hidden="true" />

        {projectHeader && (
          <section className={'note-project-apparatus' + (projectHeader.useDiptych ? ' note-project-apparatus--diptych' : ' note-project-apparatus--stacked')}>
            {projectHeader.pillars.length > 0 && (
              <div className="note-project-col note-project-col--pillars">
                <div className="note-project-label">pillars</div>
                <ol>
                  {projectHeader.pillars.map((p, i) => <li key={i}>{p}</li>)}
                </ol>
              </div>
            )}
            {projectHeader.open_questions.length > 0 && (
              <div className="note-project-col note-project-col--questions">
                <div className="note-project-label">open questions</div>
                <ol>
                  {projectHeader.open_questions.map((q, i) => <li key={i}>{q}</li>)}
                </ol>
              </div>
            )}
          </section>
        )}

        {mode === 'render' ? (
          <div
            className="note-rendered"
            onClick={handleRenderedClick}
            dangerouslySetInnerHTML={{ __html: bodyReady ? (html || '<p style="color:var(--ink-faint);font-style:italic">empty note — double-click to edit.</p>') : '' }}
          />
        ) : (
          <textarea
            ref={textareaRef}
            className="note-rendered"
            value={body}
            onChange={e => setBody(e.target.value)}
            spellCheck={false}
            style={{
              /* 写作区 = col-2 only (黄金分割对齐 — text wrap 落在 col-2/
                 col-3 边界 = .note-page × 0.618. 写作和阅读 measure 同 73ch,
                 视觉线和文字 wrap 一致, 不再"文字穿过线进 col-3").
                 Per user 2026-04-29 "黄金分割率找好位置, 文字超出线了". */
              gridColumn: '2',
              maxWidth: 'none',
              width: '100%',
              minHeight: '70vh', resize: 'none', overflow: 'hidden',
              background: 'transparent', border: 0, outline: 'none',
              fontFamily: '"Source Serif 4 Variable", "EB Garamond", "Noto Serif SC", "Source Han Serif SC", "Cormorant Garamond", "Songti SC", serif',
              fontFeatureSettings: '"kern" 1, "onum" 1',
              fontOpticalSizing: 'auto',
              fontSize: 18, lineHeight: 1.62,
              color: 'var(--ink-title)',
              padding: '4px 16px 0 0',
            }}
          />
        )}

        {/* col-3 marginalia. Renders ONLY when has functional content:
            agent-trace events, vault peers (fallback), wikilink suggestions
            (edit), or active deepen sessions (edit). Truly empty = silent
            absence (no decorative placeholder), per user 2026-04-29
            "等待council 有什么用" 反馈. */}
        {(agentTrace.length > 0
          || (mode === 'edit' && deepenSessions.length > 0)
        ) && (
        <aside className="note-marginalia">
          {/* Edit-only: deepen breadcrumb (active sessions, 已 ship — 与
              agent-trace 同 spirit, 兼容并存). */}
          {mode === 'edit' && deepenSessions.length > 0 && (
            <nav className="deepen-breadcrumb" aria-label="active deepens">
              <div className="deepen-label">deepens · {deepenSessions.length}</div>
              {deepenSessions.map(sess => (
                <div key={sess.id} className="deepen-item">
                  <button
                    onClick={() => {
                      if (sess.host && sess.host.scrollIntoView) {
                        sess.host.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      }
                    }}
                    title={sess.selection}
                  >
                    <span className="deepen-dot">{sess.mode === 'quick' ? '◌' : '●'}</span>
                    {' '}
                    <span className="deepen-excerpt">
                      {(sess.selection || '').slice(0, 24)}
                      {(sess.selection || '').length > 24 ? '…' : ''}
                    </span>
                  </button>
                  <button
                    className="deepen-dismiss"
                    onClick={() => onDiscardDeepen(sess.id)}
                    title="stop + dismiss (interrupts running gemini)"
                    aria-label="stop and dismiss this deepen"
                  >⊘</button>
                </div>
              ))}
            </nav>
          )}

          {/* AGENT-TRACE RIBBON — both modes, 倒序 last 10. */}
          {agentTrace.length > 0 && (
            <ul className="agent-trace-ribbon" aria-label="council footprint">
              {agentTrace.map((ev, i) => (
                <li key={i}>
                  <span className="trace-agent">{ev.agent_id}</span>
                  <span className="trace-ts">{formatTraceTs(ev.ts)}</span>
                  <span className="trace-op">{formatTraceOp(ev)}</span>
                </li>
              ))}
            </ul>
          )}

          {/* COUNCIL PROVOCATION slot — REVERTED 2026-04-29 (user 反对
              gemini-quality auto-suggest = WPS-tier 反感). 重 ship 待
              Claude API 集成 + 手动 trigger 模式. 现在 edit col-3 仅有
              deepen breadcrumb + agent-trace + vault-peers fallback. */}

          {/* 2026-05-03 — vault-peers block removed per user request.
              The same-folder peer list (showing 01-pending / 02-pending /…
              under the chain folder name) cluttered the recall view; pending
              lessons clearly aren't useful drill targets, and the chain rail
              + footer already provide cleaner navigation. */}
        </aside>
        )}

        {/* Inline deepen callouts — Path B真正的 inline. Each session is rendered
            via ReactDOM.createPortal into a host <div class="deepen-host"> that we
            inserted into .note-rendered right after the selected paragraph (DOM
            manipulation in Cmd+K handler). User sees callout immediately below
            the段 they're reading, not far at end of note. */}
        {window.DeepenCallout && deepenSessions.map(sess =>
          sess.host
            ? ReactDOM.createPortal(
                <DeepenErrorBoundary>
                  <window.DeepenCallout
                    mode={sess.mode || 'deepen'}
                    selection={sess.selection}
                    noteRel={sess.noteRel}
                    style={sess.style}
                    lang={sess.lang}
                    onPersist={(text, style) => onPersistDeepen(sess.id, text, style)}
                    onDiscard={() => onDiscardDeepen(sess.id)}
                    onContinue={(nextMode, direction, priorSynth) => onContinueDeepen(sess, nextMode, direction, priorSynth)}
                  />
                </DeepenErrorBoundary>,
                sess.host,
                sess.id
              )
            : null
        )}

        {/* Backlinks panel (Obsidian 灵魂) — notes containing [[wikilink]]
            referencing this one. Below body, above footer. Per user
            2026-04-29 "把 Obsidian 灵魂融入 PTOR". Hidden when 0 backlinks. */}
        {backlinks.length > 0 && bodyReady && (
          <section className="note-backlinks" aria-label="linked from">
            <div className="backlinks-label">linked from {backlinks.length}</div>
            <ul>
              {backlinks.map((b, i) => (
                <li key={i}>
                  <button
                    onClick={() => window.dispatchEvent(new CustomEvent('ptor:open-rel', { detail: b.rel }))}
                    title={b.rel}
                  >
                    <span className="backlink-label">{b.label}</span>
                    <span className="backlink-excerpt">{b.excerpt}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="note-footer">
          <span>{(meta && meta.rel) ? meta.rel.split('/').pop() : ''}</span>
          {folioDate && <span>{folioDate}</span>}
          <span>~{readingMinutes} min</span>
          {/* corpus signals — only render when present + meaningful. Editorial
              tone via single-word qualitative state (vivid/fading/asleep).
              Cite count appears only when ≥1; "cited 4×" reads as natural
              language. recall_count omitted to avoid footer bloat — RecallDashboard
              already surfaces dormant notes by ranking. */}
          {strengthLabel && <span>{strengthLabel.word} {strengthLabel.pct}</span>}
          {corpus && corpus.citeCount > 0 && (
            <span>cited {corpus.citeCount}×</span>
          )}
          <span className="note-footer-edit">
            {deepenSessions.length > 0
              ? 'edit locked — keep or let go deepen first'
              : 'double-click to ' + (mode === 'render' ? 'edit' : 'preview')}
          </span>
        </footer>
      </div>
      {askCard && window.AskCard && (
        <window.AskCard
          template={askCard.template}
          selection={askCard.selection}
          noteRel={rel}
          onClose={() => setAskCard(null)}
          onPin={onPinResult}
          onAppend={onAppendResult}
        />
      )}
      {palpationOpen && window.PalpationOverlay && (
        <window.PalpationOverlay
          tier={provenanceTier}
          readCount={corpus?.readCount || 0}
          mtime={corpus?.mtime || null}
          onDismiss={() => setPalpationOpen(false)}
        />
      )}
      {/* 2026-05-03 v0148 — Recall inline deepen pill. Position:fixed,
          anchored to selection's trailing edge, viewport-clamped. Click
          mounts DeepenCallout INLINE below the source paragraph (stays on
          Recall view; no chat route). */}
      {recallQuote && (
        <div
          role="button"
          aria-label="deepen this passage inline"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onDeepenInline}
          style={{
            position: 'fixed',
            left: Math.min(Math.max(8, recallQuote.x + 8), (typeof window !== 'undefined' ? window.innerWidth : 1200) - 120),
            top: Math.min(Math.max(8, recallQuote.y + 6), (typeof window !== 'undefined' ? window.innerHeight : 800) - 40),
            zIndex: 100,
            fontFamily: '"Cormorant Garamond", "EB Garamond", "Noto Serif SC", Georgia, serif',
            fontStyle: 'italic',
            fontSize: 12.5,
            letterSpacing: '0.04em',
            color: 'var(--ink-faint)',
            padding: '5px 12px',
            border: '1px solid color-mix(in srgb, var(--brass-mid) 38%, transparent)',
            background: 'color-mix(in srgb, var(--brass-mid) 6%, var(--bg-page, #faf6ee))',
            boxShadow: '0 4px 14px color-mix(in srgb, var(--brass-mid) 12%, transparent)',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            userSelect: 'none',
            animation: 'recall-ask-fade-in 220ms ease-out 80ms both',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--ink-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--ink-faint)'; }}
        >· deepen</div>
      )}
    </div>
  );
}

Object.assign(window, { RecallNoteView });
