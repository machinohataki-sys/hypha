/* global React, Icon, Watercolor */
// HYPHA · Home
//
// v0.4 (2026-05-08): vault-aware. When the boot probe in app.jsx finds
// existing curricula, they're passed in as `courses` and rendered as a
// resumable list. Empty vault keeps the zero-state ("还没织下第一根线...")
// so first-launch experience is unchanged.
// Host contract: HomeScreen({user, arc, onOpenLesson, onRoute, courses,
// onResumeCourse, onCreateNew}). Last 3 are optional for back-compat.
//
// v0.5.x (2026-05-09): 搁置课程 (D · 长按褪去) lane. Council = Lung divergent
// + Muse aesthetic + Scout frontier; MUSE 顶级审美大师 spec'd the 1100ms
// cubic-bezier fog dissolve (ink → tabac → aubergine, blur + kerning +
// translateY mist). Course rows now respond to mousedown-and-hold: 1.1s
// commits (vault.del → .trash 7d), early release smoothly restores. The
// existing brass-stroke-rail long-press in HandscrollNav.jsx stays as a
// power-user shortcut. 已搁置 list (Apple-Mail-style Recently Deleted)
// renders below the course list when there are recoverable items.
// CSS keyframes live in app/colors_and_type.css under "搁置课程 D".

const { useState } = React;

function relativeAgo(ts) {
  if (!ts) return '';
  const sec = Math.floor((Date.now() - ts) / 1000);
  const remain = Math.max(0, 7 * 86400 - sec);
  const remainDays = Math.floor(remain / 86400);
  const remainHours = Math.floor((remain % 86400) / 3600);
  const remainStr = remainDays > 0
    ? `${remainDays} 天后归尘`
    : (remainHours > 0 ? `${remainHours} 时后归尘` : '即将归尘');
  let agoStr;
  if (sec < 60) agoStr = `${sec} 秒前`;
  else if (sec < 3600) agoStr = `${Math.floor(sec / 60)} 分前`;
  else if (sec < 86400) agoStr = `${Math.floor(sec / 3600)} 时前`;
  else agoStr = `${Math.floor(sec / 86400)} 天前`;
  return `${agoStr} · ${remainStr}`;
}

const HomeScreen = ({ user, arc, onOpenLesson, onRoute, courses, onResumeCourse, onCreateNew }) => {
  const [hour] = useState(new Date().getHours());
  const greeting = hour < 5 ? "Late evening"
                 : hour < 12 ? "Good morning"
                 : hour < 18 ? "Good afternoon"
                 : "Good evening";
  const dateLabel = new Date().toLocaleDateString(undefined, {
    weekday: "long", month: "short", day: "numeric",
  });
  const namePart = user && user.name ? <span className="italic">{user.name}.</span> : null;

  // v0.5.x — local mutable course list. Seed from `courses` prop; refresh via
  // IPC after archive / restore so the list reflects vault truth without
  // requiring app.jsx to re-mount HomeScreen.
  const [localCourses, setLocalCourses] = React.useState(Array.isArray(courses) ? courses : []);
  React.useEffect(() => {
    setLocalCourses(Array.isArray(courses) ? courses : []);
  }, [courses]);

  const refreshCourses = React.useCallback(async () => {
    try {
      const fn = window.ptor && window.ptor.hypha && window.ptor.hypha.curriculumList;
      if (typeof fn !== 'function') return;
      const list = await fn();
      if (Array.isArray(list)) {
        const sorted = list.slice().sort((a, b) => (b.lastIdx ?? -1) - (a.lastIdx ?? -1));
        setLocalCourses(sorted);
      }
    } catch (_) { /* graceful no-op; toast already surfaces failures */ }
  }, []);

  // 已搁置 list (Apple-Mail-style "Recently Deleted").
  const [deprecated, setDeprecated] = React.useState([]);
  const refreshDeprecated = React.useCallback(async () => {
    try {
      const fn = window.ptor && window.ptor.hypha && window.ptor.hypha.curriculumListDeprecated;
      if (typeof fn !== 'function') { setDeprecated([]); return; }
      const list = await fn();
      setDeprecated(Array.isArray(list) ? list : []);
    } catch (_) { setDeprecated([]); }
  }, []);
  React.useEffect(() => { refreshDeprecated(); }, [refreshDeprecated]);

  // v0.5.x sub-lane — Frontier Cron visible UI surface (Machino-J self-shipped
  // after sub-agent batch 403'd 2026-05-09 evening). Reads settings via
  // existing `settings:get` IPC on mount; toggles via `frontierCronStart` /
  // `frontierCronStop` bridges shipped in H lane. Renders as marginalia
  // between active courses and 已搁置 section — not a giant card.
  const [cronEnabled, setCronEnabled] = React.useState(false);
  const [cronInterval, setCronInterval] = React.useState(6);
  const [cronToggling, setCronToggling] = React.useState(false);
  const cronToggleAt = React.useRef(0);
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fn = window.ptor && window.ptor.hypha && window.ptor.hypha.settingsGet;
        if (typeof fn !== 'function') return;
        const s = await fn();
        if (cancelled || !s) return;
        if (typeof s.frontierCronEnabled === 'boolean') setCronEnabled(s.frontierCronEnabled);
        const v = Number(s.frontierCronInterval);
        if (Number.isFinite(v) && v >= 6) setCronInterval(v);
      } catch (_) { /* settings read non-fatal; UI defaults to off + 6h */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleCronToggle = React.useCallback(async () => {
    const now = Date.now();
    if (now - cronToggleAt.current < 400) return;
    cronToggleAt.current = now;
    if (cronToggling) return;
    setCronToggling(true);
    const turningOn = !cronEnabled;
    try {
      if (turningOn) {
        const fn = window.ptor && window.ptor.hypha && window.ptor.hypha.frontierCronStart;
        if (typeof fn !== 'function') {
          setToast({ kind: 'err', text: '前沿巡探 IPC 未连' });
          setTimeout(() => setToast(null), 3600);
          return;
        }
        const r = await fn({ intervalHours: cronInterval });
        if (r && r.ok === true) {
          setCronEnabled(true);
          setToast({ kind: 'ok', text: '前沿巡探 · 已开' });
          setTimeout(() => setToast(null), 2400);
        } else {
          setToast({ kind: 'err', text: '开启失败 · ' + ((r && r.error) || '未知') });
          setTimeout(() => setToast(null), 3600);
        }
      } else {
        const fn = window.ptor && window.ptor.hypha && window.ptor.hypha.frontierCronStop;
        if (typeof fn !== 'function') {
          setToast({ kind: 'err', text: '前沿巡探 IPC 未连' });
          setTimeout(() => setToast(null), 3600);
          return;
        }
        const r = await fn();
        if (r && r.ok === true) {
          setCronEnabled(false);
          setToast({ kind: 'ok', text: '前沿巡探 · 已关' });
          setTimeout(() => setToast(null), 2400);
        } else {
          setToast({ kind: 'err', text: '关闭失败 · ' + ((r && r.error) || '未知') });
          setTimeout(() => setToast(null), 3600);
        }
      }
    } catch (e) {
      setToast({ kind: 'err', text: '前沿巡探异常 · ' + (e && e.message || e) });
      setTimeout(() => setToast(null), 3600);
    } finally {
      setCronToggling(false);
    }
  }, [cronEnabled, cronInterval, cronToggling]);

  const handleCronIntervalPick = React.useCallback(async (hours) => {
    if (![6, 12, 24].includes(hours)) return;
    setCronInterval(hours);
    if (!cronEnabled) return;
    try {
      const stop = window.ptor && window.ptor.hypha && window.ptor.hypha.frontierCronStop;
      const start = window.ptor && window.ptor.hypha && window.ptor.hypha.frontierCronStart;
      if (typeof stop !== 'function' || typeof start !== 'function') return;
      await stop();
      const r = await start({ intervalHours: hours });
      if (!r || r.ok !== true) {
        setToast({ kind: 'err', text: '间隔切换失败 · ' + ((r && r.error) || '未知') });
        setTimeout(() => setToast(null), 3600);
      } else {
        setToast({ kind: 'ok', text: `间隔 · ${hours} 时` });
        setTimeout(() => setToast(null), 2400);
      }
    } catch (e) {
      setToast({ kind: 'err', text: '间隔切换异常 · ' + (e && e.message || e) });
      setTimeout(() => setToast(null), 3600);
    }
  }, [cronEnabled]);

  // Per-row gesture state: { [slug]: 'pressing' | 'aborted' | 'committed' }.
  const [pressState, setPressState] = React.useState({});
  const pressTimers = React.useRef({});

  // Toast for IPC envelope failures (Muse #2 anti-silent-catch — every
  // {ok:false} surfaces here in italic peer voice, never swallowed).
  const [toast, setToast] = React.useState(null);
  const showToast = React.useCallback((kind, text, ms = 2400) => {
    setToast({ kind, text });
    setTimeout(() => setToast(null), ms);
  }, []);

  const setRowState = React.useCallback((slug, state) => {
    setPressState(prev => {
      const next = { ...prev };
      if (state === null) delete next[slug];
      else next[slug] = state;
      return next;
    });
  }, []);

  // Cleanup any pending timers on unmount.
  React.useEffect(() => () => {
    Object.values(pressTimers.current).forEach(t => clearTimeout(t));
    pressTimers.current = {};
  }, []);

  const startPress = (e, slug, rowEl) => {
    if (!slug) return;
    if (e.button !== 0) return; // left mouse only
    const cur = pressState[slug];
    if (cur === 'pressing' || cur === 'committed') return;
    // Clear stale --from-* CSS vars so first press has clean baseline.
    ['--from-opacity', '--from-blur', '--from-spacing', '--from-y', '--from-color']
      .forEach(p => rowEl.style.removeProperty(p));
    setRowState(slug, 'pressing');
    if (pressTimers.current[slug]) clearTimeout(pressTimers.current[slug]);
    pressTimers.current[slug] = setTimeout(() => {
      delete pressTimers.current[slug];
      commitDispose(slug);
    }, 1100);
  };

  const cancelPress = (slug, rowEl) => {
    if (!slug) return;
    const timer = pressTimers.current[slug];
    if (timer) { clearTimeout(timer); delete pressTimers.current[slug]; }
    setPressState(prev => {
      if (prev[slug] !== 'pressing') return prev;
      // Capture computed styles for the asymmetric ease-out restore (MUSE).
      try {
        const cs = window.getComputedStyle(rowEl);
        const blurMatch = (cs.filter && cs.filter !== 'none') ? cs.filter.match(/blur\(([^)]+)\)/) : null;
        const blurVal = blurMatch ? blurMatch[1] : '0px';
        let yVal = '0px';
        if (cs.transform && cs.transform !== 'none') {
          const m = cs.transform.match(/matrix\(([^)]+)\)/);
          if (m) {
            const parts = m[1].split(',').map(s => parseFloat(s.trim()));
            if (parts.length === 6 && Number.isFinite(parts[5])) yVal = parts[5] + 'px';
          }
        }
        rowEl.style.setProperty('--from-opacity', cs.opacity);
        rowEl.style.setProperty('--from-blur', blurVal);
        rowEl.style.setProperty('--from-spacing', cs.letterSpacing === 'normal' ? '0' : cs.letterSpacing);
        rowEl.style.setProperty('--from-y', yVal);
        rowEl.style.setProperty('--from-color', cs.color);
      } catch (_) { /* style capture is non-fatal; restore falls through to default vars */ }
      const next = { ...prev };
      next[slug] = 'aborted';
      return next;
    });
    // Strip 'aborted' after the 280ms restore completes.
    setTimeout(() => {
      setPressState(prev => {
        if (prev[slug] !== 'aborted') return prev;
        const next = { ...prev };
        delete next[slug];
        return next;
      });
    }, 320);
  };

  const commitDispose = async (slug) => {
    setRowState(slug, 'committed');
    const fn = window.ptor && window.ptor.hypha && window.ptor.hypha.curriculumArchive;
    if (typeof fn !== 'function') {
      showToast('err', '搁置失败 · 桥接未连', 3600);
      setRowState(slug, null);
      return;
    }
    try {
      const r = await fn(slug);
      // Wait for 240ms collapse animation to play out, then sync from vault.
      setTimeout(async () => {
        if (r && r.ok === true) {
          await refreshCourses();
          await refreshDeprecated();
          showToast('ok', '已搁置 · 七日内可恢');
        } else {
          showToast('err', '搁置失败 · ' + ((r && r.error) || '未知'), 3600);
          setRowState(slug, null);
          await refreshCourses();
        }
      }, 240);
    } catch (e) {
      showToast('err', '搁置异常 · ' + (e && e.message || e), 3600);
      setRowState(slug, null);
    }
  };

  const handleRestore = async (trashName) => {
    const fn = window.ptor && window.ptor.hypha && window.ptor.hypha.curriculumRestore;
    if (typeof fn !== 'function') {
      showToast('err', '恢复失败 · 桥接未连', 3600);
      return;
    }
    try {
      const r = await fn(trashName);
      if (r && r.ok === true) {
        showToast('ok', '已恢复');
        await refreshCourses();
        await refreshDeprecated();
      } else {
        showToast('err', '恢复失败 · ' + ((r && r.error) || '未知'), 3600);
      }
    } catch (e) {
      showToast('err', '恢复异常 · ' + (e && e.message || e), 3600);
    }
  };

  const hasCourses = Array.isArray(localCourses) && localCourses.length > 0;
  const hasDeprecated = Array.isArray(deprecated) && deprecated.length > 0;

  return (
    <div className="col gap-24 fade-in" style={{
      padding: "28px 36px 56px", maxWidth: 1480, margin: "0 auto", position: "relative",
    }}>
      <div className="wc-stage card-quiet" style={{
        position: "relative", padding: "32px 36px 28px",
        overflow: "hidden", display: "flex", flexDirection: "column", gap: 18,
        minHeight: hasCourses ? 220 : 320,
      }}>
        <Watercolor.Mycelium seed={3} opacity={0.55} />

        <div className="col gap-12" style={{ position: "relative", zIndex: 2 }}>
          <div className="eyebrow">Today · {dateLabel}</div>

          <div className="t-h1 serif" style={{ fontWeight: 400, fontSize: 42, lineHeight: 1.05 }}>
            {greeting},{namePart ? <><br />{namePart}</> : null}
          </div>

          <div className="t-quote" style={{ marginTop: 4, color: "var(--ink-3)" }}>
            {hasCourses
              ? "继续上一回，或开一节新课。"
              : "还没织下第一根线。先开一节课，让今天有一个着力点。"}
          </div>

          {!hasCourses && (
            <div className="row gap-8" style={{ marginTop: 18 }}>
              <button className="btn btn-primary" onClick={() => onRoute && onRoute("lesson")}>
                <Icon name="play" size={14} /> 开始一节课
              </button>
              <button className="btn btn-ghost" onClick={() => onRoute && onRoute("library")}>
                <Icon name="book" size={13} /> 带一份原文
              </button>
            </div>
          )}
        </div>
      </div>

      {hasCourses && (
        <div className="col gap-12">
          <div className="row" style={{ alignItems: "baseline", gap: 12 }}>
            <div className="eyebrow">课程</div>
            <span className="spacer" />
            <button className="btn btn-ghost" onClick={() => { if (typeof onCreateNew === 'function') onCreateNew(); }}>
              <Icon name="plus" size={13} /> 创建新课
            </button>
          </div>
          <div className="col gap-8">
            {localCourses.map((c, i) => {
              const lastN = (typeof c.lastIdx === 'number' && c.lastIdx >= 0) ? c.lastIdx + 1 : 0;
              const total = (typeof c.totalLessons === 'number') ? c.totalLessons : 0;
              const progressLabel = total > 0
                ? `${lastN} / ${total}`
                : (lastN > 0 ? `第 ${lastN} 节` : "尚未开课");
              const slug = c.topic;
              const rowState = pressState[slug];
              const rowClasses = [
                'dispose-row',
                'card-quiet',
                'row',
                rowState === 'pressing' ? 'dispose-press' : '',
                rowState === 'aborted' ? 'dispose-aborted' : '',
                rowState === 'committed' ? 'dispose-committed' : '',
              ].filter(Boolean).join(' ');
              return (
                <div
                  key={slug || i}
                  data-slug={slug}
                  className={rowClasses}
                  style={{
                    padding: "16px 20px", alignItems: "center", gap: 16,
                    borderLeft: "3px solid var(--ochre)",
                    position: "relative",
                  }}
                  onMouseDown={(e) => startPress(e, slug, e.currentTarget)}
                  onMouseUp={(e) => cancelPress(slug, e.currentTarget)}
                  onMouseLeave={(e) => cancelPress(slug, e.currentTarget)}
                >
                  <div className="col" style={{ minWidth: 0, gap: 4 }}>
                    <div className="serif" style={{ fontSize: 18, lineHeight: 1.25, fontWeight: 500 }}>
                      {c.topic || "(untitled)"}
                    </div>
                    <div className="dispose-meta t-tiny mono" style={{ color: "var(--ink-4)", letterSpacing: ".06em" }}>
                      {progressLabel}
                    </div>
                  </div>
                  <span className="spacer" />
                  <span className="dispose-press-hint" style={{ marginRight: 12 }}>
                    按住 · 课程渐隐
                  </span>
                  <button
                    className="btn btn-primary"
                    disabled={!c.firstLessonRel}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); if (typeof onResumeCourse === 'function') onResumeCourse(c); }}
                  >
                    <Icon name="play" size={13} /> 继续
                  </button>
                </div>
              );
            })}
          </div>

          <div className="frontier-cron-row" style={{
            marginTop: 18,
            padding: '6px 4px',
            display: 'flex',
            alignItems: 'baseline',
            gap: 14,
            fontFamily: 'inherit',
            fontStyle: 'italic',
            fontSize: 13.5,
            color: 'var(--ink-faint)',
            letterSpacing: '0.02em',
            borderTop: '1px dotted var(--hairline-warm)',
            paddingTop: 14,
          }}>
            <span style={{ color: 'var(--ink-muted)' }}>前沿巡探</span>
            <span style={{ color: 'var(--ink-faint)' }}>
              {cronEnabled ? `每 ${cronInterval} 时拉一次` : '休眠中'}
            </span>
            <span style={{ flex: 1 }} />
            {[6, 12, 24].map(h => {
              const sel = h === cronInterval;
              return (
                <button
                  key={h}
                  type="button"
                  onClick={() => handleCronIntervalPick(h)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    fontFamily: 'inherit',
                    fontStyle: 'italic',
                    fontSize: 13,
                    color: sel ? 'var(--brass-mid)' : 'var(--ink-faint)',
                    padding: '2px 0',
                    borderBottom: sel ? '1px solid var(--brass-mid)' : '1px solid transparent',
                    cursor: 'pointer',
                    letterSpacing: '0.04em',
                    transition: 'color 160ms ease, border-bottom-color 160ms ease',
                  }}
                  onMouseEnter={(e) => { if (!sel) e.currentTarget.style.color = 'var(--brass-mid)'; }}
                  onMouseLeave={(e) => { if (!sel) e.currentTarget.style.color = 'var(--ink-faint)'; }}
                >
                  {h} 时
                </button>
              );
            })}
            <button
              type="button"
              onClick={handleCronToggle}
              disabled={cronToggling}
              style={{
                background: 'transparent',
                border: 'none',
                fontFamily: 'inherit',
                fontStyle: 'italic',
                fontSize: 13,
                color: cronEnabled ? 'var(--brass-mid)' : 'var(--ink-muted)',
                padding: '2px 8px',
                borderBottom: '1px solid transparent',
                cursor: cronToggling ? 'wait' : 'pointer',
                letterSpacing: '0.04em',
                marginLeft: 6,
                opacity: cronToggling ? 0.55 : 1,
                transition: 'color 160ms ease, border-bottom-color 160ms ease',
              }}
              onMouseEnter={(e) => { if (!cronToggling) e.currentTarget.style.borderBottomColor = 'var(--brass-mid)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderBottomColor = 'transparent'; }}
            >
              {cronEnabled ? '关' : '开'}
            </button>
          </div>

          {hasDeprecated && (
            <div className="set-aside-section">
              <div className="label">已搁置 · 七日内可恢</div>
              {deprecated.map(d => (
                <div key={d.trashName} className="set-aside-row">
                  <span className="set-aside-title">{d.topic || d.originalSlug}</span>
                  <span className="set-aside-when">{relativeAgo(d.archivedAt)}</span>
                  <button
                    className="set-aside-restore"
                    onClick={() => handleRestore(d.trashName)}
                  >
                    恢复
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: 28,
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '10px 18px',
            background: toast.kind === 'err'
              ? 'color-mix(in srgb, var(--brass-amber) 14%, var(--bg-card, #fbf6ec))'
              : 'color-mix(in srgb, var(--brass-mid) 8%, var(--bg-card, #fbf6ec))',
            color: toast.kind === 'err' ? 'var(--brass-amber)' : 'var(--ink-primary)',
            border: '1px solid var(--hairline-warm)',
            borderRadius: 4,
            fontStyle: 'italic',
            fontSize: 14,
            letterSpacing: '0.02em',
            boxShadow: '0 6px 20px color-mix(in srgb, var(--brass-deep) 20%, transparent)',
            zIndex: 100,
            animation: 'fadeIn .25s ease both',
          }}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
};

window.HomeScreen = HomeScreen;
