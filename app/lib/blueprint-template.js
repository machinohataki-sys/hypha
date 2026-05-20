'use strict';

// HYPHA · W3.2 Product Blueprint template.
//
// Implements BLUEPRINT.md §11.2 — a 10-section structured product spec. The
// 10 sections are the **stable canonical schema**; new sections require a
// blueprint-level decision (recorded in §8 Decision Log). The template is
// the single source of truth for:
//
//   1. Filling a fresh blueprint with placeholder text (when a product is
//      first registered in W3.1 Creation Pool).
//   2. Round-tripping a markdown file on disk through the editor UI and back
//      without losing structure or comments (renderBlueprint / parseBlueprint).
//   3. Validating that every section either has content or has been
//      explicitly skipped — drafts with silent blanks are rejected.
//
// File format on disk (per spec at specs/product-blueprint.md):
//
//   ---
//   slug: my-product
//   created_at: 2026-05-13T10:00:00Z
//   updated_at: 2026-05-13T10:00:00Z
//   schema_version: 1
//   ---
//
//   # Product Blueprint
//
//   ## 1. Product North Star
//   <body>
//
//   ## 2. Target Users
//   <body>
//
//   ... (10 sections total)
//
// Section heading parse is permissive (matches both English BLUEPRINT.md text
// and Chinese subtitles); render output is canonical. Section bodies are
// markdown — we treat them as opaque text, not parsed further (except Risk
// Map which has a sub-structure documented inline).

// ---------------------------------------------------------------------------
// Section schema — order is load-bearing (== the blueprint reading order).
// ---------------------------------------------------------------------------

const SECTIONS = [
  {
    key: 'northStar',
    number: 1,
    heading: 'Product North Star',
    hint: '这个产品最终要改变什么？一句话写下它存在的理由。',
    placeholder: '_(尚未写下。)_ 产品的根本指向 — 不是功能列表，是世界状态的差。',
  },
  {
    key: 'targetUsers',
    number: 2,
    heading: 'Target Users',
    hint: '这个产品为谁存在？刻画 1-3 个具体的人，不写人口统计。',
    placeholder: '_(尚未写下。)_ 一个具体的人，正在做一件具体的事。',
  },
  {
    key: 'corePain',
    number: 3,
    heading: 'Core Pain',
    hint: '它解决什么痛点？痛点不是"需求"，是用户当前正在承受的代价。',
    placeholder: '_(尚未写下。)_ 没有这个产品时，用户付出什么代价？',
  },
  {
    key: 'hypothesis',
    number: 4,
    heading: 'Current Hypothesis',
    hint: '当前最重要的产品假设 — 如果证伪，整个产品 pivot。',
    placeholder: '_(尚未写下。)_ "如果我们这样做，那么…会发生"。',
  },
  {
    key: 'modules',
    number: 5,
    heading: 'Modules',
    hint: '已有的模块。每个模块写一行：名字 + 它的职责。',
    placeholder: '_(尚未写下。)_ 模块图 — 不是组件树，是职责分配。',
  },
  {
    key: 'openQuestions',
    number: 6,
    heading: 'Open Questions',
    hint: '当前还没想清楚的问题。写下它们就是降低混乱熵。',
    placeholder: '_(尚未写下。)_ 列出 3-7 个真正没想清楚的问题。',
  },
  {
    key: 'inspirationPool',
    number: 7,
    heading: 'Inspiration Pool',
    hint: '从 Lesson / Note / Book / Pack / Spark 迁移来的灵感。引用链接。',
    placeholder: '_(尚未写下。)_ 列出灵感与来源链接 — [[lesson:slug]] / [[note:rel]] / [[spark:id]]。',
  },
  {
    key: 'decisionLog',
    number: 8,
    heading: 'Decision Log',
    hint: '关键决策记录。每条引用 decision-log.jsonl 索引。',
    placeholder: '_(尚未写下。)_ 重要 yes / no — 标注引用编号 (DL-001 等)。',
  },
  {
    key: 'riskMap',
    number: 9,
    heading: 'Risk Map',
    // Risk Map has internal sub-structure (5 categories × severity 4-tier).
    // See RISK_CATEGORIES + SEVERITY_LEVELS below + spec for canonical
    // markdown rendering.
    hint: '技术 / 商业 / 产品 / 法律 / 成本 — 每条标注 severity + 缓解。',
    placeholder: [
      '### Technical',
      '_(尚未写下。)_',
      '',
      '### Business',
      '_(尚未写下。)_',
      '',
      '### Product',
      '_(尚未写下。)_',
      '',
      '### Legal',
      '_(尚未写下。)_',
      '',
      '### Cost',
      '_(尚未写下。)_',
    ].join('\n'),
  },
  {
    key: 'roadmap',
    number: 10,
    heading: 'Roadmap',
    hint: '从当前版本到理想版本的路径。不是甘特图，是叙事顺序。',
    placeholder: '_(尚未写下。)_ 从此刻到理想的路径 — 列出里程碑，每个标注 why。',
  },
];

const SECTION_BY_KEY = Object.fromEntries(SECTIONS.map((s) => [s.key, s]));

// Risk Map sub-structure (spec §Risk Map). renderBlueprint / parseBlueprint
// treat the riskMap section body as opaque markdown by default. Callers that
// want structured access should use renderRiskMap / parseRiskMap below.

const RISK_CATEGORIES = ['technical', 'business', 'product', 'legal', 'cost'];
const SEVERITY_LEVELS = ['low', 'medium', 'high', 'critical'];
const RISK_CATEGORY_LABEL = {
  technical: 'Technical',
  business: 'Business',
  product: 'Product',
  legal: 'Legal',
  cost: 'Cost',
};

// ---------------------------------------------------------------------------
// Frontmatter — minimal hand-rolled YAML (string / number / boolean scalars
// only; no nested objects or lists). Hypha doesn't pull in js-yaml elsewhere,
// so we avoid a dependency.
// ---------------------------------------------------------------------------

function _isPlainScalar(v) {
  if (v == null) return true;
  const t = typeof v;
  return t === 'string' || t === 'number' || t === 'boolean';
}

function _serializeFrontmatterValue(v) {
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  // Quote if contains special YAML chars or leading/trailing whitespace.
  if (/[:#&*!|>'"%@`\n\r\t]/.test(s) || /^\s|\s$/.test(s) || /^[-?]\s/.test(s)) {
    return JSON.stringify(s); // JSON strings are valid YAML double-quoted scalars
  }
  return s;
}

function _parseFrontmatterValue(raw) {
  const s = String(raw).trim();
  if (s === '') return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  // Quoted string
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try { return JSON.parse(s.startsWith("'") ? `"${s.slice(1, -1).replace(/"/g, '\\"')}"` : s); }
    catch (_) { return s.slice(1, -1); }
  }
  return s;
}

function _renderFrontmatter(fm) {
  if (!fm || typeof fm !== 'object') return '';
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (!_isPlainScalar(v)) continue; // skip unsupported (defensive)
    lines.push(`${k}: ${_serializeFrontmatterValue(v)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function _parseFrontmatter(text) {
  // Expects text to start with `---\n` and have a closing `---` line.
  if (!text.startsWith('---')) return { fm: {}, rest: text };
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== '---') return { fm: {}, rest: text };
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') { closeIdx = i; break; }
  }
  if (closeIdx < 0) return { fm: {}, rest: text };
  const fm = {};
  for (let i = 1; i < closeIdx; i += 1) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    fm[m[1]] = _parseFrontmatterValue(m[2]);
  }
  const rest = lines.slice(closeIdx + 1).join('\n').replace(/^\n+/, '');
  return { fm, rest };
}

// ---------------------------------------------------------------------------
// BLUEPRINT_TEMPLATE — the canonical 10-section spec object. Exported.
// ---------------------------------------------------------------------------

const BLUEPRINT_TEMPLATE = Object.freeze({
  schema_version: 1,
  sections: SECTIONS.map((s) => Object.freeze({
    key: s.key,
    number: s.number,
    heading: s.heading,
    hint: s.hint,
    placeholder: s.placeholder,
  })),
  risk_categories: RISK_CATEGORIES.slice(),
  severity_levels: SEVERITY_LEVELS.slice(),
});

// ---------------------------------------------------------------------------
// renderBlueprint — productData → markdown string.
//
// productData shape (all fields optional; missing → placeholder):
//   {
//     slug, name, productType, created_at, updated_at,
//     northStar, targetUsers, corePain, hypothesis, modules,
//     openQuestions, inspirationPool, decisionLog, riskMap, roadmap
//   }
//
// Empty / falsy section value → emits SECTIONS[i].placeholder.
// String "[skipped: <reason>]" → emitted verbatim (counts as explicit skip).
// ---------------------------------------------------------------------------

function renderBlueprint(productData = {}) {
  const data = productData || {};
  const now = new Date().toISOString();
  const fm = {
    slug: data.slug || '',
    name: data.name || '',
    product_type: data.productType || data.product_type || '',
    schema_version: 1,
    created_at: data.created_at || now,
    updated_at: data.updated_at || now,
  };

  const parts = [_renderFrontmatter(fm), '', '# Product Blueprint', ''];
  for (const s of SECTIONS) {
    const raw = data[s.key];
    const body = (typeof raw === 'string' && raw.trim()) ? raw.trim() : s.placeholder;
    parts.push(`## ${s.number}. ${s.heading}`);
    parts.push(`> ${s.hint}`);
    parts.push('');
    parts.push(body);
    parts.push('');
  }
  return parts.join('\n').replace(/\n{3,}$/, '\n');
}

// ---------------------------------------------------------------------------
// parseBlueprint — markdown string → { frontmatter, sections }.
//
// sections.<key> is the trimmed body of each canonical section (without
// heading + hint). Missing sections → empty string. Quote-line hints (lines
// starting with `> `) are stripped from each section's body.
// ---------------------------------------------------------------------------

function parseBlueprint(markdown = '') {
  const text = String(markdown || '');
  const { fm, rest } = _parseFrontmatter(text);

  // Section regex: `## <number>. <Heading>` (heading match is lax — we accept
  // any heading text on a `##` line after stripping the leading "N. " prefix).
  const sections = {};
  for (const s of SECTIONS) sections[s.key] = '';

  // Tokenize ## headings, then split body until the next ## line.
  const lines = rest.split(/\r?\n/);
  let currentKey = null;
  let buffer = [];

  const flush = () => {
    if (!currentKey) return;
    // Strip leading `> hint` quote lines.
    let body = buffer.join('\n');
    body = body.replace(/^(?:\s*>[^\n]*\n)+/, '');
    body = body.trim();
    sections[currentKey] = body;
  };

  const matchSectionHeading = (line) => {
    const m = line.match(/^##\s+(\d{1,2})[.．。]?\s*(.*)$/);
    if (!m) return null;
    const num = Number(m[1]);
    const hit = SECTIONS.find((s) => s.number === num);
    if (hit) return hit.key;
    // Fallback: match by heading text (case-insensitive substring).
    const text2 = (m[2] || '').trim().toLowerCase();
    const byHeading = SECTIONS.find((s) => s.heading.toLowerCase() === text2);
    return byHeading ? byHeading.key : null;
  };

  for (const line of lines) {
    if (/^#\s+/.test(line)) continue; // top-level `# Product Blueprint` — ignore
    const key = line.startsWith('## ') ? matchSectionHeading(line) : null;
    if (key) {
      flush();
      currentKey = key;
      buffer = [];
    } else if (currentKey) {
      buffer.push(line);
    }
  }
  flush();

  return { frontmatter: fm, sections };
}

// ---------------------------------------------------------------------------
// validateBlueprint — returns { valid, missing_sections, warnings }.
//
// Rules:
//   1. Each of the 10 sections must have either non-empty content OR an
//      explicit "[skipped: <reason>]" marker. Empty / placeholder-only → miss.
//   2. North Star + Hypothesis are HARD-required (cannot be skipped).
//   3. Decision Log entries with `[ref:DL-<n>]` markers must follow the
//      numbering convention (best-effort lint).
//   4. Risk Map should contain at least 1 category heading (warning if none).
//
// Input: either a parsed sections object, a productData object, or a full
// markdown string.
// ---------------------------------------------------------------------------

function _isExplicitSkip(text) {
  return /^\[skipped:[^\]]*\]\s*$/i.test(String(text || '').trim());
}

function _isPlaceholderOnly(text, section) {
  const t = String(text || '').trim();
  if (!t) return true;
  // Match the canonical "_(尚未写下。)_" placeholder. We don't full-string
  // compare against the multi-line Risk Map placeholder; instead detect that
  // all lines collapse to placeholder + the 5 sub-headings + blanks.
  if (/^_\(尚未写下/.test(t)) return true;
  // Risk Map special-case: if every line either matches a sub-heading
  // (`### …`) or is a placeholder line, treat as placeholder-only.
  if (section && section.key === 'riskMap') {
    const stripped = t.split(/\n+/)
      .map((l) => l.trim())
      .filter((l) => l && !/^###\s+/i.test(l));
    if (stripped.length === 0) return true;
    if (stripped.every((l) => /^_\(尚未写下/.test(l))) return true;
  }
  return false;
}

function validateBlueprint(input) {
  let sections;
  if (typeof input === 'string') {
    sections = parseBlueprint(input).sections;
  } else if (input && typeof input === 'object') {
    if (input.sections && typeof input.sections === 'object') {
      sections = input.sections;
    } else {
      sections = input;
    }
  } else {
    sections = {};
  }

  const missing_sections = [];
  const warnings = [];
  const HARD_REQUIRED = new Set(['northStar', 'hypothesis']);

  for (const s of SECTIONS) {
    const body = (sections && typeof sections[s.key] === 'string') ? sections[s.key] : '';
    const skipped = _isExplicitSkip(body);
    const placeholderOnly = _isPlaceholderOnly(body, s);

    if (placeholderOnly && !skipped) {
      missing_sections.push(s.key);
      continue;
    }
    if (skipped && HARD_REQUIRED.has(s.key)) {
      missing_sections.push(s.key);
      warnings.push(`${s.heading} is hard-required and cannot be skipped`);
      continue;
    }

    // Section-specific soft warnings.
    if (s.key === 'riskMap' && !skipped) {
      const hasCategoryHeading = /(?:^|\n)###\s+/i.test(body);
      if (!hasCategoryHeading) {
        warnings.push('Risk Map has no `### Category` subheadings — at least one of Technical / Business / Product / Legal / Cost recommended.');
      }
    }
    if (s.key === 'decisionLog' && !skipped) {
      const refs = (body.match(/DL-\d+/g) || []);
      if (refs.length > 0) {
        const seen = new Set();
        for (const r of refs) {
          if (seen.has(r)) warnings.push(`Decision Log reference ${r} appears more than once`);
          seen.add(r);
        }
      }
    }
    if (s.key === 'inspirationPool' && !skipped) {
      const linkCount = (body.match(/\[\[[^\]]+\]\]|https?:\/\//g) || []).length;
      if (linkCount === 0) {
        warnings.push('Inspiration Pool has no inbound link — list at least one [[lesson:…]] / [[note:…]] / URL source.');
      }
    }
  }

  return {
    valid: missing_sections.length === 0,
    missing_sections,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Risk Map structured helpers (optional — UI may use them, or treat the
// section body as opaque markdown).
//
// Risk record shape:
//   { category, description, severity, mitigation }
//
// renderRiskMap(risks)  — array → markdown body for §9
// parseRiskMap(body)    — markdown body → array (best-effort; unknown lines
//                          attached to most recent risk as continuation)
// ---------------------------------------------------------------------------

function renderRiskMap(risks) {
  if (!Array.isArray(risks) || risks.length === 0) {
    return SECTION_BY_KEY.riskMap.placeholder;
  }
  // Group by category in canonical order.
  const grouped = new Map(RISK_CATEGORIES.map((c) => [c, []]));
  for (const r of risks) {
    const cat = RISK_CATEGORIES.includes(r && r.category) ? r.category : 'product';
    grouped.get(cat).push(r);
  }
  const out = [];
  for (const cat of RISK_CATEGORIES) {
    const list = grouped.get(cat);
    out.push(`### ${RISK_CATEGORY_LABEL[cat]}`);
    if (!list.length) {
      out.push('_(尚未写下。)_');
    } else {
      for (const r of list) {
        const sev = SEVERITY_LEVELS.includes(r && r.severity) ? r.severity : 'medium';
        const desc = (r && r.description) ? String(r.description).trim() : '_(描述待补)_';
        const mit = (r && r.mitigation) ? String(r.mitigation).trim() : '';
        out.push(`- **[${sev}]** ${desc}`);
        if (mit) out.push(`  - _mitigation:_ ${mit}`);
      }
    }
    out.push('');
  }
  return out.join('\n').trim();
}

function parseRiskMap(body) {
  const text = String(body || '');
  const risks = [];
  if (!text.trim()) return risks;
  const lines = text.split(/\r?\n/);
  let currentCategory = 'product';
  let currentRisk = null;
  const flush = () => { if (currentRisk) { risks.push(currentRisk); currentRisk = null; } };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const catM = line.match(/^###\s+(.+?)\s*$/);
    if (catM) {
      flush();
      const label = catM[1].toLowerCase();
      const found = RISK_CATEGORIES.find((c) => RISK_CATEGORY_LABEL[c].toLowerCase() === label || c === label);
      if (found) currentCategory = found;
      continue;
    }
    const riskM = line.match(/^[-*]\s+(?:\*\*\[(\w+)\]\*\*\s+)?(.+)$/);
    if (riskM) {
      flush();
      const sev = riskM[1] && SEVERITY_LEVELS.includes(riskM[1].toLowerCase()) ? riskM[1].toLowerCase() : 'medium';
      currentRisk = {
        category: currentCategory,
        severity: sev,
        description: riskM[2].trim(),
        mitigation: '',
      };
      continue;
    }
    const mitM = line.match(/^\s+-\s+_mitigation:_\s+(.+)$/i);
    if (mitM && currentRisk) {
      currentRisk.mitigation = mitM[1].trim();
      continue;
    }
    // Unknown continuation — attach to current risk description.
    if (currentRisk && line.trim()) {
      currentRisk.description += `\n${line.trim()}`;
    }
  }
  flush();
  return risks;
}

// ---------------------------------------------------------------------------
// emptySections — returns a fresh `{key: ''}` map for all 10 sections.
// Convenience for UI useState initializers.
// ---------------------------------------------------------------------------

function emptySections() {
  const out = {};
  for (const s of SECTIONS) out[s.key] = '';
  return out;
}

module.exports = {
  BLUEPRINT_TEMPLATE,
  SECTIONS,
  RISK_CATEGORIES,
  SEVERITY_LEVELS,
  renderBlueprint,
  parseBlueprint,
  validateBlueprint,
  renderRiskMap,
  parseRiskMap,
  emptySections,
};
