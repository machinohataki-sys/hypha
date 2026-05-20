'use strict';
// HYPHA · Companion T2_LOCAL — local Gemma 3 4B interface scaffold (v1.0 boot-9).
//
// Scope (v1.0):
//   Ship the contract surface so v1.x can swap in a real llama.cpp / Ollama
//   bridge without touching any caller. The contract:
//
//     initLocalModel({ model_path, lazy })   → { ready, reason?, path }
//     generateLocal({ prompt, max_tokens, temperature })
//                                            → Promise<{ text, tokens_used, latency_ms }>
//                                              throws LOCAL_MODEL_NOT_READY when ready=false
//     getModelStatus()                       → { ready, model_name, model_size_mb,
//                                                ram_available_mb, expected_path }
//     downloadModel({ progress_cb })         → { ok:false, status:'not_implemented_v1.0' }
//     unloadModel()                          → { ok:true, released:boolean }
//
//   T2_LOCAL_AVAILABLE = false for v1.0. The router (DISPATCH_POLICY T2_LOCAL)
//   walks through any T2_LOCAL caller, hits LOCAL_MODEL_NOT_READY, and falls
//   straight through to the cloud chain (transparent to the user). v1.1+ flips
//   the flag once a real local runtime is bundled.
//
//   This module is intentionally bindings-free. We do a lazy require() of
//   `./local-stub` (Ollama wrapper) only when the model file is actually present
//   AND init was called with { lazy:false } — otherwise we never load anything
//   heavy. The Ollama path is treated as ONE possible local-runtime; future v1.x
//   can wire llama.cpp / llamafile via the same surface.
//
// Persistence:
//   Model file expected at  <vault>/.hypha/models/gemma-3-4b-q4.gguf
//   (default — overridable via initLocalModel({ model_path }).
//
// Failure handling:
//   Every public function returns a structured envelope OR throws a typed
//   Error (code = 'LOCAL_MODEL_NOT_READY'). Never crashes the caller.

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

// ---- Public capability flag (v1.0 = false) ---------------------------------

const T2_LOCAL_AVAILABLE = false;

// ---- Default model descriptor ----------------------------------------------

const DEFAULT_MODEL_NAME    = 'gemma-3-4b-q4';
const DEFAULT_MODEL_SIZE_MB = 4096; // ~4 GB Q4 quant
const DEFAULT_MODEL_FILE    = 'gemma-3-4b-q4.gguf';
const DEFAULT_VAULT_DIR     = path.join(process.cwd(), 'vault');

function _expectedModelPath(opts) {
  if (opts && typeof opts.model_path === 'string' && opts.model_path.trim()) {
    return opts.model_path.trim();
  }
  const vaultDir = (opts && opts.vault_dir) || process.env.HYPHA_VAULT_DIR || DEFAULT_VAULT_DIR;
  return path.join(vaultDir, '.hypha', 'models', DEFAULT_MODEL_FILE);
}

// ---- Module-level state ----------------------------------------------------

let _state = {
  ready:        false,
  reason:       'not_initialized',
  model_path:   null,
  initialized:  false,
  ollama_probe: null, // null | true | false (cached probe result, optional)
};

// ---- Helpers ---------------------------------------------------------------

function _safeStatBytes(p) {
  try {
    const st = fs.statSync(p);
    if (st && st.isFile()) return st.size;
    return null;
  } catch (_) {
    return null;
  }
}

function _safeFreeMemMB() {
  try {
    return Math.floor(os.freemem() / (1024 * 1024));
  } catch (_) {
    return null;
  }
}

class LocalModelNotReadyError extends Error {
  constructor(reason = 'model_not_downloaded', expectedPath = null) {
    super(`Local model not ready: ${reason}`);
    this.name = 'LocalModelNotReadyError';
    this.code = 'LOCAL_MODEL_NOT_READY';
    this.reason = reason;
    this.expected_path = expectedPath;
  }
}

// ---- Public API ------------------------------------------------------------

/**
 * Inspect-only init. Never downloads, never loads weights. With { lazy: true }
 * (the default) it only stats the expected path; if the file is missing we
 * return `{ ready:false, reason:'model_not_downloaded' }`. With { lazy: false }
 * we additionally probe the optional Ollama bridge (via the existing
 * local-stub) so future v1.1+ wiring can decide to use Ollama when present.
 *
 * @param {object} [opts]
 * @param {string} [opts.model_path] — explicit override for the .gguf path
 * @param {string} [opts.vault_dir]  — base dir (defaults to process.cwd()/vault)
 * @param {boolean} [opts.lazy=true]
 * @returns {{ ready: boolean, reason?: string, path: string }}
 */
function initLocalModel(opts = {}) {
  const lazy = opts.lazy !== false; // default true
  const expectedPath = _expectedModelPath(opts);

  _state.model_path  = expectedPath;
  _state.initialized = true;

  // v1.0 short-circuit. T2_LOCAL_AVAILABLE is false until v1.1+ — even if a
  // user manually drops the .gguf in place, we still report ready:false so
  // the router fallback path stays the only honest contract.
  if (!T2_LOCAL_AVAILABLE) {
    _state.ready  = false;
    _state.reason = 'capability_disabled_v1.0';
    return { ready: false, reason: _state.reason, path: expectedPath };
  }

  // Below this point is v1.1+ code, dormant in v1.0. Kept here so the swap-in
  // doesn't require rewriting initLocalModel.
  const size = _safeStatBytes(expectedPath);
  if (size == null) {
    _state.ready  = false;
    _state.reason = 'model_not_downloaded';
    return { ready: false, reason: _state.reason, path: expectedPath };
  }
  if (size < 100 * 1024 * 1024) {
    // <100 MB → almost certainly truncated/partial download
    _state.ready  = false;
    _state.reason = 'model_file_truncated';
    return { ready: false, reason: _state.reason, path: expectedPath };
  }

  if (!lazy) {
    try {
      const stub = require('../llm/local-stub');
      if (typeof stub.isOllamaAvailable === 'function') {
        // Fire-and-forget probe; the promise updates state on a later tick.
        Promise.resolve(stub.isOllamaAvailable()).then(
          (v) => { _state.ollama_probe = !!v; },
          ()  => { _state.ollama_probe = false; },
        );
      }
    } catch (_) { /* stub absent → fine */ }
  }

  _state.ready  = true;
  _state.reason = null;
  return { ready: true, path: expectedPath };
}

/**
 * Generate text via the local model. v1.0 always throws LOCAL_MODEL_NOT_READY
 * (capability disabled). v1.1+ will delegate to the underlying bridge.
 *
 * Callers MUST catch this error and fall back to cloud — never let it bubble
 * to the user. The router enforces this for executeChat('T2_LOCAL', ...).
 *
 * @param {object} args
 * @param {string} args.prompt
 * @param {number} [args.max_tokens=200]
 * @param {number} [args.temperature]
 * @returns {Promise<{ text: string, tokens_used: number, latency_ms: number, model_name: string }>}
 */
async function generateLocal(args = {}) {
  if (!_state.initialized) initLocalModel({ lazy: true });

  if (!_state.ready) {
    const reason = _state.reason || 'not_ready';
    throw new LocalModelNotReadyError(reason, _state.model_path);
  }

  // v1.1+ path: delegate to whichever bridge is wired. For now we route
  // through the existing local-stub (Ollama HTTP). If Ollama is down, the
  // stub falls back to its template responder — which would mask "local model
  // failed" as "local model succeeded with garbage". Detect + throw.
  const startedAt = Date.now();
  try {
    const stub = require('../llm/local-stub');
    if (typeof stub.runLocal !== 'function') {
      throw new LocalModelNotReadyError('bridge_not_wired', _state.model_path);
    }
    const available = (typeof stub.isOllamaAvailable === 'function')
      ? await stub.isOllamaAvailable()
      : false;
    if (!available) {
      throw new LocalModelNotReadyError('bridge_unreachable', _state.model_path);
    }
    const text = await stub.runLocal(String(args.prompt || ''), {
      maxTokens:    Number.isFinite(args.max_tokens) ? args.max_tokens : 200,
      temperature:  Number.isFinite(args.temperature) ? args.temperature : undefined,
    });
    const elapsed = Date.now() - startedAt;
    return {
      text:        String(text || ''),
      tokens_used: 0, // bridge does not surface counts; v1.2+ may add
      latency_ms:  elapsed,
      model_name:  DEFAULT_MODEL_NAME,
    };
  } catch (err) {
    if (err && err.code === 'LOCAL_MODEL_NOT_READY') throw err;
    // Bridge crashed mid-generation → surface as NOT_READY so caller falls back
    // cleanly to cloud, matching v1.0 contract.
    throw new LocalModelNotReadyError(
      'bridge_failed:' + ((err && err.message) || 'unknown'),
      _state.model_path,
    );
  }
}

/**
 * Inspect status without performing any I/O beyond a single statSync.
 * Safe to call from a hot UI loop (Settings polls this for status line).
 *
 * @returns {{ ready: boolean, model_name: string, model_size_mb: number,
 *            ram_available_mb: number|null, expected_path: string,
 *            reason: string|null, capability_available: boolean }}
 */
function getModelStatus() {
  if (!_state.initialized) initLocalModel({ lazy: true });
  return {
    ready:                _state.ready,
    model_name:           DEFAULT_MODEL_NAME,
    model_size_mb:        DEFAULT_MODEL_SIZE_MB,
    ram_available_mb:     _safeFreeMemMB(),
    expected_path:        _state.model_path,
    reason:               _state.reason,
    capability_available: T2_LOCAL_AVAILABLE,
  };
}

/**
 * v1.0 stub. Returns immediately with `not_implemented_v1.0`. v1.1+ will
 * stream chunked download progress via progress_cb({pct, bytes, total}).
 *
 * @param {object} [args]
 * @param {(p: { pct: number, bytes: number, total: number }) => void} [args.progress_cb]
 * @returns {Promise<{ ok: false, status: 'not_implemented_v1.0', message: string }>}
 */
async function downloadModel(_args = {}) {
  return {
    ok:      false,
    status:  'not_implemented_v1.0',
    message: '本地模型下载将在 v1.1+ 上线 (~4 GB Q4 量化, 8 GB RAM)。',
  };
}

/**
 * Release any in-memory weights. v1.0 has none → returns released:false
 * (no-op). v1.1+ frees the loaded model.
 */
function unloadModel() {
  _state.ready  = false;
  _state.reason = 'unloaded_by_caller';
  return { ok: true, released: false };
}

/**
 * Test seam. Reset module-level state so smoke tests can simulate a clean
 * boot without process restart.
 */
function _resetState() {
  _state = {
    ready: false, reason: 'not_initialized', model_path: null,
    initialized: false, ollama_probe: null,
  };
}

module.exports = {
  // Public API
  initLocalModel,
  generateLocal,
  getModelStatus,
  downloadModel,
  unloadModel,
  // Constants
  T2_LOCAL_AVAILABLE,
  DEFAULT_MODEL_NAME,
  DEFAULT_MODEL_SIZE_MB,
  DEFAULT_MODEL_FILE,
  // Errors
  LocalModelNotReadyError,
  // Test seam
  _resetState,
};
