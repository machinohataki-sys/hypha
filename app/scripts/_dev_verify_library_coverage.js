#!/usr/bin/env node
'use strict';

// HYPHA · _dev_verify_library_coverage — smoke for Phase E.0 library-coverage backend.
//
// Validates app/lib/library/coverage.js:
//   1. assessCoverage with empty vault → has_coverage=false + book_count=0
//   2. assessCoverage with goal-only (no real graph-rag data) → graceful empty
//   3. assessCoverage validates inputs (no goal / no vaultRoot)
//   4. recommendBooks input validation (no goal → error)
//   5. recommendBooks structural validation (when LLM stub returns valid JSON)
//   6. _sanitizeBookEntry caps lengths + filters bad entries
//   7. validateRecommendation accepts empty books array
//   8. validateRecommendation rejects malformed entries
//
// LLM is stubbed via Module._resolveFilename hack to avoid real network calls.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// Isolated vault
const TMP_VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'hypha-coverage-smoke-'));
process.env.HYPHA_DATA = TMP_VAULT;

// ── Stub app/lib/llm BEFORE require ────────────────────────────────────
const llmPath = path.join(__dirname, '..', 'lib', 'llm', 'index.js');
const originalResolve = Module._resolveFilename;

let _stubMode = 'valid';
let _stubCalls = [];

function _stubExecuteChat(capability, args) {
  const msgs = (args && Array.isArray(args.messages)) ? args.messages : [];
  _stubCalls.push({
    capability,
    msg: msgs[msgs.length - 1] && msgs[msgs.length - 1].content,
    sys: msgs[0] && msgs[0].content,
    user: msgs[1] && msgs[1].content,
  });
  if (_stubMode === 'valid') {
    return Promise.resolve({
      result: {
        books: [
          { title: '雪国', title_pinyin_or_romaji: 'Yukiguni', author: '川端康成', year: 1948, language: 'ja', why_canonical: '川端最具代表性的物哀文本之一', suggested_format: 'EPUB', category: 'primary' },
          { title: '古都', author: '川端康成', year: 1962, language: 'ja', why_canonical: '京都风物 + 物哀的另一极', suggested_format: 'EPUB', category: 'primary' },
          { title: 'Kawabata: The Sound of the Mountain Studies', author: 'Donald Keene', language: 'en', why_canonical: '英美学界对川端的标准研究', suggested_format: 'PDF', category: 'secondary' },
        ],
        confidence: 0.82,
        notes: '日文原版优先, 译本可用 Edward Seidensticker 英译',
      },
      providerId: 'mock', model: 'mock', capability,
    });
  }
  if (_stubMode === 'empty-uncertain') {
    return Promise.resolve({
      result: { books: [], confidence: 0.2, notes: '目标过于宽泛, 不能 confident 推荐' },
      providerId: 'mock', model: 'mock', capability,
    });
  }
  if (_stubMode === 'malformed') {
    return Promise.resolve({
      result: { books: [{ title: 'Bad' }] }, // missing author / language / why_canonical
      providerId: 'mock', model: 'mock', capability,
    });
  }
  if (_stubMode === 'over-cap') {
    // 2026-05-18 Phase G.0: MAX_BOOKS 5 → 10. Stub returns 14 to verify cap.
    return Promise.resolve({
      result: {
        books: Array.from({ length: 14 }, (_, i) => ({
          title: `Book ${i+1}`, author: 'Author ' + i, language: 'en',
          why_canonical: `reason ${i}`, suggested_format: 'PDF', category: 'primary',
        })),
        confidence: 0.7,
      },
      providerId: 'mock', model: 'mock', capability,
    });
  }
  if (_stubMode === 'fit-mode-valid') {
    // Phase F.2 — fit-over-popular mode: includes personal_fit_score + popularity_score + tradeoff_note
    return Promise.resolve({
      result: {
        books: [
          { title: '雪国', author: '川端康成', year: 1948, language: 'ja', why_canonical: '川端式静默笔法的原典', suggested_format: 'EPUB', category: 'primary', personal_fit_score: 0.95, popularity_score: 0.85, tradeoff_note: '' },
          { title: '山月记', author: '中岛敦', year: 1942, language: 'ja', why_canonical: '短篇 + 内省静默, 接近川端笔法', suggested_format: 'EPUB', category: 'primary', personal_fit_score: 0.88, popularity_score: 0.35, tradeoff_note: '冷书但精确切合短篇 + 静默' },
          { title: 'Kawabata: The Sound of the Mountain Studies', author: 'Donald Keene', language: 'en', why_canonical: '英美学界对川端静默的标准研究', suggested_format: 'PDF', category: 'secondary', personal_fit_score: 0.78, popularity_score: 0.45, tradeoff_note: '' },
        ],
        confidence: 0.85,
        notes: 'niche_factor=high 已加 1 冷书 (山月记)',
      },
      providerId: 'mock', model: 'mock', capability,
    });
  }
  return Promise.reject(new Error('stub: unknown mode ' + _stubMode));
}

Module._resolveFilename = function (request, parent, ...rest) {
  if (parent && parent.filename && parent.filename.includes('coverage.js') && request === '../llm') {
    return llmPath;
  }
  return originalResolve.call(this, request, parent, ...rest);
};

// Pre-cache fake llm module
require.cache[llmPath] = {
  id: llmPath, filename: llmPath, loaded: true,
  exports: { executeChat: _stubExecuteChat },
};

const coverage = require('../lib/library/coverage');

const tests = [];
let passed = 0, failed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; tests.push(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else      { failed++; tests.push(`  \x1b[31mFAIL\x1b[0m ${name}${extra ? '\n    ' + extra : ''}`); }
}

(async () => {

// ── Test 1: assessCoverage with empty vault ─────────────────────────────
{
  const r = await coverage.assessCoverage({
    goal: '川端康成 物哀笔法',
    archetype: 'HUMANITIES',
    vaultRoot: TMP_VAULT,
  });
  check('1. empty vault — has_coverage=false', r.has_coverage === false);
  check('1. empty vault — book_count=0', r.book_count === 0);
  check('1. empty vault — hit_count=0', r.hit_count === 0);
  check('1. empty vault — total_library_books=0', r.total_library_books === 0);
  check('1. empty vault — threshold returned', r.threshold && r.threshold.min_books === 2 && r.threshold.min_hits === 5);
}

// ── Test 2: assessCoverage graceful when no graph data ─────────────────
{
  const r = await coverage.assessCoverage({
    goal: 'TypeScript generics',
    archetype: 'TECH-CONCEPT',
    vaultRoot: TMP_VAULT,
  });
  check('2. no-graph — returns object without throwing', r && typeof r === 'object');
  check('2. no-graph — has_coverage=false', r.has_coverage === false);
  check('2. no-graph — hits is array', Array.isArray(r.hits));
}

// ── Test 3: input validation ────────────────────────────────────────────
{
  const r1 = await coverage.assessCoverage({ vaultRoot: TMP_VAULT });
  check('3. no goal — error returned', r1.error === 'goal required');
  const r2 = await coverage.assessCoverage({ goal: 'test' });
  check('3. no vaultRoot — error returned', r2.error === 'vaultRoot required');
  const r3 = await coverage.assessCoverage({ goal: '   ', vaultRoot: TMP_VAULT });
  check('3. whitespace goal — error returned', r3.error === 'goal required');
}

// ── Test 4: recommendBooks input validation ─────────────────────────────
{
  const r = await coverage.recommendBooks({ goal: '' });
  check('4. no goal — books empty', Array.isArray(r.books) && r.books.length === 0);
  check('4. no goal — confidence=0', r.confidence === 0);
  check('4. no goal — error noted', r.notes === 'goal required');
}

// ── Test 5: recommendBooks valid path ───────────────────────────────────
{
  _stubMode = 'valid';
  _stubCalls = [];
  const r = await coverage.recommendBooks({
    goal: '川端康成 物哀笔法',
    archetype: 'HUMANITIES',
  });
  check('5. valid — books length=3', r.books.length === 3, `got ${r.books.length}`);
  check('5. valid — confidence=0.82', Math.abs(r.confidence - 0.82) < 0.001);
  check('5. valid — first book is 雪国', r.books[0].title === '雪国');
  check('5. valid — first book author=川端康成', r.books[0].author === '川端康成');
  check('5. valid — first book category=primary', r.books[0].category === 'primary');
  check('5. valid — language preserved', r.books[0].language === 'ja');
  check('5. valid — capability T3_MID used', _stubCalls.length > 0 && _stubCalls[0].capability === 'T3_MID');
  check('5. valid — archetype hint in prompt', _stubCalls.length > 0 && _stubCalls[0].msg && _stubCalls[0].msg.includes('HUMANITIES'));
}

// ── Test 6: recommendBooks empty-uncertain path ─────────────────────────
{
  _stubMode = 'empty-uncertain';
  const r = await coverage.recommendBooks({ goal: '随便学点东西', archetype: 'TECH-CONCEPT' });
  check('6. uncertain — books empty', r.books.length === 0);
  check('6. uncertain — confidence=0.2', Math.abs(r.confidence - 0.2) < 0.001);
  check('6. uncertain — notes mentions vague', r.notes.includes('过于宽泛') || r.notes.includes('vague'));
}

// ── Test 7: recommendBooks malformed result ─────────────────────────────
{
  _stubMode = 'malformed';
  const r = await coverage.recommendBooks({ goal: '川端', archetype: 'HUMANITIES' });
  check('7. malformed — books empty', r.books.length === 0);
  check('7. malformed — confidence=0', r.confidence === 0);
  check('7. malformed — notes mentions validation', r.notes.includes('validation') || r.notes.includes('failed'));
}

// ── Test 8: recommendBooks over-cap result ──────────────────────────────
{
  _stubMode = 'over-cap';
  const r = await coverage.recommendBooks({ goal: 'history', archetype: 'HUMANITIES' });
  check('8. over-cap — books capped to 10 (Phase G.0)', r.books.length === 10, `got ${r.books.length}`);
}

// ── Test 9: validateRecommendation direct ──────────────────────────────
{
  const v1 = coverage.validateRecommendation({ books: [] });
  check('9. validate — empty books OK', v1.ok === true);
  const v2 = coverage.validateRecommendation({ books: [{ title: 'X' }] });
  check('9. validate — missing author rejected', v2.ok === false && v2.error.includes('author'));
  const v3 = coverage.validateRecommendation(null);
  check('9. validate — null rejected', v3.ok === false);
  const v4 = coverage.validateRecommendation({});
  check('9. validate — missing books array rejected', v4.ok === false);
}

// ── Test 10: _sanitizeBookEntry caps + filters ─────────────────────────
{
  const { _sanitizeBookEntry } = coverage._internals;
  const longTitle = 'a'.repeat(500);
  const sane = _sanitizeBookEntry({ title: longTitle, author: 'X', language: 'en', why_canonical: 'y', suggested_format: 'JUNK', category: 'unknown' });
  check('10. sanitize — title capped', sane.title.length === 200);
  check('10. sanitize — suggested_format default PDF', sane.suggested_format === 'PDF');
  check('10. sanitize — category default secondary', sane.category === 'secondary');
  check('10. sanitize — missing title returns null', _sanitizeBookEntry({ author: 'X' }) === null);
  check('10. sanitize — missing author returns null', _sanitizeBookEntry({ title: 'X' }) === null);
  // Phase F.2 — fit-mode scores preserved + clamped
  const fitSane = _sanitizeBookEntry({ title: 'X', author: 'Y', language: 'zh', why_canonical: 'z', personal_fit_score: 1.5, popularity_score: -0.2, tradeoff_note: '冷书' });
  check('10. sanitize — personal_fit_score clamped to 1', fitSane.personal_fit_score === 1);
  check('10. sanitize — popularity_score clamped to 0', fitSane.popularity_score === 0);
  check('10. sanitize — tradeoff_note preserved', fitSane.tradeoff_note === '冷书');
}

// ── Test 11: Phase F.2 fit-over-popular mode ────────────────────────────
{
  _stubMode = 'fit-mode-valid';
  _stubCalls = [];
  const r = await coverage.recommendBooks({
    goal: '川端式静默 + 短篇 + 汉语, 5 年',
    archetype: 'HUMANITIES',
    crystallizedTags: {
      primary_focus: '川端式静默笔法 + 短篇汉语小说',
      output_form: '6-8 篇短篇汉语小说',
      current_level: 'hobbyist',
      timeline: '5 年',
      niche_factor: 'high',
      scale: 'career',
    },
  });
  check('11. fit-mode — mode=fit-over-popular', r.mode === 'fit-over-popular');
  check('11. fit-mode — 3 books returned', r.books.length === 3);
  check('11. fit-mode — 山月记 cold pick included', r.books.some(b => b.title === '山月记'));
  check('11. fit-mode — 山月记 popularity < fit', r.books.find(b => b.title === '山月记').popularity_score < r.books.find(b => b.title === '山月记').personal_fit_score);
  check('11. fit-mode — 山月记 tradeoff_note non-empty', r.books.find(b => b.title === '山月记').tradeoff_note.length > 0);
  check('11. fit-mode — niche_factor in _meta', r._meta && r._meta.niche_factor === 'high');
  // Verify prompt got the tags
  check('11. fit-mode — prompt contains primary_focus', _stubCalls.length > 0 && _stubCalls[0].user && _stubCalls[0].user.includes('primary_focus'));
  check('11. fit-mode — prompt contains niche_factor=high', _stubCalls.length > 0 && _stubCalls[0].user && _stubCalls[0].user.includes('high'));
  // Verify prompt is the FIT one (not canonical)
  check('11. fit-mode — fit prompt selected', _stubCalls.length > 0 && _stubCalls[0].sys && _stubCalls[0].sys.includes('fit-mode'));
}

// ── Test 12: canonical mode backward-compat (no crystallizedTags) ──────
{
  _stubMode = 'valid';
  _stubCalls = [];
  const r = await coverage.recommendBooks({ goal: '川端康成', archetype: 'HUMANITIES' });
  check('12. canonical — mode=canonical', r.mode === 'canonical');
  check('12. canonical — original prompt used', _stubCalls.length > 0 && _stubCalls[0].sys && !_stubCalls[0].sys.includes('fit-mode'));
}

// ── Report ─────────────────────────────────────────────────────────────
console.log('\n=== HYPHA · Library Coverage smoke ===\n');
for (const line of tests) console.log(line);
console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed}/${passed + failed} PASS\x1b[0m\n`);

try { fs.rmSync(TMP_VAULT, { recursive: true, force: true }); } catch (_) {}
process.exit(failed === 0 ? 0 : 1);

})();
