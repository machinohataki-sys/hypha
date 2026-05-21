'use strict';

const fetch = require('node-fetch');
const OpenAI = require('openai');
// V0.5 E0 D6 — typed event writer + sqlite model_calls bridge.
// DAG-edge: agent.js imports events + sqlite; neither imports back.
// `events.write(slug, ...)` replaces ad-hoc `vault.appendJSONL('events.jsonl', ...)`
// scattered through this file (3 call sites in lines ~86-146 + 1 method-tag at ~2361).
// Slug resolution: `opts.lesson_slug` || `settings.lesson_slug` || '_global'.
// `_global` slug carves a vault/_global/events.jsonl bucket for context-free events
// (provider connectivity tests, harvest scans). Per-lesson events still land per-slug.
//
// Cost recording (`sqliteDb.recordChatCallEstimate`) is wired at the
// `designSkeletonOnly` executeChat call site (this file's only direct executeChat).
// Other heavy executeChat-driven sites live OUTSIDE agent.js. As of V0.5 E0
// D11-D14 Phase 1 (Machino-γ tranche), 6 of 7 are now wrapped in their own
// files via the same pattern (capture _t0, await dispatch,
// sqliteDb.recordChatCallEstimate(dispatch, '<taskType>', {latency_ms,...})):
//   - app/lib/lesson-body-generator.js:283   ('lessonBody')              [WIRED]
//   - app/lib/scoring.js:243                  ('scoring')                 [WIRED]
//   - app/lib/anti-slop/prosecute-judge-rewrite.js:96/172/255             [WIRED]
//                                             ('prosecuteAttack' / 'judgeRule' / 'rewriteFix')
//   - app/lib/anti-slop/confession.js:96      ('confession')              [WIRED]
//   - app/lib/harvest/layer1-canonical.js:752 ('layer1Canonical')         [WIRED]
//   - app/scripts/wolf-rater.js:168           (offline judge)             [defer — outside Machino-γ scope]
const events = require('./lib/events');
const sqliteDb = require('./db/sqlite');
// Hypha Product Constitution — prepended to every LLM system prompt so output
// inherits the product's manuscript-register / pedagogical-philosophy soul,
// not just generic LLM defaults. Edit `lib/hypha-constitution.js` to evolve.
const { FULL: HYPHA_FULL, SHORT: HYPHA_SHORT, userProfileBlock } = require('./lib/hypha-constitution');
// 2026-05-02 — direct Anthropic Messages API adapter. Replaces dead `claude`
// provider that pointed OpenAI SDK at Anthropic's incompatible Messages
// endpoint. Dispatched when provider has `via: 'sdk-anthropic'`. Sends
// system prompt via wire-level system parameter so Hypha's tutor instructions
// outrank any Claude Code persona present in the calling environment.
const anthropicAdapter = require('./lib/anthropic-adapter');

// 2026-05-02 / 2026-05-03 — persona-leak detection. Scan tutor output for
// Claude Code agent-council names (Lung / Leo / Yogo / Muse / MEOW / Wolf /
// Nancy / Ghost / TATA / SONCAR / QAQ) that bleed in via claude-cli persona
// overlay. "Victor" was historically also a leak signal but conflicts with
// users who set tutorName=Victor in their profile. NAMES THE USER PUT IN
// THEIR OWN PROFILE (settings.userProfile.name + .tutorName) are NEVER
// flagged — those are intentional address. Hits write to events.jsonl.
const PERSONA_LEAK_AGENT_NAMES = ['Lung', 'Leo', 'Yogo', 'Muse', 'MEOW', 'Wolf', 'Nancy', 'Ghost', 'TATA', 'SONCAR', 'QAQ'];
// v0158n — Claude Code meta-cognition leak markers. These are concepts the
// underlying Anthropic API model does NOT know about; they only appear when
// the spawned `claude` CLI's base persona (or walk-up CLAUDE.md content)
// bleeds into the tutor output. Hits trigger event log + console warning.
const CLAUDE_CODE_META_MARKERS = [
  /\bplan mode\b/i,
  /\btutor roleplay\b/i,
  /\bsystem[- ]?reminder\b/i,
  /TodoWrite/,
  /<command-(?:name|message)>/,
  /\bbegin now\b.{0,40}\b(plan|tutor|conflict)\b/i,
  /\bI need to clarify your intent\b/i,
  // v0158o — explicit "/login" / "/logout" advice = Claude Code's auth-error
  // escape hatch leaking into tutor output. With slash-dispatch shipping in
  // v0158o the user CAN type these, so seeing them in tutor output should
  // still be flagged as a leak (tutor shouldn't suggest CLI commands).
  /(?:^|\s)\/login\b/,
  /(?:^|\s)\/logout\b/,
];
function _detectClaudeCodeLeak(text) {
  if (!text) return null;
  for (const re of CLAUDE_CODE_META_MARKERS) {
    const m = re.exec ? re.exec(text) : null;
    if (m) return m[0];
  }
  return null;
}
function _buildPersonaLeakRE(settings) {
  const profile = settings && settings.userProfile;
  const userName = profile && profile.name && String(profile.name).trim();
  const tutorName = profile && profile.tutorName && String(profile.tutorName).trim();
  const userOwned = new Set();
  if (userName) userOwned.add(userName.toLowerCase());
  if (tutorName) userOwned.add(tutorName.toLowerCase());
  // Filter agent crew + add Victor only if user didn't claim it as their name.
  const candidates = ['Victor', 'Machino', ...PERSONA_LEAK_AGENT_NAMES]
    .filter(n => !userOwned.has(n.toLowerCase()));
  if (candidates.length === 0) return null;
  return new RegExp('\\b(' + candidates.join('|') + ')\\b|用户(?!灵感)', 'i');
}
// v0.2 Surface Finishing Track A A1 — post-stream anti-ingratiation scan.
// Runs after every tutor turn alongside _detectAndLogPersonaLeak. Hybrid:
// (a) logs `ingratiation_flagged` events to events.jsonl for trust-panel +
//     audit surface (Trust Panel "本节连贯 · ingratiation N次"),
// (b) returns the cleaned text (matches stripped via scrubIngratiation) so
//     callers can persist the cleaned version in transcript / downstream
//     consumers (confession / extract-from-lesson / re-stream prompts).
// Streamed chunks already left for renderer — those still carry violations
// in real time. TODO (v0.4): move to real-time chunk-level scrub (requires
// SSE protocol change to buffer + edit window).
function _detectAndLogIngratiation(text, settings, opts) {
  if (!text || typeof text !== 'string') return { clean_text: text, violations: [] };
  let detector = null;
  try { detector = require('./lib/agent-character/anti-ingratiation'); }
  catch (_) { return { clean_text: text, violations: [] }; /* lib missing → silent no-op */ }
  if (!detector || typeof detector.detectIngratiation !== 'function') {
    return { clean_text: text, violations: [] };
  }

  let hits = [];
  try { hits = detector.detectIngratiation(text) || []; }
  catch (_) { return { clean_text: text, violations: [] }; /* never break the call */ }
  if (!Array.isArray(hits) || hits.length === 0) {
    return { clean_text: text, violations: [] };
  }

  try {
    const phrases = hits.map(h => (h && h.match) ? String(h.match).slice(0, 80) : '').filter(Boolean);
    const slug = (opts && opts.lesson_slug) || (settings && settings.lesson_slug) || '_global';
    // V0.5 E0 D6 — type/op + field names UNCHANGED (downstream consumers depend).
    // `op` retained alongside events.write's required `type` to keep legacy readers working.
    events.write(slug, {
      type: 'ingratiation_flagged',
      op: 'ingratiation_flagged',
      provider: settings && settings.provider,
      model: settings && settings.model,
      count: hits.length,
      phrases,
      patterns: hits.slice(0, 6).map(h => h && h.pattern).filter(Boolean),
      context: (opts && opts.context) || 'tutor_turn',
      lesson_slug: (opts && opts.lesson_slug) || (settings && settings.lesson_slug) || null,
      lesson_idx: (opts && Number.isFinite(opts.lesson_idx)) ? opts.lesson_idx : null,
      turn_id: (opts && opts.turn_id) || null,
    });
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`[ingratiation_flagged] count=${hits.length} phrases=`, phrases.slice(0, 3));
    }
  } catch (err) {
    // Never silent-catch: flagging must not break the call but failure must surface.
    console.warn('[ingratiation_flagged] write failed:', err && err.message);
  }

  // Scrub: substitute matched spans + collapse whitespace. Returns clean text
  // for transcript persistence + downstream consumers. If scrub fails, fall
  // back to original text (detect+log already succeeded).
  try {
    if (typeof detector.scrubIngratiation === 'function') {
      const scrubbed = detector.scrubIngratiation(text);
      if (scrubbed && typeof scrubbed.clean_text === 'string') {
        return { clean_text: scrubbed.clean_text, violations: scrubbed.violations || hits };
      }
    }
  } catch (err) {
    console.warn('[ingratiation_scrub] failed:', err && err.message);
  }
  return { clean_text: text, violations: hits };
}

function _detectAndLogPersonaLeak(text, settings, opts) {
  if (!text || typeof text !== 'string') return;
  // v0158n — Claude Code meta-cognition leak (plan mode / TodoWrite / etc).
  // Independent of agent-name leak; runs even when settings.userProfile is empty.
  const ccLeak = _detectClaudeCodeLeak(text);
  if (ccLeak) {
    try {
      const idx = text.search(new RegExp(ccLeak.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i'));
      const slug = (opts && opts.lesson_slug) || (settings && settings.lesson_slug) || '_global';
      // V0.5 E0 D6 — type/op + field names UNCHANGED.
      events.write(slug, {
        type: 'claude_code_meta_leak',
        op: 'claude_code_meta_leak',
        provider: settings && settings.provider,
        model: settings && settings.model,
        hit: ccLeak,
        snippet: text.slice(Math.max(0, idx - 40), idx + 120),
        context: (opts && opts.context) || 'tutor_turn',
        hint: 'CLI sandbox failed — CLAUDE.md walk-up or ~/.claude/ leak. Check _hyphaSandboxDir + CLAUDE_CONFIG_DIR/HOME env in spawn.',
      });
      console.warn('[claude_code_meta_leak] hit=', ccLeak, ' — sandbox may be misconfigured');
    } catch (err) {
      console.warn('[claude_code_meta_leak] write failed:', err && err.message);
    }
  }
  // Original agent-name leak detector (Lung/Leo/Yogo/Muse/etc).
  const re = _buildPersonaLeakRE(settings);
  if (!re) return;
  const m = text.match(re);
  if (!m) return;
  try {
    const idx = text.search(re);
    const slug = (opts && opts.lesson_slug) || (settings && settings.lesson_slug) || '_global';
    // V0.5 E0 D6 — type/op + field names UNCHANGED.
    const evt = {
      type: 'persona_leak',
      op: 'persona_leak',
      provider: settings && settings.provider,
      model: settings && settings.model,
      hit: m[0],
      snippet: text.slice(Math.max(0, idx - 40), idx + 80),
      context: (opts && opts.context) || 'tutor_turn',
    };
    events.write(slug, evt);
    console.warn('[persona_leak]', m[0], 'in', evt.snippet.slice(0, 60));
  } catch (err) {
    console.warn('[persona_leak] write failed:', err && err.message);
  }
}

const BANNED_DOMAINS = [
  'edu.cn', '.cn/', 'tsinghua.edu', 'pku.edu', 'fudan.edu', 'sjtu.edu', 'zju.edu',
  'ustc.edu', 'nankai.edu', 'tongji.edu', 'csdn.net', 'cnblogs.com',
];

// 2026-05-08 (v0.3 lesson-chat unblock): when user has provider env var set
// but settings.apiKey blank, fall back to env. Mirrors the capability-class
// router behavior in app/lib/llm/* so the legacy agent.js streamTurn path
// works for users on Chinese providers without re-typing the key in Hypha
// settings UI. The fallback ladder per provider id:
//   glm       → GLM_API_KEY
//   deepseek  → DEEPSEEK_API_KEY
//   kimi      → KIMI_API_KEY
//   openai    → OPENAI_API_KEY
// sdk-anthropic + cli paths bypass this — they use their own auth chain.
function _envApiKeyFor(providerId) {
  if (!providerId) return null;
  const map = {
    glm: process.env.GLM_API_KEY,
    deepseek: process.env.DEEPSEEK_API_KEY,
    kimi: process.env.KIMI_API_KEY,
    moonshot: process.env.KIMI_API_KEY,
    openai: process.env.OPENAI_API_KEY,
  };
  const k = map[String(providerId).toLowerCase()];
  return (k && typeof k === 'string') ? k.trim() : null;
}

function client(settings) {
  const fromSettings = (settings && settings.apiKey && String(settings.apiKey).trim()) || null;
  const fromEnv = !fromSettings ? _envApiKeyFor(settings && settings.provider) : null;
  return new OpenAI({
    apiKey: fromSettings || fromEnv || 'missing',
    baseURL: settings.baseURL || 'https://api.openai.com/v1',
  });
}

// ── CLI provider dispatch ───────────────────────────────────────────────────
// User has Claude Max / Gemini subscription → vendor CLI shells run prompts
// against their authenticated session (no API key needed). Hypha shells out
// to the binary instead of OpenAI SDK calls.
const { spawn: _cliSpawn } = require('node:child_process');

function _resolveProviderConfig(settings) {
  const providers = require('./lib/providers');
  return providers.getProvider(settings.provider) || {};
}

function _composePromptFromMessages(messages) {
  // CLI binaries take a single text prompt — flatten the messages array into
  // a structured plain-text composition. system + each turn delineated.
  let out = '';
  for (const m of messages) {
    if (m.role === 'system') out += `[SYSTEM]\n${m.content}\n\n`;
    else if (m.role === 'user') out += `[YOU]\n${m.content}\n\n`;
    else if (m.role === 'assistant') out += `[TUTOR]\n${m.content}\n\n`;
  }
  out += '[YOUR REPLY AS TUTOR]\n';
  return out;
}

// 2026-05-05 (Appendix C) — bare composer for cliPureMode. Strips the Hypha-
// specific [YOU]/[TUTOR]/[YOUR REPLY AS TUTOR] role labels so claude-cli sees
// only natural conversation text. For single-turn (1 user message) emits the
// raw content. For multi-turn uses standard "User: / Assistant:" labels which
// match Anthropic Messages-API conventions and don't bias the model into
// Hypha's tutor frame.
function _composeBareUserPrompt(messages) {
  const filtered = (messages || []).filter(m => m && (m.role === 'user' || m.role === 'assistant'));
  if (filtered.length === 0) return '';
  if (filtered.length === 1 && filtered[0].role === 'user') {
    return String(filtered[0].content || '');
  }
  const lines = [];
  for (const m of filtered) {
    const label = m.role === 'user' ? 'User' : 'Assistant';
    lines.push(`${label}: ${m.content || ''}`);
  }
  return lines.join('\n\n') + '\n\n';
}

// 2026-05-02 — for CLIs that support a `--system-prompt` flag (Anthropic
// claude CLI does, verified `claude --help`), extract system-role messages
// and return them separately so they can be sent via the proper API system
// field instead of being flattened into the user-message blob with a
// "[SYSTEM]" ASCII tag (where the model treats it as user text + the host
// CLI's own loaded system prompt — Claude Code's Victor persona — wins).
//
// This single change is what closes the persona-pollution bug: with
// `--system-prompt`, our system text takes the wire-level system field, and
// per Anthropic's API contract system >> user. Even with Claude Code's
// CLAUDE.md walkup + agent registrations still loaded in context, the
// custom system prompt dominates first-recall behavior.
// v0158n — oil-capsule isolation for spawned CLI processes. Without these,
// `claude` walks up from CWD to find E:\victor\CLAUDE.md (Victor's universe),
// reads ~/.claude/CLAUDE.md (global memory), reads ~/.claude.json (settings).
// All three pollute lesson tutor output with plan-mode meta-cognition,
// agent-council names, etc. Per WebSearch 2026-05-04 (Issue #3833 +
// dbreunig 2026-04 system-prompt build): even with --system-prompt (replace),
// CLAUDE.md walk-up + global memory load runs through a SEPARATE injection
// path that --system-prompt does NOT shadow. Only CWD + HOME + CLAUDE_CONFIG_DIR
// redirection blocks those paths.
//
// _hyphaSandboxDir() returns an isolated path under userData where:
//   - no CLAUDE.md walk-up exists (we ensure parent dirs are clean)
//   - we plant an empty .claude/ to anchor walk-up (claude stops here)
//   - CLAUDE_CONFIG_DIR points here (kills ~/.claude/ leak)
//   - HOME points here (kills ~/.claude.json leak per Issue #3833)
let _sandboxDirCache = null;
function _hyphaSandboxDir() {
  if (_sandboxDirCache) return _sandboxDirCache;
  try {
    const path = require('node:path');
    const fs = require('node:fs');
    const os = require('node:os');
    const { app } = require('electron');
    const base = (app && typeof app.getPath === 'function')
      ? app.getPath('userData')
      : path.join(os.tmpdir(), 'hypha-userData');
    const dir = path.join(base, 'cli-sandbox');
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    // Plant a CLAUDE.md sentinel that stops walk-up + emits no instructions.
    // Empty file = walk-up halts here, no content injected.
    const sentinel = path.join(dir, 'CLAUDE.md');
    if (!fs.existsSync(sentinel)) {
      fs.writeFileSync(sentinel,
        '<!-- Hypha CLI sandbox — intentionally empty to halt CLAUDE.md walk-up. -->\n',
        'utf8'
      );
    }
    // Also plant empty global ~/.claude/CLAUDE.md inside this sandbox (the
    // CLAUDE_CONFIG_DIR target) so claude doesn't fall through to user's real one.
    const sandboxGlobal = path.join(dir, '.claude', 'CLAUDE.md');
    if (!fs.existsSync(sandboxGlobal)) {
      fs.writeFileSync(sandboxGlobal,
        '<!-- Hypha CLI sandbox global memory — empty by design. -->\n',
        'utf8'
      );
    }
    _sandboxDirCache = dir;
    return dir;
  } catch (e) {
    console.warn('[hypha-sandbox] init failed:', e.message);
    return null;
  }
}

// Build the env + cwd pair for spawning a sandboxed claude CLI. Used only when
// provider.via === 'cli' AND binary === 'claude' (or claude-* variant). Other
// CLIs (gemini, codex) keep current env path; they don't have the same
// CLAUDE.md walk-up bug.
function _hyphaSandboxedSpawnOpts(baseEnv, cfg, settings) {
  const isClaude = cfg && cfg.binary && /^claude(\b|-)/i.test(cfg.binary);
  if (!isClaude) {
    return {
      env: { ...baseEnv, GEMINI_CLI_TRUST_WORKSPACE: 'true' },
      cwd: undefined,
    };
  }
  const dir = _hyphaSandboxDir();
  if (!dir) {
    return {
      env: { ...baseEnv, GEMINI_CLI_TRUST_WORKSPACE: 'true' },
      cwd: undefined,
    };
  }
  // v0158p — inject CLAUDE_CODE_OAUTH_TOKEN if user has pasted one via /token
  // slash command. Anthropic-blessed headless auth path (Issue #22992): user
  // runs `claude setup-token` in real terminal once, copies token, pastes into
  // Hypha. This works in sandbox without TTY because token is provided
  // directly, no OAuth browser flow required at runtime.
  const oauthToken = settings && typeof settings.oauthToken === 'string'
    ? settings.oauthToken.trim() : '';
  const env = {
    ...baseEnv,
    GEMINI_CLI_TRUST_WORKSPACE: 'true',
    // Redirect ~/.claude/ → sandbox/.claude/. Per Issue #3833 this is
    // partial — ~/.claude.json still lives at $HOME. So also redirect HOME.
    CLAUDE_CONFIG_DIR: require('node:path').join(dir, '.claude'),
    HOME: dir,
    USERPROFILE: dir, // Windows equivalent of HOME
  };
  if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  return { env, cwd: dir };
}

function _splitSystemFromMessages(messages) {
  const systemParts = [];
  const others = [];
  for (const m of messages || []) {
    if (m && m.role === 'system' && typeof m.content === 'string' && m.content.trim()) {
      systemParts.push(m.content);
    } else {
      others.push(m);
    }
  }
  return {
    systemPrompt: systemParts.join('\n\n'),
    others,
  };
}

// Run a CLI binary once (non-streaming). Returns the full reply string.
//
// Prompt-passing convention (matches lib/deepen-pipeline.js working pattern):
//   - prompt ALWAYS goes via stdin (multi-line / unicode / quote-safe — shell
//     never sees it). Newline-mangling that shell:true on Windows would do
//     to a CLI arg never happens because stdin bypasses cmd.exe entirely.
//   - cfg.promptFlag, when set, is pushed as a BARE flag with no value. It
//     signals "non-interactive mode" to CLIs that need the hint (claude '-p'
//     toggles --print). For CLIs that REQUIRE a value after the flag (gemini's
//     yargs strict mode), set cfg.promptFlag to null and let the CLI infer
//     from piped stdin (default behaviour for both gemini and codex).
async function _runCliOnce(messages, settings, opts = {}) {
  const cfg = _resolveProviderConfig(settings);
  if (!cfg.binary) throw new Error('cli provider missing binary name');
  // 2026-05-05 (Appendix C) — pure passthrough mode. When opts.cliPureMode is
  // set, drop ALL system messages so the CLI uses its own default Claude Code
  // system rather than Hypha's tutor scaffolding. Sandbox env still applies,
  // so Victor universe / global agents / ~/.claude.json stay blocked.
  // Used by tutor speech path (streamTurn) when provider is claude-cli;
  // user-facing dialog matches Terminal experience. JSON callers (llmJSON →
  // here non-streaming) do NOT pass cliPureMode — they need --system-prompt
  // to control schema, so their behavior is unchanged.
  if (opts.cliPureMode && Array.isArray(messages)) {
    messages = messages.filter(m => !(m && m.role === 'system'));
  }
  const timeoutMs = opts.timeoutMs || 90_000;
  // 2026-05-02 — split system messages out so they can ride the CLI's
  // --system-prompt flag and reach the API's system field cleanly.
  let messagesToCompose = messages;
  let systemPromptForFlag = '';
  if (cfg.systemPromptFlag) {
    const split = _splitSystemFromMessages(messages);
    systemPromptForFlag = split.systemPrompt;
    messagesToCompose = split.others;
  }
  // 2026-05-05 (Appendix C) — pure mode uses bare composer (no Hypha role
  // labels). Otherwise legacy [YOU]/[TUTOR]/[YOUR REPLY AS TUTOR] composer.
  let prompt = opts.cliPureMode
    ? _composeBareUserPrompt(messagesToCompose)
    : _composePromptFromMessages(messagesToCompose);
  // 2026-05-03 — Windows CMD has ~8192-char arg limit. planChain's system
  // prompt easily exceeds this. When too long, inline as [SYSTEM] block in
  // stdin instead of --system-prompt flag. Loses CLI system-field isolation
  // (claude-cli persona may bleed in for that call) but prevents the hard
  // "command line is too long" exit.
  const SYS_FLAG_MAX = 5000;
  if (systemPromptForFlag && systemPromptForFlag.length > SYS_FLAG_MAX) {
    prompt = `[SYSTEM]\n${systemPromptForFlag}\n[/SYSTEM]\n\n${prompt}`;
    systemPromptForFlag = '';
  }
  const args = [];
  if (Array.isArray(cfg.prefixArgs)) args.push(...cfg.prefixArgs);
  if (cfg.modelFlag && (settings.model || cfg.defaultModel)) {
    args.push(cfg.modelFlag, settings.model || cfg.defaultModel);
  }
  if (cfg.systemPromptFlag && systemPromptForFlag) {
    args.push(cfg.systemPromptFlag, systemPromptForFlag);
  }
  if (cfg.promptFlag) args.push(cfg.promptFlag);
  if (Array.isArray(cfg.suffixArgs)) args.push(...cfg.suffixArgs);
  return new Promise((resolve, reject) => {
    let child;
    let killed = false;
    try {
      // v0158n — sandbox claude CLI to block CLAUDE.md walk-up + ~/.claude/ leak.
      const _sandbox = _hyphaSandboxedSpawnOpts(process.env, cfg, settings);
      child = _cliSpawn(cfg.binary, args, {
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: _sandbox.env,
        cwd: _sandbox.cwd,
      });
    } catch (e) { return reject(new Error('spawn failed: ' + e.message)); }
    // Hard timeout — without this a stalled CLI binary (network hang, persona
    // overflow, prompt waiting on stdin) blocks chain:create indefinitely.
    // Mirrors the 90s default that OpenAI-compat + Anthropic SDK branches use.
    const tid = setTimeout(() => {
      killed = true;
      try { child.kill('SIGTERM'); } catch (_) {}
      const e = new Error(`CLI ${cfg.binary} timed out after ${Math.round(timeoutMs/1000)}s`);
      e.code = 'CLI_TIMEOUT';
      reject(e);
    }, timeoutMs);
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', err => { clearTimeout(tid); if (!killed) reject(new Error('cli error: ' + err.message)); });
    child.on('close', code => {
      clearTimeout(tid);
      if (killed) return; // already rejected via timeout
      if (code !== 0) return reject(new Error(`cli exit ${code}: ${stderr.slice(0, 300)}`));
      resolve(stdout.trim());
    });
    try { child.stdin.write(prompt); child.stdin.end(); }
    catch (e) { clearTimeout(tid); reject(new Error('stdin write failed: ' + e.message)); }
  });
}

// Run a CLI binary in streaming mode. Calls onChunk(text) per content piece.
// opts.signal: optional AbortSignal — when triggered, kills the child via
// SIGTERM so the stop button in the UI can halt the stream.
async function _runCliStream(messages, settings, onChunk, opts = {}) {
  const cfg = _resolveProviderConfig(settings);
  if (!cfg.binary) throw new Error('cli provider missing binary name');
  // 2026-05-05 (Appendix C) — same pure passthrough as _runCliOnce. When
  // opts.cliPureMode is set, drop system messages; CLI uses its default
  // system. Set by streamTurn when the resolved binary is claude-* (user
  // wants pure Terminal claude-cli experience for tutor turns).
  if (opts.cliPureMode && Array.isArray(messages)) {
    messages = messages.filter(m => !(m && m.role === 'system'));
  }
  // 2026-05-02 — same split as _runCliOnce: system messages ride the
  // --system-prompt flag, others go via stdin. See _splitSystemFromMessages.
  let messagesToCompose = messages;
  let systemPromptForFlag = '';
  if (cfg.systemPromptFlag) {
    const split = _splitSystemFromMessages(messages);
    systemPromptForFlag = split.systemPrompt;
    messagesToCompose = split.others;
  }
  let prompt = opts.cliPureMode
    ? _composeBareUserPrompt(messagesToCompose)
    : _composePromptFromMessages(messagesToCompose);
  // 2026-05-03 — Windows CMD has ~8192-char arg limit. planChain's system
  // prompt easily exceeds this. When too long, inline as [SYSTEM] block in
  // stdin instead of --system-prompt flag. Loses CLI system-field isolation
  // (claude-cli persona may bleed in for that call) but prevents the hard
  // "command line is too long" exit.
  const SYS_FLAG_MAX = 5000;
  if (systemPromptForFlag && systemPromptForFlag.length > SYS_FLAG_MAX) {
    prompt = `[SYSTEM]\n${systemPromptForFlag}\n[/SYSTEM]\n\n${prompt}`;
    systemPromptForFlag = '';
  }
  const args = [];
  if (Array.isArray(cfg.prefixArgs)) args.push(...cfg.prefixArgs);
  if (cfg.modelFlag && (settings.model || cfg.defaultModel)) {
    args.push(cfg.modelFlag, settings.model || cfg.defaultModel);
  }
  if (cfg.systemPromptFlag && systemPromptForFlag) {
    args.push(cfg.systemPromptFlag, systemPromptForFlag);
  }
  // 2026-05-05 (Appendix D) — claude-cli session continuity. When resumeSessionId
  // is set, claude joins an existing session it knows from prior call's session_id.
  // This eliminates the per-turn transcript replay (caller passes ONLY the current
  // user message) — model has its own history. Approaches native Terminal claude
  // experience. Only meaningful when binary supports --resume (claude-cli does).
  if (opts.resumeSessionId && /^claude(\b|-)/i.test(cfg.binary)) {
    args.push('--resume', String(opts.resumeSessionId));
  }
  if (cfg.promptFlag) args.push(cfg.promptFlag);
  if (Array.isArray(cfg.streamFlag) && cfg.streamFlag.length) args.push(...cfg.streamFlag);
  if (Array.isArray(cfg.suffixArgs)) args.push(...cfg.suffixArgs);

  return new Promise((resolve, reject) => {
    let child;
    let aborted = false;
    let _sessionIdReported = false;
    try {
      // v0158n — same sandbox as _runCliOnce.
      const _sandbox = _hyphaSandboxedSpawnOpts(process.env, cfg, settings);
      child = _cliSpawn(cfg.binary, args, {
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: _sandbox.env,
        cwd: _sandbox.cwd,
      });
    } catch (e) { return reject(new Error('spawn failed: ' + e.message)); }
    // Wire optional abort signal — UI stop button → main.js IPC abort →
    // ac.signal aborts → kill the child. Resolves the promise so any
    // accumulated content already streamed via onChunk is preserved.
    let onAbort = null;
    if (opts.signal) {
      if (opts.signal.aborted) {
        try { child.kill('SIGTERM'); } catch (_) {}
        aborted = true;
      } else {
        onAbort = () => {
          aborted = true;
          try { child.kill('SIGTERM'); } catch (_) {}
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    let stderr = '';
    let buffer = '';
    let isStreamJSON = Array.isArray(cfg.streamFlag) && cfg.streamFlag.includes('stream-json');

    // v0158e — claude 2.x stream-json compatibility. The 1.x → 2.x bump (verified
    // by user 2026-05-04: claude --version → 2.1.126) likely changed event shape.
    // Old parser only matched {message: {content: [{type:'text',text}]}} OR ev.delta
    // OR ev.text. New 2.x events may use Anthropic SSE shape (content_block_delta
    // with delta.text). Add wider matching + log every event so we can capture
    // unknown shapes for follow-up.
    let _emittedChunks = 0;
    let _allEventsRaw = '';      // accumulate raw stdout for fallback if 0 chunks
    function _extractTextFromEvent(ev) {
      // Match all known shapes from claude 1.x and 2.x stream-json
      // 1.x: { type: 'assistant', message: { content: [{type:'text', text:'...'}] } }
      if (ev.message && ev.message.content && Array.isArray(ev.message.content)) {
        const t = ev.message.content
          .filter(c => c && c.type === 'text')
          .map(c => c.text || '')
          .join('');
        if (t) return t;
      }
      // 2.x SSE-style: { type: 'content_block_delta', delta: { type: 'text_delta', text: '...' } }
      if (ev.type === 'content_block_delta' && ev.delta && typeof ev.delta.text === 'string') {
        return ev.delta.text;
      }
      // 2.x alternate: { type: 'message_delta', delta: { content: [...] } }
      if (ev.type === 'message_delta' && ev.delta && Array.isArray(ev.delta.content)) {
        const t = ev.delta.content
          .filter(c => c && c.type === 'text')
          .map(c => c.text || '')
          .join('');
        if (t) return t;
      }
      // 2.x text-only field at top
      if (ev.type === 'text' && typeof ev.text === 'string') return ev.text;
      // Fallback: ev.text or ev.delta as string (legacy 1.x compat)
      if (typeof ev.text === 'string') return ev.text;
      if (typeof ev.delta === 'string') return ev.delta;
      return '';
    }

    child.stdout.on('data', d => {
      const chunk = d.toString('utf8');
      _allEventsRaw += chunk;
      if (isStreamJSON) {
        buffer += chunk;
        let lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            // 2026-05-05 (Appendix D) — session_id capture for fresh-spawn case.
            // claude-cli stream-json emits a `system` (or system_init / init)
            // event near the start carrying session_id. Caller persists it for
            // future --resume calls. Multi-field tolerance: schema across CLI
            // versions varies, accept any of session_id / sessionId / id.
            if (!_sessionIdReported && opts.onSessionId && !opts.resumeSessionId) {
              const sid = (ev && (ev.session_id || ev.sessionId || (ev.session && ev.session.id) || (ev.type === 'system' && ev.id)));
              if (sid && typeof sid === 'string' && sid.length > 0 && sid.length < 200) {
                _sessionIdReported = true;
                try { opts.onSessionId(sid); } catch (_) { /* swallow callback fail */ }
              }
            }
            const text = _extractTextFromEvent(ev);
            if (text) {
              onChunk(text);
              _emittedChunks += 1;
            } else {
              // Unknown event shape — log for diagnostic so we can update parser
              console.log('[_runCliStream] unparsed event type=' + (ev.type || '?') + ' keys=' + Object.keys(ev).slice(0, 5).join(','));
            }
          } catch (_) { /* not JSON, skip — claude often prints non-JSON warnings */ }
        }
      } else {
        onChunk(chunk);
        _emittedChunks += 1;
      }
    });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', err => {
      if (onAbort && opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (!aborted) reject(new Error('cli stream error: ' + err.message));
    });
    child.on('close', code => {
      if (onAbort && opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (aborted) return resolve();
      if (code !== 0) return reject(new Error(`cli exit ${code}: ${stderr.slice(0, 300)}`));
      // Flush any remaining buffer line
      if (isStreamJSON && buffer.trim()) {
        try {
          const ev = JSON.parse(buffer);
          const text = _extractTextFromEvent(ev);
          if (text) { onChunk(text); _emittedChunks += 1; }
        } catch (_) {}
      }
      // v0158e — empty-output fallback: if streamJSON parser found 0 chunks but
      // child exited 0, treat raw stdout as plain text. Likely scenario: claude
      // 2.x changed event shape entirely + parser missed everything. Better to
      // emit "[object Object]"-like raw than blank. Strip ANSI control chars.
      if (_emittedChunks === 0 && _allEventsRaw.trim()) {
        console.log('[_runCliStream] FALLBACK: 0 chunks parsed from stream-json, ' + _allEventsRaw.length + ' bytes raw stdout. Emitting raw as plain text. Recent stdout sample: ' + _allEventsRaw.slice(0, 400));
        const cleaned = _allEventsRaw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
        if (cleaned) onChunk(cleaned);
      }
      console.log('[_runCliStream] DONE provider=' + cfg.id + ' emittedChunks=' + _emittedChunks + ' rawLen=' + _allEventsRaw.length + ' stderrLen=' + stderr.length);
      resolve();
    });
    try { child.stdin.write(prompt); child.stdin.end(); }
    catch (e) { reject(new Error('stdin write failed: ' + e.message)); }
  });
}

function _isCliProvider(settings) {
  const cfg = _resolveProviderConfig(settings);
  return cfg && cfg.via === 'cli';
}

// Hypha Cloud — POST messages to /v1/llm with the user's desktop token,
// return assistant content (string). Throws on 402 (out of credit) so the
// renderer can surface "topup needed" UI; throws on 401 so renderer can
// open the sign-in flow. Other errors bubble up like any other backend.
async function _hyphaProxyCall(messages, settings, opts) {
  const baseURL = (settings.hyphaBaseURL || 'https://hypha.studio').replace(/\/$/, '');
  const token = settings.hyphaToken;
  if (!token) {
    const err = new Error('Hypha Cloud not signed in');
    err.code = 'HYPHA_NOT_SIGNED_IN';
    throw err;
  }
  const body = {
    model: settings.model || 'managed',
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.max_tokens || 4000,
    response_format: opts.json ? { type: 'json_object' } : undefined,
    fn: opts.fn || 'llmJSON',
  };
  const fetchFn = (typeof fetch === 'function') ? fetch : require('node-fetch');
  const res = await fetchFn(`${baseURL}/v1/llm`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (res.status === 402) {
    const data = await res.json().catch(() => ({}));
    const err = new Error('Hypha Cloud: out of credit. Top up at ' + (data.topup_url || ''));
    err.code = 'HYPHA_NO_CREDIT';
    err.topupUrl = data.topup_url;
    throw err;
  }
  if (res.status === 401) {
    const err = new Error('Hypha Cloud: token invalid. Sign in again.');
    err.code = 'HYPHA_BAD_TOKEN';
    throw err;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Hypha Cloud: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  let raw = data.choices?.[0]?.message?.content || '';
  if (opts.json) {
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    if (!raw.startsWith('{') && !raw.startsWith('[')) {
      const m = raw.match(/[\{\[][\s\S]*[\}\]]/);
      if (m) raw = m[0];
    }
  }
  return raw;
}

function passesSourcePolicy(url) {
  const u = String(url || '').toLowerCase();
  return !BANNED_DOMAINS.some(d => u.includes(d));
}

// ── harvest() helpers — extracted for telemetry + parallel scheduling ───────
// Each channel returns { items: [...], err: null|string } so the orchestrator
// can capture per-channel failures without one bad source killing the rest.

async function _harvestGithub(topic) {
  const q = encodeURIComponent(String(topic).trim());
  const ghRes = await fetch(`https://api.github.com/search/repositories?q=${q}&sort=stars&per_page=8`, {
    headers: { 'User-Agent': 'Hypha/0.1', Accept: 'application/vnd.github+json' },
  });
  const items = [];
  if (ghRes.ok) {
    const data = await ghRes.json();
    for (const r of (data.items || [])) {
      if (!passesSourcePolicy(r.html_url)) continue;
      items.push({ url: r.html_url, title: r.full_name, excerpt: r.description || '', stars: r.stargazers_count, sourceType: 'github' });
    }
  }
  return items;
}

async function _harvestHN(topic) {
  const q = encodeURIComponent(String(topic).trim());
  const hnRes = await fetch(`https://hn.algolia.com/api/v1/search?query=${q}&numericFilters=points>50&hitsPerPage=10`);
  const items = [];
  if (hnRes.ok) {
    const data = await hnRes.json();
    for (const h of (data.hits || [])) {
      const url = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
      if (!passesSourcePolicy(url)) continue;
      items.push({ url, title: h.title || h.story_title || '', excerpt: (h.story_text || '').slice(0, 240), stars: h.points, sourceType: 'hn' });
    }
  }
  return items;
}

async function _harvestArxiv(topic) {
  const q = encodeURIComponent(String(topic).trim());
  // sortBy=submittedDate&sortOrder=descending → newest preprints first.
  // Was sortBy=relevance which biased toward older highly-cited papers.
  const axRes = await fetch(`http://export.arxiv.org/api/query?search_query=all:${q}&max_results=8&sortBy=submittedDate&sortOrder=descending`, {
    headers: { 'User-Agent': 'Hypha/0.1' },
  });
  const items = [];
  if (axRes.ok) {
    const xml = await axRes.text();
    const entries = xml.split('<entry>').slice(1);
    for (const e of entries) {
      const t = (e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      const s = (e.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || '';
      const u = (e.match(/<id>([\s\S]*?)<\/id>/) || [])[1] || '';
      if (!passesSourcePolicy(u)) continue;
      items.push({ url: u.trim(), title: t.trim().replace(/\s+/g, ' '), excerpt: s.trim().replace(/\s+/g, ' ').slice(0, 240), stars: 0, sourceType: 'arxiv' });
    }
  }
  return items;
}

// R-LIB Day 2 (2026-05-12): module-level cache of latest library book rollup
// per topic. _bookRollup attached non-enumerable to the harvest array gets
// stripped on `[...perChannel.library]` spread in the merge path, so we cache
// here instead. Skeleton stage reads via getLibraryRollupForTopic(topic). LRU-
// bounded at 32 entries.
const _LIBRARY_ROLLUP_CACHE = new Map();
function _setLibraryRollup(topic, rollup) {
  const key = String(topic || '').trim().toLowerCase();
  if (!key) return;
  _LIBRARY_ROLLUP_CACHE.set(key, rollup);
  if (_LIBRARY_ROLLUP_CACHE.size > 32) {
    const firstKey = _LIBRARY_ROLLUP_CACHE.keys().next().value;
    _LIBRARY_ROLLUP_CACHE.delete(firstKey);
  }
}
function getLibraryRollupForTopic(topic) {
  return _LIBRARY_ROLLUP_CACHE.get(String(topic || '').trim().toLowerCase()) || null;
}

// R-LIB Day 3 (2026-05-12): same cache pattern for community pack hints —
// skeleton stage injects syllabus_skeleton + curator badges; CHALLENGE pipeline
// reads contested_questions as objector seeds. LRU-bounded at 32.
const _COMMUNITY_HINT_CACHE = new Map();
function _setCommunityHint(topic, hint) {
  const key = String(topic || '').trim().toLowerCase();
  if (!key) return;
  _COMMUNITY_HINT_CACHE.set(key, hint);
  if (_COMMUNITY_HINT_CACHE.size > 32) {
    const firstKey = _COMMUNITY_HINT_CACHE.keys().next().value;
    _COMMUNITY_HINT_CACHE.delete(firstKey);
  }
}
function getCommunityHintForTopic(topic) {
  return _COMMUNITY_HINT_CACHE.get(String(topic || '').trim().toLowerCase()) || null;
}

// User Library — local PDF/MD/TXT chunks ingested via library:pickAndAdd.
// Always-on channel, free, fast. Per pedagogy.md System 5 (Bibliography
// Grounding). Returns shape compatible with other harvest channels so the
// downstream BM25/rank pass and aggregator stay agnostic.
//
// Phase B Gap 4 (2026-05-17): primary path is now GraphRAG over per-book
// entity graphs. Caught by user: BM25 + CJK single-char tokenizer collapsed
// "诺贝尔文学" → ["诺","贝","尔","文","学"], scoring philosophy books high
// because "学" / "文" are high-frequency CJK chars. GraphRAG queries against
// LLM-extracted entities (people / works / schools) + 13 typed edges. BM25
// retained below as `_harvestLibraryBM25Legacy` and used as fallback when
// graph build hasn't run yet (new uploads, smoke envs).
async function _harvestLibrary(topic, settings) {
  try {
    const graphRag = require('./lib/graph-rag');
    const vaultLib = require('./lib/vault');
    const vaultRoot = vaultLib.resolveRoot();

    const hits = await graphRag.queryGraph({
      courseGoal: topic,
      archetype: settings && settings._archetype,
      k: 10,
      vaultRoot,
      settings,
    });

    if (!Array.isArray(hits) || hits.length === 0) {
      // Graph found nothing → fall back to BM25 (perhaps user has books but
      // never ran a graph build, or graphs are stale). BM25 result is still
      // better than empty.
      return _harvestLibraryBM25Legacy(topic, settings);
    }

    // Convert GraphRAG hits → harvest-channel shape so downstream BM25/merge
    // + skeleton-stage prompt injection stay agnostic. Adds GraphRAG-only
    // provenance fields (hit_node, walked_via) for citation / trace UI.
    // 2026-05-19 — Anti-Slop bridge: enrich each source with fidelity_score
    // from library manifest so lesson-body-generator can render "[fidelity=
    // 0.62 mid OCR]" tag → architect prompt sees grounding fidelity →
    // self-confession when source quality is low.
    const libraryLib = require('./lib/library');
    return hits.map(h => {
      const fid = libraryLib.getFidelity({ vaultRoot, bookId: h.book_id }) || {};
      return {
        url: `library://${h.book_id}/chunk-${h.chunk_idx}`,
        title: `${h.book_title || ''} — ${h.chunk_title || ''}`.trim() || 'Library chunk',
        excerpt: (h.snippet || '').slice(0, 400),
        stars: Number.isFinite(h.score) ? h.score : 0,
        sourceType: 'library',
        book_author: h.book_author || '',
        book_id: h.book_id,
        chunk_idx: h.chunk_idx,
        // GraphRAG-specific provenance:
        hit_node: h.hit_node || null,
        matched_query_entity: h.matched_query_entity || null,
        walked_via: h.walked_via || [],
        // Anti-Slop bridge — source fidelity carried for prompt-level tagging.
        fidelity_score: fid.fidelity_score,
        fidelity_tier: fid.fidelity_tier,
        parsed_level: fid.parsed_level,
      };
    });
  } catch (err) {
    // Defensive: any unexpected failure in graph-rag (e.g. graphology missing,
    // corrupt graph file) falls back to BM25 so user always gets results.
    console.warn('[harvest_library] graph-rag failed, falling back to BM25:', err && err.message);
    return _harvestLibraryBM25Legacy(topic, settings);
  }
}

// Original BM25 + 3-vector query expansion. Kept as fallback when GraphRAG
// produces no hits (typical case: new book uploaded, graph not yet built)
// or when graph-rag module fails to load (graphology absent etc.).
//
// R-LIB Day 2 (2026-05-12): 3-vector query expansion + book-level rollup.
// Topic → {direct, prereq, related} aliases via query-expansion dict. Each
// vector queried separately. Same chunk hit by multiple vecs gets sum-bonus +
// vec_origins merged set. Books that span vectors rank highest (e.g. Copleston
// Vol 4 has direct=Spinoza + prereq=Descartes hits). Per-book rollup with TOC
// attached as `_bookRollup` side-channel for skeleton-stage prompt injection.
async function _harvestLibraryBM25Legacy(topic, settings) {
  try {
    const libraryLib = require('./lib/library');
    const vaultLib = require('./lib/vault');
    const { expandQueryForCourse } = require('./lib/query-expansion');
    const vaultRoot = vaultLib.resolveRoot();

    const layer1Ancestors = (settings && Array.isArray(settings.layer1Ancestors))
      ? settings.layer1Ancestors : [];
    const { direct, prereq, related } = expandQueryForCourse(
      String(topic || ''), { layer1Ancestors }
    );

    // Per-vec retrieval — each alias gets its own queryLibrary call so multi-
    // hit detection can attribute origin. k=5 per term, bounded to keep cost
    // manageable (dict has ~3-5 aliases per role × 3 roles = ~12 calls max).
    const taggedHits = [];
    const _queryVec = (terms, origin) => {
      for (const term of terms) {
        if (!term || typeof term !== 'string' || !term.trim()) continue;
        let hits = [];
        try { hits = libraryLib.queryLibrary({ vaultRoot, topic: term.trim(), k: 5 }) || []; }
        catch (_) { hits = []; }
        for (const h of hits) taggedHits.push({ ...h, vec_origin: origin, vec_term: term });
      }
    };
    _queryVec(direct, 'direct');
    _queryVec(prereq, 'prereq');
    _queryVec(related, 'related');

    if (taggedHits.length === 0) return [];

    // Merge same chunk (book_id + chunk_idx) → sum-bonus + union of vec_origins
    const chunkMap = new Map();
    for (const h of taggedHits) {
      const key = `${h.book_id}:${h.chunk_idx}`;
      const prev = chunkMap.get(key);
      if (prev) {
        prev.score += h.score;
        prev.vec_origins.add(h.vec_origin);
      } else {
        chunkMap.set(key, { ...h, vec_origins: new Set([h.vec_origin]) });
      }
    }
    const merged = [...chunkMap.values()].sort((a, b) => b.score - a.score);

    // Per-book aggregation. Books that hit multiple vecs (direct+prereq) rank
    // higher than single-vec books — signal of broad coverage. e.g. Copleston
    // Vol 4 (direct=28 + prereq=12) ranks above narrow Spinoza-only monograph.
    const bookMap = new Map();
    for (const m of merged) {
      const b = bookMap.get(m.book_id);
      const inDirect = m.vec_origins.has('direct') ? 1 : 0;
      const inPrereq = m.vec_origins.has('prereq') ? 1 : 0;
      const inRelated = m.vec_origins.has('related') ? 1 : 0;
      if (b) {
        b.hit_count++;
        b.total_score += m.score;
        b.direct_hits += inDirect;
        b.prereq_hits += inPrereq;
        b.related_hits += inRelated;
        if (b.top_chunks.length < 3) b.top_chunks.push(m);
      } else {
        bookMap.set(m.book_id, {
          book_id: m.book_id,
          book_title: m.book_title,
          book_author: m.book_author,
          hit_count: 1,
          total_score: m.score,
          direct_hits: inDirect,
          prereq_hits: inPrereq,
          related_hits: inRelated,
          top_chunks: [m],
        });
      }
    }

    const books = [...bookMap.values()].sort((a, b) => {
      // Primary: vec span (3 > 2 > 1) — book covering multiple roles is most relevant
      const aSpan = (a.direct_hits > 0 ? 1 : 0) + (a.prereq_hits > 0 ? 1 : 0) + (a.related_hits > 0 ? 1 : 0);
      const bSpan = (b.direct_hits > 0 ? 1 : 0) + (b.prereq_hits > 0 ? 1 : 0) + (b.related_hits > 0 ? 1 : 0);
      if (aSpan !== bSpan) return bSpan - aSpan;
      // Tiebreaker: total raw score
      return b.total_score - a.total_score;
    });
    const topBooks = books.slice(0, 5);

    // Attach TOC for skeleton-stage prompt — chapter titles only, no body text
    for (const b of topBooks) {
      try {
        const tocRes = libraryLib.getBookTOC({ vaultRoot, id: b.book_id });
        b.toc = (tocRes && tocRes.ok) ? (tocRes.toc || []) : [];
      } catch (_) { b.toc = []; }
    }

    // Flat chunk list for legacy downstream consumers (BM25 merge in harvest()).
    // Cap at 2 chunks per book × 5 books = 10 max, lower than the previous
    // single-vec 6 to keep token budget steady despite richer per-chunk metadata.
    // 2026-05-19 — Anti-Slop bridge: per-source fidelity_score for prompt tag.
    const flatItems = [];
    for (const b of topBooks) {
      const fid = libraryLib.getFidelity({ vaultRoot, bookId: b.book_id }) || {};
      for (const ch of b.top_chunks.slice(0, 2)) {
        flatItems.push({
          url: `library://${ch.book_id}/chunk-${ch.chunk_idx}`,
          title: `${ch.book_title || ''} — ${ch.chunk_title || ''}`.trim() || 'Library chunk',
          excerpt: (ch.snippet || '').slice(0, 400),
          stars: ch.score || 0,
          sourceType: 'library',
          book_author: ch.book_author || '',
          book_id: ch.book_id,
          chunk_idx: ch.chunk_idx,
          chunk_type: ch.chunk_type || null,
          vec_origins: [...ch.vec_origins],
          // Anti-Slop bridge — source fidelity carried for prompt-level tagging.
          fidelity_score: fid.fidelity_score,
          fidelity_tier: fid.fidelity_tier,
          parsed_level: fid.parsed_level,
        });
      }
    }

    // Stash per-book rollup in module-level cache keyed by topic — skeleton
    // stage reads via getLibraryRollupForTopic() to inject 📚 TOC cards into
    // SYSTEM_PROMPT. Cache survives the array spread/concat in harvest() merge.
    const rollup = topBooks.map(b => ({
      book_id: b.book_id,
      book_title: b.book_title,
      book_author: b.book_author,
      direct_hits: b.direct_hits,
      prereq_hits: b.prereq_hits,
      related_hits: b.related_hits,
      total_score: b.total_score,
      toc: b.toc,
    }));
    _setLibraryRollup(topic, rollup);
    return flatItems;
  } catch (_) { return []; }
}

// Community Commons — curated GitHub-hosted YAML/JSON packs.
// R-LIB Day 3 (2026-05-12): always-on harvest channel mirroring _harvestLibrary
// pattern. Packs ship bundled in app/lib/commons-packs/<id>/pack.json + user-
// installed copies override at ~/.hypha/commons/packs/. Match by topic +
// alias. Each pack contributes:
//   - recommended_sources[] → flat harvest items (sourceType='community')
//   - syllabus_skeleton[]   → cached for skeleton-stage prompt injection
//   - contested_questions[] → cached for CHALLENGE pipeline objector seed
//
// Returns flatItems compatible with the BM25/merge path. Side-channel hint
// stashed via _setCommunityHint(topic, ...) — skeleton stage reads through
// getCommunityHintForTopic(topic).
async function _harvestCommunity(topic, settings) {
  try {
    const communityLib = require('./lib/community');
    const lang = (settings && settings.lang) || 'zh';
    const matches = communityLib.queryPacks(String(topic || ''), { lang });
    if (!matches || matches.length === 0) {
      _setCommunityHint(topic, null);
      return [];
    }

    // Use top 2 matching packs (cap to keep token budget bounded)
    const usePacks = matches.slice(0, 2);
    const flatItems = [];
    const syllabusMerged = [];
    const contestedMerged = [];
    const packsMeta = [];

    for (const pack of usePacks) {
      const stale = communityLib.isPackStale(pack);
      packsMeta.push({
        id: pack.id,
        topic: pack.topic,
        lang: pack.lang,
        curator: pack.curator,
        ratified_count: Array.isArray(pack.ratified_by) ? pack.ratified_by.length : 0,
        ratified_at: pack.ratified_at || null,
        stale,
      });

      // Skeleton hint — chapters + KP candidates verbatim from the pack
      if (Array.isArray(pack.syllabus_skeleton)) {
        for (const chap of pack.syllabus_skeleton) {
          syllabusMerged.push({
            pack_id: pack.id,
            chapter: chap.chapter,
            kp_candidates: Array.isArray(chap.kp_candidates) ? chap.kp_candidates : [],
          });
        }
      }
      // Contested questions for CHALLENGE pipeline seeding
      if (Array.isArray(pack.contested_questions)) {
        for (const q of pack.contested_questions) {
          contestedMerged.push({ pack_id: pack.id, question: q });
        }
      }
      // Recommended sources as harvest items
      const sources = Array.isArray(pack.recommended_sources) ? pack.recommended_sources : [];
      sources.forEach((src, idx) => {
        const isBook = (src.type || '').toLowerCase() === 'book';
        const url = isBook
          ? `community://${pack.id}/book-${idx}`
          : (src.url || `community://${pack.id}/web-${idx}`);
        flatItems.push({
          url,
          title: src.title || src.url || `Community recommendation ${idx + 1}`,
          excerpt: src.reason || '',
          stars: Math.max(1, packsMeta[packsMeta.length - 1].ratified_count),
          sourceType: 'community',
          pack_id: pack.id,
          pack_curator: pack.curator || 'unknown',
          community_source_type: src.type || 'unknown',
        });
      });
    }

    _setCommunityHint(topic, {
      packs_used: packsMeta,
      syllabus_skeleton: syllabusMerged,
      contested_questions: contestedMerged,
    });
    return flatItems;
  } catch (_) { return []; }
}

// Tavily WebSearch — additive 4th channel. Silent no-op when key absent so the
// existing 3-channel flow degrades cleanly. Free tier: 1k req/mo.
async function _harvestWebSearch(topic, settings) {
  const tavilyKey = (settings && settings.tavilyKey) || process.env.TAVILY_API_KEY || '';
  if (!tavilyKey) return [];
  // 2026-05-17 — difficulty-scaled max_results. Default 10, capped at 20.
  const _scale = Number(settings && settings._difficultyScale) || 1;
  const _maxResults = Math.min(20, Math.max(5, Math.floor(10 * _scale)));
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyKey,
        query: String(topic),
        search_depth: 'basic',
        max_results: _maxResults,
        include_answer: false,
        include_raw_content: false,
      }),
    });
    if (!res.ok) return [];
    const json = await res.json();
    const results = Array.isArray(json.results) ? json.results : [];
    return results
      .map(r => ({
        url: r.url || '',
        title: String(r.title || '').slice(0, 200),
        excerpt: String(r.content || '').slice(0, 400),
        sourceType: 'web',
        stars: 0,
      }))
      .filter(s => s.url && s.title && passesSourcePolicy(s.url));
  } catch (_) {
    return [];
  }
}

// _harvestCitations — v0.6.0 5th channel. Given top arxiv IDs from the upfront
// harvest, pull each paper's references (papers it cites) and citations
// (papers that cite it) via Semantic Scholar's free Graph API. This is the
// "citation graph traversal" Lung flagged as the highest-leverage missing
// primitive — the system can now reach the paper that the harvested paper
// itself names as the actual frontier.
//
// Semantic Scholar free tier: ~100 req/sec unauthenticated, no API key
// needed. We pause 100ms between calls to stay courteous. Capped at top-3
// arxiv seeds × 2 endpoints each = max 6 HTTP calls per harvest.
//
// Additive: silent no-op on network error / 404 / empty paper. Never throws.
async function _harvestCitations(arxivIds, maxRefs = 5, maxCitedBy = 3) {
  const out = [];
  if (!Array.isArray(arxivIds) || arxivIds.length === 0) return out;
  const fetchFn = (typeof fetch !== 'undefined' && fetch) ? fetch : require('node-fetch');
  for (const id of arxivIds.slice(0, 3)) {
    if (!id) continue;
    try {
      const headers = { 'User-Agent': 'Hypha-frontier-harvest/0.6' };
      // References (papers this paper cites — what the seed paper anchors to)
      const refsUrl = `https://api.semanticscholar.org/graph/v1/paper/ARXIV:${encodeURIComponent(id)}/references?fields=title,abstract,year,externalIds&limit=${maxRefs}`;
      const refsRes = await fetchFn(refsUrl, { headers });
      if (refsRes && refsRes.ok) {
        const data = await refsRes.json();
        for (const r of (data.data || []).slice(0, maxRefs)) {
          if (!r || !r.citedPaper) continue;
          const arxivId = r.citedPaper.externalIds && r.citedPaper.externalIds.ArXiv;
          out.push({
            url: arxivId ? `https://arxiv.org/abs/${arxivId}` : '',
            title: String(r.citedPaper.title || '').slice(0, 200),
            excerpt: String(r.citedPaper.abstract || '').slice(0, 400),
            sourceType: 'cited-ref',
            stars: 0,
            year: r.citedPaper.year || null,
            parentArxivId: id,
          });
        }
      }
      await new Promise(r => setTimeout(r, 100));
      // Citations (papers that cite this paper — frontier extending forward)
      const citesUrl = `https://api.semanticscholar.org/graph/v1/paper/ARXIV:${encodeURIComponent(id)}/citations?fields=title,abstract,year,externalIds&limit=${maxCitedBy}`;
      const citesRes = await fetchFn(citesUrl, { headers });
      if (citesRes && citesRes.ok) {
        const data = await citesRes.json();
        for (const r of (data.data || []).slice(0, maxCitedBy)) {
          if (!r || !r.citingPaper) continue;
          const arxivId = r.citingPaper.externalIds && r.citingPaper.externalIds.ArXiv;
          out.push({
            url: arxivId ? `https://arxiv.org/abs/${arxivId}` : '',
            title: String(r.citingPaper.title || '').slice(0, 200),
            excerpt: String(r.citingPaper.abstract || '').slice(0, 400),
            sourceType: 'cited-by',
            stars: 0,
            year: r.citingPaper.year || null,
            parentArxivId: id,
          });
        }
      }
      await new Promise(r => setTimeout(r, 100));
    } catch (_) { /* additive; never throw */ }
  }
  return out.filter(s => s.url && s.title);
}

// ── v0.7.0 — 4 new harvest channels ─────────────────────────────────────────
// All fail-soft: lib import inside try/catch so a missing dep doesn't break
// the harvest contract. Each returns array of {url, title, excerpt, ...}.

// Channel 7 — Wikipedia full text (intro paragraph). No key. Language-aware.
async function _harvestWikipedia(topic) {
  const q = String(topic).trim();
  if (!q) return [];
  const lang = /[一-龥]/.test(q) ? 'zh' : 'en';
  const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  try {
    // Step 1: opensearch → top 8 article titles + URLs
    const searchRes = await fetchFn(
      `https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=8&namespace=0&format=json`,
      { headers: { 'User-Agent': 'Hypha/0.7' } }
    );
    if (!searchRes.ok) return [];
    const sd = await searchRes.json();
    const titles = sd[1] || [];
    const urls = sd[3] || [];
    if (titles.length === 0) return [];
    // Step 2: extract intros for all titles in one query
    const titlesParam = titles.map(encodeURIComponent).join('|');
    const extractRes = await fetchFn(
      `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=true&explaintext=true&titles=${titlesParam}&format=json&redirects=1`,
      { headers: { 'User-Agent': 'Hypha/0.7' } }
    );
    if (!extractRes.ok) return [];
    const ed = await extractRes.json();
    const pages = (ed.query && ed.query.pages) ? Object.values(ed.query.pages) : [];
    const titleToExtract = {};
    for (const p of pages) {
      if (p && p.title) titleToExtract[p.title] = String(p.extract || '');
    }
    const out = [];
    for (let i = 0; i < titles.length; i++) {
      const t = titles[i];
      const u = urls[i] || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(t)}`;
      const intro = titleToExtract[t] || '';
      if (!intro || intro.length < 50) continue;  // skip stubs
      if (!passesSourcePolicy(u)) continue;
      out.push({
        url: u, title: t,
        excerpt: intro.slice(0, 600),
        sourceType: 'wikipedia', stars: 0, lang,
      });
    }
    return out;
  } catch (_) { return []; }
}

// Channel 8 — OpenAlex (250M scholarly works incl. humanities). No key.
async function _harvestOpenAlex(topic) {
  const q = String(topic).trim();
  if (!q) return [];
  const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  try {
    const res = await fetchFn(
      `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=8&mailto=hypha@machinohataki.dev`,
      { headers: { 'User-Agent': 'Hypha/0.7' } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const out = [];
    for (const w of (data.results || [])) {
      if (!w || !w.title) continue;
      // OpenAlex stores abstract as inverted_index — reconstruct.
      let abstract = '';
      if (w.abstract_inverted_index && typeof w.abstract_inverted_index === 'object') {
        const positions = [];
        for (const [word, idxs] of Object.entries(w.abstract_inverted_index)) {
          for (const i of idxs) positions[i] = word;
        }
        abstract = positions.filter(Boolean).join(' ');
      }
      if (!abstract || abstract.length < 50) continue;  // skip works without abstracts
      const url = (w.doi && w.doi.startsWith('http')) ? w.doi
        : (w.doi ? `https://doi.org/${String(w.doi).replace(/^https?:\/\/doi\.org\//, '')}`
        : (w.id || ''));
      if (!url) continue;
      if (!passesSourcePolicy(url)) continue;
      out.push({
        url,
        title: String(w.title || '').slice(0, 200),
        excerpt: abstract.slice(0, 600),
        sourceType: 'openalex',
        stars: Number(w.cited_by_count) || 0,
        year: Number(w.publication_year) || null,
      });
    }
    return out;
  } catch (_) { return []; }
}

// Channel 6 — YouTube transcript. Lib-dependent (youtube-search-api +
// youtube-transcript). Skip-on-fail per video. ~3-6s for 8 videos.
// v0.4 — curated creators registry. Lazy-loaded once. Maps lowercased
// channel name AND handle to creator entry for quick `channelName` match.
let _curatedCreatorsMap = null;
function _loadCuratedCreators() {
  if (_curatedCreatorsMap) return _curatedCreatorsMap;
  _curatedCreatorsMap = new Map();
  try {
    const cfg = require('./lib/curated-creators.json');
    for (const c of (cfg.creators || [])) {
      const keys = new Set();
      if (c.name) keys.add(String(c.name).toLowerCase());
      if (c.handle) keys.add(String(c.handle).toLowerCase());
      // Strip "(NAME)" parenthetical so "3Blue1Brown (Grant Sanderson)" also matches "3blue1brown" alone
      const stripped = String(c.name || '').toLowerCase().replace(/\s*\([^)]+\)\s*/g, '').trim();
      if (stripped) keys.add(stripped);
      for (const k of keys) _curatedCreatorsMap.set(k, c);
    }
  } catch (_) { /* file missing → empty map, _harvestYouTube falls back to generic */ }
  return _curatedCreatorsMap;
}

async function _harvestYouTube(topic) {
  const q = String(topic).trim();
  if (!q) return [];
  let YTSearch, YTTranscript;
  try { YTSearch = require('youtube-search-api'); } catch (_) { return []; }
  try { YTTranscript = require('youtube-transcript'); } catch (_) { /* transcript optional */ }
  let videos;
  try {
    const r = await Promise.race([
      YTSearch.GetListByKeyword(q, false, 8, [{ type: 'video' }]),
      new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 6000)),
    ]);
    videos = (r && r.items) ? r.items : [];
  } catch (_) { return []; }
  const out = [];
  await Promise.allSettled(videos.slice(0, 8).map(async v => {
    if (!v || !v.id) return;
    const url = `https://www.youtube.com/watch?v=${v.id}`;
    let transcript = '';
    if (YTTranscript && YTTranscript.YoutubeTranscript) {
      try {
        const segs = await Promise.race([
          YTTranscript.YoutubeTranscript.fetchTranscript(v.id),
          new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 2500)),
        ]);
        transcript = (segs || []).map(s => s.text || '').join(' ');
      } catch (_) {}
    }
    if (!passesSourcePolicy(url)) return;
    out.push({
      url, title: String(v.title || '').slice(0, 200),
      excerpt: transcript ? transcript.slice(0, 600) : (v.description || '').slice(0, 400),
      sourceType: 'youtube',
      stars: Number((v.viewCount && v.viewCount.text || '').replace(/[^\d]/g, '')) || 0,
      durationSec: (v.length && v.length.simpleText) || null,
      channelName: (v.channelTitle) || null,
      hasTranscript: !!transcript,
    });
  }));
  // v0.4 — curated-creator boost. Tag results whose channelName matches a
  // curated creator (3Blue1Brown, Karpathy, Veritasium, ...) with sourceType
  // 'youtube-curated' and 1.5x stars boost so downstream BM25 ranks them up.
  const curatedMap = _loadCuratedCreators();
  if (curatedMap.size > 0) {
    for (const item of out) {
      if (!item.channelName) continue;
      const cname = String(item.channelName).toLowerCase();
      for (const [key, creator] of curatedMap.entries()) {
        if (cname === key || cname.includes(key) || key.includes(cname)) {
          item.sourceType = 'youtube-curated';
          item.curatedCreatorId = creator.channelId;
          item.curatedTeachingValue = creator.teaching_value;
          item.stars = Math.round((item.stars || 0) * 1.5) + 1;
          break;
        }
      }
    }
    // v0.4 — force-include top result from a curated creator whose
    // specialization_keywords match the topic, IF none of the existing
    // results already covers them. Closes the gap where generic YouTube
    // search misses the canonical channel for this topic.
    const qLower = q.toLowerCase();
    let forced = null;
    try {
      const cfg = require('./lib/curated-creators.json');
      for (const c of (cfg.creators || [])) {
        for (const kw of (c.specialization_keywords || [])) {
          if (qLower.includes(String(kw).toLowerCase())) { forced = c; break; }
        }
        if (forced) break;
      }
    } catch (_) {}
    if (forced && !out.some(o => o.curatedCreatorId === forced.channelId)) {
      try {
        const r2 = await Promise.race([
          YTSearch.GetListByKeyword(`${q} ${forced.name}`, false, 4, [{ type: 'video' }]),
          new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 4000)),
        ]);
        const v2 = (r2 && r2.items) ? r2.items[0] : null;
        if (v2 && v2.id && passesSourcePolicy(`https://www.youtube.com/watch?v=${v2.id}`)) {
          out.unshift({
            url: `https://www.youtube.com/watch?v=${v2.id}`,
            title: String(v2.title || '').slice(0, 200),
            excerpt: (v2.description || '').slice(0, 400),
            sourceType: 'youtube-curated',
            stars: 100,
            channelName: v2.channelTitle || forced.name,
            curatedCreatorId: forced.channelId,
            curatedTeachingValue: forced.teaching_value,
            forcedInclusion: true,
          });
        }
      } catch (_) {}
    }
  }
  return out;
}

// Channel — Pinned Domains (L4 of v0.4 5-layer Course Source Stack). Tavily
// multi-domain search over the curated lab-blog + framework-docs domains
// declared in app/lib/pinned-sources.json. Archetype-routed: each domain
// declares which archetypes it serves (e.g. openai.com ∈ TECH-CONCEPT, MINDSET;
// vercel.com ∈ TECH-PROC). Returns sourceType 'lab_blog' or 'framework_docs'
// per the matching pinned entry.
async function _harvestPinnedDomains(topic, archetype, settings) {
  const tavilyKey = (settings && settings.tavilyKey) || process.env.TAVILY_API_KEY || '';
  if (!tavilyKey) return [];
  const q = String(topic).trim();
  if (!q) return [];
  let cfg;
  try { cfg = require('./lib/pinned-sources.json'); } catch (_) { return []; }
  const arch = archetype || '_default';
  const domains = (cfg.domains || [])
    .filter(d => Array.isArray(d.archetype_routing) && d.archetype_routing.includes(arch))
    .slice(0, 8);
  if (domains.length === 0) return [];
  const includeDomains = domains.map(d => d.domain);
  const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  try {
    const r = await fetchFn('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyKey, query: q, search_depth: 'basic', max_results: 6,
        include_domains: includeDomains,
      }),
    });
    if (!r.ok) return [];
    const j = await r.json();
    const out = [];
    for (const item of (j.results || []).slice(0, 6)) {
      const url = item.url || '';
      if (!url) continue;
      const matched = domains.find(d => url.includes(d.domain));
      out.push({
        url,
        title: String(item.title || '').slice(0, 200),
        excerpt: String(item.content || '').replace(/\s+/g, ' ').slice(0, 600),
        sourceType: matched ? matched.source_type : 'lab_blog',
        pinnedDomain: matched ? matched.domain : '',
        pinnedAuthority: matched ? matched.authority : 0,
        stars: 0,
      });
    }
    return out;
  } catch (_) { return []; }
}

// Channel 9 — Stanford Encyclopedia of Philosophy (gated to HUMANITIES).
// Discovery via Tavily-filtered domain search; HTML scrape with cheerio.
async function _harvestSEP(topic, settings) {
  const tavilyKey = (settings && settings.tavilyKey) || process.env.TAVILY_API_KEY || '';
  if (!tavilyKey) return [];  // no reliable discovery without Tavily
  const q = String(topic).trim();
  if (!q) return [];
  let cheerio;
  try { cheerio = require('cheerio'); } catch (_) { return []; }
  const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  // Step 1: Tavily search restricted to plato.stanford.edu
  let entryUrls = [];
  try {
    const tRes = await fetchFn('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyKey, query: q, search_depth: 'basic', max_results: 5,
        include_domains: ['plato.stanford.edu'],
      }),
    });
    if (!tRes.ok) return [];
    const tj = await tRes.json();
    entryUrls = (tj.results || []).map(r => r.url).filter(u => u && /plato\.stanford\.edu\/entries\//.test(u));
  } catch (_) { return []; }
  if (entryUrls.length === 0) return [];
  // Step 2: fetch + extract intro per entry
  const out = [];
  await Promise.allSettled(entryUrls.slice(0, 4).map(async url => {
    try {
      const r = await Promise.race([
        fetchFn(url, { headers: { 'User-Agent': 'Hypha/0.7' } }),
        new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 4000)),
      ]);
      if (!r.ok) return;
      const html = await r.text();
      const $ = cheerio.load(html);
      const title = $('h1').first().text().trim() || $('title').text().trim();
      // SEP entry intro: first <p> after the table of contents OR inside #preamble.
      let intro = $('#preamble p').first().text().trim();
      if (!intro || intro.length < 50) intro = $('#main-text p').first().text().trim();
      if (!intro || intro.length < 50) intro = $('p').slice(0, 3).map((_, el) => $(el).text().trim()).get().join(' ');
      intro = intro.replace(/\s+/g, ' ').slice(0, 600);
      if (!intro || !title) return;
      out.push({ url, title: String(title).slice(0, 200), excerpt: intro, sourceType: 'sep', stars: 0 });
    } catch (_) {}
  }));
  return out;
}

// Channel — Canonical Curriculum (L1 of v0.4 5-layer Course Source Stack).
// Hits top US-university open courseware: MIT OCW, Stanford (online + class
// pages), Berkeley CS/EECS, CMU CS, Harvard CS50/HarvardX, OpenStax. Returns
// syllabus-shaped results that designSequence treats as STRUCTURE PRIOR (peer-
// institution sequencing) and designLesson treats as L1 grounding ("MIT 18.06
// uses this example"). No HTML scrape — Tavily index covers .edu paths well.
async function _harvestCourseware(topic, settings) {
  const tavilyKey = (settings && settings.tavilyKey) || process.env.TAVILY_API_KEY || '';
  if (!tavilyKey) return [];
  const q = String(topic).trim();
  if (!q) return [];
  const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  const COURSEWARE_DOMAINS = [
    'ocw.mit.edu',
    'online.stanford.edu',
    'web.stanford.edu',
    'cs.berkeley.edu',
    'eecs.berkeley.edu',
    'cs.cmu.edu',
    'cs50.harvard.edu',
    'harvardx.harvard.edu',
    'openstax.org',
  ];
  let results = [];
  try {
    const tRes = await fetchFn('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyKey,
        query: `${q} syllabus OR course OR "lecture notes" OR "reading list"`,
        search_depth: 'basic', max_results: 8,
        include_domains: COURSEWARE_DOMAINS,
      }),
    });
    if (!tRes.ok) return [];
    const tj = await tRes.json();
    results = tj.results || [];
  } catch (_) { return []; }
  const _institutionFor = (url) => {
    if (/ocw\.mit\.edu/i.test(url)) return 'MIT';
    if (/stanford\.edu/i.test(url)) return 'Stanford';
    if (/berkeley\.edu/i.test(url)) return 'UC Berkeley';
    if (/cs\.cmu\.edu/i.test(url)) return 'Carnegie Mellon';
    if (/cs50\.harvard\.edu|harvardx\.harvard\.edu/i.test(url)) return 'Harvard';
    if (/openstax\.org/i.test(url)) return 'OpenStax';
    return 'university';
  };
  const _syllabusTypeFor = (url, title) => {
    const blob = (url + ' ' + (title || '')).toLowerCase();
    if (/syllabus|schedule/.test(blob)) return 'syllabus';
    if (/lecture[-_ ]?note|\/notes\/|readings/.test(blob)) return 'lecture-notes';
    if (/reading[-_ ]?list|textbook/.test(blob)) return 'reading-list';
    if (/assignment|homework|problem[-_ ]?set|\bpset/.test(blob)) return 'assignment';
    if (/exam|midterm|\bfinal\b/.test(blob)) return 'exam';
    return 'syllabus';
  };
  const _courseCodeFor = (url) => {
    const m = url.match(/(?:\/|=|-)((?:CS|EE|EECS|CSE|MATH|STAT|18|6|15)[-._ ]?\d{2,4}[A-Z]?)\b/i);
    return m ? m[1].replace(/[-._ ]/g, '').toUpperCase() : '';
  };
  const out = [];
  for (const r of (results || []).slice(0, 6)) {
    const url = r.url || '';
    const title = String(r.title || '').slice(0, 200);
    const excerpt = String(r.content || '').replace(/\s+/g, ' ').slice(0, 600);
    if (!url || !title) continue;
    out.push({
      url, title, excerpt,
      sourceType: 'courseware',
      institution: _institutionFor(url),
      courseCode: _courseCodeFor(url),
      syllabusType: _syllabusTypeFor(url, title),
      stars: 0,
    });
  }
  return out;
}

// Channel — OpenReview (L3 of v0.4 5-layer). ICLR / NeurIPS / ICML / COLM /
// COLT submissions + reviews. API v2 search at api2.openreview.net. Returns
// peer-reviewed frontier papers with venue tag (! arxiv preprint, ! benchmark).
// Auth-free for public-readable notes; 5s timeout, graceful drop on failure.
async function _harvestOpenReview(topic, _settings) {
  const q = String(topic).trim();
  if (!q) return [];
  const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  try {
    const url = `https://api2.openreview.net/notes/search?term=${encodeURIComponent(q)}&type=note&content=all&limit=10`;
    const r = await Promise.race([
      fetchFn(url, { headers: { 'User-Agent': 'Hypha/0.4' } }),
      new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 5000)),
    ]);
    if (!r.ok) return [];
    const j = await r.json();
    const notes = Array.isArray(j.notes) ? j.notes : [];
    const out = [];
    for (const n of notes.slice(0, 8)) {
      const c = (n && n.content) || {};
      const title = (c.title && c.title.value) || c.title || '';
      const abstract = (c.abstract && c.abstract.value) || c.abstract || '';
      const venue = (c.venue && c.venue.value) || c.venue || '';
      const forum = n.forum || n.id || '';
      if (!title || !forum) continue;
      out.push({
        url: `https://openreview.net/forum?id=${forum}`,
        title: String(title).slice(0, 200),
        excerpt: String(abstract).replace(/\s+/g, ' ').slice(0, 600),
        sourceType: 'openreview',
        venue: String(venue).slice(0, 80),
        stars: 0,
      });
    }
    return out;
  } catch (_) { return []; }
}

// Channel — Papers with Code (L3). Paper + code repo + benchmark/dataset
// linkage. paperswithcode.com/api/v1/papers public endpoint, no auth needed.
// Tag engineering_value high in metadata schema (Day 5).
async function _harvestPapersWithCode(topic, _settings) {
  const q = String(topic).trim();
  if (!q) return [];
  const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  try {
    const url = `https://paperswithcode.com/api/v1/papers/?q=${encodeURIComponent(q)}&page=1&items_per_page=8`;
    const r = await Promise.race([
      fetchFn(url, { headers: { 'User-Agent': 'Hypha/0.4', 'Accept': 'application/json' } }),
      new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 5000)),
    ]);
    if (!r.ok) return [];
    const j = await r.json();
    const results = Array.isArray(j.results) ? j.results : [];
    const out = [];
    for (const p of results.slice(0, 6)) {
      const id = p.id || '';
      const title = String(p.title || '').slice(0, 200);
      const abstract = String(p.abstract || '').replace(/\s+/g, ' ').slice(0, 600);
      const url = p.url_pdf || p.url_abs || (id ? `https://paperswithcode.com/paper/${id}` : '');
      if (!title || !url) continue;
      out.push({
        url, title, excerpt: abstract,
        sourceType: 'pwc',
        published: String(p.published || '').slice(0, 30),
        stars: 0,
      });
    }
    return out;
  } catch (_) { return []; }
}

// Channel — Hugging Face Papers (L3). Daily-trending AI papers community pool.
// Uses Tavily domain-filter on huggingface.co/papers/* (paths with "papers/"
// segment). Tag freshness high; stability low (HF trending churns daily).
async function _harvestHFPapers(topic, settings) {
  const tavilyKey = (settings && settings.tavilyKey) || process.env.TAVILY_API_KEY || '';
  if (!tavilyKey) return [];
  const q = String(topic).trim();
  if (!q) return [];
  const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  try {
    const r = await fetchFn('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyKey, query: q, search_depth: 'basic', max_results: 8,
        include_domains: ['huggingface.co'],
      }),
    });
    if (!r.ok) return [];
    const j = await r.json();
    const results = (j.results || []).filter(x => x && x.url && /huggingface\.co\/papers\//.test(x.url));
    return results.slice(0, 5).map(x => ({
      url: x.url,
      title: String(x.title || '').slice(0, 200),
      excerpt: String(x.content || '').replace(/\s+/g, ' ').slice(0, 600),
      sourceType: 'hf-papers',
      stars: 0,
    }));
  } catch (_) { return []; }
}

// Channel 10 — YC Library (gated to MINDSET / startup keywords). Discovery
// via Tavily filtered to YC-canon domains, fallback to ycombinator.com search.
async function _harvestYCLibrary(topic, settings) {
  const tavilyKey = (settings && settings.tavilyKey) || process.env.TAVILY_API_KEY || '';
  const q = String(topic).trim();
  if (!q) return [];
  if (tavilyKey) {
    const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
    try {
      const r = await fetchFn('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyKey, query: q, search_depth: 'basic', max_results: 8,
          include_domains: ['ycombinator.com', 'paulgraham.com', 'samaltman.com', 'startupschool.org'],
        }),
      });
      if (!r.ok) return [];
      const j = await r.json();
      return (j.results || []).map(x => ({
        url: x.url || '',
        title: String(x.title || '').slice(0, 200),
        excerpt: String(x.content || '').slice(0, 600),
        sourceType: 'yc', stars: 0,
      })).filter(s => s.url && s.title && passesSourcePolicy(s.url));
    } catch (_) { return []; }
  }
  return [];  // fallback HTML scrape deferred — Tavily covers most cases
}

// Hacker News deepen (v0.7.0). Existing _harvestHN got titles + algolia
// snippets; this enrichment fetches top-3 high-points hits' comment threads
// and appends top-3 expert comments to excerpt.
async function _enrichHNComments(items) {
  const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
  const top3 = (items || [])
    .filter(it => it && it.stars && it.stars >= 100)
    .sort((a, b) => b.stars - a.stars)
    .slice(0, 3);
  await Promise.allSettled(top3.map(async it => {
    const m = it.url && it.url.match(/news\.ycombinator\.com\/item\?id=(\d+)/);
    const objectId = m ? m[1] : null;
    if (!objectId) return;
    try {
      const r = await fetchFn(`https://hn.algolia.com/api/v1/items/${objectId}`, {
        headers: { 'User-Agent': 'Hypha/0.7' },
      });
      if (!r.ok) return;
      const data = await r.json();
      // Walk the comment tree, collect comments with points >= 10
      const comments = [];
      const walk = (node) => {
        if (!node) return;
        if (node.text && (node.points || 0) >= 10) {
          comments.push({ points: node.points, text: String(node.text).replace(/<[^>]+>/g, '').slice(0, 200) });
        }
        if (node.children) for (const c of node.children) walk(c);
      };
      walk(data);
      comments.sort((a, b) => b.points - a.points);
      const top = comments.slice(0, 3);
      if (top.length === 0) return;
      const append = top.map(c => `TOP HN COMMENT (${c.points}pt): ${c.text}`).join(' | ');
      it.excerpt = (it.excerpt || '') + ' | ' + append;
    } catch (_) {}
  }));
  return items;
}

// _harvestPerLesson — v0.6.0 lightweight per-lesson re-harvest. Called from
// main.js's lessons:adapt-after-finish IPC just BEFORE proposeNextLesson, so
// the upcoming lesson sees frontier-fresh sources rather than lesson-1's
// frozen broad-search residue. Skips GitHub/HN/arxiv (covered upfront);
// only Tavily web-search + citation-graph traversal of existing arxiv hits.
//
// Returns ≤ ~15 raw sources; main.js dedupes against existing sources.json
// by URL before appending.
async function _harvestPerLesson(existingSources, lessonTopic, settings) {
  const arxivIds = (existingSources || [])
    .map(s => {
      const m = s && s.url && s.url.match(/arxiv\.org\/abs\/([\d.v]+)/);
      return m ? m[1] : null;
    })
    .filter(Boolean)
    .slice(0, 2);
  const tasks = [];
  if ((settings && settings.tavilyKey) || process.env.TAVILY_API_KEY) {
    tasks.push(_harvestWebSearch(lessonTopic, settings));
  }
  if (arxivIds.length) {
    tasks.push(_harvestCitations(arxivIds, 3, 2));
  }
  if (tasks.length === 0) return [];
  const results = await Promise.allSettled(tasks);
  const out = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) out.push(...r.value);
  }
  return out;
}

// v0.7.0 — archetype-aware channel routing. Each topic class gets the right
// 4-7 channels in parallel; channels that wouldn't help are skipped (saves
// latency + avoids polluting sources with noise — e.g., SEP firing for
// "React Hooks" wastes 4s + injects irrelevant philosophy entries).
const CHANNEL_ROUTES = {
  // v0.4 — courseware (L1 Canonical Curriculum) joins TECH/DECL/LANG routes.
  // HUMANITIES already has SEP for academic philosophy; courseware would
  // duplicate (Stanford SEP, MIT/Harvard humanities OCW are in same league).
  // MINDSET stays YC-anchored (lab_blog joins via pinned-domains in v0.4 step 4).
  'TECH-CONCEPT': ['github', 'arxiv', 'web', 'hn', 'youtube', 'openalex', 'courseware', 'openreview', 'pwc', 'hf-papers', 'pinned-domains'],
  'TECH-PROC':    ['github', 'hn', 'web', 'youtube', 'courseware', 'pwc', 'pinned-domains'],
  'HUMANITIES':   ['wikipedia', 'openalex', 'sep', 'web', 'hn'],
  'MINDSET':      ['yclibrary', 'web', 'wikipedia', 'youtube', 'hn', 'pinned-domains'],
  'LANG-ACQ':     ['wikipedia', 'youtube', 'web', 'courseware'],
  'DECL-MASS':    ['wikipedia', 'openalex', 'web', 'hn', 'courseware'],
  '_default':     ['github', 'hn', 'arxiv', 'web'],
};

async function harvest(topic, settings, onProgress = null, archetype = '_default', difficulty = 0.6) {
  const t0 = Date.now();
  const route = CHANNEL_ROUTES[archetype] || CHANNEL_ROUTES._default;
  // 2026-05-17 — difficulty scaling for Tavily-using channels. base + floor(base*d*2).
  // 0.95 → 2.9x, 0.65 → 2.3x, 0.35 → 1.7x, 0.05 → 1.1x. Applied via settings._scaleHint
  // so individual _harvestXxx fns pick it up without refactoring all signatures.
  const _scaledSettings = Object.assign({}, settings || {}, {
    _difficultyScale: 1 + Math.max(0, Math.min(1, Number(difficulty) || 0.6)) * 2,
  });
  settings = _scaledSettings;
  // Initialize perChannel only for the channels that will fire (saves bytes
  // on telemetry + signals to renderer which channels were active).
  const perChannel = {};
  for (const key of route) {
    perChannel[key] = { n: 0, ms: 0, err: null, items: [] };
  }
  // citation + fallback always present (citation conditional on arxiv hits,
  // fallback always added). Initialize for telemetry consistency.
  if (!perChannel.citation) perChannel.citation = { n: 0, ms: 0, err: null, items: [] };
  perChannel.fallback = { n: 0, ms: 0, err: null, items: [] };

  // Channel dispatcher — maps key to its helper invocation.
  const CHANNEL_FNS = {
    github:    () => _harvestGithub(topic),
    hn:        () => _harvestHN(topic),
    arxiv:     () => _harvestArxiv(topic),
    web:       () => _harvestWebSearch(topic, settings),
    wikipedia: () => _harvestWikipedia(topic),
    openalex:  () => _harvestOpenAlex(topic),
    youtube:   () => _harvestYouTube(topic),
    sep:       () => _harvestSEP(topic, settings),
    yclibrary: () => _harvestYCLibrary(topic, settings),
    courseware: () => _harvestCourseware(topic, settings),
    openreview: () => _harvestOpenReview(topic, settings),
    pwc:        () => _harvestPapersWithCode(topic, settings),
    'hf-papers':      () => _harvestHFPapers(topic, settings),
    'pinned-domains': () => _harvestPinnedDomains(topic, archetype, settings),
  };
  const runChannel = async (key, fn) => {
    const start = Date.now();
    try {
      const items = await fn();
      perChannel[key].items = items;
      perChannel[key].n = items.length;
    } catch (e) {
      perChannel[key].err = (e && e.message) ? String(e.message) : String(e);
    } finally {
      perChannel[key].ms = Date.now() - start;
    }
  };

  // Fire all archetype-routed channels in parallel.
  await Promise.allSettled(route.map(key => {
    const fn = CHANNEL_FNS[key];
    if (!fn) return Promise.resolve();
    return runChannel(key, fn);
  }));

  // Always-on user Library channel — local, fast, no rate limit. Added 2026-05-12
  // per user request: "在生成课程的过程中会 fetch library 中相关内容". Library
  // items aggregate into liveItems below alongside route channels so downstream
  // BM25/rank treats them as first-class signal sources.
  perChannel.library = { n: 0, ms: 0, err: null, items: [] };
  await runChannel('library', () => _harvestLibrary(topic, settings));

  // Always-on Community Commons channel (R-LIB Day 3, 2026-05-12). Curated
  // GitHub-hosted packs match by topic + alias. Pack-recommended sources flow
  // into liveItems with sourceType='community'; syllabus_skeleton + contested
  // questions cached via _setCommunityHint for skeleton + CHALLENGE consumers.
  perChannel.community = { n: 0, ms: 0, err: null, items: [] };
  await runChannel('community', () => _harvestCommunity(topic, settings));

  // v0.7.0 — HN deepen: enrich HN items with top expert comments. Sequential
  // after parallel batch so the top hits' points are known.
  if (perChannel.hn && perChannel.hn.items && perChannel.hn.items.length > 0) {
    try { await _enrichHNComments(perChannel.hn.items); } catch (_) {}
  }

  // v0.6.0 — 5th channel: citation graph traversal seeded by top arxiv hits.
  // Sequential after the 4 parallel channels so we have arxiv IDs to seed.
  // Each seed paper contributes its references (what it cites) AND citations
  // (what cites it) — gives the system reach beyond keyword search into the
  // actual citation network around the seed papers. Free Semantic Scholar
  // Graph API; no key required. Errors are absorbed silently — never block
  // the harvest contract.
  const citationT0 = Date.now();
  try {
    // v0.7.0 — guard arxiv-channel access; archetype routing may have skipped it.
    const arxivItems = (perChannel.arxiv && perChannel.arxiv.items) || [];
    const arxivIds = arxivItems
      .map(s => {
        const m = s && s.url && s.url.match(/arxiv\.org\/abs\/([\d.v]+)/);
        return m ? m[1] : null;
      })
      .filter(Boolean);
    if (arxivIds.length) {
      perChannel.citation.items = await _harvestCitations(arxivIds, 5, 3);
      perChannel.citation.n = perChannel.citation.items.length;
    }
  } catch (e) {
    perChannel.citation.err = (e && e.message) ? String(e.message) : String(e);
  } finally {
    perChannel.citation.ms = Date.now() - citationT0;
  }

  // Curated frontier+university anchors (Eternal Law 8) — always added so the
  // downstream BM25/rank pass has at least these tier-1 endpoints to pull from.
  const fbStart = Date.now();
  perChannel.fallback.items = [
    { url: 'https://news.ycombinator.com', title: 'Hacker News (frontier forum)', excerpt: '', stars: 0, sourceType: 'forum-anchor' },
    { url: 'https://stanford.edu', title: 'Stanford courses', excerpt: 'university anchor', stars: 0, sourceType: 'uni-anchor' },
    { url: 'https://ocw.mit.edu', title: 'MIT OpenCourseWare', excerpt: 'university anchor', stars: 0, sourceType: 'uni-anchor' },
  ];
  perChannel.fallback.n = perChannel.fallback.items.length;
  perChannel.fallback.ms = Date.now() - fbStart;

  // v0.7.0 — dynamic liveItems from whichever channels actually fired.
  // perChannel keys are determined by archetype routing + always-on
  // citation/fallback. Fallback is excluded from "live" (it's the safety net).
  const liveItems = [];
  for (const key of Object.keys(perChannel)) {
    if (key === 'fallback') continue;
    const items = (perChannel[key] && perChannel[key].items) || [];
    liveItems.push(...items);
  }
  // totalUseful = topic-specific signal only (excludes fallback anchors).
  // Title + (url OR substantive excerpt) → counts as a real source.
  const totalUseful = liveItems.filter(s =>
    s && s.title && (s.url || (s.excerpt && s.excerpt.length > 50))
  ).length;
  const durationMs = Date.now() - t0;

  // Telemetry — events.jsonl. Wrapped in try so a vault hiccup never breaks
  // the harvest contract.
  try {
    const vault = require('./lib/vault');
    if (vault && typeof vault.appendJSONL === 'function') {
      // v0.7.0 — emit perChannel telemetry dynamically (variable keyset by archetype).
      const perChannelTelemetry = {};
      for (const key of Object.keys(perChannel)) {
        perChannelTelemetry[key] = {
          n: perChannel[key].n,
          ms: perChannel[key].ms,
          err: perChannel[key].err,
        };
      }
      vault.appendJSONL('events.jsonl', {
        ts: new Date().toISOString(),
        op: 'harvest_complete',
        topic: String(topic),
        archetype,
        route,
        perChannel: perChannelTelemetry,
        totalUseful,
        durationMs,
      });
      // v0.6.1 — thin-trigger now fires on EITHER aggregate-thin OR
      // all-channels-thin (no single channel produced ≥3 sources). Per-channel
      // counts attached to the event so downstream telemetry can diagnose
      // which trigger fired and which channels under-delivered.
      // v0.7.0 — thin-trigger over whichever live channels actually ran.
      const liveChannelKeys = Object.keys(perChannel).filter(k => k !== 'fallback');
      const channelMaxes = liveChannelKeys.map(c => (perChannel[c] && perChannel[c].n) || 0);
      const isAggregateThin = totalUseful < 5;
      const isAllChannelsThin = channelMaxes.length > 0 && channelMaxes.every(n => n < 3);
      if (isAggregateThin || isAllChannelsThin) {
        vault.appendJSONL('events.jsonl', {
          ts: new Date().toISOString(),
          op: 'harvest_thin',
          topic: String(topic),
          archetype,
          totalUseful,
          aggregateThin: isAggregateThin,
          allChannelsThin: isAllChannelsThin,
          channelCounts: Object.fromEntries(liveChannelKeys.map((c, i) => [c, channelMaxes[i]])),
        });
      }
    }
  } catch (_) {}

  // Optional progress callback — main.js can wire this through to webContents
  // so the renderer surfaces a thin-source banner inline.
  if (typeof onProgress === 'function') {
    try {
      // v0.7.0 — dynamic perChannel for the renderer banner.
      const perChannelOnProgress = {};
      for (const key of Object.keys(perChannel)) {
        perChannelOnProgress[key] = {
          n: perChannel[key].n,
          err: perChannel[key].err,
        };
      }
      onProgress('harvest_complete', {
        totalUseful,
        archetype,
        perChannel: perChannelOnProgress,
      });
    } catch (_) {}
  }

  // Final assembly — preserve original [live..., fallback...] order + 30 cap.
  const out = [...liveItems, ...perChannel.fallback.items];
  return out.slice(0, 30);
}

// ─────────────────────────────────────────────────────────────────────────
// v0.3 — harvestV3: 5-layer Heavy Harvest dispatcher
// ─────────────────────────────────────────────────────────────────────────
//
// Sits ALONGSIDE legacy `harvest()` — does NOT replace it. Dispatches to the
// Phase 1 Heavy-Harvest modules under app/lib/harvest/:
//   - layer1-canonical    — MIT OCW / Yale OYC / Stanford syllabus extraction
//                           → STRUCTURE ANCHOR (lectureSequence + prerequisiteChain)
//                           that designSkeletonOnly anchors to. The cure for
//                           the v0.2.1 哲学→Galileo failure (LLM training-
//                           frequency prior overrode pre-Socratic canonical
//                           ordering — Thales/Anaximander/Heraclitus skipped).
//   - layer3-deep-frontier — arXiv / OpenReview / Papers with Code / HF Papers
//                           / Semantic Scholar deep-fetch (abstract + intro
//                           excerpt + reviews + leaderboard deltas).
//   - layer4-community     — bb-browser daemon: Twitter / Reddit / ProductHunt
//                           (+ Xiaohongshu / AppStore RSS optional). 知乎 OUT.
//                           WebSearch fallback when daemon unavailable.
//
// Plus the legacy harvest() (v0.4 channels: Courseware / OpenReview / PwC /
// HFPapers / PinnedDomains / GitHub / HN / arXiv / WebSearch / Wikipedia /
// OpenAlex / YouTube / SEP / YCLibrary) is still called as a `legacy` channel
// — those entries land in `legacy[]` and unify into `sources[]`.
//
// Archetype-aware dispatch:
//   HUMANISTIC      → Layer 1 + Layer 3 (skip community — Twitter signal weak
//                     for philosophy/literature/history)
//   TECH-CONCEPT    → all 3 layers + legacy
//   TECH-PROC       → Layer 4 heavy + Layer 3 light + legacy
//   MATH-PHYSICS    → Layer 1 heavy + Layer 3 (arXiv) + legacy
//   GUIDE / PROCESS-MASTERY → Layer 4 + legacy
//   _default         → Layer 1 best-effort + Layer 3 + legacy
//
// Returns:
//   {
//     structureAnchor: { lectureSequence, prerequisiteChain, anchorCourses },
//     sources:         [...flat ranked unified list with sourceType + layer + best_use],
//     layer1:          {raw Layer 1 result},
//     layer3:          {raw Layer 3 result},
//     layer4:          {raw Layer 4 result},
//     legacy:          [...legacy harvest result],
//     warnings:        [...string]
//   }
//
// opts:
//   - onProgress(stage, payload?) — wires layer module progress through plus
//                                   own dispatcher events (layer1:start,
//                                   layer3:start, layer4:start, legacy:start,
//                                   layer1:done, ..., done).
//   - signal — AbortSignal chained into each layer call.
//   - layer1Options / layer3Options / layer4Options — opt overrides.
//
// Per-layer error isolation: one layer crashing doesn't kill the others.
// Phase 1 modules lazy-required to avoid circular boot risk.
async function harvestV3(topic, settings, prePrediction, archetype = '_default', opts = {}) {
  const t0 = Date.now();
  // v0.5.2 — frontier-cron flags: cronMode=true suppresses progress events for
  // silent background sweeps; tavilyFallback=true routes Layer 3 emptiness
  // through a Tavily search so the cron digest is rarely empty.
  const cronMode = !!opts.cronMode;
  const tavilyFallback = !!opts.tavilyFallback;
  const onProgress = (cronMode || typeof opts.onProgress !== 'function') ? null : opts.onProgress;
  const signal = opts.signal || null;
  const warnings = [];
  const safeProgress = (stage, payload) => {
    if (!onProgress) return;
    try { onProgress(stage, payload); } catch (_) { /* never let UI hooks throw */ }
  };

  // Archetype routing — which layers fire for this archetype.
  // Per project_hypha_5layer_scrape_spec selective-scraping mandate:
  // archetype-aware channel selection, not blind fire-all.
  const arch = String(archetype || '_default').toUpperCase();
  const route = (() => {
    if (arch === 'HUMANISTIC' || arch === 'HUMANITIES') {
      return { layer1: true, layer3: true, layer4: false, legacy: true };
    }
    if (arch === 'TECH-CONCEPT') {
      return { layer1: true, layer3: true, layer4: true, legacy: true };
    }
    if (arch === 'TECH-PROC') {
      return { layer1: false, layer3: true, layer4: true, legacy: true };
    }
    if (arch === 'MATH-PHYSICS' || arch === 'DECL-MASS') {
      return { layer1: true, layer3: true, layer4: false, legacy: true };
    }
    if (arch === 'GUIDE' || arch === 'PROCESS-MASTERY' || arch === 'MINDSET') {
      return { layer1: false, layer3: false, layer4: true, legacy: true };
    }
    return { layer1: true, layer3: true, layer4: false, legacy: true };
  })();

  const result = {
    structureAnchor: null,
    sources: [],
    layer1: null,
    layer3: null,
    layer4: null,
    legacy: [],
    warnings,
  };

  // 2026-05-17 阶 2 difficulty scaling — per-layer source budgets scale with
  // the user's goal difficulty (0-1, sourced from goal-guardian._estimate-
  // Difficulty or LLM classifyAll.diff.score). Formula per source:
  //   cap = base + floor(base × difficulty × 2)
  // → difficulty 0.05 nudges base by 10% (low-floor); difficulty 0.95 nearly
  // triples it. Each layer module has its own internal hard cap that still
  // applies (layer3 hard-clamps at 20, layer1 anchor list is finite). Caller
  // can override per-layer via opts.layer{1,3,4}Options.
  const _harvestDifficulty = (() => {
    const d = Number(opts.difficulty);
    if (Number.isFinite(d) && d >= 0 && d <= 1) return d;
    return 0.6;
  })();
  function _scaleBudget(base) {
    return base + Math.floor(base * _harvestDifficulty * 2);
  }
  safeProgress('harvest:difficulty', {
    difficulty: _harvestDifficulty,
    scale_examples: {
      layer1_maxAnchors: _scaleBudget(3),
      layer3_maxPapersPerSource: Math.min(20, _scaleBudget(5)),
      layer4_maxPostsPerPlatform: _scaleBudget(10),
    },
  });

  // ── Layer 1 — Canonical Curriculum syllabus extraction ─────────────────
  if (route.layer1) {
    safeProgress('layer1:start', { topic, archetype: arch });
    try {
      // Lazy require — avoid circular boot risk per orchestrator constraint.
      const { harvestLayer1Canonical } = require('./lib/harvest/layer1-canonical');
      const layer1Opts = Object.assign({
        timeoutMs: 120000,
        perFetchTimeoutMs: 15000,
        useLlmForPrereq: true,
        // 2026-05-17 difficulty scaling — base 3 anchors @ neutral 0.6 → 6.
        maxAnchors: _scaleBudget(3),
      }, opts.layer1Options || {}, { signal });
      const l1 = await harvestLayer1Canonical({
        topic,
        archetype: arch,
        goalContract: (settings && settings.goalContract) || null,
        options: layer1Opts,
      });
      result.layer1 = l1;
      if (l1 && Array.isArray(l1.warnings)) warnings.push(...l1.warnings.map(w => `layer1: ${w}`));
      if (l1 && (l1.lectureSequence || []).length > 0) {
        result.structureAnchor = {
          lectureSequence: l1.lectureSequence || [],
          prerequisiteChain: l1.prerequisiteChain || [],
          anchorCourses: l1.anchorCourses || [],
          confidence: typeof l1.confidence === 'number' ? l1.confidence : 0,
        };
      }
      safeProgress('layer1:done', {
        anchors: ((l1 && l1.anchorCourses) || []).length,
        lectures: ((l1 && l1.lectureSequence) || []).length,
        confidence: (l1 && l1.confidence) || 0,
      });
    } catch (e) {
      const msg = (e && e.message) ? String(e.message) : String(e);
      warnings.push(`layer1: dispatcher error — ${msg}`);
      safeProgress('layer1:error', { error: msg });
    }
  }

  // ── Layer 3 — Frontier deep-extract ────────────────────────────────────
  if (route.layer3) {
    safeProgress('layer3:start', { topic, archetype: arch });
    try {
      const { harvestLayer3DeepFrontier } = require('./lib/harvest/layer3-deep-frontier');
      // Wire per-source progress through to caller as layer3:<src>:<event>.
      const layer3Opts = Object.assign({
        timeoutMs: 300000,
        // 2026-05-17 difficulty scaling — base 5 papers @ neutral 0.6 → 11.
        // layer3 module internally clamps to 20 so 0.95 difficulty caps there.
        maxPapersPerSource: Math.min(20, _scaleBudget(5)),
        deepFetchIntro: true,
      }, opts.layer3Options || {}, {
        signal,
        onProgress: (stage, payload) => safeProgress('layer3:' + stage, payload),
      });
      const l3 = await harvestLayer3DeepFrontier({ topic, options: layer3Opts });
      result.layer3 = l3;
      if (l3 && Array.isArray(l3.warnings)) warnings.push(...l3.warnings.map(w => `layer3: ${w}`));
      safeProgress('layer3:done', { total_papers: (l3 && l3.total_papers) || 0 });
    } catch (e) {
      const msg = (e && e.message) ? String(e.message) : String(e);
      warnings.push(`layer3: dispatcher error — ${msg}`);
      safeProgress('layer3:error', { error: msg });
    }
    // v0.5.2 — Tavily fallback for cron mode when Layer 3 surfaced zero
    // papers. Keeps the daily frontier digest meaningful even when arXiv /
    // OpenReview rate-limit a cron host. Inline minimal call (does not import
    // a non-existent helper). Graceful no-op when no Tavily key configured.
    if (tavilyFallback && (!result.layer3 || ((result.layer3.total_papers || 0) === 0))) {
      const tavilyKey = (settings && settings.tavilyKey) || process.env.TAVILY_API_KEY || '';
      if (!tavilyKey) {
        warnings.push('layer3 tavily-fallback: no key configured — skipping');
      } else {
        try {
          const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
          const r = await fetchFn('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: tavilyKey,
              query: `${topic} arxiv recent`,
              search_depth: 'basic',
              max_results: 6,
              include_domains: ['arxiv.org', 'openreview.net', 'paperswithcode.com', 'huggingface.co'],
            }),
          });
          if (!r.ok) {
            warnings.push(`layer3 tavily-fallback: HTTP ${r.status}`);
          } else {
            const j = await r.json();
            const items = Array.isArray(j.results) ? j.results : [];
            const papers = items.map(it => ({
              url: it.url || '',
              title: String(it.title || '').slice(0, 200),
              abstract: String(it.content || '').replace(/\s+/g, ' ').slice(0, 600),
              published: null,
              authors: null,
              venue: null,
            })).filter(p => p.url);
            if (papers.length > 0) {
              if (!result.layer3) result.layer3 = { sources: {}, total_papers: 0, warnings: [] };
              if (!result.layer3.sources) result.layer3.sources = {};
              result.layer3.sources.tavily_fallback = { papers };
              result.layer3.total_papers = (result.layer3.total_papers || 0) + papers.length;
              result.layer3.tavily_fallback_used = true;
            }
          }
        } catch (e) {
          warnings.push(`layer3 tavily-fallback: ${e && e.message ? e.message : String(e)}`);
        }
      }
    }
  }

  // ── Layer 4 — Community discussion via bb-browser ─────────────────────
  if (route.layer4) {
    safeProgress('layer4:start', { topic, archetype: arch });
    try {
      const { harvestLayer4Community } = require('./lib/harvest/layer4-community');
      const layer4Opts = Object.assign({
        timeoutMs: 180000,
        perCallTimeoutMs: 45000,
        // 2026-05-17 difficulty scaling — base 10 posts @ neutral 0.6 → 22.
        maxPostsPerPlatform: _scaleBudget(10),
      }, opts.layer4Options || {}, { signal });
      const l4 = await harvestLayer4Community({ topic, archetype: arch, options: layer4Opts });
      result.layer4 = l4;
      if (l4 && Array.isArray(l4.warnings)) warnings.push(...l4.warnings.map(w => `layer4: ${w}`));
      if (l4 && l4.daemon_available === false) {
        warnings.push('layer4: bb-browser daemon unavailable — community signal via WebSearch fallback');
      }
      safeProgress('layer4:done', {
        total_posts: (l4 && l4.total_posts) || 0,
        daemon_available: !!(l4 && l4.daemon_available),
        fallback_used_any: !!(l4 && l4.fallback_used_any),
      });
    } catch (e) {
      const msg = (e && e.message) ? String(e.message) : String(e);
      warnings.push(`layer4: dispatcher error — ${msg}`);
      safeProgress('layer4:error', { error: msg });
    }
  }

  // ── Legacy harvest (v0.4 channels) ─────────────────────────────────────
  // Calls existing harvest() so v0.4-era callers' channels still flow into
  // the unified sources[] (Courseware / GitHub / HN / arXiv / WebSearch /
  // Wikipedia / OpenAlex / YouTube / SEP / YCLibrary / OpenReview / PwC /
  // HFPapers / PinnedDomains). Errors absorbed; legacy[] just empty on failure.
  if (route.legacy) {
    safeProgress('legacy:start', { topic, archetype: arch });
    try {
      const legacyOnProgress = (stage, payload) => safeProgress('legacy:' + String(stage), payload);
      const legacyArch = (archetype && archetype !== '_default') ? archetype : '_default';
      const legacyArr = await harvest(topic, settings, legacyOnProgress, legacyArch);
      result.legacy = Array.isArray(legacyArr) ? legacyArr : [];
      safeProgress('legacy:done', { count: result.legacy.length });
    } catch (e) {
      const msg = (e && e.message) ? String(e.message) : String(e);
      warnings.push(`legacy: dispatcher error — ${msg}`);
      safeProgress('legacy:error', { error: msg });
    }
  }

  // ── Unified flat sources[] ─────────────────────────────────────────────
  // Each entry: { url, title, excerpt, sourceType, layer, best_use, ... }.
  // sourceType drives metadata defaults (authority / freshness / etc) via
  // _inferSourceMetadata; new layer-3/4 sourceTypes ('paper-deep' /
  // 'community-discussion' / 'course-anchor') fall through to defaults
  // gracefully (best_use defaults to 'lesson').
  const flat = [];

  // Layer 1 anchor-course rows — high-authority curriculum entries.
  if (result.layer1 && Array.isArray(result.layer1.anchorCourses)) {
    for (const c of result.layer1.anchorCourses) {
      if (!c || !c.url) continue;
      flat.push({
        url: c.url,
        title: c.title || '',
        excerpt: (c.syllabus_text || '').slice(0, 280),
        stars: 0,
        sourceType: 'course-anchor',
        layer: 1,
        best_use: 'curriculum',
        authority: 95,
        teaching_value: 90,
        stability: 90,
        license_status: 'open',
        anchor_meta: {
          source: c.source || '',
          syllabusUrl: c.syllabusUrl || '',
          terms_offered: c.terms_offered || '',
        },
      });
    }
  }

  // Layer 3 papers — deep-fetched abstracts + intros.
  if (result.layer3 && result.layer3.sources) {
    const SRC_KEYS = ['arxiv', 'openreview', 'papers_with_code', 'hf_papers', 'semantic_scholar', 'tavily_fallback'];
    for (const key of SRC_KEYS) {
      const blob = result.layer3.sources[key];
      if (!blob || !Array.isArray(blob.papers)) continue;
      for (const p of blob.papers) {
        if (!p || !p.url) continue;
        flat.push({
          url: p.url,
          title: p.title || '',
          excerpt: (p.abstract || p.intro_excerpt || p.summary || '').slice(0, 400),
          stars: Number(p.stars) || 0,
          sourceType: 'paper-deep',
          layer: 3,
          best_use: 'spark',
          authority: (key === 'openreview' || key === 'arxiv') ? 80 : 70,
          freshness: 95,
          frontier_value: 90,
          paper_meta: {
            source: key,
            authors: p.authors || null,
            published: p.published || null,
            venue: p.venue || null,
          },
        });
      }
    }
  }

  // Layer 4 community posts.
  if (result.layer4 && result.layer4.platforms) {
    for (const platform of Object.keys(result.layer4.platforms)) {
      const pdata = result.layer4.platforms[platform];
      const posts = (pdata && Array.isArray(pdata.posts)) ? pdata.posts : [];
      for (const post of posts) {
        if (!post || !post.url) continue;
        flat.push({
          url: post.url,
          title: post.title || post.text_excerpt || '',
          excerpt: (post.text_excerpt || post.summary || '').slice(0, 300),
          stars: Number(post.score) || Number(post.upvotes) || 0,
          sourceType: 'community-discussion',
          layer: 4,
          best_use: 'example',
          authority: pdata.fallback_used ? 35 : 50,
          freshness: 80,
          engineering_value: 60,
          community_meta: {
            platform,
            fallback_used: !!pdata.fallback_used,
            author: post.author || null,
            timestamp: post.timestamp || post.created_at || null,
          },
        });
      }
    }
  }

  // Legacy v0.4 channel sources — already shaped { url, title, excerpt,
  // stars, sourceType }; tag them as layer 0 for downstream UI grouping.
  for (const s of result.legacy) {
    if (!s || !s.url) continue;
    flat.push(Object.assign({ layer: 0 }, s));
  }

  // ── Dedup by URL (keep first occurrence) + cap at 60 ────────────────────
  const seen = new Set();
  const unified = [];
  for (const s of flat) {
    if (!s || !s.url) continue;
    const key = String(s.url).split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    unified.push(s);
    if (unified.length >= 60) break;
  }

  // ── BM25 rank against topic for primary ordering, then prepend any
  // layer-1 anchor-course rows so the canonical-curriculum spine always
  // tops the list (regardless of BM25 score on a short syllabus excerpt).
  let ranked;
  try {
    ranked = rankSourcesBM25(unified, String(topic || ''), unified.length, {});
  } catch (e) {
    warnings.push(`harvestV3: rank fallback — ${e && e.message ? e.message : String(e)}`);
    ranked = unified.slice();
  }
  const anchorRows = ranked.filter(s => s.sourceType === 'course-anchor');
  const otherRows = ranked.filter(s => s.sourceType !== 'course-anchor');
  result.sources = [...anchorRows, ...otherRows];

  // ── Telemetry ──────────────────────────────────────────────────────────
  const durationMs = Date.now() - t0;
  try {
    const vault = require('./lib/vault');
    if (vault && typeof vault.appendJSONL === 'function') {
      vault.appendJSONL('events.jsonl', {
        ts: new Date().toISOString(),
        op: 'harvest_v3_complete',
        topic: String(topic || ''),
        archetype: arch,
        route,
        durationMs,
        layer1_anchors: result.layer1 ? (result.layer1.anchorCourses || []).length : 0,
        layer1_lectures: result.layer1 ? (result.layer1.lectureSequence || []).length : 0,
        layer1_confidence: result.layer1 ? (result.layer1.confidence || 0) : 0,
        layer3_papers: result.layer3 ? (result.layer3.total_papers || 0) : 0,
        layer4_posts: result.layer4 ? (result.layer4.total_posts || 0) : 0,
        layer4_daemon_available: result.layer4 ? !!result.layer4.daemon_available : null,
        legacy_count: (result.legacy || []).length,
        unified_count: result.sources.length,
        warnings_count: warnings.length,
      });
    }
  } catch (_) { /* telemetry best-effort */ }

  safeProgress('done', {
    durationMs,
    structure_anchor_present: !!result.structureAnchor,
    unified_count: result.sources.length,
    warnings_count: warnings.length,
  });
  return result;
}

// 2026-05-03 — JsonSpotter-style balanced-bracket JSON extractor. Replaces
// the prior greedy regex `/[\{\[][\s\S]*[\}\]]/` which grabbed from FIRST `{`
// to LAST `}` — broken when the LLM (esp. claude-cli with Victor persona)
// returns "Here's the schema example {schema}. The actual extraction: {real}"
// since the regex pulled both blocks together → JSON.parse fails → empty
// fallback (which is why ConceptAtlas stayed empty across 10 turns despite
// each extractAtlasDelta call "succeeding"). New approach: walk every `{`
// or `[` start, count balanced brackets respecting strings/escapes, try
// JSON.parse on each candidate, return the first valid one.
function _extractFirstJSON(rawIn) {
  if (typeof rawIn !== 'string') return rawIn;
  let raw = rawIn.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  // Whole-string parse first (the happy path: model gave us pure JSON).
  try { JSON.parse(raw); return raw; } catch (_) { /* fall through */ }
  // Walk every `{` or `[` start; per start, count balanced brackets.
  for (let start = 0; start < raw.length; start++) {
    const openCh = raw[start];
    if (openCh !== '{' && openCh !== '[') continue;
    const closeCh = openCh === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < raw.length; i++) {
      const c = raw[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === openCh) depth++;
      else if (c === closeCh) {
        depth--;
        if (depth === 0) {
          const candidate = raw.slice(start, i + 1);
          try { JSON.parse(candidate); return candidate; } catch (_) {}
          break; // this start didn't yield valid JSON; try the next start
        }
      }
    }
  }
  return raw; // no valid JSON found — let downstream JSON.parse throw
}

async function llmJSON(messages, settings, opts = {}) {
  // Hypha Cloud branch — managed-LLM proxy. Sends to https://APP/v1/llm with
  // the user's long-lived desktop token (hyphaToken in settings). Server
  // applies free-tier quota or paid credit; returns OpenAI-shaped response.
  if (settings.provider === 'hypha-managed') {
    return await _hyphaProxyCall(messages, settings, opts);
  }
  // 2026-05-02 — Anthropic SDK direct branch. provider `claude` (API) uses
  // the Messages API with system parameter → no Claude Code persona context
  // → claude.ai-quality output. Requires sk-ant key.
  const _cfg = _resolveProviderConfig(settings);
  if (_cfg && _cfg.via === 'sdk-anthropic') {
    let raw = await anthropicAdapter.runOnce(messages, settings, opts);
    if (opts.json) raw = _extractFirstJSON(raw);
    return raw;
  }
  // CLI provider branch — shell out to vendor binary (Claude Max / Gemini CLI).
  if (_isCliProvider(settings)) {
    const _t0 = Date.now();
    let raw = await _runCliOnce(messages, settings, { timeoutMs: opts.timeoutMs });
    // V0.5 E1 cost-ledger plug: CLI path emits no usage data, so this row
    // lands as estimation_source='tokenizer-fallback'. Non-fatal.
    try {
      const sqliteDb = require('./db/sqlite');
      const dispatch = {
        result: raw,
        usage: null,
        providerId: 'claude-cli',
        model: settings.model || 'claude-cli',
        _requestMessages: messages,
      };
      sqliteDb.recordChatCallEstimate(dispatch, opts.taskType || 'llmJSON-cli', {
        latency_ms: Date.now() - _t0,
      });
    } catch (err) {
      console.warn('[recordChatCallEstimate] llmJSON-cli err=', err && err.message);
    }
    if (opts.json) raw = _extractFirstJSON(raw);
    return raw;
  }
  const c = client(settings);
  const isGLM = (settings.provider === 'glm') || ((settings.baseURL || '').includes('bigmodel.cn'));
  // GLM-5 has thinking ON by default → message.content empty, reasoning_content
  // holds everything. Disable thinking for JSON-output calls where we need
  // actual content (clarify / design / state update / etc).
  const body = {
    model: settings.model || 'glm-5',
    messages,
    temperature: opts.temperature ?? 0.7,
    response_format: opts.json ? { type: 'json_object' } : undefined,
    max_tokens: opts.max_tokens || 4000,
  };
  if (isGLM) {
    // GLM disable-thinking parameter (per Z.AI OpenAI-compat docs).
    body.thinking = { type: 'disabled' };
  }
  // 2026-05-01 — hard timeout via AbortController. Default 90s, callers can
  // override (designSequence uses 180s for the trimmed monolith). Without
  // this the LLM call could hang indefinitely (Yogo: 85% structural-bug
  // probability behind the 10-min user complaint).
  const timeoutMs = opts.timeoutMs || 90_000;
  const _t0 = Date.now();
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), timeoutMs);
  let r;
  try {
    r = await c.chat.completions.create(body, { signal: ac.signal });
  } catch (err) {
    if (err && (err.name === 'AbortError' || /aborted/i.test(err.message || ''))) {
      clearTimeout(tid);
      const e = new Error(`LLM call timed out after ${Math.round(timeoutMs / 1000)}s`);
      e.code = 'LLM_TIMEOUT';
      throw e;
    }
    // If the disable-thinking param itself is rejected, retry without it.
    if (isGLM && body.thinking && err && /thinking|enable_thinking/i.test(err.message || '')) {
      delete body.thinking;
      try { r = await c.chat.completions.create(body, { signal: ac.signal }); }
      catch (err2) {
        clearTimeout(tid);
        if (err2 && (err2.name === 'AbortError' || /aborted/i.test(err2.message || ''))) {
          const e = new Error(`LLM call timed out after ${Math.round(timeoutMs / 1000)}s`);
          e.code = 'LLM_TIMEOUT';
          throw e;
        }
        throw err2;
      }
    } else {
      clearTimeout(tid);
      throw err;
    }
  }
  clearTimeout(tid);
  // V0.5 E1 cost-ledger plug: OpenAI-shape providers (GLM/DeepSeek/Kimi via
  // legacy agent.js path; not the executeChat router). r.usage has prompt+
  // completion_tokens; we synthesize a dispatch + record. Non-fatal.
  const _recordOpenAI = (text) => {
    try {
      const sqliteDb = require('./db/sqlite');
      const usage = (r && r.usage) ? {
        prompt_tokens: r.usage.prompt_tokens,
        completion_tokens: r.usage.completion_tokens,
      } : null;
      const dispatch = {
        result: text,
        usage,
        providerId: settings.provider || 'openai-shape',
        model: settings.model || body.model,
        _requestMessages: messages,
      };
      sqliteDb.recordChatCallEstimate(dispatch, opts.taskType || 'llmJSON-openai', {
        latency_ms: Date.now() - _t0,
      });
    } catch (err) {
      console.warn('[recordChatCallEstimate] llmJSON-openai err=', err && err.message);
    }
  };
  const msg = r.choices?.[0]?.message;
  if (!msg) { _recordOpenAI(''); return ''; }
  // Prefer message.content; fall back to reasoning_content if content is empty
  // (some providers + thinking mode write all output there).
  const content = (msg.content || '').trim();
  if (content) { _recordOpenAI(content); return content; }
  const reasoning = (msg.reasoning_content || '').trim();
  if (reasoning) {
    console.error('[llmJSON] content empty; using reasoning_content fallback (' + reasoning.length + ' chars)');
    // For JSON-mode, try to extract the first {...} block from reasoning.
    let out;
    if (opts.json) {
      const m = reasoning.match(/\{[\s\S]*\}/);
      out = m ? m[0] : reasoning;
    } else {
      out = reasoning;
    }
    _recordOpenAI(out);
    return out;
  }
  _recordOpenAI('');
  return '';
}

// clarifyQuestions — after user submits the topic/goal/time form, ask the LLM
// to propose 3-5 sharp clarifying questions (each with 4-6 multiple-choice
// option bubbles + a "Decide for me" + an "Other" escape). User's answers feed
// back into designSequence to tailor the 60-120 lesson curriculum.
async function clarifyQuestions(topic, goal, timeCommit, settings) {
  const profileBlock = userProfileBlock(settings && settings.userProfile);
  const sys = `${profileBlock}You are about to design a deep curriculum (60-180 lessons) for a self-directed learner. Before generating the lessons, you ask 3-5 sharp clarifying questions to make the curriculum specific to this person — not generic. If the STUDENT PROFILE above shows the student already has experience the topic would normally start from, SKIP basic-orientation questions and ask higher-leverage ones.

Output a JSON object: { "questions": [ { "id": string, "question": string, "options": [ { "id": string, "label": string } ], "multiSelect": boolean, "allowOther": boolean } ] }

Rules:
- 3 to 5 questions total. Fewer if topic+goal already gives clear shape; more only if genuinely needed to disambiguate.
- Each question MUST have 4-6 options + a "decide" option ({"id":"decide","label":"Decide for me · 让我决定"}).
- multiSelect: true ONLY for "which subtopics" / "which case studies" style questions where multiple coexist; false for stance / depth / format / tone preferences.
- allowOther: true if the option space is naturally open-ended; false if your 4-6 options exhaust the meaningful space.
- "label" can be bilingual: "english · 中文" — if topic is Chinese, lead with Chinese; if topic is English, lead with English.
- Questions should expose orthogonal axes — math depth vs systems engineering, theory vs practice, breadth vs single-thread depth, frontier vs foundations weight, audience for the goal, etc.
- AVOID generic surveys ("what's your level?", "how often will you study?"). Those came from the form already. Ask topic-SPECIFIC questions.
- Forbidden words in labels/questions: AI, LLM, embedding, model, prompt, agent, RAG, vector, fine-tune.

Output JSON only, no preamble.`;

  const user = `Topic: ${topic}
Stated goal: ${goal || '(none)'}
Time commitment: ${timeCommit}

Return the JSON now.`;

  const raw = await llmJSON(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    settings,
    { json: true, temperature: 0.6, max_tokens: 3000 }
  );
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.questions) ? parsed.questions : [];
  } catch (_) {
    return [];
  }
}

// === Hypha Lacquer Loop pedagogy v0 — see app/lib/pedagogy.md ===
// Archetype-gated primitive directives folded into designSequence sys prompt.
const ARCHETYPES = ['LANG-ACQ', 'TECH-CONCEPT', 'TECH-PROC', 'HUMANITIES', 'DECL-MASS', 'MINDSET'];

const PRIMITIVES = {
  P1: { name: 'EXPLAIN-TO-LEARN', directive: 'Each lesson MUST end with a 1-paragraph explain-to-child block where the tutor invites the learner to re-state the lesson\'s claim in plain language; tutor probes one ambiguity.' },
  P2: { name: 'PRE-READ PREDICTION', directive: 'Lesson opens with one prediction prompt: a concrete claim/mechanism/answer the learner forecasts BEFORE the canonical reveal.' },
  P3: { name: 'CUE-RETRIEVAL', directive: 'After main exposition, present 2-3 cue prompts (concept-name, scenario, mechanism question) WITHOUT the answer; learner responds; tutor reveals canonical + flags discrepancies.' },
  P4: { name: 'SCAFFOLDED INQUIRY', directive: 'When introducing a non-trivial concept, first ask "what would you ask first about X" and rubric-grade the question depth/specificity, then run P3 retrieval on implicit pre-knowledge before delivering instruction.' },
  P5: { name: 'EXPERTISE-AWARE IMITATION', directive: 'When demonstrating a procedure, gate the presentation by learner mastery: <0.3 = full worked example; 0.3-0.7 = partial example with 1-2 steps blanked; >0.7 = problem only, no example.' },
  F1: { name: 'PRODUCTIVE FAILURE', directive: 'For conceptually-deep lessons, generate a hard variant problem the learner attempts BEFORE seeing the canonical method. Failure trace persists as state.' },
  F2: { name: 'HYBRID INTERLEAVING', directive: 'Within each ~10-lesson phase: lessons 1-5 = blocked on a single sub-topic; lessons 6-10 = interleaved across the phase\'s sub-topics for category discrimination.' },
  F3: { name: 'CALIBRATION LOOP', directive: 'End every lesson with a confidence prompt (0-100) on the learnGoal; tutor logs against P3 retrieval score; gap > 30 → flag for next-lesson re-derivation.' },
};

// HIGH=2, MED=1, LOW=0, SKIP=-1. See app/lib/pedagogy.md Layer 3.
// v0158m — added P6 PRIOR-INSTALL column. HIGH for concept-dense archetypes
// (TECH-CONCEPT/TECH-PROC/HUMANITIES); LOW for archetypes where the prior is
// already provided by other substrates (LANG-ACQ has L1 anchors; DECL-MASS has
// rote substrate). MINDSET = MED (concept-dense but learner often has lay prior).
const EMPHASIS = {
  'LANG-ACQ':     { P1: 2, P2: 1, P3: 2, P4: 0, P5: -1, P6: 0, F1: 0,  F2: 2, F3: 1 },
  'TECH-CONCEPT': { P1: 2, P2: 2, P3: 0, P4: 1, P5: 1,  P6: 2, F1: 2,  F2: 2, F3: 2 },
  'TECH-PROC':    { P1: 1, P2: 2, P3: 1, P4: 0, P5: 2,  P6: 2, F1: 2,  F2: 1, F3: 2 },
  'HUMANITIES':   { P1: 2, P2: 1, P3: 1, P4: 2, P5: 0,  P6: 2, F1: 1,  F2: 1, F3: 0 },
  'DECL-MASS':    { P1: 0, P2: 0, P3: 2, P4: 0, P5: -1, P6: 0, F1: -1, F2: 0, F3: 1 },
  'MINDSET':      { P1: 2, P2: 2, P3: 1, P4: 2, P5: 0,  P6: 1, F1: 1,  F2: 1, F3: 1 },
};

const EMPHASIS_LABEL = {
  2: 'HIGH (MUST appear ≥1× per 3 consecutive lessons)',
  1: 'MED (MAY appear when natural to the topic)',
  0: 'LOW (only on explicit gap signal in prior lessons)',
};

// 2026-05-02 — turn-time concrete moves derived from each Layer-1 primitive.
// designSequence already injects these directives at curriculum-design time;
// streamTurn (per-turn) needs the BEHAVIORAL form ("when X then do Y") so
// Opus can pick the right move per conversation state. Built dynamically
// from EMPHASIS[archetype] so each archetype only sees its enabled primitives.
const TURN_MOVES = {
  P1: 'When the student gives an extended answer or claims understanding → ask them to RESTATE the core claim in plain language as if teaching a high-school freshman. Then probe ONE specific ambiguity in their restatement (not abstract praise).',
  P2: 'Before introducing a new concept/mechanism → STOP. Ask the student to PREDICT what the answer/mechanism might be. Capture verbatim ("you predicted: X"). Reveal canonical only after they commit. Name the delta explicitly. ⚠ DO NOT FIRE if P6 is active for this concept (no prior to predict against).',
  P3: 'When recalling previously-covered concept → present a blind cue (concept name OR scenario) WITHOUT the answer. Wait for their attempt. Reveal canonical, FLAG specific discrepancies (not just "good job").',
  P4: 'Before introducing a non-trivial new concept → ask "what would you ASK first to understand X?". Internally rubric-grade their question depth+specificity. Then test pre-knowledge via a P3-style cue. Then deliver instruction. Skip if student has already shown >0.5 mastery on adjacent concepts. ⚠ DO NOT FIRE if P6 is active for this concept.',
  P5: 'When demonstrating a procedure → calibrate by mastery seen in transcript: novice (≤2 attempts) = full worked example; intermediate = partial example with 1-2 steps blanked; expert (>3 successful attempts) = problem only, no example.',
  P6: 'When this lesson\'s central concept has NO anchor in the student\'s state.concepts AND priorNotes does not mention it → install a usable prior FIRST (BEFORE any P2/P3/P4 fires). 4-stage arc: (1) DEFINE — name + plain definition; (2) ANALOGIZE — one concrete analogy that gives the concept a body; (3) CHECK — confirm the prior landed via Feynman-back rephrase OR concrete-instance test (not deep-mechanism probe); (4) EXTEND — only after CHECK passes, deepen via probe / next layer / Feynman explain-back. Teacher-says-MORE on the foundation triggers more effective thinking; saying less ≠ pedagogy. **EMIT** the marker `<!-- p6: introduced concept_id=X -->` in the FIRST turn so lesson:finish persists state.concepts[X].',
  F1: 'For conceptually-deep moments → present a hard variant problem FIRST and let student attempt before you reveal the canonical method. The failed attempt activates prior knowledge — productive failure beats direct instruction on transfer. ⚠ PF requires existing prior — DO NOT FIRE if P6 just installed prior this lesson; defer F1 to a later lesson.',
  F3: 'At end of substantive turns → ask "How confident are you that you can [restate the learn goal] right now? 0-100." Note their answer. If next retrieval gap > 30, flag in your final tag as <!--method:F3-gap-->.',
};
// F2 (HYBRID INTERLEAVING) is curriculum-level (handled by chain planner), not
// per-turn — omitted from turn-time block.

// _buildTurnTimeMoves — emit only the primitives the archetype actually
// emphasizes (>= LOW), tagged with their priority label. Returns a system-
// prompt block telling Opus "decide silently which move applies, then act"
// + the invisible <!--method:Px--> tag emission rule.
function _buildTurnTimeMoves(archetype) {
  const emph = EMPHASIS[archetype];
  if (!emph) return '';
  const lines = [];
  for (const k of ['P1', 'P2', 'P3', 'P4', 'P5', 'F1', 'F3']) {
    const v = emph[k];
    if (v == null || v < 0) continue; // SKIP or undefined → omit
    const labelShort = (EMPHASIS_LABEL[v] || '').split(' ')[0];
    lines.push(`[${k} ${PRIMITIVES[k].name} — ${labelShort}] ${TURN_MOVES[k]}`);
  }
  if (!lines.length) return '';
  return `\n═══ TURN-TIME PEDAGOGICAL MOVES (archetype: ${archetype}) ═══

DECIDE silently which move applies to THIS turn based on conversation state, then act. You don't have to use a move every turn — pick when it naturally fits. Prefer HIGH-emphasis moves over MED, MED over LOW.

${lines.join('\n\n')}

End EVERY tutor reply with exactly one invisible HTML comment tag on its own final line: \`<!--method:P0-->\` for generic/parsing turn, or \`<!--method:Px-->\` (Px = the dominant Lacquer primitive you used: P1 / P2 / P3 / P4 / P5 / F1 / F3). The comment is invisible to the student but lets Hypha track which moves you deployed for diagnostics + spaced-revisit scheduling. Strict format, no extra prose around the tag.
══════════════════════════════════════════════════════════════════════════
`;
}

// 2026-05-02 — parse the <!--method:Px--> tag from accumulated tutor reply
// and log to events.jsonl. Pairs with _detectAndLogPersonaLeak (same call
// site in streamTurn). Used by future scheduler to know which primitive
// was deployed per lesson, drives spaced-revisit cadence + per-archetype
// emphasis tuning.
const METHOD_TAG_RE = /<!--method:(P0|P[1-5]|F[1-3](?:-gap)?)-->/i;
function _logMethodTag(text, settings, opts) {
  if (!text || typeof text !== 'string') return;
  const m = text.match(METHOD_TAG_RE);
  if (!m) return;
  try {
    const slug = (opts && opts.lesson_slug) || (settings && settings.lesson_slug) || '_global';
    // V0.5 E0 D6 — type/op + field names UNCHANGED.
    events.write(slug, {
      type: 'method_used',
      op: 'method_used',
      method: m[1],
      provider: settings && settings.provider,
      model: settings && settings.model,
      context: (opts && opts.context) || 'tutor_turn',
    });
  } catch (err) {
    console.warn('[method_used] write failed:', err && err.message);
  }
}

// getEmphasis — exposed to main.js so the lesson IPC can detect when a
// primitive (e.g. P2) is HIGH/MED for the curriculum's archetype, and gate
// runtime behavior accordingly. primitiveId optional → returns full emphasis obj.
function getEmphasis(archetype, primitiveId) {
  const e = EMPHASIS[archetype];
  if (!e) return null;
  if (primitiveId) return typeof e[primitiveId] === 'number' ? e[primitiveId] : null;
  return e;
}

// classifyArchetype — 1 small LLM call to bucket the topic into one of 5
// archetypes. Caller may pass opts.archetype to skip this step.
async function classifyArchetype(topic, goal, settings) {
  const sys = `${HYPHA_SHORT}Classify the learning topic into ONE archetype. Return only JSON: {"archetype": "<one of: LANG-ACQ | TECH-CONCEPT | TECH-PROC | HUMANITIES | DECL-MASS | MINDSET>"}.

- LANG-ACQ: foreign/second-language learning (English, Japanese, Spanish — reading, speaking, grammar)
- TECH-CONCEPT: theory-heavy technical (LLM algorithms, physics, cognitive science, statistics theory) — derive from atoms
- TECH-PROC: skill-heavy technical (coding, lab procedures, instrumentation, frontend implementation) — practice patterns
- HUMANITIES: interpretive (philosophy, literature, history, art criticism)
- DECL-MASS: declarative mass (vocabulary, anatomy, legal codes, taxonomies) — high-volume facts
- MINDSET: practitioner mental models / decision frameworks (Buffett's investing, Musk's first-principles, Munger's latticework, Bezos's day-1, Soros's reflexivity, leadership/founding-style biographies extracted as a way of thinking). Triggers when the topic is "<person>'s thinking / mindset / philosophy / approach", "X way / X school of <doing>", or a methodology named after its practitioner.`;
  const user = `Topic: ${topic}\nGoal: ${goal || '(none)'}\n\nReturn JSON.`;
  try {
    const raw = await llmJSON(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      settings,
      { json: true, temperature: 0.1, max_tokens: 100 }
    );
    const a = String(JSON.parse(raw).archetype || '').trim();
    return ARCHETYPES.includes(a) ? a : 'TECH-CONCEPT';
  } catch (_) { return 'TECH-CONCEPT'; }
}

// ────────────────────────────────────────────────────────────────────────────
// Layer 0 Subtract-First Course Architecture (pedagogy.md 2026-05-11, MEOW v5
// CONDITIONAL → PASS via Precedence + Migration Matrix). Two pure helpers
// called at v0.3 2-stage flow Stage 2 (skeleton).
//
// classifyVisualArchetype = S1 storage topology (tree/DAG/timeline/matrix/flat),
//   ORTHOGONAL to Layer 3 classifyArchetype (LANG-ACQ / TECH-CONCEPT / etc.).
//   Layer 3 picks WHICH PRIMITIVES the tutor emphasises; S1 picks HOW the KP
//   map renders in Layer 6 default view + Show map toggle.
// lessonSplit = R3 + R11 弹性课时切分. Pure function over KP count + intent.
//   Disjoint thresholds per Layer 0 S2 (≤8 / 9-17 / 18-26 / ≥27).
// ────────────────────────────────────────────────────────────────────────────

const VISUAL_ARCHETYPES = ['tree', 'DAG', 'timeline', 'matrix', 'flat'];

/**
 * Layer 0 S1 — visual (storage-topology) archetype router.
 * Returns one of VISUAL_ARCHETYPES; defaults to 'DAG' on LLM failure.
 *
 * @param {string} topic
 * @param {string|null} userIntent — 考研 | 兴趣 | 论文 | 复盘 (biases LLM hint)
 * @param {object} settings
 * @returns {Promise<'tree'|'DAG'|'timeline'|'matrix'|'flat'>}
 */
async function classifyVisualArchetype(topic, userIntent, settings) {
  const sys = `${HYPHA_SHORT}Classify a learning topic by the TOPOLOGY of relations between knowledge points. Return only JSON: {"visual_archetype": "<one of: tree | DAG | timeline | matrix | flat>"}.

- tree: strict parent-child hierarchy (mathematical theorem chains, taxonomies, anatomy systems)
- DAG: nodes inter-define / multiple parents (philosophy: substance/attribute/mode mutually constituted; transformer architecture: Q-K-V matrices that explain each other)
- timeline: temporal sequence dominant (history of philosophy, project stages, biology evolution)
- matrix: two-axis crossing (economics supply×demand, OS deadlock 4-condition, 2x2 strategy)
- flat: unstructured set (vocabulary, legal codes, name lists — no inherent ordering)

This is a STORAGE TOPOLOGY classification — orthogonal to pedagogical emphasis. Pick what BEST fits how the knowledge naturally hangs together, not the teaching style.`;
  const user = `Topic: ${topic}\nLearner intent: ${userIntent || '(none specified)'}\n\nReturn JSON.`;
  try {
    const raw = await llmJSON(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      settings,
      { json: true, temperature: 0.1, max_tokens: 100 }
    );
    const a = String(JSON.parse(raw).visual_archetype || '').trim();
    return VISUAL_ARCHETYPES.includes(a) ? a : 'DAG';
  } catch (_) { return 'DAG'; }
}

/**
 * Layer 0 S2 — lesson split (YOGO-designed pure function).
 * Disjoint thresholds (MEOW v3 HIGH 2 fix):
 *   kpCount ≤ 8        → 1 课时 (e.g. Spinoza substance/attribute/mode)
 *   9 ≤ kpCount ≤ 17   → 2 课时 (e.g. Kant 纯批 + 实批)
 *   18 ≤ kpCount ≤ 26  → 3 课时 (e.g. Aristotle 形而上学 / 伦理学 / 逻辑学)
 *   kpCount ≥ 27       → reject + narrow-scope prompt
 *
 * Distribution is even-clamped to per-lesson KP ∈ [5,9] (Miller's working
 * memory cap). userIntent is recorded on the return object for downstream
 * consumers; intent-aware target-count skew is left to the designSequence
 * prompt (avoids encoding policy in this pure layer).
 *
 * @param {number} kpCount
 * @param {string|null} userIntent
 * @returns {{ n_lessons: number, target_counts: number[], user_intent: string|null, reject?: string }}
 */
function lessonSplit(kpCount, userIntent) {
  const intent = (typeof userIntent === 'string' && userIntent.trim()) ? userIntent.trim() : null;
  if (!Number.isFinite(kpCount) || kpCount <= 0) {
    return { n_lessons: 1, target_counts: [5], user_intent: intent };
  }
  if (kpCount >= 27) {
    return {
      n_lessons: 0,
      target_counts: [],
      user_intent: intent,
      reject: `Topic too large (${kpCount} KP candidates ≥ 27). Narrow scope or split into sub-topics.`,
    };
  }
  let n_lessons;
  if (kpCount <= 8) n_lessons = 1;
  else if (kpCount <= 17) n_lessons = 2;
  else n_lessons = 3; // 18..26

  const base = Math.floor(kpCount / n_lessons);
  const remainder = kpCount % n_lessons;
  const target_counts = [];
  for (let i = 0; i < n_lessons; i++) {
    const c = base + (i < remainder ? 1 : 0);
    // MEOW v6 audit fix (2026-05-11) — preserve KP count conservation. Drop
    // the Math.max(5, ...) floor that previously fabricated a KP at the
    // boundary kp=9 → [5,5] (10 slots for 9 candidates). Keep upper bound
    // (Miller's working-memory cap) only. A lesson at the lower edge (e.g.
    // kp=9 → [5,4]) under-fills working memory but matches the real
    // candidate count — intent-relative subtraction prefers truth over
    // arithmetic ideal. sum(target_counts) === kpCount is now invariant.
    target_counts.push(Math.min(9, c));
  }
  return { n_lessons, target_counts, user_intent: intent };
}

// summarizeSources — 1 small LLM call (~500 tok) that compresses 25 raw
// harvest results into a "shape of the field" digest for designSequence to
// consume. Per Leo's audit: shipping 25 source lines as raw input was 5×
// input-token bloat with no downstream use (designLesson only ships the top
// 10 titles). Output: dense paragraph naming the field's main subareas +
// 2026-currency papers/repos/debates by name. Falls back gracefully.
async function summarizeSources(topic, sources, settings, opts = {}) {
  const lines = sources.slice(0, 25)
    .map((s, i) => `${i + 1}. [${s.sourceType}] ${s.title} — ${(s.excerpt || '').slice(0, 200)}`)
    .join('\n');
  // v0.5.0 — when corpus is a single uploaded document, frame the digest as
  // the document's shape (so designSeed's trajectory talks about THIS book's
  // arc), not "the field's" general shape.
  const isUpload = Array.isArray(sources) && sources.length > 0 && sources.every(s => s && s.sourceType === 'user-upload');
  // v0.6.0 — accept optional archetype hint to inject a frontier window into
  // the digest prompt so the resulting "shape of the field" paragraph
  // anchors against the right time horizon (12mo for TECH-CONCEPT,
  // undated for MINDSET, 5y for HUMANITIES, etc.). Caller passes archetype
  // when known; otherwise we skip the anchor (back-compat with v0.5.x sites).
  const archetypeHint = opts && opts.archetype ? String(opts.archetype) : null;
  let frontierLine = '';
  if (archetypeHint) {
    try {
      const tmpl = loadArchetypeTemplate(archetypeHint);
      if (tmpl && tmpl.frontier_definition && tmpl.frontier_definition.prompt_anchor) {
        frontierLine = ` Frontier window: ${tmpl.frontier_definition.prompt_anchor}`;
      }
    } catch (_) {}
  }
  const sys = isUpload
    ? `Compress an uploaded document's chapter list into a single dense "shape of this document" paragraph (≤450 tokens). Name the book/document's 4-7 movements (its actual arc, in its own terms — not the wider field's). Cite specific chapter titles. No fluff, no list format, no markdown.${frontierLine} This digest will feed a curriculum-design step that needs to see how THIS document is structured so the curriculum can move foundations → frontier through it.`
    : `Compress a list of harvested sources about a learning topic into a single dense "shape of the field" paragraph (≤450 tokens). Name 4-7 subareas. Cite specific recent papers / repos / debates BY NAME (author/year/title) where the source list contains them. No fluff, no list format, no markdown.${frontierLine} This digest will feed a curriculum-design step that needs to see the field's actual structure, not 25 disconnected items.`;
  const user = isUpload
    ? `Topic: ${topic}\n\nUploaded document chapters:\n${lines}\n\nReturn the digest paragraph describing THIS document's shape.`
    : `Topic: ${topic}\n\nHarvested sources:\n${lines}\n\nReturn the digest paragraph.`;
  try {
    const raw = await llmJSON(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      settings,
      { json: false, temperature: 0.3, max_tokens: 600, timeoutMs: 60_000 }
    );
    return (raw || '').trim();
  } catch (_) {
    // Fallback to raw list — caller has its own try/catch.
    return lines;
  }
}

async function designSequence(topic, sources, level, settings, opts = {}) {
  const goal = (opts.goal || '').trim();
  const timeCommit = opts.timeCommit || 'month';
  // 2026-05-01 council (Leo's 95% waste-tax audit + Lung's mycelial argument):
  // upfront generation of 60-100 lessons is wasted — designLesson regenerates
  // the body per-turn and lessons:adapt-after-finish overwrites future
  // learn_goals. Cut counts ~5×; rely on Tier 2 emit-as-needed (next ship)
  // to extend the curriculum lazily as the user advances.
  const TIME_TARGETS = {
    week:    { count: '5-8',   anchor: '5-8 lessons (curiosity dive; finishable in a week)' },
    month:   { count: '12-20', anchor: '12-20 lessons (build a working understanding over a month)' },
    quarter: { count: '25-40', anchor: '25-40 lessons (deep traversal; spaced revisits across months)' },
    open:    { count: '18-30', anchor: '18-30 lessons (no rush, prioritize depth and frontier reach)' },
  };
  const T = TIME_TARGETS[timeCommit] || TIME_TARGETS.month;

  // W6.4 Curriculum Graph (BLUEPRINT §20 v1.8) — when the topic hits AI/CS
  // keywords, prefer the hand-curated DAG over LLM skeleton generation.
  // Returns the same { lessons: [{ title, learnGoal, prereqIds }] } shape the
  // downstream pipeline expects. opts.disableCurriculumGraph=true bypasses
  // (used by A/B baseline). Failures fall through to the LLM path silently.
  const _AI_CS_RE = /\b(ai|ml|machine learning|deep learning|neural net|transformer|llm|gpt|claude|agent|rag|nlp|computer science|cs|python|pytorch|tensorflow|backprop|rlhf|fine[- ]?tuning|tokeniz|embedding|prompt|attention|gradient descent|reinforcement learning|cnn|rnn|lstm)\b/i;
  if (!opts.disableCurriculumGraph && _AI_CS_RE.test(`${topic} ${goal}`)) {
    try {
      const targetCount = parseInt(String(T.count).split('-').pop(), 10) || 16;
      const graphPlan = await require('./lib/curriculum-graph/graph-engine')
        .buildCustomCurriculum({ north_star_goal: goal || topic, topic }, targetCount);
      if (graphPlan && graphPlan.ok && graphPlan.plan && graphPlan.plan.lessons.length >= 5) {
        const lessons = graphPlan.plan.lessons.map((l, i) => ({
          title: l.title,
          learnGoal: l.learnGoal,
          prereqIds: i === 0 ? [] : [i - 1],
          _graphKpId: l.kpId,
          _graphLayer: l.layer,
          _graphDifficulty: l.difficulty,
        }));
        return { lessons, source: 'curriculum-graph', targetKpIds: graphPlan.plan.targetKpIds };
      }
    } catch (err) {
      console.error('[designSequence] curriculum-graph path failed, falling through to LLM:', err.message);
    }
  }

  // Lacquer Loop v0: classify archetype + assemble primitive directives.
  // opts.disableLacquer=true → vanilla baseline arm (no archetype, no directives).
  // Used for A/B pilot comparison vs Lacquer Loop arm.
  const disableLacquer = !!opts.disableLacquer;
  let archetype = null;
  let pedagogyBlock = '';
  let schemaExtra = '';
  if (!disableLacquer) {
    archetype = opts.archetype || await classifyArchetype(topic, goal, settings);
    const emph = EMPHASIS[archetype] || EMPHASIS['TECH-CONCEPT'];
    const directiveLines = Object.entries(emph)
      .filter(([_, v]) => v >= 0)
      .map(([k, v]) => `- ${k} ${PRIMITIVES[k].name} [${EMPHASIS_LABEL[v]}] — ${PRIMITIVES[k].directive}`)
      .join('\n');
    const skipList = Object.entries(emph)
      .filter(([_, v]) => v < 0)
      .map(([k]) => `${k} ${PRIMITIVES[k].name}`).join(', ');
    // methodTags / dominantPrimitive removed 2026-05-01 (Leo's waste-tax audit):
    // designLesson reads EMPHASIS[archetype] directly per-turn (line 549),
    // never reading the per-lesson upfront tags. They were ~80-150 output
    // tokens × N lessons of pure overhead. Archetype itself stays at curriculum
    // level (state.archetype) where it's actually consumed.
    pedagogyBlock = `\n═══ Hypha Lacquer Loop — domain archetype: ${archetype} ═══\n\nFor this archetype, prioritize these pedagogical primitives across the curriculum (the runtime tutor will apply them per-turn):\n\n${directiveLines}${skipList ? `\n\nForbidden as primary lesson type for this archetype: ${skipList}` : ''}\n`;
    schemaExtra = '';
  }

  // 2026-05-01 — replaced raw 25-source list (~3000 input tokens) with a
  // ~400-token shape-of-the-field digest. Per Leo's audit, designLesson
  // downstream only ships the top-10 source titles; the raw 25-source list
  // shipped to designSequence was 5× input bloat with no downstream use.
  // Falls back to the raw list if summarization fails (best-effort).
  let sourceDigest;
  try {
    sourceDigest = await summarizeSources(topic, sources, settings);
  } catch (err) {
    console.error('[designSequence] source summary failed, falling back to raw list:', err.message);
    sourceDigest = sources.slice(0, 25).map((s, i) => `${i + 1}. [${s.sourceType}] ${s.title} — ${s.excerpt || ''}`).join('\n');
  }
  const sys = `${HYPHA_FULL}You design a deep sequential pseudo-curriculum (basic→frontier) in the SAGE register: 循循渐进 — each lesson a small step beyond the previous, never a leap. The student commits to a SUBSTANTIAL course of conversations, not a survey.

Output a JSON object: { "lessons": [ { "title": string, "learnGoal": string, "prereqIds": [int]${schemaExtra} } ] }

Hard rules:
- **${T.count} lessons total**. ${T.anchor}. A short syllabus (under the floor) means you under-served them; refuse to output less.
- Strict prerequisite ordering — lesson N may only depend on 0..N-1. Each lesson should depend on 1-3 specific prior lessons.
- "title": 4-10 words, concrete + specific. NEVER generic ("Introduction to X", "Overview", "Fundamentals" alone). Each title names a specific mechanism, technique, paper, or distinction.
- "learnGoal": one sentence, plain language. The single concrete claim or skill the student walks away with. Should pass: "If they can answer THIS question afterwards, the lesson succeeded."
- **Difficulty curve = monotonic + small Δ per step**. The Δ between lesson N and N+1 should be small enough that a student who finished N can begin N+1 in one breath. Each ~5 lessons = one named "phase" of mastery (foundations → tools → mechanisms → frontier → synthesis); but do not output phase headers, just the smooth sequence.
- **Spaced revisit**: every ~10 lessons, include 1 lesson that re-derives an earlier concept from a new angle (cite which prior lesson it deepens via prereqIds). Prevents staleness, builds the student's compound model.
- **Mix theory and practice**: roughly 60% mechanism / 30% case study or hands-on / 10% open question.
- Final ~10 lessons reach the actual frontier — recent papers (2025-2026), open problems, debates. NAME the papers/debates by author or year, do not say "recent advances".
- Calibrate to declared level (beginner / intermediate / advanced) for the floor; the ceiling always reaches frontier.
- Do NOT name a single source as "the textbook" — synthesize across the harvested sources.
${pedagogyBlock}
Banned words in title or learnGoal (forge §219 register): AI, LLM, embedding, model, prompt, agent, RAG, vector, fine-tune.`;

  // Format clarification answers (from clarifyQuestions) into prompt-readable lines.
  const clarif = (opts.clarifications || []);
  const clarifLines = clarif.length
    ? clarif.map(c => `  - ${c.question}\n    → ${Array.isArray(c.answer) ? c.answer.join(', ') : c.answer}`).join('\n')
    : '';

  const user = `Topic: ${topic}
Level: ${level}
Time commitment: ${timeCommit} (target ${T.count} lessons)
${goal ? `Student's stated goal: ${goal}\n\nCalibrate the curriculum to this goal. The final 5-10 lessons should specifically equip the student to act on it — pull case studies, exercises, and frontier readings that ladder toward the goal, not generic survey content.\n` : ''}${clarifLines ? `\nStudent's specific preferences (from a clarifying questionnaire — TREAT AS HARD CONSTRAINTS, not suggestions):\n${clarifLines}\n\nThe curriculum must reflect every preference above. If user said "Decide for me" on a question, you may use your judgment for that axis only. Other answers are non-negotiable.\n` : ''}
Shape of the field (digest of harvested sources):
${sourceDigest}

Return the JSON object now. Aim for the count target above.`;

  const raw = await llmJSON(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    settings,
    // 2026-05-01: max_tokens cut from 14000 → 4000 (per Leo's audit on
    // expected output size of 12-20 lessons). timeoutMs 180s upper bound;
    // typical wall time should be 20-60s now.
    { json: true, temperature: 0.55, max_tokens: 4000, timeoutMs: 180_000 }
  );
  try {
    const parsed = JSON.parse(raw);
    const lessons = (parsed.lessons || []).map((l, idx) => ({
      idx,
      title: l.title,
      learnGoal: l.learnGoal,
      prereqIds: l.prereqIds || [],
    }));
    return { archetype, lacquer: !disableLacquer, lessons };
  } catch (_) {
    return {
      archetype,
      lacquer: !disableLacquer,
      lessons: [{ idx: 0, title: 'Foundations', learnGoal: `Establish what '${topic}' actually means.`, prereqIds: [] }],
    };
  }
}

// v0158q — cached prompt loader for Hypha Learn templates. Reads each template
// at most once per process; returns '' on read failure (silent fail-safe).
const _learnPromptCache = new Map();
function _loadLearnPromptCached(name) {
  const cached = _learnPromptCache.get(name);
  if (typeof cached === 'string') return cached;
  try {
    const _fs = require('node:fs');
    const _path = require('node:path');
    const txt = _fs.readFileSync(_path.join(__dirname, 'prompts', `${name}.txt`), 'utf8');
    _learnPromptCache.set(name, txt);
    return txt;
  } catch (_) {
    _learnPromptCache.set(name, '');
    return '';
  }
}

// v0.4 — pedagogy rules registry. Lazy-loaded, cached. Falls back to empty
// when the JSON is missing (graceful degrade — no PEDAGOGY GUARDRAILS block).
let _pedagogyRulesCache = null;
function _loadPedagogyRules() {
  if (_pedagogyRulesCache) return _pedagogyRulesCache;
  try { _pedagogyRulesCache = require('./lib/pedagogy-rules.json'); }
  catch (_) { _pedagogyRulesCache = { principles: [] }; }
  return _pedagogyRulesCache;
}

// _selectPedagogyForLesson — pick top-3 pedagogy principles by
// (archetype_weight × lesson_stage_weight). Pure deterministic. Returns
// up to `count` principle objects. Used to populate PEDAGOGY GUARDRAILS.
function _selectPedagogyForLesson(archetype, currentState, count = 3) {
  const cfg = _loadPedagogyRules();
  const list = (cfg && Array.isArray(cfg.principles)) ? cfg.principles : [];
  if (list.length === 0) return [];
  const stage = String(currentState || 'HOOK').toUpperCase();
  const arch = archetype || 'TECH-CONCEPT';
  const scored = list.map(p => {
    const aw = (p.archetype_weights && typeof p.archetype_weights[arch] === 'number') ? p.archetype_weights[arch] : 1;
    const sw = (p.lesson_stage_weights && typeof p.lesson_stage_weights[stage] === 'number') ? p.lesson_stage_weights[stage] : 1;
    return { p, score: aw * sw };
  }).sort((a, b) => b.score - a.score);
  // Filter zero-scored (e.g. transfer in HOOK stage = 0 → don't inject).
  return scored.filter(s => s.score > 0).slice(0, count).map(s => s.p);
}

// _buildPedagogyBlock — render the selected principles as a PEDAGOGY
// GUARDRAILS prompt block. Returns '' when no principles apply (e.g. END
// state where all stage-weights are zero) so the prompt stays clean.
function _buildPedagogyBlock(archetype, currentState) {
  const picks = _selectPedagogyForLesson(archetype, currentState, 3);
  if (picks.length === 0) return '';
  const lines = picks.map((p, i) =>
    `${i + 1}. [${p.name}] ${p.distilled_rule}\n   → applied here: ${p.hypha_application}`
  );
  return `PEDAGOGY GUARDRAILS — apply these ${picks.length} principles in this turn (weighted by archetype "${archetype}" + state "${currentState || 'HOOK'}"):\n${lines.join('\n')}\n\nThese are not decoration. If your draft violates one (e.g. teach without prior probe, exceed cognitive load, give vague feedback, skip transfer), revise BEFORE sending.`;
}

// _buildStructurePriorBlock — extract top-1 courseware source matching the
// current lesson and render as a STRUCTURE PRIOR prompt fragment. Returns ''
// when no courseware grounded (graceful no-op). Caller passes the already-
// scoped `sources` array; this function does its own BM25 + best_use filter.
function _buildStructurePriorBlock(sources, query) {
  if (!Array.isArray(sources) || sources.length === 0) return '';
  if (!query || !String(query).trim()) return '';
  const top = rankSourcesBM25(sources, query, 1, { desiredUse: 'curriculum' });
  if (top.length === 0) return '';
  const s = top[0];
  const inst = s.institution || 'university';
  const code = s.courseCode ? ` ${s.courseCode}` : '';
  const url = s.url ? ` (${s.url})` : '';
  const excerpt = String(s.excerpt || '').replace(/\s+/g, ' ').slice(0, 250);
  return `STRUCTURE PRIOR — ${inst}${code} sequences this topic as follows${url}:\n${excerpt}\nUse as a sequencing prior, NOT verbatim copy. Align if their order is canonical; deviate when the student's goal demands a different entry point.`;
}

// v0.2 Surface Finishing Track A A2 — render the Character Contract for the
// active tutor agent as a CHARACTER CONTRACT block. Goes BEFORE LESSON BRIEF
// in the system-prompt appendix so the contract is the tutor's outermost
// frame ("who I am") and the brief sits inside it ("what I'm teaching now").
//
// Default agent_id = 'mycelium-professor' (the cognitive structure designer
// per specs/persona-coherence-layer.md). Falls through silently when the
// loader throws or returns null (legacy tutors keep working without it).
//
// Block format kept tight (~250-350 tokens) — uses i_am, i_am_not,
// epistemic_temperament, failure_protocol from the 13-field contract schema.
// Project mycelium-professor.json does NOT have a `failure_honesty_modes`
// field; we use `failure_protocol` (closest semantic match: per-agent prose
// protocol for failure-honesty).
function _buildCharacterContractBlock(agentId) {
  const id = agentId || 'mycelium-professor';
  let contract = null;
  try {
    const loader = require('./lib/agent-character/contract-loader');
    contract = loader.loadContract(id);
  } catch (_) { return ''; }
  if (!contract || typeof contract !== 'object') return '';

  const lines = [];
  lines.push('=== CHARACTER CONTRACT ===');
  if (Array.isArray(contract.i_am) && contract.i_am.length > 0) {
    lines.push('I am:');
    contract.i_am.forEach(item => lines.push(`- ${String(item).trim()}`));
  }
  if (Array.isArray(contract.i_am_not) && contract.i_am_not.length > 0) {
    lines.push('I am NOT:');
    contract.i_am_not.forEach(item => lines.push(`- ${String(item).trim()}`));
  }
  if (contract.epistemic_temperament) {
    lines.push(`Epistemic temperament: ${String(contract.epistemic_temperament).trim()}`);
  }
  if (contract.failure_protocol) {
    lines.push(`Failure-honesty protocol: ${String(contract.failure_protocol).trim()}`);
  }
  lines.push('=== END CONTRACT ===');
  lines.push('');
  lines.push('This contract is your outermost frame. Every turn must honor it; the LESSON BRIEF below sits INSIDE this frame.');
  return lines.join('\n');
}

// γ10 (2026-05-15) — distilled persona corpus overlay. When a
// vault/.persona-wisdom/<personaId>.md file exists (and is NOT
// 'WAITING_DISTILL'), render it as a "PERSONA WISDOM" appendix block to be
// stacked AFTER the string-register TUTOR PERSONA block (in classic mode)
// or alongside the CHARACTER CONTRACT block (in learn mode). The string
// register stays the spine — wisdom is an *overlay* that thickens the voice
// with corpus-derived priors. Empty string when no wisdom file exists or
// loader throws, so callers can `.filter(Boolean).join('\n\n')` safely.
//
// Returns { block, status } so the caller can emit an event
// `persona_wisdom_injected` with the status enum surfaced.
function _buildPersonaWisdomBlock(personaId) {
  if (!personaId || typeof personaId !== 'string') return { block: '', status: null };
  let wisdom = null;
  try {
    const wisdomLoader = require('./lib/personas/load-wisdom');
    wisdom = wisdomLoader.loadPersonaWisdom(personaId);
  } catch (_) {
    return { block: '', status: null };
  }
  if (!wisdom || wisdom.status === 'WAITING_DISTILL') return { block: '', status: null };

  const sections = wisdom.sections || {};
  // Sections we surface in the system-prompt overlay. Order matters — the
  // identity sentence anchors first, then the teaching-move arsenal, then
  // hedging / limits, then idiolect + anti-patterns. Sections that aren't
  // present in this persona's wisdom file are skipped silently.
  const SURFACED = [
    // Old English schema (karpathy / limu / munger / tao / tolkien distilled
    // pre-2026-05-15).
    'What he is, in one line',
    'What she is, in one line',
    'What they are, in one line',
    'Six load-bearing teaching moves',
    'Load-bearing teaching moves',
    'How he hedges',
    'How she hedges',
    'How they hedge',
    'How he admits limits',
    'How she admits limits',
    'How they admit limits',
    'Idiolect to keep available, not to mimic verbatim',
    'Idiolect',
    'Where he is *not* a fit',
    'Where she is *not* a fit',
    'Where they are *not* a fit',
    'Where he is not a fit',
    'Where she is not a fit',
    'Where they are not a fit',
    // New CN schema (distill-corpus.js post-2026-05-15, e.g.
    // nobel-literature-critic). Order = identity → voice → moves → anti → register.
    '整体调子 (register)',
    '核心信念 (core_beliefs)',
    '标志性表达 (signature_voice)',
    '思维模式 (thought_patterns)',
    '反模式 (anti_patterns)',
    '常用 referent (favorite_referents)',
    '不碰的话题 (topics_he_avoids)',
  ];
  // Build a case-insensitive lookup so we don't miss minor punctuation
  // variants between personas.
  const sectionKeys = Object.keys(sections);
  const lookup = new Map();
  for (const k of sectionKeys) lookup.set(k.toLowerCase(), k);

  const lines = [];
  const headerName = wisdom.display_name || personaId;
  lines.push(`=== PERSONA WISDOM · ${headerName} (distilled corpus, ${wisdom.distilled || 'undated'}) ===`);
  lines.push('');
  lines.push('This block overlays the TUTOR PERSONA register above with corpus-derived voice priors. The string register tells you HOW to teach; this block tells you the corpus from which that register was distilled. Honor the priors below — but the STUDENT block and the CHARACTER CONTRACT still outrank this overlay.');

  const seen = new Set();
  let surfacedCount = 0;
  for (const want of SURFACED) {
    const k = lookup.get(want.toLowerCase());
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const body = String(sections[k] || '').trim();
    if (!body) continue;
    lines.push('');
    lines.push(`-- ${k} --`);
    // Soft cap: 1200 chars per section keeps the overlay block under ~6KB
    // even for chatty personas. Far more important is keeping the order
    // (identity → moves → hedge → limits → idiolect) than the absolute
    // length; the LLM will pick up cadence from this much prose easily.
    lines.push(body.length > 1200 ? body.slice(0, 1200).trimEnd() + ' …' : body);
    surfacedCount += 1;
  }

  if (surfacedCount === 0) return { block: '', status: wisdom.status };

  lines.push('');
  lines.push('=== END PERSONA WISDOM ===');
  return { block: lines.join('\n'), status: wisdom.status };
}

// v0.2 Surface Finishing Track B B2 — render the pre-lesson body v2 brief
// (thesis + canonical_example + 2 misconceptions + exit_proof) as a LESSON
// BRIEF block. Reads vault/<slug>/lesson-<idx>.body.json. Returns '' when
// the body file is absent (graceful no-op — designLesson falls through to
// today's v0.4 grounding-only behaviour). When present, the tutor reads
// its own prep notes BEFORE the chat opens, anchoring the turn in a
// concrete thesis instead of "winging an overview".
function _buildLessonBriefBlock(slug, idx) {
  if (!slug) return '';
  if (!Number.isFinite(idx) || idx < 0) return '';
  let body = null;
  try {
    const vault = require('./lib/vault');
    const persisted = vault.readJSON(`${slug}/lesson-${idx}.body.json`, null);
    body = persisted && persisted.body;
  } catch (_) { return ''; }
  if (!body || typeof body !== 'object') return '';
  if (!body.thesis) return '';

  const lines = [];
  lines.push(`LESSON BRIEF (your own prep — read first, anchor every turn here):`);
  lines.push(`  thesis: ${String(body.thesis).trim()}`);

  // R-DIDACTIC (2026-05-13) — surface knowledge_points list + relation edges
  // so HOOK 首轮 can render the 减法 骨架 instead of falling back to narrative.
  // Source priority: body.knowledge_points (v0.3+ KP arc schema) → KP arc
  // sidecar at vault/<slug>/lesson-N.kp-arcs.json (post-curriculum:approve_and_body)
  // → final fallback to skeleton lessonPlan slot's own title/learn_goal (legacy).
  // Tutor sees a numbered list it MUST enumerate verbatim per learn-start.txt
  // HOOK · DIDACTIC TEMPLATE.
  let kpList = null;
  if (Array.isArray(body.knowledge_points) && body.knowledge_points.length > 0) {
    kpList = body.knowledge_points;
  } else {
    try {
      const vault2 = require('./lib/vault');
      const arcs = vault2.readJSON(`${slug}/lesson-${idx}.kp-arcs.json`, null);
      if (arcs && Array.isArray(arcs.arcs) && arcs.arcs.length > 0) {
        kpList = arcs.arcs.map(a => ({
          id: a.id || a.kp_id,
          title: a.title || (a.kp_seed && a.kp_seed.title) || '',
          prereq_ids: a.prereq_ids || (a.connects_to_prev || []).map(c => c.target_kp_id || c),
          relations: (a.connects_to_next || []).map(c => ({ target: c.target_kp_id, relation: c.relation })),
        }));
      }
    } catch (_) { /* sidecar absent — fall through */ }
  }
  if (Array.isArray(kpList) && kpList.length > 0) {
    lines.push(`  knowledge_points (本节减法后的骨架 — HOOK 必须列出全部, EXPOSE/EXTEND 逐个进):`);
    kpList.slice(0, 9).forEach((kp, i) => {
      const id = kp.id || `kp-${i + 1}`;
      const title = String(kp.title || '').trim() || '(untitled)';
      const prereq = Array.isArray(kp.prereq_ids) && kp.prereq_ids.length
        ? `prereq: ${kp.prereq_ids.slice(0, 3).join(', ')}`
        : 'prereq: 无';
      lines.push(`    ${i + 1}. ${id}: ${title} — ${prereq}`);
    });
    // relation edges — across KPs, name relation type
    const edges = [];
    kpList.forEach(kp => {
      (kp.relations || []).slice(0, 3).forEach(r => {
        if (r && r.target) edges.push({ from: kp.id, to: r.target, rel: r.relation || '推出' });
      });
    });
    if (edges.length > 0) {
      lines.push(`  relation_edges (knowledge_points 间关系, HOOK 第 3 段挑 2-3 条说):`);
      edges.slice(0, 6).forEach(e => {
        lines.push(`    - ${e.from} --(${e.rel})--> ${e.to}`);
      });
    }
  }

  if (body.canonical_example) {
    lines.push(`  canonical_example: ${String(body.canonical_example).replace(/\s+/g, ' ').trim().slice(0, 400)}`);
  }
  if (Array.isArray(body.common_misconceptions) && body.common_misconceptions.length) {
    lines.push(`  common_misconceptions:`);
    body.common_misconceptions.slice(0, 2).forEach((m, i) => {
      lines.push(`    ${i + 1}. ${String(m).replace(/\s+/g, ' ').trim().slice(0, 250)}`);
    });
  }
  // W1.4 Misconception Engine — surface classified wrong-priors with category
  // labels + cross-lesson wrong-priors learned in prior courses on this topic.
  // The 4 categories (wrong_analogy / surface_understanding / dangerous_
  // simplification / pseudo_understanding) cue the tutor to choose the right
  // repair strategy when one fires mid-lesson. Cross-lesson recall reuses
  // misconception data the user already paid for in prior slugs.
  try {
    const mcEngine = require('./lib/misconception-engine');
    const mcVault = require('./lib/misconception-vault');
    const own = mcEngine.extractMisconceptions(body, 'lesson-' + idx);
    const cross = mcVault.crossLessonMisconceptionsForTopic(slug);
    const merged = mcVault.dedupeMisconceptions(own, cross).slice(0, 6);
    if (merged.length > 0) {
      lines.push(`  MISCONCEPTIONS TO PRE-EMPT (4 categories, surface BEFORE the student walks in):`);
      merged.forEach((m, i) => {
        const cat = m.category || 'surface_understanding';
        const sev = m.severity || 'medium';
        const src = m._sourceSlug ? ` [cross-lesson: ${m._sourceSlug}]` : '';
        lines.push(`    ${i + 1}. [${cat} / ${sev}]${src} ${String(m.text || '').slice(0, 200)}`);
      });
    }
  } catch (_) { /* W1.4 engine optional — never block LESSON BRIEF */ }
  if (body.exit_proof) {
    lines.push(`  exit_proof (Feynman test you close on): ${String(body.exit_proof).replace(/\s+/g, ' ').trim().slice(0, 300)}`);
  }
  if (body.mechanism_explanation) {
    lines.push(`  mechanism_in_one_breath: ${String(body.mechanism_explanation).replace(/\s+/g, ' ').trim().slice(0, 400)}`);
  }
  if (Array.isArray(body.jargon_list) && body.jargon_list.length) {
    lines.push(`  jargon_to_introduce: ${body.jargon_list.slice(0, 5).map(j => String(j).replace(/\s+/g, ' ').trim().slice(0, 80)).join(' | ')}`);
  }
  if (body.note_connection && !/first lesson — no prior note/i.test(String(body.note_connection))) {
    lines.push(`  note_connection: ${String(body.note_connection).trim()}`);
  }
  // W3.3 Product Transfer surfacing — body.product_transfer may be either
  // (a) the prep LLM's 1-sentence hint (string, ≤30 words) OR (b) the W3.3
  // post-fill object { content, P, suggested_section }. Either form gets
  // surfaced so the tutor can land the 10th-segment "迁移到你的产品" callout
  // in-conversation when it fits the pulse. Object form wins when both exist.
  const pt = body.product_transfer;
  if (pt && typeof pt === 'object' && typeof pt.content === 'string' && pt.content.trim()) {
    lines.push(`  product_transfer (P=${(pt.P != null ? pt.P.toFixed(2) : 'n/a')}, section=${pt.suggested_section || 'general'}):`);
    lines.push(`    ${pt.content.replace(/\n+/g, '\n    ').slice(0, 800)}`);
  } else if (typeof pt === 'string' && pt.trim()) {
    lines.push(`  product_transfer_hint: ${pt.trim().slice(0, 250)}`);
  }
  lines.push(``);
  lines.push(`Honor this brief. The thesis is the ONE thing this 30-min landed; do NOT broaden into encyclopedia survey. The canonical_example is your recurring anchor — return to it across HOOK→VERIFY→EXTEND. The misconceptions are wrong-priors to surface and correct, not strawmen. The knowledge_points list above IS the HOOK 5-段 template's content for 段 2; the relation_edges feed 段 3.`);
  return lines.join('\n');
}

async function designLesson({ topic, idx, sequence, sources, state, priorNotes, agentProfile, userProfile, archetype, mode, currentState, stateHistory, stakeBlock, transcript, latestUserMsg, lessonTitle, learnGoal }, settings) {
  // v0158q — Hypha Learn opt-in. When mode === 'learn' we render the
  // state-machine + STAKE substrate templates and bypass the classic
  // monolithic prompt below. Every other branch (classic / undefined /
  // anything not 'learn') falls through to the existing path unchanged.
  if (mode === 'learn') {
    const isFirstTurn = !Array.isArray(transcript) || transcript.length === 0;
    const tplName = isFirstTurn ? 'learn-start' : 'learn-turn';
    const tpl = _loadLearnPromptCached(tplName);
    const transcriptStr = (Array.isArray(transcript) && transcript.length)
      ? transcript.map(t => `${t.role === 'assistant' ? 'TUTOR' : 'STUDENT'}: ${t.content || ''}`).join('\n\n')
      : '(no prior turns this session)';
    // 2026-05-08 Phase A — YC root cause fix. Was title-only (~10 lines, 0
    // grounding substance) → tutor fell back to training data, producing the
    // "像 Google 摘要" register the student flagged. Now: BM25-rank against
    // (learnGoal + lesson title + topic), take top 6, render each chapter
    // with its 350-char excerpt body. sources.json already carries 400-char
    // excerpts per chapter (main.js:2098); we just stopped throwing them
    // away. ~1500 tokens of grounding well under context budget.
    const _bm25Query = [
      learnGoal || '',
      (sequence && sequence[idx] && sequence[idx].title) || '',
      topic || '',
    ].filter(Boolean).join(' ').trim();
    const _srcArr = Array.isArray(sources) ? sources : [];
    const _ranked = (_bm25Query && _srcArr.length > 0)
      ? rankSourcesBM25(_srcArr, _bm25Query, 6)
      : _srcArr.slice(0, 6);
    const sourcesList = _ranked.length > 0
      ? _ranked.map((s, i) => {
          const tag = s.sourceType || 'src';
          const title = String(s.title || `Source ${i + 1}`).slice(0, 100);
          const excerpt = String(s.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 350);
          const url = s.url ? ` (${s.url})` : '';
          return `--- Source ${i + 1} [${tag}]: ${title}${url} ---\n${excerpt || '(no excerpt available — cite by title only)'}`;
        }).join('\n\n')
      : '(no sources available — proceed without grounding citations)';
    const priorNotesStr = (Array.isArray(priorNotes) && priorNotes.length)
      ? priorNotes.slice(-3).map(p => `Lesson ${p.idx}: ${(p.body || '').slice(0, 600)}`).join('\n---\n')
      : '(none yet)';
    const studentStateJson = JSON.stringify({
      mastered: (state && state.mastered) || [],
      gaps: (state && state.gaps) || [],
      concepts: (state && state.concepts) || {},
    });
    const vars = {
      TOPIC: topic || '',
      LESSON_TITLE: lessonTitle || (sequence && sequence[idx] && sequence[idx].title) || '',
      LEARN_GOAL: learnGoal || (sequence && sequence[idx] && sequence[idx].learnGoal) || '',
      LESSON_IDX_PLUS_1: String((idx | 0) + 1),
      STUDENT_STATE_JSON: studentStateJson,
      PRIOR_NOTES: priorNotesStr,
      SOURCES_LIST: sourcesList,
      STAKE_BLOCK: stakeBlock || '',
      CURRENT_STATE: currentState || 'HOOK',
      STATE_HISTORY: JSON.stringify(Array.isArray(stateHistory) ? stateHistory : []),
      TRANSCRIPT: transcriptStr,
      LATEST_USER_MSG: latestUserMsg || '',
    };
    let body = tpl;
    for (const [k, v] of Object.entries(vars)) body = body.split(`{{${k}}}`).join(String(v));
    // v0.4 — L2 PEDAGOGY GUARDRAILS + L1 STRUCTURE PRIOR injection.
    // Both blocks append AFTER the rendered template so they don't interfere
    // with template var substitution above. Empty strings when no signal —
    // prompt stays clean for END state / no-courseware curricula.
    const _pedagogyBlock = _buildPedagogyBlock(archetype, currentState);
    const _structurePriorBlock = _buildStructurePriorBlock(_srcArr, _bm25Query);
    // v0.2 Surface Finishing Track B B2 — pre-lesson body v2 brief read from
    // vault/<topic>/lesson-<idx>.body.json (when present). Carries the
    // thesis the tutor must anchor on; STRUCTURE PRIOR + PEDAGOGY GUARDRAILS
    // shape HOW to teach the brief.
    const _lessonBriefBlock = _buildLessonBriefBlock(topic, idx);
    // v0.2 Surface Finishing Track A A2 — Character Contract goes FIRST so
    // it is the tutor's outermost identity frame; everything else (brief,
    // structure prior, pedagogy guardrails) sits INSIDE this frame.
    const _characterContractBlock = _buildCharacterContractBlock(
      (agentProfile && agentProfile.agent_id) || 'mycelium-professor'
    );
    // γ10 (2026-05-15) — distilled persona corpus overlay (learn-mode path).
    // Reads vault/.persona-wisdom/<personaId>.md when present and overlays
    // it AFTER the character contract so the contract stays the outermost
    // frame and the wisdom thickens the voice with corpus-derived priors.
    // No-op (empty block) when the persona has no distilled wisdom yet.
    const _learnPersonaId = (agentProfile && agentProfile.persona) || 'socratic';
    const _learnPersonaWisdom = _buildPersonaWisdomBlock(_learnPersonaId);
    if (_learnPersonaWisdom.block) {
      try {
        const _vw = require('./lib/vault');
        const _slugForEvent = (state && state.slug)
          || (sequence && sequence[0] && sequence[0].slug)
          || (topic ? String(topic).toLowerCase().replace(/[^a-z0-9_-]+/g, '-') : '');
        _vw.appendJSONL('events.jsonl', {
          ts: new Date().toISOString(),
          op: 'persona_wisdom_injected',
          slug: _slugForEvent || null,
          lessonIdx: Number.isFinite(idx) ? idx : null,
          personaId: _learnPersonaId,
          wisdom_status: _learnPersonaWisdom.status,
          mode: 'learn',
        });
      } catch (_) { /* events.jsonl write must never break lesson generation */ }
    }
    // W6.3 Research Radar — pull last-7-days frontier citation block (if any).
    // Anti-feed: lessonCitationHook returns '' when no recent reports exist;
    // we never inject empty noise. designLesson stays the spine; radar only
    // compiles INTO the lesson when there is something to compile.
    let _radarCiteBlock = '';
    try {
      const _radarLib = require('./lib/research-radar');
      const _slug = (state && state.slug)
        || (sequence && sequence[0] && sequence[0].slug)
        || (topic ? String(topic).toLowerCase().replace(/[^a-z0-9_-]+/g, '-') : '');
      if (_slug) {
        const hook = _radarLib.lessonCitationHook(_slug, idx);
        if (hook && hook.ok && hook.citation_block) _radarCiteBlock = hook.citation_block;
      }
    } catch (_) { /* graceful — radar absence must not break lesson generation */ }
    const _appendix = [_characterContractBlock, _learnPersonaWisdom.block, _lessonBriefBlock, _structurePriorBlock, _pedagogyBlock, _radarCiteBlock].filter(Boolean).join('\n\n');
    // Constitution prepended on top so manuscript register + identity gates
    // outrank the learn-mode prompt — same precedence as classic path.
    const _learnFinalPrompt = `${HYPHA_FULL}\n${body}${_appendix ? '\n\n' + _appendix : ''}`;

    // 2026-05-16 consolidation — β20 Context Packer observability hook for
    // learn-mode. Estimates per-block token cost + logs to
    // vault/<slug>/.context-pack-log.jsonl. v0 is observability only; budget
    // enforcement / truncation deferred to v0.5+. Fire-and-forget.
    try {
      const cp = require('./lib/infrastructure/context-packer');
      const _slugForPack = (state && state.slug)
        || (sequence && sequence[0] && sequence[0].slug)
        || (topic ? String(topic).toLowerCase().replace(/[^a-z0-9_-]+/g, '-') : '');
      if (_slugForPack && cp && typeof cp.logPackDecision === 'function') {
        const blocks = [
          { name: 'constitution',       content: HYPHA_FULL || '' },
          { name: 'body',               content: body || '' },
          { name: 'character_contract', content: _characterContractBlock || '' },
          { name: 'persona_wisdom',     content: (_learnPersonaWisdom && _learnPersonaWisdom.block) || '' },
          { name: 'lesson_brief',       content: _lessonBriefBlock || '' },
          { name: 'structure_prior',    content: _structurePriorBlock || '' },
          { name: 'pedagogy',           content: _pedagogyBlock || '' },
          { name: 'radar_cite',         content: _radarCiteBlock || '' },
        ];
        const decision = {
          accepted: blocks.map(b => ({
            name: b.name, included: !!b.content, truncated: false,
            tokens: cp.estimateTokens(b.content || ''),
          })),
          totalTokens: cp.estimateTokens(_learnFinalPrompt),
          budget: 12000,
          overBudget: false,
          warnings: [],
        };
        Promise.resolve(cp.logPackDecision({
          slug: _slugForPack, lessonIdx: Number.isFinite(idx) ? idx : null,
          budget: 12000, blocks: decision.accepted, decision,
        })).catch(() => { /* fire-and-forget */ });
      }
    } catch (_) { /* context-pack observability optional */ }

    return _learnFinalPrompt;
  }

  // v0.9.0 HERMES-style — inject file-based user profile derived from this
  // vault's lesson corpus. Per /tr council 2026-05-02: Hypha's vault IS the
  // personalization corpus; we just need to surface it. Profile lives at
  // <vault>/.hypha/user-profile.md and contains 4 sections (STYLE /
  // GRAVITATION / VOICE / PROJECT). If file is absent, block is empty —
  // tutor falls back to today's behavior. Cold-start derivation triggered
  // separately via main.js IPC `userProfile:rebuild`.
  let hyphaUserProfileBlock = '';
  try {
    const userProfileLib = require('./lib/userProfile');
    const vaultLib = require('./lib/vault');
    const vaultRoot = vaultLib.resolveRoot();
    const profile = userProfileLib.loadProfile(vaultRoot);
    hyphaUserProfileBlock = userProfileLib.formatForPrompt(profile);
  } catch (_) { /* graceful no-op */ }

  // Lacquer Loop P2 PRE-READ PREDICTION — when archetype emphasizes P2 (HIGH/MED),
  // the lesson's first turn must be a prediction prompt, not a probe-of-understanding.
  // P2 emphasis values per app/lib/pedagogy.md: HIGH=2, MED=1, LOW=0, SKIP=-1.
  const p2Emph = (archetype && EMPHASIS[archetype] && typeof EMPHASIS[archetype].P2 === 'number') ? EMPHASIS[archetype].P2 : 0;
  const target = sequence[idx];
  // v0158m P6 PRIOR-INSTALL — when archetype is concept-dense AND the central
  // concept has no anchor in state.concepts / priorNotes, P6 SUPERSEDES P2/P4
  // first-turn invocation. Pure-Socratic on novel concept = mathematical noise
  // extraction (I(answer; question) ≈ 0 when learner's prior is uniform).
  // Hybrid trigger: frontmatter concept_id check + LLM self-judge fallback.
  const p6Emph = (archetype && EMPHASIS[archetype] && typeof EMPHASIS[archetype].P6 === 'number') ? EMPHASIS[archetype].P6 : 0;
  const conceptId = (target && target.conceptId) || null;
  const conceptState = (state && state.concepts && conceptId) ? state.concepts[conceptId] : null;
  const userSkipped = !!(conceptState && conceptState.user_skipped);
  const userForceExpose = !!(conceptState && conceptState.user_force_expose);
  const conceptIntroduced = !!(conceptState && conceptState.introduced_at);
  // priorNotes mention check — coarse but cheap. Match concept_id token in any prior body.
  const conceptInPriors = !!(conceptId && priorNotes.some(p =>
    (p.body || '').toLowerCase().includes(conceptId.toLowerCase())
  ));
  const p6Active = p6Emph >= 1
    && !userSkipped
    && (userForceExpose || (!conceptIntroduced && !conceptInPriors));
  // When concept_id is missing (legacy course frontmatter), let the LLM self-judge
  // novelty by surfacing the directive as a soft instruction in the system prompt.
  const p6FallbackToLLMJudge = p6Emph >= 1 && !conceptId && !userSkipped;
  // P2 only fires when P6 isn't active (information-theoretic priority).
  const p2Active = (p2Emph >= 1) && !p6Active;
  const priorSummary = priorNotes.slice(-3).map(p => `Lesson ${p.idx}: ${(p.body || '').slice(0, 600)}`).join('\n---\n') || '(none yet)';
  const stateSummary = JSON.stringify({ mastered: state.mastered || [], gaps: state.gaps || [] });

  // Tutor persona — defaults to Socratic if no agent.json exists.
  // Persona prompts hand-authored in app/lib/personas.js.
  const personas = require('./lib/personas');
  const personaId = (agentProfile && agentProfile.persona) || 'socratic';
  const persona = personas.getPersona(personaId);
  const customInstructions = (agentProfile && agentProfile.customInstructions || '').trim();
  // Tutor display name precedence: per-curriculum agent.json.displayName >
  // global profile.tutorName > persona.label > generic "tutor". This lets
  // the user set "Andrej" in the colophon and the LLM self-introduces by
  // that name everywhere unless they override per-curriculum.
  const perCurriculumTutorName = (agentProfile && typeof agentProfile.displayName === 'string')
    ? agentProfile.displayName.trim() : '';
  const globalTutorName = (userProfile && typeof userProfile.tutorName === 'string')
    ? userProfile.tutorName.trim() : '';
  const tutorDisplayName = perCurriculumTutorName || globalTutorName || persona.label || 'tutor';
  const studentName = (userProfile && typeof userProfile.name === 'string')
    ? userProfile.name.trim()
    : '';
  const studentAbout = (userProfile && typeof userProfile.about === 'string')
    ? userProfile.about.trim()
    : '';
  // Two separate blocks so the LLM treats name (factual addressing) and about
  // (register / depth signal) differently. The "do not quote back" line on
  // the about block prevents the LLM from awkwardly mirroring the student's
  // self-description in early turns (Claude-style framing).
  const studentBlock = (studentName || studentAbout)
    ? [
        '',
        studentName
          ? `Student's name: ${studentName}. Address them by this name when natural — opening / pivot moments / sincere praise — but don't sprinkle it in every paragraph (sounds artificial).`
          : null,
        studentAbout
          ? `Student's self-introduction (they wrote this themselves):\n"""\n${studentAbout}\n"""\nUse it to tailor register, depth, examples, and references. Do NOT quote it back at them; absorb it as context.`
          : null,
        '',
      ].filter(Boolean).join('\n')
    : '';

  // v0.6.2 — per-curriculum LLM response language. Stored at state.language.
  // When set, every tutor turn complies. Empty = LLM picks naturally from topic.
  const curriculumLanguage = (state && typeof state.language === 'string') ? state.language.trim() : '';
  const languageBlock = curriculumLanguage
    ? `\nRESPONSE LANGUAGE OVERRIDE (binding): respond to the student in ${curriculumLanguage}, regardless of the topic's natural language or the student profile's language. Exception: if the student explicitly switches languages mid-conversation or asks for a different language for a specific term, honor their immediate request — but return to ${curriculumLanguage} for the next turn unless they sustain the switch.\n`
    : '';

  // 2026-05-02 — Lacquer Loop W2: per-turn pedagogical moves block.
  // designSequence handles curriculum-level (W1); this is the runtime form.
  const turnTimeMovesBlock = _buildTurnTimeMoves(archetype);

  // v0.4 — L2 PEDAGOGY GUARDRAILS + L1 STRUCTURE PRIOR for classic mode.
  // Mirrors learn-mode injection above. Classic mode lacks an explicit
  // currentState so we treat first-lesson as HOOK; mid-curriculum lessons
  // default to EXTEND/CONNECT mid-stage by approximating from priorNotes
  // length (more priors → later stage → CONNECT/LATCH-leaning weights).
  const _classicStage = (priorNotes && priorNotes.length >= 4) ? 'CONNECT' : ((idx | 0) === 0 ? 'HOOK' : 'EXTEND');
  const _classicPedagogyBlock = _buildPedagogyBlock(archetype, _classicStage);
  const _classicQuery = [target?.learnGoal || '', target?.title || '', topic || ''].filter(Boolean).join(' ').trim();
  const _classicSrcArr = Array.isArray(sources) ? sources : [];
  const _classicStructurePriorBlock = _buildStructurePriorBlock(_classicSrcArr, _classicQuery);
  // v0.2 Track B B2 — also for classic mode (legacy path), append LESSON BRIEF.
  const _classicLessonBriefBlock = _buildLessonBriefBlock(topic, idx);
  // v0.2 Track A A2 — Character Contract for classic mode, parallel to
  // learn-mode. Same contract; same outermost-frame ordering.
  const _classicCharacterContractBlock = _buildCharacterContractBlock(
    (agentProfile && agentProfile.agent_id) || 'mycelium-professor'
  );
  // γ10 (2026-05-15) — distilled persona corpus overlay (classic-mode path).
  // Parallel to learn-mode injection above. The TUTOR PERSONA block (string
  // register, hand-authored in personas.js) stays as the in-prompt spine;
  // this overlay supplies corpus-derived voice priors when a wisdom file is
  // available. classic-cli pure passthrough path (streamTurn line ~3956
  // drops the system prompt entirely) does NOT see this overlay — TODO:
  // when classic-cli regains a structured persona injection path, copy this
  // wisdom block into the user-msg layer there too.
  const _classicPersonaWisdom = _buildPersonaWisdomBlock(personaId);
  if (_classicPersonaWisdom.block) {
    try {
      const _vw = require('./lib/vault');
      const _slugForEvent = (state && state.slug)
        || (sequence && sequence[0] && sequence[0].slug)
        || (topic ? String(topic).toLowerCase().replace(/[^a-z0-9_-]+/g, '-') : '');
      _vw.appendJSONL('events.jsonl', {
        ts: new Date().toISOString(),
        op: 'persona_wisdom_injected',
        slug: _slugForEvent || null,
        lessonIdx: Number.isFinite(idx) ? idx : null,
        personaId,
        wisdom_status: _classicPersonaWisdom.status,
        mode: 'classic',
      });
    } catch (_) { /* events.jsonl write must never break lesson generation */ }
  }
  const _classicAppendix = [_classicCharacterContractBlock, _classicPersonaWisdom.block, _classicLessonBriefBlock, _classicStructurePriorBlock, _classicPedagogyBlock].filter(Boolean).join('\n\n');

  const _classicFinalPrompt = `${HYPHA_FULL}${languageBlock}You are a tutor inside Hypha. You are teaching one specific lesson now.

Your name (as the student knows you): ${tutorDisplayName}. When self-introducing or signing off, use this name; don't reveal the underlying model name unless asked directly.

Topic: ${topic}
This lesson (#${idx + 1}): ${target?.title || 'Untitled'}
Learn goal: ${target?.learnGoal || ''}

${hyphaUserProfileBlock}═══ STUDENT (read FIRST — every other instruction below defers to this) ═══${studentBlock || `
(no student profile provided — assume average adult learner, calibrate via first turn)
`}
HARD RULE: The persona below is HOW you teach; this student profile is WHO you're teaching. WHO determines the depth ceiling. If the student says they have no foundation / are a beginner / lack prerequisites, you DO NOT introduce gradients, backprop math, matrix calculus, advanced framework APIs, or jargon UNTIL after concept-level intuition lands. The persona's hardcore register MUST be re-interpreted to fit this student. Karpathy-to-a-beginner = explain neurons as "weighted vote" before any sigma notation. Strang-to-a-beginner = picture vectors as arrows before any rank/null-space. If student profile is silent, calibrate from their first answer.
══════════════════════════════════════════════════════════════════════════

═══ TUTOR PERSONA (adopt this register, but always at the depth the STUDENT block above allows) ═══
${persona.prompt}
${customInstructions ? `\nAdditional instructions (curriculum-specific):\n${customInstructions}\n` : ''}
══════════════════════════════════════════════════════════════════════════

Student persistent state:
${stateSummary}

Recent prior notes (the student wrote these themselves; honor what they already know):
${priorSummary}

Available sources (cite by name, do not invent):
${(() => {
  // 2026-05-08 Phase A — same fix as learn path (BM25 + excerpts). Classic
  // mode kept in parity so legacy callers benefit too. Empty-sources branch
  // returns an explicit fallback string so the prompt stays well-formed.
  const q = [target?.learnGoal || '', target?.title || '', topic || ''].filter(Boolean).join(' ').trim();
  const arr = Array.isArray(sources) ? sources : [];
  const ranked = (q && arr.length > 0) ? rankSourcesBM25(arr, q, 6) : arr.slice(0, 6);
  if (ranked.length === 0) return '(no sources available — proceed without grounding citations)';
  return ranked.map((s, i) => {
    const tag = s.sourceType || 'src';
    const title = String(s.title || `Source ${i + 1}`).slice(0, 100);
    const excerpt = String(s.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 350);
    const url = s.url ? ` (${s.url})` : '';
    return `--- Source ${i + 1} [${tag}]: ${title}${url} ---\n${excerpt || '(no excerpt available — cite by title only)'}`;
  }).join('\n\n');
})()}
${turnTimeMovesBlock}
Universal rules (overlay on top of the persona above):
${p6Active ? `1. **P6 PRIOR-INSTALL** (THIS LESSON'S OPENER MUST INSTALL THE CONCEPT'S PRIOR — concept "${conceptId}" has no anchor in state.concepts and is not mentioned in priorNotes; archetype ${archetype} marks P6 as ${p6Emph === 2 ? 'HIGH' : 'MED'}). Open with the 4-stage exposition arc BEFORE any probe / prediction / inquiry. **DENSITY PER STAGE IS BINDING** — total opening 600-1200 字 (中文) or 250-500 words (English). Thin stage = noise. Match Claude-Code-terminal depth.
   (1) **DEFINE** — 2-4 paragraphs. Name + plain definition + ENUMERATE the concept's main forms / sub-types / variants when they exist (e.g., 'leverage' has 4 forms: labor / capital / code / media — name each with a 1-line characterization; 'Q/K/V' = three matrices, name each role + their relationship). Hand the student a structured map, not a tease line.
   (2) **ANALOGIZE** — 2-4 paragraphs. Concrete analogy that gives the concept a body, **plus at least one numerical instance OR A-vs-B structural contrast**. Example: '你 1 万自有, 借 9 万凑 10 万买股票 → 涨 10% 还本金 9 万 → 手里 2 万 (100% 回报); 不借 1 万 → 同样涨 10% 只赚 1000 (10% 回报). 同样市场动一格, 你的钱包动十格.' Include the contrast.
   (3) **CHECK** — pose ONE concrete instance test that REQUIRES the learner to compute / specify / predict — NOT 'what do you think?' or 'does that make sense?'. Examples: '如果上面那笔 10 万跌 10%, 你手里剩多少？算给我看' / 'Q 完全不匹配任何 K 时, attention 输出是什么？给个具体场景'. **WAIT for the learner's reply BEFORE proceeding to EXTEND** — do not pre-emptively answer your own CHECK in the same turn.
   (4) **EXTEND** — fires ONLY after the learner replies to CHECK. Then introduce the next deeper layer with its own mini-arc (mini-define → mini-instance → connect to prior). For leverage this is asymmetric companion concepts (Permissioned vs Permissionless / Power Law / Barbell strategy) presented as 'now that 杠杆 lands, here's the twin you also need: 不对称回报...'. Density: 2-4 paragraphs. Optionally close with a Feynman-back invitation.
   ⚠ Information-theoretic justification: pre-prior probes carry I(answer; question) ≈ 0 — they extract noise. Saying MORE on the foundation triggers MORE effective thinking.
   ⚠ EMIT in your FIRST turn the marker line: \`<!-- p6: introduced concept_id=${conceptId || 'INFERRED'} -->\` so lesson:finish can persist state.concepts.
   ⚠ Do NOT fire P2 (prediction) or P4 (scaffolded inquiry) on a brand-new concept — they require a non-uniform prior to be informative. P6 supersedes them on the first turn.` : (p6FallbackToLLMJudge ? `1. **P6 GATE (LLM self-judge)** — this lesson lacks a concept_id field; archetype ${archetype} marks P6 as ${p6Emph === 2 ? 'HIGH' : 'MED'}. JUDGE: is the central concept of this lesson genuinely new to the student (not mentioned in priorNotes / state.concepts / student profile)? IF YES → run the 4-stage P6 arc (DEFINE → ANALOGIZE → CHECK → EXTEND); emit \`<!-- p6: introduced concept_id=<your-best-guess-kebab-id> -->\` on the FIRST turn. IF NO → fall back to rule below.
   FALLBACK (concept already known): ${p2Active ? 'Open with ONE prediction prompt (P2).' : 'Open with ONE concept-level probe question.'}` : (p2Active ? `1. **P2 PRE-READ PREDICTION** (THIS LESSON'S OPENER MUST BE A PREDICTION PROMPT — archetype ${archetype} emphasizes prediction; the concept is already in state.concepts so the learner has a non-uniform prior to predict against). Open with ONE prediction prompt — ask the student to FORECAST the lesson's central claim/mechanism BEFORE you reveal anything. Frame it as a guess, not a test. Do NOT reveal canonical until they respond. Capture verbatim ("You said: X") and EXPLICITLY compare to canonical.` : `1. Open with ONE question that probes current understanding of the lesson goal AT THE LEVEL THE STUDENT BLOCK INDICATES. No preamble. No "Welcome".`))}
2. After student's answer, re-calibrate depth (hit / miss / partial). Adapt — but never assume prerequisites the student profile did not claim.
3. **DEPTH LATCHING** — match output length to the moment, not a fixed cap. When the student asks for substance (explain / walk through / distill / 详细 / 深入 / 解释), deliver at full Claude-Code-terminal depth, then one question at the end. When the student asserts a claim (probe-target), brief Q-back to sharpen it. Persona-specific overrides apply (Lewin = longer prose; Sandel = stricter dialogue).
4. When student says something insightful, name it explicitly so the dual-layer note can capture it as 用户灵感.
5. Reference prior notes when relevant.
6. End the lesson when learn goal is met OR student signals "ready". Never artificially extend.
7. If you catch yourself using a term the student profile suggests they don't know, stop mid-sentence and rewrite — never push through with a "you'll learn this later" handwave.
7. NEVER use the words: AI, LLM, embedding, model, prompt, agent, RAG, vector. You are the teacher, not a tool.

Begin now.${_classicAppendix ? '\n\n' + _classicAppendix : ''}`;

  // 2026-05-16 consolidation — β20 Context Packer observability hook for
  // classic-mode (parallel to learn-mode at line ~3549). Fire-and-forget log
  // of per-block token cost. v0 observability only; truncation/budget
  // enforcement deferred to v0.5+. Slug resolved best-effort.
  try {
    const cp = require('./lib/infrastructure/context-packer');
    const _slugForPack = (state && state.slug)
      || (sequence && sequence[0] && sequence[0].slug)
      || (topic ? String(topic).toLowerCase().replace(/[^a-z0-9_-]+/g, '-') : '');
    if (_slugForPack && cp && typeof cp.logPackDecision === 'function') {
      const blocks = [
        { name: 'constitution',       content: HYPHA_FULL || '' },
        { name: 'language_block',     content: languageBlock || '' },
        { name: 'character_contract', content: _classicCharacterContractBlock || '' },
        { name: 'persona_wisdom',     content: (_classicPersonaWisdom && _classicPersonaWisdom.block) || '' },
        { name: 'lesson_brief',       content: _classicLessonBriefBlock || '' },
        { name: 'structure_prior',    content: _classicStructurePriorBlock || '' },
        { name: 'pedagogy',           content: _classicPedagogyBlock || '' },
      ];
      const decision = {
        accepted: blocks.map(b => ({
          name: b.name, included: !!b.content, truncated: false,
          tokens: cp.estimateTokens(b.content || ''),
        })),
        totalTokens: cp.estimateTokens(_classicFinalPrompt),
        budget: 12000,
        overBudget: false,
        warnings: [],
      };
      Promise.resolve(cp.logPackDecision({
        slug: _slugForPack, lessonIdx: Number.isFinite(idx) ? idx : null,
        budget: 12000, blocks: decision.accepted, decision,
      })).catch(() => { /* fire-and-forget */ });
    }
  } catch (_) { /* context-pack observability optional */ }

  return _classicFinalPrompt;
}

// Machino-α8 (2026-05-15) — Anti-Slop post-stream sequential complaint loop.
// Wires 3 backend-only detector modules (citation-verifier / pedagogy-claim /
// confidence-leak) + anti-illusion + Prosecute-Judge-Rewrite over the freeform
// tutor reply. Runs sequentially after ingratiation scrub (not in chunk path).
// Result attaches to streamTurn return as `antiSlop`; caller (main.js) decides
// whether to persist `rewritten` over `cleaned` and emit to renderer.
// Never throws — all failures are wrapped non-fatal.
async function _runAntiSlopPostStreamScan({ text, slug, lessonIdx, settings, sourceGrounded, archetype }) {
  if (!text || typeof text !== 'string' || !text.trim()) return null;
  try {
    const citVerifier = require('./lib/anti-slop/citation-verifier');
    const pedDetector = require('./lib/anti-slop/pedagogy-claim-detector');
    const confLeak = require('./lib/anti-slop/confidence-leak-detector');
    const metaphorDetector = require('./lib/anti-slop/metaphor-as-structure-detector');
    let antiIllusion = null;
    try { antiIllusion = require('./lib/anti-illusion'); } catch (_) { antiIllusion = null; }
    const pjr = require('./lib/anti-slop/prosecute-judge-rewrite');

    // Machino-α9 (2026-05-15) — resolve archetype for detector tuning.
    // Priority: explicit caller param > vault/<slug>/state.json.archetype >
    // 'TECH-CONCEPT' (strict default). Read-only; never mutates state.json.
    let resolvedArchetype = (typeof archetype === 'string' && archetype.trim())
      ? archetype.trim()
      : null;
    if (!resolvedArchetype && slug) {
      try {
        const vaultMod = require('./lib/vault');
        const st = vaultMod.readJSON(`${slug}/state.json`, null);
        if (st && typeof st.archetype === 'string' && st.archetype.trim()) {
          resolvedArchetype = st.archetype.trim();
        }
      } catch (_) { /* state.json unreadable → keep null → strict fallback below */ }
    }
    if (!resolvedArchetype) resolvedArchetype = 'TECH-CONCEPT';

    const ctx = { is_source_grounded: !!sourceGrounded, archetype: resolvedArchetype };

    // Sequential — post-stream is not in UI hot path; saves API budget vs parallel race.
    let citR = null, pedR = null, confR = null, illR = null, metaphorR = null;
    try { citR = slug ? await citVerifier.verifyCitations(text, slug, { archetype: resolvedArchetype }) : null; }
    catch (e) { console.warn('[anti-slop post-stream] citation-verifier failed:', e && e.message); }
    try { pedR = pedDetector.detectPedagogyClaims(text); }
    catch (e) { console.warn('[anti-slop post-stream] pedagogy-claim-detector failed:', e && e.message); }
    try { confR = confLeak.detectConfidenceLeaks(text, ctx); }
    catch (e) { console.warn('[anti-slop post-stream] confidence-leak-detector failed:', e && e.message); }
    try {
      if (antiIllusion && typeof antiIllusion.detectIllusion === 'function') {
        illR = antiIllusion.detectIllusion(text, {});
      }
    } catch (e) { console.warn('[anti-slop post-stream] anti-illusion failed:', e && e.message); }
    // Phase D.0 (2026-05-18) — metaphor-as-structure detector. Council verdict:
    // metaphor without paired forcing function = entertainment, not transformation.
    try { metaphorR = metaphorDetector.detectMetaphorAsStructure(text, { archetype: resolvedArchetype }); }
    catch (e) { console.warn('[anti-slop post-stream] metaphor-as-structure failed:', e && e.message); }

    const signals = {
      citations: citR && citR.summary,
      pedagogy: pedR && pedR.summary,
      confidence: confR && confR.summary,
      illusion: illR,
      metaphor: metaphorR && metaphorR.summary,
    };

    // Surface scan metrics to events.jsonl so UI Trust Panel / future audits
    // see scan happened even when nothing fired.
    try {
      const eventSlug = slug || '_global';
      events.write(eventSlug, {
        type: 'anti_slop_post_stream_scan',
        op: 'anti_slop_post_stream_scan',
        lesson_slug: slug || null,
        lesson_idx: Number.isFinite(lessonIdx) ? lessonIdx : null,
        archetype: resolvedArchetype,
        cit_unverified: citR && citR.summary ? citR.summary.unverified : 0,
        cit_no_source: citR && citR.summary ? citR.summary.no_source : 0,
        cit_unsourced_allowed: citR && citR.summary && Number.isFinite(citR.summary.unsourced_allowed) ? citR.summary.unsourced_allowed : 0,
        ped_unknown: pedR && pedR.summary ? pedR.summary.unknown : 0,
        ped_inconsistent: pedR && pedR.summary ? pedR.summary.inconsistent : 0,
        conf_leak_count: confR && confR.summary ? confR.summary.leak_count : 0,
        illusion_detected: !!(illR && illR.illusion_detected),
        illusion_type: illR && illR.illusion_type ? illR.illusion_type : null,
        metaphor_verdict: metaphorR && metaphorR.summary ? metaphorR.summary.verdict : null,
        metaphor_count: metaphorR && metaphorR.summary ? metaphorR.summary.metaphor_count : 0,
        metaphor_unsupported_count: metaphorR && metaphorR.summary ? metaphorR.summary.unsupported_count : 0,
        metaphor_force_pair_ratio: metaphorR && metaphorR.summary ? metaphorR.summary.force_pair_ratio : 1,
      });
    } catch (err) {
      console.warn('[anti-slop post-stream] scan-event write failed:', err && err.message);
    }

    // Run Prosecute-Judge-Rewrite freeform path. MVP: math-derived severity +
    // T6_STRONG rewrite only on mid/high. `pjrResult.rewritten` is null when
    // nothing needs change OR rewrite was rejected (length guard / LLM err).
    // Machino-β9 (2026-05-15) — pass archetype so PJR can gate rewriting
    // (HUMANITIES never rewrites, LANG-ACQ/MINDSET only at 'high' severity).
    let pjrResult = null;
    try {
      pjrResult = await pjr.runProsecuteJudgeOnFreeform({ text, signals, settings, slug, archetype: resolvedArchetype });
    } catch (err) {
      console.warn('[anti-slop post-stream] PJR failed:', err && err.message);
    }

    // β9 — if the archetype gate suppressed a would-be rewrite, emit a
    // distinct event so the UI knows signals fired but PJR honored archetype.
    if (pjrResult && pjrResult.verdict && pjrResult.verdict.gated_by_archetype) {
      try {
        const eventSlug = slug || '_global';
        events.write(eventSlug, {
          type: 'anti_slop_rewrite_gated_by_archetype',
          op: 'anti_slop_rewrite_gated_by_archetype',
          lesson_slug: slug || null,
          lesson_idx: Number.isFinite(lessonIdx) ? lessonIdx : null,
          severity: pjrResult.verdict.severity,
          focus_axes: pjrResult.verdict.focus_axes,
          archetype: pjrResult.verdict.archetype_used || null,
        });
      } catch (err) {
        console.warn('[anti-slop post-stream] gated-event write failed:', err && err.message);
      }
    }

    // If a rewrite actually landed, mark it so transcript / downstream see it.
    if (pjrResult && pjrResult.rewritten) {
      try {
        const eventSlug = slug || '_global';
        events.write(eventSlug, {
          type: 'anti_slop_rewrite_applied',
          op: 'anti_slop_rewrite_applied',
          lesson_slug: slug || null,
          lesson_idx: Number.isFinite(lessonIdx) ? lessonIdx : null,
          severity: pjrResult.verdict && pjrResult.verdict.severity,
          focus_axes: pjrResult.verdict && pjrResult.verdict.focus_axes,
          archetype: (pjrResult.verdict && pjrResult.verdict.archetype_used) || resolvedArchetype || null,
          provider: pjrResult.provider || null,
          model: pjrResult.model || null,
        });
      } catch (err) {
        console.warn('[anti-slop post-stream] rewrite-event write failed:', err && err.message);
      }
    }

    return {
      signals,
      verdict: pjrResult && pjrResult.verdict,
      rewritten: pjrResult && pjrResult.rewritten,
      rewrite_skipped_reason: pjrResult && pjrResult.rewrite_skipped_reason,
      rewrite_error: pjrResult && pjrResult.rewrite_error,
    };
  } catch (err) {
    console.warn('[anti-slop post-stream] outer failure (non-fatal):', err && err.message);
    return null;
  }
}

async function streamTurn({ systemPrompt, history, userMsg, settings, signal, resumeSessionId, onSessionId, currentLesson, goalContract, slug, lessonIdx, archetype }, onChunk) {
  // 2026-05-05 (Appendix D) — claude-cli session continuity. When
  // resumeSessionId is set, the model has its own history via --resume; we
  // skip transcript replay and send ONLY the current user message. Approaches
  // native Terminal `claude` experience.
  const isResumePath = !!resumeSessionId;

  // W2.3 Goal Guardian + Affective Router. Scan the current user turn
  // (cheap regex, <1ms, no network) + last 2 user turns from history. When
  // a non-on_track state fires, prepend an italic Garamond modifier to the
  // system prompt so THIS reply (tutor's response to the user's message)
  // adopts the gentler tone / lower difficulty. State row is best-effort
  // appended to events.jsonl by the IPC handler — agent.js path swallows
  // failures silently so guardian never breaks the tutor stream.
  let _guardianAmendedSystem = systemPrompt;
  try {
    if (userMsg && userMsg !== '__begin__') {
      const router = require('./lib/affective-router');
      const guardian = require('./lib/goal-guardian');
      const recentUserHistory = (history || []).filter(h => h && h.role === 'user').slice(-2).map(h => ({ role: 'user', text: h.content || '' }));
      const recentTurns = [...recentUserHistory, { role: 'user', text: userMsg }];
      const state = guardian.assessGuardianState({
        userTrace: { recentTurns },
        goalContract: goalContract || null,
        currentLesson: currentLesson || null,
        slug, lessonIdx,
      });
      if (state && state.state && state.state !== 'on_track') {
        const intervention = guardian.decideIntervention(state.state, currentLesson || null);
        if (intervention && intervention.prompt_modifier) {
          _guardianAmendedSystem = `${systemPrompt}\n\n[GUARDIAN ${state.state.toUpperCase()} · diff=${intervention.difficulty_adjust}]\n${intervention.prompt_modifier}`;
          try {
            const _vaultMod = require('./lib/vault');
            _vaultMod.appendJSONL('events.jsonl', { ts: new Date().toISOString(), op: 'guardian_prompt_injected', slug: slug || null, lesson_idx: Number.isFinite(lessonIdx) ? lessonIdx : null, state: state.state, signals: (state.affect && state.affect.signals) || [], guardian_action: state.guardian_action, difficulty_adjust: intervention.difficulty_adjust });
          } catch (_) {}
        }
      }
    }
  } catch (_) { /* guardian failure must never break tutor stream */ }

  // 2026-05-16 consolidation — Privacy Memory scrub pass on userMsg + history
  // BEFORE messages leave Hypha boundary. Redactions live at vault/data/
  // privacy-memory.jsonl (global, not per-slug). _scrubOne is best-effort: if
  // the privacy module errors or has no rows, original text passes through.
  // Streamed reply (model → user) NOT scrubbed here — that's anti-ingratiation
  // territory. This boundary protects only outbound user-authored text.
  const _scrubOne = async (text) => {
    if (typeof text !== 'string' || !text.length) return text;
    try {
      const pm = require('./lib/infrastructure/privacy-memory');
      const r = await pm.scrubText({ text });
      if (r && r.ok && typeof r.scrubbed === 'string') return r.scrubbed;
    } catch (_) { /* swallow; never break tutor stream */ }
    return text;
  };

  const messages = [];
  if (!isResumePath) {
    messages.push({ role: 'system', content: _guardianAmendedSystem });
    for (const h of (history || [])) {
      const scrubbedContent = h && h.role === 'user' ? await _scrubOne(h.content) : h.content;
      messages.push({ role: h.role, content: scrubbedContent });
    }
  }
  if (userMsg && userMsg !== '__begin__') {
    const scrubbedUserMsg = await _scrubOne(userMsg);
    messages.push({ role: 'user', content: scrubbedUserMsg });
  }
  else if (!isResumePath) messages.push({ role: 'user', content: '[Lesson start. Begin with your first question.]' });

  // 2026-05-02 — accumulate the full reply transparently so we can run
  // persona-leak detection after the stream ends without coupling onChunk's
  // callers to leak logic. Wrap the user-supplied onChunk.
  let _accumulated = '';
  const _wrappedOnChunk = (text) => {
    _accumulated += text;
    onChunk(text);
  };
  // 2026-05-14 (Audit-B fix) — ingratiation scrub captured here so streamTurn
  // can return { cleaned, violations } to caller. Caller persists `cleaned`
  // into vault/<slug>/sessions/L<idx>-<ts>.jsonl assistant turn. Streamed
  // chunks (renderer) still see uncleaned text — real-time chunk-level scrub
  // deferred to v0.4 (SSE protocol change). Until then: post-stream transcript
  // + downstream consumers (confession / extract-from-lesson / re-stream
  // prompts) see the clean version.
  let _scrubResult = { clean_text: '', violations: [] };
  const _runIngratiationScan = () => {
    _scrubResult = _detectAndLogIngratiation(_accumulated, settings, { context: 'tutor_turn', lesson_slug: slug, lesson_idx: lessonIdx })
      || { clean_text: _accumulated, violations: [] };
  };

  // Machino-α8 (2026-05-15) — post-stream anti-slop scan + PJR loop. Runs once
  // per turn after ingratiation scrub completes. Result attaches to streamTurn
  // return so the caller can persist `rewritten` text into transcript / emit
  // `anti-slop:scan-complete` to renderer. Never throws.
  let _antiSlopResult = null;
  const _runAntiSlopScan = async () => {
    const baseText = (_scrubResult && _scrubResult.clean_text) || _accumulated;
    if (!baseText || !baseText.trim()) { _antiSlopResult = null; return; }
    _antiSlopResult = await _runAntiSlopPostStreamScan({
      text: baseText,
      slug,
      lessonIdx,
      settings,
      // is_source_grounded — let confidence-leak relax assertive penalties when
      // the curriculum has user-supplied sources.json (course context).
      sourceGrounded: !!slug,
      // β9 (2026-05-15) — archetype routes PJR rewrite gate: HUMANITIES never
      // rewrites, LANG-ACQ/MINDSET only at 'high' severity; tech/decl-mass strict.
      archetype,
    });
  };

  // P10 (boot-4, 2026-05-19) — Companion emotion-tone bridge. Composes W3.5
  // 6-trigger schema with rolling emotion-state classifier. Suppression matrix:
  // BOUNDARY_PROTECT + lesson_complete/product_spark_sprout → silent. Escalation
  // matrix: BOUNDARY + interrupt_resume → over_grind. Fires only when this turn
  // looks like an interrupt-resume (user came back to an in-progress lesson —
  // history has prior turns AND userMsg is real AND not the synthetic __begin__).
  // Other W3.5 triggers (lesson_complete / finish_capture / product_spark_sprout /
  // note_revival) fire from main.js paths, NOT streamTurn — keeps Lens 9 SURGICAL.
  // Graceful fallback: bridge throws OR returns !ok → companionExpression = null,
  // never breaks the tutor stream.
  let _companionExpression = null;
  const _runCompanionCompose = async () => {
    try {
      if (!userMsg || userMsg === '__begin__') return;
      const priorAssistantTurns = (history || []).filter(h => h && h.role === 'assistant').length;
      if (priorAssistantTurns <= 0) return;
      const bridge = require('./lib/companion/emotion-tone-bridge');
      const recentUserQuestions = (history || []).filter(h => h && h.role === 'user').map(h => h.content || '');
      const verdict = await bridge.composeExpression({
        trigger: 'interrupt_resume',
        sessionContext: {
          currentText: userMsg,
          recentQuestions: recentUserQuestions,
          turnCount: (history || []).length,
        },
      });
      if (!verdict || verdict.ok !== true) return;
      _companionExpression = {
        suppressed: !!verdict.suppressed,
        effective_trigger: verdict.effective_trigger || null,
        emotion: verdict.emotion || null,
        emotion_signal: verdict.emotion_signal || null,
        register: (verdict.bias && verdict.bias.register) || null,
        expression: verdict.suppressed ? null : (verdict.expression || null),
        reason: verdict.reason || null,
      };
    } catch (err) {
      console.warn('[streamTurn] companion compose failed (non-fatal):', err && err.message);
      _companionExpression = null;
    }
  };

  // 2026-05-02 — Anthropic SDK direct branch. Cleanest Opus output;
  // no Claude Code persona context.
  const _cfg = _resolveProviderConfig(settings);
  if (_cfg && _cfg.via === 'sdk-anthropic') {
    try {
      await anthropicAdapter.runStream(messages, settings, _wrappedOnChunk, { signal });
    } catch (err) {
      console.error('[streamTurn] sdk-anthropic stream failed:', err && err.message);
      throw err;
    } finally {
      _detectAndLogPersonaLeak(_accumulated, settings, { context: 'tutor_turn' });
      _runIngratiationScan();
      _logMethodTag(_accumulated, settings, { context: 'tutor_turn' });
    }
    await _runAntiSlopScan();
    await _runCompanionCompose();
    return { accumulated: _accumulated, cleaned: _scrubResult.clean_text || _accumulated, violations: _scrubResult.violations || [], antiSlop: _antiSlopResult, companion: _companionExpression };
  }

  // CLI provider branch — Claude Max / Gemini CLI shell-out streaming.
  if (_isCliProvider(settings)) {
    // 2026-05-05 (Appendix C) — pure passthrough for claude-cli. User wants
    // Hypha's claude-cli tutor turns to feel like Terminal claude-cli (newly
    // installed Claude Code in an empty folder). Drop Hypha's tutor system
    // prompt so Claude Code's default system takes over. Sandbox env still
    // blocks Victor universe / global agents. Other CLI binaries (gemini-cli,
    // codex-cli) keep their existing flow — user only flagged claude-cli.
    // 2026-05-05 (Appendix D) — Plus session continuity via --resume.
    const _cliCfgForPure = _resolveProviderConfig(settings);
    const _isClaudeCli = !!(_cliCfgForPure && _cliCfgForPure.binary
      && /^claude(\b|-)/i.test(_cliCfgForPure.binary));

    // 2026-05-16 consolidation — cliPureMode strips the system prompt, which
    // discards the PERSONA WISDOM block. Extract that block from the system
    // prompt and prepend it to the first user message so claude-cli still
    // sees the distilled corpus register. Resume turns (resumeSessionId set)
    // skip this — the wisdom has already been injected on the lesson-open
    // turn and persisted in claude-cli's --resume history.
    if (_isClaudeCli && !isResumePath && Array.isArray(messages)) {
      try {
        const wisdomMatch = _guardianAmendedSystem.match(
          /=== PERSONA WISDOM[\s\S]*?=== END PERSONA WISDOM ===/
        );
        if (wisdomMatch) {
          const wisdomBlock = wisdomMatch[0];
          const firstUserIdx = messages.findIndex(m => m && m.role === 'user');
          if (firstUserIdx >= 0) {
            messages[firstUserIdx] = {
              role: 'user',
              content: `${wisdomBlock}\n\n${messages[firstUserIdx].content || ''}`,
            };
          }
        }
      } catch (_) { /* wisdom injection optional; never break CLI path */ }
    }

    try {
      await _runCliStream(messages, settings, _wrappedOnChunk, {
        signal,
        cliPureMode: _isClaudeCli,
        resumeSessionId: _isClaudeCli ? resumeSessionId : null,
        onSessionId: _isClaudeCli ? onSessionId : null,
      });
    } catch (err) {
      console.error('[streamTurn] cli stream failed:', err && err.message);
      throw err;
    } finally {
      _detectAndLogPersonaLeak(_accumulated, settings, { context: 'tutor_turn' });
      _runIngratiationScan();
      _logMethodTag(_accumulated, settings, { context: 'tutor_turn' });
    }
    await _runAntiSlopScan();
    await _runCompanionCompose();
    return { accumulated: _accumulated, cleaned: _scrubResult.clean_text || _accumulated, violations: _scrubResult.violations || [], antiSlop: _antiSlopResult, companion: _companionExpression };
  }

  const c = client(settings);
  let stream;
  try {
    stream = await c.chat.completions.create({
      model: settings.model || 'glm-5',
      messages,
      stream: true,
      temperature: 0.8,
      // 2026-05-08 — was 1500. Caused mid-sentence truncation on rich HOOK
      // turns (P6 4-stage opener spec demands 600-1200 字 中文 ≈ 800-1600
      // tokens; pre-v0.4 was already at the cap, v0.4 PEDAGOGY GUARDRAILS
      // density push tipped it over). Raised to 4000 to match designSequence
      // (agent.js:2080) and give headroom for full HOOK + state markers
      // + question + closing. Cost impact negligible — most turns finish
      // well below this; the cap only matters for outliers.
      max_tokens: 4000,
    }, signal ? { signal } : undefined);
  } catch (err) {
    console.error('[streamTurn] create failed:', err && err.message, err && err.status, err && err.error);
    throw new Error('create failed: ' + (err && err.message || err));
  }

  let chunkCount = 0;
  let lastError = null;
  try {
    for await (const part of stream) {
      const delta = part && part.choices && part.choices[0] && part.choices[0].delta;
      if (!delta) continue;
      // GLM-5 + Claude (thinking mode) emit reasoning_content separately from
      // content. Visible content goes through delta.content. Reasoning is
      // currently dropped (per Day 2 plan) — student sees questions, not CoT.
      if (delta.content) {
        _wrappedOnChunk(delta.content);
        chunkCount++;
      }
      // Future: surface reasoning_content into a collapsed pane if user asks.
    }
  } catch (err) {
    console.error('[streamTurn] iteration failed:', err && err.message, 'chunks so far:', chunkCount);
    lastError = err;
  }
  if (chunkCount === 0 && !lastError) {
    // Stream finished cleanly but emitted zero visible chunks — likely all
    // content went into reasoning_content (some providers + thinking mode).
    // Fall back to non-streaming call to retrieve the answer.
    console.error('[streamTurn] zero content chunks; falling back to non-streaming');
    try {
      const r = await c.chat.completions.create({
        model: settings.model || 'glm-5',
        messages,
        stream: false,
        temperature: 0.8,
        max_tokens: 1500,
      });
      const text = r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content;
      if (text) _wrappedOnChunk(text);
    } catch (err) {
      console.error('[streamTurn] non-streaming fallback also failed:', err && err.message);
      _detectAndLogPersonaLeak(_accumulated, settings, { context: 'tutor_turn' });
      _runIngratiationScan();
      _logMethodTag(_accumulated, settings, { context: 'tutor_turn' });
      throw err;
    }
  } else if (lastError) {
    _detectAndLogPersonaLeak(_accumulated, settings, { context: 'tutor_turn' });
    _runIngratiationScan();
    throw lastError;
  }
  _detectAndLogPersonaLeak(_accumulated, settings, { context: 'tutor_turn' });
  _runIngratiationScan();
  await _runAntiSlopScan();
  await _runCompanionCompose();
  return { accumulated: _accumulated, cleaned: _scrubResult.clean_text || _accumulated, violations: _scrubResult.violations || [], antiSlop: _antiSlopResult, companion: _companionExpression };
}

async function synthesizeNote({ topic, idx, transcript, sources, sequence, mode, priorBody }, settings) {
  const target = sequence[idx];
  const tx = (transcript || []).map(t => `${t.role === 'user' ? 'You' : 'Tutor'}: ${t.content}`).join('\n\n');
  const sourceList = sources.slice(0, 8).map(s => `- ${s.title}`).join('\n');

  // Continuation mode — student revisits an already-graduated lesson. Their
  // 课程基础 stays as-is; we ONLY emit a new 用户灵感 paragraph(s) capturing
  // what THIS revisit added on top of what they already wrote down.
  if (mode === 'continuation') {
    const priorExcerpt = (priorBody || '').slice(0, 4000);
    const sys = `${HYPHA_FULL}You write a SHORT 用户灵感 paragraph (1-2 paragraphs, ≤180 words total) for a student REVISITING a lesson they've already graduated from. The original course foundation (课程基础) and prior insights (用户灵感) are below — preserve their voice + register, but capture ONLY what this revisit added on top.

Output: 1-2 paragraphs in second person ("you"). Plain prose. No headers. No frontmatter. No "Here is the insight:". Just the paragraph(s).

Rules:
- Reference the prior 课程基础 / 用户灵感 only as needed to anchor the new insight; do NOT restate them.
- Pull a verbatim quote or two from the new dialog where the student said something fresh.
- If the new dialog yielded NO new insight (just review of old material), say so honestly in one sentence and stop.
- Forbidden words: AI, LLM, embedding, agent, model, prompt, RAG, vector, fine-tune.
- Garamond-cadence prose. Sentences that breathe.`;

    const user = `Lesson: ${target?.title || ''}
Topic: ${topic}

Prior note (for context only — do not restate):
${priorExcerpt}

This revisit's dialog:
${tx}

Write the new 用户灵感 paragraph(s) now.`;

    return await llmJSON([{ role: 'system', content: sys }, { role: 'user', content: user }], settings, { temperature: 0.7, max_tokens: 1000, timeoutMs: 180_000 });
  }

  // Fresh distill — Lacquer Loop multi-layer note. 2026-05-03: replaces
  // 2-section (课程基础 + 用户灵感) with 6 primitive-derived sections per
  // app/lib/pedagogy.md (5 retained P1-P5 + 3 frontier F1-F3 + A1-A3
  // substrate). Each section is OPTIONAL — emit only if that primitive
  // actually fired in the dialog. The note becomes a training log of the
  // user's specific cognitive trace, not a generic summary.
  const sys = `${HYPHA_FULL}You write a Lacquer Loop study note from a tutoring dialog. Output ONE markdown document with frontmatter + UP TO 6 sections, each tagged with the pedagogical primitive it embodies.

Strict frontmatter:
---
topic: ${topic}
lesson_idx: ${idx}
lesson_title: ${(target?.title || '').replace(/"/g, "'")}
date: ${new Date().toISOString().slice(0, 10)}
---

# ${target?.title || 'Lesson'}

Then emit ONLY the sections below that genuinely fired in the dialog. Each section header MUST include its <!--method:Pn--> tag so downstream tools can audit primitive coverage.

## 课程基础 <!--method:P1-->
1-3 plain-language paragraphs. The conceptual core of the lesson, source-faithful. No jargon the student doesn't already use. ALWAYS emit this section (even short).

## 你的预测 → 实际 <!--method:P2-->
ONLY if the dialog contains a prediction prompt + the student's verbatim guess + the actual answer. Format: > 你预测: "..." \\n > 实际: "..." \\n delta: 一句话说为何差距/吻合. SKIP this section if no prediction exchange happened.

## 回想检验 <!--method:P3-->
ONLY if the tutor asked cue prompts (concept name / scenario / mechanism question) and student tried to recall before being shown the answer. Format: > 提示: ... \\n > 你说: ... \\n > 标准: ... \\n match: 0-1. List 1-3 retrieval attempts. SKIP if dialog was pure exposition with no cue-recall exchange.

## 你提的问题 <!--method:P4-->
ONLY if the student volunteered a substantive question that the tutor scaffolded. Quote the question verbatim, note depth (surface/structural/frontier), then 1 sentence on how the tutor framed before answering. SKIP for purely tutor-led lessons.

## 失败先行 <!--method:F1-->
ONLY if the student attempted a hard problem BEFORE seeing the canonical method, and the attempt failed. Format: > 你尝试: ... \\n > 为何不通: ... \\n > 标准方法: 一句话. The failure trace is the value — preserve it. SKIP if no fail-first attempt.

## 用户灵感 <!--method:user-->
1-3 paragraphs in second person ("你"). What THIS specific student noticed, connected to other notes, half-formed insights worth coming back to. Pull verbatim quotes where the student said something fresh. ALWAYS emit this section — half the note's value lives here.

Rules across all sections:
- Garamond-cadence prose. Sentences that breathe.
- No "Here is the note:" / "I will now write..." preamble.
- Forbidden words anywhere: AI, LLM, embedding, agent, model, prompt, RAG, vector, fine-tune.
- If a section is optional and didn't fire, OMIT THE HEADER ENTIRELY (don't write "(none)").`;

  const user = `Sources used in this lesson:
${sourceList}

Dialog:
${tx}

Write the note now.`;

  let raw = await llmJSON([{ role: 'system', content: sys }, { role: 'user', content: user }], settings, { temperature: 0.6, max_tokens: 2000, timeoutMs: 180_000 });
  // 2026-05-03 — strip ONLY claude-cli agent-crew leaks. User-set names
  // (settings.userProfile.name + .tutorName) are intentional address and
  // must NEVER be stripped. Earlier version wrongly flagged "Machino" (user's
  // actual name) as leak.
  raw = _stripPersonaPreamble(raw, settings);
  return raw;
}

// Remove claude-cli agent-crew greetings (e.g. "Lung online.", "Victor here.")
// that bleed past the --system-prompt flag. Walks from the top, drops up to
// 8 lines until a markdown heading. NEVER strips lines that mention the
// user's own name or tutor name from settings.userProfile — those are the
// intentional address Hypha asked for in the system prompt. Conservative —
// never strips past the first header so real distill content is preserved.
function _stripPersonaPreamble(text, settings) {
  if (!text) return text;
  const profile = settings && settings.userProfile;
  const userName = profile && profile.name ? String(profile.name).trim().toLowerCase() : '';
  const tutorName = profile && profile.tutorName ? String(profile.tutorName).trim().toLowerCase() : '';
  // Agent crew names that signal Claude Code persona leak. "Victor" included
  // unless user claimed it. Generic user-name greetings (e.g. "Machino，") are
  // NOT stripped — that's correct address.
  const crewNames = ['Lung', 'Leo', 'Yogo', 'Muse', 'MEOW', 'Wolf', 'Nancy', 'Ghost', 'TATA', 'SONCAR', 'QAQ'];
  if (userName !== 'victor' && tutorName !== 'victor') crewNames.push('Victor');
  const crewRE = new RegExp('\\b(' + crewNames.join('|') + ')\\b', 'i');
  const lines = text.split('\n');
  let cutAt = -1;
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const ln = lines[i].trim();
    if (!ln) continue;
    if (/^#{1,3}\s/.test(ln) || /^---/.test(ln)) break; // hit real content
    if (crewRE.test(ln)) { cutAt = i; }
  }
  if (cutAt < 0) return text;
  let rest = lines.slice(cutAt + 1);
  while (rest.length && !rest[0].trim()) rest.shift();
  return rest.join('\n');
}

async function updateState({ state, transcript, note, idx, sequence }, settings) {
  const tx = (transcript || []).map(t => `${t.role}: ${t.content}`).join('\n').slice(0, 6000);
  const sys = `You update a learner's persistent state after a lesson. Output JSON only.

Schema:
{ "mastered": [string], "gaps": [string], "preferences": object }

- mastered: append concept tags the student demonstrably understood this lesson
- gaps: append concept tags they fumbled, kept asking about, or that need revisit
- preferences: keep prior preferences, update only if student stated one explicitly
- DO NOT include lastIdx — that's set elsewhere
- 5-15 entries per array, deduplicated against existing state`;

  const user = `Existing state:
${JSON.stringify(state)}

Lesson #${idx + 1}: ${sequence[idx]?.title || ''}

Note:
${note.slice(0, 2500)}

Dialog tail:
${tx.slice(-2000)}

Output JSON.`;

  const raw = await llmJSON([{ role: 'system', content: sys }, { role: 'user', content: user }], settings, { json: true, temperature: 0.3 });
  try {
    const parsed = JSON.parse(raw);
    return {
      mastered: Array.isArray(parsed.mastered) ? parsed.mastered : (state.mastered || []),
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps : (state.gaps || []),
      preferences: parsed.preferences || state.preferences || {},
    };
  } catch (_) {
    return state;
  }
}

async function evolveAgainstZeitgeist(noteBody, settings) {
  const today = new Date().toISOString().slice(0, 10);
  const sys = `You write ONE paragraph (3-5 sentences) that places a study note against today's intellectual frontier. Today: ${today}.

- Concrete. Name specific 2025-2026 papers, products, or debates relevant to the note.
- No banned words: AI, LLM, embedding, agent, model, prompt, RAG.
- No throat-clearing. Open with the connection, not "This note relates to..."
- If the note already feels timeless, say so in one sentence and stop.`;
  return await llmJSON([{ role: 'system', content: sys }, { role: 'user', content: `Note:\n${noteBody.slice(0, 4000)}\n\nWrite the paragraph.` }], settings, { temperature: 0.7, max_tokens: 400 });
}

async function crossPollinate(notes, settings) {
  const corpus = notes.slice(0, 12).map(n => `### ${n.name}\n${(n.body || '').slice(0, 1200)}`).join('\n\n');
  const sys = `You find non-obvious cross-domain fusions between study notes. Output JSON: { "fusions": [ { "noteA": filename, "noteB": filename, "fusion": one sentence connecting them in a way neither note states alone } ] }.

- 3-7 fusions max.
- Bias toward distant-domain pairs (e.g. linear algebra ∩ poetry > matrix ∩ tensor).
- If fewer than 2 notes are interesting, return { "fusions": [] }.
- No banned words: AI, LLM, embedding, agent, model, prompt, RAG.`;
  const raw = await llmJSON([{ role: 'system', content: sys }, { role: 'user', content: corpus }], settings, { json: true, temperature: 0.85, max_tokens: 1200 });
  try { return JSON.parse(raw).fusions || []; } catch (_) { return []; }
}

async function weeklyReport(events, settings) {
  const summary = events.slice(-150).map(e => `${e.ts?.slice(0, 16)} ${e.op}${e.topic ? ` ${e.topic}` : ''}${e.idx !== undefined ? `#${e.idx}` : ''}`).join('\n');
  const sys = `You write a one-page weekly study report in markdown. Sections: ## Coverage / ## Quality of attention / ## Open questions / ## Suggested next.

- Quote actual lesson titles and topics from the event log.
- Honest. If a topic was started and abandoned, say so.
- No filler. No banned words: AI, LLM, embedding, agent, model, prompt, RAG.`;
  return await llmJSON([{ role: 'system', content: sys }, { role: 'user', content: `Events this week:\n${summary || '(no events yet)'}` }], settings, { temperature: 0.5, max_tokens: 1500 });
}

// Concept Atlas Phase A.1 — per-turn concept extraction (council 2026-05-01).
// Given the previous atlas + new turn text + lesson context, returns a delta
// describing newly introduced concepts, references to existing ones, and (for
// user turns) which existing concepts the user "settled" by using correctly.
//
// Council 3-layer synthesis: this is the SUBSTRATE layer. Verb-graph
// (expectation-violation) annotations come in A.2 as additive layer; opt-in
// challenge mode (Sic et Non) comes in A.3 as register layer.
async function extractAtlasDelta({ prevAtlas, turnText, role, lessonContext }, settings) {
  const prevConcepts = (prevAtlas && prevAtlas.concepts) || {};
  const prevExpected = (prevAtlas && prevAtlas.expected) || [];
  const knownTerms = Object.keys(prevConcepts);
  const knownAltForms = knownTerms.flatMap(t => (prevConcepts[t].alt_forms || []));
  const turnIdx = (prevAtlas && prevAtlas.turn_count) || 0;

  const sys = `You extract concept atlas updates from one tutoring conversation turn.

Lesson title: ${lessonContext.lesson_title || ''}
Learn goal: ${lessonContext.learn_goal || ''}

Atlas already tracks these concept terms (do NOT re-introduce; recognize alt-forms):
${knownTerms.length ? knownTerms.map(t => `- ${t} (alt: ${(prevConcepts[t].alt_forms || []).slice(0, 3).join(', ') || 'none'})`).join('\n') : '(empty atlas)'}

Already expected-but-not-yet covered:
${prevExpected.length ? prevExpected.map(e => `- ${e.term}`).join('\n') : '(none)'}

This turn (#${turnIdx}) is by the ${role}.

Output STRICT JSON only:
{
  "introduced": [
    { "term": "<canonical term>", "alt_forms": ["<form1>", "<form2>"], "snippet": "<<=80 chars from turn>", "category": "<definition|procedure|relation|instance>" }
  ],
  "referenced": [
    { "term": "<existing canonical from atlas>" }
  ],
  "settled_by_user": [
    { "term": "<existing canonical>", "rationale": "<<=60 chars on why correct usage>" }
  ],
  "expected_uncovered": [
    { "term": "<concept tutor PROMISED or learn_goal IMPLIES but not yet introduced>", "reason": "<<=40 chars>" }
  ]
}

Rules:
- "introduced": only if term is not in atlas + not an alt-form of existing term. Match aggressively to existing terms (Nash equilibrium / 纳什均衡 / Nash 均衡 = same).
- "referenced": atlas terms (or alt-forms) that this turn mentions again.
- "settled_by_user": ONLY when role=user AND user uses an atlas term in CORRECT context (not just parroted). Include rationale. If role=tutor, leave [].
- "expected_uncovered": concepts the LEARN GOAL or tutor's earlier promises imply will be needed but haven't been introduced yet. Be conservative — max 3.
- If turn is empty / off-topic / just acknowledgment → return all empty arrays.
- Output VALID JSON. No markdown fences. No prose.`;

  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: `Turn text:\n"""\n${turnText}\n"""` },
  ];

  let raw;
  try {
    raw = await llmJSON(messages, settings, { json: true, temperature: 0.2, max_tokens: 800 });
  } catch (err) {
    console.error('[extractAtlasDelta] LLM call failed:', err && err.message);
    return { introduced: [], referenced: [], settled_by_user: [], expected_uncovered: [], _debug: 'llm_failed:' + (err && err.message || err) };
  }
  let delta;
  try { delta = JSON.parse(raw); }
  catch (e) {
    console.error('[extractAtlasDelta] JSON parse failed; raw=' + (raw || '').slice(0, 200));
    return { introduced: [], referenced: [], settled_by_user: [], expected_uncovered: [], _debug: 'parse_failed:' + e.message + ':raw=' + (raw || '').slice(0, 300) };
  }
  const out = {
    introduced: Array.isArray(delta.introduced) ? delta.introduced : [],
    referenced: Array.isArray(delta.referenced) ? delta.referenced : [],
    settled_by_user: Array.isArray(delta.settled_by_user) ? delta.settled_by_user : [],
    expected_uncovered: Array.isArray(delta.expected_uncovered) ? delta.expected_uncovered : [],
  };
  // 2026-05-03 diagnostic: if all 4 arrays empty, attach raw response (truncated)
  // for the events log to surface. Helps diagnose whether LLM returned empty
  // shape vs returned something the parser couldn't extract concepts from.
  const totalConcepts = out.introduced.length + out.referenced.length + out.settled_by_user.length + out.expected_uncovered.length;
  if (totalConcepts === 0) {
    out._debug = 'all_empty:raw=' + (raw || '').slice(0, 400);
  }
  return out;
}

// Lacquer Loop W6 — Learning Chain Planner. Three small LLM classifiers + one
// chain-design call. Council 2026-05-01 (Yogo / Leo / Scout) calibrated formulas
// in app/lib/feasibility.js; this layer turns user-facing inputs (goal text +
// answers) into the numeric inputs that classifier consumes.
async function classifyDifficulty(goal, settings) {
  // v0.6.1 — inject the calibrated student profile so difficulty scoring
  // can adjust for the learner's actual baseline (e.g. "PhD-level" framing
  // for an experienced ML researcher means something different than for
  // a high-schooler). Empty block when no profile present.
  const profileBlock = userProfileBlock(settings && settings.userProfile);
  const sys = `${HYPHA_SHORT}${profileBlock}Score the cognitive difficulty of mastering the user's learning goal at the level they describe. Output JSON: { "score": float 0..1, "rationale": string }.

Calibration anchors:
- 0.0 = grade-school basics
- 0.3 = high-school / vocational survival
- 0.5 = undergraduate proficiency
- 0.7 = graduate research
- 0.85 = doctoral / GPT-tier theoretical threshold (field-credible practitioner)
- 1.0 = open research frontier (publishing original work)

Heuristics:
- "frontier" / "research" / "GPT-tier" / "PhD-level" → 0.85+
- "intro" / "basics" / "for beginners" / "survival" → ≤ 0.3
- "professional" / "production" / "fluent" → 0.5-0.7
- Default to 0.5 if ambiguous.

Return JSON only.`;
  const user = `Goal: ${goal}`;
  try {
    const raw = await llmJSON(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      settings,
      { json: true, temperature: 0.2, max_tokens: 200 }
    );
    const p = JSON.parse(raw);
    return { score: Math.max(0, Math.min(1, Number(p.score) || 0.5)), rationale: p.rationale || '' };
  } catch (_) { return { score: 0.5, rationale: 'classify failed' }; }
}

async function classifyIntrinsicLoad(goal, settings) {
  // v0.6.1 — inject the calibrated student profile. Element interactivity
  // is partly relative: a transformer's interlocked components feel "high"
  // to a novice but "med" to a researcher who already chunks them. Profile
  // block lets the model calibrate against the learner's actual baseline.
  const profileBlock = userProfileBlock(settings && settings.userProfile);
  const sys = `${HYPHA_SHORT}${profileBlock}Classify the cognitive ELEMENT INTERACTIVITY (Sweller 1988 / Likourezos 2024) of the topic. Element interactivity = how many concepts/elements MUST be processed simultaneously.

Output JSON: { "load": "low"|"med"|"high", "rationale": string }.

- low (multiplier 1.0): isolated facts, vocabulary, procedural recipes. Examples: foreign-language vocab, anatomy taxonomy, history dates, cooking technique.
- med (multiplier 1.5): related but separable rules / patterns. Examples: programming syntax, basic accounting, organic chemistry mechanisms, historical narrative analysis.
- high (multiplier 2.0): heavily interdependent abstract systems where every concept references multiple others simultaneously. Examples: category theory, advanced quantum mechanics, transformer architectures (attention/positional/loss interlocked), Goedel incompleteness, large-scale distributed systems.

Return JSON only.`;
  const user = `Topic: ${goal}`;
  try {
    const raw = await llmJSON(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      settings,
      { json: true, temperature: 0.1, max_tokens: 200 }
    );
    const p = JSON.parse(raw);
    const load = ['low', 'med', 'high'].includes(p.load) ? p.load : 'med';
    return { load, rationale: p.rationale || '' };
  } catch (_) { return { load: 'med', rationale: 'classify failed' }; }
}

// _findRelevantProbe — v0.6.1. Pick the most topic-relevant probe from
// profile.probes[]. Uses Jaccard-ish overlap of ≥3-char tokens between
// probe.topic and goal. Returns the best match if its overlap covers ≥30%
// of the probe's tokens, else null. Falls back to legacy profile.probe
// (singular) when profile.probes is not an array. Internal helper —
// not exported so callers can't depend on the heuristic shape.
function _findRelevantProbe(profile, goal) {
  if (!profile) return null;
  const probes = Array.isArray(profile.probes)
    ? profile.probes
    : (profile.probe ? [profile.probe] : []);
  if (probes.length === 0) return null;
  const goalLower = String(goal || '').toLowerCase();
  const goalTokens = new Set(
    goalLower.split(/\W+/).filter(t => t && t.length >= 3)
  );
  let bestProbe = null;
  let bestScore = 0;
  for (const p of probes) {
    if (!p || !p.topic) continue;
    const probeTokens = new Set(
      String(p.topic).toLowerCase().split(/\W+/).filter(t => t && t.length >= 3)
    );
    if (probeTokens.size === 0) continue;
    let overlap = 0;
    for (const t of probeTokens) if (goalTokens.has(t)) overlap += 1;
    const score = overlap / probeTokens.size;
    if (score > bestScore) {
      bestScore = score;
      bestProbe = p;
    }
  }
  return bestScore >= 0.3 ? bestProbe : null;
}

async function classifyPriorKnowledge(goal, answers, settings) {
  const formattedAnswers = (answers || []).map(a =>
    `Q: ${a.question}\nA: ${Array.isArray(a.answer) ? a.answer.join(', ') : a.answer}`
  ).join('\n\n');
  const profile = settings && settings.userProfile;
  const profileBlock = userProfileBlock(profile);
  // v0.6.1 — profile.probes[] is an array of recent probes (newest first, max 5).
  // Legacy profile.probe (singular, most-recent copy) is still honored as a
  // back-compat fallback. Only surface a probe if its topic actually overlaps
  // with the current goal — otherwise the calibrated baseline is for an
  // UNRELATED topic and would mislead the prior. _findRelevantProbe handles
  // both shapes + the relevance filter.
  const probe = _findRelevantProbe(profile, goal);
  const probeClause = (probe && typeof probe.score === 'number') ? `

PROBE RESULTS (calibrated baseline ON THE TOPIC "${probe.topic}" — use as PRIMARY signal over self-introduction when the topic matches):
- Score: ${Math.round(probe.score * 100)}% (${probe.correctCount || 0}/${probe.total || 0})
- Band: ${probe.band || 'unknown'}
Map band → score: novice → 0.05-0.20, foundational → 0.20-0.40, intermediate → 0.40-0.65, advanced → 0.65-0.90.

NOTE: this probe is on "${probe.topic}" — if the current GOAL "${goal}" is unrelated, fall back to the prose self-introduction signal instead.` : '';
  const sys = `${HYPHA_SHORT}${profileBlock}${probeClause}Given a learning GOAL and the student's self-reported BACKGROUND, score how close they currently are to the goal. Use the STUDENT PROFILE block above (if present) as the PRIMARY signal — the answers below are supplementary disambiguators, not the baseline. Output JSON: { "score": float 0..1, "rationale": string, "missing_prerequisites": [string] }.

Closeness calibration:
- 0.0 = total novice (no relevant background at all)
- 0.3 = adjacent fundamentals (math/CS literacy but no domain)
- 0.5 = solid foundations (could pass an undergraduate course in adjacent topic)
- 0.7 = ready (only the goal-specific domain remains)
- 1.0 = already there

missing_prerequisites: list 2-5 specific topics they must master before the goal. Each = 2-6 words, CONCRETE (e.g. "linear algebra: eigendecomposition", NOT "math basics"). Order by foundational-first.

Return JSON only.`;
  const user = `Goal: ${goal}\n\nStudent self-report:\n${formattedAnswers}`;
  try {
    const raw = await llmJSON(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      settings,
      { json: true, temperature: 0.3, max_tokens: 600 }
    );
    const p = JSON.parse(raw);
    return {
      score: Math.max(0, Math.min(1, Number(p.score) || 0.2)),
      rationale: p.rationale || '',
      missing_prerequisites: Array.isArray(p.missing_prerequisites) ? p.missing_prerequisites : [],
    };
  } catch (_) { return { score: 0.2, rationale: 'classify failed', missing_prerequisites: [] }; }
}

// classifyAll — 2026-05-03 perf optimization. Merges classifyDifficulty +
// classifyIntrinsicLoad + classifyPriorKnowledge into ONE LLM call. The 3
// classifiers used to run via Promise.all (3 parallel round-trips, bound by
// slowest ~10-15s on Opus). One call cuts to ~4-6s. Returns the same shape
// as the 3 individual classifiers combined so chain:create can swap in
// without changing downstream consumers.
async function classifyAll(goal, answers, settings) {
  const formattedAnswers = (answers || []).map(a =>
    `Q: ${a.question}\nA: ${Array.isArray(a.answer) ? a.answer.join(', ') : a.answer}`
  ).join('\n\n');
  const profile = settings && settings.userProfile;
  const profileBlock = userProfileBlock(profile);
  const probe = _findRelevantProbe(profile, goal);
  const probeClause = (probe && typeof probe.score === 'number') ? `

PROBE RESULTS (calibrated baseline ON THE TOPIC "${probe.topic}" — use as PRIMARY signal over self-introduction when topic matches):
- Score: ${Math.round(probe.score * 100)}% (${probe.correctCount || 0}/${probe.total || 0})
- Band: ${probe.band || 'unknown'}
Map band → prior_score: novice → 0.05-0.20, foundational → 0.20-0.40, intermediate → 0.40-0.65, advanced → 0.65-0.90.

NOTE: probe is on "${probe.topic}" — if current GOAL "${goal}" is unrelated, fall back to prose self-introduction.` : '';
  const sys = `${HYPHA_SHORT}${profileBlock}${probeClause}Classify the learning task across THREE dimensions in one call. Return JSON only:

{
  "difficulty_score": float 0..1,
  "difficulty_rationale": string,
  "intrinsic_load": "low" | "med" | "high",
  "intrinsic_rationale": string,
  "prior_score": float 0..1,
  "prior_rationale": string,
  "missing_prerequisites": [string]
}

DIFFICULTY anchors:
- 0.0 grade-school basics · 0.3 high-school survival · 0.5 undergrad proficiency · 0.7 grad research · 0.85 doctoral / GPT-tier · 1.0 open frontier
- "frontier"/"PhD-level" → 0.85+ · "intro"/"basics" → ≤0.3 · "professional"/"production" → 0.5-0.7 · default 0.5

INTRINSIC LOAD (Sweller element interactivity, Likourezos 2024):
- low (×1.0): isolated facts/vocabulary/recipes (lang vocab, anatomy taxonomy, cooking)
- med (×1.5): related but separable rules (programming syntax, accounting, organic mechanisms)
- high (×2.0): heavily interdependent abstract systems (category theory, quantum, transformer arch, distributed systems)

PRIOR KNOWLEDGE: how close student is to goal (0=zero foundation, 1=already there). Use STUDENT PROFILE as PRIMARY signal; answers below are supplementary disambiguators. Output missing_prerequisites = list of named knowledge bodies the student lacks for this goal.

Return JSON only, no prose.`;
  const user = `Goal: ${goal}\n\nStudent answers:\n${formattedAnswers || '(none)'}`;
  try {
    const raw = await llmJSON(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      settings,
      { json: true, temperature: 0.2, max_tokens: 600, timeoutMs: 60_000 }
    );
    const p = JSON.parse(raw);
    return {
      difficulty: {
        score: Math.max(0, Math.min(1, Number(p.difficulty_score) || 0.5)),
        rationale: p.difficulty_rationale || '',
      },
      intrinsic: {
        load: ['low', 'med', 'high'].includes(p.intrinsic_load) ? p.intrinsic_load : 'med',
        rationale: p.intrinsic_rationale || '',
      },
      prior: {
        score: Math.max(0, Math.min(1, Number(p.prior_score) || 0.2)),
        rationale: p.prior_rationale || '',
        missing_prerequisites: Array.isArray(p.missing_prerequisites) ? p.missing_prerequisites : [],
      },
    };
  } catch (e) {
    console.error('[classifyAll] failed:', e.message);
    // Fallback to safe defaults — chain:create can still proceed.
    return {
      difficulty: { score: 0.5, rationale: 'classifyAll failed' },
      intrinsic: { load: 'med', rationale: 'classifyAll failed' },
      prior: { score: 0.2, rationale: 'classifyAll failed', missing_prerequisites: [] },
    };
  }
}

// generateProbeMCQ — v0.6.0 Lung's PLACEMENT_PROBE. Issues 5 calibrated
// multiple-choice questions ranging foundational → frontier on the topic, so
// the curriculum can anchor at the actual baseline (vs. the self-introduction
// prose, which under- or over-states routinely). LLM returns each question
// with options including a `correct: boolean` flag. Renderer is expected to
// HOLD the full structure (answers + correctness) for tally; main.js's
// profile:probe IPC may strip `correct` flags before sending to the renderer
// for display, but for v0.6 simplicity we ship the full structure (so the
// renderer can self-grade and report `{questionId, optionId, correct}`
// triples back to scoreProbe).
async function generateProbeMCQ(topic, goal, settings) {
  const profileBlock = userProfileBlock(settings && settings.userProfile);
  const sys = `${HYPHA_SHORT}${profileBlock}Generate 5 calibrated multiple-choice questions to assess a learner's baseline knowledge of "${topic}" so a curriculum can start from the right level. Output JSON: { "questions": [{"id":string, "q":string, "options":[{"id":string,"label":string,"correct":boolean}], "rationale":string}, ...] }.

Hard rules:
- Exactly 5 questions, ranging from foundational (Q1) to frontier (Q5) by difficulty.
- 4 options per question; exactly 1 option has "correct": true.
- "rationale" 1 sentence explaining what skill the question tests.
- For Q5 (frontier), use a 2025-2026 development if domain has one.
- No throwaway tricks. Each question's correct answer is genuinely diagnostic.
- Question text concise (≤ 30 words). Option labels ≤ 12 words each.
Output JSON only.`;
  const user = `Topic: ${topic}\nGoal: ${goal || '(not stated)'}\n\nReturn JSON.`;
  const raw = await llmJSON(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    settings,
    { json: true, temperature: 0.4, max_tokens: 1500, timeoutMs: 30_000, fn: 'generateProbeMCQ' }
  );
  const p = JSON.parse(raw);
  const questions = Array.isArray(p.questions) ? p.questions.slice(0, 5) : [];
  // Defensive normalization: fill missing ids, clamp lengths, coerce correct flag.
  return questions.map((q, i) => ({
    id: q.id || `q${i + 1}`,
    q: String(q.q || '').slice(0, 240),
    options: Array.isArray(q.options) ? q.options.slice(0, 6).map((o, oi) => ({
      id: o.id || `o${oi + 1}`,
      label: String(o.label || '').slice(0, 100),
      correct: o.correct === true,
    })) : [],
    rationale: String(q.rationale || '').slice(0, 200),
  }));
}

// scoreProbe — v0.6.0. Pure tally: renderer self-grades each MCQ (it has the
// `correct` flag from generateProbeMCQ's output) and submits triples
// `[{questionId, optionId, correct}, ...]`. We compute score (correct/total),
// derive a band, and return both. No LLM call — fast deterministic grading.
//
// Bands (used downstream by classifyPriorKnowledge to anchor the prior):
//   < 0.30  → novice
//   < 0.60  → foundational
//   < 0.85  → intermediate
//   ≥ 0.85  → advanced
async function scoreProbe(topic, goal, answers, settings) {
  const list = Array.isArray(answers) ? answers : [];
  const correctCount = list.filter(a => a && a.correct === true).length;
  const total = Math.max(1, list.length);
  const score = correctCount / total;
  const band = score < 0.3 ? 'novice'
    : score < 0.6 ? 'foundational'
    : score < 0.85 ? 'intermediate'
    : 'advanced';
  return { score, band, correctCount, total };
}

async function planChain(goal, ctx, settings) {
  const { tier, pacingTier, ratio, gap, missing_prerequisites, timeWeeks, dailyHours, intrinsicLoad, pComplete, lang, archetype } = ctx;
  // Detect output language: explicit ctx.lang wins; else auto-detect from goal text.
  const detectedLang = (lang === 'zh' || lang === 'en') ? lang
    : (/[一-龥]/.test(String(goal || '')) ? 'zh' : 'en');
  const tierGuidance = {
    'nearly-impossible': 'CONDENSE prerequisites to bare minimum. Accept partial mastery on prereqs. Focus pressure on gap-bridging. Exit criteria LIBERAL. WARN that ambition exceeds time — recommend extending OR accepting intermediate target. Tone = direct + urgent (NOT mocking).',
    'possible': 'BALANCE prerequisite floors with goal pursuit. Regular checkpoints. Exit criteria = passable for next link. Tone = guided + steady.',
    'easy': 'ALLOW deep dives. Exploration encouraged. Exit criteria = mastery. Last link can include extension topics. Tone = Socratic + open.',
  };
  // v0.6.1 — pacing-tier guidance modulates LINK COUNT around the moderate
  // baseline (3-8 in the opening clause). Distinct axis from feasibility-tier
  // above (which modulates tone + warning). pacingTier ∈ {'gentle','moderate',
  // 'heroic'}; absent value defaults to 'moderate' so v0.6.0 callers see no
  // regression — only an extra "Pacing=moderate" guidance line is appended.
  const pTier = (pacingTier === 'gentle' || pacingTier === 'heroic') ? pacingTier : 'moderate';
  const tierGuide = pTier === 'gentle'
    ? '\nPacing="gentle" — prefer the SHORTEST viable chain (3-5 links). Drop optional prerequisites.'
    : pTier === 'heroic'
    ? '\nPacing="heroic" — prefer DEEP scaffolding (6-10 links). Add buffer prerequisites and revisit links.'
    : '\nPacing="moderate" — balanced 4-6 links.';
  const langInstruction = detectedLang === 'zh'
    ? 'OUTPUT LANGUAGE: Chinese (Simplified). All "topic", "rationale", "exit_criterion", "warning", "alternatives.lower_target_to" fields MUST be in Chinese. Match the user\'s register (formal academic Chinese, NOT casual). Numbers + technical terms (eigenvalue, BKT, etc.) may stay in English when natural.'
    : 'OUTPUT LANGUAGE: English. All fields in English.';
  const profileBlock = userProfileBlock(settings && settings.userProfile);
  // v0.6.6 — archetype-aware chain shape. Without the archetype hint, the LLM
  // defaults to operational/scheduling tasks (especially for MINDSET goals
  // where self-help training data dominates). Inject the archetype's frontier
  // window + the corresponding chain-shape so the LLM mirrors the curriculum-
  // level phase template at chain level.
  let chainShapeBlock = '';
  let archetypeFrontierLine = '';
  if (archetype) {
    try {
      const tmpl = loadArchetypeTemplate(archetype);
      if (tmpl && tmpl.frontier_definition && tmpl.frontier_definition.prompt_anchor) {
        archetypeFrontierLine = `Frontier window: ${tmpl.frontier_definition.prompt_anchor}\n`;
      }
    } catch (_) {}
    const SHAPES = {
      'TECH-CONCEPT': 'foundations → tools → mechanisms → frontier → synthesis (ultimate)',
      'TECH-PROC':    'primitives → patterns → tradeoffs → frontier → synthesis (ultimate)',
      'LANG-ACQ':     'phonology → high-frequency → patterns → native register → synthesis (ultimate)',
      'HUMANITIES':   'context → claims → counter-claims → frontier → synthesis (ultimate)',
      'DECL-MASS':    'scaffold → anchor cases → patterns → recent finds → synthesis (ultimate)',
      'MINDSET':      'origin → decisions → heuristics → edge cases → synthesis (ultimate)',
    };
    if (SHAPES[archetype]) {
      chainShapeBlock = `\n═══ ARCHETYPE CHAIN-SHAPE (binding) ═══\nArchetype = ${archetype}\n${archetypeFrontierLine}Per this archetype, the chain prefers shape: ${SHAPES[archetype]}\n═══════════════════════════════════════\n`;
    }
  }

  // v0.6.6 — TECH-PROC is the one archetype where operational/procedural verbs
  // are CORRECT (drill primitives, build artifacts). Other 5 archetypes need
  // knowledge-content links. exit_criterion phrasing branches accordingly.
  const isProceduralArchetype = archetype === 'TECH-PROC' || archetype === 'LANG-ACQ';
  const exitCriterionGuidance = isProceduralArchetype
    ? '- exit_criterion: 1 sentence testable claim — for ' + archetype + ' archetype, a behavior the learner can EXECUTE ("ship a working X app" / "sustain 5-min Y dialogue"). Procedural skill outcome.'
    : '- exit_criterion: 1 sentence testable claim — an EXPLANATION/DERIVATION/ARGUMENT the learner can PRODUCE ("explain X from atoms naming Y theorems" / "argue for/against Z citing N primary sources"). Knowledge outcome, not behavior. Avoid "establish habit", "set up tool", "track progress" — these are infrastructure not knowledge.';

  // v0.6.9 — per-link lesson budget per role with explicit escalation. User
  // 2026-05-02: prereq < core < ultimate; uniform sizing was wrong. tier_mult
  // applies across the board.
  const tierMult = pTier === 'gentle' ? 0.6 : pTier === 'heroic' ? 1.6 : 1.0;
  const lessonRangeByRole = {
    prerequisite: { min: Math.round(25 * tierMult), max: Math.round(50 * tierMult) },
    core:         { min: Math.round(50 * tierMult), max: Math.round(100 * tierMult) },
    ultimate:     { min: Math.round(80 * tierMult), max: Math.round(150 * tierMult) },
  };
  const lessonsCountGuide = `\n═══ PER-LINK LESSON COUNT (binding — escalation is mandatory) ═══
Each link gets an explicit "lessons_count" field. Role-based ranges (already adjusted for pacing tier "${pTier}"):
- prerequisite: ${lessonRangeByRole.prerequisite.min}-${lessonRangeByRole.prerequisite.max} lessons
- core:        ${lessonRangeByRole.core.min}-${lessonRangeByRole.core.max} lessons
- ultimate:    ${lessonRangeByRole.ultimate.min}-${lessonRangeByRole.ultimate.max} lessons (DEEPEST — this is where the user's actual goal lives)

Hard rule: the chain ESCALATES. Each later prereq has more lessons than the previous prereq. Each core has more than the deepest prereq. Ultimate has more than any core. This reflects depth of mastery — by the time the student reaches the ultimate goal they're swimming in real material, not glancing at a survey.

duration_weeks should track lessons_count proportionally: ~7 lessons/week at moderate pacing assuming 2hr/day. So a 50-lesson core link is ~7 weeks; a 130-lesson ultimate link is ~18 weeks. Sum across all links gives the chain's true horizon — it WILL exceed the user's stated timeWeeks if the goal is ambitious. That's the honest signal.
═══════════════════════════════════════════════════════════
`;

  // Phase C (2026-05-17) — 5-axis output targets per chain link. Without an
  // explicit per-axis cumulative target the chain shows total weeks/lessons
  // but says nothing about WHAT the user will have produced/practiced/read/
  // reflected on. archetype-aware: HUMANITIES gets all 5; TECH-CONCEPT/TECH-
  // PROC drop "read"; LANG-ACQ/DECL-MASS/MINDSET keep only learn+practice.
  // See `app/lib/lifetime-ledger/axes.js` for canonical mapping.
  const { ARCHETYPE_AXIS_SET: _AXIS_SET, ARCHETYPE_UNIT_HINTS: _AXIS_HINTS } = require('./lib/lifetime-ledger/axes');
  const axisSet = _AXIS_SET[archetype] || ['learn', 'practice'];
  const axisHints = _AXIS_HINTS[archetype] || { learn: '概念', practice: '小时' };
  const axisHintLine = axisSet.map(a => `${a}:${axisHints[a] || '?'}`).join(' / ');
  const axisGuide = `
═══ 5-AXIS OUTPUT TARGETS (binding for archetype=${archetype || 'unknown'}) ═══
Each link MUST include "output_targets" array with these axes ONLY: ${axisSet.join(', ')}.
Per-axis unit hints: ${axisHintLine}
Count = honest cumulative target for that link's duration_weeks (! random, anchor on benchmark people if possible).

Example for HUMANITIES (e.g. 诺奖文学 link "20世纪现代主义诗学" 12 weeks):
  "output_targets": [
    {"axis":"learn","unit":"流派","count":8},
    {"axis":"practice","unit":"精读片段","count":120},
    {"axis":"produce","unit":"札记","count":30},
    {"axis":"read","unit":"本","count":35},
    {"axis":"reflect","unit":"论辩往返","count":10}
  ],
  "frontier_axis_p50": {"learn":8,"practice":100,"produce":25,"read":30,"reflect":8}

Also include "frontier_axis_p50": {[axis]: number} — your honest p50 estimate
based on what an actual benchmark person (compared to user's goal) would log
in this stage. If you don't know, set field to null. ! 编 false numbers.
═══════════════════════════════════════════════════
`;

  const sys = `${HYPHA_FULL}${profileBlock}You design a LEARNING CHAIN of 3-8 topics that bridges the student from their current state to an ambitious learning goal. Use the STUDENT PROFILE block above (if present) to set the chain's starting point — if the student already has experience the chain would normally start from, COMPRESS or DROP those prerequisite links. Output JSON: { "links": [{ "topic": string, "duration_weeks": float, "lessons_count": int, "role": "prerequisite"|"core"|"ultimate", "rationale": string, "exit_criterion": string, "output_targets": Axis[], "frontier_axis_p50": object | null }], "warning": string|null, "alternatives": { "extend_time_to_weeks": int|null, "lower_target_to": string|null } }.${lessonsCountGuide}${axisGuide}

${langInstruction}

═══ CHAIN-LINK CONTENT TYPE (binding — read FIRST before any rule below) ═══

EVERY link is a body of substantive KNOWLEDGE with a literature and a depth ceiling — NOT a process, habit, schedule, tool, or technique-of-studying. Each link is something the student LEARNS (acquires understanding of), not something they DO (execute as behavior).

Self-reference rule (HARD): Hypha itself is the delivery substrate — daily lessons, scheduling, atlas/mind-mapping, habit formation, spaced-repetition, ghost-lesson materialization, source retrieval, reflection journaling. These are NEVER chain links. The chain provides the SUBSTANCE that fills Hypha's delivery; do not list Hypha's mechanisms AS the substance.

Spawn test: each link must be authorable as a 25-150 lesson curriculum with distinct, non-overlapping lesson content. If you can't write 30 lessons under the proposed link title, the link is operational fluff — replace it with the underlying knowledge domain.

FORBIDDEN as link topics (operational fluff):
- "establish/build/maintain habit" / "建立习惯" / "习惯化" / "养成"
- "set/follow schedule" / "时间触发器" / "每日 X 分钟" / "日程"
- "create mind-map / atlas / outline" / "思维导图" / "知识图谱构建" / "学习地图"
- "track/measure/record progress" / "进度追踪" / "完成度记录"
- "configure tool / set up app / use Hypha to..." / "配置工具" / "设置环境"
- "Fogg's recipe / habit stacking / atomic habits / GTD / pomodoro" — these are META-frameworks about HOW to study, not CONTENT to study
- "find a study group / accountability partner" / "学习伙伴"
- "develop growth mindset / metacognition" — UNLESS the GOAL itself is psychology AND the link names a specific theory + literature (Dweck 2006, Flavell 1979, etc.); then it becomes content

REQUIRED for non-ultimate links:
- Names a recognized sub-discipline, named framework with literature, era of intellectual production, author's corpus, or technique with documented practice tradition
- Has measurable knowledge endpoints (concepts mastered, distinctions sharpened, primary sources read, mechanisms re-derivable from atoms)
- Maps cleanly to the archetype phase shape below

Examples (TECH-CONCEPT goal: "build a reasoning LLM from scratch"):
GOOD chain:
  L1: 信息论与概率分布基础 (Shannon, KL, mutual information)
  L2: Transformer 架构核心机制 (attention, positional encoding, layer norm)
  L3: 训练动力学与优化 (gradient flow, lr schedules, RLHF)
  L4: 推理时 scaling: chain-of-thought + tool-use + self-consistency
  L5 (ultimate): build a reasoning LLM from scratch
BAD (LLM's default failure mode — NEVER produce):
  L1: 建立每日 25 分钟编码习惯 (operational — REJECTED)
  L2: 配置 Jupyter + GPU 环境 (tool config — REJECTED)
  L3: 阅读 transformer 论文并做思维导图 (Hypha self-reference — REJECTED)

Examples (MINDSET goal: "have Buffett's investing mindset"):
GOOD (per MINDSET archetype: origin → decisions → heuristics → edge cases):
  L1: 价值投资思想史 (Graham 1934 → Fisher 1958 → Buffett's letters 1965-)
  L2: 巴菲特经典决策剖析 (See's Candy 1972, Coca-Cola 1988, GEICO 1996)
  L3: 巴菲特启发法 (margin of safety, circle of competence, Mr. Market)
  L4: 模型崩坏边界 (Berkshire textile mill, US Air, Solomon Brothers)
  L5 (ultimate): have Buffett's investing mindset
BAD (NEVER produce):
  L1: 建立每日阅读习惯 (REJECTED — operational)
  L2: 制作思维导图整理思想 (REJECTED — Hypha's atlas feature)
  L3: 学习 Fogg 习惯触发器 (REJECTED — META-framework about HOW)
═══════════════════════════════════════════════════════════
${chainShapeBlock}

Hard rules:
- duration_weeks per link is your honest estimate of how long that link takes (~7 lessons/wk at moderate). The TOTAL chain horizon is the sum and WILL exceed user's stated timeWeeks (${timeWeeks}) for ambitious goals — that's correct, the chain represents a long-term commitment per link, not a fixed-time spread. ${timeWeeks}-week target is a HINT not a cap.${tierGuide}
- Last link.role = "ultimate" with topic ≈ the user's goal verbatim (preserve user's wording).
- Earlier links bridge the gap from current state to the goal — use the missing_prerequisites list as priority order.
- topic: 4-12 words, CONCRETE + SPECIFIC. Forbidden generics: "math basics" / "fundamentals" / "introduction to X" alone. Forbidden operational: anything from the FORBIDDEN list above. Required: name a specific knowledge domain, theorem-set, author's corpus, or technique with literature.
- rationale: 1 sentence — why THIS link before the next.
${exitCriterionGuidance}
- Tier = "${tier}" (feasibility ratio P50 = ${ratio}, P(complete) ≈ ${pComplete}). ${tierGuidance[tier]}
${tier === 'nearly-impossible' ? `- "warning" MUST be non-null: explain in plain user-language that time is too tight (ratio ${ratio} below 0.7 threshold). "alternatives.extend_time_to_weeks" = ${Math.ceil(timeWeeks * 2)}; "alternatives.lower_target_to" = a concrete less-ambitious version of the goal (1 sentence, same language as output).` : ''}
- Order: prerequisites first (most foundational first), then core, then ultimate.
- DO NOT use mocking phrases like "Listen up!" / "Hard truth:" — be direct but respectful.

Output JSON only.`;
  const user = `Ultimate goal: ${goal}
Time budget: ${timeWeeks} weeks
Daily commitment: ${dailyHours} hours
Topic intrinsic load: ${intrinsicLoad}
Gap to goal: ${gap} (0 = already there, 1 = zero foundation)
Missing prerequisites identified: ${(missing_prerequisites || []).join(', ') || '(none specified)'}

Return JSON now.`;
  // v0.6.6 — operational-fluff detection. If the LLM ignores the prompt
  // and produces a habit/schedule/tool-config link, we either regenerate
  // once (with the violations called out) OR ship with quality_warnings
  // so the renderer can surface a "may be operational fluff — refuse?" UI.
  // TECH-PROC + LANG-ACQ archetypes legitimately have procedural verbs;
  // skip the audit for those (whitelist).
  const FORBIDDEN_PATTERNS = [
    /\b(establish|build|maintain|cultivate|develop)\b\s*(?:a|the)?\s*(?:daily\s+|weekly\s+)?\b(habit|routine|schedule|rhythm|ritual)\b/i,
    /(?:形成|建立|养成|培养)\s*\S{0,8}?(习惯|常规|节奏|惯例)/,
    /(?:每日|每天)\s*\d+\s*(?:分钟|小时|min|hour)/i,
    /\b(time|daily|weekly)\s*trigger\b/i,
    /(时间|每日|日程|节奏)\s*触发器/,
    /\b(create|build|make|draw)\b\s*(?:a|the)?\s*\b(mind\s*map|atlas|outline|knowledge\s*graph)\b/i,
    /(制作|构建|绘制|建立)\s*\S{0,8}?(思维导图|知识图谱|学习地图|atlas)/,
    /\b(track|measure|record|monitor)\s*\S{0,16}?\s*(progress|completion|metrics|进度|完成度|进展)/i,
    /(追踪|测量|记录|监控)\s*\S{0,8}?(进度|完成度|进展|进展度)/,
    /\b(fogg(?:'s)?(?:\s+\w+)?(?:\s+recipe|\s+model)?|atomic\s+habits|gtd|getting\s+things\s+done|pomodoro)\b/i,
    /\b(configure|set\s*up|install)\s*\S{0,16}?\s*(tool|environment|app|setup|environment)/i,
    /(配置|设置|搭建)\s*\S{0,8}?(工具|环境|应用)/,
    /\b(find|join)\s+(a\s+)?(study\s+group|accountability\s+partner|learning\s+buddy)\b/i,
    /(找|加入)\s*\S{0,4}?(学习小组|学习伙伴|搭子)/,
  ];
  const skipAudit = isProceduralArchetype;  // TECH-PROC + LANG-ACQ keep procedural verbs
  function _auditChain(links) {
    if (skipAudit) return [];
    const violations = [];
    (links || []).forEach((l, i) => {
      if (!l || !l.topic) return;
      // Last link = ultimate goal, exempt (it IS the user's goal verbatim,
      // even if vague — that's the whole point of the chain).
      if (l.role === 'ultimate' || i === links.length - 1) return;
      for (const re of FORBIDDEN_PATTERNS) {
        if (re.test(String(l.topic))) {
          violations.push({ idx: i, topic: l.topic, pattern: re.source });
          break;
        }
      }
    });
    return violations;
  }

  // 2026-05-05 — retry-with-descending-temperature loop. Pre-fix, planChain
  // returned empty links on any single LLM failure (parse error / timeout /
  // truncation), surfacing as "崩了 / 无法生成 plan" to the user; clicking again
  // re-rolled the dice and usually worked. Now: 3 attempts at temps [0.4, 0.2,
  // 0.1] — first attempt natural sampling, subsequent attempts collapse the
  // distribution toward greedy. max_tokens raised 8000→12000 because complex
  // chains (10-15 links × 5-8 fields) hit the 8K ceiling and JSON arrived
  // truncated. Backward-compatible: return shape unchanged on success and on
  // final failure.
  const RETRY_TEMPS = [0.4, 0.2, 0.1];
  let parsed = null;
  let lastErr = null;
  for (let attempt = 0; attempt < RETRY_TEMPS.length; attempt++) {
    try {
      const raw = await llmJSON(
        [{ role: 'system', content: sys }, { role: 'user', content: user }],
        settings,
        {
          json: true,
          temperature: RETRY_TEMPS[attempt],
          max_tokens: 12000,
          timeoutMs: 180_000,
        }
      );
      try {
        parsed = JSON.parse(raw);
        if (attempt > 0) {
          console.log(`[planChain] succeeded on retry ${attempt + 1}/${RETRY_TEMPS.length} (temp=${RETRY_TEMPS[attempt]})`);
        }
        break;
      } catch (parseErr) {
        lastErr = parseErr;
        console.warn(`[planChain] attempt ${attempt + 1}/${RETRY_TEMPS.length} JSON parse failed (temp=${RETRY_TEMPS[attempt]}): ${parseErr.message}`);
        if (attempt === RETRY_TEMPS.length - 1) {
          console.error('[planChain] final raw response (first 500 chars):', String(raw || '').slice(0, 500));
        }
      }
    } catch (llmErr) {
      lastErr = llmErr;
      console.warn(`[planChain] attempt ${attempt + 1}/${RETRY_TEMPS.length} LLM call failed: ${llmErr.message} ${llmErr.code || ''}`);
    }
    if (attempt < RETRY_TEMPS.length - 1) {
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  if (!parsed) {
    return {
      links: [],
      warning: `plan failed after ${RETRY_TEMPS.length} attempts: ${lastErr ? lastErr.message : 'unknown'}`,
      alternatives: null,
    };
  }

  // 2026-05-17 Phase C Gap 2 — frontier_axis_p50 LLM hallucination
  // validator. If LLM-reported p50 differs > 3x (either direction) from
  // its own output_targets count on the same axis, flag quality_warning
  // 'axis_p50_unanchored'. Surfaces to UI as gray "数值参考" hint without
  // blocking the chain. ! filter — keeps row, just signals uncertainty.
  const _auditAxisP50 = (links) => {
    const out = [];
    (links || []).forEach((l, i) => {
      const p50 = l && l.frontier_axis_p50;
      const targets = Array.isArray(l && l.output_targets) ? l.output_targets : [];
      if (!p50 || typeof p50 !== 'object' || targets.length === 0) return;
      for (const t of targets) {
        if (!t || typeof t.axis !== 'string') continue;
        const tCount = Number(t.count);
        const pVal = Number(p50[t.axis]);
        if (!Number.isFinite(tCount) || tCount <= 0) continue;
        if (!Number.isFinite(pVal) || pVal <= 0) continue;
        const r = pVal / tCount;
        // MEOW MID 2026-05-17 — tightened 3x → 2.5x to catch HUMANITIES
        // chains where LLM target is 2-3x stricter than its own benchmark
        // estimate (most common drift mode); 3x missed ~40% of real cases.
        if (r > 2.5 || r < 1 / 2.5) {
          out.push({ link_idx: i, axis: t.axis, target_count: tCount, p50_value: pVal, ratio: Number(r.toFixed(2)) });
        }
      }
    });
    return out;
  };

  // Audit + regenerate-once if violations.
  let violations = _auditChain(parsed.links);
  if (violations.length > 0) {
    try {
      const violationsList = violations.map(v => `  L${v.idx + 1}: "${v.topic}"`).join('\n');
      const correctionUser = `${user}

CRITICAL: your previous attempt produced these OPERATIONAL FLUFF links that violate the CHAIN-LINK CONTENT TYPE rule:
${violationsList}

These are NOT knowledge bodies — they are habit/schedule/tool-config tasks. Each violation must be replaced with a substantive knowledge domain that has a literature and a depth ceiling. Re-emit the full chain JSON with the violations replaced. Do NOT introduce new operational fluff.`;
      const raw2 = await llmJSON(
        [{ role: 'system', content: sys }, { role: 'user', content: correctionUser }],
        settings,
        { json: true, temperature: 0.3, max_tokens: 3500 }
      );
      const parsed2 = JSON.parse(raw2);
      const violations2 = _auditChain(parsed2.links);
      if (violations2.length === 0 || violations2.length < violations.length) {
        parsed = parsed2;
        violations = violations2;
      }
    } catch (_) { /* regenerate failed; ship original with warnings */ }
  }

  // Gap 2 — collect axis_p50 anchor mismatches (non-blocking).
  const axisP50Issues = _auditAxisP50(parsed.links);

  return {
    links: Array.isArray(parsed.links) ? parsed.links : [],
    warning: parsed.warning || null,
    alternatives: parsed.alternatives || null,
    quality_warnings: violations.length > 0 ? violations : null,
    axis_p50_warnings: axisP50Issues.length > 0 ? axisP50Issues : null,
  };
}

// Lacquer Loop W4 — frozen quiz bank generator. Produces N free-recall questions
// covering the first `upTo` lessons. Used pre-deploy on pilot curricula; result
// is locked into <topic>/quiz-bank.json (frozen + hash + created_at) and run at
// Day-0 + Day-7 to measure retention. Falsifier per pedagogy.md: ≥15pp Day-7
// recall lift over current designSequence baseline = unlock A3 + TECH-CONCEPT.
async function generateQuizBank(topic, sequence, settings, opts = {}) {
  const upTo = Math.min(opts.upTo || 7, sequence.length);
  const numQuestions = opts.numQuestions || 10;
  const lessonList = sequence.slice(0, upTo)
    .map(l => `${l.idx}. ${l.title || ''} — ${l.learnGoal || ''}`).join('\n');

  const sys = `You design a frozen recall test (${numQuestions} questions) that measures whether a learner has absorbed lessons 0..${upTo - 1} of a curriculum. The test runs at Day-0 (right after lessons) AND Day-7 (one week later) to measure retention.

Output a JSON object: { "questions": [ { "id": int, "lesson_idx": int, "question": string, "expected_answer": string, "scoring_criteria": string } ] }

Rules:
- ${numQuestions} questions total. Distribute across lessons 0..${upTo - 1} (≥1 per lesson; more for denser-content lessons).
- "question": 1 sentence, FREE-RECALL format ("State the mechanism by which X causes Y" / "What does Z predict about W?"). NEVER multiple-choice — recognition ≠ recall.
- "expected_answer": 1-3 sentences, the canonical correct answer. Specific and testable.
- "scoring_criteria": brief rubric (1 line) for partial credit (e.g. "must mention the cure-window concept AND name the trigger").
- Questions test core CLAIMS or MECHANISMS, not trivia. If lesson taught a process, ask the process; if it taught a distinction, ask the distinction.
- Difficulty: floor = passable with 70% lesson absorption; ceiling = passable only with deep understanding.

Output JSON only, no preamble.`;

  const user = `Topic: ${topic}
Lessons covered:
${lessonList}

Return the ${numQuestions} questions now.`;

  const raw = await llmJSON(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    settings,
    { json: true, temperature: 0.4, max_tokens: 4000 }
  );
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.questions) ? parsed.questions : [];
  } catch (_) { return []; }
}

// Phase 3.1 — adaptLessonGoal: rewrites an upcoming locked lesson's
// learn_goal (and optionally title) based on the just-finished lesson's
// settled-signal tier. Reuses HYPHA_FULL constitution for soul.
//
// signalTier: 'BASIC' | 'DEEP' (STANDARD never reaches this function)
//   - BASIC: student settled 0 concepts last lesson — reground basics first.
//   - DEEP: student settled ≥4 — level up next lesson's depth/creativity.
// settledTerms: list of concept terms the student settled (independent + correct)
// missingTerms: list of concepts INTRODUCED last lesson but NOT settled
// neighborhood: { prev: {title, learnGoal}, next: {title, learnGoal} } context
async function adaptLessonGoal({ currentTitle, currentGoal, signalTier, settledTerms, missingTerms, neighborhood, settings }) {
  const tierGuide = {
    BASIC: `The student finished the previous lesson WITHOUT settling any concept independently+correctly. Their grasp is shaky. PREPEND a clause to the learn_goal that:
- names 1-2 concepts they MISSED (from missingTerms)
- biases this lesson toward concrete examples + retrieval before abstraction
- preserves the lesson's place in the sequence — do NOT change the topic, only the depth/concreteness.`,
    DEEP: `The student finished the previous lesson with ≥4 concepts settled (independent + correct). They are fluent. APPEND a clause to the learn_goal that:
- names 2-3 concepts they SETTLED (from settledTerms)
- pushes this lesson toward extension / frontier / creative application
- preserves the lesson's place in the sequence — do NOT change the topic, only level up the depth.`,
  };
  const prevCtx = neighborhood && neighborhood.prev
    ? `\nPREVIOUS LESSON (just finished):\n  title: ${neighborhood.prev.title}\n  learn_goal: ${neighborhood.prev.learnGoal}`
    : '';
  const nextCtx = neighborhood && neighborhood.next
    ? `\nNEXT-NEXT LESSON (do NOT change, but preserve continuity to it):\n  title: ${neighborhood.next.title}\n  learn_goal: ${neighborhood.next.learnGoal}`
    : '';
  const sys = `${HYPHA_FULL}You are rewriting ONE upcoming lesson's learn_goal based on the student's settled-signal from the previous lesson. Output JSON: { "newGoal": string, "newTitle": string|null, "reason": string }.

Rules:
- newGoal: 1 sentence, plain language. Same single concrete claim/skill standard as before — but now adjusted per signal tier.
- newTitle: usually null (preserve original). Only override if the title is misleading after the goal shift.
- reason: 1 sentence — why this rewrite. Cite the specific signal (e.g. "student settled retrieval+spacing concepts last lesson — push toward FSRS frontier").
- Preserve sequence continuity: this lesson's learn_goal must still chain naturally into the NEXT-NEXT lesson.
- Forbidden: changing the topic; making the lesson easier or harder by collapsing all rules into "easier/harder"; restating the previous lesson.

${tierGuide[signalTier] || ''}

Output JSON only.`;
  const user = `CURRENT LESSON (to rewrite):
  title: ${currentTitle}
  learn_goal: ${currentGoal}

SIGNAL TIER: ${signalTier}
Settled terms (student demonstrated mastery): ${(settledTerms || []).join(', ') || '(none)'}
Missing terms (introduced but not settled): ${(missingTerms || []).join(', ') || '(none)'}
${prevCtx}${nextCtx}

Return JSON now.`;
  try {
    const raw = await llmJSON(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      settings,
      { json: true, temperature: 0.2, max_tokens: 600 }
    );
    const p = JSON.parse(raw);
    return {
      newGoal: String(p.newGoal || currentGoal).slice(0, 600),
      newTitle: p.newTitle ? String(p.newTitle).slice(0, 200) : null,
      reason: String(p.reason || '').slice(0, 400),
    };
  } catch (_) {
    return { newGoal: currentGoal, newTitle: null, reason: 'adapt failed; preserved original' };
  }
}

// scoreQuizAnswer — LLM-judged 0..1 score on free-recall answer vs expected.
async function scoreQuizAnswer(question, expected, scoringCriteria, learnerAnswer, settings) {
  const sys = `Score a learner's recall answer against expected. Output: {"score": 0..1, "reason": string}.

Scoring rubric:
- 1.0 = exact concept match (wording can vary, but mechanism + key terms present)
- 0.7 = key claim correct but partial (missing 1 key detail)
- 0.3 = direction right but main mechanism wrong
- 0.0 = wrong direction or empty

Be STRICT on mechanism, LENIENT on phrasing.`;

  const user = `Question: ${question}
Expected answer: ${expected}
Scoring criteria: ${scoringCriteria || '(use mechanism + key terms)'}
Learner's answer: ${learnerAnswer || '(empty)'}

Return JSON.`;

  try {
    const raw = await llmJSON(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      settings,
      { json: true, temperature: 0.1, max_tokens: 200 }
    );
    const parsed = JSON.parse(raw);
    const score = Math.max(0, Math.min(1, Number(parsed.score) || 0));
    return { score, reason: parsed.reason || '' };
  } catch (_) { return { score: 0, reason: 'judge error' }; }
}

// computeVariance — given the user's declared learning intent (from
// curriculum-create welcome form) and the just-finished lesson's atlas-delta,
// return a 1-line "intent echo + drift summary" that will render at the top
// of the distilled note (Variance Card, v0.2). The card answers: "did this
// lesson move you toward your stated goal, or did you wander?"
//
// Inputs:
//   goal         — string from state.json (curriculum-create welcome form)
//   topicSlug    — curriculum slug, for echo
//   delivered    — array of concept terms whose settled_at_turn fell in this
//                  lesson's session-turn range (already computed by caller)
//   timeCommit   — 'a-week' | 'a-month' | '3-months' | 'open-ended'
//   lessonTitle  — string, current lesson
//
// Output (parsed JSON):
//   { intentEcho:   string (1 sentence, paraphrases the goal in 千金 register)
//   , driftSummary: string (1-2 sentences, factual not motivational)
//   , onTrack:      'on' | 'drifting' | 'detour'
//   , driftReason:  string (≤1 sentence, why drift if any)
//   }
//
// Cost: ~250 tokens out, ~$0.0002 with GLM, ~$0.005 with Sonnet. Low temp.
async function computeVariance({ goal, topicSlug, delivered, timeCommit, lessonTitle }, settings) {
  const sys = `You read a learner's declared goal + a list of concepts they actually settled in one lesson, and produce a 1-card "variance" report.

Your voice: editorial, factual, manuscript register (Hypha's brand). NO motivational language. No "great job!" No "keep going!" Treat the learner as a serious adult auditing their own progress.

Forbidden words: AI, LLM, model, prompt. Forbidden phrases: "you're doing great", "fantastic progress", any exclamation marks.

Output STRICT JSON:
  intentEcho: 1-sentence paraphrase of the user's goal (≤20 words)
  driftSummary: 1-2 sentences, factual. Cite specific delivered concepts. Note if direction matches the goal.
  onTrack: "on" | "drifting" | "detour" — your judgement
  driftReason: ≤1 sentence; if onTrack="on", leave empty string`;

  const userMsg = `Topic: ${topicSlug}
Lesson title: ${lessonTitle || '(untitled)'}
Time commitment: ${timeCommit || 'open-ended'}
Declared goal: ${goal || '(no explicit goal set)'}
Concepts settled this lesson: ${(delivered || []).slice(0, 15).join(', ') || '(none — learner did not settle independently)'}

Output the JSON variance card.`;

  try {
    const raw = await llmJSON(
      [{ role: 'system', content: sys }, { role: 'user', content: userMsg }],
      settings,
      { json: true, temperature: 0.2, max_tokens: 400, fn: 'computeVariance' }
    );
    const parsed = JSON.parse(raw);
    return {
      intentEcho: String(parsed.intentEcho || '').trim().slice(0, 200),
      driftSummary: String(parsed.driftSummary || '').trim().slice(0, 400),
      onTrack: ['on', 'drifting', 'detour'].includes(parsed.onTrack) ? parsed.onTrack : 'on',
      driftReason: String(parsed.driftReason || '').trim().slice(0, 200),
    };
  } catch (err) {
    return {
      intentEcho: goal ? goal.slice(0, 100) : '',
      driftSummary: delivered && delivered.length
        ? `this lesson settled ${delivered.length} concept${delivered.length === 1 ? '' : 's'}: ${delivered.slice(0, 5).join(', ')}.`
        : 'this lesson settled no concepts independently.',
      onTrack: 'on',
      driftReason: '',
    };
  }
}

// ─── v0.4.0 — Three-stage curriculum gen ────────────────────────────────────

// loadArchetypeTemplate — read the per-archetype phase template from disk.
// Falls back to TECH-CONCEPT if the archetype is unknown or template missing.
// Templates live at app/lib/archetype-templates/<archetype>.json.
const _path = require('path');
const _fs = require('fs');
function loadArchetypeTemplate(archetype) {
  const dir = _path.join(__dirname, 'lib', 'archetype-templates');
  const tryRead = (a) => {
    try { return JSON.parse(_fs.readFileSync(_path.join(dir, `${a}.json`), 'utf8')); }
    catch (_) { return null; }
  };
  return tryRead(archetype) || tryRead('TECH-CONCEPT') || {
    archetype: 'TECH-CONCEPT',
    phases: [
      { id: 'foundations', label: 'Foundations', lessonCount: [2, 4, 6], tone: '' },
      { id: 'mechanisms',  label: 'Mechanisms',  lessonCount: [3, 5, 8], tone: '' },
      { id: 'frontier',    label: 'Frontier',    lessonCount: [2, 3, 5], tone: '' },
      { id: 'synthesis',   label: 'Synthesis',   lessonCount: [1, 2, 3], tone: '' },
    ],
  };
}

// timeCommitToCountIdx — DEPRECATED. Kept only for legacy designSequence path.
// New pipeline uses computePhaseLessonCounts (weight-based, custom-aware).
function timeCommitToCountIdx(timeCommit) {
  if (timeCommit === 'week')   return 0;
  if (timeCommit === 'month')  return 1;
  if (timeCommit === 'quarter' || timeCommit === 'open' || timeCommit === 'open-ended') return 2;
  if (timeCommit === 'two-month' || timeCommit === 'custom') return 2;
  return 1;
}

// tierMultiplier — v0.6.0 picker. gentle (0.6×) and heroic (1.6×) modulate the
// final lesson count around the moderate baseline (1.0×). 'moderate' or unknown
// tier returns 1.0 → preserves v0.5.x behavior.
function tierMultiplier(tier) {
  if (tier === 'gentle') return 0.6;
  if (tier === 'heroic') return 1.6;
  return 1.0; // moderate / unknown
}

// deriveLessonTarget — 2026-05-13 user pushback iteration 2:
//   v1 (earlier today): intent + breadth bands, fixed 35 removed
//   v2 (now): "100 天给 38 节什么意思, 至少一天一节" — TIME IS THE FLOOR.
//   When user commits N days, lesson count ≥ N. Intent scales density UP from
//   that floor, never below.
//
// Decision hierarchy:
//   1. explicit customLessons (1-200) → verbatim (advanced override, ignores other signals)
//   2. days available (from deadline date OR explicit days OR timeCommit enum)
//      → lessons = days × intent_density (floor ≥ 1.0)
//   3. neither → intent + breadth base (small numbers, 9-38)
//
// Intent density (≥ 1.0 floor per user 2026-05-13 "至少一天一节"):
//   考研: 1.5× days  (cram intensity)
//   论文: 1.2× days  (rigorous depth)
//   兴趣: 1.0× days  (1 lesson per day — the floor)
//   复盘: 1.0× days  (compression, still 1 per day)
//
// Topic-breadth bonus (only applies to no-days fallback path):
//   broad: 1.4× / normal: 1.2× / focused: 1.0× (applied to intent-base, not to days path)
//
// Days resolution priority: days (number) > deadline date diff > timeCommit enum
//   timeCommit enum → days: week=7, month=30, two-month=60, quarter=90, open=180
function deriveLessonTarget({ timeCommit, customLessons, user_intent, topic, days, deadline }) {
  const cn = Number(customLessons);
  if (Number.isFinite(cn) && cn >= 1 && cn <= 200) {
    return { target: Math.round(cn), reasoning: `custom=${cn}` };
  }

  // Resolve effective days from any of 3 inputs (priority order)
  let daysEffective = null;
  let daysSource = null;
  const dn = Number(days);
  if (Number.isFinite(dn) && dn >= 1 && dn <= 730) {
    daysEffective = Math.round(dn);
    daysSource = 'explicit-days';
  }
  if (!daysEffective && deadline) {
    try {
      const dateMs = Date.parse(deadline);
      if (Number.isFinite(dateMs)) {
        const diff = Math.ceil((dateMs - Date.now()) / (24 * 3600 * 1000));
        if (diff >= 1 && diff <= 730) {
          daysEffective = diff;
          daysSource = `deadline(${deadline})`;
        }
      }
    } catch (_) {}
  }
  if (!daysEffective && timeCommit) {
    const ENUM_DAYS = { week: 7, month: 30, 'two-month': 60, quarter: 90, open: 180, 'open-ended': 180 };
    if (ENUM_DAYS[timeCommit]) {
      daysEffective = ENUM_DAYS[timeCommit];
      daysSource = `timeCommit=${timeCommit}`;
    }
  }

  const intent = (typeof user_intent === 'string' && user_intent.trim()) ? user_intent.trim() : '兴趣';

  // PATH A — days available: lessons = days × intent_density (floor 1.0)
  if (daysEffective) {
    const INTENT_DENSITY = { '考研': 1.5, '论文': 1.2, '兴趣': 1.0, '复盘': 1.0 };
    const density = INTENT_DENSITY[intent] || 1.0;
    const target = Math.round(daysEffective * density);
    return {
      target: Math.max(2, Math.min(200, target)),
      reasoning: `days=${daysEffective}(${daysSource}) × intent=${intent}/${density} = ${target}`,
    };
  }

  // PATH B — no days info: fall back to intent + breadth base
  const t = String(topic || '').trim();
  const BROAD_RE = /(史|哲学|概览|入门|overview|introduction|全集|大全|总论|社会|经济|文化|历史)/i;
  const isBroad = BROAD_RE.test(t) || t.length >= 8;
  const isFocused = t.length > 0 && t.length <= 4 && !isBroad;
  const breadth = isBroad ? 'broad' : (isFocused ? 'focused' : 'normal');

  const INTENT_BASE = {
    '考研':  { focused: 12, normal: 22, broad: 38 },
    '论文':  { focused:  6, normal: 10, broad: 18 },
    '兴趣':  { focused:  5, normal:  9, broad: 14 },
    '复盘':  { focused:  3, normal:  5, broad:  8 },
  };
  const base = INTENT_BASE[intent] || INTENT_BASE['兴趣'];
  const target = Math.max(2, Math.min(60, base[breadth]));
  return {
    target,
    reasoning: `no-time-given/intent=${intent}/breadth=${breadth}/base=${base[breadth]} → ${target}`,
  };
}

// computePhaseLessonCounts — distribute target total across phases by weight.
//
// 2026-05-13: Total derivation replaced with deriveLessonTarget() which respects
// user_intent (考研/论文/兴趣/复盘) + topic breadth heuristic. Fixed-35 default
// removed per user feedback "固定 35 没意思". timeCommit + tier still honored as
// modifiers when explicitly set.
//
// Largest-remainder method: floor(weight × target), then distribute leftover
// to phases with largest fractional parts. Min 1 lesson per phase enforced.
function computePhaseLessonCounts(phases, timeCommit, customLessons, tier, opts) {
  opts = opts || {};
  // R3 2026-05-13 — when caller has already resolved the authoritative total
  // (via resolveLessonShape), skip deriveLessonTarget + tier so the weight
  // distributor honors the resolved figure exactly. Tier multiplier is the
  // caller's responsibility in that path (resolveLessonShape doesn't apply it).
  let target;
  if (Number.isFinite(opts.totalOverride) && opts.totalOverride > 0) {
    target = Math.round(opts.totalOverride);
  } else {
    const derivation = deriveLessonTarget({
      timeCommit,
      customLessons,
      user_intent: opts.user_intent,
      topic: opts.topic,
      deadline: opts.deadline,
      days: opts.days,
    });
    target = Math.round(derivation.target * tierMultiplier(tier));
  }
  if (target < phases.length) target = phases.length; // ≥1 per phase

  let weights = phases.map(p => {
    const w = Number(p.weight);
    return Number.isFinite(w) && w > 0 ? w : 0;
  });
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW <= 0) {
    weights = phases.map(() => 1 / phases.length);
  } else {
    weights = weights.map(w => w / sumW);
  }

  const raw = weights.map(w => w * target);
  const counts = raw.map(r => Math.max(1, Math.floor(r)));
  let diff = target - counts.reduce((a, b) => a + b, 0);
  if (diff > 0) {
    const order = raw
      .map((r, i) => ({ frac: r - Math.floor(r), i }))
      .sort((a, b) => b.frac - a.frac);
    let oi = 0;
    while (diff > 0) {
      counts[order[oi % order.length].i] += 1;
      diff -= 1;
      oi += 1;
    }
  } else if (diff < 0) {
    while (diff < 0) {
      let maxI = 0;
      for (let i = 1; i < counts.length; i++) {
        if (counts[i] > counts[maxI]) maxI = i;
      }
      if (counts[maxI] > 1) { counts[maxI] -= 1; diff += 1; }
      else break;
    }
  }
  return counts;
}

// resolveLessonShape — 2026-05-13 R3 dynamic lessonSplit integration.
//
// Returns the authoritative `{ totalLessons, perSlotKpTargets, source, reject }`
// shape decision for a curriculum, reconciling 3 signals:
//
//   1. customLessons override (1-200)     → verbatim, source='custom-override'
//   2. lessonSplit(kp_density, intent)    → primary signal, source='kp-density'
//   3. deriveLessonTarget(time-floor)     → floor; max(floor, kp_density)
//
// `kpCandidateCount` should be the post-harvest KP candidate proxy
// (structureAnchor.lectureSequence.length when anchor present; null otherwise).
// When null, lessonSplit is skipped and we fall back to deriveLessonTarget alone
// (source='time-floor' or 'intent-base' depending on whether days are known).
//
// When lessonSplit returns reject (kpCount ≥ 27 — Miller cap blown), we emit a
// reject marker so designSeed/designSkeletonOnly can raise `topic_too_broad`.
//
// `perSlotKpTargets` is ALWAYS sum == lessonSplit's intended KP budget when
// available; when finalLessons > lessonSplit.n_lessons, the per-slot budget is
// proportionally re-distributed across the larger lesson count (each slot may
// fall to 1-2 KP — that's the truthful answer for sparse-density topics).
//
// R3.1 (2026-05-13) — intent-density skew. lessonSplit is intent-AGNOSTIC by
// design (locked pure function). Post-process its [target_counts] using a
// per-intent target KP/lesson density: 考研 8.5 / 论文 7 / 兴趣 5.5 / 复盘 5.
// Skew fires only when |density_ratio − 1| > 0.15 (≥15% drift), preserving
// disjoint-threshold reject path and time-floor priority. Each slot stays in
// Miller [3,9]. Skew operates on lessonSplit's signal BEFORE time-floor
// reconciliation, so daysFloor still wins when it's larger.

// INTENT_DENSITY_TARGET — per-intent median KP/lesson density used to skew
// lessonSplit's intent-agnostic [target_counts] toward learner mode. Numbers
// are pedagogical priors (考研 wants dense, 复盘 wants sparse), not data-fit.
const INTENT_DENSITY_TARGET = Object.freeze({
  '考研': 8.5,
  '论文': 7,
  '兴趣': 5.5,
  '复盘': 5,
});
const INTENT_SKEW_DEAD_BAND = 0.15;       // |ratio − 1| ≤ this → no skew
const INTENT_SKEW_SLOT_MIN = 3;            // Miller working-memory floor
const INTENT_SKEW_SLOT_MAX = 9;            // Miller working-memory ceiling

// applyIntentDensitySkew — pure transform over lessonSplit's
// { n_lessons, target_counts } given a userIntent. Returns new
// { n_lessons, target_counts, skewed, density_before, density_after,
//   density_target } shape. Total KP sum is preserved via largest-remainder
// even-distribute when re-binning. No-op (skewed=false) when intent unknown,
// total KP < INTENT_SKEW_SLOT_MIN * 2 (can't split into ≥2 valid slots), or
// density already inside ±15% of target.
function applyIntentDensitySkew(splitTargetCounts, userIntent) {
  const intent = (typeof userIntent === 'string' && userIntent.trim()) ? userIntent.trim() : null;
  const target = intent && INTENT_DENSITY_TARGET[intent];
  if (!target || !Array.isArray(splitTargetCounts) || splitTargetCounts.length === 0) {
    return { n_lessons: (splitTargetCounts || []).length, target_counts: (splitTargetCounts || []).slice(),
      skewed: false, density_before: null, density_after: null, density_target: target || null };
  }
  // Density signal = first-slot KP (the same proxy the task spec uses).
  const densityBefore = splitTargetCounts[0];
  const ratio = densityBefore / target;
  // Dead band: drift < 15% → keep lessonSplit's output verbatim.
  if (Math.abs(ratio - 1) <= INTENT_SKEW_DEAD_BAND) {
    return { n_lessons: splitTargetCounts.length, target_counts: splitTargetCounts.slice(),
      skewed: false, density_before: densityBefore, density_after: densityBefore, density_target: target };
  }
  // Re-bin total KP at target density. Clamp slot count so each slot stays in
  // Miller [3,9] — if KP is too small to make ≥2 valid slots at this target,
  // bail (skew can't help; fall back to lessonSplit's output).
  const totalKp = splitTargetCounts.reduce((a, b) => a + b, 0);
  const minSlots = Math.max(1, Math.ceil(totalKp / INTENT_SKEW_SLOT_MAX));
  const maxSlots = Math.max(1, Math.floor(totalKp / INTENT_SKEW_SLOT_MIN));
  if (maxSlots < minSlots) {
    return { n_lessons: splitTargetCounts.length, target_counts: splitTargetCounts.slice(),
      skewed: false, density_before: densityBefore, density_after: densityBefore, density_target: target };
  }
  let newN = Math.round(totalKp / target);
  if (newN < minSlots) newN = minSlots;
  if (newN > maxSlots) newN = maxSlots;
  if (newN === splitTargetCounts.length) {
    return { n_lessons: splitTargetCounts.length, target_counts: splitTargetCounts.slice(),
      skewed: false, density_before: densityBefore, density_after: densityBefore, density_target: target };
  }
  // Largest-remainder distribute totalKp across newN slots, each in [3,9].
  const base = Math.floor(totalKp / newN);
  const remainder = totalKp % newN;
  const newCounts = [];
  for (let i = 0; i < newN; i++) {
    newCounts.push(Math.min(INTENT_SKEW_SLOT_MAX,
      Math.max(INTENT_SKEW_SLOT_MIN, base + (i < remainder ? 1 : 0))));
  }
  return {
    n_lessons: newN,
    target_counts: newCounts,
    skewed: true,
    density_before: densityBefore,
    density_after: newCounts[0],
    density_target: target,
  };
}
function resolveLessonShape({ kpCandidateCount, userIntent, timeCommit, customLessons, deadline, days, topic, phaseCount }) {
  // Hard override: customLessons skips both signals.
  const cn = Number(customLessons);
  if (Number.isFinite(cn) && cn >= 1 && cn <= 200) {
    return {
      totalLessons: Math.round(cn),
      source: 'custom-override',
      perSlotKpTargets: null,        // unknown; caller can synthesize from lessonSplit if it ran independently
      lessonSplit: null,
      daysFloor: null,
      reject: null,
    };
  }

  // Probe lessonSplit only when we have a real KP candidate count to ground it.
  // Pure-fallback designSeed (no anchor) can pass null → we skip lessonSplit.
  const haveKpProbe = Number.isFinite(kpCandidateCount) && kpCandidateCount > 0;
  const splitRaw = haveKpProbe ? lessonSplit(kpCandidateCount, userIntent) : null;
  if (splitRaw && splitRaw.reject) {
    // R3.1 — preserve disjoint-threshold reject path (KP ≥ 27). No skew.
    return {
      totalLessons: 0,
      source: 'reject',
      perSlotKpTargets: null,
      lessonSplit: splitRaw,
      daysFloor: null,
      reject: splitRaw.reject,
    };
  }

  // R3.1 post-process — intent-density skew. lessonSplit is intent-agnostic;
  // we redistribute its target_counts toward the user_intent's KP/lesson
  // median (考研 dense / 复盘 sparse) while preserving total KP. Runs BEFORE
  // time-floor reconciliation so the floor-vs-density comparison uses the
  // skewed kp-density signal.
  const skew = splitRaw
    ? applyIntentDensitySkew(splitRaw.target_counts, userIntent)
    : { skewed: false, n_lessons: 0, target_counts: [], density_before: null, density_after: null, density_target: null };
  const split = splitRaw ? {
    ...splitRaw,
    n_lessons: skew.skewed ? skew.n_lessons : splitRaw.n_lessons,
    target_counts: skew.skewed ? skew.target_counts.slice() : splitRaw.target_counts.slice(),
    intent_skew: {
      applied: skew.skewed,
      density_before: skew.density_before,
      density_after: skew.density_after,
      density_target: skew.density_target,
      n_lessons_before: splitRaw.n_lessons,
      n_lessons_after: skew.skewed ? skew.n_lessons : splitRaw.n_lessons,
      target_counts_before: splitRaw.target_counts.slice(),
    },
  } : null;

  // Detect whether the caller actually committed to a time horizon. ONLY then
  // does the day-floor apply (user 2026-05-13 "100 天 → ≥100 lessons 至少一天一节").
  // Without a time anchor, kp-density is the only signal — we don't let the
  // intent-base fallback inside deriveLessonTarget inflate the count past
  // what KP density supports (would re-create v2 "100 天给 38 节" inversion
  // in the no-time case).
  const hasTimeAnchor = (
    (Number.isFinite(Number(days)) && Number(days) >= 1) ||
    (deadline && !Number.isNaN(Date.parse(deadline))) ||
    (typeof timeCommit === 'string' && /^(week|month|two-month|quarter|open|open-ended)$/.test(timeCommit))
  );

  // Day-floor derivation reuses deriveLessonTarget (which we promised not to touch).
  // We always compute it for telemetry, but only ENFORCE it when hasTimeAnchor.
  const derivation = deriveLessonTarget({
    timeCommit, customLessons: null, user_intent: userIntent, topic, deadline, days,
  });
  const daysFloor = hasTimeAnchor ? Math.max(phaseCount || 1, derivation.target) : null;

  // No KP probe → fall back to time-floor (or pure intent-base when no time).
  if (!split) {
    return {
      totalLessons: daysFloor != null ? daysFloor : Math.max(phaseCount || 1, derivation.target),
      source: daysFloor != null ? 'time-floor' : 'intent-base',
      perSlotKpTargets: null,
      lessonSplit: null,
      daysFloor,
      reject: null,
    };
  }

  // Both signals present. When no time anchor, kp-density wins. When time
  // anchor, max(daysFloor, kpDensity) — typical case: daysFloor wins.
  const kpDensity = split.n_lessons || 1;
  const floorWins = daysFloor != null && daysFloor > kpDensity;
  const totalLessons = floorWins ? daysFloor : kpDensity;
  const source = floorWins ? 'time-floor' : 'kp-density';

  // Distribute the KP budget across the FINAL lesson count.
  // - When kp-density wins (totalLessons == split.n_lessons), use split.target_counts verbatim.
  // - When floor wins (totalLessons > split.n_lessons), proportionally redistribute
  //   the same KP budget (sum of target_counts) across the larger slot count.
  //   Each slot may fall to 1 KP — that's the honest answer; we don't fabricate.
  let perSlotKpTargets;
  if (!floorWins) {
    perSlotKpTargets = split.target_counts.slice();
  } else {
    const totalKpBudget = split.target_counts.reduce((a, b) => a + b, 0) || kpCandidateCount;
    const base = Math.floor(totalKpBudget / totalLessons);
    const remainder = totalKpBudget % totalLessons;
    perSlotKpTargets = [];
    for (let i = 0; i < totalLessons; i++) {
      // floor 1 KP per lesson (each lesson needs ≥1 atom to teach)
      perSlotKpTargets.push(Math.max(1, base + (i < remainder ? 1 : 0)));
    }
  }

  return {
    totalLessons,
    source,
    perSlotKpTargets,
    lessonSplit: split,
    daysFloor,
    reject: null,
  };
}

// v0.4 — 8-field source metadata schema defaults. Per-sourceType anchor
// values for {authority, freshness, stability, teaching_value, frontier_value,
// engineering_value, license_status, best_use}. Read-time inference (no
// vault migration): existing sources.json files keep working — undefined
// fields filled by _inferSourceMetadata(src) at read time.
const SOURCE_METADATA_DEFAULTS = Object.freeze({
  'courseware':       { authority: 95, stability: 85, teaching_value: 90, frontier_value: 20, license_status: 'open',    best_use: 'curriculum' },
  'pedagogy':         { authority: 95,                teaching_value: 100,                                                best_use: 'lesson_design' },
  'arxiv':            { authority: 70, freshness: 100, stability: 40, frontier_value: 95,                                 best_use: 'spark' },
  'pwc':              { authority: 75,                 frontier_value: 80, engineering_value: 90,                         best_use: 'lesson' },
  'openreview':       { authority: 80,                 frontier_value: 85, stability: 60,                                 best_use: 'spark' },
  'hf-papers':        { authority: 65, freshness: 95,  frontier_value: 80, stability: 30,                                 best_use: 'spark' },
  'lab_blog':         { authority: 90, freshness: 80,  engineering_value: 85,                                             best_use: 'lesson' },
  'framework_docs':   { authority: 80, stability: 85,  engineering_value: 80,                                             best_use: 'lesson' },
  'youtube-curated':  { authority: 85, teaching_value: 95, frontier_value: 50,                                            best_use: 'lesson' },
  'youtube':          { authority: 40, teaching_value: 50,                                                                best_use: 'example' },
  'github':           {                  freshness: 80, engineering_value: 80,                                            best_use: 'assignment' },
  'sep':              { authority: 95, stability: 95,  teaching_value: 80,                                                best_use: 'lesson' },
  'wikipedia':        { authority: 60, stability: 70,                                                                     best_use: 'example' },
  'openalex':         { authority: 80, frontier_value: 60,                                                                best_use: 'spark' },
  'yc':               { authority: 75, engineering_value: 70,                                                             best_use: 'lesson' },
  'cited-ref':        { authority: 70, frontier_value: 70, stability: 50,                                                 best_use: 'spark' },
  'cited-by':         { authority: 70, frontier_value: 75, stability: 50,                                                 best_use: 'spark' },
  'web':              { authority: 50,                                                                                    best_use: 'example' },
  'hn':               { authority: 55, freshness: 75, engineering_value: 60,                                              best_use: 'example' },
  'forum-anchor':     { authority: 50,                                                                                    best_use: 'example' },
  'uni-anchor':       { authority: 90, stability: 90,  teaching_value: 80,                                                best_use: 'curriculum' },
  'user-upload':      { authority: 100, license_status: 'open',                                                           best_use: 'lesson' },
  'user-url':         { authority: 95,                                                                                    best_use: 'lesson' },
});

// _inferSourceMetadata — backfill the 8-field metadata schema on a source
// using sourceType-keyed defaults. Existing values in `src` win (caller
// already enriched). Pure function: returns a NEW object, never mutates.
function _inferSourceMetadata(src) {
  if (!src || typeof src !== 'object') return src;
  const sourceType = src.sourceType || 'web';
  const defaults = SOURCE_METADATA_DEFAULTS[sourceType] || {};
  return {
    authority:         (typeof src.authority         === 'number') ? src.authority         : (defaults.authority         || 0),
    freshness:         (typeof src.freshness         === 'number') ? src.freshness         : (defaults.freshness         || 0),
    stability:         (typeof src.stability         === 'number') ? src.stability         : (defaults.stability         || 0),
    teaching_value:    (typeof src.teaching_value    === 'number') ? src.teaching_value    : (defaults.teaching_value    || 0),
    frontier_value:    (typeof src.frontier_value    === 'number') ? src.frontier_value    : (defaults.frontier_value    || 0),
    engineering_value: (typeof src.engineering_value === 'number') ? src.engineering_value : (defaults.engineering_value || 0),
    license_status:    src.license_status || defaults.license_status || 'unknown',
    best_use:          src.best_use        || defaults.best_use        || 'lesson',
  };
}

// rankSourcesBM25 — pure-JS BM25 over title + excerpt. No LLM, no embeddings.
// Returns top-k sources sorted by relevance. Used by Stage 2 (frontier
// retrieval) to pick which 5 sources to pass to proposeNextLesson per
// upcoming lesson — citations always real, never invented.
//
// v0.4 — opts.desiredUse filters list to only sources whose inferred
// best_use matches (e.g. 'curriculum' for designSequence STRUCTURE PRIOR,
// 'lesson' for in-lesson grounding). authority/teaching_value boost folded
// into the score so courseware (auth 95) ranks above generic web (auth 50).
function rankSourcesBM25(sources, query, k = 5, opts = {}) {
  const list0 = Array.isArray(sources) ? sources : [];
  if (list0.length === 0) return [];
  // v0.4 — best_use filter (optional).
  const desiredUse = opts && opts.desiredUse ? String(opts.desiredUse) : '';
  const list = desiredUse
    ? list0.filter(s => _inferSourceMetadata(s).best_use === desiredUse)
    : list0;
  if (list.length === 0) return [];
  const q = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (q.length === 0) return list.slice(0, k);
  // BM25 params (standard).
  const k1 = 1.5, b = 0.75;
  const docs = list.map(s => `${s.title || ''} ${s.excerpt || ''}`.toLowerCase());
  const docTokens = docs.map(d => d.split(/\s+/).filter(Boolean));
  const docLens = docTokens.map(t => t.length);
  const avgLen = docLens.reduce((a, b) => a + b, 0) / docLens.length || 1;
  const N = list.length;
  // df per query term
  const df = {};
  for (const term of q) {
    df[term] = docTokens.filter(t => t.includes(term)).length;
  }
  // score each doc
  const scored = list.map((src, i) => {
    let score = 0;
    const tokens = docTokens[i];
    const len = docLens[i];
    for (const term of q) {
      const tf = tokens.filter(t => t === term).length;
      if (tf === 0) continue;
      const idf = Math.log(1 + (N - df[term] + 0.5) / (df[term] + 0.5));
      score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * len / avgLen));
    }
    // Star/recency boost — small multiplier so popular sources tie-break ahead.
    const stars = Number(src.stars) || 0;
    const starBoost = stars > 0 ? Math.log10(1 + stars) * 0.3 : 0;
    // 2026-05-05 — user-supplied URLs (sourceType='user-url') ranked above
    // generic web harvest. User explicitly chose these URLs as authoritative,
    // so per-document score gets 1.5x multiplier. user-upload (PDFs/MDs/TXTs
    // dropped via picker) is the primary high-priority channel and skips
    // web harvest entirely; user-url is the parallel high-priority channel
    // that lives within uploadedSource.files[] alongside uploads.
    const userUrlBoost = (src.sourceType === 'user-url') ? 0.5 : 0;
    // v0.4 — authority + teaching_value boost from metadata schema. Bounded
    // multiplier so a high-authority source with low BM25 doesn't crowd out
    // a low-authority source that's actually on-topic. Range 0 - 0.3.
    const meta = _inferSourceMetadata(src);
    const useTeaching = (desiredUse === 'lesson' || desiredUse === 'lesson_design' || desiredUse === 'curriculum');
    const metaBoost = ((meta.authority || 0) / 1000) + (useTeaching ? (meta.teaching_value || 0) / 1000 : 0);
    return { src, score: (score + starBoost) * (1 + userUrlBoost + metaBoost) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map(s => s.src);
}

// designSeed — Stage 1 of the three-stage pipeline. Replaces the 14000-token
// monolithic designSequence call. Reads phase structure from per-archetype
// JSON template (no LLM call for SHAPE) and runs ONE small LLM call to write
// only lesson 1's title + learnGoal + a one-paragraph trajectory description.
//
// Total wall time target: 5-8 seconds. Token output ~400, max_tokens 600.
//
// Returns { archetype, phases, firstLesson, trajectory, lessonPlan }.
//   - phases:    [{id, label, lessonCount, tone}] from template
//   - lessonPlan: flat list of pending lesson-slot specs derived from phases
//                 + timeCommit. Each slot = { idx, phaseId, phaseLabel,
//                 phaseLessonIdx, ghost: true }. Lesson 0 gets the firstLesson
//                 fields filled; rest stay as pending ghosts.
async function designSeed({ topic, goal, archetype, timeCommit, customLessons, tier, clarifications, sourceDigest, goalContract }, settings) {
  const tmpl = loadArchetypeTemplate(archetype || 'TECH-CONCEPT');
  // 2026-05-13 v2 — time-floor + intent-density derivation.
  const _userIntent = (goalContract && goalContract.user_intent) || null;
  const _deadline = (goalContract && goalContract.deadline) || null;
  const _days = (goalContract && goalContract.days) || null;
  // 2026-05-13 R3 — designSeed has no KP candidate count (no harvest anchor in
  // this path), so resolveLessonShape falls back to time-floor only. We still
  // run it through the resolver to keep one canonical decision surface.
  const _shape = resolveLessonShape({
    kpCandidateCount: null,
    userIntent: _userIntent,
    timeCommit,
    customLessons,
    deadline: _deadline,
    days: _days,
    topic,
    phaseCount: tmpl.phases.length,
  });
  const counts = computePhaseLessonCounts(tmpl.phases, timeCommit, customLessons, tier, {
    user_intent: _userIntent,
    topic,
    deadline: _deadline,
    days: _days,
    totalOverride: _shape.source === 'custom-override' ? null : _shape.totalLessons,
  });
  const phases = tmpl.phases.map((p, i) => ({
    id: p.id,
    label: p.label,
    lessonCount: counts[i],
    tone: p.tone || '',
  }));

  // Build the pending lesson-plan: flat slots, one per planned lesson.
  // Slot 0 will be filled by firstLesson; all others stay ghosts until
  // proposeNextLesson materializes them just-ahead-of-need.
  const lessonPlan = [];
  let idx = 0;
  for (const ph of phases) {
    for (let li = 0; li < ph.lessonCount; li++) {
      lessonPlan.push({
        idx,
        phaseId: ph.id,
        phaseLabel: ph.label,
        phaseLessonIdx: li,
        phaseTone: ph.tone,
      });
      idx += 1;
    }
  }
  const totalLessons = lessonPlan.length;

  const profileBlock = userProfileBlock(settings && settings.userProfile);
  const frontierAnchor = (tmpl && tmpl.frontier_definition && tmpl.frontier_definition.prompt_anchor) || '';
  const sys = `${HYPHA_FULL}${profileBlock}You are seeding a Hypha curriculum: a sequence of one-on-one tutor conversations that build basics → frontier in the manuscript register. The PHASE STRUCTURE is already fixed (the user will see ${phases.length} phases: ${phases.map(p => p.label).join(', ')}, totaling ${totalLessons} lessons). Your job here is ONLY to:

1. Write the title + 1-sentence learnGoal + conceptId of LESSON 1 (the very first lesson, in phase "${phases[0].label}", phase tone: "${phases[0].tone}"). If the STUDENT PROFILE shows the student already knows the typical lesson-1 material, lift LESSON 1 to a higher entry point that matches their actual baseline.
2. Write a 2-3 sentence "trajectory" paragraph describing where the curriculum heads — concrete (names of mechanisms / frontier debates / final artifact), not generic.

Output STRICT JSON: { "firstLesson": { "title": string, "learnGoal": string, "conceptId": string }, "trajectory": string }

Hard rules:
- title: 4-10 words, concrete + specific. NEVER generic ("Introduction to X", "Overview"). Names a specific mechanism / claim / starting move.
- learnGoal: 1 sentence, plain. Single concrete claim or skill.
- conceptId: kebab-case stable identifier for the central concept this lesson teaches (e.g. "attention-qkv", "sigma-algebra", "productive-failure"). Used for cross-lesson concept tracking — once introduced via P6, future lessons reusing the same conceptId skip the prior-install step. Lowercase, hyphen-separated, 1-4 words.
- trajectory: ≤ 80 words. Names specific mechanisms / papers / artifacts the learner will reach by phase ${phases[phases.length - 1].label}. No generic words like "fundamentals", "essentials".
- Banned words: AI, LLM, embedding, model, prompt, agent, RAG, vector, fine-tune.${frontierAnchor ? `\n- Frontier window: ${frontierAnchor}` : ''}`;

  const userMsg = `Topic: ${topic}
Archetype: ${archetype}
Time commitment: ${timeCommit} (${totalLessons} lessons across ${phases.length} phases)
${goal ? `Student's stated goal: ${goal}\n` : ''}
${Array.isArray(clarifications) && clarifications.length ? `Clarifications:\n${clarifications.map(c => `  - ${c.question} → ${Array.isArray(c.answer) ? c.answer.join(', ') : c.answer}`).join('\n')}\n` : ''}
Shape of the field (digest):
${(sourceDigest || '').slice(0, 1500)}

Return the JSON now. Lesson 1 should be the most accessible entry point that an absolute beginner could start in one breath.`;

  let firstLesson = { title: topic, learnGoal: `Begin a deep traversal of ${topic}.` };
  let trajectory = `${phases.length} phases of conversation: ${phases.map(p => p.label).join(' → ')}.`;
  try {
    const raw = await llmJSON(
      [{ role: 'system', content: sys }, { role: 'user', content: userMsg }],
      settings,
      { json: true, temperature: 0.4, max_tokens: 600, timeoutMs: 30_000, fn: 'designSeed' }
    );
    const parsed = JSON.parse(raw);
    if (parsed.firstLesson && parsed.firstLesson.title && parsed.firstLesson.learnGoal) {
      firstLesson = parsed.firstLesson;
    }
    if (parsed.trajectory) trajectory = String(parsed.trajectory).slice(0, 600);
  } catch (err) {
    console.error('[designSeed] failed, using fallback:', err.message);
  }

  // Fill slot 0 of lessonPlan with firstLesson; rest stay ghosts.
  if (lessonPlan.length > 0) {
    lessonPlan[0].title = firstLesson.title;
    lessonPlan[0].learnGoal = firstLesson.learnGoal;
    lessonPlan[0].ghost = false;
    // v0158m — emit conceptId for P6 routing when LLM provided one.
    if (typeof firstLesson.conceptId === 'string' && firstLesson.conceptId.trim()) {
      lessonPlan[0].conceptId = firstLesson.conceptId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    }
    for (let i = 1; i < lessonPlan.length; i++) {
      lessonPlan[i].ghost = true;
    }
  }
  // R3 — stamp per-slot target_count when resolveLessonShape produced one
  // (only happens when a KP probe was available — not in pure designSeed path).
  // Otherwise leave undefined; downstream falls back to default targetCount.
  if (Array.isArray(_shape.perSlotKpTargets)) {
    for (let i = 0; i < lessonPlan.length; i++) {
      const t = _shape.perSlotKpTargets[i];
      if (Number.isFinite(t) && t > 0) lessonPlan[i].target_count = t;
    }
  }
  return {
    archetype: archetype || 'TECH-CONCEPT', phases, firstLesson, trajectory, lessonPlan,
    _shape: { source: _shape.source, totalLessons: _shape.totalLessons, daysFloor: _shape.daysFloor, lessonSplit: _shape.lessonSplit },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// v0.3 — designSkeletonOnly: SKELETON-FIRST curriculum design
// ─────────────────────────────────────────────────────────────────────────
//
// Sits ALONGSIDE legacy designSeed — does NOT replace it. The new v0.3 path
// (per project_hypha_v03_2stage_gen 2-stage flow) calls designSkeletonOnly
// during STAGE 1 to produce a SKELETON for user approval, then later (after
// the user clicks 开始上课) STAGE 2 calls generateLessonBodyV2 in
// lesson-body-generator.js to produce the actual lesson body.
//
// Why this exists:
//   v0.2.1 designSeed shipped a 哲学 course whose tutor opened at Galileo
//   1633 + Descartes, skipping pre-Socratics. Root cause: LLM training-
//   frequency prior puts Descartes/Galileo above Thales (more famous = more
//   mentioned), and designSeed had no external syllabus anchor. v0.3 cure:
//   harvestV3 Layer 1 returns canonical lectureSequence + prerequisiteChain;
//   designSkeletonOnly is REQUIRED to honor it as STRUCTURE ANCHOR. Deviation
//   is allowed only with explicit reason in _meta.deviations[].
//
// Differences from legacy designSeed:
//   1. Accepts args.structureAnchor (mandatory if provided; graceful fallback
//      to designSeed if null/empty).
//   2. Adds 3 new per-slot fields to lessonPlan: scope_in / scope_out /
//      prerequisite — surface the boundary between adjacent lessons.
//   3. NO firstLesson body content — lessonPlan slots are SKELETON ONLY
//      (each marked ghost: true; STAGE 2 fills body via generateLessonBodyV2).
//   4. _meta.deviations[] records explicit deviations from the anchor.
//
// Returns:
//   {
//     archetype, phases, lessonPlan, trajectory,
//     _meta: { deviations: [...], structure_anchor_used: bool }
//   }
//
// Each lessonPlan[].slot:
//   { idx, phaseId, phaseLabel, phaseLessonIdx, phaseTone,
//     title, learnGoal, conceptId,
//     scope_in, scope_out, prerequisite,
//     ghost: true }
async function designSkeletonOnly(args, settings) {
  args = args || {};
  const { topic, goal, archetype, timeCommit, customLessons, tier, clarifications, sourceDigest } = args;
  const structureAnchor = args.structureAnchor || null;

  // ── Graceful fallback when no structure anchor present ────────────────
  // Per spec: "If null/empty → fall back to designSeed legacy behavior +
  // emit warning (graceful for archetypes/topics where Layer 1 returned
  // nothing)." Examples: 'cooking' / niche topics without canonical syllabus.
  const hasAnchor = structureAnchor
    && Array.isArray(structureAnchor.lectureSequence)
    && structureAnchor.lectureSequence.length > 0;
  if (!hasAnchor) {
    const legacy = await designSeed({
      topic, goal, archetype, timeCommit, customLessons, tier, clarifications, sourceDigest,
    }, settings);
    // Reshape legacy output to skeleton shape: drop firstLesson body content,
    // mark all slots ghost, add empty scope fields. _meta tags the fallback.
    const lessonPlan = (legacy.lessonPlan || []).map((slot, i) => Object.assign({}, slot, {
      ghost: true,
      title: i === 0 && legacy.firstLesson ? (legacy.firstLesson.title || slot.title || '') : (slot.title || ''),
      learnGoal: i === 0 && legacy.firstLesson ? (legacy.firstLesson.learnGoal || slot.learnGoal || '') : (slot.learnGoal || ''),
      conceptId: slot.conceptId || (i === 0 && legacy.firstLesson ? (legacy.firstLesson.conceptId || '') : ''),
      scope_in: '',
      scope_out: '',
      prerequisite: '',
      // R3 — propagate target_count if designSeed stamped one (rare in this
      // path since designSeed has no KP probe, but kept for completeness).
      target_count: (Number.isFinite(slot.target_count) && slot.target_count > 0) ? slot.target_count : undefined,
    }));
    return {
      archetype: legacy.archetype,
      phases: legacy.phases,
      lessonPlan,
      trajectory: legacy.trajectory,
      _meta: {
        deviations: [],
        structure_anchor_used: false,
        fallback_reason: 'no_structure_anchor — falling back to legacy designSeed shape',
        lesson_shape: legacy._shape || null,
      },
    };
  }

  // ── Anchor present — drive skeleton from Layer 1 lectureSequence ─────
  const tmpl = loadArchetypeTemplate(archetype || 'TECH-CONCEPT');
  // 2026-05-13 v2 — time-floor + intent-density derivation (user: "100天给38节
  // 什么意思 至少一天一节"). Resolves days from goalContract.deadline if set.
  const _userIntent = (args && args.goalContract && args.goalContract.user_intent) || null;
  const _deadline = (args && args.goalContract && args.goalContract.deadline) || null;
  const _days = (args && args.goalContract && args.goalContract.days) || null;
  // 2026-05-13 R3 — KP candidate count from harvested canonical lecture
  // sequence. lessonSplit consumes this; resolveLessonShape reconciles
  // kp-density vs day-floor. Reject signal (KP ≥ 27) propagates as a thrown
  // error so main.js can emit `curriculum_v3_lesson_split_topic_too_broad`.
  const _kpCandidateCount = (structureAnchor.lectureSequence || []).length;
  const _shape = resolveLessonShape({
    kpCandidateCount: _kpCandidateCount,
    userIntent: _userIntent,
    timeCommit,
    customLessons,
    deadline: _deadline,
    days: _days,
    topic,
    phaseCount: tmpl.phases.length,
  });
  if (_shape.reject) {
    const err = new Error(_shape.reject);
    err.code = 'TOPIC_TOO_BROAD';
    err.kpCandidateCount = _kpCandidateCount;
    err.userIntent = _userIntent;
    throw err;
  }
  const counts = computePhaseLessonCounts(tmpl.phases, timeCommit, customLessons, tier, {
    user_intent: _userIntent,
    topic,
    deadline: _deadline,
    days: _days,
    totalOverride: _shape.source === 'custom-override' ? null : _shape.totalLessons,
  });
  const phases = tmpl.phases.map((p, i) => ({
    id: p.id,
    label: p.label,
    lessonCount: counts[i],
    tone: p.tone || '',
  }));

  // Build base lesson-plan slots from phase counts (same as designSeed).
  const lessonPlan = [];
  let idx = 0;
  for (const ph of phases) {
    for (let li = 0; li < ph.lessonCount; li++) {
      lessonPlan.push({
        idx,
        phaseId: ph.id,
        phaseLabel: ph.label,
        phaseLessonIdx: li,
        phaseTone: ph.tone,
      });
      idx += 1;
    }
  }
  const totalLessons = lessonPlan.length;

  // ── Build STRUCTURE ANCHOR blocks for system prompt ────────────────────
  const lectureSequenceFmt = (structureAnchor.lectureSequence || []).slice(0, 30)
    .map(lec => {
      const prereq = (Array.isArray(lec.prerequisite_idxs) && lec.prerequisite_idxs.length)
        ? ` [prereq idx: ${lec.prerequisite_idxs.join(', ')}]`
        : '';
      return `${lec.idx}. ${lec.title}${prereq}`;
    }).join('\n');

  const prerequisiteChainFmt = (structureAnchor.prerequisiteChain || []).slice(0, 20)
    .map(edge => {
      const pre = Array.isArray(edge.prerequisites) ? edge.prerequisites.join(' / ') : '';
      return `- ${edge.concept} ⇐ ${pre || '(no prereq)'}`;
    }).join('\n');

  const anchorCoursesFmt = (structureAnchor.anchorCourses || []).slice(0, 3)
    .map(c => `- ${c.title} (${c.source})`).join('\n');

  const profileBlock = userProfileBlock(settings && settings.userProfile);
  const frontierAnchor = (tmpl && tmpl.frontier_definition && tmpl.frontier_definition.prompt_anchor) || '';

  // W6.1 Book Grounding (BLUEPRINT §4) — inject GROUNDING PROFILE block AHEAD
  // of LIBRARY_EVIDENCE so the planner sees high-level book roles before
  // chunk-level evidence. Synthesis was built by main.js before this call.
  // Args may carry `groundingSynthesis` + `groundingProfiles` from main.js.
  let groundingBlock = '';
  try {
    if (args && args.groundingSynthesis) {
      const _grounding = require('./lib/grounding');
      groundingBlock = _grounding.renderGroundingBlock(args.groundingSynthesis, args.groundingProfiles || []);
    }
  } catch (_) {
    groundingBlock = '';
  }
  const groundingSection = groundingBlock ? `${groundingBlock}\n\n` : '';

  // W8.2 Flywheel · Step 4 — Commons → Lesson hint. Find top-3 Commons packs
  // relevant to the current topic and prepend COMMONS HINTS block AHEAD of
  // LIBRARY_EVIDENCE. Same delivery contract as LIBRARY_EVIDENCE — purely
  // additive system-prompt context. Best-effort; degrades to empty string
  // when the flywheel lib isn't loadable.
  let commonsHintsSection = '';
  try {
    const _c2l = require('./lib/flywheel/commons-to-lesson');
    const lessonTopicProbe = (args && (args.topic || args.topicSlug)) || topic || '';
    if (lessonTopicProbe) {
      const found = _c2l.findRelevantCommonsForLesson(args && args.topicSlug || '', lessonTopicProbe, { topK: 3 });
      const block = _c2l.injectCommonsIntoLessonPrompt({ topic: lessonTopicProbe }, (found && found.packs) || []);
      commonsHintsSection = block ? `${block}\n\n` : '';
    }
  } catch (_) {
    commonsHintsSection = '';
  }

  const sys = `${HYPHA_FULL}${profileBlock}You are designing a curriculum skeleton. The user has invested time. Speed is anti-trust.

${commonsHintsSection}${groundingSection}CANONICAL SYLLABUS ORDER (from Layer 1 anchor courses — TREAT AS STRUCTURE ANCHOR):
${lectureSequenceFmt}

PREREQUISITE CHAIN:
${prerequisiteChainFmt || '(none extracted; respect lecture order above)'}

ANCHOR COURSES:
${anchorCoursesFmt || '(none)'}

YOUR LESSON PLAN MUST RESPECT THIS ORDER. If you deviate, justify in _meta.deviations[] with reason.

The PHASE STRUCTURE is fixed (the user will see ${phases.length} phases: ${phases.map(p => p.label).join(', ')}, totaling ${totalLessons} lessons).

Each lesson SLOT must include:
  - title — 4-10 words, concrete + specific. Names a specific mechanism / claim / starting move. NEVER generic.
  - learnGoal — 1 sentence, plain. Single concrete claim or skill.
  - conceptId — kebab-case stable identifier (e.g. "thales-water-monism", "sigma-algebra"). Lowercase, hyphen-separated, 1-4 words.
  - scope_in — 1-2 sentences, what THIS lesson covers (concrete, named).
  - scope_out — 1-2 sentences, what THIS lesson EXPLICITLY does NOT cover (defers to which other lesson, or out-of-scope entirely).
  - prerequisite — 1 sentence, what user must already know.

DO NOT generate lesson body content. Only skeleton.

Output STRICT JSON:
{
  "lessonPlan": [
    { "idx": 0, "title": "...", "learnGoal": "...", "conceptId": "...",
      "scope_in": "...", "scope_out": "...", "prerequisite": "..." },
    ...one entry per slot, idx 0..${totalLessons - 1}...
  ],
  "trajectory": "2-3 sentences naming specific mechanisms / papers / artifacts the learner reaches by phase ${phases[phases.length - 1].label}",
  "_meta": {
    "deviations": [
      { "idx": <slot idx>, "original_canonical_lecture": "<from CANONICAL SYLLABUS ORDER>", "replaced_with": "<your title>", "reason": "<why>" }
    ],
    "structure_anchor_used": true
  }
}

Hard rules:
- ${totalLessons} lessonPlan entries, idx 0..${totalLessons - 1}, in order.
- For TOTAL lessons ≤ canonical lectures, use the FIRST ${totalLessons} canonical lectures verbatim or adapt them. For TOTAL lessons > canonical lectures, USE all canonical lectures in order then EXTEND with deeper / applied / frontier lessons in the final phase.
- Lesson 0 MUST anchor at the start of the canonical sequence (the very first canonical lecture / earliest concept). Do not skip to a famous-but-late icon.
- Banned words: AI, LLM, embedding, model, prompt, agent, RAG, vector, fine-tune.${frontierAnchor ? `\n- Frontier window: ${frontierAnchor}` : ''}`;

  const userMsg = `Topic: ${topic}
Archetype: ${archetype}
Time commitment: ${timeCommit} (${totalLessons} lessons across ${phases.length} phases)
${goal ? `Student's stated goal: ${goal}\n` : ''}${Array.isArray(clarifications) && clarifications.length ? `Clarifications:\n${clarifications.map(c => `  - ${c.question} → ${Array.isArray(c.answer) ? c.answer.join(', ') : c.answer}`).join('\n')}\n` : ''}Shape of the field (digest):
${(sourceDigest || '').slice(0, 1500)}

Phase plan:
${phases.map((p, i) => `  ${i + 1}. ${p.label} — ${p.lessonCount} lesson(s) — tone: ${p.tone || '(default)'}`).join('\n')}

Return the JSON now. Anchor lesson 0 at the start of the canonical syllabus order. Do not skip to famous-but-late icons.`;

  // ── LLM call ─────────────────────────────────────────────────────────
  // Lazy-require ./lib/llm to avoid circular boot. Falls back to llmJSON
  // (legacy provider path) if executeChat unavailable. Both paths produce
  // a JSON string we parse below.
  let raw = '';
  let llmCallOk = false;
  try {
    let llm = null;
    try { llm = require('./lib/llm'); } catch (_) { llm = null; }
    if (llm && typeof llm.executeChat === 'function') {
      const _t0 = Date.now();
      const dispatch = await llm.executeChat('T6_STRONG', {
        messages: [
          { role: 'system', content: sys },
          { role: 'user',   content: userMsg },
        ],
        json: true,
        temperature: 0.4,
        maxTokens: 4000,
        timeoutMs: 90000,
      });
      const _latency = Date.now() - _t0;
      // V0.5 E0 D6 — record cost estimate row for designSkeletonOnly call.
      // Wrapped: recordChatCallEstimate must never break course creation.
      try {
        sqliteDb.recordChatCallEstimate(dispatch, 'designSkeletonOnly', {
          latency_ms: _latency,
          tuple_id: (args && args.topicSlug) || null,
          slug: (args && args.topicSlug) || null,
          success: true,
        });
      } catch (err) {
        console.warn('[recordChatCallEstimate] designSkeletonOnly slug=', (args && args.topicSlug) || '_global', 'err=', err && err.message);
      }
      // executeChat result shape varies per provider; pull text content.
      const r = dispatch && dispatch.result;
      if (typeof r === 'string') raw = r;
      else if (r && typeof r.content === 'string') raw = r.content;
      else if (r && r.message && typeof r.message.content === 'string') raw = r.message.content;
      else if (r && Array.isArray(r.choices) && r.choices[0] && r.choices[0].message
               && typeof r.choices[0].message.content === 'string') raw = r.choices[0].message.content;
      else raw = JSON.stringify(r || dispatch || {});
      llmCallOk = true;
    } else {
      // Fallback: legacy llmJSON (provider abstraction in this file).
      raw = await llmJSON(
        [{ role: 'system', content: sys }, { role: 'user', content: userMsg }],
        settings,
        { json: true, temperature: 0.4, max_tokens: 4000, timeoutMs: 90_000, fn: 'designSkeletonOnly' }
      );
      llmCallOk = true;
    }
  } catch (err) {
    console.error('[designSkeletonOnly] LLM call failed:', err && err.message ? err.message : err);
  }

  let parsed = null;
  if (llmCallOk && raw) {
    try {
      const cleaned = _extractFirstJSON(raw);
      parsed = (typeof cleaned === 'string') ? JSON.parse(cleaned) : cleaned;
    } catch (e) {
      console.error('[designSkeletonOnly] JSON parse failed:', e && e.message ? e.message : e);
    }
  }

  // ── Merge LLM output into lessonPlan slots; ghost = true for all ──────
  let trajectory = `${phases.length} phases: ${phases.map(p => p.label).join(' → ')}.`;
  let deviations = [];
  let structureAnchorUsed = true;
  if (parsed && Array.isArray(parsed.lessonPlan)) {
    for (const entry of parsed.lessonPlan) {
      if (!entry || typeof entry.idx !== 'number') continue;
      const i = entry.idx;
      if (i < 0 || i >= lessonPlan.length) continue;
      lessonPlan[i].title       = String(entry.title || '').slice(0, 200);
      lessonPlan[i].learnGoal   = String(entry.learnGoal || '').slice(0, 400);
      lessonPlan[i].conceptId   = String(entry.conceptId || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 60);
      lessonPlan[i].scope_in    = String(entry.scope_in || '').slice(0, 400);
      lessonPlan[i].scope_out   = String(entry.scope_out || '').slice(0, 400);
      lessonPlan[i].prerequisite = String(entry.prerequisite || '').slice(0, 400);
      lessonPlan[i].ghost = true; // SKELETON ONLY — STAGE 2 fills body
    }
    if (typeof parsed.trajectory === 'string') trajectory = parsed.trajectory.slice(0, 600);
    if (parsed._meta) {
      if (Array.isArray(parsed._meta.deviations)) deviations = parsed._meta.deviations;
      if (typeof parsed._meta.structure_anchor_used === 'boolean') {
        structureAnchorUsed = parsed._meta.structure_anchor_used;
      }
    }
  } else {
    // LLM failed entirely — fill from canonical sequence verbatim so the
    // skeleton at least surfaces canonical ordering. scope_in/out/prereq
    // empty strings; user will hit 需要修改 to regen.
    const seq = structureAnchor.lectureSequence || [];
    for (let i = 0; i < lessonPlan.length; i++) {
      const lec = seq[i];
      if (lec) {
        lessonPlan[i].title = String(lec.title || '').slice(0, 200);
        lessonPlan[i].learnGoal = '';
        lessonPlan[i].conceptId = '';
        lessonPlan[i].scope_in = '';
        lessonPlan[i].scope_out = '';
        lessonPlan[i].prerequisite = i > 0 && seq[i - 1] ? `Lesson ${i}: ${seq[i - 1].title}` : '';
      } else {
        lessonPlan[i].title = '';
        lessonPlan[i].learnGoal = '';
        lessonPlan[i].conceptId = '';
        lessonPlan[i].scope_in = '';
        lessonPlan[i].scope_out = '';
        lessonPlan[i].prerequisite = '';
      }
      lessonPlan[i].ghost = true;
    }
  }

  // Final ghost-mark sweep — every slot is a ghost in skeleton-only path.
  for (const slot of lessonPlan) slot.ghost = true;

  // R3 — stamp per-slot target_count from resolveLessonShape decision.
  // Always present in this anchor-driven path (kpCandidateCount was set).
  if (Array.isArray(_shape.perSlotKpTargets)) {
    for (let i = 0; i < lessonPlan.length; i++) {
      const t = _shape.perSlotKpTargets[i];
      if (Number.isFinite(t) && t > 0) lessonPlan[i].target_count = t;
    }
  }

  return {
    archetype: archetype || 'TECH-CONCEPT',
    phases,
    lessonPlan,
    trajectory,
    _meta: {
      deviations,
      structure_anchor_used: structureAnchorUsed,
      lesson_shape: {
        source: _shape.source,
        totalLessons: _shape.totalLessons,
        daysFloor: _shape.daysFloor,
        kpCandidateCount: _kpCandidateCount,
        lessonSplit: _shape.lessonSplit,
      },
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// critiqueAndRefineSkeleton — 4-wave critique + regen loop on top of
// designSkeletonOnly. Per user 2026-05-13 "三令五申 ensure skeleton quality
// — 1 min generation is anti-trust" feedback (memory `course_gen_slow_visible`
// already articulated 5-15 min visible labor as the trust floor).
//
// Wave 1: input — initial skeleton from designSkeletonOnly (already done by caller)
// Wave 2: parallel 3-agent critique (Lung / Muse / Scout, T4_JUDGE each, ~60-90s)
//   - Lung divergent: missing KPs, cross-domain edges, training-frequency gaps
//   - Muse critical: Feynman-test failures, encyclopedia framing, scope drift
//   - Scout citation: evidence anchor strength per lesson (library/community/web)
// Wave 3: synth + regen — fold critique into a regen call to LLM (T6_STRONG)
// Wave 4: structural validation + return same shape as designSkeletonOnly
//
// onProgress is called at each wave boundary with { stage, ...extra } so the
// caller can stream progress events to the UI (curriculum:progress channel).
// ──────────────────────────────────────────────────────────────────────
async function critiqueAndRefineSkeleton(args, settings) {
  args = args || {};
  const {
    initialSkeleton,
    topic,
    goal,
    archetype,
    harvestContext,
    sourceDigest,
    structureAnchor,
    onProgress,
  } = args;
  const emit = (stage, extra) => { try { onProgress && onProgress(stage, extra || {}); } catch (_) {} };

  if (!initialSkeleton || !Array.isArray(initialSkeleton.lessonPlan) || initialSkeleton.lessonPlan.length === 0) {
    emit('critique:skipped', { reason: 'no initial skeleton — nothing to critique' });
    return initialSkeleton;
  }

  // Render skeleton as compact bullet list for critique prompts
  const skeletonStr = initialSkeleton.lessonPlan.map(s =>
    `${s.idx}. ${s.title || '(untitled)'} — goal: ${s.learnGoal || '(none)'} / scope_in: ${(s.scope_in || '').slice(0, 120)} / prereq: ${(s.prerequisite || '').slice(0, 120)}`
  ).join('\n');

  // Build LIBRARY_EVIDENCE + COMMUNITY_HINT context blocks (already rendered
  // by lesson-generator for skeleton stage — duplicate logic here to keep
  // critique calls self-sufficient without re-importing lesson-generator).
  const ctxBlocks = [];
  if (harvestContext && Array.isArray(harvestContext.libraryRollup) && harvestContext.libraryRollup.length > 0) {
    const top = harvestContext.libraryRollup.slice(0, 3);
    ctxBlocks.push('LIBRARY EVIDENCE:\n' + top.map(b => {
      const author = b.book_author ? ` — ${b.book_author}` : '';
      const tocLine = Array.isArray(b.toc) && b.toc.length > 0
        ? '  TOC: ' + b.toc.slice(0, 10).map(t => t.title).join(' / ')
        : '';
      return `- ${b.book_title}${author} (D/P/R=${b.direct_hits}/${b.prereq_hits}/${b.related_hits})\n${tocLine}`;
    }).join('\n'));
  }
  if (harvestContext && harvestContext.communityHint && Array.isArray(harvestContext.communityHint.packs_used) && harvestContext.communityHint.packs_used.length > 0) {
    const syllabusByPack = {};
    for (const item of (harvestContext.communityHint.syllabus_skeleton || [])) {
      if (!syllabusByPack[item.pack_id]) syllabusByPack[item.pack_id] = [];
      syllabusByPack[item.pack_id].push(item.chapter);
    }
    ctxBlocks.push('COMMUNITY PACK HINTS:\n' + harvestContext.communityHint.packs_used.map(p =>
      `- ${p.id} (curator: ${p.curator}): ${(syllabusByPack[p.id] || []).slice(0, 6).join(' / ')}`
    ).join('\n'));
  }
  const ctxStr = ctxBlocks.join('\n\n');

  // ── Wave 2: 3 parallel critiques (Lung / Muse / Scout) ───────────────
  emit('critique:start', { skeleton_n: initialSkeleton.lessonPlan.length });

  const lungPrompt = `You are LUNG — divergent connection-finder. Audit this curriculum skeleton for what's MISSING.

Topic: ${topic}
Goal: ${goal || '(none)'}
Archetype: ${archetype || '(none)'}

CURRENT SKELETON:
${skeletonStr}

${ctxStr ? ctxStr + '\n\n' : ''}Find:
1. Cross-domain edges the skeleton ignores (other fields' analogous concepts)
2. KPs implicitly assumed but never made explicit
3. Training-frequency bias — does the skeleton lean on famous-but-late icons over earlier necessary anchors? (Per pedagogy.md Galileo-skip bug — e.g. teaching Spinoza without Plato substance prereq)
4. Adjacent useful concepts that would 10x understanding if added

Return STRICT JSON: { "findings": [{ "type": "missing-kp|cross-domain|training-bias|adjacent-concept", "lesson_idx": <int|null>, "issue": "<≤120 char>", "fix_suggestion": "<≤200 char>" }], "overall_note": "<≤200 char>" }`;

  const musePrompt = `You are MUSE — critical attacker, user-perspective challenger. Audit this curriculum skeleton for failures.

Topic: ${topic}
Goal: ${goal || '(none)'}

CURRENT SKELETON:
${skeletonStr}

${ctxStr ? ctxStr + '\n\n' : ''}Find:
1. Feynman test failures — lessons whose learnGoal you can't apply to a concrete instance (definition-only, encyclopedia framing)
2. Scope drift — scope_in vs goal mismatch
3. Prereq gaps — a lesson requires X but no prior lesson teaches X
4. Vague titles ("Introduction to ___" / "Overview of ___") — banned anti-patterns

Return STRICT JSON: { "findings": [{ "type": "feynman-fail|scope-drift|prereq-gap|vague-title", "lesson_idx": <int|null>, "issue": "<≤120 char>", "fix_suggestion": "<≤200 char>" }], "overall_note": "<≤200 char>" }`;

  const scoutPrompt = `You are SCOUT — citation auditor. Audit this curriculum skeleton against the evidence base.

Topic: ${topic}
Goal: ${goal || '(none)'}

CURRENT SKELETON:
${skeletonStr}

${ctxStr || '(no library/community evidence present — assess based on canonical priors only)'}

Find:
1. Lessons with NO evidence anchor in library/community/web sources (LLM training-frequency only)
2. Lessons where the cited evidence type mismatches the lesson's claim type (definition vs argument vs critique)
3. Lessons that should anchor to a specific book/pack section but currently float

Return STRICT JSON: { "findings": [{ "type": "no-anchor|type-mismatch|float", "lesson_idx": <int|null>, "issue": "<≤120 char>", "fix_suggestion": "<≤200 char>" }], "overall_note": "<≤200 char>" }`;

  const runCritique = async (label, prompt) => {
    emit(`critique:${label}:start`, {});
    let raw = '';
    try {
      let llm = null;
      try { llm = require('./lib/llm'); } catch (_) { llm = null; }
      if (llm && typeof llm.executeChat === 'function') {
        const d = await llm.executeChat('T4_JUDGE', {
          messages: [{ role: 'user', content: prompt }],
          json: true,
          temperature: 0.6,
          maxTokens: 1500,
          timeoutMs: 90000,
        });
        const r = d && d.result;
        if (typeof r === 'string') raw = r;
        else if (r && typeof r.content === 'string') raw = r.content;
        else if (r && r.message && typeof r.message.content === 'string') raw = r.message.content;
        else if (r && Array.isArray(r.choices) && r.choices[0] && r.choices[0].message && typeof r.choices[0].message.content === 'string') raw = r.choices[0].message.content;
        else raw = JSON.stringify(r || d || {});
      } else {
        raw = await llmJSON([{ role: 'user', content: prompt }], settings, { json: true, temperature: 0.6, max_tokens: 1500, timeoutMs: 90_000, fn: `critique-${label}` });
      }
    } catch (e) {
      console.error(`[critique:${label}] LLM call failed:`, e && e.message);
      raw = '';
    }
    let parsed = null;
    if (raw) {
      try {
        const cleaned = _extractFirstJSON(raw);
        parsed = (typeof cleaned === 'string') ? JSON.parse(cleaned) : cleaned;
      } catch (_) { parsed = null; }
    }
    const findings = (parsed && Array.isArray(parsed.findings)) ? parsed.findings.slice(0, 12) : [];
    const overall = (parsed && typeof parsed.overall_note === 'string') ? parsed.overall_note.slice(0, 300) : '';
    emit(`critique:${label}:done`, { findings_n: findings.length });
    return { label, findings, overall };
  };

  const [lung, muse, scout] = await Promise.all([
    runCritique('lung', lungPrompt),
    runCritique('muse', musePrompt),
    runCritique('scout', scoutPrompt),
  ]);
  emit('critique:done', {
    lung_n: lung.findings.length,
    muse_n: muse.findings.length,
    scout_n: scout.findings.length,
  });

  // ── Wave 3: synth + regen ─────────────────────────────────────────────
  emit('refine:start', {});

  const formatFindings = (c) => c.findings.length === 0
    ? `  (no issues found by ${c.label})`
    : c.findings.map(f => `  - [lesson ${f.lesson_idx == null ? '*' : f.lesson_idx}] (${f.type}) ${f.issue}\n    → ${f.fix_suggestion}`).join('\n');

  const totalFindings = lung.findings.length + muse.findings.length + scout.findings.length;
  if (totalFindings === 0) {
    // No critique findings — skip regen, return original
    emit('refine:skipped', { reason: 'no critique findings' });
    return Object.assign({}, initialSkeleton, {
      _meta: Object.assign({}, initialSkeleton._meta || {}, {
        critique: {
          lung_findings_n: 0,
          muse_findings_n: 0,
          scout_findings_n: 0,
          refined: false,
        },
      }),
    });
  }

  const refinePrompt = `You are refining a curriculum skeleton based on critique from 3 advisors.

Topic: ${topic}
Goal: ${goal || '(none)'}
Archetype: ${archetype || '(none)'}

ORIGINAL SKELETON:
${skeletonStr}

CRITIQUE — LUNG (divergent, missing KPs):
${formatFindings(lung)}
  Overall: ${lung.overall || '(none)'}

CRITIQUE — MUSE (Feynman test + scope):
${formatFindings(muse)}
  Overall: ${muse.overall || '(none)'}

CRITIQUE — SCOUT (evidence anchor):
${formatFindings(scout)}
  Overall: ${scout.overall || '(none)'}

${ctxStr ? ctxStr + '\n\n' : ''}TASK: Output a REVISED skeleton that addresses the critique. Keep ${initialSkeleton.lessonPlan.length} lessons unless critique explicitly demands a different count. Each lesson:
  - title (4-10 words, concrete + specific, NEVER generic)
  - learnGoal (single concrete claim/skill, plain sentence)
  - conceptId (kebab-case stable id, 1-4 words)
  - scope_in (1-2 sentences, named + specific)
  - scope_out (1-2 sentences, explicitly excluded with reason)
  - prerequisite (1 sentence, what user must already know)

PRIORITIES: (a) anchor early lessons in prereq concepts (combat Galileo-skip). (b) replace vague titles with concrete mechanism names. (c) cite library/pack evidence where Scout flagged float.

Forbidden words: AI, LLM, embedding, model, prompt, agent, RAG, vector, fine-tune.

Output STRICT JSON: { "lessonPlan": [{ "idx": <int>, "title": "...", "learnGoal": "...", "conceptId": "...", "scope_in": "...", "scope_out": "...", "prerequisite": "..." }, ...], "trajectory": "<2-3 sentences>", "_meta": { "critique_applied": ["<lung_issue_addressed>", "<muse_issue_addressed>", ...], "deviations": [] } }`;

  let refinedRaw = '';
  try {
    let llm = null;
    try { llm = require('./lib/llm'); } catch (_) { llm = null; }
    if (llm && typeof llm.executeChat === 'function') {
      const d = await llm.executeChat('T6_STRONG', {
        messages: [{ role: 'user', content: refinePrompt }],
        json: true,
        temperature: 0.4,
        maxTokens: 4000,
        timeoutMs: 120000,
      });
      const r = d && d.result;
      if (typeof r === 'string') refinedRaw = r;
      else if (r && typeof r.content === 'string') refinedRaw = r.content;
      else if (r && r.message && typeof r.message.content === 'string') refinedRaw = r.message.content;
      else if (r && Array.isArray(r.choices) && r.choices[0] && r.choices[0].message && typeof r.choices[0].message.content === 'string') refinedRaw = r.choices[0].message.content;
      else refinedRaw = JSON.stringify(r || d || {});
    } else {
      refinedRaw = await llmJSON([{ role: 'user', content: refinePrompt }], settings, { json: true, temperature: 0.4, max_tokens: 4000, timeoutMs: 120_000, fn: 'refineSkeleton' });
    }
  } catch (e) {
    console.error('[refine] LLM call failed:', e && e.message);
    refinedRaw = '';
  }

  let refinedParsed = null;
  if (refinedRaw) {
    try {
      const cleaned = _extractFirstJSON(refinedRaw);
      refinedParsed = (typeof cleaned === 'string') ? JSON.parse(cleaned) : cleaned;
    } catch (_) { refinedParsed = null; }
  }

  // ── Wave 4: structural validation + merge ─────────────────────────────
  if (!refinedParsed || !Array.isArray(refinedParsed.lessonPlan) || refinedParsed.lessonPlan.length === 0) {
    emit('refine:failed', { reason: 'refine LLM returned no usable lessonPlan; keeping original' });
    return Object.assign({}, initialSkeleton, {
      _meta: Object.assign({}, initialSkeleton._meta || {}, {
        critique: {
          lung_findings_n: lung.findings.length,
          muse_findings_n: muse.findings.length,
          scout_findings_n: scout.findings.length,
          refined: false,
          refine_failed: true,
        },
      }),
    });
  }

  // Merge refined fields back into the canonical lessonPlan shape (preserve
  // phaseId / phaseLabel / phaseLessonIdx / phaseTone from initial — those
  // come from archetype template, not LLM output).
  const refinedLessonPlan = initialSkeleton.lessonPlan.map((slot, i) => {
    const entry = refinedParsed.lessonPlan.find(e => e && e.idx === i)
      || refinedParsed.lessonPlan[i]
      || null;
    if (!entry) return slot;
    return Object.assign({}, slot, {
      title: String(entry.title || slot.title || '').slice(0, 200),
      learnGoal: String(entry.learnGoal || slot.learnGoal || '').slice(0, 400),
      conceptId: String(entry.conceptId || slot.conceptId || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 60),
      scope_in: String(entry.scope_in || slot.scope_in || '').slice(0, 400),
      scope_out: String(entry.scope_out || slot.scope_out || '').slice(0, 400),
      prerequisite: String(entry.prerequisite || slot.prerequisite || '').slice(0, 400),
      ghost: true,
    });
  });

  emit('refine:done', { lesson_n: refinedLessonPlan.length });

  return {
    archetype: initialSkeleton.archetype,
    phases: initialSkeleton.phases,
    lessonPlan: refinedLessonPlan,
    trajectory: (typeof refinedParsed.trajectory === 'string' ? refinedParsed.trajectory.slice(0, 600) : initialSkeleton.trajectory),
    _meta: Object.assign({}, initialSkeleton._meta || {}, {
      critique: {
        lung_findings_n: lung.findings.length,
        muse_findings_n: muse.findings.length,
        scout_findings_n: scout.findings.length,
        critique_applied: Array.isArray(refinedParsed._meta && refinedParsed._meta.critique_applied) ? refinedParsed._meta.critique_applied : [],
        refined: true,
      },
    }),
  };
}

// proposeNextLesson — Stage 3 of the pipeline. Given prior lesson outcomes
// (atlas + variance) and the next pending slot's phase context, generate ONE
// lesson's title + learnGoal. Cheap (~250 tokens out, 3-5s wall time). Fires
// from the existing lessons:adapt-after-finish IPC when the next slot is a
// ghost (body still '_pending_').
//
// Inputs:
//   topic           — curriculum topic
//   archetype       — for tone reference
//   slot            — { idx, phaseId, phaseLabel, phaseLessonIdx, phaseTone }
//   priorLessons    — array of { idx, title, learnGoal } already taught/written
//   priorAtlas      — top settled concepts from prior lessons (string[])
//   priorVariance   — last variance card { intentEcho, driftSummary }
//   retrievedSources — top-K sources from BM25 ranking (max 5 entries)
//
// Returns { title, learnGoal }.
async function proposeNextLesson({ topic, archetype, slot, priorLessons, priorAtlas, priorVariance, retrievedSources }, settings) {
  const sys = `${HYPHA_FULL}You write ONE lesson's title + learnGoal for a Hypha curriculum mid-flight. You see what the learner has already covered + settled, and write the next lesson with concrete knowledge of priors.

Phase: ${slot.phaseLabel} (slot ${slot.phaseLessonIdx + 1} within phase). Tone: "${slot.phaseTone || 'editorial, specific'}".

Output STRICT JSON: { "title": string, "learnGoal": string, "conceptId": string }

Rules:
- title: 4-10 words, concrete + specific. Reference the actual mechanism / paper / technique. NEVER generic.
- learnGoal: 1 plain-language sentence. The single concrete claim or skill.
- conceptId: kebab-case stable identifier for the central concept this lesson teaches (e.g. "attention-qkv", "backprop-chain-rule", "phlogiston-theory"). Used for cross-lesson tracking — once introduced via P6, future lessons reusing the same conceptId skip prior-install. Lowercase, hyphen-separated, 1-4 words. Reuse a previously-introduced conceptId IF this lesson genuinely revisits / deepens the same concept.
- Stay within the phase tone. Reference at least one concept from priorAtlas where natural (continuity).
- If retrievedSources contain a recent named paper, cite the author / title in the learnGoal where it fits.
- Banned words: AI, LLM, embedding, model, prompt, agent, RAG, vector, fine-tune.`;

  const priorTitlesLine = (priorLessons || [])
    .slice(-3)
    .map(l => `  · ${l.title} → ${l.learnGoal}`)
    .join('\n');
  const sourcesLine = (retrievedSources || [])
    .slice(0, 5)
    .map(s => `  · [${s.sourceType}] ${s.title}${s.excerpt ? ' — ' + s.excerpt.slice(0, 120) : ''}`)
    .join('\n');

  const userMsg = `Topic: ${topic}
Archetype: ${archetype}
Phase: ${slot.phaseLabel}, lesson ${slot.phaseLessonIdx + 1} of phase

${priorTitlesLine ? `Last 3 lessons taught:\n${priorTitlesLine}\n` : ''}
${(priorAtlas && priorAtlas.length) ? `Concepts the student has settled so far: ${priorAtlas.slice(0, 12).join(', ')}\n` : ''}
${priorVariance && priorVariance.driftSummary ? `Recent drift: ${priorVariance.driftSummary}\n` : ''}
${sourcesLine ? `Available sources for citation:\n${sourcesLine}\n` : ''}

Write the next lesson now.`;

  try {
    const raw = await llmJSON(
      [{ role: 'system', content: sys }, { role: 'user', content: userMsg }],
      settings,
      { json: true, temperature: 0.4, max_tokens: 400, timeoutMs: 20_000, fn: 'proposeNextLesson' }
    );
    const parsed = JSON.parse(raw);
    if (parsed.title && parsed.learnGoal) {
      const result = {
        title: String(parsed.title).slice(0, 200),
        learnGoal: String(parsed.learnGoal).slice(0, 400),
      };
      // v0158m — capture conceptId for P6 routing if LLM emitted one.
      if (typeof parsed.conceptId === 'string' && parsed.conceptId.trim()) {
        result.conceptId = parsed.conceptId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 60);
      }
      return result;
    }
  } catch (err) {
    console.error('[proposeNextLesson] failed:', err.message);
  }
  // Fallback: derive from phase tone.
  return {
    title: `${slot.phaseLabel} step ${slot.phaseLessonIdx + 1}`,
    learnGoal: `Continue ${slot.phaseLabel.toLowerCase()} of ${topic}.`,
  };
}

// W2.1 — applyCadenceCoefficient. Optional KP-density adjuster that callers
// can opt into BEFORE body generation. cadence-engine's kp_coefficient
// (deep=1.00 / balanced=1.00 / compress=0.80 / final=0.60) multiplies the
// per-slot KP target. Pure: returns new array. Never mutates input.
// Does NOT touch lessonSplit / deriveLessonTarget / computePhaseLessonCounts;
// runs ON TOP of their decisions as a soft cadence-aware overlay.
//
// Note: floors each slot at 1 KP (a lesson must have at least one atom).
function applyCadenceCoefficient(perSlotKpTargets, kpCoefficient) {
  if (!Array.isArray(perSlotKpTargets)) return perSlotKpTargets;
  const coeff = Number(kpCoefficient);
  if (!Number.isFinite(coeff) || coeff <= 0 || coeff >= 1) {
    // No-op when coefficient is 1.0 or invalid.
    return perSlotKpTargets.slice();
  }
  return perSlotKpTargets.map(n => {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return v;
    return Math.max(1, Math.round(v * coeff));
  });
}

module.exports = {
  // v0158o — exposed for cli-install.js + main.js auth IPCs to spawn `claude`
  // with the SAME sandbox isolation that lesson dispatch uses. Otherwise login
  // token goes to user's real ~/.claude/ but agent invocations look at sandbox.
  _hyphaSandboxDir,
  _hyphaSandboxedSpawnOpts,
  llmJSON,                      // v0.11.0 — exposed for reflectionLLM (HERMES feedback loop)
  getLibraryRollupForTopic,     // R-LIB Day 2 — skeleton stage reads per-book TOC + D/P/R hits
  getCommunityHintForTopic,     // R-LIB Day 3 — skeleton stage reads pack syllabus + contested
  critiqueAndRefineSkeleton,    // 2026-05-13 — 4-wave critique loop (Lung/Muse/Scout + refine)
  harvest,
  // v0.3 — Heavy Harvest dispatcher (5-layer) + skeleton-only design path
  harvestV3,
  clarifyQuestions,
  classifyArchetype,
  // Layer 0 Subtract-First (pedagogy.md 2026-05-11) — visual topology + KP split
  classifyVisualArchetype,
  lessonSplit,
  VISUAL_ARCHETYPES,
  getEmphasis,
  classifyDifficulty,
  classifyIntrinsicLoad,
  classifyPriorKnowledge,
  classifyAll,
  planChain,
  designSequence,
  designLesson,
  streamTurn,
  synthesizeNote,
  updateState,
  evolveAgainstZeitgeist,
  crossPollinate,
  weeklyReport,
  extractAtlasDelta,
  generateQuizBank,
  scoreQuizAnswer,
  computeVariance,
  summarizeSources,
  // v0.4.0 three-stage pipeline
  loadArchetypeTemplate,
  rankSourcesBM25,
  // v0.4 — 5-layer Course Source Stack metadata schema
  SOURCE_METADATA_DEFAULTS,
  _inferSourceMetadata,
  designSeed,
  designSkeletonOnly,           // v0.3 — skeleton-first 2-stage flow
  proposeNextLesson,
  adaptLessonGoal,
  // v0.6.0 — tier multiplier + probe + per-lesson re-harvest
  tierMultiplier,
  computePhaseLessonCounts,
  deriveLessonTarget,           // 2026-05-13 — intent + breadth aware lesson-count derivation
  resolveLessonShape,           // R3 2026-05-13 — authoritative lessonSplit + time-floor reconciler
  applyCadenceCoefficient,      // W2.1 2026-05-13 — optional cadence-mode KP density overlay
  generateProbeMCQ,
  scoreProbe,
  _harvestPerLesson,
};
