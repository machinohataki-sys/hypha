/* global React */
// HYPHA · Book Spark Pack viewer (v0.2 schema — theme-grouped 7-field deep Sparks).
//
// New shape (per phases.js phase7):
//   { schema_version, book_title, version, source_note,
//     author_core_question, overall_structure, book_model,
//     themes: [{ id, name, description, sparks: [{ id, name, hook, mechanism[],
//                  counterintuitive, ai_era, transfer, experiment }] }],
//     anti_sparks: [{ kind, text }],
//     strategic_propositions: [string],
//     risk_and_copyright_note }
//
// Manuscript register: italic EB Garamond + Noto Serif SC, brass hairlines,
// no SaaS chrome. Each Spark is a fold-out card so the page stays calm.

const { useState, useEffect, useCallback, useMemo } = React;

const BookSparkPackScreen = ({ bookId, onBack }) => {
  const [pack, setPack] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [exportNotice, setExportNotice] = useState(null);
  // expanded spark ids — default all collapsed for calm; click to open
  const [openSparks, setOpenSparks] = useState(() => new Set());

  useEffect(() => {
    let cancelled = false;
    if (!bookId || !window.ptor || !window.ptor.hypha || !window.ptor.hypha.distill) {
      setError('bridge missing: distill');
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    (async () => {
      try {
        const r = await window.ptor.hypha.distill.getBookSparkPack(bookId);
        if (cancelled) return;
        if (!r || !r.ok) { setError((r && r.error) || 'fetch failed'); return; }
        setPack(r.pack || null);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [bookId]);

  const handleExport = useCallback(() => {
    if (!pack) return;
    try {
      const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `book-spark-pack-${(pack.book_title || 'book').replace(/[^\w一-鿿]+/g, '-')}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportNotice('已导出 JSON');
      setTimeout(() => setExportNotice(null), 2400);
    } catch (e) {
      setError('export failed: ' + (e.message || String(e)));
    }
  }, [pack]);

  const handleExportMd = useCallback(() => {
    if (!pack) return;
    try {
      const md = renderPackMarkdown(pack);
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(pack.book_title || 'book').replace(/[^\w一-鿿]+/g, '-')}-spark-pack.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportNotice('已导出 Markdown');
      setTimeout(() => setExportNotice(null), 2400);
    } catch (e) {
      setError('export md failed: ' + (e.message || String(e)));
    }
  }, [pack]);

  const toggleSpark = useCallback((sparkId) => {
    setOpenSparks((prev) => {
      const next = new Set(prev);
      if (next.has(sparkId)) next.delete(sparkId);
      else next.add(sparkId);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    if (!pack || !Array.isArray(pack.themes)) return;
    const all = new Set();
    pack.themes.forEach(t => (t.sparks || []).forEach(s => all.add(s.id)));
    setOpenSparks(all);
  }, [pack]);

  const collapseAll = useCallback(() => setOpenSparks(new Set()), []);

  const totalSparks = useMemo(() => {
    if (!pack || !Array.isArray(pack.themes)) return 0;
    return pack.themes.reduce((n, t) => n + ((t.sparks || []).length), 0);
  }, [pack]);

  if (loading) {
    return <div className="col gap-12" style={{ padding: 40, color: 'var(--ink-2)' }}>
      <span className="italic">Loading book spark pack…</span>
    </div>;
  }
  if (error) {
    return <div className="col gap-12" style={{ padding: 40 }}>
      <div style={{
        padding: '12px 16px', background: 'rgba(139,58,58,0.08)',
        border: '1px solid rgba(139,58,58,0.3)', borderRadius: 2, color: '#8B3A3A',
      }}>{error}</div>
      <button onClick={onBack} className="btn btn-ghost" style={{ alignSelf: 'flex-start' }}>返回</button>
    </div>;
  }
  if (!pack) {
    return <div className="col gap-12" style={{ padding: 40 }}>
      <div className="italic" style={{ color: 'var(--ink-2)' }}>
        这本书还没蒸馏. 回到 Library, 点 "Distill" 启动 7 阶段流程.
      </div>
      <button onClick={onBack} className="btn btn-ghost" style={{ alignSelf: 'flex-start' }}>返回</button>
    </div>;
  }

  // Detect legacy v0.1 pack and prompt re-distill
  const isLegacy = pack.schema_version !== '0.2' && !Array.isArray(pack.themes);

  return (
    <div className="col gap-24 fade-in" style={{ padding: '40px 48px 80px', maxWidth: 880, margin: '0 auto' }}>
      <Header
        pack={pack}
        totalSparks={totalSparks}
        onExportJson={handleExport}
        onExportMd={handleExportMd}
        onExpandAll={expandAll}
        onCollapseAll={collapseAll}
        onBack={onBack}
      />

      {exportNotice && (
        <div style={{
          padding: '8px 12px', background: 'rgba(77,139,154,0.10)',
          border: '1px solid rgba(77,139,154,0.30)', borderRadius: 2,
          fontSize: 13, color: '#2F5762',
        }}>{exportNotice}</div>
      )}

      {isLegacy && (
        <div style={{
          padding: '14px 18px', background: 'rgba(184,153,104,0.12)',
          border: '1px solid rgba(184,153,104,0.40)', borderRadius: 2,
        }}>
          <div className="serif" style={{ fontSize: 14, color: 'var(--ink)' }}>
            <span className="italic">旧版蒸馏 schema (v0.1).</span> 本书的 Spark Pack 是浅章节摘要, 不是 v0.2 母题+深 Spark 结构.
            回 Library 撤销蒸馏后重新 Distill, 即得到深度版.
          </div>
        </div>
      )}

      {/* 全书底层公式 */}
      {pack.book_model && (
        <Section eyebrow="全书底层公式" title="本书在用什么角度看世界">
          <p className="serif" style={{ fontSize: 16, lineHeight: 1.8, color: 'var(--ink)', margin: 0 }}>
            {pack.book_model}
          </p>
        </Section>
      )}

      {/* 作者核心问题 + 论证骨架 */}
      {(pack.author_core_question || pack.overall_structure) && (
        <Section eyebrow="作者核心问题 / 论证骨架">
          {pack.author_core_question && (
            <p className="serif italic" style={{ fontSize: 15, color: 'var(--ink-1)', margin: '0 0 10px' }}>
              {pack.author_core_question}
            </p>
          )}
          {pack.overall_structure && (
            <p className="serif" style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--ink-2)', margin: 0 }}>
              {pack.overall_structure}
            </p>
          )}
        </Section>
      )}

      {/* 战略命题 — 简短锋利, 放前面让用户先看见 */}
      {Array.isArray(pack.strategic_propositions) && pack.strategic_propositions.length > 0 && (
        <Section eyebrow="最终战略命题" title="一句话提取">
          <ol style={{ margin: 0, paddingLeft: 22, color: 'var(--ink)' }}>
            {pack.strategic_propositions.map((p, i) => (
              <li key={i} className="serif" style={{ fontSize: 15, lineHeight: 1.7, marginBottom: 8 }}>
                {p}
              </li>
            ))}
          </ol>
        </Section>
      )}

      {/* 母题地图 + Sparks */}
      {Array.isArray(pack.themes) && pack.themes.length > 0 && (
        <Section eyebrow={`母题地图 · ${pack.themes.length} 母题 · ${totalSparks} Sparks`}>
          <div className="col gap-20">
            {pack.themes.map(t => (
              <ThemeBlock key={t.id || t.name} theme={t} openSparks={openSparks} onToggle={toggleSpark} />
            ))}
          </div>
        </Section>
      )}

      {/* 反向批判 — 作者 over/under/outdated/可重写 */}
      {Array.isArray(pack.anti_sparks) && pack.anti_sparks.length > 0 && (
        <Section eyebrow="反向批判 / Anti-Sparks">
          <AntiSparks items={pack.anti_sparks} />
        </Section>
      )}

      {/* 来源 + 风险 */}
      {(pack.source_note || pack.risk_and_copyright_note) && (
        <Section eyebrow="来源 · 风险 · 版权">
          {pack.source_note && (
            <p className="serif italic" style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--ink-2)', margin: '0 0 8px' }}>
              {pack.source_note}
            </p>
          )}
          {pack.risk_and_copyright_note && (
            <p className="serif italic" style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--ink-3)', margin: 0 }}>
              {pack.risk_and_copyright_note}
            </p>
          )}
        </Section>
      )}
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────────────

const Header = ({ pack, totalSparks, onExportJson, onExportMd, onExpandAll, onCollapseAll, onBack }) => (
  <div className="col gap-12">
    <div className="row gap-16" style={{ alignItems: 'baseline' }}>
      <div className="col" style={{ flex: 1 }}>
        <div className="eyebrow">Book Spark Pack · v{pack.version || '?'} · schema v{pack.schema_version || '0.1'}</div>
        <h1 className="serif" style={{ fontSize: 32, margin: '4px 0 0', fontWeight: 400, lineHeight: 1.2 }}>
          <span className="italic">蒸馏</span>{' '}{pack.book_title}
        </h1>
        {totalSparks > 0 && (
          <span className="t-small italic" style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 4 }}>
            {totalSparks} 深 Sparks 跨 {pack.themes ? pack.themes.length : 0} 母题
          </span>
        )}
      </div>
      <button onClick={onBack} className="btn btn-ghost" style={{ fontSize: 13, color: 'var(--ink-2)' }}>返回</button>
    </div>
    <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
      <button onClick={onExpandAll} className="btn btn-ghost" style={{ fontSize: 12, color: '#B89968' }}>全部展开</button>
      <button onClick={onCollapseAll} className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--ink-2)' }}>全部收起</button>
      <span style={{ flex: 1 }} />
      <button onClick={onExportMd} className="btn btn-ghost" style={{ fontSize: 12, color: '#B89968' }}>导出 Markdown</button>
      <button onClick={onExportJson} className="btn btn-ghost" style={{ fontSize: 12, color: '#B89968' }}>导出 JSON</button>
    </div>
  </div>
);

const Section = ({ eyebrow, title, children }) => (
  <div className="col gap-10">
    <div className="eyebrow" style={{ fontSize: 11, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--ink-2)' }}>
      {eyebrow}
    </div>
    {title && (
      <h2 className="serif italic" style={{ fontSize: 22, margin: 0, fontWeight: 400, color: 'var(--ink-1)' }}>
        {title}
      </h2>
    )}
    <div style={{
      padding: '16px 20px',
      background: 'var(--paper)',
      border: '1px solid var(--rule-soft)',
      borderLeft: '2px solid #B89968',
      borderRadius: 2,
    }}>
      {children}
    </div>
  </div>
);

const ThemeBlock = ({ theme, openSparks, onToggle }) => {
  const sparks = Array.isArray(theme.sparks) ? theme.sparks : [];
  return (
    <div className="col gap-10" style={{
      padding: '14px 18px',
      background: 'var(--cream)',
      border: '1px solid var(--rule-soft)',
      borderRadius: 2,
    }}>
      <div className="col gap-2">
        <span className="t-tiny" style={{ fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--ink-3)' }}>
          {theme.id || ''}
        </span>
        <h3 className="serif" style={{ fontSize: 20, margin: 0, fontWeight: 500, color: 'var(--ink)' }}>
          {theme.name}
        </h3>
        {theme.description && (
          <p className="serif italic" style={{ fontSize: 13, color: 'var(--ink-2)', margin: '4px 0 0' }}>
            {theme.description}
          </p>
        )}
      </div>
      <div className="col gap-10" style={{ marginTop: 6 }}>
        {sparks.map(s => (
          <SparkCard key={s.id || s.name} spark={s} open={openSparks.has(s.id)} onToggle={() => onToggle(s.id)} />
        ))}
      </div>
    </div>
  );
};

const SparkCard = ({ spark, open, onToggle }) => {
  return (
    <div style={{
      background: 'var(--paper)',
      border: '1px solid var(--rule-soft)',
      borderRadius: 2,
    }}>
      <button
        onClick={onToggle}
        style={{
          display: 'flex', width: '100%', alignItems: 'baseline', gap: 12,
          padding: '12px 16px', background: 'transparent', border: 'none', cursor: 'pointer',
          textAlign: 'left', borderBottom: open ? '1px solid var(--rule-soft)' : 'none',
        }}
      >
        <span className="t-tiny" style={{ fontSize: 10, color: 'var(--ink-3)', minWidth: 60 }}>
          {spark.id}
        </span>
        <span className="serif" style={{ flex: 1, fontSize: 16, color: 'var(--ink)', fontWeight: 500 }}>
          {spark.name || '(unnamed)'}
        </span>
        {spark.counterintuitive && !open && (
          <span className="serif italic" style={{
            fontSize: 12, color: 'var(--ink-2)', maxWidth: 360,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {spark.counterintuitive}
          </span>
        )}
        <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{open ? '−' : '+'}</span>
      </button>
      {open && <SparkBody spark={spark} />}
    </div>
  );
};

const SparkBody = ({ spark }) => (
  <div className="col gap-14" style={{ padding: '14px 20px 18px' }}>
    {spark.hook && <SparkField label="原文思想钩子" body={spark.hook} />}
    {Array.isArray(spark.mechanism) && spark.mechanism.length > 0 && (
      <div className="col gap-4">
        <FieldLabel label="深层机制链" />
        <ol style={{ margin: 0, paddingLeft: 22, color: 'var(--ink)' }}>
          {spark.mechanism.map((m, i) => (
            <li key={i} className="serif" style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 4 }}>
              {m}
            </li>
          ))}
        </ol>
      </div>
    )}
    {spark.counterintuitive && (
      <div className="col gap-4">
        <FieldLabel label="反常识锋刃" />
        <p className="serif italic" style={{
          fontSize: 15, lineHeight: 1.7, color: '#8B3A3A',
          margin: 0, padding: '8px 14px',
          borderLeft: '2px solid rgba(139,58,58,0.40)',
          background: 'rgba(139,58,58,0.05)',
        }}>
          {spark.counterintuitive}
        </p>
      </div>
    )}
    {spark.ai_era && <SparkField label="AI 时代反蒸馏" body={spark.ai_era} />}
    {spark.transfer && <SparkField label="对 HYPHA / 用户目标 的迁移" body={spark.transfer} />}
    {spark.experiment && (
      <div className="col gap-4">
        <FieldLabel label="可执行实验" />
        <p className="serif" style={{
          fontSize: 13, lineHeight: 1.7, color: 'var(--ink)',
          margin: 0, padding: '8px 14px',
          borderLeft: '2px solid #4D8B9A',
          background: 'rgba(77,139,154,0.06)',
          whiteSpace: 'pre-wrap',
        }}>
          {spark.experiment}
        </p>
      </div>
    )}
  </div>
);

const SparkField = ({ label, body }) => (
  <div className="col gap-4">
    <FieldLabel label={label} />
    <p className="serif" style={{
      fontSize: 13, lineHeight: 1.7, color: 'var(--ink)', margin: 0, whiteSpace: 'pre-wrap',
    }}>{body}</p>
  </div>
);

const FieldLabel = ({ label }) => (
  <span className="t-tiny" style={{
    fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase',
    color: 'var(--ink-3)', fontStyle: 'italic',
  }}>
    {label}
  </span>
);

const ANTI_KIND_LABELS = {
  overestimated: '作者高估',
  underestimated: '作者低估',
  outdated: '过时观点',
  ai_rewriteable: 'AI 时代可重写',
};

const AntiSparks = ({ items }) => {
  const grouped = items.reduce((acc, it) => {
    const k = it.kind || 'other';
    if (!acc[k]) acc[k] = [];
    acc[k].push(it.text);
    return acc;
  }, {});
  return (
    <div className="col gap-12">
      {Object.entries(grouped).map(([kind, texts]) => (
        <div key={kind} className="col gap-4">
          <FieldLabel label={ANTI_KIND_LABELS[kind] || kind} />
          <ul style={{ margin: 0, paddingLeft: 22, color: 'var(--ink)' }}>
            {texts.map((t, i) => (
              <li key={i} className="serif" style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 4 }}>
                {t}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────────────
// Markdown export — mirrors the user's gold-standard layout from
// "黑客与画家 24-Spark 深度版", so a packed Spark Pack can be pasted into
// any markdown viewer / shared as a single file.

function renderPackMarkdown(pack) {
  const lines = [];
  lines.push(`# 《${pack.book_title}》Spark Pack v${pack.version || ''}`);
  lines.push('');
  if (pack.source_note) lines.push(`> ${pack.source_note}`);
  if (pack.book_model) {
    lines.push('');
    lines.push('## 全书底层公式');
    lines.push('');
    lines.push(pack.book_model);
  }
  if (pack.author_core_question || pack.overall_structure) {
    lines.push('');
    lines.push('## 作者核心问题 / 论证骨架');
    lines.push('');
    if (pack.author_core_question) lines.push(`**${pack.author_core_question}**`);
    if (pack.overall_structure) { lines.push(''); lines.push(pack.overall_structure); }
  }
  if (Array.isArray(pack.strategic_propositions) && pack.strategic_propositions.length > 0) {
    lines.push('');
    lines.push('## 最终战略命题');
    lines.push('');
    pack.strategic_propositions.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
  }
  if (Array.isArray(pack.themes) && pack.themes.length > 0) {
    lines.push('');
    lines.push('## 母题地图');
    pack.themes.forEach((t) => {
      lines.push('');
      lines.push(`### ${t.name}`);
      if (t.description) { lines.push(''); lines.push(`*${t.description}*`); }
      (t.sparks || []).forEach((s) => {
        lines.push('');
        lines.push(`#### ${s.id} · ${s.name}`);
        if (s.hook) { lines.push(''); lines.push(`**原文思想钩子**: ${s.hook}`); }
        if (Array.isArray(s.mechanism) && s.mechanism.length > 0) {
          lines.push('');
          lines.push('**深层机制链**:');
          lines.push('');
          s.mechanism.forEach((m, i) => lines.push(`${i + 1}. ${m}`));
        }
        if (s.counterintuitive) { lines.push(''); lines.push(`**反常识锋刃**: *${s.counterintuitive}*`); }
        if (s.ai_era) { lines.push(''); lines.push(`**AI 时代反蒸馏**: ${s.ai_era}`); }
        if (s.transfer) { lines.push(''); lines.push(`**迁移**: ${s.transfer}`); }
        if (s.experiment) { lines.push(''); lines.push(`**可执行实验**: ${s.experiment}`); }
      });
    });
  }
  if (Array.isArray(pack.anti_sparks) && pack.anti_sparks.length > 0) {
    lines.push('');
    lines.push('## 反向批判 / Anti-Sparks');
    const grouped = pack.anti_sparks.reduce((acc, it) => {
      const k = it.kind || 'other';
      if (!acc[k]) acc[k] = [];
      acc[k].push(it.text);
      return acc;
    }, {});
    Object.entries(grouped).forEach(([kind, texts]) => {
      lines.push('');
      lines.push(`### ${ANTI_KIND_LABELS[kind] || kind}`);
      lines.push('');
      texts.forEach((t) => lines.push(`- ${t}`));
    });
  }
  if (pack.risk_and_copyright_note) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(`*${pack.risk_and_copyright_note}*`);
  }
  return lines.join('\n');
}

window.BookSparkPackScreen = BookSparkPackScreen;
