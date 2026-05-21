#!/usr/bin/env node
'use strict';

// HYPHA · _dev_verify_source_lane_router — smoke for v0.3 5-layer harvest spec.
//
// Validates:
//   app/lib/source-lane-router.js       — routeLanes / decideTransportForUrl
//   app/lib/source-conference-extractor.js — extractConferenceFields
//   app/lib/source-course-extractor.js     — extractCourseFields
//   app/lib/source-extractor.js (extractWithLanePlan additive wrapper)
//
// Goals:
//   1. 5 layers × 6 archetypes routing correctness
//   2. bb-browser transport decisions for restricted hosts; 知乎 OUT
//   3. Conference HTML fixture → Tutorial/Workshop/Best Paper extraction
//   4. Course HTML fixture → Syllabus/Assignments/Reading extraction
//   5. Backward compat: existing source-extractor exports untouched

const router = require('../lib/source-lane-router');
const conf = require('../lib/source-conference-extractor');
const course = require('../lib/source-course-extractor');
const sx = require('../lib/source-extractor');

const tests = [];
let passed = 0, failed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; tests.push(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else      { failed++; tests.push(`  \x1b[31mFAIL\x1b[0m ${name}${extra ? '\n    ' + extra : ''}`); }
}

(async () => {

// ──────────────────────────────────────────────────────────────────────────
// Group 1: routeLanes shape + archetype coverage
// ──────────────────────────────────────────────────────────────────────────

// Test 1.1: HUMANITIES skips frontier + engineering, anchors canonical
{
  const r = router.routeLanes({ archetype: 'HUMANITIES', query: 'philosophy' });
  check('1.1 HUMANITIES — ok=true', r.ok === true);
  check('1.1 HUMANITIES — plan has 5 layers', Array.isArray(r.plan) && r.plan.length === 5);
  check('1.1 HUMANITIES — frontier skipped',
    r.plan.find(p => p.layer === 'frontier').route === 'skip');
  check('1.1 HUMANITIES — engineering skipped',
    r.plan.find(p => p.layer === 'engineering').route === 'skip');
  check('1.1 HUMANITIES — canonical is priority 1',
    r.plan.find(p => p.layer === 'canonical').priority === 1);
  check('1.1 HUMANITIES — canonical has priority sources',
    r.plan.find(p => p.layer === 'canonical').sources.length > 0);
  check('1.1 HUMANITIES — skipped_layers includes frontier + engineering',
    r.skipped_layers.includes('frontier') && r.skipped_layers.includes('engineering'));
}

// Test 1.2: TECH-CONCEPT anchors frontier + uses bb-browser for engineering
{
  const r = router.routeLanes({ archetype: 'TECH-CONCEPT', query: 'transformers' });
  check('1.2 TECH-CONCEPT — frontier is priority 1',
    r.plan.find(p => p.layer === 'frontier').priority === 1);
  check('1.2 TECH-CONCEPT — engineering uses bb-browser',
    r.plan.find(p => p.layer === 'engineering').route === 'bb-browser');
  check('1.2 TECH-CONCEPT — pedagogy skipped',
    r.plan.find(p => p.layer === 'pedagogy').route === 'skip');
  check('1.2 TECH-CONCEPT — frontier has arxiv source',
    r.plan.find(p => p.layer === 'frontier').sources.some(s => s.id === 'arxiv'));
}

// Test 1.3: TECH-PROC anchors engineering, skips canonical + pedagogy
{
  const r = router.routeLanes({ archetype: 'TECH-PROC', query: 'react hooks' });
  check('1.3 TECH-PROC — engineering is priority 1',
    r.plan.find(p => p.layer === 'engineering').priority === 1);
  check('1.3 TECH-PROC — engineering uses bb-browser',
    r.plan.find(p => p.layer === 'engineering').route === 'bb-browser');
  check('1.3 TECH-PROC — canonical skipped',
    r.plan.find(p => p.layer === 'canonical').route === 'skip');
}

// Test 1.4: plan sorted by priority ascending
{
  const r = router.routeLanes({ archetype: 'HUMANITIES', query: 'tolkien' });
  let sorted = true;
  for (let i = 1; i < r.plan.length; i++) {
    if (r.plan[i].priority < r.plan[i - 1].priority) { sorted = false; break; }
  }
  check('1.4 plan sorted by priority ascending', sorted);
}

// Test 1.5: unknown archetype → ok=false + reason
{
  const r = router.routeLanes({ archetype: 'UNKNOWN-XYZ', query: 'foo' });
  check('1.5 unknown archetype — ok=false', r.ok === false);
  check('1.5 unknown archetype — reason set',
    typeof r.reason === 'string' && r.reason.includes('unknown'));
}

// Test 1.6: listSupportedArchetypes returns all 6
{
  const archs = router.listSupportedArchetypes();
  check('1.6 listSupportedArchetypes — 6 archetypes',
    Array.isArray(archs) && archs.length === 6);
  check('1.6 listSupportedArchetypes — includes HUMANITIES',
    archs.includes('HUMANITIES'));
}

// ──────────────────────────────────────────────────────────────────────────
// Group 2: bb-browser routing decisions
// ──────────────────────────────────────────────────────────────────────────

// Test 2.1: Twitter → bb-browser
{
  const r = router.decideTransportForUrl('https://twitter.com/karpathy/status/123');
  check('2.1 twitter.com → bb-browser', r.route === 'bb-browser');
}

// Test 2.2: x.com → bb-browser
{
  const r = router.decideTransportForUrl('https://x.com/sama');
  check('2.2 x.com → bb-browser', r.route === 'bb-browser');
}

// Test 2.3: reddit.com → bb-browser
{
  const r = router.decideTransportForUrl('https://www.reddit.com/r/MachineLearning');
  check('2.3 reddit.com → bb-browser', r.route === 'bb-browser');
}

// Test 2.4: 知乎 → skip (user lock 2026-05-09)
{
  const r = router.decideTransportForUrl('https://www.zhihu.com/question/12345');
  check('2.4 zhihu.com → skip (user lock)', r.route === 'skip');
  check('2.4 zhihu.com — reason cites 2026-05-09 lock',
    typeof r.reason === 'string' && r.reason.includes('2026-05-09'));
}

// Test 2.5: arxiv → webfetch
{
  const r = router.decideTransportForUrl('https://arxiv.org/abs/2604.25849');
  check('2.5 arxiv.org → webfetch', r.route === 'webfetch');
}

// Test 2.6: producthunt → bb-browser
{
  const r = router.decideTransportForUrl('https://www.producthunt.com/products/cursor');
  check('2.6 producthunt.com → bb-browser', r.route === 'bb-browser');
}

// Test 2.7: invalid URL → webfetch (graceful)
{
  const r = router.decideTransportForUrl('not-a-url');
  check('2.7 invalid URL → webfetch (graceful)', r.route === 'webfetch');
}

// ──────────────────────────────────────────────────────────────────────────
// Group 3: Conference extractor on synthetic fixtures
// ──────────────────────────────────────────────────────────────────────────

const NEURIPS_FIXTURE = `<!doctype html>
<html><body>
<h1>NeurIPS 2024</h1>
<h2>Tutorials</h2>
<ul>
  <li><a href="/tut1">Half-day tutorial on Diffusion Models — Song & Ho</a></li>
  <li><a href="/tut2">Full-day tutorial on Mechanistic Interpretability</a></li>
</ul>
<h2>Workshops</h2>
<ul>
  <li>Workshop on Foundation Models for Decision Making</li>
  <li>SafeML Workshop</li>
</ul>
<h2>Best Paper Award</h2>
<ul>
  <li><a href="/bp1">Stealing Part of a Production Language Model (Tramer et al.)</a></li>
</ul>
<h2>Oral Presentations</h2>
<ul>
  <li>Vision Transformers Need Registers</li>
  <li>Mamba: Linear-Time Sequence Modeling</li>
</ul>
<h2>Keynote</h2>
<ul>
  <li>Yann LeCun on Joint Embedding Predictive Architectures</li>
</ul>
</body></html>`;

// Test 3.1: NeurIPS fixture extraction
{
  const r = conf.extractConferenceFields({ url: 'https://neurips.cc/Conferences/2024', html: NEURIPS_FIXTURE });
  check('3.1 NeurIPS — ok=true', r.ok === true);
  check('3.1 NeurIPS — conference_id=neurips', r.conference_id === 'neurips');
  check('3.1 NeurIPS — conference_year=2024', r.conference_year === 2024);
  check('3.1 NeurIPS — found tutorials',
    r.fields.tutorials.length >= 2);
  check('3.1 NeurIPS — found workshops',
    r.fields.workshops.length >= 2);
  check('3.1 NeurIPS — found best_papers',
    r.fields.best_papers.length >= 1);
  check('3.1 NeurIPS — found orals',
    r.fields.orals.length >= 2);
  check('3.1 NeurIPS — found keynotes',
    r.fields.keynotes.length >= 1);
  check('3.1 NeurIPS — sections_found includes best_papers',
    r.stats.sections_found.includes('best_papers'));
}

// Test 3.2: OpenReview review fixture
const OR_FIXTURE = `<!doctype html>
<html><body>
<h1>OpenReview 2025</h1>
<h2>Review Thread</h2>
<ul>
  <li>Reviewer 2 raised concerns about benchmark contamination</li>
  <li>Rebuttal addressed dataset size limitation</li>
</ul>
</body></html>`;
{
  const r = conf.extractConferenceFields({ url: 'https://openreview.net/forum?id=xyz', html: OR_FIXTURE });
  check('3.2 OpenReview — conference_id=openreview', r.conference_id === 'openreview');
  check('3.2 OpenReview — openreview_reviews captured',
    r.fields.openreview_reviews.length >= 2);
}

// Test 3.3: empty HTML graceful
{
  const r = conf.extractConferenceFields({ url: 'https://neurips.cc/', html: '' });
  check('3.3 empty html — ok=false', r.ok === false);
}

// ──────────────────────────────────────────────────────────────────────────
// Group 4: Course extractor on synthetic fixtures
// ──────────────────────────────────────────────────────────────────────────

const MIT_OCW_FIXTURE = `<!doctype html>
<html><body>
<h1>6.006 Introduction to Algorithms — Spring 2020</h1>
<h2>Prerequisites</h2>
<p>6.0001 Introduction to Computer Science Programming + 6.042 Mathematics for CS</p>
<h2>Syllabus</h2>
<ul>
  <li>Week 1 — Algorithmic Thinking; Peak Finding</li>
  <li>Week 2 — Models of Computation; Document Distance</li>
  <li>Week 3 — Sorting and Trees</li>
</ul>
<h2>Lectures</h2>
<ul>
  <li><a href="/l1">Lecture 1: Algorithmic Thinking</a></li>
  <li><a href="/l2">Lecture 2: Models of Computation</a></li>
</ul>
<h2>Assignments</h2>
<ul>
  <li>Problem Set 1 — Peak Finding</li>
  <li>Problem Set 2 — Document Distance</li>
</ul>
<h2>Required Readings</h2>
<ul>
  <li>CLRS Chapter 1-3</li>
  <li>CLRS Chapter 6 (Heapsort)</li>
</ul>
<h2>Final Project</h2>
<ul>
  <li>Implement a graph algorithm of your choice</li>
</ul>
</body></html>`;

// Test 4.1: MIT OCW fixture extraction
{
  const r = course.extractCourseFields({ url: 'https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-spring-2020/', html: MIT_OCW_FIXTURE });
  check('4.1 MIT OCW — ok=true', r.ok === true);
  check('4.1 MIT OCW — institution=MIT OCW', r.institution === 'MIT OCW');
  check('4.1 MIT OCW — course_id captured',
    typeof r.course_id === 'string' && r.course_id.includes('6-006'));
  check('4.1 MIT OCW — syllabus captured 3 weeks',
    r.fields.syllabus.length >= 3);
  check('4.1 MIT OCW — syllabus has week=1',
    r.fields.syllabus.some(s => s.week === 1));
  check('4.1 MIT OCW — assignments captured',
    r.fields.assignments.length >= 2);
  check('4.1 MIT OCW — reading captured',
    r.fields.reading.length >= 2);
  check('4.1 MIT OCW — final_project captured',
    r.fields.final_project.length >= 1);
  check('4.1 MIT OCW — prerequisites captured',
    r.fields.prerequisites.length >= 1);
  check('4.1 MIT OCW — lectures captured',
    r.fields.lectures.length >= 2);
  check('4.1 MIT OCW — sections_found includes syllabus',
    r.stats.sections_found.includes('syllabus'));
}

// Test 4.2: Stanford fixture w/ labs
const STANFORD_FIXTURE = `<!doctype html>
<html><body>
<h1>CS229 Machine Learning</h1>
<h2>Schedule</h2>
<ul>
  <li>Lecture 1: Linear Regression</li>
  <li>Lecture 2: Logistic Regression</li>
</ul>
<h2>Lab Assignments</h2>
<ul>
  <li>Lab 1: Numpy refresher</li>
</ul>
<h2>Midterm Exam</h2>
<ul>
  <li>Coverage: lectures 1-7</li>
</ul>
</body></html>`;
{
  const r = course.extractCourseFields({ url: 'https://cs229.stanford.edu/', html: STANFORD_FIXTURE });
  check('4.2 Stanford — institution=Stanford', r.institution === 'Stanford');
  check('4.2 Stanford — labs captured', r.fields.labs.length >= 1);
  check('4.2 Stanford — exams captured', r.fields.exams.length >= 1);
}

// Test 4.3: empty HTML graceful
{
  const r = course.extractCourseFields({ url: 'https://ocw.mit.edu/', html: '' });
  check('4.3 empty html — ok=false', r.ok === false);
}

// ──────────────────────────────────────────────────────────────────────────
// Group 5: source-extractor backward-compat + extractWithLanePlan
// ──────────────────────────────────────────────────────────────────────────

// Test 5.1: existing exports preserved
{
  check('5.1 source-extractor — extractFromPath still exported',
    typeof sx.extractFromPath === 'function');
  check('5.1 source-extractor — extractFromUrl still exported',
    typeof sx.extractFromUrl === 'function');
  check('5.1 source-extractor — _normalizeUploadedSource still exported',
    typeof sx._normalizeUploadedSource === 'function');
  check('5.1 source-extractor — firstFileName still exported',
    typeof sx.firstFileName === 'function');
  check('5.1 source-extractor — MAX_FILE_BYTES still exported',
    typeof sx.MAX_FILE_BYTES === 'number' && sx.MAX_FILE_BYTES > 0);
}

// Test 5.2: extractWithLanePlan added
{
  check('5.2 source-extractor — extractWithLanePlan added',
    typeof sx.extractWithLanePlan === 'function');
}

// Test 5.3: extractWithLanePlan dispatches conference URL + html → conference kind
{
  const r = await sx.extractWithLanePlan('https://neurips.cc/Conferences/2024', { html: NEURIPS_FIXTURE });
  check('5.3 extractWithLanePlan — conference URL → kind=conference', r.kind === 'conference');
  check('5.3 extractWithLanePlan — conference URL → tutorials populated',
    r.fields && r.fields.tutorials && r.fields.tutorials.length >= 1);
}

// Test 5.4: extractWithLanePlan dispatches course URL + html → course kind
{
  const r = await sx.extractWithLanePlan('https://ocw.mit.edu/courses/6-006/', { html: MIT_OCW_FIXTURE });
  check('5.4 extractWithLanePlan — course URL → kind=course', r.kind === 'course');
  check('5.4 extractWithLanePlan — course URL → syllabus populated',
    r.fields && r.fields.syllabus && r.fields.syllabus.length >= 1);
}

// Test 5.5: extractWithLanePlan with invalid URL → ok=false
{
  const r = await sx.extractWithLanePlan('', { html: '<p>hi</p>' });
  check('5.5 extractWithLanePlan — empty URL → ok=false', r.ok === false);
}

// Test 5.6: extractWithLanePlan with non-conference, non-course URL + html
{
  const r = await sx.extractWithLanePlan('https://example.com/blog/post', { html: '<h1>foo</h1>' });
  check('5.6 extractWithLanePlan — generic URL + html → kind=text + ok=false (defer to extractFromUrl)',
    r.kind === 'text' && r.ok === false);
}

// ──────────────────────────────────────────────────────────────────────────
// Group 6: matrix completeness sanity
// ──────────────────────────────────────────────────────────────────────────

// Test 6.1: every archetype has all 5 layers in matrix
{
  const archs = router.listSupportedArchetypes();
  let allComplete = true;
  for (const a of archs) {
    for (const layer of router.LAYERS) {
      const cell = router.laneCellFor(a, layer);
      if (!cell || typeof cell.priority !== 'number' || typeof cell.route !== 'string') {
        allComplete = false;
        break;
      }
    }
  }
  check('6.1 matrix complete — every (archetype × layer) cell present', allComplete);
}

// Test 6.2: only known routes used
{
  const archs = router.listSupportedArchetypes();
  const validRoutes = new Set(['webfetch', 'bb-browser', 'skip']);
  let allValid = true;
  for (const a of archs) {
    for (const layer of router.LAYERS) {
      const cell = router.laneCellFor(a, layer);
      if (!validRoutes.has(cell.route)) { allValid = false; break; }
    }
  }
  check('6.2 matrix — only known routes (webfetch/bb-browser/skip)', allValid);
}

// ── Report ─────────────────────────────────────────────────────────────
console.log('\n=== HYPHA · Source Lane Router smoke ===\n');
for (const line of tests) console.log(line);
console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed}/${passed + failed} PASS\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);

})().catch((err) => {
  console.error('\x1b[31mFATAL\x1b[0m', err && err.stack || err);
  process.exit(2);
});
