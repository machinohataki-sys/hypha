// V0.5 E0 D10 — evaluation pipeline orchestrator
//
// Banner:
//   AUTHOR_GROUND_VS_WOLF_BASELINE_κ — sanity check pipeline, NOT human IRR.
//
// Sequence:
//   1. wolf-rater rater_b (skipped if all sidecars present)
//   2. synthesize rater_a from features_hit_truth (AUTHOR_GROUND_TRUTH; calibration only)
//   3. compute-kappa <topic>
//   4. run-f1 <topic> --truth-source=rater
//
// Output:
//   vault/.evaluator/runs/d10-<YYYY-MM-DD>.json — captured stdout per step + summary
//
// Run:
//   node app/scripts/run-evaluation-d10.js [--topic=philosophy]
//
// Exit codes:
//   0 — pipeline ran without crash (numbers advisory; substandard κ/F1 do NOT fail D10)
//   1 — crash / spawn failure / IO failure
//   2 — usage error
//
// Created 2026-05-10 D10 by Machino-C. NOT touched by Machino-A/B (file-disjoint).

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const VAULT_ROOT = process.env.HYPHA_VAULT_DIR || path.join(__dirname, '..', '..', 'vault');
const RUNS_DIR = path.join(VAULT_ROOT, '.evaluator', 'runs');
const SCRIPTS_DIR = __dirname;

const BANNER = '============================================================\n' +
               '  AUTHOR_GROUND_VS_WOLF_BASELINE_κ — sanity check pipeline,\n' +
               '  NOT human inter-rater reliability.\n' +
               '  rater_a = AUTHOR_GROUND_TRUTH (synthetic from features_hit_truth)\n' +
               '  rater_b = WOLF_RATER_BASELINE (synthetic LLM judge)\n' +
               '  Numbers are advisory pipeline-sanity checks.\n' +
               '============================================================';

function _parseArgs(argv) {
  const args = { topic: 'philosophy', help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--topic=')) args.topic = a.slice('--topic='.length);
  }
  return args;
}

function _printHelp() {
  console.log(`
D10 evaluation pipeline orchestrator

Usage:
  node app/scripts/run-evaluation-d10.js [--topic=philosophy]

Steps (sequential):
  1. wolf-rater.js --rater=b   (synthetic LLM rater_b)
  2. synth rater_a from features_hit_truth (AUTHOR_GROUND_TRUTH sidecars)
  3. compute-kappa.js
  4. run-f1.js --truth-source=rater

Output:
  vault/.evaluator/runs/d10-<date>.json (captured stdout + summary)
`);
}

function _spawnNode(scriptName, scriptArgs, stepLabel) {
  return new Promise((resolve) => {
    const scriptPath = path.join(SCRIPTS_DIR, scriptName);
    const proc = spawn(process.execPath, [scriptPath, ...scriptArgs], {
      cwd: path.join(__dirname, '..', '..'),
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { const s = d.toString(); stdout += s; process.stdout.write(s); });
    proc.stderr.on('data', d => { const s = d.toString(); stderr += s; process.stderr.write(s); });
    proc.on('error', err => {
      resolve({ step: stepLabel, script: scriptName, args: scriptArgs, exitCode: -1, error: err.message, stdout, stderr });
    });
    proc.on('close', code => {
      resolve({ step: stepLabel, script: scriptName, args: scriptArgs, exitCode: code, stdout, stderr });
    });
  });
}

// Step 2: synthesize rater_a from features_hit_truth.
// Marks each sidecar as AUTHOR_GROUND_TRUTH for downstream κ interpretation.
function _synthesizeAuthorRaterA(topic) {
  const dir = path.join(VAULT_ROOT, '.evaluator', 'golden', topic);
  if (!fs.existsSync(dir)) {
    return { step: 'synth-rater-a', error: `golden directory missing: ${dir}` };
  }
  const files = fs.readdirSync(dir).filter(f =>
    f.endsWith('.json') && !f.startsWith('_') && !f.includes('.rater-')
  );
  let written = 0;
  let skipped = 0;
  const errors = [];
  for (const f of files) {
    let item;
    try { item = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
    catch (err) { errors.push(`${f}: parse error ${err.message}`); continue; }
    if (!item.id) { errors.push(`${f}: missing id`); continue; }
    const sidecarPath = path.join(dir, `${item.id}.rater-a.json`);
    if (fs.existsSync(sidecarPath)) {
      // Respect existing rater_a (could be real human label)
      skipped++;
      continue;
    }
    const ratings = {};
    for (const cand of (item.candidate_responses || [])) {
      const truth = Array.isArray(cand.features_hit_truth) ? cand.features_hit_truth.slice() : [];
      ratings[cand.id] = {
        features_hit: truth,
        verdict: truth.length >= item.k_threshold ? 'pass' : 'fail',
        justification: 'AUTHOR_GROUND_TRUTH (synthesized from features_hit_truth, calibration only)',
        ts: new Date().toISOString(),
      };
    }
    const sidecar = {
      rater_id: 'a',
      name: 'author_ground_truth',
      ts: new Date().toISOString(),
      ratings,
      author_ground_truth: true,
      synthesized_from: 'features_hit_truth',
      note: 'AUTHOR_GROUND_TRUTH — calibration baseline ONLY. NOT a human rater. Real human labels (when collected) MUST overwrite this sidecar.',
    };
    const tmp = `${sidecarPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(sidecar, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, sidecarPath);
    written++;
  }
  return { step: 'synth-rater-a', written, skipped, errors };
}

function _writeSummary(topic, steps) {
  if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const out = {
    topic,
    ts: new Date().toISOString(),
    banner: 'AUTHOR_GROUND_VS_WOLF_BASELINE_κ',
    note: 'rater_a = AUTHOR_GROUND_TRUTH; rater_b = WOLF_RATER_BASELINE. Numbers advisory.',
    steps,
  };
  const filePath = path.join(RUNS_DIR, `d10-${date}.json`);
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
  return filePath;
}

async function main() {
  const args = _parseArgs(process.argv);
  if (args.help) { _printHelp(); return; }

  console.log(BANNER);
  console.log(`[run-d10] topic=${args.topic}`);

  const steps = [];

  // Step 1: wolf-rater rater_b
  console.log('\n[run-d10] step 1/4 — wolf-rater rater_b');
  const step1 = await _spawnNode('wolf-rater.js', [args.topic, '--rater=b'], 'wolf-rater-b');
  steps.push(step1);
  if (step1.exitCode !== 0) {
    console.warn(`[run-d10] step 1 exit ${step1.exitCode} — continuing (advisory pipeline).`);
  }

  // Step 2: synthesize rater_a from features_hit_truth
  console.log('\n[run-d10] step 2/4 — synth rater_a from features_hit_truth');
  const step2 = _synthesizeAuthorRaterA(args.topic);
  steps.push(step2);
  console.log(`[run-d10] synth: written=${step2.written} skipped=${step2.skipped} errors=${(step2.errors || []).length}`);
  if (step2.error) {
    console.error(`[run-d10] step 2 fatal: ${step2.error}`);
    const summaryPath = _writeSummary(args.topic, steps);
    console.error(`[run-d10] summary: ${summaryPath}`);
    process.exit(1);
  }

  // Step 3: compute-kappa
  console.log('\n[run-d10] step 3/4 — compute-kappa');
  const step3 = await _spawnNode('compute-kappa.js', [args.topic], 'compute-kappa');
  steps.push(step3);

  // Step 4: run-f1 --truth-source=rater
  console.log('\n[run-d10] step 4/4 — run-f1 --truth-source=rater');
  const step4 = await _spawnNode('run-f1.js', [args.topic, '--truth-source=rater'], 'run-f1-rater');
  steps.push(step4);

  const summaryPath = _writeSummary(args.topic, steps);
  console.log('---');
  console.log(BANNER);
  console.log(`[run-d10] summary: ${summaryPath}`);
  console.log('[run-d10] reminder: numbers advisory; substandard κ/F1 do NOT fail D10. Pipeline-sanity only.');
  process.exit(0);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[run-d10] error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main, _synthesizeAuthorRaterA };
