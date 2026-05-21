'use strict';

// Production Scaffold pipeline — student draft → LLM grading (3-dim).
//
// Per pedagogy.md Layer 5 M4 + assignment.js R11: each lesson NOTE ships a
// PRODUCTION SCAFFOLD entrypoint (intent / slot_template / kp_slot_mapping).
// User draft 槽答案 → this pipeline grades:
//   1. structure_adherence  — 槽顺序 / 字数 / 占满情况
//   2. content_depth        — 每槽内容厚度 / 具体性 / 是否套话
//   3. evidence_link        — 每槽是否显式链回具体 KP id / title
//
// Output: { scores: {structure_adherence, content_depth, evidence_link}, feedback }
// scores 0-100 each, feedback markdown.
//
// Single gemini call per grade (no multi-stage waves). Per-intent prompt at
// prompts/production-<intent>.txt drives the rubric. Streams 'llm:production-progress'
// via onProgress for UI feedback during the call.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const GRADE_TIMEOUT_MS = 120000;  // 2 min — single call, no waves
const DEFAULT_MODEL = null;

const SAY_HUMAN_TAIL = `

—

写作 register (硬约束 for "feedback" 字段, 不约束 JSON scores):
- 说人话, 不堆套话
- 不奉承用户. 不开篇 "很高兴..." / "好的, 我来..."
- 短句优先. 一句话 ≤ 35 字优先
- 数字给具体值
- FORBIDDEN words: AI / LLM / embedding / model / prompt / agent / RAG / vector / fine-tune
`;

function loadTemplate(promptsDir, intent) {
  return fs.readFileSync(path.join(promptsDir, 'production-' + intent + '.txt'), 'utf8');
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
    console.log(`[production] ${tag} spawn model=${modelLog} promptLen=${prompt.length}`);
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
      console.log(`[production] ${tag} spawn FAILED:`, e.message);
      resolve({ ok: false, text: '', stderr: 'spawn failed: ' + e.message });
      return;
    }

    let stdout = '';
    let stderr = '';
    let resolved = false;
    const timeoutMs = opts.timeoutMs || GRADE_TIMEOUT_MS;
    const finish = (payload) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      const dur = Date.now() - t0;
      const status = payload.ok ? 'OK' : 'ERR';
      console.log(`[production] ${tag} ${status} ${dur}ms ${payload.ok ? 'outLen=' + (payload.text || '').length : 'err=' + (payload.stderr || '').slice(0, 80)}`);
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

// Extract JSON object from gemini's mixed output (often has prose before/after).
// Returns parsed object or null.
//
// Robust against feedback strings containing literal { or } chars (code-reviewer
// HIGH fix: naive brace-depth was unaware of string delimiters; feedback markdown
// citing student draft frequently contains } and broke depth count). Strategy:
//   1. Direct JSON.parse
//   2. Strip code fences and retry
//   3. Find first '{' and last '}', try JSON.parse on the slice; on failure walk
//      the last '}' backwards looking for the next valid parse.
function extractJSON(raw) {
  if (!raw) return null;
  let s = raw.replace(/\[[0-9;]*[a-zA-Z]/g, '').trim();
  try { return JSON.parse(s); } catch (_) {}
  // Strip outer markdown code fences if present
  const fenced = s.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  if (fenced !== s) {
    try { return JSON.parse(fenced); } catch (_) {}
    s = fenced;
  }
  const start = s.indexOf('{');
  if (start === -1) return null;
  // Try last '}' first (greedy span); if fail, walk back through each '}'
  // and retry parse. This handles feedback strings containing literal { and
  // } chars without confusing depth — JSON.parse is the source of truth.
  for (let i = s.lastIndexOf('}'); i > start; i = s.lastIndexOf('}', i - 1)) {
    const candidate = s.slice(start, i + 1);
    try { return JSON.parse(candidate); } catch (_) {}
  }
  return null;
}

// Sanitize student draft before interpolating into prompt: collapse triple-quote
// runs to prevent boundary escape (code-reviewer HIGH fix). Student writing """
// in their draft would close the delimited block early and pollute the model's
// instruction context. Replace """ → ⹂⹂⹂ (rare unicode) preserves visual intent
// without breaking the prompt template's triple-quote delimiter.
function sanitizeDraft(draft) {
  if (typeof draft !== 'string') return '';
  return draft.replace(/"""/g, '⹂⹂⹂').replace(/\u0000/g, '');
}

function clampScore(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * Grade a student production-scaffold draft.
 *
 * @param {object} args
 * @param {string} args.intent         考研 | 兴趣 | 论文 | 复盘
 * @param {Array}  args.slotTemplate   slot 名列表 (per intent, len 4)
 * @param {Array}  args.kpSlotMapping  [{ slot_name, kp_refs: [{kp_id, title, rationale}] }]
 * @param {string} args.studentDraft   user 填的 4-slot 文本 (单 string, 内部 slot 用 markdown 分段)
 * @param {Array}  args.lessonKPs      lesson 的全部 KP arc 数据 (用于 evidence_link 检查)
 * @param {string} args.lang
 * @param {string} args.promptsDir
 * @param {AbortSignal} args.signal
 * @param {Function}    args.onProgress({stage, status, text?, error?})
 * @returns {{ok: bool, scores?: {structure_adherence, content_depth, evidence_link}, feedback?: string, error?: string}}
 */
async function gradeDraft({ intent, slotTemplate, kpSlotMapping, studentDraft, lessonKPs, lang, promptsDir, signal, onProgress }) {
  const onP = onProgress || (() => {});

  if (!intent || !studentDraft) {
    return { ok: false, error: 'intent + studentDraft required' };
  }

  // Validate intent has a prompt file
  let template;
  try { template = loadTemplate(promptsDir, intent); }
  catch (e) { return { ok: false, error: 'template missing: production-' + intent + '.txt' }; }

  const ctx = {
    INTENT: intent,
    LANG: lang || 'zh',
    LANG_NAME: (lang === 'en') ? 'English' : '中文',
    SLOT_TEMPLATE: slotTemplate ? slotTemplate.join(' / ') : '',
    SLOT_COUNT: slotTemplate ? slotTemplate.length : 4,
    KP_SLOT_MAPPING: JSON.stringify(kpSlotMapping || [], null, 2),
    LESSON_KPS: JSON.stringify(
      (lessonKPs || []).map(k => ({
        kp_id: k.kp_id || k.id || '',
        title: k.title || (k.arc && k.arc.title) || '',
        definition: (k.arc && k.arc.definition) || k.definition || '',
      })),
      null, 2
    ),
    STUDENT_DRAFT: sanitizeDraft(studentDraft),
    CURRENT_DATE: new Date().toISOString().slice(0, 10),
  };

  const prompt = interpolate(template, ctx);

  onP({ stage: 'grade', status: 'start', label: 'grading draft' });
  console.log(`[production] grade START intent=${intent} draftLen=${studentDraft.length}`);
  const t0 = Date.now();

  let r, attempts = 0;
  while (attempts < 2) {
    r = await geminiCall(prompt, {
      signal,
      timeoutMs: GRADE_TIMEOUT_MS,
      model: DEFAULT_MODEL,
      tag: 'grade',
      onChunk: (s) => onP({ stage: 'grade', status: 'chunk', text: s }),
      skipSayHuman: false,
    });
    if (r.ok) break;
    const err = r.stderr || '';
    const transient = /timeout|429|RESOURCE_EXHAUSTED|capacity|backoff|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(err);
    if (!transient || attempts >= 1 || (signal && signal.aborted)) break;
    attempts += 1;
    onP({ stage: 'grade', status: 'retry', attempt: attempts, error: humanizeError(err) });
    await new Promise(res => setTimeout(res, 2000));
  }

  if (!r.ok) {
    const human = humanizeError(r.stderr || ('exit ' + r.exitCode));
    onP({ stage: 'grade', status: 'error', error: human });
    return { ok: false, error: human };
  }

  // Parse JSON. If parse fails, return ok:false with raw + parse-error so UI
  // can show "gemini output ill-formed, retry" without losing the response.
  const parsed = extractJSON(r.text);
  if (!parsed) {
    onP({ stage: 'grade', status: 'error', error: 'output JSON parse failed' });
    return {
      ok: false,
      error: 'gemini returned ill-formed JSON',
      raw: r.text.slice(0, 2000),
    };
  }

  const scores = {
    structure_adherence: clampScore(parsed.structure_adherence),
    content_depth: clampScore(parsed.content_depth),
    evidence_link: clampScore(parsed.evidence_link),
  };
  const feedback = typeof parsed.feedback === 'string' ? parsed.feedback : '';

  console.log(`[production] grade DONE total=${Date.now() - t0}ms scores=${JSON.stringify(scores)}`);
  onP({ stage: 'grade', status: 'done', text: feedback, scores });

  return { ok: true, scores, feedback, raw: r.text };
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

module.exports = { gradeDraft, humanizeError };
