'use strict';

// HYPHA · W7.1 Pack Learning Path (BLUEPRINT §12.4).
//
// Wraps a Pack's syllabus skeleton into a N-lesson study path keyed to the
// user's mastery map. Also owns the on-disk Pack Study Note — a single
// markdown file per (slug, packId) under
// `vault/<slug>/pack-study/<pack_id>.md` that the user accretes into as
// they walk through the lessons.
//
// Pure file I/O + deterministic transforms. No LLM. The real "lesson body
// generation" happens elsewhere (agent.js designLesson) — this module's
// role is to scaffold + persist the user's notes around it.

const fs = require('node:fs');
const path = require('node:path');

// ─── Path resolution ────────────────────────────────────────────────────────

function _vaultRoot() {
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) return process.env.HYPHA_DATA;
  if (process.env.HYPHA_VAULT_DIR && fs.existsSync(process.env.HYPHA_VAULT_DIR)) return process.env.HYPHA_VAULT_DIR;
  return path.join(__dirname, '..', '..', '..', 'data');
}

function _ensureSlug(slug) {
  if (!slug || typeof slug !== 'string') throw new Error('learning-path: slug required');
  if (slug.includes('..') || path.isAbsolute(slug)) {
    throw new Error('learning-path: slug must be a vault-relative directory name');
  }
}
function _ensurePackId(packId) {
  if (!packId || typeof packId !== 'string') throw new Error('learning-path: packId required');
  if (packId.includes('..') || packId.includes(path.sep) || /[<>:"|?*\0]/.test(packId)) {
    throw new Error('learning-path: packId must be a safe filename segment');
  }
}

function _studyDir(slug) {
  _ensureSlug(slug);
  return path.join(_vaultRoot(), slug, 'pack-study');
}

function _studyNotePath(slug, packId) {
  _ensurePackId(packId);
  return path.join(_studyDir(slug), `${packId}.md`);
}

// ─── 1. Build path ──────────────────────────────────────────────────────────
//
// Given a pack + the user's mastery map, fold the syllabus into N lessons.
// Heuristics (mirror operations.deepLearn but keep mastery awareness):
//   - Default N = clamp(syllabus.length, 3, 8)
//   - Weak-mastery topics (score < 0.5) bubble to the FRONT (build floor first)
//   - Strong-mastery topics (score > 0.85) compress into single recap lessons
//
// Returns a JSON-serialisable plan. Caller decides whether to persist it.

/**
 * @param {object} pack          pack.json shape from community.js
 * @param {object} [userMastery] map { topic|kpId: 0..1 }
 * @returns {{packId, topic, lessons, _meta}}
 */
function buildPackLearningPath(pack, userMastery = {}) {
  if (!pack || !pack.topic) throw new Error('buildPackLearningPath: pack.topic required');
  const syllabus = Array.isArray(pack.syllabus_skeleton) ? pack.syllabus_skeleton.slice() : [];
  const masteryOf = (label) => {
    if (!label || !userMastery) return null;
    const exact = userMastery[label];
    if (typeof exact === 'number') return exact;
    const ln = String(label).toLowerCase();
    for (const [k, v] of Object.entries(userMastery)) {
      const kn = String(k).toLowerCase();
      if (kn === ln || kn.includes(ln) || ln.includes(kn)) return Number(v) || null;
    }
    return null;
  };

  // Score each chapter by inverse-mastery so weak topics rank earlier.
  const annotated = syllabus.map((ch, i) => {
    const m = masteryOf(ch.chapter);
    return {
      idx: i,
      chapter: ch.chapter || `Chapter ${i + 1}`,
      kp_candidates: Array.isArray(ch.kp_candidates) ? ch.kp_candidates.slice() : [],
      mastery: m,
      priority: m == null ? 0.5 : (1 - m),
    };
  });
  annotated.sort((a, b) => b.priority - a.priority);

  const N = Math.min(8, Math.max(3, annotated.length || 4));
  const lessons = [];
  for (let i = 0; i < N; i++) {
    const ch = annotated[i] || { chapter: `${pack.topic} — overflow`, kp_candidates: [], mastery: null };
    const isRecap = ch.mastery != null && ch.mastery > 0.85;
    lessons.push({
      idx: i,
      title: isRecap ? `${ch.chapter}（巩固）` : ch.chapter,
      learn_goal: pack.lang === 'zh'
        ? (isRecap ? `${ch.chapter} 已基本掌握, 走一遍 recap` : `把 ${ch.chapter} 的最弱处补到能讲给同侪`)
        : (isRecap ? `Recap ${ch.chapter} — already mostly understood` : `Repair the weakest part of ${ch.chapter}`),
      kp_candidates: ch.kp_candidates.slice(0, 4),
      mastery_in: ch.mastery,
      pack_id: pack.id || null,
      kind: isRecap ? 'recap' : 'depth',
    });
  }

  return {
    packId: pack.id || null,
    topic: pack.topic,
    lessons,
    _meta: {
      generated_at: new Date().toISOString(),
      total_chapters: syllabus.length,
      total_lessons: lessons.length,
      mastery_signal: Object.keys(userMastery || {}).length > 0,
    },
  };
}

// ─── 2. Pack Study Note read / append ──────────────────────────────────────
//
// Single markdown file per (slug, packId). Append-only API — caller passes
// fully-formatted content blocks; the appender stamps the section with a
// short header so the note remains scrollable + diffable. No structured
// JSON sidecar — keep the artifact simple + user-editable.

function getPackStudyNote(packId, slug) {
  _ensurePackId(packId);
  _ensureSlug(slug);
  const p = _studyNotePath(slug, packId);
  if (!fs.existsSync(p)) return null;
  try {
    const body = fs.readFileSync(p, 'utf8');
    return { packId, slug, path: p, body };
  } catch (err) {
    return { packId, slug, path: p, body: '', error: err.message };
  }
}

/**
 * Append a content block to the study note. If the file does not yet exist,
 * it is created with a frontmatter header (pack id, slug, created_at).
 * Returns the post-append size + path.
 *
 * @param {string} packId
 * @param {string} slug
 * @param {string} content  user-authored markdown
 * @returns {{path, bytes, appended_at}}
 */
function appendPackStudyNote(packId, slug, content) {
  _ensurePackId(packId);
  _ensureSlug(slug);
  if (content == null) throw new Error('appendPackStudyNote: content required');
  const dir = _studyDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  const p = _studyNotePath(slug, packId);
  const now = new Date().toISOString();
  let out = '';
  if (!fs.existsSync(p)) {
    out += '---\n';
    out += `pack_id: ${packId}\n`;
    out += `slug: ${slug}\n`;
    out += `created_at: ${now}\n`;
    out += '---\n\n';
    out += `# ${packId} — 学习笔记\n\n`;
  }
  // Soft-separator: italic timestamp eyebrow, then the user's block.
  out += `\n_${now}_\n\n`;
  out += String(content).trimEnd() + '\n';
  fs.appendFileSync(p, out, 'utf8');
  const st = fs.statSync(p);
  return { path: p, bytes: st.size, appended_at: now };
}

/**
 * List all study notes under a slug — used by the Notebook screen sidebar.
 * Returns minimal stat info; body retrieval is on demand.
 */
function listPackStudyNotes(slug) {
  _ensureSlug(slug);
  const dir = _studyDir(slug);
  if (!fs.existsSync(dir)) return [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
    const p = path.join(dir, ent.name);
    let st = null;
    try { st = fs.statSync(p); } catch (_) {}
    out.push({
      packId: ent.name.replace(/\.md$/, ''),
      path: p,
      bytes: st ? st.size : 0,
      modified_at: st ? st.mtime.toISOString() : null,
    });
  }
  out.sort((a, b) => String(b.modified_at || '').localeCompare(String(a.modified_at || '')));
  return out;
}

module.exports = {
  buildPackLearningPath,
  getPackStudyNote,
  appendPackStudyNote,
  listPackStudyNotes,
  _vaultRoot,
  _studyDir,
  _studyNotePath,
};
