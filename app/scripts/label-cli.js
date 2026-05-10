// V0.5 E0 — HITL labeling CLI for golden-set items
//
// Walks unlabeled or partially-labeled items in vault/.evaluator/golden/<topic>/.
// Prompts verdict (pass/fail/unclear) + justification + rater-id. Writes back to JSON.
//
// Run:
//   node app/scripts/label-cli.js philosophy --rater=a
//   node app/scripts/label-cli.js philosophy --rater=b
//   node app/scripts/label-cli.js --help
//
// Created 2026-05-10 on v0.5-substrate.

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const VAULT_ROOT = process.env.HYPHA_VAULT_DIR || path.join(__dirname, '..', '..', 'vault');
const VALID_VERDICTS = new Set(['pass', 'fail', 'unclear']);
const VALID_RATERS = new Set(['a', 'b']);

function _printHelp() {
  console.log(`
HITL labeling CLI for V0.5 golden-set items.

Usage:
  node app/scripts/label-cli.js <topic> --rater=<a|b> [--limit=<n>]
  node app/scripts/label-cli.js --help

Examples:
  node app/scripts/label-cli.js philosophy --rater=a
  node app/scripts/label-cli.js philosophy --rater=b --limit=5

Behavior:
  - Lists items in vault/.evaluator/golden/<topic>/*.json that are missing the chosen rater's verdict.
  - For each item, prints the instance prompt + syllabus_anchor.
  - Prompts: verdict (pass/fail/unclear), justification (one line). Empty input skips the item.
  - Writes rater_a or rater_b field. When both raters present, computes agreement boolean.
  - Idempotent: re-running on already-rated items skips them by default.

Lifecycle:
  - All seeded items start as lifecycle='draft'.
  - When both raters agree AND user runs ratify command (separate, future Day 6): lifecycle becomes 'ratified'.
  - Items disagreed by raters stay 'draft' until a 3rd rater or revision adjudicates.

IRR-before-F1 rule:
  - Run app/scripts/compute-kappa.js <topic> after each labeling session.
  - F1 harness (Day 4-5) refuses to run on a topic with kappa < 0.7.
`);
}

function _parseArgs(argv) {
  const args = { topic: null, rater: null, limit: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--rater=')) args.rater = a.slice('--rater='.length);
    else if (a.startsWith('--limit=')) args.limit = Number(a.slice('--limit='.length));
    else if (!args.topic && !a.startsWith('--')) args.topic = a;
  }
  return args;
}

function _listItems(topic) {
  const dir = path.join(VAULT_ROOT, '.evaluator', 'golden', topic);
  if (!fs.existsSync(dir)) {
    console.error(`[label-cli] golden directory missing: ${dir}`);
    return null;
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  return files.map(f => {
    const fullPath = path.join(dir, f);
    let obj;
    try {
      obj = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch (err) {
      console.warn(`[label-cli] skip malformed ${f}: ${err.message}`);
      return null;
    }
    return { fullPath, obj };
  }).filter(Boolean);
}

async function _promptOne(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, (ans) => resolve(ans)));
}

async function main() {
  const args = _parseArgs(process.argv);
  if (args.help) {
    _printHelp();
    return;
  }
  if (!args.topic) {
    console.error('[label-cli] topic required. Try --help.');
    process.exit(2);
  }
  if (!args.rater || !VALID_RATERS.has(args.rater)) {
    console.error(`[label-cli] --rater=a or --rater=b required.`);
    process.exit(2);
  }

  const items = _listItems(args.topic);
  if (!items) process.exit(2);

  const raterField = `rater_${args.rater}`;
  const todo = items.filter(({ obj }) => !obj[raterField] || !VALID_VERDICTS.has(obj[raterField].verdict));

  if (todo.length === 0) {
    console.log(`[label-cli] all ${items.length} item(s) already have rater_${args.rater} verdict.`);
    return;
  }

  const limit = args.limit || todo.length;
  const slice = todo.slice(0, limit);

  console.log(`[label-cli] topic=${args.topic} rater=${args.rater}`);
  console.log(`[label-cli] ${slice.length} item(s) to label (of ${todo.length} pending, ${items.length} total)`);
  console.log('[label-cli] empty input skips an item; Ctrl+C exits.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let labeledCount = 0;
  for (const { fullPath, obj } of slice) {
    console.log('---');
    console.log(`id: ${obj.id}`);
    console.log(`syllabus_anchor: ${obj.syllabus_anchor || '(none)'}`);
    console.log(`instance: ${obj.instance}`);
    console.log(`verification_channel: ${obj.verification_channel}`);
    if (obj.verification_channel === 'sealed_rubric') {
      console.log(`answer_key_hash (first 16): ${obj.answer_key_hash ? obj.answer_key_hash.slice(0, 16) : '(missing)'}`);
    }

    const verdict = (await _promptOne(rl, `verdict (pass/fail/unclear, blank=skip): `)).trim().toLowerCase();
    if (!verdict) { console.log('[label-cli] skipped\n'); continue; }
    if (!VALID_VERDICTS.has(verdict)) {
      console.warn(`[label-cli] invalid verdict "${verdict}", skipping`);
      continue;
    }
    const justification = (await _promptOne(rl, `justification (1 line): `)).trim();
    const name = (await _promptOne(rl, `rater name (default ${args.rater === 'a' ? 'founder' : 'rater_b'}): `)).trim() || (args.rater === 'a' ? 'founder' : 'rater_b');

    obj[raterField] = { name, verdict, justification, ts: new Date().toISOString() };

    if (obj.rater_a && obj.rater_b && VALID_VERDICTS.has(obj.rater_a.verdict) && VALID_VERDICTS.has(obj.rater_b.verdict)) {
      obj.agreement = obj.rater_a.verdict === obj.rater_b.verdict;
    }

    fs.writeFileSync(fullPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    labeledCount++;
    console.log(`[label-cli] saved rater_${args.rater} for ${obj.id}\n`);
  }

  rl.close();
  console.log(`[label-cli] done. labeled ${labeledCount} item(s).`);
  console.log(`[label-cli] next step: node app/scripts/compute-kappa.js ${args.topic}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[label-cli] error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
