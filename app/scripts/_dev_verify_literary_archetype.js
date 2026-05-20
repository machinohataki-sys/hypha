#!/usr/bin/env node
'use strict';

// HYPHA · _dev_verify_literary_archetype — smoke for System 5 Phase 4+6
// literary archetype specialization (2026-05-20).
//
// Validates the additive literary branch across:
//   1. app/lib/distillation/book-router.js  — detectBookArchetype()
//      • Fiction-like fixture → 'literary' with confidence > 0
//      • Technical-like fixture → not 'literary'
//      • Mixed / too-short fixture → 'unknown'
//   2. app/lib/distillation/phases.js       — phase 4 + 6 literary builders
//      • Mock returns spark_literary[] when archetype='literary'
//      • Mock returns spark_ai_era[] when archetype omitted (regression)
//      • phase4_frontierize threads archetype through invokeLLM
//      • phase6_personalize inherits archetype from phase4 output
//   3. app/lib/grounding/book-profile.js    — archetype stamp + literary rules
//      • profile.archetype field present when opts.archetype passed
//      • Prompt body contains LITERARY MODE block when archetype='literary'
//      • Default prompt unchanged when archetype omitted
//   4. Negative regression: technical-style text does NOT trip the literary
//      heuristic even when it quotes inline strings.
//
// LLM is stubbed via HYPHA_DISTILL_MOCK=1 (no Module hack needed for phases).
// For book-profile, llm.executeChat is stubbed via Module._resolveFilename.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

process.env.HYPHA_DISTILL_MOCK = '1';

const TMP_VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'hypha-literary-smoke-'));

// ── Stub app/lib/llm for grounding/book-profile ───────────────────────────
const llmPath = path.join(__dirname, '..', 'lib', 'llm', 'index.js');
const llmDirPath = path.join(__dirname, '..', 'lib', 'llm');
const originalResolve = Module._resolveFilename;

let _stubLastPrompt = '';
let _stubArchetypeSeen = false;

Module._resolveFilename = function (request, parent, ...rest) {
  if (parent && parent.filename && parent.filename.endsWith('book-profile.js')
      && (request === '../llm' || request.endsWith('lib/llm') || request.endsWith('lib\\llm'))) {
    const stubPath = path.join(__dirname, '_literary_archetype_llm_stub.js');
    fs.writeFileSync(stubPath, `
'use strict';
module.exports = {
  executeChat: async (cap, args) => {
    const msgs = (args && Array.isArray(args.messages)) ? args.messages : [];
    const text = msgs.map(m => m.content || '').join('\\n');
    if (text.includes('LITERARY MODE')) global._STUB_LITERARY_FLAG = true;
    global._STUB_LAST_PROMPT = text;
    return {
      result: {
        fit_to_goal: 'Reading this book trains an ear for psychological self-deception.',
        goal_relevance: 'The reader builds capacity to sit with morally ambiguous characters.',
        core_sparks: ['瘙痒 motif as embodied self-loathing', '地下室作为意识空间'],
        unfit_content: [],
        risks_and_outdated: ['period misogyny in voice'],
        transferable_methodology: ['fragmented chronology', 'first-person reliability erosion'],
        productizable_inspiration: ['一年后重读第 6 章', '与一位读者通信讨论 confession'],
      },
      providerId: 'mock', model: 'mock', capability: cap,
    };
  },
};
`, 'utf-8');
    return stubPath;
  }
  return originalResolve.call(this, request, parent, ...rest);
};

// ── Test harness ──────────────────────────────────────────────────────────
const tests = [];
let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; tests.push(`  \x1b[32m✓\x1b[0m ${name}`); }
  else      { failed++; tests.push(`  \x1b[31m✗\x1b[0m ${name}`); }
}

// ── Fixtures ──────────────────────────────────────────────────────────────
// 1. Fiction fixture: Dostoyevsky-style chapter w/ heavy dialogue + past tense.
const FICTION_TEXT = `
他望着房梁, 心里想着前一晚的羞辱. "你真是个混蛋," 她说过, "你以为你在受难, 其实只是怕被人看见."
他笑了一下. 笑里有恨, 也有一种廉价的得意. 三十年来他都活在这种笑里.
"你来这里做什么?" 他问. 她没有回答. 她只是看着窗外那条街, 那条他每天都要走过的街.
他想起母亲也曾用同样的姿势看过同一条街. 那时他才十二岁. 母亲走了一个月之后, 父亲也走了.
窗外的雪还在下. 他咳了一声, 试图把这一刻的难堪咳出去. 没用. 难堪比血更黏.
她终于开口了. "你以为我恨你吗? 我只是累了." 这句话像一把钝刀, 不锋利, 却切得很慢.
他没有回答. 他坐到她身边. 两个人都没有说话. 桌上的茶凉了, 窗外的雪还在下.
那个夜晚后来发生的事, 他记得每一个细节, 又记不清整体. 他后来想, 也许人就是这样老去的:
一个又一个细节, 拼不成一张完整的脸. 他想起十二岁那年也是这样, 一个细节, 又一个细节, 母亲就这样消失了.
"你还会来吗?" 他问. "我不知道," 她说, "也许吧. 也许不会了."
她走了之后, 他在房间里待了很久. 他想哭, 但哭不出来. 他想到许多年以后的自己, 还会不会记得这一夜.
他走到镜子前. 镜子里那张脸他认识, 又不认识. 他笑了一下. 笑里没有恨, 也没有得意, 只有累.
"算了," 他对镜子里的那个人说, "算了."
`.trim().repeat(3);

// 2. Technical fixture: Knuth-style algorithm chapter w/ code + math density.
const TECHNICAL_TEXT = `
We now analyze the worst-case running time of the algorithm. Let \\$T(n)\\$ denote the
number of basic operations on input of size n.

\`\`\`
procedure MergeSort(A, p, r):
    if p < r:
        q = floor((p + r) / 2)
        MergeSort(A, p, q)
        MergeSort(A, q+1, r)
        Merge(A, p, q, r)
\`\`\`

The recurrence is \\$T(n) = 2T(n/2) + \\Theta(n)\\$ which by the Master Theorem
resolves to \\$T(n) = \\Theta(n \\log n)\\$.

Consider the loop invariant: at the start of each iteration of the outer for-loop,
the subarray A[1..i-1] consists of the i-1 smallest elements of A[1..n] in sorted
order. We prove this by induction on i.

\`\`\`
for i = 2 to A.length:
    key = A[i]
    j = i - 1
    while j > 0 and A[j] > key:
        A[j+1] = A[j]
        j = j - 1
    A[j+1] = key
\`\`\`

The amortized cost per insertion is \\$O(\\log n)\\$ using a binary heap.
Note \\$\\sum_{k=1}^{n} k = n(n+1)/2 = \\Theta(n^2)\\$ in the worst case.

\`\`\`python
def binary_search(arr, target):
    lo, hi = 0, len(arr) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if arr[mid] == target:
            return mid
        elif arr[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1
\`\`\`

This is asymptotically optimal in the comparison model: any deterministic
comparison-based search must perform \\$\\Omega(\\log n)\\$ comparisons in the worst case.
`.trim().repeat(3);

function makeBook(id, text, n = 5) {
  return {
    id,
    title: id,
    author: 'Test',
    chunks: Array.from({ length: n }, (_, i) => ({
      idx: i,
      title: `Section ${i + 1}`,
      text,
    })),
  };
}

(async () => {
  const router = require('../lib/distillation/book-router');
  const phases = require('../lib/distillation/phases');
  const bookProfile = require('../lib/grounding/book-profile');

  // ── Test 1-3: detectBookArchetype on fiction ───────────────────────────
  {
    const r = router.detectBookArchetype(makeBook('dostoyevsky', FICTION_TEXT));
    check('1. fiction → archetype=literary', r.archetype === 'literary');
    check('2. fiction → confidence > 0.5', r.confidence > 0.5);
    check('3. fiction → dialogue_ratio > 0.10', r.signals.dialogue_ratio > 0.10);
  }

  // ── Test 4-5: detectBookArchetype on technical (negative — must NOT trip) ─
  {
    const r = router.detectBookArchetype(makeBook('knuth', TECHNICAL_TEXT));
    check('4. technical → archetype != literary (negative)', r.archetype !== 'literary');
    check('5. technical → code_density_score > 0.3', r.signals.code_density_score > 0.3);
  }

  // ── Test 6: detectBookArchetype on too-short input ─────────────────────
  {
    const r = router.detectBookArchetype({ id: 'tiny', chunks: [{ text: 'short' }] });
    check('6. too-short input → archetype=unknown', r.archetype === 'unknown');
  }

  // ── Test 7: detectBookArchetype on empty book ──────────────────────────
  {
    const r = router.detectBookArchetype({ id: 'empty', chunks: [] });
    check('7. empty book → archetype=unknown + reason=no-chunks',
      r.archetype === 'unknown' && r.signals && r.signals.reason === 'no-chunks');
  }

  // ── Test 8: phase 4 literary mock returns spark_literary[] ─────────────
  {
    const book = makeBook('lit-book', FICTION_TEXT);
    const phase3 = {
      phase_n: 3,
      book_id: book.id,
      themes: [{
        id: 'theme-01', name: 'self-loathing',
        sparks: [{ id: 'spark-01', name: '瘙痒', hook: 'h', mechanism: ['m1'], counterintuitive: 'c' }],
      }],
    };
    const out = await phases.phase4_frontierize(book, phase3, { archetype: 'literary' });
    check('8. phase4 literary → returns spark_literary[] (not spark_ai_era)',
      Array.isArray(out.spark_literary)
      && out.spark_literary.length === 1
      && out.spark_literary[0].motif
      && out.spark_literary[0].narrative_arc
      && out.spark_literary[0].key_passage
      && !out.spark_ai_era);
    check('8b. phase4 literary → output.archetype="literary"', out.archetype === 'literary');
  }

  // ── Test 9: phase 4 default (regression — no archetype) ────────────────
  {
    const book = makeBook('tech-book', TECHNICAL_TEXT);
    const phase3 = {
      phase_n: 3,
      book_id: book.id,
      themes: [{
        id: 'theme-01', name: 'merge-sort',
        sparks: [{ id: 'spark-01', name: 'divide-and-conquer', hook: 'h', mechanism: ['m1'], counterintuitive: 'c' }],
      }],
    };
    const out = await phases.phase4_frontierize(book, phase3, {});
    check('9. phase4 default → returns spark_ai_era[] (regression)',
      Array.isArray(out.spark_ai_era)
      && out.spark_ai_era.length === 1
      && out.spark_ai_era[0].ai_era
      && !out.spark_literary);
  }

  // ── Test 10: phase 6 inherits literary from phase4 ────────────────────
  {
    const book = makeBook('lit-book', FICTION_TEXT);
    const phase3 = {
      themes: [{ id: 'theme-01', name: 't', sparks: [{ id: 'spark-01' }] }],
    };
    const phase4 = await phases.phase4_frontierize(book, phase3, { archetype: 'literary' });
    const phase6 = await phases.phase6_personalize(book, { phase3, phase4 }, {});
    check('10. phase6 inherits archetype=literary from phase4',
      phase6.archetype === 'literary'
      && Array.isArray(phase6.spark_literary_transfer)
      && phase6.spark_literary_transfer[0].resonance
      && phase6.spark_literary_transfer[0].reading_invitation
      && Array.isArray(phase6.reading_commitments)
      && !phase6.spark_personalize);
  }

  // ── Test 11: phase 6 default — regression ──────────────────────────────
  {
    const book = makeBook('tech-book', TECHNICAL_TEXT);
    const phase3 = {
      themes: [{ id: 'theme-01', name: 't', sparks: [{ id: 'spark-01' }] }],
    };
    const phase4 = await phases.phase4_frontierize(book, phase3, {});
    const phase6 = await phases.phase6_personalize(book, { phase3, phase4 }, {});
    check('11. phase6 default → returns spark_personalize[] + strategic_propositions[]',
      Array.isArray(phase6.spark_personalize)
      && phase6.spark_personalize[0].transfer
      && phase6.spark_personalize[0].experiment
      && Array.isArray(phase6.strategic_propositions)
      && !phase6.spark_literary_transfer);
  }

  // ── Test 12: book-profile stamps archetype on the persisted profile ────
  {
    const slug = 'literary-test-slug';
    const bookId = 'test-book';
    // No manifest on disk → buildBookProfile falls back to title=bookId.
    const profile = await bookProfile.buildBookProfile(bookId, { north_star_goal: '读 D' }, {
      vaultRoot: TMP_VAULT,
      slug,
      force: true,
      archetype: 'literary',
    });
    check('12. book-profile → archetype stamped on profile', profile.archetype === 'literary');
    check('12b. book-profile → LITERARY MODE injected into prompt',
      global._STUB_LITERARY_FLAG === true);
  }

  // ── Test 13: book-profile default — no archetype → no LITERARY block ───
  {
    global._STUB_LITERARY_FLAG = false;
    const slug = 'default-test-slug';
    const bookId = 'test-book-default';
    const profile = await bookProfile.buildBookProfile(bookId, { north_star_goal: '学算法' }, {
      vaultRoot: TMP_VAULT,
      slug,
      force: true,
    });
    check('13. book-profile default → archetype=null (regression)', profile.archetype === null);
    check('13b. book-profile default → no LITERARY MODE in prompt',
      global._STUB_LITERARY_FLAG === false);
  }

  // ── Test 14: Negative — fiction-style WITHIN technical context doesn't flip detector ─
  {
    // Technical doc with a single dialogue-quoting paragraph: must still be non-literary.
    const mixed = TECHNICAL_TEXT + '\n\n"This algorithm is elegant," said Donald, "but watch the cache."\n\n' + TECHNICAL_TEXT;
    const r = router.detectBookArchetype(makeBook('mostly-tech', mixed));
    check('14. fiction-quote inside technical → still != literary', r.archetype !== 'literary');
  }

  // ── Test 15: Negative — pure code block w/o any prose stays non-literary ─
  {
    const codeOnly = '```\n' + 'for (let i=0;i<100;i++){ a[i]=i*2; }\n'.repeat(20) + '```\n';
    const r = router.detectBookArchetype(makeBook('codeonly', codeOnly.repeat(5)));
    check('15. pure code → archetype != literary', r.archetype !== 'literary');
  }

  // ── Report ─────────────────────────────────────────────────────────────
  console.log('\n=== HYPHA · Literary Archetype smoke (Phase 4+6) ===\n');
  for (const line of tests) console.log(line);
  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed}/${passed + failed} PASS\x1b[0m\n`);

  try { fs.rmSync(TMP_VAULT, { recursive: true, force: true }); } catch (_) {}
  try { fs.unlinkSync(path.join(__dirname, '_literary_archetype_llm_stub.js')); } catch (_) {}
  process.exit(failed === 0 ? 0 : 1);
})();
