#!/usr/bin/env node
'use strict';

// HYPHA · _dev_verify_tutor_identity — smoke for Phase D.1 identity primitive.
//
// Validates:
//   1. loadIdentity returns defaults when file missing
//   2. saveIdentity persists + stamps updated_at
//   3. appendPrior is immutable + caps text length
//   4. appendCallback persists callbacks_to_lesson array
//   5. appendRelationshipToken persists event
//   6. callback-inject extractRecentUserProductions reads events.jsonl + identity
//   7. buildCallbackBlockForLesson returns string with user-original text
//   8. lesson 0 → empty callback block (no prior)
//   9. > 3 lessons back → only lookback window pulled
//  10. Productions sorted newest-first
//
// Uses HYPHA_VAULT_DIR pointing to a temp dir so smoke isolated.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated vault — vault.js uses HYPHA_DATA env var (! HYPHA_VAULT_DIR)
const TMP_VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'hypha-identity-smoke-'));
process.env.HYPHA_DATA = TMP_VAULT;

const ti = require('../lib/identity/tutor-identity');
const ci = require('../lib/identity/callback-inject');
const vault = require('../lib/vault');

// Unique slug per run so even if vault root override fails, no cross-run pollution
const SLUG = `test-chain-mono-no-aware-${Date.now()}-${process.pid}`;

const tests = [];
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; tests.push(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else      { failed++; tests.push(`  \x1b[31mFAIL\x1b[0m ${name}${extra ? '\n    ' + extra : ''}`); }
}

// ── Test 1: defaults when missing ──────────────────────────────────────
{
  const id = ti.loadIdentity(SLUG);
  check('1. defaults — schema_version=1', id.schema_version === 1);
  check('1. defaults — voice_register=italic-garamond-warm', id.voice_register === 'italic-garamond-warm');
  check('1. defaults — voice_name=Victor', id.voice_name === 'Victor');
  check('1. defaults — empty established_priors[]', Array.isArray(id.established_priors) && id.established_priors.length === 0);
  check('1. defaults — empty callback_log[]', Array.isArray(id.callback_log) && id.callback_log.length === 0);
}

// ── Test 2: saveIdentity persists + stamps updated_at ──────────────────
{
  const before = new Date().toISOString();
  const saved = ti.saveIdentity(SLUG, { voice_name: 'TestVoice', extra: 'should-passthrough' });
  check('2. save — voice_name persisted', saved.voice_name === 'TestVoice');
  check('2. save — schema_version pinned to current', saved.schema_version === 1);
  check('2. save — updated_at >= before', saved.updated_at >= before);
  // re-load to verify file write
  const reloaded = ti.loadIdentity(SLUG);
  check('2. save — reload returns persisted voice_name', reloaded.voice_name === 'TestVoice');
}

// ── Test 3: appendPrior immutable + caps text ──────────────────────────
{
  const longText = 'a'.repeat(2000);
  const after = ti.appendPrior(SLUG, { lesson_idx: 1, user_produced_text: longText, concept_anchored: 'pre-question' });
  check('3. appendPrior — established_priors length 1', after.established_priors.length === 1);
  check('3. appendPrior — text capped to 800 chars', after.established_priors[0].user_produced_text.length === 800);
  check('3. appendPrior — concept_anchored persisted', after.established_priors[0].concept_anchored === 'pre-question');
  // immutability: returning new object, not mutating prior
  ti.appendPrior(SLUG, { lesson_idx: 2, user_produced_text: 'second user text 长长长长长长' });
  const reloaded = ti.loadIdentity(SLUG);
  check('3. appendPrior — second append accumulates', reloaded.established_priors.length === 2);
  check('3. appendPrior — empty text throws', (() => {
    try { ti.appendPrior(SLUG, { lesson_idx: 3, user_produced_text: '   ' }); return false; }
    catch (_) { return true; }
  })());
}

// ── Test 4: appendCallback persists callbacks_to_lesson ────────────────
{
  const r = ti.appendCallback(SLUG, { lesson_idx: 3, callbacks_to_lesson: [1, 2], callback_text: 'lesson-3 callback' });
  check('4. appendCallback — callback_log length 1', r.callback_log.length === 1);
  check('4. appendCallback — callbacks_to_lesson array', Array.isArray(r.callback_log[0].callbacks_to_lesson) && r.callback_log[0].callbacks_to_lesson.length === 2);
  check('4. appendCallback — filters non-finite', (() => {
    const r2 = ti.appendCallback(SLUG, { lesson_idx: 4, callbacks_to_lesson: [1, 'x', NaN, 2] });
    return r2.callback_log[r2.callback_log.length - 1].callbacks_to_lesson.length === 2;
  })());
}

// ── Test 5: appendRelationshipToken ────────────────────────────────────
{
  const r = ti.appendRelationshipToken(SLUG, { event: 'user_corrected_metaphor', lesson_idx: 2, text: 'user said the metaphor was wrong' });
  check('5. appendRelationshipToken — persists event', r.relationship_tokens[0].event === 'user_corrected_metaphor');
  check('5. appendRelationshipToken — empty event throws', (() => {
    try { ti.appendRelationshipToken(SLUG, { event: '   ' }); return false; }
    catch (_) { return true; }
  })());
}

// ── Test 6: events.jsonl + sessions/*.jsonl readers pick up productions ─
{
  // Write fake events.jsonl (secondary source)
  vault.appendJSONL(`${SLUG}/events.jsonl`, { type: 'user_message', lesson_idx: 1, content: '冬夜火车开过山区隧道, 车窗外白成一片.' });
  vault.appendJSONL(`${SLUG}/events.jsonl`, { type: 'lesson_user_turn', lesson_idx: 2, user_text: '我看了 川端 开篇, 物哀好像是物理事实自己承担情绪.' });
  vault.appendJSONL(`${SLUG}/events.jsonl`, { type: 'user_artifact_submitted', lesson_idx: 3, text: '我重写: 夜深, 隧道尽头, 雪白成一片.' });
  vault.appendJSONL(`${SLUG}/events.jsonl`, { type: 'user_message', lesson_idx: 0, content: 'ok' }); // too short, filtered
  vault.appendJSONL(`${SLUG}/events.jsonl`, { type: 'system_log', lesson_idx: 2, message: 'not a user production' }); // wrong type

  // Write fake session JSONL (PRIMARY source — HYPHA's actual transcript persistence)
  vault.appendJSONL(`${SLUG}/sessions/L01-2026-05-18T01-00-00-000Z.jsonl`, { role: 'meta', idx: 1, mode: 'learn', startISO: '2026-05-18T01:00:00.000Z' });
  vault.appendJSONL(`${SLUG}/sessions/L01-2026-05-18T01-00-00-000Z.jsonl`, { role: 'tutor', idx: 1, text: '川端 物哀 开篇.' });
  vault.appendJSONL(`${SLUG}/sessions/L01-2026-05-18T01-00-00-000Z.jsonl`, { role: 'user', idx: 1, text: '从 session 文件来的 user 文本 lesson 1.' });
  vault.appendJSONL(`${SLUG}/sessions/L02-2026-05-18T02-00-00-000Z.jsonl`, { role: 'user', idx: 2, text: '从 session 文件来的 user 文本 lesson 2.' });

  const { productions, sources } = ci.extractRecentUserProductions({ chainSlug: SLUG, lessonIdx: 4, lookback: 3 });
  check('6. extract — productions ≥ 3', productions.length >= 3, `got ${productions.length}`);
  check('6. extract — events_count > 0', sources.events_count > 0);
  check('6. extract — sessions_count > 0 (primary source live)', sources.sessions_count > 0, `sessions=${sources.sessions_count}`);
  check('6. extract — filtered short ok text', !productions.some(p => p.text.trim() === 'ok'));
  check('6. extract — filtered system_log', !productions.some(p => p.text.includes('not a user production')));
  check('6. extract — session-source production present', productions.some(p => p.source === 'session'), `sources=${productions.map(p => p.source).join(',')}`);
}

// ── Test 7: buildCallbackBlockForLesson formats well ───────────────────
{
  const block = ci.buildCallbackBlockForLesson({ chainSlug: SLUG, lessonIdx: 4 });
  check('7. block — non-empty string', typeof block === 'string' && block.length > 50);
  check('7. block — includes 上节回声 header', block.includes('上节回声'));
  check('7. block — includes user original text', block.includes('冬夜') || block.includes('川端') || block.includes('夜深'));
  check('7. block — includes voice name', block.includes('Victor') || block.includes('TestVoice'));
  check('7. block — includes 要求', block.includes('要求'));
}

// ── Test 8: lesson 0 → empty block (no prior to callback) ──────────────
{
  const block = ci.buildCallbackBlockForLesson({ chainSlug: SLUG, lessonIdx: 0 });
  check('8. lesson 0 — empty block', block === '');
  const archBlock = ci.buildCallbackBlockForArchitect({ chainSlug: SLUG, lessonIdx: 0 });
  check('8. lesson 0 — architect empty block', archBlock === '');
}

// ── Test 9: lookback window respected ──────────────────────────────────
{
  // lessonIdx=4, lookback=2 → should only pull lessons 2, 3 (not lesson 1)
  const { productions } = ci.extractRecentUserProductions({ chainSlug: SLUG, lessonIdx: 4, lookback: 2 });
  const lessonsSeen = new Set(productions.map(p => p.lesson_idx));
  check('9. lookback — does not include lesson 1', !lessonsSeen.has(1), `seen=${Array.from(lessonsSeen).join(',')}`);
  check('9. lookback — includes lessons in window', lessonsSeen.has(2) || lessonsSeen.has(3));
}

// ── Test 10: productions sorted newest-first ───────────────────────────
{
  const { productions } = ci.extractRecentUserProductions({ chainSlug: SLUG, lessonIdx: 5, lookback: 5 });
  let sortedDesc = true;
  for (let i = 1; i < productions.length; i++) {
    if (productions[i].lesson_idx > productions[i - 1].lesson_idx) { sortedDesc = false; break; }
  }
  check('10. sort — productions descending by lesson_idx', sortedDesc, `idxs=${productions.map(p => p.lesson_idx).join(',')}`);
}

// ── Test 11: architect formatter — non-empty + schema-field guidance ───
{
  const archBlock = ci.buildCallbackBlockForArchitect({ chainSlug: SLUG, lessonIdx: 4, lookback: 3 });
  check('11. architect — non-empty', typeof archBlock === 'string' && archBlock.length > 100);
  check('11. architect — includes PRIOR USER PRODUCTIONS header', archBlock.includes('PRIOR USER PRODUCTIONS'));
  check('11. architect — includes note_connection guidance', archBlock.includes('note_connection'));
  check('11. architect — includes canonical_example guidance', archBlock.includes('canonical_example'));
  check('11. architect — includes quote constraint', archBlock.includes('≥ 5'));
  check('11. architect — includes user original text from events.jsonl',
    archBlock.includes('冬夜') || archBlock.includes('川端') || archBlock.includes('夜深'));
  check('11. architect — bans generic boilerplate', archBlock.includes('! generic') || archBlock.includes('! 延续上节'));
}

// ── Test 12: architect vs teacher format differs ───────────────────────
{
  const teacher = ci.buildCallbackBlockForLesson({ chainSlug: SLUG, lessonIdx: 4 });
  const architect = ci.buildCallbackBlockForArchitect({ chainSlug: SLUG, lessonIdx: 4 });
  check('12. format differ — both non-empty', teacher.length > 0 && architect.length > 0);
  check('12. format differ — teacher has 上节回声 header, architect does not',
    teacher.includes('上节回声') && !architect.includes('上节回声'));
  check('12. format differ — architect has schema-field guidance, teacher does not',
    architect.includes('note_connection') && !teacher.includes('note_connection'));
}

// ── Report ─────────────────────────────────────────────────────────────
console.log('\n=== HYPHA · Tutor Identity + Callback Inject smoke ===\n');
for (const line of tests) console.log(line);
console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed}/${passed + failed} PASS\x1b[0m\n`);

// cleanup tmp vault + any real-data-dir pollution if HYPHA_DATA didn't take effect
try { fs.rmSync(TMP_VAULT, { recursive: true, force: true }); } catch (_) {}
try {
  const realDataDir = require('path').resolve(__dirname, '..', '..', 'data', SLUG);
  if (fs.existsSync(realDataDir)) fs.rmSync(realDataDir, { recursive: true, force: true });
} catch (_) { /* best-effort */ }

process.exit(failed === 0 ? 0 : 1);
