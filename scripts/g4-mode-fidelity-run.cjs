'use strict';

/**
 * HYPHA · v0.1 G4 acceptance gate runner — Mode behavior fidelity (Option A).
 *
 * Reads scripts/g4-mode-fidelity-fixture.json (10 contracts × 3 modes),
 * generates a lesson plan for each, scores whether mode-specific signals
 * appear in the plan via:
 *   1) keyword presence (Exam/Growth/Hybrid lexicons), 0-100
 *   2) LLM-as-tagger via executeChat('T4_JUDGE'), 0-100
 *   3) final = 0.5 × keyword + 0.5 × LLM, threshold 60 = "aligns with mode"
 *
 * PASS criterion: ≥9/10 contracts align.
 *
 * Cost: 10 × T6_STRONG plan generation + 10 × T4_JUDGE tagger ≈ ¥0.20.
 * Time: ~5-10 min wall clock.
 */

const path = require('path');
const fs = require('fs');
const { generatePlan } = require(path.resolve(__dirname, '..', 'app', 'lib', 'lesson-generator.js'));
const { executeChat } = require(path.resolve(__dirname, '..', 'app', 'lib', 'llm'));

const FIXTURE_PATH = path.resolve(__dirname, 'g4-mode-fidelity-fixture.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

const KEYWORDS = {
  Exam:   ['deadline', 'scope', 'time', '考', '截止', '时间', 'pass', 'score', 'test', '应试', '真题', '考点', '范围', '模拟', '冲刺', '考试', '通过率'],
  Growth: ['transfer', 'apply', 'understand', 'fork', 'build', '理解', '应用', '迁移', '长期', 'master', '深入', '原理', '机制', '产品', 'ship'],
  Hybrid: [],
};

function keywordScore(planText, mode) {
  const text = planText.toLowerCase();
  if (mode === 'Hybrid') {
    const exam = KEYWORDS.Exam.some(k => text.includes(k.toLowerCase()));
    const growth = KEYWORDS.Growth.some(k => text.includes(k.toLowerCase()));
    return (exam && growth) ? 90 : (exam || growth) ? 50 : 0;
  }
  const wanted = KEYWORDS[mode] || [];
  const hits = wanted.filter(k => text.includes(k.toLowerCase())).length;
  return Math.min(100, hits * 25);
}

const TAGGER_SYSTEM = `You judge whether a HYPHA lesson plan aligns with a target learning mode.

Modes:
- Exam: maximize exam performance within scope + deadline. Plan should reference time pressure, exam scope, test-style proof.
- Growth: long-term shift in understanding + ability to ship/transfer. Plan should reference transfer, depth, application beyond exam.
- Hybrid: BOTH — plan must show deadline pressure AND transfer goal.

Output ONE JSON: {"score": 0-100, "reason": "<=80 chars"}.

100 = plan strongly aligns with the requested mode (clear, multiple signals).
60-99 = aligns (signals visible, not dominant).
0-59 = misaligned (no mode-specific signal, looks generic).`;

async function llmTaggerScore(plan, mode) {
  const planText = JSON.stringify(plan, null, 2);
  const messages = [
    { role: 'system', content: TAGGER_SYSTEM },
    { role: 'user', content: `Target mode: ${mode}\n\nLesson plan:\n${planText}\n\nScore alignment (0-100) + reason.` },
  ];
  try {
    const dispatch = await executeChat('T4_JUDGE', { messages, json: true, maxTokens: 200, temperature: 0 });
    const out = dispatch.result;
    const score = Number(out && out.score);
    return { score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0, reason: (out && out.reason) || '', providerId: dispatch.providerId };
  } catch (e) {
    return { score: 0, reason: 'tagger error: ' + e.message, providerId: null };
  }
}

(async () => {
  console.log('G4 Mode Behavior Fidelity — runner');
  console.log(`Contracts: ${fixture.contracts.length}`);
  console.log('-'.repeat(80));

  const results = [];
  let aligned = 0;

  for (let i = 0; i < fixture.contracts.length; i++) {
    const c = fixture.contracts[i];
    const idx = String(i + 1).padStart(2, '0');
    const mode = c.goal.learning_model;
    try {
      const plan = await generatePlan({
        goalContract: c.goal,
        audience: c.audience,
        learnerState: c.learner_state,
      });
      const planText = JSON.stringify(plan);
      const kw = keywordScore(planText, mode);
      const tag = await llmTaggerScore(plan, mode);
      const final = 0.5 * kw + 0.5 * tag.score;
      const ok = final >= 60;
      if (ok) aligned++;
      console.log(`${idx} [${ok ? 'OK' : '--'}] ${c.name.padEnd(28)} mode=${mode.padEnd(7)} kw=${String(kw).padEnd(3)} llm=${String(tag.score).padEnd(3)} final=${final.toFixed(0).padEnd(3)} via=${tag.providerId || 'n/a'}`);
      results.push({ idx, name: c.name, mode, keyword_score: kw, llm_score: tag.score, llm_reason: tag.reason, final_score: final, aligned: ok, plan });
    } catch (e) {
      console.error(`${idx} ERROR: ${c.name}: ${e.message}`);
      results.push({ idx, name: c.name, mode, error: e.message });
    }
  }

  console.log('-'.repeat(80));
  const total = fixture.contracts.length;
  console.log(`aligned: ${aligned}/${total} (${(aligned / total * 100).toFixed(0)}%)`);
  console.log(`gate: ≥9/10 — ${aligned >= 9 ? 'PASS ✓' : 'FAIL ✗'}`);

  fs.writeFileSync(
    path.resolve(__dirname, 'g4-mode-fidelity-output.json'),
    JSON.stringify({ summary: { total, aligned, pass: aligned >= 9 }, results }, null, 2),
  );
  console.log(`output: scripts/g4-mode-fidelity-output.json`);

  process.exit(aligned >= 9 ? 0 : 1);
})();
