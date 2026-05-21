# W8.4 — Feedback Channel + Donate + Cashflow Shield + Cost Budget Engine

> Status: theory-ship (v0.1, 2026-05-13).
> Source of truth: BLUEPRINT §19 (commercial structure) + §17.3 (cashflow
> shield) + ROADMAP v2.4. Cross-cuts with W5.1 cheap-router and W8.1
> anti-promise scanner.

## Why this exists

Hypha cannot survive on "unlimited AI for ¥9.9 / month." That is the
business model of a venture-funded loss leader, not a sustainable
cognitive instrument. The W8.4 stream encodes four discipline mechanisms
that must coexist for Hypha to ship without burning the team or the
users out:

1. **Slightly higher membership price** (BLUEPRINT §19.1) — `pricing v3`
   Founders Path E. The Pro tier sits at ¥99 → ¥69 loyalty floor. We do
   not subsidize user A's expensive calls with user B's silent quota.
2. **Voluntary Donate** (BLUEPRINT §19.2) — for users who want to
   accelerate the project beyond their membership. Non-financial perks
   only.
3. **Feedback Channel** (BLUEPRINT §19.3) — bidirectional, with
   non-cash rewards for accepted contributions.
4. **Cashflow Shield + Cost Budget Engine** (BLUEPRINT §17.3) —
   enforces (1) at the technical layer. A runaway loop cannot silently
   torch a month of revenue.

The four mechanisms together encode the founding pact: **we sell
goal-directed learning progress, not unlimited model calls.**

## 1. Feedback Channel — 8 types × 7 reward currencies

### Submission types (8, per BLUEPRINT §19.3)

| Enum | Display (zh) | Example |
|---|---|---|
| `product_idea` | 产品建议 | "把 atlas 整合进 Lesson tail" |
| `lesson_quality` | Lesson 质量 | "lesson-3 出现 3 连定义" |
| `note_use` | Note 使用 | "wikilink 双击 → 起新 lesson 的快捷键缺失" |
| `companion_dialogue` | Companion 台词 | "菌类星人句末 emoji 不像其他句子" |
| `pack_structure` | Pack 结构 | "Plato pack 没有 prereq edges" |
| `exam_model` | Exam 模型 | "考研英语 cloze 模拟错位" |
| `bug` | Bug | "lesson 加载白屏" |
| `uncomfortable_experience` | 不舒服体验 | "弹窗节奏过快" |

### Reward currencies (7, all non-cash)

| Enum | Currency | Notes |
|---|---|---|
| `deepen_credit` | 深化次数 | 1 credit = 1 extra Deepen call |
| `distillation_credit` | 长文蒸馏额度 | 1 credit = 1 book-spark distillation slot |
| `radar_credit` | Research Radar 次数 | 1 = 1 radar run |
| `pack_credit` | Pack 生成额度 | 1 = 1 pack |
| `membership_days` | 会员天数 | typically 7 / 14 / 30 |
| `founding_contributor` | Founding Contributor 徽章 | one-shot per user |
| `companion_title` | Companion 特殊称号 | cosmetic only |

### Anti-promise contract (hard)

The trailing line in §19.3:

> 不代表 IP / 收益 / 分红权.

surfaces in `ANTI_PROMISE_DISCLAIMER` on every feedback submission UI.
Reward grant records inherit this disclaimer verbatim so we can prove
what the user saw at grant-time even if the disclaimer copy evolves.

### File layout

```
vault/data/feedback/
  ├── <ts>-<id>.json         (one per submission)
  └── rewards/
      └── <ts>-<reward_id>.json
```

Submission record shape (flat JSON):

```
{ id, slug, type, content, attachments[], status, reward?, ts_created,
  ts_reviewed?, reviewed_by? }
```

`status` ∈ { pending, triaged, accepted, declined, duplicate }.

## 2. Donate — 4-tier ladder, non-cash perks only

### Tier ladder (BLUEPRINT §19.2, monotone ascending)

| Tier | Amount (¥) | Perks added (cumulative) |
|---|---|---|
| `supporter` | 50 | 创始支持者徽章 |
| `early_believer` | 200 | + 菌类星人特殊称号 / + 新功能优先体验 |
| `patron` | 500 | + 支持者墙留名 / + 额外模型额度 / + 额外长文蒸馏次数 |
| `sustainer` | 1000 | + 反馈优先处理 / + Companion 私人称号定制 |

Each tier inherits the previous tier's perks.

### Legal text (frozen string, surfaced in every donate UI)

```
关于 Donate (蓝图 §19.2):

• 自愿支持, 不构成投资.
• 不承诺任何形式的现金回报.
• 不参与分红, 不获得股权.
• 回馈仅以非现金形式发放: 徽章 / 称号 / 支持者墙留名 / 优先体验 /
  模型额度 / 长文蒸馏额度 / 反馈优先处理.
• Hypha 团队保留是否接受 / 退还 / 调整回馈的最终决定权.

若你期待金融回报, 请勿赞助; 这是为相信项目并愿意推动其更长寿命的人
准备的通道.
```

### Anti-promise verification

`donate.verifyAntiPromise(content)` is called on any user-authored copy
before it is surfaced in donate flows. It first attempts to delegate to
W8.1 `anti-slop/anti-promise.scan()`; if W8.1 is not present, the local
`FORBIDDEN_PROMISE_TERMS` list is used. Forbidden terms include:

- 投资回报 / 现金回报 / 分红 / 股权 / 股份 / 收益分成
- 保证收益 / 稳赚 / 回本 / 净赚 / 盈利保证
- (English mirrors) roi / guaranteed return / profit share /
  equity share / dividend

The scanner returns `{ clean: bool, hits: [], reason }` — callers refuse
to display copy with `clean: false`.

### Payment-rails

`recordDonation()` creates an intent ledger entry with
`status: 'pending_payment'`. The Stripe / WeChat Pay confirmation
roundtrip is owned by the regulated payment-rails work-stream, not by
W8.4. The ledger is auditable on its own.

## 3. Cost Budget Engine — per-lesson capability caps

### Tier × Capability cap table (`LESSON_COST_BUDGET`)

| Tier | T6_STRONG | T4_JUDGE | T3_MID | T2_LOCAL | T1_EMBED |
|---|---:|---:|---:|---:|---:|
| **Pro** | 4 | 8 | 16 | ∞ | ∞ |
| **Founders** | 8 | 16 | 32 | ∞ | ∞ |
| **BYOK** | ∞ | ∞ | ∞ | ∞ | ∞ |

Caps are **per-lesson**, not per-session. A lesson with 4 T6 calls
already on the books returns `wouldExceedBudget=true` on the 5th
attempt under Pro.

T2_LOCAL (Gemma) and T1_EMBED (BGE-M3) are unlimited because they run
on the user's machine. BYOK is unlimited at the platform level because
the user pays the upstream provider directly; we still log usage for
telemetry, but never block.

### Approx ¥ per 1k tokens (overshoots upstream, intentional)

```
T6_STRONG : ¥0.025
T4_JUDGE  : ¥0.008
T3_MID    : ¥0.004
T2_LOCAL  : 0
T1_EMBED  : 0
```

These deliberately overshoot real provider rates by ~10-20%. Reason:
the cashflow shield should trip *before* surprise charges, not after.

### Files written

```
vault/<slug>/cost-log.jsonl       (append-only call log)
vault/<slug>/cost-budget.json     (per-lesson running counters)
```

`cost-log.jsonl` rows:

```
{ ts, slug, lessonIdx, capability, input_tokens, output_tokens, cost_cny }
```

## 4. Cashflow Shield — daily ¥ ceiling

### Tier ceiling (`MAX_DAILY_COST_CNY`)

| Tier | Ceiling |
|---|---:|
| Pro | ¥5 / day |
| Founders | ¥10 / day |
| BYOK | ¥999 / day (effectively unlimited; tracked) |

### Soft warning

When daily spend ≥ 80% of the tier ceiling, `notifyExceedSoft()` emits a
one-shot warning per day (idempotent — `soft_warn_emitted` flag in the
state file). The UI renders this as an editorial line in `screen-cost-
budget.jsx`, not a toast.

### Anti-runaway

The shield exists specifically to defend against:

- **User misclick rapid-fire** — `[Send]` button mashed during a UI
  delay loops 5 T6 calls in a second.
- **Agent infinite retry** — a malformed message loop in an agent
  pipeline that re-tries the same prompt 30× under network jitter.
- **System bug** — a broken provider health check that re-pings every
  10 ms with full payloads.

In all three cases, the per-lesson cap might be respected by accident
(only one lesson is in the loop), but the daily ¥ ceiling will trip
within seconds and stop the bleed.

### File layout

```
vault/data/shield/daily/<userId>-<YYYY-MM-DD>.json
```

Shape:

```
{ user_id, day, total_cost_cny, soft_warn_emitted, last_call_ts }
```

State auto-resets on date rollover (`recordCharge()` detects
`state.day !== today` and zeroes the counters).

## 5. Integration points

### W5.1 cheap-router

Before W5.1's `_routeCheapFirst` fires, the W8.4 pre-call gate
(`_w84PreCallGate` in `router.js`) runs. Caller passes `{ userId, tier,
slug, lessonIdx, estimated_cost_cny }` on the `chatArgs` envelope and
the shield + budget gates both have a chance to throw
`BudgetExceededError` *before* a single token leaves the machine.

The hook is **opt-in**: callers that omit `chatArgs.userId` skip the
gate entirely, preserving the existing `executeChat` ABI. This lets
W5.1 / W8.x stream callers migrate over time without a flag day.

When the gate trips, the cheap-router never sees the call; the cheap
path is also skipped. `BudgetExceededError` surfaces to the IPC layer,
which the UI turns into a non-leak structured toast (just `code` +
`details.reason`).

### W8.1 anti-promise

`donate.verifyAntiPromise(content)` and `feedback.submitFeedback()`
both lean on the W8.1 scanner (`require('../anti-slop/anti-promise')`)
when present; the lazy require + fall-through to a local term list
keeps W8.4 shippable before W8.1 lands.

### Pricing v3 (memory `pricing_qualification_loyalty`)

Founders Path E (¥499 one-time + ¥99 → ¥69 floor) shows up in W8.4 via
the tier names `Founders` and `Pro` used in `LESSON_COST_BUDGET` and
`MAX_DAILY_COST_CNY`. Founders' daily ¥ ceiling is doubled and the
per-lesson cap on T6/T4/T3 also doubled — the loyalty curve is
expressed as runtime headroom, not just a discount.

## 6. IPC surface (`app/main.js`)

```
feedback:submit / list / get / accept / rewards / types
donate:tiers / record / legal / list / antiPromise
cost:budget / record / remaining / wouldExceed / report
shield:check / enforce / notifySoft
```

All handlers wrap in `_w84Err` to return `{ ok:false, error, code }` on
failure — same envelope contract used by `crossspark:*` /
`judgmentgym:*`.

## 7. Renderer surface (`app/preload.js`)

```
window.ptor.feedback = { submit, list, get, accept, rewards, types }
window.ptor.donate   = { tiers, record, legal, list, antiPromise }
window.ptor.cost     = { budget, record, remaining, wouldExceed, report }
window.ptor.shield   = { check, enforce, notifySoft }
```

## 8. UI screens

- `app/design/screen-feedback.jsx` (route `feedback`)
- `app/design/screen-donate.jsx` (route `donate`)
- `app/design/screen-cost-budget.jsx` (route `cost-budget`)

All three live within the manuscript register: EB Garamond italic on
labels, Noto Serif SC for body, brass hairlines, no progress-bar
pageantry. Cost overshoot in `cost-budget` is signalled by terracotta
type, not by red bar.

## 9. Out of scope for W8.4

- Real Stripe / WeChat Pay integration (intentional-placeholder).
- Multi-user vault (rewards.userId is reserved for future use).
- Cost prediction model (the gate uses post-hoc `cost_cny`; a
  pre-call prediction loop belongs to a later W8.x).
- Founders-curve loyalty pricing engine (lives in pricing-engine, not
  here).

## 10. Verification matrix

1. `node --check` on all 4 lib files + `router.js` + `main.js`.
2. JSX brace balance on all 3 screen files + `app.jsx`.
3. Module load smoke: `require('./feedback')` /
   `require('./donate')` / `require('./cost-budget')` /
   `require('./shield')`.
4. `submitFeedback` → `markFeedbackAccepted` round-trip records a
   reward.
5. `recordDonation` returns `status: 'pending_payment'` + the legal
   text contains "不构成投资".
6. `recordLLMCall` → `getRemainingBudget` returns decremented counter.
7. `checkCashflowShield('userX', 'BYOK')` always returns `ok: true`;
   under Pro after `recordCharge(¥6)` returns `ok: false`.
8. `verifyAntiPromise('保证收益')` returns `clean: false` with hit.
