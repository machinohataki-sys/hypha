// 长卷 Handscroll Navigation — replaces tree-of-folders sidebar.
// Two surfaces: ChainStrokeRail (far-left, 32px wide, vertical brass strokes
// for each chain) + HandscrollFooter (bottom-of-screen, horizontal scroll
// of lesson dots with a brass seal at current position).
//
// Substrate: state.json:lessonRels[] is already a 1-D ordered array per
// chain link. We flatten chain → all-lessons-in-link-order for the footer
// scroll. Scrolls active dot into center on selection change.
//
// Why no tree, no expand/collapse, no ResizeObserver: those were the bug
// class. This view never collapses, never animates height, never measures
// inner content. Total visible DOM: ~13 chain strokes + N lesson dots
// (where N is current chain's lesson count). At 1175 lessons across 13
// chains the active chain is at most ~175 dots — well within smooth render
// budget on the bottom strip's overflow-x scroll container.

function useChainData() {
  const [VAULT, setVault] = React.useState([]);
  const [loaded, setLoaded] = React.useState(false);

  const refresh = React.useCallback(() => {
    if (!window.ptor || !window.ptor.vault) {
      setLoaded(true);
      return Promise.resolve();
    }
    return window.ptor.vault.list().then(res => {
      setVault((res && res.folders) || []);
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  React.useEffect(() => { refresh(); }, [refresh]);

  // Refresh on curriculum:create completion (so newly-generated chain links appear)
  React.useEffect(() => {
    if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.onCurriculumProgress) return;
    return window.ptor.hypha.onCurriculumProgress((p) => {
      if (p && p.stage === 'done') refresh();
    });
  }, [refresh]);

  // 2026-05-03 — refresh on lesson:finish so the next-lesson unlock + the
  // distilled-state of the finished lesson surface in the rail/footer
  // immediately. Without this, vault:list's locked/distilled flags stay
  // stale until next manual reload.
  React.useEffect(() => {
    const onFinish = () => refresh();
    window.addEventListener('hypha:lesson-finished', onFinish);
    return () => window.removeEventListener('hypha:lesson-finished', onFinish);
  }, [refresh]);

  const chains = React.useMemo(() => {
    const map = new Map();
    for (const f of VAULT) {
      if (!f.chainSlug) continue;
      if (!map.has(f.chainSlug)) {
        map.set(f.chainSlug, {
          slug: f.chainSlug,
          ultimateGoal: f.chainUltimateGoal || f.chainSlug,
          totalLinks: f.chainTotalLinks || null,
          folders: [],
        });
      }
      map.get(f.chainSlug).folders.push(f);
    }
    for (const g of map.values()) {
      g.folders.sort((a, b) => (a.chainLinkIdx ?? 9999) - (b.chainLinkIdx ?? 9999));
    }
    return Array.from(map.values());
  }, [VAULT]);

  return { VAULT, chains, loaded, refresh };
}

// Determine which chain the active lesson belongs to. Returns null when
// there's no active lesson (welcome page, post-Esc) — do NOT silently fall
// back to chains[0], otherwise rail + footer falsely highlight a chain the
// user has not chosen, which leaks into the chain-create welcome screen.
function useActiveChain(activeRel, chains) {
  return React.useMemo(() => {
    if (!activeRel || !chains.length) return null;
    const folderName = String(activeRel).split('/')[0];
    for (const c of chains) {
      if (c.folders.some(f => f.folder === folderName)) return c;
    }
    return null;
  }, [activeRel, chains]);
}

// ─── ChainStrokeRail — vertical brass strokes, one per chain ───────────────
function ChainStrokeRail({ activeRel, onSelect }) {
  const { chains, loaded, refresh } = useChainData();
  const activeChain = useActiveChain(activeRel, chains);
  const [hoveredSlug, setHoveredSlug] = React.useState(null);
  // 2026-05-03 v0122 final — DESTROY = 长按 0.5s = 直接 soft-delete.
  // No 5s undo window, no drained state, no bounce-back.
  // Visual feedback during 0.5s: brass clip-path drains top→bottom.
  // mouseup < 0.5s = cancel (brass refills 200ms).
  // mouseup ≥ 0.5s = irrelevant (commit already fired).
  // Recovery: data/vault/.trash/ filesystem (7d auto-purge from v0121).
  const [pressing, setPressing] = React.useState(null);   // slug | null
  const pressTimerRef = React.useRef(null);

  const startPress = (chain) => {
    setPressing(chain.slug);
    pressTimerRef.current = setTimeout(async () => {
      pressTimerRef.current = null;
      setPressing(null);
      setHoveredSlug(prev => prev === chain.slug ? null : prev);
      const folders = chain.folders.map(f => f.folder);
      try {
        for (const fname of folders) {
          try { await window.ptor.vault.del(fname); } catch (_) {}
        }
        try { await window.ptor.vault.del(chain.slug); } catch (_) {}
        if (typeof refresh === 'function') await refresh();
      } catch (_) {}
    }, 500);
  };

  const cancelPress = () => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    setPressing(null);
  };

  // Cleanup timer on unmount.
  React.useEffect(() => () => {
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
  }, []);

  if (!loaded) {
    return <div style={{ width: 32, height: '100%', flexShrink: 0 }} />;
  }

  // Truncate the chain ultimate-goal for the slideout. Limit prevents the
  // tooltip from overrunning the lesson body when goals are paragraph-long.
  const truncateGoal = (s) => {
    if (!s) return '';
    if (s.length <= 36) return s;
    return s.slice(0, 36).trimEnd() + '…';
  };

  return (
    <div style={{
      width: 32, height: '100%', flexShrink: 0,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      paddingTop: 32, gap: 14,
      borderRight: '1px solid color-mix(in srgb, var(--brass-mid) 18%, transparent)',
      background: 'transparent',
      // Allow the tooltip to escape the rail's right edge.
      overflow: 'visible',
      position: 'relative',
      zIndex: 5,
    }}>
      {chains.map(c => {
        const isActive = activeChain && c.slug === activeChain.slug;
        const isHovered = hoveredSlug === c.slug;
        const isPressing = pressing === c.slug;
        return (
          <div
            key={c.slug}
            style={{
              position: 'relative',
              width: 32, height: 56,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <button
              type="button"
              onClick={() => {
                if (isPressing) return;
                const firstFolder = c.folders[0];
                if (!firstFolder || !firstFolder.items) return;
                const firstReal = firstFolder.items.find(it => !it.ghost && !it.locked) || firstFolder.items[0];
                if (firstReal) onSelect(firstReal.rel || firstReal.id);
              }}
              onMouseEnter={() => setHoveredSlug(c.slug)}
              onMouseLeave={() => {
                setHoveredSlug(prev => prev === c.slug ? null : prev);
                if (isPressing) cancelPress();
              }}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                startPress(c);
              }}
              onMouseUp={() => { if (isPressing) cancelPress(); }}
              onContextMenu={(e) => e.preventDefault()}
              style={{
                position: 'relative',
                width: 4, height: 56,
                background: 'transparent', border: 'none', padding: 0,
                cursor: 'pointer',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute', inset: 0,
                  borderRadius: 2,
                  background: isActive && !isPressing
                    ? 'var(--brass-bright)'
                    : isHovered && !isPressing
                      ? 'color-mix(in srgb, var(--brass-mid) 75%, transparent)'
                      : 'color-mix(in srgb, var(--brass-mid) 38%, transparent)',
                  boxShadow: isActive && !isPressing
                    ? '0 0 8px color-mix(in srgb, var(--brass-bright) 60%, transparent)'
                    : 'none',
                  clipPath: isPressing ? 'inset(100% 0 0 0)' : 'inset(0 0 0 0)',
                  transition: isPressing
                    ? 'clip-path 500ms cubic-bezier(0.22, 1, 0.36, 1)'
                    : 'clip-path 220ms cubic-bezier(0.4, 0, 0.2, 1), background 360ms ease, box-shadow 360ms ease',
                  pointerEvents: 'none',
                }}
              />
            </button>
            {/* Slideout tooltip — chain ultimate goal italic on hover. */}
            <span
              aria-hidden={!isHovered && !isPressing}
              style={{
                position: 'absolute',
                left: '100%',
                marginLeft: 14,
                top: '50%',
                transform: (isHovered || isPressing)
                  ? 'translate(0, -50%)'
                  : 'translate(-14px, -50%)',
                opacity: (isHovered || isPressing) ? 1 : 0,
                transitionProperty: 'transform, opacity',
                transitionDuration: (isHovered || isPressing) ? '420ms, 360ms' : '320ms, 240ms',
                transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
                transitionDelay: isHovered ? '120ms, 80ms' : '0ms, 0ms',
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
                background: 'var(--bg-page)',
                border: '1px solid color-mix(in srgb, var(--brass-mid) 38%, transparent)',
                padding: '7px 16px',
                borderRadius: 2,
                fontFamily: '"Cormorant Garamond", "EB Garamond", "Noto Serif SC", Georgia, serif',
                fontStyle: 'italic',
                fontSize: 13.5,
                letterSpacing: '0.01em',
                color: 'var(--ink-primary)',
                boxShadow: '0 6px 22px rgba(60, 40, 20, 0.10), 0 1px 3px rgba(60, 40, 20, 0.06)',
                zIndex: 50,
                maxWidth: 360,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {truncateGoal(c.ultimateGoal)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── HandscrollFooter — horizontal dots strip with brass seal ──────────────
function HandscrollFooter({ activeRel, onSelect }) {
  const { chains, loaded } = useChainData();
  const activeChain = useActiveChain(activeRel, chains);
  const scrollerRef = React.useRef(null);

  // Flatten current chain's lessons into one ordered array.
  const allLessons = React.useMemo(() => {
    if (!activeChain) return [];
    const out = [];
    for (const folder of activeChain.folders) {
      for (const item of (folder.items || [])) {
        out.push({
          rel: item.rel || item.id,
          ghost: !!item.ghost,
          locked: !!item.locked,
          linkIdx: folder.chainLinkIdx,
          folderName: folder.folder,
          label: item.label,
        });
      }
    }
    return out;
  }, [activeChain]);

  const activeIndex = activeRel ? allLessons.findIndex(l => l.rel === activeRel) : -1;

  // Center the active dot when it changes.
  React.useEffect(() => {
    if (activeIndex < 0 || !scrollerRef.current) return;
    const el = scrollerRef.current.querySelector(`[data-li="${activeIndex}"]`);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }, [activeIndex]);

  if (!loaded) return null;

  if (!activeChain) {
    return (
      <div style={{
        height: 72,
        borderTop: '1px solid color-mix(in srgb, var(--brass-mid) 18%, transparent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
        fontStyle: 'italic', fontSize: 14, color: 'var(--ink-faint)',
        background: 'transparent',
      }}>
        no chain yet · open or create one
      </div>
    );
  }

  const counterText = activeIndex >= 0
    ? `${activeIndex + 1}/${allLessons.length}`
    : `${allLessons.length}`;

  // Truncate ultimate goal for display.
  const goal = activeChain.ultimateGoal.length > 48
    ? activeChain.ultimateGoal.slice(0, 48) + '…'
    : activeChain.ultimateGoal;

  return (
    <div style={{
      height: 72,
      borderTop: '1px solid color-mix(in srgb, var(--brass-mid) 18%, transparent)',
      display: 'flex', flexDirection: 'column',
      background: 'transparent',
      flexShrink: 0,
    }}>
      <div style={{
        padding: '8px 18px 4px',
        display: 'flex', alignItems: 'baseline', gap: 12,
        fontFamily: '"Cormorant Garamond", "EB Garamond", "Noto Serif SC", serif',
      }}>
        <span style={{
          fontStyle: 'italic',
          fontSize: 11.5,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--brass-bright)',
          opacity: 0.86,
        }}>chain · {goal}</span>
        <span style={{
          marginLeft: 'auto',
          fontFamily: '"JetBrains Mono", monospace',
          fontStyle: 'normal',
          fontSize: 10.5,
          color: 'var(--ink-faint)',
          fontVariantNumeric: 'tabular-nums',
        }}>{counterText}</span>
      </div>
      <div ref={scrollerRef} style={{
        flex: 1,
        overflowX: 'auto',
        overflowY: 'hidden',
        display: 'flex',
        alignItems: 'center',
        padding: '0 18px 6px',
        gap: 5,
      }}>
        {allLessons.map((l, i) => {
          const isActive = i === activeIndex;
          const isPast = activeIndex >= 0 && i < activeIndex;
          const baseSize = isActive ? 10 : (isPast ? 6 : (l.ghost ? 4 : 5));
          const op = isActive
            ? 1
            : l.ghost
              ? 0.32
              : (isPast ? 0.62 : 0.55);
          const bg = isActive
            ? 'var(--brass-bright)'
            : l.ghost
              ? 'var(--ink-faint)'
              : 'var(--brass-mid)';
          return (
            <button
              key={l.rel}
              data-li={i}
              type="button"
              onClick={() => {
                if (l.ghost || l.locked) return;
                onSelect(l.rel);
              }}
              title={`${l.label} · link ${l.linkIdx ?? '?'}/${activeChain.totalLinks ?? '?'}`}
              style={{
                width: baseSize, height: baseSize, minWidth: baseSize,
                borderRadius: '50%',
                background: bg,
                opacity: op,
                border: 'none',
                cursor: (l.ghost || l.locked) ? 'not-allowed' : 'pointer',
                padding: 0,
                flexShrink: 0,
                boxShadow: isActive
                  ? '0 0 0 2px var(--bg-page), 0 0 0 3px var(--brass-bright), 0 0 8px color-mix(in srgb, var(--brass-bright) 50%, transparent)'
                  : 'none',
                transition: 'opacity 220ms ease, box-shadow 220ms ease',
              }}
              onMouseEnter={e => { if (!isActive && !l.ghost && !l.locked) e.currentTarget.style.opacity = '0.9'; }}
              onMouseLeave={e => { if (!isActive && !l.ghost && !l.locked) e.currentTarget.style.opacity = String(op); }}
            />
          );
        })}
      </div>
    </div>
  );
}

window.HandscrollNav = { ChainStrokeRail, HandscrollFooter };
