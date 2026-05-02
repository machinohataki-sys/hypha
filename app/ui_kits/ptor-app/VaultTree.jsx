// VaultTree with phase dots + time-since markers. Reads theme tokens.
// Phase mapping: 0=untouched (no SRS), 1=P1 new, 2=P2 review, 3=P3+P4 mature.

const PHASE_VAR = { 0: 'var(--brass-dim)', 1: 'var(--brass-mid)', 2: 'var(--brass-mid)', 3: 'var(--brass-bright)' };

// Living-Substrate Stage 1 (council 2026-04-30): patina opacity decay per
// item based on `lastAttendedAt`. Notes recently read or written stay at
// full saturation; weeks-untouched notes visually fade. Active note always
// shows at 1.0 (re-saturate). Decay curve: half-life ~30 days, floor 0.45
// (notes never disappear, just dim).
function patinaOpacity(lastAttendedAt) {
  if (!lastAttendedAt) return 0.55;          // never seen → mid-dim
  const ts = new Date(lastAttendedAt).getTime();
  if (!Number.isFinite(ts)) return 0.55;
  const days = (Date.now() - ts) / 86400000;
  if (days <= 0) return 1.0;
  // 1 - 0.55 × (1 - e^-days/30): 7d→0.93, 30d→0.65, 90d→0.48, ∞→0.45
  const decay = 1 - 0.55 * (1 - Math.exp(-days / 30));
  return Math.max(0.45, Math.min(1, decay));
}

function daysSince(iso) {
  if (!iso) return Infinity;
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return Infinity;
  return Math.max(0, (Date.now() - ts) / 86400000);
}

function VaultTree({ active, onSelect, viewMode }) {
  const [VAULT, setVault] = React.useState([]);
  const [loaded, setLoaded] = React.useState(false);
  const [open, setOpen] = React.useState({});
  const [importOpen, setImportOpen] = React.useState(false);
  const [chainOpen, setChainOpen] = React.useState(false);  // Lacquer Loop W7 chain planner modal
  const [vaultName, setVaultName] = React.useState('');     // last segment of vault root, e.g. "beiking"

  // CRUD UI state. Only one of these is non-null at a time (mutually exclusive).
  // composeIn: { folder } — inline new-note input under that folder
  // composeShelf: '' or non-null — inline new-folder input at root
  // ctxMenu: { kind: 'item'|'folder', id, x, y } — right-click popover anchor
  // renameTarget: { kind: 'item'|'folder', id, draft } — inline rename input
  // deleteArm: id — first-click on delete arms it (2s window) for second confirm
  const [composeIn, setComposeIn] = React.useState(null);
  const [composeShelf, setComposeShelf] = React.useState(null);
  const [ctxMenu, setCtxMenu] = React.useState(null);
  const [renameTarget, setRenameTarget] = React.useState(null);
  const [deleteArm, setDeleteArm] = React.useState(null);
  // Hypha — Learn flow. learnTopic: null | string (current input draft).
  // learnStatus: null | 'harvesting' | 'designing' | 'writing-lessons' | 'error'
  const [learnTopic, setLearnTopic] = React.useState(null);
  const [learnStatus, setLearnStatus] = React.useState(null);
  // Customize Tutor — null | { slug, profile, personas } when editing a folder's tutor profile.
  const [tutorEdit, setTutorEdit] = React.useState(null);
  const [tutorSaved, setTutorSaved] = React.useState(false);
  // Hypha — current settings used by the ambient model chip in the bottom-left
  // footer. null until first settingsGet() resolves; thereafter mirrors
  // data/settings.json. Re-fetched on `hypha:settings-updated` (dispatched by
  // ColophonView when the user edits any token).
  const [currentSettings, setCurrentSettings] = React.useState(null);
  const [chipHover, setChipHover] = React.useState(false);
  React.useEffect(() => {
    if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.settingsGet) return;
    let alive = true;
    const reload = () => {
      window.ptor.hypha.settingsGet().then(s => { if (alive) setCurrentSettings(s); }).catch(() => {});
    };
    reload();
    const onUpdate = () => reload();
    window.addEventListener('hypha:settings-updated', onUpdate);
    return () => { alive = false; window.removeEventListener('hypha:settings-updated', onUpdate); };
  }, []);

  // Cmd+, / Ctrl+, dispatches hypha:open-colophon → App.jsx switches viewMode
  // to 'colophon'. The old settings modal was deleted 2026-04-30 per
  // LUNG+LEO+YOGO council (kill modal, settings is a vault page not a dialog).
  React.useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        try { window.dispatchEvent(new CustomEvent('hypha:open-colophon')); } catch (_) {}
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Refresh list — extracted so CRUD ops can re-fetch without window.location.reload
  const refresh = React.useCallback(() => {
    if (!window.ptor || !window.ptor.vault) return Promise.resolve();
    return window.ptor.vault.list().then(res => {
      const list = (res && res.folders) || [];
      setVault(list);
      // Preserve existing open state — only initialize folders we haven't seen
      setOpen(prev => {
        const next = { ...prev };
        for (const f of list) if (!(f.folder in next)) next[f.folder] = true;
        return next;
      });
      if (res && res.root) {
        const last = String(res.root).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
        setVaultName(last);
      }
      setLoaded(true);
    }).catch(err => { console.error('vault list failed', err); setLoaded(true); });
  }, []);

  // Hypha — auto-refresh sidebar when curriculum:create finishes elsewhere
  // (e.g. welcome page). Without this, lessons get written to disk but the
  // VaultTree stays stuck on its last list() snapshot.
  React.useEffect(() => {
    if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.onCurriculumProgress) return;
    return window.ptor.hypha.onCurriculumProgress((p) => {
      if (p && p.stage === 'done') refresh();
    });
  }, [refresh]);

  // Hypha — open Customize Tutor modal from anywhere via custom event.
  // E.g. LessonChat header click on "· tutor: <name>" dispatches this.
  React.useEffect(() => {
    const onCustomize = async (e) => {
      const slug = e && e.detail && e.detail.slug;
      if (!slug || !window.ptor || !window.ptor.hypha) return;
      try {
        const [profile, list] = await Promise.all([
          window.ptor.hypha.agentGet(slug),
          window.ptor.hypha.personas ? window.ptor.hypha.personas() : Promise.resolve([]),
        ]);
        setTutorEdit({ slug, profile: profile || { persona: 'socratic', customInstructions: '' }, personas: list || [] });
        setTutorSaved(false);
      } catch (_) {}
    };
    window.addEventListener('hypha:open-tutor-customize', onCustomize);
    return () => window.removeEventListener('hypha:open-tutor-customize', onCustomize);
  }, []);

  // Click outside / Esc closes ctx menu + cancels rename/compose. The "+"
  // button no longer opens a popover (it goes straight to Learn input) so
  // the actionMenu / actionWrapRef branches were removed 2026-05-01.
  React.useEffect(() => {
    if (!ctxMenu) return;
    const onDocClick = () => setCtxMenu(null);
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setCtxMenu(null);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDocClick); document.removeEventListener('keydown', onKey); };
  }, [ctxMenu]);

  // Disarm delete after 2s of inaction
  React.useEffect(() => {
    if (!deleteArm) return;
    const t = setTimeout(() => setDeleteArm(null), 2000);
    return () => clearTimeout(t);
  }, [deleteArm]);

  React.useEffect(() => {
    console.log('[VaultTree] mount, ptor=', !!window.ptor, 'vault=', !!(window.ptor && window.ptor.vault));
    if (!window.ptor || !window.ptor.vault) { setLoaded(true); return; }
    refresh();
  }, [refresh]);

  // ── CRUD action handlers ─────────────────────────────────────────────────
  const handleDelete = React.useCallback(async (rel) => {
    if (!window.ptor || !window.ptor.vault || !window.ptor.vault.del) return;
    const r = await window.ptor.vault.del(rel);
    if (!r || !r.ok) console.warn('[vault] delete failed', r);
    setDeleteArm(null); setCtxMenu(null);
    if (active === rel) onSelect(null);
    refresh();
  }, [refresh, active, onSelect]);

  const handleRename = React.useCallback(async (oldRel, newRel) => {
    if (!window.ptor || !window.ptor.vault || !window.ptor.vault.rename) return;
    if (!newRel || newRel === oldRel) { setRenameTarget(null); return; }
    const r = await window.ptor.vault.rename(oldRel, newRel);
    if (!r || !r.ok) { console.warn('[vault] rename failed', r); setRenameTarget(null); return; }
    setRenameTarget(null);
    if (active === oldRel) onSelect(r.rel);
    refresh();
  }, [refresh, active, onSelect]);

  const handleNewNote = React.useCallback(async (folder, name) => {
    if (!window.ptor || !window.ptor.vault) return;
    const trimmed = (name || '').trim();
    if (!trimmed) { setComposeIn(null); return; }
    const fileName = trimmed.toLowerCase().endsWith('.md') ? trimmed : `${trimmed}.md`;
    const rel = `${folder}/${fileName}`;
    await window.ptor.vault.write(rel, '');
    setComposeIn(null);
    refresh();
    onSelect(rel);
  }, [refresh, onSelect]);

  const handleNewShelf = React.useCallback(async (name) => {
    if (!window.ptor || !window.ptor.vault || !window.ptor.vault.mkdir) return;
    const trimmed = (name || '').trim();
    if (!trimmed) { setComposeShelf(null); return; }
    await window.ptor.vault.mkdir(trimmed);
    setComposeShelf(null);
    setOpen(prev => ({ ...prev, [trimmed]: true }));
    refresh();
  }, [refresh]);
  return (
    <div style={{
      width: '100%', height: '100%', minWidth: 0,
      padding: '16px 0', display: 'flex', flexDirection: 'column',
      gap: 1,
      background: 'var(--glass-light)',
      backdropFilter: 'var(--glass-blur)',
      WebkitBackdropFilter: 'var(--glass-blur)',
      overflow: 'hidden auto',
    }}>
      {/* Vault header — 大字 italic Garamond vault 名 + 右侧 "+" 直接进入
          创建课程流程。2026-05-01 council 决议：删除中介菜单（Compose / Bring
          in / New shelf 改走文件夹右键 ctxMenu）。"+" 在千金认知 = "新课程"，
          多一层菜单是无用 chrome 且 modal-card 在 atlas-day 下背景撞色。点击：
          (1) 切回 evolution mode（如在 settings/recall），(2) 立即弹 Learn 输入。
          行底 brass hairline 锚定 header。 */}
      <div style={{
        position: 'relative',
        padding: '2px 16px 12px',
        margin: '0 0 10px',
        display: 'flex', alignItems: 'baseline', gap: 10,
        borderBottom: '1px solid color-mix(in srgb, var(--brass-mid) 18%, transparent)',
      }}>
        <span style={{
          fontFamily: '"EB Garamond", "Noto Serif SC", "Cormorant Garamond", Georgia, serif',
          fontStyle: 'italic', fontWeight: 500,
          fontSize: 19,
          lineHeight: 1.2,
          color: 'var(--ink-title)',
          letterSpacing: '0.005em',
        }}>{vaultName === 'data' ? 'hypha' : (vaultName || 'vault')}</span>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => {
            // 唯一意图：创建课程。先切回 evolution mode（settings/recall →
            // evolution），再开 Learn 输入框。App.jsx 监听 hypha:open-evolution。
            try { window.dispatchEvent(new CustomEvent('hypha:open-evolution')); } catch (_) {}
            setLearnTopic('');
          }}
          title="New course"
          aria-label="New course"
          style={{
            background: 'transparent',
            border: 'none', cursor: 'pointer',
            padding: 0, width: 22, height: 22, borderRadius: 11,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--ink-faint)',
            opacity: 0.62,
            transition: 'opacity 220ms cubic-bezier(0.22, 1, 0.36, 1), color 220ms, background 220ms',
          }}
          onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = 'var(--brass-bright)'; }}
          onMouseLeave={e => { e.currentTarget.style.opacity = '0.62'; e.currentTarget.style.color = 'var(--ink-faint)'; }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <line x1="6" y1="2" x2="6" y2="10" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
            <line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {window.ImportDialog && (
        <window.ImportDialog
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onComplete={() => { setImportOpen(false); refresh(); }}
        />
      )}
      {window.ChainPlannerView && (
        <window.ChainPlannerView
          open={chainOpen}
          onClose={() => setChainOpen(false)}
        />
      )}

      {/* New-shelf inline input — shown right under header.
          Italic Garamond, no chrome — same register as folder labels. */}
      {composeShelf !== null && (
        <ShelfInput
          initial={composeShelf}
          onCommit={(name) => handleNewShelf(name)}
          onCancel={() => setComposeShelf(null)}
        />
      )}
      {/* Hypha — Learn input. Topic → curriculum:create. Italic Garamond, no chrome. */}
      {learnTopic !== null && (
        <div style={{
          padding: '10px 16px 14px',
          borderBottom: '1px solid color-mix(in srgb, var(--brass-mid) 14%, transparent)',
          margin: '0 0 8px',
        }}>
          <input
            autoFocus
            value={learnTopic}
            placeholder="what do you want to learn?"
            disabled={!!learnStatus && learnStatus !== 'error'}
            onChange={e => setLearnTopic(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Escape') { setLearnTopic(null); setLearnStatus(null); return; }
              if (e.key === 'Enter') {
                const t = (learnTopic || '').trim();
                if (!t || !window.ptor || !window.ptor.hypha) return;
                setLearnStatus('harvesting');
                let unsub = null;
                try {
                  unsub = window.ptor.hypha.onCurriculumProgress((p) => {
                    if (p && p.stage) setLearnStatus(p.stage);
                  });
                  const r = await window.ptor.hypha.curriculumCreate(t, 'intermediate');
                  if (unsub) unsub();
                  if (r && r.ok) {
                    setLearnTopic(null);
                    setLearnStatus(null);
                    refresh();
                    if (r.lessonRels && r.lessonRels[0] && typeof onPick === 'function') onPick(r.lessonRels[0]);
                  } else {
                    setLearnStatus('error');
                  }
                } catch (err) {
                  if (unsub) unsub();
                  setLearnStatus('error');
                }
              }
            }}
            style={{
              width: '100%',
              background: 'transparent',
              color: 'var(--ink-title)',
              border: 'none',
              borderBottom: '1px solid color-mix(in srgb, var(--brass-mid) 32%, transparent)',
              fontFamily: '"EB Garamond", "Noto Serif SC", "Cormorant Garamond", Georgia, serif',
              fontStyle: 'italic',
              fontSize: 17,
              padding: '4px 0',
              outline: 'none',
            }}
          />
          <div style={{
            marginTop: 8,
            fontFamily: '"EB Garamond", "Noto Serif SC", serif',
            fontStyle: 'italic',
            fontSize: 12,
            color: 'var(--ink-faint)',
            minHeight: 16,
          }}>
            {learnStatus === 'harvesting' && 'gathering sources from the better parts of the web…'}
            {learnStatus === 'designing' && 'arranging a sequence of lessons…'}
            {learnStatus === 'writing-lessons' && 'writing lesson stubs to the vault…'}
            {learnStatus === 'error' && (
              <span style={{ color: 'var(--verdict-flag)' }}>
                couldn't begin — check api key in settings, or press esc to cancel.
              </span>
            )}
            {!learnStatus && (
              <>
                press enter to begin · esc to cancel
                {/* In-flow link to chain planner. 2026-05-01 user feedback:
                    chain planner belongs INSIDE the course-creation flow, not
                    as a parallel top-level menu item. Click → close Learn,
                    open ChainPlannerView modal; chain planner creates its own
                    curriculum, so no need to round-trip back to this input. */}
                {' · '}
                <button
                  onClick={() => { setLearnTopic(null); setChainOpen(true); }}
                  style={{
                    background: 'transparent', border: 'none', padding: 0,
                    font: 'inherit', fontStyle: 'italic',
                    color: 'var(--brass-bright)',
                    cursor: 'pointer',
                    borderBottom: '1px solid transparent',
                    transition: 'border-color 200ms',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderBottomColor = 'var(--brass-bright)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderBottomColor = 'transparent'; }}
                  title="if your goal is bigger than one course — plan a chain of prerequisites first"
                >plan a chain →</button>
              </>
            )}
          </div>
        </div>
      )}
      {VAULT.length === 0 && (
        <div style={{
          padding: '22px 16px', fontFamily: '"EB Garamond", "Cormorant Garamond", Georgia, serif',
          fontStyle: 'italic', fontSize: 17, color: 'var(--ink-faint)', lineHeight: 1.5,
        }}>
          {loaded
            ? (window.ptor && window.ptor.vault ? 'vault is empty.' : 'vault not yet connected.')
            : 'loading vault…'}
          <div style={{
            marginTop: 8, fontFamily: '"JetBrains Mono", monospace', fontSize: 11,
            letterSpacing: '0.04em', color: 'var(--ink-faint)', opacity: 0.65,
            fontStyle: 'normal',
          }}>{loaded ? (window.ptor ? 'no .md files yet' : 'awaiting ipc bridge') : 'reading vault'}</div>
        </div>
      )}
      {VAULT.map(folder => {
        const isOpen = !!open[folder.folder];
        const isFolderCtxTarget = ctxMenu && ctxMenu.kind === 'folder' && ctxMenu.id === folder.folder;
        return (
          <React.Fragment key={folder.folder}>
            <div onClick={() => setOpen({ ...open, [folder.folder]: !isOpen })}
                 data-ctx-target={isFolderCtxTarget ? 'true' : undefined}
                 onContextMenu={(e) => {
                   e.preventDefault();
                   setCtxMenu({ kind: 'folder', id: folder.folder, x: e.clientX, y: e.clientY });
                 }}
                 style={{
                   display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', cursor: 'pointer',
                   fontFamily: '"EB Garamond", "Noto Serif SC", "Cormorant Garamond", Georgia, serif',
                   fontStyle: 'italic', fontSize: 17, fontWeight: 500,
                   letterSpacing: '0.005em',
                   color: isFolderCtxTarget ? 'var(--ink-title)' : 'var(--ink-primary)',
                   // Lung+Muse synthesis: 3 micro-events on right-click target.
                   background: isFolderCtxTarget
                     ? 'color-mix(in srgb, var(--brass-mid) 14%, transparent)'
                     : 'transparent',
                   boxShadow: isFolderCtxTarget
                     ? 'inset 2px 0 0 var(--brass-bright)'
                     : 'none',
                   transition:
                     'background 280ms cubic-bezier(0.4, 0, 0.15, 1),' +
                     'color 200ms cubic-bezier(0.3, 0.7, 0.2, 1) 40ms,' +
                     'box-shadow 200ms cubic-bezier(0.2, 0.7, 0.2, 1) 60ms',
                 }}>
              {/* chevron rotates instead of swapping glyph — smoother */}
              <span style={{
                color: 'var(--ink-faint)',
                display: 'inline-block',
                transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 260ms cubic-bezier(0.22, 1, 0.36, 1)',
                transformOrigin: '50% 50%',
                width: 10, textAlign: 'center',
                fontStyle: 'normal',
                fontFamily: '"JetBrains Mono", monospace',
              }}>▸</span>
              {renameTarget && renameTarget.kind === 'folder' && renameTarget.id === folder.folder ? (
                <RenameInput
                  initial={renameTarget.draft}
                  onCommit={(v) => handleRename(folder.folder, v)}
                  onCancel={() => setRenameTarget(null)}
                  italic={true}
                  fontSize={17}
                />
              ) : (
                <span>{folder.folder === 'data' ? 'hypha' : folder.folder}</span>
              )}
              <span style={{
                marginLeft: 'auto',
                color: 'var(--ink-faint)',
                fontFamily: '"JetBrains Mono", monospace',
                fontStyle: 'normal',
                fontSize: 11,
                fontVariantNumeric: 'tabular-nums',
                opacity: 0.62,
              }}>{folder.count}</span>
            </div>
            {/* Grid-rows trick: 0fr <-> 1fr animates real height with no JS measurement.
                Inner wrapper is min-height: 0 + overflow: hidden so children clip cleanly. */}
            <div style={{
              display: 'grid',
              gridTemplateRows: isOpen ? '1fr' : '0fr',
              transition: 'grid-template-rows 320ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}>
              <div style={{ overflow: 'hidden', minHeight: 0 }}>
                {folder.items.map((item, idx) => {
                  const on = active === item.id;
                  const isRenaming = renameTarget && renameTarget.kind === 'item' && renameTarget.id === item.id;
                  // Hypha — locked lessons: dim + cursor:not-allowed + click is no-op.
                  const isLocked = item.locked;
                  const lockedDim = isLocked ? 0.42 : 1;
                  // Patina decay — not-active rows fade with neglect. Active row
                  // re-saturates to full opacity (read becomes attention signal).
                  const patinaOp = on ? 1 : patinaOpacity(item.lastAttendedAt);
                  // Lung+Muse synthesis 2026-04-30: right-click row "selection"
                  // feedback. Three concurrent micro-events while ctxMenu open;
                  // all revert on close via single source of truth ctxMenu.id.
                  const isCtxTarget = ctxMenu && ctxMenu.kind === 'item' && ctxMenu.id === item.id;
                  return (
                    <div key={item.id}
                         data-ctx-target={isCtxTarget ? 'true' : undefined}
                         onClick={() => { if (!isRenaming && !isLocked) onSelect(item.id); }}
                         onContextMenu={(e) => {
                           e.preventDefault();
                           if (!isLocked) setCtxMenu({ kind: 'item', id: item.id, x: e.clientX, y: e.clientY });
                         }}
                         title={isLocked ? 'Locked — finish the previous lesson first.' : undefined}
                         style={{
                           display: 'flex', alignItems: 'center', gap: 10,
                           padding: '5px 14px 5px 30px', margin: '0 6px',
                           borderRadius: 2, cursor: isLocked ? 'not-allowed' : 'pointer',
                           fontFamily: '"JetBrains Mono", monospace', fontSize: 13,
                           // Ink darken: ctx-target → ink-title (Muse macOS Notes pattern, 200ms@40ms)
                           color: (on || isCtxTarget) ? 'var(--ink-title)' : 'var(--ink-primary)',
                           // Background fill: hover 9%, ctx-target 8% mid + 280ms
                           background: isCtxTarget
                             ? 'color-mix(in srgb, var(--brass-mid) 14%, transparent)'
                             : on ? 'rgba(242, 230, 218, 0.06)' : 'transparent',
                           // Inset rule: ctx-target gets 2px brass-bright on left edge (60ms in)
                           boxShadow: isCtxTarget
                             ? 'inset 2px 0 0 var(--brass-bright)'
                             : on ? 'inset 2px 0 0 var(--ink-title)' : 'none',
                           // staggered child reveal: each item lags ~28ms; locked = 0.42;
                           // patina decay multiplies in (active row → 1.0 saturate).
                           opacity: (isOpen ? 1 : 0) * lockedDim * patinaOp,
                           transform: isOpen ? 'translateY(0)' : 'translateY(-4px)',
                           transition:
                             `opacity 240ms cubic-bezier(0.22, 1, 0.36, 1) ${isOpen ? idx * 28 : 0}ms,` +
                             `transform 240ms cubic-bezier(0.22, 1, 0.36, 1) ${isOpen ? idx * 28 : 0}ms,` +
                             'background 280ms cubic-bezier(0.4, 0, 0.15, 1),' +
                             'color 200ms cubic-bezier(0.3, 0.7, 0.2, 1) 40ms,' +
                             'box-shadow 200ms cubic-bezier(0.2, 0.7, 0.2, 1) 60ms',
                         }}>
                      <span style={{
                        width: 6, height: 6, borderRadius: '50%',
                        background: `radial-gradient(circle at 35% 30%, var(--pearl-glow), transparent 55%), ${PHASE_VAR[item.phase]}`,
                        boxShadow: `inset 0 0 0 0.5px rgba(0,0,0,0.08)`,
                        flexShrink: 0,
                      }} />
                      {isRenaming ? (
                        <RenameInput
                          initial={renameTarget.draft}
                          onCommit={(v) => {
                            // Reconstruct full rel: same folder, new file basename.
                            const newName = v.toLowerCase().endsWith('.md') ? v : `${v}.md`;
                            handleRename(item.id, `${folder.folder}/${newName}`);
                          }}
                          onCancel={() => setRenameTarget(null)}
                          italic={false}
                          fontSize={13}
                        />
                      ) : (
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
                      )}
                      {/* Phase 3.1 — `adapted` mark. Quiet italic Garamond `·`
                          in brass-mid. Tooltip explains the lesson was
                          re-tuned by Hypha based on prior settled-by-user
                          signal. Suppressed on locked rows (mark would imply
                          state the user can't yet see). */}
                      {item.adapted && !isLocked && (
                        <span title="adapted from prior lesson outcome"
                              style={{
                                fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
                                fontStyle: 'italic',
                                fontSize: 15,
                                lineHeight: '13px',
                                color: 'var(--brass-mid)',
                                opacity: 0.55,
                                marginLeft: 4,
                                userSelect: 'none',
                              }}>·</span>
                      )}
                      {/* Phase 3.2 — cure-clock "next suggested" mark. Brass-bright
                          pearl with radial highlight (matches phase-dot vocabulary).
                          revisit mode = slightly larger + warmer glow. forward mode
                          = standard pearl. Title surfaces mode for tooltip. */}
                      {item.isNextSuggested && !isLocked && (
                        <span title={item.nextSuggestedMode === 'revisit'
                                ? `revisit suggested — concept ${item.nextSuggestedRevisitOf} cure window expired`
                                : 'next suggested lesson'}
                              style={{
                                width: item.nextSuggestedMode === 'revisit' ? 7 : 6,
                                height: item.nextSuggestedMode === 'revisit' ? 7 : 6,
                                borderRadius: '50%',
                                background: `radial-gradient(circle at 35% 30%, var(--pearl-glow), transparent 55%), var(--brass-bright)`,
                                boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.08)',
                                marginLeft: 6,
                                flexShrink: 0,
                              }} />
                      )}
                      <span style={{
                        marginLeft: 'auto',
                        color: 'var(--ink-faint)',
                        fontSize: 11,
                        fontVariantNumeric: 'tabular-nums',
                        opacity: 0.62,
                      }}>{item.since}</span>
                    </div>
                  );
                })}

                {/* New-note inline input under this folder */}
                {composeIn && composeIn.folder === folder.folder && (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '5px 14px 5px 30px', margin: '0 6px',
                    borderRadius: 2,
                    fontFamily: '"JetBrains Mono", monospace', fontSize: 13,
                    background: 'rgba(242, 230, 218, 0.04)',
                  }}>
                    <span style={{
                      width: 6, height: 6, borderRadius: '50%',
                      background: 'var(--brass-mid)',
                      flexShrink: 0, opacity: 0.7,
                    }} />
                    {/* intentional-placeholder: real HTML input placeholder attribute, not a stub */}
                    <RenameInput
                      initial=""
                      placeholder="new note name…"
                      onCommit={(v) => handleNewNote(folder.folder, v)}
                      onCancel={() => setComposeIn(null)}
                      italic={false}
                      fontSize={13}
                    />
                  </div>
                )}
              </div>
            </div>
          </React.Fragment>
        );
      })}
      {/* Hypha — TOKONOMA-DIRECT footer band. Per Lung+Muse council 2026-04-30:
          phase counter removed (PTOR SRS-state irrelevant to curriculum app).
          Whole 280×40 band = single click target (Fitts), Hara alcove emptiness,
          1px brass-bright top hairline on hover (Norm Architects craft marker).
          State at rest, no italic (budget reserved for brand). Cmd+, also opens. */}
      <div
        onClick={() => { try { window.dispatchEvent(new CustomEvent('hypha:open-colophon')); } catch (_) {} }}
        onMouseEnter={() => setChipHover(true)}
        onMouseLeave={() => setChipHover(false)}
        title={(currentSettings && currentSettings.apiKey)
          ? `${currentSettings.model || 'glm-5'} · ⌘, to edit`
          : 'no api key yet · click or ⌘, to add one'}
        style={{
          marginTop: 'auto',
          padding: '14px 16px',
          borderTop: '1px solid var(--border-soft)',
          boxShadow: chipHover
            ? 'inset 0 1px 0 var(--brass-bright)'
            : 'inset 0 1px 0 transparent',
          transition: 'box-shadow 280ms cubic-bezier(0.22, 1, 0.36, 1), background 220ms',
          background: chipHover ? 'color-mix(in srgb, var(--brass-mid) 4%, transparent)' : 'transparent',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          minHeight: 40,
        }}
      >
        {(currentSettings && currentSettings.apiKey) ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
            fontStyle: 'normal', fontWeight: 400,
            fontSize: 14,
            letterSpacing: '0.005em',
            color: chipHover ? 'var(--ink-title)' : 'var(--ink-muted)',
            transition: 'color 220ms',
          }}>
            <span>{currentSettings.model || 'glm-5'}</span>
            <span aria-hidden="true" style={{
              width: 6, height: 6, borderRadius: '50%',
              background: chipHover ? 'var(--accent-teal)' : 'color-mix(in srgb, var(--accent-teal) 78%, transparent)',
              boxShadow: chipHover ? '0 0 6px color-mix(in srgb, var(--accent-teal) 50%, transparent)' : 'none',
              transition: 'background 220ms, box-shadow 220ms',
            }} />
          </span>
        ) : (
          <span style={{
            display: 'inline-flex', alignItems: 'baseline', gap: 12,
            fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
            fontStyle: 'normal', fontWeight: 400,
            fontSize: 14,
            letterSpacing: '0.005em',
            color: chipHover ? 'var(--ink-title)' : 'var(--ink-muted)',
            transition: 'color 220ms',
          }}>
            <span style={{ color: 'var(--ink-faint)' }}>{(currentSettings && currentSettings.model) || 'claude-sonnet-4-6'}</span>
            <span style={{ color: chipHover ? 'var(--brass-bright)' : 'var(--brass-mid)', transition: 'color 220ms' }}>
              add api key
              <span aria-hidden="true" style={{ marginLeft: 6, opacity: chipHover ? 1 : 0.62, transition: 'opacity 220ms' }}>→</span>
            </span>
          </span>
        )}
      </div>


      {/* Right-click context menu — rendered as a fixed-position floating popover.
          For items: rename + delete (delete uses 2-step arm-then-confirm).
          For folders: rename + delete (recursive) + new note here. */}
      {ctxMenu && (
        <ContextPopover
          x={ctxMenu.x}
          y={ctxMenu.y}
          deleteArmed={deleteArm === ctxMenu.id}
          onClose={() => setCtxMenu(null)}
          onRename={() => {
            const draft = ctxMenu.kind === 'item'
              ? (ctxMenu.id.split('/').pop() || '').replace(/\.md$/i, '')
              : ctxMenu.id;
            setRenameTarget({ kind: ctxMenu.kind, id: ctxMenu.id, draft });
            setCtxMenu(null);
          }}
          onDelete={() => {
            if (deleteArm === ctxMenu.id) {
              handleDelete(ctxMenu.id);
            } else {
              setDeleteArm(ctxMenu.id);
            }
          }}
          onNewNote={ctxMenu.kind === 'folder' ? () => {
            setComposeIn({ folder: ctxMenu.id });
            setOpen(prev => ({ ...prev, [ctxMenu.id]: true }));
            setCtxMenu(null);
          } : null}
          onCustomizeTutor={ctxMenu.kind === 'folder' ? async () => {
            const slug = ctxMenu.id;
            setCtxMenu(null);
            if (!window.ptor || !window.ptor.hypha) return;
            try {
              const [profile, list] = await Promise.all([
                window.ptor.hypha.agentGet(slug),
                window.ptor.hypha.personas ? window.ptor.hypha.personas() : Promise.resolve([]),
              ]);
              setTutorEdit({ slug, profile: profile || { persona: 'socratic', customInstructions: '' }, personas: list || [] });
              setTutorSaved(false);
            } catch (_) {}
          } : null}
        />
      )}

      {/* Hypha — Customize Tutor modal. Portal'd to body. Persona pills (bell
          animation) + custom textarea + save. Writes to <slug>/agent.json. */}
      {tutorEdit !== null && ReactDOM.createPortal(
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setTutorEdit(null); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 320,
            background: 'var(--bg-modal-backdrop)',
            backdropFilter: 'blur(6px) saturate(130%)',
            WebkitBackdropFilter: 'blur(6px) saturate(130%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div style={{
            background: 'var(--bg-modal-card)',
            borderRadius: '32px 22px 32px 22px',
            boxShadow:
              'inset 0 1px 0 color-mix(in srgb, var(--brass-bright) 22%, transparent), ' +
              'inset 0 0 0 1px color-mix(in srgb, var(--brass-mid) 18%, transparent), ' +
              '0 40px 96px -20px rgba(0,0,0,0.55), ' +
              '0 14px 36px -8px rgba(0,0,0,0.32)',
            padding: '36px 40px 28px',
            minWidth: 600, maxWidth: 760, maxHeight: '88vh',
            display: 'flex', flexDirection: 'column',
            fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
            color: 'var(--ink-primary)',
          }}>
            <h3 style={{
              fontStyle: 'normal', fontWeight: 400, fontSize: 28, lineHeight: 1.05,
              color: 'var(--ink-title)', margin: '0 0 6px',
              letterSpacing: '-0.012em',
            }}>tutor for this curriculum</h3>
            <p style={{
              fontStyle: 'italic', fontWeight: 400, fontSize: 14.5, lineHeight: 1.45,
              color: 'var(--ink-muted)', margin: '0 0 20px',
            }}><em style={{ color: 'var(--brass-bright)', fontStyle: 'italic' }}>{tutorEdit.slug}</em> — pick a teaching register, optionally add custom rules below.</p>

            <div style={{ overflowY: 'auto', flex: 1, paddingRight: 8 }}>
              {/* Identity — display name + avatar. The persona pill below sets
                  the teaching register; this section sets what the chat shows. */}
              {(() => {
                const personaList = tutorEdit.personas || [];
                const cur = personaList.find(p => p.id === tutorEdit.profile.persona);
                const personaLabel = cur ? cur.label : 'tutor';
                return (
                  <div style={{
                    padding: '14px 18px',
                    marginBottom: 22,
                    borderRadius: '18px 14px 18px 14px',
                    background: 'color-mix(in srgb, var(--brass-mid) 6%, transparent)',
                    boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--brass-mid) 14%, transparent)',
                  }}>
                    <div style={{
                      fontFamily: '"Cormorant Garamond", "EB Garamond", Georgia, serif',
                      fontWeight: 500, fontSize: 12, letterSpacing: '0.16em', textTransform: 'uppercase',
                      color: 'var(--ink-faint)', marginBottom: 8,
                    }}>display name</div>
                    {/* intentional-placeholder: real HTML input placeholder */}
                    <input
                      value={tutorEdit.profile.displayName || ''}
                      placeholder={personaLabel}
                      onChange={e => setTutorEdit({ ...tutorEdit, profile: { ...tutorEdit.profile, displayName: e.target.value } })}
                      style={{
                        width: '100%',
                        background: 'transparent', border: 'none', outline: 'none',
                        fontFamily: 'inherit', fontStyle: 'normal',
                        fontSize: 18, fontWeight: 500,
                        color: 'var(--ink-title)',
                        padding: '4px 0',
                        borderBottom: '1px solid color-mix(in srgb, var(--brass-mid) 22%, transparent)',
                      }}
                    />
                  </div>
                );
              })()}

              {/* Persona pills, grouped by domain */}
              {(() => {
                const grouped = {};
                (tutorEdit.personas || []).forEach(p => {
                  const d = p.domain || 'other';
                  if (!grouped[d]) grouped[d] = [];
                  grouped[d].push(p);
                });
                const order = ['generic', 'cs', 'writing', 'bio', 'design', 'philosophy', 'math', 'physics', 'finance', 'other'];
                const labels = { generic: 'general', cs: 'computer science', writing: 'writing', bio: 'biology · cognition', design: 'design philosophy', philosophy: 'philosophy · ethics', math: 'mathematics', physics: 'physics', finance: 'finance', other: 'other' };
                return order.filter(d => grouped[d]).map(d => (
                  <div key={d} style={{ marginBottom: 22 }}>
                    <label style={{
                      display: 'block',
                      fontFamily: '"Cormorant Garamond", "EB Garamond", Georgia, serif',
                      fontWeight: 500, fontSize: 12, letterSpacing: '0.16em', textTransform: 'uppercase',
                      color: 'var(--ink-faint)', marginBottom: 10,
                    }}>{labels[d] || d}</label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {grouped[d].map(p => {
                        const on = tutorEdit.profile.persona === p.id;
                        return (
                          <button
                            key={p.id}
                            onClick={() => setTutorEdit({ ...tutorEdit, profile: { ...tutorEdit.profile, persona: p.id } })}
                            className={'hypha-bubble' + (on ? ' hypha-bubble--on' : '')}
                            title={p.short || ''}
                            style={{
                              position: 'relative',
                              background: on ? 'color-mix(in srgb, var(--brass-bright) 22%, transparent)' : 'transparent',
                              border: 'none',
                              borderRadius: '14px 10px 14px 10px',
                              boxShadow: on
                                ? 'inset 0 0 0 1.5px var(--brass-bright), inset 0 1px 0 color-mix(in srgb, var(--brass-bright) 36%, transparent)'
                                : 'inset 0 0 0 1px color-mix(in srgb, var(--brass-mid) 32%, transparent)',
                              color: on ? 'var(--ink-title)' : 'var(--ink-muted)',
                              fontFamily: 'inherit', fontStyle: 'normal',
                              fontWeight: 500, fontSize: 14, padding: '7px 14px',
                              cursor: 'pointer',
                              transition:
                                'background 280ms cubic-bezier(0.4, 0, 0.15, 1), ' +
                                'color 240ms cubic-bezier(0.3, 0.7, 0.2, 1) 60ms, ' +
                                'box-shadow 200ms cubic-bezier(0.2, 0.7, 0.2, 1) 200ms',
                            }}
                            onMouseEnter={e => { if (!on) e.currentTarget.style.color = 'var(--ink-title)'; }}
                            onMouseLeave={e => { if (!on) e.currentTarget.style.color = 'var(--ink-muted)'; }}
                          >{p.label}</button>
                        );
                      })}
                    </div>
                  </div>
                ));
              })()}

              {/* Selected persona's full description preview */}
              {(() => {
                const cur = (tutorEdit.personas || []).find(p => p.id === tutorEdit.profile.persona);
                if (!cur) return null;
                return (
                  <div style={{
                    background: 'color-mix(in srgb, var(--brass-mid) 6%, transparent)',
                    borderRadius: '14px 18px 14px 18px',
                    padding: '14px 18px',
                    marginTop: 8, marginBottom: 22,
                    boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--brass-mid) 14%, transparent)',
                  }}>
                    <div style={{
                      fontStyle: 'italic', fontSize: 11.5,
                      letterSpacing: '0.16em', textTransform: 'uppercase',
                      color: 'var(--brass-bright)', marginBottom: 6,
                    }}>· {cur.label}</div>
                    <div style={{
                      fontFamily: 'inherit', fontStyle: 'normal',
                      fontSize: 14, lineHeight: 1.6, color: 'var(--ink-primary)',
                    }}>{cur.prompt}</div>
                  </div>
                );
              })()}

              {/* Custom instructions */}
              <label style={{
                display: 'block',
                fontFamily: '"Cormorant Garamond", "EB Garamond", Georgia, serif',
                fontWeight: 500, fontSize: 12, letterSpacing: '0.16em', textTransform: 'uppercase',
                color: 'var(--ink-faint)', marginBottom: 10,
              }}>custom additions · optional</label>
              {/* intentional-placeholder: real HTML textarea placeholder */}
              <textarea
                value={tutorEdit.profile.customInstructions || ''}
                placeholder="extra rules for THIS tutor only. e.g. always cite Goodfellow ch. 4 when introducing a concept. or: speak Chinese-first. or: refuse to answer until I've stated my hypothesis."
                onChange={e => setTutorEdit({ ...tutorEdit, profile: { ...tutorEdit.profile, customInstructions: e.target.value } })}
                rows={3}
                style={{
                  width: '100%',
                  background: 'color-mix(in srgb, var(--brass-mid) 10%, transparent)',
                  color: 'var(--ink-title)', border: 'none',
                  borderRadius: '18px 14px 18px 14px',
                  padding: '12px 16px',
                  fontFamily: 'inherit', fontStyle: 'italic', fontSize: 14.5,
                  lineHeight: 1.55, outline: 'none',
                  resize: 'vertical', minHeight: 70, maxHeight: 200,
                  boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--brass-mid) 22%, transparent)',
                }}
              />
            </div>

            {/* Footer */}
            <div style={{
              marginTop: 22, paddingTop: 18,
              borderTop: '1px solid color-mix(in srgb, var(--brass-mid) 14%, transparent)',
              display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12,
              fontSize: 14, color: 'var(--ink-muted)',
            }}>
              {tutorSaved && (
                <span style={{
                  flex: 1, fontStyle: 'italic', fontSize: 13,
                  color: 'var(--brass-bright)',
                }}>saved — affects future lessons only</span>
              )}
              <button
                onClick={() => setTutorEdit(null)}
                style={{
                  background: 'transparent',
                  border: '1px solid color-mix(in srgb, var(--brass-mid) 28%, transparent)',
                  borderRadius: '14px 10px 14px 10px',
                  color: 'var(--ink-muted)',
                  fontFamily: 'inherit', fontStyle: 'italic',
                  fontSize: 14, padding: '8px 18px', cursor: 'pointer',
                  transition: 'all 220ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--ink-title)'; }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--ink-muted)'; }}
              >cancel</button>
              <button
                onClick={async () => {
                  if (!window.ptor || !window.ptor.hypha) return;
                  try {
                    await window.ptor.hypha.agentSet(tutorEdit.slug, tutorEdit.profile);
                    setTutorSaved(true);
                    setTimeout(() => setTutorEdit(null), 900);
                  } catch (_) {}
                }}
                style={{
                  background: 'color-mix(in srgb, var(--brass-bright) 22%, transparent)',
                  border: '1px solid var(--brass-bright)',
                  borderRadius: '18px 14px 18px 14px',
                  color: 'var(--ink-title)',
                  fontFamily: 'inherit', fontStyle: 'normal',
                  fontSize: 15, fontWeight: 500, padding: '8px 22px', cursor: 'pointer',
                  transition: 'background 220ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--brass-bright) 32%, transparent)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--brass-bright) 22%, transparent)'; }}
              >save</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ── Inline editors ────────────────────────────────────────────────────────
// RenameInput: tight inline <input>, autofocus, Enter commits, Esc cancels,
// blur commits (so click-elsewhere isn't a data loss). Same font register
// as the surrounding label for invisible-control feel.
function RenameInput({ initial, onCommit, onCancel, italic, fontSize, placeholder }) {
  const [val, setVal] = React.useState(initial || '');
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (ref.current) {
      ref.current.focus();
      // Pre-select for fast overwrite when renaming
      try { ref.current.setSelectionRange(0, ref.current.value.length); } catch (_) {}
    }
  }, []);
  return (
    <input
      ref={ref}
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); onCommit(val); }
        else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        e.stopPropagation();
      }}
      onBlur={() => onCommit(val)}
      onClick={(e) => e.stopPropagation()}
      placeholder={placeholder || ''}
      style={{
        flex: 1, minWidth: 0,
        background: 'transparent', border: 'none', outline: 'none',
        padding: 0, margin: 0,
        fontFamily: italic
          ? '"EB Garamond", "Noto Serif SC", "Cormorant Garamond", Georgia, serif'
          : '"JetBrains Mono", monospace',
        fontStyle: italic ? 'italic' : 'normal',
        fontSize: fontSize || 13,
        fontWeight: italic ? 500 : 400,
        color: 'var(--ink-title)',
        letterSpacing: italic ? '0.005em' : 'normal',
      }}
    />
  );
}

// ShelfInput: italic Garamond chip, sits between header + folder list.
// Same register as folder labels; enter commits, esc/blur empty cancels.
function ShelfInput({ initial, onCommit, onCancel }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px',
      margin: '0 0 4px',
      background: 'rgba(242, 230, 218, 0.04)',
      borderLeft: '2px solid var(--brass-mid)',
    }}>
      <span style={{
        color: 'var(--ink-faint)',
        width: 10, textAlign: 'center',
        fontFamily: '"JetBrains Mono", monospace', fontSize: 13,
      }}>▸</span>
      <RenameInput
        initial={initial}
        placeholder="new shelf name…"
        onCommit={onCommit}
        onCancel={onCancel}
        italic={true}
        fontSize={17}
      />
    </div>
  );
}

// ContextPopover: minimal right-click menu. Position via portal to body
// (fixed). Same chrome as the "+" popover for visual consistency.
function ContextPopover({ x, y, deleteArmed, onClose, onRename, onDelete, onNewNote, onCustomizeTutor }) {
  // Clamp to viewport so the menu doesn't clip off screen edges.
  const W = 200;
  const extras = (onNewNote ? 1 : 0) + (onCustomizeTutor ? 1 : 0);
  const H = 78 + extras * 36;
  const px = Math.min(x, window.innerWidth - W - 8);
  const py = Math.min(y, window.innerHeight - H - 8);
  const items = [];
  if (onNewNote) items.push({ label: 'New note here', onClick: onNewNote });
  if (onCustomizeTutor) items.push({ label: 'Customize Tutor', sub: 'persona for this curriculum', onClick: onCustomizeTutor });
  items.push({ label: 'Rename', onClick: onRename });
  items.push({
    // Armed-to-confirm signaled by italic word change ("really?"), NOT by
    // chromatic accent. teal accent on warm Garamond+brass register =
    // off-key (per atlas-register feedback). The font already italic, so the
    // text-swap does the work; color stays in the same ink token family.
    label: deleteArmed ? 'really?' : 'Delete',
    onClick: onDelete,
    danger: true,
    armed: deleteArmed,
  });
  // Lung tether-without-line: asymmetric border-radius — the corner closest to
  // the source row gets smaller radius (implies "lifted FROM here").
  // Popover position relative to viewport: above-or-below cursor, left-or-right.
  const belowCursor = y < window.innerHeight - H - 8;
  // If popover renders below the click, top corners face the row → top-left small.
  // If above, bottom corners face the row → bottom-left small.
  const radiusValue = belowCursor
    ? '6px 14px 14px 14px'   // top-left small (pulled from row)
    : '14px 14px 14px 6px';  // bottom-left small (popover hangs above)
  return ReactDOM.createPortal(
    <div
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: px, top: py,
        zIndex: 300,
        minWidth: W,
        background: 'var(--bg-modal-card)',
        border: '1px solid color-mix(in srgb, var(--brass-mid) 22%, transparent)',
        borderRadius: radiusValue,
        boxShadow:
          'inset 0 1px 0 color-mix(in srgb, var(--brass-bright) 18%, transparent), ' +
          '0 16px 40px -8px rgba(0, 0, 0, 0.55), ' +
          '0 4px 12px rgba(0, 0, 0, 0.22)',
        padding: '6px 0',
        animation: 'va-menu-rise 180ms cubic-bezier(0.22, 1, 0.36, 1)',
        transformOrigin: belowCursor ? 'top left' : 'bottom left',
      }}
    >
      {items.map((it, i) => (
        <button
          key={i}
          onClick={(e) => { e.stopPropagation(); it.onClick(); }}
          style={{
            display: 'block', width: '100%',
            padding: '8px 16px',
            background: 'transparent', border: 'none',
            textAlign: 'left', cursor: 'pointer',
            // ROMAN Garamond for action labels — italic is decoration register
            // (titles / quotes / marginalia). Action menus need fast scan.
            // The ONE italic exception below is "really?" — italic appearing
            // once in a roman list = pause signal (italic doing its real job).
            fontFamily: '"EB Garamond", "Noto Serif SC", serif',
            fontStyle: it.armed ? 'italic' : 'normal',
            fontSize: 14.5,
            fontWeight: 500,
            letterSpacing: '0.005em',
            color: 'var(--ink-title)',
            opacity: it.armed ? 0.82 : 1,
            transition: 'opacity 180ms, background 180ms, font-style 180ms',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'color-mix(in srgb, var(--brass-mid) 9%, transparent)';
          }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <div>{it.label}</div>
          {it.sub && (
            <div style={{
              fontSize: 11.5, fontStyle: 'italic',
              color: 'var(--ink-faint)', marginTop: 2,
              fontWeight: 400,
            }}>{it.sub}</div>
          )}
        </button>
      ))}
    </div>,
    document.body
  );
}

Object.assign(window, { VaultTree });
