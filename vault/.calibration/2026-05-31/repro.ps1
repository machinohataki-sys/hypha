$ErrorActionPreference = "Stop"
Write-Host "[repro] V0.5 E0 calibration reproduction"
Write-Host "[repro] expected runtime <30min"
Set-Location (Join-Path $PSScriptRoot "..\..\..")
npm install --silent
node app/scripts/seed-llm-systems-golden.js
node app/scripts/run-eval-exec-channel.js llm-systems
node app/scripts/run-mutation-test.js llm-systems
Write-Host "[repro] done — read vault/.evaluator/runs/d20-*.json"
Write-Host "[repro] expected F1: 0.9659 (mutation-test) +/- 0.03"
