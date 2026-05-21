'use strict';

/**
 * HYPHA · W6.1 Bibliography Grounding — test scaffold.
 *
 * intentional-placeholder: this file ships as `test.todo()` placeholders that
 * lock the W6.1 contract. Real assertions land in W6.1-followup once the live
 * T4_JUDGE / T6_STRONG providers are wired through and the GroundingReviewScreen
 * gains DOM-level coverage. Filing the todos NOW locks the shape so consumers
 * (designSkeletonOnly + the renderer) don't re-discover behavior.
 *
 * Test runner: node:test (built-in since Node 18). Run once wired:
 *   node --test app/__tests__/grounding.test.js
 */

let test, _describe;
try {
  ({ test, describe: _describe } = require('node:test'));
} catch (_) {
  test = (_n, _fn) => {};
  test.todo = (_n) => {};
  _describe = (_n, fn) => (typeof fn === 'function' ? fn() : null);
}
const describe = _describe || ((_n, fn) => (typeof fn === 'function' ? fn() : null));

describe('W6.1 Book Grounding Profile · 8 fields', () => {
  test.todo('buildBookProfile returns all 8 spec fields (fit_to_goal / goal_relevance / core_sparks / unfit_content / risks_and_outdated / transferable_methodology / productizable_inspiration + book_id/title index)');
  test.todo('buildBookProfile caches to vault/<slug>/grounding/profiles/<book-id>.json with _goal_hash + version stamps');
  test.todo('buildBookProfile cache hit returns _cached:true and SKIPS T4_JUDGE call when goal hash unchanged');
  test.todo('buildBookProfile --force bypasses cache and re-invokes T4_JUDGE even when stale cache valid');
  test.todo('buildBookProfile goal-hash change (e.g. north_star_goal differs) invalidates cache automatically');
  test.todo('buildBookProfile clamps array fields to spec limits (core_sparks ≤7, others ≤5) so over-eager LLM does not bloat payload');
  test.todo('buildBookProfile LLM-bridge-missing path returns deterministic fallback profile (no crash, fields present)');
});

describe('W6.1 Grounding Synthesis · 6 fields', () => {
  test.todo('synthesizeGrounding returns all 6 spec fields (books_with_roles / complementary_pairs / conflicts / excluded_content / synthesis_notes + slug/goal index)');
  test.todo('synthesizeGrounding enforces exactly ONE primary role (auto-promotes first when zero, demotes extras when multiple)');
  test.todo('synthesizeGrounding auto-appends missing books as secondary so every input book has a row');
  test.todo('synthesizeGrounding empty bookIds returns stub synthesis (notes mention no books selected) without LLM call');
  test.todo('synthesizeGrounding caches synthesis.json with _hash = sha1(goalHash + sorted(bookIds))');
  test.todo('synthesizeGrounding bookIds set change (add/remove book) invalidates cache via _hash mismatch');
});

describe('W6.1 runGroundingForCourse · main entry', () => {
  test.todo('runGroundingForCourse builds profiles + synthesis in parallel then emits grounding:built event');
  test.todo('runGroundingForCourse writes role_distribution {primary, secondary, supplement} to events.jsonl');
  test.todo('runGroundingForCourse onProgress callback fires grounding:profiles:start/done + grounding:synthesis:start/done');
});

describe('W6.1 renderGroundingBlock · designSkeletonOnly injection', () => {
  test.todo('renderGroundingBlock emits non-empty block when books_with_roles populated, empty string when not');
  test.todo('renderGroundingBlock surfaces conflicts and excluded_content so the planner sees them in SYSTEM_PROMPT');
});

describe('W6.1 IPC surface', () => {
  test.todo('grounding:buildProfile / grounding:synthesize / grounding:runForCourse return {ok, ...} envelopes; errors return {ok:false, error}');
});
