'use strict';

// Expand pipeline — 3-axis lateral exploration of selection.
// Mirror of deepen-pipeline.js (gemini CLI) but axis-driven, no catalog selector.
//
// Axes (per pedagogy.md Layer 5 M2 EXPAND):
//   1. canon-cold:    syllabus / textbook canon 外延 (academy 已认可, vault 未覆盖)
//   2. personal-cold: vault backlink graph 补集 (语义邻近但 user 未笔记)
//   3. model-cold:    training-corpus 稀疏 legit branch (LLM 显式诚实自检)
//
// Output: 3 axis cards + synth grid integrator. Serial execution (mirrors deepen
// serial mode — Windows subprocess contention + flash quota bursts).
//
// Fallback: vault < VAULT_MIN_NOTES → personal-cold emits sentinel
// `[PERSONAL_COLD_FALLBACK: ...]` and synth folds canon-cold over.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildWikiContext } = require('./wiki-context');

const AXIS_TIMEOUT_MS = 180000;
const SYNTH_TIMEOUT_MS = 240000;
const DEFAULT_MODEL = null;
const VAULT_MIN_NOTES = 3;

const AXES = ['canon-cold', 'personal-cold', 'model-cold'];

const SAY_HUMAN_TAIL = `

—

写作 register (硬约束, 优先于上面所有规则):
- 说人话, 不堆套话. 严禁: "在...的语境下" / "值得注意的是" / "具有显著影响" / "在某种程度上" / "可以从多个维度"
- 假大空诊断: 任何句子里没有具体名字 / 数字 / 案例 / 真情境 → 删. 抽象再抽象 = 0 价值.
- 短句优先. 长定语 ≥ 25 字 = 改写. 一句话 ≤ 35 字优先.
- 不奉承用户. 不开篇 "很高兴..." / "好的, 我来...". 不收尾 "希望对你有帮助" / "总之...".
- 引名词必须有具体年份/作者/案例; 没有就直接说 "我没找到具体例子" 不模糊化.
- 数字给具体值, 不写 "较大 / 显著 / 明显".
- 中文输出禁直译式句法, 用编辑过的中文表达.
- 输出 JSON 结构的跳过这条 — 只有自由叙述类适用.
- FORBIDDEN words in output: AI / LLM / embedding / model / prompt / agent / RAG / vector / fine-tune. 用 domain term 替代 (e.g. "训练 corpus" → "文献基底"; "vector search" → "概念邻近搜索").
`;

function loadTemplate(promptsDir, stageId) {
  return fs.readFileSync(path.join(promptsDir, 'expand-' + stageId + '.txt'), 'utf8');
}

function interpolate(template, vars) {
  let out = template;
  for (const [k, v] of Object.entries(vars || {})) {
    out = out.split('{{' + k + '}}').join(String(v == null ? '' : v));
  }
  return out;
}

function geminiCall(prompt, opts = {}) {
  const finalPrompt = opts.skipSayHuman ? prompt : (prompt + SAY_HUMAN_TAIL);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tag = opts.tag || 'gemini';
    const modelLog = process.env.GEMINI_MODEL || opts.model || 'default';
    console.log(`[expand] ${tag} spawn model=${modelLog} promptLen=${prompt.length}`);
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
      console.log(`[expand] ${tag} spawn FAILED:`, e.message);
      resolve({ ok: false, text: '', stderr: 'spawn failed: ' + e.message });
      return;
    }

    let stdout = '';
    let stderr = '';
    let resolved = false;
    const timeoutMs = opts.timeoutMs || AXIS_TIMEOUT_MS;
    const finish = (payload) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      const dur = Date.now() - t0;
      const status = payload.ok ? 'OK' : 'ERR';
      console.log(`[expand] ${tag} ${status} ${dur}ms ${payload.ok ? 'outLen=' + (payload.text || '').length : 'err=' + (payload.stderr || '').slice(0, 80)}`);
      resolve(payload);
    };
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch (_) {} finish({ ok: false, text: stdout, stderr: 'timeout' }); }, timeoutMs);

    if (opts.signal) {
      const onAbort = () => { try { child.kill('SIGTERM'); } catch (_) {} finish({ ok: false, text: stdout, stderr: 'aborted' }); };
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    if (opts.onChunk) child.stdout.on('data', (chunk) => { const s = chunk.toString('utf8'); stdout += s; opts.onChunk(s); });
    else              child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => finish({ ok: false, text: stdout, stderr: err.message }));
    child.on('close', (code) => {
      const cleaned = stderr.replace(/Warning:\s*True color \(24-bit\)[^\n]*\n?/gi, '');
      finish({ ok: code === 0, text: stdout, stderr: cleaned.slice(0, 4000), exitCode: code });
    });

    try { child.stdin.write(finalPrompt); child.stdin.end(); }
    catch (e) { finish({ ok: false, text: '', stderr: 'stdin write: ' + e.message }); }
  });
}

// Code-reviewer HIGH fix: cache vault note count per vaultRoot (5-min TTL) to
// avoid synchronous recursive readdirSync blocking the main process on every
// expand invocation. Vault rarely shrinks mid-session, so a coarse cache is
// safe — a stale 5-min count only affects the personal-cold fallback threshold,
// not output correctness.
const _vaultCountCache = new Map();   // vaultRoot → { ts, count }
const _VAULT_COUNT_TTL_MS = 5 * 60 * 1000;

function countVaultNotes(vaultRoot) {
  if (!vaultRoot) return 0;
  const cached = _vaultCountCache.get(vaultRoot);
  if (cached && (Date.now() - cached.ts) < _VAULT_COUNT_TTL_MS) return cached.count;
  try {
    let count = 0;
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, ent.name);
        if (ent.isDirectory()) { if (!ent.name.startsWith('.')) walk(fp); }
        else if (ent.isFile() && ent.name.endsWith('.md')) count++;
      }
    };
    walk(vaultRoot);
    _vaultCountCache.set(vaultRoot, { ts: Date.now(), count });
    return count;
  } catch (_) { return 0; }
}

async function runPipeline({ selection, noteRel, lang, direction, vaultRoot, promptsDir, signal, onProgress }) {
  const dir = (direction || '').trim();
  const vaultSize = countVaultNotes(vaultRoot);
  const ctx = {
    SELECTION: selection || '',
    NOTE_REL: noteRel || '',
    LANG: lang || 'zh',
    LANG_NAME: (lang === 'en') ? 'English' : '中文',
    DIRECTION: dir,
    DIRECTION_DESC: dir
      ? `用户给的横展方向 (优先此 axis): "${dir}"`
      : '用户没给方向, 按 3 轴均匀输出',
    VAULT_CONTEXT: '',
    VAULT_SIZE: vaultSize,
    VAULT_TOO_SMALL: vaultSize < VAULT_MIN_NOTES,
    CURRENT_DATE: new Date().toISOString().slice(0, 10),
    CURRENT_YEAR: String(new Date().getFullYear()),
  };
  const onP = onProgress || (() => {});

  if (vaultRoot) {
    try {
      const wc = await buildWikiContext({
        vaultRoot, query: selection || '', currentNoteRel: noteRel || '', kCards: 8, signal,
      });
      ctx.VAULT_CONTEXT = wc.formatted || '';
      console.log(`[expand] wiki-context: ${wc.source}, ${wc.articles.length} articles, ${ctx.VAULT_CONTEXT.length} chars`);
    } catch (e) {
      console.log(`[expand] wiki-context FAILED: ${e.message}`);
      ctx.VAULT_CONTEXT = '';
    }
  }

  const runAxis = async (axis) => {
    if (signal && signal.aborted) return { ok: false, error: 'aborted' };
    onP({ stage: axis, status: 'start', label: axis });

    let template;
    try { template = loadTemplate(promptsDir, axis); }
    catch (e) { onP({ stage: axis, status: 'error', error: 'template missing: ' + axis }); return { ok: false, error: 'template missing: ' + axis }; }
    const prompt = interpolate(template, ctx);

    const isSynth = axis === 'synth';
    const callOpts = {
      signal,
      timeoutMs: isSynth ? SYNTH_TIMEOUT_MS : AXIS_TIMEOUT_MS,
      model: DEFAULT_MODEL,
      tag: axis,
    };

    let r, attempts = 0;
    while (attempts < 2) {
      // Mirror deepen-pipeline gate: only stream chunks on first attempt to
      // avoid duplicated synth text in UI on retry (code-reviewer HIGH fix).
      if (isSynth && attempts === 0) {
        callOpts.onChunk = (s) => onP({ stage: 'synth', status: 'chunk', text: s });
      } else {
        delete callOpts.onChunk;
      }
      r = await geminiCall(prompt, callOpts);
      if (r.ok) break;
      const err = r.stderr || '';
      const transient = /timeout|429|RESOURCE_EXHAUSTED|capacity|backoff|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(err);
      if (!transient || attempts >= 1 || (signal && signal.aborted)) break;
      attempts += 1;
      onP({ stage: axis, status: 'retry', attempt: attempts, error: humanizeError(err) });
      await new Promise(res => setTimeout(res, 2000));
    }
    if (!r.ok) {
      const human = humanizeError(r.stderr || ('exit ' + r.exitCode));
      onP({ stage: axis, status: 'error', error: human });
      return { ok: false, error: human };
    }
    const cleaned = r.text.replace(/\[[0-9;]*[a-zA-Z]/g, '').trim();
    onP({ stage: axis, status: 'done', text: cleaned, label: axis });
    return { ok: true, cleaned };
  };

  console.log(`[expand] pipeline START (3-axis serial, vault=${vaultSize})`);
  const pipelineT0 = Date.now();

  const axisOutputBlocks = [];
  for (const axis of AXES) {
    if (signal && signal.aborted) return { ok: false, ctx, error: 'aborted' };
    if (axis === 'personal-cold' && ctx.VAULT_TOO_SMALL) {
      const sentinel = `[PERSONAL_COLD_FALLBACK: vault ${vaultSize} notes < ${VAULT_MIN_NOTES} threshold — synth will fold canon-cold]`;
      ctx['PERSONAL_COLD'] = sentinel;
      onP({ stage: axis, status: 'done', text: sentinel, label: axis });
      axisOutputBlocks.push(`=== ${axis} ===\n${sentinel}\n`);
      continue;
    }
    const res = await runAxis(axis);
    if (!res.ok) {
      console.log(`[expand] axis ${axis} FAILED: ${res.error} — skipping`);
      axisOutputBlocks.push(`=== ${axis} ===\n[FAILED: ${res.error}]\n`);
      continue;
    }
    const key = axis.toUpperCase().replace(/-/g, '_');
    ctx[key] = res.cleaned;
    axisOutputBlocks.push(`=== ${axis} ===\n${res.cleaned}\n`);
  }
  ctx.AXIS_OUTPUTS = axisOutputBlocks.join('\n');

  if (signal && signal.aborted) return { ok: false, ctx, error: 'aborted' };
  const synthRes = await runAxis('synth');
  if (!synthRes.ok) {
    console.log(`[expand] synth FAILED after ${Date.now() - pipelineT0}ms`);
    return { ok: false, ctx, error: synthRes.error, failedStage: 'synth' };
  }
  ctx.SYNTH = synthRes.cleaned;
  console.log(`[expand] pipeline DONE total=${Date.now() - pipelineT0}ms`);

  return { ok: true, ctx, synth: ctx.SYNTH || '' };
}

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

module.exports = { runPipeline, humanizeError, AXES };
