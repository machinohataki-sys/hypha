'use strict';

// HYPHA · W8.4 Feedback Channel (BLUEPRINT §19.3)
//
// User can write back at any time. Submissions live in a tiny fs-backed JSON
// store under `vault/data/feedback/`. Each submission is a flat record:
//   { id, slug, type, content, attachments[], status, reward?, ts_created,
//     ts_reviewed?, reviewed_by? }
//
// Anti-promise contract (蓝图 §19.3 final line):
//   不代表 IP / 收益 / 分红权.
// Reward currency is non-cash: extra Deepen / Distillation slots / Radar runs
// / Pack generation quota / membership extension / Founding Contributor badge
// / Companion 特殊称号. No money flows back to user. Listed in REWARD_TYPES.
//
// Surfaces:
//   submitFeedback / listFeedback / getFeedback / markFeedbackAccepted /
//   getRewardHistory + ANTI_PROMISE_DISCLAIMER + FEEDBACK_TYPES + REWARD_TYPES.

const fs = require('node:fs');
const path = require('node:path');
const vault = require('../vault');

// -- enums ------------------------------------------------------------------

const FEEDBACK_TYPES = Object.freeze([
  'product_idea',
  'lesson_quality',
  'note_use',
  'companion_dialogue',
  'pack_structure',
  'exam_model',
  'bug',
  'uncomfortable_experience',
]);

// Reward currencies — non-cash, non-equity, non-revenue-share.
// Each reward emits a record under `vault/data/feedback/rewards/`.
const REWARD_TYPES = Object.freeze([
  'deepen_credit',          // extra Deepen calls
  'distillation_credit',    // book / longform distillation slot
  'radar_credit',           // Research Radar runs
  'pack_credit',            // Pack generation
  'membership_days',        // membership extension N days
  'founding_contributor',   // Founding Contributor badge (one-shot)
  'companion_title',        // Companion 特殊称号
]);

const FEEDBACK_STATUSES = Object.freeze([
  'pending',
  'triaged',
  'accepted',
  'declined',
  'duplicate',
]);

const ANTI_PROMISE_DISCLAIMER = [
  '反馈采纳奖励不代表 IP 共享权 / 收益分成 / 分红权 / 股权.',
  '奖励仅以非现金形式发放 (额度 / 会员天数 / 徽章 / 称号).',
  '我们保留是否采纳的最终决定权, 不构成任何回报承诺.',
].join('\n');

// -- io ---------------------------------------------------------------------

function _feedbackDir() {
  const root = vault.resolveRoot();
  const dir = path.join(root, 'data', 'feedback');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function _rewardsDir() {
  const dir = path.join(_feedbackDir(), 'rewards');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function _newId(prefix = 'fb') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

// -- validation -------------------------------------------------------------

function _assertType(type) {
  if (!FEEDBACK_TYPES.includes(type)) {
    throw new Error(`feedback.invalid_type: "${type}" not in [${FEEDBACK_TYPES.join(',')}]`);
  }
}

function _assertReward(rewardType) {
  if (!REWARD_TYPES.includes(rewardType)) {
    throw new Error(`feedback.invalid_reward: "${rewardType}" not in [${REWARD_TYPES.join(',')}]`);
  }
}

// -- core API ---------------------------------------------------------------

/**
 * @param {string} slug — course slug or 'global' if app-wide.
 * @param {{type: string, content: string, attachments?: Array<{name,path}>}} payload
 * @returns {{ok: boolean, id?: string, record?: object, error?: string}}
 */
function submitFeedback(slug, payload = {}) {
  try {
    const { type, content, attachments } = payload;
    _assertType(type);
    if (typeof content !== 'string' || content.trim().length < 2) {
      throw new Error('feedback.empty_content');
    }
    const id = _newId('fb');
    const ts = Date.now();
    const record = {
      id,
      slug: slug || 'global',
      type,
      content: content.trim(),
      attachments: Array.isArray(attachments) ? attachments.slice(0, 8) : [],
      status: 'pending',
      reward: null,
      ts_created: ts,
      ts_reviewed: null,
      reviewed_by: null,
    };
    const file = path.join(_feedbackDir(), `${ts}-${id}.json`);
    _safeWrite(file, record);
    return { ok: true, id, record };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * @param {object} [filter] — { type?, status?, slug? } AND-filter.
 * @returns {Array<object>} newest-first.
 */
function listFeedback(filter = {}) {
  const dir = _feedbackDir();
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => _readJson(path.join(dir, f)))
    .filter(Boolean);
  const out = entries.filter((r) => {
    if (filter.type && r.type !== filter.type) return false;
    if (filter.status && r.status !== filter.status) return false;
    if (filter.slug && r.slug !== filter.slug) return false;
    return true;
  });
  out.sort((a, b) => (b.ts_created || 0) - (a.ts_created || 0));
  return out;
}

function getFeedback(id) {
  if (!id) return null;
  const dir = _feedbackDir();
  if (!fs.existsSync(dir)) return null;
  const match = fs.readdirSync(dir).find((f) => f.endsWith(`-${id}.json`));
  if (!match) return null;
  return _readJson(path.join(dir, match));
}

/**
 * Mark a feedback as accepted and emit a reward record.
 * Returns { ok, record, reward } or { ok:false, error }.
 */
function markFeedbackAccepted(id, rewardType, rewardAmount = 1) {
  try {
    _assertReward(rewardType);
    const record = getFeedback(id);
    if (!record) throw new Error(`feedback.not_found:${id}`);
    if (record.status === 'accepted') {
      return { ok: true, record, reward: record.reward, already: true };
    }
    const ts = Date.now();
    const reward = {
      reward_id: _newId('rw'),
      feedback_id: id,
      type: rewardType,
      amount: Number.isFinite(rewardAmount) ? rewardAmount : 1,
      ts_granted: ts,
      // Founding badge is one-shot per user — `amount` ignored if badge.
      one_shot: rewardType === 'founding_contributor',
    };
    record.status = 'accepted';
    record.reward = reward;
    record.ts_reviewed = ts;
    record.reviewed_by = 'team';
    // Rewrite record
    const dir = _feedbackDir();
    const match = fs.readdirSync(dir).find((f) => f.endsWith(`-${id}.json`));
    if (!match) throw new Error('feedback.file_missing');
    _safeWrite(path.join(dir, match), record);
    // Append reward
    const rwFile = path.join(_rewardsDir(), `${ts}-${reward.reward_id}.json`);
    _safeWrite(rwFile, reward);
    return { ok: true, record, reward };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Cumulative reward history. `userId` is reserved for future multi-user vault;
 * the local vault has a single user, so all rewards are returned.
 */
function getRewardHistory(_userId) {
  const dir = _rewardsDir();
  if (!fs.existsSync(dir)) return { rewards: [], totals: {} };
  const rewards = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => _readJson(path.join(dir, f)))
    .filter(Boolean);
  rewards.sort((a, b) => (b.ts_granted || 0) - (a.ts_granted || 0));
  const totals = {};
  for (const r of rewards) {
    if (!r || !r.type) continue;
    totals[r.type] = (totals[r.type] || 0) + (Number.isFinite(r.amount) ? r.amount : 1);
  }
  return { rewards, totals };
}

module.exports = {
  // enums
  FEEDBACK_TYPES,
  REWARD_TYPES,
  FEEDBACK_STATUSES,
  ANTI_PROMISE_DISCLAIMER,
  // ops
  submitFeedback,
  listFeedback,
  getFeedback,
  markFeedbackAccepted,
  getRewardHistory,
};
