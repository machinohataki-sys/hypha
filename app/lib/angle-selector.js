'use strict';

// angle-selector — picks 5-6 deepen angles dynamically per invocation.
//
// Pipeline:
//   1. Load catalog from prompts/angles/_catalog.json
//   2. Run selector LLM call (cheap flash, ~2s) with selection + direction +
//      compact catalog
//   3. Parse JSON {chosen: [slug...], reasoning: "..."}
//   4. Validate (slugs exist in catalog, count in [5,6], coverage diversity)
//   5. Apply dependency resolution (if occam chosen but leo/lung absent,
//      auto-inject one)
//   6. On any failure → fall back to catalog.default_fallback
//
// The pipeline (lib/deepen-pipeline.js) calls selectAngles() once per
// runPipeline invocation.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SELECTOR_TIMEOUT_MS = 30000;
const SELECTOR_MODEL = 'gemini-2.5-flash';

// Catalog cache (per-process). Re-load on file mtime change for dev.
let _catalogCache = null;
let _catalogPath = null;
let _catalogMtime = 0;

function loadCatalog(promptsDir) {
  const p = path.join(promptsDir, 'angles', '_catalog.json');
  let stat;
  try { stat = fs.statSync(p); }
  catch (e) { throw new Error('catalog missing at ' + p); }
  if (_catalogPath === p && _catalogMtime === stat.mtimeMs && _catalogCache) return _catalogCache;
  const raw = fs.readFileSync(p, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.angles)) throw new Error('catalog schema invalid');
  _catalogCache = parsed;
  _catalogPath = p;
  _catalogMtime = stat.mtimeMs;
  return parsed;
}

let _selectorTemplateCache = null;
function loadSelectorTemplate(promptsDir) {
  if (_selectorTemplateCache) return _selectorTemplateCache;
  const p = path.join(promptsDir, 'deepen-selector.txt');
  _selectorTemplateCache = fs.readFileSync(p, 'utf8');
  return _selectorTemplateCache;
}

function interpolate(template, vars) {
  let out = template;
  for (const [k, v] of Object.entries(vars || {})) {
    out = out.split('{{' + k + '}}').join(String(v == null ? '' : v));
  }
  return out;
}

// Compact catalog for selector prompt: one line per angle.
function compactCatalog(catalog) {
  return catalog.angles.map(a => `- ${a.slug} (${a.category}): ${a.description}`).join('\n');
}

function geminiCall(prompt, opts = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let child;
    try {
      const model = process.env.GEMINI_MODEL || opts.model || null;
      const args = model ? ['-m', model] : [];
      child = spawn('gemini', args, {
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: 'true' },
      });
    } catch (e) {
      resolve({ ok: false, text: '', stderr: 'spawn failed: ' + e.message });
      return;
    }
    let stdout = '', stderr = '';
    let resolved = false;
    const timeoutMs = opts.timeoutMs || SELECTOR_TIMEOUT_MS;
    const finish = (payload) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      console.log(`[angle-selector] ${payload.ok ? 'OK' : 'ERR'} ${Date.now() - t0}ms`);
      resolve(payload);
    };
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch (_) {} finish({ ok: false, text: stdout, stderr: 'timeout' }); }, timeoutMs);

    if (opts.signal) {
      const onAbort = () => { try { child.kill('SIGTERM'); } catch (_) {} finish({ ok: false, text: stdout, stderr: 'aborted' }); };
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', err => finish({ ok: false, text: stdout, stderr: err.message }));
    child.on('close', code => finish({ ok: code === 0, text: stdout, stderr: stderr.slice(0, 500) }));

    try { child.stdin.write(prompt); child.stdin.end(); }
    catch (e) { finish({ ok: false, text: '', stderr: 'stdin: ' + e.message }); }
  });
}

function parseSelectorJson(rawText) {
  if (!rawText) return null;
  const stripped = String(rawText).replace(/\[[0-9;]*[a-zA-Z]/g, '').trim();
  const fenced = stripped.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : stripped;
  try { return JSON.parse(candidate); } catch (_) {}
  const m = candidate.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (_) {}
  }
  return null;
}

// Validate + dependency-resolve a chosen list.
// Returns { chosen, warnings: [] } where chosen is a sanitized list ordered
// such that dependencies precede dependents.
function validateAndResolve(rawChosen, catalog) {
  const slugMap = new Map(catalog.angles.map(a => [a.slug, a]));
  const warnings = [];
  // Filter to valid slugs
  let chosen = (rawChosen || []).filter(s => slugMap.has(s));
  if (chosen.length === 0) {
    return { chosen: catalog.default_fallback.slice(), warnings: ['no valid slugs; used default fallback'] };
  }
  // Dedupe preserving order
  chosen = Array.from(new Set(chosen));
  // Add missing dependencies
  const expanded = [];
  const seen = new Set();
  for (const slug of chosen) {
    const ang = slugMap.get(slug);
    for (const dep of (ang.needs || [])) {
      if (!seen.has(dep) && slugMap.has(dep)) {
        // Auto-inject only if dep is NOT already present in the chosen list
        // (so we don't double-add — the dep will appear when its own iteration
        // reaches it via the natural for-loop progression below)
        if (!chosen.includes(dep)) {
          expanded.push(dep);
          seen.add(dep);
          warnings.push('auto-injected dep ' + dep + ' for ' + slug);
        }
      }
    }
    if (!seen.has(slug)) {
      expanded.push(slug);
      seen.add(slug);
    }
  }
  // Cap at 7 to avoid runaway expansion (5-6 chosen + max 1-2 deps)
  if (expanded.length > 7) {
    warnings.push('chosen+deps exceeds 7, truncating');
    return { chosen: expanded.slice(0, 7), warnings };
  }
  // Topological order: dep before dependent. Simple stable algorithm since
  // catalog deps form a shallow DAG (no cycles in current 19-angle catalog).
  const ordered = topoSort(expanded, slugMap);
  return { chosen: ordered, warnings };
}

function topoSort(slugs, slugMap) {
  const slugSet = new Set(slugs);
  const visited = new Set();
  const out = [];
  function visit(s) {
    if (visited.has(s) || !slugSet.has(s)) return;
    visited.add(s);
    const ang = slugMap.get(s);
    for (const dep of (ang.needs || [])) {
      if (slugSet.has(dep)) visit(dep);
    }
    out.push(s);
  }
  for (const s of slugs) visit(s);
  return out;
}

// Main entry. Resolves with { chosen, reasoning, source: 'llm'|'fallback', warnings: [] }.
//
// @param {object} args
// @param {string} args.selection
// @param {string} [args.direction]
// @param {string} args.promptsDir
// @param {AbortSignal} [args.signal]
async function selectAngles({ selection, direction, promptsDir, signal }) {
  const catalog = loadCatalog(promptsDir);
  const fallback = () => ({
    chosen: validateAndResolve(catalog.default_fallback, catalog).chosen,
    reasoning: 'fallback (selector unavailable)',
    source: 'fallback',
    warnings: [],
  });

  if (!selection || String(selection).trim().length < 3) {
    return fallback();
  }

  const template = loadSelectorTemplate(promptsDir);
  const prompt = interpolate(template, {
    SELECTION: selection,
    DIRECTION: direction || '(none)',
    ANGLE_CATALOG: compactCatalog(catalog),
  });

  const r = await geminiCall(prompt, { model: SELECTOR_MODEL, signal });
  if (!r.ok) {
    console.log(`[angle-selector] selector call failed: ${r.stderr}, using fallback`);
    return { ...fallback(), source: 'fallback', warnings: ['selector call failed: ' + r.stderr] };
  }

  const parsed = parseSelectorJson(r.text);
  if (!parsed || !Array.isArray(parsed.chosen)) {
    console.log(`[angle-selector] selector output not parseable, using fallback. raw=${r.text.slice(0, 200)}`);
    return { ...fallback(), source: 'fallback', warnings: ['parse failed'] };
  }

  const { chosen, warnings } = validateAndResolve(parsed.chosen, catalog);
  if (chosen.length < 3) {
    console.log(`[angle-selector] chosen<3 after validation, using fallback`);
    return { ...fallback(), source: 'fallback', warnings: ['too few valid slugs after dedup'] };
  }

  return {
    chosen,
    reasoning: String(parsed.reasoning || '').slice(0, 200),
    source: 'llm',
    warnings,
  };
}

module.exports = {
  selectAngles,
  loadCatalog,
  validateAndResolve,
  parseSelectorJson,
  topoSort,
};
