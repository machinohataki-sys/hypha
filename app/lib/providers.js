'use strict';

// Hypha — provider registry. Single source of truth for the 3 LLM provider
// tracks (Claude / OpenAI / GLM) Hypha supports out of the box. Used by:
//   - main.js _hyphaDefaultSettings() (default fallback)
//   - main.js providers:list IPC (renderer reads via window.ptor.hypha.providers())
//   - VaultTree.jsx settings modal (provider→model+baseURL coupling)
//
// Order in the array drives display order in pill toggles + dropdowns.
// Default provider = Claude (per user 2026-04-30 "我最喜欢CLAUDE").
// Alpha-binary build overrides default to GLM via HYPHA_DEFAULT_GLM_KEY env
// at packaging time; runtime logic in main.js.

const PROVIDERS = [
  // Hypha Cloud — managed proxy + prepaid credit. Day-1 onboarding default
  // for users who don't want to BYO API key. Server picks cheapest viable
  // backend (default GLM-4.5). Sign-in via colophon → magic link → desktop
  // token stored in settings.json `hyphaToken` field.
  {
    id: 'hypha-managed',
    label: 'Hypha Cloud',
    via: 'hypha-server',
    baseURL: '',                  // resolved at call site from APP_URL
    models: [
      { id: 'managed', label: 'Hypha Cloud (auto)', sub: 'free 30 turns/day · server picks model' },
    ],
    defaultModel: 'managed',
    keyHint: 'sign in via colophon — no key needed',
  },
  {
    id: 'claude',
    label: 'Claude (Direct API)',
    // 2026-05-02 — uses @anthropic-ai/sdk via app/lib/anthropic-adapter.js.
    // Was previously broken (pointed OpenAI SDK at Anthropic Messages
    // endpoint = 404). Now sends Hypha system prompt via wire-level system
    // parameter — output identical to claude.ai. No Claude Code persona
    // contamination. Default for users wanting cleanest Opus output.
    via: 'sdk-anthropic',
    recommended: true,
    baseURL: 'https://api.anthropic.com',
    models: [
      { id: 'claude-opus-4-7',   label: 'Opus 4.7',   sub: 'deepest reasoning · cleanest output' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', sub: 'best coding · cheaper' },
      { id: 'claude-haiku-4-5',  label: 'Haiku 4.5',  sub: 'fast · cheap' },
    ],
    defaultModel: 'claude-opus-4-7',
    keyHint: 'sk-ant-… from console.anthropic.com — recommended for cleanest Opus output (~$0.17/lesson with caching, $5 ≈ 30 lessons)',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-5',          label: 'GPT-5',          sub: 'latest flagship' },
      { id: 'gpt-5-thinking', label: 'GPT-5 Thinking', sub: 'reasoning mode' },
      { id: 'gpt-4o',         label: 'GPT-4o',         sub: 'multimodal'      },
    ],
    defaultModel: 'gpt-5',
    keyHint: 'sk-… from platform.openai.com',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    models: [
      { id: 'gemini-2.5-flash',        label: 'Gemini 2.5 Flash',       sub: 'fast · cheap · default' },
      { id: 'gemini-2.5-pro',          label: 'Gemini 2.5 Pro',         sub: 'flagship · long context' },
      { id: 'gemini-3.1-pro-preview',  label: 'Gemini 3.1 Pro · preview', sub: 'newest · capacity-limited (429)' },
      { id: 'gemini-2.5-flash-lite',   label: 'Gemini 2.5 Flash Lite',  sub: 'fastest · cheapest' },
      { id: 'gemini-3-flash-preview',  label: 'Gemini 3 Flash · preview', sub: 'mid-tier preview' },
    ],
    // 2026-05-02: gemini-3.1-pro-preview demoted from default — Google server
    // returns persistent 429 "No capacity available for model" for free-tier
    // and even paid keys at peak. gemini-2.5-flash is the most reliable
    // first-call experience for new users; they can opt up to 3.1 Pro later
    // when capacity returns.
    defaultModel: 'gemini-2.5-flash',
    keyHint: 'AIza… from aistudio.google.com',
  },
  // ── CLI-based providers (use vendor subscription, no API key) ────────────
  // User has Claude Max → spawns `claude` binary. Same for Gemini CLI.
  {
    id: 'claude-cli',
    label: 'Claude Max · CLI (DEPRECATED for tutor)',
    // 2026-05-02 — hidden from default UI. 2026-05-03 — DEPRECATED for tutor
    // turns. Claude Code's ~30k-token persona cannot be fully overridden via
    // --system-prompt; the model still leaks "Machino" / "[YOUR REPLY AS
    // TUTOR]" / meta-confused replies into Hypha tutor output. main.js auto-
    // migrates settings.provider='claude-cli' → 'claude' (sdk-anthropic) on
    // launch (or 'hypha-managed' if no sk-ant key set). Kept in array only
    // so legacy settings rendering doesn't crash with "unknown provider".
    hidden: true,
    deprecated: true,
    deprecatedFor: 'tutor',
    via: 'cli',
    binary: 'claude',
    // Claude Code CLI requires --verbose alongside stream-json when in print mode
    // (without it, claude exits 1: "When using --print, --output-format=stream-json requires --verbose").
    streamFlag: ['--output-format', 'stream-json', '--verbose'],
    promptFlag: '-p',
    modelFlag: '--model',
    // 2026-05-02 — Hypha's system messages ride this flag so they reach the
    // wire-level system field. Without it, Hypha's system text was flattened
    // into the user message blob with a "[SYSTEM]" ASCII label, where Claude
    // Code's loaded Victor persona outranked it. With it, the model's first
    // recall obeys Hypha's tutor instructions even when CLAUDE.md walkup +
    // ~/.claude/agents are still in context. Live verified clean.
    systemPromptFlag: '--system-prompt',
    // v0158x — extended thinking via --effort flag (Claude Code 2026 syntax,
    // replaces deprecated --thinking / budget_tokens). 2026-05-05: bumped
    // 'high' → 'xhigh' per user request. effort levels (low/medium/high/
    // xhigh/max); xhigh is "advanced coding and complex agentic work
    // requiring extended exploration", more thinking budget than high
    // without going to max. Pushed via suffixArgs so applies to both
    // _runCliOnce and _runCliStream paths.
    suffixArgs: ['--effort', 'xhigh'],
    baseURL: '',
    models: [
      { id: 'claude-opus-4-7',   label: 'Opus 4.7',   sub: 'deepest reasoning' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', sub: 'best coding · default' },
      { id: 'claude-haiku-4-5',  label: 'Haiku 4.5',  sub: 'fast and cheap' },
    ],
    defaultModel: 'claude-sonnet-4-6',
    keyHint: 'uses your logged-in Claude Max session — free with subscription. Carries Claude Code persona context (~30k tokens) which Hypha now overrides via --system-prompt; output is mostly clean but use the Claude Direct API tile above for fully claude.ai-equivalent output.',
    cliInstall: 'npm install -g @anthropic-ai/claude-code · then run `claude` once to authenticate',
  },
  {
    id: 'gemini-cli',
    label: 'Gemini · CLI (DEPRECATED for tutor)',
    // 2026-05-03 — same persona-pollution risk as claude-cli. Auto-migrated
    // by main.js on startup. Kept in array for legacy settings safety.
    hidden: true,
    deprecated: true,
    deprecatedFor: 'tutor',
    via: 'cli',
    binary: 'gemini',
    streamFlag: [],
    // Gemini CLI's `-p` flag is yargs-strict — bare `-p` errors out
    // ("Not enough arguments following: p"). Use stdin-only invocation
    // (matches lib/deepen-pipeline.js working pattern); gemini in default
    // interactive mode consumes a piped+closed stdin as one prompt and exits.
    promptFlag: null,
    modelFlag: '-m',
    baseURL: '',
    models: [
      { id: 'gemini-2.5-flash',       label: 'Gemini 2.5 Flash',       sub: 'fast · cheap · default' },
      { id: 'gemini-2.5-pro',         label: 'Gemini 2.5 Pro',         sub: 'flagship · long context' },
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro · preview', sub: 'newest · capacity-limited (429)' },
      { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash · preview', sub: 'mid-tier preview' },
    ],
    // 2026-05-02: see comment on `gemini` provider above — same 429 issue.
    // agent.js sets GEMINI_CLI_TRUST_WORKSPACE=true so trusted-folder check
    // doesn't block (verified working).
    defaultModel: 'gemini-2.5-flash',
    keyHint: 'uses your Google AI Studio session via the gemini CLI',
    cliInstall: 'npm install -g @google/gemini-cli · then run `gemini auth login`',
  },
  {
    id: 'codex-cli',
    label: 'Codex · CLI (DEPRECATED for tutor)',
    // 2026-05-03 — same persona-pollution risk. Auto-migrated by main.js.
    hidden: true,
    deprecated: true,
    deprecatedFor: 'tutor',
    via: 'cli',
    binary: 'codex',
    // codex uses a subcommand pattern: `codex exec <flags>`. prefixArgs gets
    // prepended before model/prompt flags. suffixArgs lets non-git workspaces
    // run without git-repo refusal. Prompt arrives via stdin (no -p flag).
    prefixArgs: ['exec'],
    suffixArgs: ['--skip-git-repo-check'],
    streamFlag: [],
    promptFlag: null,
    modelFlag: '--model',
    baseURL: '',
    models: [
      { id: 'gpt-5',          label: 'GPT-5',          sub: 'flagship · API-key auth only' },
      { id: 'gpt-5-thinking', label: 'GPT-5 Thinking', sub: 'reasoning mode · API-key auth only' },
      { id: 'gpt-5-mini',     label: 'GPT-5 Mini',     sub: 'fast · cheap · API-key auth only' },
    ],
    defaultModel: 'gpt-5-mini',
    // 2026-05-02 known issue: OpenAI does NOT permit gpt-5/gpt-5-thinking/
    // gpt-5-mini under ChatGPT-subscription auth in the codex CLI. All return
    // {"error":"The 'gpt-5...' model is not supported when using Codex with a
    // ChatGPT account."}. To use this provider you MUST run `codex login`
    // with an OpenAI API key (sk-…), NOT a ChatGPT Plus/Pro session. If your
    // primary auth is ChatGPT subscription, use the `openai` provider with a
    // direct API key instead.
    keyHint: 'requires API-key auth — `codex login --api-key sk-…`. ChatGPT subscription auth is rejected by OpenAI for gpt-5* models.',
    cliInstall: 'npm install -g @openai/codex · then `codex login --api-key sk-…`',
  },
  {
    id: 'glm',
    label: 'GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      { id: 'glm-5',      label: 'GLM 5',      sub: '745B MoE flagship' },
      { id: 'glm-4-plus', label: 'GLM 4 Plus', sub: 'stable production' },
      { id: 'glm-4-air',  label: 'GLM 4 Air',  sub: 'cheap'             },
    ],
    defaultModel: 'glm-5',
    keyHint: 'from open.bigmodel.cn',
  },
];

function getProvider(id) {
  return PROVIDERS.find(p => p.id === id) || PROVIDERS[0];
}

function defaultSettingsFor(providerId) {
  const p = getProvider(providerId);
  return {
    provider: p.id,
    baseURL: p.baseURL,
    model: p.defaultModel,
    apiKey: '',
    sourceCountries: ['us', 'uk', 'se', 'jp', 'ch'],
  };
}

module.exports = { PROVIDERS, getProvider, defaultSettingsFor };
