#!/usr/bin/env node
'use strict';

// learnlm-bench.js — A-vs-A harness: Hypha Learn vs Hypha Classic.
// SONCAR criterion: Likert 5pt rise ≥1pt + vivid-density rise ≥15% on ≥8/10 lessons.
// Axes: curiosity / metacognition / active_learning. Raters: 3 × 2 panels (n=6).
// Usage: node app/scripts/learnlm-bench.js --corpus ./bench-corpus --out ./bench-report.json

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const args = { corpus: './bench-corpus', out: './bench-report.json' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--corpus') args.corpus = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '-h' || a === '--help') {
      process.stdout.write('Usage: learnlm-bench.js --corpus <dir> --out <file.json>\n');
      process.exit(0);
    }
  }
  return args;
}

const SENSORY_EN = [
  'taste','tasted','sour','sweet','salty','bitter','umami','crunch','chew','texture',
  'smooth','rough','sharp','soft','warm','cold','hot','damp','dry','smell','scent',
  'aroma','fragrance','reek','musk','smoke','ash','see','saw','glance','gaze','flicker',
  'glow','shadow','glare','dim','hear','heard','hum','buzz','hiss','rustle','clang',
  'creak','silence','touch','grip','press','slide','grasp','weight','pressure','tension'
];
const SENSORY_CN = [
  '酸','甜','苦','辣','咸','鲜','嫩','脆','糙','软','硬','烫','凉','潮','干','香','臭',
  '腥','焦','烟','闻','看','瞥','凝','光','影','晃','听','嗡','嘶','沙'
];
const ENTITY_CN = [
  '北京','上海','东京','京都','纽约','巴黎','伦敦','柏林','莫斯科','亚里士多德',
  '黑格尔','康德','尼采','马克思','达尔文','爱因斯坦','哈佛','剑桥','牛津','麻省',
  '清华','北大','复旦','波兰','德国','法国','日本','美国','中国','英国'
];
const SENSORY_SET = new Set([...SENSORY_EN.map((w) => w.toLowerCase()), ...SENSORY_CN]);

function joinTurns(t) {
  return (t && Array.isArray(t.turns)) ? t.turns.map((x) => String(x.content || '')).join('\n') : '';
}
function tokenize(text) {
  const en = text.match(/[A-Za-z][A-Za-z'\-]+/g) || [];
  const cn = text.match(/[一-鿿]/g) || [];
  return { en, cn, total: en.length + cn.length };
}
function countSensory(en, cn) {
  let n = 0;
  for (const w of en) if (SENSORY_SET.has(w.toLowerCase())) n++;
  for (const c of cn) if (SENSORY_SET.has(c)) n++;
  return n;
}
function countEntities(text) {
  let n = 0;
  const re = /(^|[^.!?\n]\s)([A-Z][a-z]{2,})/g;
  while (re.exec(text) !== null) n++;
  for (const w of ENTITY_CN) {
    const m = text.match(new RegExp(w, 'g'));
    if (m) n += m.length;
  }
  const longCJK = text.match(/[一-鿿]{4,}/g) || [];
  return n + Math.min(longCJK.length, 20);
}
function countAgency(text) {
  let n = 0;
  const en = text.match(/\b(you|your|yours|we|us|our)\b/gi);
  if (en) n += en.length;
  const cnYou = text.match(/你/g); if (cnYou) n += cnYou.length;
  const cnWe = text.match(/我们/g); if (cnWe) n += cnWe.length;
  return n;
}
function countSpecificity(text) {
  let n = 0;
  const nums = text.match(/\b\d+(\.\d+)?\b/g); if (nums) n += nums.length;
  const dates = text.match(/\b\d{4}[-/年]\d{1,2}([-/月]\d{1,2})?\b/g); if (dates) n += dates.length;
  const yrs = text.match(/\b(19|20)\d{2}\b/g); if (yrs) n += yrs.length;
  return n;
}
function vividDensity(text) {
  const tk = tokenize(text);
  if (tk.total === 0) return { density: 0, sensory: 0, entity: 0, agency: 0, specificity: 0, total: 0 };
  const sensory = countSensory(tk.en, tk.cn);
  const entity = countEntities(text);
  const agency = countAgency(text);
  const specificity = countSpecificity(text);
  return { density: (sensory + entity + agency + specificity) / tk.total, sensory, entity, agency, specificity, total: tk.total };
}

function loadLessons(corpusDir, branch) {
  const dir = path.join(corpusDir, branch);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!fs.statSync(full).isDirectory()) continue;
    const tp = path.join(full, 'transcript.json');
    if (!fs.existsSync(tp)) continue;
    try { out.push({ id: `${branch}/${name}`, lessonId: name, branch, ...JSON.parse(fs.readFileSync(tp, 'utf8')) }); }
    catch (e) { process.stderr.write(`[skip] ${tp}: ${e.message}\n`); }
  }
  return out.sort((a, b) => a.lessonId.localeCompare(b.lessonId));
}

function splitCSV(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (c === ',' && !inQ) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur); return out;
}
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) return [];
  const head = splitCSV(lines[0]).map((h) => h.trim().toLowerCase());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCSV(lines[i]);
    const row = {};
    for (let j = 0; j < head.length; j++) row[head[j]] = (cells[j] || '').trim();
    rows.push(row);
  }
  return rows;
}
function loadRatings(corpusDir) {
  const dir = path.join(corpusDir, 'ratings');
  if (!fs.existsSync(dir)) return null;
  const panels = {};
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.csv')) continue;
    panels[name.replace(/\.csv$/, '')] = parseCSV(fs.readFileSync(path.join(dir, name), 'utf8'));
  }
  return Object.keys(panels).length ? panels : null;
}

function meanByLessonAxis(rows) {
  const buckets = new Map();
  for (const r of rows) {
    const s = parseFloat(r.score);
    if (!Number.isFinite(s)) continue;
    const k = `${r.lesson_id}|${r.axis}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(s);
  }
  const out = {};
  for (const [k, arr] of buckets) {
    const [lesson, axis] = k.split('|');
    if (!out[lesson]) out[lesson] = {};
    out[lesson][axis] = arr.reduce((a, b) => a + b, 0) / arr.length;
  }
  return out;
}
function branchOf(id) { return id.startsWith('learn/') ? 'learn' : 'classic'; }
function axisDeltas(perLesson) {
  const axes = ['curiosity', 'metacognition', 'active_learning'];
  const sums = { classic: {}, learn: {} }, counts = { classic: {}, learn: {} };
  for (const ax of axes) { sums.classic[ax] = sums.learn[ax] = 0; counts.classic[ax] = counts.learn[ax] = 0; }
  for (const [lid, axMap] of Object.entries(perLesson)) {
    const b = branchOf(lid);
    for (const ax of axes) if (typeof axMap[ax] === 'number') { sums[b][ax] += axMap[ax]; counts[b][ax] += 1; }
  }
  const out = {};
  for (const ax of axes) {
    const c = counts.classic[ax] ? sums.classic[ax] / counts.classic[ax] : null;
    const l = counts.learn[ax] ? sums.learn[ax] / counts.learn[ax] : null;
    out[ax] = { classic: c, learn: l, delta: (c != null && l != null) ? +(l - c).toFixed(3) : null };
  }
  return out;
}
function kendallW(rows) {
  const items = new Map(); const raters = new Set();
  for (const r of rows) {
    const s = parseFloat(r.score);
    if (!Number.isFinite(s)) continue;
    const k = `${r.lesson_id}|${r.axis}`;
    if (!items.has(k)) items.set(k, new Map());
    items.get(k).set(r.rater_id, s);
    raters.add(r.rater_id);
  }
  const rl = [...raters], m = rl.length;
  const keys = [...items.keys()].filter((k) => items.get(k).size === m);
  const n = keys.length;
  if (m < 2 || n < 2) return null;
  const ranksByRater = {};
  for (const rid of rl) {
    const pairs = keys.map((k) => ({ k, s: items.get(k).get(rid) })).sort((a, b) => a.s - b.s);
    const ranks = {};
    let i = 0;
    while (i < pairs.length) {
      let j = i;
      while (j + 1 < pairs.length && pairs[j + 1].s === pairs[i].s) j++;
      const avg = (i + j) / 2 + 1;
      for (let q = i; q <= j; q++) ranks[pairs[q].k] = avg;
      i = j + 1;
    }
    ranksByRater[rid] = ranks;
  }
  const Ri = keys.map((k) => rl.reduce((s, rid) => s + ranksByRater[rid][k], 0));
  const Rbar = Ri.reduce((a, b) => a + b, 0) / n;
  const S = Ri.reduce((acc, r) => acc + (r - Rbar) ** 2, 0);
  return +((12 * S) / (m * m * (n ** 3 - n))).toFixed(3);
}

function pairLessons(lessons, perLessonRatings) {
  const byKey = {}; for (const l of lessons) byKey[`${l.branch}/${l.lessonId}`] = l;
  const paired = [];
  for (const l of lessons) {
    if (l.branch !== 'classic') continue;
    const cId = `classic/${l.lessonId}`, xId = `learn/${l.lessonId}`;
    const cM = vividDensity(joinTurns(byKey[cId]));
    const xL = byKey[xId];
    paired.push({
      lessonId: l.lessonId,
      classic: { id: cId, density: cM.density, ratings: perLessonRatings ? perLessonRatings[cId] || null : null },
      learn: xL ? { id: xId, density: vividDensity(joinTurns(xL)).density, ratings: perLessonRatings ? perLessonRatings[xId] || null : null } : null
    });
  }
  return paired;
}
function lessonPassed(p) {
  if (!p.learn) return { densityOK: false, likertOK: null, dPct: 0 };
  const dPct = p.classic.density > 0
    ? ((p.learn.density - p.classic.density) / p.classic.density) * 100
    : (p.learn.density > 0 ? Infinity : 0);
  let likertOK = null;
  if (p.classic.ratings && p.learn.ratings) {
    const axes = ['curiosity', 'metacognition', 'active_learning'];
    const deltas = axes.map((ax) => (p.learn.ratings[ax] != null && p.classic.ratings[ax] != null) ? p.learn.ratings[ax] - p.classic.ratings[ax] : null).filter((v) => v != null);
    likertOK = deltas.length ? (deltas.reduce((a, b) => a + b, 0) / deltas.length) >= 1.0 : null;
  }
  return { densityOK: dPct >= 15, likertOK, dPct: +dPct.toFixed(1) };
}

function main() {
  const args = parseArgs(process.argv);
  const corpusDir = path.resolve(args.corpus);
  if (!fs.existsSync(corpusDir)) { process.stderr.write(`[fatal] corpus not found: ${corpusDir}\n`); process.exit(2); }
  const classic = loadLessons(corpusDir, 'classic');
  const learn = loadLessons(corpusDir, 'learn');
  const all = [...classic, ...learn];

  const cMeans = classic.map((l) => vividDensity(joinTurns(l)).density);
  const lMeans = learn.map((l) => vividDensity(joinTurns(l)).density);
  const avg = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
  const classicMean = avg(cMeans), learnMean = avg(lMeans);
  const deltaPct = classicMean > 0 ? ((learnMean - classicMean) / classicMean) * 100 : null;

  const panels = loadRatings(corpusDir);
  let likert = null, agreement = null, perLessonRatings = null;
  if (!panels) {
    process.stderr.write('[warn] no ratings yet — run human rating phase\n');
  } else {
    const allRows = [].concat(...Object.values(panels));
    perLessonRatings = meanByLessonAxis(allRows);
    likert = axisDeltas(perLessonRatings);
    agreement = {};
    for (const [p, rows] of Object.entries(panels)) agreement[p] = kendallW(rows);
  }

  const paired = pairLessons(all, perLessonRatings);
  const perLesson = paired.map((p) => ({ lessonId: p.lessonId, ...lessonPassed(p) }));
  const passing = perLesson.filter((r) => r.likertOK == null ? r.densityOK : (r.densityOK && r.likertOK)).length;
  const likertPass = likert ? Object.values(likert).every((v) => v.delta != null && v.delta >= 1.0) : null;
  const densityPass = deltaPct != null && deltaPct >= 15;
  const eightPass = passing >= 8;
  const overall = (likertPass !== false) && densityPass && eightPass;

  const report = {
    corpus_size: { classic: classic.length, learn: learn.length },
    vivid_density: {
      classic_mean: +classicMean.toFixed(4),
      learn_mean: +learnMean.toFixed(4),
      delta_pct: deltaPct != null ? +deltaPct.toFixed(1) : null
    },
    likert,
    rater_agreement_W: agreement,
    per_lesson: perLesson,
    pass_criterion: {
      'likert_rise_>=1pt': likertPass == null ? 'N/A' : (likertPass ? 'PASS' : 'FAIL'),
      'density_rise_>=15pct': densityPass ? 'PASS' : 'FAIL',
      'ge_8_of_10_lessons_passing': eightPass ? 'PASS' : 'FAIL',
      OVERALL: overall ? 'PASS' : 'FAIL'
    }
  };

  fs.writeFileSync(path.resolve(args.out), JSON.stringify(report, null, 2));
  const lines = [
    `corpus: classic=${report.corpus_size.classic} learn=${report.corpus_size.learn}`,
    `vivid-density classic=${report.vivid_density.classic_mean}  learn=${report.vivid_density.learn_mean}  Δ=${report.vivid_density.delta_pct ?? 'n/a'}%`
  ];
  if (likert) for (const [ax, v] of Object.entries(likert)) lines.push(`likert ${ax.padEnd(16)} classic=${v.classic ?? 'n/a'}  learn=${v.learn ?? 'n/a'}  Δ=${v.delta ?? 'n/a'}`);
  else lines.push('likert: (no ratings)');
  if (agreement) for (const [p, w] of Object.entries(agreement)) lines.push(`Kendall W ${p}: ${w ?? 'n/a'}`);
  lines.push(`passing lessons: ${passing}/${perLesson.length}`, `OVERALL: ${report.pass_criterion.OVERALL}`);
  process.stdout.write(lines.join('\n') + '\n' + `report → ${path.resolve(args.out)}\n`);
}

if (require.main === module) main();

module.exports = { vividDensity, parseCSV, kendallW, axisDeltas, meanByLessonAxis, loadLessons, loadRatings, lessonPassed };
