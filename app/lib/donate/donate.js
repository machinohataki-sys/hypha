'use strict';

// HYPHA · W8.4 Donate (BLUEPRINT §19.2)
//
// Donation is **voluntary support**, NOT investment.
// Hard contract — these strings must appear in user-facing donate copy:
//   - 不构成投资
//   - 不承诺现金回报
//   - 不参与分红
//
// Non-financial perks ladder (4 tiers, monotone ascending):
//   supporter / early_believer / patron / sustainer
//
// Stripe / WeChat Pay integration is intentionally deferred per W8.4
// scope (intentional-placeholder: payment-rails belong to a separate
// regulated-payments work-stream, not this ledger). This module records
// the intent + perks resolution; `recordDonation()` is the source-of-
// truth log and the only contract downstream payment adapters must honor.
//
// Anti-promise validator (`verifyAntiPromise`) cross-checks any copy
// authored for donate flows against forbidden financial terms. Reuses
// W8.1 anti-promise scan if available, else a built-in micro-scanner.

const fs = require('node:fs');
const path = require('node:path');
const vault = require('../vault');

// -- amount floor + perk thresholds -----------------------------------------
//
// 2026-05-13 — 4-tier SaaS-style price ladder removed. Donations are now
// freeform (¥0.1 floor + user-typed amount). DONATE_TIERS retained ONLY as
// perk-threshold knowledge — the highest tier whose `amount_cny` ≤ donation
// is matched, and its perks granted. Below the lowest tier ("just thanks"),
// no perks attach; the gift itself is the act. Manuscript register: gifts,
// not subscriptions.

const MIN_DONATION_CNY = 0.1;

const DONATE_TIERS = Object.freeze([
  {
    tier_name: 'just_thanks',
    display_zh: '一声谢',
    amount_cny: MIN_DONATION_CNY,
    perks: [],
  },
  {
    tier_name: 'supporter',
    display_zh: '支持者',
    amount_cny: 50,
    perks: ['创始支持者徽章'],
  },
  {
    tier_name: 'early_believer',
    display_zh: '早期信仰者',
    amount_cny: 200,
    perks: [
      '创始支持者徽章',
      '菌类星人特殊称号',
      '新功能优先体验',
    ],
  },
  {
    tier_name: 'patron',
    display_zh: '赞助者',
    amount_cny: 500,
    perks: [
      '创始支持者徽章',
      '菌类星人特殊称号',
      '新功能优先体验',
      '支持者墙留名',
      '额外模型额度',
      '额外长文蒸馏次数',
    ],
  },
  {
    tier_name: 'sustainer',
    display_zh: '长期共建者',
    amount_cny: 1000,
    perks: [
      '创始支持者徽章',
      '菌类星人特殊称号',
      '新功能优先体验',
      '支持者墙留名',
      '额外模型额度',
      '额外长文蒸馏次数',
      '反馈优先处理',
      'Companion 私人称号定制',
    ],
  },
]);

function _resolvePerksByAmount(amount) {
  if (!Number.isFinite(amount) || amount < MIN_DONATION_CNY) return null;
  let matched = null;
  for (const t of DONATE_TIERS) {
    if (amount >= t.amount_cny) matched = t;
  }
  return matched;
}

const LEGAL_TEXT = [
  '关于 Donate (蓝图 §19.2):',
  '',
  '• 自愿支持, 不构成投资.',
  '• 不承诺任何形式的现金回报.',
  '• 不参与分红, 不获得股权.',
  '• 回馈仅以非现金形式发放: 徽章 / 称号 / 支持者墙留名 / 优先体验 / 模型额度 / 长文蒸馏额度 / 反馈优先处理.',
  '• Hypha 团队保留是否接受 / 退还 / 调整回馈的最终决定权.',
  '',
  '若你期待金融回报, 请勿赞助; 这是为相信项目并愿意推动其更长寿命的人准备的通道.',
].join('\n');

// Forbidden phrases inside donate / feedback copy. If any of these surface
// in user-facing text we refuse the copy and ask the author to rephrase.
const FORBIDDEN_PROMISE_TERMS = Object.freeze([
  '投资回报', '现金回报', '分红', '股权', '股份', '收益分成',
  '保证收益', '稳赚', '回本', '净赚', '盈利保证',
  // English mirrors (we use mixed-language UI for niche features)
  'roi', 'guaranteed return', 'profit share', 'equity share', 'dividend',
]);

// -- io ---------------------------------------------------------------------

function _donateDir() {
  const root = vault.resolveRoot();
  const dir = path.join(root, 'data', 'donate');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function _newId() {
  return `dn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function _safeWrite(filePath, obj) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function _readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { return null; }
}

// -- core API ---------------------------------------------------------------

function getDonateTiers() {
  return DONATE_TIERS.map((t) => ({ ...t, perks: t.perks.slice() }));
}

function getDonateLegalText() {
  return LEGAL_TEXT;
}

function _resolveTier(tierName) {
  return DONATE_TIERS.find((t) => t.tier_name === tierName) || null;
}

/**
 * Record a donation intent. `paymentRef` is the upstream Stripe/WeChat
 * reference once integrated; for now it's left as `null` and the entry
 * stays in 'pending_payment' status.
 *
 * Amount drives the perk-grant — the highest tier whose `amount_cny` ≤
 * `amount` is matched. `tierHint` is optional and only used to disambiguate
 * the displayed label when the amount exactly straddles a threshold (else
 * ignored — manuscript register: gifts, not subscriptions).
 *
 * @param {string} userId
 * @param {number} amount
 * @param {string} [tierHint]
 * @returns {{ok: boolean, id?: string, record?: object, error?: string}}
 */
function recordDonation(userId, amount, tierHint) {
  try {
    if (!userId) throw new Error('donate.missing_user_id');
    if (!Number.isFinite(amount) || amount < MIN_DONATION_CNY) {
      throw new Error(`donate.amount_below_floor:${amount}<${MIN_DONATION_CNY}`);
    }
    const matched = _resolvePerksByAmount(amount);
    if (!matched) throw new Error('donate.no_perk_threshold_matched');
    const id = _newId();
    const ts = Date.now();
    const record = {
      id,
      user_id: userId,
      tier: matched.tier_name,
      tier_display_zh: matched.display_zh,
      tier_hint: tierHint || null,
      amount_cny: amount,
      perks_granted: matched.perks.slice(),
      status: 'pending_payment', // becomes 'completed' once payment confirmed
      // intentional-placeholder: payment_ref is the upstream Stripe / WeChat
      // Pay reference id, populated by the payment-rails adapter on confirm.
      // Kept null at intent-time so this ledger is auditable on its own.
      payment_ref: null,
      ts_created: ts,
      ts_confirmed: null,
      // Hard-coded legal stance — recorded with the donation so we can
      // prove what the user saw at donate-time even if LEGAL_TEXT evolves.
      legal_acknowledged: LEGAL_TEXT,
    };
    const file = path.join(_donateDir(), `${ts}-${id}.json`);
    _safeWrite(file, record);
    return { ok: true, id, record };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function listDonations(filter = {}) {
  const dir = _donateDir();
  if (!fs.existsSync(dir)) return [];
  const out = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => _readJson(path.join(dir, f)))
    .filter(Boolean)
    .filter((r) => !filter.userId || r.user_id === filter.userId)
    .filter((r) => !filter.tier || r.tier === filter.tier);
  out.sort((a, b) => (b.ts_created || 0) - (a.ts_created || 0));
  return out;
}

/**
 * Scan donate / feedback copy for forbidden financial-return promises.
 * Delegates to W8.1 anti-promise scanner if it exists; otherwise uses
 * the local FORBIDDEN_PROMISE_TERMS list.
 *
 * @param {string} content
 * @returns {{clean: boolean, hits: Array<string>, reason?: string}}
 */
function verifyAntiPromise(content) {
  if (!content || typeof content !== 'string') {
    return { clean: true, hits: [] };
  }
  // Try W8.1 anti-promise scanner. Defensive — module may not exist yet.
  try {
    // eslint-disable-next-line global-require
    const w81 = require('../anti-slop/anti-promise');
    if (w81 && typeof w81.scan === 'function') {
      const res = w81.scan(content);
      if (res && Array.isArray(res.hits)) {
        return { clean: res.hits.length === 0, hits: res.hits, source: 'w8.1' };
      }
    }
  } catch (_) {
    // fall through to local scanner
  }
  const lower = content.toLowerCase();
  const hits = FORBIDDEN_PROMISE_TERMS.filter((term) => lower.includes(term.toLowerCase()));
  return {
    clean: hits.length === 0,
    hits,
    source: 'local',
    reason: hits.length === 0
      ? null
      : `donate / feedback 文案禁用财务回报承诺词: ${hits.join(', ')}.`,
  };
}

module.exports = {
  DONATE_TIERS,
  MIN_DONATION_CNY,
  LEGAL_TEXT,
  FORBIDDEN_PROMISE_TERMS,
  getDonateTiers,
  getDonateLegalText,
  recordDonation,
  listDonations,
  verifyAntiPromise,
};
