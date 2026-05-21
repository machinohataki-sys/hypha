'use strict';

// HYPHA · Creation System §11.8 — Roadmap Sync (slug-bound)
//
// Per BLUEPRINT §11.8: roll up the past 7 days of decisions / assumptions /
// product Sparks (+ kill-watcher auto-flag rows) into a weekly markdown
// roadmap. The LLM curates "本周优先 / 暂缓 / 建议砍掉" — Hypha persists the
// rendered markdown to vault/<slug>/roadmap-weekly-YYYY-MM-DD.md.
//
// Slug-bound today (founder cohort hasn't bound `.products/<id>/` yet).
// v0.7.1+ migrates to product-bound storage; this module stays curriculum-
// rooted on purpose so the UI can render before bind.
//
// API:
//   runWeeklySync({ slug, now, settings, dryRun }) → { ok, summary, mdPath?, skipped? }
//   getLatestRoadmap(slug)                          → { ok, mdContent, mdPath, generatedAt } | { ok:false }
//   listRoadmapWeeks(slug)                          → array of { weekAnchorDate, mdPath }
//
// Defense:
//   - slug validated (no '..', '/', '\\', leading '.')
//   - executeChat failure → { ok:false, error }
//   - LLM emits invalid JSON → { ok:false, error:'invalid-json' }
//   - LLM emits valid JSON but structurally bad → { ok:false, error }
//   - dryRun:true skips disk write
//   - corrupt JSONL lines in upstream ledgers silently skipped (mirrors siblings)
//
// Out of scope (per Machino-α4 task spec):
//   - UI (Machino-β4)
//   - product-bound roadmap (v0.7.1)
//   - cron registration (v0.7.1)
//   - 14 modules self-declaration (Machino-γ4)

const fs = require('node:fs');
const path = require('node:path');
const vault = require('../vault');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_ENTRIES_TOTAL = 3;
const MAX_PRIORITY = 3;
const MAX_DEFER = 3;
const MAX_CONSIDER_KILLING = 3;
const MIN_SUMMARY_CHARS = 20;
const MD_FILE_PREFIX = 'roadmap-weekly-';
const MD_FILE_SUFFIX = '.md';

// ---------------------------------------------------------------------------
// Slug + path helpers (mirror sibling modules)
// ---------------------------------------------------------------------------

function _safeSlug(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const trimmed = slug.trim();
  if (!trimmed) return null;
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) return null;
  if (trimmed.startsWith('.')) return null;
  return trimmed;
}

function _baseDir(safeSlug) {
  const root = vault.resolveRoot();
  return path.join(root, safeSlug);
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

// Monday-anchored week. ISO weeks treat Monday as the first day; downstream
// readers expect that convention (matches "本周路线" header). For a Sunday,
// `getDay()` returns 0 → roll back 6 days to land on prior Monday.
function _mondayOfWeek(d) {
  const out = new Date(d.getTime());
  const dow = out.getDay(); // 0 (Sun) .. 6 (Sat)
  const delta = (dow + 6) % 7; // Mon -> 0, Tue -> 1, ..., Sun -> 6
  out.setDate(out.getDate() - delta);
  out.setHours(0, 0, 0, 0);
  return out;
}

function _isoDateOnly(d) {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// JSONL readers — defensive, mirrors sibling module conventions.
// ---------------------------------------------------------------------------

function _readJsonl(abs) {
  if (!fs.existsSync(abs)) return [];
  let raw;
  try { raw = fs.readFileSync(abs, 'utf8'); }
  catch (_) { return []; }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); }
    catch (_) { /* skip corrupt line */ }
  }
  return rows;
}

// Per-id collapse (latest-state + earliest-prediction) — same semantics as
// assumption-ledger / product-spark. Decisions have no id-column so they are
// returned as-is.
function _collapseLatest(rows, idKey) {
  const groups = new Map();
  for (const r of rows) {
    if (!r || !r[idKey]) continue;
    const id = r[idKey];
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  }
  const out = [];
  for (const [, rs] of groups) {
    if (!rs.length) continue;
    rs.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const earliest = rs[0];
    const latest = rs[rs.length - 1];
    const merged = { ...latest };
    if (earliest.prediction && !merged.prediction) {
      merged.prediction = earliest.prediction;
    }
    out.push(merged);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gather 7-day window across all 4 ledgers.
// ---------------------------------------------------------------------------

function _gather(safeSlug, now) {
  const base = _baseDir(safeSlug);
  const cutoffIso = new Date(now.getTime() - WEEK_MS).toISOString();

  // Decisions: row-per-row (no state machine).
  const decisionRows = _readJsonl(path.join(base, 'decisions.jsonl'))
    .filter(r => r && typeof r.ts === 'string' && r.ts >= cutoffIso);

  // Assumptions + sparks: collapse to latest state per id, then filter by latest ts.
  const allAssumptions = _readJsonl(path.join(base, 'assumptions.jsonl'));
  const collapsedAssumptions = _collapseLatest(allAssumptions, 'assumption_id')
    .filter(r => r && typeof r.ts === 'string' && r.ts >= cutoffIso);

  const allSparks = _readJsonl(path.join(base, 'sparks.jsonl'));
  const collapsedSparks = _collapseLatest(allSparks, 'spark_id')
    .filter(r => r && typeof r.ts === 'string' && r.ts >= cutoffIso);

  // Auto-flagged / auto-killed rows from kill-watcher land in either a
  // sibling decision-reviews.jsonl (decisions) or as `_meta.auto_killed_at`
  // rows in assumptions.jsonl / sparks.jsonl. We surface them all under a
  // single `killed` bucket so the LLM can weigh recent purges.
  const decisionReviews = _readJsonl(path.join(base, 'decision-reviews.jsonl'))
    .filter(r => r && r.action === 'auto_review_flag' && typeof r.ts === 'string' && r.ts >= cutoffIso);

  const autoKilledAssumptions = allAssumptions.filter(r => r
    && r._meta && r._meta.auto_killed_at
    && typeof r._meta.auto_killed_at === 'string'
    && r._meta.auto_killed_at >= cutoffIso);

  const autoKilledSparks = allSparks.filter(r => r
    && r._meta && r._meta.auto_killed_at
    && typeof r._meta.auto_killed_at === 'string'
    && r._meta.auto_killed_at >= cutoffIso);

  return {
    decisions: decisionRows,
    assumptions: collapsedAssumptions,
    sparks: collapsedSparks,
    decisionReviews,
    autoKilledAssumptions,
    autoKilledSparks,
  };
}

// ---------------------------------------------------------------------------
// LLM prompt construction.
// ---------------------------------------------------------------------------

function _fmtPrediction(p) {
  if (!p || typeof p !== 'object') return '';
  const claim = (typeof p.claim === 'string' ? p.claim : '').trim();
  const falsifier = (typeof p.falsifier === 'string' ? p.falsifier : '').trim();
  const deadline = (typeof p.deadline_iso === 'string' ? p.deadline_iso : '').trim();
  const bits = [];
  if (claim) bits.push(`预测=${claim}`);
  if (falsifier) bits.push(`证伪=${falsifier}`);
  if (deadline) bits.push(`截止=${deadline}`);
  return bits.length ? ` [${bits.join(' · ')}]` : '';
}

function _dateOnly(ts) {
  if (typeof ts !== 'string') return '';
  return ts.slice(0, 10);
}

function _lessonAnchor(row) {
  if (Number.isFinite(row.lesson_idx)) return `lesson-${row.lesson_idx}`;
  return '';
}

function _buildLlmInput(bundle) {
  const lines = [];

  // Decisions
  lines.push(`## 决策(近 7 天 ${bundle.decisions.length} 条)`);
  if (bundle.decisions.length === 0) {
    lines.push('- (无)');
  } else {
    for (const r of bundle.decisions) {
      const date = _dateOnly(r.ts);
      const anchor = _lessonAnchor(r);
      const decision = (r.decision || '').trim();
      const rationale = (r.rationale || '').trim();
      const tail = rationale ? `, 理由: ${rationale}` : '';
      lines.push(`- ${date} ${anchor} 决定${decision}${tail}${_fmtPrediction(r.prediction)}`);
    }
  }
  lines.push('');

  // Assumptions
  lines.push(`## 假设(近 7 天 ${bundle.assumptions.length} 条)`);
  if (bundle.assumptions.length === 0) {
    lines.push('- (无)');
  } else {
    for (const r of bundle.assumptions) {
      const date = _dateOnly(r.ts);
      const anchor = _lessonAnchor(r);
      const state = r.state || 'unvalidated';
      const claim = (r.claim || '').trim();
      lines.push(`- ${date} ${anchor} [${state}] ${claim}${_fmtPrediction(r.prediction)}`);
    }
  }
  lines.push('');

  // Sparks
  lines.push(`## 灵感(近 7 天 ${bundle.sparks.length} 条)`);
  if (bundle.sparks.length === 0) {
    lines.push('- (无)');
  } else {
    for (const r of bundle.sparks) {
      const date = _dateOnly(r.ts);
      const anchor = _lessonAnchor(r);
      const state = r.state || 'Seed';
      const transfer = (r.core_transfer || '').trim();
      lines.push(`- ${date} ${anchor} [${state}] ${transfer}${_fmtPrediction(r.prediction)}`);
    }
  }
  lines.push('');

  // Kill-watcher auto purges (combined view)
  const killCount = bundle.decisionReviews.length
    + bundle.autoKilledAssumptions.length
    + bundle.autoKilledSparks.length;
  lines.push(`## 自动推翻/搁置(kill-watcher 抓到 ${killCount} 条)`);
  if (killCount === 0) {
    lines.push('- (无)');
  } else {
    for (const r of bundle.decisionReviews) {
      const date = _dateOnly(r.ts);
      const decision = (r.original_decision || '').trim();
      const dl = (r.deadline_iso || '').trim();
      lines.push(`- ${date} 决策 "${decision}" 被 auto flagged (deadline ${dl})`);
    }
    for (const r of bundle.autoKilledAssumptions) {
      const date = _dateOnly(r._meta.auto_killed_at);
      const claim = (r.claim || '').trim();
      const dl = r.prediction && r.prediction.deadline_iso ? r.prediction.deadline_iso : '';
      lines.push(`- ${date} 假设 "${claim}" 被 auto refuted (deadline ${dl})`);
    }
    for (const r of bundle.autoKilledSparks) {
      const date = _dateOnly(r._meta.auto_killed_at);
      const transfer = (r.core_transfer || '').trim();
      const dl = r.prediction && r.prediction.deadline_iso ? r.prediction.deadline_iso : '';
      lines.push(`- ${date} 灵感 "${transfer}" 被 auto rejected (deadline ${dl})`);
    }
  }

  return lines.join('\n');
}

const SYSTEM_PROMPT = [
  '你在为创作者做一周路线复盘。给你近 7 天的决策、假设、灵感、自动推翻清单。',
  '你的任务: 挑出本周该优先处理的事 + 暂缓的事 + 建议砍掉的事。',
  '',
  '严格规则:',
  '- 中文输出, 手稿调, 禁用 emoji / 感叹号 / "great" / 营销话术',
  '- 不编造。数据稀疏就少写, 不强行凑数',
  '- priority_now ≤ 3 条; defer ≤ 3 条; consider_killing ≤ 3 条',
  '- 每条 summary ≥ 20 字',
  '- anchor_refs 必须指向你看到的具体条目 (如 "lesson-3 决策" / "lesson-5 灵感")',
  '- 不输出"努力学习是好的"这种空话',
  '',
  '输出严格 JSON, 不加任何解释或代码围栏:',
  '{',
  '  "week_anchor": "本周关键洞察 1-2 句",',
  '  "priority_now": [',
  '    {',
  '      "title": "短标题 (≤ 20 字)",',
  '      "summary": "为什么本周该优先处理 1-2 句 (≥ 20 字)",',
  '      "anchor_refs": ["lesson-3 决策", "lesson-5 灵感"],',
  '      "next_action": "下一步具体动作"',
  '    }',
  '  ],',
  '  "defer": [',
  '    { "title": "...", "summary": "为什么暂缓 (≥ 20 字)", "anchor_refs": ["..."] }',
  '  ],',
  '  "consider_killing": [',
  '    { "title": "...", "reason": "为什么该砍 (≥ 20 字)", "anchor_refs": ["..."] }',
  '  ]',
  '}',
].join('\n');

// ---------------------------------------------------------------------------
// LLM output sanitization. Defensive against null / wrong types / oversized.
// ---------------------------------------------------------------------------

function _trim(v, max) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  if (!t) return '';
  return t.length > max ? t.slice(0, max) : t;
}

function _coerceAnchorRefs(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (!t) continue;
    out.push(t.length > 80 ? t.slice(0, 80) : t);
    if (out.length >= 6) break;
  }
  return out;
}

function _normalizeLlmOutput(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { obj = JSON.parse(stripped); }
    catch (_) { return { error: 'invalid-json' }; }
  }
  if (!obj || typeof obj !== 'object') return { error: 'invalid-json' };

  const weekAnchor = _trim(obj.week_anchor, 300);

  const priorityRaw = Array.isArray(obj.priority_now) ? obj.priority_now : [];
  const deferRaw = Array.isArray(obj.defer) ? obj.defer : [];
  const killRaw = Array.isArray(obj.consider_killing) ? obj.consider_killing : [];

  const priority = [];
  for (const r of priorityRaw) {
    if (!r || typeof r !== 'object') continue;
    const title = _trim(r.title, 80);
    const summary = _trim(r.summary, 600);
    const nextAction = _trim(r.next_action, 300);
    if (title.length === 0) continue;
    if (summary.length < MIN_SUMMARY_CHARS) continue;
    priority.push({
      title,
      summary,
      anchor_refs: _coerceAnchorRefs(r.anchor_refs),
      next_action: nextAction,
    });
    if (priority.length >= MAX_PRIORITY) break;
  }

  const defer = [];
  for (const r of deferRaw) {
    if (!r || typeof r !== 'object') continue;
    const title = _trim(r.title, 80);
    const summary = _trim(r.summary, 600);
    if (title.length === 0) continue;
    if (summary.length < MIN_SUMMARY_CHARS) continue;
    defer.push({
      title,
      summary,
      anchor_refs: _coerceAnchorRefs(r.anchor_refs),
    });
    if (defer.length >= MAX_DEFER) break;
  }

  const considerKilling = [];
  for (const r of killRaw) {
    if (!r || typeof r !== 'object') continue;
    const title = _trim(r.title, 80);
    const reason = _trim(r.reason, 600);
    if (title.length === 0) continue;
    if (reason.length < MIN_SUMMARY_CHARS) continue;
    considerKilling.push({
      title,
      reason,
      anchor_refs: _coerceAnchorRefs(r.anchor_refs),
    });
    if (considerKilling.length >= MAX_CONSIDER_KILLING) break;
  }

  return {
    week_anchor: weekAnchor,
    priority_now: priority,
    defer,
    consider_killing: considerKilling,
  };
}

// ---------------------------------------------------------------------------
// Markdown render.
// ---------------------------------------------------------------------------

function _renderMarkdown({ slug, weekAnchorDate, generatedAtIso, entryCount, llm }) {
  const lines = [];
  lines.push('---');
  lines.push(`slug: ${slug}`);
  lines.push(`week_anchor_date: ${weekAnchorDate}`);
  lines.push(`generated_at: ${generatedAtIso}`);
  lines.push(`entry_count: { decisions: ${entryCount.decisions}, assumptions: ${entryCount.assumptions}, sparks: ${entryCount.sparks}, killed: ${entryCount.killed} }`);
  lines.push('---');
  lines.push('');
  lines.push(`# 本周路线 · ${weekAnchorDate}`);
  lines.push('');
  if (llm.week_anchor) {
    lines.push(llm.week_anchor);
    lines.push('');
  }

  lines.push('## 本周优先 (priority_now)');
  if (llm.priority_now.length === 0) {
    lines.push('- (本周无明确优先项)');
  } else {
    for (const item of llm.priority_now) {
      lines.push(`- **${item.title}** — ${item.summary}`);
      if (item.anchor_refs.length) {
        lines.push(`  - 来源: ${item.anchor_refs.join(' · ')}`);
      }
      if (item.next_action) {
        lines.push(`  - 下一步: ${item.next_action}`);
      }
    }
  }
  lines.push('');

  lines.push('## 暂缓 (defer)');
  if (llm.defer.length === 0) {
    lines.push('- (无)');
  } else {
    for (const item of llm.defer) {
      lines.push(`- **${item.title}** — ${item.summary}`);
      if (item.anchor_refs.length) {
        lines.push(`  - 来源: ${item.anchor_refs.join(' · ')}`);
      }
    }
  }
  lines.push('');

  lines.push('## 建议砍掉 (consider_killing)');
  if (llm.consider_killing.length === 0) {
    lines.push('- (无)');
  } else {
    for (const item of llm.consider_killing) {
      lines.push(`- **${item.title}** — ${item.reason}`);
      if (item.anchor_refs.length) {
        lines.push(`  - 来源: ${item.anchor_refs.join(' · ')}`);
      }
    }
  }
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the weekly roadmap sync for one slug.
 *
 * @param {object} args
 * @param {string} args.slug
 * @param {Date} [args.now]      — defaults to new Date()
 * @param {object} [args.settings] — passed through; reserved for future LLM router needs
 * @param {boolean} [args.dryRun] — if true, do not write the markdown to disk
 * @returns {Promise<{ ok:boolean, summary?:object, mdPath?:string, skipped?:string, error?:string }>}
 */
async function runWeeklySync({ slug, now, settings: _settings, dryRun } = {}) {
  const safe = _safeSlug(slug);
  if (!safe) return { ok: false, error: 'roadmap-sync: invalid slug' };

  const nowDate = now instanceof Date ? now : new Date();

  let bundle;
  try { bundle = _gather(safe, nowDate); }
  catch (err) {
    return { ok: false, error: `roadmap-sync: gather failed: ${err && err.message ? err.message : String(err)}` };
  }

  const entryCount = {
    decisions: bundle.decisions.length,
    assumptions: bundle.assumptions.length,
    sparks: bundle.sparks.length,
    killed: bundle.decisionReviews.length
      + bundle.autoKilledAssumptions.length
      + bundle.autoKilledSparks.length,
  };

  const totalEntries = entryCount.decisions + entryCount.assumptions + entryCount.sparks;
  if (totalEntries < MIN_ENTRIES_TOTAL) {
    return { ok: true, skipped: 'too-few-entries', count: totalEntries };
  }

  const userPrompt = _buildLlmInput(bundle);

  let llmOut;
  try {
    // Lazy-require so cold paths (lint / test) don't pull the router.
    const { executeChat } = require('../llm');
    const dispatched = await executeChat('T6_STRONG', {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt },
      ],
      json: true,
      temperature: 0.4,
      maxTokens: 2500,
    });
    llmOut = dispatched && dispatched.result != null ? dispatched.result : dispatched;
  } catch (err) {
    return {
      ok: false,
      error: `roadmap-sync: llm failed: ${err && err.message ? err.message : String(err)}`,
    };
  }

  const normalized = _normalizeLlmOutput(llmOut);
  if (normalized.error === 'invalid-json') {
    return { ok: false, error: 'invalid-json' };
  }

  const weekMonday = _mondayOfWeek(nowDate);
  const weekAnchorDate = _isoDateOnly(weekMonday);
  const generatedAtIso = nowDate.toISOString();

  const md = _renderMarkdown({
    slug: safe,
    weekAnchorDate,
    generatedAtIso,
    entryCount,
    llm: normalized,
  });

  const summary = {
    week_anchor_date: weekAnchorDate,
    generated_at: generatedAtIso,
    entry_count: entryCount,
    priority_now_count: normalized.priority_now.length,
    defer_count: normalized.defer.length,
    consider_killing_count: normalized.consider_killing.length,
    week_anchor: normalized.week_anchor || '',
  };

  if (dryRun) {
    return { ok: true, summary, dryRun: true, md };
  }

  const baseDir = _baseDir(safe);
  const mdPath = path.join(baseDir, `${MD_FILE_PREFIX}${weekAnchorDate}${MD_FILE_SUFFIX}`);

  try {
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(mdPath, md, 'utf8');
  } catch (err) {
    return {
      ok: false,
      error: `roadmap-sync: write failed: ${err && err.message ? err.message : String(err)}`,
    };
  }

  return { ok: true, summary, mdPath };
}

// ---------------------------------------------------------------------------
// Read helpers — UI listing / latest-fetch.
// ---------------------------------------------------------------------------

// Match roadmap-weekly-YYYY-MM-DD.md exactly. Tolerate weird stuff in the dir
// (other .md, .body.json, etc.) by skipping non-matching names.
const _ROADMAP_RE = /^roadmap-weekly-(\d{4}-\d{2}-\d{2})\.md$/;

function _listRoadmapFiles(safeSlug) {
  const baseDir = _baseDir(safeSlug);
  if (!fs.existsSync(baseDir)) return [];
  let dirents;
  try { dirents = fs.readdirSync(baseDir, { withFileTypes: true }); }
  catch (_) { return []; }
  const out = [];
  for (const d of dirents) {
    if (!d.isFile()) continue;
    const m = d.name.match(_ROADMAP_RE);
    if (!m) continue;
    out.push({
      weekAnchorDate: m[1],
      mdPath: path.join(baseDir, d.name),
    });
  }
  // Newest first by date string (YYYY-MM-DD sorts lexically = chronologically).
  out.sort((a, b) => b.weekAnchorDate.localeCompare(a.weekAnchorDate));
  return out;
}

function listRoadmapWeeks(slug) {
  const safe = _safeSlug(slug);
  if (!safe) return [];
  return _listRoadmapFiles(safe);
}

function getLatestRoadmap(slug) {
  const safe = _safeSlug(slug);
  if (!safe) return { ok: false, error: 'invalid slug' };
  const list = _listRoadmapFiles(safe);
  if (!list.length) return { ok: false, error: 'no-roadmap' };
  const latest = list[0];
  let mdContent;
  try { mdContent = fs.readFileSync(latest.mdPath, 'utf8'); }
  catch (err) {
    return { ok: false, error: `read failed: ${err && err.message ? err.message : String(err)}` };
  }
  // Prefer the generated_at line from the frontmatter; fall back to the file
  // mtime if the line is missing (older hand-rolled drafts).
  let generatedAt = '';
  const m = mdContent.match(/^generated_at:\s*(.+)$/m);
  if (m) {
    generatedAt = m[1].trim();
  } else {
    try { generatedAt = fs.statSync(latest.mdPath).mtime.toISOString(); }
    catch (_) { generatedAt = ''; }
  }
  return {
    ok: true,
    mdContent,
    mdPath: latest.mdPath,
    generatedAt,
    weekAnchorDate: latest.weekAnchorDate,
  };
}

module.exports = {
  runWeeklySync,
  getLatestRoadmap,
  listRoadmapWeeks,
  // Surface internals for tests / introspection.
  _MIN_ENTRIES_TOTAL: MIN_ENTRIES_TOTAL,
  _MAX_PRIORITY: MAX_PRIORITY,
  _MAX_DEFER: MAX_DEFER,
  _MAX_CONSIDER_KILLING: MAX_CONSIDER_KILLING,
  _MD_FILE_PREFIX: MD_FILE_PREFIX,
  _MD_FILE_SUFFIX: MD_FILE_SUFFIX,
};
