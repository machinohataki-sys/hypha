/* global React, Icon, Watercolor, Tooltip */
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

const TIER_LABEL = {
  'nearly-impossible': '几乎不可能',
  'strained': '紧张',
  'moderate': '适中',
  'gentle': '宽松',
  'heroic': '英雄',
};

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

  // Frontier last-harvest surface (2026-05-19). Reads frontierStatus on mount;
  // when hasFrontier && harvestCount > 0, the panel substring after "前沿巡探 ·"
  // becomes "N 条 · <relativeTime>" instead of "未启 · 点 6/12/24 时开启".
  const [frontierMeta, setFrontierMeta] = React.useState(null);
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fn = window.ptor && window.ptor.hypha && window.ptor.hypha.frontierStatus;
        if (typeof fn !== 'function') return;
        const r = await fn();
        if (cancelled || !r || r.ok !== true) return;
        if (r.hasFrontier && typeof r.harvestCount === 'number' && r.harvestCount > 0) {
          setFrontierMeta({ count: r.harvestCount, at: r.lastHarvestAt || 0 });
        }
      } catch (_) { /* non-fatal; fall back to existing copy */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Relative-time formatter scoped to frontier substring.
  // Routes through window.ptor.util.formatRelativeTime (canonical impl at
  // app/lib/util/relative-time.js); suffix '前抓' preserves hour/day display
  // ("N 时前抓" / "N 天前抓"). Falls back to inline mirror if bridge missing.
  const frontierRelative = React.useCallback((ts) => {
    if (!ts) return '';
    const fn = window.ptor && window.ptor.util && window.ptor.util.formatRelativeTime;
    if (typeof fn === 'function') return fn(ts, { suffix: '前抓' });
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 60) return '刚刚';
    if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前抓`;
    if (sec < 86400) return `${Math.floor(sec / 3600)} 时前抓`;
    return `${Math.floor(sec / 86400)} 天前抓`;
  }, []);

  // 编辑目标 handler (2026-05-19). Opens window.prompt seeded with current goal,
  // calls editCourseGoal IPC, refreshes list on success, toasts on error.
  const handleEditGoal = React.useCallback(async (course) => {
    if (!course || !course.topic) return;
    const seed = course.goal || course.northStarGoal || course.topic || '';
    let next;
    try {
      next = window.prompt('编辑课程目标', seed);
    } catch (_) { next = null; }
    if (next === null) return;
    const trimmed = String(next).trim();
    if (!trimmed) return;
    const fn = window.ptor && window.ptor.hypha && window.ptor.hypha.editCourseGoal;
    if (typeof fn !== 'function') {
      showToast('err', '编辑目标失败 · 桥接未连', 3600);
      return;
    }
    try {
      const r = await fn(course.topic, trimmed);
      if (r && r.ok === true) {
        showToast('ok', '目标已更新');
        try {
          const key = `editGoal_history_${course.topic}`;
          const prev = JSON.parse(localStorage.getItem(key) || '[]');
          prev.push({
            ts: new Date().toISOString(),
            type: 'north_star',
            oldGoal: course.goal || course.northStarGoal || '',
            newGoal: trimmed,
          });
          while (prev.length > 10) prev.shift();
          localStorage.setItem(key, JSON.stringify(prev));
        } catch (_) { /* localStorage full or absent — silent */ }
        await refreshCourses();
      } else {
        showToast('err', '编辑目标失败 · ' + ((r && r.error) || '未知'), 3600);
      }
    } catch (e) {
      showToast('err', '编辑目标异常 · ' + (e && e.message || e), 3600);
    }
  }, [refreshCourses]);

  const handleEditUltimate = React.useCallback(async (course) => {
    if (!course || !course.topic) return;
    const seed = course.ultimateGoal || '';
    let next;
    try {
      next = window.prompt('改课程 ultimate 目标', seed);
    } catch (_) { next = null; }
    if (next === null) return;
    const trimmed = String(next).trim();
    if (!trimmed || trimmed.length < 3) {
      showToast('err', '目标过短 (至少 3 字)', 2400);
      return;
    }
    const fn = window.ptor && window.ptor.hypha && window.ptor.hypha.chainEditUltimate;
    if (typeof fn !== 'function') {
      showToast('err', '改 ultimate 失败 · 桥接未连', 3600);
      return;
    }
    try {
      const r = await fn(course.topic, trimmed);
      if (r && r.ok === true) {
        showToast('ok', '已改 ultimate');
        try {
          const key = `editGoal_history_${course.topic}`;
          const prev = JSON.parse(localStorage.getItem(key) || '[]');
          prev.push({
            ts: new Date().toISOString(),
            type: 'ultimate',
            oldGoal: course.ultimateGoal || '',
            newGoal: trimmed,
          });
          while (prev.length > 10) prev.shift();
          localStorage.setItem(key, JSON.stringify(prev));
        } catch (_) { /* localStorage full or absent — silent */ }
        await refreshCourses();
      } else {
        showToast('err', '改 ultimate 失败 · ' + ((r && r.error) || '未知'), 3600);
      }
    } catch (e) {
      showToast('err', '改 ultimate 异常 · ' + (e && e.message || e), 3600);
    }
  }, [refreshCourses]);

  // v0.4.11: setCourseSeries IPC dual-writes state.series + chain.parent_chain_slug
  // under the hood (backend agent ship). "系列" semantically = parent_chain;
  // toast text stays simple, prompt label clarifies cross-course scope.
  // Seed from effectiveSeries (canonical view) then fall back to raw series.
  const handleSetSeries = React.useCallback(async (course) => {
    if (!course || !course.topic) return;
    const seed = (course.effectiveSeries && typeof course.effectiveSeries === 'string')
      ? course.effectiveSeries
      : ((course.series && typeof course.series === 'string') ? course.series : '');
    let next;
    try {
      next = window.prompt('设课程系列 (跨课分组 · 空 = 移出系列)', seed);
    } catch (_) { next = null; }
    if (next === null) return;
    const trimmed = String(next).trim();
    const fn = window.ptor && window.ptor.hypha && window.ptor.hypha.setCourseSeries;
    if (typeof fn !== 'function') {
      showToast('err', '设系列失败 · 桥接未连', 3600);
      return;
    }
    try {
      const r = await fn(course.topic, trimmed ? trimmed : null);
      if (r && r.ok === true) {
        showToast('ok', trimmed ? '已设系列 · ' + trimmed : '已移出系列');
        await refreshCourses();
      } else {
        showToast('err', '设系列失败 · ' + ((r && r.error) || '未知'), 3600);
      }
    } catch (e) {
      showToast('err', '设系列异常 · ' + (e && e.message || e), 3600);
    }
  }, [refreshCourses]);

  // Per-row gesture state: { [slug]: 'pressing' | 'aborted' | 'committed' }.
  const [pressState, setPressState] = React.useState({});
  const pressTimers = React.useRef({});

  // Toast for IPC envelope failures (Muse #2 anti-silent-catch — every
  // {ok:false} surfaces here in italic peer voice, never swallowed). v0.4.10
  // delegates to the unified <ToastRoot/> mounted at App root; local state
  // dropped. Signature preserved so call sites stay surgical.
  const showToast = React.useCallback((kind, text, ms = 2400) => {
    if (window.HyphaToast && typeof window.HyphaToast.showToast === 'function') {
      window.HyphaToast.showToast(kind, text, ms);
    }
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

          {/* Hero action row — smart label per vault state (2026-05-13).
              语义: 创建课程 (新课立项) ≠ 开始课程 (进入已有课). User differentiated these
              two actions in 2026-05-13 review. localCourses is sorted lastIdx-desc, [0] = 最近一节.
              没课 → 创建课程 + 带一份原文.
              有课 → 开始课程 (跳 [0]) + 创建课程 (新立项) + 带一份原文. */}
          <div className="row gap-8" style={{ marginTop: 18 }}>
            {hasCourses ? (
              <>
                <button
                  className="btn btn-primary"
                  disabled={!localCourses[0] || !localCourses[0].firstLessonRel}
                  onClick={() => {
                    const top = localCourses[0];
                    if (top && typeof onResumeCourse === 'function') onResumeCourse(top);
                  }}
                >
                  <Icon name="play" size={14} /> 开始课程
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => { if (typeof onCreateNew === 'function') onCreateNew(); }}
                >
                  <Icon name="plus" size={13} /> 创建课程
                </button>
                <button className="btn btn-ghost" onClick={() => onRoute && onRoute("library")}>
                  <Icon name="book" size={13} /> 带一份原文
                </button>
                {/* W1.5 — real-classroom Capture Mode entry. Lectures, video
                    courses, and longform reading all open the same low-
                    interruption capture surface. */}
                <button className="btn btn-ghost" onClick={() => onRoute && onRoute("capture")}>
                  <Icon name="book" size={13} /> 真实课堂记录
                </button>
              </>
            ) : (
              <>
                <button
                  className="btn btn-primary"
                  onClick={() => { if (typeof onCreateNew === 'function') onCreateNew(); }}
                >
                  <Icon name="plus" size={14} /> 创建课程
                </button>
                <button className="btn btn-ghost" onClick={() => onRoute && onRoute("library")}>
                  <Icon name="book" size={13} /> 带一份原文
                </button>
                <button className="btn btn-ghost" onClick={() => onRoute && onRoute("capture")}>
                  <Icon name="book" size={13} /> 真实课堂记录
                </button>
              </>
            )}
          </div>
          {/* 工具入口 (italic Garamond, low visual weight). 2026-05-13 七 pill 削枝:
              砍 7-Day AI Builder (hardcoded preset, 主流程 = 自创课程, 7-day 留 Quick Start 模板 demo).
              砍 跨学科 / 判断力 (独立屏 → 埋进 lesson chat 卡住时的 reframe pill).
              砍 课程图 (硬编码 AI/CS 单领域 KP graph, 非通用学习者用例).
              砍 Launch (dev-only readiness gate, 不对 user). */}
          <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontFamily: 'EB Garamond, "Noto Serif SC", serif', fontStyle: 'italic', fontSize: 12, color: 'var(--ink-3, #8a7d68)', letterSpacing: '0.04em', marginRight: 4 }}>工具 ·</span>
            <button className="btn btn-ghost" onClick={() => onRoute && onRoute("north-star")} style={{ fontSize: 12, fontFamily: 'EB Garamond, serif' }}>轨迹</button>
            <button className="btn btn-ghost" onClick={() => onRoute && onRoute("product-blueprint")} style={{ fontSize: 12, fontFamily: 'EB Garamond, serif' }}>产品蓝图</button>
            <button className="btn btn-ghost" onClick={() => onRoute && onRoute("spark-pool")} style={{ fontSize: 12, fontFamily: 'EB Garamond, serif' }}>Sparks</button>
            <button className="btn btn-ghost" onClick={() => onRoute && onRoute("kpi-dashboard")} style={{ fontSize: 12, fontFamily: 'EB Garamond, serif' }}>KPI</button>
            <button className="btn btn-ghost" onClick={() => onRoute && onRoute("flywheel-dashboard")} style={{ fontSize: 12, fontFamily: 'EB Garamond, serif' }}>Flywheel</button>
            <button className="btn btn-ghost" onClick={() => onRoute && onRoute("pack-learning")} style={{ fontSize: 12, fontFamily: 'EB Garamond, serif' }}>Pack</button>
            <button className="btn btn-ghost" onClick={() => onRoute && onRoute("exam-dashboard")} style={{ fontSize: 12, fontFamily: 'EB Garamond, serif' }}>考试</button>
            <button className="btn btn-ghost" onClick={() => onRoute && onRoute("radar-dashboard")} style={{ fontSize: 12, fontFamily: 'EB Garamond, serif' }}>前沿雷达</button>
            <button className="btn btn-ghost" onClick={() => onRoute && onRoute("ux-settings")} style={{ fontSize: 12, fontFamily: 'EB Garamond, serif' }}>设置</button>
            <button className="btn btn-ghost" onClick={() => onRoute && onRoute("feedback")} style={{ fontSize: 12, fontFamily: 'EB Garamond, serif' }}>反馈</button>
            <button className="btn btn-ghost" onClick={() => onRoute && onRoute("donate")} style={{ fontSize: 12, fontFamily: 'EB Garamond, serif' }}>Donate</button>
            <button className="btn btn-ghost" onClick={() => onRoute && onRoute("cost-budget")} style={{ fontSize: 12, fontFamily: 'EB Garamond, serif' }}>预算</button>
          </div>
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
          {(() => {
            // 系列 grouping (2026-05-19, v0.4.11 updated to effectiveSeries).
            // Prefer canonical c.effectiveSeries (backend: parentChainSlug ?? series ?? null);
            // fall back to raw c.series for backward compat with stale lists.
            // null/undefined → "其他". Skip section headers entirely if only one group total.
            // Within each group, preserve incoming sort order (refreshCourses already sorts
            // by lastIdx-desc).
            const groups = new Map();
            const OTHER = '__other__';
            for (const c of localCourses) {
              const eff = (c && typeof c.effectiveSeries === 'string' && c.effectiveSeries.trim())
                ? c.effectiveSeries.trim()
                : ((c && typeof c.series === 'string' && c.series.trim()) ? c.series.trim() : null);
              const key = eff || OTHER;
              if (!groups.has(key)) groups.set(key, []);
              groups.get(key).push(c);
            }
            // Ordered: named series in first-seen order, "其他" last.
            const orderedKeys = [];
            for (const k of groups.keys()) if (k !== OTHER) orderedKeys.push(k);
            if (groups.has(OTHER)) orderedKeys.push(OTHER);
            const showHeaders = orderedKeys.length > 1;
            return (
              <div className="col gap-16">
                {orderedKeys.map(key => {
                  const list = groups.get(key) || [];
                  const heading = key === OTHER ? '其他' : `系列 · ${key}`;
                  return (
                    <div key={key} className="col gap-8">
                      {showHeaders && (
                        <div className="eyebrow" style={{ marginTop: 4 }}>{heading}</div>
                      )}
                      <div className="col gap-8">
                        {list.map((c, i) => {
              const lastN = (typeof c.lastIdx === 'number' && c.lastIdx >= 0) ? c.lastIdx + 1 : 0;
              const total = (typeof c.totalLessons === 'number') ? c.totalLessons : 0;
              // v0.4.11 (2026-05-19) — sessionsCount fallback. User complaint:
              // "下午上了一节课, 此处全部都是 0" 因为 /finish 未跑 lastIdx ! bump.
              // 若 lastIdx=-1 (无 finish) 但 sessionsCount > 0 显 "进行中 · N 次".
              const sess = (typeof c.sessionsCount === 'number') ? c.sessionsCount : 0;
              const genInFlight = c.lessonGenInFlight === true || c.genStatus === 'pending';
              const progressLabel = genInFlight
                ? '课程生成中...'
                : (total > 0
                    ? (lastN > 0
                        ? `${lastN} / ${total}`
                        : (sess > 0 ? `进行中 · ${sess} 次访问 / ${total} 节` : `0 / ${total} · 尚未开课`))
                    : (lastN > 0 ? `第 ${lastN} 节` : (sess > 0 ? `进行中 · ${sess} 次访问` : "尚未开课")));
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
                    {c.ultimateGoal && (() => {
                      const truncated = c.ultimateGoal.length > 60;
                      const display = truncated ? c.ultimateGoal.slice(0, 58) + '…' : c.ultimateGoal;
                      const ultimateSpan = (
                        <span style={{
                          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
                          fontStyle: 'italic',
                          fontSize: 13,
                          color: 'var(--terracotta-2, #8B3A3A)',
                          letterSpacing: '.01em',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          minWidth: 0,
                          maxWidth: '100%',
                        }} title={c.ultimateGoal}>
                          ULTIMATE · {display}
                        </span>
                      );
                      const feasBadge = c.feasibility ? (
                        <span className="mono" style={{
                          fontSize: 10,
                          color: 'var(--terracotta-1, #A66D2C)',
                          marginLeft: 8,
                          letterSpacing: '.05em',
                          whiteSpace: 'nowrap',
                          cursor: 'help',
                        }} title={`${TIER_LABEL[c.feasibility.tier] || c.feasibility.tier} · hoursNeeded ${c.feasibility.hoursNeeded} / hoursAvailable ${c.feasibility.hoursAvailable}`}>
                          · {TIER_LABEL[c.feasibility.tier] || c.feasibility.tier} ({c.feasibility.hoursNeeded}h / {c.feasibility.hoursAvailable}h)
                        </span>
                      ) : null;
                      const feasGap = c.feasibility
                        ? Math.max(0, (c.feasibility.hoursNeeded || 0) - (c.feasibility.hoursAvailable || 0))
                        : 0;
                      const feasTipContent = c.feasibility
                        ? `${TIER_LABEL[c.feasibility.tier] || c.feasibility.tier} = ${c.feasibility.tier} · hoursNeeded ${c.feasibility.hoursNeeded} vs hoursAvailable ${c.feasibility.hoursAvailable} · gap ${feasGap}h`
                        : '';
                      return (
                        <div className="row" style={{ marginTop: 4, marginBottom: 4, alignItems: 'baseline', minWidth: 0 }}>
                          {truncated && typeof Tooltip === 'function' ? (
                            <Tooltip position="bottom" maxWidth={420} content={c.ultimateGoal}>
                              {ultimateSpan}
                            </Tooltip>
                          ) : ultimateSpan}
                          {c.feasibility && (
                            typeof Tooltip === 'function' ? (
                              <Tooltip position="bottom" maxWidth={320} content={feasTipContent}>
                                {feasBadge}
                              </Tooltip>
                            ) : feasBadge
                          )}
                        </div>
                      );
                    })()}
                    <div className="dispose-meta t-tiny mono" style={{ color: "var(--ink-4)", letterSpacing: ".06em" }}>
                      {progressLabel}
                    </div>
                    {/* v0.4.11 — surface canonical chain.parent_chain_slug when it
                        diverges from raw state.series (e.g. post-migration scenario).
                        Italic decoration register per feedback_italic_decoration_only —
                        parenthetical editorial commentary, not an action label. */}
                    {c.parentChainSlug && typeof c.parentChainSlug === 'string'
                      && c.parentChainSlug !== c.series && (
                      <div
                        className="mono"
                        style={{
                          fontSize: 9,
                          fontStyle: 'italic',
                          color: 'var(--terracotta-1, #A66D2C)',
                          letterSpacing: '.04em',
                          marginTop: 1,
                        }}
                        title="canonical chain.parent_chain_slug"
                      >
                        · parent: {c.parentChainSlug}
                      </div>
                    )}
                    {Array.isArray(c.chainLinks) && c.chainLinks.length > 0 && (
                      <div className="row" style={{ marginTop: 6, gap: 2, alignItems: 'center', height: 4 }}>
                        {c.chainLinks.map((link, idx) => {
                          const ROLE_COLOR = {
                            prerequisite: '#A8A8A8',
                            core: 'var(--brass-mid, #B59465)',
                            ultimate: 'var(--terracotta-2, #8B3A3A)',
                          };
                          const color = ROLE_COLOR[link.role] || '#A8A8A8';
                          return (
                            <div key={idx} style={{
                              flex: link.lessons_count || 1,
                              height: 4,
                              background: color,
                              borderRadius: 1,
                              opacity: 0.85,
                            }} title={`${link.role || 'unknown'} · ${link.lessons_count || 0} 节${link.topic ? ' · ' + link.topic : ''}`} />
                          );
                        })}
                      </div>
                    )}
                    <div className="row" style={{ gap: 14, alignItems: 'baseline', marginTop: 2 }}>
                      <button
                        type="button"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); handleEditUltimate(c); }}
                        title="改课程的 ultimate 目标 (chain.json.ultimate_goal)"
                        style={{
                          padding: '2px 0',
                          background: 'transparent',
                          border: 'none',
                          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
                          fontSize: 12,
                          color: 'var(--ink-3, #8a7d68)',
                          letterSpacing: '0.04em',
                          cursor: 'pointer',
                          borderBottom: '1px solid transparent',
                          transition: 'color 160ms ease, border-bottom-color 160ms ease',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--brass-mid)'; e.currentTarget.style.borderBottomColor = 'var(--brass-mid)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--ink-3, #8a7d68)'; e.currentTarget.style.borderBottomColor = 'transparent'; }}
                      >
                        改 ultimate
                      </button>
                      <button
                        type="button"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); handleEditGoal(c); }}
                        title="改学习目标 (state.goalContract.north_star_goal — 进阶字段, 通常已与 ultimate 同步)"
                        style={{
                          padding: '2px 0',
                          background: 'transparent',
                          border: 'none',
                          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
                          fontSize: 12,
                          color: 'var(--ink-3, #8a7d68)',
                          letterSpacing: '0.04em',
                          cursor: 'pointer',
                          borderBottom: '1px solid transparent',
                          transition: 'color 160ms ease, border-bottom-color 160ms ease',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--brass-mid)'; e.currentTarget.style.borderBottomColor = 'var(--brass-mid)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--ink-3, #8a7d68)'; e.currentTarget.style.borderBottomColor = 'transparent'; }}
                      >
                        编辑目标
                      </button>
                      <button
                        type="button"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); handleSetSeries(c); }}
                        style={{
                          padding: '2px 0',
                          background: 'transparent',
                          border: 'none',
                          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
                          fontSize: 12,
                          color: 'var(--ink-3, #8a7d68)',
                          letterSpacing: '0.04em',
                          cursor: 'pointer',
                          borderBottom: '1px solid transparent',
                          transition: 'color 160ms ease, border-bottom-color 160ms ease',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--brass-mid)'; e.currentTarget.style.borderBottomColor = 'var(--brass-mid)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--ink-3, #8a7d68)'; e.currentTarget.style.borderBottomColor = 'transparent'; }}
                      >
                        设系列
                      </button>
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
                    </div>
                  );
                })}
              </div>
            );
          })()}

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
              {cronEnabled
                ? `每 ${cronInterval} 时拉一次`
                : (frontierMeta
                    ? `前沿 · ${frontierMeta.count} 条 · ${frontierRelative(frontierMeta.at)}`
                    : '未启 · 点 6/12/24 时开启')}
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

      {/* v0.4.10 — local toast JSX removed; <ToastRoot/> at App root renders
          all toasts dispatched via window.HyphaToast.showToast. */}
    </div>
  );
};

window.HomeScreen = HomeScreen;
