#!/usr/bin/env bash
set -e
echo "[repro] V0.5 E0 calibration reproduction"
echo "[repro] expected runtime <30min"
cd "$(dirname "$0")/../../.."
npm install --silent
node app/scripts/seed-llm-systems-golden.js
node app/scripts/run-eval-exec-channel.js llm-systems
node app/scripts/run-mutation-test.js llm-systems
echo "[repro] done — read vault/.evaluator/runs/d20-*.json for output"
echo "[repro] expected F1: 0.9659 (mutation-test) +/- 0.03"
