'use strict';

// HYPHA · W3.1 Creation Pool — schema definitions (BLUEPRINT §11.1-11.8)
//
// 4 ledger schemas + blueprint markdown skeleton + product-type enum +
// inspiration-pool row shape. Pure data, no fs / no LLM. Used by:
//   - creation-pool.js          (write blueprint + 4 ledger files on bind)
//   - creation-pool-ops.js      (validate addDecision / addAssumption rows)
//   - W3.2 Product Blueprint    (read BLUEPRINT_SCHEMA section list)
//   - W3.3 Product Transfer     (write inspiration-pool rows)
//   - W3.4 Product Spark        (read SPARK_LIFECYCLE for state machine)
//
// Boundary: this stream locks the FRAMEWORK (file shape + ledger row shape).
// W3.2 owns blueprint body editing UI; W3.4 owns the spark state machine.

// 10 product types — covers the BLUEPRINT §11.1 universe of "user 当前创造物".
// Adding a new type = additive change here + UI dropdown extension. Existing
// product directories never re-typed; if a user wants to convert, W3.3
// Product Transfer handles the migration as a fresh bind.
const PRODUCT_TYPES = Object.freeze([
  'product',         // SaaS / consumer / hardware — the canonical case
  'thesis',          // academic thesis / dissertation
  'novel',           // fiction / serialized writing
  'research',        // research program, not a single paper
  'website',         // marketing / personal / portfolio site
  'course',          // a course the user is BUILDING (distinct from learning)
  'personal_brand',  // ongoing identity work — Twitter / Substack / talks
  'opensource',      // OSS library / framework / tool
  'business',        // business plan / company / venture
  'exam_prep',       // long-arc preparation for a specific exam
]);

// Blueprint = markdown w/ YAML frontmatter + 10 section headers (per §11.1).
// This stream locks the FRAME ONLY; W3.2 owns the body editor + auto-fill of
// the 10 sections from lessons / notes / sparks. The frame is sufficient for
// W3.1 (round-trip via getProduct frontmatter; section headers as anchors).
const BLUEPRINT_SCHEMA = Object.freeze({
  frontmatter_fields: Object.freeze([
    'product_name',
    'product_type',
    'north_star',
    'bound_at',          // ISO ts
    'last_updated',      // ISO ts (refreshed by ops on every mutation)
    'slug',              // curriculum slug this product is bound to
    'version',           // bumps on schema migration
  ]),
  // 10 sections — matches BLUEPRINT §11.1 enumeration exactly. Order is
  // load-bearing: W3.2 UI renders sections in this order; auto-fill agents
  // (W2.1 transfer / W3.4 spark) target sections by index.
  sections: Object.freeze([
    { id: 'blueprint',        title: '产品蓝图',     description: '一句话 + 一段话 + 关键截图位' },
    { id: 'core_problem',     title: '核心问题',     description: '产品要解决的真实痛点' },
    { id: 'user_pain',        title: '用户痛点',     description: '具象场景 + 当前替代方案' },
    { id: 'north_star',       title: '北极星指标',   description: '单一可衡量的成功指标' },
    { id: 'design_principles', title: '设计原则',    description: '不可妥协的取舍' },
    { id: 'modules',          title: '功能模块',     description: '当前 + 路线图模块' },
    { id: 'hypotheses',       title: '未验证假设',   description: '指向 assumption-ledger.jsonl' },
    { id: 'inspirations',     title: '灵感池',       description: '指向 inspiration-pool.jsonl (lesson/note/pack)' },
    { id: 'risks',            title: '风险清单',     description: '已知威胁 + 缓解' },
    { id: 'roadmap',          title: '路线图',       description: '指向 roadmap-sync.json' },
  ]),
  version: 1,
});

// decision-log.jsonl — append-only ledger per BLUEPRINT §11.5. One row per
// product-level decision. Distinct from lesson-level events.jsonl: this is
// the user's decision archaeology, not the system's behavior log.
const DECISION_LOG_SCHEMA = Object.freeze({
  required_fields: Object.freeze([
    'id',                  // d-<unixMs>-<rand>
    'ts',                  // ISO
    'decision_text',       // short label ("ship beta to 5 users")
    'background',          // why it came up
    'basis',               // what evidence / lesson / spark / note backs it
    'opposing_views',      // counterarguments considered (string or [])
    'final_choice',        // what was chosen
    'follow_up_needed',    // [] of strings (action items)
  ]),
  optional_fields: Object.freeze([
    'linked_lesson_idx',
    'linked_note_rels',
    'linked_assumption_ids',
    'verdict_confidence',  // 0..1
  ]),
});

// assumption-ledger.jsonl — Lean Startup-style hypothesis tracker per §11.6.
// Distinguishes "we believe X" from "we verified X" — the LLM's weakest spot.
const ASSUMPTION_LEDGER_SCHEMA = Object.freeze({
  required_fields: Object.freeze([
    'id',                  // a-<unixMs>-<rand>
    'ts',                  // creation ts
    'assumption_text',     // "users will pay $49/mo for X"
    'status',              // see STATUSES
    'verification_method', // "5 user interviews" / "1 landing-page test"
    'deadline',            // ISO date (when status MUST flip)
  ]),
  optional_fields: Object.freeze([
    'status_updated_at',   // ISO ts of last status change
    'evidence_links',      // [{ kind, ref }] — lesson/note/url
    'linked_decision_ids',
    'confidence_pre',      // 0..1 belief BEFORE verification
    'confidence_post',     // 0..1 belief AFTER verification
  ]),
  statuses: Object.freeze(['unverified', 'verifying', 'verified', 'refuted']),
});

// kill-criteria.json — when to walk away. Per §11.7. Single file (not jsonl)
// because criteria are LIVE (current_value mutates on every evaluation).
// evaluateKillCriteria writes a snapshot to evaluation-log.jsonl for history.
const KILL_CRITERIA_SCHEMA = Object.freeze({
  shape: Object.freeze({
    criteria: 'array of criterion',
    last_evaluated: 'ISO ts or null',
    would_kill_now: 'bool — any criterion.would_kill is true',
  }),
  criterion_required_fields: Object.freeze([
    'id',                  // k-<unixMs>-<rand>
    'description',         // "if MAU < 50 by month 3"
    'threshold',           // { metric, op, value } e.g. { metric:'mau', op:'<', value:50 }
    'current_value',       // number | null
    'would_kill',          // bool — last evaluation result
  ]),
  criterion_optional_fields: Object.freeze([
    'created_at',
    'last_checked_at',
    'severity',            // 'soft' | 'hard'
    'notes',
  ]),
});

// roadmap-sync.json — weekly suggestions from the system (Companion agents +
// Quality Harness) + processed queue. Per §11.8. Not a heavy roadmap — that's
// in blueprint.md §10 sections. This file is the SYNC SURFACE between the
// pool and the rest of Hypha (Companion W3.5 reads + appends).
const ROADMAP_SYNC_SCHEMA = Object.freeze({
  shape: Object.freeze({
    weekly_suggestions: 'array of suggestion',
    processed: 'array of ids — IDs the user has actioned (accepted or rejected)',
    last_synced_at: 'ISO ts',
  }),
  suggestion_required_fields: Object.freeze([
    'id',                  // r-<unixMs>-<rand>
    'ts',
    'items',               // [{ kind, text, source }]
    'priority',            // 1 | 2 | 3 (1 = highest)
  ]),
  suggestion_optional_fields: Object.freeze([
    'source_agent',        // 'companion' | 'quality_harness' | 'manual'
    'expires_at',
    'action_taken',        // 'accepted' | 'rejected' | 'deferred' | null
    'action_taken_at',
  ]),
  priorities: Object.freeze([1, 2, 3]),
});

// inspiration-pool.jsonl — links lessons / notes / packs / book-sparks /
// research-reports back to the product. One row per link event. Renderer
// reads & groups by `source` prefix to populate blueprint.md §8 灵感池.
const INSPIRATION_POOL_SCHEMA = Object.freeze({
  required_fields: Object.freeze([
    'ts',
    'source',              // 'lesson:N' | 'note:<rel>' | 'pack:<id>' | 'book:<id>' | 'research:<id>'
    'relevance',           // 0..1 user-supplied or auto
    'source_summary',      // 1-2 lines for de-referencing without re-reading source
  ]),
  optional_fields: Object.freeze([
    'tags',
    'linked_module_id',
    'linked_section_id',   // blueprint section it inspires (e.g. 'core_problem')
    'pinned',
  ]),
  // Valid source prefixes — used by linkers to enforce shape.
  source_prefixes: Object.freeze(['lesson:', 'note:', 'pack:', 'book:', 'research:']),
});

// W3.4 lifecycle states — exposed so this stream can validate sparks/*.md
// frontmatter when it round-trips through getProduct.spark_count. Owner of
// the state machine + transitions is W3.4.
const SPARK_LIFECYCLE = Object.freeze({
  states: Object.freeze(['captured', 'incubating', 'tested', 'promoted', 'discarded']),
  // Round-trip terminator: anything in captured/incubating/tested counts as
  // "live"; promoted = absorbed into blueprint; discarded = dead but kept.
  live_states: Object.freeze(['captured', 'incubating', 'tested']),
});

// File layout reference — single source of truth for relative paths under
// vault/<slug>/product/. Used by creation-pool.js + ops + the spec.
const PRODUCT_LAYOUT = Object.freeze({
  root_dir: 'product',
  blueprint: 'product/blueprint.md',
  decision_log: 'product/decision-log.jsonl',
  assumption_ledger: 'product/assumption-ledger.jsonl',
  kill_criteria: 'product/kill-criteria.json',
  roadmap_sync: 'product/roadmap-sync.json',
  inspiration_pool: 'product/inspiration-pool.jsonl',
  sparks_dir: 'product/sparks',                          // W3.4 owns body
  evaluation_log: 'product/evaluation-log.jsonl',        // kill-criteria history
});

module.exports = {
  PRODUCT_TYPES,
  BLUEPRINT_SCHEMA,
  DECISION_LOG_SCHEMA,
  ASSUMPTION_LEDGER_SCHEMA,
  KILL_CRITERIA_SCHEMA,
  ROADMAP_SYNC_SCHEMA,
  INSPIRATION_POOL_SCHEMA,
  SPARK_LIFECYCLE,
  PRODUCT_LAYOUT,
};
