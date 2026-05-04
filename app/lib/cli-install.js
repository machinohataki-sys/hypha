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
// listens on localhost callback, exits when done. We just spawn + report exit.
function loginClaude(onChunk) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('claude', ['login'], {
        shell: process.platform === 'win32',
        stdio: ['inherit', 'pipe', 'pipe'],
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

module.exports = { detectClaude, installClaude, loginClaude, uninstallClaude };
