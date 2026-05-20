'use strict';
// Track A/B URL pinger — fetch URL, extract title/og:image/last-modified metadata.
// Per specs/track-a-b-social-sandbox.md §5 (Verification Harness).

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

const TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 200 * 1024; // 200KB cap for parse

function pingUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length < 8 || rawUrl.length > 500) {
    return Promise.resolve({ url: rawUrl, fetched_at: new Date().toISOString(), status_code: null, title: null, og_image: null, last_modified: null, error: 'BAD_URL' });
  }
  let parsed;
  try { parsed = new URL(rawUrl); } catch (_) {
    return Promise.resolve({ url: rawUrl, fetched_at: new Date().toISOString(), status_code: null, title: null, og_image: null, last_modified: null, error: 'BAD_URL_PARSE' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return Promise.resolve({ url: rawUrl, fetched_at: new Date().toISOString(), status_code: null, title: null, og_image: null, last_modified: null, error: 'BAD_PROTOCOL' });
  }
  const client = parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    let resolved = false;
    let buf = '';
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };
    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'User-Agent': 'HYPHA-pinger/0.5', 'Accept': 'text/html,application/xhtml+xml' },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const lastMod = res.headers['last-modified'] || null;
      res.setEncoding('utf-8');
      res.on('data', (chunk) => {
        if (buf.length > MAX_BODY_BYTES) { req.destroy(); return; }
        buf += chunk;
      });
      res.on('end', () => {
        const title = extractTitle(buf);
        const og = extractOgImage(buf);
        done({
          url: rawUrl,
          fetched_at: new Date().toISOString(),
          status_code: res.statusCode || null,
          title, og_image: og, last_modified: lastMod,
        });
      });
    });
    req.on('error', (e) => done({
      url: rawUrl, fetched_at: new Date().toISOString(),
      status_code: null, title: null, og_image: null, last_modified: null,
      error: e.code || e.message || 'ERR',
    }));
    req.on('timeout', () => { req.destroy(); done({
      url: rawUrl, fetched_at: new Date().toISOString(),
      status_code: null, title: null, og_image: null, last_modified: null,
      error: 'TIMEOUT',
    }); });
    req.end();
  });
}

function extractTitle(body) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  if (!m) return null;
  return m[1].trim().replace(/\s+/g, ' ').slice(0, 200) || null;
}

function extractOgImage(body) {
  const m = /<meta[^>]*property\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["']/i.exec(body)
        || /<meta[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:image["']/i.exec(body);
  if (!m) return null;
  return m[1].trim().slice(0, 500) || null;
}

module.exports = { pingUrl, extractTitle, extractOgImage };
