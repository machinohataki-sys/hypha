#!/usr/bin/env node
'use strict';
// HYPHA · _dev_verify_critique_loop — smoke for the critique-loop bundle.
//
// Coverage:
//   M1-M8   MSIFR validators (syntax / namespace / silent_catch / scope_creep
//           + composer short-circuit)
//   C1-C5   critiqueLessonDraft mocked LLM (high-score ship, low-score revise,
//           MSIFR pre-gate, critic failure fail-open, trace shape)
//   T1-T3   quality-trace.jsonl write + JSON line shape
//   F1-F2   experimental flag default-off (env + config)
//
// Run:
//   node app/scripts/_dev_verify_critique_loop.js
// Exit 0 = PASS N/N. Exit 1 on any FAIL.

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const tests = [];
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; tests.push(`  [PASS] ${name}`); }
  else      { failed++; tests.push(`  [FAIL] ${name}${extra ? '\n    ' + extra : ''}`); }
}

// ── Sandbox vault root so we never touch real vault data ──────────────
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hypha-critique-loop-'));
function _cleanup() {
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
}
process.on('exit', _cleanup);

// ── Load modules ──────────────────────────────────────────────────────
const msifr     = require('../lib/lesson-critique-msifr');
const critique  = require('../lib/lesson-critique');

(async () => {

// ═════════════════ MSIFR · 8 cases ═════════════════════════════════════

// M1. validateSyntax — empty string
{
  const r = msifr.validateSyntax('');
  check('M1. validateSyntax rejects empty string',
    r.ok === false && r.failed_at === 'syntax', JSON.stringify(r));
}

// M2. validateSyntax — unbalanced fences
{
  const r = msifr.validateSyntax('intro\n```js\ncode no close fence\n');
  check('M2. validateSyntax rejects unbalanced code fences',
    r.ok === false && /fence/.test(r.reason), JSON.stringify(r));
}

// M3. validateSyntax — well-formed object passes
{
  const r = msifr.validateSyntax({ thesis: 'x', exit_proof: 'y' });
  check('M3. validateSyntax accepts well-formed object',
    r.ok === true && r.failed_at === null, JSON.stringify(r));
}

// M4. validateNamespace — orphan footnote ref
{
  const r = msifr.validateNamespace('See [^3] for details. No definition follows.');
  check('M4. validateNamespace rejects orphan [^3]',
    r.ok === false && r.failed_at === 'namespace', JSON.stringify(r));
}

// M4b. validateNamespace — defined footnote passes
{
  const r = msifr.validateNamespace('See [^3] for details.\n\n[^3]: This is the definition.');
  check('M4b. validateNamespace accepts defined [^3]',
    r.ok === true, JSON.stringify(r));
}

// M5. validateSilentCatch — TODO marker rejected
// intentional-placeholder: the literal "TODO" tokens in this test block are
// DETECTOR INPUT FIXTURES exercising the MSIFR silent-catch validator
// signature; they are not deferred work. Same justification as the regex
// patterns in lesson-critique-msifr.js.
{
  const r = msifr.validateSilentCatch('## Mechanism\n\n# TODO: fill in the details later');
  check('M5. validateSilentCatch rejects "# TODO:" marker',
    r.ok === false && r.failed_at === 'silent_catch', JSON.stringify(r));
}

// M5b. validateSilentCatch — clean prose passes
{
  const r = msifr.validateSilentCatch('## Mechanism\n\nThe seed germinates under specific conditions of moisture and temperature.');
  check('M5b. validateSilentCatch accepts clean prose',
    r.ok === true, JSON.stringify(r));
}

// M6. validateScopeCreep — body misses scope_in tokens
{
  const r = msifr.validateScopeCreep(
    'This lesson covers cooking recipes and grocery shopping tips.',
    { scope_in: 'single-head self-attention matrix operations', scope_out: 'multi-head positional encoding' }
  );
  check('M6. validateScopeCreep rejects body missing scope_in anchors',
    r.ok === false && r.failed_at === 'scope_creep', JSON.stringify(r));
}

// M7. validateScopeCreep — body leaks scope_out phrase
{
  const r = msifr.validateScopeCreep(
    'attention is computed via the standard QKV dot-product, with additional multi-head positional encoding logic.',
    { scope_in: 'attention basics', scope_out: 'multi-head positional encoding' }
  );
  check('M7. validateScopeCreep rejects scope_out phrase leak',
    r.ok === false && /scope_out/.test(r.reason), JSON.stringify(r));
}

// M8. composeMsifr — short-circuits on first failure
// intentional-placeholder: "TODO" below is a DETECTOR INPUT FIXTURE, not
// abandoned work.
{
  const r = msifr.composeMsifr('# TODO finish later\n\nleaks multi-head logic',
    { scope_in: 'attention', scope_out: 'multi-head' });
  // Order is syntax → namespace → silent_catch → scope_creep. TODO trips
  // silent_catch first; scope_creep never runs.
  check('M8. composeMsifr short-circuits at first failure (silent_catch wins over scope_creep)',
    r.ok === false && r.failed_at === 'silent_catch', JSON.stringify(r));
}

// ═════════════════ Critique invocation · 5 cases ═══════════════════════

function _mockLLM(scoreOrVerdict, criticism, extraCriticism) {
  const calls = [];
  return {
    calls,
    executeChat: async (cap, args) => {
      calls.push({ cap, prompt: args && args.messages && args.messages[0] && args.messages[0].content });
      let payload;
      if (typeof scoreOrVerdict === 'number') {
        payload = { score: scoreOrVerdict, criticism: criticism || [], verdict: scoreOrVerdict >= 0.7 ? 'ship' : 'revise' };
      } else if (scoreOrVerdict === 'invalid') {
        return { result: 'this is not JSON at all, just prose', providerId: 'mock', model: 'mock-v1' };
      } else if (scoreOrVerdict === 'throw') {
        throw new Error('simulated provider 500');
      } else {
        payload = scoreOrVerdict;
      }
      return { result: JSON.stringify(payload), providerId: 'mock', model: 'mock-v1' };
    },
  };
}

const goodDraft = {
  thesis: 'Self-attention computes a weighted sum of value vectors, where weights come from query-key dot products normalized by softmax.',
  canonical_example: 'Given 3 tokens (the cat sat), each token becomes a query vector q_i, key vector k_i, value vector v_i. Output for position i is sum over j of softmax(q_i·k_j) * v_j.',
  exit_proof: 'Learner hand-computes attention output for a 3-token input with given Q/K/V matrices.',
};

const samplePlan = {
  lessonTitle: 'Attention · QKV weighted sum',
  learnGoal: 'Hand-compute self-attention output for a 3-token sequence',
  scope_in: 'single-head self-attention matrix operations',
  scope_out: 'multi-head positional encoding',
  success_test: 'Given Q/K/V matrices, learner produces correct attention output.',
  failure_test: 'Learner only recites the formula without computing a worked example.',
  archetype: 'TECH-CONCEPT',
  lesson_id: 0,
};

// C1. High score → ship, must_revise=false
{
  const mock = _mockLLM(0.85, ['minor: could add more on softmax intuition']);
  const r = await critique.critiqueLessonDraft({
    draft: goodDraft,
    plan: samplePlan,
    modelDraft: 'mock-generator-v1',
    config: { llm: mock, vaultRoot: sandbox },
  });
  check('C1. critic high score (0.85) → must_revise=false, revised_draft=draft',
    r.score === 0.85 && r.must_revise === false && r.revised_draft === goodDraft,
    JSON.stringify({ score: r.score, must_revise: r.must_revise, has_draft: !!r.revised_draft }));
  check('C1b. critic called exactly once with T4_JUDGE',
    mock.calls.length === 1 && mock.calls[0].cap === 'T4_JUDGE',
    JSON.stringify({ count: mock.calls.length, cap: mock.calls[0] && mock.calls[0].cap }));
}

// C2. Low score → must_revise=true, revised_draft=null
{
  const mock = _mockLLM(0.42, ['draft only restates the formula', 'no worked example provided', 'misses success_test entirely']);
  const r = await critique.critiqueLessonDraft({
    draft: goodDraft,
    plan: samplePlan,
    config: { llm: mock, vaultRoot: sandbox },
  });
  check('C2. critic low score (0.42) → must_revise=true, revised_draft=null',
    r.score === 0.42 && r.must_revise === true && r.revised_draft === null,
    JSON.stringify({ score: r.score, must_revise: r.must_revise }));
  check('C2b. low score returns ≥1 criticism',
    Array.isArray(r.criticism) && r.criticism.length >= 1,
    JSON.stringify({ criticism: r.criticism }));
}

// C3. MSIFR pre-gate fires BEFORE critic (no LLM call)
// intentional-placeholder: "TODO" below is DETECTOR INPUT for the MSIFR
// silent-catch validator; not abandoned work.
{
  const mock = _mockLLM(0.99, []);
  const badDraft = { thesis: '# TODO: write thesis later', exit_proof: 'x' };
  const r = await critique.critiqueLessonDraft({
    draft: badDraft,
    plan: samplePlan,
    config: { llm: mock, vaultRoot: sandbox },
  });
  check('C3. MSIFR pre-gate → must_revise=true, score=0, no LLM call',
    r.must_revise === true && r.score === 0 && mock.calls.length === 0,
    JSON.stringify({ score: r.score, must_revise: r.must_revise, llm_calls: mock.calls.length }));
  check('C3b. MSIFR criticism names the failed validator',
    Array.isArray(r.criticism) && r.criticism[0] && /MSIFR/.test(r.criticism[0]) && /silent_catch/.test(r.criticism[0]),
    JSON.stringify(r.criticism));
}

// C4. Critic provider failure → fail-open (must_revise=false, draft preserved)
{
  const mock = _mockLLM('throw');
  const r = await critique.critiqueLessonDraft({
    draft: goodDraft,
    plan: samplePlan,
    config: { llm: mock, vaultRoot: sandbox },
  });
  check('C4. critic throw → fail-open (must_revise=false, draft preserved)',
    r.must_revise === false && r.revised_draft === goodDraft && r.score === null,
    JSON.stringify({ score: r.score, must_revise: r.must_revise, has_draft: !!r.revised_draft }));
}

// C5. Critic returns unparseable → fail-open same path
{
  const mock = _mockLLM('invalid');
  const r = await critique.critiqueLessonDraft({
    draft: goodDraft,
    plan: samplePlan,
    config: { llm: mock, vaultRoot: sandbox },
  });
  check('C5. critic unparseable JSON → fail-open',
    r.must_revise === false && r.score === null,
    JSON.stringify({ score: r.score, must_revise: r.must_revise }));
}

// ═════════════════ A/B trace · 3 cases ════════════════════════════════

// T1. trace file exists + parseable jsonl
{
  const traceFile = path.join(sandbox, '.hypha', 'quality-trace.jsonl');
  check('T1. quality-trace.jsonl was created in sandbox vault',
    fs.existsSync(traceFile), traceFile);

  const content = fs.readFileSync(traceFile, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  check('T1b. ≥5 trace lines written (C1-C5 each emit one)',
    lines.length >= 5, `got ${lines.length} lines`);

  let parsedOk = true;
  let firstParsed = null;
  for (const ln of lines) {
    try { const p = JSON.parse(ln); if (!firstParsed) firstParsed = p; }
    catch (_) { parsedOk = false; break; }
  }
  check('T2. every trace line is valid JSON',
    parsedOk, parsedOk ? `parsed ${lines.length}` : 'parse error');

  // T3. shape contains required keys
  const required = ['ts', 'lesson_id', 'generator', 'critic', 'score_pre', 'score_post', 'divergence'];
  const missingKeys = required.filter(k => !(k in firstParsed));
  check('T3. trace line carries required keys (ts, lesson_id, generator, critic, score_pre, score_post, divergence)',
    missingKeys.length === 0,
    `missing=${missingKeys.join(',')}; sample=${JSON.stringify(firstParsed).slice(0, 200)}`);
}

// ═════════════════ Experimental flag · 2 cases (integration) ══════════

// F1. Flag default-OFF: lesson-body-generator does not import lesson-critique
//     at module load time (lazy require inside the conditional). We verify by
//     inspecting the source — cheaper than running a full generateLessonBodyV2.
{
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'lesson-body-generator.js'), 'utf8');
  // Sanity: critique module is referenced...
  check('F1a. lesson-body-generator references lesson-critique (integration wired)',
    /require\(['"]\.\/lesson-critique['"]\)/.test(src), 'no require found');
  // ...AND that reference is inside an "if (critiqueOn)" branch, not top-level.
  const requireIdx = src.indexOf(`require('./lesson-critique')`);
  const gateIdx = src.lastIndexOf('if (critiqueOn)', requireIdx);
  check('F1b. require(\'./lesson-critique\') is gated behind if (critiqueOn) block (default-off)',
    gateIdx >= 0 && gateIdx < requireIdx && (requireIdx - gateIdx) < 600,
    `requireIdx=${requireIdx}, gateIdx=${gateIdx}`);
}

// F2. Flag-off path emits trace with critique_enabled=false (zero LLM call).
//     We verify by inspecting the generator source for the marker emission.
{
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'lesson-body-generator.js'), 'utf8');
  check('F2. flag-off path emits critique_enabled:false trace line',
    /critique_enabled:\s*false/.test(src),
    'no critique_enabled:false marker found in generator');
}

// ── Report ───────────────────────────────────────────────────────────
console.log('\n=== HYPHA · Lesson Critique-Loop smoke ===\n');
for (const line of tests) console.log(line);
console.log(`\n${passed}/${passed + failed} PASS\n`);

// Dump 1 synthetic trace line so the parent agent can read it back.
try {
  const traceFile = path.join(sandbox, '.hypha', 'quality-trace.jsonl');
  if (fs.existsSync(traceFile)) {
    const content = fs.readFileSync(traceFile, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length > 0) {
      console.log('--- A/B trace sample (first line) ---');
      console.log(lines[0]);
      console.log('--- end sample ---\n');
    }
  }
} catch (_) {}

process.exit(failed === 0 ? 0 : 1);

})().catch(err => {
  console.error('FATAL:', err && err.stack || err);
  process.exit(1);
});
