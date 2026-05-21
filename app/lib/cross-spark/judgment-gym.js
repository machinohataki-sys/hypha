'use strict';

// HYPHA · W7.4 Judgment Gym — paired-comparison训练场.
//
// Per BLUEPRINT.md §14.4: "训练比较 2 个产品方案 / 2 个 Agent 架构 / 2 个
// Lesson / 2 个 Pack / 2 种解释, 训练标准 / 品味 / 取舍 / 判断力."
//
// What a "judgment exercise" is:
//   The system presents two options A and B together with shared context.
//   The user submits a judgment: which one they pick (or "neither/both"),
//   what dimensions they used, and the weight they put on each dimension.
//   The gym scores the judgment along four learned metrics:
//     standard / taste / tradeoff / judgment
//   and stores the result so the user (and later, sub-agents) can review
//   their own trajectory.
//
// Public surface:
//   createJudgmentExercise({ type, optionA, optionB, context, slug })
//                                  → exercise object
//   submitJudgment(exerciseId, userJudgment, opts?)
//                                  → { score, analysis }
//   getJudgmentHistory(slug)       → exercise records
//   EXERCISE_TYPES                 — 5-tuple constant
//
// Persistence: vault/<slug>/growth/judgment-gym.jsonl — append-only with
// rows of {kind: 'exercise'|'submission', ...}. Exercises persist before
// submission so a partially completed gym round can resume after restart.
//
// LLM tier: §14.4 places the analysis step in T6_STRONG. We expose
// `_analyseJudgment` as the hookup point and provide a deterministic
// mock so the rest of the W7.4 stream can be developed offline.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Soft requires.
let _events = null;
try { _events = require('../events'); } catch (_) { _events = null; }

// ----------------------------------------------------------------------
// Schema constants.
// ----------------------------------------------------------------------

const EXERCISE_TYPES = Object.freeze([
  'product_proposals',
  'agent_architectures',
  'lessons',
  'packs',
  'explanations',
]);

// Each type maps to a default dimension set that the user can override.
// These are the "ruler marks" along which paired options get compared.
const _DEFAULT_DIMENSIONS = Object.freeze({
  product_proposals:   ['用户价值', '可落地', '差异化', '6 周可 ship', 'kill criteria 清晰'],
  agent_architectures: ['可解释', '成本', '失败模式', '可扩展', '可观测'],
  lessons:             ['GOAL BINDING', 'FEYNMAN TEST', '叙事节奏', '诚实度', '后续可深入'],
  packs:               ['source 可信', '知识密度', '判别度', '可被引用', 'license 干净'],
  explanations:        ['cause→effect 链', '反例呈现', '8 岁可读', '不省略难点', '可被反驳'],
});

// Score metric labels (BLUEPRINT §14.4).
const JUDGMENT_METRICS = Object.freeze(['standard', 'taste', 'tradeoff', 'judgment']);

// ----------------------------------------------------------------------
// Persistence.
// ----------------------------------------------------------------------

function _vaultRoot() {
  if (process.env.HYPHA_VAULT_DIR && fs.existsSync(process.env.HYPHA_VAULT_DIR)) {
    return process.env.HYPHA_VAULT_DIR;
  }
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) {
    return process.env.HYPHA_DATA;
  }
  return path.join(__dirname, '..', '..', '..', 'vault');
}

function _historyPath(slug) {
  return path.join(_vaultRoot(), String(slug || '_orphan'), 'growth', 'judgment-gym.jsonl');
}

function _ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function _append(slug, row) {
  try {
    const p = _historyPath(slug);
    _ensureDir(path.dirname(p));
    fs.appendFileSync(p, JSON.stringify(row) + '\n', 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function _readAll(slug) {
  const p = _historyPath(slug);
  if (!fs.existsSync(p)) return [];
  const rows = [];
  const text = fs.readFileSync(p, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch (_) { /* skip */ }
  }
  return rows;
}

// ----------------------------------------------------------------------
// Validation.
// ----------------------------------------------------------------------

function _assertOption(label, o) {
  if (!o || typeof o !== 'object') {
    throw new Error(`${label} required (object with at least a title field)`);
  }
  if (!o.title || typeof o.title !== 'string') {
    throw new Error(`${label}.title required (non-empty string)`);
  }
}

// ----------------------------------------------------------------------
// Public — createJudgmentExercise
// ----------------------------------------------------------------------

function createJudgmentExercise({ type, optionA, optionB, context, slug, dimensions } = {}) {
  if (!EXERCISE_TYPES.includes(type)) {
    throw new Error(`type must be one of ${EXERCISE_TYPES.join('|')}`);
  }
  _assertOption('optionA', optionA);
  _assertOption('optionB', optionB);

  const ts = new Date().toISOString();
  const stub = crypto
    .createHash('sha256')
    .update(`${type}|${optionA.title}|${optionB.title}|${ts}`)
    .digest('hex')
    .slice(0, 8);
  const id = `jgm-${ts.replace(/[-:.TZ]/g, '').slice(0, 14)}-${stub}`;

  // Snapshot the options so mutating them after creation cannot rewrite
  // the historical exercise. Match how product-spark stores transitions.
  const exercise = {
    id,
    ts,
    slug: slug || null,
    type,
    optionA: {
      title: optionA.title,
      body: optionA.body || '',
      meta: optionA.meta || null,
    },
    optionB: {
      title: optionB.title,
      body: optionB.body || '',
      meta: optionB.meta || null,
    },
    context: context || '',
    dimensions: Array.isArray(dimensions) && dimensions.length > 0
      ? dimensions.slice(0, 8)
      : _DEFAULT_DIMENSIONS[type].slice(),
    state: 'awaiting',   // awaiting | submitted | scored
  };

  if (slug) {
    _append(slug, { kind: 'exercise', ...exercise });
    if (_events && typeof _events.write === 'function') {
      try {
        _events.write(slug, {
          type: 'growth:judgment_exercise:created',
          exercise_id: id,
          exercise_type: type,
        });
      } catch (_) { /* graceful */ }
    }
  }
  return exercise;
}

// ----------------------------------------------------------------------
// Scoring — deterministic mock + reasoning trace.
//
// Inputs:
//   exercise (the created object)
//   userJudgment = {
//     pick: 'A' | 'B' | 'both' | 'neither',
//     reasoning: string,
//     dimensions_used: string[],   // subset of exercise.dimensions
//     weights?: { [dim]: number }, // optional explicit weighting
//   }
//
// Output:
//   {
//     score: { standard, taste, tradeoff, judgment }  // 0..1
//     analysis: {
//       called_out_dimensions: string[],
//       missed_dimensions: string[],
//       reasoning_quality: 0..1,
//       narrative: string,
//     }
//   }
//
// We score on signals the user actually produced — no truth answer is
// required, the gym trains the *process* of comparison, not the *answer*.
// ----------------------------------------------------------------------

function _analyseJudgment(exercise, userJudgment) {
  const dims = exercise.dimensions || [];
  const usedRaw = Array.isArray(userJudgment.dimensions_used) ? userJudgment.dimensions_used : [];
  const used = usedRaw.filter((d) => dims.includes(d));
  const missed = dims.filter((d) => !used.includes(d));
  const reasoning = String(userJudgment.reasoning || '');

  // standard — did the user articulate the dimensions the gym proposed?
  const standard = dims.length === 0 ? 0 : Math.min(1, used.length / Math.max(3, dims.length));

  // taste — did the user pick (not punt to 'both' / 'neither' without articulating tradeoff)?
  let taste = 0;
  if (userJudgment.pick === 'A' || userJudgment.pick === 'B') taste = 0.8;
  else if (userJudgment.pick === 'both' || userJudgment.pick === 'neither') {
    // 'both' or 'neither' is acceptable IF reasoning explains the punt.
    taste = reasoning.length >= 80 ? 0.6 : 0.2;
  }

  // tradeoff — did the user name what they gave up by choosing?
  const tradeoffSignal = /(but|代价|trade|放弃|换走|cost|less|缺|牺牲)/i.test(reasoning);
  const tradeoff = tradeoffSignal ? 0.9 : 0.3;

  // judgment — composite signal: reasoning length + dimension coverage + tradeoff named.
  const reasoningQuality = Math.min(1, reasoning.length / 200);
  const judgment = Math.min(1, 0.4 * standard + 0.25 * taste + 0.25 * tradeoff + 0.1 * reasoningQuality);

  const score = {
    standard: Number(standard.toFixed(2)),
    taste: Number(taste.toFixed(2)),
    tradeoff: Number(tradeoff.toFixed(2)),
    judgment: Number(judgment.toFixed(2)),
  };

  // Narrative — short, plain prose. Hand-written templates, no SaaS gushing.
  let narrative;
  if (judgment >= 0.75) {
    narrative = '判断有立场, 标准被明确写出, 取舍点也提到了 — 这是这个训练真正想培养的反应。继续做下一题, 把 missed dimensions 也补上。';
  } else if (judgment >= 0.45) {
    narrative = '主框架立住了, 但还有 dimensions 没被点到, 或取舍点没被命名。下一轮试着把"放弃了什么"也写出来 — 真正的判断力体现在那一句。';
  } else {
    narrative = '这次判断更偏直觉。把 reasoning 拉到 ≥ 200 字, 把所有 dimensions 都过一遍, 再写下"如果换 6 个月后看, 我还会这么选吗" — 然后重答一次。';
  }

  return {
    score,
    analysis: {
      called_out_dimensions: used,
      missed_dimensions: missed,
      reasoning_quality: Number(reasoningQuality.toFixed(2)),
      narrative,
    },
  };
}

// ----------------------------------------------------------------------
// Public — submitJudgment
// ----------------------------------------------------------------------

function submitJudgment(exerciseId, userJudgment, opts = {}) {
  if (!exerciseId || typeof exerciseId !== 'string') {
    throw new Error('exerciseId required (string)');
  }
  if (!userJudgment || typeof userJudgment !== 'object') {
    throw new Error('userJudgment required (object)');
  }
  if (!['A', 'B', 'both', 'neither'].includes(userJudgment.pick)) {
    throw new Error('userJudgment.pick must be one of A | B | both | neither');
  }

  // Resolve exercise — slug is needed to read history. Caller passes slug
  // through opts; for unbound exercises (no slug at creation), the test
  // surface can pass the exercise object directly via opts.exerciseObject.
  let exercise = null;
  if (opts && opts.exerciseObject && opts.exerciseObject.id === exerciseId) {
    exercise = opts.exerciseObject;
  } else if (opts && opts.slug) {
    const all = _readAll(opts.slug);
    for (const r of all) {
      if (r.kind === 'exercise' && r.id === exerciseId) {
        exercise = r;
        break;
      }
    }
  }
  if (!exercise) {
    throw new Error(`exercise ${exerciseId} not found (pass slug or exerciseObject in opts)`);
  }

  const { score, analysis } = _analyseJudgment(exercise, userJudgment);
  const submission = {
    kind: 'submission',
    id: `${exerciseId}-sub-${Date.now().toString(36)}`,
    exercise_id: exerciseId,
    ts: new Date().toISOString(),
    slug: exercise.slug || null,
    user_judgment: {
      pick: userJudgment.pick,
      reasoning: String(userJudgment.reasoning || ''),
      dimensions_used: Array.isArray(userJudgment.dimensions_used) ? userJudgment.dimensions_used.slice() : [],
      weights: userJudgment.weights && typeof userJudgment.weights === 'object'
        ? { ...userJudgment.weights }
        : null,
    },
    score,
    analysis,
  };

  if (exercise.slug) {
    _append(exercise.slug, submission);
    if (_events && typeof _events.write === 'function') {
      try {
        _events.write(exercise.slug, {
          type: 'growth:judgment_exercise:submitted',
          exercise_id: exerciseId,
          judgment_score: score.judgment,
          pick: userJudgment.pick,
        });
      } catch (_) { /* graceful */ }
    }
  }

  return { ok: true, score, analysis, submission_id: submission.id };
}

// ----------------------------------------------------------------------
// Public — getJudgmentHistory
// ----------------------------------------------------------------------

function getJudgmentHistory(slug) {
  if (!slug) return { exercises: [], submissions: [], stats: null };
  const rows = _readAll(slug);
  const exercises = rows.filter((r) => r.kind === 'exercise');
  const submissions = rows.filter((r) => r.kind === 'submission');

  // Quick rolling stats for a coach surface.
  const last10 = submissions.slice(-10);
  const avgJudgment = last10.length === 0
    ? null
    : Number((last10.reduce((acc, s) => acc + ((s.score && s.score.judgment) || 0), 0) / last10.length).toFixed(2));
  const stats = {
    exercise_count: exercises.length,
    submission_count: submissions.length,
    rolling_judgment_avg: avgJudgment,
  };

  // Newest first.
  exercises.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  submissions.sort((a, b) => (a.ts < b.ts ? 1 : -1));

  return { exercises, submissions, stats };
}

// ----------------------------------------------------------------------
// Exports
// ----------------------------------------------------------------------

module.exports = {
  createJudgmentExercise,
  submitJudgment,
  getJudgmentHistory,
  EXERCISE_TYPES,
  JUDGMENT_METRICS,
  _internals: {
    analyseJudgment: _analyseJudgment,
    historyPath: _historyPath,
    defaultDimensions: _DEFAULT_DIMENSIONS,
  },
};
