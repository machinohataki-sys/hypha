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
    label: 'Claude',
    baseURL: 'https://api.anthropic.com/v1',
    models: [
      { id: 'claude-opus-4-7',   label: 'Opus 4.7',   sub: 'deepest reasoning' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', sub: 'best coding · default' },
      { id: 'claude-haiku-4-5',  label: 'Haiku 4.5',  sub: 'fast and cheap' },
    ],
    defaultModel: 'claude-sonnet-4-6',
    keyHint: 'sk-ant-… from console.anthropic.com',
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
      { id: 'gemini-3.1-pro-preview',  label: 'Gemini 3.1 Pro · preview', sub: 'newest flagship' },
      { id: 'gemini-2.5-pro',          label: 'Gemini 2.5 Pro',         sub: 'flagship · long context' },
      { id: 'gemini-2.5-flash',        label: 'Gemini 2.5 Flash',       sub: 'fast · cheap' },
      { id: 'gemini-2.5-flash-lite',   label: 'Gemini 2.5 Flash Lite',  sub: 'fastest · cheapest' },
      { id: 'gemini-3-flash-preview',  label: 'Gemini 3 Flash · preview', sub: 'mid-tier preview' },
    ],
    defaultModel: 'gemini-3.1-pro-preview',
    keyHint: 'AIza… from aistudio.google.com',
  },
  // ── CLI-based providers (use vendor subscription, no API key) ────────────
  // User has Claude Max → spawns `claude` binary. Same for Gemini CLI.
  {
    id: 'claude-cli',
    label: 'Claude Max · CLI',
    via: 'cli',
    binary: 'claude',
    // Claude Code CLI requires --verbose alongside stream-json when in print mode
    // (without it, claude exits 1: "When using --print, --output-format=stream-json requires --verbose").
    streamFlag: ['--output-format', 'stream-json', '--verbose'],
    promptFlag: '-p',
    modelFlag: '--model',
    baseURL: '',
    models: [
      { id: 'claude-opus-4-7',   label: 'Opus 4.7',   sub: 'deepest reasoning' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', sub: 'best coding · default' },
      { id: 'claude-haiku-4-5',  label: 'Haiku 4.5',  sub: 'fast and cheap' },
    ],
    defaultModel: 'claude-sonnet-4-6',
    keyHint: 'uses your logged-in Claude Max session — no key needed',
    cliInstall: 'npm install -g @anthropic-ai/claude-code · then run `claude` once to authenticate',
  },
  {
    id: 'gemini-cli',
    label: 'Gemini · CLI',
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
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro · preview', sub: 'newest flagship · CLI default' },
      { id: 'gemini-2.5-pro',         label: 'Gemini 2.5 Pro',         sub: 'flagship · long context' },
      { id: 'gemini-2.5-flash',       label: 'Gemini 2.5 Flash',       sub: 'fast · cheap' },
      { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash · preview', sub: 'mid-tier preview' },
    ],
    defaultModel: 'gemini-3.1-pro-preview',
    keyHint: 'uses your Google AI Studio session via the gemini CLI',
    cliInstall: 'npm install -g @google/gemini-cli · then run `gemini auth login`',
  },
  {
    id: 'codex-cli',
    label: 'Codex · CLI',
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
      { id: 'gpt-5',          label: 'GPT-5',          sub: 'flagship' },
      { id: 'gpt-5-thinking', label: 'GPT-5 Thinking', sub: 'reasoning mode' },
      { id: 'gpt-5-mini',     label: 'GPT-5 Mini',     sub: 'fast · cheap' },
    ],
    defaultModel: 'gpt-5',
    keyHint: 'uses your logged-in codex CLI session — no API key needed',
    cliInstall: 'npm install -g @openai/codex · then run `codex auth login`',
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
