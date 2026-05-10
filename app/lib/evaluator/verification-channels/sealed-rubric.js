// V0.5 E0 — sealed-rubric verification channel
//
// sha256-locked answer-key grader. Author commits the rubric BEFORE the test;
// learner's response is hashed and compared against the sealed hash.
//
// Per Leo R1 + Council convergence: for non-executable domains (philosophy / argumentation),
// the rubric must be locked at lesson-creation time. LLM does NOT grade.
//
// Created 2026-05-10 on v0.5-substrate.

'use strict';

const crypto = require('crypto');

let _jsSha256 = null;
try {
  _jsSha256 = require('js-sha256');
} catch (_e) {
  console.warn('[sealed-rubric] js-sha256 unavailable, using crypto fallback');
}

function _hash(text) {
  const normalized = _normalize(text);
  if (_jsSha256 && _jsSha256.sha256) return _jsSha256.sha256(normalized);
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function _normalize(text) {
  // Conservative normalization: trim ends, collapse internal whitespace runs, lowercase.
  // Authors locking a key should choose plaintext that survives this transform.
  if (typeof text !== 'string') return '';
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function lockAnswerKey(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.trim() === '') {
    throw new Error('lockAnswerKey: plaintext must be non-empty string');
  }
  const sealed_hash = _hash(plaintext);
  return {
    sealed_hash,
    locked_at: new Date().toISOString(),
    plaintext_length: plaintext.length,
    normalized_length: _normalize(plaintext).length,
    algorithm: 'sha256',
    normalization: 'trim+collapse-whitespace+lowercase',
  };
}

function verifyAgainstKey(userResponse, sealedHash) {
  if (typeof userResponse !== 'string') {
    return { match: false, reason: 'response must be string', hash_user: null, hash_expected: sealedHash };
  }
  if (typeof sealedHash !== 'string' || sealedHash.length !== 64) {
    return { match: false, reason: 'sealed hash must be 64-char hex sha256', hash_user: null, hash_expected: sealedHash };
  }
  const hash_user = _hash(userResponse);
  return {
    match: hash_user === sealedHash,
    hash_user,
    hash_expected: sealedHash,
    normalized_user_length: _normalize(userResponse).length,
  };
}

function verifyMultipleKeys(userResponse, sealedHashList) {
  // For rubrics with multiple acceptable phrasings (e.g. "spaced retrieval" / "interleaved practice")
  // author locks several keys; any match passes.
  if (!Array.isArray(sealedHashList) || sealedHashList.length === 0) {
    return { match: false, reason: 'sealed hash list empty', matched_index: -1 };
  }
  const hash_user = _hash(userResponse);
  for (let i = 0; i < sealedHashList.length; i++) {
    if (hash_user === sealedHashList[i]) {
      return { match: true, hash_user, matched_index: i, total_keys: sealedHashList.length };
    }
  }
  return { match: false, hash_user, matched_index: -1, total_keys: sealedHashList.length };
}

// V0.5 D3.1+ — feature-set verification (substring match w/ normalization)
//
// Per Council post-MEOW: full-prose sha256 match was structurally broken for
// philosophy-style rubrics. Feature-set channel splits each rubric into atomic
// claims; verifyFeatures runs deterministic substring match per phrasing.
// LLM never grades. Auto-evaluator equals normalized substring containment,
// nothing more.
//
// item shape (D3.1):
//   { answer_features: [{id, claim, alt_phrasings, ...}], k_threshold }
//
// returns:
//   { features_hit: ['f1', 'f3'], predicted_pass: bool, threshold: int, channel: 'feature_substring' }

function verifyFeatures(responseText, item) {
  const result = { features_hit: [], predicted_pass: false, channel: 'feature_substring', threshold: null, per_feature: [] };
  if (typeof responseText !== 'string') {
    result.reason = 'response must be string';
    return result;
  }
  if (!item || !Array.isArray(item.answer_features) || item.answer_features.length === 0) {
    result.reason = 'item missing answer_features';
    return result;
  }
  const k = (typeof item.k_threshold === 'number') ? item.k_threshold : 1;
  result.threshold = k;
  const normalizedResponse = _normalize(responseText);
  if (!normalizedResponse) {
    return result;
  }
  for (const f of item.answer_features) {
    if (!f || !f.id) continue;
    const phrasings = [f.claim, ...((f.alt_phrasings) || [])].filter(p => typeof p === 'string' && p.trim());
    let hit = false;
    let matched_phrasing = null;
    for (const p of phrasings) {
      const np = _normalize(p);
      if (np && normalizedResponse.includes(np)) {
        hit = true;
        matched_phrasing = p;
        break;
      }
    }
    result.per_feature.push({ id: f.id, hit, matched_phrasing });
    if (hit) result.features_hit.push(f.id);
  }
  result.predicted_pass = result.features_hit.length >= k;
  return result;
}

module.exports = {
  lockAnswerKey,
  verifyAgainstKey,
  verifyMultipleKeys,
  verifyFeatures,
};
