'use strict';
// Shared relative-time formatter for Chinese UI register.
// Returns "刚刚" / "N 分钟前" / "N 时前" / "N 天前" / "N 月前" / fallback ISO date.

function formatRelativeTime(ts, opts = {}) {
  if (!ts) return '';
  const now = Date.now();
  let t;
  try { t = new Date(ts).getTime(); } catch (_) { return ''; }
  if (!Number.isFinite(t)) return '';
  const diffSec = Math.max(0, Math.floor((now - t) / 1000));
  const suffix = opts.suffix || '前';
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return Math.floor(diffSec / 60) + ' 分钟' + suffix;
  if (diffSec < 86400) return Math.floor(diffSec / 3600) + ' 时' + suffix;
  if (diffSec < 30 * 86400) return Math.floor(diffSec / 86400) + ' 天' + suffix;
  if (diffSec < 365 * 86400) return Math.floor(diffSec / (30 * 86400)) + ' 月' + suffix;
  return new Date(ts).toISOString().slice(0, 10);
}

module.exports = { formatRelativeTime };
