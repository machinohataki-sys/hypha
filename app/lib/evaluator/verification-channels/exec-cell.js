// V0.5 E0 — exec-cell verification channel
//
// Runs a Node code cell in a sandboxed child process with timeout.
// Returns {pass, stdout_hash, runtime_ms, stderr_excerpt} matching events-schema.json exec_result.
//
// Non-LLM verifier per Leo R1 council concession: LLM cannot judge its own output;
// code that asserts pass/fail is the substrate.
//
// Created 2026-05-10 on v0.5-substrate.

'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 5000;
const STDERR_EXCERPT_MAX = 400;

function _sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function runCell(code, opts) {
  opts = opts || {};
  const timeout = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    if (typeof code !== 'string' || code.trim() === '') {
      return resolve({
        pass: false,
        stdout_hash: _sha256(''),
        runtime_ms: 0,
        stderr_excerpt: 'empty code cell',
        reason: 'empty_code',
      });
    }

    let child;
    try {
      child = spawn(process.execPath, ['-e', code], {
        timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_OPTIONS: '' },
      });
    } catch (err) {
      return resolve({
        pass: false,
        stdout_hash: _sha256(''),
        runtime_ms: Date.now() - start,
        stderr_excerpt: `spawn failed: ${err.message}`,
        reason: 'spawn_error',
      });
    }

    const killer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (_e) { /* re-emit */ console.warn('[exec-cell] kill failed'); }
    }, timeout);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    child.on('error', (err) => {
      clearTimeout(killer);
      resolve({
        pass: false,
        stdout_hash: _sha256(stdout),
        runtime_ms: Date.now() - start,
        stderr_excerpt: stderr.slice(0, STDERR_EXCERPT_MAX) || `child error: ${err.message}`,
        reason: 'child_error',
      });
    });

    child.on('close', (code) => {
      clearTimeout(killer);
      const runtime = Date.now() - start;
      const stderrExcerpt = stderr.slice(0, STDERR_EXCERPT_MAX);
      if (timedOut) {
        return resolve({
          pass: false,
          stdout_hash: _sha256(stdout),
          runtime_ms: runtime,
          stderr_excerpt: stderrExcerpt || 'timeout',
          reason: 'timeout',
        });
      }
      resolve({
        pass: code === 0,
        stdout_hash: _sha256(stdout),
        runtime_ms: runtime,
        stderr_excerpt: stderrExcerpt,
        exit_code: code,
      });
    });
  });
}

function assertCell(code, expectedStdoutHash, opts) {
  return runCell(code, opts).then((result) => {
    if (!result.pass) return result;
    return {
      ...result,
      pass: result.pass && (expectedStdoutHash == null || result.stdout_hash === expectedStdoutHash),
      hash_match: expectedStdoutHash == null ? null : result.stdout_hash === expectedStdoutHash,
    };
  });
}

module.exports = {
  runCell,
  assertCell,
  DEFAULT_TIMEOUT_MS,
};
