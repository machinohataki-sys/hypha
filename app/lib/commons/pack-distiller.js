'use strict';

// HYPHA · Commons · Pack Distiller (γ17 — Commons System §6 子 v0).
//
// Generates an editorial "what would I get if I imported this pack" preview
// card WITHOUT extracting the pack to vault/. Reads the .hypha-pack bytes in
// memory, validates the manifest via the same path pack-import.js uses (via
// inspectPack), then selectively decodes only the small subset of payload
// files needed to compose the distill card (state.json, agent.json,
// sources.json, head excerpts of the first 2 lesson-NN.md, plus the list
// of persona-wisdom file names — never the full body).
//
// 2026-05-20 boot-6 hardening — closes 8 boundary defects discovered in the
// pre-existing v0 implementation:
//   1.  All `catch (_) {}` silent swallows replaced with structured
//       `_logTrappedError(scope, err)` (per `silent_catch_hides_typeerror`,
//       2026-05-13 Hypha vault.delete TypeError incident).
//   2.  packPath validated for type + length + traversal-shape before any
//       fs touch.
//   3.  Pre-flight file size cap (200MB, matching source-extractor) — reject
//       oversize packs before `readFileSync` saturates memory.
//   4.  Pre-flight file accessibility — `fs.accessSync(R_OK)` reports
//       permission errors with a clear code instead of dropping into the
//       generic EXCEPTION envelope.
//   5.  License gate (optional via `opts.requireLicenseKnown`) — refuses
//       distill on `'unknown'` parsed license per `license-layer.js` matrix,
//       avoiding silent fallback to most-restrictive private-only.
//   6.  Source-trust gate (optional via `opts.minTrustBand`) — band
//       comparison vs `verified` > `community` > `unverified` ordering.
//   7.  Security-layer integration — text fields exposed to LLM context
//       (lesson_0_excerpt, topic_summary, lesson titles) routed through
//       `security-layer.sanitizeForLLM` so injection-pattern payloads in
//       a tampered pack do not slip into downstream prompts. Sanitization
//       events surface in `distill.warnings`.
//   8.  Consistent error envelope — every return path is
//       `{ok:false, error:CODE, detail?:string}` (was previously a mix of
//       `{ok:false, error:STRING}` with no detail).
//
// Honesty signals:
//   * `hash_mismatch` is surfaced as a non-fatal warning ("pack may be
//     tampered") rather than aborting — the caller may still want the
//     editorial preview, just with a tamper flag.
//   * License is parsed through license-layer.parseLicense; the
//     `license_commercial` boolean is its `.allowed_usage.commercial`.
//   * `source_trust` is computed via source-trust.computeTrustScore and
//     then banded into 'verified' (≥75) / 'community' (≥40) / 'unverified'.
//
// API:
//   distillPack({ packPath, requireLicenseKnown?, minTrustBand?, maxBytes? })
//     → Promise<{ok, distill?, error?, detail?}>
//
// Error codes:
//   BAD_INPUT          — packPath missing / not a string / traversal shape
//   PACK_NOT_FOUND     — file does not exist
//   PACK_TOO_LARGE     — file size exceeds maxBytes (default 200MB)
//   PACK_UNREADABLE    — file exists but cannot be opened (perms / locked)
//   INVALID_PACK       — magic / manifest / framing failed
//   HASH_MISMATCH      — manifest.pack_hash does not match recomputed
//                        (still returns distill on non-strict path; see below)
//   LICENSE_UNKNOWN    — parseLicense returned 'unknown' AND
//                        requireLicenseKnown=true
//   TRUST_BELOW_FLOOR  — source_trust band below minTrustBand
//   EXCEPTION          — unexpected throw (now carries `detail`)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const _packImport = require('./pack-import');
const _licenseLayer = require('./license-layer');
const _sourceTrust = require('./source-trust');
const _securityLayer = require('./security-layer');

const PACK_MAGIC     = _packImport.PACK_MAGIC;
const FILE_SEPARATOR = _packImport.FILE_SEPARATOR;
const FILE_END       = _packImport.FILE_END;

const LESSON_EXCERPT_MAX_CHARS = 500;
const TOPIC_SUMMARY_MAX_CHARS  = 300;
const MAX_LESSON_TITLES        = 5;

// boot-6: align with app/lib/source-extractor.js per-file cap (200MB). Packs
// larger than this are likely either binary-payload-renamed-pack or
// pathological — refuse fast before readFileSync hogs RAM.
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

// boot-6: trust band ordering — band[i] > band[j] iff i < j. Used by
// minTrustBand gate.
const TRUST_BAND_ORDER = Object.freeze(['verified', 'community', 'unverified']);

// ---------------------------------------------------------------------------
// boot-6 helpers — structured error logging + envelope construction
// ---------------------------------------------------------------------------

// Replaces the legacy `catch (_) {}` silent-swallow pattern. Logging is
// console.warn so it surfaces during dev + does not break the read-only
// distill path. Per `silent_catch_hides_typeerror` (2026-05-13).
function _logTrappedError(scope, err) {
  if (!err) return;
  const msg = err && err.message ? err.message : String(err);
  const isType = err instanceof TypeError;
  const tag = isType ? '[pack-distiller TypeError]' : '[pack-distiller warn]';
  try {
    console.warn(`${tag} ${scope}: ${msg}`);
  } catch (loggingFailure) {
    // Don't let logging itself become a silent-swallow point — note it on
    // process.stderr if the global console is missing.
    try { process.stderr.write(`${tag} ${scope}: ${msg}\n`); } catch (_inner) { /* truly nothing we can do */ }
  }
}

// Canonical error envelope — keeps shape consistent across paths.
function _errEnvelope(code, detail) {
  const env = { ok: false, error: code };
  if (detail != null) env.detail = String(detail).slice(0, 280);
  return env;
}

// Validates the packPath argument shape BEFORE touching fs. Returns
// `{ok:true, abs}` on success, an error envelope on failure.
function _validatePackPathArg(packPath) {
  if (packPath == null || typeof packPath !== 'string') {
    return _errEnvelope('BAD_INPUT', 'packPath required (string)');
  }
  const trimmed = packPath.trim();
  if (trimmed.length === 0) {
    return _errEnvelope('BAD_INPUT', 'packPath is empty');
  }
  if (trimmed.length > 4096) {
    return _errEnvelope('BAD_INPUT', 'packPath too long');
  }
  // Null-byte injection guard.
  if (trimmed.indexOf(String.fromCharCode(0)) >= 0) {
    return _errEnvelope('BAD_INPUT', 'packPath contains NUL byte');
  }
  let abs;
  try {
    abs = path.resolve(trimmed);
  } catch (err) {
    return _errEnvelope('BAD_INPUT', `path.resolve failed: ${err && err.message}`);
  }
  return { ok: true, abs };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function _readPackBytes(packPath, maxBytes) {
  const abs = path.resolve(packPath);
  if (!fs.existsSync(abs)) return _errEnvelope('PACK_NOT_FOUND', abs);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (err) {
    return _errEnvelope('PACK_UNREADABLE', err && err.message);
  }
  if (!stat.isFile()) {
    return _errEnvelope('INVALID_PACK', 'path is not a regular file');
  }
  if (stat.size > maxBytes) {
    return _errEnvelope('PACK_TOO_LARGE',
      `pack ${stat.size} bytes exceeds cap ${maxBytes}`);
  }
  // Permission pre-check — better error than a generic readFileSync throw.
  try {
    fs.accessSync(abs, fs.constants.R_OK);
  } catch (err) {
    return _errEnvelope('PACK_UNREADABLE', err && err.message);
  }
  try {
    return { ok: true, buf: fs.readFileSync(abs), size: stat.size };
  } catch (err) {
    return _errEnvelope('PACK_UNREADABLE', err && err.message);
  }
}

function _truncate(str, max) {
  if (typeof str !== 'string') return '';
  if (str.length <= max) return str;
  return str.slice(0, max);
}

function _bandTrust(score) {
  if (!Number.isFinite(score)) return 'unverified';
  if (score >= 75) return 'verified';
  if (score >= 40) return 'community';
  return 'unverified';
}

// Returns true iff `actual` band is >= `floor` band per TRUST_BAND_ORDER.
function _trustBandGTE(actual, floor) {
  if (!floor) return true;
  const ai = TRUST_BAND_ORDER.indexOf(actual);
  const fi = TRUST_BAND_ORDER.indexOf(floor);
  if (ai < 0 || fi < 0) return false;
  return ai <= fi; // lower index = higher band
}

function _bufIndexOf(haystack, needle, fromIndex = 0) {
  return haystack.indexOf(needle, fromIndex);
}

// Walks the pack body the same way pack-import.js does, but returns a sparse
// in-memory index of {relPath, bodyStart, declaredLen} entries WITHOUT
// copying the payload bytes. Caller decides which entries to slice + decode.
function _indexFileBlocks(buf, bodyStart) {
  const sepBuf = Buffer.from(FILE_SEPARATOR, 'utf8');
  const endBuf = Buffer.from(FILE_END, 'utf8');
  const headerTerm = Buffer.from('\n\n', 'utf8');
  const entries = [];
  let cursor = bodyStart;

  while (true) {
    if (buf.length - cursor >= endBuf.length &&
        buf.slice(cursor, cursor + endBuf.length).compare(endBuf) === 0) {
      cursor += endBuf.length;
      break;
    }
    if (buf.length - cursor < sepBuf.length ||
        buf.slice(cursor, cursor + sepBuf.length).compare(sepBuf) !== 0) {
      return { ok: false, error: 'expected_separator_or_end' };
    }
    cursor += sepBuf.length;

    const headerEnd = _bufIndexOf(buf, headerTerm, cursor);
    if (headerEnd < 0) return { ok: false, error: 'truncated_entry_header' };
    const headerStr = buf.slice(cursor, headerEnd).toString('utf8');
    const m = headerStr.match(/^filename:\s*([^\n]+)\nsize:\s*(\d+)$/);
    if (!m) return { ok: false, error: 'malformed_entry_header' };
    const relPath = m[1].trim();
    const declaredLen = parseInt(m[2], 10);
    if (!Number.isFinite(declaredLen) || declaredLen < 0) {
      return { ok: false, error: 'invalid_entry_size' };
    }
    cursor = headerEnd + headerTerm.length;
    if (cursor + declaredLen > buf.length) {
      return { ok: false, error: 'truncated_entry_body' };
    }
    entries.push({ relPath, bodyStart: cursor, declaredLen });
    cursor += declaredLen;
  }
  return { ok: true, entries };
}

// Find magic + locate first file separator → returns manifest bytes range so
// callers can pull manifest themselves OR sniff body offset. We piggy-back on
// inspectPack for manifest parsing (canonical path), but need the bodyStart
// for our own block index — so we re-derive it here cheaply.
function _findBodyStart(buf) {
  const magicBuf = Buffer.from(PACK_MAGIC, 'utf8');
  if (buf.length < magicBuf.length ||
      buf.slice(0, magicBuf.length).compare(magicBuf) !== 0) {
    return -1;
  }
  const sepBuf = Buffer.from(FILE_SEPARATOR, 'utf8');
  return _bufIndexOf(buf, sepBuf, magicBuf.length);
}

function _safeJSONParse(str, scope) {
  try {
    return JSON.parse(str);
  } catch (err) {
    _logTrappedError(`safeJSONParse:${scope || 'unknown'}`, err);
    return null;
  }
}

function _decodeUtf8(buf, start, len) {
  return buf.slice(start, start + len).toString('utf8');
}

// boot-6: route any text destined for LLM context through security-layer.
// Returns { text, sanitized:boolean, removed:Array }.
function _sanitizeForLLMSafe(raw, scope) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { text: '', sanitized: false, removed: [] };
  }
  try {
    const r = _securityLayer.sanitizeForLLM(raw);
    const removed = Array.isArray(r && r.removed) ? r.removed : [];
    return {
      text: (r && typeof r.sanitized === 'string') ? r.sanitized : raw,
      sanitized: removed.length > 0,
      removed,
    };
  } catch (err) {
    _logTrappedError(`sanitizeForLLM:${scope || 'unknown'}`, err);
    return { text: raw, sanitized: false, removed: [] };
  }
}

// ---------------------------------------------------------------------------
// pack_hash recheck — non-fatal warning surface
// ---------------------------------------------------------------------------

function _verifyPackHash(manifest) {
  if (!manifest || !manifest.contents || typeof manifest.pack_hash !== 'string') {
    return { ok: false };
  }
  try {
    const canonical = JSON.stringify(manifest.contents);
    const recomputed = crypto.createHash('sha256')
      .update(Buffer.from(canonical, 'utf8'))
      .digest('hex');
    return { ok: recomputed === manifest.pack_hash };
  } catch (err) {
    _logTrappedError('verifyPackHash', err);
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// distill builder — composes editorial card from manifest + sampled bodies
// ---------------------------------------------------------------------------

function _buildLessonsSummary(entries, buf, sanitizationEvents) {
  // Lesson files match `lesson-<digits>.md` at slug-root level. Sort
  // numerically, take first MAX_LESSON_TITLES titles + first 2 excerpts.
  const lessons = entries
    .filter(e => /^lesson-\d+\.md$/i.test(e.relPath))
    .sort((a, b) => {
      const an = parseInt(a.relPath.match(/lesson-(\d+)\.md/i)[1], 10);
      const bn = parseInt(b.relPath.match(/lesson-(\d+)\.md/i)[1], 10);
      return an - bn;
    });

  const titles = [];
  let lesson_0_excerpt = '';
  for (let i = 0; i < lessons.length && titles.length < MAX_LESSON_TITLES; i++) {
    const e = lessons[i];
    // Decode just the head — title sits in frontmatter or first H1 line.
    const headLen = Math.min(e.declaredLen, 1024);
    const head = _decodeUtf8(buf, e.bodyStart, headLen);
    let title = null;
    const fmTitle = head.match(/^---[\s\S]*?\ntitle:\s*["']?([^"'\n]+)["']?\s*\n[\s\S]*?---/);
    if (fmTitle) {
      title = fmTitle[1].trim();
    } else {
      const h1 = head.match(/^#\s+(.+)$/m);
      if (h1) title = h1[1].trim();
    }
    // boot-6: titles flow to UI + potentially LLM — sanitize.
    const titleRaw = title || e.relPath;
    const titleSan = _sanitizeForLLMSafe(titleRaw, `lesson_title:${e.relPath}`);
    if (titleSan.sanitized) sanitizationEvents.push({ where: `lesson_title:${e.relPath}`, count: titleSan.removed.length });
    titles.push(titleSan.text);
    if (i === 0) {
      const excerptLen = Math.min(e.declaredLen, LESSON_EXCERPT_MAX_CHARS);
      const rawExcerpt = _truncate(_decodeUtf8(buf, e.bodyStart, excerptLen), LESSON_EXCERPT_MAX_CHARS);
      const exSan = _sanitizeForLLMSafe(rawExcerpt, `lesson_0_excerpt:${e.relPath}`);
      if (exSan.sanitized) sanitizationEvents.push({ where: `lesson_0_excerpt:${e.relPath}`, count: exSan.removed.length });
      lesson_0_excerpt = exSan.text;
    }
  }

  return { count: lessons.length, titles, lesson_0_excerpt };
}

function _buildSourcesSummary(sourcesJson) {
  if (!sourcesJson || typeof sourcesJson !== 'object') {
    return { total: 0, breakdown: {} };
  }
  // sources.json may be {chapters: [...]} or [{...}] depending on version.
  const rows = Array.isArray(sourcesJson)
    ? sourcesJson
    : (Array.isArray(sourcesJson.chapters) ? sourcesJson.chapters : []);
  const breakdown = {};
  let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    total++;
    const t = (row.sourceType || row.kind || 'unknown') + '';
    breakdown[t] = (breakdown[t] || 0) + 1;
  }
  return { total, breakdown };
}

function _buildPersonaWisdomSummary(entries, buf) {
  // Persona wisdom files live under `.persona-wisdom/<id>.md` or sometimes
  // `persona-wisdom/...` if the pack was exported by an older HYPHA build.
  const matched = entries.filter(e =>
    /(^|\/)(\.?persona-wisdom)\//.test(e.relPath) && /\.md$/i.test(e.relPath)
  );
  const ids = matched.map(e => {
    const base = path.posix.basename(e.relPath).replace(/\.md$/i, '');
    return base;
  });
  return { count: matched.length, ids };
}

function _countJSONLRows(entries, buf, relPath) {
  const e = entries.find(x => x.relPath === relPath || x.relPath.endsWith('/' + relPath));
  if (!e) return null;
  const body = _decodeUtf8(buf, e.bodyStart, e.declaredLen);
  let count = 0;
  for (const line of body.split('\n')) {
    if (line.trim()) count++;
  }
  return { count };
}

function _readEntryJSON(entries, buf, candidatePaths, scope) {
  for (const cand of candidatePaths) {
    const e = entries.find(x => x.relPath === cand);
    if (!e) continue;
    return _safeJSONParse(_decodeUtf8(buf, e.bodyStart, e.declaredLen), scope || cand);
  }
  return null;
}

// ---------------------------------------------------------------------------
// public — distillPack
// ---------------------------------------------------------------------------

async function distillPack(opts = {}) {
  // boot-6 hardening — input shape gate (BAD_INPUT instead of PACK_NOT_FOUND
  // for malformed args; user can distinguish "wrong call" from "file gone").
  const argCheck = _validatePackPathArg(opts && opts.packPath);
  if (!argCheck.ok) return argCheck;
  const packPath = argCheck.abs;

  const maxBytes = (typeof opts.maxBytes === 'number' && opts.maxBytes > 0)
    ? Math.min(opts.maxBytes, DEFAULT_MAX_BYTES * 4) // safety ceiling
    : DEFAULT_MAX_BYTES;

  let r;
  try {
    r = _readPackBytes(packPath, maxBytes);
  } catch (err) {
    _logTrappedError('readPackBytes', err);
    return _errEnvelope('EXCEPTION', err && err.message);
  }
  if (!r.ok) return r;

  // Manifest validation via canonical inspectPack path (pack-import.js).
  // inspectPack returns {ok:false, error:'pack_hash_mismatch', manifest}
  // for tampered packs — we treat that case as recoverable here.
  let manifest;
  let hashMismatch = false;
  try {
    const ins = _packImport.inspectPack(packPath);
    if (!ins.ok) {
      if (ins.error === 'pack_hash_mismatch' && ins.manifest) {
        manifest = ins.manifest;
        hashMismatch = true;
      } else if (ins.error === 'pack_not_found') {
        return _errEnvelope('PACK_NOT_FOUND', packPath);
      } else {
        return _errEnvelope('INVALID_PACK', ins.error);
      }
    } else {
      manifest = ins.manifest;
    }
  } catch (err) {
    _logTrappedError('inspectPack', err);
    return _errEnvelope('EXCEPTION', err && err.message);
  }

  // Secondary cross-check — should match inspectPack's verdict, but cheap.
  if (!hashMismatch) {
    const v = _verifyPackHash(manifest);
    if (v.ok === false) hashMismatch = true;
  }

  // Body index — needed to sample state.json / lesson heads / etc.
  const bodyStart = _findBodyStart(r.buf);
  if (bodyStart < 0) {
    return _errEnvelope('INVALID_PACK', 'magic_or_separator_missing');
  }

  let index;
  try {
    index = _indexFileBlocks(r.buf, bodyStart);
  } catch (err) {
    _logTrappedError('indexFileBlocks', err);
    return _errEnvelope('EXCEPTION', err && err.message);
  }
  if (!index.ok) {
    return _errEnvelope('INVALID_PACK', index.error);
  }
  const entries = index.entries;

  // Compose distill fields.
  const warnings = [];
  const sanitizationEvents = [];
  if (hashMismatch) warnings.push('hash_mismatch — pack may be tampered');

  // state.json + agent.json + sources.json — try slug-relative roots.
  // pack-export stores them at the top of slug/, so rel paths are the
  // file names directly.
  const state = _readEntryJSON(entries, r.buf, ['state.json'], 'state.json') || {};
  const agent = _readEntryJSON(entries, r.buf, ['agent.json'], 'agent.json') || {};
  const sources = _readEntryJSON(entries, r.buf, ['sources.json'], 'sources.json');

  const lessons = _buildLessonsSummary(entries, r.buf, sanitizationEvents);
  const sourcesSummary = _buildSourcesSummary(sources);
  const personaWisdoms = _buildPersonaWisdomSummary(entries, r.buf);

  // Creation System files — optional, may be absent on older packs.
  const decisions = _countJSONLRows(entries, r.buf, 'decisions.jsonl');
  const sparks = _countJSONLRows(entries, r.buf, 'sparks.jsonl');

  // License — pass a synthetic pack-shaped object to license-layer.
  const licenseInput = {
    license: manifest.license,
    author: manifest.author || agent.displayName || null,
    topic: state.topic || manifest.source_slug,
  };
  let licenseParsed;
  try {
    licenseParsed = _licenseLayer.parseLicense(licenseInput);
  } catch (err) {
    _logTrappedError('parseLicense', err);
    licenseParsed = { license: 'unknown', allowed_usage: { commercial: false } };
    warnings.push('license_unclear');
  }
  if (licenseParsed.license === 'unknown') warnings.push('license_unclear');

  // boot-6 GATE: requireLicenseKnown — abort distill if license unknown.
  if (opts.requireLicenseKnown && licenseParsed.license === 'unknown') {
    return _errEnvelope('LICENSE_UNKNOWN',
      `license field "${manifest.license == null ? 'absent' : manifest.license}" did not resolve`);
  }

  // Source trust — feed a synthetic pack into source-trust.computeTrustScore.
  // The fields it inspects: curator_pubkey / ratified_by / created_at /
  // citations / sources. We pass through what we have from manifest + state.
  const trustPackShape = {
    curator_pubkey: manifest.curator_pubkey || null,
    ratified_by: manifest.ratified_by || [],
    created_at: manifest.exported_at || null,
    citations: state.citations || manifest.citations || [],
    sources: Array.isArray(sources)
      ? sources
      : (sources && Array.isArray(sources.chapters) ? sources.chapters : []),
  };
  let trustScore = 0;
  try {
    trustScore = _sourceTrust.computeTrustScore(trustPackShape);
  } catch (err) {
    _logTrappedError('computeTrustScore', err);
  }
  const sourceTrustBand = _bandTrust(trustScore);

  // boot-6 GATE: minTrustBand — abort distill if source trust below floor.
  if (opts.minTrustBand) {
    const floor = String(opts.minTrustBand).toLowerCase();
    if (TRUST_BAND_ORDER.indexOf(floor) < 0) {
      return _errEnvelope('BAD_INPUT',
        `minTrustBand "${opts.minTrustBand}" not in [${TRUST_BAND_ORDER.join('|')}]`);
    }
    if (!_trustBandGTE(sourceTrustBand, floor)) {
      return _errEnvelope('TRUST_BELOW_FLOOR',
        `source_trust=${sourceTrustBand} below floor=${floor} (score=${trustScore})`);
    }
  }

  // Goal contract — Creation System §11.4 anchor.
  const goal_contract = state.goal_contract || state.goalContract || null;

  // Topic summary — pull from state.learn_goal head or state.description.
  // boot-6: route through security-layer before exposing to LLM context.
  const topicSummaryRaw = (state.learn_goal || state.description || state.topic || '') + '';
  const topicSummaryTruncated = _truncate(topicSummaryRaw, TOPIC_SUMMARY_MAX_CHARS);
  const topicSan = _sanitizeForLLMSafe(topicSummaryTruncated, 'topic_summary');
  if (topicSan.sanitized) sanitizationEvents.push({ where: 'topic_summary', count: topicSan.removed.length });
  const topic_summary = topicSan.text;

  // Size estimate — manifest reports authoritative `total_size_bytes`.
  const totalBytes = typeof manifest.total_size_bytes === 'number'
    ? manifest.total_size_bytes
    : (r.size || 0);
  const size_estimate_mb = Math.round((totalBytes / (1024 * 1024)) * 100) / 100;

  // Aged-pack warning — packs older than 12 months may have stale citations.
  if (manifest.exported_at) {
    try {
      const ageMs = Date.now() - new Date(manifest.exported_at).getTime();
      if (Number.isFinite(ageMs) && ageMs > 12 * 30 * 24 * 3600 * 1000) {
        warnings.push('pack_too_old — exported > 12 months ago');
      }
    } catch (err) {
      _logTrappedError('agePackCheck', err);
    }
  }

  if (sourcesSummary.total === 0) warnings.push('missing_sources');
  if (sanitizationEvents.length > 0) {
    const totalRemoved = sanitizationEvents.reduce((acc, ev) => acc + (ev.count || 0), 0);
    warnings.push(`security_sanitized — ${totalRemoved} pattern${totalRemoved === 1 ? '' : 's'} stripped from ${sanitizationEvents.length} field${sanitizationEvents.length === 1 ? '' : 's'}`);
  }

  const distill = {
    pack_id: manifest.pack_id || null,
    source_slug: manifest.source_slug || null,
    archetype: manifest.archetype || state.archetype || null,
    license: licenseParsed.license,
    license_commercial: !!(licenseParsed.allowed_usage && licenseParsed.allowed_usage.commercial),
    source_trust: sourceTrustBand,
    source_trust_score: trustScore,
    topic: state.topic || manifest.source_slug || null,
    learn_goal: state.learn_goal || null,
    goal_contract,
    lessons: { count: lessons.count, titles: lessons.titles },
    sources: sourcesSummary,
    persona_wisdoms: personaWisdoms,
    decisions,
    sparks,
    size_estimate_mb,
    contents_sample: {
      lesson_0_excerpt: lessons.lesson_0_excerpt || '',
      topic_summary,
    },
    warnings,
    // boot-6: surface sanitization events for renderer audit (count only,
    // no original payload — that would re-introduce the injection).
    sanitization_events: sanitizationEvents.map(ev => ({ where: ev.where, count: ev.count })),
  };

  return { ok: true, distill };
}

module.exports = {
  distillPack,
  // boot-6: exported for smoke harness only.
  _internals: {
    DEFAULT_MAX_BYTES,
    TRUST_BAND_ORDER,
    _validatePackPathArg,
    _bandTrust,
    _trustBandGTE,
    _errEnvelope,
  },
};
