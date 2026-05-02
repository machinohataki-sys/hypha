'use strict';

// wiki-writeback — post-synth article evidence-section accumulator.
//
// After deepen-synth completes:
//   1. Scan synth output for [WIKI:slug] citations.
//   2. For each cited slug, fetch its current article (title + abstract).
//   3. Build a writeback prompt: synth + cited articles → list of "should this
//      slug get an evidence section appended?".
//   4. LLM returns either empty list (no new evidence) or per-article delta.
//   5. Append `## evidence (YYYY-MM-DD)` block to the article note's body.
//   6. Record ARTICLE_UPDATED event in event-log.
//
// Safety invariants:
//   • Body is APPEND-ONLY under the evidence header. User text is never touched.
//   • Frontmatter is NOT touched here — _wiki: re-distill happens separately.
//   • If parsing fails OR LLM returns nothing, no-op silently (no spam writes).
//   • Conflicts: same article gets multiple evidence sections over time, each
//     dated. User prunes manually if desired.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_MODEL = 'gemini-2.5-flash';
const WRITEBACK_TIMEOUT_MS = 60000;

// rel "ai-learn/SAGE.md" / slug "ai-learn/SAGE" → "ai-learn/SAGE.md"
function slugToRel(slug) {
  if (!slug) return '';
  return slug.endsWith('.md') ? slug : (slug + '.md');
}

let _templateCache = null;
function loadWritebackTemplate(promptsDir) {
  if (_templateCache) return _templateCache;
  const p = path.join(promptsDir, 'wiki-writeback.txt');
  _templateCache = fs.readFileSync(p, 'utf8');
  return _templateCache;
}

function interpolate(template, vars) {
  let out = template;
  for (const [k, v] of Object.entries(vars || {})) {
    out = out.split('{{' + k + '}}').join(String(v == null ? '' : v));
  }
  return out;
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
    const timeoutMs = opts.timeoutMs || WRITEBACK_TIMEOUT_MS;
    const finish = (payload) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      console.log(`[wiki-writeback] ${payload.ok ? 'OK' : 'ERR'} ${Date.now() - t0}ms`);
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

function parseUpdatesJson(rawText) {
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

// Run writeback for one synth result.
//
// @param {object} args
// @param {string} args.vaultRoot
// @param {string} args.synth         — full synth text (cited slugs are extracted from it)
// @param {string[]} args.citedSlugs  — slugs the caller already extracted
// @param {string} args.promptsDir
// @param {AbortSignal} [args.signal]
// @returns {Promise<{ ok, updates: [{slug, append_section}], skipped?: bool, error? }>}
async function runWriteback({ vaultRoot, synth, citedSlugs, promptsDir, signal }) {
  if (!vaultRoot || !synth) return { ok: false, error: 'vaultRoot + synth required', skipped: true };
  if (!Array.isArray(citedSlugs) || citedSlugs.length === 0) {
    return { ok: true, updates: [], skipped: true };
  }

  // Load each cited article's metadata from wiki-index. Packaged Hypha
  // excludes ptor2-legacy-corpus-bet — this require fails and we early-return.
  let wikiIndex;
  try { wikiIndex = require('../../../ptor2-legacy-corpus-bet/wiki/index'); }
  catch (_) {
    return { ok: true, updates: [], skipped: true, reason: 'wiki module unavailable' };
  }
  const idx = wikiIndex.loadIndex(vaultRoot);
  const citedArticles = [];
  for (const slug of citedSlugs) {
    const a = idx.articles[slug];
    if (a) {
      citedArticles.push({ slug, title: a.title, abstract: a.abstract, concepts: a.concepts });
    }
  }
  if (citedArticles.length === 0) {
    return { ok: true, updates: [], skipped: true, reason: 'no cited articles in index' };
  }

  // Format CITED_ARTICLES block
  const articlesBlock = citedArticles.map(a =>
    `[WIKI:${a.slug}]\n  title: ${a.title}\n  abstract: ${a.abstract || '(none)'}\n  concepts: ${(a.concepts || []).join(', ')}`
  ).join('\n\n');

  const template = loadWritebackTemplate(promptsDir);
  const prompt = interpolate(template, {
    SYNTH: synth,
    CITED_ARTICLES: articlesBlock,
  });

  const r = await geminiCall(prompt, { model: DEFAULT_MODEL, signal });
  if (!r.ok) return { ok: false, error: r.stderr };

  const parsed = parseUpdatesJson(r.text);
  if (!parsed || !Array.isArray(parsed.updates)) {
    return { ok: false, error: 'output not parseable JSON', raw: r.text.slice(0, 200) };
  }

  // Filter to valid slugs + non-empty append_section
  const validUpdates = parsed.updates
    .filter(u => u && u.slug && idx.articles[u.slug])
    .filter(u => typeof u.append_section === 'string' && u.append_section.trim().length > 10)
    .map(u => ({ slug: u.slug, append_section: u.append_section.trim() }));

  // Apply updates to disk
  const applied = [];
  for (const u of validUpdates) {
    try {
      const rel = slugToRel(u.slug);
      const abs = path.resolve(vaultRoot, rel);
      if (!abs.startsWith(path.resolve(vaultRoot))) continue;
      if (!fs.existsSync(abs)) continue;
      const cur = fs.readFileSync(abs, 'utf8');
      const date = new Date().toISOString().slice(0, 10);
      const block = `\n\n## evidence (${date})\n\n${u.append_section}\n`;
      fs.writeFileSync(abs, cur + block, 'utf8');
      applied.push({ slug: u.slug, rel, bytes: block.length });

      // Record ARTICLE_UPDATED event
      try {
        const eventLog = require('../../../ptor2-legacy-corpus-bet/corpus/event-log');
        if (eventLog && eventLog.record) {
          eventLog.record(vaultRoot, {
            op: 'article_updated',
            file: rel,
            agent_id: 'synth-writeback',
            meta: { change_type: 'evidence_appended', bytes: block.length },
          });
        }
      } catch (_) {}
    } catch (e) {
      console.log(`[wiki-writeback] apply failed for ${u.slug}: ${e.message}`);
    }
  }

  return { ok: true, updates: applied };
}

module.exports = { runWriteback, parseUpdatesJson };
