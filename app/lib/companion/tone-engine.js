'use strict';
// HYPHA · W3.5 Companion Layer — Tone Engine (v0).
//
// Generates Myco (菌类星人) expressions for 6 trigger types. T2_LOCAL Gemma
// 3 4B local Ollama call is TODO; v0 ships with mock templates that already
// honor BLUEPRINT §16 voice clamps. Templates are not placeholder strings —
// they ARE the v0 product. Local model upgrade later improves variety, not
// register.
//
// Boundary: this module only generates + locally validates. It does NOT
// enforce max_turns_per_session / lesson-in-progress / settings-off — those
// live in boundary-guard.js. Keeping the split sharp so the engine can be
// unit-tested without faking session state.

const fs = require('node:fs');
const path = require('node:path');
const { tagMockOutput } = require('../v0-mock-marker');

const CONTRACT_PATH = path.join(__dirname, 'contract.yaml');

// ── Minimal YAML parser ──────────────────────────────────────────────────
// Project does not have js-yaml installed (verified 2026-05-13). The
// contract.yaml is small + hand-authored, so we parse it with a focused
// loader instead of pulling a new runtime dep. Supports the exact subset
// the contract uses: scalars, block strings (|), list-of-scalars (- "..."),
// list-of-maps (- name: ... \n patterns: [...]). Inline JSON-flow arrays
// `[a, b, c]` supported for forbidden patterns. Comments + blank lines
// skipped. Not a general YAML library — do NOT extend without tests.
function _parseYAML(text) {
  const lines = text.split(/\r?\n/).map(l => l.replace(/\s+$/, ''));
  const root = {};
  let i = 0;

  function indentOf(line) {
    const m = line.match(/^(\s*)/);
    return m ? m[1].length : 0;
  }
  function isBlank(line) {
    return !line || /^\s*(#.*)?$/.test(line);
  }
  function stripComment(line) {
    // Strip trailing # comment unless inside quotes. Contract uses no quoted
    // # — safe shortcut. Preserve leading whitespace.
    const idx = line.indexOf(' #');
    return idx >= 0 ? line.slice(0, idx).replace(/\s+$/, '') : line;
  }
  function parseScalar(raw) {
    let s = raw.trim();
    if (s === '') return '';
    if (s === 'null' || s === '~') return null;
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
    // Quoted string
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
    // Inline flow array [a, "b", c]
    if (s.startsWith('[') && s.endsWith(']')) {
      const inner = s.slice(1, -1).trim();
      if (!inner) return [];
      // Split on commas not inside quotes — primitive but enough for our pattern lists
      const parts = [];
      let cur = '';
      let inStr = null;
      for (const ch of inner) {
        if (inStr) {
          cur += ch;
          if (ch === inStr) inStr = null;
        } else if (ch === '"' || ch === "'") {
          inStr = ch;
          cur += ch;
        } else if (ch === ',') {
          parts.push(cur);
          cur = '';
        } else {
          cur += ch;
        }
      }
      if (cur.trim()) parts.push(cur);
      return parts.map(p => parseScalar(p));
    }
    return s;
  }
  function parseBlockString(baseIndent) {
    // After `key: |` — collect lines whose indent > baseIndent. Join with
    // newlines, then strip the common leading indent.
    const out = [];
    let detectedIndent = null;
    while (i < lines.length) {
      const ln = lines[i];
      if (isBlank(ln)) { out.push(''); i++; continue; }
      const ind = indentOf(ln);
      if (ind <= baseIndent) break;
      if (detectedIndent == null) detectedIndent = ind;
      out.push(ln.slice(detectedIndent));
      i++;
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n');
  }
  function parseMap(baseIndent) {
    const obj = {};
    while (i < lines.length) {
      let raw = lines[i];
      if (isBlank(raw)) { i++; continue; }
      const ind = indentOf(raw);
      if (ind < baseIndent) break;
      if (ind > baseIndent) {
        // Should not happen at this entry point; skip.
        i++;
        continue;
      }
      const line = stripComment(raw);
      const trimmed = line.trim();
      // Key: value | Key: (multi-line)
      const m = trimmed.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (!m) { i++; continue; }
      const key = m[1];
      const val = m[2];
      if (val === '|' || val === '|-' || val === '>' || val === '>-') {
        i++;
        const block = parseBlockString(baseIndent);
        obj[key] = block.trim();
        continue;
      }
      if (val === '') {
        // Look-ahead: next non-blank line determines list-vs-map.
        i++;
        // Skip blanks
        let probe = i;
        while (probe < lines.length && isBlank(lines[probe])) probe++;
        if (probe >= lines.length) {
          obj[key] = null;
          continue;
        }
        const nextLine = stripComment(lines[probe]);
        const nextInd = indentOf(nextLine);
        if (nextInd <= baseIndent) {
          obj[key] = null;
          continue;
        }
        const nextTrim = nextLine.trim();
        if (nextTrim.startsWith('- ') || nextTrim === '-') {
          obj[key] = parseList(nextInd);
        } else {
          obj[key] = parseMap(nextInd);
        }
        continue;
      }
      // Inline scalar / inline flow array
      obj[key] = parseScalar(val);
      i++;
    }
    return obj;
  }
  function parseList(baseIndent) {
    const arr = [];
    while (i < lines.length) {
      const raw = lines[i];
      if (isBlank(raw)) { i++; continue; }
      const ind = indentOf(raw);
      if (ind < baseIndent) break;
      if (ind > baseIndent) { i++; continue; }
      const line = stripComment(raw).trim();
      if (!line.startsWith('-')) break;
      const rest = line.slice(1).trim();
      if (rest === '') {
        // Hanging dash → next-line nested map
        i++;
        arr.push(parseMap(baseIndent + 2));
        continue;
      }
      // Inline `- key: value` style → start of map item at this offset
      const kvMatch = rest.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (kvMatch) {
        const item = {};
        item[kvMatch[1]] = kvMatch[2] === '' ? null : parseScalar(kvMatch[2]);
        i++;
        // Continue collecting nested keys at the item's offset (rest start)
        const itemIndent = baseIndent + 2;
        const sub = parseMap(itemIndent);
        for (const k of Object.keys(sub)) item[k] = sub[k];
        arr.push(item);
        continue;
      }
      // Pure scalar `- "..."` or `- value`
      arr.push(parseScalar(rest));
      i++;
    }
    return arr;
  }
  Object.assign(root, parseMap(0));
  return root;
}

let _contractCache = null;
function loadContract({ fresh = false } = {}) {
  if (_contractCache && !fresh) return _contractCache;
  const raw = fs.readFileSync(CONTRACT_PATH, 'utf8');
  const obj = _parseYAML(raw);
  // Defensive defaults — if the YAML is corrupted or hand-edited badly, fall
  // back to safe values so callers don't crash.
  if (!obj.max_response_chars) obj.max_response_chars = 80;
  if (!obj.max_turns_per_session) obj.max_turns_per_session = 5;
  if (!Array.isArray(obj.triggers)) obj.triggers = [];
  if (!Array.isArray(obj.forbidden)) obj.forbidden = [];
  _contractCache = obj;
  return obj;
}

// ── Mock fallback templates (per trigger) ───────────────────────────────
// Each entry is an array; if local model is unavailable we pick the first
// one (deterministic for tests) — random pick is upgrade work, not v0.
const MOCK_TEMPLATES = {
  lesson_complete: [
    '孢子已经落进土里. 现在让它安静地长一会.',
    '今天的知识孢子落了下来. 不急着翻土.',
  ],
  interrupt_resume: [
    '菌丝没有死, 只是安静了三天. 今天接回一小段根须就够.',
    '腐殖层还在. 接回旧菌丝, 不必从头.',
  ],
  over_grind: [
    '暗处的菌丝需要时间. 不必每天都翻土.',
    '生长层需要发酵. 现在的安静不是停滞.',
  ],
  finish_capture: [
    '孢子收束. 开始发酵.',
    '收束孢子, 进入暗处.',
  ],
  product_spark_sprout: [
    '新菌芽冒头了.',
    '新菌芽从腐殖层里抽出.',
  ],
  note_revival: [
    '旧菌丝在另一边亮起.',
    '休眠孢子收到回流, 再次发光.',
  ],
};

const SUPPORTED_TRIGGERS = Object.freeze(Object.keys(MOCK_TEMPLATES));

/**
 * Produce one Myco expression for a trigger type.
 *
 * @param {string} triggerType — one of SUPPORTED_TRIGGERS
 * @param {object} [context]   — optional context (currently unused by mock,
 *                              wired for the T2_LOCAL Gemma upgrade)
 * @returns {Promise<string>}
 */
async function generateExpression(triggerType, context = {}) {
  if (!SUPPORTED_TRIGGERS.includes(triggerType)) {
    throw new Error(`Unknown companion trigger "${triggerType}". Supported: ${SUPPORTED_TRIGGERS.join(', ')}`);
  }
  // v1.0 boot-9 — T2_LOCAL preference probe. Privacy: when local is ready,
  // companion thoughts never leave the device. v1.0 always returns
  // ready:false (T2_LOCAL_AVAILABLE=false), so this is a no-op that proves
  // the wire is in place for v1.1+ swap-in. Any throw or non-ready status
  // falls through to MOCK_TEMPLATES — never blocks emission.
  try {
    const localModel = require('./local-model');
    const status = localModel.getModelStatus();
    if (status && status.ready === true && localModel.T2_LOCAL_AVAILABLE === true) {
      const result = await localModel.generateLocal({
        prompt: `[trigger=${triggerType}] ${JSON.stringify(context || {})}`,
        max_tokens: 80,
        temperature: 0.7,
      });
      if (result && typeof result.text === 'string' && result.text.trim()) {
        return result.text.trim();
      }
    }
  } catch (_) {
    // LOCAL_MODEL_NOT_READY or any other failure → fall through to mock.
  }
  // Mock templates below are NOT placeholder strings; they are the v0/v1.0
  // shipping product. Authored to honor BLUEPRINT §16 voice clamps verbatim.
  // The T2_LOCAL probe above will activate once v1.1+ flips the capability.
  const templates = MOCK_TEMPLATES[triggerType];
  // Deterministic v0 pick — test-stable. Variant rotation is later work.
  return templates[0];
}

/**
 * Envelope-form companion expression for renderer surfaces that want to know
 * whether the text came from a real local model or a v0 mock template. Wraps
 * the deterministic template pick (or, post-v0.8, the Gemma 3 4B output) with
 * a v0-mock-marker tag so `<V0MockBanner payload={...} />` can render
 * "v0 模板输出" in the corner of the companion toast.
 *
 * Kept separate from generateExpression(string) on purpose — generateValid +
 * validateExpression run lexical checks on a raw string and must not see an
 * object. This is the renderer-side cousin, never called from the boundary
 * guard path.
 *
 * @param {string} triggerType
 * @param {object} [context]
 * @returns {Promise<{ message: string, tone: string, _hypha_mock: string, _mock_reason: string }>}
 */
async function generateExpressionTagged(triggerType, context = {}) {
  const message = await generateExpression(triggerType, context);
  const tone = (context && typeof context.tone === 'string') ? context.tone : 'alien-quiet';
  return tagMockOutput(
    { message, tone, trigger: triggerType },
    'tone-engine 当前用 deterministic templates, Gemma 3 4B 本地 LLM 待 v0.8 上线',
  );
}

/**
 * Validate an expression against forbidden patterns + voice clamps that
 * are lexically checkable. Used by tests + as a defense-in-depth before
 * boundary-guard renders. Returns true if expression passes.
 *
 * Hard checks (lexical):
 *   - max_response_chars
 *   - any forbidden.patterns match
 *   - contains '!' (voice clamp: no exclamation)
 *   - contains emoji (BMP + supplementary plane heuristic)
 *
 * Semantic clamps (Garamond cadence, alien register) are NOT checkable
 * here — they are enforced by template authorship + future model prompt.
 *
 * @param {string} text
 * @param {object} [contract] — optional pre-loaded contract; auto-loads if absent
 * @returns {boolean}
 */
function validateExpression(text, contract) {
  if (typeof text !== 'string' || !text.trim()) return false;
  const c = contract || loadContract();
  if (text.length > (c.max_response_chars || 80)) return false;
  if (text.includes('!') || text.includes('！')) return false;
  if (_containsEmoji(text)) return false;
  for (const group of (c.forbidden || [])) {
    const patterns = Array.isArray(group.patterns) ? group.patterns : [];
    for (const p of patterns) {
      if (typeof p !== 'string' || !p) continue;
      if (text.includes(p)) return false;
    }
  }
  return true;
}

function _containsEmoji(s) {
  // Heuristic: surrogate pair (most emoji) OR common pictograph blocks.
  if (/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(s)) return true;
  if (/[☀-➿⌀-⏿]/.test(s)) return true;
  return false;
}

/**
 * Generate-then-validate, with one regen attempt. Returns the accepted
 * expression or null. boundary-guard.js still has final say on emission.
 */
async function generateValid(triggerType, context = {}) {
  const contract = loadContract();
  let text = await generateExpression(triggerType, context);
  if (validateExpression(text, contract)) return text;
  // Regen once — currently mock-deterministic so this is theatrical, but
  // wiring the path now means the T2_LOCAL upgrade gets it for free.
  text = await generateExpression(triggerType, context);
  if (validateExpression(text, contract)) return text;
  return null;
}

module.exports = {
  loadContract,
  generateExpression,
  generateExpressionTagged,
  validateExpression,
  generateValid,
  SUPPORTED_TRIGGERS,
  // Exposed for tests only.
  _parseYAML,
  MOCK_TEMPLATES,
};
