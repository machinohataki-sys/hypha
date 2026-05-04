// Layout state, retract gestures, Klimt-mode (per Muse council 2026-04-27).
// Resize handle: invisible 6px hit-zone, hover-revealed hairline (Apple Mail register).
// Drag below 170px → snap retracted. Double-click boundary toggles. Keyboard symmetric.

const LAYOUT_KEY = 'ptor.layout';
const VAULT_DEFAULT = 264;
const TERM_DEFAULT  = 380;
const MIN_WIDTH     = 200;
const SNAP_THRESH   = 170;  // drag below this = retract
const MAX_VAULT     = 460;
const MAX_TERM      = 560;

// Living-Substrate Stage 1 (council 2026-04-30): WelcomeBanner surfaces TIME
// data already in the substrate (latest-read across all notes, fading-count)
// so the act of opening Hypha shows visible state, not an inert window.
// Auto-dims after 60s so it doesn't compete with primary content.
//
// Reads vault.list() (which now returns lastAttendedAt per item per
// council Stage 1 backend change) + profile.name. Recomputes when
// hypha:profile-updated fires.
function WelcomeBanner() {
  const [stats, setStats] = React.useState(null);
  const [profile, setProfile] = React.useState({ name: '' });
  const [dimmed, setDimmed] = React.useState(false);

  // Auto-dim after 60s ambient hold
  React.useEffect(() => {
    const t = setTimeout(() => setDimmed(true), 60000);
    return () => clearTimeout(t);
  }, []);

  // Load profile + recompute on update
  React.useEffect(() => {
    if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.profileGet) return;
    let alive = true;
    const load = () => {
      window.ptor.hypha.profileGet().then(p => {
        if (alive && p) setProfile({ name: p.name || '' });
      }).catch(() => {});
    };
    load();
    const onUpdate = () => load();
    window.addEventListener('hypha:profile-updated', onUpdate);
    return () => { alive = false; window.removeEventListener('hypha:profile-updated', onUpdate); };
  }, []);

  // Compute vault stats (last-attended, fading count, lessons untouched)
  React.useEffect(() => {
    if (!window.ptor || !window.ptor.vault || !window.ptor.vault.list) return;
    let alive = true;
    window.ptor.vault.list().then(res => {
      if (!alive) return;
      const folders = (res && res.folders) || [];
      const allItems = folders.flatMap(f => f.items || []);
      let latestTs = 0;
      let fading = 0;
      let untouched = 0;
      for (const it of allItems) {
        if (it.lastAttendedAt) {
          const ts = new Date(it.lastAttendedAt).getTime();
          if (Number.isFinite(ts) && ts > latestTs) latestTs = ts;
          const days = (Date.now() - ts) / 86400000;
          if (days >= 30) fading += 1;
          if (days >= 7) untouched += 1;
        } else {
          untouched += 1;
          fading += 1;
        }
      }
      const since = latestTs ? humanSince(Date.now() - latestTs) : null;
      setStats({ since, fading, untouched, total: allItems.length });
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // 2026-05-01 寒暄 upgrade (option A): time-of-day + literary fragment pool,
  // seeded by (date × time-bucket) so each bucket-window shows a stable greeting
  // (no performative refresh when user reopens 3× in one afternoon). Zero LLM,
  // zero IP geolocation — locale + system clock are both 100% local & instant.
  const now = React.useRef(new Date()).current;
  const hour = now.getHours();
  const tod = (hour < 5 ? 'predawn'
            : hour < 8 ? 'firstlight'
            : hour < 11 ? 'morning'
            : hour < 14 ? 'midday'
            : hour < 17 ? 'afternoon'
            : hour < 19 ? 'dusk'
            : hour < 22 ? 'evening'
            : 'night');

  const TIME_PHRASES = {
    predawn:    ['in the small hour before dawn',   'in the late dark',           'in the silence before light'],
    firstlight: ['at first light',                  'in the early light',         'as the morning thins'],
    morning:    ['this morning',                    'in the bright morning',      'while the light is fresh'],
    midday:     ['at this noon hour',               'in the high light',          'at midday'],
    afternoon:  ['this afternoon',                  'in the long afternoon',      'as the light leans'],
    dusk:       ['at dusk',                         'in the dimming hour',        'as the day folds'],
    evening:    ['this evening',                    'in the lamplight',           'as the evening settles'],
    night:      ['tonight',                         'in this late hour',          'in the deep evening'],
  };

  // Manuscript-register one-liners — keep all in present tense + paper/ink/page
  // vocabulary. Avoid productivity verbs ("ready to start", "let's go").
  const FRAGMENTS = [
    'the manuscript opens where you left it.',
    'ink and paper waiting.',
    'your last page is still warm.',
    'what was unfinished waits without complaint.',
    'the desk is yours again.',
    'a folded corner remembers where you stopped.',
    'the margins are still listening.',
    'pages settle as you arrive.',
    'somewhere a sentence is half-finished.',
    'the gloss column is empty, ready.',
    '墨迹未干处。',
    '翻开你昨日折页处。',
  ];

  const seed = (() => {
    const day = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${tod}`;
    let h = 5381;
    for (let i = 0; i < day.length; i++) h = ((h << 5) + h + day.charCodeAt(i)) | 0;
    return Math.abs(h);
  })();
  const timePhrase = TIME_PHRASES[tod][seed % TIME_PHRASES[tod].length];
  const fragment   = FRAGMENTS[(seed >> 7) % FRAGMENTS.length];

  const name = profile.name || 'reader';
  const sinceLabel = stats && stats.since ? `Last opened ${stats.since}.`
                   : stats ? 'First time here.'
                   : '';

  return (
    <div style={{
      padding: '14px 32px 6px',
      fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
      fontStyle: 'italic',
      fontSize: 13.5,
      color: 'var(--ink-faint)',
      opacity: dimmed ? 0.32 : 0.88,
      transition: 'opacity 1800ms cubic-bezier(0.22, 1, 0.36, 1)',
      pointerEvents: 'none',
      userSelect: 'none',
      letterSpacing: '0.005em',
      lineHeight: 1.55,
    }}>
      <div>
        Welcome back, <span style={{ color: 'var(--ink-title)' }}>{name}</span>, {timePhrase}. {fragment}
      </div>
      {stats && (sinceLabel || stats.untouched > 0 || stats.fading > 0) && (
        <div style={{ marginTop: 2 }}>
          {sinceLabel}
          {stats.untouched > 0 && (
            <> <span style={{ color: 'var(--brass-bright)' }}>{stats.untouched}</span> untouched in 7+ days.</>
          )}
          {stats.fading > 0 && (
            <> <span style={{ color: 'var(--brass-mid)' }}>{stats.fading}</span> fading.</>
          )}
        </div>
      )}
    </div>
  );
}

// Human-readable duration since N ms ago. "2 days ago" / "3 hours ago" / "now".
function humanSince(ms) {
  if (!ms || ms < 0) return 'now';
  const min = ms / 60000;
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.floor(min)} min ago`;
  const h = min / 60;
  if (h < 24) return `${Math.floor(h)} hour${Math.floor(h) === 1 ? '' : 's'} ago`;
  const d = h / 24;
  if (d < 30) return `${Math.floor(d)} day${Math.floor(d) === 1 ? '' : 's'} ago`;
  const mo = d / 30;
  if (mo < 12) return `${Math.floor(mo)} month${Math.floor(mo) === 1 ? '' : 's'} ago`;
  return `${Math.floor(mo / 12)} year${Math.floor(mo / 12) === 1 ? '' : 's'} ago`;
}

function loadLayout() {
  try {
    const data = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}');
    return {
      vaultWidth: typeof data.vaultWidth === 'number' ? data.vaultWidth : VAULT_DEFAULT,
      terminalWidth: typeof data.terminalWidth === 'number' ? data.terminalWidth : TERM_DEFAULT,
      vaultRetracted: !!data.vaultRetracted,
      terminalRetracted: !!data.terminalRetracted,
    };
  } catch (_) {
    return { vaultWidth: VAULT_DEFAULT, terminalWidth: TERM_DEFAULT, vaultRetracted: false, terminalRetracted: false };
  }
}

function saveLayout(state) {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(state)); } catch (_) {}
}

function ResizeHandle({ side, onDrag, onCommit, onDoubleClick, hint }) {
  const [hovered, setHovered] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);

  const onMouseDown = React.useCallback((e) => {
    e.preventDefault();
    setDragging(true);
    document.body.classList.add('ptor-resizing');
    let lastX = e.clientX;
    const onMove = (ev) => {
      const dx = ev.clientX - lastX;
      lastX = ev.clientX;
      onDrag(side === 'left' ? dx : -dx);
    };
    const onUp = () => {
      setDragging(false);
      document.body.classList.remove('ptor-resizing');
      onCommit && onCommit();
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [onDrag, onCommit, side]);

  // Hairline opacity: dragging > hint > hover > rest
  const opacity = dragging ? 0.85 : (hint ? 0.32 : (hovered ? 0.32 : 0));

  return (
    <div
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 6, marginLeft: -3, marginRight: -3,
        cursor: 'none', position: 'relative',
        zIndex: 10, flexShrink: 0,
        userSelect: 'none',
      }}
    >
      <div style={{
        position: 'absolute', top: 0, bottom: 0, left: '50%',
        width: dragging ? 2 : 1,
        transform: dragging ? 'translateX(-1px)' : 'translateX(-0.5px)',
        background: 'var(--brass-mid)',
        opacity,
        transition: dragging
          ? 'opacity 140ms cubic-bezier(0.22,1,0.36,1), width 140ms, transform 140ms'
          : 'opacity 1400ms cubic-bezier(0.22,1,0.36,1), width 140ms, transform 140ms',
        pointerEvents: 'none',
      }} />
    </div>
  );
}

// Single first-launch whisper: "Lesezimmer — Ctrl+." appears once after 45s idle,
// fades after 6s OR after first Ctrl+. press. localStorage flag = never again.
function LesezimmerWhisper() {
  const [shown, setShown] = React.useState(false);
  const [fading, setFading] = React.useState(false);

  React.useEffect(() => {
    let storedSeen;
    try { storedSeen = localStorage.getItem('ptor.lesezimmer.seen'); } catch (_) {}
    if (storedSeen) return;

    const showTimer = setTimeout(() => setShown(true), 45000);

    const onKey = (e) => {
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && e.key === '.') {
        try { localStorage.setItem('ptor.lesezimmer.seen', '1'); } catch (_) {}
        setFading(true);
        setTimeout(() => setShown(false), 800);
      }
    };
    window.addEventListener('keydown', onKey);

    return () => {
      clearTimeout(showTimer);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  React.useEffect(() => {
    if (!shown) return;
    try { localStorage.setItem('ptor.lesezimmer.seen', '1'); } catch (_) {}
    const fadeTimer = setTimeout(() => setFading(true), 6000);
    const hideTimer = setTimeout(() => setShown(false), 6800);
    return () => { clearTimeout(fadeTimer); clearTimeout(hideTimer); };
  }, [shown]);

  if (!shown) return null;

  return (
    <div style={{
      position: 'fixed', bottom: 28, left: '50%',
      transform: 'translateX(-50%)',
      fontFamily: '"JetBrains Mono", monospace', fontSize: 11,
      letterSpacing: '0.04em',
      color: 'var(--pearl)',
      opacity: fading ? 0 : 0.72,
      transition: 'opacity 800ms cubic-bezier(0.22,1,0.36,1)',
      pointerEvents: 'none', zIndex: 100,
      whiteSpace: 'nowrap',
    }}>
      <em style={{ fontFamily: '"EB Garamond", "Cormorant Garamond", Georgia, serif', fontStyle: 'italic', fontSize: 14 }}>Lesezimmer</em>
      <span style={{ opacity: 0.6 }}> — Ctrl + .</span>
    </div>
  );
}

// AtlasView — Theatrum Stratigraphicum.
//
// Per dialectics/2026-04-28-atlas-theatrum-stratigraphicum.md (Lung+Leo+Muse
// council): atlas IS NOT a project blueprint store. It is a corpus-shape
// dashboard — 4 horizontal strata bands by reinforcement strength
// (live ≥0.7 / warm 0.4-0.7 / cooling 0.2-0.4 / dormant <0.2), x-axis within
// each band = log(days_since_last_event), right edge = today. Click → specimen
// slab lifts above the strata with title, folder, top-5 co-cites (hush hairlines).
//
// Empty state = vitrine labels + italic Garamond. Per Muse + Lung: emptiness
// must be visually structured because day-zero is a real corpus moment.
//
// Blueprint .md files (frontmatter `kind: project|blueprint`) are NOT shown
// here as a card library. They render inline inside NoteView via ProjectHeader
// (vision → standfirst, pillars + open_questions → editorial diptych header).
//
// Falsifier (Leo): user opens atlas <1×/week after week 2 → kill surface.

const ATLAS_BANDS = [
  { id: 'live',    label: 'live',    tint: 'var(--atlas-band-live)',    stroke: 'var(--accent-teal)' },
  { id: 'warm',    label: 'warm',    tint: 'var(--atlas-band-warm)',    stroke: 'var(--brass-amber)' },
  { id: 'cooling', label: 'cooling', tint: 'var(--atlas-band-cooling)', stroke: 'var(--brass-mid)' },
  { id: 'dormant', label: 'dormant', tint: 'var(--atlas-band-dormant)', stroke: 'var(--ink-faint)' },
];

function bandOf(strength) {
  if (strength >= 0.7) return ATLAS_BANDS[0];
  if (strength >= 0.4) return ATLAS_BANDS[1];
  if (strength >= 0.2) return ATLAS_BANDS[2];
  return ATLAS_BANDS[3];
}

// Convert main.js list IPC `since` ("now" / "5m" / "3h" / "2d" / "·") to days.
function sinceToDays(since) {
  if (!since || since === '·') return 365;
  if (since === 'now') return 0;
  const m = since.match(/^(\d+)([mhd])$/);
  if (!m) return 365;
  const n = parseInt(m[1], 10);
  if (m[2] === 'm') return n / (60 * 24);
  if (m[2] === 'h') return n / 24;
  if (m[2] === 'd') return n;
  return 365;
}

// log-scaled x in [0,1]. right edge = today, left edge ≈ 1y ago.
function daysToX(days) {
  const k = Math.log(1 + Math.min(days, 365)) / Math.log(366);
  return 1 - k;
}

// stable per-id y-jitter so dots don't pile up at center of band
function yJitter(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h * 31) + id.charCodeAt(i)) >>> 0;
  return 0.25 + (h % 1000) / 1800; // [0.25, 0.80]
}

function AtlasView() {
  const [items, setItems] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [hoverId, setHoverId] = React.useState(null);
  const [activeId, setActiveId] = React.useState(null);
  const [activeMeta, setActiveMeta] = React.useState(null);
  const [activeSimilar, setActiveSimilar] = React.useState([]);

  // Apply atlas chromatic register on mount, restore on unmount. Observe
  // data-theme mutations to re-prefix when ThemeToggle writes 'night'/'day'
  // (prevents card-dissolve bug after theme toggle).
  React.useEffect(() => {
    const root = document.documentElement;
    const prev = root.getAttribute('data-theme') || 'night';
    const isNight = prev === 'night' || prev === 'atlas-night';
    root.setAttribute('data-theme', isNight ? 'atlas-night' : 'atlas-day');

    const obs = new MutationObserver(() => {
      const cur = root.getAttribute('data-theme');
      if (cur === 'night') root.setAttribute('data-theme', 'atlas-night');
      else if (cur === 'day') root.setAttribute('data-theme', 'atlas-day');
    });
    obs.observe(root, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      obs.disconnect();
      const cur = root.getAttribute('data-theme');
      const wasNight = cur === 'atlas-night' || cur === 'night';
      root.setAttribute('data-theme', wasNight ? 'night' : 'day');
    };
  }, []);

  // Load vault list + bulk strength map in parallel. Notes never event-logged
  // fall back to baseline 0.7 (matches RecallDashboard convention; matches
  // reinforce.js DEFAULT_IMPORTANCE × decay-by-mtime).
  React.useEffect(() => {
    if (!window.ptor || !window.ptor.vault) { setLoading(false); return; }
    let cancelled = false;
    const strengthsP = (window.ptor.corpus && window.ptor.corpus.strengths)
      ? window.ptor.corpus.strengths().catch(() => ({}))
      : Promise.resolve({});
    Promise.all([window.ptor.vault.list(), strengthsP]).then(([res, strs]) => {
      if (cancelled) return;
      const folders = (res && res.folders) || [];
      const all = folders.flatMap(f =>
        (f.items || []).map(i => {
          const s = strs && strs[i.id] != null ? strs[i.id] : 0.7;
          const days = sinceToDays(i.since);
          return {
            id: i.id,
            label: i.label || i.id,
            folder: f.folder || '',
            since: i.since || '',
            strength: s,
            days,
            x: daysToX(days),
            band: bandOf(s),
          };
        })
      );
      setItems(all);
      setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // When a dot is clicked, fetch per-note meta (cite/recall counts) + co-cites.
  // Both calls are tolerant of backend absence — corpus is optional.
  React.useEffect(() => {
    if (!activeId || !window.ptor || !window.ptor.corpus) {
      setActiveMeta(null); setActiveSimilar([]); return;
    }
    let cancelled = false;
    if (window.ptor.corpus.meta) {
      window.ptor.corpus.meta(activeId)
        .then(m => { if (!cancelled) setActiveMeta(m); })
        .catch(() => {});
    }
    if (window.ptor.corpus.similar) {
      window.ptor.corpus.similar(activeId, 5)
        .then(s => { if (!cancelled) setActiveSimilar(Array.isArray(s) ? s : []); })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [activeId]);

  const active = activeId ? items.find(i => i.id === activeId) : null;
  const isEmpty = !loading && items.length === 0;

  return (
    <div style={{
      flex: 1, position: 'relative', display: 'flex', flexDirection: 'column',
      // Mirrored radial gradient palette already wired via atlas-night / atlas-day
      background: 'var(--bg-page)',
      backgroundColor: 'var(--bg-base)',
      color: 'var(--atlas-ink-primary)',
      overflow: 'hidden', minHeight: 0,
    }}>
      {/* folio header */}
      <div style={{
        padding: '16px 32px 12px',
        display: 'flex', alignItems: 'baseline', gap: 14,
        fontFamily: '"JetBrains Mono", monospace', fontSize: 11,
        letterSpacing: '0.06em', color: 'var(--atlas-ink-dim)',
        borderBottom: '0.5px solid var(--atlas-hairline)',
      }}>
        <span>atlas</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span style={{ opacity: 0.7 }}>theatrum stratigraphicum</span>
        <span style={{ marginLeft: 'auto', opacity: 0.6 }}>
          {loading ? 'gathering…' : `${items.length} notes`}
        </span>
      </div>

      {/* Specimen slab — lifts when a dot is clicked. Italic Garamond title,
          JBM band/folder/since meta, hush hairlines for top-5 co-cites. */}
      {active && (
        <div style={{
          padding: '24px 56px 22px',
          borderBottom: '0.5px solid var(--atlas-hairline)',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <div style={{
            fontFamily: '"JetBrains Mono", monospace', fontSize: 10.5,
            letterSpacing: '0.06em', color: 'var(--atlas-ink-dim)',
            display: 'flex', gap: 14, alignItems: 'baseline',
          }}>
            <span>{active.band.label}</span>
            <span style={{ opacity: 0.5 }}>·</span>
            <span>{active.folder || 'root'}</span>
            <span style={{ opacity: 0.5 }}>·</span>
            <span>{active.since || 'untouched'}</span>
            <button
              onClick={() => setActiveId(null)}
              style={{
                marginLeft: 'auto',
                background: 'transparent', border: 'none', cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 'inherit', letterSpacing: 'inherit',
                color: 'var(--atlas-ink-dim)', padding: 0,
              }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--atlas-ink-primary)'; }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--atlas-ink-dim)'; }}
            >dismiss ✕</button>
          </div>
          <div style={{
            fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
            fontStyle: 'italic', fontSize: 26, fontWeight: 500,
            color: 'var(--atlas-ink-primary)', lineHeight: 1.2,
            letterSpacing: '-0.005em',
          }}>
            {active.label.replace(/\.md$/i, '').replace(/[-_]+/g, ' ')}
          </div>
          {activeSimilar.length > 0 && (
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 6,
              alignItems: 'baseline',
            }}>
              <span style={{
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 9.5, letterSpacing: '0.08em',
                color: 'var(--atlas-ink-dim)', opacity: 0.7,
              }}>cited with</span>
              {activeSimilar.map((s, i) => {
                const lbl = String(s.rel || '').split('/').pop().replace(/\.md$/i, '').replace(/[-_]+/g, ' ');
                return (
                  <span key={i} style={{
                    fontFamily: '"EB Garamond", Georgia, serif',
                    fontStyle: 'italic', fontSize: 13,
                    color: 'var(--hush)',
                    borderBottom: '1px solid var(--hush)',
                    paddingBottom: 1,
                  }}>{lbl}</span>
                );
              })}
            </div>
          )}
          {activeMeta && (activeMeta.citeCount > 0 || activeMeta.recallCount > 0 || active.strength != null) && (
            <div style={{
              fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
              letterSpacing: '0.04em', color: 'var(--atlas-ink-dim)',
              opacity: 0.7, marginTop: 4,
              display: 'flex', gap: 14,
            }}>
              {activeMeta.citeCount > 0 && <span>cited {activeMeta.citeCount}×</span>}
              {activeMeta.recallCount > 0 && <span>recalled {activeMeta.recallCount}×</span>}
              <span>strength {Math.round((active.strength || 0) * 100)}</span>
            </div>
          )}
        </div>
      )}

      {/* Strata stage. 4 bands stacked vertically, dots placed at left =
          log(days_since_last_event), staggered y per stable id-hash. */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        padding: '24px 56px 56px', overflow: 'auto',
      }}>
        {isEmpty ? (
          <EmptyTheatrum />
        ) : loading ? (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: '"EB Garamond", Georgia, serif', fontStyle: 'italic',
            fontSize: 16, color: 'var(--atlas-ink-dim)',
          }}>gathering strata…</div>
        ) : (
          ATLAS_BANDS.map((band, bandIx) => {
            const bandItems = items.filter(it => it.band.id === band.id);
            const hasActive = active && active.band.id === band.id;
            const dim = active ? !hasActive : false;
            const isLast = bandIx === ATLAS_BANDS.length - 1;
            const hovered = hoverId && bandItems.find(it => it.id === hoverId);
            return (
              <div key={band.id}
                style={{
                  position: 'relative',
                  flex: 1, minHeight: 96,
                  background: band.tint,
                  borderTop: '0.5px solid var(--atlas-hairline)',
                  opacity: dim ? 0.4 : 1,
                  transition: 'opacity 200ms cubic-bezier(0.22,1,0.36,1)',
                }}>
                <div style={{
                  position: 'absolute', left: 12, top: 8,
                  fontFamily: '"JetBrains Mono", monospace', fontSize: 9.5,
                  letterSpacing: '0.08em', color: 'var(--atlas-ink-dim)',
                  opacity: 0.65,
                }}>{band.label}</div>
                <div style={{
                  position: 'absolute', right: 12, top: 8,
                  fontFamily: '"JetBrains Mono", monospace', fontSize: 9.5,
                  letterSpacing: '0.04em', color: 'var(--atlas-ink-dim)',
                  opacity: 0.5,
                }}>{bandItems.length}</div>
                {isLast && (
                  <>
                    <div style={{
                      position: 'absolute', left: 12, bottom: 6,
                      fontFamily: '"JetBrains Mono", monospace', fontSize: 9,
                      letterSpacing: '0.06em', color: 'var(--atlas-ink-dim)', opacity: 0.5,
                    }}>1y ago</div>
                    <div style={{
                      position: 'absolute', right: 12, bottom: 6,
                      fontFamily: '"JetBrains Mono", monospace', fontSize: 9,
                      letterSpacing: '0.06em', color: 'var(--atlas-ink-dim)', opacity: 0.5,
                    }}>today →</div>
                  </>
                )}
                {bandItems.map(it => {
                  const isHover = hoverId === it.id;
                  const isActive = activeId === it.id;
                  const y = yJitter(it.id);
                  return (
                    <button key={it.id}
                      onMouseEnter={() => setHoverId(it.id)}
                      onMouseLeave={() => setHoverId(null)}
                      onClick={() => setActiveId(it.id === activeId ? null : it.id)}
                      title={it.label.replace(/\.md$/i, '')}
                      aria-label={it.label}
                      style={{
                        position: 'absolute',
                        left: `calc(${it.x * 100}% - 5px)`,
                        top: `calc(${y * 100}% - 5px)`,
                        width: isActive ? 14 : (isHover ? 12 : 8),
                        height: isActive ? 14 : (isHover ? 12 : 8),
                        borderRadius: '50%',
                        background: isActive
                          ? 'var(--atlas-opportunity)'
                          : (isHover ? band.stroke : 'var(--atlas-ink-primary)'),
                        opacity: isActive ? 1 : (isHover ? 0.95 : 0.55),
                        border: 'none', padding: 0, cursor: 'pointer',
                        boxShadow: isActive
                          ? '0 0 0 2px var(--atlas-bg-deep), 0 0 18px var(--atlas-opportunity)'
                          : (isHover ? '0 0 0 2px var(--atlas-bg-deep)' : 'none'),
                        transition: 'width 160ms, height 160ms, opacity 160ms, box-shadow 160ms, background 160ms',
                      }}
                    />
                  );
                })}
                {hovered && (() => {
                  const it = hovered;
                  const y = yJitter(it.id);
                  const onRight = it.x < 0.5;
                  return (
                    <div style={{
                      position: 'absolute',
                      left: onRight ? `calc(${it.x * 100}% + 14px)` : 'auto',
                      right: onRight ? 'auto' : `calc(${(1 - it.x) * 100}% + 14px)`,
                      top: `calc(${y * 100}% - 9px)`,
                      fontFamily: '"EB Garamond", Georgia, serif', fontStyle: 'italic',
                      fontSize: 13, color: 'var(--atlas-ink-primary)',
                      whiteSpace: 'nowrap', pointerEvents: 'none',
                      opacity: 0.95,
                      maxWidth: '36ch',
                      overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{it.label.replace(/\.md$/i, '').replace(/[-_]+/g, ' ')}</div>
                  );
                })()}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// Empty-state vitrine — the strata stay visible at zero notes. Per Muse + Lung
// dialectic 2026-04-28: emptiness must be visually structured because the
// day-zero state is a real corpus moment, not an error.
function EmptyTheatrum() {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      gap: 0,
    }}>
      {ATLAS_BANDS.map(band => (
        <div key={band.id} style={{
          flex: 1, minHeight: 64,
          background: band.tint,
          borderTop: '0.5px solid var(--atlas-hairline)',
          position: 'relative',
        }}>
          <div style={{
            position: 'absolute', left: 12, top: '50%',
            transform: 'translateY(-50%)',
            fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
            letterSpacing: '0.08em', color: 'var(--atlas-ink-dim)',
            opacity: 0.45,
          }}>{band.label}</div>
        </div>
      ))}
      <div style={{
        textAlign: 'center',
        fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
        fontStyle: 'italic', fontSize: 18,
        color: 'var(--atlas-ink-primary)', opacity: 0.7,
        maxWidth: '38ch', lineHeight: 1.55,
        margin: '28px auto 0',
      }}>
        atlas brightens with reinforcement. write a note or open one to begin.
      </div>
    </div>
  );
}


// Inject the view-mode reveal keyframes once, globally.
// Per 2026-04-28 user direction: "不急不徐 从隐到显" — unhurried reveal,
// new view appears from hidden, NOT a crossfade between two surfaces.
// 720ms cubic-bezier(0.22, 1, 0.36, 1) — quiet ease-out. Opacity 0→1 +
// translateY(10px → 0) + slight blur softening at start (only first 200ms).
if (typeof document !== 'undefined' && !document.getElementById('ptor-view-reveal-style')) {
  const s = document.createElement('style');
  s.id = 'ptor-view-reveal-style';
  s.textContent = `
    @keyframes ptor-view-reveal {
      0%   { opacity: 0; transform: translateY(10px); filter: blur(2px); }
      30%  { filter: blur(0); }
      100% { opacity: 1; transform: translateY(0);   filter: blur(0); }
    }
    .ptor-view-shell {
      flex: 1; display: flex; min-width: 0; min-height: 0;
      overflow: hidden;
      animation: ptor-view-reveal 720ms cubic-bezier(0.22, 1, 0.36, 1);
      will-change: opacity, transform;
    }
  `;
  document.head.appendChild(s);
}

function PTorApp() {
  const [tab, setTab] = React.useState('verify');
  const [active, setActive] = React.useState(null);
  const [transitioning, setTransitioning] = React.useState(false);

  // Global listener for ptor:open-rel custom events. NoteView col-3 vault
  // peers dispatch this on click to navigate without prop drill. Per /tr
  // 2026-04-29 council col-3 must be functional, not decorative.
  React.useEffect(() => {
    const onOpenRel = (e) => {
      if (e && e.detail && typeof e.detail === 'string') {
        setActive(e.detail);
      }
    };
    window.addEventListener('ptor:open-rel', onOpenRel);
    return () => window.removeEventListener('ptor:open-rel', onOpenRel);
  }, []);
  // viewMode = which top-level surface is shown. Brand-fades-into-state per
  // 2026-04-27 atlas council: clicking the wordmark cycles 'note' ↔ 'atlas'.
  // Hypha 2026-04-30: viewMode = { 'evolution' (default lesson) | 'recall' (storage) | 'colophon' (settings prose) }.
  // 'colophon' added 2026-04-30 (LUNG+LEO+YOGO council): replaces the old
  // settings modal — Cmd+, navigates here instead of opening a portal.
  // The actual initial value is hydrated from settings.app.defaultView in the
  // mount effect below — initial 'evolution' is just a paint-friendly default.
  const [viewMode, setViewMode] = React.useState('evolution');
  // v0.11.2 — concept page surface. When user clicks [[concept]] in any note
  // and wikiResolve returns kind='concept', NoteView dispatches
  // `hypha:open-concept-page` with { slug, idx, term }. We mount
  // ConceptLogbookPanel in the right rail (replacing the per-note ConceptAtlas)
  // until user closes it or navigates to another note. Per /tr 2026-05-02
  // wiki+gbrain three-piece (B — concept-as-page).
  const [conceptPage, setConceptPage] = React.useState(null);
  React.useEffect(() => {
    const onOpen = (e) => {
      const detail = e && e.detail;
      if (!detail || !detail.slug || !detail.term) return;
      setConceptPage(detail);
      setViewMode('evolution');
    };
    window.addEventListener('hypha:open-concept-page', onOpen);
    return () => window.removeEventListener('hypha:open-concept-page', onOpen);
  }, []);
  // viewBeforeColophon — remembers where the user was before opening the
  // colophon, so Esc returns there rather than always to evolution.
  const viewBeforeColophonRef = React.useRef('evolution');

  // v0.4.4 — hoist curriculum-creation state above viewMode switching so that
  // navigating to settings/recall (which unmounts HyphaEvolutionWelcome) and
  // back doesn't reset the form. While creatingTopic is non-null, the welcome
  // surface always renders the 'creating' phase regardless of remount cycles.
  // ESC at app level cancels active creation when not in colophon (colophon
  // owns its own ESC behavior — exit colophon).
  const [creatingTopic, setCreatingTopic] = React.useState(null);

  // Smooth cross-fade between viewModes via the CSS View Transitions API
  // (Chrome 111+, supported by Electron 35). Wraps any setViewMode call;
  // falls back to instant change on browsers without support.
  // CSS rules in colors_and_type.css define the 320ms tonal fade.
  const startViewMode = React.useCallback((next) => {
    // setViewMode accepts either a value or an updater fn — React resolves it
    // internally with the latest state, so this helper has no stale-state risk
    // and an empty deps array keeps event listeners from re-binding.
    if (typeof document.startViewTransition !== 'function') {
      setViewMode(next);
      return;
    }
    // v0.8.3 per /tr council 2026-05-02 (LUNG H2 + LEO Symptom 2): pause
    // chouguang-breath WAAPI animations during the view-transition snapshot
    // window so the BEFORE/AFTER snapshots don't capture rows mid-cycle.
    // Bounded resume on transition.finished — no leak (SCOUT's iterations:
    // Infinity + pause leak only matters for forgotten pauses; we resume
    // within ~320ms).
    const paused = [];
    if (typeof document.getAnimations === 'function') {
      document.getAnimations().forEach(a => {
        if (a && a.id === 'chouguang-breath' && a.playState === 'running') {
          try { a.pause(); paused.push(a); } catch (_) {}
        }
      });
    }
    const transition = document.startViewTransition(() => {
      // React 18 batching: state inside the callback is flushed synchronously
      // when the callback returns (or its returned promise resolves), which
      // is when the View Transitions API takes the "after" snapshot.
      setViewMode(next);
    });
    const resume = () => paused.forEach(a => { try { a.play(); } catch (_) {} });
    if (transition && transition.finished && typeof transition.finished.finally === 'function') {
      transition.finished.finally(resume);
    } else {
      // Older API or no transition object — resume immediately.
      resume();
    }
  }, []);

  // Open the colophon view from anywhere via Cmd+, → dispatched event from
  // VaultTree's keybinding handler. Esc returns to the prior view.
  React.useEffect(() => {
    const onOpen = () => {
      startViewMode(prev => {
        if (prev !== 'colophon') viewBeforeColophonRef.current = prev;
        return 'colophon';
      });
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const isInput = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
      if (isInput) return;     // let the inline editor consume Esc first
      // Colophon's ESC always wins (existing behavior).
      if (viewMode === 'colophon') {
        e.preventDefault();
        startViewMode(viewBeforeColophonRef.current || 'evolution');
        return;
      }
      // v0.4.4 — ESC during curriculum creation cancels it.
      if (creatingTopic) {
        e.preventDefault();
        try { window.dispatchEvent(new CustomEvent('hypha:cancel-create', { detail: { topic: creatingTopic } })); } catch (_) {}
      }
    };
    window.addEventListener('hypha:open-colophon', onOpen);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('hypha:open-colophon', onOpen);
      window.removeEventListener('keydown', onKey);
    };
  }, [viewMode, creatingTopic]);

  // Open evolution view from anywhere — VaultTree "+" dispatches this so
  // clicking + in settings/recall jumps back to evolution + then opens Learn.
  React.useEffect(() => {
    const onOpen = () => startViewMode('evolution');
    window.addEventListener('hypha:open-evolution', onOpen);
    return () => window.removeEventListener('hypha:open-evolution', onOpen);
  }, []);

  // v0.2.1 — Concept Logbook navigation. ConceptLogbookPanel dispatches
  // 'hypha:pick-lesson' when user clicks a lesson row in a concept's
  // biography. We open that lesson in evolution mode (same as if the user
  // had clicked it in vault tree).
  React.useEffect(() => {
    const onPick = (e) => {
      const targetRel = e && e.detail && e.detail.rel;
      if (!targetRel) return;
      startViewMode('evolution');
      setActive(targetRel);
    };
    window.addEventListener('hypha:pick-lesson', onPick);
    return () => window.removeEventListener('hypha:pick-lesson', onPick);
  }, []);

  // 2026-05-01: ChainPlannerView mounts at App root (escapes VaultTree's
  // stacking trap that cramped the modal into a 250px column). Welcome
  // form's "plan a chain →" link dispatches `hypha:open-chain-planner`
  // with detail = { topic, goal, timeCommit, clarifications }. Chain
  // planner is now a pure result view — it auto-loads from this context,
  // no separate form to fill (per user 2026-05-01: "chain 不是一个过程
  // 而是结果，是分析原过程将这些作为参数然后生成的推荐结果").
  const [chainContext, setChainContext] = React.useState(null);
  React.useEffect(() => {
    const onOpenChain = (e) => {
      const detail = (e && e.detail) || {};
      // Require at least topic or goal so the planner has something to chain.
      if (!detail.topic && !detail.goal) return;
      setChainContext(detail);
    };
    window.addEventListener('hypha:open-chain-planner', onOpenChain);
    return () => window.removeEventListener('hypha:open-chain-planner', onOpenChain);
  }, []);

  // v0.8.4 — recall and evolution share 'day' theme. Previous code flipped
  // between 'day' and 'atlas-day' on view-mode change; day's --bg-base
  // (#F0D9C8 ivory) and atlas-day's (#C6B29B dust-stone) are visibly different
  // (~20% luminance drop), and during the view-transition cross-fade EVERY
  // backdrop-filter element (NavRail / VaultTree / titlebar / glass surfaces)
  // resampled the new darker backdrop, producing user-reported "白色方块变黑"
  // chrome darkening + perceived flicker + lag (snapshot rasterizing many
  // re-blurred regions). Theme.jsx still sets 'day' globally on app mount;
  // removing this override means BEFORE/AFTER view-transition snapshots have
  // identical theme tokens, so chrome stays static across the switch — only
  // the content area crossfades. If recall mode chromatic distinction is
  // re-desired later, scope it via `body[data-mode="recall"]` selectors on
  // specific recall components, NOT via global --bg-base token mutation.

  // Hypha — apply settings.app to document root + viewMode + listen for live
  // updates. Font CSS vars cascade into ChatBubble (size/line-height/family).
  // defaultView only seeds initial mount; subsequent toggles aren't reverted.
  React.useEffect(() => {
    const FONT_SIZE = {
      small:   { tutor: ['15px', '24px'], user: ['13px', '20px'] },
      default: { tutor: ['17px', '27px'], user: ['15px', '22px'] },
      large:   { tutor: ['19px', '30px'], user: ['15px', '24px'] },
    };
    const FONT_FAMILY = {
      editorial: '"EB Garamond", "Noto Serif SC", Georgia, serif',
      system:    'system-ui, -apple-system, "Segoe UI", "Helvetica Neue", "PingFang SC", sans-serif',
    };
    const apply = (app) => {
      const sz = FONT_SIZE[app && app.fontSize] || FONT_SIZE.default;
      const fam = FONT_FAMILY[app && app.fontFamily] || FONT_FAMILY.editorial;
      const root = document.documentElement;
      root.style.setProperty('--chat-tutor-size', sz.tutor[0]);
      root.style.setProperty('--chat-tutor-line', sz.tutor[1]);
      root.style.setProperty('--chat-user-size', sz.user[0]);
      root.style.setProperty('--chat-user-line', sz.user[1]);
      root.style.setProperty('--chat-font-family', fam);
      root.style.setProperty('--chat-breath-width', '2px');
      root.style.setProperty('--chat-breath-offset', '18px');
    };
    // v0.8.6 — apply font CSS variables SYNCHRONOUSLY on mount using the
    // last-known settings cached in localStorage. Without this, ChatBubble's
    // fontSize falls through to the inline-style fallback (17px) for the
    // ~50-200ms it takes settingsGet IPC to resolve; if user chose 'large'
    // (19px) or 'small' (15px), text VISIBLY reflows once the var arrives.
    // User reported "聊天先生成小版文字过一会突然放大到正常大小" — exactly this.
    // localStorage is synchronous and in-process so the first paint already
    // has the user's chosen size. The async settingsGet still runs as before
    // and updates the cache if it differs (rare; only after edit elsewhere).
    let cachedApp = {};
    try {
      const raw = window.localStorage.getItem('hypha:lastAppSettings');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') cachedApp = parsed;
      }
    } catch (_) {}
    apply(cachedApp);
    let firstLoad = true;
    const reload = () => {
      if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.settingsGet) return;
      window.ptor.hypha.settingsGet().then(s => {
        const app = (s && s.app) || {};
        apply(app);
        try { window.localStorage.setItem('hypha:lastAppSettings', JSON.stringify(app)); } catch (_) {}
        if (firstLoad) {
          firstLoad = false;
          if (app.defaultView === 'recall' || app.defaultView === 'evolution') {
            setViewMode(app.defaultView);
          }
        }
      }).catch(() => apply({}));
    };
    reload();
    const onUpdate = () => reload();
    window.addEventListener('hypha:settings-updated', onUpdate);
    return () => window.removeEventListener('hypha:settings-updated', onUpdate);
  }, []);
  const contentRef = React.useRef(null);

  const initial = React.useMemo(loadLayout, []);
  const [vaultWidth, setVaultWidth] = React.useState(initial.vaultWidth);
  const [termWidth,  setTermWidth]  = React.useState(initial.terminalWidth);
  const [vaultRetracted, setVaultRetracted] = React.useState(initial.vaultRetracted);
  const [termRetracted,  setTermRetracted]  = React.useState(initial.terminalRetracted);
  const [resizing, setResizing] = React.useState(false);
  // Sister-boundary glow — when one side retracts, the OTHER hairline brightens 1.4s.
  // Architecture teaches itself the symmetry. (Muse round 7 prescription E.)
  const [hintLeft, setHintLeft] = React.useState(false);
  const [hintRight, setHintRight] = React.useState(false);
  const prevVaultRetracted = React.useRef(vaultRetracted);
  const prevTermRetracted = React.useRef(termRetracted);

  React.useEffect(() => {
    if (vaultRetracted && !prevVaultRetracted.current) {
      // vault just retracted → hint the terminal-side handle
      if (!termRetracted) {
        setHintRight(true);
        const t = setTimeout(() => setHintRight(false), 1400);
        prevVaultRetracted.current = vaultRetracted;
        return () => clearTimeout(t);
      }
    }
    prevVaultRetracted.current = vaultRetracted;
  }, [vaultRetracted, termRetracted]);

  React.useEffect(() => {
    if (termRetracted && !prevTermRetracted.current) {
      // terminal just retracted → hint the vault-side handle
      if (!vaultRetracted) {
        setHintLeft(true);
        const t = setTimeout(() => setHintLeft(false), 1400);
        prevTermRetracted.current = termRetracted;
        return () => clearTimeout(t);
      }
    }
    prevTermRetracted.current = termRetracted;
  }, [termRetracted, vaultRetracted]);

  // Persist layout
  React.useEffect(() => {
    saveLayout({
      vaultWidth, terminalWidth: termWidth,
      vaultRetracted, terminalRetracted: termRetracted,
    });
  }, [vaultWidth, termWidth, vaultRetracted, termRetracted]);

  const Tab = { verify: VerifyTab, quiz: QuizTab, case: CaseTab, follow: FollowTab, graph: GraphTab }[tab];

  const smoothSwitch = React.useCallback((setter, value) => {
    const el = contentRef.current;
    if (!el || transitioning) { setter(value); return; }
    setTransitioning(true);
    el.animate(
      [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(6px)' }],
      { duration: 140, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' }
    ).onfinish = () => {
      setter(value);
      el.animate(
        [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' }
      ).onfinish = () => setTransitioning(false);
    };
  }, [transitioning]);

  const onSelectTab = React.useCallback((t) => {
    if (t === tab) {
      if (active) setActive(null);
      return;
    }
    smoothSwitch(setTab, t);
    if (active) setActive(null);
  }, [tab, active, smoothSwitch]);

  // Drag handlers — dragging suspends transition for direct control
  const onVaultDrag = React.useCallback((delta) => {
    setResizing(true);
    setVaultRetracted(false);
    setVaultWidth(w => {
      const next = w + delta;
      if (next < SNAP_THRESH) return SNAP_THRESH; // pin at threshold visual; commit decides
      return Math.min(MAX_VAULT, Math.max(MIN_WIDTH, next));
    });
  }, []);
  const onVaultCommit = React.useCallback(() => {
    setResizing(false);
    setVaultWidth(w => {
      if (w <= SNAP_THRESH + 4) {
        // Below threshold at release → retract
        setVaultRetracted(true);
        return VAULT_DEFAULT; // remember a sane default for next open
      }
      return w;
    });
  }, []);
  const onTermDrag = React.useCallback((delta) => {
    setResizing(true);
    setTermRetracted(false);
    setTermWidth(w => {
      const next = w + delta;
      if (next < SNAP_THRESH) return SNAP_THRESH;
      return Math.min(MAX_TERM, Math.max(MIN_WIDTH, next));
    });
  }, []);
  const onTermCommit = React.useCallback(() => {
    setResizing(false);
    setTermWidth(w => {
      if (w <= SNAP_THRESH + 4) {
        setTermRetracted(true);
        return TERM_DEFAULT;
      }
      return w;
    });
  }, []);

  // Keyboard shortcuts
  React.useEffect(() => {
    const onKey = (e) => {
      const cmd = e.metaKey || e.ctrlKey;
      const isInput = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
      if (cmd && e.key === '\\') {
        e.preventDefault();
        if (e.shiftKey) setTermRetracted(r => !r);
        else setVaultRetracted(r => !r);
      } else if (cmd && e.key === '.') {
        // Klimt mode: toggle both together
        e.preventDefault();
        const both = !(vaultRetracted && termRetracted);
        setVaultRetracted(both); setTermRetracted(both);
      } else if (e.key === 'Escape' && !isInput && active) {
        e.preventDefault();
        setActive(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [vaultRetracted, termRetracted, active]);

  const paneTransition = resizing
    ? 'none'
    : 'width 220ms cubic-bezier(0.32, 0.72, 0, 1)';

  const immersed = vaultRetracted && termRetracted;
  const toggleImmersion = React.useCallback(() => {
    const both = !immersed;
    setVaultRetracted(both);
    setTermRetracted(both);
  }, [immersed]);

  const toggleView = React.useCallback(() => {
    // Hypha 2026-04-30: viewMode = { 'evolution' (default) | 'recall' (storage) }.
    // Old 'atlas' Theatrum strata view retired for v0; 'recall' replaces it as
    // the read-only browse surface; 'evolution' is the active-lesson surface.
    startViewMode(v => v === 'evolution' ? 'recall' : 'evolution');
  }, []);

  // Both modes render the same NoteView shell. Mode prop threads through to
  // NoteView via TabContent so Tutor/Finish chrome only shows in evolution mode.
  return (
    <PTorWindow
      onHome={() => setActive(null)}
      immersed={immersed}
      onToggleImmersion={toggleImmersion}
      viewMode={viewMode}
      onToggleView={toggleView}
    >
      <div key="note" className="ptor-view-shell">
      {/* 长卷 v0.11.3 — Handscroll redesign. Tree-of-folders sidebar replaced
          by a 32px vertical brass-stroke ChainStrokeRail (one stroke per
          chain) on the left + a bottom-of-screen HandscrollFooter strip
          showing the active chain's full lesson sequence as dots with a
          brass seal at the current position. Killed: chain expand/collapse
          machinery, ResizeObserver height measurement, multi-level grid-rows
          transitions, the IIFE Map-grouping render that compounded bugs at
          1000+ rows. VaultTree still mounts invisibly off-screen so its
          settings/tutor/customize modals (triggered by global events
          + Cmd+, etc.) keep working — only its tree render is gone. */}
      <div style={{
        position: 'absolute', visibility: 'hidden', pointerEvents: 'none',
        width: 1, height: 1, overflow: 'hidden', left: -9999, top: -9999,
      }}>
        <VaultTree active={active} onSelect={setActive} viewMode={viewMode} />
      </div>

      {/* LEFT — chain stroke rail (32px, no resize, no collapse) */}
      <HandscrollNav.ChainStrokeRail activeRel={active} onSelect={setActive} />

      {/* CENTER — when immersed, prose centers in a 820px lane (roughly
          65-75ch at 17px Garamond). The empty side-margin is kept *empty*
          per Muse 2026-04-27 ruling: "do not let the matrix touch the
          Klimt." Future inline-diagram support (Lung's MARGINALIA_GRAVITY)
          can use the lane's own internal padding without colonizing the
          breathing room. */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Welcome banner — Living-Substrate Stage 1: surfaces TIME data the
            user already has but never sees, so the substrate stops feeling
            inert at boot. Auto-dims to ink-faint after 60s so it stays
            ambient. Evolution mode only — Colophon / Recall don't need it. */}
        {viewMode === 'evolution' && <WelcomeBanner />}
        {/* TabBar removed 2026-04-30: PTOR's verify/quiz/case/follow/graph tabs
            are vault-SRS workflow surfaces, not relevant to Hypha's curriculum
            learning loop. Tab variable still resolves to VerifyTab for routing. */}
        <div ref={contentRef} style={{
          flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
          willChange: 'opacity, transform',
          width: '100%',
          maxWidth: immersed ? 820 : '100%',
          alignSelf: immersed ? 'center' : 'stretch',
          transition: 'max-width 360ms cubic-bezier(0.32, 0.72, 0, 1)',
        }}>
          {viewMode === 'colophon' ? (
            <ColophonView />
          ) : (
            <Tab
              active={active}
              onPick={setActive}
              onBack={() => setActive(null)}
              viewMode={viewMode}
              creatingTopic={creatingTopic}
              setCreatingTopic={setCreatingTopic}
            />
          )}
        </div>
        {/* BOTTOM — handscroll strip (always visible in evolution mode). */}
        {viewMode === 'evolution' && (
          <HandscrollNav.HandscrollFooter activeRel={active} onSelect={setActive} />
        )}
      </div>

      {/* RIGHT — terminal rail */}
      <ResizeHandle
        side="right"
        onDrag={onTermDrag}
        onCommit={onTermCommit}
        onDoubleClick={() => setTermRetracted(r => !r)}
        hint={hintRight}
      />
      <div style={{
        width: termRetracted ? 0 : termWidth,
        // height: '100%' removed — was causing flex+overflow chain bug:
        // flex item default min-height:auto + child height:100% expanded
        // the rail to NavRail's full content, which got clipped by
        // .ptor-view-shell's overflow:hidden. NavRail's own overflow:auto
        // never triggered because it wasn't taller than its declared height.
        // Fix: this div becomes a flex column with min-height:0 so its
        // child (NavRail) can be flex:1 and own the actual scroll.
        display: 'flex', flexDirection: 'column', minHeight: 0,
        flexShrink: 0,
        overflow: 'hidden',
        transition: paneTransition,
        borderLeft: termRetracted ? 'none' : '1px solid var(--border-soft)',
      }}>
        {/* Right rail = navigation for the active note (TOC + see-also).
            LiveTerminal removed v0.1.6 — terminal didn't fit the editorial
            register and Cmd+K already covers the AI surface. vc-core code
            stays in lib/ for future Labs drawer.
            v0.11.2 — concept page (from wikilink → atlas resolution) takes
            precedence over per-note ConceptAtlas. Closes back to active
            note's atlas on user dismiss. */}
        {conceptPage && window.ConceptLogbookPanel
          ? <window.ConceptLogbookPanel
              slug={conceptPage.slug}
              conceptId={conceptPage.term}
              currentRel={active}
              onClose={() => setConceptPage(null)}
              onPickLesson={(targetRel) => {
                setConceptPage(null);
                if (targetRel) setActive(targetRel);
              }}
            />
          : active && viewMode === 'evolution' && window.ConceptAtlas
            ? <ConceptAtlas rel={active} />
            : <NavRail rel={active} onPick={setActive} />}
      </div>
      <LesezimmerWhisper />
      </div>
      {/* ChainPlannerView at App root — outside the PTorWindow flex tree so
          its position:fixed modal isn't clipped by sidebar containers.
          Triggered by `hypha:open-chain-planner` events with welcome-form
          context as detail. */}
      {window.ChainPlannerView && (
        <window.ChainPlannerView
          open={!!chainContext}
          onClose={() => setChainContext(null)}
          context={chainContext}
        />
      )}
    </PTorWindow>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<PTorApp />);
