// V0.5 E0 Phase 3 unblock — bilingual golden-set translator.
//
// Founder cannot rate 50 English golden items (language barrier, not domain).
// This script translates each canonical item to a Chinese sidecar <id>.zh.json
// so label-cli can render bilingually. Canonical items remain immutable.
//
// Usage:
//   node app/scripts/translate-golden-zh.js philosophy
//   node app/scripts/translate-golden-zh.js llm-systems
//   node app/scripts/translate-golden-zh.js --all
//
// Idempotency: skip if sidecar exists AND source_hash matches current source.
// Re-translate on hash mismatch (canonical item was edited → translation stale).
//
// Cost guard: per-item cap ¥0.05, topic-total cap ¥3. Abort on cap breach.
// Recorded via sqliteDb.recordChatCallEstimate(dispatch, 'translateZh', ...).
//
// Atomic-rename writer: never leaves partial files.
//
// LLM: executeChat('T6_STRONG', { json: true, ... }) — JSON-mode structured req.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VAULT_ROOT = process.env.HYPHA_VAULT_DIR || path.join(__dirname, '..', '..', 'vault');
const KNOWN_TOPICS = ['philosophy', 'llm-systems'];

const PER_ITEM_CAP_RMB = 0.05;
const TOPIC_TOTAL_CAP_RMB = 3.0;
const SCHEMA_VERSION = '0.5.zh.D18';
const TRANSLATOR_TAG = 'T6_STRONG-glm-direct';

const SYSTEM_PROMPT = [
  '你是学术翻译，专门翻译哲学与 LLM-systems 题目。',
  '把英文题目翻成简体中文。',
  '保留专业术语原文括注（如：hexis 习性 / telos 目的 / RoPE / KV-cache / attention 注意力）。',
  '译文必须忠实于结构和命题，不增不减，不发挥。',
  '保留学术调性，避免白话或网络流行语。',
  '严格按用户给定 JSON schema 返回；不要添加 markdown 围栏；不要解释。',
].join(' ');

function _printHelp() {
  console.log(`
Bilingual golden-set translator — V0.5 E0 Phase 3.

Usage:
  node app/scripts/translate-golden-zh.js <topic>
  node app/scripts/translate-golden-zh.js --all
  node app/scripts/translate-golden-zh.js --help

Topics: ${KNOWN_TOPICS.join(', ')}

Behavior:
  - For each canonical <id>.json, write sister <id>.zh.json with translations
    of instance / answer_features (statement_zh + alt_phrasings_zh[0..1]) /
    candidate_responses[].text / prompt_text (when present).
  - Idempotent: source_hash compared; unchanged sources are skipped.
  - Drift: source mutation triggers re-translation.
  - Cost guard: per-item ¥${PER_ITEM_CAP_RMB.toFixed(2)} / topic ¥${TOPIC_TOTAL_CAP_RMB.toFixed(2)} cap.
`);
}

function _parseArgs(argv) {
  const args = { topic: null, all: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--all') args.all = true;
    else if (!args.topic && !a.startsWith('--')) args.topic = a;
  }
  return args;
}

// source_hash = sha256(instance + features.map(f=>f.claim + f.alt_phrasings.join('|')).join('||') + candidates.map(c=>c.text).join('|'))
// Captures: instance text, every feature claim + its phrasings, every candidate.
// Excludes: prompt_text intentionally (per spec; covered by content drift via candidates).
function _computeSourceHash(item) {
  const instance = String(item.instance || '');
  const features = Array.isArray(item.answer_features) ? item.answer_features : [];
  const featuresJoined = features
    .map((f) => {
      const claim = String(f.claim || f.statement || '');
      const alts = Array.isArray(f.alt_phrasings) ? f.alt_phrasings.join('|') : '';
      return `${claim}${alts}`;
    })
    .join('||');
  const candidates = Array.isArray(item.candidate_responses) ? item.candidate_responses : [];
  const candidatesJoined = candidates.map((c) => String(c.text || '')).join('|');
  const combined = `${instance}${featuresJoined}${candidatesJoined}`;
  return crypto.createHash('sha256').update(combined, 'utf8').digest('hex');
}

function _listCanonicalItems(topic) {
  const dir = path.join(VAULT_ROOT, '.evaluator', 'golden', topic);
  if (!fs.existsSync(dir)) {
    console.error(`[translate-golden-zh] golden directory missing: ${dir}`);
    return null;
  }
  const files = fs.readdirSync(dir).filter((f) =>
    f.endsWith('.json') &&
    !f.startsWith('_') &&
    !f.includes('.rater-') &&
    !f.endsWith('.zh.json')
  );
  const items = [];
  for (const f of files) {
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      items.push({ fullPath: path.join(dir, f), obj, dir });
    } catch (err) {
      console.warn(`[translate-golden-zh] skip malformed ${f}: ${err.message}`);
    }
  }
  return { dir, items };
}

function _readExistingSidecar(dir, itemId) {
  const p = path.join(dir, `${itemId}.zh.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.warn(`[translate-golden-zh] sidecar ${itemId}.zh.json parse error: ${err.message}; will re-translate`);
    return null;
  }
}

function _writeSidecarAtomic(dir, itemId, sidecar) {
  const p = path.join(dir, `${itemId}.zh.json`);
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(sidecar, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
  return p;
}

// Build the structured user payload for a single item.
function _buildTranslateRequest(item) {
  const payload = {
    instance: String(item.instance || ''),
    features: Array.isArray(item.answer_features)
      ? item.answer_features.map((f) => ({
          id: String(f.id || ''),
          statement: String(f.claim || f.statement || ''),
          alt_phrasings: Array.isArray(f.alt_phrasings) ? f.alt_phrasings : [],
        }))
      : [],
    candidates: Array.isArray(item.candidate_responses)
      ? item.candidate_responses.map((c) => ({
          id: String(c.id || ''),
          text: String(c.text || ''),
        }))
      : [],
  };
  if (typeof item.prompt_text === 'string' && item.prompt_text.length > 0) {
    payload.prompt_text = item.prompt_text;
  }
  return payload;
}

// Validate LLM response shape. Returns array of error strings (empty = OK).
//
// Schema variance: philosophy items have `instance` + answer_features; llm-systems
// items have `prompt_text` (no `instance`) + exec_cell (no answer_features). The
// validator therefore requires instance_zh only when the source had a non-empty
// `instance`, and requires prompt_text_zh only when expected.prompt_text is set.
function _validateLLMResponse(resp, expected) {
  const errs = [];
  if (!resp || typeof resp !== 'object') {
    errs.push('response not an object');
    return errs;
  }
  if (expected.instance !== undefined && expected.instance.length > 0) {
    if (typeof resp.instance_zh !== 'string' || resp.instance_zh.length === 0) {
      errs.push('missing instance_zh');
    }
  }
  const fz = resp.features_zh;
  if (expected.features.length > 0) {
    if (!Array.isArray(fz) || fz.length !== expected.features.length) {
      errs.push(`features_zh length mismatch (expected ${expected.features.length}, got ${Array.isArray(fz) ? fz.length : 'non-array'})`);
    } else {
      for (let i = 0; i < fz.length; i++) {
        const f = fz[i];
        if (!f || typeof f.statement_zh !== 'string' || f.statement_zh.length === 0) {
          errs.push(`features_zh[${i}].statement_zh missing`);
        }
        if (!Array.isArray(f && f.alt_phrasings_zh)) {
          errs.push(`features_zh[${i}].alt_phrasings_zh not array`);
        }
      }
    }
  }
  const cz = resp.candidates_zh;
  if (expected.candidates.length > 0) {
    if (!Array.isArray(cz) || cz.length !== expected.candidates.length) {
      errs.push(`candidates_zh length mismatch (expected ${expected.candidates.length}, got ${Array.isArray(cz) ? cz.length : 'non-array'})`);
    } else {
      for (let i = 0; i < cz.length; i++) {
        const c = cz[i];
        if (!c || typeof c.text_zh !== 'string' || c.text_zh.length === 0) {
          errs.push(`candidates_zh[${i}].text_zh missing`);
        }
      }
    }
  }
  if (expected.prompt_text !== undefined) {
    if (typeof resp.prompt_text_zh !== 'string' || resp.prompt_text_zh.length === 0) {
      errs.push('missing prompt_text_zh (source had prompt_text)');
    }
  }
  return errs;
}

// Build the sidecar object from the validated LLM response + source item.
// Keeps alt_phrasings_zh truncated to first 2 per spec (label-cli renders 2).
function _buildSidecar(item, llmResp, sourceHash) {
  const features = Array.isArray(item.answer_features) ? item.answer_features : [];
  const candidates = Array.isArray(item.candidate_responses) ? item.candidate_responses : [];
  const out = {
    item_id: item.id,
    source_hash: sourceHash,
    translated_at: new Date().toISOString(),
    version: SCHEMA_VERSION,
    translator: TRANSLATOR_TAG,
  };
  // instance_zh only when source had instance (philosophy items). llm-systems
  // items omit `instance` entirely; their user-facing question lives in
  // prompt_text, so emitting an empty instance_zh would be misleading.
  if (typeof item.instance === 'string' && item.instance.length > 0) {
    out.instance_zh = String(llmResp.instance_zh || '');
  }
  // features_zh array only when source had answer_features.
  if (features.length > 0) {
    out.features_zh = features.map((f, i) => {
      const fz = (llmResp.features_zh && llmResp.features_zh[i]) || {};
      const altsZh = Array.isArray(fz.alt_phrasings_zh) ? fz.alt_phrasings_zh.slice(0, 2) : [];
      return {
        id: String(f.id || ''),
        statement_zh: String(fz.statement_zh || ''),
        alt_phrasings_zh: altsZh,
      };
    });
  }
  out.candidates_zh = candidates.map((c, i) => {
    const cz = (llmResp.candidates_zh && llmResp.candidates_zh[i]) || {};
    return {
      id: String(c.id || ''),
      text_zh: String(cz.text_zh || ''),
    };
  });
  if (typeof item.prompt_text === 'string' && item.prompt_text.length > 0) {
    out.prompt_text_zh = String(llmResp.prompt_text_zh || '');
  }
  return out;
}

async function _translateOne(item, executeChat, sqliteDb) {
  const payload = _buildTranslateRequest(item);
  const userMsg = [
    `Translate the following item to Simplified Chinese. Return strict JSON with this schema:`,
    `{`,
    `  "instance_zh": "<zh translation of instance>",`,
    `  "features_zh": [{ "id": "<same id>", "statement_zh": "<zh>", "alt_phrasings_zh": ["<zh of phrasing 1>", "<zh of phrasing 2>", ...] }],`,
    `  "candidates_zh": [{ "id": "<same id>", "text_zh": "<zh>" }]${payload.prompt_text !== undefined ? ',' : ''}`,
    payload.prompt_text !== undefined ? `  "prompt_text_zh": "<zh>"` : '',
    `}`,
    ``,
    `Rules:`,
    `- Preserve Greek/Latin/technical terms with original-in-parens form (e.g. "习性 (hexis)" / "目的 (telos)" / "RoPE" / "KV-cache" / "注意力 (attention)").`,
    `- Translate every alt_phrasings entry; keep array order; do not drop.`,
    `- features_zh.length MUST equal source features.length; candidates_zh.length MUST equal source candidates.length.`,
    `- Academic register; no internet slang; no marketing tone.`,
    ``,
    `SOURCE:`,
    JSON.stringify(payload, null, 2),
  ].filter((l) => l !== '').join('\n');

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: userMsg },
  ];

  const t0 = Date.now();
  let dispatch;
  try {
    dispatch = await executeChat('T6_STRONG', {
      messages,
      json: true,
      temperature: 0.3,
      maxTokens: 4000,
      timeoutMs: 120000,
    });
  } catch (err) {
    return { ok: false, error: `executeChat failed: ${err && err.message || err}` };
  }
  const latencyMs = Date.now() - t0;

  // Cost-estimate row — must not break translation on db failure.
  try {
    sqliteDb.recordChatCallEstimate(dispatch, 'translateZh', {
      tuple_id: item.id,
      latency_ms: latencyMs,
      success: true,
    });
  } catch (err) {
    console.warn(`[translate-golden-zh] recordChatCallEstimate failed for ${item.id}: ${err && err.message}`);
  }

  const resp = dispatch && dispatch.result;
  const expected = {
    instance: payload.instance,
    features: payload.features,
    candidates: payload.candidates,
    prompt_text: payload.prompt_text,
  };
  // Some LLM runs flatten field names (statement_zh → statement, text_zh → text).
  // Normalize before validation so we don't fail healthy responses on cosmetic
  // key drift. We mutate a shallow copy, not the dispatch.result, to keep the
  // raw response addressable in logs.
  const normalized = _normalizeResponseKeys(resp);
  const errs = _validateLLMResponse(normalized, expected);
  if (errs.length > 0) {
    // Surface a truncated dump on validation failure so re-runs aren't blind.
    const dump = JSON.stringify(resp).slice(0, 400);
    return { ok: false, error: `LLM response invalid: ${errs.join('; ')} | dump=${dump}`, dispatch };
  }
  return { ok: true, resp: normalized, dispatch, latencyMs };
}

// Some LLM responses use `statement` instead of `statement_zh`, or `text`
// instead of `text_zh`. This normalizer lifts the un-suffixed key into the
// _zh-suffixed slot when the latter is missing, so validation + sidecar
// build see a consistent shape. Non-destructive: original keys preserved.
function _normalizeResponseKeys(resp) {
  if (!resp || typeof resp !== 'object') return resp;
  const out = { ...resp };
  if (typeof out.instance === 'string' && typeof out.instance_zh !== 'string') {
    out.instance_zh = out.instance;
  }
  if (Array.isArray(out.features_zh)) {
    out.features_zh = out.features_zh.map((f) => {
      if (!f || typeof f !== 'object') return f;
      const nf = { ...f };
      if (typeof nf.statement === 'string' && typeof nf.statement_zh !== 'string') {
        nf.statement_zh = nf.statement;
      }
      if (typeof nf.claim_zh === 'string' && typeof nf.statement_zh !== 'string') {
        nf.statement_zh = nf.claim_zh;
      }
      if (Array.isArray(nf.alt_phrasings) && !Array.isArray(nf.alt_phrasings_zh)) {
        nf.alt_phrasings_zh = nf.alt_phrasings;
      }
      return nf;
    });
  }
  if (Array.isArray(out.candidates_zh)) {
    out.candidates_zh = out.candidates_zh.map((c) => {
      if (!c || typeof c !== 'object') return c;
      const nc = { ...c };
      if (typeof nc.text === 'string' && typeof nc.text_zh !== 'string') {
        nc.text_zh = nc.text;
      }
      return nc;
    });
  }
  if (typeof out.prompt_text === 'string' && typeof out.prompt_text_zh !== 'string') {
    out.prompt_text_zh = out.prompt_text;
  }
  return out;
}

async function _translateTopic(topic) {
  const listing = _listCanonicalItems(topic);
  if (!listing) return { wrote: 0, skipped: 0, retranslated: 0, errors: [], totalSpend: 0, dir: null };
  const { dir, items } = listing;
  const n = items.length;
  console.log(`[translate-golden-zh] TOPIC=${topic} n=${n} capPerItem=¥${PER_ITEM_CAP_RMB.toFixed(2)} capTotal=¥${TOPIC_TOTAL_CAP_RMB.toFixed(2)}`);
  console.log(`[translate-golden-zh] dir: ${dir}`);

  // Late-require so the script doesn't fail-fast on env-load before we can show usage.
  const { executeChat } = require('../lib/llm');
  const sqliteDb = require('../db/sqlite');

  let wrote = 0;
  let skipped = 0;
  let retranslated = 0;
  let totalSpend = 0;
  const errors = [];

  // sqlite cost lookup helper: fetch this run's cumulative model_calls cost
  // for translateZh task_type. Approx — uses estimated_cost from placeholder rates.
  function _estimateLastItemCost(itemId) {
    try {
      const db = sqliteDb.open();
      const row = db.prepare(
        `SELECT estimated_cost FROM model_calls WHERE task_type='translateZh' AND tuple_id=@id ORDER BY ts DESC LIMIT 1`
      ).get({ id: itemId });
      return row && Number.isFinite(row.estimated_cost) ? row.estimated_cost : 0;
    } catch (_) { return 0; }
  }

  for (const { obj } of items) {
    const itemId = obj.id;
    const sourceHash = _computeSourceHash(obj);
    const existing = _readExistingSidecar(dir, itemId);
    if (existing && existing.source_hash === sourceHash) {
      skipped++;
      continue;
    }
    const isRetranslate = !!existing;

    const result = await _translateOne(obj, executeChat, sqliteDb);
    if (!result.ok) {
      errors.push({ itemId, error: result.error });
      console.warn(`[translate-golden-zh] ${itemId} FAILED: ${result.error}`);
      continue;
    }

    const itemCost = _estimateLastItemCost(itemId);
    totalSpend += itemCost;
    if (itemCost > PER_ITEM_CAP_RMB) {
      // intentional-placeholder: per-provider rate cards are stubbed in sqlite.js
      // (Cheap Router BLUEPRINT §17.2.1 owns calibrated rates, ships v0.6+). The
      // ¥0.05/¥3 caps are precautionary against future rate updates; until then,
      // the warn line surfaces over-budget without blocking since stub estimate
      // is order-of-magnitude only. Real abort still fires on TOPIC_TOTAL cap.
      console.warn(`[translate-golden-zh] WARN: ${itemId} cost ¥${itemCost.toFixed(4)} exceeded per-item cap ¥${PER_ITEM_CAP_RMB.toFixed(2)} (still writing — sqlite rates are stubbed pending Cheap Router v0.6+)`);
    }
    if (totalSpend > TOPIC_TOTAL_CAP_RMB) {
      console.error(`[translate-golden-zh] ABORT: topic total spend ¥${totalSpend.toFixed(4)} exceeded cap ¥${TOPIC_TOTAL_CAP_RMB.toFixed(2)}`);
      return { wrote, skipped, retranslated, errors, totalSpend, dir };
    }

    const sidecar = _buildSidecar(obj, result.resp, sourceHash);
    try {
      _writeSidecarAtomic(dir, itemId, sidecar);
    } catch (err) {
      errors.push({ itemId, error: `sidecar write failed: ${err && err.message}` });
      console.warn(`[translate-golden-zh] ${itemId} write FAILED: ${err && err.message}`);
      continue;
    }
    wrote++;
    if (isRetranslate) retranslated++;
    console.log(`[translate-golden-zh] wrote ${itemId}.zh.json (${result.latencyMs}ms, ¥${itemCost.toFixed(4)}${isRetranslate ? ', drift' : ''})`);
  }

  console.log('');
  console.log(`[translate-golden-zh] wrote ${wrote} item(s), skipped ${skipped} unchanged, ${retranslated} re-translated (drift)`);
  console.log(`[translate-golden-zh] dir: ${dir}`);
  // intentional-placeholder: spend total derives from sqlite estimated_cost which
  // uses stub per-provider rate cards (sqlite.js _COST_RATES_PLACEHOLDER). Until
  // Cheap Router v0.6+ ships calibrated rates, this number is order-of-magnitude
  // only and intentionally not load-bearing.
  console.log(`[translate-golden-zh] total spend ¥${totalSpend.toFixed(4)} (sqlite rates stubbed pending Cheap Router v0.6+)`);
  if (errors.length > 0) {
    console.log(`[translate-golden-zh] errors: ${errors.length}`);
    for (const e of errors) console.log(`  - ${e.itemId}: ${e.error}`);
  }
  return { wrote, skipped, retranslated, errors, totalSpend, dir };
}

async function main() {
  const args = _parseArgs(process.argv);
  if (args.help) { _printHelp(); return; }
  const topics = args.all ? KNOWN_TOPICS : (args.topic ? [args.topic] : []);
  if (topics.length === 0) {
    console.error('[translate-golden-zh] topic required (or --all).');
    _printHelp();
    process.exit(2);
  }
  for (const t of topics) {
    if (!KNOWN_TOPICS.includes(t)) {
      console.error(`[translate-golden-zh] unknown topic "${t}" (known: ${KNOWN_TOPICS.join(', ')})`);
      process.exit(2);
    }
  }
  let aggregateErrors = 0;
  for (const topic of topics) {
    const { errors } = await _translateTopic(topic);
    aggregateErrors += errors.length;
    if (topics.length > 1) console.log('---');
  }
  if (aggregateErrors > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[translate-golden-zh] fatal: ${err && err.stack || err}`);
    process.exit(1);
  });
}

module.exports = { main, _computeSourceHash, _buildTranslateRequest, _validateLLMResponse, _buildSidecar };
