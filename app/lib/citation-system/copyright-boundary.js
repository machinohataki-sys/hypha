'use strict';

// HYPHA · W7.3 Citation System · copyright-boundary (BLUEPRINT §12.7)
//
// Rule-based risk assessment: given a piece of content + its citation +
// the user's INTENT, return one of { low / medium / high / block }.
//
// Blueprint principles (§12.7):
//   - 索引结构可以       → low
//   - 短摘要可以         → low (≤ 200 chars per citation)
//   - 长引文 (>500 字)   → medium
//   - 全章节复制         → high
//   - 替代付费内容       → block
//
// Reuses W6.5 commons/license-layer for the underlying license matrix
// (CC-BY-NC / proprietary / etc. mapping to allowed intents). This
// module ADDS the content-length × intent dimension on top.

const license = require('../commons/license-layer');

const RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'block']);
const INTENTS = Object.freeze(['private_learn', 'public_lesson', 'commercial', 'commons_share']);

const CHAR_LIMITS = Object.freeze({
  short_snippet: 200,
  medium_quote:  500,
  long_quote:    1500,
  // > long_quote → "full chapter" tier.
});

/**
 * Assess copyright risk for using `content` (a citation's text payload)
 * under a given `intent`. `citation` provides the underlying source
 * (mostly type + attribution; when it's a Pack we reuse W6.5 license).
 *
 * @param {object} args
 * @param {string} args.content   the actual text being used
 * @param {object} args.citation  shape from citation.createCitation
 * @param {'private_learn'|'public_lesson'|'commercial'|'commons_share'} args.intent
 * @returns {{ risk_level:string, reason:string, alternative_suggested:string|null, license_check?:object }}
 */
function assessCopyrightRisk(args) {
  const a = args || {};
  const content = String(a.content || '');
  const citation = a.citation || {};
  const intent = INTENTS.includes(a.intent) ? a.intent : 'private_learn';
  const len = content.length;

  // 1. Length-based base tier — independent of license.
  let lenTier;
  if (len <= CHAR_LIMITS.short_snippet) lenTier = 'low';
  else if (len <= CHAR_LIMITS.medium_quote) lenTier = 'low';
  else if (len <= CHAR_LIMITS.long_quote) lenTier = 'medium';
  else lenTier = 'high'; // full-chapter sized excerpt

  // 2. Internal types (lesson / note / spark) — user's own material; no
  //    third-party copyright exposure. Always low regardless of length.
  const internalTypes = new Set(['lesson', 'note', 'spark']);
  if (internalTypes.has(citation.type)) {
    return {
      risk_level: 'low',
      reason: `Internal ${citation.type} — user-owned material, no third-party copyright surface.`,
      alternative_suggested: null,
    };
  }

  // 3. Pack citation — defer license matrix to W6.5.
  let licenseCheck = null;
  if (citation.type === 'pack' && a.pack) {
    // intent vocab differs slightly (commons_share isn't a W6.5 intent).
    const intentMap = {
      private_learn: 'private_learn',
      public_lesson: 'public_lesson',
      commercial:    'commercial',
      commons_share: 'modify',
    };
    licenseCheck = license.checkUsage(a.pack, intentMap[intent]);
    if (!licenseCheck.allowed) {
      return {
        risk_level: 'block',
        reason: `License "${licenseCheck.license}" blocks ${intent}: ${licenseCheck.reason}`,
        alternative_suggested: _alternativeFor(citation, intent, 'license'),
        license_check: licenseCheck,
      };
    }
  }

  // 4. Replacement-for-paid-content heuristic — if the user is doing
  //    `public_lesson` or `commercial` AND the citation is a full chapter
  //    of a published book/paper, block.
  if (citation.type === 'book' && lenTier === 'high' && (intent === 'public_lesson' || intent === 'commercial')) {
    return {
      risk_level: 'block',
      reason: `公开发布完整章节相当于替代原书；版权所有者很可能主张侵权。改用结构索引 + 短引文 + 自己解读。`,
      alternative_suggested: '只引 200 字以内核心段落 + 自写 mechanism + 链回原书购买入口',
      license_check: licenseCheck,
    };
  }
  if (citation.type === 'paper' && lenTier === 'high' && intent === 'commercial') {
    return {
      risk_level: 'block',
      reason: `商业再发布学术论文全文超出 fair-use 范围。`,
      alternative_suggested: '引用 abstract + 1-2 段关键 method + DOI 链回',
      license_check: licenseCheck,
    };
  }

  // 5. Web URL with commercial intent + long quote — high risk.
  if (citation.type === 'web_url' && lenTier === 'high' && intent === 'commercial') {
    return {
      risk_level: 'high',
      reason: `Commercial use of >1500-char web excerpt exceeds typical fair-use; consult source license.`,
      alternative_suggested: '改为短引文 + 链接，或先取得作者许可',
      license_check: licenseCheck,
    };
  }

  // 6. Intent gradient — medium quotes for public_lesson are OK with
  //    attribution; medium quotes for commercial bump one tier.
  let finalTier = lenTier;
  if (intent === 'commercial' && lenTier === 'medium') finalTier = 'high';
  if (intent === 'public_lesson' && lenTier === 'medium') finalTier = 'medium';
  if (intent === 'private_learn') {
    // Private learning is most permissive — high → medium, block stays block.
    if (finalTier === 'high') finalTier = 'medium';
  }

  return {
    risk_level: finalTier,
    reason: _reasonFor(finalTier, len, citation.type, intent),
    alternative_suggested: finalTier === 'low' ? null : _alternativeFor(citation, intent, 'length'),
    license_check: licenseCheck,
  };
}

function _reasonFor(tier, len, type, intent) {
  const intentLabel = {
    private_learn: '私人学习',
    public_lesson: '公开课程',
    commercial:    '商业用途',
    commons_share: 'Commons 分享',
  }[intent] || intent;
  if (tier === 'low') return `${len} 字 ${type} 引用用于${intentLabel} — 短摘要 + 署名即可，风险低。`;
  if (tier === 'medium') return `${len} 字 ${type} 引用用于${intentLabel} — 中等长度，需署名 + 链回原文。`;
  if (tier === 'high') return `${len} 字 ${type} 引用用于${intentLabel} — 接近替代原文，考虑改写或裁短。`;
  return `${len} 字 ${type} 引用用于${intentLabel} — 越过 fair-use 边界。`;
}

function _alternativeFor(citation, intent, cause) {
  const t = citation.type || 'web_url';
  if (cause === 'license') {
    if (intent === 'commercial') return '寻找 CC-BY / CC0 同主题 pack，或联系作者商业授权';
    if (intent === 'public_lesson') return '换成 NC-clean pack 或自行 paraphrase 后引用';
    return '改为 private-learn-only 使用';
  }
  if (t === 'book') return '改用结构索引 + 短摘要 (≤200 字) + 自写 mechanism';
  if (t === 'paper') return '引用 abstract + DOI 链接';
  if (t === 'web_url') return '改为 1-2 句引文 + 永久链接';
  return '改为短引文 + 链接';
}

/**
 * 1-sentence plain-Chinese warning per risk level. UI surface.
 */
function getBoundaryWarning(risk) {
  if (!risk || typeof risk !== 'object') return '';
  switch (risk.risk_level) {
    case 'low':    return '';
    case 'medium': return `提示: ${risk.reason}`;
    case 'high':   return `⚠ 高风险: ${risk.reason}${risk.alternative_suggested ? ` 建议: ${risk.alternative_suggested}` : ''}`;
    case 'block':  return `⛔ 不可使用: ${risk.reason}${risk.alternative_suggested ? ` 替代: ${risk.alternative_suggested}` : ''}`;
    default:       return '';
  }
}

module.exports = {
  RISK_LEVELS,
  INTENTS,
  CHAR_LIMITS,
  assessCopyrightRisk,
  getBoundaryWarning,
};
