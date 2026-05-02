#!/usr/bin/env node
'use strict';

// Hypha CLI — terminal-native learning loop.
// Shares data/ + settings.json + agent.json with the Electron app.
// Same agent.js / vault.js / providers.js / personas.js as main.

const path = require('node:path');
const readline = require('node:readline');
const fs = require('node:fs');

// Resolve module paths relative to package root.
const ROOT = path.resolve(__dirname, '..');
const vault = require(path.join(ROOT, 'app', 'lib', 'vault'));
const agent = require(path.join(ROOT, 'app', 'agent'));
const providers = require(path.join(ROOT, 'app', 'lib', 'providers'));
const personas = require(path.join(ROOT, 'app', 'lib', 'personas'));

// ── ANSI helpers ────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  bold: '\x1b[1m',
  brass: '\x1b[38;5;180m',         // warm amber
  brassBright: '\x1b[38;5;215m',   // brighter amber
  ink: '\x1b[38;5;230m',           // cream
  inkMuted: '\x1b[38;5;138m',      // tan
  inkFaint: '\x1b[38;5;100m',      // dim olive
  teal: '\x1b[38;5;73m',           // accent teal
  red: '\x1b[38;5;167m',           // verdict-flag
  hr: '─',
};
const c = (s, code) => `${code}${s}${C.reset}`;
const log = (...args) => console.log(...args);
const write = (s) => process.stdout.write(s);
const hr = (n = 60) => c(C.hr.repeat(n), C.inkFaint);

// ── Settings ────────────────────────────────────────────────────────────────
function getSettings() {
  if (vault.exists && vault.exists('settings.json')) {
    return vault.readJSON('settings.json', null) || defaultSettings();
  }
  const def = defaultSettings();
  vault.writeJSON('settings.json', def);
  return def;
}
function defaultSettings() {
  // CLI default = Gemini (per user 2026-04-30 "用Gemini去学习"). Electron app
  // separately defaults to Claude or GLM via env. Both share the same file;
  // whichever surface writes last wins. Acceptable.
  if (process.env.GEMINI_API_KEY) {
    return { ...providers.defaultSettingsFor('gemini'), apiKey: process.env.GEMINI_API_KEY };
  }
  if (process.env.HYPHA_DEFAULT_GLM_KEY) {
    return { ...providers.defaultSettingsFor('glm'), apiKey: process.env.HYPHA_DEFAULT_GLM_KEY };
  }
  return { ...providers.defaultSettingsFor('claude'), apiKey: process.env.ANTHROPIC_API_KEY || '' };
}
function saveSettings(patch) {
  const cur = getSettings();
  const next = { ...cur, ...patch };
  vault.writeJSON('settings.json', next);
  return next;
}

// ── Spinner ─────────────────────────────────────────────────────────────────
function startSpinner(label) {
  if (!process.stdout.isTTY) return () => {};
  const frames = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];
  let i = 0;
  const id = setInterval(() => {
    write(`\r${c(frames[i = (i + 1) % frames.length], C.brass)} ${c(label, C.inkMuted)}`);
  }, 80);
  return () => {
    clearInterval(id);
    write('\r\x1b[K'); // clear line
  };
}

// ── readline helpers ────────────────────────────────────────────────────────
function ask(prompt, opts = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(c(prompt, C.brass), (ans) => { rl.close(); resolve(ans.trim()); });
    if (opts.default) write(opts.default);
  });
}
async function askChoice(prompt, choices) {
  log('');
  choices.forEach((ch, i) => log(`  ${c(String(i + 1).padStart(2, ' '), C.brass)}  ${ch.label}${ch.sub ? c(' · ' + ch.sub, C.inkFaint) : ''}`));
  log('');
  while (true) {
    const ans = await ask(prompt + ' ');
    const n = parseInt(ans, 10);
    if (Number.isFinite(n) && n >= 1 && n <= choices.length) return choices[n - 1];
    log(c('  pick a number 1-' + choices.length, C.red));
  }
}

// ── Banner ──────────────────────────────────────────────────────────────────
function banner() {
  log('');
  log(c('  Hypha', C.brassBright + C.italic) + c(' · the note agent', C.inkMuted + C.italic));
  log('');
}

// ── Commands ────────────────────────────────────────────────────────────────

async function cmdSettings(args) {
  banner();
  if (args[0] === 'set') {
    const kv = args[1];
    if (!kv || !kv.includes('=')) { log(c('usage: hypha settings set key=value', C.red)); return; }
    const [k, ...rest] = kv.split('=');
    const v = rest.join('=');
    if (k === 'provider') {
      const p = providers.getProvider(v);
      saveSettings({ provider: p.id, baseURL: p.baseURL, model: p.defaultModel });
    } else {
      saveSettings({ [k]: v });
    }
    log(c('  saved', C.teal));
    return;
  }
  const s = getSettings();
  log('  ' + c('provider', C.inkFaint) + '   ' + c(s.provider || '—', C.ink));
  log('  ' + c('model', C.inkFaint) + '      ' + c(s.model || '—', C.ink));
  log('  ' + c('baseURL', C.inkFaint) + '    ' + c(s.baseURL || '—', C.inkMuted));
  log('  ' + c('apiKey', C.inkFaint) + '     ' + (s.apiKey ? c('•••' + s.apiKey.slice(-6), C.teal) : c('(none)', C.red)));
  log('');
  log(c('  hypha settings set provider=gemini', C.inkFaint));
  log(c('  hypha settings set apiKey=AIza...', C.inkFaint));
  log(c('  hypha settings set model=gemini-2.5-pro', C.inkFaint));
}

async function cmdTest() {
  banner();
  const settings = getSettings();
  const cfg = providers.getProvider(settings.provider) || {};
  const stop = startSpinner('pinging ' + (settings.model || cfg.defaultModel) + '…');
  const t0 = Date.now();

  // CLI provider branch — spawn vendor binary, no API key.
  if (cfg.via === 'cli' && cfg.binary) {
    const { spawn } = require('node:child_process');
    const args = [];
    if (cfg.modelFlag) args.push(cfg.modelFlag, settings.model || cfg.defaultModel);
    if (cfg.promptFlag) args.push(cfg.promptFlag);
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(cfg.binary, args, { shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        stop();
        log('  ' + c('spawn failed (binary not in PATH?)', C.red) + '  ' + c(err.message, C.inkMuted));
        return resolve();
      }
      let out = '', errOut = '';
      child.stdout.on('data', d => { out += d.toString('utf8'); });
      child.stderr.on('data', d => { errOut += d.toString('utf8'); });
      child.on('close', code => {
        stop();
        if (code !== 0) {
          log('  ' + c('failed', C.red) + '  ' + c(`exit ${code}: ${errOut.slice(0, 200)}`, C.inkMuted));
        } else {
          const sample = out.trim().slice(0, 60) || '(empty)';
          log('  ' + c(settings.model || cfg.defaultModel, C.brassBright) + '  ' + c((Date.now() - t0) + 'ms', C.inkMuted) + '  ' + c('"' + sample + '"', C.teal) + '  ' + c('via CLI', C.inkFaint));
        }
        resolve();
      });
      try { child.stdin.write('Reply with: ready'); child.stdin.end(); }
      catch (_) {}
    });
  }

  // API provider branch.
  if (!settings.apiKey) { stop(); log(c('  no api key — hypha settings set apiKey=...', C.red)); return; }
  try {
    const OpenAI = require('openai');
    const client = new OpenAI({ apiKey: settings.apiKey, baseURL: settings.baseURL || 'https://api.openai.com/v1' });
    const isGLM = settings.provider === 'glm';
    const body = {
      model: settings.model,
      messages: [{ role: 'user', content: 'Reply with: ready' }],
      max_tokens: 16,
      temperature: 0,
    };
    if (isGLM) body.thinking = { type: 'disabled' };
    let r;
    try { r = await client.chat.completions.create(body); }
    catch (err) {
      if (isGLM && body.thinking && /thinking|enable_thinking/i.test(err.message || '')) {
        delete body.thinking; r = await client.chat.completions.create(body);
      } else throw err;
    }
    const msg = r.choices?.[0]?.message;
    const sample = (msg?.content || msg?.reasoning_content || '').trim().slice(0, 60);
    stop();
    log('  ' + c(settings.model, C.brassBright) + '  ' + c((Date.now() - t0) + 'ms', C.inkMuted) + '  ' + c('"' + sample + '"', C.teal));
  } catch (err) {
    stop();
    log('  ' + c('failed', C.red) + '  ' + c(err.message || String(err), C.inkMuted));
  }
}

// Lacquer Loop W5a — backfill missing fields on existing curricula's state.json.
// Adds `concepts: {}` (A1+A2 substrate) and `archetype` (Layer 3 router) if absent.
// Idempotent: skips already-migrated curricula. Reports per-slug action.
async function cmdMigrateState(args) {
  banner();
  const dryRun = args.includes('--dry-run');
  const root = vault.resolveRoot();
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { entries = []; }
  const settings = getSettings();
  let migrated = 0, skipped = 0, classified = 0;

  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const stateRel = `${e.name}/state.json`;
    const state = vault.readJSON(stateRel, null);
    if (!state) continue;

    const needsConcepts = !state.concepts;
    const needsArchetype = !state.archetype;
    if (!needsConcepts && !needsArchetype) {
      log('  ' + c(e.name + ' — already migrated', C.inkFaint));
      skipped += 1;
      continue;
    }

    if (needsConcepts) state.concepts = {};
    if (needsArchetype) {
      const goal = state.goal || '';
      try {
        if (dryRun) {
          state.archetype = 'TECH-CONCEPT';
          log('  ' + c(e.name + ' [dry-run] would classify (default TECH-CONCEPT)', C.inkMuted));
        } else {
          state.archetype = await agent.classifyArchetype(e.name, goal, settings);
          classified += 1;
          log('  ' + c(e.name + ' — archetype = ' + state.archetype, C.teal));
        }
      } catch (_) {
        state.archetype = 'TECH-CONCEPT';
        log('  ' + c(e.name + ' — classify failed, fallback TECH-CONCEPT', C.red));
      }
    }

    if (!dryRun) {
      vault.writeJSON(stateRel, state);
      log('  ' + c(e.name + ' — migrated (concepts:' + needsConcepts + ' archetype:' + needsArchetype + ')', C.brassBright));
    } else {
      log('  ' + c(e.name + ' [dry-run] would migrate (concepts:' + needsConcepts + ' archetype:' + needsArchetype + ')', C.inkMuted));
    }
    migrated += 1;
  }

  log('');
  log('  ' + c('migrated: ' + migrated + ' | skipped: ' + skipped + ' | LLM-classified: ' + classified, C.brassBright));
  if (dryRun) log('  ' + c('dry-run only — no files written. Run without --dry-run to apply.', C.inkFaint));
}

async function cmdTopics() {
  banner();
  const root = vault.resolveRoot();
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (_) { entries = []; }
  const topics = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const state = vault.readJSON(`${e.name}/state.json`, null);
    if (!state) continue;
    const ag = vault.readJSON(`${e.name}/agent.json`, { persona: 'socratic' });
    const persona = personas.getPersona(ag.persona || 'socratic');
    const total = (state.lessonRels || []).length;
    const done = (state.lastIdx ?? -1) + 1;
    topics.push({ slug: e.name, total, done, persona: persona.label, goal: state.goal || '' });
  }
  if (topics.length === 0) {
    log(c('  no topics yet — hypha learn "transformer architecture"', C.inkFaint));
    return;
  }
  topics.forEach(t => {
    log('  ' + c(t.slug, C.brassBright) + c('   ' + t.done + '/' + t.total + ' lessons', C.inkMuted) + c('   ' + t.persona, C.inkFaint));
    if (t.goal) log('  ' + c('  ' + t.goal, C.italic + C.inkMuted));
  });
  log('');
}

async function cmdLearn(args) {
  banner();
  const settings = getSettings();
  if (!settings.apiKey) { log(c('  no api key — hypha settings set apiKey=...', C.red)); return; }

  // --no-lacquer flag → vanilla baseline arm for A/B pilot comparison.
  // Strip flag from args before forming topic string.
  const disableLacquer = args.includes('--no-lacquer');
  args = args.filter(a => a !== '--no-lacquer');
  if (disableLacquer) log(c('  baseline mode (Lacquer Loop directives disabled)', C.inkMuted));

  let topic = args.join(' ').trim();
  if (!topic) topic = await ask('  topic: ');
  if (!topic) { log(c('  cancelled', C.red)); return; }
  const goal = await ask('  goal:  ');
  const timeChoice = await askChoice('  time: ', [
    { label: 'a week',     sub: '~30 lessons' },
    { label: 'a month',    sub: '~80 lessons' },
    { label: '3 months',   sub: '~150 lessons' },
    { label: 'open-ended', sub: 'as long as it takes' },
  ]);
  const timeCommit = ['week', 'month', 'quarter', 'open'][[
    'a week', 'a month', '3 months', 'open-ended'
  ].indexOf(timeChoice.label)];

  // Clarify
  log(''); log(hr());
  let stop = startSpinner('drafting clarifying questions…');
  let questions = [];
  try { questions = await agent.clarifyQuestions(topic, goal, timeCommit, settings); }
  catch (err) { stop(); log(c('  ' + err.message, C.red)); return; }
  stop();
  const clarifications = [];
  for (const q of questions) {
    log(''); log('  ' + c(q.question, C.ink + C.italic));
    const opts = q.options || [];
    const choice = await askChoice('  → ', opts.map(o => ({ label: o.label })));
    clarifications.push({ id: q.id, question: q.question, answer: choice.label });
  }

  // Harvest + design
  log(''); log(hr());
  stop = startSpinner('harvesting from GitHub / arXiv / HN…');
  const sources = await agent.harvest(topic, settings);
  stop();
  log('  ' + c('harvested ' + sources.length + ' sources', C.teal));

  stop = startSpinner('arranging lessons (1-3 min)…');
  const slug = String(topic).toLowerCase().trim().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'untitled';
  vault.writeJSON(`${slug}/sources.json`, sources);
  let sequence;
  try {
    var _ds = await agent.designSequence(topic, sources, 'intermediate', settings, { goal, timeCommit, clarifications, disableLacquer });
    sequence = _ds.lessons;
    var _archetype = _ds.archetype;
    var _lacquer = _ds.lacquer;
  } catch (err) { stop(); log(c('  designSequence failed: ' + err.message, C.red)); return; }
  stop();
  log('  ' + c('arranged ' + sequence.length + ' lessons (' + _archetype + ')', C.teal));

  // Write lesson stubs + state.json + agent.json
  const lessonRels = [];
  const today = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < sequence.length; i++) {
    const lesson = sequence[i];
    const fm = ['---',
      `lesson_idx: ${i}`,
      `learn_goal: ${JSON.stringify(lesson.learnGoal || '')}`,
      `locked: ${i > 0}`, `topic_slug: ${slug}`,
      `date_created: ${today}`, `date_distilled: null`, '---'].join('\n');
    const slug2 = (lesson.title || 'lesson').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
    const rel = `${slug}/${String(i).padStart(2, '0')}-${slug2}.md`;
    const body = `${fm}\n\n# ${lesson.title || 'Lesson ' + (i + 1)}\n\n## 课程基础\n\n*This lesson hasn't been taught yet. Run \`hypha lesson ${rel}\` to begin.*\n\n## 用户灵感\n\n`;
    vault.write(rel, body);
    lessonRels.push(rel);
  }
  vault.writeJSON(`${slug}/state.json`, {
    mastered: [], gaps: [], preferences: { level: 'intermediate' },
    goal, timeCommit, clarifications, archetype: _archetype, lacquer: _lacquer, concepts: {}, lastIdx: -1, lessonRels,
  });
  if (!vault.exists(`${slug}/agent.json`)) {
    const derived = personas.derivePersona({ topic, goal, clarifications });
    vault.writeJSON(`${slug}/agent.json`, { persona: derived, customInstructions: '', derivedFromClarifications: true });
    log('  ' + c('tutor → ' + personas.getPersona(derived).label, C.brassBright));
  }
  log('');
  log(c('  ready. begin lesson 1:', C.inkMuted));
  log(c('    hypha lesson ' + lessonRels[0], C.brassBright));
  log('');
}

async function cmdLesson(args) {
  banner();
  const rel = args[0];
  if (!rel) { log(c('  usage: hypha lesson <topic-slug>/<NN-stub.md>', C.red)); return; }
  const settings = getSettings();
  const note = vault.read(rel);
  if (!note) { log(c('  lesson not found: ' + rel, C.red)); return; }
  const fm = note.frontmatter || {};
  if (fm.locked === 'true') { log(c('  locked — finish prior lesson first', C.red)); return; }
  if (fm.date_distilled && fm.date_distilled !== 'null') {
    log(c('  this lesson is graduated. opening sessions list…', C.inkMuted));
    return cmdSessions(args);
  }
  await runLessonChat(rel, settings);
}

// Resume or start a fresh chat session for a lesson rel.
async function runLessonChat(rel, settings, opts = {}) {
  const note = vault.read(rel);
  const fm = note.frontmatter || {};
  const slug = fm.topic_slug || rel.split(/[\\/]/)[0];
  const idx = parseInt(fm.lesson_idx, 10);
  const sources = vault.readJSON(`${slug}/sources.json`, []);
  const state = vault.readJSON(`${slug}/state.json`, { mastered: [], gaps: [], lessonRels: [] });
  const agentProfile = vault.readJSON(`${slug}/agent.json`, { persona: 'socratic', customInstructions: '' });
  const persona = personas.getPersona(agentProfile.persona);
  const sequence = (state.lessonRels || []).map((_r, i) => ({ idx: i, title: '', learnGoal: '' }));
  const priorNotes = [];
  for (let i = 0; i < idx; i++) {
    const r = state.lessonRels?.[i]; if (!r) continue;
    const n = vault.read(r); if (n && n.body) priorNotes.push({ idx: i, body: n.body });
  }

  // Find or create session file
  let sessionFile = opts.sessionFile;
  let isNew = false;
  if (!sessionFile) {
    const dirRel = `${slug}/sessions`;
    const entries = vault.listDir(dirRel);
    const prefix = `L${String(idx).padStart(2, '0')}-`;
    const existing = entries
      .filter(e => !e.isDir && e.name.startsWith(prefix) && e.name.endsWith('.jsonl'))
      .sort((a, b) => b.name.localeCompare(a.name));
    if (existing.length > 0) {
      sessionFile = existing[0].name;
      log(c('  resuming session ' + sessionFile, C.inkFaint));
    } else {
      const startIso = new Date().toISOString().replace(/[:.]/g, '-');
      sessionFile = `L${String(idx).padStart(2, '0')}-${startIso}.jsonl`;
      isNew = true;
      vault.appendJSONL(`${dirRel}/${sessionFile}`, { ts: new Date().toISOString(), idx, role: 'meta', mode: 'fresh' });
    }
  }
  const sessionRel = `${slug}/sessions/${sessionFile}`;

  // Print header
  const lessonTitle = fm.title || note.body.match(/^# (.+)$/m)?.[1] || rel.split(/[\\/]/).pop();
  const learnGoal = String(fm.learn_goal || '').replace(/^"|"$/g, '');
  log('');
  log(c('  · tutor: ' + persona.label, C.brassBright + C.italic));
  log('  ' + c(lessonTitle, C.ink + C.bold));
  if (learnGoal) log('  ' + c(learnGoal, C.italic + C.inkMuted));
  log('  ' + hr(56));
  log('');

  // Replay prior turns
  const priorTurns = vault.readJSONL(sessionRel)
    .filter(t => t.idx === idx && (t.role === 'user' || t.role === 'tutor'));
  for (const t of priorTurns) {
    if (t.role === 'user') {
      log('  ' + c('you', C.brass + C.italic));
      log('  ' + (t.text || '').split('\n').map(l => '  ' + l).join('\n'));
      log('');
    } else {
      log('  ' + c('· tutor', C.brassBright + C.italic));
      log('  ' + (t.text || '').split('\n').map(l => '  ' + l).join('\n'));
      log('');
    }
  }

  // Build system prompt + transcript for API
  const systemPrompt = await agent.designLesson({
    topic: slug, idx, sequence, sources, state, priorNotes,
    lessonTitle, learnGoal, agentProfile,
  }, settings);
  const apiTranscript = priorTurns.map(t => ({
    role: t.role === 'tutor' ? 'assistant' : t.role,
    content: t.text,
  }));

  // First turn? Auto-fire __begin__
  let firstTurn = priorTurns.length === 0;

  // Interactive loop
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: c('  > ', C.brass) });
  const askLine = () => new Promise((resolve) => {
    rl.once('line', (line) => resolve(line.trim()));
    rl.prompt();
  });

  const cleanupRl = () => { try { rl.close(); } catch (_) {} };
  let userMsg = firstTurn ? '__begin__' : null;

  while (true) {
    if (!userMsg) {
      const input = await askLine();
      if (!input) continue;
      if (input === '/finish' || input === '/exit') break;
      if (input === '/help') {
        log(c('  /finish — graduate this lesson (distill into note)', C.inkFaint));
        log(c('  /exit   — leave (session preserved, resume later)', C.inkFaint));
        continue;
      }
      userMsg = input;
      vault.appendJSONL(sessionRel, { ts: new Date().toISOString(), idx, role: 'user', text: userMsg });
      apiTranscript.push({ role: 'user', content: userMsg });
    }

    log('');
    log('  ' + c('· tutor', C.brassBright + C.italic));
    write('  ');
    let acc = '';
    try {
      await agent.streamTurn({
        systemPrompt,
        history: apiTranscript.slice(0, -1), // history doesn't include latest user msg
        userMsg,
        settings,
      }, (chunk) => {
        acc += chunk;
        // Indent newlines in streaming
        write(chunk.replace(/\n/g, '\n  '));
      });
    } catch (err) {
      log(''); log('  ' + c('[error: ' + err.message + ']', C.red));
      cleanupRl(); return;
    }
    log(''); log('');
    vault.appendJSONL(sessionRel, { ts: new Date().toISOString(), idx, role: 'tutor', text: acc });
    apiTranscript.push({ role: 'assistant', content: acc });
    userMsg = null;
    firstTurn = false;
  }

  cleanupRl();

  // /finish path
  log('');
  log(c('  distilling…', C.inkMuted));
  try {
    const distilled = await agent.synthesizeNote({
      topic: slug, idx, transcript: apiTranscript.map(t => ({
        role: t.role === 'assistant' ? 'tutor' : t.role,
        content: t.content,
      })),
      sources, sequence, lessonTitle, learnGoal, mode: 'fresh', priorBody: note.body,
    }, settings);
    const today = new Date().toISOString().slice(0, 10);
    const newFm = ['---',
      `lesson_idx: ${idx}`,
      `learn_goal: ${JSON.stringify(learnGoal)}`,
      `locked: false`, `topic_slug: ${slug}`,
      `date_created: ${fm.date_created || today}`, `date_distilled: ${today}`, '---'].join('\n');
    vault.write(rel, `${newFm}\n\n${distilled}\n`);
    // Unlock next lesson
    const nextRel = state.lessonRels?.[idx + 1];
    if (nextRel) {
      const next = vault.read(nextRel);
      if (next) vault.write(nextRel, next.body.replace(/^locked:\s*true/m, 'locked: false'));
    }
    // Update state
    const newState = await agent.updateState({
      state, transcript: apiTranscript.map(t => ({ role: t.role === 'assistant' ? 'tutor' : t.role, content: t.content })),
      note: distilled, idx, sequence,
    }, settings);
    newState.lastIdx = Math.max(state.lastIdx ?? -1, idx);
    newState.lessonRels = state.lessonRels;
    vault.writeJSON(`${slug}/state.json`, newState);
    log(c('  graduated. note distilled into ' + rel, C.teal));
    if (nextRel) log(c('  next: hypha lesson ' + nextRel, C.brassBright));
  } catch (err) {
    log(c('  distill failed: ' + err.message, C.red));
  }
}

async function cmdSessions(args) {
  const rel = args[0];
  const note = vault.read(rel);
  if (!note) { log(c('  not found', C.red)); return; }
  const fm = note.frontmatter || {};
  const slug = fm.topic_slug || rel.split(/[\\/]/)[0];
  const idx = parseInt(fm.lesson_idx, 10);
  const dirRel = `${slug}/sessions`;
  const entries = vault.listDir(dirRel);
  const prefix = `L${String(idx).padStart(2, '0')}-`;
  const sessions = entries
    .filter(e => !e.isDir && e.name.startsWith(prefix) && e.name.endsWith('.jsonl'))
    .sort((a, b) => b.name.localeCompare(a.name));
  log('');
  log(c('  graduated · ' + (fm.date_distilled || ''), C.brassBright));
  log('  ' + c(rel, C.inkMuted));
  log('');
  if (sessions.length === 0) { log(c('  no sessions recorded', C.inkFaint)); return; }
  sessions.forEach((s, i) => {
    const turns = vault.readJSONL(`${dirRel}/${s.name}`).filter(t => t.idx === idx);
    const meta = turns.find(t => t.role === 'meta') || {};
    const userTurns = turns.filter(t => t.role === 'user').length;
    const firstTutor = turns.find(t => t.role === 'tutor');
    log('  ' + c(String(i + 1).padStart(2, ' '), C.brass) + '  ' + c(s.name, C.inkMuted) + '  ' + c(userTurns + ' turns', C.inkFaint) + (meta.mode === 'continuation' ? c(' · revisit', C.brassBright) : ''));
    if (firstTutor) log('       ' + c((firstTutor.text || '').slice(0, 80) + '…', C.italic + C.ink));
  });
  log('');
  log(c('  hypha lesson ' + rel + ' --session N   to read session N', C.inkFaint));
}

// ── Quiz bank (Lacquer Loop W4 falsifier) ───────────────────────────────────
// hypha quiz-bank <slug> [--up-to N] [--n-questions N]
// Generates a frozen 10-question recall test for lessons 0..upTo-1 of a curriculum.
// Writes to <slug>/quiz-bank.json with sha256 lock + created_at. Idempotent: refuses
// to overwrite an existing frozen bank unless --force.
async function cmdQuizBank(args) {
  banner();
  const slug = args[0];
  if (!slug) { log(c('  usage: hypha quiz-bank <topic-slug> [--up-to N] [--n-questions N] [--force]', C.red)); return; }
  const force = args.includes('--force');
  const upToFlag = args.indexOf('--up-to');
  const nFlag = args.indexOf('--n-questions');
  const upTo = upToFlag > -1 ? parseInt(args[upToFlag + 1], 10) || 7 : 7;
  const nQuestions = nFlag > -1 ? parseInt(args[nFlag + 1], 10) || 10 : 10;

  const stateRel = `${slug}/state.json`;
  const state = vault.readJSON(stateRel, null);
  if (!state) { log(c('  curriculum not found: ' + slug, C.red)); return; }
  const lessonRels = state.lessonRels || [];
  if (lessonRels.length === 0) { log(c('  curriculum has no lessons', C.red)); return; }

  const bankRel = `${slug}/quiz-bank.json`;
  if (vault.exists(bankRel) && !force) {
    log(c('  quiz-bank already frozen for ' + slug + ' — pass --force to regenerate (breaks Day-7 comparability)', C.red));
    return;
  }

  // Reconstruct sequence from lesson .md frontmatter (title + learn_goal).
  const sequence = lessonRels.slice(0, upTo).map((rel, idx) => {
    const note = vault.read(rel) || {};
    const fm = note.frontmatter || {};
    const title = (note.body || '').match(/^# (.+)$/m)?.[1] || `Lesson ${idx + 1}`;
    return { idx, title, learnGoal: fm.learn_goal || '', rel };
  });

  const settings = getSettings();
  log(c('  generating ' + nQuestions + ' frozen recall questions on lessons 0..' + (upTo - 1) + '…', C.inkMuted));
  let questions;
  try {
    questions = await agent.generateQuizBank(slug, sequence, settings, { upTo, numQuestions: nQuestions });
  } catch (err) { log(c('  generateQuizBank failed: ' + err.message, C.red)); return; }
  if (!questions || questions.length === 0) { log(c('  generation returned no questions', C.red)); return; }

  const crypto = require('node:crypto');
  const lessonsHashSrc = sequence.map(l => `${l.idx}|${l.title}|${l.learnGoal}`).join('\n');
  const inputHash = crypto.createHash('sha256').update(lessonsHashSrc).digest('hex').slice(0, 16);

  const bank = {
    slug,
    archetype: state.archetype || null,
    created_at: new Date().toISOString(),
    upTo,
    n_questions: questions.length,
    input_hash: inputHash,           // hash of lesson titles + goals — detects drift
    frozen: true,                     // do not edit; regenerate via --force only
    questions,
  };
  vault.writeJSON(bankRel, bank);
  log('  ' + c('quiz-bank frozen: ' + bankRel + ' (' + questions.length + ' questions, hash=' + inputHash + ')', C.brassBright));
  log('  ' + c('next: hypha quiz-run ' + slug + ' day0    (administer right after lessons)', C.inkFaint));
  log('  ' + c('then: hypha quiz-run ' + slug + ' day7    (administer 7 days later)', C.inkFaint));
}

// hypha quiz-run <slug> <attempt-tag>
// Walks the frozen bank, prompts learner for each answer, scores via LLM, writes
// <slug>/quiz-results.jsonl (one line per attempt — never edited, only appended).
async function cmdQuizRun(args) {
  banner();
  const slug = args[0];
  const tag = args[1] || ('attempt-' + Date.now());
  if (!slug) { log(c('  usage: hypha quiz-run <topic-slug> [tag]   e.g. day0 / day7', C.red)); return; }

  const bank = vault.readJSON(`${slug}/quiz-bank.json`, null);
  if (!bank || !Array.isArray(bank.questions)) {
    log(c('  no quiz-bank for ' + slug + ' — run: hypha quiz-bank ' + slug, C.red)); return;
  }

  const settings = getSettings();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(r => rl.question(q, r));

  log('  ' + c(bank.n_questions + ' questions | tag=' + tag + ' | bank-hash=' + bank.input_hash, C.inkMuted));
  log('');

  const results = [];
  for (let i = 0; i < bank.questions.length; i++) {
    const q = bank.questions[i];
    log(c(`Q${i + 1}/${bank.n_questions}  (lesson ${q.lesson_idx})`, C.brassBright));
    log('  ' + q.question);
    const learnerAnswer = (await ask(c('  > ', C.inkFaint))).trim();
    const judged = await agent.scoreQuizAnswer(q.question, q.expected_answer, q.scoring_criteria, learnerAnswer, settings);
    log('  ' + c(`score=${judged.score.toFixed(2)} — ${judged.reason}`, judged.score >= 0.7 ? C.teal : C.red));
    log('');
    results.push({
      qid: q.id ?? i, lesson_idx: q.lesson_idx, question: q.question,
      learner_answer: learnerAnswer, score: judged.score, reason: judged.reason,
    });
  }
  rl.close();

  const total = results.reduce((s, r) => s + r.score, 0);
  const pct = (total / results.length) * 100;
  const resultRecord = {
    tag, ts: new Date().toISOString(), bank_hash: bank.input_hash,
    n: results.length, total, pct, results,
  };
  // Append-only — never overwrite previous attempts.
  const resultsRel = `${slug}/quiz-results.jsonl`;
  vault.appendJSONL(resultsRel, resultRecord);

  log('  ' + c(`total: ${total.toFixed(1)} / ${results.length} = ${pct.toFixed(1)}%`, C.brassBright));
  log('  ' + c('written: ' + resultsRel, C.inkFaint));
}

// Lacquer Loop W6 — Learning Chain Planner. Council-designed (Yogo + Leo + Scout
// 2026-05-01). 7-step interactive flow: goal → time/daily/consistency/failed →
// classifyDifficulty (LLM) → clarifyQuestions Q&A (LLM) → classifyPriorKnowledge
// (LLM) → classifyIntrinsicLoad (LLM) → feasibility tier + plans → planChain (LLM).
// Persists to <slug>/chain.json.
async function cmdChain(args) {
  banner();
  const settings = getSettings();
  if (!settings.apiKey) { log(c('  no api key — hypha settings set apiKey=...', C.red)); return; }

  let goal = args.join(' ').trim();
  if (!goal) goal = await ask(c('  ultimate goal: ', C.brassBright));
  if (!goal) { log(c('  cancelled', C.red)); return; }

  // Numeric inputs (calibrated by council)
  const weeksRaw = await ask(c('  time budget (weeks; e.g. 4 / 12 / 26 / 52): ', C.inkMuted));
  const timeWeeks = Math.max(0.5, parseFloat(weeksRaw) || 4);
  const dailyRaw = await ask(c('  daily commitment (hours; Newport ceiling = 4): ', C.inkMuted));
  const dailyHours = Math.max(0.5, parseFloat(dailyRaw) || 2);
  const consistencyRaw = await ask(c('  prior consistency (days/week you actually studied >2h, last 60 days; 0-7): ', C.inkMuted));
  const priorConsistency = Math.max(0, Math.min(7, parseInt(consistencyRaw, 10) || 0));
  const failedRaw = await ask(c('  prior failed attempts at this goal (0 / 1 / 2+): ', C.inkMuted));
  const failedAttempts = Math.max(0, Math.min(5, parseInt(failedRaw, 10) || 0));

  // Step 1+2 in parallel — difficulty + intrinsic-load classification
  let stop = startSpinner('classifying goal difficulty + element interactivity…');
  const [diff, intrinsic] = await Promise.all([
    agent.classifyDifficulty(goal, settings),
    agent.classifyIntrinsicLoad(goal, settings),
  ]);
  stop();
  log('  ' + c('difficulty: ' + (diff.score * 100).toFixed(0) + '/100 — ' + diff.rationale, C.inkMuted));
  log('  ' + c('intrinsic load: ' + intrinsic.load + ' — ' + intrinsic.rationale, C.inkMuted));

  // Step 3 — Q&A on prior knowledge
  log('');
  log(hr());
  stop = startSpinner('drafting prior-knowledge questions…');
  let questions = [];
  try { questions = await agent.clarifyQuestions(goal, '', 'open', settings); }
  catch (err) { stop(); log(c('  clarifyQuestions failed: ' + err.message, C.red)); return; }
  stop();
  const answers = [];
  for (const q of questions) {
    log('');
    log('  ' + c(q.question, C.ink + C.italic));
    const opts = q.options || [];
    const choice = await askChoice('  ', opts.map(o => ({ label: o.label })));
    answers.push({ question: q.question, answer: choice.label });
  }

  // Step 4 — prior knowledge classification
  log('');
  stop = startSpinner('estimating your starting point…');
  const prior = await agent.classifyPriorKnowledge(goal, answers, settings);
  stop();
  log('  ' + c('starting point: ' + (prior.score * 100).toFixed(0) + '/100   gap to goal = ' + ((1 - prior.score) * 100).toFixed(0), C.inkMuted));
  if (prior.missing_prerequisites.length) {
    log('  ' + c('identified gaps:', C.inkMuted));
    prior.missing_prerequisites.forEach(p => log('    ' + c('· ' + p, C.inkFaint)));
  }

  // Step 5 — feasibility classification (pure function)
  const feasibility = require(path.join(ROOT, 'app', 'lib', 'feasibility'));
  const feasibilityInput = {
    targetDifficulty: diff.score,
    priorKnowledge: prior.score,
    timeWeeks, dailyHours,
    intrinsicLoad: intrinsic.load,
    priorConsistency, failedAttempts,
  };
  const verdict = feasibility.classifyFeasibility(feasibilityInput);
  log('');
  log(hr());
  const tierColor = verdict.tier === 'easy' ? C.teal : verdict.tier === 'possible' ? C.brassBright : C.red;
  const isCN = /[一-龥]/.test(goal);
  // Plain-language verdict — hide P10/P90, ratio, focus, ai_register, density.
  // Show only what 千金 cares about: tier name, time math, completion %, advice.
  log('  ' + c((isCN ? '判定：' : 'verdict: ') + verdict.config.label_zh + (isCN ? '' : ' (' + verdict.tier + ')'), tierColor));
  const gapMult = verdict.hoursAvailable > 0 ? Math.round(verdict.hoursNeeded / verdict.hoursAvailable) : '∞';
  log('  ' + c((isCN
    ? '  时间需要约 ' + verdict.hoursNeeded + ' 小时；你能投入约 ' + verdict.hoursAvailable + ' 小时（缺口 ≈ ' + gapMult + ' 倍）'
    : '  ~' + verdict.hoursNeeded + 'h needed / ~' + verdict.hoursAvailable + 'h available (~' + gapMult + 'x gap)'), C.inkFaint));
  log('  ' + c((isCN ? '  完成率估算约 ' : '  est. completion rate ≈ ') + (verdict.pComplete * 100).toFixed(0) + '%', C.inkFaint));
  if (isCN) {
    const adviceCN = {
      'nearly-impossible': '太挤——建议拉长时间或换更具体的目标。',
      'possible': '可达——需要稳定执行，前置阶段会有点累。',
      'easy': '时间充裕——可以加深探索或往上拔目标。',
    }[verdict.tier];
    log('  ' + c('  ' + adviceCN, C.italic + C.inkMuted));
  } else {
    log('  ' + c('  ' + verdict.config.advice, C.italic + C.inkMuted));
  }

  // Step 5b — multi-plan alternatives if not 'easy'.
  // Show only plans that actually CHANGE the tier (compared to baseline).
  // If no single lever shifts tier, surface that as a "no single fix" hint.
  let plans = null;
  if (verdict.tier !== 'easy') {
    plans = feasibility.proposePlans(feasibilityInput);
    const shapeLabelsCN = {
      'baseline': '原方案',
      'compress-target': '降低目标 30%',
      'extend-time': '时间 ×2',
      'intensify-daily': '每日提到 4h（Newport 上限）',
      'pivot-easier-domain': '换更具体的子领域',
    };
    const liftedPlans = plans.filter(p => p.shape !== 'baseline' && p.classification.tier !== verdict.tier);
    log('');
    log(c(isCN ? '  ── 备选方案 ──' : '  ── alternatives ──', C.brassBright));
    if (liftedPlans.length === 0) {
      log('  ' + c(isCN
        ? '  没有任何单一调整能把档位拉上去——需要复合（如同时拉时间 + 提目标具体度）。'
        : '  no single lever changes the tier — needs combined adjustments (e.g. extend-time + pivot-target).', C.red));
    } else {
      for (const p of liftedPlans) {
        const cz = p.classification;
        const label = (isCN ? shapeLabelsCN[p.shape] : p.shape) || p.shape;
        log('  ' + c('↑ ' + label, C.teal));
        log('    ' + c('→ ' + cz.config.label_zh + '  ' + (isCN ? '完成率 ≈ ' : 'pComp ≈ ') + (cz.pComplete * 100).toFixed(0) + '%', C.inkFaint));
      }
    }
  }

  // Step 6 — plan chain (LLM). Pass lang so output matches user's input language.
  log('');
  stop = startSpinner(isCN ? '设计学习链…' : 'designing learning chain…');
  const chain = await agent.planChain(goal, {
    tier: verdict.tier,
    ratio: verdict.ratio.p50,
    gap: verdict.gap,
    missing_prerequisites: prior.missing_prerequisites,
    timeWeeks, dailyHours,
    intrinsicLoad: intrinsic.load,
    pComplete: verdict.pComplete,
    lang: isCN ? 'zh' : 'en',
  }, settings);
  stop();
  if (!chain.links.length) { log(c(isCN ? '  学习链生成失败' : '  chain generation failed', C.red)); return; }

  // Step 7 — display + persist
  const roleLabelCN = { 'prerequisite': '前置', 'core': '核心', 'ultimate': '终点' };
  log('');
  log(c(isCN ? '  ── 学习链 ──' : '  ── LEARNING CHAIN ──', C.brassBright));
  chain.links.forEach((l, i) => {
    const roleColor = l.role === 'ultimate' ? C.brassBright : l.role === 'core' ? C.brass : C.inkMuted;
    const roleStr = isCN ? (roleLabelCN[l.role] || l.role) : l.role;
    const wkStr = (isCN ? '周' : 'w');
    log('  ' + c((i + 1) + '. ', C.brass) + c(l.topic, roleColor));
    log('     ' + c(l.duration_weeks + wkStr + ' · ' + roleStr, C.inkMuted));
    if (l.rationale) log('     ' + c((isCN ? '原因：' : 'why: ') + l.rationale, C.inkFaint));
    if (l.exit_criterion) log('     ' + c((isCN ? '过关：' : 'exit: ') + l.exit_criterion, C.inkFaint));
  });
  if (chain.warning) {
    log('');
    log(c('  ⚠ ' + chain.warning, C.red));
  }
  if (chain.alternatives) {
    if (chain.alternatives.extend_time_to_weeks) log(c('    ' + (isCN ? '改 ' : 'alt: extend to ') + chain.alternatives.extend_time_to_weeks + (isCN ? ' 周' : ' weeks'), C.inkMuted));
    if (chain.alternatives.lower_target_to) log(c('    ' + (isCN ? '换目标：' : 'alt: lower target to ') + '"' + chain.alternatives.lower_target_to + '"', C.inkMuted));
  }
  log('');

  const slug = goal.toLowerCase().trim().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'chain';
  const chainData = {
    slug, ultimate_goal: goal, created_at: new Date().toISOString(),
    inputs: { timeWeeks, dailyHours, priorConsistency, failedAttempts },
    classifications: { difficulty: diff, intrinsic, prior },
    questionnaire: answers,
    feasibility: verdict,
    plans,
    chain,
  };
  vault.writeJSON(`${slug}/chain.json`, chainData);
  log('  ' + c('saved: ' + slug + '/chain.json', C.inkFaint));
  log('  ' + c('next: hypha learn <link topic>     (drill into any link as a curriculum)', C.inkFaint));
  log('');
}

// Lacquer Loop W5+ pilot baseline tool — compares two curricula's quiz results.
// Usage: hypha pilot-report <lacquer-slug> <baseline-slug>
// Reads quiz-results.jsonl from each, finds latest day0 + day7 attempts,
// computes raw delta + retention-ratio delta, applies ≥15pp falsifier gate.
async function cmdPilotReport(args) {
  banner();
  const slugA = args[0]; const slugB = args[1];
  if (!slugA || !slugB) {
    log(c('  usage: hypha pilot-report <lacquer-slug> <baseline-slug>', C.red));
    log(c('  workflow:', C.inkFaint));
    log(c('    1. hypha learn <topic-A>             # lacquer arm', C.inkFaint));
    log(c('    2. hypha learn <topic-B> --no-lacquer  # baseline arm', C.inkFaint));
    log(c('    3. lessons + quiz-bank + quiz-run day0 + (7 days) + quiz-run day7 — both arms', C.inkFaint));
    log(c('    4. hypha pilot-report <A> <B>', C.inkFaint));
    return;
  }

  function loadResults(slug) {
    const stateRel = `${slug}/state.json`;
    const state = vault.readJSON(stateRel, null);
    if (!state) return null;
    const resultsRel = `${slug}/quiz-results.jsonl`;
    if (!vault.exists(resultsRel)) return { slug, state, day0: null, day7: null };
    const all = vault.readJSONL(resultsRel);
    const latestByTag = (tag) => all.filter(r => r.tag === tag).sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))[0] || null;
    return { slug, state, day0: latestByTag('day0'), day7: latestByTag('day7') };
  }

  const a = loadResults(slugA); const b = loadResults(slugB);
  if (!a) { log(c('  ' + slugA + ' — state.json missing', C.red)); return; }
  if (!b) { log(c('  ' + slugB + ' — state.json missing', C.red)); return; }

  function tagFor(arm) { return arm.state.lacquer === false ? 'baseline' : (arm.state.lacquer === true ? 'lacquer' : 'unknown'); }
  function pf(r) { return r ? `${r.pct.toFixed(1)}% (${r.n}q hash=${r.bank_hash || '?'})` : '(missing)'; }

  log(c('Pilot report — Lacquer Loop falsifier gate (≥15pp Day-7)', C.brassBright));
  log('');
  for (const arm of [a, b]) {
    const label = arm.slug + '  [' + tagFor(arm) + ']' + (arm.state.archetype ? '  archetype=' + arm.state.archetype : '');
    log('  ' + c(label, arm === a ? C.teal : C.inkMuted));
    log('    day0: ' + pf(arm.day0));
    log('    day7: ' + pf(arm.day7));
    if (arm.day0 && arm.day7) {
      const drop = arm.day0.pct - arm.day7.pct;
      const ratio = arm.day0.pct > 0 ? (arm.day7.pct / arm.day0.pct) * 100 : 0;
      log('    drop: ' + drop.toFixed(1) + 'pp     retention-ratio: ' + ratio.toFixed(1) + '%');
    }
  }
  log('');

  if (!(a.day7 && b.day7)) {
    log(c('  insufficient data — both arms need a day7 attempt', C.red));
    return;
  }

  const day7Delta = a.day7.pct - b.day7.pct;
  const sameBank = a.day7.bank_hash && a.day7.bank_hash === b.day7.bank_hash;
  log('  ' + c('Day-7 raw delta (lacquer − baseline): ' + day7Delta.toFixed(1) + 'pp', day7Delta >= 15 ? C.teal : C.red));
  if (!sameBank) log(c('    NOTE: bank-hash differs — raw delta only meaningful within same questions; prefer retention-ratio delta below.', C.inkFaint));

  let ratioDelta = null;
  if (a.day0 && b.day0 && a.day0.pct > 0 && b.day0.pct > 0) {
    const aRet = a.day7.pct / a.day0.pct; const bRet = b.day7.pct / b.day0.pct;
    ratioDelta = (aRet - bRet) * 100;
    log('  ' + c('Retention-ratio delta: ' + ratioDelta.toFixed(1) + 'pp', ratioDelta >= 15 ? C.teal : C.red));
  } else {
    log(c('  retention-ratio delta unavailable (need day0 in both arms)', C.inkFaint));
  }

  log('');
  const passRaw = day7Delta >= 15;
  const passRatio = ratioDelta !== null && ratioDelta >= 15;
  const verdict = (passRaw || passRatio) ? 'PASS' : 'FAIL';
  log('  ' + c('Falsifier gate (≥15pp): ' + verdict, verdict === 'PASS' ? C.brassBright : C.red));
  if (verdict === 'PASS') log('  ' + c('→ unlock A3 controller-state + TECH-CONCEPT archetype (per pedagogy.md)', C.inkFaint));
  else log('  ' + c('→ Lacquer Loop hypothesis collapses; revert to prior 5-design+3-runtime split or pure-prompt baseline', C.inkFaint));
}

// ── Phase 6 — verify-phase3 ────────────────────────────────────────────────
// Reads vault files only (no LLM, no Electron). Asserts file-level invariants
// for Phase 3.1 / 3.3 / 3.4. UI surfaces 3.2 + 3.5 are out of scope here —
// see plan §"UI smoke checklist" for those.
async function cmdVerifyPhase3(args) {
  banner();
  const slug = args[0];
  if (!slug) {
    log(c('  usage: hypha verify-phase3 <slug>', C.red));
    log(c('  reads <slug>/{state.json,adaptations.jsonl,NN-*.md} and reports PASS/FAIL', C.inkFaint));
    return;
  }
  const stateRel = `${slug}/state.json`;
  const state = vault.readJSON(stateRel, null);
  if (!state) { log(c('  ' + stateRel + ' missing — slug not a curriculum?', C.red)); return; }
  const lessonRels = Array.isArray(state.lessonRels) ? state.lessonRels : [];
  if (lessonRels.length === 0) { log(c('  no lessons in state.lessonRels', C.red)); return; }

  const log_ = vault.readJSONL(`${slug}/adaptations.jsonl`);
  const allEntries = Array.isArray(log_) ? log_ : [];
  const adaptEntries = allEntries.filter(r => r && r.type !== 'revert');
  const revertEntries = allEntries.filter(r => r && r.type === 'revert');

  const checks = [];   // {id, label, pass, detail}
  const ck = (id, label, pass, detail) => checks.push({ id, label, pass, detail });

  // [3.1] settled-signal adapt fired — at least one adapt entry, tier set on each
  if (adaptEntries.length === 0) {
    ck('3.1.fired', 'settled-signal adapt fired', false,
      'no entries in adaptations.jsonl (expected ≥1 after a fresh finish with rich atlas; see falsifier protocol)');
  } else {
    const validTier = adaptEntries.every(r => ['BASIC', 'STANDARD', 'DEEP'].includes(r.signalTier));
    const tierCount = adaptEntries.reduce((a, r) => { a[r.signalTier] = (a[r.signalTier] || 0) + 1; return a; }, {});
    const tierStr = Object.entries(tierCount).map(([t, n]) => `${t} ${n}`).join(' / ');
    ck('3.1.fired', 'settled-signal adapt fired', validTier,
      `${adaptEntries.length} entries, tiers: ${tierStr}` + (validTier ? '' : ' (some entries missing valid signalTier)'));
  }

  // [3.1] frontmatter `adapted: true` for affected lessons (excluding ones currently reverted)
  const latestRevertTs = new Map();
  for (const r of revertEntries) {
    if (Number.isFinite(r.affectedIdx) && r.ts) {
      const cur = latestRevertTs.get(r.affectedIdx);
      if (!cur || r.ts > cur) latestRevertTs.set(r.affectedIdx, r.ts);
    }
  }
  const affectedSet = new Set();
  for (const r of adaptEntries) {
    if (!Number.isFinite(r.affectedIdx)) continue;
    const rev = latestRevertTs.get(r.affectedIdx);
    if (rev && r.ts && rev > r.ts) continue;     // reverted — frontmatter should be adapted: false
    affectedSet.add(r.affectedIdx);
  }
  let fmAdaptedHits = 0; let fmAdaptedMisses = [];
  let countCapHits = 0; let countCapViolations = [];
  for (const idx of affectedSet) {
    const rel = lessonRels[idx];
    if (!rel) { fmAdaptedMisses.push(`idx=${idx} (no rel in state)`); continue; }
    const note = vault.read(rel);
    if (!note) { fmAdaptedMisses.push(`idx=${idx} (file missing)`); continue; }
    const fm = note.frontmatter || {};
    const isAdapted = String(fm.adapted || '').toLowerCase() === 'true';
    if (isAdapted) fmAdaptedHits += 1; else fmAdaptedMisses.push(`idx=${idx}`);
    const cnt = parseInt(fm.adaptation_count || '0', 10);
    if (cnt <= 2) countCapHits += 1; else countCapViolations.push(`idx=${idx} count=${cnt}`);
  }
  ck('3.1.fm', 'frontmatter `adapted: true` on active adapts',
    affectedSet.size > 0 ? fmAdaptedMisses.length === 0 : true,
    affectedSet.size === 0 ? 'no active adapts to check'
      : `${fmAdaptedHits}/${affectedSet.size} adapted` + (fmAdaptedMisses.length ? ` — missing on ${fmAdaptedMisses.join(', ')}` : ''));
  ck('3.1.cap', 'adaptation_count cap (≤2 per lesson)',
    countCapViolations.length === 0,
    affectedSet.size === 0 ? 'no active adapts to check'
      : `${countCapHits}/${affectedSet.size} within cap` + (countCapViolations.length ? ` — over: ${countCapViolations.join(', ')}` : ''));

  // [3.3] revert log structure — each revert references a real prior adapt
  const adaptIdxs = new Set(adaptEntries.map(r => r.affectedIdx).filter(Number.isFinite));
  const orphanReverts = revertEntries.filter(r => !adaptIdxs.has(r.affectedIdx));
  ck('3.3.struct', 'revert log structure (no orphan reverts)',
    orphanReverts.length === 0,
    `${revertEntries.length} reverts, ${orphanReverts.length} orphan` +
      (orphanReverts.length ? ` — affectedIdx not in adapt log: ${orphanReverts.map(r => r.affectedIdx).join(', ')}` : ''));

  // [3.3] oldTitle / oldGoal present (degraded-OK for pre-3.3 entries — count both)
  const withOldGoal = adaptEntries.filter(r => r.oldGoal != null).length;
  const withOldTitle = adaptEntries.filter(r => r.oldTitle != null).length;
  ck('3.3.fields', 'adapt log has oldGoal (revert prereq)',
    adaptEntries.length === 0 || withOldGoal === adaptEntries.length,
    `${withOldGoal}/${adaptEntries.length} entries have oldGoal · ${withOldTitle}/${adaptEntries.length} have oldTitle (oldTitle missing on pre-3.3 entries is OK; revert restores goal-only on those)`);

  // [3.4] weekly count (last 7 days)
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekly = adaptEntries.filter(r => r.ts && Date.parse(r.ts) >= sevenDaysAgo);
  const weeklyTiers = weekly.reduce((a, r) => { a[r.signalTier || 'STANDARD'] = (a[r.signalTier || 'STANDARD'] || 0) + 1; return a; }, {});
  const weeklyTierStr = Object.entries(weeklyTiers).map(([t, n]) => `${t}=${n}`).join(' ');
  ck('3.4.weekly', 'weekly summary count (last 7d)', true,
    `${weekly.length} adapts in past 7 days` + (weekly.length ? ` — tiers: ${weeklyTierStr}` : ''));

  // ── render ────────────────────────────────────────────────────────────────
  log(c(`=== Phase 3 verification: ${slug} ===`, C.brassBright));
  log('');
  let passes = 0; let fails = 0;
  for (const k of checks) {
    const tag = k.pass ? c('PASS', C.teal) : c('FAIL', C.red);
    log('  ' + c(`[${k.id}]`, C.inkFaint) + ' ' + k.label.padEnd(42) + ' ' + tag);
    if (k.detail) log('    ' + c(k.detail, C.inkMuted));
    if (k.pass) passes += 1; else fails += 1;
  }
  log('');
  log('  ' + c(`[summary] ${passes} PASS / ${fails} FAIL`, fails === 0 ? C.brassBright : C.red));
  if (fails > 0) {
    log(c('  → see plan §"Falsifier protocol" for triage by check id', C.inkFaint));
  } else {
    log(c('  → run UI smoke checklist next (3.2 vault dots / 3.4 fade-in / 3.5 streaming / 3.3 revert click)', C.inkFaint));
  }
}

async function cmdHelp() {
  banner();
  log('  ' + c('hypha chain [goal]', C.brassBright) + '         ' + c('plan a learning chain (council-calibrated feasibility tier)', C.inkMuted));
  log('  ' + c('hypha learn [topic] [--no-lacquer]', C.brassBright) + ' ' + c('start a course (--no-lacquer = baseline arm)', C.inkMuted));
  log('  ' + c('hypha topics', C.brassBright) + '              ' + c('list curricula', C.inkMuted));
  log('  ' + c('hypha lesson <rel>', C.brassBright) + '        ' + c('open / resume a lesson', C.inkMuted));
  log('  ' + c('hypha sessions <rel>', C.brassBright) + '      ' + c('list sessions for a graduated lesson', C.inkMuted));
  log('  ' + c('hypha quiz-bank <slug>', C.brassBright) + '    ' + c('generate frozen recall test (W4 falsifier)', C.inkMuted));
  log('  ' + c('hypha quiz-run <slug> <tag>', C.brassBright) + ' ' + c('administer + score (e.g. day0 / day7)', C.inkMuted));
  log('  ' + c('hypha migrate-state [--dry-run]', C.brassBright) + ' ' + c('backfill concepts/archetype on old curricula', C.inkMuted));
  log('  ' + c('hypha pilot-report <lacquer> <baseline>', C.brassBright) + ' ' + c('A/B compare day7 retention + ≥15pp gate', C.inkMuted));
  log('  ' + c('hypha verify-phase3 <slug>', C.brassBright) + ' ' + c('Phase 3 e2e file-level invariants (3.1/3.3/3.4)', C.inkMuted));
  log('  ' + c('hypha settings [set k=v]', C.brassBright) + '  ' + c('view / edit', C.inkMuted));
  log('  ' + c('hypha test', C.brassBright) + '                ' + c('ping current provider', C.inkMuted));
  log('');
  log(c('  inside a lesson: type / messages, /finish to graduate, /exit to pause', C.inkFaint));
  log('');
}

// ── Dispatch ────────────────────────────────────────────────────────────────
async function main() {
  const [, , cmd, ...args] = process.argv;
  switch (cmd) {
    case 'learn':     await cmdLearn(args); break;
    case 'topics':    await cmdTopics(); break;
    case 'lesson':    await cmdLesson(args); break;
    case 'sessions':  await cmdSessions(args); break;
    case 'quiz-bank': await cmdQuizBank(args); break;
    case 'quiz-run':  await cmdQuizRun(args); break;
    case 'migrate-state': await cmdMigrateState(args); break;
    case 'pilot-report': await cmdPilotReport(args); break;
    case 'verify-phase3': await cmdVerifyPhase3(args); break;
    case 'chain': await cmdChain(args); break;
    case 'settings':  await cmdSettings(args); break;
    case 'test':      await cmdTest(); break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:   await cmdHelp(); break;
    default:
      log(c('  unknown command: ' + cmd, C.red));
      log(c('  hypha help', C.inkFaint));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
