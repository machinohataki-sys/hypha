// Day-only theme system for Hypha.
//
// Per user 2026-04-30: night mode removed. App always renders in day palette
// (now slightly 肉粉 — see :root[data-theme="day"] in colors_and_type.css).
// Theme.jsx kept as a thin lock so the data-theme attribute is set on
// document mount; ThemeToggle returns null so the titlebar button vanishes
// without breaking PTorWindow's layout (which still references it).

function useTheme() {
  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', 'day');
    // Clean up any stale override left in localStorage from the day/night era
    // so future code paths can't accidentally re-toggle.
    try { localStorage.removeItem('ptor-theme-override'); } catch {}
  }, []);
  return ['day', () => {}];
}

// ThemeToggle returns null — kept exported so PTorWindow's titlebar render
// (which still references <ThemeToggle/>) doesn't break, but the button
// vanishes from the chrome. Day-only mode locked.
function ThemeToggle() {
  return null;
}

Object.assign(window, { useTheme, ThemeToggle });
