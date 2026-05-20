'use strict';

// HYPHA · Wave 6.1 Bibliography Grounding · main entry
//
// One-call orchestrator that runs the full grounding flow for a course:
//   1. Build a Book Grounding Profile per selected book (parallel, cached).
//   2. Build the Grounding Synthesis across all books (cached).
//   3. Stamp an events.jsonl row so the rest of the system sees grounding ran.
//   4. Return { profiles[], synthesis } so caller can inject into SYSTEM_PROMPT.
//
// Per BLUEPRINT §4 + plan task §3, this is the single integration point that
// downstream `agent.designSkeletonOnly` and the IPC layer call before any
// curriculum body lands.

const fs = require('node:fs');
const path = require('node:path');

const { buildBookProfile, refreshAllProfiles, getCachedProfile } = require('./book-profile');
const { synthesizeGrounding, getSynthesis } = require('./synthesis');

function _appendEvent(vaultRoot, evt) {
  try {
    const dir = path.join(vaultRoot);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const eventsPath = path.join(vaultRoot, 'events.jsonl');
    const row = JSON.stringify({ ts: new Date().toISOString(), ...evt }) + '\n';
    fs.appendFileSync(eventsPath, row, 'utf-8');
  } catch (_) {
    // Telemetry is non-fatal. Never break the pipeline on a log write.
  }
}

/**
 * Run the full grounding pipeline for one course.
 *
 * @param {string} slug
 * @param {object|null} goalContract
 * @param {string[]} bookIds
 * @param {object} opts — { vaultRoot, force, onProgress }
 * @returns {Promise<{ profiles: object[], synthesis: object, role_distribution: object }>}
 */
async function runGroundingForCourse(slug, goalContract, bookIds, opts = {}) {
  const vaultRoot = opts.vaultRoot;
  const force = !!opts.force;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  if (!vaultRoot) throw new Error('runGroundingForCourse: opts.vaultRoot required');
  if (!slug) throw new Error('runGroundingForCourse: slug required');

  const ids = Array.isArray(bookIds) ? bookIds.filter(Boolean) : [];

  onProgress('grounding:profiles:start', { book_count: ids.length });
  const profiles = await refreshAllProfiles(slug, goalContract, ids, { vaultRoot, force });
  onProgress('grounding:profiles:done', { profile_count: profiles.length });

  onProgress('grounding:synthesis:start', {});
  const synthesis = await synthesizeGrounding(slug, goalContract, ids, { vaultRoot, force });
  onProgress('grounding:synthesis:done', {});

  // Role distribution rollup for the events.jsonl event.
  const roleDist = { primary: 0, secondary: 0, supplement: 0 };
  for (const r of (synthesis.books_with_roles || [])) {
    if (roleDist[r.role] != null) roleDist[r.role] += 1;
  }

  _appendEvent(vaultRoot, {
    type: 'grounding:built',
    slug,
    book_count: ids.length,
    role_distribution: roleDist,
    synthesis_cached: !!synthesis._cached,
  });

  return { profiles, synthesis, role_distribution: roleDist };
}

/**
 * Render the grounding synthesis as a compact text block suitable for
 * injection into agent.designSkeletonOnly's SYSTEM_PROMPT. The block sits
 * BEFORE the LIBRARY_EVIDENCE block (R-LIB Day 4) so the skeleton planner
 * sees high-level book roles before chunk-level evidence.
 *
 * @param {object} synthesis
 * @param {object[]} profiles
 * @returns {string}
 */
function renderGroundingBlock(synthesis, profiles) {
  if (!synthesis || !Array.isArray(synthesis.books_with_roles) || synthesis.books_with_roles.length === 0) {
    return '';
  }
  const byId = {};
  for (const p of (profiles || [])) byId[p.book_id] = p;

  const rolesLine = synthesis.books_with_roles.map(r => {
    const title = (byId[r.book_id] && byId[r.book_id].title) || r.book_id;
    return `  - [${r.role}] ${title} — ${r.responsibility}`;
  }).join('\n');

  const conflicts = (synthesis.conflicts || []).slice(0, 3).map(c =>
    `  - ${c.book_a} vs ${c.book_b} on "${c.conflict_topic}" — adopt: ${c.resolution}`
  ).join('\n');

  const excluded = (synthesis.excluded_content || []).slice(0, 5).map(e =>
    `  - ${e.book_id}: ${e.topic}`
  ).join('\n');

  return [
    'GROUNDING PROFILE (bibliography geology — respect role assignments):',
    rolesLine,
    conflicts ? `Conflicts resolved:\n${conflicts}` : '',
    excluded ? `Excluded (do NOT teach):\n${excluded}` : '',
    `Synthesis notes: ${synthesis.synthesis_notes || ''}`,
  ].filter(Boolean).join('\n');
}

module.exports = {
  runGroundingForCourse,
  renderGroundingBlock,
  // Re-export sub-module entry points so main.js IPC handlers can be terse.
  buildBookProfile,
  getCachedProfile,
  refreshAllProfiles,
  synthesizeGrounding,
  getSynthesis,
};
