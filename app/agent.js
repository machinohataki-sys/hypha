'use strict';

const fetch = require('node-fetch');
const OpenAI = require('openai');
// Hypha Product Constitution — prepended to every LLM system prompt so output
// inherits the product's manuscript-register / pedagogical-philosophy soul,
// not just generic LLM defaults. Edit `lib/hypha-constitution.js` to evolve.
const { FULL: HYPHA_FULL, SHORT: HYPHA_SHORT, userProfileBlock } = require('./lib/hypha-constitution');

const BANNED_DOMAINS = [
  'edu.cn', '.cn/', 'tsinghua.edu', 'pku.edu', 'fudan.edu', 'sjtu.edu', 'zju.edu',
  'ustc.edu', 'nankai.edu', 'tongji.edu', 'csdn.net', 'cnblogs.com',
];

function client(settings) {
  return new OpenAI({
    apiKey: settings.apiKey || 'missing',
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
async function _runCliOnce(messages, settings) {
  const cfg = _resolveProviderConfig(settings);
  if (!cfg.binary) throw new Error('cli provider missing binary name');
  const prompt = _composePromptFromMessages(messages);
  const args = [];
  if (Array.isArray(cfg.prefixArgs)) args.push(...cfg.prefixArgs);
  if (cfg.modelFlag && (settings.model || cfg.defaultModel)) {
    args.push(cfg.modelFlag, settings.model || cfg.defaultModel);
  }
  if (cfg.promptFlag) args.push(cfg.promptFlag);
  if (Array.isArray(cfg.suffixArgs)) args.push(...cfg.suffixArgs);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = _cliSpawn(cfg.binary, args, {
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: 'true' },
      });
    } catch (e) { return reject(new Error('spawn failed: ' + e.message)); }
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', err => reject(new Error('cli error: ' + err.message)));
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`cli exit ${code}: ${stderr.slice(0, 300)}`));
      resolve(stdout.trim());
    });
    try { child.stdin.write(prompt); child.stdin.end(); }
    catch (e) { reject(new Error('stdin write failed: ' + e.message)); }
  });
}

// Run a CLI binary in streaming mode. Calls onChunk(text) per content piece.
async function _runCliStream(messages, settings, onChunk) {
  const cfg = _resolveProviderConfig(settings);
  if (!cfg.binary) throw new Error('cli provider missing binary name');
  const prompt = _composePromptFromMessages(messages);
  const args = [];
  if (Array.isArray(cfg.prefixArgs)) args.push(...cfg.prefixArgs);
  if (cfg.modelFlag && (settings.model || cfg.defaultModel)) {
    args.push(cfg.modelFlag, settings.model || cfg.defaultModel);
  }
  if (cfg.promptFlag) args.push(cfg.promptFlag);
  if (Array.isArray(cfg.streamFlag) && cfg.streamFlag.length) args.push(...cfg.streamFlag);
  if (Array.isArray(cfg.suffixArgs)) args.push(...cfg.suffixArgs);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = _cliSpawn(cfg.binary, args, {
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: 'true' },
      });
    } catch (e) { return reject(new Error('spawn failed: ' + e.message)); }
    let stderr = '';
    let buffer = '';
    let isStreamJSON = Array.isArray(cfg.streamFlag) && cfg.streamFlag.includes('stream-json');

    child.stdout.on('data', d => {
      const chunk = d.toString('utf8');
      if (isStreamJSON) {
        // newline-delimited JSON events. Parse each line, extract content.
        buffer += chunk;
        let lines = buffer.split('\n');
        buffer = lines.pop(); // last partial line
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            // Claude Code stream-json format: { type, message: { content: [{type,text}] } } or similar
            const text = (ev.message && ev.message.content && ev.message.content
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join(''))
              || ev.delta || ev.text || '';
            if (text) onChunk(text);
          } catch (_) { /* not JSON, skip */ }
        }
      } else {
        // Plain text streaming — emit raw chunks.
        onChunk(chunk);
      }
    });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', err => reject(new Error('cli stream error: ' + err.message)));
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`cli exit ${code}: ${stderr.slice(0, 300)}`));
      // flush any remaining buffer line
      if (isStreamJSON && buffer.trim()) {
        try {
          const ev = JSON.parse(buffer);
          const text = (ev.message && ev.message.content && ev.message.content
            .filter(c => c.type === 'text').map(c => c.text).join(''))
            || ev.delta || ev.text || '';
          if (text) onChunk(text);
        } catch (_) { if (!isStreamJSON) onChunk(buffer); }
      }
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

// Tavily WebSearch — additive 4th channel. Silent no-op when key absent so the
// existing 3-channel flow degrades cleanly. Free tier: 1k req/mo.
async function _harvestWebSearch(topic, settings) {
  const tavilyKey = (settings && settings.tavilyKey) || process.env.TAVILY_API_KEY || '';
  if (!tavilyKey) return [];
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyKey,
        query: String(topic),
        search_depth: 'basic',
        max_results: 10,
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

async function harvest(topic, settings, onProgress = null) {
  const t0 = Date.now();
  const perChannel = {
    github:   { n: 0, ms: 0, err: null, items: [] },
    hn:       { n: 0, ms: 0, err: null, items: [] },
    arxiv:    { n: 0, ms: 0, err: null, items: [] },
    web:      { n: 0, ms: 0, err: null, items: [] },
    citation: { n: 0, ms: 0, err: null, items: [] },
    fallback: { n: 0, ms: 0, err: null, items: [] },
  };

  // Run all 4 live channels in parallel. Promise.allSettled so a single
  // network failure can't take down the whole harvest.
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

  await Promise.allSettled([
    runChannel('github', () => _harvestGithub(topic)),
    runChannel('hn',     () => _harvestHN(topic)),
    runChannel('arxiv',  () => _harvestArxiv(topic)),
    runChannel('web',    () => _harvestWebSearch(topic, settings)),
  ]);

  // v0.6.0 — 5th channel: citation graph traversal seeded by top arxiv hits.
  // Sequential after the 4 parallel channels so we have arxiv IDs to seed.
  // Each seed paper contributes its references (what it cites) AND citations
  // (what cites it) — gives the system reach beyond keyword search into the
  // actual citation network around the seed papers. Free Semantic Scholar
  // Graph API; no key required. Errors are absorbed silently — never block
  // the harvest contract.
  const citationT0 = Date.now();
  try {
    const arxivIds = (perChannel.arxiv.items || [])
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

  const liveItems = [
    ...perChannel.github.items,
    ...perChannel.hn.items,
    ...perChannel.arxiv.items,
    ...perChannel.web.items,
    ...perChannel.citation.items,
  ];
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
      vault.appendJSONL('events.jsonl', {
        ts: new Date().toISOString(),
        op: 'harvest_complete',
        topic: String(topic),
        perChannel: {
          github:   { n: perChannel.github.n,   ms: perChannel.github.ms,   err: perChannel.github.err },
          hn:       { n: perChannel.hn.n,       ms: perChannel.hn.ms,       err: perChannel.hn.err },
          arxiv:    { n: perChannel.arxiv.n,    ms: perChannel.arxiv.ms,    err: perChannel.arxiv.err },
          web:      { n: perChannel.web.n,      ms: perChannel.web.ms,      err: perChannel.web.err },
          citation: { n: perChannel.citation.n, ms: perChannel.citation.ms, err: perChannel.citation.err },
          fallback: { n: perChannel.fallback.n, ms: perChannel.fallback.ms, err: perChannel.fallback.err },
        },
        totalUseful,
        durationMs,
      });
      if (totalUseful < 5) {
        vault.appendJSONL('events.jsonl', {
          ts: new Date().toISOString(),
          op: 'harvest_thin',
          topic: String(topic),
          totalUseful,
        });
      }
    }
  } catch (_) {}

  // Optional progress callback — main.js can wire this through to webContents
  // so the renderer surfaces a thin-source banner inline.
  if (typeof onProgress === 'function') {
    try {
      onProgress('harvest_complete', {
        totalUseful,
        perChannel: {
          github:   { n: perChannel.github.n,   err: perChannel.github.err },
          hn:       { n: perChannel.hn.n,       err: perChannel.hn.err },
          arxiv:    { n: perChannel.arxiv.n,    err: perChannel.arxiv.err },
          web:      { n: perChannel.web.n,      err: perChannel.web.err },
          citation: { n: perChannel.citation.n, err: perChannel.citation.err },
          fallback: { n: perChannel.fallback.n, err: perChannel.fallback.err },
        },
      });
    } catch (_) {}
  }

  // Final assembly — preserve original [live..., fallback...] order + 30 cap.
  const out = [...liveItems, ...perChannel.fallback.items];
  return out.slice(0, 30);
}

async function llmJSON(messages, settings, opts = {}) {
  // Hypha Cloud branch — managed-LLM proxy. Sends to https://APP/v1/llm with
  // the user's long-lived desktop token (hyphaToken in settings). Server
  // applies free-tier quota or paid credit; returns OpenAI-shaped response.
  if (settings.provider === 'hypha-managed') {
    return await _hyphaProxyCall(messages, settings, opts);
  }
  // CLI provider branch — shell out to vendor binary (Claude Max / Gemini CLI).
  if (_isCliProvider(settings)) {
    let raw = await _runCliOnce(messages, settings);
    // Strip markdown code fences if model wrapped JSON in ```json ... ```
    if (opts.json) {
      raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      // If still not pure JSON, try to extract first {...} block
      if (!raw.startsWith('{') && !raw.startsWith('[')) {
        const m = raw.match(/[\{\[][\s\S]*[\}\]]/);
        if (m) raw = m[0];
      }
    }
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
  const msg = r.choices?.[0]?.message;
  if (!msg) return '';
  // Prefer message.content; fall back to reasoning_content if content is empty
  // (some providers + thinking mode write all output there).
  const content = (msg.content || '').trim();
  if (content) return content;
  const reasoning = (msg.reasoning_content || '').trim();
  if (reasoning) {
    console.error('[llmJSON] content empty; using reasoning_content fallback (' + reasoning.length + ' chars)');
    // For JSON-mode, try to extract the first {...} block from reasoning.
    if (opts.json) {
      const m = reasoning.match(/\{[\s\S]*\}/);
      return m ? m[0] : reasoning;
    }
    return reasoning;
  }
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
const EMPHASIS = {
  'LANG-ACQ':     { P1: 2, P2: 1, P3: 2, P4: 0, P5: -1, F1: 0,  F2: 2, F3: 1 },
  'TECH-CONCEPT': { P1: 2, P2: 2, P3: 0, P4: 1, P5: 1,  F1: 2,  F2: 2, F3: 2 },
  'TECH-PROC':    { P1: 1, P2: 2, P3: 1, P4: 0, P5: 2,  F1: 2,  F2: 1, F3: 2 },
  'HUMANITIES':   { P1: 2, P2: 1, P3: 1, P4: 2, P5: 0,  F1: 1,  F2: 1, F3: 0 },
  'DECL-MASS':    { P1: 0, P2: 0, P3: 2, P4: 0, P5: -1, F1: -1, F2: 0, F3: 1 },
  'MINDSET':      { P1: 2, P2: 2, P3: 1, P4: 2, P5: 0,  F1: 1,  F2: 1, F3: 1 },
};

const EMPHASIS_LABEL = {
  2: 'HIGH (MUST appear ≥1× per 3 consecutive lessons)',
  1: 'MED (MAY appear when natural to the topic)',
  0: 'LOW (only on explicit gap signal in prior lessons)',
};

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

async function designLesson({ topic, idx, sequence, sources, state, priorNotes, agentProfile, userProfile, archetype }, settings) {
  // Lacquer Loop P2 PRE-READ PREDICTION — when archetype emphasizes P2 (HIGH/MED),
  // the lesson's first turn must be a prediction prompt, not a probe-of-understanding.
  // P2 emphasis values per app/lib/pedagogy.md: HIGH=2, MED=1, LOW=0, SKIP=-1.
  const p2Emph = (archetype && EMPHASIS[archetype] && typeof EMPHASIS[archetype].P2 === 'number') ? EMPHASIS[archetype].P2 : 0;
  const p2Active = p2Emph >= 1;
  const target = sequence[idx];
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

  return `${HYPHA_FULL}You are a tutor inside Hypha. You are teaching one specific lesson now.

Your name (as the student knows you): ${tutorDisplayName}. When self-introducing or signing off, use this name; don't reveal the underlying model name unless asked directly.

Topic: ${topic}
This lesson (#${idx + 1}): ${target?.title || 'Untitled'}
Learn goal: ${target?.learnGoal || ''}

═══ STUDENT (read FIRST — every other instruction below defers to this) ═══${studentBlock || `
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
${sources.slice(0, 10).map(s => `- ${s.title} [${s.sourceType}]`).join('\n')}

Universal rules (overlay on top of the persona above):
${p2Active ? `1. **P2 PRE-READ PREDICTION** (THIS LESSON'S OPENER MUST BE A PREDICTION PROMPT — archetype ${archetype} emphasizes prediction). Open with ONE prediction prompt — ask the student to FORECAST the lesson's central claim/mechanism BEFORE you reveal anything. Frame it as a guess, not a test ("What do you think happens when X meets Y?" / "Predict the outcome of Z"). Do NOT reveal the canonical answer until they respond. After they respond, capture their prediction verbatim ("You said: X") and EXPLICITLY compare to the canonical (where they landed, where they missed, what surprised). Predict-error magnitude is the high-value learning signal — make the comparison visible to the student.` : `1. Open with ONE question that probes current understanding of the lesson goal AT THE LEVEL THE STUDENT BLOCK INDICATES. No preamble. No "Welcome". If student says "no foundation", first question is concept-level (e.g., "have you ever heard of weights in a neural network?"), NOT formula-level.`}
2. After student's answer, re-calibrate depth (hit / miss / partial). Adapt — but never assume prerequisites the student profile did not claim.
3. Each turn ≤ 2 short paragraphs + at least 1 question (unless persona explicitly demands otherwise — e.g., Lewin demos may run longer prose; Sandel demands stricter dialogue-only).
4. When student says something insightful, name it explicitly so the dual-layer note can capture it as 用户灵感.
5. Reference prior notes when relevant.
6. End the lesson when learn goal is met OR student signals "ready". Never artificially extend.
7. If you catch yourself using a term the student profile suggests they don't know, stop mid-sentence and rewrite — never push through with a "you'll learn this later" handwave.
7. NEVER use the words: AI, LLM, embedding, model, prompt, agent, RAG, vector. You are the teacher, not a tool.

Begin now.`;
}

async function streamTurn({ systemPrompt, history, userMsg, settings }, onChunk) {
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const h of (history || [])) messages.push({ role: h.role, content: h.content });
  if (userMsg && userMsg !== '__begin__') messages.push({ role: 'user', content: userMsg });
  else messages.push({ role: 'user', content: '[Lesson start. Begin with your first question.]' });

  // CLI provider branch — Claude Max / Gemini CLI shell-out streaming.
  if (_isCliProvider(settings)) {
    try {
      await _runCliStream(messages, settings, onChunk);
    } catch (err) {
      console.error('[streamTurn] cli stream failed:', err && err.message);
      throw err;
    }
    return;
  }

  const c = client(settings);
  let stream;
  try {
    stream = await c.chat.completions.create({
      model: settings.model || 'glm-5',
      messages,
      stream: true,
      temperature: 0.8,
      max_tokens: 1500,
    });
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
        onChunk(delta.content);
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
      if (text) onChunk(text);
    } catch (err) {
      console.error('[streamTurn] non-streaming fallback also failed:', err && err.message);
      throw err;
    }
  } else if (lastError) {
    throw lastError;
  }
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

    return await llmJSON([{ role: 'system', content: sys }, { role: 'user', content: user }], settings, { temperature: 0.7, max_tokens: 1000 });
  }

  // Fresh distill — full dual-layer note.
  const sys = `${HYPHA_FULL}You write dual-layer study notes from a tutoring dialog. Output ONE markdown document with frontmatter and TWO clear sections.

Strict structure:
---
topic: ${topic}
lesson_idx: ${idx}
lesson_title: ${(target?.title || '').replace(/"/g, "'")}
date: ${new Date().toISOString().slice(0, 10)}
---

# ${target?.title || 'Lesson'}

## 课程基础
[1-3 paragraphs. What was actually taught. The conceptual core. Source-faithful. Plain language. No jargon the student doesn't already use.]

## 用户灵感
[1-3 paragraphs in second person ("you"). What THIS specific student noticed, asked, connected to other notes, half-formed insights worth coming back to. Pull verbatim quotes from their messages where useful. This section is half the note's value — do NOT skimp.]

Forbidden words anywhere in output: AI, LLM, embedding, agent, model, prompt, RAG.`;

  const user = `Sources used in this lesson:
${sourceList}

Dialog:
${tx}

Write the note now.`;

  return await llmJSON([{ role: 'system', content: sys }, { role: 'user', content: user }], settings, { temperature: 0.6, max_tokens: 2000 });
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
    return { introduced: [], referenced: [], settled_by_user: [], expected_uncovered: [] };
  }
  let delta;
  try { delta = JSON.parse(raw); }
  catch (_) {
    console.error('[extractAtlasDelta] JSON parse failed; raw=' + (raw || '').slice(0, 200));
    return { introduced: [], referenced: [], settled_by_user: [], expected_uncovered: [] };
  }
  return {
    introduced: Array.isArray(delta.introduced) ? delta.introduced : [],
    referenced: Array.isArray(delta.referenced) ? delta.referenced : [],
    settled_by_user: Array.isArray(delta.settled_by_user) ? delta.settled_by_user : [],
    expected_uncovered: Array.isArray(delta.expected_uncovered) ? delta.expected_uncovered : [],
  };
}

// Lacquer Loop W6 — Learning Chain Planner. Three small LLM classifiers + one
// chain-design call. Council 2026-05-01 (Yogo / Leo / Scout) calibrated formulas
// in app/lib/feasibility.js; this layer turns user-facing inputs (goal text +
// answers) into the numeric inputs that classifier consumes.
async function classifyDifficulty(goal, settings) {
  const sys = `${HYPHA_SHORT}Score the cognitive difficulty of mastering the user's learning goal at the level they describe. Output JSON: { "score": float 0..1, "rationale": string }.

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
  const sys = `${HYPHA_SHORT}Classify the cognitive ELEMENT INTERACTIVITY (Sweller 1988 / Likourezos 2024) of the topic. Element interactivity = how many concepts/elements MUST be processed simultaneously.

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

async function classifyPriorKnowledge(goal, answers, settings) {
  const formattedAnswers = (answers || []).map(a =>
    `Q: ${a.question}\nA: ${Array.isArray(a.answer) ? a.answer.join(', ') : a.answer}`
  ).join('\n\n');
  const profileBlock = userProfileBlock(settings && settings.userProfile);
  // v0.6.0 — if a calibrated probe exists in profile.probe, surface it as the
  // PRIMARY ground-truth signal. Self-introduction prose (humble-brag or
  // impostor-syndrome) is a known-noisy channel; the probe is calibrated
  // against actual MCQs the student answered. Empty clause when no probe.
  const probe = (settings && settings.userProfile && settings.userProfile.probe) || null;
  const probeClause = (probe && typeof probe.score === 'number') ? `

PROBE RESULTS (calibrated baseline — use as PRIMARY signal over self-introduction):
- Topic probed: ${probe.topic || '(unspecified)'}
- Score: ${Math.round(probe.score * 100)}% (${probe.correctCount || 0}/${probe.total || 0})
- Band: ${probe.band || 'unknown'}
Map band → score: novice → 0.05-0.20, foundational → 0.20-0.40, intermediate → 0.40-0.65, advanced → 0.65-0.90.` : '';
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
  const { tier, ratio, gap, missing_prerequisites, timeWeeks, dailyHours, intrinsicLoad, pComplete, lang } = ctx;
  // Detect output language: explicit ctx.lang wins; else auto-detect from goal text.
  const detectedLang = (lang === 'zh' || lang === 'en') ? lang
    : (/[一-龥]/.test(String(goal || '')) ? 'zh' : 'en');
  const tierGuidance = {
    'nearly-impossible': 'CONDENSE prerequisites to bare minimum. Accept partial mastery on prereqs. Focus pressure on gap-bridging. Exit criteria LIBERAL. WARN that ambition exceeds time — recommend extending OR accepting intermediate target. Tone = direct + urgent (NOT mocking).',
    'possible': 'BALANCE prerequisite floors with goal pursuit. Regular checkpoints. Exit criteria = passable for next link. Tone = guided + steady.',
    'easy': 'ALLOW deep dives. Exploration encouraged. Exit criteria = mastery. Last link can include extension topics. Tone = Socratic + open.',
  };
  const langInstruction = detectedLang === 'zh'
    ? 'OUTPUT LANGUAGE: Chinese (Simplified). All "topic", "rationale", "exit_criterion", "warning", "alternatives.lower_target_to" fields MUST be in Chinese. Match the user\'s register (formal academic Chinese, NOT casual). Numbers + technical terms (eigenvalue, BKT, etc.) may stay in English when natural.'
    : 'OUTPUT LANGUAGE: English. All fields in English.';
  const profileBlock = userProfileBlock(settings && settings.userProfile);
  const sys = `${HYPHA_FULL}${profileBlock}You design a LEARNING CHAIN of 3-8 topics that bridges the student from their current state to an ambitious learning goal. Use the STUDENT PROFILE block above (if present) to set the chain's starting point — if the student already has experience the chain would normally start from, COMPRESS or DROP those prerequisite links. Output JSON: { "links": [{ "topic": string, "duration_weeks": float, "role": "prerequisite"|"core"|"ultimate", "rationale": string, "exit_criterion": string }], "warning": string|null, "alternatives": { "extend_time_to_weeks": int|null, "lower_target_to": string|null } }.

${langInstruction}

Hard rules:
- Sum of duration_weeks across all links = ${timeWeeks} (HARD constraint).
- Last link.role = "ultimate" with topic ≈ the user's goal verbatim (preserve user's wording).
- Earlier links bridge the gap from current state to the goal — use the missing_prerequisites list as priority order.
- topic: 4-12 words, CONCRETE + SPECIFIC. Forbidden: "math basics" / "fundamentals" / "introduction to X" alone. Required: name a specific mechanism, technique, paper, or distinction.
- rationale: 1 sentence — why THIS link before the next.
- exit_criterion: 1 sentence testable claim (a concrete behavior the learner should be able to perform).
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
  try {
    const raw = await llmJSON(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      settings,
      { json: true, temperature: 0.4, max_tokens: 3500 }
    );
    const p = JSON.parse(raw);
    return {
      links: Array.isArray(p.links) ? p.links : [],
      warning: p.warning || null,
      alternatives: p.alternatives || null,
    };
  } catch (_) { return { links: [], warning: 'plan failed', alternatives: null }; }
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

// computePhaseLessonCounts — distribute target total across phases by weight.
//
// Total mapping (depth-first; user pushed back on shallow counts 2026-05-01):
//   week        →   6   (curiosity dive)
//   month       →  35   (working understanding)
//   two-month   →  70   (substantial)
//   quarter     → 100   (deep traversal — bachelor-foundation territory)
//   open        → 100   (default to deep)
//   custom      → customLessons (clamped to 1-200)
//
// v0.6.0 — `tier` (gentle/moderate/heroic) modulates the base target by
// 0.6/1.0/1.6×. Multiplier applies AFTER the time-commit base so a 'heroic'
// month curriculum yields ~56 lessons instead of 35; 'gentle' month → ~21.
//
// Largest-remainder method: floor(weight × target), then distribute leftover
// to phases with largest fractional parts. Min 1 lesson per phase enforced.
function computePhaseLessonCounts(phases, timeCommit, customLessons, tier) {
  const TOTAL_BY_TIME = {
    week: 6, month: 35, 'two-month': 70, quarter: 100, open: 100,
  };
  let target;
  const cn = Number(customLessons);
  if (Number.isFinite(cn) && cn >= 1 && cn <= 200) {
    target = Math.round(cn);
  } else {
    target = TOTAL_BY_TIME[timeCommit] || 35;
  }
  // Apply tier multiplier (v0.6.0). Round AFTER multiply so distribution
  // operates on a single integer target. Min phases.length still enforced
  // below — gentle tier on a tiny phase template won't drop below 1/phase.
  target = Math.round(target * tierMultiplier(tier));
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

// rankSourcesBM25 — pure-JS BM25 over title + excerpt. No LLM, no embeddings.
// Returns top-k sources sorted by relevance. Used by Stage 2 (frontier
// retrieval) to pick which 5 sources to pass to proposeNextLesson per
// upcoming lesson — citations always real, never invented.
function rankSourcesBM25(sources, query, k = 5) {
  const list = Array.isArray(sources) ? sources : [];
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
    return { src, score: score + starBoost };
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
async function designSeed({ topic, goal, archetype, timeCommit, customLessons, tier, clarifications, sourceDigest }, settings) {
  const tmpl = loadArchetypeTemplate(archetype || 'TECH-CONCEPT');
  const counts = computePhaseLessonCounts(tmpl.phases, timeCommit, customLessons, tier);
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

1. Write the title + 1-sentence learnGoal of LESSON 1 (the very first lesson, in phase "${phases[0].label}", phase tone: "${phases[0].tone}"). If the STUDENT PROFILE shows the student already knows the typical lesson-1 material, lift LESSON 1 to a higher entry point that matches their actual baseline.
2. Write a 2-3 sentence "trajectory" paragraph describing where the curriculum heads — concrete (names of mechanisms / frontier debates / final artifact), not generic.

Output STRICT JSON: { "firstLesson": { "title": string, "learnGoal": string }, "trajectory": string }

Hard rules:
- title: 4-10 words, concrete + specific. NEVER generic ("Introduction to X", "Overview"). Names a specific mechanism / claim / starting move.
- learnGoal: 1 sentence, plain. Single concrete claim or skill.
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
    for (let i = 1; i < lessonPlan.length; i++) {
      lessonPlan[i].ghost = true;
    }
  }
  return { archetype: archetype || 'TECH-CONCEPT', phases, firstLesson, trajectory, lessonPlan };
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

Output STRICT JSON: { "title": string, "learnGoal": string }

Rules:
- title: 4-10 words, concrete + specific. Reference the actual mechanism / paper / technique. NEVER generic.
- learnGoal: 1 plain-language sentence. The single concrete claim or skill.
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
      return { title: String(parsed.title).slice(0, 200), learnGoal: String(parsed.learnGoal).slice(0, 400) };
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

module.exports = {
  harvest,
  clarifyQuestions,
  classifyArchetype,
  getEmphasis,
  classifyDifficulty,
  classifyIntrinsicLoad,
  classifyPriorKnowledge,
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
  designSeed,
  proposeNextLesson,
  adaptLessonGoal,
  // v0.6.0 — tier multiplier + probe + per-lesson re-harvest
  tierMultiplier,
  computePhaseLessonCounts,
  generateProbeMCQ,
  scoreProbe,
  _harvestPerLesson,
};
