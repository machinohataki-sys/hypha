'use strict';
// HYPHA · W5.1 T2_LOCAL · Gemma 3 4B Ollama stub (per BLUEPRINT §17.2).
//
// Theory ship: surface contract locked, real Ollama wiring is fully present
// (POST /api/generate against http://localhost:11434), but when Ollama is
// unreachable we fall back to a template responder so callers never block
// or throw. Companion v0.8 will toggle to "Ollama required" once the
// runtime is part of the user-side install.
//
// Public surface:
//   runLocal(prompt, options) → Promise<string>
//   isOllamaAvailable()       → Promise<boolean>  (cached 5 min)

const http = require('http');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.HYPHA_LOCAL_MODEL || 'gemma3:4b';
const PROBE_TIMEOUT_MS = 1500;
const RUN_TIMEOUT_MS = 30_000;
const AVAILABILITY_CACHE_MS = 5 * 60_000;

let _availability = { value: null, checkedAt: 0, inflight: null };

// ---- Low-level HTTP helpers (no external deps) ------------------------------

function _parseUrl(u) {
  try { return new URL(u); } catch (_) { return null; }
}

function _httpRequest({ url, method = 'GET', body = null, timeoutMs = RUN_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const parsed = _parseUrl(url);
    if (!parsed) return reject(new Error('Invalid URL: ' + url));
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const opts = {
      method,
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + (parsed.search || ''),
      headers: {
        'accept': 'application/json',
        ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, text });
        } else {
          reject(new Error('Ollama HTTP ' + res.statusCode + ': ' + text.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout after ' + timeoutMs + 'ms')); });
    if (data) req.write(data);
    req.end();
  });
}

// ---- Availability probe (5-min cached) --------------------------------------

/**
 * Returns true if Ollama is reachable on OLLAMA_HOST. Cached 5 min.
 * Never throws — connection refused / timeout / DNS failure → false.
 *
 * @returns {Promise<boolean>}
 */
async function isOllamaAvailable() {
  const now = Date.now();
  if (_availability.value !== null && (now - _availability.checkedAt) < AVAILABILITY_CACHE_MS) {
    return _availability.value;
  }
  if (_availability.inflight) return _availability.inflight;
  _availability.inflight = (async () => {
    try {
      await _httpRequest({ url: OLLAMA_HOST + '/api/tags', method: 'GET', timeoutMs: PROBE_TIMEOUT_MS });
      _availability.value = true;
    } catch (_) {
      _availability.value = false;
    }
    _availability.checkedAt = Date.now();
    _availability.inflight = null;
    return _availability.value;
  })();
  return _availability.inflight;
}

// ---- Mock template responder ------------------------------------------------

// Companion v0.8 has 6 trigger types per specs/companion-triggers.md. The
// templates below are deliberately terse, manuscript-register (see
// hypha-constitution.js FORBIDDEN list — no "AI" / "model" / emoji), so a
// caller that hits this path during dev gets useful output rather than a
// throw or an empty string.
const COMPANION_TEMPLATES = {
  spark_sprout:      '一处新茬冒头，慢些看，先记下名字。',
  finish_ritual:     '这一节告一段落，回到桌边，深呼吸三次。',
  goal_drift:        '路偏了半步，停一下，对照原来的题目。',
  silence_too_long:  '已经很久没有声响，先抬头看看窗外。',
  misconception:     '此处需要再读一遍，原文比记忆更稳。',
  evidence_required: '把支撑这句话的来源贴上来，再继续。',
};

function _templateResponse(prompt) {
  const p = String(prompt || '').toLowerCase();
  for (const key of Object.keys(COMPANION_TEMPLATES)) {
    if (p.includes(key) || p.includes(key.replace(/_/g, ' '))) {
      return COMPANION_TEMPLATES[key];
    }
  }
  // Generic short echo — keeps unit tests deterministic on this branch too.
  const trimmed = String(prompt || '').slice(0, 80).trim();
  return trimmed ? '本地模型未到位，留底：' + trimmed : '本地模型未到位。';
}

// ---- Real Ollama generate ---------------------------------------------------

async function _ollamaGenerate(prompt, { model, maxTokens, temperature, timeoutMs }) {
  const body = {
    model: model || DEFAULT_MODEL,
    prompt: String(prompt || ''),
    stream: false,
    options: {
      ...(typeof temperature === 'number' ? { temperature } : {}),
      ...(typeof maxTokens === 'number' ? { num_predict: maxTokens } : {}),
    },
  };
  const { text } = await _httpRequest({
    url: OLLAMA_HOST + '/api/generate',
    method: 'POST',
    body,
    timeoutMs: timeoutMs || RUN_TIMEOUT_MS,
  });
  // Ollama returns one JSON object when stream=false: { response, done, ... }.
  let json;
  try { json = JSON.parse(text); } catch (e) {
    throw new Error('Ollama response not JSON: ' + text.slice(0, 200));
  }
  if (typeof json.response !== 'string') {
    throw new Error('Ollama response missing `response` field');
  }
  return json.response;
}

/**
 * Run a prompt through the local Gemma model via Ollama. Falls back to the
 * template responder if Ollama is unreachable — never throws on missing infra.
 *
 * @param {string} prompt
 * @param {object} [options]
 * @param {string} [options.model='gemma3:4b']
 * @param {number} [options.maxTokens]
 * @param {number} [options.temperature]
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.forceMock=false] — testing escape hatch
 * @returns {Promise<string>}
 */
async function runLocal(prompt, options = {}) {
  if (options.forceMock) return _templateResponse(prompt);
  const available = await isOllamaAvailable();
  if (!available) return _templateResponse(prompt);
  try {
    return await _ollamaGenerate(prompt, options);
  } catch (_) {
    // Real call failed mid-flight (model not installed, OOM, etc.) — flip
    // availability cache to false so the next 5 min go straight to mock.
    _availability.value = false;
    _availability.checkedAt = Date.now();
    return _templateResponse(prompt);
  }
}

// ---- Test seam --------------------------------------------------------------

function _resetAvailabilityCache() {
  _availability = { value: null, checkedAt: 0, inflight: null };
}

module.exports = {
  runLocal,
  isOllamaAvailable,
  _resetAvailabilityCache, // test-only
  COMPANION_TEMPLATES,
  DEFAULT_MODEL,
  OLLAMA_HOST,
};
