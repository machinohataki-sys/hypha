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

module.exports = {
  lockAnswerKey,
  verifyAgainstKey,
  verifyMultipleKeys,
};
