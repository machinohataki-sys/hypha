'use strict';

// HYPHA · Lesson Note deposit — sub-step I (v0.1).
//
// Writes a lesson record into the user vault as a markdown file with two
// frontmatter-aligned H2 sections:
//   ## 课程基础 (Course Base) — hook + path + body prose, deterministic.
//   ## 用户灵感 (User Insight) — micro-proof stimulus + user response + score.
//
// AMD-10 v0.1 frozen scope: NO Pack/Note connections, NO Product Transfer in
// body. Deposit is idempotent at the filename level — re-call always allocates
// the next free lesson-N.md inside the slug folder; existing files are NEVER
// overwritten (silent loss = data loss). v0.2+ may add update / merge.

const fs = require('fs');
const path = require('path');

const VAULT_ROOT_DEFAULT = path.resolve(__dirname, '..', '..', 'vault');

function vaultRoot() {
  return process.env.HYPHA_VAULT_ROOT || VAULT_ROOT_DEFAULT;
}

// Slug from main_creation > north_star_goal. Lowercase ASCII + CJK kept
// (一-鿿). Everything else collapsed to '-'. Trim leading/trailing '-'. Cap
// at 60 chars to avoid exotic-path edge cases on Windows.
function slugify(s) {
  if (!s || typeof s !== 'string') return 'lesson';
  const lower = s.toLowerCase().trim();
  // Replace runs of non-allowed with '-'
  const cleaned = lower.replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned) return 'lesson';
  return cleaned.length > 60 ? cleaned.slice(0, 60).replace(/-+$/g, '') : cleaned;
}

// Scan vault/<slug>/ for lesson-N.md, return next free integer (max + 1).
// Creates dir lazily — caller does fs.mkdirSync. Returns { dir, nextN, nextPath }.
function resolveLessonPath({ slug }) {
  const dir = path.join(vaultRoot(), slug);
  let maxN = 0;
  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir);
    for (const name of entries) {
      const m = /^lesson-(\d+)\.md$/i.exec(name);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > maxN) maxN = n;
      }
    }
  }
  const nextN = maxN + 1;
  const nextPath = path.join(dir, `lesson-${nextN}.md`);
  return { dir, nextN, nextPath };
}

// YAML-safe scalar — quote if it contains ':', '#', leading '-', or
// surrounding whitespace; escape inner double-quotes.
function yamlScalar(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s === '') return '""';
  if (/[:#\n"'\\]/.test(s) || /^[\s-]/.test(s) || /\s$/.test(s)) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return s;
}

function buildFrontmatter({ plan, scoreResult, goalContract, lessonId, generatedAt }) {
  const fields = [];
  fields.push(['lesson_id', lessonId]);
  fields.push(['generated', generatedAt]);
  if (goalContract && goalContract.north_star_goal) fields.push(['goal_north_star', goalContract.north_star_goal]);
  if (goalContract && goalContract.main_creation) fields.push(['goal_main_creation', goalContract.main_creation]);
  if (goalContract && goalContract.learning_model) fields.push(['learning_model', goalContract.learning_model]);
  if (scoreResult && scoreResult.evidence_type) fields.push(['evidence_type', scoreResult.evidence_type]);
  if (scoreResult && typeof scoreResult.passed === 'boolean') fields.push(['passed', scoreResult.passed ? 'true' : 'false']);
  if (scoreResult && scoreResult.false_positive_risk) fields.push(['false_positive_risk', scoreResult.false_positive_risk]);
  if (plan && plan.assignment_level !== undefined && plan.assignment_level !== null) {
    fields.push(['assignment_level', plan.assignment_level]);
  } else {
    fields.push(['assignment_level', 1]);
  }
  return fields.map(([k, v]) => `${k}: ${yamlScalar(v)}`).join('\n') + '\n';
}

function buildBody({ plan, body, response, scoreResult }) {
  const out = [];
  out.push('## 课程基础 (Course Base)');
  out.push('');
  out.push('### 钩子 (Hook)');
  out.push(plan && plan.hook_concrete ? plan.hook_concrete : '_no hook recorded_');
  out.push('');
  out.push('### 学习路径 (Path)');
  const planPath = (plan && Array.isArray(plan.path)) ? plan.path : [];
  const proseByIdx = {};
  if (body && Array.isArray(body.path_prose)) {
    body.path_prose.forEach((item, i) => {
      const key = (item && item.step_id !== undefined && item.step_id !== null) ? String(item.step_id) : String(i);
      if (item && item.prose) proseByIdx[key] = item.prose;
    });
  }
  const roman = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii'];
  if (planPath.length === 0) {
    out.push('_no path recorded_');
  } else {
    planPath.forEach((step, i) => {
      const r = roman[i] || String(i + 1);
      out.push(`- ${r}. ${step}`);
      const prose = proseByIdx[String(i)];
      if (prose) {
        out.push(`  ${prose}`);
      }
    });
  }
  out.push('');
  out.push('### 整体行文 (Body)');
  if (body && body.intro_prose) {
    out.push(body.intro_prose);
    out.push('');
  }
  if (body && body.closing_prose) {
    out.push(body.closing_prose);
    out.push('');
  }
  if (!body || (!body.intro_prose && !body.closing_prose)) {
    out.push('_body not generated_');
    out.push('');
  }

  out.push('## 用户灵感 (User Insight)');
  out.push('');
  out.push('### 微证据 (Micro Proof)');
  const stim = plan && plan.micro_proof && plan.micro_proof.stimulus;
  const expect = plan && plan.micro_proof && plan.micro_proof.expected_signal;
  const fail = plan && plan.micro_proof && plan.micro_proof.fail_mode;
  out.push(`**Stimulus:** ${stim || '_(none)_'}`);
  out.push('');
  out.push('**Response:**');
  out.push('');
  out.push('```');
  out.push(response || '');
  out.push('```');
  out.push('');
  if (expect) out.push(`**Pass pattern:** ${expect}`);
  if (fail) out.push(`**Fail mode:** ${fail}`);
  out.push('');
  out.push('### 评分 (Score)');
  if (scoreResult) {
    if (scoreResult.evidence_type) out.push(`- Evidence type: ${scoreResult.evidence_type}`);
    if (typeof scoreResult.passed === 'boolean') out.push(`- Passed: ${scoreResult.passed ? 'true' : 'false'}`);
    if (scoreResult.false_positive_risk) out.push(`- False-positive risk: ${scoreResult.false_positive_risk}`);
    const hits = scoreResult.baseline_check && Array.isArray(scoreResult.baseline_check.regex_hits)
      ? scoreResult.baseline_check.regex_hits : null;
    if (hits) out.push(`- Tokens hit: ${hits.length === 0 ? '—' : hits.join(', ')}`);
    if (scoreResult.llm_signal && scoreResult.llm_signal.reason) {
      out.push(`- LLM signal reason: ${scoreResult.llm_signal.reason}`);
    }
  } else {
    out.push('_no score recorded_');
  }
  out.push('');
  out.push('### 下一步 (Next)');
  out.push((plan && plan.next_lesson_seed) ? plan.next_lesson_seed : '_no seed recorded_');
  return out.join('\n');
}

async function depositLessonNote({ plan, body, response, scoreResult, goalContract }) {
  // 1. Validate inputs (graceful — only the load-bearing fields are hard-required).
  if (!plan || typeof plan !== 'object') {
    throw Object.assign(new Error('plan is required'), { code: 'BAD_INPUT' });
  }
  if (!plan.objective || typeof plan.objective !== 'string') {
    throw Object.assign(new Error('plan.objective is required'), { code: 'BAD_INPUT' });
  }
  if (!plan.micro_proof || typeof plan.micro_proof !== 'object') {
    throw Object.assign(new Error('plan.micro_proof is required'), { code: 'BAD_INPUT' });
  }
  if (!goalContract || typeof goalContract !== 'object') {
    throw Object.assign(new Error('goalContract is required'), { code: 'BAD_INPUT' });
  }
  if (!goalContract.north_star_goal) {
    throw Object.assign(new Error('goalContract.north_star_goal is required'), { code: 'BAD_INPUT' });
  }

  // 2. Slug + path.
  const slug = slugify(goalContract.main_creation || goalContract.north_star_goal);
  const { dir, nextN, nextPath } = resolveLessonPath({ slug });

  // 3 + 4. Compose content.
  const generatedAt = new Date().toISOString();
  const fm = buildFrontmatter({ plan, scoreResult, goalContract, lessonId: nextN, generatedAt });
  const md = buildBody({ plan, body, response: response || '', scoreResult });
  const content = `---\n${fm}---\n\n# Lesson ${nextN}: ${plan.objective}\n\n${md}\n`;

  // 5. SAFETY: guard against an unlikely race on resolveLessonPath. Never overwrite.
  if (fs.existsSync(nextPath)) {
    throw Object.assign(new Error(`refusing to overwrite ${nextPath}`), { code: 'EEXIST' });
  }

  // 6. Persist.
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(nextPath, content, 'utf8');

  return { ok: true, path: nextPath, lessonId: nextN, slug };
}

module.exports = { depositLessonNote, slugify, resolveLessonPath, buildFrontmatter, buildBody };
