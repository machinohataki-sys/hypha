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

// v0.4.0 — top-level NoteView error boundary. v0.3.x had blank-screen
// failures when a child component crashed silently — user saw cream paper
// with no error. This catches anything below NoteView and prints the error
// + component stack inline so future bugs surface their own diagnostic
// without requiring DevTools console.
class NoteViewErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null, info: null }; }
  static getDerivedStateFromError(error) { return { error: error, info: null }; }
  componentDidCatch(error, info) {
    console.error('[noteview-error-boundary] NoteView crashed:', error);
    console.error('[noteview-error-boundary] component stack:', info && info.componentStack);
    this.setState({ info });
  }
  render() {
    if (this.state.error) {
      const msg = String(this.state.error.message || this.state.error);
      const stack = this.state.info ? String(this.state.info.componentStack || '').slice(0, 400) : '';
      return (
        <div style={{
          flex: 1, padding: '48px',
          fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
          color: 'var(--verdict-flag, #c46a5d)',
          overflow: 'auto',
        }}>
          <div style={{
            maxWidth: 720, margin: '0 auto',
            borderLeft: '3px solid var(--verdict-flag, #c46a5d)',
            paddingLeft: 18,
          }}>
            <p style={{ fontStyle: 'italic', fontSize: 16, marginBottom: 12 }}>
              this lesson view crashed while rendering.
            </p>
            <p style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 12, color: 'var(--ink-muted)', marginBottom: 12 }}>
              {msg}
            </p>
            {stack && (
              <pre style={{
                fontFamily: '"JetBrains Mono", monospace', fontSize: 11,
                color: 'var(--ink-faint)', whiteSpace: 'pre-wrap',
                background: 'color-mix(in srgb, var(--brass-mid) 6%, transparent)',
                padding: 12, borderRadius: 2, overflow: 'auto', maxHeight: 240,
              }}>{stack}</pre>
            )}
            <p style={{ fontStyle: 'italic', fontSize: 13, marginTop: 14, color: 'var(--ink-muted)' }}>
              please share this with Victor — paste the message + stack above.
              press Esc / pick another note in the sidebar to recover.
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Outer NoteView entry — wraps the actual implementation in the v0.4.0
// error boundary so a child render crash surfaces an inline error card
// (with stack + actionable message) instead of a blank cream rectangle.
function NoteView(props) {
  return (
    <NoteViewErrorBoundary>
      <NoteViewInner {...props} />
    </NoteViewErrorBoundary>
  );
}

function NoteViewInner({ rel, onBack, viewMode = 'evolution' }) {
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
  // Hypha — lesson session for curriculum notes. Object { id, requestId } | null.
  // Rendered inline in note-page header when frontmatter.lesson_idx is set.
  const [lessonOpen, setLessonOpen] = React.useState(false);
  const [finishStatus, setFinishStatus] = React.useState(null); // null|'distilling'|'done'|'error'
  // Reset lesson state when navigating to a different note.
  React.useEffect(() => { setLessonOpen(false); setFinishStatus(null); }, [rel]);

  // v0.8.0 候光 P3 OPSZ — variable-font opsz axis modulates with viewport
  // zone occupancy on display type ONLY (h1/h2/h3 + .note-title). SCOUT
  // 2026-05-02 verified: opsz on body paragraphs triggers full relayout —
  // chouguang.opszAttention enforces a 150-char ceiling and throws otherwise.
  // P4 HAIRLINE — quote-mark underline draws L-to-R on first viewport entry
  // (replaces the static at-rest underline that read as "stamped" not "earned").
  React.useEffect(() => {
    if (!window.chouguang) return;
    const stage = stageRef.current;
    if (!stage) return;
    const disposers = [];
    const id = requestAnimationFrame(() => {
      try {
        const headings = stage.querySelectorAll('h1.note-title, .note-rendered h1, .note-rendered h2, .note-rendered h3');
        headings.forEach(h => {
          try {
            const dispose = window.chouguang.opszAttention(h, {});
            if (typeof dispose === 'function') disposers.push(dispose);
          } catch (_) {}
        });
        const quoteMarks = stage.querySelectorAll('.hypha-quote-mark');
        quoteMarks.forEach(q => {
          q.classList.add('chouguang-hl');
          try { window.chouguang.hairline(q, { durationMs: 520, onlyFirstEntry: true }); } catch (_) {}
        });
      } catch (_) {}
    });
    return () => {
      cancelAnimationFrame(id);
      disposers.forEach(d => { try { d(); } catch (_) {} });
    };
  }, [rel, html, bodyReady]);
  // Clear sessions on rel change (sessions are scoped to current note view)
  React.useEffect(() => { setDeepenSessions([]); }, [rel]);

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
  // v0.11.0 — when basename match fails (data-rel absent), consult
  // wikiResolve IPC: may resolve to an atlas concept (dispatch
  // hypha:open-concept-page) or a daily note. Falls back to flash on miss.
  const handleRenderedClick = React.useCallback(async (e) => {
    const a = e.target.closest && e.target.closest('a.wikilink');
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    const targetRel = a.getAttribute('data-rel');
    if (targetRel) {
      window.dispatchEvent(new CustomEvent('ptor:open-rel', { detail: targetRel }));
      return;
    }
    // Broken link path — try wikiResolve before flashing.
    const target = a.getAttribute('data-target') || (a.textContent || '').trim();
    if (target && window.ptor && window.ptor.vault && window.ptor.vault.wikiResolve) {
      try {
        const r = await window.ptor.vault.wikiResolve(target);
        if (r && r.exists) {
          if ((r.kind === 'note' || r.kind === 'daily') && r.rel) {
            window.dispatchEvent(new CustomEvent('ptor:open-rel', { detail: r.rel }));
            return;
          }
          if (r.kind === 'concept' && r.conceptKey) {
            window.dispatchEvent(new CustomEvent('hypha:open-concept-page', { detail: r.conceptKey }));
            return;
          }
        }
      } catch (_) {}
    }
    // unknown — gentle flash
    a.classList.add('wikilink-flash');
    setTimeout(() => a.classList.remove('wikilink-flash'), 600);
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

  // 2026-05-03 v0145 — Deepen verb retired. After 8 failed builds (6× Ctrl+D
  // chord + 2× paragraph hover-strip declared "无实用性"), council Phase 1
  // (Lung+Leo+Yogo) unanimously chose: kill the dedicated trigger; route
  // selection through the existing chat composer. The selection-anchored
  // composer lives in LessonChat (this file ~line 3290+); NoteViewInner
  // no longer injects strips or listens for deepen-request events.
  // DeepenCallout component + IPC pipeline are kept as substrate but no
  // longer auto-mount from this surface.

  // Clean up any stale .deepen-host nodes when rel changes (defensive —
  // the new flow doesn't create them, but legacy vault content might
  // contain leftovers from earlier builds).
  React.useEffect(() => {
    return () => {
      // On unmount or rel change, remove all hosts
      document.querySelectorAll('.deepen-host').forEach(h => h.remove());
    };
  }, [rel]);

  // 2026-05-03 v0149 — Ctrl+Shift+D opens AskCard floating popover (per user
  // "悬浮卡片" / "最开始那个版本" request — the v0.1 era UI, NOT the inline
  // DeepenCallout). Single-shot llm.run against prompts/deepen.txt, rendered
  // by AskCard at NoteView.jsx:2092 (askCard state at line 127, render alive).
  // Coexists with v0148 inline pill in Recall view: pill = mouse / inline
  // multi-stage; chord = keyboard / floating single-shot.
  // VaultTree.jsx:296 owns plain Ctrl+D = daily-note (its `!e.shiftKey` check
  // excludes this chord — no collision).
  React.useEffect(() => {
    const onKey = (e) => {
      const cmd = e.metaKey || e.ctrlKey;
      if (!cmd || !e.shiftKey || e.altKey) return;
      if (e.key !== 'd' && e.key !== 'D') return;
      const t = e.target;
      const tag = (t && t.tagName) ? t.tagName.toLowerCase() : '';
      if (t && (t.isContentEditable || tag === 'input' || tag === 'textarea')) return;
      const sel = window.getSelection && window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const text = sel.toString().trim();
      if (!text) return;
      e.preventDefault();
      setAskCard({ template: 'deepen', selection: text, noteRel: rel });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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

  // Hypha 2026-04-30: in evolution mode + lesson .md, route based on whether
  // the lesson has been graduated (frontmatter.date_distilled set):
  //   - not finished → LessonChat (live Socratic chat, resume latest session)
  //   - finished     → LessonHistoryView (list of all sessions for this lesson)
  // Recall mode always renders the .md normally below.
  const isEvolutionLesson = (
    viewMode === 'evolution'
    && meta && meta.frontmatter
    && meta.frontmatter.lesson_idx !== undefined
    && meta.frontmatter.lesson_idx !== ''
  );
  const isFinished = isEvolutionLesson && meta.frontmatter.date_distilled
    && meta.frontmatter.date_distilled !== 'null'
    && meta.frontmatter.date_distilled !== '';

  if (isEvolutionLesson) {
    return (
      <div
        ref={stageRef}
        className="note-stage hypha-lesson-stage"
        style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          overflow: 'hidden', minHeight: 0,
          position: 'relative',
        }}
      >
        {/* G1B — chain-link nav banner. Renders nothing if this lesson's
            curriculum isn't part of a learning chain. Sits above both
            LessonChat and LessonHistoryView so the user always sees their
            chain context regardless of finish state. */}
        <ChainLinkBanner rel={rel} meta={meta} />
        {isFinished ? (
          <LessonHistoryView
            rel={rel}
            meta={meta}
            onReread={() => {
              if (rel && window.ptor && window.ptor.vault) {
                window.ptor.vault.read(rel).then(res => {
                  if (res) { setBody(res.body || ''); setMeta({ rel: res.rel, mtime: res.mtime, size: res.size, frontmatter: res.frontmatter }); }
                });
              }
            }}
          />
        ) : (
          <LessonChat
            rel={rel}
            meta={meta}
            onDistilled={() => {
              if (rel && window.ptor && window.ptor.vault) {
                window.ptor.vault.read(rel).then(res => {
                  if (res) { setBody(res.body || ''); setMeta({ rel: res.rel, mtime: res.mtime, size: res.size, frontmatter: res.frontmatter }); }
                });
              }
            }}
          />
        )}
        {/* 2026-05-03 — deepen portals MUST also render inside this evolution-
            lesson early-return branch. Previously only the markdown-note return
            (line 1007+) had them; user pressing Ctrl+D in LessonChat / Lesson-
            HistoryView triggered the keydown handler + inserted host divs +
            updated deepenSessions state, but the portal-rendering JSX block
            (~line 2064) was unreachable from this branch → host divs sat
            empty + user saw nothing. */}
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
      </div>
    );
  }

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

        {/* Hypha — old inline lesson controls (Tutor/Finish). Day 2.8 retired:
            evolution+lesson now early-returns LessonChat above. This block is
            only reachable in non-lesson edge cases; gated on `false` to keep
            code as reference but never render. */}
        {false && meta && meta.frontmatter && meta.frontmatter.lesson_idx !== undefined && meta.frontmatter.lesson_idx !== '' && (
          <div style={{
            display: 'flex', gap: 12, alignItems: 'baseline',
            margin: '4px 0 14px',
            fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
          }}>
            <button
              onClick={() => setLessonOpen(v => !v)}
              style={{
                background: 'transparent',
                border: '1px solid color-mix(in srgb, var(--brass-bright) 36%, transparent)',
                borderRadius: 0,
                color: lessonOpen ? 'var(--ink-title)' : 'var(--brass-bright)',
                fontFamily: 'inherit',
                fontStyle: 'italic',
                fontSize: 14,
                padding: '4px 14px',
                cursor: 'pointer',
                letterSpacing: '0.01em',
              }}
              title={lessonOpen ? 'close tutor' : 'open tutor'}
            >
              {lessonOpen ? 'close tutor' : 'tutor'}
            </button>
            <button
              disabled={finishStatus === 'distilling'}
              onClick={async () => {
                if (!window.ptor || !window.ptor.hypha || !rel) return;
                setFinishStatus('distilling');
                try {
                  const r = await window.ptor.hypha.finish(rel, '');
                  if (r && r.ok) {
                    setFinishStatus('done');
                    // Re-read the note so the distilled body shows up in NoteView.
                    setTimeout(() => {
                      const _r = rel;
                      window.ptor.vault.read(_r).then(res => {
                        if (res) { setBody(res.body || ''); setMeta({ rel: res.rel, mtime: res.mtime, size: res.size, frontmatter: res.frontmatter }); }
                      });
                    }, 60);
                  } else {
                    setFinishStatus('error');
                  }
                } catch (_) { setFinishStatus('error'); }
              }}
              style={{
                background: 'transparent',
                border: '1px solid color-mix(in srgb, var(--brass-mid) 28%, transparent)',
                borderRadius: 0,
                color: finishStatus === 'distilling' ? 'var(--ink-faint)' : 'var(--ink-muted)',
                fontFamily: 'inherit',
                fontStyle: 'italic',
                fontSize: 14,
                padding: '4px 14px',
                cursor: finishStatus === 'distilling' ? 'wait' : 'pointer',
                letterSpacing: '0.01em',
              }}
              title="distill the conversation into this note's two layers"
            >
              {finishStatus === 'distilling' ? 'distilling…' : finishStatus === 'done' ? 'distilled ✓' : finishStatus === 'error' ? 'try again' : 'finish lesson'}
            </button>
            {meta.frontmatter.learn_goal && (
              <span style={{
                fontStyle: 'italic',
                color: 'var(--ink-faint)',
                fontSize: 13,
                opacity: 0.78,
                marginLeft: 4,
              }}>{String(meta.frontmatter.learn_goal).replace(/^"|"$/g, '')}</span>
            )}
          </div>
        )}

        {/* Hypha — old inline DeepenCallout lesson session. Day 2.8 retired:
            LessonChat above owns the chat surface in evolution. Gated false. */}
        {false && lessonOpen && window.DeepenCallout && (
          <div style={{ margin: '0 0 22px' }}>
            <window.DeepenCallout
              mode="lesson"
              selection=""
              noteRel={rel}
              style="denser"
              lang="en"
              direction=""
              autorun
              onPersist={() => { /* lesson persist = noop; finish button does the real distill */ }}
              onDiscard={() => setLessonOpen(false)}
            />
          </div>
        )}

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
          || vaultPeers.length > 0
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

          {/* Both modes fallback: same-folder peers when agentTrace=0. Real
              navigable list. Click dispatches CustomEvent that App.jsx listens
              for to update active rel — decoupled from prop drill. */}
          {agentTrace.length === 0 && vaultPeers.length > 0 && (
            <nav className="vault-peers" aria-label="folder peers">
              <div className="hint-label">{(rel.split('/')[0] || 'vault')}</div>
              {vaultPeers.map((p, i) => (
                <button
                  key={i}
                  onClick={() => window.dispatchEvent(new CustomEvent('ptor:open-rel', { detail: p.rel }))}
                  title={p.rel}
                >
                  {p.label.replace(/\.md$/i, '')}
                </button>
              ))}
            </nav>
          )}
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
    </div>
  );
}

// ============================================================================
// ChainLinkBanner — G1B.
// When the open lesson belongs to a curriculum that's a link in a learning
// chain, show "chain: {goal} · link N/M · this curriculum: {topic}". When the
// user is on the last lesson AND the lesson is finished (date_distilled set),
// expose an "advance →" button that calls window.ptor.hypha.chainAdvance and
// dispatches both `hypha:open-rel` (per spec) and `ptor:open-rel` (the actually-
// listened-for event in App.jsx) to navigate to the next chain link.
// Renders nothing if there's no chain.
// ============================================================================
function ChainLinkBanner({ rel, meta }) {
  const [state, setState] = React.useState(null);          // curriculum's state.json
  const [chain, setChain] = React.useState(null);          // chain's chain.json
  const [linksState, setLinksState] = React.useState(null);// chain's links-state.json
  const [advancing, setAdvancing] = React.useState(false);
  const [advanceError, setAdvanceError] = React.useState(null);

  const slug = React.useMemo(
    () => (rel ? rel.split(/[\\/]/)[0] : null),
    [rel]
  );

  React.useEffect(() => {
    if (!slug || !window.ptor || !window.ptor.vault) return undefined;
    let cancelled = false;
    setState(null); setChain(null); setLinksState(null);
    setAdvancing(false); setAdvanceError(null);

    window.ptor.vault.read(slug + '/state.json').then((res) => {
      if (cancelled) return;
      if (!res || !res.body) { setState({ chainSlug: null }); return; }
      let parsed = null;
      try { parsed = JSON.parse(res.body); } catch (_) { parsed = null; }
      if (!parsed || !parsed.chainSlug) {
        setState({ chainSlug: null });
        return;
      }
      setState(parsed);
      const cSlug = parsed.chainSlug;
      Promise.all([
        window.ptor.vault.read(cSlug + '/chain.json'),
        window.ptor.vault.read(cSlug + '/links-state.json'),
      ]).then(([chainRes, lsRes]) => {
        if (cancelled) return;
        try {
          if (chainRes && chainRes.body) setChain(JSON.parse(chainRes.body));
        } catch (_) {}
        try {
          if (lsRes && lsRes.body) setLinksState(JSON.parse(lsRes.body));
        } catch (_) {}
      }).catch(() => {});
    }).catch(() => {});

    return () => { cancelled = true; };
  }, [slug]);

  // Bail until we know whether there's a chain.
  if (!state) return null;
  if (!state.chainSlug) return null;
  if (!linksState || !chain) return null;

  const links = Array.isArray(linksState.links) ? linksState.links : [];
  const currentLinkIdx = links.findIndex((l) => l && l.slug === slug);
  if (currentLinkIdx < 0) return null;
  const totalLinks = links.length;
  const currentLink = links[currentLinkIdx] || {};
  const chainGoal = chain.ultimate_goal || chain.goal || '';

  // Last-lesson + finished detection.
  const lessonRels = Array.isArray(state.lessonRels) ? state.lessonRels : [];
  const isLastLesson = lessonRels.length > 0 && rel === lessonRels[lessonRels.length - 1];
  const dd = meta && meta.frontmatter && meta.frontmatter.date_distilled;
  const isFinished = !!(dd && dd !== 'null' && dd !== '');
  const hasNextLink = currentLinkIdx + 1 < totalLinks;
  const nextLink = hasNextLink ? links[currentLinkIdx + 1] : null;
  const showAdvance = isLastLesson && isFinished && hasNextLink;

  const handleAdvance = async () => {
    if (!window.ptor || !window.ptor.hypha
      || typeof window.ptor.hypha.chainAdvance !== 'function') {
      setAdvanceError('chainAdvance unavailable');
      return;
    }
    setAdvancing(true); setAdvanceError(null);
    try {
      const r = await window.ptor.hypha.chainAdvance({ chainSlug: state.chainSlug });
      if (r && r.ok && r.nextLessonRel) {
        try { window.dispatchEvent(new CustomEvent('hypha:open-rel', { detail: { rel: r.nextLessonRel } })); } catch (_) {}
        try { window.dispatchEvent(new CustomEvent('ptor:open-rel', { detail: r.nextLessonRel })); } catch (_) {}
      } else {
        setAdvancing(false);
        setAdvanceError((r && r.error) || 'failed to advance');
      }
    } catch (err) {
      setAdvancing(false);
      setAdvanceError((err && err.message) || String(err));
    }
  };

  return (
    <div style={{
      padding: '10px 48px 8px',
      borderBottom: '1px solid color-mix(in srgb, var(--brass-mid) 8%, transparent)',
      fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
      fontStyle: 'italic', fontSize: 13, lineHeight: 1.55,
      color: 'var(--ink-faint)',
      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16,
      flexWrap: 'wrap',
    }}>
      <span>
        chain: {chainGoal} · link {currentLinkIdx + 1}/{totalLinks}
        {currentLink.topic ? <> · this curriculum: {currentLink.topic}</> : null}
      </span>
      {showAdvance && (
        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 12 }}>
          <span style={{ color: 'var(--ink-muted)' }}>
            → ready for next link{nextLink && nextLink.topic ? `: ${nextLink.topic}` : ''}
          </span>
          <button
            onClick={handleAdvance}
            disabled={advancing}
            style={{
              background: 'transparent',
              border: '1px solid color-mix(in srgb, var(--brass-mid) 32%, transparent)',
              borderRadius: '10px 14px 10px 14px',
              color: advancing ? 'var(--ink-faint)' : 'var(--brass-bright)',
              fontFamily: 'inherit', fontStyle: 'italic',
              fontSize: 13, padding: '4px 12px',
              cursor: advancing ? 'not-allowed' : 'pointer',
              opacity: advancing ? 0.5 : 1,
              transition: 'all 220ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            {advancing ? 'advancing…' : 'advance →'}
          </button>
          {advanceError && (
            <span style={{ color: 'var(--verdict-flag, #c44)', fontSize: 12 }}>· {advanceError}</span>
          )}
        </span>
      )}
    </div>
  );
}

// ============================================================================
// LessonChat — Claude.ai-style multi-turn Socratic chat surface for evolution
// mode. Replaces the .md markdown render when viewMode === 'evolution' AND
// meta.frontmatter.lesson_idx exists. The .md file is no longer the live
// surface; it becomes a distill artifact written by lesson:finish.
//
// State machine:
//   on mount → if no messages, auto-fire __begin__ (tutor speaks first)
//   on user submit → append user msg + tutor placeholder → invoke llm:lesson
//   on chunk events (status:'chunk', stage:'lesson') → append to last tutor msg
//   on done → setStreaming(false)
//   on Finish lesson click → invoke lesson:finish → setBody(distilled) so user
//     sees the result inline. User can then switch to recall mode via wordmark.
// ============================================================================

function LessonChat({ rel, meta, onDistilled, sourceSessionFile }) {
  const [messages, setMessages] = React.useState([]);
  const [input, setInput] = React.useState('');
  const [streaming, setStreaming] = React.useState(false);
  // 2026-05-03 v0145 — selection-anchored composer (replaces deepen verb).
  // When user has a non-collapsed selection inside .hypha-chat-rich (tutor
  // bubble) or .note-rendered (rendered note), this state holds the text.
  // Composer shows a quoted preview + placeholder swap. On send, the user
  // message is prepended with `> [selection]\n\n[user text]`. No new gesture,
  // no new component — just routes through the existing chat infrastructure.
  const [quotedSelection, setQuotedSelection] = React.useState(null);
  const [finishStatus, setFinishStatus] = React.useState(null); // null|'distilling'|'done'|'error'
  // 2026-05-03 — adapting next lesson banner. true while lessonsAdapt is in
  // flight (between hypha:lessons-adapt-started + -done events). Removes the
  // "is anything happening?" anxiety while the deferred 60-90s LLM call runs
  // in the background after FINISH.
  const [adaptingNext, setAdaptingNext] = React.useState(false);
  React.useEffect(() => {
    const onStart = (e) => { if (!e || !e.detail || e.detail.rel === rel) setAdaptingNext(true); };
    const onDone  = (e) => { if (!e || !e.detail || e.detail.rel === rel) setAdaptingNext(false); };
    window.addEventListener('hypha:lessons-adapt-started', onStart);
    window.addEventListener('hypha:lessons-adapt-done', onDone);
    return () => {
      window.removeEventListener('hypha:lessons-adapt-started', onStart);
      window.removeEventListener('hypha:lessons-adapt-done', onDone);
    };
  }, [rel]);

  // 2026-05-03 v0145.1 — selection watcher for the selection-anchored composer.
  // CRITICAL: commit on mouseup, NOT on selectionchange. selectionchange fires
  // during the drag, which would render the preview block mid-drag, push the
  // composer up, reflow the chat area, and shift the prose under the user's
  // still-pressed mouse — the selection then extends to include preceding
  // text the user didn't intend (user complaint 2026-05-03: "我选中文字然后
  // 自动给我把上文我不想要的文字也选取了"). Mouseup-only ensures preview
  // appears AFTER selection is final, so any subsequent layout shift can't
  // change what was selected.
  //
  // Doesn't auto-clear on collapse — user might click into textarea (which
  // collapses selection) and we want the quote to persist. Cleared only by ×,
  // Esc, send, or a new selection in scope.
  React.useEffect(() => {
    let pendingTimer = null;
    const commitSelection = () => {
      try {
        const sel = window.getSelection && window.getSelection();
        if (!sel || sel.isCollapsed) return;
        const text = (sel.toString() || '').trim();
        if (text.length < 2) return;
        let node = sel.anchorNode;
        if (node && node.nodeType === 3) node = node.parentElement;
        let inScope = false;
        while (node && node !== document.body) {
          if (node.classList && (
            node.classList.contains('hypha-chat-rich') ||
            node.classList.contains('note-rendered')
          )) { inScope = true; break; }
          node = node.parentElement;
        }
        if (inScope) setQuotedSelection({ text });
      } catch (_) {}
    };
    const onMouseUp = () => {
      // 30ms delay so selection state finalizes after browser's native
      // mouseup handling. Without this, sel.toString() can return the
      // pre-mouseup selection on some Chromium versions.
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(commitSelection, 30);
    };
    // Keyboard selection (shift+arrow / shift+click): commit on keyup of
    // shift release. Less common but supported.
    const onKeyUp = (e) => {
      if (e.key === 'Shift') {
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = setTimeout(commitSelection, 30);
      }
    };
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keyup', onKeyUp);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('keyup', onKeyUp);
      if (pendingTimer) clearTimeout(pendingTimer);
    };
  }, []);

  // 2026-05-03 v0145+v0147 — Cross-view quote pickup.
  // RecallNoteView (read-only surface, viewMode='recall') dispatches
  // hypha:open-chat-with-quote + hypha:open-evolution when user clicks the
  // `· ask in chat` pill on a selection. Race condition: the live event
  // fires BEFORE LessonChat is mounted (we're in recall view at dispatch
  // time, evolution view mounts on the NEXT React cycle). Solution:
  // RecallNoteView ALSO stashes on window.__hyphaPendingQuote; LessonChat's
  // mount-time effect (this one) picks it up regardless of timing.
  React.useEffect(() => {
    if (window.__hyphaPendingQuote && window.__hyphaPendingQuote.text) {
      const text = String(window.__hyphaPendingQuote.text || '').trim();
      if (text.length >= 2) setQuotedSelection({ text });
      try { window.__hyphaPendingQuote = null; } catch (_) {}
    }
    const onOpenWithQuote = (e) => {
      if (!e || !e.detail) return;
      const text = String(e.detail.text || '').trim();
      if (text.length >= 2) setQuotedSelection({ text });
    };
    window.addEventListener('hypha:open-chat-with-quote', onOpenWithQuote);
    return () => window.removeEventListener('hypha:open-chat-with-quote', onOpenWithQuote);
  }, []);

  // Esc clears the quoted selection (lightweight detach without clicking ×).
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && quotedSelection) {
        setQuotedSelection(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [quotedSelection]);
  // Phase 3.4 — weekly adaptation summary surfaced after lesson:finish + adapt
  // resolves. null = not loaded; {count, tiers, recent} once available.
  // Rendered as a quiet italic Garamond paragraph below the finish button.
  const [weeklySummary, setWeeklySummary] = React.useState(null);
  const [sessionFile, setSessionFile] = React.useState(sourceSessionFile || null);
  const [sessionMode, setSessionMode] = React.useState(sourceSessionFile ? 'continuation' : 'fresh');
  const [tutorLabel, setTutorLabel] = React.useState(''); // active persona display label
  // Tutor + user profile objects passed to ChatBubble for avatars + names.
  // tutorProfile: per-curriculum agent.json.displayName > global profile.tutorName
  //   > persona.label > 'tutor'.
  // userProfile: from <vault>/data/profile.json (name + tutorName).
  const [tutorProfile, setTutorProfile] = React.useState({ displayName: '', avatar: null });
  const [userProfile, setUserProfile] = React.useState({ name: '', avatar: null, tutorName: '' });
  // History panel — list of past sessions for this lesson, toggled from header.
  // Rows let user switch the chat view to an earlier session (read its turns
  // into `messages` + adopt its file as `sessionFile` so further turns append to it).
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [sessions, setSessions] = React.useState([]);
  const [sessionsLoading, setSessionsLoading] = React.useState(false);
  // autoBegin: null until loaded, then true|false. Read from settings.app on
  // each rel change so the user's general-tab choice ("tutor speaks first" vs
  // "wait for me to begin") takes effect on next lesson open.
  const [autoBegin, setAutoBegin] = React.useState(null);
  const requestIdRef = React.useRef(null);
  const messagesEndRef = React.useRef(null);
  const inputRef = React.useRef(null);
  const beganRef = React.useRef(false);

  // 2.2 — atlas.quotes lifted into LessonChat so ChatBubble can render
  // persistent brass-mid underlines on previously-quoted passages. Reuses
  // hypha:atlas-updated event already dispatched by ConceptAtlas writes.
  // Phase 2.2 plan: flickering-tickling-koala.md.
  const [atlasQuotes, setAtlasQuotes] = React.useState([]);
  React.useEffect(() => {
    if (!rel || !window.ptor || !window.ptor.hypha || !window.ptor.hypha.atlasGet) {
      setAtlasQuotes([]);
      return;
    }
    let alive = true;
    const reload = () => {
      window.ptor.hypha.atlasGet(rel).then(a => {
        if (!alive) return;
        const qs = (a && Array.isArray(a.quotes)) ? a.quotes : [];
        setAtlasQuotes(qs);
      }).catch(() => { if (alive) setAtlasQuotes([]); });
    };
    reload();
    const onAtlasUpdate = (e) => {
      if (e && e.detail && e.detail.rel && e.detail.rel !== rel) return;
      reload();
    };
    window.addEventListener('hypha:atlas-updated', onAtlasUpdate);
    return () => { alive = false; window.removeEventListener('hypha:atlas-updated', onAtlasUpdate); };
  }, [rel]);

  // Phase 2.6 — bubble recall: ConceptAtlas dispatches hypha:bubble-recall
  // when user hovers a quote card. We find the matching ChatBubble by
  // data-msg-idx, scroll-into-view + apply temporary halo class. Counterpart
  // to 2.2 underline-click → quote-card glow (bidirectional reading).
  React.useEffect(() => {
    let lastEl = null;
    const onRecall = (e) => {
      const idx = e && e.detail && e.detail.msgIdx;
      if (typeof idx !== 'number') return;
      const el = document.querySelector(`[data-msg-idx="${idx}"]`);
      if (!el) return;
      if (lastEl && lastEl !== el) lastEl.classList.remove('hypha-bubble-recall');
      el.classList.add('hypha-bubble-recall');
      try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
      lastEl = el;
    };
    const onClear = (e) => {
      const idx = e && e.detail && e.detail.msgIdx;
      if (typeof idx !== 'number') return;
      const el = document.querySelector(`[data-msg-idx="${idx}"]`);
      if (el) el.classList.remove('hypha-bubble-recall');
      if (lastEl === el) lastEl = null;
    };
    window.addEventListener('hypha:bubble-recall', onRecall);
    window.addEventListener('hypha:bubble-recall-clear', onClear);
    return () => {
      window.removeEventListener('hypha:bubble-recall', onRecall);
      window.removeEventListener('hypha:bubble-recall-clear', onClear);
      if (lastEl) lastEl.classList.remove('hypha-bubble-recall');
    };
  }, []);

  // Resolve current curriculum's persona + tutor display profile on mount.
  // Tutor displayName precedence:
  //   per-curriculum agent.json.displayName > global profile.tutorName
  //   > persona.label > 'tutor'.
  // Re-runs when userProfile.tutorName changes (user edits in colophon),
  // so the chat updates without app restart.
  React.useEffect(() => {
    if (!rel || !window.ptor || !window.ptor.hypha || !window.ptor.hypha.agentGet || !window.ptor.hypha.personas) return;
    const slug = rel.split(/[\\/]/)[0];
    Promise.all([window.ptor.hypha.agentGet(slug), window.ptor.hypha.personas()])
      .then(([profile, list]) => {
        const id = (profile && profile.persona) || 'socratic';
        const p = (list || []).find(x => x.id === id);
        const personaLabel = p ? p.label : id;
        setTutorLabel(personaLabel);
        const perCurriculum = profile && typeof profile.displayName === 'string' ? profile.displayName.trim() : '';
        const globalTutor = (userProfile && userProfile.tutorName) || '';
        setTutorProfile({
          displayName: perCurriculum || globalTutor || personaLabel,
          avatar: (profile && profile.avatar) || null,
        });
      }).catch(() => {});
  }, [rel, userProfile.tutorName]);

  // Load user profile (vault/data/profile.json) + refresh on cross-app updates
  // so the chat avatars stay current after the user edits their profile.
  React.useEffect(() => {
    if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.profileGet) return;
    let alive = true;
    const load = () => {
      window.ptor.hypha.profileGet().then(p => {
        if (alive && p) setUserProfile({
          name: p.name || '',
          avatar: p.avatar || null,
          tutorName: p.tutorName || '',
        });
      }).catch(() => {});
    };
    load();
    const onUpdate = () => load();
    window.addEventListener('hypha:profile-updated', onUpdate);
    return () => { alive = false; window.removeEventListener('hypha:profile-updated', onUpdate); };
  }, []);

  const lessonTitle = (meta && meta.frontmatter && meta.frontmatter.title)
    || (rel ? rel.split(/[\\/]/).pop().replace(/\.md$/i, '').replace(/^\d+-/, '') : '');
  const learnGoal = (meta && meta.frontmatter && String(meta.frontmatter.learn_goal || '').replace(/^"|"$/g, '')) || '';

  // G9 — per-lesson re-harvest visibility. TEAM B emits
  // 'lesson:reharvest-complete' via window.ptor.hypha.onLessonReharvestComplete.
  // When a payload arrives that matches this rel, surface a quiet italic banner
  // for ~5s. Tolerates missing preload export (TEAM B may not have shipped yet).
  const [reharvestBanner, setReharvestBanner] = React.useState(null); // null | { freshCount, channels }
  React.useEffect(() => {
    if (!window.ptor || !window.ptor.hypha
      || typeof window.ptor.hypha.onLessonReharvestComplete !== 'function') {
      return; // graceful no-op
    }
    let timer = null;
    const off = window.ptor.hypha.onLessonReharvestComplete((payload) => {
      if (!payload || !payload.rel) return;
      if (payload.rel !== rel) return; // only show for the currently-open lesson
      setReharvestBanner({
        freshCount: Number(payload.freshCount) || 0,
        channels: payload.channels || { tavily: 0, citation: 0 },
      });
      clearTimeout(timer);
      timer = setTimeout(() => setReharvestBanner(null), 5000);
    });
    return () => {
      clearTimeout(timer);
      if (typeof off === 'function') off();
    };
  }, [rel]);

  // Reset on rel change.
  React.useEffect(() => {
    setMessages([]);
    setInput('');
    setStreaming(false);
    setFinishStatus(null);
    setSessionFile(sourceSessionFile || null);
    setSessionMode(sourceSessionFile ? 'continuation' : 'fresh');
    setHistoryOpen(false);
    setSessions([]);
    beganRef.current = false;
  }, [rel, sourceSessionFile]);

  // Load session list lazily — only when user opens the history panel.
  // Refreshes each open so a session that just finished streaming shows up.
  const loadSessions = React.useCallback(async () => {
    if (!rel || !window.ptor || !window.ptor.llm || !window.ptor.llm.lessonSessions) return;
    setSessionsLoading(true);
    try {
      const list = await window.ptor.llm.lessonSessions(rel);
      setSessions(Array.isArray(list) ? list : []);
    } catch (_) {
      setSessions([]);
    } finally {
      setSessionsLoading(false);
    }
  }, [rel]);

  // Switch the chat view to a past session. Loads its turns into messages and
  // adopts its file as the active sessionFile so further turns append to it.
  const openSession = React.useCallback(async (file) => {
    if (!rel || !file || !window.ptor || !window.ptor.llm || !window.ptor.llm.lessonTranscript) return;
    if (streaming) return;     // don't switch mid-stream
    try {
      const r = await window.ptor.llm.lessonTranscript(rel, file);
      if (!r || !r.ok) return;
      const turns = (r.turns || [])
        .filter(t => t.role === 'user' || t.role === 'tutor')
        .map(t => ({ role: t.role, text: t.text }));
      setMessages(turns);
      setSessionFile(file);
      beganRef.current = true;   // existing session — don't auto-fire __begin__
      setHistoryOpen(false);
    } catch (_) {}
  }, [rel, streaming]);

  // Resume existing session if available — query lesson.sessions on mount.
  // If a non-finished session exists for this rel, load its turns + adopt its file.
  // (Continuation flow already passes sourceSessionFile pre-seeded with prior turns.)
  React.useEffect(() => {
    if (!rel || !window.ptor || !window.ptor.llm || !window.ptor.llm.lessonSessions) return;
    if (sourceSessionFile) {
      // Continuation — load the seeded sessionFile's turns
      window.ptor.llm.lessonTranscript(rel, sourceSessionFile).then(r => {
        if (!r || !r.ok) return;
        const turns = (r.turns || [])
          .filter(t => t.role === 'user' || t.role === 'tutor')
          .map(t => ({ role: t.role, text: t.text }));
        if (turns.length > 0) setMessages(turns);
        beganRef.current = turns.length > 0; // skip auto __begin__ if seeded
      }).catch(() => {});
      return;
    }
    // Fresh (or resume): list sessions; if any, pick latest.
    window.ptor.llm.lessonSessions(rel).then(sessions => {
      if (!Array.isArray(sessions) || sessions.length === 0) return;
      const latest = sessions[0]; // already sorted newest first by main.js
      setSessionFile(latest.file);
      setSessionMode(latest.mode || 'fresh');
      window.ptor.llm.lessonTranscript(rel, latest.file).then(r => {
        if (!r || !r.ok) return;
        const turns = (r.turns || [])
          .filter(t => t.role === 'user' || t.role === 'tutor')
          .map(t => ({ role: t.role, text: t.text }));
        if (turns.length > 0) {
          setMessages(turns);
          beganRef.current = true; // resumed — don't auto __begin__
        }
      }).catch(() => {});
    }).catch(() => {});
  }, [rel, sourceSessionFile]);

  // Subscribe to chunk stream — tutor reply appends to last message.
  React.useEffect(() => {
    if (!window.ptor || !window.ptor.llm || !window.ptor.llm.onDeepenProgress) return;
    return window.ptor.llm.onDeepenProgress((p) => {
      if (!p || p.requestId !== requestIdRef.current) return;
      if (p.stage !== 'lesson') return;
      if (p.status === 'chunk' && p.text) {
        setMessages(ms => {
          const next = ms.slice();
          const last = next[next.length - 1];
          if (last && last.role === 'tutor') {
            next[next.length - 1] = { ...last, text: (last.text || '') + p.text };
          }
          return next;
        });
      } else if (p.status === 'done') {
        setStreaming(false);
        requestIdRef.current = null;
        // Concept Atlas Phase A.1: feed completed tutor turn into atlas
        // extractor. Fire-and-forget; atlas:append-turn is async + the UI
        // doesn't block on it. ConceptAtlas component listens for the event.
        setMessages(ms => {
          const lastTutor = ms[ms.length - 1];
          if (lastTutor && lastTutor.role === 'tutor' && lastTutor.text && rel
              && window.ptor && window.ptor.hypha && window.ptor.hypha.atlasAppendTurn) {
            window.ptor.hypha.atlasAppendTurn(rel, 'tutor', lastTutor.text)
              .then(() => { try { window.dispatchEvent(new CustomEvent('hypha:atlas-updated', { detail: { rel } })); } catch (_) {} })
              .catch(() => {});
          }
          return ms;
        });
        // Refocus the input so user can keep typing without click.
        setTimeout(() => { try { inputRef.current && inputRef.current.focus(); } catch (_) {} }, 60);
      } else if (p.status === 'aborted') {
        setStreaming(false);
        // Stop button was clicked. Append a faint italic "(stopped)" suffix
        // to whatever text already streamed, marking the partial state.
        setMessages(ms => {
          const next = ms.slice();
          const last = next[next.length - 1];
          if (last && last.role === 'tutor') {
            const existing = last.text || '';
            const sep = existing && !existing.endsWith('\n') ? ' ' : '';
            next[next.length - 1] = { ...last, text: existing + sep + '*(stopped)*' };
          }
          return next;
        });
        requestIdRef.current = null;
        setTimeout(() => { try { inputRef.current && inputRef.current.focus(); } catch (_) {} }, 60);
      } else if (p.status === 'error') {
        setStreaming(false);
        // Surface the actual error from main.js so user (and we) see what failed.
        // Generic "connection failed" hid the real cause (e.g. GLM streaming SSE
        // mismatch, thinking-mode delta routing, model not found, etc.).
        const errMsg = p.error || 'unknown error';
        try { console.error('[LessonChat] lesson stream error:', p); } catch (_) {}
        setMessages(ms => {
          const next = ms.slice();
          const last = next[next.length - 1];
          if (last && last.role === 'tutor' && !last.text) {
            next[next.length - 1] = { ...last, text: '[error: ' + errMsg + ']', error: true };
          }
          return next;
        });
        requestIdRef.current = null;
      }
    });
  }, []);

  function handleStop() {
    if (!streaming || !requestIdRef.current) return;
    if (window.ptor && window.ptor.llm && window.ptor.llm.lessonAbort) {
      window.ptor.llm.lessonAbort(requestIdRef.current).catch(() => {});
    }
  }

  // Auto-scroll to bottom on every message change.
  React.useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages.length, streaming]);

  // Load autoBegin from settings on each rel change. Default ON (preserves
  // historical behavior). null while loading prevents the auto-begin effect
  // from firing prematurely.
  React.useEffect(() => {
    if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.settingsGet) {
      setAutoBegin(true);
      return;
    }
    window.ptor.hypha.settingsGet().then(s => {
      const v = !s || !s.app || s.app.autoBeginLesson !== false;
      setAutoBegin(v);
    }).catch(() => setAutoBegin(true));
  }, [rel]);

  // Auto-begin: on first mount with this rel, fire __begin__ so tutor opens
  // with first question. Gated on autoBegin === true; null (loading) and
  // false (manual mode) both skip — manual mode shows a "begin lesson"
  // button in the messages area instead.
  React.useEffect(() => {
    if (autoBegin !== true) return;
    if (beganRef.current) return;
    if (!rel || !meta) return;
    if (!window.ptor || !window.ptor.llm || !window.ptor.llm.lesson) return;
    beganRef.current = true;
    sendTurn('__begin__');
    // eslint-disable-next-line
  }, [rel, meta, autoBegin]);

  function sendTurn(userMsg) {
    const reqId = 'lsn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    requestIdRef.current = reqId;
    setStreaming(true);
    setMessages(ms => {
      const next = ms.slice();
      if (userMsg !== '__begin__') next.push({ role: 'user', text: userMsg });
      next.push({ role: 'tutor', text: '' });
      return next;
    });
    // Concept Atlas Phase A.1: feed user turn to atlas extractor (fire-and-forget).
    // __begin__ is a marker, not real user content — skip it.
    if (userMsg && userMsg !== '__begin__' && rel
        && window.ptor && window.ptor.hypha && window.ptor.hypha.atlasAppendTurn) {
      window.ptor.hypha.atlasAppendTurn(rel, 'user', userMsg)
        .then(() => { try { window.dispatchEvent(new CustomEvent('hypha:atlas-updated', { detail: { rel } })); } catch (_) {} })
        .catch(() => {});
    }
    window.ptor.llm.lesson({
      noteRel: rel,
      userMsg,
      requestId: reqId,
      sessionFile: sessionFile || undefined,
    }).then(r => {
      if (r && r.sessionFile && !sessionFile) setSessionFile(r.sessionFile);
    }).catch(err => {
      setStreaming(false);
      setMessages(ms => {
        const next = ms.slice();
        const last = next[next.length - 1];
        if (last && last.role === 'tutor') {
          next[next.length - 1] = { ...last, text: '[error: ' + (err && err.message || err) + ']', error: true };
        }
        return next;
      });
    });
  }

  function handleSend() {
    const t = (input || '').trim();
    if (!t || streaming) return;
    // 2026-05-03 v0145 — if a selection is anchored to this composer,
    // prepend it as a markdown blockquote so the tutor receives "user
    // is asking about THIS specific passage". The selection is part of
    // the user message (visible in chat history) — no separate channel.
    let payload = t;
    if (quotedSelection && quotedSelection.text) {
      const quoteLines = quotedSelection.text
        .split('\n')
        .map(l => '> ' + l)
        .join('\n');
      payload = `${quoteLines}\n\n${t}`;
    }
    setInput('');
    setQuotedSelection(null);
    sendTurn(payload);
  }

  async function handleFinish() {
    if (!window.ptor || !window.ptor.hypha || finishStatus === 'distilling') return;
    setFinishStatus('distilling');
    try {
      const r = await window.ptor.hypha.finish(rel, '', {
        sessionFile: sessionFile || undefined,
        mode: sessionMode,
      });
      if (r && r.ok) {
        setFinishStatus('done');
        // 2026-05-03 — broadcast finish so HandscrollNav rail/footer + RECALL
        // refresh their vault:list cache. Without this, the next-lesson lock
        // state stays stale (file is unlocked but rail still shows lock).
        try { window.dispatchEvent(new CustomEvent('hypha:lesson-finished', { detail: { rel } })); } catch (_) {}
        if (typeof onDistilled === 'function') onDistilled();
        // Phase 3.1 — fire-and-forget settled-signal goal adaptation. Reads
        // this lesson's atlas + rewrites next 1-3 locked lessons' learn_goal.
        // Only fires on fresh mode (continuation = revisit, no DAG impact).
        // 2026-05-03 — call lessonsAdapt regardless of sessionMode. Previously
        // gated to 'fresh' only on the assumption that continuation = pure
        // revisit. But: when fresh-finish times out partway, NoteView auto-
        // switches to continuation; subsequent finishes never materialize the
        // next ghost lesson. Net result: user stuck with N-pending stubs
        // forever. lessonsAdapt is idempotent (skips non-ghost lessons + skips
        // unlocked lessons for goal rewrite), so calling on continuation is
        // safe and recovers from the prior-timeout path.
        // 2026-05-03 — defer lessonsAdapt by 2s. Without this, the heavy LLM
        // call (proposeNextLesson + per-lesson reharvest, 30-90s of claude-cli
        // child-process orchestration) starts immediately after finish IPC
        // returns, while the rail/RECALL/note are also calling vault.list
        // concurrently. Result: main process IPC queue saturates, every
        // subsequent renderer click queues behind = "整体卡顿点击无反应".
        // 2s gap lets vault refreshes complete + UI settle before background
        // LLM begins. Also dispatch start/end events so a banner can render.
        if (window.ptor.hypha.lessonsAdapt) {
          try { window.dispatchEvent(new CustomEvent('hypha:lessons-adapt-started', { detail: { rel } })); } catch (_) {}
          setTimeout(() => {
            window.ptor.hypha.lessonsAdapt(rel)
              .then(res => {
                if (res && res.ok && res.adaptedCount > 0) {
                  try { window.dispatchEvent(new CustomEvent('hypha:lessons-adapted', { detail: res })); } catch (_) {}
                }
                const slug = rel ? rel.split(/[\\/]/)[0] : '';
                if (slug && window.ptor.hypha.adaptationsWeeklySummary) {
                  window.ptor.hypha.adaptationsWeeklySummary(slug)
                    .then(s => { if (s && s.ok && s.count > 0) setWeeklySummary(s); })
                    .catch(() => {});
                }
              })
              .catch(() => {/* silent — adapt is best-effort */})
              .finally(() => {
                try { window.dispatchEvent(new CustomEvent('hypha:lessons-adapt-done', { detail: { rel } })); } catch (_) {}
              });
          }, 2000);
        }
      } else {
        setFinishStatus('error');
      }
    } catch (_) { setFinishStatus('error'); }
  }

  return (
    <div style={{
      flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column',
      fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
      color: 'var(--ink-primary)',
    }}>
      {/* Header — lesson title + learn goal + persona indicator + finish button */}
      <header style={{
        padding: '24px 48px 18px',
        borderBottom: '1px solid color-mix(in srgb, var(--brass-mid) 14%, transparent)',
        display: 'flex', alignItems: 'flex-start', gap: 16,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* 2026-05-02 长卷 redesign — chain-level controls (tutor / language)
              previously lived behind right-click on sidebar folders. With the
              tree gone, surface them here as inline buttons in the lesson
              header. Both dispatch events that VaultTree (mounted offscreen)
              still listens for and opens the corresponding modal. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 6, flexWrap: 'wrap' }}>
            {tutorLabel && (
              <button
                onClick={() => {
                  const slug = rel ? rel.split(/[\\/]/)[0] : '';
                  if (slug) window.dispatchEvent(new CustomEvent('hypha:open-tutor-customize', { detail: { slug } }));
                }}
                title="customize this curriculum's tutor"
                style={{
                  background: 'transparent', border: 'none', padding: 0,
                  cursor: 'pointer',
                  fontStyle: 'italic', fontSize: 11.5,
                  letterSpacing: '0.16em', textTransform: 'uppercase',
                  color: 'var(--brass-bright)',
                  transition: 'color 220ms cubic-bezier(0.22, 1, 0.36, 1)',
                  display: 'inline-block',
                  fontFamily: 'inherit',
                }}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--ink-title)'; }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--brass-bright)'; }}
              >· tutor: {tutorLabel}</button>
            )}
            <button
              onClick={() => {
                const slug = rel ? rel.split(/[\\/]/)[0] : '';
                if (slug) window.dispatchEvent(new CustomEvent('hypha:open-language', { detail: { slug } }));
              }}
              title="set the language this curriculum's tutor responds in"
              style={{
                background: 'transparent', border: 'none', padding: 0,
                cursor: 'pointer',
                fontStyle: 'italic', fontSize: 11.5,
                letterSpacing: '0.16em', textTransform: 'uppercase',
                color: 'var(--brass-bright)',
                transition: 'color 220ms cubic-bezier(0.22, 1, 0.36, 1)',
                display: 'inline-block',
                fontFamily: 'inherit',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--ink-title)'; }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--brass-bright)'; }}
            >· language</button>
          </div>
          <h2 style={{
            fontStyle: 'normal', fontWeight: 400, fontSize: 22, lineHeight: 1.25,
            color: 'var(--ink-title)', margin: '0 0 6px',
            letterSpacing: '-0.005em',
          }}>{lessonTitle}</h2>
          {learnGoal && (
            <p style={{
              fontStyle: 'italic', fontWeight: 400, fontSize: 14.5, lineHeight: 1.5,
              color: 'var(--ink-muted)', margin: 0,
              maxWidth: 720,
            }}>{learnGoal}</p>
          )}
          {/* G9 — re-harvest banner. Italic Garamond, ink-faint, no chrome.
              Only visible for ~5s after TEAM B fires lesson:reharvest-complete
              for this rel. Reuses the inherited font stack from <header>. */}
          {reharvestBanner && (
            <p style={{
              marginTop: 8, marginBottom: 0,
              fontStyle: 'italic', fontWeight: 400,
              fontSize: 13, lineHeight: 1.5,
              color: 'var(--ink-faint)',
              maxWidth: 720,
              animation: 'hypha-reharvest-fade 360ms cubic-bezier(0.22, 1, 0.36, 1) both',
            }}>
              freshly gathered: {reharvestBanner.freshCount} new source{reharvestBanner.freshCount === 1 ? '' : 's'} for this lesson · {reharvestBanner.channels.tavily || 0} from web · {reharvestBanner.channels.citation || 0} from citation graph
              <style>{`
                @keyframes hypha-reharvest-fade {
                  from { opacity: 0; transform: translateY(-3px); }
                  to   { opacity: 1; transform: translateY(0); }
                }
              `}</style>
            </p>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
          <button
            onClick={handleFinish}
            disabled={messages.length < 2 || finishStatus === 'distilling'}
            style={{
              background: 'transparent',
              border: '1px solid color-mix(in srgb, var(--brass-mid) 32%, transparent)',
              borderRadius: '14px 10px 14px 10px',
              color: finishStatus === 'distilling' ? 'var(--ink-faint)' : 'var(--ink-muted)',
              fontFamily: 'inherit', fontStyle: 'italic',
              fontSize: 14, padding: '7px 16px',
              cursor: (messages.length < 2 || finishStatus === 'distilling') ? 'not-allowed' : 'pointer',
              opacity: (messages.length < 2 || finishStatus === 'distilling') ? 0.5 : 1,
              whiteSpace: 'nowrap',
              transition: 'all 220ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
            onMouseEnter={e => { if (messages.length >= 2 && finishStatus !== 'distilling') { e.currentTarget.style.borderColor = 'var(--brass-bright)'; e.currentTarget.style.color = 'var(--ink-title)'; } }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--brass-mid) 32%, transparent)'; e.currentTarget.style.color = 'var(--ink-muted)'; }}
          >
            {finishStatus === 'distilling' ? 'distilling…' :
             finishStatus === 'done' ? 'distilled · switch to recall' :
             finishStatus === 'error' ? 'try again' :
             'finish lesson'}
          </button>
          {/* 2026-05-03 — "正在生成下一节" indicator. Renders only when the
              deferred lessonsAdapt LLM call is in flight (60-90s background).
              Quiet italic Garamond, no spinner — calm-tech. */}
          {adaptingNext && (
            <p style={{
              maxWidth: 280, margin: '4px 0 0',
              fontFamily: 'inherit', fontStyle: 'italic',
              fontSize: 12.5, lineHeight: 1.5,
              color: 'var(--ink-faint)',
              textAlign: 'right',
            }}>
              正在生成下一节…
            </p>
          )}
          {/* Phase 3.4 — weekly adaptation notice. Quiet italic Garamond
              paragraph that appears only after finish + adapt resolves with
              count > 0. Phrasing reflects tier mix: "deepened" (DEEP),
              "regrounded" (BASIC). Right-aligned, no chrome. */}
          {weeklySummary && weeklySummary.count > 0 && (
            <p style={{
              maxWidth: 280, margin: '4px 0 0',
              fontStyle: 'italic', fontSize: 12.5, lineHeight: '18px',
              textAlign: 'right',
              color: 'var(--ink-muted)',
              animation: 'hypha-weekly-fade-in 600ms cubic-bezier(0.22, 1, 0.36, 1) both',
            }}>
              this week the curriculum was retuned{' '}
              <span style={{ fontStyle: 'normal', color: 'var(--brass-bright)', fontVariantNumeric: 'tabular-nums' }}>{weeklySummary.count}</span>
              {' '}{weeklySummary.count === 1 ? 'time' : 'times'}
              {(() => {
                const t = weeklySummary.tiers || {};
                const parts = [];
                if (t.DEEP) parts.push(`${t.DEEP} deeper`);
                if (t.BASIC) parts.push(`${t.BASIC} regrounded`);
                if (parts.length === 0) return '.';
                return ` — ${parts.join(', ')}.`;
              })()}
              <style>{`@keyframes hypha-weekly-fade-in {
                from { opacity: 0; transform: translateY(-3px); }
                to   { opacity: 1; transform: translateY(0); }
              }`}</style>
            </p>
          )}
          {/* history — open a panel listing past sessions for this lesson; click
              a row to load its transcript + adopt its session file. Visually
              quieter than finish lesson (no border at rest) so it doesn't
              compete with the primary action. */}
          <button
            onClick={() => {
              const next = !historyOpen;
              setHistoryOpen(next);
              if (next) loadSessions();
            }}
            style={{
              background: 'transparent',
              border: '1px solid transparent',
              borderRadius: '10px 14px 10px 14px',
              color: historyOpen ? 'var(--ink-title)' : 'var(--ink-faint)',
              fontFamily: 'inherit', fontStyle: 'italic',
              fontSize: 13, padding: '5px 14px',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              transition: 'all 220ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--brass-mid) 24%, transparent)'; e.currentTarget.style.color = 'var(--ink-title)'; }}
            onMouseLeave={e => { if (!historyOpen) { e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.color = 'var(--ink-faint)'; } }}
            title="past sessions for this lesson"
          >
            {historyOpen ? 'close history' : 'history'}
          </button>
        </div>
      </header>

      {historyOpen && (
        <div style={{
          padding: '14px 48px 18px',
          borderBottom: '1px solid color-mix(in srgb, var(--brass-mid) 14%, transparent)',
          background: 'color-mix(in srgb, var(--brass-mid) 4%, transparent)',
        }}>
          <div style={{
            fontStyle: 'italic', fontSize: 11, letterSpacing: '0.12em',
            textTransform: 'uppercase', color: 'var(--ink-faint)',
            marginBottom: 10,
          }}>
            past sessions {sessions.length > 0 && `· ${sessions.length}`}
          </div>
          {sessionsLoading ? (
            <div style={{ fontStyle: 'italic', fontSize: 13, color: 'var(--ink-faint)' }}>loading…</div>
          ) : sessions.length === 0 ? (
            <div style={{ fontStyle: 'italic', fontSize: 13, color: 'var(--ink-faint)' }}>no earlier sessions for this lesson yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {sessions.map((s) => {
                const isCurrent = s.file === sessionFile;
                const dt = s.startISO ? new Date(s.startISO) : null;
                const when = dt && !isNaN(dt.getTime())
                  ? dt.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                  : (s.file || '');
                return (
                  <button
                    key={s.file}
                    onClick={() => openSession(s.file)}
                    disabled={streaming || isCurrent}
                    style={{
                      textAlign: 'left',
                      background: isCurrent ? 'color-mix(in srgb, var(--brass-mid) 10%, transparent)' : 'transparent',
                      border: '1px solid color-mix(in srgb, var(--brass-mid) ' + (isCurrent ? '36%' : '18%') + ', transparent)',
                      borderRadius: 8,
                      padding: '8px 12px',
                      cursor: (streaming || isCurrent) ? 'default' : 'pointer',
                      fontFamily: 'inherit', color: 'var(--ink-primary)',
                      transition: 'all 180ms cubic-bezier(0.22, 1, 0.36, 1)',
                      display: 'flex', flexDirection: 'column', gap: 4,
                    }}
                    onMouseEnter={e => { if (!streaming && !isCurrent) { e.currentTarget.style.borderColor = 'var(--brass-bright)'; } }}
                    onMouseLeave={e => { if (!streaming && !isCurrent) { e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--brass-mid) 18%, transparent)'; } }}
                  >
                    <div style={{
                      display: 'flex', alignItems: 'baseline', gap: 10,
                      fontStyle: 'italic', fontSize: 12,
                      color: 'var(--ink-muted)',
                    }}>
                      <span>{when}</span>
                      <span style={{ opacity: 0.5 }}>·</span>
                      <span>{s.turnCount || 0} turn{(s.turnCount || 0) === 1 ? '' : 's'}</span>
                      {s.mode === 'continuation' && (
                        <>
                          <span style={{ opacity: 0.5 }}>·</span>
                          <span style={{ color: 'var(--brass-bright)' }}>continuation</span>
                        </>
                      )}
                      {isCurrent && (
                        <span style={{ marginLeft: 'auto', color: 'var(--brass-bright)', fontStyle: 'italic' }}>current</span>
                      )}
                    </div>
                    {s.firstQuestion && (
                      <div style={{
                        fontSize: 13.5, lineHeight: 1.45,
                        color: 'var(--ink-primary)',
                        overflow: 'hidden', textOverflow: 'ellipsis',
                        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                      }}>{s.firstQuestion}</div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Messages — full-height scrollable column, max-width 720 center-aligned */}
      <div style={{
        flex: 1, minHeight: 0, overflowY: 'auto',
        padding: '24px 0 8px',
      }}>
        <div style={{
          maxWidth: 720, margin: '0 auto', padding: '0 32px',
          display: 'flex', flexDirection: 'column', gap: 28,
        }}>
          {messages.length === 0 && streaming && (
            <div style={{
              fontStyle: 'italic', fontSize: 14, color: 'var(--ink-faint)',
              padding: '12px 0',
            }}>thinking…</div>
          )}
          {messages.length === 0 && !streaming && autoBegin === false && (
            <div style={{
              padding: '40px 0', display: 'flex', justifyContent: 'center',
            }}>
              <button
                onClick={() => { beganRef.current = true; sendTurn('__begin__'); }}
                style={{
                  background: 'transparent',
                  border: '1px solid color-mix(in srgb, var(--brass-mid) 40%, transparent)',
                  borderRadius: '18px 14px 18px 14px',
                  color: 'var(--ink-title)',
                  fontFamily: 'inherit', fontStyle: 'italic',
                  fontSize: 16, padding: '10px 24px',
                  cursor: 'pointer',
                  letterSpacing: '0.02em',
                  transition: 'all 220ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--brass-bright)'; e.currentTarget.style.background = 'color-mix(in srgb, var(--brass-bright) 8%, transparent)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--brass-mid) 40%, transparent)'; e.currentTarget.style.background = 'transparent'; }}
              >begin lesson</button>
            </div>
          )}
          {messages.map((m, i) => (
            <ChatBubble key={i} role={m.role} text={m.text} streaming={streaming && i === messages.length - 1 && m.role === 'tutor'} error={m.error} userProfile={userProfile} tutorProfile={tutorProfile} msgIdx={i} quotedRanges={atlasQuotes.filter(q => q.msg_idx === i)} noteRel={rel} />
          ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Composer — Inkstone Well (LUNG+MUSE council 2026-04-30).
          Recessed trough (no outer border, pure inset shadow) with a 28px
          circular reservoir well to the right. Well fills with ink as the
          user types (background-size 0→100% by length/80). Click well = send.
          MUSE invariants enforced: typed glyphs are 100% opacity crisp Garamond,
          no per-keystroke JS animation (CSS-only background-size handles fill),
          caret zone has no ambient effect, focus ring is explicit.

          v0145 — selection-anchored quote preview rendered ABOVE the well
          when user has selected text in a tutor bubble or rendered note. */}
      <div style={{
        padding: '16px 32px 24px',
        borderTop: '1px solid color-mix(in srgb, var(--brass-mid) 14%, transparent)',
      }}>
        {quotedSelection && (
          <div style={{
            maxWidth: 720, margin: '0 auto 8px',
            display: 'flex', gap: 10, alignItems: 'flex-start',
            padding: '8px 14px 8px 14px',
            borderLeft: '2px solid color-mix(in srgb, var(--brass-mid) 38%, transparent)',
            background: 'color-mix(in srgb, var(--brass-mid) 4%, transparent)',
            fontFamily: 'inherit',
            fontSize: 13,
            lineHeight: 1.55,
            color: 'var(--ink-faint)',
          }}>
            <span style={{ flex: 1, fontStyle: 'italic' }}>
              {quotedSelection.text.length > 160
                ? quotedSelection.text.slice(0, 160) + '…'
                : quotedSelection.text}
            </span>
            <button
              onClick={() => setQuotedSelection(null)}
              aria-label="detach quote"
              title="detach (Esc)"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--ink-faint)',
                fontFamily: 'inherit',
                fontSize: 13,
                fontStyle: 'normal',
                letterSpacing: '0.04em',
                cursor: 'pointer',
                padding: '0 4px',
                lineHeight: 1.55,
              }}
            >×</button>
          </div>
        )}
        <div style={{
          maxWidth: 720, margin: '0 auto',
          display: 'flex', gap: 12, alignItems: 'flex-end',
          background: 'color-mix(in srgb, var(--brass-mid) 6%, transparent)',
          borderRadius: '20px 16px 20px 16px',
          padding: '12px 14px 12px 22px',
          boxShadow: [
            'inset 0 2px 4px color-mix(in srgb, var(--ink-title) 14%, transparent)',
            'inset 0 -1px 0 color-mix(in srgb, var(--brass-bright) 18%, transparent)',
            'inset 0 0 0 0.5px color-mix(in srgb, var(--brass-mid) 22%, transparent)',
          ].join(', '),
        }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
            }}
            placeholder={
              streaming
                ? 'tutor is replying…'
                : quotedSelection
                  ? 'ask about this —'
                  : 'your answer…'
            }
            rows={1}
            disabled={streaming}
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              color: 'var(--ink-title)',
              fontFamily: 'inherit', fontStyle: 'normal', fontSize: 16,
              lineHeight: 1.5,
              padding: '6px 0',
              outline: 'none',
              resize: 'none',
              minHeight: 24, maxHeight: 160,
            }}
          />
          {/* Reservoir well — fills with ink as you type. Click to send.
              When streaming → transforms into stop button (square inset, dim brass).
              When fill caps at 80 chars → meniscus-breath: brass surface convex
              bulges + breathes via slow scale cycle (筆洗 register, continuous
              motion past static cap). */}
          <button
            onClick={streaming ? handleStop : handleSend}
            disabled={!streaming && !input.trim()}
            aria-label={streaming ? 'stop tutor' : 'Send (or press Enter)'}
            title={streaming ? 'stop' : 'send'}
            style={{
              position: 'relative',
              flexShrink: 0,
              width: 28, height: 28,
              borderRadius: '50%',
              border: '1px solid ' + (streaming
                ? 'color-mix(in srgb, var(--brass-mid) 60%, transparent)'
                : input.trim()
                  ? 'var(--brass-bright)'
                  : 'color-mix(in srgb, var(--brass-mid) 36%, transparent)'),
              padding: 0,
              backgroundColor: 'color-mix(in srgb, var(--brass-mid) 4%, transparent)',
              backgroundImage: streaming
                ? 'none'
                : `radial-gradient(circle at center, var(--ink-title) 0%, color-mix(in srgb, var(--ink-title) 88%, var(--brass-bright)) 100%)`,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'center bottom',
              backgroundSize: streaming
                ? '0% 0%'
                : `100% ${Math.min(1, input.length / 80) * 100}%`,
              boxShadow: streaming
                ? 'inset 0 1px 2px color-mix(in srgb, var(--ink-title) 18%, transparent), 0 0 0 2px color-mix(in srgb, var(--brass-mid) 14%, transparent)'
                : input.trim()
                  ? 'inset 0 1px 2px color-mix(in srgb, var(--ink-title) 22%, transparent), 0 0 0 2px color-mix(in srgb, var(--brass-bright) 12%, transparent)'
                  : 'inset 0 1px 2px color-mix(in srgb, var(--ink-title) 14%, transparent)',
              cursor: streaming ? 'pointer' : (input.trim() ? 'pointer' : 'not-allowed'),
              transition: 'background-size 180ms ease-out, box-shadow 180ms ease-out, border-color 180ms ease-out',
              alignSelf: 'flex-end',
              marginBottom: 4,
            }}
          >
            {streaming && (
              /* Stop glyph — small filled square inset, dim brass.
                 Tap-target = whole 28px button. */
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute', left: '50%', top: '50%',
                  transform: 'translate(-50%, -50%)',
                  width: 9, height: 9, borderRadius: 1,
                  background: 'color-mix(in srgb, var(--brass-bright) 70%, var(--ink-title))',
                  boxShadow: '0 0 6px color-mix(in srgb, var(--brass-bright) 25%, transparent)',
                  pointerEvents: 'none',
                }}
              />
            )}
            {!streaming && input.length >= 80 && (
              /* Meniscus-breath overlay — brass surface convex bulge +
                 slow scale cycle once the well is full. Continues motion
                 past the static-fill cap. */
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute', inset: 0,
                  borderRadius: '50%',
                  background: `radial-gradient(circle at center 75%, color-mix(in srgb, var(--brass-bright) 38%, transparent) 0%, transparent 55%)`,
                  pointerEvents: 'none',
                  animation: 'hypha-meniscus-breath 2400ms cubic-bezier(0.4, 0, 0.6, 1) infinite',
                }}
              />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ChatBubble — Hypha Breath-Line (LUNG+MUSE+Plan council 2026-05-01 outcome).
//
// Drop bubble metaphor entirely. Both speakers share the main prose column at
// full width, identical Garamond roman register. Speaker identity encoded by
// a 2px vertical "breath-line" running down the outer-left of each turn —
// tutor full brass-bright opacity, user 35% brass-mid mix. During tutor
// streaming the spine darkens floor→full over 600ms (ink soaking into paper,
// not a progress bar). Anchor: 18C lab-journal phase-spines (Lavoisier 1789).
//
// Compounding payoff: across a long session the spine becomes a density chart
// of who spoke when — conversation rhythm surfaces visually, zero new UI.
//
// Speaker is encoded preattentively (luminance + position-of-spine), so labels
// disappear at-rest. Tutor name + actions surface only on hover.
function ChatBubble({ role, text, streaming, error, userProfile, tutorProfile, msgIdx, quotedRanges, noteRel }) {
  const isUser = role === 'user';
  const [hover, setHover] = React.useState(false);

  // 金句 drag-source: when user drags a text selection out of this bubble,
  // enrich dataTransfer with msgIdx + role so ConceptAtlas drop handler
  // can persist a structured quote (not just raw text/plain). Browser default
  // selection-drag still fires text/plain — our custom MIME is additive.
  // ≥6-char minimum filters accidental tiny drags.
  // Phase 2.1: custom drag-image — italic Garamond ghost with paper-tear
  // left edge (clip-path zigzag), brass-mid hairline spine, soft drop-shadow.
  // Replaces browser-default selection-drag preview which was visually flat.
  const handleDragStart = React.useCallback((e) => {
    if (isUser || error) return; // only tutor passages drag-tear into atlas
    let sel = '';
    try { sel = String(window.getSelection ? window.getSelection().toString() : '').trim(); } catch (_) {}
    if (!sel || sel.length < 6) return;
    try {
      e.dataTransfer.setData('text/plain', sel);
      e.dataTransfer.setData('application/hypha-quote', JSON.stringify({
        text: sel, msgIdx: typeof msgIdx === 'number' ? msgIdx : null, role,
      }));
      e.dataTransfer.effectAllowed = 'copy';

      // Build paper-tear drag preview. Mounted off-screen briefly so the
      // browser can snapshot it for the drag image, then removed next tick.
      const ghost = document.createElement('div');
      const truncated = sel.length > 240 ? sel.slice(0, 237) + '…' : sel;
      ghost.textContent = '“' + truncated + '”';
      ghost.style.cssText = [
        'position: absolute', 'top: -9999px', 'left: -9999px',
        'max-width: 280px',
        'padding: 12px 18px 12px 24px',
        'background: color-mix(in srgb, var(--bg-page, #f4ead9) 92%, transparent)',
        'color: var(--brass-bright, #c9a86a)',
        'font-family: "EB Garamond", "Noto Serif SC", Georgia, serif',
        'font-style: italic',
        'font-size: 14px',
        'line-height: 1.55',
        'border-left: 1px solid color-mix(in srgb, var(--brass-mid, #c4a890) 70%, transparent)',
        'box-shadow: 0 6px 18px rgba(0,0,0,0.22), 0 1px 0 color-mix(in srgb, var(--brass-bright, #c9a86a) 22%, transparent) inset',
        // Torn-edge polygon — irregular zigzag on left side, clean right side.
        // Numbers chosen by eye to read as hand-torn paper, not pixel artifact.
        'clip-path: polygon(' +
          '8px 0%, 100% 0%, 100% 100%, 6px 100%, ' +
          '3px 92%, 7px 80%, 2px 66%, 8px 52%, ' +
          '3px 38%, 6px 22%, 2px 10%' +
        ')',
        'pointer-events: none',
        'user-select: none',
        'letter-spacing: 0.005em',
      ].join('; ');
      document.body.appendChild(ghost);
      // Anchor: cursor at top-left of ghost (slightly inset from torn edge).
      e.dataTransfer.setDragImage(ghost, 18, 16);
      // Remove next tick — browser already snapshotted.
      setTimeout(() => { try { ghost.remove(); } catch (_) {} }, 0);
    } catch (_) {}
  }, [isUser, error, msgIdx, role]);

  const tutorName = (
    (tutorProfile && tutorProfile.displayName && String(tutorProfile.displayName).trim()) ||
    (tutorProfile && tutorProfile.name && String(tutorProfile.name).trim()) ||
    'tutor'
  );

  const spineColor = error
    ? 'var(--verdict-flag)'
    : isUser
      ? 'var(--breath-user)'
      : 'var(--breath-tutor)';

  // Tutor stream-darkening: spine starts at floor, ramps to full over 600ms.
  const tutorStreamingFloor = streaming && !error && !isUser;

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDragStart={handleDragStart}
      data-msg-idx={typeof msgIdx === 'number' ? msgIdx : undefined}
      style={{
        position: 'relative',
        width: '100%',
        paddingLeft: 'var(--chat-breath-offset, 18px)',
      }}
    >
      {/* Breath-line — outer-left spine, encodes speaker via luminance.
          Tutor while streaming = 35% opacity ramping to 100% over 600ms
          (ink soaking, not a progress bar). User = always full mix at 35%. */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 0,
          top: '0.4em',
          bottom: '0.4em',
          width: 'var(--chat-breath-width, 2px)',
          background: spineColor,
          opacity: tutorStreamingFloor ? 0.35 : 1,
          transition: 'opacity 600ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      />

      {/* Hover affordance strip — floating above prose in the inter-turn gap.
          Action labels (copy/cite/deepen) are ROMAN per italic-decoration-only
          invariant. The tutor sigil prefix is italic small-caps (decoration
          register, not an action). */}
      <div
        aria-hidden={!hover}
        style={{
          position: 'absolute',
          right: 0,
          top: -18,
          fontFamily: 'var(--chat-font-family, inherit)',
          fontStyle: 'normal',
          fontSize: 11.5,
          letterSpacing: '0.04em',
          color: 'var(--ink-faint)',
          opacity: hover ? 1 : 0,
          transition: hover
            ? 'opacity 220ms ease-out 80ms'
            : 'opacity 120ms ease-in',
          pointerEvents: hover ? 'auto' : 'none',
          whiteSpace: 'nowrap',
          userSelect: 'none',
        }}
      >
        {!isUser && (
          <span style={{
            fontStyle: 'italic',
            textTransform: 'uppercase', letterSpacing: '0.16em',
            marginRight: 14,
          }}>· {tutorName}</span>
        )}
        <span
          style={{ cursor: 'pointer' }}
          onClick={() => { try { navigator.clipboard.writeText(text); } catch(_){} }}
        >copy</span>
        {/* v0.8.5 — explicit 金句 → atlas extraction. Picks up the current
            selection (must be inside this bubble + ≥6 chars) and persists via
            quoteAdd. Drag-and-drop still works as before; this is a more
            discoverable affordance for users who don't realize they can drag.
            Tutor turns only — user turns don't earn 金句. */}
        {!isUser && !error && (
          <span
            style={{ marginLeft: 14, cursor: 'pointer' }}
            title="select text in this bubble, then click → keep as 金句 in concept atlas"
            onClick={async () => {
              if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.quoteAdd) return;
              let sel = '';
              try { sel = String(window.getSelection ? window.getSelection().toString() : '').trim(); } catch (_) {}
              if (!sel || sel.length < 6) {
                // No selection — fall back to whole bubble text (truncated to 600 chars).
                sel = (text || '').trim().slice(0, 600);
              }
              if (!sel || sel.length < 6) return;
              if (!noteRel) return;
              try {
                const r = await window.ptor.hypha.quoteAdd(noteRel, {
                  text: sel,
                  msgIdx: typeof msgIdx === 'number' ? msgIdx : null,
                  role,
                });
                if (r && r.ok) {
                  try { window.dispatchEvent(new CustomEvent('hypha:atlas-updated', { detail: { rel: noteRel } })); } catch (_) {}
                }
              } catch (_) {}
            }}
          >→ keep</span>
        )}
      </div>

      {/* Lacquer Loop W7 v1.2 — TutorInkBlot replaces the pre-stream vacuum.
          Mounts only while a tutor bubble is streaming AND no text has arrived
          yet; dissolves over 200ms when the first chunk lands. Skipped on
          error or for user turns. */}
      {!isUser && !error && window.TutorInkBlot && (
        <window.TutorInkBlot streaming={!!streaming} hasText={!!(text && text.length)} />
      )}

      {/* Prose body. While streaming, render plain pre-wrapped text + caret
          (no markdown / no math typeset — avoids per-token re-typeset jitter).
          On stream-end (or when text is final from the start), render through
          marked → DOMPurify → MathJax.typesetPromise so md and $...$/$$...$$
          become typeset. Plain-text pre-wrap fallback applies for user turns. */}
      <ChatBody
        text={text}
        streaming={streaming}
        error={error}
        isUser={isUser}
        quotedRanges={Array.isArray(quotedRanges) && !isUser ? quotedRanges : null}
      />
    </div>
  );
}

// renderTextWithUnderlines — for streaming/plain ChatBody. Splits raw text
// around matched quote substrings and emits inline <u> elements. Single match
// per quote (first occurrence wins). Unmatched quotes simply skip.
function renderTextWithUnderlines(text, quotes) {
  if (!quotes || quotes.length === 0) return text;
  let segments = [text];
  for (const q of quotes) {
    if (!q || typeof q.text !== 'string') continue;
    const target = q.text.trim();
    if (target.length < 6) continue;
    const next = [];
    let placed = false;
    for (const seg of segments) {
      if (placed || typeof seg !== 'string') { next.push(seg); continue; }
      const pos = seg.indexOf(target);
      if (pos < 0) { next.push(seg); continue; }
      if (pos > 0) next.push(seg.slice(0, pos));
      next.push(
        React.createElement('u', {
          key: q.id,
          className: 'hypha-quote-mark',
          'data-quote-id': q.id,
          onClick: (e) => {
            e.stopPropagation();
            try { window.dispatchEvent(new CustomEvent('hypha:quote-recall', { detail: { quoteId: q.id } })); } catch (_) {}
          },
        }, target)
      );
      const tail = seg.slice(pos + target.length);
      if (tail) next.push(tail);
      placed = true;
    }
    segments = next;
  }
  return segments;
}

// ChatBody — split out so the stream-end markdown+MathJax effect is local to
// each bubble (one ref per bubble; new mounts trigger their own typeset).
// Phase 2.2: accepts `quotedRanges` (quotes with this msg as origin) and
// injects persistent brass-mid hairline underlines at matching substrings.
// Markdown path: post-render DOM walk wraps matches in <u class="hypha-quote-mark">.
// Plain/streaming path: text sliced into React segments around matches.
// Phase 3.5: paced display via rAF — `displayedText` lags `text` slightly and
// drains at ~60 char/sec (adaptive up to 120 cps when backlog > 200) so
// provider-tokenizer pops become Word-like flow. Drains instantly on
// stream-end; snaps on shrink (retry / reset).
function ChatBody({ text, streaming, error, isUser, quotedRanges }) {
  const bodyRef = React.useRef(null);
  const [displayedText, setDisplayedText] = React.useState(text || '');
  const rawTextRef = React.useRef(text || '');
  const rafRef = React.useRef(0);
  const lastTickRef = React.useRef(0);
  const reducedMotionRef = React.useRef(false);
  React.useEffect(() => {
    try {
      reducedMotionRef.current = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_) { reducedMotionRef.current = false; }
  }, []);
  // Keep rawTextRef current without restarting the rAF cycle.
  React.useEffect(() => { rawTextRef.current = text || ''; }, [text]);
  // Snap on shrink (retry / __begin__): if raw text is shorter than what's
  // displayed, we lose nothing by collapsing to the new prefix.
  React.useEffect(() => {
    const raw = text || '';
    setDisplayedText(prev => (raw.length < prev.length ? raw : prev));
  }, [text]);
  // Drainer: run only while streaming. On stream-end, drain instantly so the
  // rich-render path sees the full text without trailing tail.
  React.useEffect(() => {
    if (reducedMotionRef.current || isUser || error || !streaming) {
      setDisplayedText(text || '');
      return;
    }
    let cancelled = false;
    lastTickRef.current = 0;
    const tick = (now) => {
      if (cancelled) return;
      if (!lastTickRef.current) lastTickRef.current = now;
      const dt = now - lastTickRef.current;
      lastTickRef.current = now;
      setDisplayedText(prev => {
        const raw = rawTextRef.current;
        if (raw.length < prev.length) return raw;
        if (raw.length === prev.length) return prev;
        const buffer = raw.length - prev.length;
        const cps = buffer > 200 ? 120 : 60;
        const advance = Math.max(1, Math.round((dt / 1000) * cps));
        const nextLen = Math.min(raw.length, prev.length + advance);
        return raw.slice(0, nextLen);
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [streaming, isUser, error]);
  const baseStyle = {
    fontFamily: 'var(--chat-font-family, inherit)',
    fontStyle: 'normal',
    fontSize: isUser
      ? 'var(--chat-user-size, 15px)'
      : 'var(--chat-tutor-size, 17px)',
    lineHeight: isUser
      ? 'var(--chat-user-line, 22px)'
      : 'var(--chat-tutor-line, 27px)',
    color: error
      ? 'var(--ink-title)'
      : isUser ? 'var(--ink-muted)' : 'var(--ink-title)',
    whiteSpace: 'pre-wrap',
    textWrap: 'pretty',
  };

  // Whether to render rich (markdown + math) — tutor only, post-stream, no error.
  const renderRich = !isUser && !error && !streaming && text && text.trim().length > 0;

  React.useEffect(() => {
    if (!renderRich) return;
    const el = bodyRef.current;
    if (!el) return;
    let cancelled = false;
    try {
      const md = (window.marked && window.marked.parse) ? window.marked.parse(text, { breaks: true, gfm: true }) : null;
      if (!md) { el.textContent = text; return; }
      const safe = (window.DOMPurify && window.DOMPurify.sanitize)
        ? window.DOMPurify.sanitize(md, { ADD_ATTR: ['target'] })
        : md;
      el.innerHTML = safe;
    } catch (_) {
      el.textContent = text;
      return;
    }
    // Typeset math after innerHTML settles. MathJax may still be loading;
    // in that case skip — text remains as raw $...$ but markdown is rendered.
    if (window.MathJax && window.MathJax.typesetPromise) {
      window.MathJax.typesetPromise([el]).catch(() => {/* swallow per-bubble fail */});
    }

    // Phase 2.2 — inject persistent underlines for quotedRanges. Walks text
    // nodes (skip code/pre/u), wraps first match per quote in <u>. Click
    // dispatches hypha:quote-recall so ConceptAtlas can scroll-to + glow.
    if (Array.isArray(quotedRanges) && quotedRanges.length > 0) {
      const onClick = (e) => {
        const u = e.target.closest && e.target.closest('u.hypha-quote-mark');
        if (!u) return;
        const id = u.getAttribute('data-quote-id');
        if (!id) return;
        e.stopPropagation();
        try { window.dispatchEvent(new CustomEvent('hypha:quote-recall', { detail: { quoteId: id } })); } catch (_) {}
      };
      el.addEventListener('click', onClick);
      // Defer to next frame so MathJax/innerHTML settle before walking.
      const raf = requestAnimationFrame(() => {
        if (cancelled) return;
        for (const q of quotedRanges) {
          if (!q || typeof q.text !== 'string') continue;
          const target = q.text.trim();
          if (target.length < 6) continue;
          if (el.querySelector(`u.hypha-quote-mark[data-quote-id="${q.id}"]`)) continue;
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
            acceptNode: (n) => {
              let p = n.parentNode;
              while (p && p !== el) {
                const tag = (p.tagName || '').toLowerCase();
                if (tag === 'code' || tag === 'pre' || tag === 'u' || tag === 'mjx-container') return NodeFilter.FILTER_REJECT;
                p = p.parentNode;
              }
              return n.nodeValue && n.nodeValue.indexOf(target) >= 0
                ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
            },
          });
          const node = walker.nextNode();
          if (!node) continue;
          const pos = node.nodeValue.indexOf(target);
          if (pos < 0) continue;
          const before = node.nodeValue.slice(0, pos);
          const after = node.nodeValue.slice(pos + target.length);
          const u = document.createElement('u');
          u.className = 'hypha-quote-mark';
          u.dataset.quoteId = q.id;
          u.textContent = target;
          const parent = node.parentNode;
          if (before) parent.insertBefore(document.createTextNode(before), node);
          parent.insertBefore(u, node);
          if (after) parent.insertBefore(document.createTextNode(after), node);
          parent.removeChild(node);
        }
      });
      return () => { cancelled = true; cancelAnimationFrame(raf); el.removeEventListener('click', onClick); };
    }
    return () => { cancelled = true; };
  }, [renderRich, text, quotedRanges]);

  // Streaming OR user OR error path — plain text + optional caret.
  // Phase 3.5: while streaming, render the paced `displayedText` (≤ `text`)
  // so the bubble flows like ink instead of popping at provider-chunk cadence.
  // For user/error/non-streaming, fall back to `text` so no display lag.
  if (!renderRich) {
    const visibleText = (streaming && !isUser && !error) ? displayedText : text;
    const body = (Array.isArray(quotedRanges) && quotedRanges.length > 0 && visibleText)
      ? renderTextWithUnderlines(visibleText, quotedRanges)
      : visibleText;
    return (
      <div style={baseStyle}>
        {body}
        {streaming && !error && !isUser && (
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 1,
              height: '1.1em',
              marginLeft: 2,
              background: 'var(--brass-bright)',
              verticalAlign: 'text-bottom',
              animation: 'hypha-caret 1.2s steps(2) infinite',
            }}
          />
        )}
        <style>{`
          @keyframes hypha-caret {
            0%, 49% { opacity: 1 }
            50%, 100% { opacity: 0 }
          }
        `}</style>
      </div>
    );
  }

  // Rich render — innerHTML set imperatively in useEffect above. Markdown owns
  // its own block flow, so drop pre-wrap (otherwise <p> spacing doubles).
  return (
    <div
      ref={bodyRef}
      className="hypha-chat-rich"
      style={{ ...baseStyle, whiteSpace: 'normal' }}
    />
  );
}

// ============================================================================
// LessonHistoryView — list of all sessions for a finished (graduated) lesson.
// Shows sessions newest-first; click row → SessionReadView; from there user can
// "continue from here" to fork a continuation session.
// ============================================================================

// VarianceCard — v0.2 post-lesson studio. Reads <slug>/variances.jsonl via
// the variance:get IPC and renders a single card showing intent echo +
// drift summary + on-track judgement. Renders nothing if no variance was
// computed (curriculum predates v0.2 or finish handler skipped). 千金
// register: italic Garamond, brass + teal accents, no chrome rectangles.
function VarianceCard({ rel }) {
  const [variance, setVariance] = React.useState(null);
  const [loaded, setLoaded] = React.useState(false);
  React.useEffect(() => {
    if (!rel || !window.ptor || !window.ptor.hypha || !window.ptor.hypha.varianceGet) {
      setLoaded(true); return;
    }
    let alive = true;
    window.ptor.hypha.varianceGet(rel)
      .then(v => { if (alive) { setVariance(v); setLoaded(true); } })
      .catch(() => { if (alive) { setLoaded(true); } });
    return () => { alive = false; };
  }, [rel]);
  if (!loaded || !variance) return null;
  const trackColor = variance.onTrack === 'detour'   ? 'var(--accent-teal, #4D8B9A)'
                    : variance.onTrack === 'drifting' ? 'var(--brass-mid, #a0876e)'
                    : 'var(--brass-bright, #c4a890)';
  const trackLabel = variance.onTrack === 'detour'   ? 'detour'
                   : variance.onTrack === 'drifting' ? 'drifting'
                   : 'on track';
  const date = variance.ts ? variance.ts.slice(0, 10) : '';
  return (
    <div style={{
      maxWidth: 720, margin: '0 auto 18px', padding: '14px 22px',
      borderLeft: `2px solid ${trackColor}`,
      background: 'color-mix(in srgb, var(--brass-mid) 5%, transparent)',
      fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
    }}>
      <div style={{
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 10.5, letterSpacing: '0.18em', textTransform: 'uppercase',
        color: 'var(--ink-faint)', marginBottom: 6,
      }}>
        variance · <span style={{ color: trackColor }}>{trackLabel}</span>
        {date && <span style={{ marginLeft: 12, opacity: 0.6 }}>{date}</span>}
      </div>
      {variance.intentEcho && (
        <p style={{
          margin: '0 0 8px', fontStyle: 'italic', fontSize: 15,
          color: 'var(--ink-muted)', lineHeight: 1.5,
        }}>
          intent: <span style={{ color: 'var(--ink-title)' }}>{variance.intentEcho}</span>
        </p>
      )}
      {variance.driftSummary && (
        <p style={{
          margin: 0, fontSize: 15, color: 'var(--ink-primary)', lineHeight: 1.6,
        }}>{variance.driftSummary}</p>
      )}
      {variance.driftReason && variance.onTrack !== 'on' && (
        <p style={{
          margin: '6px 0 0', fontSize: 13, fontStyle: 'italic',
          color: 'var(--ink-muted)', lineHeight: 1.5,
        }}>{variance.driftReason}</p>
      )}
    </div>
  );
}

function LessonHistoryView({ rel, meta, onReread }) {
  const [sessions, setSessions] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [openSession, setOpenSession] = React.useState(null); // null | { file, mode, ... }
  const [continuationSession, setContinuationSession] = React.useState(null); // sessionFile string when continuing

  // 2026-05-03 — 焚信 (Burning Letters) delete ceremony.
  // pressing: which session file (the row) is currently being long-pressed
  // dissolving: file → 'dissolving' (visual fade phase, 2.4s) | 'committing' (5s undo window) | 'gone' (collapsed)
  // Long-press 1.2s → enter 'dissolving' state (CSS filter blur+ash sweep,
  // mask-image top→bottom). Concurrent 5s undo timer; mouseenter on dissolving
  // row reverts. Timer expires → 'gone' (height:0 collapse + IPC soft-delete).
  const [pressingFile, setPressingFile] = React.useState(null);
  const [dissolving, setDissolving] = React.useState({}); // file → 'dissolving' | 'gone'
  const pressTimerRef = React.useRef(null);
  const expireTimersRef = React.useRef({});

  const startPress = React.useCallback((file) => {
    setPressingFile(file);
    pressTimerRef.current = setTimeout(() => {
      pressTimerRef.current = null;
      setPressingFile(null);
      setDissolving(d => ({ ...d, [file]: 'dissolving' }));
      // 5s undo window, then commit
      expireTimersRef.current[file] = setTimeout(async () => {
        delete expireTimersRef.current[file];
        try {
          if (window.ptor && window.ptor.llm && window.ptor.llm.lessonSessionDelete) {
            await window.ptor.llm.lessonSessionDelete(rel, file);
          }
        } catch (_) {}
        setDissolving(d => ({ ...d, [file]: 'gone' }));
        // After collapse animation finishes, remove from sessions
        setTimeout(() => {
          setSessions(prev => prev.filter(s => s.file !== file));
          setDissolving(d => { const n = { ...d }; delete n[file]; return n; });
        }, 700);
      }, 5000);
    }, 1200);
  }, [rel]);

  const cancelPress = React.useCallback(() => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    setPressingFile(null);
  }, []);

  const undoDissolve = React.useCallback((file) => {
    if (expireTimersRef.current[file]) {
      clearTimeout(expireTimersRef.current[file]);
      delete expireTimersRef.current[file];
    }
    setDissolving(d => { const n = { ...d }; delete n[file]; return n; });
  }, []);

  // Cleanup on unmount
  React.useEffect(() => () => {
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
    Object.values(expireTimersRef.current).forEach(t => clearTimeout(t));
  }, []);

  const lessonTitle = (meta && meta.frontmatter && meta.frontmatter.title)
    || (rel ? rel.split(/[\\/]/).pop().replace(/\.md$/i, '').replace(/^\d+-/, '').replace(/-/g, ' ') : '');
  const learnGoal = (meta && meta.frontmatter && String(meta.frontmatter.learn_goal || '').replace(/^"|"$/g, '')) || '';
  const distilledDate = (meta && meta.frontmatter && meta.frontmatter.date_distilled) || '';

  const refresh = React.useCallback(() => {
    if (!rel || !window.ptor || !window.ptor.llm || !window.ptor.llm.lessonSessions) return;
    setLoading(true);
    window.ptor.llm.lessonSessions(rel).then(s => {
      setSessions(Array.isArray(s) ? s : []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [rel]);

  React.useEffect(() => {
    refresh();
    setOpenSession(null);
    setContinuationSession(null);
  }, [rel, refresh]);

  // If continuation session is active, render a fresh LessonChat seeded with it.
  if (continuationSession) {
    return (
      <LessonChat
        rel={rel}
        meta={meta}
        sourceSessionFile={continuationSession}
        onDistilled={() => {
          setContinuationSession(null);
          if (typeof onReread === 'function') onReread();
          refresh();
        }}
      />
    );
  }

  // Reading a single session.
  if (openSession) {
    return (
      <SessionReadView
        rel={rel}
        session={openSession}
        onBack={() => setOpenSession(null)}
        onContinue={async () => {
          if (!window.ptor || !window.ptor.llm || !window.ptor.llm.lessonContinueFrom) return;
          const r = await window.ptor.llm.lessonContinueFrom(rel, openSession.file);
          if (r && r.ok && r.sessionFile) {
            setOpenSession(null);
            setContinuationSession(r.sessionFile);
          }
        }}
      />
    );
  }

  return (
    <div style={{
      flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
      fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
      color: 'var(--ink-primary)',
    }}>
      <header style={{
        padding: '24px 48px 18px',
        borderBottom: '1px solid color-mix(in srgb, var(--brass-mid) 14%, transparent)',
      }}>
        <div style={{
          fontStyle: 'italic', fontSize: 12, letterSpacing: '0.16em',
          textTransform: 'uppercase', color: 'var(--brass-bright)',
          marginBottom: 6,
        }}>graduated · {distilledDate}</div>
        <h2 style={{
          fontStyle: 'normal', fontWeight: 400, fontSize: 22, lineHeight: 1.25,
          color: 'var(--ink-title)', margin: '0 0 6px', letterSpacing: '-0.005em',
        }}>{lessonTitle}</h2>
        {learnGoal && (
          <p style={{
            fontStyle: 'italic', fontWeight: 400, fontSize: 14.5, lineHeight: 1.5,
            color: 'var(--ink-muted)', margin: 0, maxWidth: 720,
          }}>{learnGoal}</p>
        )}
      </header>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '18px 0' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '0 32px' }}>
          <VarianceCard rel={rel} />
          {loading && (
            <div style={{ fontStyle: 'italic', fontSize: 14, color: 'var(--ink-faint)', padding: 24, textAlign: 'center' }}>loading sessions…</div>
          )}
          {!loading && sessions.length === 0 && (
            <div style={{ fontStyle: 'italic', fontSize: 14, color: 'var(--ink-faint)', padding: 24, textAlign: 'center' }}>no sessions yet · this lesson was graduated without recorded turns.</div>
          )}
          {!loading && sessions.map((s, i) => {
            const dt = s.startISO ? s.startISO.replace('T', ' · ').slice(0, 16) : s.file;
            const isPressing = pressingFile === s.file;
            const phase = dissolving[s.file]; // 'dissolving' | 'gone' | undefined
            const isDissolving = phase === 'dissolving';
            const isGone = phase === 'gone';
            return (
              <button
                key={s.file}
                onClick={() => {
                  // ignore click while pressing/dissolving — defer to press / undo
                  if (isPressing || isDissolving || isGone) return;
                  setOpenSession(s);
                }}
                onMouseDown={(e) => {
                  if (e.button !== 0 || isDissolving || isGone) return;
                  startPress(s.file);
                }}
                onMouseUp={() => { if (isPressing) cancelPress(); }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'color-mix(in srgb, var(--brass-mid) 6%, transparent)';
                  // Hovering a dissolving row = silent undo (5s window)
                  if (isDissolving) undoDissolve(s.file);
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  if (isPressing) cancelPress();
                }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: isGone ? 'none' : '1px solid color-mix(in srgb, var(--brass-mid) 12%, transparent)',
                  padding: isGone ? '0 8px' : '18px 8px',
                  height: isGone ? '0' : 'auto',
                  overflow: 'hidden',
                  cursor: isDissolving ? 'pointer' : 'pointer',
                  fontFamily: 'inherit',
                  position: 'relative',
                  transition: isGone
                    ? 'height 600ms ease, padding 600ms ease, opacity 400ms ease 200ms'
                    : isDissolving
                      ? 'filter 2400ms cubic-bezier(0.4, 0, 0.6, 1), opacity 2400ms cubic-bezier(0.4, 0, 0.6, 1), -webkit-mask-image 2400ms cubic-bezier(0.4, 0, 0.6, 1), mask-image 2400ms cubic-bezier(0.4, 0, 0.6, 1)'
                      : 'background 220ms cubic-bezier(0.22, 1, 0.36, 1), filter 220ms ease, opacity 220ms ease',
                  filter: isDissolving ? 'blur(4px) saturate(0.4) hue-rotate(335deg) brightness(0.9)' : 'none',
                  opacity: isGone ? 0 : (isDissolving ? 0.45 : 1),
                  WebkitMaskImage: isDissolving ? 'linear-gradient(to bottom, transparent 0%, black 35%, black 100%)' : 'none',
                  maskImage: isDissolving ? 'linear-gradient(to bottom, transparent 0%, black 35%, black 100%)' : 'none',
                }}
              >
                <div style={{
                  display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6,
                }}>
                  <span style={{
                    fontStyle: 'italic', fontSize: 13, color: 'var(--ink-muted)',
                    letterSpacing: '0.04em',
                  }}>{dt}</span>
                  {s.mode === 'continuation' && (
                    <span style={{
                      fontStyle: 'italic', fontSize: 11, color: 'var(--brass-bright)',
                      letterSpacing: '0.16em', textTransform: 'uppercase',
                    }}>· revisit</span>
                  )}
                  <span style={{
                    flex: 1, textAlign: 'right',
                    fontStyle: 'italic', fontSize: 12, color: 'var(--ink-faint)',
                  }}>{s.turnCount} turn{s.turnCount === 1 ? '' : 's'}</span>
                </div>
                <div style={{
                  fontFamily: 'inherit', fontStyle: 'italic',
                  fontSize: 16, lineHeight: 1.5, color: 'var(--ink-title)',
                  fontWeight: 400,
                }}>
                  "{s.firstQuestion || '(no opening question recorded)'}"
                </div>
                {/* Press progress bar — 1px brass line fills bottom of row
                    over 1.2s during long-press. Resets if press canceled. */}
                <span
                  aria-hidden="true"
                  style={{
                    position: 'absolute', left: 0, bottom: 0,
                    height: 1,
                    background: 'var(--brass-bright)',
                    width: isPressing ? '100%' : '0%',
                    transition: isPressing ? 'width 1200ms linear' : 'width 220ms ease',
                    pointerEvents: 'none',
                  }}
                />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// SessionReadView — read-only transcript of one session. Two actions: back +
// continue from here (forks a continuation session via lesson:continueFrom).
// ============================================================================

function SessionReadView({ rel, session, onBack, onContinue }) {
  // Load profiles inline so transcript bubbles show the same names as live chat.
  // Tutor displayName precedence: per-curriculum agent.json.displayName >
  // global profile.tutorName > persona.label > 'tutor'.
  const [tutorProfile, setTutorProfile] = React.useState({ displayName: '', avatar: null });
  const [userProfile, setUserProfile] = React.useState({ name: '', avatar: null, tutorName: '' });
  React.useEffect(() => {
    if (!rel || !window.ptor || !window.ptor.hypha || !window.ptor.hypha.agentGet || !window.ptor.hypha.personas) return;
    const slug = rel.split(/[\\/]/)[0];
    Promise.all([window.ptor.hypha.agentGet(slug), window.ptor.hypha.personas()])
      .then(([profile, list]) => {
        const id = (profile && profile.persona) || 'socratic';
        const p = (list || []).find(x => x.id === id);
        const personaLabel = p ? p.label : id;
        const perCurriculum = profile && typeof profile.displayName === 'string' ? profile.displayName.trim() : '';
        const globalTutor = (userProfile && userProfile.tutorName) || '';
        setTutorProfile({
          displayName: perCurriculum || globalTutor || personaLabel,
          avatar: (profile && profile.avatar) || null,
        });
      }).catch(() => {});
  }, [rel, userProfile.tutorName]);
  React.useEffect(() => {
    if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.profileGet) return;
    window.ptor.hypha.profileGet().then(p => {
      if (p) setUserProfile({
        name: p.name || '',
        avatar: p.avatar || null,
        tutorName: p.tutorName || '',
      });
    }).catch(() => {});
  }, []);
  const [turns, setTurns] = React.useState([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!rel || !session || !window.ptor || !window.ptor.llm || !window.ptor.llm.lessonTranscript) return;
    setLoading(true);
    window.ptor.llm.lessonTranscript(rel, session.file).then(r => {
      if (r && r.ok) {
        setTurns((r.turns || []).filter(t => t.role === 'user' || t.role === 'tutor'));
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [rel, session]);

  return (
    <div style={{
      flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
      fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
      color: 'var(--ink-primary)',
    }}>
      <header style={{
        padding: '24px 48px 18px',
        borderBottom: '1px solid color-mix(in srgb, var(--brass-mid) 14%, transparent)',
        display: 'flex', alignItems: 'baseline', gap: 16,
      }}>
        <button
          onClick={onBack}
          style={{
            background: 'transparent', border: 'none', padding: '4px 10px',
            cursor: 'pointer', fontFamily: 'inherit', fontStyle: 'italic',
            fontSize: 14, color: 'var(--ink-muted)',
            transition: 'color 220ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--ink-title)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-muted)'; }}
        >← back to history</button>
        <span style={{
          flex: 1,
          fontStyle: 'italic', fontSize: 13, color: 'var(--ink-faint)',
          letterSpacing: '0.04em',
        }}>{session.startISO ? session.startISO.replace('T', ' · ').slice(0, 16) : session.file}</span>
        <button
          onClick={onContinue}
          style={{
            background: 'color-mix(in srgb, var(--brass-bright) 18%, transparent)',
            border: '1px solid var(--brass-bright)',
            borderRadius: '14px 10px 14px 10px',
            color: 'var(--ink-title)',
            fontFamily: 'inherit', fontStyle: 'italic',
            fontSize: 14, padding: '7px 16px',
            cursor: 'pointer',
            transition: 'all 220ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--brass-bright) 28%, transparent)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--brass-bright) 18%, transparent)'; }}
        >continue from here →</button>
      </header>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '24px 0' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '0 32px', display: 'flex', flexDirection: 'column', gap: 28 }}>
          {loading && (
            <div style={{ fontStyle: 'italic', fontSize: 14, color: 'var(--ink-faint)', padding: 24, textAlign: 'center' }}>loading transcript…</div>
          )}
          {!loading && turns.map((t, i) => (
            <ChatBubble key={i} role={t.role} text={t.text} streaming={false} error={false} userProfile={userProfile} tutorProfile={tutorProfile} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// ConceptAtlas — Phase A.1 substrate (council 2026-05-01).
//
// Right-rail panel showing the live concept state of the current lesson.
// Reads atlas from main process (atlas:get), listens for `hypha:atlas-updated`
// events fired by LessonChat after each tutor/user turn streams complete.
//
// Rendering:
//   · grouped by state — introduced / referenced / settled / drifted / expected
//   · "drifted" computed at render time: last occurrence > 3 turns ago
//   · italic Garamond chips, no boxes / cards / SaaS pills
//   · click chip → cycle state (escape hatch: user disagrees with extraction)
//
// State color register:
//   introduced → ink-faint italic + brass-mid underline (just appeared)
//   referenced → brass-mid italic (re-encountered, not yet settled)
//   settled    → brass-bright italic, slight rim (you used it correctly)
//   drifted    → ink-faint italic + hairline strikethrough (cooling)
//   expected   → ink-muted italic + brass dashed underline (tutor should bring it up)
// ConceptLogbookPanel — v0.2.1 per-concept biography, assembled across ALL
// lessons in the curriculum via concept-logbook:get IPC. Replaces the atlas
// chip list temporarily (toggled by double-click on a chip). Cross-session
// view = the moat surface (Lung's CONCEPT_AS_VESSEL: concept is a ship,
// lessons are ports). cuflow/OpenMAIC structurally cannot have this — they
// have no week-over-week substrate.
function ConceptLogbookPanel({ slug, conceptId, currentRel, onClose, onPickLesson }) {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    if (!slug || !conceptId) { setLoading(false); return; }
    if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.conceptLogbook) {
      setLoading(false); return;
    }
    let alive = true;
    setLoading(true);
    window.ptor.hypha.conceptLogbook(slug, conceptId)
      .then(r => { if (alive) { setData(r); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [slug, conceptId]);
  const entries = (data && data.ok && Array.isArray(data.entries)) ? data.entries : [];
  return (
    <div style={{
      flex: 1, minHeight: 0, overflowY: 'auto',
      padding: '20px 18px 32px',
      fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
    }}>
      <button
        onClick={onClose}
        style={{
          background: 'transparent', border: 'none', padding: 0, margin: '0 0 14px',
          fontFamily: 'inherit', fontStyle: 'italic', fontSize: 13,
          color: 'var(--ink-faint)', cursor: 'pointer',
          borderBottom: '1px solid transparent', transition: 'border-color 200ms, color 200ms',
        }}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--brass-bright)'; e.currentTarget.style.borderBottomColor = 'var(--brass-bright)'; }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-faint)'; e.currentTarget.style.borderBottomColor = 'transparent'; }}
      >← back to atlas</button>

      <div style={{
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 10.5, letterSpacing: '0.18em', textTransform: 'uppercase',
        color: 'var(--ink-faint)', marginBottom: 4,
      }}>biography</div>
      <h3 style={{
        margin: '0 0 16px', fontSize: 22, fontStyle: 'italic',
        color: 'var(--brass-bright)', fontWeight: 400,
      }}>{conceptId}</h3>

      {loading && (
        <p style={{ fontStyle: 'italic', color: 'var(--ink-faint)', fontSize: 13 }}>loading…</p>
      )}
      {!loading && entries.length === 0 && (
        <p style={{ fontStyle: 'italic', color: 'var(--ink-faint)', fontSize: 13 }}>
          this concept has only been seen in the current lesson — no biography yet.
        </p>
      )}
      {!loading && entries.map((e) => {
        const isCurrent = e.lessonRel === currentRel;
        const stateLabel = e.state === 'settled' ? 'settled'
                         : e.state === 'referenced' ? 'referenced'
                         : e.state === 'drifted' ? 'drifted'
                         : 'introduced';
        const stateColor = e.state === 'settled' ? 'var(--brass-bright)'
                         : e.state === 'referenced' ? 'var(--brass-mid)'
                         : e.state === 'drifted' ? 'var(--ink-faint)'
                         : 'var(--ink-muted)';
        return (
          <button
            key={e.idx}
            onClick={() => { if (e.lessonRel && typeof onPickLesson === 'function') onPickLesson(e.lessonRel); }}
            disabled={isCurrent}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              background: isCurrent ? 'color-mix(in srgb, var(--brass-mid) 8%, transparent)' : 'transparent',
              border: 'none',
              borderLeft: isCurrent ? `2px solid ${stateColor}` : '2px solid transparent',
              padding: '10px 12px',
              margin: '0 0 8px',
              fontFamily: 'inherit',
              cursor: isCurrent ? 'default' : 'pointer',
              transition: 'background 200ms, border-color 200ms',
            }}
            onMouseEnter={ev => { if (!isCurrent) ev.currentTarget.style.background = 'color-mix(in srgb, var(--brass-mid) 6%, transparent)'; }}
            onMouseLeave={ev => { if (!isCurrent) ev.currentTarget.style.background = 'transparent'; }}
            title={isCurrent ? 'currently viewing this lesson' : 'open this lesson'}
          >
            <div style={{
              display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4,
              fontSize: 11.5, color: 'var(--ink-faint)',
              fontFamily: '"JetBrains Mono", monospace', letterSpacing: '0.04em',
            }}>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{String(e.idx + 1).padStart(2, '0')}</span>
              <span style={{ color: stateColor, fontFamily: 'inherit', fontStyle: 'italic', textTransform: 'lowercase', letterSpacing: 0 }}>· {stateLabel}</span>
              {e.distilled && <span style={{ marginLeft: 'auto' }}>distilled</span>}
            </div>
            <div style={{
              fontStyle: 'italic', fontSize: 14, lineHeight: 1.4,
              color: isCurrent ? 'var(--ink-title)' : 'var(--ink-primary)',
            }}>{e.lessonTitle}</div>
            {e.snippet && (
              <p style={{
                margin: '4px 0 0', fontSize: 12.5, lineHeight: 1.45,
                color: 'var(--ink-muted)', fontStyle: 'normal',
              }}>"{e.snippet}"</p>
            )}
          </button>
        );
      })}
    </div>
  );
}

// AtlasMindMapPanel — v0.3 lacquerware mindmap. Cross-lesson view of every
// concept ever seen in this curriculum. Concentric layout by settled state
// (substrate-as-position, not arbitrary force-directed): inner ring =
// settled, then referenced, then introduced, drifted on the periphery.
// Edges = co-occurrence count in same lesson. Hand-rolled SVG (no
// third-party graph lib — Hypha rejects motion-library imports per
// Motion v1 §H). Click a node → opens its biography panel.
function AtlasMindMapPanel({ slug, currentRel, onClose, onPickConcept }) {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [hoverTerm, setHoverTerm] = React.useState(null);
  const W = 340, H = 480, CX = W / 2, CY = H / 2;
  const RINGS = { settled: 60, referenced: 110, introduced: 170, drifted: 215 };

  React.useEffect(() => {
    if (!slug || !window.ptor || !window.ptor.hypha || !window.ptor.hypha.atlasCurriculumView) {
      setLoading(false); return;
    }
    let alive = true;
    setLoading(true);
    window.ptor.hypha.atlasCurriculumView(slug)
      .then(r => { if (alive) { setData(r); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [slug]);

  // Deterministic angle per term so layout is stable across renders.
  const hashAngle = (term) => {
    let h = 0;
    for (let i = 0; i < term.length; i++) h = ((h << 5) - h + term.charCodeAt(i)) | 0;
    return ((h % 360) + 360) % 360;
  };

  const concepts = (data && data.ok && data.concepts) || [];
  const edges = (data && data.ok && data.edges) || [];
  const totalLessons = (data && data.totalLessons) || 0;

  // Position each concept by state ring + deterministic angle.
  // Same-state concepts spread evenly; angle hash adds visual variety.
  const positioned = React.useMemo(() => {
    const byState = { settled: [], referenced: [], introduced: [], drifted: [] };
    for (const c of concepts) (byState[c.state] || byState.introduced).push(c);
    const out = {};
    for (const [state, list] of Object.entries(byState)) {
      const r = RINGS[state] || 170;
      const N = list.length;
      list.sort((a, b) => a.term.localeCompare(b.term));
      list.forEach((c, i) => {
        // Spread evenly + small hash-based wobble so layout isn't perfectly geometric.
        const baseAngle = (i / Math.max(1, N)) * 360;
        const wobble = ((hashAngle(c.term) % 30) - 15);
        const ang = (baseAngle + wobble) * Math.PI / 180;
        out[c.term] = {
          x: CX + r * Math.cos(ang),
          y: CY + r * Math.sin(ang),
          state, c,
        };
      });
    }
    return out;
  }, [concepts]);

  const stateColor = {
    settled:    'var(--brass-bright)',
    referenced: 'var(--brass-mid)',
    introduced: 'var(--ink-muted)',
    drifted:    'var(--ink-faint)',
  };

  return (
    <div style={{
      flex: 1, minHeight: 0, overflowY: 'auto',
      padding: '16px 14px 24px',
      fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
        <button
          onClick={onClose}
          style={{
            background: 'transparent', border: 'none', padding: 0,
            fontFamily: 'inherit', fontStyle: 'italic', fontSize: 13,
            color: 'var(--ink-faint)', cursor: 'pointer',
            borderBottom: '1px solid transparent', transition: 'border-color 200ms, color 200ms',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--brass-bright)'; e.currentTarget.style.borderBottomColor = 'var(--brass-bright)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-faint)'; e.currentTarget.style.borderBottomColor = 'transparent'; }}
        >← back to atlas</button>
        <span style={{ flex: 1 }} />
        <span style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 10.5, letterSpacing: '0.18em', textTransform: 'uppercase',
          color: 'var(--ink-faint)', fontVariantNumeric: 'tabular-nums',
        }}>{concepts.length} concepts · {totalLessons} lessons</span>
      </div>

      {loading && (
        <p style={{ fontStyle: 'italic', color: 'var(--ink-faint)', fontSize: 13, padding: 24, textAlign: 'center' }}>
          assembling cross-lesson atlas…
        </p>
      )}
      {!loading && concepts.length === 0 && (
        <p style={{ fontStyle: 'italic', color: 'var(--ink-faint)', fontSize: 13, padding: 24, textAlign: 'center' }}>
          no concepts yet — the mindmap grows as lessons accumulate.
        </p>
      )}
      {!loading && concepts.length > 0 && (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', maxHeight: 480 }}>
            {/* Concentric ring guides — 1px hairlines, very low opacity */}
            {Object.entries(RINGS).map(([state, r]) => (
              <circle key={state} cx={CX} cy={CY} r={r}
                fill="none" stroke="var(--brass-mid)"
                strokeOpacity={0.08} strokeWidth={0.5} />
            ))}
            {/* Edges — drawn first so nodes overlay them */}
            {edges.map((e, i) => {
              const a = positioned[e.a], b = positioned[e.b];
              if (!a || !b) return null;
              const opacity = Math.min(0.35, 0.05 + e.weight * 0.06);
              const isHovered = hoverTerm === e.a || hoverTerm === e.b;
              return (
                <line key={i}
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke="var(--brass-mid)"
                  strokeWidth={isHovered ? 1 : 0.5}
                  strokeOpacity={isHovered ? 0.6 : opacity}
                />
              );
            })}
            {/* Nodes */}
            {concepts.map(c => {
              const p = positioned[c.term];
              if (!p) return null;
              const isHovered = hoverTerm === c.term;
              const r = c.state === 'settled' ? 4 : c.state === 'referenced' ? 3.2 : 2.6;
              const labelOpacity = isHovered ? 1 : (c.state === 'settled' ? 0.92 : c.state === 'referenced' ? 0.72 : 0.5);
              const labelDx = p.x > CX ? 7 : -7;
              const labelAnchor = p.x > CX ? 'start' : 'end';
              return (
                <g key={c.term}
                   onMouseEnter={() => setHoverTerm(c.term)}
                   onMouseLeave={() => setHoverTerm(prev => prev === c.term ? null : prev)}
                   onClick={() => { if (typeof onPickConcept === 'function') onPickConcept(c.term); }}
                   style={{ cursor: 'pointer' }}>
                  <circle cx={p.x} cy={p.y} r={isHovered ? r + 1.5 : r}
                    fill={stateColor[c.state] || 'var(--ink-muted)'}
                    fillOpacity={c.state === 'drifted' ? 0.5 : 1}
                    style={{ transition: 'r 220ms cubic-bezier(0.22, 1, 0.36, 1)' }}
                  />
                  <text x={p.x + labelDx} y={p.y + 3.5}
                    fontFamily='"EB Garamond", "Noto Serif SC", Georgia, serif'
                    fontStyle="italic"
                    fontSize={isHovered ? 11.5 : 10.5}
                    fill={c.state === 'settled' ? 'var(--ink-title)' : 'var(--ink-muted)'}
                    fillOpacity={labelOpacity}
                    textAnchor={labelAnchor}
                    style={{ pointerEvents: 'none', textDecoration: c.state === 'drifted' ? 'line-through' : 'none' }}
                  >
                    {c.term}
                  </text>
                </g>
              );
            })}
            {/* Center label — totals echo */}
            <text x={CX} y={CY + 4}
              fontFamily='"JetBrains Mono", monospace'
              fontSize={9} fill="var(--ink-faint)"
              textAnchor="middle" letterSpacing="0.16em"
              style={{ textTransform: 'uppercase' }}
            >atlas</text>
          </svg>

          {/* Hover snippet — appears below SVG, no chrome */}
          <div style={{
            minHeight: 36, padding: '8px 4px 0',
            fontStyle: 'italic', fontSize: 12.5, color: 'var(--ink-muted)',
            lineHeight: 1.5,
          }}>
            {hoverTerm && positioned[hoverTerm] && (
              <>
                <span style={{ color: stateColor[positioned[hoverTerm].state], fontStyle: 'italic' }}>
                  {hoverTerm}
                </span>
                <span style={{ color: 'var(--ink-faint)' }}> · {positioned[hoverTerm].state} · {positioned[hoverTerm].c.lessonCount} lesson{positioned[hoverTerm].c.lessonCount === 1 ? '' : 's'}</span>
                {positioned[hoverTerm].c.snippet && (
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--ink-muted)' }}>
                    "{positioned[hoverTerm].c.snippet}"
                  </p>
                )}
              </>
            )}
          </div>

          {/* Ring legend */}
          <div style={{
            display: 'flex', gap: 14, marginTop: 8, paddingTop: 12,
            borderTop: '1px solid color-mix(in srgb, var(--brass-mid) 14%, transparent)',
            fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
            letterSpacing: '0.12em', textTransform: 'uppercase',
            color: 'var(--ink-faint)',
            flexWrap: 'wrap',
          }}>
            {[
              { state: 'settled',    label: 'settled' },
              { state: 'referenced', label: 'referenced' },
              { state: 'introduced', label: 'introduced' },
              { state: 'drifted',    label: 'drifted' },
            ].map(s => (
              <span key={s.state} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: stateColor[s.state],
                  opacity: s.state === 'drifted' ? 0.5 : 1,
                }} />
                {s.label}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ConceptAtlas({ rel }) {
  const [atlas, setAtlas] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [editingTerm, setEditingTerm] = React.useState(null);
  // v0.2.1 — concept biography toggle. When non-null, the right rail swaps
  // from atlas-chip-list to ConceptLogbookPanel for that concept across the
  // whole curriculum. Triggered by double-click on a chip (single-click
  // still cycles state — existing behavior).
  const [biographyTerm, setBiographyTerm] = React.useState(null);
  // v0.3 — mindmap toggle. When true, swap chip list for cross-lesson SVG
  // mindmap (concentric layout by settled state). Click a node → biography.
  const [mapMode, setMapMode] = React.useState(false);
  // 金句 drag-tear state. dropActive: true while a hypha-quote drag hovers the
  // panel — shows brass dashed affordance ring. expandedQuoteId: which quote's
  // insight editor is open. draftInsight: in-progress textarea content.
  const [dropActive, setDropActive] = React.useState(false);
  const [expandedQuoteId, setExpandedQuoteId] = React.useState(null);
  const [draftInsight, setDraftInsight] = React.useState('');
  const [savingQuoteId, setSavingQuoteId] = React.useState(null);
  const [justAddedId, setJustAddedId] = React.useState(null);
  // 2.3: hover-to-reveal × + arm-then-commit delete (no modal — inline 2-stage).
  // hoverQuoteId: which card has × visible. armedQuoteId: clicked × once,
  // 2nd click within 2s commits delete; otherwise auto-disarm via setTimeout.
  const [hoverQuoteId, setHoverQuoteId] = React.useState(null);
  const [armedQuoteId, setArmedQuoteId] = React.useState(null);
  const armTimerRef = React.useRef(null);
  // 2.4 — history toggle per quote (insight versions disclosure).
  const [historyOpenId, setHistoryOpenId] = React.useState(null);

  const reload = React.useCallback(() => {
    if (!rel || !window.ptor || !window.ptor.hypha || !window.ptor.hypha.atlasGet) {
      setAtlas(null);
      setLoading(false);
      return;
    }
    window.ptor.hypha.atlasGet(rel).then(a => {
      setAtlas(a);
      setLoading(false);
    }).catch(() => {
      setAtlas(null);
      setLoading(false);
    });
  }, [rel]);

  React.useEffect(() => {
    setLoading(true);
    reload();
    const onUpdate = (e) => {
      // Only reload if the event matches OUR rel (lesson user is currently on)
      if (e && e.detail && e.detail.rel && e.detail.rel !== rel) return;
      reload();
    };
    window.addEventListener('hypha:atlas-updated', onUpdate);
    return () => window.removeEventListener('hypha:atlas-updated', onUpdate);
  }, [rel, reload]);

  // Phase 2.2 — bidirectional reading: clicking an underlined passage in
  // ChatBubble dispatches hypha:quote-recall {quoteId}. Find matching card,
  // scroll-into-view + apply 600ms brass glow. No-op if id not in current atlas.
  React.useEffect(() => {
    const onRecall = (e) => {
      const id = e && e.detail && e.detail.quoteId;
      if (!id) return;
      const card = document.querySelector(`[data-hypha-quote-card="${id}"]`);
      if (!card) return;
      try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
      card.classList.remove('hypha-quote-glow');
      // Force reflow so class re-add re-triggers animation
      void card.offsetWidth; // eslint-disable-line no-unused-expressions
      card.classList.add('hypha-quote-glow');
      setTimeout(() => { try { card.classList.remove('hypha-quote-glow'); } catch (_) {} }, 700);
    };
    window.addEventListener('hypha:quote-recall', onRecall);
    return () => window.removeEventListener('hypha:quote-recall', onRecall);
  }, []);

  const cycleState = React.useCallback(async (term, currentState) => {
    if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.atlasEditState) return;
    const order = ['introduced', 'referenced', 'settled', 'drifted'];
    const idx = order.indexOf(currentState);
    const next = order[(idx + 1) % order.length];
    try {
      const r = await window.ptor.hypha.atlasEditState(rel, term, next);
      if (r && r.atlas) setAtlas(r.atlas);
    } catch (_) {}
  }, [rel]);

  // 金句 drag-and-drop handlers — drop zone is the entire ConceptAtlas panel.
  // Reads enriched payload from custom MIME 'application/hypha-quote' (set by
  // ChatBubble dragstart); falls back to plain text if dropped from elsewhere.
  // NOTE: these hooks must be declared BEFORE any early return below — Rules of
  // Hooks require a stable hook count across renders. v0.4.2 fix.
  const onDragOver = React.useCallback((e) => {
    if (!e.dataTransfer) return;
    const types = Array.from(e.dataTransfer.types || []);
    if (types.includes('application/hypha-quote') || types.includes('text/plain')) {
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
      setDropActive(true);
    }
  }, []);
  const onDragLeave = React.useCallback((e) => {
    // Only deactivate when leaving panel boundary (not when crossing children)
    if (!e.currentTarget.contains(e.relatedTarget)) setDropActive(false);
  }, []);
  const onDrop = React.useCallback(async (e) => {
    e.preventDefault();
    setDropActive(false);
    if (!rel || !window.ptor || !window.ptor.hypha || !window.ptor.hypha.quoteAdd) return;
    let payload = null;
    try {
      const enriched = e.dataTransfer.getData('application/hypha-quote');
      if (enriched) payload = JSON.parse(enriched);
    } catch (_) {}
    if (!payload || !payload.text) {
      const plain = (e.dataTransfer.getData('text/plain') || '').trim();
      if (plain.length >= 6) payload = { text: plain, msgIdx: null, role: 'tutor' };
    }
    if (!payload || !payload.text || payload.text.length < 6) return;
    try {
      const r = await window.ptor.hypha.quoteAdd(rel, payload);
      if (r && r.ok && r.atlas) {
        setAtlas(r.atlas);
        if (r.quote) {
          setJustAddedId(r.quote.id);
          setTimeout(() => setJustAddedId(prev => prev === r.quote.id ? null : prev), 900);
        }
        // Notify LessonChat (which lifts atlas.quotes for ChatBubble underlines).
        try { window.dispatchEvent(new CustomEvent('hypha:atlas-updated', { detail: { rel } })); } catch (_) {}
      }
    } catch (_) {}
  }, [rel]);

  // 2.3 delete handler — first × click ARMS (2s window); second commits.
  const handleDeleteClick = React.useCallback(async (e, quoteId) => {
    e.stopPropagation();
    if (!rel || !window.ptor || !window.ptor.hypha || !window.ptor.hypha.quoteDelete) return;
    if (armedQuoteId !== quoteId) {
      // First click — arm. Auto-disarm after 2s.
      setArmedQuoteId(quoteId);
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
      armTimerRef.current = setTimeout(() => setArmedQuoteId(null), 2000);
      return;
    }
    // Second click within window — commit.
    if (armTimerRef.current) { clearTimeout(armTimerRef.current); armTimerRef.current = null; }
    setArmedQuoteId(null);
    try {
      const r = await window.ptor.hypha.quoteDelete(rel, quoteId);
      if (r && r.ok && r.atlas) {
        setAtlas(r.atlas);
        if (expandedQuoteId === quoteId) { setExpandedQuoteId(null); setDraftInsight(''); }
        try { window.dispatchEvent(new CustomEvent('hypha:atlas-updated', { detail: { rel } })); } catch (_) {}
      }
    } catch (_) {}
  }, [rel, armedQuoteId, expandedQuoteId]);

  const saveInsight = React.useCallback(async (quoteId) => {
    if (!rel || !window.ptor || !window.ptor.hypha || !window.ptor.hypha.quoteAddInsight) return;
    const text = (draftInsight || '').trim();
    if (!text) return;
    setSavingQuoteId(quoteId);
    try {
      const r = await window.ptor.hypha.quoteAddInsight(rel, quoteId, text);
      if (r && r.ok && r.atlas) {
        setAtlas(r.atlas);
        setExpandedQuoteId(null);
        setDraftInsight('');
        try { window.dispatchEvent(new CustomEvent('hypha:atlas-updated', { detail: { rel } })); } catch (_) {}
      }
    } catch (_) {} finally {
      setSavingQuoteId(null);
    }
  }, [rel, draftInsight]);

  if (loading) {
    return (
      <div style={{ padding: '24px 16px', fontFamily: '"EB Garamond", Georgia, serif',
        fontStyle: 'italic', fontSize: 13, color: 'var(--ink-faint)', opacity: 0.7 }}>
        loading atlas…
      </div>
    );
  }

  // Not a lesson note (no lesson_idx in fm) → atlasGet returned null
  if (!atlas || !atlas.lesson_idx === undefined && atlas.lesson_idx === null) {
    return null;   // hide rail; no concept atlas for non-lesson notes
  }

  const concepts = (atlas && atlas.concepts) || {};
  const expected = (atlas && atlas.expected) || [];
  const quotes = (atlas && Array.isArray(atlas.quotes)) ? atlas.quotes : [];
  const currentTurn = atlas.turn_count || 0;
  const DRIFT_THRESHOLD = 3;

  // Bucket concepts by state. Compute "drifted" at render time:
  // any non-settled concept whose last occurrence is > DRIFT_THRESHOLD turns ago.
  const buckets = { introduced: [], referenced: [], settled: [], drifted: [] };
  for (const term of Object.keys(concepts)) {
    const c = concepts[term];
    const lastTurn = c.occurrences && c.occurrences.length
      ? c.occurrences[c.occurrences.length - 1].turn
      : c.first_seen_turn || 0;
    const turnsSinceLast = currentTurn - lastTurn;
    let state = c.state;
    if (state === 'settled') {
      // Settled stays settled regardless of drift (mastery is durable)
    } else if (turnsSinceLast >= DRIFT_THRESHOLD) {
      state = 'drifted';
    }
    if (!buckets[state]) buckets[state] = [];
    buckets[state].push({ ...c, displayState: state, lastTurn });
  }

  const totalLive = buckets.introduced.length + buckets.referenced.length
    + buckets.settled.length + buckets.drifted.length;

  if (totalLive === 0 && expected.length === 0 && quotes.length === 0) {
    return (
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        style={{
          padding: '32px 18px',
          fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
          fontStyle: 'italic', fontSize: 15, color: 'var(--ink-faint)',
          opacity: 0.75, lineHeight: 1.6,
          minHeight: '60vh',
          border: dropActive
            ? '1px dashed color-mix(in srgb, var(--brass-bright) 60%, transparent)'
            : '1px solid transparent',
          background: dropActive
            ? 'color-mix(in srgb, var(--brass-mid) 4%, transparent)'
            : 'transparent',
          transition: 'border-color 220ms var(--ease-quiet, cubic-bezier(0.4, 0, 0.2, 1)), background 220ms',
        }}
      >
        atlas empty.
        <br/>
        first concepts appear once tutor speaks.
        <br/><br/>
        <span style={{ opacity: 0.6 }}>or drag a passage here to keep it as 金句.</span>
      </div>
    );
  }

  // Section heading style — italic caps editorial register.
  // v0.8.5 — bumped from 10.5 to 13. User reported "字体太小看不清".
  const headingStyle = {
    fontFamily: '"Cormorant Garamond", "EB Garamond", Georgia, serif',
    fontStyle: 'italic',
    fontSize: 13,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color: 'var(--ink-faint)',
    margin: '14px 0 6px',
    fontWeight: 500,
  };

  // Chip per state — italic Garamond, color + underline as state signal.
  const renderChip = (c) => {
    const isSettled = c.displayState === 'settled';
    const isReferenced = c.displayState === 'referenced';
    const isDrifted = c.displayState === 'drifted';
    return (
      <button
        key={c.term}
        onClick={() => cycleState(c.term, c.state)}
        onDoubleClick={(e) => { e.preventDefault(); setBiographyTerm(c.term); }}
        title={(c.snippet || '') + (c.lastTurn != null ? ` · turn ${c.lastTurn}` : '') + ' · click=cycle state · double-click=biography'}
        style={{
          display: 'block',
          background: 'transparent',
          border: 'none',
          padding: '3px 0',
          margin: 0,
          textAlign: 'left',
          cursor: 'pointer',
          fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
          fontStyle: 'italic',
          fontSize: 16,
          lineHeight: 1.45,
          color: isSettled ? 'var(--brass-bright)'
            : isReferenced ? 'var(--brass-mid)'
            : isDrifted ? 'var(--ink-faint)'
            : 'var(--ink-muted)',     // introduced
          textDecoration: isDrifted ? 'line-through' : 'none',
          textDecorationColor: 'color-mix(in srgb, var(--brass-mid) 28%, transparent)',
          borderBottom: c.displayState === 'introduced'
            ? '1px solid color-mix(in srgb, var(--brass-mid) 50%, transparent)'
            : '1px solid transparent',
          paddingBottom: 2,
          transition: 'color 240ms cubic-bezier(0.16, 1, 0.3, 1)',
          width: '100%',
        }}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--ink-title)'; }}
        onMouseLeave={e => {
          e.currentTarget.style.color = isSettled ? 'var(--brass-bright)'
            : isReferenced ? 'var(--brass-mid)'
            : isDrifted ? 'var(--ink-faint)'
            : 'var(--ink-muted)';
        }}
      >
        · {c.term}
      </button>
    );
  };

  // v0.2.1 — when biographyTerm set, render LogbookPanel instead of chip list.
  if (biographyTerm) {
    const slug = rel ? rel.split(/[\\/]/)[0] : '';
    return (
      <ConceptLogbookPanel
        slug={slug}
        conceptId={biographyTerm}
        currentRel={rel}
        onClose={() => setBiographyTerm(null)}
        onPickLesson={(targetRel) => {
          // Dispatch global event — App.jsx listener navigates to that lesson.
          try { window.dispatchEvent(new CustomEvent('hypha:pick-lesson', { detail: { rel: targetRel } })); } catch (_) {}
          setBiographyTerm(null);
        }}
      />
    );
  }
  // v0.3 — when mapMode true, render cross-lesson mindmap. Click node → opens
  // biography for that concept (chains into the v0.2.1 logbook surface).
  if (mapMode) {
    const slug = rel ? rel.split(/[\\/]/)[0] : '';
    return (
      <AtlasMindMapPanel
        slug={slug}
        currentRel={rel}
        onClose={() => setMapMode(false)}
        onPickConcept={(term) => { setMapMode(false); setBiographyTerm(term); }}
      />
    );
  }

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        flex: 1, minHeight: 0,
        overflowY: 'auto',
        padding: '20px 18px 32px',
        fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
        outline: dropActive
          ? '1px dashed color-mix(in srgb, var(--brass-bright) 60%, transparent)'
          : '1px solid transparent',
        outlineOffset: -4,
        background: dropActive
          ? 'color-mix(in srgb, var(--brass-mid) 4%, transparent)'
          : 'transparent',
        transition: 'outline-color 220ms var(--ease-quiet, cubic-bezier(0.4, 0, 0.2, 1)), background 220ms',
      }}
    >
      <div style={{
        ...headingStyle,
        margin: '0 0 14px',
        color: 'var(--brass-bright)',
        fontSize: 14,
        display: 'flex', alignItems: 'baseline', gap: 8,
      }}>
        <span>概念地图 · {totalLive} 个{quotes.length > 0 ? ` · 金句 ${quotes.length}` : ''}</span>
        <span style={{ flex: 1 }} />
        {/* v0.3 — open mindmap (cross-lesson concentric SVG). Italic, brass-bright on hover. */}
        <button
          onClick={() => setMapMode(true)}
          title="view all concepts as a cross-lesson mindmap"
          style={{
            background: 'transparent', border: 'none', padding: 0,
            fontFamily: '"EB Garamond", "Noto Serif SC", serif',
            fontStyle: 'italic', fontSize: 14,
            letterSpacing: 0, textTransform: 'none',
            color: 'var(--brass-mid)', cursor: 'pointer',
            borderBottom: '1px solid transparent',
            transition: 'border-color 200ms, color 200ms',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--brass-bright)'; e.currentTarget.style.borderBottomColor = 'var(--brass-bright)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--brass-mid)'; e.currentTarget.style.borderBottomColor = 'transparent'; }}
        >view as map →</button>
      </div>

      {/* 金句 (Golden Quotes) section — drag-tear extractions from tutor messages.
          Each quote: italic Garamond blockquote, click to expand inline insight
          editor. Saving the insight appends to note's 用户灵感 layer. */}
      {quotes.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={headingStyle}>金句 ({quotes.length})</div>
          {quotes.map(q => {
            const isExpanded = expandedQuoteId === q.id;
            const hasInsight = !!(q.insight && q.insight.trim());
            const isJustAdded = justAddedId === q.id;
            return (
              <div
                key={q.id}
                data-hypha-quote-card={q.id}
                onMouseEnter={() => {
                  setHoverQuoteId(q.id);
                  // 2.6 — dispatch bubble-recall so LessonChat halos the source bubble.
                  if (typeof q.msg_idx === 'number') {
                    try { window.dispatchEvent(new CustomEvent('hypha:bubble-recall', { detail: { msgIdx: q.msg_idx } })); } catch (_) {}
                  }
                }}
                onMouseLeave={() => {
                  setHoverQuoteId(prev => prev === q.id ? null : prev);
                  // Disarm if mouse leaves card without confirming delete.
                  if (armedQuoteId === q.id) {
                    if (armTimerRef.current) { clearTimeout(armTimerRef.current); armTimerRef.current = null; }
                    setArmedQuoteId(null);
                  }
                  if (typeof q.msg_idx === 'number') {
                    try { window.dispatchEvent(new CustomEvent('hypha:bubble-recall-clear', { detail: { msgIdx: q.msg_idx } })); } catch (_) {}
                  }
                }}
                style={{
                  position: 'relative',
                  marginBottom: 8,
                  paddingLeft: 10,
                  paddingRight: 22,
                  borderLeft: '2px solid color-mix(in srgb, var(--brass-mid) ' + (hasInsight ? '70%' : '36%') + ', transparent)',
                  animation: isJustAdded ? 'hypha-quote-arrive 420ms var(--ease-quiet, cubic-bezier(0.4, 0, 0.2, 1))' : 'none',
                }}
              >
                {/* 2.3 — hover-reveal × delete glyph. First click arms (changes
                    color to verdict-flag); second click within 2s commits.
                    Auto-disarm on mouseleave or 2s timeout. */}
                <button
                  onClick={(e) => handleDeleteClick(e, q.id)}
                  aria-label={armedQuoteId === q.id ? '再点一次确认删除' : '删除金句'}
                  title={armedQuoteId === q.id ? '再点一次确认删除（已写见解仍保留在用户灵感）' : '删除金句'}
                  style={{
                    position: 'absolute',
                    top: 2, right: 2,
                    width: 18, height: 18,
                    background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: '"EB Garamond", "Cormorant Garamond", serif',
                    fontStyle: 'italic', fontSize: 14, lineHeight: 1,
                    color: armedQuoteId === q.id ? 'var(--verdict-flag, #c44)' : 'var(--ink-faint)',
                    opacity: (hoverQuoteId === q.id || armedQuoteId === q.id) ? 0.78 : 0,
                    transition: 'opacity 220ms var(--ease-quiet, cubic-bezier(0.4, 0, 0.2, 1)), color 180ms',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }}
                  onMouseLeave={e => { e.currentTarget.style.opacity = (hoverQuoteId === q.id || armedQuoteId === q.id) ? '0.78' : '0'; }}
                >×</button>
                <button
                  onClick={() => {
                    if (isExpanded) { setExpandedQuoteId(null); setDraftInsight(''); }
                    else { setExpandedQuoteId(q.id); setDraftInsight(q.insight || ''); }
                  }}
                  style={{
                    display: 'block', width: '100%',
                    background: 'transparent', border: 'none', padding: '4px 0',
                    textAlign: 'left', cursor: 'pointer',
                    fontFamily: 'inherit', fontStyle: 'italic',
                    fontSize: 15, lineHeight: 1.55,
                    color: hasInsight ? 'var(--brass-bright)' : 'var(--ink-muted)',
                    transition: 'color 220ms var(--ease-quiet, cubic-bezier(0.4, 0, 0.2, 1))',
                  }}
                  title={hasInsight ? '已写见解 · 点击展开编辑' : '点击写下你的见解 → 用户灵感'}
                  onMouseEnter={e => { e.currentTarget.style.color = 'var(--ink-title)'; }}
                  onMouseLeave={e => { e.currentTarget.style.color = hasInsight ? 'var(--brass-bright)' : 'var(--ink-muted)'; }}
                >
                  <span style={{ color: 'var(--brass-mid)', opacity: 0.75 }}>“</span>{q.text}<span style={{ color: 'var(--brass-mid)', opacity: 0.75 }}>”</span>
                  {hasInsight && <span style={{ marginLeft: 6, fontSize: 12, color: 'var(--brass-mid)', opacity: 0.6, letterSpacing: '0.08em' }}>· 见解</span>}
                </button>
                {/* 2.5 — linked-concept chips (atlas terms found in quote text). */}
                {Array.isArray(q.linked_concepts) && q.linked_concepts.length > 0 && (
                  <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {q.linked_concepts.map(t => (
                      <span
                        key={t}
                        title={'atlas concept · ' + t}
                        style={{
                          fontFamily: '"EB Garamond", "Noto Serif SC", serif',
                          fontStyle: 'italic',
                          fontSize: 13,
                          color: 'var(--brass-mid)',
                          letterSpacing: '0.02em',
                          padding: '0 1px',
                          borderBottom: '1px dotted color-mix(in srgb, var(--brass-mid) 45%, transparent)',
                          opacity: 0.85,
                        }}
                      >· {t}</span>
                    ))}
                  </div>
                )}
                {isExpanded && (() => {
                  // 2.4 — derive version list. Backwards-compat: if no
                  // insight_versions field, synthesize from string insight.
                  const versions = Array.isArray(q.insight_versions) && q.insight_versions.length
                    ? q.insight_versions
                    : (hasInsight ? [{ text: q.insight, ts: q.insight_at }] : []);
                  const priorVersions = versions.slice(0, -1);
                  const showHistory = historyOpenId === q.id;
                  return (
                  <div style={{ marginTop: 6, marginBottom: 10 }}>
                    {priorVersions.length > 0 && (
                      <button
                        onClick={() => setHistoryOpenId(showHistory ? null : q.id)}
                        style={{
                          background: 'transparent', border: 'none', cursor: 'pointer',
                          fontFamily: 'inherit', fontStyle: 'italic', fontSize: 13,
                          color: 'var(--ink-faint)', padding: '2px 0', marginBottom: 6,
                          letterSpacing: '0.04em',
                        }}
                      >{showHistory ? '收起' : `往昔 (${priorVersions.length})`}</button>
                    )}
                    {showHistory && priorVersions.map((v, vi) => (
                      <div key={vi} style={{
                        marginBottom: 6, padding: '6px 10px',
                        background: 'color-mix(in srgb, var(--brass-mid) 4%, transparent)',
                        borderLeft: '1px solid color-mix(in srgb, var(--brass-mid) 22%, transparent)',
                        fontSize: 14, color: 'var(--ink-muted)',
                        fontStyle: 'italic', lineHeight: 1.55,
                      }}>
                        <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', letterSpacing: '0.05em', marginBottom: 2 }}>
                          v{vi + 1} · {(v.ts || '').slice(0, 10)}
                        </div>
                        {v.text}
                      </div>
                    ))}
                    <textarea
                      autoFocus
                      value={draftInsight}
                      onChange={e => setDraftInsight(e.target.value)}
                      onKeyDown={e => {
                        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveInsight(q.id); }
                        if (e.key === 'Escape') { setExpandedQuoteId(null); setDraftInsight(''); }
                      }}
                      placeholder="写下你的见解 — 这条会进入笔记的「用户灵感」层"
                      rows={3}
                      style={{
                        width: '100%', resize: 'vertical', minHeight: 56,
                        background: 'transparent',
                        color: 'var(--ink-primary)',
                        border: 'none',
                        borderBottom: '1px solid color-mix(in srgb, var(--brass-mid) 32%, transparent)',
                        fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
                        fontStyle: 'normal',
                        fontSize: 14, lineHeight: 1.55,
                        padding: '6px 0',
                        outline: 'none',
                      }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 14, marginTop: 6 }}>
                      <span style={{ fontSize: 10.5, color: 'var(--ink-faint)', fontStyle: 'italic', opacity: 0.7 }}>
                        ⌘↩ 保存 · esc 取消
                      </span>
                      <button
                        onClick={() => saveInsight(q.id)}
                        disabled={!draftInsight.trim() || savingQuoteId === q.id}
                        style={{
                          background: 'transparent',
                          border: 'none', cursor: draftInsight.trim() ? 'pointer' : 'not-allowed',
                          color: draftInsight.trim() ? 'var(--brass-bright)' : 'var(--ink-faint)',
                          fontFamily: 'inherit', fontStyle: 'italic', fontSize: 13,
                          padding: '2px 0', opacity: draftInsight.trim() ? 1 : 0.5,
                        }}
                      >{savingQuoteId === q.id ? '存入中…' : (priorVersions.length > 0 ? '存为新版本 →' : '存入用户灵感 →')}</button>
                    </div>
                  </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}

      {/* Embedded keyframe — quote-arrive flicker (one-shot when newly dropped) */}
      <style>{`
        @keyframes hypha-quote-arrive {
          0%   { opacity: 0; transform: translateY(-3px); }
          60%  { opacity: 1; transform: translateY(0); }
          100% { opacity: 1; }
        }
      `}</style>

      {buckets.introduced.length > 0 && (
        <div style={{ marginBottom: 4 }}>
          <div style={headingStyle}>introduced ({buckets.introduced.length})</div>
          {buckets.introduced.map(renderChip)}
        </div>
      )}
      {buckets.referenced.length > 0 && (
        <div style={{ marginBottom: 4 }}>
          <div style={headingStyle}>referenced ({buckets.referenced.length})</div>
          {buckets.referenced.map(renderChip)}
        </div>
      )}
      {buckets.settled.length > 0 && (
        <div style={{ marginBottom: 4 }}>
          <div style={headingStyle}>settled ({buckets.settled.length})</div>
          {buckets.settled.map(renderChip)}
        </div>
      )}
      {buckets.drifted.length > 0 && (
        <div style={{ marginBottom: 4 }}>
          <div style={headingStyle}>drifted ({buckets.drifted.length})</div>
          {buckets.drifted.map(renderChip)}
        </div>
      )}

      {expected.length > 0 && (
        <div style={{ marginBottom: 4, marginTop: 14 }}>
          <div style={headingStyle}>expected ({expected.length})</div>
          {expected.map(e => (
            <div
              key={e.term}
              title={e.reason || 'tutor should bring this up'}
              style={{
                display: 'block',
                padding: '3px 0',
                fontFamily: 'inherit',
                fontStyle: 'italic',
                fontSize: 14,
                lineHeight: 1.4,
                color: 'var(--ink-muted)',
                borderBottom: '1px dashed color-mix(in srgb, var(--brass-mid) 40%, transparent)',
                paddingBottom: 2,
                marginBottom: 1,
                opacity: 0.75,
              }}
            >· {e.term}</div>
          ))}
        </div>
      )}

      <div style={{
        marginTop: 22,
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 9.5, letterSpacing: '0.04em',
        color: 'var(--ink-faint)', opacity: 0.6,
        lineHeight: 1.55,
      }}>
        click chip to cycle state if extractor got it wrong.
      </div>
    </div>
  );
}

Object.assign(window, { NoteView, LessonChat, LessonHistoryView, SessionReadView, ConceptAtlas, ConceptLogbookPanel });
