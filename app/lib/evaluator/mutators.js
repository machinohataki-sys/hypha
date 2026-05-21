// V0.5 E0 — substrate mutation testing: mutators
//
// Pure-function module producing two arrays of code variants for a given JS
// source string:
//
//   perturbations(code)  -> semantic-preserving variants. exec-cell verifier
//                           SHOULD still pass these (expected_pass=true).
//   mutations(code)      -> semantic-breaking variants. exec-cell verifier
//                           SHOULD reject these (expected_pass=false).
//
// Each transformation may legitimately not apply to every input (e.g. no
// numeric literal > 1 to zero out). In that case the transformation is
// skipped -- the array gets fewer entries, never a fabricated one.
//
// String + comment regions are masked before any source-level transform so
// no perturbation/mutation ever edits literal characters inside a "..." or
// `// comment`.
//
// Created 2026-05-11 on v0.5-substrate (V0.5 E0 Path A mutation testing).

'use strict';

const JS_KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null',
  'of', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield', 'async', 'await',
  'static', 'enum', 'implements', 'interface', 'package', 'private',
  'protected', 'public',
]);

const JS_BUILTINS = new Set([
  'Math', 'Number', 'console', 'JSON', 'Array', 'String', 'Boolean',
  'undefined', 'null', 'Object', 'Symbol', 'BigInt', 'Date', 'RegExp',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Error', 'TypeError',
  'RangeError', 'SyntaxError', 'ReferenceError', 'parseFloat', 'parseInt',
  'isNaN', 'isFinite', 'globalThis', 'process', 'Buffer', 'require',
  'module', 'exports', '__dirname', '__filename', 'setTimeout',
  'setInterval', 'clearTimeout', 'clearInterval', 'Infinity', 'NaN',
]);

// Mask = a sentinel char that never appears as identifier/numeric character.
const MASK = '\x01';

// ---------- masking ----------

// Replace all string-literal and comment chars (except newlines) with MASK
// in a position-preserving fashion. Returns the masked string. Quote chars
// and comment delimiters are also masked so they do not match operator
// scans (e.g. // would otherwise mis-fire the operator-flip rule).
function _maskStringsAndComments(code) {
  const out = [];
  let i = 0;
  const n = code.length;

  while (i < n) {
    const c = code[i];
    const cc = code[i + 1];

    // line comment
    if (c === '/' && cc === '/') {
      while (i < n && code[i] !== '\n') {
        out.push(MASK);
        i++;
      }
      continue;
    }
    // block comment
    if (c === '/' && cc === '*') {
      out.push(MASK); out.push(MASK);
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
        out.push(code[i] === '\n' ? '\n' : MASK);
        i++;
      }
      if (i < n) {
        out.push(MASK); out.push(MASK);
        i += 2;
      }
      continue;
    }
    // string literals: ' " `
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out.push(MASK);
      i++;
      while (i < n && code[i] !== quote) {
        if (code[i] === '\\' && i + 1 < n) {
          out.push(MASK); out.push(MASK);
          i += 2;
          continue;
        }
        out.push(code[i] === '\n' ? '\n' : MASK);
        i++;
      }
      if (i < n) {
        out.push(MASK);
        i++;
      }
      continue;
    }
    out.push(c);
    i++;
  }

  return out.join('');
}

// ---------- helpers ----------

function _isPropertyAccess(masked, identIndex) {
  let j = identIndex - 1;
  while (j >= 0 && /\s/.test(masked[j])) j--;
  if (j < 0 || masked[j] !== '.') return false;
  // Exclude spread `...ident` — three consecutive dots = not a member access.
  if (masked[j - 1] === '.' && masked[j - 2] === '.') return false;
  return true;
}

function _isObjectKeyOrShorthand(masked, identIndex, identName) {
  const end = identIndex + identName.length;
  let k = end;
  while (k < masked.length && /\s/.test(masked[k])) k++;
  const next = masked[k];
  let j = identIndex - 1;
  while (j >= 0 && /\s/.test(masked[j])) j--;
  const prev = masked[j];
  const prevIsBraceOrComma = prev === '{' || prev === ',';
  if (prevIsBraceOrComma && next === ':') return true;
  if (prevIsBraceOrComma && (next === ',' || next === '}')) return true;
  return false;
}

function _findRenameTarget(masked) {
  // First declared local that is not keyword/builtin.
  const declRe = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let m;
  while ((m = declRe.exec(masked)) !== null) {
    const name = m[1];
    if (JS_KEYWORDS.has(name) || JS_BUILTINS.has(name)) continue;
    return name;
  }
  return null;
}

function _renameIdentifier(code, masked, oldName, newName) {
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^A-Za-z0-9_$])(${escaped})(?![A-Za-z0-9_$])`, 'g');
  const splices = [];
  let m;
  while ((m = re.exec(masked)) !== null) {
    const nameStart = m.index + m[1].length;
    if (_isPropertyAccess(masked, nameStart)) {
      re.lastIndex = nameStart + oldName.length;
      continue;
    }
    if (_isObjectKeyOrShorthand(masked, nameStart, oldName)) {
      re.lastIndex = nameStart + oldName.length;
      continue;
    }
    splices.push({ start: nameStart, end: nameStart + oldName.length });
    re.lastIndex = nameStart + oldName.length;
  }
  if (splices.length === 0) return null;
  let mutated = code;
  for (let i = splices.length - 1; i >= 0; i--) {
    const s = splices[i];
    mutated = mutated.slice(0, s.start) + newName + mutated.slice(s.end);
  }
  return mutated;
}

function _findFirstNumericLiteral(masked, predicate) {
  // Numbers in masked source, preceded by a non-ident, non-dot char.
  const re = /(^|[^A-Za-z0-9_$.])(\d+\.\d+(?:[eE][+-]?\d+)?|\d+(?:[eE][+-]?\d+)?)/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const raw = m[2];
    const val = Number(raw);
    if (Number.isNaN(val)) {
      re.lastIndex = m.index + m[0].length;
      continue;
    }
    const start = m.index + m[1].length;
    const end = start + raw.length;
    if (predicate(val, raw)) {
      return { start, end, value: val, raw };
    }
    re.lastIndex = end;
  }
  return null;
}

// ---------- PERTURBATIONS ----------

function _pRename(code, masked) {
  const target = _findRenameTarget(masked);
  if (!target) return null;
  const newName = target + '_x';
  const mutated = _renameIdentifier(code, masked, target, newName);
  if (mutated == null || mutated === code) return null;
  return {
    name: `rename_${target}_to_${newName}`,
    mutated_code: mutated,
    kind: 'perturbation',
    expected_pass: true,
  };
}

function _pNoopStatement(code) {
  const idx = code.indexOf(';');
  if (idx < 0) return null;
  const mutated = code.slice(0, idx + 1) + 'void 0;' + code.slice(idx + 1);
  return {
    name: 'noop_inject_void0',
    mutated_code: mutated,
    kind: 'perturbation',
    expected_pass: true,
  };
}

function _pInlineComment(code) {
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(';')) {
      lines[i] = lines[i] + ' // trace';
      return {
        name: 'inline_comment_trace',
        mutated_code: lines.join('\n'),
        kind: 'perturbation',
        expected_pass: true,
      };
    }
  }
  return {
    name: 'inline_comment_trace',
    mutated_code: code + ' // trace',
    kind: 'perturbation',
    expected_pass: true,
  };
}

function _pParenWrapNumber(code, masked) {
  const hit = _findFirstNumericLiteral(masked, (v) => v > 1 && Number.isFinite(v));
  if (!hit) return null;
  const mutated = code.slice(0, hit.start) + '(' + hit.raw + ')' + code.slice(hit.end);
  return {
    name: `paren_wrap_${hit.raw}`,
    mutated_code: mutated,
    kind: 'perturbation',
    expected_pass: true,
  };
}

function _pWhitespace(code) {
  const idx = code.indexOf(';');
  if (idx < 0) return null;
  const mutated = code.slice(0, idx + 1) + '\n' + code.slice(idx + 1);
  return {
    name: 'whitespace_extra_newline',
    mutated_code: mutated,
    kind: 'perturbation',
    expected_pass: true,
  };
}

function perturbations(code) {
  if (typeof code !== 'string' || code.trim() === '') return [];
  const masked = _maskStringsAndComments(code);
  const out = [];
  const candidates = [
    _pRename(code, masked),
    _pNoopStatement(code),
    _pInlineComment(code),
    _pParenWrapNumber(code, masked),
    _pWhitespace(code),
  ];
  for (const c of candidates) {
    if (c) out.push(c);
  }
  return out;
}

// ---------- MUTATIONS ----------

function _mOffByOne(code, masked) {
  const hit = _findFirstNumericLiteral(masked, (v, raw) =>
    v > 1 &&
    Number.isInteger(v) &&
    !raw.includes('.') &&
    !raw.includes('e') &&
    !raw.includes('E')
  );
  if (!hit) return null;
  const newVal = String(hit.value + 1);
  const mutated = code.slice(0, hit.start) + newVal + code.slice(hit.end);
  return {
    name: `off_by_one_${hit.raw}_to_${newVal}`,
    mutated_code: mutated,
    kind: 'mutation',
    expected_pass: false,
  };
}

function _mOperatorFlip(code, masked) {
  // Compound first so we don't mis-fire `<` against `<=`.
  const flips = [
    { from: '===', to: '!==' },
    { from: '!==', to: '===' },
    { from: '<=',  to: '>=' },
    { from: '>=',  to: '<=' },
    { from: '<',   to: '>' },
    { from: '>',   to: '<' },
    { from: '+',   to: '-' },
    { from: '-',   to: '+' },
    { from: '*',   to: '/' },
    { from: '/',   to: '*' },
  ];
  for (const { from, to } of flips) {
    let idx = -1;
    let searchFrom = 0;
    while ((idx = masked.indexOf(from, searchFrom)) >= 0) {
      const after = masked[idx + from.length];
      const before = masked[idx - 1];
      // skip composite contexts
      if (from === '<' && (after === '=' || after === '<')) { searchFrom = idx + 1; continue; }
      // '>' must not be the '>' inside '=>' (arrow) or '>=' / '>>'
      if (from === '>' && (after === '=' || after === '>' || before === '=')) { searchFrom = idx + 1; continue; }
      if (from === '+' && (after === '+' || after === '=' || before === '+')) { searchFrom = idx + 1; continue; }
      if (from === '-' && (after === '-' || after === '=' || before === '-')) { searchFrom = idx + 1; continue; }
      if (from === '*' && (after === '*' || after === '=' || before === '*')) { searchFrom = idx + 1; continue; }
      if (from === '/' && (after === '/' || after === '*' || after === '=' || before === '/' || before === '*')) {
        searchFrom = idx + 1;
        continue;
      }
      // unary context guard for + / -
      if (from === '+' || from === '-') {
        let j = idx - 1;
        while (j >= 0 && /\s/.test(masked[j])) j--;
        const prev = masked[j];
        if (prev === undefined || prev === '=' || prev === '(' || prev === ',' ||
            prev === ':' || prev === MASK || prev === '\n' || prev === ';' ||
            prev === '{' || prev === '[' || prev === '?' || prev === '&' ||
            prev === '|' || prev === '!') {
          searchFrom = idx + 1;
          continue;
        }
        if (!/[A-Za-z0-9_$)\]]/.test(prev)) { searchFrom = idx + 1; continue; }
      }
      const mutated = code.slice(0, idx) + to + code.slice(idx + from.length);
      return {
        name: `op_flip_${from}_to_${to}`,
        mutated_code: mutated,
        kind: 'mutation',
        expected_pass: false,
      };
    }
  }
  return null;
}

function _mConstantZero(code, masked) {
  const hit = _findFirstNumericLiteral(masked, (v) => v > 1 && Number.isFinite(v));
  if (!hit) return null;
  const mutated = code.slice(0, hit.start) + '0' + code.slice(hit.end);
  return {
    name: `const_zero_${hit.raw}_to_0`,
    mutated_code: mutated,
    kind: 'mutation',
    expected_pass: false,
  };
}

function _mSignFlip(code, masked) {
  const hit = _findFirstNumericLiteral(masked, (v) => v > 1 && Number.isFinite(v));
  if (!hit) return null;
  if (!/\d/.test(masked[hit.start])) return null;
  // Also require the slot before hit.start to NOT be part of a number context
  // already containing a unary minus.
  const prev = masked[hit.start - 1];
  if (prev === '-') return null;
  const mutated = code.slice(0, hit.start) + '-' + code.slice(hit.start);
  return {
    name: `sign_flip_${hit.raw}`,
    mutated_code: mutated,
    kind: 'mutation',
    expected_pass: false,
  };
}

function _dropCallAt(code, callStart, prefixLen, label) {
  let i = callStart + prefixLen;
  let depth = 1;
  let inString = null;
  while (i < code.length && depth > 0) {
    const c = code[i];
    if (inString) {
      if (c === '\\') { i += 2; continue; }
      if (c === inString) { inString = null; i++; continue; }
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inString = c; i++; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    i++;
  }
  if (depth !== 0) return null;
  let end = i;
  if (code[end] === ';') end++;
  const mutated = code.slice(0, callStart) + code.slice(end);
  if (mutated === code) return null;
  return {
    name: label,
    mutated_code: mutated,
    kind: 'mutation',
    expected_pass: false,
  };
}

function _mDropPrintStatement(code) {
  const startKey = 'console.log(';
  const lastStart = code.lastIndexOf(startKey);
  if (lastStart >= 0) return _dropCallAt(code, lastStart, startKey.length, 'drop_console_log');
  const altKey = 'process.stdout.write(';
  const altStart = code.lastIndexOf(altKey);
  if (altStart >= 0) return _dropCallAt(code, altStart, altKey.length, 'drop_process_stdout_write');
  return null;
}

function _mComparisonInvert(code) {
  const pairs = [
    ['Math.max',   'Math.min'],
    ['Math.min',   'Math.max'],
    ['Math.floor', 'Math.ceil'],
    ['Math.ceil',  'Math.floor'],
  ];
  for (const [from, to] of pairs) {
    const idx = code.indexOf(from);
    if (idx < 0) continue;
    const after = code[idx + from.length];
    if (after && /[A-Za-z0-9_$]/.test(after)) continue;
    const mutated = code.slice(0, idx) + to + code.slice(idx + from.length);
    return {
      name: `cmp_invert_${from}_to_${to}`,
      mutated_code: mutated,
      kind: 'mutation',
      expected_pass: false,
    };
  }
  return null;
}

function mutations(code) {
  if (typeof code !== 'string' || code.trim() === '') return [];
  const masked = _maskStringsAndComments(code);
  const out = [];
  const candidates = [
    _mOffByOne(code, masked),
    _mOperatorFlip(code, masked),
    _mConstantZero(code, masked),
    _mSignFlip(code, masked),
    _mDropPrintStatement(code),
    _mComparisonInvert(code),
  ];
  for (const c of candidates) {
    if (c) out.push(c);
  }
  return out;
}

module.exports = {
  perturbations,
  mutations,
  // exposed for unit-test / spot-check use
  _maskStringsAndComments,
  _findRenameTarget,
  _findFirstNumericLiteral,
};
