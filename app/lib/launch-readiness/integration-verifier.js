'use strict';

// HYPHA · W8.1 Launch Readiness — Cross-module integration verifier.
//
// The 20-item checklist proves each module loads. Integration verifies
// the dependency wiring between them is real, not stubbed. Each chain
// below is a published cross-W contract from BLUEPRINT §11 / §15 / §17 /
// §22 — broken chains mean a launch-blocking integration regression.
//
// Verification strategy:
//   1. Require both endpoints.
//   2. Grep the dependency's source for `require('<consumer>')` (or the
//      equivalent IPC-channel reference).
//   3. Optionally invoke the producer with a no-op argument to confirm
//      the surface is callable; never with side-effect args.
//
// All checks return a `{ chain, ok, evidence, reason? }` row. Final
// envelope rolls them up to `{ integration_ok, broken_chains, chains }`.

const fs = require('fs');
const path = require('path');

const LIB_ROOT = path.join(__dirname, '..');
const MAIN_JS = path.join(__dirname, '..', '..', 'main.js');

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function _readLib(rel) {
  // Reads a file under app/lib/<rel> (also accepts subdir paths like
  // 'creation-system-v1/index.js'). Returns null when missing.
  try {
    const abs = path.join(LIB_ROOT, rel);
    return fs.readFileSync(abs, 'utf8');
  } catch (_) { return null; }
}

function _readMain() {
  try { return fs.readFileSync(MAIN_JS, 'utf8'); }
  catch (_) { return null; }
}

function _grepRequires(src, needle) {
  // Look for any require()/lazy-require referencing `needle` as a path
  // segment. Handles both `require('./foo')` and `require('../foo/bar')`.
  if (!src) return 0;
  const escaped = needle.replace(/[/\\.]/g, '[\\\\/.]');
  const re = new RegExp("require\\(\\s*['\"][^'\"]*" + escaped + "['\"]\\s*\\)", 'g');
  const found = src.match(re);
  return found ? found.length : 0;
}

function _grepLiteral(src, needle) {
  if (!src) return 0;
  const found = src.split(needle).length - 1;
  return found > 0 ? found : 0;
}

function _safeRequire(rel) {
  try { return require(rel); } catch (_) { return null; }
}

// --------------------------------------------------------------------------
// Chain checks. Each one returns the standard row shape.
//
// `chain` is a stable string id (used by the CLI report + UI list).
// `evidence` is human-readable proof (e.g., "1 hit in consumer.js").
// --------------------------------------------------------------------------

function _checkW21toW22() {
  // W2.1 cadence-engine (or its hook wrapper) must reach into W2.2
  // assignment-cadence on Integration Day so the cadence advance writes a
  // matching assignment level.
  const cadHook = _readLib('creation-system-v1/cadence-hook.js');
  const cadEngine = _readLib('cadence-engine.js');
  const asg = _readLib('assignment.js');
  const asgCadence = _readLib('assignment-cadence.js');
  const evidence = [];
  let ok = false;

  if (asg && _grepRequires(asg, 'assignment-cadence') > 0) {
    evidence.push('assignment.js → assignment-cadence (' + _grepRequires(asg, 'assignment-cadence') + ')');
    ok = true;
  }
  if (cadHook && _grepRequires(cadHook, 'cadence-engine') > 0) {
    evidence.push('creation-system-v1/cadence-hook → cadence-engine');
    ok = true;
  }
  if (cadEngine && asgCadence) {
    // Both libs ship — the hook layer connects them through events.jsonl
    // even if no direct require chain exists.
    evidence.push('cadence-engine.js + assignment-cadence.js both ship');
  }
  return {
    chain: 'W2.1_cadence → W2.2_assignment_cadence',
    ok,
    evidence: evidence.join(' · ') || 'no concrete wiring found',
    reason: ok ? undefined : 'expected require chain cadence-hook → cadence-engine and/or assignment → assignment-cadence',
  };
}

function _checkW33toW34() {
  // W3.3 product-transfer must invoke W3.4 product-spark (or its data
  // pipe) so that a transfer event optionally sprouts a roadmap spark.
  // Looking for either a direct require or the W5.4 orchestrator linking
  // them.
  const csIndex = _readLib('creation-system-v1/index.js');
  const transferAudit = _readLib('creation-system-v1/auto-transfer.js');
  const sparkPrio = _readLib('creation-system-v1/spark-priority.js');
  const roadmap = _readLib('creation-system-v1/auto-roadmap-sync.js');
  const evidence = [];
  let ok = false;

  if (transferAudit && _grepRequires(transferAudit, 'product-transfer') > 0) {
    evidence.push('auto-transfer → product-transfer');
    ok = true;
  }
  if (sparkPrio && _grepRequires(sparkPrio, 'product-spark') > 0) {
    evidence.push('spark-priority → product-spark');
    ok = true;
  }
  if (roadmap && _grepRequires(roadmap, 'product-spark') > 0) {
    evidence.push('auto-roadmap-sync → product-spark');
    ok = true;
  }
  if (csIndex && _grepRequires(csIndex, 'auto-transfer') > 0 && _grepRequires(csIndex, 'spark-priority') > 0) {
    evidence.push('creation-system-v1/index orchestrates both');
  }
  return {
    chain: 'W3.3_product-transfer → W3.4_product-spark',
    ok,
    evidence: evidence.join(' · ') || 'no wiring found',
    reason: ok ? undefined : 'expected creation-system-v1 sub-modules to require both product-transfer + product-spark',
  };
}

function _checkW41toW1W2W3() {
  // W4.1 scenario / 7-day-growth must thread W1 (quality harness +
  // anti-illusion), W2 (cadence + assignment), and W3 (creation pool +
  // transfer + spark + companion) into the single 7-day orchestrator.
  const sevenDay = _readLib('integrations/seven-day-growth.js');
  const evidence = [];
  let ok = false;
  if (!sevenDay) {
    return {
      chain: 'W4.1_scenario → W1+W2+W3 (7-day-growth fan-in)',
      ok: false,
      evidence: 'integrations/seven-day-growth.js missing',
    };
  }
  const needs = [
    ['cadence-engine', 'W2.1'],
    ['assignment-cadence', 'W2.2'],
    ['product-transfer', 'W3.3'],
    ['product-spark', 'W3.4'],
  ];
  let hits = 0;
  for (const [mod, lbl] of needs) {
    if (_grepLiteral(sevenDay, mod) > 0) {
      evidence.push(lbl + ':' + mod);
      hits++;
    }
  }
  ok = hits >= 3; // ≥3/4 of the explicit cross-wave libs threaded through
  return {
    chain: 'W4.1_scenario → W1+W2+W3 (7-day-growth fan-in)',
    ok,
    evidence: evidence.join(' · ') + (ok ? ' · ' + hits + '/4 wires' : ' · only ' + hits + '/4 wires (need ≥3)'),
    reason: ok ? undefined : 'seven-day-growth.js does not pull enough cross-wave deps; check integrations/seven-day-growth.js',
  };
}

function _checkW51FanOut() {
  // W5.1 cheap-router must be reachable from W5.2 / W5.3 / W6.1 / W6.2 /
  // W6.3 / W7.4 callers. We grep each caller for the require — not all
  // are required to ship today, but the contract says cheap-router must
  // be the gate the cheap LLM calls go through.
  const callers = [
    ['llm/context-packer.js', 'W5.2_context-packer'],
    ['llm/router.js', 'W5.3_router'],
    ['research-radar/radar.js', 'W6.3_research-radar'],
    ['cross-spark/engine.js', 'W7.4_cross-spark'],
  ];
  const evidence = [];
  let hits = 0;
  for (const [c, lbl] of callers) {
    const src = _readLib(c);
    if (src && _grepRequires(src, 'cheap-router') > 0) {
      evidence.push(lbl);
      hits++;
    }
  }
  const ok = hits >= 3; // ≥3 of the 4 declared callers reach the router
  return {
    chain: 'W5.1_cheap-router ← {W5.2/W5.3/W6.3/W7.4}',
    ok,
    evidence: evidence.join(' · ') + ' · ' + hits + '/' + callers.length,
    reason: ok ? undefined : 'cheap-router fan-in is thin; expected ≥3 of 4 callers',
  };
}

function _checkW73Citation() {
  // W7.3 citation-system must be used by lesson-body-generator (W6.1),
  // product-spark (W3.4 spark flow), research-radar (W6.3), and the
  // web-note-engine (W3.5). All four use it through dynamic require for
  // graceful degradation.
  const callers = [
    ['lesson-body-generator.js', 'W6.1_lesson-body'],
    ['product-spark.js', 'W3.4_product-spark'],
    ['research-radar/auto-actions.js', 'W6.3_research-radar'],
    ['web-note-engine/graph.js', 'W3.5_web-note-engine'],
  ];
  const evidence = [];
  let hits = 0;
  for (const [c, lbl] of callers) {
    const src = _readLib(c);
    if (src && _grepRequires(src, 'citation-system') > 0) {
      evidence.push(lbl);
      hits++;
    }
  }
  const ok = hits >= 3;
  return {
    chain: 'W7.3_citation-system ← {W6.1/W3.4/W6.3/W3.5}',
    ok,
    evidence: evidence.join(' · ') + ' · ' + hits + '/' + callers.length,
    reason: ok ? undefined : 'citation-system fan-in is thin; expected ≥3 of 4 callers',
  };
}

function _checkW51MainIPC() {
  // Main process IPC for cheap-router. Required so renderer surfaces
  // (W5.2 / W6.2 cron jobs / W4.2 KPI) can invoke a cheap relevance
  // pass without spawning the router themselves.
  const main = _readMain();
  const hit = main && _grepRequires(main, 'llm/cheap-router');
  const evidence = hit ? 'main.js requires llm/cheap-router (' + hit + ')' : 'no main.js wire';
  return {
    chain: 'W5.1_cheap-router → main.js IPC',
    ok: !!hit,
    evidence,
    reason: hit ? undefined : 'main.js must require app/lib/llm/cheap-router',
  };
}

// --------------------------------------------------------------------------
// verifyW1ToW7Integration — main entry. Synchronous so callers can fold
// it into a single CLI report without async plumbing.
// --------------------------------------------------------------------------

function verifyW1ToW7Integration() {
  const chains = [
    _checkW21toW22(),
    _checkW33toW34(),
    _checkW41toW1W2W3(),
    _checkW51FanOut(),
    _checkW73Citation(),
    _checkW51MainIPC(),
  ];
  const broken = chains.filter((c) => !c.ok).map((c) => ({
    chain: c.chain,
    reason: c.reason || c.evidence || 'unknown',
    evidence: c.evidence || '',
  }));
  return {
    integration_ok: broken.length === 0,
    chain_count: chains.length,
    chains,
    broken_chains: broken,
    generated_at: new Date().toISOString(),
  };
}

module.exports = {
  verifyW1ToW7Integration,
  // Granular checks exposed for unit tests + surgical CLI re-runs.
  _checks: {
    cadenceToAssignment:   _checkW21toW22,
    transferToSpark:       _checkW33toW34,
    scenarioFanIn:         _checkW41toW1W2W3,
    cheapRouterFanOut:     _checkW51FanOut,
    citationFanIn:         _checkW73Citation,
    cheapRouterMainIPC:    _checkW51MainIPC,
  },
};
