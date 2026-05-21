'use strict';

// HYPHA · Commons · License Layer (Wave 6.5 Commons full)
//
// Implements BLUEPRINT.md §12.7 License — parses pack.license, enforces
// usage intents, generates attribution text.
//
// Single source of truth for what a user is allowed to DO with a pack.
// 4 intents: private_learn / public_lesson / commercial / modify.
//
// LICENSE_TYPES strictly enumerated. "unknown" = parse failed; treated as
// most restrictive (private_learn only) to keep users safe by default.

const fs = require('node:fs');
const path = require('node:path');

const LICENSE_TYPES = Object.freeze([
  'CC0',
  'CC-BY',
  'CC-BY-SA',
  'CC-BY-NC',
  'CC-BY-NC-SA',
  'MIT',
  'Apache-2.0',
  'GPL-3.0',
  'proprietary',
  'unknown',
]);

// Permission matrix per license. Each row = { private_learn,
// public_lesson, commercial, modify, attribution_required, share_alike }.
const LICENSE_PERMISSIONS = Object.freeze({
  'CC0':         { private_learn: true,  public_lesson: true,  commercial: true,  modify: true,  attribution_required: false, share_alike: false },
  'CC-BY':       { private_learn: true,  public_lesson: true,  commercial: true,  modify: true,  attribution_required: true,  share_alike: false },
  'CC-BY-SA':    { private_learn: true,  public_lesson: true,  commercial: true,  modify: true,  attribution_required: true,  share_alike: true  },
  'CC-BY-NC':    { private_learn: true,  public_lesson: true,  commercial: false, modify: true,  attribution_required: true,  share_alike: false },
  'CC-BY-NC-SA': { private_learn: true,  public_lesson: true,  commercial: false, modify: true,  attribution_required: true,  share_alike: true  },
  'MIT':         { private_learn: true,  public_lesson: true,  commercial: true,  modify: true,  attribution_required: true,  share_alike: false },
  'Apache-2.0':  { private_learn: true,  public_lesson: true,  commercial: true,  modify: true,  attribution_required: true,  share_alike: false },
  'GPL-3.0':     { private_learn: true,  public_lesson: true,  commercial: true,  modify: true,  attribution_required: true,  share_alike: true  },
  'proprietary': { private_learn: true,  public_lesson: false, commercial: false, modify: false, attribution_required: true,  share_alike: false },
  'unknown':     { private_learn: true,  public_lesson: false, commercial: false, modify: false, attribution_required: true,  share_alike: false },
});

// Normalize free-form license strings → canonical LICENSE_TYPES value.
const LICENSE_ALIASES = Object.freeze({
  // CC0
  'cc0':                   'CC0',
  'cc-0':                  'CC0',
  'cc 0':                  'CC0',
  'public domain':         'CC0',
  'creative commons zero': 'CC0',
  // CC-BY family
  'cc-by':                 'CC-BY',
  'cc by':                 'CC-BY',
  'cc-by 4.0':             'CC-BY',
  'cc by 4.0':             'CC-BY',
  'cc-by-sa':              'CC-BY-SA',
  'cc by sa':              'CC-BY-SA',
  'cc-by-nc':              'CC-BY-NC',
  'cc by nc':              'CC-BY-NC',
  'cc-by-nc-sa':           'CC-BY-NC-SA',
  'cc by nc sa':           'CC-BY-NC-SA',
  // OSS
  'mit':                   'MIT',
  'mit license':           'MIT',
  'apache':                'Apache-2.0',
  'apache 2':              'Apache-2.0',
  'apache-2.0':            'Apache-2.0',
  'apache 2.0':            'Apache-2.0',
  'gpl':                   'GPL-3.0',
  'gpl-3.0':               'GPL-3.0',
  'gpl3':                  'GPL-3.0',
  'gplv3':                 'GPL-3.0',
  // proprietary
  'proprietary':           'proprietary',
  'all rights reserved':   'proprietary',
  'commercial':            'proprietary',
});

/**
 * Normalize a license string and return canonical LICENSE_TYPES value.
 */
function _canonicalize(raw) {
  if (raw == null) return 'unknown';
  const norm = String(raw).trim().toLowerCase().replace(/[._]/g, '-').replace(/\s+/g, ' ');
  if (LICENSE_ALIASES[norm]) return LICENSE_ALIASES[norm];
  // Try direct match against LICENSE_TYPES (case-insensitive)
  for (const t of LICENSE_TYPES) {
    if (t.toLowerCase() === norm) return t;
  }
  // Partial prefix match — longest alias first so "cc-by-nc-sa 4.0" beats
  // "cc-by". Without this sort, declaration order wins and shorter
  // prefixes silently shadow longer (CC-BY-NC-SA → CC-BY bug).
  const sortedAliases = Object.entries(LICENSE_ALIASES)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [alias, canonical] of sortedAliases) {
    if (norm.startsWith(alias)) return canonical;
  }
  return 'unknown';
}

/**
 * Parse the license field from a pack object (pack.json shape) OR from a
 * pack YAML/JSON file path. Returns:
 *   {
 *     license,                  // canonical LICENSE_TYPES value
 *     raw,                      // original string
 *     allowed_usage: { private_learn, public_lesson, commercial, modify },
 *     attribution_required,
 *     share_alike,
 *     summary,                  // short editorial line
 *   }
 */
function parseLicense(packOrYamlPath) {
  let pack = packOrYamlPath;

  if (typeof packOrYamlPath === 'string') {
    // Path argument — load pack.json (we only ship JSON in v0.1; YAML
    // support is a v0.2+ ladder. JSON only for now per Wave 6 ship.)
    try {
      const raw = fs.readFileSync(packOrYamlPath, 'utf8');
      pack = JSON.parse(raw);
    } catch (err) {
      return {
        license: 'unknown',
        raw: null,
        allowed_usage: { private_learn: true, public_lesson: false, commercial: false, modify: false },
        attribution_required: true,
        share_alike: false,
        summary: `License parse failed (${err && err.message}); treating as most-restrictive.`,
      };
    }
  }

  const raw = (pack && pack.license != null) ? pack.license : null;
  const canonical = _canonicalize(raw);
  const perms = LICENSE_PERMISSIONS[canonical];

  const author = pack && (pack.author || pack.curator) ? (pack.author || pack.curator) : 'Unknown';
  const topic = pack && pack.topic ? pack.topic : 'Unknown pack';

  let summary;
  if (canonical === 'CC0') {
    summary = `公共领域 (CC0) — 任意使用, 无需署名.`;
  } else if (canonical.startsWith('CC-BY-NC')) {
    summary = `${canonical} — 可学习 / 可公开课程 / 禁商业用途. 需署名${perms.share_alike ? ' + 同协议共享' : ''}.`;
  } else if (canonical.startsWith('CC-BY')) {
    summary = `${canonical} — 可商业 / 可改编. 需署名${perms.share_alike ? ' + 同协议共享' : ''}.`;
  } else if (canonical === 'MIT' || canonical === 'Apache-2.0') {
    summary = `${canonical} — OSS 许可, 商业友好. 需保留 ${canonical === 'MIT' ? '版权声明' : '版权 + NOTICE'}.`;
  } else if (canonical === 'GPL-3.0') {
    summary = `GPL-3.0 — 任意使用, 但衍生作品必须开源 (copyleft).`;
  } else if (canonical === 'proprietary') {
    summary = `专有许可 — 仅作私人学习. 公开 / 商业 / 改编需作者许可.`;
  } else {
    summary = `未识别 (${raw == null ? '无 license 字段' : raw}) — 按最保守策略仅作私人学习.`;
  }

  return {
    license: canonical,
    raw,
    allowed_usage: {
      private_learn: perms.private_learn,
      public_lesson: perms.public_lesson,
      commercial: perms.commercial,
      modify: perms.modify,
    },
    attribution_required: perms.attribution_required,
    share_alike: perms.share_alike,
    summary,
    _author: author,
    _topic: topic,
  };
}

/**
 * Check whether a specific usage intent is allowed.
 *
 * @param {object} pack
 * @param {'private_learn'|'public_lesson'|'commercial'|'modify'} intent
 * @returns {{ allowed: bool, reason: string, license: string }}
 */
function checkUsage(pack, intent) {
  const validIntents = ['private_learn', 'public_lesson', 'commercial', 'modify'];
  if (!validIntents.includes(intent)) {
    return { allowed: false, reason: `Invalid intent "${intent}". Expected one of: ${validIntents.join(', ')}`, license: 'invalid' };
  }
  const parsed = parseLicense(pack);
  const allowed = parsed.allowed_usage[intent] === true;
  let reason;
  if (allowed) {
    reason = parsed.attribution_required && intent !== 'private_learn'
      ? `Allowed under ${parsed.license}; attribution required.`
      : `Allowed under ${parsed.license}.`;
    if (parsed.share_alike && intent === 'modify') {
      reason += ' Derivative work must use the same license.';
    }
  } else {
    const intentLabel = {
      private_learn: '私人学习',
      public_lesson: '公开发布课程',
      commercial: '商业用途',
      modify: '改编',
    }[intent];
    reason = `${parsed.license} 不允许 ${intentLabel}. ${parsed.summary}`;
  }
  return { allowed, reason, license: parsed.license };
}

/**
 * Format attribution string per pack metadata.
 *
 * Example: "Pack 柏拉图 by hypha-org, CC-BY 4.0"
 */
function formatAttribution(pack) {
  if (!pack) return 'Attribution unavailable.';
  const parsed = parseLicense(pack);
  const author = pack.author || pack.curator || 'Unknown author';
  const topic = pack.topic || pack.id || 'Untitled pack';
  if (parsed.license === 'CC0') {
    return `Pack "${topic}" by ${author} — CC0 (public domain).`;
  }
  if (parsed.license === 'unknown') {
    return `Pack "${topic}" by ${author} — license unspecified; private learning only.`;
  }
  return `Pack "${topic}" by ${author}, ${parsed.license}.`;
}

module.exports = {
  LICENSE_TYPES,
  LICENSE_PERMISSIONS,
  LICENSE_ALIASES,
  parseLicense,
  checkUsage,
  formatAttribution,
};
