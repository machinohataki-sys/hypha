'use strict';

// Deepen pipeline — 7-stage parallel-wave gemini calls feeding each other.
// Stages grouped by topological dependency (extracted from prompt {{VAR}}
// references): independent stages run concurrently in waves; dependents wait.
//
// Dependency graph (from prompt analysis 2026-04-28):
//   scout: ()                             leo: ()
//   lung: scout                           nancy: scout, leo
//   occam: lung, leo                      muse: lung, leo, nancy
//   synth: scout, lung, leo, occam, nancy, muse
//
// Waves:
//   1. scout + leo                  (both no deps, ~parallel max wall ~scout)
//   2. lung + nancy                 (both ready after wave 1)
//   3. occam + muse                 (both ready after wave 2)
//   4. synth                        (sequential final integration)
//
// Wall time: ~5min sequential → ~2min wave (Lever 1) → ~1.5min with flash
// for non-synth stages (Lever 2). Synth retains default model for quality.
//
// Per /tr 2026-04-28 council Path B: replaces single-call AskCard. Output
// lands inline in NoteView body as a callout block (not modal).

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
// V2: wiki-context replaces vault-context (paragraph cosine RAG → graph
// walk over LLM-curated articles). wiki-context falls back to v1 vault-
// context internally if wiki-index.json is empty/missing, so the v1 module
// stays loaded by reference until v0.3 deletion.
const { buildWikiContext, extractWikiCitations } = require('./wiki-context');
const { runWriteback } = require('./wiki-writeback');
const { selectAngles, loadCatalog } = require('./angle-selector');

// V3 catalog-driven execution. Stages are no longer hardcoded — selector
// picks 5-6 angles from prompts/angles/_catalog.json per invocation. synth
// + quick stay hardcoded (synth = mandatory final integrator; quick = own
// path). Legacy STAGE_DEFS removed; per-angle timeouts come from catalog.
const SYNTH_TIMEOUT_MS = 360000;
const QUICK_TIMEOUT_MS = 30000;
const DEFAULT_ANGLE_TIMEOUT_MS = 240000;
// V3.2 (per user 2026-04-29 directive "我自己用就给我接入GEMINI最好的模型吧"):
// null = no `-m` flag = gemini CLI uses its default model (currently
// gemini-3.1-pro per project memory, the best in the family). Reverts V3.1
// synth-flash speed surgery — user accepts longer wait for higher output
// quality. If quota / cost becomes a problem, set GEMINI_MODEL env var to
// override per call without re-editing.
const DEFAULT_MODEL = null;

// V3.2: say-human register clamp. Appended to every prompt sent through
// geminiCall by default. Skipped only for callers that output JSON (selector
// / distill in their own files have their own geminiCall and are unaffected).
// Per user verbatim: "AI味太重导致假大空" — counter that with a hard register
// constraint that the LLM reads LAST (so it's freshest when generating).
const SAY_HUMAN_TAIL = `

—

写作 register (硬约束, 优先于上面所有规则):
- 说人话, 不 AI 腔. 严禁: "在...的语境下" / "值得注意的是" / "具有显著影响" / "在某种程度上" / "可以从多个维度"
- 假大空诊断: 任何句子里没有具体名字 / 数字 / 案例 / 真情境 → 删. 抽象再抽象 = 0 价值.
- 短句优先. 长定语 ≥ 25 字 = 改写. 一句话 ≤ 35 字优先.
- 用 "感觉卡" 代替 "性能瓶颈"; "我以为 X 其实 Y" 代替 "经分析存在差异"; "卡死了" 代替 "出现异常".
- 不奉承用户. 不开篇 "很高兴..." / "好的, 我来...". 不收尾 "希望对你有帮助" / "总之...".
- 引名词必须有具体年份/作者/案例; 没有就直接说 "我没找到具体例子" 不模糊化.
- 数字给具体值, 不写 "较大 / 显著 / 明显". e.g. "60s 不是 90s" 而非 "略快".
- 中文输出禁直译式句法 (英文 → 字面中文), 用编辑过的中文表达.
- 输出 JSON 结构的 (selector / distill metadata 等) 跳过这条 — 只有自由叙述类适用.
`;

// Legacy STAGES export — renderer ETA calc may consume this. Now derived
// from catalog (synth + selector + the 19 catalog angles, but actual run
// is dynamic; this is just the maximum surface).
let _legacyStages = null;
function STAGES_for(promptsDir) {
  if (_legacyStages) return _legacyStages;
  try {
    const catalog = loadCatalog(promptsDir);
    _legacyStages = [
      { id: 'selector', label: 'choosing angles', timeoutMs: 30000 },
      ...catalog.angles.map(a => ({ id: a.slug, label: a.name, timeoutMs: a.timeoutMs || DEFAULT_ANGLE_TIMEOUT_MS })),
      { id: 'synth', label: 'weaving', timeoutMs: SYNTH_TIMEOUT_MS },
    ];
  } catch (_) {
    _legacyStages = [{ id: 'synth', label: 'weaving', timeoutMs: SYNTH_TIMEOUT_MS }];
  }
  return _legacyStages;
}

function loadTemplate(promptsDir, stageId) {
  // V3: catalog angles live at prompts/angles/<slug>.txt; synth + quick stay
  // at prompts/deepen-<id>.txt. Try angles/ path first when stageId looks
  // like a catalog slug; fall back to legacy path.
  const anglesPath = path.join(promptsDir, 'angles', stageId + '.txt');
  if (fs.existsSync(anglesPath)) return fs.readFileSync(anglesPath, 'utf8');
  const legacyPath = path.join(promptsDir, 'deepen-' + stageId + '.txt');
  return fs.readFileSync(legacyPath, 'utf8');
}

function interpolate(template, vars) {
  let out = template;
  for (const [k, v] of Object.entries(vars || {})) {
    out = out.split('{{' + k + '}}').join(String(v == null ? '' : v));
  }
  return out;
}

// One gemini call. Resolves with { ok, text, stderr } or rejects on spawn error.
// Bypasses the trusted-folder prompt (headless mode). Model precedence:
//   env GEMINI_MODEL > opts.model > gemini CLI default (with auto-fallback).
function geminiCall(prompt, opts = {}) {
  // V3.2: append SAY_HUMAN_TAIL by default. Caller passes opts.skipSayHuman=true
  // for JSON-output stages where the register clamp would confuse output.
  const finalPrompt = opts.skipSayHuman ? prompt : (prompt + SAY_HUMAN_TAIL);
  return new Promise((resolve) => {
    const t0 = Date.now();
    let tSpawn = null;        // when child process is alive (post-spawn-syscall)
    let tFirstByte = null;    // when first stdout chunk arrives (TTFB after model warm)
    const tag = opts.tag || 'gemini';
    const modelLog = process.env.GEMINI_MODEL || opts.model || 'default';
    console.log(`[deepen] ${tag} spawn model=${modelLog} promptLen=${prompt.length}`);
    let child;
    try {
      const model = process.env.GEMINI_MODEL || opts.model || null;
      const args = model ? ['-m', model] : [];
      child = spawn('gemini', args, {
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: 'true' },
      });
    } catch (e) { console.log(`[deepen] ${tag} spawn FAILED:`, e.message); resolve({ ok: false, text: '', stderr: 'spawn failed: ' + e.message }); return; }

    // V3.1 timing instrumentation (per /tr Muse VERDICT 2026-04-29):
    // capture spawn-syscall vs CLI-bootstrap vs LLM-decode breakdown so we
    // can verify whether spawn overhead (Lung's claim) or LLM decode (Leo's)
    // is the actual ceiling. One real run + grep [deepen] should answer.
    child.on('spawn', () => { tSpawn = Date.now(); });

    let stdout = '';
    let stderr = '';
    let resolved = false;
    const timeoutMs = opts.timeoutMs || 180000;          // 3 min per stage hard cap
    const finish = (payload) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      const dur = Date.now() - t0;
      const status = payload.ok ? 'OK' : 'ERR';
      // Timing decomposition: spawn (cmd.exe + node boot) | bootstrap-to-first-byte (CLI init + auth + TTFT) | decode (rest)
      const spawnMs = tSpawn ? (tSpawn - t0) : null;
      const bootstrapMs = (tSpawn && tFirstByte) ? (tFirstByte - tSpawn) : null;
      const decodeMs = tFirstByte ? (Date.now() - tFirstByte) : null;
      const breakdown = `spawn=${spawnMs ?? '?'}ms bootstrap=${bootstrapMs ?? '?'}ms decode=${decodeMs ?? '?'}ms`;
      console.log(`[deepen] ${tag} ${status} ${dur}ms ${breakdown}${payload.ok ? ` outLen=${(payload.text || '').length}` : ` err=${(payload.stderr || '').slice(0, 80)}`}`);
      resolve(payload);
    };
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch (_) {} finish({ ok: false, text: stdout, stderr: 'timeout' }); }, timeoutMs);

    if (opts.signal) {
      const onAbort = () => { try { child.kill('SIGTERM'); } catch (_) {} finish({ ok: false, text: stdout, stderr: 'aborted' }); };
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    if (opts.onChunk) child.stdout.on('data', (chunk) => { if (!tFirstByte) tFirstByte = Date.now(); const s = chunk.toString('utf8'); stdout += s; opts.onChunk(s); });
    else              child.stdout.on('data', (chunk) => { if (!tFirstByte) tFirstByte = Date.now(); stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => finish({ ok: false, text: stdout, stderr: err.message }));
    child.on('close', (code) => {
      // V3.10: stderr 500 → 4000 + strip gemini CLI's "True color (24-bit)
      // support not detected" warning. Electron subprocess has no real TTY
      // so gemini emits that warning first; at 500 char cap it ate the whole
      // buffer + hid actual stage error. Strip it then take 4000 chars.
      const cleaned = stderr.replace(/Warning:\s*True color \(24-bit\)[^\n]*\n?/gi, '');
      finish({ ok: code === 0, text: stdout, stderr: cleaned.slice(0, 4000), exitCode: code });
    });

    try { child.stdin.write(finalPrompt); child.stdin.end(); }
    catch (e) { finish({ ok: false, text: '', stderr: 'stdin write: ' + e.message }); }
  });
}

// Run full pipeline. onProgress({ stage, status, text? }) called at:
//   { stage: 'scout', status: 'start' }
//   { stage: 'scout', status: 'done', text: '...' }
//   ... and so on for each stage
//   { stage: 'synth', status: 'chunk', text: '...' }   ← streamed during final stage
//   { stage: 'synth', status: 'done', text: 'full synth' }
//
// Returns { ok, ctx (all stages), synth, error? }
async function runPipeline({ selection, noteRel, style, lang, direction, vaultRoot, promptsDir, signal, onProgress }) {
  const dir = (direction || '').trim();
  const ctx = {
    SELECTION: selection || '',
    NOTE_REL: noteRel || '',
    STYLE: style || 'denser',
    LANG: lang || 'zh',
    LANG_NAME: (lang === 'en') ? 'English' : '中文',
    STYLE_DESC: (style === 'plainer')
      ? '通俗 (key terms get a 1-line gloss on first appearance, daily-life analogies for abstractions, sparse but kept citations, no fluff)'
      : '深奥 (preserve technical terms, assume reader knows the frontier background, dense citations, no simplification of complex relations)',
    DIRECTION: dir,
    DIRECTION_DESC: dir
      ? `用户给的方向 (优先按此 angle 推进, 不偏题): "${dir}"`
      : '用户没给特定方向, 按 selection 内容自由广度 deepen',
    VAULT_CONTEXT: '',  // populated below; LLM-Wiki + Gbrain provenance-anchored cards
    CURRENT_DATE: new Date().toISOString().slice(0, 10),  // hard cutoff for Scout — prevents future-date hallucination
    CURRENT_YEAR: String(new Date().getFullYear()),
  };
  const onP = onProgress || (() => {});

  // V2 wiki context — concept-graph walk over LLM-curated articles instead
  // of paragraph cosine. wiki-context.js falls back to v1 vault-context
  // (paragraph RAG) when wiki-index.json is empty, so cold-start still works.
  // Single retrieval shared across all stages.
  if (vaultRoot) {
    try {
      const wc = await buildWikiContext({
        vaultRoot,
        query: selection || '',
        currentNoteRel: noteRel || '',
        kCards: 8,
        signal,
      });
      ctx.VAULT_CONTEXT = wc.formatted || '';
      console.log(`[deepen] wiki-context: source=${wc.source}, ${wc.articles.length} articles, ${ctx.VAULT_CONTEXT.length} chars`);
    } catch (e) {
      console.log(`[deepen] wiki-context FAILED: ${e.message}`);
      ctx.VAULT_CONTEXT = '';
    }
  }

  // Resolve angle metadata from catalog (catalog is loaded by selector
  // upstream; re-load here for runStage's local reference). synth + quick
  // are not in the catalog — they're hardcoded primitives.
  let _catalog = null;
  try { _catalog = loadCatalog(promptsDir); } catch (_) {}
  const angleMap = _catalog ? new Map(_catalog.angles.map(a => [a.slug, a])) : new Map();

  function angleMeta(slug) {
    if (slug === 'synth') return { name: 'weaving', timeoutMs: SYNTH_TIMEOUT_MS, category: 'synthesis' };
    const a = angleMap.get(slug);
    if (a) return { name: a.name, timeoutMs: a.timeoutMs || DEFAULT_ANGLE_TIMEOUT_MS, category: a.category || 'unknown' };
    return { name: slug, timeoutMs: DEFAULT_ANGLE_TIMEOUT_MS, category: 'unknown' };
  }

  // Run a single stage (catalog angle or synth). Reads ctx for template
  // interpolation; caller writes the returned cleaned text back into ctx.
  const runStage = async (id) => {
    if (signal && signal.aborted) return { ok: false, error: 'aborted' };
    const meta = angleMeta(id);
    onP({ stage: id, status: 'start', label: meta.name });

    let template;
    try { template = loadTemplate(promptsDir, id); }
    catch (e) { onP({ stage: id, status: 'error', error: 'template missing: ' + id }); return { ok: false, error: 'template missing: ' + id }; }
    const prompt = interpolate(template, ctx);

    const isFinal = id === 'synth';
    // Auto-retry once on transient failures (timeout / 429 / network). Costs up
    // to one extra stage-timeout but saves full pipeline restart on briefly-busy
    // gemini default model. Hard cap = 1 retry per stage.
    let r, attempts = 0;
    while (attempts < 2) {
      // V3.1 (per /tr Muse VERDICT 2026-04-29): synth dropped from default-pro
      // to flash. Pro on synth = 60-180s decode, dominant cost. Flash = 15-35s.
      // Quality unknown but reversible: change `DEFAULT_MODEL` → `isFinal ? null : DEFAULT_MODEL`
      // to revert. A/B test on a real selection before committing forever.
      const callOpts = { signal, timeoutMs: meta.timeoutMs, model: DEFAULT_MODEL };
      // V3.9 (per user 2026-04-29 "我想要的是阶段而不是时间"): revert V3.8
      // all-stage chunk forwarding. User's mental model is phase-event driven
      // (scout done → advance, lens done → advance, synth started → advance),
      // NOT byte/time interpolation. Synth/quick still need chunk streaming
      // for the visible markdown body fill — keep that branch only.
      if (isFinal && attempts === 0) {
        callOpts.onChunk = (s) => onP({ stage: 'synth', status: 'chunk', text: s });
      }
      callOpts.tag = id;   // diagnostic tag for [deepen] log lines
      r = await geminiCall(prompt, callOpts);
      if (r.ok) break;
      const err = r.stderr || '';
      const transient = /timeout|429|RESOURCE_EXHAUSTED|capacity|backoff|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(err);
      if (!transient || attempts >= 1 || (signal && signal.aborted)) break;
      attempts += 1;
      onP({ stage: id, status: 'retry', attempt: attempts, error: humanizeError(err) });
      await new Promise(res => setTimeout(res, 2000));
    }
    if (!r.ok) {
      const human = humanizeError(r.stderr || ('exit ' + r.exitCode));
      onP({ stage: id, status: 'error', error: human });
      return { ok: false, error: human };
    }
    const cleaned = r.text.replace(/\[[0-9;]*[a-zA-Z]/g, '').trim();   // strip ANSI from gemini cli warn lines
    onP({ stage: id, status: 'done', text: cleaned, label: meta.name });
    return { ok: true, cleaned };
  };

  // V3 dynamic execution. Selector picks 5-6 angles from catalog based on
  // selection content + direction; pipeline then runs those angles + synth.
  // Serial execution (parallel disabled — see prior comment block from V2:
  // Windows subprocess contention + flash quota bursts).
  console.log('[deepen] pipeline START (V3 dynamic, serial mode)');
  const pipelineT0 = Date.now();

  // Step 1: selector picks angles
  onP({ stage: 'selector', status: 'start', label: 'choosing angles' });
  let selection_result;
  try {
    selection_result = await selectAngles({
      selection,
      direction: dir,
      promptsDir,
      signal,
    });
  } catch (e) {
    console.log(`[deepen] selector errored: ${e.message}`);
    selection_result = { chosen: ['leo', 'lung', 'muse', 'distill', 'scout'], reasoning: 'selector exception, using fallback', source: 'fallback', warnings: [e.message] };
  }
  const chosen = selection_result.chosen;
  console.log(`[deepen] selector chose [${selection_result.source}]: ${chosen.join(', ')} — ${selection_result.reasoning}`);
  onP({ stage: 'selector', status: 'done', text: selection_result.reasoning, chosen, source: selection_result.source });
  ctx.ANGLES_RAN = chosen.join(', ');

  // Step 2: run each chosen angle in topo order. ANGLES_OUTPUTS is built as
  // we go so synth (always last) can reference any angle that ran.
  const angleOutputBlocks = [];
  for (const slug of chosen) {
    if (signal && signal.aborted) return { ok: false, ctx, error: 'aborted' };
    const res = await runStage(slug);
    if (!res.ok) {
      // Per-angle failure is non-fatal: log + skip, continue with remaining angles.
      // Synth gets whatever ran. Avoids one bad angle killing the whole pipeline.
      console.log(`[deepen] angle ${slug} FAILED: ${res.error} — skipping, pipeline continues`);
      angleOutputBlocks.push(`=== ${slug} (${angleMeta(slug).category}): ${angleMeta(slug).name} ===\n[FAILED: ${res.error}]\n`);
      continue;
    }
    ctx[slug.toUpperCase()] = res.cleaned;  // legacy named ctx for templates that reference by name (occam/nancy/muse)
    const meta = angleMeta(slug);
    angleOutputBlocks.push(`=== ${slug} (${meta.category}): ${meta.name} ===\n${res.cleaned}\n`);
  }
  ctx.ANGLES_OUTPUTS = angleOutputBlocks.join('\n');

  // Step 3: synth integrates whatever ran
  if (signal && signal.aborted) return { ok: false, ctx, error: 'aborted' };
  const synthRes = await runStage('synth');
  if (!synthRes.ok) {
    console.log(`[deepen] synth FAILED after ${Date.now() - pipelineT0}ms`);
    return { ok: false, ctx, error: synthRes.error, failedStage: 'synth' };
  }
  ctx.SYNTH = synthRes.cleaned;
  console.log(`[deepen] pipeline DONE total=${Date.now() - pipelineT0}ms angles=${chosen.length}+synth`);

  // V2 writeback — post-synth, scan for [WIKI:slug] citations + ask LLM
  // whether any cited article merits an "## evidence" append. Best-effort:
  // failures are logged but do not fail the pipeline (synth already returned).
  if (vaultRoot && ctx.SYNTH) {
    try {
      const cited = extractWikiCitations(ctx.SYNTH);
      if (cited.length > 0) {
        onP({ stage: 'writeback', status: 'start', label: 'updating cited articles' });
        const wb = await runWriteback({
          vaultRoot,
          synth: ctx.SYNTH,
          citedSlugs: cited,
          promptsDir,
          signal,
        });
        if (wb.ok && wb.updates && wb.updates.length > 0) {
          console.log(`[deepen] writeback applied: ${wb.updates.map(u => u.slug).join(', ')}`);
          onP({ stage: 'writeback', status: 'done', text: `evidence appended to ${wb.updates.length} article(s)` });
        } else {
          onP({ stage: 'writeback', status: 'done', text: 'no new evidence to append' });
        }
      }
    } catch (e) {
      console.log(`[deepen] writeback failed (non-fatal): ${e.message}`);
    }
  }

  return { ok: true, ctx, synth: ctx.SYNTH || '' };
}

// Quick — single-stage flash call for ~10s lookups (Ctrl+Q surface).
async function runQuick({ selection, noteRel, lang, direction, vaultRoot, promptsDir, signal, onProgress }) {
  const dir = (direction || '').trim();
  const ctx = {
    SELECTION: selection || '',
    NOTE_REL: noteRel || '',
    LANG: lang || 'zh',
    LANG_NAME: (lang === 'en') ? 'English' : '中文',
    DIRECTION: dir,
    DIRECTION_DESC: dir
      ? `用户给的方向 (按此 angle 答, 不偏): "${dir}"`
      : '用户没给方向, 默认: 这段在说什么 + 1 个有意义的补充点',
    VAULT_CONTEXT: '',
    CURRENT_DATE: new Date().toISOString().slice(0, 10),
    CURRENT_YEAR: String(new Date().getFullYear()),
  };

  // Smaller card budget for quick (4 vs 8) — quick path is ~10s flash, prompt
  // weight matters more than coverage breadth. V2 uses wiki-context (graph
  // walk over articles) with v1 fallback baked in.
  if (vaultRoot) {
    try {
      const wc = await buildWikiContext({
        vaultRoot,
        query: selection || '',
        currentNoteRel: noteRel || '',
        kCards: 4,
        signal,
      });
      ctx.VAULT_CONTEXT = wc.formatted || '';
    } catch (_) {
      ctx.VAULT_CONTEXT = '';
    }
  }
  const onP = onProgress || (() => {});
  onP({ stage: 'quick', status: 'start', label: 'quick query' });

  let template;
  try { template = loadTemplate(promptsDir, 'quick'); }
  catch (e) { return { ok: false, error: 'template missing: quick' }; }
  const prompt = interpolate(template, ctx);

  const r = await geminiCall(prompt, {
    signal,
    timeoutMs: 30000,
    model: 'gemini-2.5-flash',
    onChunk: (s) => onP({ stage: 'quick', status: 'chunk', text: s }),
  });

  if (!r.ok) {
    const human = humanizeError(r.stderr || ('exit ' + r.exitCode));
    onP({ stage: 'quick', status: 'error', error: human });
    return { ok: false, error: human };
  }
  const cleaned = r.text.replace(/\[[0-9;]*[a-zA-Z]/g, '').trim();
  onP({ stage: 'quick', status: 'done', text: cleaned });
  return { ok: true, text: cleaned };
}

// Map raw gemini CLI / system errors → human hints (千金 / 学术 register).
// Used by both retry-decision logging and final error display in DeepenCallout.
function humanizeError(raw) {
  if (!raw) return 'something went wrong';
  const s = String(raw);
  if (/timeout/i.test(s)) return 'took too long — gemini might be busy, try again in a moment';
  if (/429|RESOURCE_EXHAUSTED|capacity|exhausted/i.test(s)) return "gemini's rate limit hit — wait a minute, then retry";
  if (/spawn|ENOENT|not.*found/i.test(s)) return 'gemini CLI not found on PATH — check installation';
  if (/trust|GEMINI_CLI_TRUST/i.test(s)) return 'gemini blocked the workspace — restart the app';
  if (/network|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(s)) return 'network unreachable — check your connection';
  if (/aborted/i.test(s)) return 'cancelled';
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

// V3: STAGES + WAVES exports removed (catalog-driven now). Renderer ETA calc
// can request stage list via STAGES_for(promptsDir) if needed.
module.exports = { runPipeline, runQuick, STAGES_for, humanizeError };
