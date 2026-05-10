'use strict';
// HYPHA · Character Contract loader (AMD-MEOW-P8 C1)
//
// Loads a Character Contract JSON for an agent. Project-shipped defaults live at
// app/lib/agent-character/contracts/<id>.json. User-side overrides at
// vault/.hypha/contracts/<id>.json take precedence when present.
//
// Phase 1 (v0.2) shipped contracts: mycelium-professor / skeptic-mushroom /
// evidence-auditor. Future contracts ship as additional JSON files with the
// same 8-field schema.

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_FIELDS = [
  'agent_id',
  'role_version',
  'i_am',
  'i_am_not',
  'i_prioritize',
  'i_will_never_sacrifice',
  'failure_protocol',
  'uncertainty_protocol',
  'user_pressure_protocol',
  'cross_agent_conflict_protocol',
];

const PROJECT_CONTRACTS_DIR = path.join(__dirname, 'contracts');

let _cache = new Map();

function _validate(c, source) {
  for (const f of REQUIRED_FIELDS) {
    if (!(f in c)) throw new Error(`Character Contract at ${source} missing field "${f}"`);
  }
  if (typeof c.agent_id !== 'string' || !c.agent_id.trim()) {
    throw new Error(`Character Contract at ${source} has invalid agent_id`);
  }
  for (const arrField of ['i_am', 'i_am_not', 'i_prioritize', 'i_will_never_sacrifice']) {
    if (!Array.isArray(c[arrField]) || c[arrField].length === 0) {
      throw new Error(`Character Contract at ${source} field "${arrField}" must be a non-empty array`);
    }
  }
  for (const strField of ['failure_protocol', 'uncertainty_protocol', 'user_pressure_protocol', 'cross_agent_conflict_protocol']) {
    if (typeof c[strField] !== 'string' || !c[strField].trim()) {
      throw new Error(`Character Contract at ${source} field "${strField}" must be a non-empty string`);
    }
  }
}

/**
 * Load a Character Contract by agent_id. Returns parsed contract object.
 * Throws if neither vault override nor project default exists.
 *
 * @param {string} agentId — e.g. 'mycelium-professor'
 * @param {object} [opts]
 * @param {string} [opts.vaultRoot] — vault root for user override lookup; if omitted, only project defaults are checked
 * @param {boolean} [opts.fresh] — bypass cache
 * @returns {object} — the contract
 */
function loadContract(agentId, opts = {}) {
  const cacheKey = `${opts.vaultRoot || 'project'}:${agentId}`;
  if (!opts.fresh && _cache.has(cacheKey)) return _cache.get(cacheKey);

  const candidates = [];
  if (opts.vaultRoot) {
    candidates.push(path.join(opts.vaultRoot, '.hypha', 'contracts', `${agentId}.json`));
  }
  candidates.push(path.join(PROJECT_CONTRACTS_DIR, `${agentId}.json`));

  let lastErr = null;
  for (const fp of candidates) {
    try {
      if (!fs.existsSync(fp)) continue;
      const raw = fs.readFileSync(fp, 'utf8');
      const obj = JSON.parse(raw);
      _validate(obj, fp);
      _cache.set(cacheKey, obj);
      return obj;
    } catch (e) {
      lastErr = e;
    }
  }

  if (lastErr) throw lastErr;
  throw new Error(`No Character Contract found for agent_id="${agentId}". Checked: ${candidates.join(', ')}`);
}

/**
 * List all available agent_ids in project contracts dir.
 * @returns {string[]}
 */
function listProjectContracts() {
  if (!fs.existsSync(PROJECT_CONTRACTS_DIR)) return [];
  return fs.readdirSync(PROJECT_CONTRACTS_DIR)
    .filter(n => n.endsWith('.json'))
    .map(n => n.slice(0, -5));
}

/**
 * Render a contract into a system-prompt fragment. Used by lesson-generator
 * + confession + Prosecutor/Judge/Rewriter (Tranche 2). Format is stable text
 * the model can read; not a JSON dump (models internalize prose better).
 *
 * @param {object} contract
 * @returns {string}
 */
function renderContractAsPrompt(contract) {
  const lines = [];
  lines.push(`# Character Contract: ${contract.display_name || contract.agent_id} (v${contract.role_version || '?'})`);
  lines.push('');
  if (contract.functional_role) lines.push(`Functional role: ${contract.functional_role}`);
  if (contract.epistemic_temperament) lines.push(`Epistemic temperament: ${contract.epistemic_temperament}`);
  lines.push('');
  lines.push('I am:');
  for (const item of contract.i_am) lines.push(`- ${item}`);
  lines.push('');
  lines.push('I am not:');
  for (const item of contract.i_am_not) lines.push(`- ${item}`);
  lines.push('');
  lines.push('I prioritize:');
  for (const item of contract.i_prioritize) lines.push(`- ${item}`);
  lines.push('');
  lines.push('I will never sacrifice:');
  for (const item of contract.i_will_never_sacrifice) lines.push(`- ${item}`);
  lines.push('');
  lines.push(`Failure protocol: ${contract.failure_protocol}`);
  lines.push('');
  lines.push(`Uncertainty protocol: ${contract.uncertainty_protocol}`);
  lines.push('');
  lines.push(`User pressure protocol: ${contract.user_pressure_protocol}`);
  lines.push('');
  lines.push(`Cross-agent conflict protocol: ${contract.cross_agent_conflict_protocol}`);
  return lines.join('\n');
}

module.exports = {
  loadContract,
  listProjectContracts,
  renderContractAsPrompt,
  REQUIRED_FIELDS,
  PROJECT_CONTRACTS_DIR,
};
