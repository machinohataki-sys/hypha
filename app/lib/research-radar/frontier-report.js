'use strict';

// HYPHA · W6.3 Research Radar — Frontier Report schema + synthesis (BLUEPRINT §15)
//
// A Frontier Report is the compiled output of one radar cycle for one topic.
// It is the artifact that gets:
//   - written to vault/<slug>/research-radar/reports/<topic>/<date>.json
//   - mirrored to a webnote raw layer node (auto-actions.storeAsNote)
//   - cited inside lesson body generation (auto-actions.lessonCitationHook)
//   - potentially seeded as Product Sparks (auto-actions.triggerProductSparkCandidate)
//
// Synthesis goes through T6_STRONG (mocked here; production wires the
// capability-class router at app/lib/llm/router.js executeChat). Mock is
// deterministic so the test smoke can verify field-shape end-to-end.
//
// Surface contract (locked):
//   RFR_SCHEMA              — descriptive schema constants
//   generateReport(items, goalContract, ctx)   → Promise<RFR-shaped object>
//   formatReportMarkdown(report)               → string (千金 register md)
//   validateReport(report)                     → { ok, error? }

// =====================================================================
// Schema (descriptive — used by callers + UI to know which fields exist)
// =====================================================================

const RFR_SCHEMA = Object.freeze({
  topic: 'string (required)',
  date: 'YYYY-MM-DD string (required)',
  slug: 'string (curriculum slug, set by radar.js after synth)',
  generated_at: 'ISO 8601 timestamp (set by radar.js)',
  items: 'Array<{ source, title, url, summary_short, relevance_to_goal, potential_implication, published_at? }>',
  synthesis_paragraph: 'string (≤ 600 chars; what changed this cycle, scholar register)',
  action_items: 'Array<{ verb, detail, ties_to_lesson? }>',
  product_spark_candidates: 'Array<{ title, core_transfer, related_product?, risk? }>',
});

// =====================================================================
// Item enrichment — pure, deterministic
// =====================================================================

function _shortenSummary(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= 280) return t;
  return t.slice(0, 277) + '…';
}

function _enrichItem(raw, goalContract) {
  // Add relevance_to_goal + potential_implication fields. In production,
  // these come from the T6_STRONG synth pass; mock derives them from the
  // goal contract north_star so the report stays grounded against the
  // user's actual learning aim (per blueprint anti-feed principle).
  const goal = String((goalContract && goalContract.north_star) || (goalContract && goalContract.topic) || '').trim();
  const titleSlice = String(raw.title || '').slice(0, 90);
  return {
    source: raw.source || 'unknown',
    title: titleSlice,
    url: raw.url || '',
    summary_short: _shortenSummary(raw.summary_short || ''),
    relevance_to_goal: goal
      ? `Touches "${goal}" through ${raw.source || 'source'}.`
      : `Topic-level relevance only (no goal contract loaded).`,
    potential_implication: _deriveImplication(raw, goalContract),
    published_at: raw.published_at || '',
  };
}

function _deriveImplication(raw, goalContract) {
  // Implication is a single editorial sentence tying the item to something
  // the user can do — never a fan-out of bullet points (the blueprint bans
  // "资讯流" feel). Mock register matches the 千金 manuscript voice.
  const mainCreation = String((goalContract && goalContract.main_creation) || '').trim();
  const titleSlice = String(raw.title || '').slice(0, 70);
  if (mainCreation) {
    return `Read against ${mainCreation}: the ${raw.source || 'item'} reframes one assumption you might be making.`;
  }
  if (titleSlice) {
    return `Worth a 5-minute pass to test whether your current frame anticipates it.`;
  }
  return `Skim only — keep your hands on the lesson, return if a real friction surfaces.`;
}

// =====================================================================
// Synthesis paragraph — mock T6_STRONG. Deterministic.
// =====================================================================

function _synthesisParagraph(items, goalContract, ctx) {
  const topic = (ctx && ctx.topic) || (goalContract && goalContract.topic) || 'this topic';
  const goal = String((goalContract && goalContract.north_star) || '').trim();
  const n = items.length;
  if (n === 0) {
    return `This cycle returned no signal for ${topic}. The frontier is quiet — keep the lesson the spine, the radar will report when something moves.`;
  }
  const sources = Array.from(new Set(items.map(i => i.source))).join(', ');
  const goalLine = goal ? ` against your stated aim "${goal}"` : '';
  return `This cycle compiled ${n} signal${n === 1 ? '' : 's'} for ${topic} from ${sources}${goalLine}. Treat the list below as raw material — the lesson that follows will weave the one or two threads that actually advance your work.`;
}

function _actionItems(items, goalContract) {
  // Action items are LOW count by design (max 3) — the blueprint forbids
  // a long checklist register. Each one ties to something the user can
  // do inside an existing surface (a lesson, a note, a spark).
  if (!items || items.length === 0) return [];
  const out = [];
  const top = items[0];
  if (top) {
    out.push({
      verb: 'cite',
      detail: `Pull "${String(top.title).slice(0, 60)}" into the next lesson on this topic.`,
      ties_to_lesson: true,
    });
  }
  if (items.length >= 3) {
    out.push({
      verb: 'compare',
      detail: 'Hold the top 3 items side-by-side and write one sentence on which one most reframes your frame.',
      ties_to_lesson: false,
    });
  }
  return out;
}

function _productSparkCandidates(items, goalContract) {
  // Only surface a spark candidate when an item has a clear "build-able"
  // shape. Mock heuristic: GitHub items get spark candidacy (they ship
  // code), arxiv + others stay as citations. Production T6_STRONG synth
  // will judge transfer potential per item.
  const mainCreation = String((goalContract && goalContract.main_creation) || '').trim();
  return (items || [])
    .filter(i => (i.source || '').toLowerCase() === 'github')
    .slice(0, 2)
    .map(i => ({
      title: `Spark: ${String(i.title).slice(0, 60)}`,
      core_transfer: mainCreation
        ? `Mechanism from this repo, mapped onto ${mainCreation}.`
        : `Mechanism from this repo — slot once your main creation declares a need.`,
      related_product: mainCreation || '',
      risk: 'Transfer may be cosmetic — only seed if the mechanism (not the surface) maps.',
      _source_url: i.url,
    }));
}

// =====================================================================
// Public surface
// =====================================================================

/**
 * Generate a Frontier Report from filtered items.
 *
 * Wave 6.3 Alpha — synthesis path is mocked (deterministic). Production
 * wires `app/lib/llm/router.executeChat('T6_STRONG', …)` here with a JSON
 * mode response shaped to the RFR_SCHEMA.
 *
 * @param {Array<object>} items - top-K items passed by radar.js after first-pass
 * @param {object} goalContract - { slug, north_star, main_creation, topic }
 * @param {object} [ctx] - { topic, date }
 * @returns {Promise<object>} report (without slug/generated_at — radar.js fills those)
 */
async function generateReport(items, goalContract, ctx = {}) {
  const safeItems = Array.isArray(items) ? items : [];
  const enriched = safeItems.map(it => _enrichItem(it, goalContract));
  return {
    topic: ctx.topic || (goalContract && goalContract.topic) || '',
    date: ctx.date || '',
    items: enriched,
    synthesis_paragraph: _synthesisParagraph(enriched, goalContract, ctx),
    action_items: _actionItems(enriched, goalContract),
    product_spark_candidates: _productSparkCandidates(enriched, goalContract),
    _synth_capability: 'T6_STRONG_MOCK',
  };
}

/**
 * Render a Frontier Report as markdown for the dashboard preview + the
 * lesson citation block. 千金 register: italic Garamond title cues, no
 * bullet-explosion. Action items + spark candidates render only when present.
 */
function formatReportMarkdown(report) {
  if (!report || typeof report !== 'object') return '';
  const lines = [];
  lines.push(`# ${report.topic || 'Frontier'} · ${report.date || ''}`);
  lines.push('');
  if (report.synthesis_paragraph) {
    lines.push(report.synthesis_paragraph);
    lines.push('');
  }
  if (Array.isArray(report.items) && report.items.length > 0) {
    lines.push('## Signals');
    lines.push('');
    for (const it of report.items) {
      const title = it.title || '(untitled)';
      const url = it.url ? ` — <${it.url}>` : '';
      lines.push(`- **[${it.source}]** ${title}${url}`);
      if (it.summary_short) lines.push(`  - ${it.summary_short}`);
      if (it.relevance_to_goal) lines.push(`  - _Relevance:_ ${it.relevance_to_goal}`);
      if (it.potential_implication) lines.push(`  - _Implication:_ ${it.potential_implication}`);
    }
    lines.push('');
  }
  if (Array.isArray(report.action_items) && report.action_items.length > 0) {
    lines.push('## Next moves');
    lines.push('');
    for (const a of report.action_items) {
      lines.push(`- **${a.verb}** — ${a.detail}`);
    }
    lines.push('');
  }
  if (Array.isArray(report.product_spark_candidates) && report.product_spark_candidates.length > 0) {
    lines.push('## Product Spark candidates');
    lines.push('');
    for (const s of report.product_spark_candidates) {
      lines.push(`- ${s.title}`);
      if (s.core_transfer) lines.push(`  - _Transfer:_ ${s.core_transfer}`);
      if (s.risk) lines.push(`  - _Risk:_ ${s.risk}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Validate that a report has the required shape. Used by IPC handlers
 * + tests so malformed objects fail loud at the boundary.
 */
function validateReport(report) {
  if (!report || typeof report !== 'object') return { ok: false, error: 'report must be object' };
  if (typeof report.topic !== 'string' || report.topic.length === 0) {
    return { ok: false, error: 'report.topic must be non-empty string' };
  }
  if (typeof report.date !== 'string') {
    return { ok: false, error: 'report.date must be string (YYYY-MM-DD)' };
  }
  if (!Array.isArray(report.items)) {
    return { ok: false, error: 'report.items must be array' };
  }
  if (typeof report.synthesis_paragraph !== 'string') {
    return { ok: false, error: 'report.synthesis_paragraph must be string' };
  }
  return { ok: true };
}

module.exports = {
  RFR_SCHEMA,
  generateReport,
  formatReportMarkdown,
  validateReport,
};
