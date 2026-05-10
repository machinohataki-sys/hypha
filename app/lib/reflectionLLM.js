'use strict';

// reflectionLLM.js — post-lesson HERMES reflection LLM call.
//
// Per /tr council 2026-05-02 v0.9.1 plan: closes the user-profile feedback
// loop. After lesson:finish succeeds, this module is fired in the background.
// It loads the current user-profile.md, sends current profile + lesson
// transcript + 用户灵感 + 金句 + atlas delta to the LLM with a strict JSON
// diff schema, parses, applies high-confidence diffs, and persists. All
// attempts (success or parse-fail) are logged to .hypha/reflections.jsonl.
//
// Pure module — caller injects opts.llmCall so we don't require ../agent.
// Never crashes the caller; all paths return { ok, ... } or { ok: false, error }.

const fs = require('fs');
const path = require('path');

const PROMPT_PATH = path.join(__dirname, 'reflection-prompt.md');
const REFLECTIONS_LOG_REL = '.hypha/reflections.jsonl';

function _loadPrompt() {
  try { return fs.readFileSync(PROMPT_PATH, 'utf8'); } catch (_) { return ''; }
}

function _substitute(template, vars) {
  let out = template;
  for (const k of Object.keys(vars)) {
    const re = new RegExp('\\{\\{\\s*' + k + '\\s*\\}\\}', 'g');
    out = out.replace(re, String(vars[k] != null ? vars[k] : ''));
  }
  return out;
}

// Split the prompt into a system part (rules/contract) and user part (data).
// The split point is "Output ONLY valid JSON" — everything before is data,
// everything from there is the spec the model needs as system context.
function _splitPrompt(rendered) {
  const idx = rendered.indexOf('Output ONLY valid JSON');
  if (idx < 0) {
    return { system: rendered, user: '' };
  }
  return {
    user: rendered.slice(0, idx).trim(),
    system: rendered.slice(idx).trim(),
  };
}

function _tryParseJson(raw) {
  if (typeof raw !== 'string') {
    if (raw && typeof raw === 'object') return { ok: true, value: raw };
    return { ok: false };
  }
  // Strip code fences if model added them.
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  try { return { ok: true, value: JSON.parse(s) }; } catch (_) {}
  // Try to extract the first {...} block.
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return { ok: true, value: JSON.parse(s.slice(first, last + 1)) }; } catch (_) {}
  }
  return { ok: false };
}

function _appendLog(vaultRoot, record) {
  try {
    const dir = path.join(vaultRoot, '.hypha');
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
    fs.appendFileSync(path.join(vaultRoot, REFLECTIONS_LOG_REL), line, 'utf8');
  } catch (_) {}
}

// Main API -----------------------------------------------------------------

async function reflect(opts) {
  const o = opts || {};
  const vaultRoot = o.vaultRoot;
  const llmCall = o.llmCall;
  if (!vaultRoot || typeof llmCall !== 'function') {
    return { ok: false, error: 'missing vaultRoot or llmCall' };
  }
  const userProfile = require('./userProfile');
  const template = _loadPrompt();
  if (!template) {
    return { ok: false, error: 'reflection-prompt.md not loadable' };
  }

  // Truncate inputs to keep token cost bounded.
  const transcript = String(o.transcript || '').slice(-3000);
  const insightLayer = String(o.insightLayer || '').slice(0, 1500);
  const quotesArr = Array.isArray(o.quotes) ? o.quotes.slice(-5) : [];
  const quotesText = quotesArr.map((q, i) => `${i + 1}. ${String(q || '').slice(0, 200)}`).join('\n') || '(none)';
  const settled = (o.atlasDelta && Array.isArray(o.atlasDelta.settled)) ? o.atlasDelta.settled.join(', ') : '';
  const drifted = (o.atlasDelta && Array.isArray(o.atlasDelta.drifted)) ? o.atlasDelta.drifted.join(', ') : '';

  // Load current profile and serialize as markdown for the prompt slot.
  const currentProfile = userProfile.loadProfile(vaultRoot);
  const vaultName = path.basename(vaultRoot);
  const profileMd = userProfile.serializeProfile(currentProfile.sections || {}, vaultName);

  const rendered = _substitute(template, {
    profile_md: profileMd,
    lesson_title: String(o.lessonTitle || ''),
    transcript: transcript || '(empty)',
    insight_layer: insightLayer || '(empty)',
    quotes: quotesText,
    settled_terms: settled || '(none)',
    drifted_terms: drifted || '(none)',
  });

  const split = _splitPrompt(rendered);

  // Call the LLM.
  let raw = '';
  try {
    raw = await llmCall(split.system, split.user);
  } catch (e) {
    _appendLog(vaultRoot, { lessonRel: o.lessonRel, error: 'llm-call', detail: String(e && e.message || e) });
    return { ok: false, error: 'llm-call' };
  }

  const parsed = _tryParseJson(raw);
  if (!parsed.ok) {
    _appendLog(vaultRoot, { lessonRel: o.lessonRel, parse_error: true, raw: String(raw || '').slice(0, 4000) });
    return { ok: false, error: 'parse', raw };
  }

  const diff = (parsed.value && parsed.value.diff) || {};
  const overall = (parsed.value && typeof parsed.value.overall_confidence === 'number') ? parsed.value.overall_confidence : null;
  const notes = (parsed.value && typeof parsed.value.notes === 'string') ? parsed.value.notes : '';

  _appendLog(vaultRoot, {
    lessonRel: o.lessonRel,
    diff,
    overall_confidence: overall,
    notes,
    raw: String(raw || '').slice(0, 4000),
  });

  // Apply high-confidence entries.
  const applyResult = userProfile.applyDiff(currentProfile, diff, { minConfidence: 0.7 });
  try {
    userProfile.writeProfile(vaultRoot, { sections: applyResult.sections }, vaultName);
  } catch (_) {}

  return {
    ok: true,
    diff,
    accepted: applyResult.accepted,
    deferred: applyResult.deferred,
    overall_confidence: overall,
    notes,
  };
}

module.exports = { reflect };
