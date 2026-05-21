/* global React */
//
// HYPHA · Roadmap Card (v0.3 Creation System surface, 2026-05-14)
//
// Mounts inside the lesson screen below ProductSparkCard. Reads the
// per-curriculum weekly roadmap markdown maintained by the Creation
// System (Machino-α4 backend: window.ptor.creation.roadmapGetLatest).
//
// Surface contract:
//   - Renders only when slug + bridge present + result.ok + mdContent non-empty
//   - Manuscript register: italic EB Garamond + Noto Serif SC on cream paper,
//     brass hairlines, no emoji, no exclamation, no marketing slang
//   - Three sections rendered with register-distinct headers:
//       本周优先 — ink + brass underline (primary band)
//       暂缓     — tabac italic (deferred band)
//       建议砍掉 — oxblood italic (kill band)
//   - All text renders through React text nodes (no dangerouslySetInnerHTML).
//     Markdown is hand-parsed in _parseRoadmapMd; on parse failure the raw
//     markdown is shown verbatim with a small editorial hint.
//
// refreshTrigger contract:
//   - Bump from parent after /finish so the card refetches the latest
//     roadmap markdown written by Machino-α4 weekly sync.

const ROADMAP_PALETTE = {
  ink:        '#2A1F12',  // 墨水 — 主标题 + body
  tabac:      '#5C4E36',  // 棕褐 — 副标 + 暂缓段
  brass:      '#B8A372',  // 黄铜分割线
  cream:      '#F4EBD9',  // 奶油背景
  oxblood:    '#6E2D2D',  // 砍掉段
  deepBrown:  '#6B4423',  // 下一步 italic
};

// ---------------------------------------------------------------------------
// Markdown parser (zero-dep, defensive)
// ---------------------------------------------------------------------------

// Frontmatter shape (per Machino-α4 spec):
//   week_anchor_date: YYYY-MM-DD
//   generated_at: ISO
//   entry_count: {decisions:N, assumptions:M, sparks:K, killed:J}
//
// Body shape:
//   ## 本周优先 / ## 暂缓 / ## 建议砍掉
//   each section contains bullet items shaped roughly as:
//     - **<title>** — <summary>
//       - 来源: <ref>
//       - 下一步: <action>     (only for 本周优先)
//
// Field names / punctuation are likely to drift slightly during α4 ship;
// the parser uses lenient regex with multiple fallbacks and silently skips
// malformed items rather than blowing up the card.

function _parseFrontmatter(fmText) {
  if (typeof fmText !== 'string') return {};
  const out = {};
  const lines = fmText.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim();
  }
  return out;
}

function _parseEntryCount(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const pick = (key) => {
    const re = new RegExp(`${key}\\s*[:=]\\s*(\\d+)`);
    const hit = raw.match(re);
    return hit ? Number(hit[1]) : 0;
  };
  const decisions = pick('decisions');
  const assumptions = pick('assumptions');
  const sparks = pick('sparks');
  const killed = pick('killed');
  if (!decisions && !assumptions && !sparks && !killed) return null;
  return { decisions, assumptions, sparks, killed };
}

// Split body into named sections keyed by header text. The first segment
// (before any `## `) is dropped. Section bodies preserve internal newlines
// so bullet parsing downstream can reason per-line.
function _splitSections(bodyText) {
  if (typeof bodyText !== 'string') return {};
  const parts = bodyText.split(/\r?\n##\s+/);
  const sections = {};
  // parts[0] is anything before the first ## header — discard.
  for (let i = 1; i < parts.length; i += 1) {
    const chunk = parts[i];
    const nl = chunk.indexOf('\n');
    const head = (nl === -1 ? chunk : chunk.slice(0, nl)).trim();
    const body = nl === -1 ? '' : chunk.slice(nl + 1);
    if (head) sections[head] = body;
  }
  return sections;
}

// Parse a section body into a list of items. Each item is anchored on a
// top-level bullet starting with `- ` at column 0. Continuation lines
// indented by 2+ spaces with `- 来源:` / `- 下一步:` attach to the parent.
function _parseSectionItems(sectionBody) {
  if (typeof sectionBody !== 'string' || !sectionBody.trim()) return [];
  const lines = sectionBody.split(/\r?\n/);
  const items = [];
  let current = null;
  const flush = () => {
    if (current && (current.title || current.summary)) items.push(current);
    current = null;
  };
  for (const line of lines) {
    if (/^-\s+/.test(line)) {
      // Top-level bullet
      flush();
      const stripped = line.replace(/^-\s+/, '');
      // Try `**title** — summary` then fall back to plain `title — summary`
      // then to the whole line as title.
      let title = '';
      let summary = '';
      const bold = stripped.match(/^\*\*(.+?)\*\*\s*[—\-:]\s*(.*)$/);
      if (bold) {
        title = bold[1].trim();
        summary = bold[2].trim();
      } else {
        const plain = stripped.match(/^(.+?)\s+[—\-]\s+(.+)$/);
        if (plain) {
          title = plain[1].trim();
          summary = plain[2].trim();
        } else {
          title = stripped.trim();
        }
      }
      current = { title, summary, source: '', nextStep: '', reason: '' };
    } else if (/^\s{2,}-\s+/.test(line) && current) {
      const sub = line.replace(/^\s+-\s+/, '');
      const srcM = sub.match(/^来源\s*[:：]\s*(.+)$/);
      const stepM = sub.match(/^下一步\s*[:：]\s*(.+)$/);
      const reasonM = sub.match(/^(?:原因|理由)\s*[:：]\s*(.+)$/);
      if (srcM) current.source = srcM[1].trim();
      else if (stepM) current.nextStep = stepM[1].trim();
      else if (reasonM) current.reason = reasonM[1].trim();
    }
  }
  flush();
  return items;
}

function _parseRoadmapMd(mdContent) {
  if (typeof mdContent !== 'string' || !mdContent.trim()) {
    return { ok: false, reason: 'empty' };
  }
  try {
    let fmRaw = '';
    let body = mdContent;
    // Frontmatter is bounded by lines containing exactly `---`. Split on
    // those lines defensively so we tolerate either CRLF or LF and trailing
    // whitespace on the delimiter lines.
    const delim = /^---\s*$/m;
    if (delim.test(mdContent)) {
      const parts = mdContent.split(/^---\s*$/m);
      // Typical shape: ['', frontmatter, body, ...]
      // Defensive: if md starts without leading `---`, parts[0] != '' — treat
      // parts[0] as body and skip frontmatter parsing.
      if (parts.length >= 3 && parts[0].trim() === '') {
        fmRaw = parts[1];
        body = parts.slice(2).join('---');
      } else {
        body = mdContent;
      }
    }
    const fm = _parseFrontmatter(fmRaw);
    const entryCount = _parseEntryCount(fm.entry_count || '');
    const sections = _splitSections(body);

    const primary = _parseSectionItems(sections['本周优先'] || '');
    const deferred = _parseSectionItems(sections['暂缓'] || '');
    const killed = _parseSectionItems(sections['建议砍掉'] || '');

    // At least one section must yield something parseable for the structured
    // render path; otherwise fall through to raw display so the user still
    // sees the upstream content.
    const total = primary.length + deferred.length + killed.length;
    if (total === 0) {
      return { ok: false, reason: 'no-items', fm, body };
    }
    return {
      ok: true,
      weekAnchorDate: typeof fm.week_anchor_date === 'string' ? fm.week_anchor_date.trim() : '',
      generatedAt: typeof fm.generated_at === 'string' ? fm.generated_at.trim() : '',
      entryCount,
      primary,
      deferred,
      killed,
    };
  } catch (_) {
    return { ok: false, reason: 'exception' };
  }
}

// ---------------------------------------------------------------------------
// Sub-renderers
// ---------------------------------------------------------------------------

const baseFont = '"EB Garamond", "Noto Serif SC", serif';

const HeaderBlock = ({ weekAnchorDate, entryCount }) => {
  const summaryBits = [];
  if (entryCount) {
    if (entryCount.decisions) summaryBits.push(`${entryCount.decisions} 决策`);
    if (entryCount.assumptions) summaryBits.push(`${entryCount.assumptions} 假设`);
    if (entryCount.sparks) summaryBits.push(`${entryCount.sparks} 灵感`);
    if (entryCount.killed) summaryBits.push(`${entryCount.killed} 自动结案`);
  }
  return (
    <div className="roadmap-header" style={{ marginBottom: 14, paddingBottom: 8, borderBottom: `1px solid ${ROADMAP_PALETTE.brass}` }}>
      <div
        style={{
          fontFamily: baseFont,
          fontStyle: 'italic',
          fontSize: 12,
          letterSpacing: '0.04em',
          color: ROADMAP_PALETTE.ink,
        }}
      >
        <span>本周路线</span>
        {weekAnchorDate ? (
          <span style={{ color: ROADMAP_PALETTE.tabac, marginLeft: 10, fontStyle: 'normal' }}>
            · {weekAnchorDate}
          </span>
        ) : null}
      </div>
      {summaryBits.length > 0 ? (
        <div
          style={{
            fontFamily: baseFont,
            fontSize: 9,
            letterSpacing: '0.06em',
            color: ROADMAP_PALETTE.tabac,
            marginTop: 4,
          }}
        >
          <span>〈基于近 7 天 {summaryBits.join(' / ')}〉</span>
        </div>
      ) : null}
    </div>
  );
};

const PrimaryItem = ({ item }) => (
  <div className="roadmap-primary-item" style={{ padding: '12px 0', borderBottom: `1px solid ${ROADMAP_PALETTE.brass}40` }}>
    {item.title ? (
      <div
        style={{
          fontFamily: baseFont,
          fontStyle: 'italic',
          fontSize: 15,
          lineHeight: 1.7,
          color: ROADMAP_PALETTE.ink,
        }}
      >
        {item.title}
      </div>
    ) : null}
    {item.summary ? (
      <div
        style={{
          fontFamily: baseFont,
          fontSize: 12,
          lineHeight: 1.7,
          color: ROADMAP_PALETTE.ink,
          marginTop: 4,
        }}
      >
        <span style={{ marginRight: 6, color: ROADMAP_PALETTE.tabac }}>→</span>
        <span>{item.summary}</span>
      </div>
    ) : null}
    {item.source ? (
      <div
        style={{
          fontFamily: baseFont,
          fontSize: 8.5,
          letterSpacing: '0.04em',
          lineHeight: 1.6,
          color: ROADMAP_PALETTE.tabac,
          marginTop: 6,
        }}
      >
        <span style={{ fontStyle: 'italic', marginRight: 6 }}>来源:</span>
        <span>{item.source}</span>
      </div>
    ) : null}
    {item.nextStep ? (
      <div
        style={{
          fontFamily: baseFont,
          fontStyle: 'italic',
          fontSize: 9.5,
          lineHeight: 1.6,
          color: ROADMAP_PALETTE.deepBrown,
          marginTop: 2,
        }}
      >
        <span style={{ marginRight: 6 }}>下一步:</span>
        <span>{item.nextStep}</span>
      </div>
    ) : null}
  </div>
);

const SecondaryItem = ({ item, tone }) => {
  const color = tone === 'kill' ? ROADMAP_PALETTE.oxblood : ROADMAP_PALETTE.tabac;
  const trailing = tone === 'kill' && item.reason ? item.reason : item.summary;
  return (
    <div className="roadmap-secondary-item" style={{ padding: '8px 0', borderBottom: `1px solid ${ROADMAP_PALETTE.brass}30` }}>
      <div
        style={{
          fontFamily: baseFont,
          fontSize: 12,
          lineHeight: 1.65,
          color: ROADMAP_PALETTE.ink,
        }}
      >
        <span style={{ fontStyle: 'italic', color, marginRight: 6 }}>〈{item.title || '未命名'}〉</span>
        {trailing ? <span>— {trailing}</span> : null}
      </div>
      {item.source ? (
        <div
          style={{
            fontFamily: baseFont,
            fontSize: 8.5,
            letterSpacing: '0.04em',
            color: ROADMAP_PALETTE.tabac,
            marginTop: 3,
          }}
        >
          <span style={{ fontStyle: 'italic', marginRight: 6 }}>来源:</span>
          <span>{item.source}</span>
        </div>
      ) : null}
    </div>
  );
};

const SectionHeader = ({ label, tone }) => {
  const styles = {
    primary: {
      color: ROADMAP_PALETTE.ink,
      borderBottom: `1px solid ${ROADMAP_PALETTE.brass}`,
    },
    defer: {
      color: ROADMAP_PALETTE.tabac,
      borderBottom: `1px solid ${ROADMAP_PALETTE.brass}40`,
    },
    kill: {
      color: ROADMAP_PALETTE.oxblood,
      borderBottom: `1px solid ${ROADMAP_PALETTE.brass}40`,
    },
  };
  const s = styles[tone] || styles.primary;
  return (
    <div
      className="roadmap-section-header"
      style={{
        fontFamily: baseFont,
        fontStyle: 'italic',
        fontSize: 11,
        letterSpacing: '0.08em',
        marginTop: 12,
        marginBottom: 6,
        paddingBottom: 4,
        ...s,
      }}
    >
      {label}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Top-level card component
// ---------------------------------------------------------------------------

// Machino-β6 (2026-05-14) — skip reason 中文化 for weekly roadmap.
// Maps the `skipped` field emitted by main.js `creation:roadmap-synced`
// event into a readable editorial sentence. Returns '' for unknown
// codes so caller can fall through to a generic phrase.
//
// intentional-placeholder: main.js currently only emits `creation:roadmap-
// synced` when mdPath exists (success path). To make this hint surface
// fire, main.js needs an additional `webContents.send('creation:roadmap-
// synced', { slug, skipped, mdPath: null })` on the skip path. This is
// explicitly scoped OUT of Machino-β6 per task spec ("不动后端... 留 TODO
// 注释或调 α6 别人") — backend emit belongs to Machino-α6. This file is
// wired to consume the field the moment it arrives.
function _skipReasonZh(code) {
  if (typeof code !== 'string' || !code.trim()) return '';
  switch (code) {
    case 'too-few-entries':
      return '近 7 天累积 < 3 条,等再积一些再生成';
    case 'invalid-json':
      return '汇总返回格式错';
    case 'llm-error':
      return '模型调用失败';
    default:
      return '';
  }
}

// Skipped hint card — small editorial register-faithful surface that
// surfaces an empty-result reason from /finish so an absent roadmap
// does not silently read as "nothing happened this week".
const SkippedHint = ({ reason, label }) => {
  const zh = _skipReasonZh(reason);
  return (
    <div
      className="roadmap-skipped"
      style={{
        marginTop: 20,
        padding: 12,
        background: ROADMAP_PALETTE.cream,
        borderTop: `1px solid ${ROADMAP_PALETTE.brass}`,
        borderBottom: `1px solid ${ROADMAP_PALETTE.brass}`,
        fontFamily: baseFont,
        lineHeight: 1.7,
      }}
    >
      <div
        style={{
          fontStyle: 'italic',
          fontSize: 11,
          letterSpacing: '0.04em',
          color: ROADMAP_PALETTE.tabac,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontStyle: 'normal',
          fontSize: 10,
          lineHeight: 1.65,
          color: ROADMAP_PALETTE.ink,
        }}
      >
        {zh || reason}
      </div>
    </div>
  );
};

const RoadmapCard = ({ slug, refreshTrigger }) => {
  const { useState, useEffect } = React;
  const [state, setState] = useState({ loading: true, ok: false, parsed: null, raw: '' });
  // Machino-α5 (2026-05-14) — bumped by main-process roadmap-synced events.
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Machino-β6 (2026-05-14) — last skipped reason from the most recent
  // matching `creation:roadmap-synced` event. Null on success or pre-
  // event. Drives the empty-state hint so weekly skips are visible.
  const [lastSkipped, setLastSkipped] = useState(null);

  useEffect(() => {
    if (!slug) { setState({ loading: false, ok: false, parsed: null, raw: '' }); return undefined; }
    let mounted = true;
    (async () => {
      try {
        const creation = window.ptor && window.ptor.creation;
        if (!creation || typeof creation.roadmapGetLatest !== 'function') {
          // Bridge not yet on window (Machino-α4 still wiring) — silent.
          if (mounted) setState({ loading: false, ok: false, parsed: null, raw: '' });
          return;
        }
        const result = await creation.roadmapGetLatest(slug);
        if (!mounted) return;
        if (!result || result.ok === false) {
          setState({ loading: false, ok: false, parsed: null, raw: '' });
          return;
        }
        const md = typeof result.mdContent === 'string' ? result.mdContent : '';
        if (!md.trim()) {
          setState({ loading: false, ok: false, parsed: null, raw: '' });
          return;
        }
        const parsed = _parseRoadmapMd(md);
        setState({ loading: false, ok: true, parsed, raw: md });
      } catch (_) {
        if (mounted) setState({ loading: false, ok: false, parsed: null, raw: '' });
      }
    })();
    return () => { mounted = false; };
  }, [slug, refreshTrigger, refreshNonce]);

  // Machino-α5 — subscribe to roadmap-synced events. Only refetch on
  // matching slug because each curriculum has its own weekly roadmap.
  useEffect(() => {
    if (!slug) return undefined;
    const creation = window.ptor && window.ptor.creation;
    if (!creation || typeof creation.onRoadmapSynced !== 'function') return undefined;
    const off = creation.onRoadmapSynced((payload) => {
      if (payload && payload.slug === slug) {
        // Machino-β6 — record skip reason on every matching event. Note:
        // current main.js skip-path does NOT emit this event (see TODO
        // above); when α6 wires it, this line activates automatically.
        setLastSkipped(payload.skipped || null);
        setRefreshNonce((n) => n + 1);
      }
    });
    return () => { try { if (typeof off === 'function') off(); } catch (_) {} };
  }, [slug]);

  // Silent on first paint + absent bridge.
  if (state.loading) return null;
  // Machino-β6 — when no roadmap is available AND a skip reason was
  // captured from a matching `creation:roadmap-synced` event, render a
  // margin-note hint instead of silent null. (Until α6 emits the skip-
  // path event, `lastSkipped` stays null and behavior is unchanged.)
  if (!state.ok) {
    if (lastSkipped) {
      return <SkippedHint reason={lastSkipped} label="本节未生成" />;
    }
    return null;
  }

  const parsed = state.parsed;
  const cardWrapper = {
    marginTop: 20,
    padding: 24,
    background: ROADMAP_PALETTE.cream,
    borderTop: `1px solid ${ROADMAP_PALETTE.brass}`,
    borderBottom: `1px solid ${ROADMAP_PALETTE.brass}`,
    fontFamily: baseFont,
    lineHeight: 1.7,
  };

  // Parser failed but raw markdown is available — render raw with a small
  // editorial hint so the content is not lost.
  if (!parsed || !parsed.ok) {
    return (
      <div className="roadmap-card roadmap-card-raw" style={cardWrapper}>
        <div
          style={{
            fontFamily: baseFont,
            fontStyle: 'italic',
            fontSize: 12,
            letterSpacing: '0.04em',
            color: ROADMAP_PALETTE.tabac,
            marginBottom: 10,
            paddingBottom: 6,
            borderBottom: `1px solid ${ROADMAP_PALETTE.brass}`,
          }}
        >
          本周路线
        </div>
        <pre
          style={{
            fontFamily: baseFont,
            fontSize: 12,
            lineHeight: 1.7,
            color: ROADMAP_PALETTE.ink,
            whiteSpace: 'pre-wrap',
            margin: 0,
          }}
        >
          {state.raw}
        </pre>
        <div
          style={{
            fontFamily: baseFont,
            fontStyle: 'italic',
            fontSize: 9,
            color: ROADMAP_PALETTE.tabac,
            marginTop: 8,
          }}
        >
          (原始 markdown,解析异常)
        </div>
      </div>
    );
  }

  return (
    <div className="roadmap-card" style={cardWrapper}>
      <HeaderBlock weekAnchorDate={parsed.weekAnchorDate} entryCount={parsed.entryCount} />

      {parsed.primary.length > 0 ? (
        <div className="roadmap-section roadmap-primary">
          <SectionHeader label="本周优先" tone="primary" />
          {parsed.primary.map((it, i) => (
            <PrimaryItem key={`p-${i}`} item={it} />
          ))}
        </div>
      ) : null}

      {parsed.deferred.length > 0 ? (
        <div className="roadmap-section roadmap-deferred">
          <SectionHeader label="暂缓" tone="defer" />
          {parsed.deferred.map((it, i) => (
            <SecondaryItem key={`d-${i}`} item={it} tone="defer" />
          ))}
        </div>
      ) : null}

      {parsed.killed.length > 0 ? (
        <div className="roadmap-section roadmap-killed">
          <SectionHeader label="建议砍掉" tone="kill" />
          {parsed.killed.map((it, i) => (
            <SecondaryItem key={`k-${i}`} item={it} tone="kill" />
          ))}
        </div>
      ) : null}
    </div>
  );
};

// Expose globally so screen-lesson-chat.jsx (loaded after this file in
// HYPHA.html) can render <RoadmapCard /> without an import.
if (typeof window !== 'undefined') {
  window.RoadmapCard = RoadmapCard;
}
