// Tab content — verdict hallmarks, ambient timeline, case, quiz, follow, graph.
// All colors come from CSS theme tokens.

// Helper: read a CSS var off <html>. Used by the canvas-only GRAPH tab.
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Refined SVG micro-marks — engraved hairline style, not Unicode symbols.
function VerdictGlyph({ kind }) {
  const size = 11;
  const style = { display: 'inline-block', width: size, height: size, verticalAlign: 'middle', flexShrink: 0 };
  if (kind === 'held') {
    // Diamond hallmark — rotated square with hairline
    return <svg style={style} viewBox="0 0 12 12" fill="none">
      <rect x="6" y="1" width="5" height="5" rx="0.8" transform="rotate(45 6 6)" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="6" cy="6" r="1" fill="currentColor" />
    </svg>;
  }
  if (kind === 'gap') {
    // Open circle with a line through — like an unfilled field mark
    return <svg style={style} viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="4.2" stroke="currentColor" strokeWidth="1" />
      <line x1="3.5" y1="6" x2="8.5" y2="6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>;
  }
  // clean — a single elegant check, like a calligrapher's tick
  return <svg style={style} viewBox="0 0 12 12" fill="none">
    <path d="M2.5 6.5 L5 9 L9.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

function VerdictCard({ kind, title, body, sources, action }) {
  const palette = {
    held:  { color: 'var(--brass-bright)',   rule: 'var(--border-strong)',  label: 'held'  },
    gap:   { color: 'var(--verdict-gap)',    rule: 'var(--verdict-gap)',    label: 'gap'   },
    clean: { color: 'var(--verdict-clean)',  rule: 'var(--verdict-clean)',  label: 'clean' },
  }[kind];
  return (
    <div style={{
      padding: '16px 20px', borderRadius: 0,
      background: 'var(--glass-light)',
      backdropFilter: 'var(--glass-blur)',
      WebkitBackdropFilter: 'var(--glass-blur)',
      boxShadow: 'inset 0 1px 0 var(--inset-highlight), inset 0 0 0 1px var(--border-soft)',
    }}>
      {/* Engraved hallmark: glyph + small-caps + hair rule. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 }}>
        <span style={{
          display: 'inline-flex', alignItems: 'baseline', gap: 8,
          paddingBottom: 4,
          borderBottom: `1px solid ${palette.rule}`,
          color: palette.color,
          fontFamily: '"JetBrains Mono", monospace', fontSize: 11,
          fontWeight: 500, letterSpacing: '0.06em',
        }}>
          <VerdictGlyph kind={kind} />
          {palette.label}
        </span>
        <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11, color: 'var(--ink-faint)', letterSpacing: '0.04em' }}>
          {sources} sources · 2 minutes ago
        </span>
      </div>
      <div style={{
        fontFamily: '"EB Garamond", "Noto Serif SC", "Cormorant Garamond", Georgia, serif',
        fontSize: 21, fontWeight: 500,
        lineHeight: 1.32, color: 'var(--ink-title)', marginBottom: 10,
        letterSpacing: '-0.003em',
      }}>{title}</div>
      <div style={{
        fontFamily: '"EB Garamond", "Noto Serif SC", "Cormorant Garamond", Georgia, serif',
        fontSize: 18, lineHeight: 1.72, color: 'var(--ink-primary)', marginBottom: action ? 14 : 0,
      }}>{body}</div>
      {action && (
        <a style={{
          display: 'inline-flex', alignItems: 'baseline', gap: 8,
          paddingBottom: 3,
          fontFamily: '"EB Garamond", "Cormorant Garamond", Georgia, serif', fontStyle: 'italic',
          fontSize: 17, color: 'var(--ink-title)',
          borderBottom: `1px solid ${palette.rule}`,
          cursor: 'pointer',
          transition: 'color 220ms cubic-bezier(0.22,1,0.36,1)',
        }}>
          <span style={{ color: palette.color, fontFamily: '"JetBrains Mono", monospace', fontSize: 13, transform: 'translateY(1px)' }}>→</span>
          {action}
        </a>
      )}
    </div>
  );
}

function EmptyHint({ headline }) {
  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 36, textAlign: 'center',
    }}>
      <div style={{
        fontFamily: '"EB Garamond", "Noto Serif SC", "Cormorant Garamond", Georgia, serif',
        fontSize: 18, fontStyle: 'italic',
        color: 'var(--ink-muted)', lineHeight: 1.72, maxWidth: '40ch',
      }}>{headline}</div>
    </div>
  );
}

function bucketOf(since) {
  if (!since || since === '·') return 'dormant';
  if (since === 'now' || /[mh]$/.test(since)) return 'today';
  const m = since.match(/^(\d+)d$/);
  if (m) {
    const d = parseInt(m[1], 10);
    if (d <= 7) return 'week';
    if (d <= 30) return 'fading';
  }
  return 'dormant';
}

function pickDuePool(folders) {
  const all = folders.flatMap(f => (f.items || []).map(i => ({ ...i, folder: f.folder })));
  // 2026-05-01: RECALL excludes live curriculum stubs (lessonIdx + !distilled).
  // Finished/graduated lessons (lessonIdx + distilled) stay — they ARE the
  // crystallised library entries the recall queue should drill into.
  const eligible = all.filter(i => i.lessonIdx == null || i.distilled);
  const fading  = eligible.filter(i => bucketOf(i.since) === 'fading' || bucketOf(i.since) === 'dormant');
  const week    = eligible.filter(i => bucketOf(i.since) === 'week');
  return fading.length > 0 ? fading : week;
}

function extractExcerpt(body) {
  if (!body) return '';
  const stripped = body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const lines = stripped.split(/\r?\n/);
  const paragraphs = [];
  let buf = [];
  for (const line of lines) {
    if (/^\s*#/.test(line)) continue;
    if (!line.trim()) {
      if (buf.length) { paragraphs.push(buf.join(' ')); buf = []; }
      if (paragraphs.length >= 2) break;
    } else {
      buf.push(line.trim());
    }
  }
  if (buf.length) paragraphs.push(buf.join(' '));
  let text = paragraphs.slice(0, 2).join(' ');
  // Strip markdown emphasis markers — verify recall is reading-prompt prose,
  // the literal ** / * characters look like jarring quote-substitutes.
  // Order matters: bold (** **) first, then italic (* *), else the * regex
  // would chew the ** markers.
  text = text
    .replace(/\*\*([^\*]+?)\*\*/g, '$1')
    .replace(/(?<!\*)\*(?!\*)([^\*]+?)(?<!\*)\*(?!\*)/g, '$1');
  if (text.length > 280) text = text.slice(0, 280).replace(/\s+\S*$/, '') + '…';
  return text;
}

function titleFromLabel(label) {
  return (label || '').replace(/\.md$/i, '').replace(/[_-]+/g, ' ');
}

function RecallDashboard({ onPick }) {
  const [folders, setFolders] = React.useState([]);
  const [queue, setQueue] = React.useState([]);
  const [index, setIndex] = React.useState(0);
  const [revealed, setRevealed] = React.useState(false);
  const [excerpt, setExcerpt] = React.useState('');

  React.useEffect(() => {
    if (!window.ptor || !window.ptor.vault) return;
    const strengthsP = (window.ptor.corpus && window.ptor.corpus.strengths)
      ? window.ptor.corpus.strengths().catch(() => ({}))
      : Promise.resolve({});
    Promise.all([window.ptor.vault.list(), strengthsP]).then(([res, strengths]) => {
      const list = (res && res.folders) || [];
      setFolders(list);
      const pool = pickDuePool(list);
      // Sort by reinforcement strength ASCENDING — lowest strength = most decayed
      // = most "due to recall". Notes never event-logged fall back to 0.7 baseline
      // (reinforce.js DEFAULT_IMPORTANCE × decay-by-mtime). Replaces Math.random()
      // shuffle: recall now drills into what you're losing grip on, not random
      // sampling. Per ptor2 README atom A3 — agent cite_count counts equal to
      // human verdicts, so notes that the agent fleet actively references stay
      // OFF the recall queue (reinforced = low priority).
      const ranked = pool.slice().sort((a, b) => {
        const sa = strengths && strengths[a.id] != null ? strengths[a.id] : 0.7;
        const sb = strengths && strengths[b.id] != null ? strengths[b.id] : 0.7;
        return sa - sb;
      });
      setQueue(ranked);
      setIndex(0);
      setRevealed(false);
    });
  }, []);

  const current = queue[index];

  const reveal = () => {
    if (!current || revealed) return;
    setRevealed(true);
    if (window.ptor && window.ptor.vault) {
      window.ptor.vault.read(current.id).then(res => {
        setExcerpt(extractExcerpt(res && res.body));
      }).catch(() => {});
    }
  };

  const advance = () => {
    setRevealed(false);
    setExcerpt('');
    setIndex(i => (i + 1) % Math.max(1, queue.length));
  };

  if (folders.length > 0 && queue.length === 0) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 36, textAlign: 'center',
      }}>
        <div style={{
          fontFamily: '"EB Garamond", "Cormorant Garamond", Georgia, serif',
          fontSize: 17, fontStyle: 'italic',
          color: 'var(--ink-muted)',
          maxWidth: '36ch', lineHeight: 1.55,
        }}>
          all notes are fresh — nothing dormant to recall right now.
        </div>
      </div>
    );
  }
  if (!current) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 36 }}>
        <div style={{
          fontFamily: '"EB Garamond", "Cormorant Garamond", Georgia, serif',
          fontSize: 15, fontStyle: 'italic',
          color: 'var(--ink-faint)',
        }}>
          loading recall…
        </div>
      </div>
    );
  }

  const titleDisplay = titleFromLabel(current.label);
  const totalDue = queue.length;

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '40px 32px', overflow: 'auto',
      position: 'relative',
    }}>
      {/* header strip — small, top */}
      <div style={{
        position: 'absolute', top: 24, left: 32,
        display: 'flex', alignItems: 'baseline', gap: 12,
      }}>
        <span style={{
          // Cormorant Garamond smcp — folio counter idiom (real small-caps).
          // See Tabs.jsx TabBarItem for register justification.
          fontFamily: '"Cormorant Garamond", "EB Garamond", Georgia, serif',
          fontFeatureSettings: '"smcp"',
          fontSize: 12,
          letterSpacing: '0.06em',
          color: 'var(--ink-faint)',
        }}>
          recall
        </span>
        <span style={{
          fontFamily: '"Cormorant Garamond", "EB Garamond", Georgia, serif',
          fontFeatureSettings: '"smcp"',
          fontSize: 11.5,
          letterSpacing: '0.04em',
          color: 'var(--ink-faint)',
        }}>
          {index + 1} of {totalDue}
        </span>
      </div>

      {/* the prompt — center stage */}
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 16, maxWidth: 540, textAlign: 'center',
      }}>
        <div style={{
          fontFamily: '"JetBrains Mono", monospace', fontSize: 11,
          letterSpacing: '0.04em', color: 'var(--ink-faint)',
        }}>
          {current.since} ago you wrote
        </div>

        <div style={{
          fontFamily: '"EB Garamond", "Noto Serif SC", "Cormorant Garamond", serif',
          fontStyle: 'normal', fontWeight: 500,
          fontSize: 36, lineHeight: 1.18,
          color: 'var(--ink-title)', letterSpacing: '-0.005em',
          maxWidth: '20ch',
        }}>
          {titleDisplay}
        </div>

        {!revealed && (
          <div style={{
            fontFamily: '"EB Garamond", "Cormorant Garamond", Georgia, serif',
            fontSize: 18, fontStyle: 'italic',
            color: 'var(--ink-muted)',
            marginTop: 14, lineHeight: 1.72,
          }}>
            do you remember what this was about?
          </div>
        )}

        {revealed && excerpt && (
          <div style={{
            fontFamily: '"EB Garamond", "Noto Serif SC", "Cormorant Garamond", Georgia, serif',
            fontSize: 18, lineHeight: 1.72,
            color: 'var(--ink-primary)', marginTop: 16, textAlign: 'left',
            maxWidth: 540,
            paddingTop: 20, borderTop: '1px solid var(--border-hairline)',
          }}>
            {excerpt}
          </div>
        )}

        {/* action row */}
        {!revealed ? (
          <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
            <RecallButton onClick={reveal} variant="primary">reveal</RecallButton>
            <RecallButton onClick={advance}>skip</RecallButton>
            <RecallButton onClick={() => onPick && onPick(current.id)}>open</RecallButton>
          </div>
        ) : (
          <VerdictLedger onCommit={() => advance()} />
        )}

        {revealed && (
          <button
            onClick={() => onPick && onPick(current.id)}
            style={{
              marginTop: 4,
              background: 'transparent', border: 'none', cursor: 'pointer',
              fontFamily: '"JetBrains Mono", monospace', fontSize: 11,
              letterSpacing: '0.06em', color: 'var(--ink-faint)',
              transition: 'color 180ms',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--brass-bright)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-faint)'; }}
          >
            open in full →
          </button>
        )}
      </div>
    </div>
  );
}

function RecallButton({ onClick, variant, children }) {
  const isPrimary = variant === 'primary';
  // Per Muse 2026-04-28 + feedback_brass_default_teal_justify:
  // - drop always-on teal underline (chrome rectangle, web-app register)
  // - primary signaled by type contrast: weight 500 + ink-title vs 400 + ink-muted
  // - hover: color brightens to brass-bright (warm, in-register)
  // - no chrome lines / fills / pills
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 14px', background: 'transparent',
        border: 'none', cursor: 'pointer',
        fontFamily: '"JetBrains Mono", monospace', fontSize: 11.5,
        letterSpacing: '0.06em',
        fontWeight: isPrimary ? 500 : 400,
        color: isPrimary ? 'var(--ink-title)' : 'var(--ink-muted)',
        transition: 'color 180ms',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.color = isPrimary ? 'var(--brass-bright)' : 'var(--ink-title)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.color = isPrimary ? 'var(--ink-title)' : 'var(--ink-muted)';
      }}
    >
      {children}
    </button>
  );
}

// VerdictLedger — 2026-04-28 redesign (Muse + AENY 自批 council-light).
// Previous version had 3-axis change (length + stroke + opacity) + numeric keys
// + mono labels = busy 1990 textbook. New: type IS the data — italic Garamond
// labels increase in size/weight/opacity. One axis (visual weight), one form
// (the word itself). Numeric key bindings still work (1/2/3) but hidden from
// view; tooltip + aria-label expose them.
function VerdictLedger({ onCommit }) {
  const grades = [
    { id: 'forgotten', label: 'forgotten', key: '1', size: 17, weight: 400, opacity: 0.65 },
    { id: 'shaky',     label: 'shaky',     key: '2', size: 20, weight: 400, opacity: 0.85 },
    { id: 'held',      label: 'held',      key: '3', size: 24, weight: 500, opacity: 1.0  },
  ];
  const [hover, setHover] = React.useState(null);

  React.useEffect(() => {
    const onKey = (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (e.key === '1') { e.preventDefault(); onCommit('forgotten'); }
      else if (e.key === '2') { e.preventDefault(); onCommit('shaky'); }
      else if (e.key === '3') { e.preventDefault(); onCommit('held'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCommit]);

  return (
    <div style={{
      display: 'flex', justifyContent: 'center', alignItems: 'baseline',
      gap: 56, marginTop: 36,
    }}>
      {grades.map(g => {
        const hovered = hover === g.id;
        return (
          <button
            key={g.id}
            onClick={() => onCommit(g.id)}
            onMouseEnter={() => setHover(g.id)}
            onMouseLeave={() => setHover(null)}
            aria-label={`${g.label} — press ${g.key}`}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              padding: '6px 8px',
              fontFamily: '"EB Garamond", "Noto Serif SC", "Cormorant Garamond", Georgia, serif',
              fontStyle: 'italic',
              fontSize: g.size,
              fontWeight: g.weight,
              color: hovered ? 'var(--ink-title)' : 'var(--ink-primary)',
              opacity: hovered ? 1 : g.opacity,
              letterSpacing: '0.005em',
              transition: 'opacity 240ms cubic-bezier(0.22,1,0.36,1), color 240ms cubic-bezier(0.22,1,0.36,1)',
            }}
          >{g.label}</button>
        );
      })}
    </div>
  );
}

function VerifyTab({ active, onPick, onBack, viewMode, creatingTopic, setCreatingTopic }) {
  // RECALL = verbatim ptor-design NoteView surface (per 2026-05-01 port plan).
  // EVOLUTION = Hypha lesson-chat polymorphic NoteView.
  if (active && viewMode === 'recall' && window.RecallNoteView) {
    return <window.RecallNoteView rel={active} onBack={onBack} />;
  }
  if (active) return <NoteView rel={active} onBack={onBack} viewMode={viewMode} />;
  if (viewMode === 'evolution') return <HyphaEvolutionWelcome onPick={onPick} creatingTopic={creatingTopic} setCreatingTopic={setCreatingTopic} />;
  return <RecallDashboard onPick={onPick} />;
}

// VinylSpinner — 黑胶 record rotating at 33⅓ rpm (1800ms/rev linear infinite).
// Lifted from PTOR2 DeepenCallout's lacquer-cut disk pattern. Concentric grooves,
// brass label center, dark wax body. Used in welcome 'asking' + 'creating' loading
// states (replaces tiny teal pulse dot — too small for full-page wait).
// spiralPathD — Archimedean spiral, outer→inner. Lifted verbatim from ptor-design
// DeepenCallout.jsx:5 (V3.5 Muse design 2026-04-29). The spiral IS the disk's
// visual identity — needle carves permanent groove outer→inner, register-coherent
// with Hypha's manuscript ink-on-paper substrate (NOT vinyl-playback metaphor).
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

// VinylSpinner — V3.5 Muse lacquer-cut disk (restored from ptor-design 2026-05-01,
// previous concentric-grooves variant deemed cluttered). 88px SVG; spiral cut at
// brass-bright; disk body uses --bg-deepen-disk against atlas/note bg.
//
// Lacquer Loop W7 v1.1 — substrate-driven motion-as-signal:
//   A1 cure-clock (0..1)  → strokeDashoffset (disk etches itself shut as cure advances)
//   A2 delta_norm (0..1)  → rotation duration 1800ms ± 15% (lerp 2200→1500 as delta rises)
//   P-primitive activation→ brass hue temperature shift via filter: hue-rotate (P4-P5 +4°, F1-F3 +8°)
//   motionLevel='quiet'   → no rotation, no a2, no hue shift; A1 fill stays
//   motionLevel='off'     → static disk, full spiral visible
// External `progress` prop (if supplied) overrides A1; existing call sites unchanged.
function VinylSpinner({ stopped, progress }) {
  const sub = (window.RuntimeSubstrate && window.RuntimeSubstrate.useSubstrate)
    ? window.RuntimeSubstrate.useSubstrate()
    : { a1Cure: 0, a2Delta: 0, p: null, motionLevel: 'full' };
  const cutLen = 1300; // empirical for outerR=40 / innerR=20 / turns=12

  // Effective progress: explicit `progress` prop wins (back-compat); else A1 cure.
  const effective = (progress != null)
    ? Math.max(0, Math.min(1, progress))
    : Math.max(0, Math.min(1, sub.a1Cure || 0));
  const offset = cutLen * (1 - effective);

  // Rotation duration — bounded ±15% around 33⅓ rpm (1800ms).
  // a2Delta 0 → 2200ms (slow breath), 1 → 1500ms (taut).
  const fullMotion = sub.motionLevel === 'full' && !stopped;
  const revMs = fullMotion
    ? Math.round(2200 - 700 * Math.max(0, Math.min(1, sub.a2Delta || 0)))
    : 1800;

  // P-primitive brass-temperature shift. Subliminal (1-deg unit barely visible),
  // but glance-readable across primitive transitions.
  const hueShift = (() => {
    if (!fullMotion || !sub.p) return 0;
    if (/^P[45]$/.test(sub.p)) return -4;
    if (/^F[123]$/.test(sub.p)) return -8;
    return 0;
  })();
  const innerOpacity = (fullMotion && /^F[123]$/.test(sub.p || '')) ? 0.45 : 0.30;

  const animation = (sub.motionLevel === 'off' || stopped)
    ? 'none'
    : `hypha-vinyl-spin ${revMs}ms linear infinite`;

  return (
    <div style={{
      width: 88, height: 88,
      animation,
      transformOrigin: '50% 50%',
      filter: stopped
        ? 'grayscale(0.5) opacity(0.7)'
        : (hueShift ? `hue-rotate(${hueShift}deg)` : 'none'),
      transition: 'filter 280ms var(--ease-quiet, cubic-bezier(0.4, 0, 0.2, 1))',
    }}>
      <style>{`
        @keyframes hypha-vinyl-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
          [data-vinyl-disk] { animation: none !important; }
        }
      `}</style>
      <svg
        data-vinyl-disk
        viewBox="-44 -44 88 88" width="88" height="88" aria-hidden="true"
      >
        {/* Disk body — warm-deep espresso (atlas-day mapped via --bg-deepen-disk). */}
        <circle r="42" fill="var(--bg-deepen-disk, #1a0c08)" />
        {/* Outer rim hairline — brass-mid 55%, sets the "lacquer surface" edge. */}
        <circle r="42" fill="none"
          stroke="var(--brass-mid)" strokeWidth="0.75" opacity="0.55" />
        {/* Inner label rim — brass-mid 30% (or 45% on F-primitive activation). */}
        <circle r="18" fill="none"
          stroke="var(--brass-mid)" strokeWidth="0.5" opacity={innerOpacity}
          style={{ transition: 'opacity 280ms var(--ease-quiet, cubic-bezier(0.4, 0, 0.2, 1))' }} />
        {/* The cut — single Archimedean spiral, brass-bright. strokeDashoffset
            fills outer→inner under A1 cure-clock (or explicit progress prop). */}
        <path
          d={spiralPathD(40, 20, 12, 360)}
          fill="none"
          stroke="var(--brass-bright)"
          strokeWidth="0.75"
          strokeLinecap="round"
          opacity="0.92"
          style={{
            strokeDasharray: cutLen,
            strokeDashoffset: offset,
            transition: 'stroke-dashoffset var(--dur-cure, 2400ms) var(--ease-cure, cubic-bezier(0.65, 0.05, 0.36, 1))',
          }}
        />
      </svg>
    </div>
  );
}

// SourceMaterialPicker — drop-or-pick affordance for an optional document
// corpus (PDF / MD / TXT). Lifts the file via electron's native dialog (or
// drag-drop reading the file via webUtils.getPathForFile + the source:extract
// IPC). On extract success, parent gets `{ text, fileName, ext, pageCount,
// chapterCount, chapters }` for plumbing into curriculum:create.
//
// 千金 register: brass-hairline frame at rest, italic Garamond, no chrome.
// At-rest: "drop a PDF · MD · TXT here, or click to choose". Hover/drag-over:
// frame brightens to brass-bright. After upload: filename · chapter count ·
// page count · [×] remove. Errors render inline below in italic red-flag.
function SourceMaterialPicker({ uploadedSource, setUploadedSource, uploadError, setUploadError }) {
  const [dropActive, setDropActive] = React.useState(false);
  const [reading, setReading] = React.useState(false);

  const _extractFromPath = React.useCallback(async (filePath) => {
    if (!filePath) return;
    setReading(true);
    setUploadError(null);
    try {
      const r = await window.ptor.hypha.sourceExtract(filePath);
      if (r && r.ok) {
        setUploadedSource({
          text: r.text,
          fileName: r.fileName,
          ext: r.ext,
          pageCount: r.pageCount,
          chapterCount: r.chapterCount,
          chapters: r.chapters,
        });
      } else {
        setUploadError(r && r.error ? r.error : 'could not read this file');
      }
    } catch (err) {
      setUploadError((err && err.message) || String(err));
    } finally {
      setReading(false);
    }
  }, [setUploadedSource, setUploadError]);

  const onClickPick = React.useCallback(async () => {
    if (reading) return;
    try {
      const r = await window.ptor.hypha.sourcePick();
      if (r && r.ok && r.filePath) await _extractFromPath(r.filePath);
    } catch (_) {}
  }, [reading, _extractFromPath]);

  const onDrop = React.useCallback(async (e) => {
    e.preventDefault();
    setDropActive(false);
    if (reading) return;
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    // Electron exposes the native filesystem path on dropped File objects via
    // webUtils.getPathForFile (Electron 32+) — wrapped in preload as
    // hypha.getDroppedFilePath. Falls back to file.path on older builds.
    let filePath = null;
    try {
      if (window.ptor && window.ptor.hypha && typeof window.ptor.hypha.getDroppedFilePath === 'function') {
        filePath = window.ptor.hypha.getDroppedFilePath(file);
      }
    } catch (_) {}
    if (!filePath) filePath = file.path || null;
    if (!filePath) {
      setUploadError('could not read the dropped file path — try clicking to pick instead');
      return;
    }
    await _extractFromPath(filePath);
  }, [reading, _extractFromPath, setUploadError]);

  const onDragOver = React.useCallback((e) => {
    if (reading) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    setDropActive(true);
  }, [reading]);
  const onDragLeave = React.useCallback((e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDropActive(false);
  }, []);

  if (uploadedSource) {
    // Compact filled-state row.
    return (
      <div style={{ marginBottom: 24 }}>
        <div style={{
          display: 'flex', alignItems: 'baseline', gap: 14,
          padding: '12px 16px',
          background: 'color-mix(in srgb, var(--brass-bright) 10%, transparent)',
          borderRadius: '14px 18px 14px 18px',
          boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--brass-bright) 30%, transparent)',
          fontFamily: '"EB Garamond", Georgia, serif',
        }}>
          <span style={{ color: 'var(--ink-title)', fontSize: 15, fontStyle: 'italic', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {uploadedSource.fileName}
          </span>
          <span style={{ color: 'var(--ink-faint)', fontSize: 13, fontStyle: 'italic' }}>
            {uploadedSource.chapterCount} {uploadedSource.chapterCount === 1 ? 'section' : 'sections'}
            {uploadedSource.ext === 'pdf' && uploadedSource.pageCount > 1 ? ` · ${uploadedSource.pageCount} pages` : ''}
          </span>
          <button
            type="button"
            onClick={() => { setUploadedSource(null); setUploadError(null); }}
            title="remove this source — fall back to web harvest"
            style={{
              background: 'transparent', border: 'none', padding: '0 4px',
              color: 'var(--ink-faint)', cursor: 'pointer',
              fontFamily: 'inherit', fontStyle: 'italic', fontSize: 16,
              transition: 'color 200ms',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--verdict-flag)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-faint)'; }}
          >×</button>
        </div>
      </div>
    );
  }

  // Empty / drop-or-pick state.
  return (
    <div style={{ marginBottom: 24 }}>
      <div
        onClick={onClickPick}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        style={{
          padding: '14px 18px',
          background: dropActive
            ? 'color-mix(in srgb, var(--brass-bright) 14%, transparent)'
            : 'color-mix(in srgb, var(--brass-mid) 8%, transparent)',
          borderRadius: '14px 18px 14px 18px',
          boxShadow: `inset 0 0 0 1px ${dropActive ? 'var(--brass-bright)' : 'color-mix(in srgb, var(--brass-mid) 22%, transparent)'}`,
          fontFamily: '"EB Garamond", Georgia, serif',
          fontStyle: 'italic', fontSize: 15,
          color: dropActive ? 'var(--ink-title)' : 'var(--ink-muted)',
          cursor: reading ? 'progress' : 'pointer',
          opacity: reading ? 0.6 : 1,
          textAlign: 'center',
          transition: 'all 220ms cubic-bezier(0.22, 1, 0.36, 1)',
          userSelect: 'none',
        }}
      >
        {reading
          ? 'reading the document…'
          : (dropActive
              ? 'drop to read'
              : 'drop a PDF · MD · TXT here, or click to choose')}
      </div>
      {uploadError && (
        <div style={{
          marginTop: 8,
          fontFamily: '"EB Garamond", Georgia, serif',
          fontStyle: 'italic', fontSize: 13,
          color: 'var(--verdict-flag)',
        }}>{uploadError}</div>
      )}
    </div>
  );
}

// Hypha welcome — evolution mode default surface. Multi-stage form:
//   phase 'form'    — topic / goal / time fields
//   phase 'asking'  — LLM generating clarifying questions
//   phase 'clarify' — user answers bubble-style multi-choice
//   phase 'creating'— curriculum:create running (harvest + design + write stubs)
function HyphaEvolutionWelcome({ onPick, creatingTopic, setCreatingTopic }) {
  // v0.4.4 — initial phase derives from hoisted creatingTopic so re-mounting
  // (after a colophon visit) preserves the creating-state UI.
  const [phase, setPhase] = React.useState(creatingTopic ? 'creating' : 'form'); // 'form' | 'asking' | 'clarify' | 'gate' | 'creating'
  const [topic, setTopic] = React.useState(creatingTopic || '');
  const [goal, setGoal] = React.useState('');
  const [timeCommit, setTimeCommit] = React.useState('month'); // 'week' | 'month' | 'two-month' | 'quarter' | 'open' | 'custom'
  const [customLessons, setCustomLessons] = React.useState(50);  // 1-200 when timeCommit==='custom'
  // v0.6.0 — tier picker (gentle / moderate / heroic). Default 'moderate' so
  // existing behavior is unchanged (multiplier = 1.0×). Passed to curriculum
  // create; agent.computePhaseLessonCounts applies multiplier.
  const [tier, setTier] = React.useState('moderate'); // 'gentle' | 'moderate' | 'heroic'
  // v0.5.0 — optional uploaded source corpus (PDF/MD/TXT). When non-null, the
  // curriculum is built from this document instead of web harvest.
  const [uploadedSource, setUploadedSource] = React.useState(null);
  const [uploadError, setUploadError] = React.useState(null);
  const [status, setStatus] = React.useState(null);
  // Clarification stage state.
  const [questions, setQuestions] = React.useState([]); // [{id, question, options[], multiSelect, allowOther}]
  const [answers, setAnswers] = React.useState({});     // { questionId: string | string[] (selected option ids OR 'OTHER:<text>') }
  const [otherDrafts, setOtherDrafts] = React.useState({}); // { questionId: text }
  const [clarifyError, setClarifyError] = React.useState(null);
  // Smart Gate (council 2026-05-01 option B) — interrupt curriculum-create if
  // feasibility tier is nearly-impossible. User chooses 硬刚 / 看推荐 / 改目标.
  const [gateResult, setGateResult] = React.useState(null);   // { feasibility, prior, intrinsic, difficulty, timeWeeks, clarifications }
  const [gateMode, setGateMode] = React.useState('decide');   // 'decide' | 'proposing' | 'chain-shown'
  const [proposedChain, setProposedChain] = React.useState(null);

  // Subscribe to curriculum:progress events so user sees harvest stages.
  // Also feed RuntimeSubstrate.a1Cure so VinylSpinner etches in time with
  // pipeline progress (motion-as-signal — see flickering-tickling-koala plan).
  const CURRICULUM_STAGE_CURE = {
    'reading-source': 0.10,
    'harvesting': 0.15,
    'designing': 0.55,
    'writing-lessons': 0.85,
    'done': 1.0,
    'error': 0,
  };
  // 2026-05-01 — designing heartbeat. Server emits 'designing-heartbeat'
  // every 5s during the LLM call; we surface the elapsed counter in the
  // status line so user can tell the call is alive even when it's slow.
  const [elapsedSec, setElapsedSec] = React.useState(0);
  // v0.6.0 — harvestStatus extends v0.5.2's harvest-thin signal. Now ALWAYS
  // surfaces a per-channel breakdown during the creating phase (not only when
  // total < 5). `fired:true` once the harvest_complete event has arrived so
  // we can ALSO drive the Tavily-onboarding nudge (web channel = 0 + no key).
  // null until first event; reset on phase transitions.
  const [harvestStatus, setHarvestStatus] = React.useState(null);
  // v0.6.0 — Tavily key presence drives onboarding nudge. Default true so we
  // do not flash the nudge before settings load resolves.
  const [hasTavilyKey, setHasTavilyKey] = React.useState(true);
  // v0.6.0 — placement probe state. probeStage is the renderer's source of
  // truth for the inline panel; questions hold `correct` flags for client-side
  // grading (we strip the flag from the visible labels but keep it in state).
  const [probeStage, setProbeStage] = React.useState(null); // null | 'loading' | 'questions' | 'submitted'
  const [probeQuestions, setProbeQuestions] = React.useState([]); // [{id, q, options:[{id,label,correct}], rationale}]
  const [probeAnswers, setProbeAnswers] = React.useState({}); // { questionId: optionId }
  const [probeResult, setProbeResult] = React.useState(null); // { score, band, correctCount, total }
  const [probeError, setProbeError] = React.useState(null);
  React.useEffect(() => {
    if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.onCurriculumProgress) return;
    const off = window.ptor.hypha.onCurriculumProgress((p) => {
      if (!p || !p.stage) return;
      // Heartbeat just updates the elapsed counter without flipping `status`.
      if (p.stage === 'designing-heartbeat') {
        setElapsedSec(Number(p.elapsed) || 0);
        return;
      }
      // Harvest-complete telemetry — v0.6.0 always-on per-channel preview.
      // Renderer below colors the banner amber when totalUseful < 5; we keep
      // the full perChannel snapshot so the Tavily onboarding nudge can fire
      // when web.n === 0 + no key configured.
      if (p.stage === 'harvest_complete') {
        const total = Number(p.totalUseful);
        const perChannel = p.perChannel || {
          github: { n: 0 }, hn: { n: 0 }, arxiv: { n: 0 }, web: { n: 0 },
        };
        setHarvestStatus({
          totalUseful: Number.isFinite(total) ? total : 0,
          perChannel,
          fired: true,
        });
        return; // not a real status flip
      }
      // Real stage change. Reset elapsed when leaving 'designing'.
      setStatus(p.stage);
      if (p.stage !== 'designing') setElapsedSec(0);
      if (window.RuntimeSubstrate && CURRICULUM_STAGE_CURE[p.stage] !== undefined) {
        window.RuntimeSubstrate.set({ a1Cure: CURRICULUM_STAGE_CURE[p.stage] });
      }
    });
    return () => {
      if (typeof off === 'function') off();
      if (window.RuntimeSubstrate) window.RuntimeSubstrate.set({ a1Cure: 0 });
    };
  }, []);

  // v0.6.0 — pull settings on mount so we know whether the Tavily key is
  // configured. Drives the onboarding nudge logic (web channel = 0 + no key).
  // Falls open (assume key present) on any error so we never falsely scold
  // the user about a missing key when settings IPC is unavailable.
  React.useEffect(() => {
    let alive = true;
    if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.settingsGet) return;
    window.ptor.hypha.settingsGet()
      .then((s) => { if (alive) setHasTavilyKey(!!(s && s.tavilyKey)); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // v0.6.0 — tier multiplier helper. Mirrors agent.computePhaseLessonCounts
  // server-side; renderer uses it for the scope-coverage % display only.
  const tierMultiplier = (t) => {
    if (t === 'gentle') return 0.6;
    if (t === 'heroic') return 1.6;
    return 1.0;
  };

  // 2026-05-01 — depth-first totals (user pushback: 3 months ≥ 100 lessons).
  // Custom slot lets the user override anywhere in 1-200.
  const TIME_OPTIONS = [
    { id: 'week',      label: 'a week',     sub: '6 lessons · curiosity dive' },
    { id: 'month',     label: 'a month',    sub: '35 lessons · working understanding' },
    { id: 'two-month', label: '2 months',   sub: '70 lessons · substantial' },
    { id: 'quarter',   label: '3 months',   sub: '100 lessons · deep traversal' },
    { id: 'custom',    label: 'custom',     sub: 'you choose · 1-200' },
  ];

  // Stage 1 → 2 transition. Submit form, request clarifying questions.
  const submitForm = React.useCallback(async () => {
    const t = (topic || '').trim();
    if (!t || !window.ptor || !window.ptor.hypha) return;
    setPhase('asking');
    setClarifyError(null);
    try {
      const r = await window.ptor.hypha.curriculumClarify({
        topic: t, goal: (goal || '').trim(), timeCommit,
      });
      if (r && r.ok && Array.isArray(r.questions) && r.questions.length > 0) {
        setQuestions(r.questions);
        // Pre-init answers map.
        const init = {};
        r.questions.forEach(q => { init[q.id] = q.multiSelect ? [] : null; });
        setAnswers(init);
        setPhase('clarify');
      } else {
        // No questions or empty — skip directly to creating.
        if (r && !r.ok) setClarifyError(r.error || 'failed to fetch questions');
        startCreate([]);
      }
    } catch (err) {
      setClarifyError((err && err.message) || String(err));
      setPhase('form');
    }
  }, [topic, goal, timeCommit]);

  // Stage 2 → 3 transition. With user's answers, kick off curriculum:create.
  const [createError, setCreateError] = React.useState(null);
  const startCreate = React.useCallback(async (clarifications) => {
    const t = (topic || '').trim();
    if (!t || !window.ptor || !window.ptor.hypha) return;
    setPhase('creating');
    setStatus('harvesting');
    setCreateError(null);
    setHarvestStatus(null);                     // reset banner for fresh run
    if (typeof setCreatingTopic === 'function') setCreatingTopic(t);
    try {
      const r = await window.ptor.hypha.curriculumCreate(t, 'intermediate', {
        goal: (goal || '').trim(),
        timeCommit: timeCommit,
        customLessons: timeCommit === 'custom' ? Math.max(1, Math.min(200, Number(customLessons) || 50)) : null,
        tier: tier,                       // v0.6.0 — gentle / moderate / heroic; multiplier applied server-side
        clarifications: clarifications,
        uploadedSource: uploadedSource,   // v0.5.0 — null when user did not pick a file
      });
      if (r && r.ok && r.lessonRels && r.lessonRels[0]) {
        setStatus(null);
        setHarvestStatus(null);
        setTopic('');
        setGoal('');
        setUploadedSource(null);
        setUploadError(null);
        setQuestions([]);
        setAnswers({});
        if (typeof setCreatingTopic === 'function') setCreatingTopic(null);
        if (typeof onPick === 'function') onPick(r.lessonRels[0]);
      } else if (r && r.cancelled) {
        // User pressed ESC — silent reset to fresh form, don't show error.
        setStatus(null);
        setHarvestStatus(null);
        setPhase('form');
        if (typeof setCreatingTopic === 'function') setCreatingTopic(null);
      } else {
        setStatus('error');
        setHarvestStatus(null);
        setCreateError((r && r.error) || 'unknown error');
        if (typeof setCreatingTopic === 'function') setCreatingTopic(null);
      }
    } catch (err) {
      setStatus('error');
      setHarvestStatus(null);
      setCreateError((err && err.message) || String(err));
      if (typeof setCreatingTopic === 'function') setCreatingTopic(null);
    }
  }, [topic, goal, timeCommit, customLessons, tier, uploadedSource, onPick, setCreatingTopic]);

  // v0.4.4 — listen for global cancel event from App's ESC handler. Optimistic
  // reset of UI; backend cleanup runs in parallel (curriculum:cancel deletes
  // any partial slug + signals the in-flight create handler to bail).
  React.useEffect(() => {
    const onCancel = (e) => {
      const t = (e && e.detail && e.detail.topic) || creatingTopic;
      if (!t) return;
      setPhase('form');
      setStatus(null);
      setHarvestStatus(null);
      setCreateError(null);
      if (typeof setCreatingTopic === 'function') setCreatingTopic(null);
      try {
        if (window.ptor && window.ptor.hypha && window.ptor.hypha.curriculumCancel) {
          window.ptor.hypha.curriculumCancel(t);
        }
      } catch (_) {}
    };
    window.addEventListener('hypha:cancel-create', onCancel);
    return () => window.removeEventListener('hypha:cancel-create', onCancel);
  }, [creatingTopic, setCreatingTopic]);

  // Build clarifications payload from answers map and dispatch.
  const submitClarify = React.useCallback(() => {
    const payload = questions.map(q => {
      let a = answers[q.id];
      if (q.multiSelect) {
        const arr = Array.isArray(a) ? a : [];
        const labels = arr.map(id => {
          if (id && id.startsWith('OTHER:')) return id.slice(6);
          const opt = q.options.find(o => o.id === id);
          return opt ? opt.label : id;
        });
        return { id: q.id, question: q.question, answer: labels.length > 0 ? labels : ['Decide for me'] };
      }
      if (!a) return { id: q.id, question: q.question, answer: 'Decide for me' };
      if (a.startsWith('OTHER:')) return { id: q.id, question: q.question, answer: a.slice(6) };
      const opt = q.options.find(o => o.id === a);
      return { id: q.id, question: q.question, answer: opt ? opt.label : a };
    });
    runGateThenCreate(payload);
  }, [questions, answers]);

  const skipClarify = React.useCallback(() => {
    runGateThenCreate([]);  // empty array = no preferences, LLM uses topic+goal only
  }, []);

  // Smart Gate flow: between clarify-done and curriculum-create, run cheap
  // feasibility classifiers. tier=nearly-impossible → interrupt with 3 paths.
  // Otherwise proceed to curriculum:create directly.
  const runGateThenCreate = React.useCallback(async (clarifications) => {
    const t = (topic || '').trim();
    if (!t || !window.ptor || !window.ptor.hypha) return;
    if (!window.ptor.hypha.feasibilityGate) {
      // Old IPC binding (no gate available) — fall through to direct create.
      startCreate(clarifications); return;
    }
    setPhase('asking'); // reuse spinner; status copy distinguishes
    setStatus('gating');
    try {
      const r = await window.ptor.hypha.feasibilityGate({
        topic: t, goal: (goal || '').trim(), timeCommit, answers: clarifications,
      });
      if (r && r.ok && r.feasibility && r.feasibility.tier === 'nearly-impossible') {
        setGateResult({ ...r, clarifications });
        setGateMode('decide');
        setProposedChain(null);
        setPhase('gate');
        setStatus(null);
        return;
      }
    } catch (_) { /* gate fail = proceed silently */ }
    startCreate(clarifications);
  }, [topic, goal, timeCommit]);

  // Gate handlers — 3 paths after nearly-impossible verdict.
  const gateAcceptHardMode = React.useCallback(() => {
    // 硬刚 — user accepts the steep path; proceed as originally planned.
    if (!gateResult) return;
    const cl = gateResult.clarifications;
    setGateResult(null);
    setProposedChain(null);
    startCreate(cl);
  }, [gateResult, startCreate]);

  const gateRequestChain = React.useCallback(async () => {
    if (!gateResult || !window.ptor || !window.ptor.hypha || !window.ptor.hypha.chainProposePrereqs) return;
    setGateMode('proposing');
    try {
      const r = await window.ptor.hypha.chainProposePrereqs({
        topic: (topic || '').trim(),
        goal: (goal || '').trim(),
        gateResult,
      });
      if (r && r.ok && r.chain && r.chain.links && r.chain.links.length) {
        setProposedChain(r.chain);
        setGateMode('chain-shown');
      } else {
        setGateMode('decide');
      }
    } catch (_) { setGateMode('decide'); }
  }, [gateResult, topic, goal]);

  const gatePickChainLink = React.useCallback((link) => {
    // User picked a prerequisite link — that link's topic becomes the new
    // curriculum topic. Time-commit may shrink (link.duration_weeks).
    if (!link || !link.topic) return;
    setTopic(link.topic);
    // Map duration_weeks to nearest timeCommit bucket.
    const w = Number(link.duration_weeks) || 4;
    const bucket = w <= 2 ? 'week' : w <= 6 ? 'month' : w <= 16 ? 'quarter' : 'open';
    setTimeCommit(bucket);
    setGateResult(null);
    setProposedChain(null);
    setQuestions([]);
    setAnswers({});
    setPhase('form');  // user can review + submit again
  }, []);

  const gateChangeGoal = React.useCallback(() => {
    setGateResult(null);
    setProposedChain(null);
    setQuestions([]);
    setAnswers({});
    setPhase('form');  // back to fresh form
  }, []);

  const toggleOption = (qid, optId, multi) => {
    setAnswers(a => {
      if (!multi) return { ...a, [qid]: a[qid] === optId ? null : optId };
      const cur = Array.isArray(a[qid]) ? a[qid] : [];
      const next = cur.includes(optId) ? cur.filter(x => x !== optId) : [...cur, optId];
      return { ...a, [qid]: next };
    });
  };

  const setOther = (qid, text, multi) => {
    setOtherDrafts(d => ({ ...d, [qid]: text }));
    if (!text.trim()) {
      // Clear OTHER from answers
      setAnswers(a => {
        if (multi) {
          const cur = Array.isArray(a[qid]) ? a[qid] : [];
          return { ...a, [qid]: cur.filter(x => !x.startsWith('OTHER:')) };
        }
        return { ...a, [qid]: a[qid] && a[qid].startsWith('OTHER:') ? null : a[qid] };
      });
      return;
    }
    setAnswers(a => {
      if (multi) {
        const cur = Array.isArray(a[qid]) ? a[qid] : [];
        const filtered = cur.filter(x => !x.startsWith('OTHER:'));
        return { ...a, [qid]: [...filtered, 'OTHER:' + text] };
      }
      return { ...a, [qid]: 'OTHER:' + text };
    });
  };

  // v0.6.0 — placement probe: 5 calibrated MCQs replace the prose self-intro
  // as the primary baseline signal for classifyPriorKnowledge. Inline panel
  // (NOT a modal) so the welcome flow stays continuous.
  const openProbe = React.useCallback(async () => {
    const t = (topic || '').trim();
    if (!t || !window.ptor || !window.ptor.hypha || !window.ptor.hypha.profileProbe) {
      setProbeError('probe not available');
      return;
    }
    setProbeStage('loading');
    setProbeError(null);
    setProbeResult(null);
    setProbeAnswers({});
    try {
      const r = await window.ptor.hypha.profileProbe({ topic: t, goal: (goal || '').trim() });
      if (r && r.ok && Array.isArray(r.questions) && r.questions.length > 0) {
        setProbeQuestions(r.questions.slice(0, 5));
        setProbeStage('questions');
      } else {
        setProbeStage(null);
        setProbeError((r && r.error) || 'no questions returned');
      }
    } catch (err) {
      setProbeStage(null);
      setProbeError((err && err.message) || String(err));
    }
  }, [topic, goal]);

  const cancelProbe = React.useCallback(() => {
    setProbeStage(null);
    setProbeQuestions([]);
    setProbeAnswers({});
    setProbeResult(null);
    setProbeError(null);
  }, []);

  const pickProbeOption = React.useCallback((qid, optId) => {
    setProbeAnswers((a) => ({ ...a, [qid]: optId }));
  }, []);

  const submitProbe = React.useCallback(async () => {
    if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.profileProbeSubmit) {
      setProbeError('submit not available');
      return;
    }
    const t = (topic || '').trim();
    // Self-grade: renderer holds the `correct` flags in probeQuestions; build
    // the answers payload with isCorrect tallied client-side so the backend
    // tally is a pure sum (no LLM, no re-fetch of questions).
    const answers = probeQuestions.map((q) => {
      const optionId = probeAnswers[q.id] || null;
      const opt = (q.options || []).find((o) => o.id === optionId);
      return {
        questionId: q.id,
        optionId,
        correct: !!(opt && opt.correct === true),
      };
    });
    setProbeError(null);
    try {
      const r = await window.ptor.hypha.profileProbeSubmit({
        topic: t, goal: (goal || '').trim(), answers,
      });
      if (r && r.ok) {
        setProbeResult({
          score: Number(r.score) || 0,
          band: r.band || 'foundational',
          correctCount: Number(r.correctCount) || 0,
          total: Number(r.total) || answers.length,
        });
        setProbeStage('submitted');
      } else {
        setProbeError((r && r.error) || 'submit failed');
      }
    } catch (err) {
      setProbeError((err && err.message) || String(err));
    }
  }, [topic, goal, probeQuestions, probeAnswers]);

  const statusLine = (() => {
    switch (status) {
      case 'reading-source': return uploadedSource
        ? `reading ${uploadedSource.fileName}…`
        : 'reading the document…';
      case 'harvesting': return 'gathering sources from the better parts of the web…';
      case 'designing': {
        // v0.4.0 — three-stage pipeline. Wall time target ≤ 15s. After
        // 30s we hint at patience; hard ceiling per stage in agent.js.
        const base = 'seeding the curriculum';
        if (elapsedSec >= 30) return `${base} — still arranging at ${elapsedSec}s…`;
        if (elapsedSec >= 5)  return `${base}… ${elapsedSec}s`;
        return `${base}…`;
      }
      case 'writing-lessons': return 'placing the first lesson…';
      case 'error': return createError
        ? `failed — ${createError.slice(0, 200)}`
        : 'couldn\'t begin — check api key in settings and try again.';
      default: return '';
    }
  })();

  // Phase-driven header copy.
  const headerCopy = (() => {
    if (phase === 'form')     return { title: 'what would you like to learn?', sub: 'Type a topic. Hypha gathers from the better parts of the web — universities of consequence, code that earned its stars, frontier discussions — and arranges a sequence of conversations.' };
    if (phase === 'asking' && status === 'gating') return { title: 'estimating feasibility…', sub: 'a quick check before we commit your time — comparing your starting point to the goal.' };
    if (phase === 'asking')   return { title: 'thinking up the right questions…', sub: 'A few targeted questions, then your course of conversations.' };
    if (phase === 'gate')     return { title: '判定：几乎不可能', sub: 'time and target are mismatched — pick a path before we commit.' };
    if (phase === 'clarify')  return { title: 'a few questions before we begin', sub: 'Your answers shape the curriculum. Pick a bubble or "Decide for me".' };
    // 2026-05-01 — sub cleared during creating; the spinner-adjacent render
    // below already shows statusLine. Two simultaneous "arranging…" lines
    // (one in header, one under spinner) was a real-screenshot bug.
    if (phase === 'creating') return { title: topic, sub: '' };
    return { title: '', sub: '' };
  })();

  return (
    <div style={{
      // 2026-05-01 bug fix: justifyContent:'center' + overflow:'auto' ate the
      // top of clarify-phase content (long bubble lists pushed above scroll
      // origin = unreachable). Switched to top-anchored flow; padding gives
      // the form-phase its visual breathing room at the top instead of
      // mathematical centering.
      flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start',
      padding: '12vh 48px 8vh', minHeight: 0, overflow: 'auto',
      fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
    }}>
      {/* Lung-Muse synthesis bubble animation: one-shot bell ring on selection.
          The ring is a separate ::after pseudo that expands + fades — only fires on
          .hypha-bubble--on application, never reverses (rings don't un-strike).
          De-selection = calm color/bg/shadow rollback only. */}
      <style>{`
        .hypha-bubble {
          isolation: isolate;
        }
        .hypha-bubble::after {
          content: '';
          position: absolute;
          inset: 0;
          border-radius: inherit;
          pointer-events: none;
          box-shadow: 0 0 0 0 transparent;
          opacity: 0;
        }
        .hypha-bubble--on {
          animation: hypha-bell-ring 520ms cubic-bezier(0, 0.6, 0.4, 1) 1;
        }
        @keyframes hypha-bell-ring {
          0%   { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--brass-mid) 32%, transparent), 0 0 0 0 color-mix(in srgb, var(--brass-bright) 56%, transparent); }
          8%   { box-shadow: inset 0 0 0 1.5px var(--brass-bright), 0 0 0 0 color-mix(in srgb, var(--brass-bright) 56%, transparent); }
          18%  { box-shadow: inset 0 0 0 1.5px var(--brass-bright), 0 0 0 4px color-mix(in srgb, var(--brass-bright) 0%, transparent); }
          100% { box-shadow: inset 0 0 0 1.5px var(--brass-bright), inset 0 1px 0 color-mix(in srgb, var(--brass-bright) 36%, transparent); }
        }
        @media (prefers-reduced-motion: reduce) {
          .hypha-bubble--on { animation: none; }
        }
        /* v0.6.0 — probe submitted ack: hairline appearance animation.
           Subtle fade + lift, no scale on the box (avoids layout-shift). */
        @keyframes hypha-probe-ack {
          0%   { opacity: 0; transform: translateY(-4px); }
          100% { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <div style={{ maxWidth: 720, width: '100%', textAlign: 'center' }}>
        <h1 style={{
          fontStyle: 'italic', fontWeight: 400, fontSize: 'clamp(28px, 3.6vw, 38px)',
          lineHeight: 1.2, color: 'var(--ink-title)', margin: '0 0 18px',
          letterSpacing: '-0.005em',
        }}>{headerCopy.title}</h1>
        <p style={{
          fontStyle: 'italic', fontWeight: 400, fontSize: 17, lineHeight: 1.6,
          color: 'var(--ink-muted)', margin: '0 0 40px',
          maxWidth: 540, marginLeft: 'auto', marginRight: 'auto',
        }}>{headerCopy.sub}</p>

        {/* Phase: FORM ─────────────────────────────────────────────────── */}
        {phase === 'form' && (
          <div style={{ maxWidth: 560, marginLeft: 'auto', marginRight: 'auto', textAlign: 'left' }}>
            <label style={{
              display: 'block', fontFamily: '"Cormorant Garamond", "EB Garamond", Georgia, serif',
              fontWeight: 500, fontSize: 13, letterSpacing: '0.16em', textTransform: 'uppercase',
              color: 'var(--ink-faint)', marginBottom: 8,
            }}>topic</label>
            {/* intentional-placeholder: real HTML input placeholder attribute, not a stub */}
            <input
              autoFocus
              value={topic}
              placeholder="e.g. transformer architecture, music of Bach, postwar Tokyo…"
              onChange={e => setTopic(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitForm(); }}
              style={{
                width: '100%', background: 'color-mix(in srgb, var(--brass-mid) 10%, transparent)',
                color: 'var(--ink-title)', border: 'none',
                borderRadius: '18px 14px 18px 14px',
                padding: '14px 18px', marginBottom: 24,
                fontFamily: 'inherit', fontStyle: 'italic', fontSize: 18,
                outline: 'none',
                boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--brass-mid) 22%, transparent)',
              }}
            />

            <label style={{
              display: 'block', fontFamily: '"Cormorant Garamond", "EB Garamond", Georgia, serif',
              fontWeight: 500, fontSize: 13, letterSpacing: '0.16em', textTransform: 'uppercase',
              color: 'var(--ink-faint)', marginBottom: 8,
            }}>your goal</label>
            {/* intentional-placeholder: textarea hint copy */}
            <textarea
              value={goal}
              placeholder="what would you do with this knowledge?  e.g. build a small one from scratch, write a substack post on it, prepare for an interview, satisfy a curiosity…"
              onChange={e => setGoal(e.target.value)}
              rows={3}
              style={{
                width: '100%', background: 'color-mix(in srgb, var(--brass-mid) 10%, transparent)',
                color: 'var(--ink-title)', border: 'none',
                borderRadius: '14px 18px 14px 18px',
                padding: '14px 18px', marginBottom: 8,
                fontFamily: 'inherit', fontStyle: 'italic', fontSize: 16,
                lineHeight: 1.5,
                outline: 'none',
                resize: 'vertical', minHeight: 70, maxHeight: 200,
                boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--brass-bright) 22%, transparent)',
              }}
            />

            {/* v0.6.0 — placement-probe CTA. Only shows once a topic exists
                (otherwise we have nothing to probe against). 5-MCQ inline
                panel replaces the prose self-intro as the primary baseline
                signal — see TEAM-D classifyPriorKnowledge prompt update. */}
            {topic.trim() && probeStage === null && (
              <div style={{
                marginBottom: 24, fontStyle: 'italic', fontSize: 13,
                color: 'var(--ink-faint)', lineHeight: 1.55,
              }}>
                {probeResult ? (
                  <span>
                    baseline updated · {probeResult.band} ({Math.round(probeResult.score * 100)}%) ·{' '}
                    <button
                      type="button"
                      onClick={openProbe}
                      style={{
                        background: 'transparent', border: 'none', padding: 0,
                        font: 'inherit', fontStyle: 'italic',
                        color: 'var(--brass-bright)', cursor: 'pointer',
                        borderBottom: '1px solid transparent',
                        transition: 'border-color 200ms',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.borderBottomColor = 'var(--brass-bright)'; }}
                      onMouseLeave={e => { e.currentTarget.style.borderBottomColor = 'transparent'; }}
                    >re-take →</button>
                  </span>
                ) : (
                  <span>
                    not sure how much you already know?{' '}
                    <button
                      type="button"
                      onClick={openProbe}
                      style={{
                        background: 'transparent', border: 'none', padding: 0,
                        font: 'inherit', fontStyle: 'italic',
                        color: 'var(--brass-bright)', cursor: 'pointer',
                        borderBottom: '1px solid transparent',
                        transition: 'border-color 200ms',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.borderBottomColor = 'var(--brass-bright)'; }}
                      onMouseLeave={e => { e.currentTarget.style.borderBottomColor = 'transparent'; }}
                    >sharpen your baseline · 5 questions →</button>
                  </span>
                )}
                {probeError && (
                  <span style={{ color: 'var(--verdict-flag)', marginLeft: 8 }}>· {probeError}</span>
                )}
              </div>
            )}

            {/* Probe loading — VinylSpinner + breath copy, identical visual
                language as ASKING phase so the loading state feels "of a
                piece" with the rest of the welcome flow. */}
            {probeStage === 'loading' && (
              <div style={{
                marginBottom: 24,
                padding: '20px 18px',
                background: 'color-mix(in srgb, var(--brass-mid) 8%, transparent)',
                borderRadius: '14px 18px 14px 18px',
                boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--brass-mid) 18%, transparent)',
                display: 'flex', alignItems: 'center', gap: 18,
              }}>
                <VinylSpinner />
                <p className="hypha-breath" style={{
                  fontStyle: 'italic', fontSize: 14, color: 'var(--ink-muted)', margin: 0, lineHeight: 1.5,
                }}>drafting 5 calibrated questions for your topic…</p>
              </div>
            )}

            {/* Probe questions — 5 MCQs in a hairline-framed panel. Each
                question is one row with the prompt + 4 option buttons, all
                in the existing 千金 register. We strip the `correct` flag
                from button labels — only the renderer's state knows answers
                until submit, when we self-grade and POST tallied results. */}
            {probeStage === 'questions' && probeQuestions.length > 0 && (
              <div style={{
                marginBottom: 24,
                padding: '18px 20px',
                background: 'color-mix(in srgb, var(--brass-mid) 6%, transparent)',
                borderRadius: '14px 18px 14px 18px',
                boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--brass-mid) 22%, transparent)',
              }}>
                <div style={{
                  fontFamily: '"Cormorant Garamond", "EB Garamond", Georgia, serif',
                  fontWeight: 500, fontSize: 12, letterSpacing: '0.16em',
                  textTransform: 'uppercase', color: 'var(--ink-faint)',
                  marginBottom: 14,
                }}>placement probe · 5 questions</div>
                {probeQuestions.map((q, qi) => {
                  const picked = probeAnswers[q.id];
                  return (
                    <div key={q.id || qi} style={{ marginBottom: qi === probeQuestions.length - 1 ? 6 : 18 }}>
                      <div style={{
                        fontFamily: 'inherit', fontSize: 15.5,
                        color: 'var(--ink-title)', marginBottom: 8, lineHeight: 1.5,
                      }}>{qi + 1}. {q.q || q.question}</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        {(q.options || []).map((opt) => {
                          const on = picked === opt.id;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() => pickProbeOption(q.id, opt.id)}
                              style={{
                                background: on ? 'color-mix(in srgb, var(--brass-bright) 18%, transparent)' : 'transparent',
                                border: 'none',
                                borderRadius: '12px 8px 12px 8px',
                                boxShadow: on
                                  ? 'inset 0 0 0 1.5px var(--brass-bright)'
                                  : 'inset 0 0 0 1px color-mix(in srgb, var(--brass-mid) 30%, transparent)',
                                color: on ? 'var(--ink-title)' : 'var(--ink-muted)',
                                fontFamily: 'inherit', fontStyle: 'italic',
                                fontSize: 14, padding: '7px 13px',
                                cursor: 'pointer',
                                transition:
                                  'background 240ms cubic-bezier(0.4, 0, 0.15, 1), ' +
                                  'color 220ms cubic-bezier(0.3, 0.7, 0.2, 1), ' +
                                  'box-shadow 200ms cubic-bezier(0.2, 0.7, 0.2, 1)',
                              }}
                              onMouseEnter={e => { if (!on) e.currentTarget.style.color = 'var(--ink-title)'; }}
                              onMouseLeave={e => { if (!on) e.currentTarget.style.color = 'var(--ink-muted)'; }}
                            >{opt.label}</button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
                {(() => {
                  const allAnswered = probeQuestions.length > 0 && probeQuestions.every(q => !!probeAnswers[q.id]);
                  return (
                    <div style={{
                      marginTop: 16, display: 'flex', alignItems: 'center', gap: 12,
                    }}>
                      <button
                        type="button"
                        onClick={cancelProbe}
                        style={{
                          background: 'transparent', border: 'none', padding: 0,
                          font: 'inherit', fontStyle: 'italic', fontSize: 13,
                          color: 'var(--ink-faint)', cursor: 'pointer',
                          borderBottom: '1px solid transparent',
                          transition: 'border-color 200ms, color 200ms',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.color = 'var(--ink-muted)'; }}
                        onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-faint)'; }}
                      >cancel</button>
                      <div style={{ flex: 1 }} />
                      <button
                        type="button"
                        onClick={submitProbe}
                        disabled={!allAnswered}
                        style={{
                          background: allAnswered ? 'color-mix(in srgb, var(--brass-bright) 22%, transparent)' : 'transparent',
                          border: '1px solid ' + (allAnswered ? 'var(--brass-bright)' : 'color-mix(in srgb, var(--brass-mid) 28%, transparent)'),
                          borderRadius: '12px 8px 12px 8px',
                          color: allAnswered ? 'var(--ink-title)' : 'var(--ink-faint)',
                          fontFamily: 'inherit', fontStyle: 'italic',
                          fontSize: 14, padding: '8px 18px',
                          cursor: allAnswered ? 'pointer' : 'not-allowed',
                          opacity: allAnswered ? 1 : 0.55,
                          transition: 'all 220ms cubic-bezier(0.22, 1, 0.36, 1)',
                        }}
                      >submit baseline →</button>
                    </div>
                  );
                })()}
                {probeError && (
                  <div style={{ marginTop: 10, fontStyle: 'italic', fontSize: 13, color: 'var(--verdict-flag)' }}>
                    {probeError}
                  </div>
                )}
              </div>
            )}

            {/* Probe submitted — subtle hairline ack. Auto-collapses 1.6s
                after appearing (handled below in an effect-light pattern)
                so the form doesn't carry a stale verdict forever. */}
            {probeStage === 'submitted' && probeResult && (
              <div
                style={{
                  marginBottom: 24,
                  padding: '12px 16px',
                  background: 'color-mix(in srgb, var(--brass-bright) 8%, transparent)',
                  borderRadius: '12px 16px 12px 16px',
                  boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--brass-bright) 30%, transparent)',
                  fontFamily: 'inherit', fontStyle: 'italic', fontSize: 14,
                  color: 'var(--ink-title)', lineHeight: 1.5,
                  animation: 'hypha-probe-ack 460ms cubic-bezier(0.22, 1, 0.36, 1) 1',
                }}
              >
                baseline updated · {probeResult.band} ({Math.round(probeResult.score * 100)}%) ·{' '}
                <button
                  type="button"
                  onClick={() => { setProbeStage(null); }}
                  style={{
                    background: 'transparent', border: 'none', padding: 0,
                    font: 'inherit', fontStyle: 'italic',
                    color: 'var(--ink-faint)', cursor: 'pointer',
                    marginLeft: 4,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.color = 'var(--ink-muted)'; }}
                  onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-faint)'; }}
                >dismiss</button>
              </div>
            )}

            {/* In-flow chain planner link. Per user 2026-05-01: chain is a
                RESULT computed from welcome-form data, not a separate
                questionnaire. We dispatch the form context (topic + goal +
                timeCommit) so ChainPlannerView opens straight into loading
                with no fields to fill. App.jsx mounts the modal at root to
                escape any stacking trap. Button disabled until at least
                topic OR goal has a value (otherwise nothing to chain). */}
            <div style={{
              marginBottom: 24,
              fontFamily: 'inherit', fontStyle: 'italic', fontSize: 13,
              color: 'var(--ink-faint)',
            }}>
              the goal feels bigger than one curriculum?{' '}
              <button
                type="button"
                disabled={!topic.trim() && !goal.trim()}
                onClick={() => {
                  try {
                    window.dispatchEvent(new CustomEvent('hypha:open-chain-planner', {
                      detail: {
                        topic: (topic || '').trim(),
                        goal: (goal || '').trim(),
                        timeCommit: timeCommit || 'month',
                        clarifications: [],     // welcome form's clarifications come AFTER first submit; skip
                      },
                    }));
                  } catch (_) {}
                }}
                style={{
                  background: 'transparent', border: 'none', padding: 0,
                  font: 'inherit', fontStyle: 'italic',
                  color: (!topic.trim() && !goal.trim()) ? 'var(--ink-faint)' : 'var(--brass-bright)',
                  cursor: (!topic.trim() && !goal.trim()) ? 'not-allowed' : 'pointer',
                  borderBottom: '1px solid transparent',
                  opacity: (!topic.trim() && !goal.trim()) ? 0.5 : 1,
                  transition: 'border-color 200ms, color 200ms, opacity 200ms',
                }}
                onMouseEnter={e => { if (topic.trim() || goal.trim()) e.currentTarget.style.borderBottomColor = 'var(--brass-bright)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderBottomColor = 'transparent'; }}
                title={(!topic.trim() && !goal.trim())
                  ? 'fill in topic or goal first'
                  : 'break it into a chain of prerequisites first — Hypha plans a sequence of courses from your starting point to the goal'}
              >plan a chain →</button>
            </div>

            {/* v0.5.0 — source-material upload (optional). When set, the
                curriculum is built from the uploaded document instead of
                web harvest. Drag-and-drop on the affordance, or click to
                pick. After upload: filename + chapter count + remove. */}
            <label style={{
              display: 'block', fontFamily: '"Cormorant Garamond", "EB Garamond", Georgia, serif',
              fontWeight: 500, fontSize: 13, letterSpacing: '0.16em', textTransform: 'uppercase',
              color: 'var(--ink-faint)', marginBottom: 8,
            }}>source material <span style={{ fontStyle: 'italic', textTransform: 'none', letterSpacing: 0, color: 'var(--ink-faint)', opacity: 0.7 }}>(optional)</span></label>
            <SourceMaterialPicker
              uploadedSource={uploadedSource}
              setUploadedSource={setUploadedSource}
              uploadError={uploadError}
              setUploadError={setUploadError}
            />

            <label style={{
              display: 'block', fontFamily: '"Cormorant Garamond", "EB Garamond", Georgia, serif',
              fontWeight: 500, fontSize: 13, letterSpacing: '0.16em', textTransform: 'uppercase',
              color: 'var(--ink-faint)', marginBottom: 8,
            }}>time you want to commit</label>
            <div style={{
              display: 'flex', gap: 4, padding: 4,
              background: 'color-mix(in srgb, var(--brass-mid) 10%, transparent)',
              borderRadius: '18px 14px 18px 14px',
              boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--brass-mid) 18%, transparent)',
              marginBottom: 32,
            }}>
              {TIME_OPTIONS.map((t, i) => {
                const on = timeCommit === t.id;
                const radius = i === 0 ? '14px 10px 14px 10px'
                              : i === TIME_OPTIONS.length - 1 ? '10px 14px 10px 14px'
                              : '12px 12px 12px 12px';
                return (
                  <button
                    key={t.id}
                    onClick={() => setTimeCommit(t.id)}
                    style={{
                      flex: 1,
                      background: on ? 'var(--bg-modal-card)' : 'transparent',
                      border: 'none', borderRadius: radius,
                      color: on ? 'var(--ink-title)' : 'var(--ink-muted)',
                      fontFamily: 'inherit', fontStyle: 'normal',
                      fontWeight: on ? 500 : 400, padding: '10px 8px', cursor: 'pointer',
                      boxShadow: on ? 'inset 0 0 0 1px color-mix(in srgb, var(--brass-bright) 32%, transparent), 0 3px 10px -2px rgba(0,0,0,0.16)' : 'none',
                      transform: on ? 'scale(1.02)' : 'scale(1)',
                      transition: 'all 280ms cubic-bezier(0.25, 1.18, 0.4, 1.02)',
                    }}
                  >
                    <div style={{ fontSize: 14 }}>{t.label}</div>
                    <div style={{ fontSize: 11, fontStyle: 'italic', color: 'var(--ink-faint)', marginTop: 2 }}>{t.sub}</div>
                  </button>
                );
              })}
            </div>

            {timeCommit === 'custom' && (
              <div style={{
                marginTop: -20, marginBottom: 32,
                display: 'flex', alignItems: 'baseline', gap: 14,
                fontFamily: '"EB Garamond", Georgia, serif',
              }}>
                <label style={{
                  fontFamily: '"Cormorant Garamond", "EB Garamond", Georgia, serif',
                  fontWeight: 500, fontSize: 13, letterSpacing: '0.16em',
                  textTransform: 'uppercase', color: 'var(--ink-faint)',
                }}>lessons</label>
                <input
                  type="number"
                  className="hypha-num-input"
                  min={1}
                  max={200}
                  value={customLessons}
                  onChange={e => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) setCustomLessons(Math.max(1, Math.min(200, Math.round(v))));
                  }}
                  style={{
                    width: 86, padding: '6px 10px 4px',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: '1px solid color-mix(in srgb, var(--brass-mid) 32%, transparent)',
                    borderRadius: 0,
                    color: 'var(--ink-title)',
                    fontFamily: 'inherit', fontStyle: 'italic',
                    fontSize: 22, fontWeight: 500,
                    textAlign: 'center', outline: 'none',
                    transition: 'border-color 220ms',
                  }}
                  onFocus={e => { e.currentTarget.style.borderBottomColor = 'var(--brass-bright)'; }}
                  onBlur={e => { e.currentTarget.style.borderBottomColor = 'color-mix(in srgb, var(--brass-mid) 32%, transparent)'; }}
                />
                <span style={{
                  fontStyle: 'italic', fontSize: 13, color: 'var(--ink-faint)',
                }}>between 1 and 200</span>
              </div>
            )}

            {/* v0.6.0 — TIER PICKER. 3 buttons in TIME_OPTIONS visual style.
                Multiplier is server-side (agent.computePhaseLessonCounts);
                renderer just displays scope-coverage % computed from the
                multiplier so the user sees an honest answer to "how broad
                is this." Default 'moderate' = 1.0× = pre-v0.6 behavior. */}
            <label style={{
              display: 'block', fontFamily: '"Cormorant Garamond", "EB Garamond", Georgia, serif',
              fontWeight: 500, fontSize: 13, letterSpacing: '0.16em', textTransform: 'uppercase',
              color: 'var(--ink-faint)', marginBottom: 8,
            }}>depth of traversal</label>
            <div style={{
              display: 'flex', gap: 4, padding: 4,
              background: 'color-mix(in srgb, var(--brass-mid) 10%, transparent)',
              borderRadius: '18px 14px 18px 14px',
              boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--brass-mid) 18%, transparent)',
              marginBottom: 8,
            }}>
              {[
                { id: 'gentle',   label: 'gentle',   sub: 'lighter scope · 60% lessons' },
                { id: 'moderate', label: 'moderate', sub: 'balanced · standard count' },
                { id: 'heroic',   label: 'heroic',   sub: 'deep traversal · 60% more lessons' },
              ].map((t, i, arr) => {
                const on = tier === t.id;
                const radius = i === 0 ? '14px 10px 14px 10px'
                              : i === arr.length - 1 ? '10px 14px 10px 14px'
                              : '12px 12px 12px 12px';
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTier(t.id)}
                    style={{
                      flex: 1,
                      background: on ? 'var(--bg-modal-card)' : 'transparent',
                      border: 'none', borderRadius: radius,
                      color: on ? 'var(--ink-title)' : 'var(--ink-muted)',
                      fontFamily: 'inherit', fontStyle: 'normal',
                      fontWeight: on ? 500 : 400, padding: '10px 8px', cursor: 'pointer',
                      boxShadow: on ? 'inset 0 0 0 1px color-mix(in srgb, var(--brass-bright) 32%, transparent), 0 3px 10px -2px rgba(0,0,0,0.16)' : 'none',
                      transform: on ? 'scale(1.02)' : 'scale(1)',
                      transition: 'all 280ms cubic-bezier(0.25, 1.18, 0.4, 1.02)',
                    }}
                  >
                    <div style={{ fontSize: 14 }}>{t.label}</div>
                    <div style={{ fontSize: 11, fontStyle: 'italic', color: 'var(--ink-faint)', marginTop: 2 }}>{t.sub}</div>
                  </button>
                );
              })}
            </div>

            {/* Scope-coverage sentence — derived from tierMultiplier and the
                selected timeCommit. Heroic is the 100% baseline (1.6× → 100%);
                moderate ≈ 63% (1.0/1.6); gentle ≈ 38% (0.6/1.6). hrs/wk and
                weeks come from the existing timeCommit buckets so the user
                sees real arithmetic, not a placeholder. */}
            {(() => {
              const HRS_PER_WK = { week: 1, month: 4, 'two-month': 8, quarter: 12, open: 4 };
              const WKS = { week: 1, month: 4, 'two-month': 8, quarter: 12, open: 12 };
              let hrs, weeks;
              if (timeCommit === 'custom') {
                const lessons = Math.max(1, Math.min(200, Number(customLessons) || 50));
                weeks = Math.max(1, Math.ceil(lessons / 8));   // assume ~8 lessons / wk avg
                hrs = Math.max(1, Math.round(lessons / weeks));
              } else {
                hrs = HRS_PER_WK[timeCommit] || 4;
                weeks = WKS[timeCommit] || 4;
              }
              const N = Math.round(tierMultiplier(tier) * 100 / 1.6 * 100) / 100;
              return (
                <div style={{
                  marginBottom: 32,
                  fontFamily: 'inherit', fontStyle: 'italic', fontSize: 13,
                  color: 'var(--ink-faint)', lineHeight: 1.55,
                }}>
                  this tier covers ~{N}% of the field's typical phases at {hrs}/wk for ~{weeks} week{weeks === 1 ? '' : 's'}
                </div>
              );
            })()}

            <button
              onClick={submitForm}
              disabled={!topic.trim()}
              style={{
                width: '100%',
                background: 'color-mix(in srgb, var(--brass-bright) 22%, transparent)',
                border: '1px solid var(--brass-bright)',
                borderRadius: '18px 14px 18px 14px',
                color: 'var(--ink-title)',
                fontFamily: 'inherit', fontStyle: 'normal',
                fontSize: 17, fontWeight: 500, padding: '14px 26px',
                cursor: !topic.trim() ? 'not-allowed' : 'pointer',
                opacity: !topic.trim() ? 0.4 : 1,
                transition: 'background 220ms cubic-bezier(0.22, 1, 0.36, 1)',
              }}
              onMouseEnter={e => { if (topic.trim()) e.currentTarget.style.background = 'color-mix(in srgb, var(--brass-bright) 32%, transparent)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--brass-bright) 22%, transparent)'; }}
            >continue</button>

            {clarifyError && (
              <div style={{ marginTop: 16, fontStyle: 'italic', fontSize: 13, color: 'var(--verdict-flag)' }}>
                couldn't fetch questions: {clarifyError}
              </div>
            )}
          </div>
        )}

        {/* Phase: ASKING — vinyl loading state ─────────────────────────── */}
        {phase === 'asking' && (
          <div style={{
            padding: '40px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22,
          }}>
            <VinylSpinner />
            <p className="hypha-breath" style={{
              fontStyle: 'italic', fontSize: 15, color: 'var(--ink-faint)', margin: 0,
            }}>{status === 'gating'
              ? '~5-10s · checking feasibility before we commit your weeks'
              : '~10-30s · drafting questions tailored to your topic + goal'}</p>
          </div>
        )}

        {/* Phase: CLARIFY — bubble multiple-choice ─────────────────────── */}
        {phase === 'clarify' && (
          <div style={{ maxWidth: 720, marginLeft: 'auto', marginRight: 'auto', textAlign: 'left' }}>
            {questions.map((q, qi) => {
              const cur = answers[q.id];
              const otherText = otherDrafts[q.id] || '';
              const otherSelected = q.multiSelect
                ? Array.isArray(cur) && cur.some(x => x && x.startsWith && x.startsWith('OTHER:'))
                : (cur && typeof cur === 'string' && cur.startsWith('OTHER:'));
              return (
                <div key={q.id} style={{ marginBottom: 36 }}>
                  <div style={{
                    fontFamily: 'inherit', fontStyle: 'normal', fontSize: 17,
                    color: 'var(--ink-title)', marginBottom: 4, fontWeight: 500,
                  }}>{qi + 1}. {q.question}</div>
                  {q.multiSelect && (
                    <div style={{
                      fontStyle: 'italic', fontSize: 12, color: 'var(--ink-faint)', marginBottom: 12,
                      letterSpacing: '0.06em',
                    }}>选多个 · pick any that apply</div>
                  )}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: q.multiSelect ? 0 : 12 }}>
                    {q.options.map((opt) => {
                      const on = q.multiSelect
                        ? (Array.isArray(cur) && cur.includes(opt.id))
                        : cur === opt.id;
                      // Lung+Muse synthesis 2026-04-30: STRUCK BELL envelope + LAMP
                      // multi-track timings + Muse rigid-box constraint.
                      // - Bounding box LOCKED: no scale, no border-thickening, no padding tween,
                      //   fontWeight always 500 (kills the layout-shift squeeze bug).
                      // - 3 properties on 3 different curves+durations: bg / color (delayed 60ms) /
                      //   inset hairline. Plus a one-shot 520ms ::after ring pulse on selection
                      //   moment (CSS animation, not transition — rings don't un-strike).
                      return (
                        <button
                          key={opt.id}
                          onClick={() => toggleOption(q.id, opt.id, q.multiSelect)}
                          className={'hypha-bubble' + (on ? ' hypha-bubble--on' : '')}
                          style={{
                            position: 'relative',
                            background: on ? 'color-mix(in srgb, var(--brass-bright) 22%, transparent)' : 'transparent',
                            border: 'none',
                            borderRadius: '14px 10px 14px 10px',
                            // Inset hairline = the only "border" — never changes box size.
                            // Hairline thickens 1px → 1.5px on selection via box-shadow inset.
                            boxShadow: on
                              ? 'inset 0 0 0 1.5px var(--brass-bright), inset 0 1px 0 color-mix(in srgb, var(--brass-bright) 36%, transparent)'
                              : 'inset 0 0 0 1px color-mix(in srgb, var(--brass-mid) 32%, transparent)',
                            color: on ? 'var(--ink-title)' : 'var(--ink-muted)',
                            fontFamily: 'inherit', fontStyle: 'normal',
                            fontWeight: 500,        // CONSTANT — fixes squeeze bug
                            fontSize: 14.5, padding: '7px 14px',
                            cursor: 'pointer',
                            // Three concurrent transitions, three different timings (Muse FM8 rebuttal):
                            transition:
                              'background 280ms cubic-bezier(0.4, 0, 0.15, 1), ' +
                              'color 240ms cubic-bezier(0.3, 0.7, 0.2, 1) 60ms, ' +
                              'box-shadow 200ms cubic-bezier(0.2, 0.7, 0.2, 1) 200ms',
                          }}
                          onMouseEnter={e => { if (!on) e.currentTarget.style.color = 'var(--ink-title)'; }}
                          onMouseLeave={e => { if (!on) e.currentTarget.style.color = 'var(--ink-muted)'; }}
                        >{opt.label}</button>
                      );
                    })}
                  </div>
                  {q.allowOther && (
                    <div style={{ marginTop: 10 }}>
                      {/* intentional-placeholder: real HTML input placeholder attribute */}
                      <input
                        type="text"
                        placeholder="other · 其他 (free text)"
                        value={otherText}
                        onChange={e => setOther(q.id, e.target.value, q.multiSelect)}
                        style={{
                          width: '100%', maxWidth: 360,
                          background: otherSelected ? 'color-mix(in srgb, var(--brass-bright) 14%, transparent)' : 'color-mix(in srgb, var(--brass-mid) 8%, transparent)',
                          color: 'var(--ink-title)',
                          border: 'none',
                          borderRadius: '12px 8px 12px 8px',
                          padding: '7px 12px',
                          fontFamily: 'inherit', fontStyle: 'italic', fontSize: 13.5,
                          outline: 'none',
                          boxShadow: 'inset 0 0 0 1px ' + (otherSelected ? 'var(--brass-bright)' : 'color-mix(in srgb, var(--brass-mid) 22%, transparent)'),
                          transition: 'all 220ms cubic-bezier(0.22, 1, 0.36, 1)',
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })}

            <div style={{
              display: 'flex', gap: 12, marginTop: 32, alignItems: 'center',
            }}>
              <button
                onClick={skipClarify}
                style={{
                  background: 'transparent',
                  border: '1px solid color-mix(in srgb, var(--brass-mid) 28%, transparent)',
                  borderRadius: '14px 10px 14px 10px',
                  color: 'var(--ink-muted)',
                  fontFamily: 'inherit', fontStyle: 'italic',
                  fontSize: 14, padding: '10px 18px',
                  cursor: 'pointer',
                  transition: 'all 220ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--ink-title)'; }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-muted)'; }}
              >skip questions</button>
              <button
                onClick={submitClarify}
                style={{
                  flex: 1,
                  background: 'color-mix(in srgb, var(--brass-bright) 22%, transparent)',
                  border: '1px solid var(--brass-bright)',
                  borderRadius: '18px 14px 18px 14px',
                  color: 'var(--ink-title)',
                  fontFamily: 'inherit', fontStyle: 'normal',
                  fontSize: 16, fontWeight: 500, padding: '12px 26px',
                  cursor: 'pointer',
                  transition: 'background 220ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--brass-bright) 32%, transparent)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--brass-bright) 22%, transparent)'; }}
              >begin lessons →</button>
            </div>
          </div>
        )}

        {/* Phase: GATE — Smart Gate (council 2026-05-01 option B) ─────────
            Shown when feasibility tier === 'nearly-impossible'. User picks
            among 3 paths: 硬刚 / 看推荐链 / 改目标. Manuscript register —
            italic Garamond block, brass-mid hairlines, no chrome buttons. */}
        {phase === 'gate' && gateResult && (
          <div style={{ maxWidth: 640, marginLeft: 'auto', marginRight: 'auto', padding: '12px 0 0' }}>
            {/* Verdict block */}
            <div style={{
              padding: '14px 18px', marginBottom: 22,
              background: 'color-mix(in srgb, var(--verdict-flag, #c44) 6%, transparent)',
              borderLeft: '2px solid color-mix(in srgb, var(--verdict-flag, #c44) 50%, transparent)',
              borderRadius: 2,
            }}>
              <div style={{ fontStyle: 'italic', fontSize: 14, color: 'var(--ink-muted)', marginBottom: 6, lineHeight: 1.55 }}>
                你想达到的目标对当前时间预算来说太挤了。
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-faint)', fontStyle: 'italic', lineHeight: 1.6 }}>
                时间需要约 {gateResult.feasibility.hoursNeeded} 小时；按 {gateResult.timeWeeks} 周 / 每日 2 小时计，你能投入约 {gateResult.feasibility.hoursAvailable} 小时
                （缺口 ≈ {gateResult.feasibility.hoursAvailable > 0 ? Math.round(gateResult.feasibility.hoursNeeded / gateResult.feasibility.hoursAvailable) : '∞'} 倍）。
                完成率估算约 {Math.round(gateResult.feasibility.pComplete * 100)}%。
              </div>
              {gateResult.prior && Array.isArray(gateResult.prior.missing_prerequisites) && gateResult.prior.missing_prerequisites.length > 0 && (
                <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--ink-muted)', fontStyle: 'italic' }}>
                  识别到的前置：
                  <ul style={{ margin: '4px 0 0 16px', padding: 0, opacity: 0.85 }}>
                    {gateResult.prior.missing_prerequisites.slice(0, 5).map((p, i) => (
                      <li key={i} style={{ marginBottom: 2 }}>{p}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Decision row — 3 italic-link options */}
            {gateMode === 'decide' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
                <button onClick={gateRequestChain} style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  fontFamily: '"EB Garamond", "Noto Serif SC", serif', fontStyle: 'italic',
                  fontSize: 17, color: 'var(--brass-bright)', padding: '6px 0',
                  textAlign: 'left',
                  transition: 'color 220ms var(--ease-quiet, cubic-bezier(0.4, 0, 0.2, 1))',
                }} onMouseEnter={e => e.currentTarget.style.color = 'var(--ink-title)'}
                   onMouseLeave={e => e.currentTarget.style.color = 'var(--brass-bright)'}>
                  → 看推荐：先学哪几个前置再回来追这个目标
                </button>
                <button onClick={gateAcceptHardMode} style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  fontFamily: '"EB Garamond", "Noto Serif SC", serif', fontStyle: 'italic',
                  fontSize: 15, color: 'var(--ink-muted)', padding: '6px 0',
                  textAlign: 'left',
                  transition: 'color 220ms var(--ease-quiet, cubic-bezier(0.4, 0, 0.2, 1))',
                }} onMouseEnter={e => e.currentTarget.style.color = 'var(--ink-title)'}
                   onMouseLeave={e => e.currentTarget.style.color = 'var(--ink-muted)'}>
                  → 硬刚：直接生成完整课程（接受 ~{Math.round(gateResult.feasibility.pComplete * 100)}% 完成率）
                </button>
                <button onClick={gateChangeGoal} style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  fontFamily: '"EB Garamond", "Noto Serif SC", serif', fontStyle: 'italic',
                  fontSize: 15, color: 'var(--ink-muted)', padding: '6px 0',
                  textAlign: 'left',
                  transition: 'color 220ms var(--ease-quiet, cubic-bezier(0.4, 0, 0.2, 1))',
                }} onMouseEnter={e => e.currentTarget.style.color = 'var(--ink-title)'}
                   onMouseLeave={e => e.currentTarget.style.color = 'var(--ink-muted)'}>
                  → 改目标：返回表单换更具体 / 更小的目标
                </button>
              </div>
            )}

            {gateMode === 'proposing' && (
              <div style={{ padding: '20px 0', display: 'flex', alignItems: 'center', gap: 14 }}>
                <VinylSpinner />
                <p className="hypha-breath" style={{
                  fontStyle: 'italic', fontSize: 14, color: 'var(--ink-muted)', margin: 0,
                }}>正在排出推荐学习链…</p>
              </div>
            )}

            {gateMode === 'chain-shown' && proposedChain && Array.isArray(proposedChain.links) && (
              <div>
                <div style={{ fontStyle: 'italic', fontSize: 13, color: 'var(--ink-faint)', marginBottom: 12, lineHeight: 1.5 }}>
                  推荐路径——点击任一前置链节进入它作为本次课程主题（可后续再回来追原目标）：
                </div>
                {proposedChain.links.map((l, i) => {
                  const isUltimate = l.role === 'ultimate';
                  return (
                    <button
                      key={i}
                      onClick={() => !isUltimate && gatePickChainLink(l)}
                      disabled={isUltimate}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left',
                        background: 'transparent', border: 'none',
                        padding: '10px 14px', marginBottom: 6,
                        borderLeft: '2px solid color-mix(in srgb, var(--brass-mid) ' + (isUltimate ? '70%' : '36%') + ', transparent)',
                        cursor: isUltimate ? 'default' : 'pointer',
                        opacity: isUltimate ? 0.5 : 1,
                        transition: 'background 220ms var(--ease-quiet, cubic-bezier(0.4, 0, 0.2, 1))',
                      }}
                      onMouseEnter={e => { if (!isUltimate) e.currentTarget.style.background = 'color-mix(in srgb, var(--brass-mid) 6%, transparent)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      <div style={{
                        fontFamily: '"EB Garamond", "Noto Serif SC", serif',
                        fontStyle: 'italic', fontSize: 16,
                        color: isUltimate ? 'var(--ink-muted)' : 'var(--ink-title)',
                      }}>
                        {(i + 1)}. {l.topic}
                      </div>
                      <div style={{
                        fontSize: 11.5, color: 'var(--ink-faint)', marginTop: 3, fontStyle: 'italic',
                        letterSpacing: '0.04em', opacity: 0.85,
                      }}>
                        {l.duration_weeks} 周 · {l.role === 'prerequisite' ? '前置' : l.role === 'core' ? '核心' : '终点（你的原目标）'}
                      </div>
                      {l.rationale && (
                        <div style={{ fontSize: 12.5, color: 'var(--ink-muted)', marginTop: 5, fontStyle: 'italic', lineHeight: 1.5 }}>
                          {l.rationale}
                        </div>
                      )}
                    </button>
                  );
                })}
                <button onClick={() => setGateMode('decide')} style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  fontFamily: '"EB Garamond", serif', fontStyle: 'italic',
                  fontSize: 13, color: 'var(--ink-faint)', marginTop: 14, padding: '4px 0',
                }}>← 返回三选一</button>
              </div>
            )}
          </div>
        )}

        {/* Phase: CREATING — vinyl + status copy ───────────────────────── */}
        {phase === 'creating' && (
          <div style={{
            padding: '40px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22,
          }}>
            <VinylSpinner stopped={status === 'error'} />
            {/* v0.6.0 — always-on source-preview banner. Replaces v0.5.2's
                thin-only signal. Color shifts to amber (--verdict-flag) when
                totalUseful < 5, otherwise stays in ink-muted. The Tavily-key
                nudge is rendered inline beneath when web channel returned 0
                AND no key is configured — single click takes the user to
                settings (colophon) to paste their key. */}
            {harvestStatus && harvestStatus.fired && status !== 'error' && (() => {
              const pc = harvestStatus.perChannel || {};
              const n = (k) => (pc[k] && Number.isFinite(pc[k].n)) ? pc[k].n : 0;
              const thin = harvestStatus.totalUseful < 5;
              const showTavilyNudge = n('web') === 0 && !hasTavilyKey;
              return (
                <div style={{
                  marginBottom: 8, maxWidth: 520, textAlign: 'center',
                }}>
                  <div style={{
                    color: thin ? 'var(--verdict-flag)' : 'var(--ink-muted)',
                    fontStyle: 'italic', fontSize: 13, lineHeight: 1.5,
                    transition: 'color 220ms cubic-bezier(0.22, 1, 0.36, 1)',
                  }}>
                    harvested {harvestStatus.totalUseful} source{harvestStatus.totalUseful === 1 ? '' : 's'} —{' '}
                    {n('github')}/{n('hn')}/{n('arxiv')}/{n('web')} (gh/hn/arxiv/web)
                  </div>
                  {showTavilyNudge && (
                    <button
                      type="button"
                      onClick={() => {
                        try { window.dispatchEvent(new CustomEvent('hypha:open-colophon')); } catch (_) {}
                      }}
                      style={{
                        marginTop: 4,
                        background: 'transparent', border: 'none', padding: 0,
                        font: 'inherit', fontStyle: 'italic', fontSize: 13,
                        color: 'var(--brass-bright)',
                        cursor: 'pointer',
                        borderBottom: '1px solid transparent',
                        transition: 'border-color 200ms',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.borderBottomColor = 'var(--brass-bright)'; }}
                      onMouseLeave={e => { e.currentTarget.style.borderBottomColor = 'transparent'; }}
                    >→ add a free Tavily key in settings for broader coverage</button>
                  )}
                </div>
              );
            })()}
            <p className={status !== 'error' ? 'hypha-breath' : undefined} style={{
              fontStyle: 'italic', fontSize: 15, lineHeight: 1.5, maxWidth: 480,
              color: status === 'error' ? 'var(--verdict-flag)' : 'var(--ink-muted)', margin: 0,
            }}>{statusLine || 'beginning…'}</p>
          </div>
        )}

        {/* 2026-05-01 — replaced ugly all-caps mono ⌘-prefix bar with a
            quiet italic Garamond hint. The keyboard shortcuts still work,
            they just stop announcing themselves like a SaaS app footer. */}
        <div style={{
          marginTop: 48, textAlign: 'center',
          fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
          fontStyle: 'italic', fontSize: 12.5,
          color: 'var(--ink-faint)', opacity: 0.55,
          letterSpacing: 0,
        }}>press enter to continue · esc to cancel</div>
      </div>
    </div>
  );
}

function CaseTab() {
  return <EmptyHint headline="case file is not yet built." />;
}

// GraphTab — focused constellation map.
//
// Reasoning behind the design:
// — A single "all notes as a sphere" view stops being readable past ~200
//   notes and offers no way to inspect one note's neighborhood.
// — Knowledge work is local, not global: you almost always want "what does
//   THIS note connect to?", not "show me everything I've ever written."
// — So we split the pane into:
//     LEFT 62%:  focused 1-hop graph anchored on the selected note
//     RIGHT 38%: search + note list (re-anchor by clicking)
//     BOTTOM:    minimap of the entire vault as a dense dot field; the
//                visible region is a brass square you can drag.
//
// Everything reads theme tokens via cssVar() so day/night both work.
function GraphTab() {
  // Vault data is empty until graph IPC is wired. Render structure preserved
  // so style work is visible; data comes from window.ptor.graph.list() later.
  const vault = React.useMemo(() => ({
    notes: [], edges: [], byId: {}, edgeCount: 0, neighbors: new Map(),
  }), []);
  const [anchorId, setAnchorId] = React.useState(null);
  const [query, setQuery] = React.useState('');

  if (vault.notes.length === 0) {
    return (
      <EmptyHint
        headline="no constellation yet — graph builds from your wikilinks once the vault is connected."
        sub="awaiting graph + backlink ipc"
      />
    );
  }

  const anchor = vault.byId[anchorId] || vault.notes[0];
  const neighborhood = computeNeighborhood(vault, anchor.id);
  const q = query.trim().toLowerCase();
  const filtered = q
    ? vault.notes.filter(n => n.title.toLowerCase().includes(q)).slice(0, 80)
    : vault.notes.slice(0, 80);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* header */}
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 10,
        padding: '14px 18px 10px',
      }}>
        <span style={{ fontFamily: '"EB Garamond", "Cormorant Garamond", Georgia, serif', fontStyle: 'italic', fontSize: 24, color: 'var(--ink-title)', whiteSpace: 'nowrap' }}>constellation</span>
        <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11.5, letterSpacing: '0.04em', color: 'var(--ink-faint)' }}>
          {vault.notes.length} notes · {vault.edgeCount} edges · anchor: {anchor.title.toLowerCase()}
        </span>
      </div>

      {/* main split */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, padding: '0 18px', gap: 14 }}>
        <FocusGraph anchor={anchor} neighborhood={neighborhood} onPick={setAnchorId} />
        <NoteList notes={filtered} anchorId={anchor.id} onPick={setAnchorId} query={query} setQuery={setQuery} neighborhood={neighborhood} />
      </div>

      {/* bottom minimap */}
      <Minimap vault={vault} anchor={anchor} onPick={setAnchorId} />
    </div>
  );
}

// Synthetic vault generator removed (Phase -1) — real graph data will come
// from window.ptor.graph.list() + window.ptor.backlink.list() in Phase 5.

function computeNeighborhood(vault, anchorId) {
  // BFS up to 2 hops.
  const dist = new Map();
  dist.set(anchorId, 0);
  let frontier = [anchorId];
  for (let h = 1; h <= 2; h++) {
    const next = [];
    for (const id of frontier) {
      for (const nb of vault.neighbors.get(id) || []) {
        if (!dist.has(nb)) { dist.set(nb, h); next.push(nb); }
      }
    }
    frontier = next;
  }
  return dist; // Map<id, hopCount>
}

// — Focus graph —————————————————————————————————————————————
function FocusGraph({ anchor, neighborhood, onPick }) {
  const cvRef = React.useRef(null);
  const wrapRef = React.useRef(null);
  // ALL mutable interaction state lives in refs — zero React re-renders during hover/draw.
  const hoverRef = React.useRef(null);      // id string or null
  const pickRef = React.useRef(onPick);
  pickRef.current = onPick;

  React.useEffect(() => {
    const cv = cvRef.current; const wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const ctx = cv.getContext('2d');
    let raf;

    // Build layout with per-node animation state (current radius, opacity, label alpha).
    const ids = Array.from(neighborhood.entries());
    const oneHop = ids.filter(([, h]) => h === 1).map(([id]) => id);
    const twoHop = ids.filter(([, h]) => h === 2).map(([id]) => id);

    const placeRing = (list, radius, baseR, baseOp) => list.map((id, i) => {
      const a = (i / Math.max(1, list.length)) * Math.PI * 2 - Math.PI / 2;
      const jr = radius * (0.92 + Math.random() * 0.14);
      return { id, ang: a, dist: jr,
        // animated props — "current" lerps toward "target" each frame
        curR: baseR, tgtR: baseR,
        curOp: baseOp, tgtOp: baseOp,
        curHalo: 0, tgtHalo: 0,
        curLabel: 0, tgtLabel: 0,   // label fade 0..1
        curEdgeOp: 0.35, tgtEdgeOp: 0.35,
      };
    });

    const nodes1 = placeRing(oneHop.slice(0, 14), 1, 4.5, 0.92);
    const nodes2 = placeRing(twoHop.slice(0, 22), 1.7, 2.2, 0.50);
    const allNodes = [...nodes1, ...nodes2];
    const oneOverflow = Math.max(0, oneHop.length - 14);
    const twoOverflow = Math.max(0, twoHop.length - 22);

    // Mouse handling — writes to refs only, never setState.
    const onMove = (e) => {
      const r = wrap.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const w = r.width, h = r.height;
      const cx = w / 2, cy = h / 2;
      const R = Math.min(w, h) * 0.36;

      let found = null;
      if (Math.hypot(mx - cx, my - cy) < 16) { found = anchor.id; }
      else {
        for (const n of nodes1) {
          const x = cx + Math.cos(n.ang) * n.dist * R;
          const y = cy + Math.sin(n.ang) * n.dist * R;
          if (Math.hypot(mx - x, my - y) < 14) { found = n.id; break; }
        }
        if (!found) {
          for (const n of nodes2) {
            const x = cx + Math.cos(n.ang) * n.dist * R;
            const y = cy + Math.sin(n.ang) * n.dist * R;
            if (Math.hypot(mx - x, my - y) < 12) { found = n.id; break; }
          }
        }
      }
      hoverRef.current = found;
      cv.style.cursor = found ? 'pointer' : 'default';
    };
    const onClick = () => {
      const h = hoverRef.current;
      if (h) pickRef.current(h);
    };
    wrap.addEventListener('mousemove', onMove);
    wrap.addEventListener('click', onClick);

    // Lerp helper — smooth exponential ease
    const lerp = (cur, tgt, speed) => cur + (tgt - cur) * speed;

    function draw() {
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const cMid    = cssVar('--brass-mid')    || '#a8856d';
      const cBright = cssVar('--brass-bright') || '#d5b28a';
      const cAmber  = cssVar('--brass-amber')  || '#e8a13c';
      const cFaint  = cssVar('--ink-faint')    || '#7a6a5e';
      const cTitle  = cssVar('--ink-title')    || '#f2e6da';

      const cx = w / 2, cy = h / 2;
      const R = Math.min(w, h) * 0.36;
      const hovered = hoverRef.current;
      const LERP = 0.12; // smooth factor per frame (~7 frames to settle)

      // Update animation targets based on hover
      for (const n of nodes1) {
        const hot = hovered === n.id;
        n.tgtR = hot ? 7 : 4.5;
        n.tgtOp = hot ? 1 : 0.92;
        n.tgtHalo = hot ? 18 : 0;
        n.tgtLabel = hot ? 1 : 0;
        n.tgtEdgeOp = hot ? 0.85 : 0.35;
      }
      for (const n of nodes2) {
        const hot = hovered === n.id;
        n.tgtR = hot ? 4.5 : 2.2;
        n.tgtOp = hot ? 0.95 : 0.50;
        n.tgtHalo = hot ? 14 : 0;
        n.tgtLabel = hot ? 1 : 0;
        n.tgtEdgeOp = hot ? 0.55 : 0.18;
      }
      // Lerp all animated props
      for (const n of allNodes) {
        n.curR      = lerp(n.curR,      n.tgtR,      LERP);
        n.curOp     = lerp(n.curOp,     n.tgtOp,     LERP);
        n.curHalo   = lerp(n.curHalo,   n.tgtHalo,   LERP);
        n.curLabel  = lerp(n.curLabel,  n.tgtLabel,   LERP);
        n.curEdgeOp = lerp(n.curEdgeOp, n.tgtEdgeOp, LERP);
      }

      // Guide rings
      ctx.strokeStyle = withAlpha(cFaint, 0.08);
      ctx.lineWidth = 0.5;
      ctx.setLineDash([4, 6]);
      for (const r of [R, R * 1.7]) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); }
      ctx.setLineDash([]);

      // Edges: anchor → 1-hop
      for (const n of nodes1) {
        const x = cx + Math.cos(n.ang) * n.dist * R;
        const y = cy + Math.sin(n.ang) * n.dist * R;
        ctx.strokeStyle = withAlpha(cBright, n.curEdgeOp);
        ctx.lineWidth = n.curEdgeOp > 0.5 ? 1.2 : 0.7;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
      }
      // Edges: 1-hop → 2-hop
      for (let i = 0; i < nodes2.length; i++) {
        const t = nodes2[i];
        const o = nodes1[i % Math.max(1, nodes1.length)];
        if (!o) continue;
        const ox = cx + Math.cos(o.ang) * o.dist * R;
        const oy = cy + Math.sin(o.ang) * o.dist * R;
        const tx = cx + Math.cos(t.ang) * t.dist * R;
        const ty = cy + Math.sin(t.ang) * t.dist * R;
        ctx.strokeStyle = withAlpha(cMid, t.curEdgeOp);
        ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(tx, ty); ctx.stroke();
      }

      // Draw nodes back-to-front: 2-hop first, then 1-hop, then anchor
      for (const n of nodes2) {
        const x = cx + Math.cos(n.ang) * n.dist * R;
        const y = cy + Math.sin(n.ang) * n.dist * R;
        // Halo (only visible when hovered, lerps in)
        if (n.curHalo > 0.5) {
          const grad = ctx.createRadialGradient(x, y, 0, x, y, n.curHalo);
          grad.addColorStop(0, withAlpha(cMid, 0.25));
          grad.addColorStop(1, withAlpha(cMid, 0));
          ctx.fillStyle = grad;
          ctx.beginPath(); ctx.arc(x, y, n.curHalo, 0, Math.PI * 2); ctx.fill();
        }
        // Core dot
        ctx.fillStyle = withAlpha(cMid, n.curOp);
        ctx.beginPath(); ctx.arc(x, y, n.curR, 0, Math.PI * 2); ctx.fill();
        // Label
        if (n.curLabel > 0.05) {
          ctx.globalAlpha = n.curLabel;
          const lbl = shortLabel(n.id);
          ctx.font = '10px "JetBrains Mono", monospace';
          const tw = ctx.measureText(lbl).width;
          // pill backdrop
          ctx.fillStyle = withAlpha(cFaint, 0.45);
          const px = x + 10, py = y - 4;
          roundRect(ctx, px - 4, py - 10, tw + 8, 15, 5);
          ctx.fill();
          ctx.fillStyle = cTitle;
          ctx.fillText(lbl, px, py);
          ctx.globalAlpha = 1;
        }
      }

      for (const n of nodes1) {
        const x = cx + Math.cos(n.ang) * n.dist * R;
        const y = cy + Math.sin(n.ang) * n.dist * R;
        // Halo
        if (n.curHalo > 0.5) {
          const grad = ctx.createRadialGradient(x, y, 0, x, y, n.curHalo);
          grad.addColorStop(0, withAlpha(cBright, 0.35));
          grad.addColorStop(1, withAlpha(cBright, 0));
          ctx.fillStyle = grad;
          ctx.beginPath(); ctx.arc(x, y, n.curHalo, 0, Math.PI * 2); ctx.fill();
        }
        // Outer ring (always visible, grows on hover)
        ctx.strokeStyle = withAlpha(cBright, 0.35);
        ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.arc(x, y, n.curR + 3, 0, Math.PI * 2); ctx.stroke();
        // Core dot
        ctx.fillStyle = withAlpha(cBright, n.curOp);
        ctx.beginPath(); ctx.arc(x, y, n.curR, 0, Math.PI * 2); ctx.fill();
        // Label
        if (n.curLabel > 0.05) {
          ctx.globalAlpha = n.curLabel;
          const lbl = shortLabel(n.id);
          ctx.font = '11px "JetBrains Mono", monospace';
          const tw = ctx.measureText(lbl).width;
          const px = x + n.curR + 8, py = y + 4;
          ctx.fillStyle = withAlpha(cFaint, 0.55);
          roundRect(ctx, px - 5, py - 12, tw + 10, 17, 6);
          ctx.fill();
          ctx.fillStyle = cTitle;
          ctx.fillText(lbl, px, py);
          ctx.globalAlpha = 1;
        }
      }

      // Anchor — breathing halo, teal (subject's signature chromatic anchor)
      const cTeal = cssVar('--accent-teal') || '#4D8B9A';
      const t = performance.now() * 0.002;
      const breathe = 1 + Math.sin(t) * 0.06;
      const anchorR = 10;
      const haloR = 32 * breathe;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
      grad.addColorStop(0, withAlpha(cTeal, 0.40));
      grad.addColorStop(0.5, withAlpha(cTeal, 0.12));
      grad.addColorStop(1, withAlpha(cTeal, 0));
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(cx, cy, haloR, 0, Math.PI * 2); ctx.fill();
      // Outer ring
      ctx.strokeStyle = withAlpha(cTeal, 0.45);
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.arc(cx, cy, anchorR + 4, 0, Math.PI * 2); ctx.stroke();
      // Core
      ctx.fillStyle = cTeal;
      ctx.beginPath(); ctx.arc(cx, cy, anchorR, 0, Math.PI * 2); ctx.fill();
      // Inner bright spot
      const inner = ctx.createRadialGradient(cx - 2, cy - 2, 0, cx, cy, anchorR);
      inner.addColorStop(0, withAlpha('#ffffff', 0.30));
      inner.addColorStop(1, withAlpha('#ffffff', 0));
      ctx.fillStyle = inner;
      ctx.beginPath(); ctx.arc(cx, cy, anchorR, 0, Math.PI * 2); ctx.fill();
      // Anchor label
      ctx.font = 'italic 13px "EB Garamond", "Cormorant Garamond", Georgia, serif';
      ctx.fillStyle = cBright;
      ctx.textAlign = 'center';
      ctx.fillText(anchor.title, cx, cy + anchorR + 18);
      ctx.textAlign = 'start';

      // Overflow caption
      if (oneOverflow + twoOverflow > 0) {
        ctx.font = '9px "JetBrains Mono", monospace';
        ctx.fillStyle = withAlpha(cFaint, 0.65);
        ctx.fillText(`+${oneOverflow} more direct · +${twoOverflow} more 2-hop`, 14, h - 14);
      }

      raf = requestAnimationFrame(draw);
    }
    draw();
    return () => { cancelAnimationFrame(raf); wrap.removeEventListener('mousemove', onMove); wrap.removeEventListener('click', onClick); };
  }, [anchor.id, neighborhood]);

  return (
    <div ref={wrapRef} style={{
      flex: '1 1 62%', position: 'relative',
      borderRadius: 0,
      background: 'var(--glass-light)',
      backdropFilter: 'var(--glass-blur)',
      WebkitBackdropFilter: 'var(--glass-blur)',
      boxShadow: 'inset 0 1px 0 var(--inset-highlight), inset 0 0 0 1px var(--border-soft)',
      overflow: 'hidden', minHeight: 0,
    }}>
      <canvas ref={cvRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      {/* legend */}
      <div style={{
        position: 'absolute', top: 12, right: 14,
        fontFamily: '"JetBrains Mono", monospace', fontSize: 10.5, letterSpacing: '0.04em',
        color: 'var(--ink-faint)', display: 'flex', gap: 14,
      }}>
        <Legend dot="var(--accent-teal)" label="anchor" />
        <Legend dot="var(--brass-bright)" label="1 hop" />
        <Legend dot="var(--brass-mid)" label="2 hop" />
      </div>
    </div>
  );
}

// Canvas rounded-rect helper
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function Legend({ dot, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot, display: 'inline-block' }} />{label}
    </span>
  );
}

function withAlpha(hex, a) {
  const h = (hex || '').trim().replace('#', '');
  if (h.length !== 6 && h.length !== 3) return `rgba(168,133,109,${a})`;
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16), g = parseInt(full.slice(2, 4), 16), b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function shortLabel(id) {
  // id "kant-categorical" → "kant · categorical"; "n-42" → "n42"
  return id.replace(/-/g, ' · ');
}

// — Note list (right column) ————————————————————————————————————————
function NoteList({ notes, anchorId, onPick, query, setQuery, neighborhood }) {
  return (
    <div style={{
      flex: '0 0 38%', display: 'flex', flexDirection: 'column', minHeight: 0,
      borderRadius: 0,
      background: 'var(--glass-light)',
      backdropFilter: 'var(--glass-blur)',
      WebkitBackdropFilter: 'var(--glass-blur)',
      boxShadow: 'inset 0 1px 0 var(--inset-highlight), inset 0 0 0 1px var(--border-soft)',
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10,
        borderBottom: '1px solid var(--border-hairline)',
      }}>
        <span style={{ color: 'var(--ink-faint)', fontFamily: '"JetBrains Mono", monospace', fontSize: 12 }}>⌕</span>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="search vault…"
          style={{
            flex: 1, background: 'transparent', border: 0, outline: 'none',
            fontFamily: '"JetBrains Mono", monospace', fontSize: 12, color: 'var(--ink-title)',
          }}
        />
        <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10.5, letterSpacing: '0.04em', color: 'var(--ink-faint)' }}>
          {notes.length} shown
        </span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '6px 4px' }}>
        {notes.map(n => {
          const hop = neighborhood.get(n.id);
          const isAnchor = n.id === anchorId;
          const dotColor = isAnchor ? 'var(--accent-teal)'
                          : hop === 1 ? 'var(--brass-bright)'
                          : hop === 2 ? 'var(--brass-mid)'
                          : 'var(--ink-faint)';
          return (
            <div key={n.id}
              onClick={() => onPick(n.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '7px 12px', borderRadius: 2,
                cursor: 'pointer',
                background: isAnchor ? 'var(--bg-elevated)' : 'transparent',
                boxShadow: isAnchor ? 'inset 0 0 0 1px var(--border-strong)' : 'none',
                transition: 'background 180ms cubic-bezier(0.22,1,0.36,1)',
              }}
              onMouseEnter={e => { if (!isAnchor) e.currentTarget.style.background = 'var(--glass-light)'; }}
              onMouseLeave={e => { if (!isAnchor) e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, flex: 'none', opacity: hop == null ? 0.35 : 1 }} />
              <span style={{
                flex: 1,
                fontFamily: '"EB Garamond", "Noto Serif SC", "Cormorant Garamond", serif',
                fontSize: 17, fontWeight: 500,
                color: isAnchor ? 'var(--accent-teal)' : 'var(--ink-title)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{n.title}</span>
              <span style={{
                fontFamily: '"JetBrains Mono", monospace', fontSize: 10.5, letterSpacing: '0.04em',
                color: 'var(--ink-faint)', flex: 'none',
              }}>{isAnchor ? 'anchor' : hop != null ? `${hop}h` : (n.cluster || '').toLowerCase()}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// — Bottom minimap ————————————————————————————————————————————
function Minimap({ vault, anchor, onPick }) {
  const cvRef = React.useRef(null);
  const wrapRef = React.useRef(null);

  React.useEffect(() => {
    const cv = cvRef.current; const wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const ctx = cv.getContext('2d');

    function draw() {
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const cMid    = cssVar('--brass-mid')    || '#a8856d';
      const cAmber  = cssVar('--brass-amber')  || '#e8a13c';

      // every note as 1px dot
      for (const n of vault.notes) {
        ctx.fillStyle = withAlpha(cMid, n.hub ? 0.85 : 0.40);
        ctx.fillRect(n.x * w - 1, n.y * h - 1, n.hub ? 2 : 1.5, n.hub ? 2 : 1.5);
      }
      // anchor highlight
      ctx.fillStyle = cAmber;
      ctx.beginPath(); ctx.arc(anchor.x * w, anchor.y * h, 3, 0, Math.PI * 2); ctx.fill();
      // ring around anchor
      ctx.strokeStyle = withAlpha(cAmber, 0.6);
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.arc(anchor.x * w, anchor.y * h, 8, 0, Math.PI * 2); ctx.stroke();
    }
    draw();
    const ro = new ResizeObserver(draw); ro.observe(wrap);

    const onClick = (e) => {
      const r = wrap.getBoundingClientRect();
      const mx = (e.clientX - r.left) / r.width;
      const my = (e.clientY - r.top) / r.height;
      // pick nearest note
      let best = null, bd = Infinity;
      for (const n of vault.notes) {
        const d = Math.hypot(n.x - mx, n.y - my);
        if (d < bd) { bd = d; best = n; }
      }
      if (best && bd < 0.04) onPick(best.id);
    };
    wrap.addEventListener('click', onClick);
    return () => { ro.disconnect(); wrap.removeEventListener('click', onClick); };
  }, [vault, anchor.x, anchor.y, anchor.id]);

  return (
    <div style={{ padding: '12px 18px 18px' }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        marginBottom: 6,
      }}>
        <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10.5, letterSpacing: '0.04em', color: 'var(--ink-muted)' }}>
          ¶ vault overview · click to jump
        </span>
        <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10.5, letterSpacing: '0.04em', color: 'var(--ink-faint)' }}>
          7 clusters
        </span>
      </div>
      <div ref={wrapRef} style={{
        height: 84, position: 'relative',
        borderRadius: 2,
        background: 'var(--glass-light)',
        backdropFilter: 'var(--glass-blur)',
        WebkitBackdropFilter: 'var(--glass-blur)',
        boxShadow: 'inset 0 0 0 1px var(--border-soft)',
        cursor: 'crosshair', overflow: 'hidden',
      }}>
        <canvas ref={cvRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      </div>
    </div>
  );
}

function FollowTab() {
  return <EmptyHint headline="follow-ups are not yet built." />;
}

function QuizTab() {
  return <EmptyHint headline="quiz is not yet built." />;
}

Object.assign(window, { VerifyTab, CaseTab, GraphTab, FollowTab, QuizTab, EmptyHint });
