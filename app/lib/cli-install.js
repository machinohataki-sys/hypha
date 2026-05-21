'use strict';

// cli-install.js — v0158d — orchestrate Claude Code CLI lifecycle from inside Hypha.
//
// Per user 2026-05-04 reframe: "Hypha = local environment, install Claude IN it
// (like terminal: npm install -g @anthropic-ai/claude-code + claude login)".
// This module is the install/detect/login/uninstall toolkit. Each function
// spawns the appropriate command + streams output.

const { spawn } = require('node:child_process');

// Detect if `claude` binary is on PATH. Returns { installed, version, error? }.
function detectClaude() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('claude', ['--version'], { shell: process.platform === 'win32' });
    } catch (e) { return resolve({ installed: false, error: 'spawn threw: ' + e.message }); }
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} resolve({ installed: false, error: 'detect timeout 8s' }); }, 8000);
    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('error', e => { clearTimeout(timer); resolve({ installed: false, error: e.message }); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) {
        // Parse version (output is like "1.2.3 (Claude Code)")
        const m = out.match(/(\d+\.\d+\.\d+)/);
        return resolve({ installed: true, version: m ? m[1] : out.trim().split('\n')[0], raw: out.trim() });
      }
      resolve({ installed: false, error: err.trim() || `exit ${code}` });
    });
  });
}

// Install Claude Code via npm (-g). Streams stdout/stderr to onChunk callback.
// Returns { ok, code, stderr? }. Hard timeout 5min (npm install can be slow).
function installClaude(onChunk) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('npm', ['install', '-g', '@anthropic-ai/claude-code'], {
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) { return resolve({ ok: false, error: 'spawn threw: ' + e.message }); }

    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
      resolve({ ok: false, error: 'install timeout 5min', stderr: stderr.slice(-500) });
    }, 300_000);

    child.stdout.on('data', d => {
      const chunk = d.toString('utf8');
      try { onChunk && onChunk(chunk); } catch (_) {}
    });
    child.stderr.on('data', d => {
      const chunk = d.toString('utf8');
      stderr += chunk;
      try { onChunk && onChunk(chunk); } catch (_) {}
    });
    child.on('error', err => {
      clearTimeout(timer);
      const msg = /ENOENT|not.*found/i.test(err.message)
        ? 'npm not found on PATH. Install Node.js + npm first: https://nodejs.org/'
        : err.message;
      resolve({ ok: false, error: msg });
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, code });
      else resolve({ ok: false, code, stderr: stderr.slice(-500), error: `npm install exit ${code}` });
    });
  });
}

// Run `claude login` to start OAuth flow. claude binary opens user's browser,
// listens on localhost callback, exits when done.
//
// v0158o — spawn in Hypha's CLI sandbox (CLAUDE_CONFIG_DIR + HOME redirected
// to userData/cli-sandbox/). Token saves to sandbox/.claude/credentials.json,
// which is the SAME location every Hypha agent invocation reads from. Without
// sandbox env here, the login token went to user's real ~/.claude/ but lesson
// dispatch (post-v0158n) reads sandbox HOME → auth always fails.
function loginClaude(onChunk) {
  return new Promise((resolve) => {
    let child;
    try {
      let sandboxOpts = { env: { ...process.env }, cwd: undefined };
      try {
        const agent = require('../agent');
        // v0158p — pass settings so CLAUDE_CODE_OAUTH_TOKEN gets injected.
        let settings = null;
        try { settings = require('../main')._hyphaSettings && require('../main')._hyphaSettings(); }
        catch (_) { /* main may be in init order; fall back to no token */ }
        if (typeof agent._hyphaSandboxedSpawnOpts === 'function') {
          sandboxOpts = agent._hyphaSandboxedSpawnOpts(process.env, { binary: 'claude' }, settings);
        }
      } catch (_) { /* fall back to inherit env if agent not loaded yet */ }
      child = spawn('claude', ['login'], {
        shell: process.platform === 'win32',
        stdio: ['inherit', 'pipe', 'pipe'],
        env: sandboxOpts.env,
        cwd: sandboxOpts.cwd,
      });
    } catch (e) { return resolve({ ok: false, error: 'spawn threw: ' + e.message }); }

    let out = '', stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
      resolve({ ok: false, error: 'login timeout 5min — browser flow incomplete?', log: out.slice(-500) });
    }, 300_000);

    child.stdout.on('data', d => {
      const chunk = d.toString('utf8');
      out += chunk;
      try { onChunk && onChunk(chunk); } catch (_) {}
    });
    child.stderr.on('data', d => {
      const chunk = d.toString('utf8');
      stderr += chunk;
      try { onChunk && onChunk(chunk); } catch (_) {}
    });
    child.on('error', err => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, log: out.slice(-500) });
      else resolve({ ok: false, code, error: stderr.trim() || `claude login exit ${code}`, log: out.slice(-500) });
    });
  });
}

// Uninstall via npm.
function uninstallClaude(onChunk) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('npm', ['uninstall', '-g', '@anthropic-ai/claude-code'], {
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) { return resolve({ ok: false, error: 'spawn threw: ' + e.message }); }

    let stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} resolve({ ok: false, error: 'uninstall timeout 60s' }); }, 60_000);

    child.stdout.on('data', d => { try { onChunk && onChunk(d.toString('utf8')); } catch (_) {} });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); try { onChunk && onChunk(d.toString('utf8')); } catch (_) {} });
    child.on('error', err => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stderr: stderr.slice(-300) });
    });
  });
}

// v0158o — logout: spawn `claude logout` in sandbox; clears sandbox/.claude/
// credentials. Idempotent (logout when not logged in returns code 0).
function logoutClaude(onChunk) {
  return new Promise((resolve) => {
    let child;
    try {
      let sandboxOpts = { env: { ...process.env }, cwd: undefined };
      try {
        const agent = require('../agent');
        if (typeof agent._hyphaSandboxedSpawnOpts === 'function') {
          sandboxOpts = agent._hyphaSandboxedSpawnOpts(process.env, { binary: 'claude' });
        }
      } catch (_) {}
      child = spawn('claude', ['logout'], {
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: sandboxOpts.env,
        cwd: sandboxOpts.cwd,
      });
    } catch (e) { return resolve({ ok: false, error: 'spawn threw: ' + e.message }); }
    let out = '', stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch (_) {} resolve({ ok: false, error: 'logout timeout 30s' }); }, 30_000);
    child.stdout.on('data', d => { const c = d.toString('utf8'); out += c; try { onChunk && onChunk(c); } catch (_) {} });
    child.stderr.on('data', d => { const c = d.toString('utf8'); stderr += c; try { onChunk && onChunk(c); } catch (_) {} });
    child.on('error', err => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, log: out.slice(-300), stderr: stderr.slice(-300) });
    });
  });
}

// v0158o — auth-status: read sandbox/.claude/ for any *.credentials* file +
// return whether claude is authenticated + path/mtime. Avoids spawning claude
// (fast, no network). Returns { ok, loggedIn, credPath, mtime } or { ok, loggedIn:false, reason }.
function authStatusClaude() {
  try {
    const path = require('node:path');
    const fs = require('node:fs');
    const agent = require('../agent');
    if (typeof agent._hyphaSandboxDir !== 'function') {
      return { ok: false, error: 'sandbox helper not loaded' };
    }
    const dir = agent._hyphaSandboxDir();
    if (!dir) return { ok: false, error: 'sandbox dir resolution failed' };
    const credDir = path.join(dir, '.claude');
    let entries = [];
    try { entries = fs.readdirSync(credDir); } catch (_) { return { ok: true, loggedIn: false, reason: '.claude dir not in sandbox yet' }; }
    const credFile = entries.find(f => /credential/i.test(f) || /\.credentials\.json/i.test(f));
    if (!credFile) return { ok: true, loggedIn: false, reason: 'no credentials file found' };
    const credPath = path.join(credDir, credFile);
    let stat = null;
    try { stat = fs.statSync(credPath); } catch (_) {}
    return { ok: true, loggedIn: true, credPath, mtime: stat ? stat.mtime.toISOString() : null };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { detectClaude, installClaude, loginClaude, logoutClaude, authStatusClaude, uninstallClaude };
