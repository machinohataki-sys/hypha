'use strict';

// Challenge pipeline — 4-stage adversarial scrutiny of selection.
// Mirror of expand-pipeline.js structure (gemini CLI, serial stages, sentinel fallbacks).
//
// Stages (per pedagogy.md Layer 5 M3 CHALLENGE):
//   1. muse:   对手论证 — strongest counter-argument, 假设你必须 win 这场对辩
//   2. leo:    first-principles — strip 到 axiomatic premise, 逐个测
//   3. scout:  历史批判史 — web search 该 doctrine 历史上谁反驳过 (时间序)
//   4. synth:  objection cards 集成 — 按反驳者归类
//
// Output: 4 cards grouped by objector + recommended responses.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildWikiContext } = require('./wiki-context');

const STAGE_TIMEOUT_MS = 180000;
const SYNTH_TIMEOUT_MS = 240000;
const SCOUT_TIMEOUT_MS = 240000;
const DEFAULT_MODEL = null;

const STAGES = ['muse', 'leo', 'scout', 'synth'];

const SAY_HUMAN_TAIL = `

—

写作 register (硬约束):
- 说人话, 不堆套话. 严禁: "在...的语境下" / "值得注意的是" / "具有显著影响" / "在某种程度上"
- 假大空诊断: 任何句子里没有具体名字 / 数字 / 案例 / 真情境 → 删
- 短句优先. 一句话 ≤ 35 字优先
- 不奉承用户. 不开篇 "很高兴..." / "好的, 我来...". 不收尾 "希望对你有帮助"
- 引名词必须有具体年份/作者/案例; 没有就直接说 "我没找到具体例子" 不模糊化
- 数字给具体值
- 中文输出禁直译式句法
- 输出 JSON 结构的跳过此条
- FORBIDDEN words in output: AI / LLM / embedding / model / prompt / agent / RAG / vector / fine-tune. 用 domain term 替代.
- CHALLENGE 模式 register: 不要弱化反方, 不要 "双方都有道理". 假设反方必须 win.
`;

function loadTemplate(promptsDir, stageId) {
  return fs.readFileSync(path.join(promptsDir, 'challenge-' + stageId + '.txt'), 'utf8');
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
    console.log(`[challenge] ${tag} spawn model=${modelLog} promptLen=${prompt.length}`);
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
      console.log(`[challenge] ${tag} spawn FAILED:`, e.message);
      resolve({ ok: false, text: '', stderr: 'spawn failed: ' + e.message });
      return;
    }

    let stdout = '';
    let stderr = '';
    let resolved = false;
    const timeoutMs = opts.timeoutMs || STAGE_TIMEOUT_MS;
    const finish = (payload) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      const dur = Date.now() - t0;
      const status = payload.ok ? 'OK' : 'ERR';
      console.log(`[challenge] ${tag} ${status} ${dur}ms ${payload.ok ? 'outLen=' + (payload.text || '').length : 'err=' + (payload.stderr || '').slice(0, 80)}`);
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

async function runPipeline({ selection, noteRel, lang, direction, vaultRoot, promptsDir, signal, onProgress }) {
  const dir = (direction || '').trim();
  const ctx = {
    SELECTION: selection || '',
    NOTE_REL: noteRel || '',
    LANG: lang || 'zh',
    LANG_NAME: (lang === 'en') ? 'English' : '中文',
    DIRECTION: dir,
    DIRECTION_DESC: dir
      ? `用户给的反驳侧重 (优先此 angle): "${dir}"`
      : '用户没给方向, 按 4 stage 均匀输出',
    VAULT_CONTEXT: '',
    CURRENT_DATE: new Date().toISOString().slice(0, 10),
    CURRENT_YEAR: String(new Date().getFullYear()),
  };
  const onP = onProgress || (() => {});

  if (vaultRoot) {
    try {
      const wc = await buildWikiContext({
        vaultRoot, query: selection || '', currentNoteRel: noteRel || '', kCards: 6, signal,
      });
      ctx.VAULT_CONTEXT = wc.formatted || '';
      console.log(`[challenge] wiki-context: ${wc.source}, ${wc.articles.length} articles`);
    } catch (e) {
      console.log(`[challenge] wiki-context FAILED: ${e.message}`);
      ctx.VAULT_CONTEXT = '';
    }
  }

  const runStage = async (stage) => {
    if (signal && signal.aborted) return { ok: false, error: 'aborted' };
    onP({ stage, status: 'start', label: stage });

    let template;
    try { template = loadTemplate(promptsDir, stage); }
    catch (e) { onP({ stage, status: 'error', error: 'template missing: ' + stage }); return { ok: false, error: 'template missing: ' + stage }; }
    const prompt = interpolate(template, ctx);

    const isSynth = stage === 'synth';
    const isScout = stage === 'scout';
    const callOpts = {
      signal,
      timeoutMs: isSynth ? SYNTH_TIMEOUT_MS : (isScout ? SCOUT_TIMEOUT_MS : STAGE_TIMEOUT_MS),
      model: DEFAULT_MODEL,
      tag: stage,
    };

    let r, attempts = 0;
    while (attempts < 2) {
      // Mirror deepen: only attach onChunk on first attempt — retry must not
      // duplicate synth stream into the UI (code-reviewer HIGH fix).
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
      onP({ stage, status: 'retry', attempt: attempts, error: humanizeError(err) });
      await new Promise(res => setTimeout(res, 2000));
    }
    if (!r.ok) {
      const human = humanizeError(r.stderr || ('exit ' + r.exitCode));
      onP({ stage, status: 'error', error: human });
      return { ok: false, error: human };
    }
    const cleaned = r.text.replace(/\[[0-9;]*[a-zA-Z]/g, '').trim();
    onP({ stage, status: 'done', text: cleaned, label: stage });
    return { ok: true, cleaned };
  };

  console.log(`[challenge] pipeline START (4-stage serial)`);
  const pipelineT0 = Date.now();

  const stageOutputBlocks = [];
  for (const stage of STAGES) {
    if (stage === 'synth') break;
    if (signal && signal.aborted) return { ok: false, ctx, error: 'aborted' };
    const res = await runStage(stage);
    if (!res.ok) {
      console.log(`[challenge] stage ${stage} FAILED: ${res.error} — skipping`);
      stageOutputBlocks.push(`=== ${stage} ===\n[FAILED: ${res.error}]\n`);
      continue;
    }
    ctx[stage.toUpperCase()] = res.cleaned;
    stageOutputBlocks.push(`=== ${stage} ===\n${res.cleaned}\n`);
  }
  ctx.STAGE_OUTPUTS = stageOutputBlocks.join('\n');

  if (signal && signal.aborted) return { ok: false, ctx, error: 'aborted' };
  const synthRes = await runStage('synth');
  if (!synthRes.ok) {
    console.log(`[challenge] synth FAILED after ${Date.now() - pipelineT0}ms`);
    return { ok: false, ctx, error: synthRes.error, failedStage: 'synth' };
  }
  ctx.SYNTH = synthRes.cleaned;
  console.log(`[challenge] pipeline DONE total=${Date.now() - pipelineT0}ms`);

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

module.exports = { runPipeline, humanizeError, STAGES };
