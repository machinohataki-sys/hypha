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

function buildFrontmatter({ plan, scoreResult, goalContract, lessonId, generatedAt, userIntent, visualArchetype, pedagogicalArchetype, knowledgePointRefs, productionScaffold } = {}) {
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
  // Phase B 改动 4 / pedagogy.md Layer 0 S0+S1+S3 — preserve intent + archetypes
  // + KP refs into frontmatter so downstream readers (NoteView, KP atomic
  // resolver, PRODUCTION SCAFFOLD UI) can dispatch without re-reading state.json.
  // All optional: older lessons skip these silently (backward compat per
  // pedagogy.md Migration Matrix C — legacy NOTE compatibility).
  const intentStr = (typeof userIntent === 'string' && userIntent.trim()) ? userIntent.trim() : '';
  if (intentStr) fields.push(['user_intent', intentStr]);
  const va = (typeof visualArchetype === 'string' && visualArchetype.trim()) ? visualArchetype.trim() : '';
  if (va) fields.push(['visual_archetype', va]);
  const pa = (typeof pedagogicalArchetype === 'string' && pedagogicalArchetype.trim()) ? pedagogicalArchetype.trim() : '';
  if (pa) fields.push(['archetype', pa]);
  if (Array.isArray(knowledgePointRefs) && knowledgePointRefs.length > 0) {
    // YAML inline array of kp ids. Resolver reads these to walk `lesson-N/kp-M.md` siblings.
    fields.push(['knowledge_point_refs', `[${knowledgePointRefs.map(id => JSON.stringify(String(id))).join(', ')}]`]);
  }
  if (productionScaffold && typeof productionScaffold === 'object' && productionScaffold.intent) {
    // Production scaffold entrypoint persisted inline for renderer fast-path.
    // Use compact JSON string (yamlScalar would over-quote nested object).
    fields.push(['production_scaffold', JSON.stringify(productionScaffold)]);
  }
  return fields.map(([k, v]) => `${k}: ${yamlScalar(v)}`).join('\n') + '\n';
}

// Phase B 改动 4 / pedagogy.md Layer 6 Tier 1 — 上期回顾 section.
// Renders a structured prior-lesson reference using whatever fields are
// available on prevLesson. If a substantive prior summary is supplied
// (prevLesson.summary), it's emitted verbatim; otherwise the section falls
// back to a wikilink + caller-supplied prevLesson.preview excerpt (up to
// 400 chars) so the section is always substantive, never a TODO note.
//
// intentional-placeholder: full 200-400-字 LLM-driven regen (per
// pedagogy.md R13 "Full regen via prior-review.js") is a separate Phase B
// 改动 8 module not yet shipped in this batch. This function is the SURFACE
// renderer; when prior-review.js lands, callers will pass prevLesson.summary
// produced by it. Until then, callers should pass prevLesson.preview (an
// excerpt) to keep the section informational rather than blank.
function renderPriorReview(prevLesson) {
  if (!prevLesson || typeof prevLesson !== 'object') return '';
  const idx = (typeof prevLesson.idx === 'number') ? Math.max(0, prevLesson.idx - 1) : 0;
  const title = prevLesson.title || `Lesson ${idx}`;
  const ref = prevLesson.rel || `lesson-${String(idx).padStart(2, '0')}`;
  const lines = ['## 上期回顾 (Prior Review)', ''];
  if (typeof prevLesson.summary === 'string' && prevLesson.summary.trim()) {
    // LLM-regenerated substantive review (when prior-review.js wires in).
    lines.push(prevLesson.summary.trim());
    lines.push('');
    lines.push(`Reference: [[${ref}|${title}]]`);
  } else if (typeof prevLesson.preview === 'string' && prevLesson.preview.trim()) {
    // Caller supplied an excerpt — quote it inline rather than leave blank.
    const preview = prevLesson.preview.replace(/\s+/g, ' ').trim().slice(0, 400);
    lines.push(`From [[${ref}|${title}]]:`);
    lines.push('');
    lines.push(`> ${preview}`);
  } else {
    // Minimal: at least the wikilink anchor, plus a brief next-step pointer
    // so the section carries real navigational information even when no
    // body excerpt was supplied by the caller.
    lines.push(`Continuing from [[${ref}|${title}]]. Open the prior lesson NOTE for full context before this one.`);
  }
  return lines.join('\n');
}

// Phase B 改动 4 / pedagogy.md Layer 6 Tier 2 — 内容总览 (text relation list,
// R14). PhD course slides always carry a "理论之间的关系" section showing how
// the lesson's KPs hang together. We render the equivalent from the lesson's
// KP seeds (or full arcs if available).
function renderTOC(knowledgePoints) {
  const kps = Array.isArray(knowledgePoints) ? knowledgePoints.filter(Boolean) : [];
  if (kps.length === 0) return '';
  const lines = ['## 内容总览 (Outline)', '', '本课时知识点关系:'];
  for (const kp of kps) {
    if (!kp || !kp.id) continue;
    const title = kp.title || '';
    const archetypeHint = kp.archetype_hint ? ` [${kp.archetype_hint}]` : '';
    const lineageList = Array.isArray(kp.lineage_link_seeds) ? kp.lineage_link_seeds : [];
    const lineage = lineageList.map(l => `${l.relation || '关联'}→${l.label || ''}`).filter(s => s !== '关联→').join(', ');
    const lineagePart = lineage ? ` (lineage: ${lineage})` : '';
    lines.push(`- **${kp.id}** ${title}${archetypeHint}${lineagePart}`);
  }
  return lines.join('\n');
}

// Phase B 改动 4 / pedagogy.md Layer 0 S3 — cross-syllabus wikilink formatter.
// Per Layer 0 S3 canonical ref schema: { syllabus_slug, lesson_idx, kp_id?,
// display_label, fallback }. '_self' or missing slug resolves in-syllabus.
function formatCrossSyllabusLink(target) {
  if (!target || typeof target !== 'object') return '';
  const slug = target.syllabus_slug && target.syllabus_slug !== '_self' ? target.syllabus_slug : null;
  const idx = Number.isInteger(target.lesson_idx) ? target.lesson_idx : 0;
  const kpId = target.kp_id || '';
  const label = target.display_label || target.fallback || target.kp_id || 'link';
  const lessonPart = `lesson-${String(idx).padStart(2, '0')}`;
  const ref = slug
    ? (kpId ? `${slug}/${lessonPart}/${kpId}` : `${slug}/${lessonPart}`)
    : (kpId ? `${lessonPart}/${kpId}` : lessonPart);
  return `[[${ref}|${label}]]`;
}

function buildBody({ plan, body, response, scoreResult, priorLesson, knowledgePoints, productionScaffold } = {}) {
  const out = [];

  // Layer 6 Tier 1 — 上期回顾 (only when priorLesson provided). Skipped
  // silently for first lesson + legacy curricula without prev pointer.
  const priorSection = renderPriorReview(priorLesson);
  if (priorSection) {
    out.push(priorSection);
    out.push('');
  }

  // Layer 6 Tier 2 — 内容总览 (only when knowledgePoints provided).
  const tocSection = renderTOC(knowledgePoints);
  if (tocSection) {
    out.push(tocSection);
    out.push('');
  }

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

  // Phase B 改动 4 / pedagogy.md Layer 5 M4 — PRODUCTION SCAFFOLD entrypoint
  // section (R11 取代旧 3-seed homework). Rendered as a final NOTE section so
  // student sees their output-add obligation alongside DEEPEN/EXPAND/CHALLENGE
  // input-add mode buttons. Skipped when productionScaffold is not provided
  // (legacy lessons without intent gating, or first-pass writes that defer
  // scaffold to a later deposit).
  if (productionScaffold && typeof productionScaffold === 'object' && productionScaffold.intent) {
    out.push('');
    out.push('## 加法义务 (Production Scaffold)');
    out.push('');
    out.push(`**Intent**: ${productionScaffold.intent}`);
    out.push('');
    const mapping = Array.isArray(productionScaffold.kp_slot_mapping) ? productionScaffold.kp_slot_mapping : [];
    if (mapping.length > 0) {
      out.push('**Slot → KP mapping**:');
      for (const m of mapping) {
        const slot = m.slot_name || '_';
        const refs = (Array.isArray(m.kp_refs) ? m.kp_refs : [])
          .map(r => {
            const title = r.title ? ` ${r.title}` : '';
            return `[[${r.kp_id}|${r.kp_id}${title}]]`;
          })
          .join(', ');
        out.push(`- **${slot}** ← ${refs || '_(no KP yet bound to this slot — write fresh)_'}`);
      }
      out.push('');
    }
    if (productionScaffold.prompt) {
      out.push(`> ${productionScaffold.prompt}`);
    }
  }

  return out.join('\n');
}

async function depositLessonNote({
  plan, body, response, scoreResult, goalContract,
  // Phase B 改动 M6c (MEOW v7 HIGH fix) — new optional inputs from pedagogy.md
  // Layer 0/4/5/6. main.js note:deposit handler auto-augments these from
  // vault state files. Direct callers can supply them explicitly.
  userIntent, visualArchetype, pedagogicalArchetype,
  knowledgePoints, knowledgePointRefs, productionScaffold, priorLesson,
} = {}) {
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

  // 3 + 4. Compose content with augmented frontmatter + body sections.
  const generatedAt = new Date().toISOString();
  const fm = buildFrontmatter({
    plan, scoreResult, goalContract, lessonId: nextN, generatedAt,
    userIntent, visualArchetype, pedagogicalArchetype,
    knowledgePointRefs, productionScaffold,
  });
  const md = buildBody({
    plan, body, response: response || '', scoreResult,
    priorLesson, knowledgePoints, productionScaffold,
  });
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

// Phase B 改动 4 / pedagogy.md Layer 0 S3 — atomic KP NOTE deposit.
//
// Writes one KP narrative arc (7+1 fields from generateKPArc) to its own .md
// at `vault/<slug>/lesson-<idx>/<kp_id>.md`. Lesson NOTE (lesson-N.md) stays
// at top level as PARENT; its body lists wikilinks to all kp-*.md children.
//
// Overwrite policy: unlike depositLessonNote which refuses to overwrite,
// depositKnowledgePointNote ALLOWS overwrite — KP arcs regenerate via
// regen-skeleton + approve-and-body, and per Migration Matrix dual-write
// rule "latest arc wins". File-level versioning is handled by the body JSON
// at `lesson-<idx>.kp-arc.json` (which keeps generation history).
async function depositKnowledgePointNote({
  kpArc,
  kpId,
  lessonIdx,
  slug,
  syllabusSlug,
  lessonTitle,
  archetype,
  visualArchetype,
  userIntent,
} = {}) {
  if (!kpArc || typeof kpArc !== 'object') {
    throw Object.assign(new Error('kpArc (object) is required'), { code: 'BAD_INPUT' });
  }
  if (typeof kpId !== 'string' || !/^kp-\d+$/.test(kpId)) {
    throw Object.assign(new Error('kpId must match /^kp-\\d+$/'), { code: 'BAD_INPUT' });
  }
  if (!Number.isInteger(lessonIdx) || lessonIdx < 0) {
    throw Object.assign(new Error('lessonIdx must be non-negative integer'), { code: 'BAD_INPUT' });
  }
  if (typeof slug !== 'string' || !slug.trim()) {
    throw Object.assign(new Error('slug is required'), { code: 'BAD_INPUT' });
  }

  const lessonDir = `lesson-${String(lessonIdx).padStart(2, '0')}`;
  const dir = path.join(vaultRoot(), slug, lessonDir);
  const filePath = path.join(dir, `${kpId}.md`);

  const generatedAt = new Date().toISOString();

  // KP frontmatter — atomic NOTE schema per pedagogy.md Layer 0 S3.
  const fmLines = [
    '---',
    `kp_id: ${yamlScalar(kpId)}`,
    `lesson_idx: ${lessonIdx}`,
    `parent_lesson_slug: ${yamlScalar(slug)}`,
    `syllabus_slug: ${yamlScalar(syllabusSlug || slug)}`,
    `lesson_title: ${yamlScalar(lessonTitle || '')}`,
    `archetype: ${yamlScalar(archetype || '')}`,
    `visual_archetype: ${yamlScalar(visualArchetype || 'DAG')}`,
    `user_intent: ${yamlScalar(userIntent || '')}`,
    `generated: ${generatedAt}`,
    `schema_version: kp-arc-v1`,
    '---',
  ];
  const fm = fmLines.join('\n');

  // Render the narrative arc 7+1 fields per pedagogy.md Layer 4.
  const body = [];
  const definitionExcerpt = (typeof kpArc.definition === 'string' && kpArc.definition.trim())
    ? kpArc.definition.trim().slice(0, 60) + (kpArc.definition.length > 60 ? '…' : '')
    : kpId;
  body.push(`# ${kpId}: ${definitionExcerpt}`);
  body.push('');

  // 1. Lineage (上接)
  if (Array.isArray(kpArc.lineage_link) && kpArc.lineage_link.length > 0) {
    body.push('## 承上 (Lineage)');
    for (const link of kpArc.lineage_link) {
      if (!link) continue;
      const wikilink = formatCrossSyllabusLink(link.target);
      body.push(`- ${wikilink || '_unresolved_'} (关系: ${link.relation || '关联'})`);
    }
    body.push('');
  }

  // 2. Definition
  if (kpArc.definition) {
    body.push('## Definition');
    body.push(String(kpArc.definition));
    body.push('');
  }

  // 3. Derivation chain
  if (Array.isArray(kpArc.derivation_chain) && kpArc.derivation_chain.length > 0) {
    body.push('## Derivation chain');
    for (const step of kpArc.derivation_chain) {
      if (!step) continue;
      body.push(`**Step ${step.step || '?'}**. ${step.claim || ''}`);
      if (step.follows_from) body.push(`  ↳ follows from: ${step.follows_from}`);
      if (step.mechanism) body.push(`  ↳ mechanism: ${step.mechanism}`);
    }
    body.push('');
  }

  // 4. Critique of
  if (Array.isArray(kpArc.critique_of) && kpArc.critique_of.length > 0) {
    body.push('## Critique of');
    for (const c of kpArc.critique_of) {
      if (!c) continue;
      body.push(`**${c.target_thinker || 'unnamed'}** — ${c.target_position || ''}`);
      if (c.attack_summary) body.push(`  ↳ ${c.attack_summary}`);
    }
    body.push('');
  }

  // 5. Analogy (conditional — only if present non-null)
  if (typeof kpArc.analogy === 'string' && kpArc.analogy.trim()) {
    body.push('## Analogy');
    body.push(kpArc.analogy.trim());
    body.push('');
  }

  // 6. Connects to next (本课时内)
  if (Array.isArray(kpArc.connects_to_next) && kpArc.connects_to_next.length > 0) {
    body.push('## Connects to next');
    for (const c of kpArc.connects_to_next) {
      if (!c) continue;
      body.push(`- [[${c.target_kp_id}]] (关系: ${c.relation || 'co-construct'})`);
    }
    body.push('');
  }

  // 7. Intent use map (PRODUCTION SCAFFOLD slots)
  if (kpArc.intent_use_map && typeof kpArc.intent_use_map === 'object') {
    const entries = Object.entries(kpArc.intent_use_map).filter(([, v]) => Array.isArray(v) && v.length > 0);
    if (entries.length > 0) {
      body.push('## Intent use (PRODUCTION SCAFFOLD slots)');
      for (const [intent, slots] of entries) {
        body.push(`**${intent}**:`);
        for (const s of slots) {
          if (!s) continue;
          body.push(`  - ${s.slot_name || '_'} — ${s.rationale || ''}`);
        }
      }
      body.push('');
    }
  }

  // 8. Paraphrase prompt
  if (typeof kpArc.paraphrase_prompt === 'string' && kpArc.paraphrase_prompt.trim()) {
    body.push('## Paraphrase prompt');
    body.push(`> ${kpArc.paraphrase_prompt.trim()}`);
    body.push('');
  }

  const content = `${fm}\n\n${body.join('\n')}\n`;

  fs.mkdirSync(dir, { recursive: true });
  // Overwrite-allowed by design (see header comment).
  fs.writeFileSync(filePath, content, 'utf8');

  return { ok: true, path: filePath, kp_id: kpId, lesson_idx: lessonIdx };
}

module.exports = {
  depositLessonNote,
  slugify,
  resolveLessonPath,
  buildFrontmatter,
  buildBody,
  // Phase B 改动 4 / pedagogy.md Layer 0 S3 + Layer 6 Tier 1/2 — new exports
  depositKnowledgePointNote,
  renderPriorReview,
  renderTOC,
  formatCrossSyllabusLink,
};
