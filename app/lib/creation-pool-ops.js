'use strict';

// HYPHA · W3.1 Creation Pool — CRUD operations on the 4 ledgers
//
// Pure fs. No LLM. Re-uses ./events.js for typed event emission and the
// internal helpers from ./creation-pool.js for path resolution so we never
// drift from the layout defined in creation-pool-schema.js.
//
// Operations:
//   addDecision(slug, decision)
//   addAssumption(slug, assumption)
//   updateAssumptionStatus(slug, id, status, evidence)
//   addKillCriterion(slug, criterion)
//   evaluateKillCriteria(slug, currentMetrics)
//   appendRoadmapSync(slug, weeklyItems)
//
// All mutations require the product to be bound (isProductBound). Otherwise
// returns { ok:false, reason:'not_bound' } — fail fast, never silently create.

const fs = require('fs');

const events = require('./events');
const schema = require('./creation-pool-schema');
const pool = require('./creation-pool');

const { abs: _abs, ensureSlug, ensureDir, touchLastUpdated } = pool._internals;

// ---------------------------------------------------------------------------
// ID generation — short prefix + unixMs + 4-char rand. Deterministic prefix
// lets callers grep history for a specific ledger family at a glance.
// ---------------------------------------------------------------------------
function _newId(prefix) {
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${Date.now()}-${rand}`;
}

function _guardBound(slug) {
  ensureSlug(slug);
  if (!pool.isProductBound(slug)) {
    return { ok: false, reason: 'not_bound', slug };
  }
  return null;
}

function _appendJsonl(absPath, row) {
  ensureDir(require('path').dirname(absPath));
  fs.appendFileSync(absPath, JSON.stringify(row) + '\n', 'utf8');
}

function _readJsonlAll(absPath) {
  if (!fs.existsSync(absPath)) return [];
  const buf = fs.readFileSync(absPath, 'utf8');
  if (!buf) return [];
  const out = [];
  for (const line of buf.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); }
    catch (_) { /* skip malformed line — preserve the rest */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// addDecision — append to decision-log.jsonl per §11.5.
// Required fields validated against DECISION_LOG_SCHEMA.required_fields
// (id + ts auto-stamped if absent).
// ---------------------------------------------------------------------------
function addDecision(slug, decision) {
  const guard = _guardBound(slug); if (guard) return guard;
  if (!decision || typeof decision !== 'object') {
    throw new Error('addDecision: decision required (object)');
  }
  if (!decision.decision_text || typeof decision.decision_text !== 'string') {
    throw new Error('addDecision: decision.decision_text required (non-empty string)');
  }
  const row = {
    id: decision.id || _newId('d'),
    ts: decision.ts || new Date().toISOString(),
    decision_text: decision.decision_text,
    background: decision.background || '',
    basis: decision.basis || '',
    opposing_views: decision.opposing_views || [],
    final_choice: decision.final_choice || '',
    follow_up_needed: Array.isArray(decision.follow_up_needed) ? decision.follow_up_needed : [],
  };
  // Optional passthroughs.
  for (const opt of schema.DECISION_LOG_SCHEMA.optional_fields) {
    if (decision[opt] !== undefined) row[opt] = decision[opt];
  }
  _appendJsonl(_abs(slug, schema.PRODUCT_LAYOUT.decision_log), row);
  touchLastUpdated(slug);
  events.write(slug, {
    type: 'product_decision_added',
    decision_id: row.id,
    decision_text: row.decision_text,
  });
  return { ok: true, slug, id: row.id, row };
}

// ---------------------------------------------------------------------------
// addAssumption — append to assumption-ledger.jsonl per §11.6. Default status
// is 'unverified'. Deadline must be ISO date / datetime string when given.
// ---------------------------------------------------------------------------
function addAssumption(slug, assumption) {
  const guard = _guardBound(slug); if (guard) return guard;
  if (!assumption || typeof assumption !== 'object') {
    throw new Error('addAssumption: assumption required (object)');
  }
  if (!assumption.assumption_text || typeof assumption.assumption_text !== 'string') {
    throw new Error('addAssumption: assumption.assumption_text required (non-empty string)');
  }
  const status = assumption.status || 'unverified';
  if (!schema.ASSUMPTION_LEDGER_SCHEMA.statuses.includes(status)) {
    throw new Error(`addAssumption: status must be one of ${schema.ASSUMPTION_LEDGER_SCHEMA.statuses.join('|')}`);
  }
  const row = {
    id: assumption.id || _newId('a'),
    ts: assumption.ts || new Date().toISOString(),
    assumption_text: assumption.assumption_text,
    status,
    verification_method: assumption.verification_method || '',
    deadline: assumption.deadline || '',
  };
  for (const opt of schema.ASSUMPTION_LEDGER_SCHEMA.optional_fields) {
    if (assumption[opt] !== undefined) row[opt] = assumption[opt];
  }
  _appendJsonl(_abs(slug, schema.PRODUCT_LAYOUT.assumption_ledger), row);
  touchLastUpdated(slug);
  events.write(slug, {
    type: 'product_assumption_added',
    assumption_id: row.id,
    status,
  });
  return { ok: true, slug, id: row.id, row };
}

// ---------------------------------------------------------------------------
// updateAssumptionStatus — append a STATUS UPDATE row to the ledger. We do
// not mutate prior rows (append-only is a load-bearing invariant: §11.6
// wants the FULL hypothesis archaeology, not just the latest state). The
// getProduct path resolves "current status per id" by scanning forward.
// ---------------------------------------------------------------------------
function updateAssumptionStatus(slug, id, status, evidence) {
  const guard = _guardBound(slug); if (guard) return guard;
  if (!id || typeof id !== 'string') {
    throw new Error('updateAssumptionStatus: id required (string)');
  }
  if (!schema.ASSUMPTION_LEDGER_SCHEMA.statuses.includes(status)) {
    throw new Error(`updateAssumptionStatus: status must be one of ${schema.ASSUMPTION_LEDGER_SCHEMA.statuses.join('|')}`);
  }
  const ledgerPath = _abs(slug, schema.PRODUCT_LAYOUT.assumption_ledger);
  const all = _readJsonlAll(ledgerPath);
  const original = all.find(r => r.id === id);
  if (!original) {
    return { ok: false, reason: 'assumption_not_found', slug, id };
  }
  const update = {
    ...original,
    id,
    status,
    status_updated_at: new Date().toISOString(),
    evidence_links: Array.isArray(evidence) ? evidence
      : (evidence ? [{ kind: 'note', ref: String(evidence) }] : (original.evidence_links || [])),
    // ts retained from original creation; status_updated_at carries the
    // mutation time. Readers can diff the two for time-to-verification.
  };
  _appendJsonl(ledgerPath, update);
  touchLastUpdated(slug);
  events.write(slug, {
    type: 'product_assumption_status_changed',
    assumption_id: id,
    old_status: original.status,
    new_status: status,
  });
  return { ok: true, slug, id, status, row: update };
}

// ---------------------------------------------------------------------------
// addKillCriterion — push a criterion into kill-criteria.json. Re-reads,
// pushes, writes. Threshold is a triple { metric, op, value }; we only
// validate shape here, not semantics.
// ---------------------------------------------------------------------------
function addKillCriterion(slug, criterion) {
  const guard = _guardBound(slug); if (guard) return guard;
  if (!criterion || typeof criterion !== 'object') {
    throw new Error('addKillCriterion: criterion required (object)');
  }
  if (!criterion.description || typeof criterion.description !== 'string') {
    throw new Error('addKillCriterion: criterion.description required (non-empty string)');
  }
  if (!criterion.threshold || typeof criterion.threshold !== 'object') {
    throw new Error('addKillCriterion: criterion.threshold required (object { metric, op, value })');
  }
  if (!criterion.threshold.metric || !criterion.threshold.op || criterion.threshold.value === undefined) {
    throw new Error('addKillCriterion: threshold must have { metric, op, value }');
  }
  const validOps = ['<', '<=', '>', '>=', '==', '!='];
  if (!validOps.includes(criterion.threshold.op)) {
    throw new Error(`addKillCriterion: threshold.op must be one of ${validOps.join('|')}`);
  }
  const killPath = _abs(slug, schema.PRODUCT_LAYOUT.kill_criteria);
  const current = JSON.parse(fs.readFileSync(killPath, 'utf8'));
  const row = {
    id: criterion.id || _newId('k'),
    description: criterion.description,
    threshold: criterion.threshold,
    current_value: criterion.current_value == null ? null : criterion.current_value,
    would_kill: false,
    created_at: new Date().toISOString(),
    last_checked_at: null,
    severity: criterion.severity || 'soft',
  };
  if (criterion.notes) row.notes = criterion.notes;
  current.criteria.push(row);
  fs.writeFileSync(killPath, JSON.stringify(current, null, 2), 'utf8');
  touchLastUpdated(slug);
  events.write(slug, {
    type: 'product_kill_criterion_added',
    criterion_id: row.id,
    description: row.description,
  });
  return { ok: true, slug, id: row.id, row };
}

// ---------------------------------------------------------------------------
// evaluateKillCriteria — given currentMetrics { metricName: value }, walk all
// criteria, set current_value + would_kill, write the kill-criteria.json,
// and append a snapshot to evaluation-log.jsonl for history. Returns
// { ok, would_kill_now, triggered: [ ids ] }.
// ---------------------------------------------------------------------------
function evaluateKillCriteria(slug, currentMetrics) {
  const guard = _guardBound(slug); if (guard) return guard;
  if (!currentMetrics || typeof currentMetrics !== 'object') {
    throw new Error('evaluateKillCriteria: currentMetrics required (object)');
  }
  const killPath = _abs(slug, schema.PRODUCT_LAYOUT.kill_criteria);
  const current = JSON.parse(fs.readFileSync(killPath, 'utf8'));
  const now = new Date().toISOString();
  const triggered = [];

  for (const c of current.criteria) {
    const val = currentMetrics[c.threshold.metric];
    if (val === undefined) {
      // No data for this metric this round — preserve last reading, mark check ts.
      c.last_checked_at = now;
      continue;
    }
    c.current_value = val;
    c.last_checked_at = now;
    c.would_kill = _compare(val, c.threshold.op, c.threshold.value);
    if (c.would_kill) triggered.push(c.id);
  }
  current.last_evaluated = now;
  current.would_kill_now = current.criteria.some(c => c.would_kill);
  fs.writeFileSync(killPath, JSON.stringify(current, null, 2), 'utf8');

  // Snapshot for history. evaluation-log.jsonl is created at bind time so it
  // already exists; append the row.
  _appendJsonl(_abs(slug, schema.PRODUCT_LAYOUT.evaluation_log), {
    ts: now,
    metrics: currentMetrics,
    triggered,
    would_kill_now: current.would_kill_now,
  });
  touchLastUpdated(slug);
  events.write(slug, {
    type: 'product_kill_evaluation',
    triggered,
    would_kill_now: current.would_kill_now,
  });
  return { ok: true, slug, would_kill_now: current.would_kill_now, triggered, last_evaluated: now };
}

function _compare(a, op, b) {
  switch (op) {
    case '<':  return a < b;
    case '<=': return a <= b;
    case '>':  return a > b;
    case '>=': return a >= b;
    case '==': return a === b;
    case '!=': return a !== b;
    default:   return false;
  }
}

// ---------------------------------------------------------------------------
// appendRoadmapSync — push a fresh weekly suggestion block to roadmap-sync.json.
// Used by Companion agents (W3.5 / W3.6) + manual flows. Items are arbitrary
// shape ({ kind, text, source }); priority required 1..3.
// ---------------------------------------------------------------------------
function appendRoadmapSync(slug, weeklyItems, priority, sourceAgent) {
  const guard = _guardBound(slug); if (guard) return guard;
  if (!Array.isArray(weeklyItems)) {
    throw new Error('appendRoadmapSync: weeklyItems must be an array');
  }
  const prio = (typeof priority === 'number' && schema.ROADMAP_SYNC_SCHEMA.priorities.includes(priority))
    ? priority : 2;
  const path = _abs(slug, schema.PRODUCT_LAYOUT.roadmap_sync);
  const current = JSON.parse(fs.readFileSync(path, 'utf8'));
  const now = new Date().toISOString();
  const row = {
    id: _newId('r'),
    ts: now,
    items: weeklyItems,
    priority: prio,
  };
  if (sourceAgent) row.source_agent = sourceAgent;
  current.weekly_suggestions.push(row);
  current.last_synced_at = now;
  fs.writeFileSync(path, JSON.stringify(current, null, 2), 'utf8');
  touchLastUpdated(slug);
  events.write(slug, {
    type: 'product_roadmap_synced',
    suggestion_id: row.id,
    priority: prio,
    item_count: weeklyItems.length,
  });
  return { ok: true, slug, id: row.id, priority: prio };
}

module.exports = {
  addDecision,
  addAssumption,
  updateAssumptionStatus,
  addKillCriterion,
  evaluateKillCriteria,
  appendRoadmapSync,
};
