'use strict';

// HYPHA · Commons · Pack Security Layer (Wave 6.5 Commons full)
//
// Implements BLUEPRINT.md §12.6 Pack Security Layer.
//
// Threat model — community packs are FILES, not executables:
//   - Pack default = NEVER executed. No .exe / .msi / .bat / .cmd / .ps1
//     / .vbs / macros / unknown archives / auto-run scripts / browser
//     extensions / remote downloaders / executable deps.
//   - Prompt Injection — packs are read by LLMs. "Ignore previous
//     instructions" / "Disregard system prompt" patterns must be stripped.
//   - Phishing — URLs in packs may redirect through shorteners.
//   - Privacy leak — packs may exfiltrate vault data via crafted URLs.
//   - Malicious deps — packs cannot install npm/pip; we still flag
//     mention of executable deps.
//   - Disguised system prompts — "SYSTEM:" lines mid-content.
//
// All scans are LOCAL — no network calls. Phishing list is static.
//
// LLMs that consume Pack content MUST call sanitizeForLLM() first;
// raw pack content never reaches the model. See pack-intelligence-card.js
// generateCard for the boundary.

const fs = require('node:fs');
const path = require('node:path');

// File extensions banned outright — Pack default is read-only YAML/MD.
const BANNED_EXTENSIONS = Object.freeze([
  '.exe', '.msi', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe',
  '.js', // Pack content is not JS — even if our app is JS, packs are data
  '.dll', '.so', '.dylib',
  '.scr', '.pif', '.com', '.cpl',
  '.sh', '.bash', '.zsh',
  '.app', '.dmg', '.pkg', '.deb', '.rpm',
  '.jar', '.war', '.class',
  '.docm', '.xlsm', '.pptm', // Office with macros
  '.crx', '.xpi', // browser extensions
]);

// Suspicious archive types — opaque containers; deferred to Wave 7.
const SUSPICIOUS_EXTENSIONS = Object.freeze([
  '.zip', '.rar', '.7z', '.tar', '.gz', '.iso',
]);

// Allowed text content extensions inside a pack directory.
const ALLOWED_EXTENSIONS = Object.freeze([
  '.json', '.yaml', '.yml', '.md', '.markdown', '.txt',
]);

// PE/Mach-O/ELF magic bytes — detects binary payloads renamed to .txt.
const BINARY_MAGIC = Object.freeze([
  { type: 'PE (Windows EXE)',   bytes: [0x4D, 0x5A] }, // "MZ"
  { type: 'ELF (Linux)',        bytes: [0x7F, 0x45, 0x4C, 0x46] }, // "\x7FELF"
  { type: 'Mach-O 32',          bytes: [0xFE, 0xED, 0xFA, 0xCE] },
  { type: 'Mach-O 64',          bytes: [0xFE, 0xED, 0xFA, 0xCF] },
  { type: 'Mach-O 32 (reverse)', bytes: [0xCE, 0xFA, 0xED, 0xFE] },
  { type: 'Mach-O 64 (reverse)', bytes: [0xCF, 0xFA, 0xED, 0xFE] },
  { type: 'ZIP / DOCM / XLSM',  bytes: [0x50, 0x4B, 0x03, 0x04] }, // "PK"
  { type: 'RAR',                bytes: [0x52, 0x61, 0x72, 0x21] }, // "Rar!"
]);

// Prompt injection patterns — case-insensitive.
const INJECTION_PATTERNS = Object.freeze([
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts|messages|rules)/i,
  /disregard\s+(the|all|previous|above)\s*(system|prior|prompt)/i,
  /forget\s+(everything|all|the system|your training)/i,
  /you\s+are\s+now\s+(a different|in)\s+(role|mode|character)/i,
  /\bnew\s+(role|persona|character|task)\s*[:：]/i,
  /\b(system|assistant|user)\s*[:：]\s*(you|now|new)/i, // SYSTEM: reroute
  /override\s+(your|the|previous)\s+(instructions|guidelines|rules)/i,
  /print\s+(your|the)\s+(system\s+prompt|instructions|hidden)/i,
  /reveal\s+(your|the)\s+(system\s+prompt|secret|hidden)/i,
  /exfiltrate|exfilt|extract\s+vault/i,
  /\bjailbreak\b|\bDAN\b\s+mode/i,
  /pretend\s+you\s+(have|are)\s+no\s+(restrictions|guidelines|rules)/i,
]);

// Known URL shorteners — flagged as suspicious (cannot resolve without
// network; we surface, do not block).
const SUSPICIOUS_DOMAINS = Object.freeze([
  'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'ow.ly', 'is.gd',
  'buff.ly', 'rebrand.ly', 'shorturl.at', 'cutt.ly', 'rb.gy',
  'tiny.cc', 'mcaf.ee', 'shorte.st',
]);

// Phishing-pattern domains — typosquats of common platforms.
const PHISHING_PATTERNS = Object.freeze([
  /\bgoog1e\b/i, /\bg00gle\b/i, /\bgithulb\b/i, /\bgithub-?app\.\w+/i,
  /\bpayp[a4]l-?secure/i, /\bappleid-?\w+\.\w+/i, /\bmicros0ft\b/i,
]);

// Executable / network operations referenced in text — flag.
const DANGEROUS_REFERENCES = Object.freeze([
  /\bcurl\s+-[osLk]+\s+https?:\/\//i,
  /\bwget\s+https?:\/\//i,
  /\bpip\s+install\b/i,
  /\bnpm\s+install\b/i,
  /\bdocker\s+run\b/i,
  /\bbash\s+<\s*\(/i,
  /\biex\s*\(\s*new-object/i, // PowerShell IEX
  /\beval\s*\(/i,
  /child_process|spawnSync|execSync/i,
]);

/**
 * Strip a packPath to its root dir for scanning.
 */
function _packRoot(packPath) {
  if (!packPath) return null;
  try {
    const stat = fs.statSync(packPath);
    return stat.isDirectory() ? packPath : path.dirname(packPath);
  } catch (_) { return null; }
}

/**
 * Recursively enumerate files in a pack dir (depth-limited).
 */
function _walkPack(root, maxDepth = 4) {
  const out = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs, depth + 1);
      else if (ent.isFile()) out.push(abs);
    }
  }
  walk(root, 0);
  return out;
}

/**
 * Detect file-extension threats.
 */
function _scanExtensions(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (BANNED_EXTENSIONS.includes(ext)) {
    return { type: 'banned_extension', detail: `${path.basename(filePath)} has banned extension ${ext}`, severity: 'critical' };
  }
  if (SUSPICIOUS_EXTENSIONS.includes(ext)) {
    return { type: 'suspicious_archive', detail: `${path.basename(filePath)} is an opaque archive (${ext})`, severity: 'high' };
  }
  return null;
}

/**
 * Read first 16 bytes + check magic against BINARY_MAGIC.
 */
function _scanBinaryMagic(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, 16, 0);
    if (n === 0) return null;
    for (const magic of BINARY_MAGIC) {
      let match = true;
      for (let i = 0; i < magic.bytes.length; i++) {
        if (buf[i] !== magic.bytes[i]) { match = false; break; }
      }
      if (match) {
        return { type: 'binary_payload', detail: `${path.basename(filePath)} starts with ${magic.type} magic bytes`, severity: 'critical' };
      }
    }
    return null;
  } catch (_) { return null; }
  finally { if (fd) try { fs.closeSync(fd); } catch (_) {} }
}

/**
 * Read file content as text (skip if > 5MB to keep scans fast).
 */
function _readTextSafe(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 5 * 1024 * 1024) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) { return null; }
}

/**
 * Scan text content for prompt-injection patterns.
 */
function _scanInjection(content, filePath) {
  const threats = [];
  for (const pat of INJECTION_PATTERNS) {
    const m = content.match(pat);
    if (m) {
      threats.push({
        type: 'prompt_injection',
        detail: `${path.basename(filePath)}: injection pattern "${m[0].slice(0, 60)}"`,
        severity: 'high',
      });
    }
  }
  return threats;
}

/**
 * Extract URLs from text content.
 */
function _extractUrls(content) {
  const urlRe = /https?:\/\/[^\s)"'<>`]+/g;
  const out = [];
  let m;
  while ((m = urlRe.exec(content)) !== null) {
    out.push(m[0]);
  }
  return out;
}

/**
 * Classify URLs — phishing / shortener / clean.
 */
function _scanUrls(content, filePath) {
  const threats = [];
  const urls = _extractUrls(content);
  for (const url of urls) {
    let domain = '';
    try { domain = new URL(url).hostname.toLowerCase(); } catch (_) { continue; }
    if (SUSPICIOUS_DOMAINS.includes(domain)) {
      threats.push({
        type: 'suspicious_url',
        detail: `${path.basename(filePath)}: shortener URL ${url}`,
        severity: 'medium',
      });
    }
    for (const pat of PHISHING_PATTERNS) {
      if (pat.test(domain)) {
        threats.push({
          type: 'phishing_url',
          detail: `${path.basename(filePath)}: typosquat domain ${domain}`,
          severity: 'critical',
        });
        break;
      }
    }
  }
  return threats;
}

/**
 * Scan for dangerous shell / install references in text.
 */
function _scanDangerousRefs(content, filePath) {
  const threats = [];
  for (const pat of DANGEROUS_REFERENCES) {
    const m = content.match(pat);
    if (m) {
      threats.push({
        type: 'dangerous_reference',
        detail: `${path.basename(filePath)}: contains "${m[0].slice(0, 60)}"`,
        severity: 'high',
      });
    }
  }
  return threats;
}

/**
 * Full pack scan. Returns:
 *   {
 *     safe: bool,
 *     threats: [{ type, detail, severity }],
 *     scanned_files: number,
 *     timestamp: ISO
 *   }
 *
 * `safe = true` ↔ zero `critical` threats AND `high` count ≤ 1.
 */
function scanPack(packPath) {
  const root = _packRoot(packPath);
  if (!root) {
    return { safe: false, threats: [{ type: 'path_unreadable', detail: `Cannot read ${packPath}`, severity: 'critical' }], scanned_files: 0, timestamp: new Date().toISOString() };
  }
  const files = _walkPack(root);
  const threats = [];

  for (const f of files) {
    const extThreat = _scanExtensions(f);
    if (extThreat) threats.push(extThreat);

    // Always check binary magic even on allowed extensions (defense in depth)
    const magicThreat = _scanBinaryMagic(f);
    if (magicThreat) threats.push(magicThreat);

    // Content scan only on text-allowed files (or extension-less)
    const ext = path.extname(f).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext) || ext === '') {
      const content = _readTextSafe(f);
      if (content != null) {
        threats.push(..._scanInjection(content, f));
        threats.push(..._scanUrls(content, f));
        threats.push(..._scanDangerousRefs(content, f));
      }
    }
  }

  const criticalCount = threats.filter(t => t.severity === 'critical').length;
  const highCount = threats.filter(t => t.severity === 'high').length;
  const safe = criticalCount === 0 && highCount <= 1;

  return {
    safe,
    threats,
    scanned_files: files.length,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Derive enum safety level from scan result.
 *   safe    — 0 critical + 0 high
 *   caution — 0 critical + 1 high   OR  ≥1 medium
 *   unsafe  — 0 critical + ≥2 high
 *   blocked — ≥1 critical
 */
function assessSafetyLevel(scanResult) {
  if (!scanResult || !Array.isArray(scanResult.threats)) return 'unknown';
  const sev = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const t of scanResult.threats) {
    if (sev[t.severity] != null) sev[t.severity]++;
  }
  if (sev.critical >= 1) return 'blocked';
  if (sev.high >= 2) return 'unsafe';
  if (sev.high === 1 || sev.medium >= 1) return 'caution';
  return 'safe';
}

/**
 * Sanitize a pack content string before LLM consumption. Strips
 * injection-pattern matches, replaces URLs with a tagged token, and
 * removes binary references. Output is safe to embed into LLM context.
 *
 * Returns { sanitized: string, removed: [{ type, original }] }
 */
function sanitizeForLLM(packContent) {
  if (typeof packContent !== 'string') {
    return { sanitized: '', removed: [{ type: 'invalid_input', original: typeof packContent }] };
  }
  let s = packContent;
  const removed = [];

  // Strip injection patterns — replace match with "[SANITIZED:injection]"
  for (const pat of INJECTION_PATTERNS) {
    const globalPat = new RegExp(pat.source, pat.flags.includes('g') ? pat.flags : pat.flags + 'g');
    s = s.replace(globalPat, (m) => {
      removed.push({ type: 'prompt_injection', original: m });
      return '[SANITIZED:injection]';
    });
  }

  // Strip dangerous-ref lines BEFORE URL tagging — the dangerous-ref
  // patterns match raw URLs (e.g. `curl -sL https://...`), so tagging
  // URLs first would shred the pattern and miss the threat.
  for (const pat of DANGEROUS_REFERENCES) {
    const globalPat = new RegExp(pat.source, pat.flags.includes('g') ? pat.flags : pat.flags + 'g');
    s = s.replace(globalPat, (m) => {
      removed.push({ type: 'dangerous_reference', original: m });
      return '[SANITIZED:dangerous-ref]';
    });
  }

  // Tag remaining URLs — replace with "[URL:domain]" for transparency.
  s = s.replace(/https?:\/\/[^\s)"'<>`]+/g, (url) => {
    let domain = 'unknown';
    try { domain = new URL(url).hostname.toLowerCase(); } catch (_) {}
    removed.push({ type: 'url_tagged', original: url });
    return `[URL:${domain}]`;
  });

  // Strip control characters (defense against unicode-tag injection)
  s = s.replace(/[ ---]/g, '');

  return { sanitized: s, removed };
}

module.exports = {
  scanPack,
  assessSafetyLevel,
  sanitizeForLLM,
  // Exported for testing / introspection:
  BANNED_EXTENSIONS,
  SUSPICIOUS_EXTENSIONS,
  ALLOWED_EXTENSIONS,
  INJECTION_PATTERNS,
  SUSPICIOUS_DOMAINS,
};
