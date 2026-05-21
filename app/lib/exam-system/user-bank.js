// app/lib/exam-system/user-bank.js
// W7.2 Exam System — User-owned Bank (题源 layer 2 of 4).
//
// Per BLUEPRINT §13.2: Hypha 不做盗版真题平台, 做"真题学习转化器" — 用户
// 上传自己拥有的资料, Hypha 负责结构化 / 分类 / 错题诊断 / 复习规划.
//
// 早期 (v2.1) 仅 User-owned Bank. Licensed / Public Index / Synthetic 后接.
//
// Parsers (真 parser, 非 mock):
//   - CSV   : RFC 4180-ish (quote-escaped fields, commas-in-quotes), header row
//   - JSON  : { items: [...] } | [...] 顶层数组
//   - MD    : '### Q: ...\nA: ...' 块格式 — 1 行 Q 行 / 1 行 A 行 / 可选 Options
//
// Persistence: vault/<slug>/exam/bank/<bank_id>.json
// Bank item schema:
//   { question, answer, options?, topic, tier, difficulty, source }

'use strict';

const path = require('node:path');

let _vault = null;
function _getVault() {
  if (_vault) return _vault;
  try { _vault = require('../vault'); } catch (_) { _vault = null; }
  return _vault;
}

function _validateSlug(slug) {
  if (typeof slug !== 'string' || !slug.trim()) throw new Error('slug required');
  if (slug.includes('..') || path.isAbsolute(slug)) throw new Error(`invalid slug: ${slug}`);
}

function _bankRel(slug, bankId) { return `${slug}/exam/bank/${bankId}.json`; }
function _bankDirRel(slug) { return `${slug}/exam/bank`; }

const DIFFICULTIES = Object.freeze(['easy', 'medium', 'hard']);

// =====================================================================
// CSV PARSER — RFC4180-ish. Supports quoted fields, embedded commas + CRLF.
// =====================================================================

function _parseCSV(text) {
  if (typeof text !== 'string' || !text) return [];
  const rows = [];
  let cur = [''];
  let inQuote = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (i + 1 < n && text[i + 1] === '"') {
          cur[cur.length - 1] += '"';
          i += 2;
          continue;
        }
        inQuote = false;
        i++;
        continue;
      }
      cur[cur.length - 1] += c;
      i++;
      continue;
    }
    if (c === '"') { inQuote = true; i++; continue; }
    if (c === ',') { cur.push(''); i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') {
      rows.push(cur);
      cur = [''];
      i++;
      continue;
    }
    cur[cur.length - 1] += c;
    i++;
  }
  // Tail row (no trailing newline).
  if (cur.length > 1 || cur[0] !== '') rows.push(cur);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 1 && row[0].trim() === '') continue;
    const obj = {};
    for (let k = 0; k < header.length; k++) {
      obj[header[k]] = row[k] != null ? String(row[k]).trim() : '';
    }
    out.push(obj);
  }
  return out;
}

// =====================================================================
// MARKDOWN PARSER — block format.
// Recognized fences:
//   ### Q: <question text...>
//   A: <answer text>
//   Options: opt1 | opt2 | opt3   (optional)
//   Topic: ...                    (optional)
//   Tier: must_master|high_yield|recognition|out_of_scope (optional)
//   Difficulty: easy|medium|hard  (optional)
// =====================================================================

function _parseMD(text) {
  if (typeof text !== 'string' || !text) return [];
  const lines = text.split(/\r?\n/);
  const items = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    const qm = line.match(/^#{1,4}\s*Q\s*[:：]\s*(.+)$/i);
    if (qm) {
      if (cur && cur.question) items.push(cur);
      cur = { question: qm[1].trim() };
      continue;
    }
    if (!cur) continue;
    const am = line.match(/^A\s*[:：]\s*(.+)$/i);
    if (am) { cur.answer = am[1].trim(); continue; }
    const om = line.match(/^Options\s*[:：]\s*(.+)$/i);
    if (om) {
      cur.options = om[1].split('|').map((s) => s.trim()).filter(Boolean);
      continue;
    }
    const tm = line.match(/^Topic\s*[:：]\s*(.+)$/i);
    if (tm) { cur.topic = tm[1].trim(); continue; }
    const tierM = line.match(/^Tier\s*[:：]\s*(.+)$/i);
    if (tierM) { cur.tier = tierM[1].trim(); continue; }
    const dm = line.match(/^Difficulty\s*[:：]\s*(.+)$/i);
    if (dm) { cur.difficulty = dm[1].trim().toLowerCase(); continue; }
  }
  if (cur && cur.question) items.push(cur);
  return items;
}

// =====================================================================
// IMPORTER
// =====================================================================

function _normalizeItem(raw, sourceLabel) {
  const item = {
    question: String(raw.question || raw.q || '').trim(),
    answer:   String(raw.answer   || raw.a || '').trim(),
    options:  Array.isArray(raw.options) ? raw.options.slice() : (
      typeof raw.options === 'string' && raw.options
        ? raw.options.split('|').map((s) => s.trim()).filter(Boolean)
        : undefined
    ),
    topic:    raw.topic ? String(raw.topic).trim() : '',
    tier:     raw.tier ? String(raw.tier).trim() : 'must_master',
    difficulty: DIFFICULTIES.includes(String(raw.difficulty || '').toLowerCase())
      ? String(raw.difficulty).toLowerCase() : 'medium',
    source:   raw.source ? String(raw.source).trim() : (sourceLabel || 'user-upload'),
  };
  if (!item.options || item.options.length === 0) delete item.options;
  return item;
}

// v2-push-b2: strict validation. Returns array of error strings (empty = valid).
// Boundary validation per Lens 9 SURGICAL — reject malformed at the system
// boundary, do not silently drop into normalize-and-discard.
const _VALID_TIERS = Object.freeze(['must_master', 'high_yield', 'recognition', 'out_of_scope']);

function _validateItem(item, rowIdx) {
  const errors = [];
  const label = `row ${rowIdx + 1}`;
  if (!item.question || item.question.length === 0) {
    errors.push(`${label}: missing question field`);
  }
  if (!item.answer || item.answer.length === 0) {
    errors.push(`${label}: missing answer field`);
  }
  // Ambiguous-correct guard: if options[] is present, answer should match one
  // exactly OR be a single letter pointing at a position. Otherwise the item
  // is unanswerable downstream.
  if (Array.isArray(item.options) && item.options.length > 0 && item.answer) {
    const ans = item.answer.trim();
    const matchExact = item.options.some((opt) => opt.trim() === ans);
    // Letter form (A/B/C/D or 1/2/3...) — must point at valid index.
    const letterIdx = /^[A-Za-z]$/.test(ans) ? (ans.toUpperCase().charCodeAt(0) - 65) : -1;
    const numIdx = /^\d+$/.test(ans) ? (parseInt(ans, 10) - 1) : -1;
    const ptrIdx = letterIdx >= 0 ? letterIdx : numIdx;
    const matchPtr = ptrIdx >= 0 && ptrIdx < item.options.length;
    if (!matchExact && !matchPtr) {
      errors.push(`${label}: answer "${ans}" not found in options [${item.options.join(' | ')}]`);
    }
    // Duplicate-option guard (ambiguous correct option).
    const seen = new Set();
    for (const opt of item.options) {
      const k = opt.trim();
      if (seen.has(k)) {
        errors.push(`${label}: duplicate option "${k}" — ambiguous correct answer`);
        break;
      }
      seen.add(k);
    }
  }
  if (item.tier && !_VALID_TIERS.includes(item.tier)) {
    errors.push(`${label}: invalid tier "${item.tier}" (expected one of ${_VALID_TIERS.join('/')})`);
  }
  return errors;
}

/**
 * Parse a bank file content (string) into items. format may be inferred from
 * the file extension (passed as `format`).
 *
 * @param {object} args
 * @param {string} args.format      — 'csv'|'json'|'md'
 * @param {string} args.content     — raw text
 * @param {string} [args.sourceLabel] — defaults to 'user-upload'
 * @param {boolean} [args.strict]   — v2-push-b2: when true, reject malformed
 *                                    rows w/ ImportValidationError instead of
 *                                    silently dropping question-less items.
 * @returns {object[]} (non-strict) | object[] w/ all validated (strict)
 */
function parseBankContent({ format, content, sourceLabel, strict } = {}) {
  const f = String(format || '').toLowerCase();
  let rawItems = [];
  if (f === 'csv') {
    rawItems = _parseCSV(content || '');
  } else if (f === 'json') {
    try {
      const parsed = JSON.parse(content || '[]');
      rawItems = Array.isArray(parsed) ? parsed
        : (parsed && Array.isArray(parsed.items) ? parsed.items : []);
    } catch (e) {
      throw new Error(`JSON parse failed: ${e && e.message || e}`);
    }
  } else if (f === 'md' || f === 'markdown') {
    rawItems = _parseMD(content || '');
  } else {
    throw new Error(`unsupported bank format: ${format}`);
  }
  const normalized = rawItems.map((r) => _normalizeItem(r, sourceLabel));
  if (strict === true) {
    const allErrors = [];
    normalized.forEach((item, idx) => {
      const errs = _validateItem(item, idx);
      if (errs.length > 0) allErrors.push(...errs);
    });
    if (allErrors.length > 0) {
      const err = new Error(`bank import rejected: ${allErrors.length} validation error(s)\n  - ${allErrors.slice(0, 10).join('\n  - ')}`);
      err.code = 'BANK_VALIDATION_FAILED';
      err.validation_errors = allErrors;
      throw err;
    }
    return normalized;
  }
  return normalized.filter((i) => i.question.length > 0);
}

/**
 * Import a user bank file. bankFile = { name, format, content } where
 * format is 'csv'|'json'|'md'. Returns bank metadata.
 *
 * @param {string} slug
 * @param {{ name?:string, format:string, content:string, source?:string }} bankFile
 * @returns {{ ok:boolean, bank_id:string, item_count:number, path:string }}
 */
function importBank(slug, bankFile) {
  _validateSlug(slug);
  if (!bankFile || typeof bankFile !== 'object') throw new Error('bankFile required');
  const items = parseBankContent({
    format: bankFile.format,
    content: bankFile.content,
    sourceLabel: bankFile.source || bankFile.name || 'user-upload',
    strict: bankFile.strict === true,
  });
  const bankId = _generateBankId(bankFile.name);
  const meta = {
    bank_id: bankId,
    display_name: bankFile.name || bankId,
    format: bankFile.format,
    source: bankFile.source || 'user-upload',
    item_count: items.length,
    items,
    imported_at: new Date().toISOString(),
    version: 1,
  };
  const v = _getVault();
  if (v && typeof v.writeJSON === 'function') {
    v.writeJSON(_bankRel(slug, bankId), meta);
  }
  return { ok: true, bank_id: bankId, item_count: items.length, path: _bankRel(slug, bankId) };
}

function _generateBankId(name) {
  const base = String(name || 'bank').toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
  const stamp = Date.now().toString(36);
  return `${base || 'bank'}-${stamp}`;
}

/**
 * List banks for a slug. Returns { bank_id, display_name, item_count, imported_at }[].
 */
function listBanks(slug) {
  _validateSlug(slug);
  const v = _getVault();
  if (!v || typeof v.listDir !== 'function') return [];
  const entries = v.listDir(_bankDirRel(slug));
  const out = [];
  for (const ent of entries) {
    if (ent.isDir) continue;
    if (!/\.json$/i.test(ent.name)) continue;
    const bankId = ent.name.replace(/\.json$/i, '');
    const meta = v.readJSON(_bankRel(slug, bankId), null);
    if (meta && typeof meta === 'object') {
      out.push({
        bank_id: meta.bank_id || bankId,
        display_name: meta.display_name || bankId,
        item_count: Array.isArray(meta.items) ? meta.items.length : (meta.item_count || 0),
        imported_at: meta.imported_at || null,
      });
    }
  }
  return out;
}

/**
 * Read one bank item.
 */
function getBankItem(slug, bankId, itemIdx) {
  _validateSlug(slug);
  if (typeof bankId !== 'string' || !bankId.trim()) throw new Error('bankId required');
  const v = _getVault();
  if (!v || typeof v.readJSON !== 'function') return null;
  const meta = v.readJSON(_bankRel(slug, bankId), null);
  if (!meta || !Array.isArray(meta.items)) return null;
  const idx = Number(itemIdx);
  if (!Number.isFinite(idx) || idx < 0 || idx >= meta.items.length) return null;
  return { ...meta.items[idx], _idx: idx, _bank_id: bankId };
}

/**
 * Tag an item with topic / tier / difficulty (UI-side curation). Writes
 * back to the bank file.
 */
function tagItem(slug, bankId, itemIdx, patch) {
  _validateSlug(slug);
  const v = _getVault();
  if (!v || typeof v.readJSON !== 'function' || typeof v.writeJSON !== 'function') {
    throw new Error('vault unavailable');
  }
  const meta = v.readJSON(_bankRel(slug, bankId), null);
  if (!meta || !Array.isArray(meta.items)) throw new Error('bank not found');
  const idx = Number(itemIdx);
  if (!Number.isFinite(idx) || idx < 0 || idx >= meta.items.length) throw new Error('itemIdx out of range');
  const cur = meta.items[idx] || {};
  const next = { ...cur };
  if (patch && typeof patch === 'object') {
    if (typeof patch.topic === 'string') next.topic = patch.topic.trim();
    if (typeof patch.tier === 'string') next.tier = patch.tier.trim();
    if (typeof patch.difficulty === 'string' && DIFFICULTIES.includes(patch.difficulty.toLowerCase())) {
      next.difficulty = patch.difficulty.toLowerCase();
    }
  }
  // Immutable: write a new items array.
  const items = meta.items.slice();
  items[idx] = next;
  v.writeJSON(_bankRel(slug, bankId), { ...meta, items, updated_at: new Date().toISOString() });
  return next;
}

module.exports = {
  // Constants
  DIFFICULTIES,
  // Parsers (exported for test + reuse)
  parseBankContent,
  _parseCSV,
  _parseMD,
  _validateItem,
  // API
  importBank,
  listBanks,
  getBankItem,
  tagItem,
};
