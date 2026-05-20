/* global React, Icon, Watercolor */
// HYPHA · Library — user knowledge source manager.
//
// Tab 1 (我的书架): list books + upload + delete. Each book row shows title +
// author + page count + chunk count + added_at. Click upload → OS file picker
// (handled by main via library:pickAndAdd). Click delete → confirm + remove.
//
// Tab 2 (Commons): v2.0+ stub. Pointer to BLUEPRINT System 6 — Knowledge Pack
// + Pack Intelligence Card + Pack Learning Mode etc. No UI surface to ship
// until platform launches; we render the spec contract here so the user knows
// what's coming without ambiguity.
//
// intentional-placeholder: Commons tab body is a spec sketch, not a stub
// awaiting implementation in this batch. Commons is v2.0+ per CLAUDE.md
// roadmap — we surface the contract today so users see the design intent.

const { useState, useEffect, useCallback } = React;

const TABS = [
  { id: 'shelf', label: '我的书架' },
  { id: 'commons', label: 'Commons · 社区知识包' },
];

const LibraryScreen = ({ onJump }) => {
  const [tab, setTab] = useState('shelf');

  return (
    <div className="col gap-20 fade-in" style={{ padding: '32px 40px 60px', maxWidth: 1100, margin: '0 auto' }}>
      <div className="row gap-16" style={{ alignItems: 'baseline' }}>
        <div className="col">
          <div className="eyebrow">Library</div>
          <h1 className="serif" style={{ fontSize: 38, margin: '4px 0 0', fontWeight: 400 }}>
            知识源 <span className="italic">书架</span>
          </h1>
          <div className="t-body" style={{ marginTop: 4 }}>上传 MD / PDF / DOCX / PPTX / XLSX / EPUB / HTML / CSV / JSON / XML — MD 直读, 其余经 <span className="italic">MarkItDown</span> 自动转换. 课程生成时按主题自动 fetch 相关 chunks 注入 harvest.</div>
        </div>
      </div>

      <div className="row gap-16" style={{ borderBottom: '1px solid var(--rule-soft)' }}>
        {TABS.map(t => (
          <button key={t.id}
            onClick={() => setTab(t.id)}
            className="btn btn-ghost"
            style={{
              padding: '8px 4px',
              fontSize: 14,
              borderBottom: tab === t.id ? '2px solid var(--ink-2)' : '2px solid transparent',
              color: tab === t.id ? 'var(--ink)' : 'var(--ink-2)',
              borderRadius: 0,
            }}>{t.label}</button>
        ))}
      </div>

      {tab === 'shelf' && <ShelfTab onJump={onJump} />}
      {tab === 'commons' && <CommonsTab />}
    </div>
  );
};

// =====================================================================
// Shelf tab — 我的书架: upload + list + delete
// =====================================================================

const ShelfTab = ({ onJump }) => {
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  // Per-file OCR / extract progress card. Updated by library:upload-progress
  // stream from main process. Cleared when upload batch finishes.
  const [progress, setProgress] = useState(null); // { file, stage, page, total, pageProgress, langs }
  // W6.2 — distilled state per book.id → bool. Populated alongside book list.
  const [distilledMap, setDistilledMap] = useState({});
  // 2026-05-14 — MarkItDown availability for the auto-convert pipeline.
  // null = checking; { available, version, error } once resolved.
  const [mdtoolStatus, setMdtoolStatus] = useState(null);

  useEffect(() => {
    if (!window.ptor || !window.ptor.hypha || typeof window.ptor.hypha.onLibraryUploadProgress !== 'function') return undefined;
    const unsub = window.ptor.hypha.onLibraryUploadProgress((payload) => {
      setProgress(payload || null);
    });
    return unsub;
  }, []);

  // Probe markitdown once on mount. If unavailable, the upload-of-PDF/DOCX
  // path will fail at extract time; surfacing the missing-tool banner up
  // front spares the user that detour.
  useEffect(() => {
    let cancelled = false;
    if (!window.ptor || !window.ptor.hypha || typeof window.ptor.hypha.markitdownStatus !== 'function') return;
    (async () => {
      try {
        const r = await window.ptor.hypha.markitdownStatus(false);
        if (!cancelled && r && r.ok) setMdtoolStatus(r);
      } catch (_) { /* best-effort */ }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!window.ptor || !window.ptor.hypha || typeof window.ptor.hypha.libraryList !== 'function') {
      setLoading(false);
      setError('bridge missing: libraryList');
      return;
    }
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const r = await window.ptor.hypha.libraryList();
        if (cancelled) return;
        if (!r || !r.ok) { setError((r && r.error) || 'list failed'); setBooks([]); return; }
        const list = Array.isArray(r.books) ? r.books : [];
        setBooks(list);
        // W6.2 — pull distilled state in parallel (best-effort; bridge may be absent)
        if (window.ptor && window.ptor.hypha && window.ptor.hypha.distill) {
          const dMap = {};
          await Promise.all(list.map(async (b) => {
            try {
              const rr = await window.ptor.hypha.distill.isDistilled(b.id);
              if (rr && rr.ok) dMap[b.id] = !!rr.distilled;
            } catch (_) { /* swallow — surfaced via empty badge */ }
          }));
          if (!cancelled) setDistilledMap(dMap);
        }
      } catch (e) {
        if (cancelled) return;
        setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [refreshTick]);

  const handleUpload = useCallback(async () => {
    if (!window.ptor || !window.ptor.hypha || typeof window.ptor.hypha.libraryPickAndAdd !== 'function') {
      setError('bridge missing: libraryPickAndAdd');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await window.ptor.hypha.libraryPickAndAdd();
      if (!r || !r.ok) {
        if (r && r.cancelled) return;
        // Compose richest message: prefer per-file errors[] over generic .error
        let msg = (r && r.error) || 'upload failed (no error message returned)';
        if (r && Array.isArray(r.errors) && r.errors.length > 0) {
          msg = r.errors.map(x => `${(x.file || '').split(/[\\/]/).pop()}: ${x.error}`).join('\n');
        }
        setError(msg);
        return;
      }
      // Partial success — some files OK, some failed. Surface both.
      if (r && Array.isArray(r.errors) && r.errors.length > 0) {
        const failMsg = r.errors.map(x => `${(x.file || '').split(/[\\/]/).pop()}: ${x.error}`).join('\n');
        setError('部分失败:\n' + failMsg);
      }
      setRefreshTick(t => t + 1);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, []);

  const handleDelete = useCallback(async (id, title) => {
    if (!window.confirm(`删除 "${title}"? 原文件 + chunks 都会从 library 移除.`)) return;
    setBusy(true);
    try {
      const r = await window.ptor.hypha.libraryRemove(id);
      if (!r || !r.ok) {
        setError((r && r.error) || 'remove failed');
        return;
      }
      setRefreshTick(t => t + 1);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="col gap-16">
      <MarkItDownBanner status={mdtoolStatus} onRecheck={async () => {
        const r = await window.ptor.hypha.markitdownStatus(true);
        if (r && r.ok) setMdtoolStatus(r);
      }} />
      <div className="row gap-12" style={{ alignItems: 'baseline' }}>
        <span className="t-small" style={{ color: 'var(--ink-2)' }}>
          {loading ? 'loading…' : `${books.length} 本`}
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={handleUpload} disabled={busy} className="btn btn-primary"
          style={{ fontSize: 13, opacity: busy ? 0.5 : 1 }}>
          <Icon name="plus" size={13} /> 上传书
        </button>
      </div>

      {error && (
        <div style={{ padding: '10px 14px', background: 'rgba(139,58,58,0.08)', border: '1px solid rgba(139,58,58,0.3)', borderRadius: 2, fontSize: 13, color: '#8B3A3A', whiteSpace: 'pre-wrap' }}>
          {error}
        </div>
      )}

      {progress && progress.stage && progress.stage !== 'done' && progress.stage !== 'error' && (
        <UploadProgressCard p={progress} />
      )}

      {!loading && books.length === 0 && !error && (
        <div className="col gap-8" style={{
          padding: '32px 24px', background: 'var(--cream)',
          border: '1px dashed var(--rule-soft)', borderRadius: 2,
          textAlign: 'center', color: 'var(--ink-2)', fontStyle: 'italic',
        }}>
          书架空空. 点 "上传书" 加 .md / .markdown / .txt — PDF 先用 calibre 转 MD.
        </div>
      )}

      <div className="col gap-8">
        {books.map(b => (
          <div key={b.id} className="row gap-16" style={{
            padding: '14px 18px',
            background: 'var(--paper)',
            border: '1px solid var(--rule-soft)',
            borderLeft: '2px solid #4D8B9A',
            borderRadius: 2,
            alignItems: 'baseline',
          }}>
            <div className="col gap-2" style={{ flex: 1, minWidth: 0 }}>
              <span className="serif" style={{ fontSize: 17, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {b.title}
              </span>
              <span className="t-tiny" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                {b.author && <span>{b.author} · </span>}
                {b.type && <span>{b.type.toUpperCase()} · </span>}
                {b.page_count > 0 && <span>{b.page_count} 页 · </span>}
                {b.chunk_count} chunk · {(b.char_count || 0).toLocaleString()} 字
              </span>
              {b.added_at && (
                <span className="t-tiny" style={{ fontSize: 10, color: 'var(--ink-3)', opacity: 0.7 }}>
                  added {b.added_at.slice(0, 10)}
                </span>
              )}
            </div>
            {/* W6.2 Distillation affordances — badge if distilled, Distill button always */}
            {distilledMap[b.id] && (
              <span className="t-tiny italic"
                title="此书已完成 7 阶段蒸馏 — Book Spark Pack 可用"
                style={{
                  fontSize: 11, color: '#2F5762',
                  padding: '2px 8px',
                  background: 'rgba(77,139,154,0.10)',
                  border: '1px solid rgba(77,139,154,0.30)',
                  borderRadius: 2,
                }}>已蒸馏</span>
            )}
            <button
              onClick={() => onJump && onJump({ screen: 'book-reader', bookId: b.id, bookTitle: b.title })}
              disabled={busy}
              className="btn btn-ghost"
              title="MD 阅读模式 · 章节侧栏"
              style={{ fontSize: 12, color: 'var(--ink-2)' }}>
              阅读
            </button>
            <button
              onClick={() => onJump && onJump(distilledMap[b.id]
                ? { screen: 'book-spark-pack', bookId: b.id, bookTitle: b.title }
                : { screen: 'distillation-progress', bookId: b.id, bookTitle: b.title })}
              disabled={busy}
              className="btn btn-ghost"
              title={distilledMap[b.id] ? '查看 Book Spark Pack' : '启动 7 阶段蒸馏'}
              style={{ fontSize: 12, color: '#B89968' }}>
              {distilledMap[b.id] ? '查看蒸馏' : 'Distill'}
            </button>
            {distilledMap[b.id] && (
              <button
                onClick={async () => {
                  if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.distill || !window.ptor.hypha.distill.clear) return;
                  const ok = window.confirm(`撤销「${b.title}」的蒸馏？\n\n7 个阶段的缓存将被清除，下次 Distill 会重新跑（重新消耗 T6 token）。`);
                  if (!ok) return;
                  setBusy(true);
                  try {
                    const r = await window.ptor.hypha.distill.clear(b.id);
                    if (!r || !r.ok) { setError((r && r.error) || 'clear failed'); return; }
                    setDistilledMap((m) => { const n = { ...m }; delete n[b.id]; return n; });
                  } catch (e) { setError(e.message || String(e)); }
                  finally { setBusy(false); }
                }}
                disabled={busy}
                className="btn btn-ghost"
                title="清除蒸馏缓存; 下次 Distill 重新跑"
                style={{ fontSize: 12, color: 'var(--ink-3, #888)' }}>
                撤销
              </button>
            )}
            <button onClick={() => handleDelete(b.id, b.title)} disabled={busy}
              className="btn btn-ghost" style={{ fontSize: 12, color: '#8B3A3A' }}>
              删除
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

// MarkItDown availability banner — shown above the upload row. Green-ish
// when ready (with version); brass when missing (with install command).
// 2026-05-14 — keeps the upload friction visible BEFORE the user picks a
// PDF and hits "markitdown not installed" mid-flow.
const MarkItDownBanner = ({ status, onRecheck }) => {
  if (!status) return null; // still probing
  if (status.available) {
    return (
      <div className="row gap-10" style={{
        padding: '8px 14px', background: 'rgba(77,139,154,0.08)',
        border: '1px solid rgba(77,139,154,0.30)', borderRadius: 2,
        fontSize: 12, color: '#2F5762', alignItems: 'center',
      }}>
        <span className="italic">MarkItDown 已就绪</span>
        {status.version && <span style={{ color: 'var(--ink-3)', fontSize: 11 }}>· {status.version}</span>}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
          可上传 {(status.acceptedExtensions || []).join(' / ')}
        </span>
      </div>
    );
  }
  return (
    <div className="col gap-6" style={{
      padding: '10px 14px', background: 'rgba(184,153,104,0.12)',
      border: '1px solid rgba(184,153,104,0.40)', borderRadius: 2,
    }}>
      <div className="row gap-8" style={{ alignItems: 'baseline' }}>
        <span className="serif italic" style={{ fontSize: 13, color: 'var(--ink-1)' }}>
          MarkItDown 未检测到 — PDF / DOCX / PPTX / XLSX / EPUB 自动转换不可用
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={onRecheck} className="btn btn-ghost"
          style={{ fontSize: 11, color: '#B89968' }}>重新检测</button>
      </div>
      <div className="serif" style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.7 }}>
        装一次, 永久生效. 需 Python 3.10+:
      </div>
      <pre style={{
        margin: '2px 0 0', padding: '6px 10px',
        background: 'var(--cream)', border: '1px solid var(--rule-soft)',
        borderRadius: 2, fontSize: 12, fontFamily: 'ui-monospace, monospace',
        color: 'var(--ink)', overflowX: 'auto',
      }}>{'pip install "markitdown[all]"'}</pre>
      {status.error && (
        <div className="t-tiny italic" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
          probe: {status.error}
        </div>
      )}
    </div>
  );
};

// Upload progress card — surfaces OCR per-page state for scanned PDFs
const UploadProgressCard = ({ p }) => {
  if (!p) return null;
  const fileIdxLabel = (Number.isFinite(p.fileIdx) && Number.isFinite(p.totalFiles) && p.totalFiles > 1)
    ? `(${p.fileIdx + 1}/${p.totalFiles}) ` : '';
  let stageLabel = p.stage;
  let detail = '';
  if (p.stage === 'load') stageLabel = '读 PDF';
  else if (p.stage === 'loaded') stageLabel = `PDF 已读 · ${p.total} 页`;
  else if (p.stage === 'tesseract-init') { stageLabel = 'OCR 初始化'; detail = '准备语言包...'; }
  else if (p.stage === 'lang-download-start') { stageLabel = '下载语言包'; detail = `${p.lang}.traineddata.gz — ${p.lang === 'chi_sim' ? '~52MB' : '~4MB'}`; }
  else if (p.stage === 'lang-downloading') {
    const mb = (n) => (n / 1024 / 1024).toFixed(1);
    stageLabel = `下载 ${p.lang}`;
    detail = p.total > 0 ? `${mb(p.received)} / ${mb(p.total)} MB (${Math.round(p.pageProgress * 100)}%)` : `${mb(p.received)} MB`;
  }
  else if (p.stage === 'lang-download-done') { stageLabel = `${p.lang} 下载完`; detail = '语言包已缓存, 下次免重新下载'; }
  else if (p.stage === 'lang-cached') { stageLabel = `${p.lang} 已缓存`; detail = '从本地加载'; }
  else if (p.stage === 'rasterize') { stageLabel = '渲染页面'; detail = `第 ${p.page} / ${p.total} 页`; }
  else if (p.stage === 'ocr') { stageLabel = 'OCR 识字'; detail = `第 ${p.page} / ${p.total} 页`; }
  else if (p.stage === 'recognizing' && typeof p.pageProgress === 'number') { stageLabel = 'OCR 进行中'; detail = `当前页 ${Math.round(p.pageProgress * 100)}%`; }
  else if (p.stage === 'page-done') { stageLabel = '页完成'; detail = `${p.page} / ${p.total} 页`; }
  else if (p.stage === 'start') stageLabel = '开始处理';
  // 2026-05-14 — MarkItDown auto-convert stages emitted by markitdown-bridge.
  else if (p.stage === 'markitdown-start') { stageLabel = 'MarkItDown 转换中'; detail = p.message || ''; }
  else if (p.stage === 'markitdown-done')  { stageLabel = 'MarkItDown 完成'; detail = p.message || ''; }

  // Per-stage progress rule (2026-05-13 fix): init / load / download-start
  // stages have NO meaningful page% — emitting "0%" looks like the app froze.
  // Only show a number when the stage actually carries progress.
  let pct = null;
  if (p.stage === 'lang-downloading' && typeof p.pageProgress === 'number') {
    pct = Math.round(p.pageProgress * 100);
  } else if (p.stage === 'recognizing' && typeof p.pageProgress === 'number') {
    pct = Math.round(p.pageProgress * 100);
  } else if ((p.stage === 'rasterize' || p.stage === 'ocr' || p.stage === 'page-done') && p.total > 0 && Number.isFinite(p.page)) {
    pct = Math.round((p.page / p.total) * 100);
  }
  // Stages that should show an indeterminate animation rather than dead "0%".
  const indeterminate = pct === null && ['start', 'load', 'loaded', 'tesseract-init', 'lang-download-start', 'lang-download-done', 'lang-cached'].includes(p.stage);

  return (
    <div className="col gap-8" style={{
      padding: '12px 16px',
      background: 'rgba(166,109,44,0.08)',
      border: '1px solid rgba(166,109,44,0.3)',
      borderLeft: '2px solid #A66D2C',
      borderRadius: 2,
      fontFamily: 'EB Garamond, "Noto Serif SC", serif',
    }}>
      <style>{`@keyframes hypha-indeterminate-slide {
        0% { left: -30%; }
        100% { left: 100%; }
      }`}</style>
      <div className="row gap-12" style={{ alignItems: 'baseline' }}>
        <span className="eyebrow" style={{ fontSize: 11, color: '#A66D2C', letterSpacing: '0.1em' }}>
          {fileIdxLabel}{stageLabel.toUpperCase()}
        </span>
        <span style={{ flex: 1, fontSize: 12, color: 'var(--ink-2)', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {p.file || ''}
        </span>
        {pct !== null
          ? <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{pct}%</span>
          : indeterminate && <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>···</span>}
      </div>
      {detail && (
        <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>{detail}</div>
      )}
      {pct !== null ? (
        <div style={{ height: 4, background: 'rgba(166,109,44,0.15)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: '#A66D2C', transition: 'width 0.3s' }} />
        </div>
      ) : indeterminate ? (
        <div style={{ height: 4, background: 'rgba(166,109,44,0.15)', borderRadius: 2, overflow: 'hidden', position: 'relative' }}>
          <div style={{
            position: 'absolute', top: 0, height: '100%',
            width: '30%', background: '#A66D2C',
            left: '-30%',
            animation: 'hypha-indeterminate-slide 1.4s ease-in-out infinite',
          }} />
        </div>
      ) : null}
    </div>
  );
};

// =====================================================================
// Commons tab — v2.0+ spec sketch
// =====================================================================

// R-LIB Day 6 (2026-05-12) — Commons v0.1 pack browser. Reads bundled +
// user-installed packs via commons:listPacks IPC. v0.1 ship = bundled-only
// (read-only); install-from-GitHub flow deferred per Day 6 plan (v0.2 ladder).
// The 6-item spec sketch is preserved at the bottom as the v2.0 roadmap.

// W6.5 Commons full — 4 indicator badges per pack row.
// Safety: safe (brass) / caution (amber) / unsafe (oxblood) / blocked (red border).
const _safetyStyle = (level) => {
  switch (level) {
    case 'safe':    return { color: '#5C7148', label: '安全' };
    case 'caution': return { color: '#A66D2C', label: '注意' };
    case 'unsafe':  return { color: '#A35F47', label: '不安全' };
    case 'blocked': return { color: '#7A2E1F', label: '已封禁', border: true };
    default:        return { color: 'var(--ink-3)', label: '未扫' };
  }
};

const _licenseHint = (lic) => {
  if (!lic) return '未识别';
  if (lic.license === 'CC0') return 'CC0';
  return lic.license;
};

// Inline 5-factor trust spark — 5 vertical bars 0..1.
const TrustSpark = ({ signals }) => {
  if (!signals) return null;
  const keys = ['author_pubkey', 'ratified_by_count', 'age_months', 'citations_count', 'source_reputation'];
  return (
    <span style={{ display: 'inline-flex', gap: 2, alignItems: 'flex-end', height: 14, marginLeft: 6 }}>
      {keys.map((k, i) => {
        const v = Math.max(0, Math.min(1, Number(signals[k]) || 0));
        return (
          <span key={i} title={`${k}: ${v.toFixed(2)}`} style={{
            display: 'inline-block', width: 3, height: Math.max(2, Math.round(v * 14)),
            background: '#8B6A4D', opacity: 0.4 + (0.6 * v),
          }} />
        );
      })}
    </span>
  );
};

const CommonsTab = () => {
  const [packs, setPacks] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [cardsByPack, setCardsByPack] = React.useState({});

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = (window.ptor && window.ptor.commonsListPacks) ? await window.ptor.commonsListPacks() : null;
        if (cancelled) return;
        if (res && res.ok) {
          setPacks(res.packs || []);
          setError(null);
        } else {
          setError((res && res.error) || '无法读取 packs');
        }
      } catch (e) {
        if (!cancelled) setError(e && e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Lazy-load 15-field PIC card on details expand. Cached per-pack id.
  const _loadCard = React.useCallback(async (pack) => {
    if (cardsByPack[pack.id]) return;
    const ctx = { goal: '', safetyLevel: pack._safety_level || 'safe' };
    try {
      const res = await (window.ptor && window.ptor.commons && window.ptor.commons.generateCard
        ? window.ptor.commons.generateCard(pack, ctx) : null);
      if (res && res.ok) {
        setCardsByPack((prev) => Object.assign({}, prev, { [pack.id]: res.card }));
      }
    } catch (_) { /* UI falls back to legacy summary */ }
  }, [cardsByPack]);

  return (
    <div className="col gap-20" style={{ maxWidth: 720 }}>
      <div className="t-small" style={{ color: 'var(--ink-3)', fontStyle: 'italic' }}>
        Commons · 社区知识包 · v0.1 (R-LIB 2026-05-12) · curated GitHub packs
      </div>

      {/* Pack browser — v0.1 ship */}
      <div className="col gap-12">
        <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em' }}>
          可用包 · {loading ? '加载中...' : packs.length}
        </div>
        {error && (
          <div className="t-small" style={{ color: '#A35F47' }}>读取失败: {error}</div>
        )}
        {!loading && !error && packs.length === 0 && (
          <div className="t-small" style={{ color: 'var(--ink-3)', fontStyle: 'italic' }}>
            暂无可用包. v0.1 ships bundled stubs; 自定义包请走 hypha-org/hypha-packs PR.
          </div>
        )}
        {packs.map((pack) => {
          const ratifiedCount = Array.isArray(pack.ratified_by) ? pack.ratified_by.length : 0;
          const isStale = pack.ratified_at && (Date.now() - Date.parse(pack.ratified_at)) > (12 * 30 * 24 * 60 * 60 * 1000);
          const syllabusN = Array.isArray(pack.syllabus_skeleton) ? pack.syllabus_skeleton.length : 0;
          const sourcesN = Array.isArray(pack.recommended_sources) ? pack.recommended_sources.length : 0;
          const contestedN = Array.isArray(pack.contested_questions) ? pack.contested_questions.length : 0;
          return (
            <div key={pack.id} className="col gap-6" style={{
              padding: '14px 18px',
              borderLeft: '2px solid #8B6A4D',
              background: 'rgba(139,106,77,0.04)',
            }}>
              <div className="row gap-8" style={{ alignItems: 'baseline' }}>
                <span className="serif" style={{ fontSize: 16, color: 'var(--ink)' }}>{pack.topic}</span>
                <span className="t-tiny mono" style={{ color: 'var(--ink-3)' }}>· {pack.id} · {pack.lang}</span>
                {isStale && <span className="t-tiny mono" style={{ color: '#A35F47' }}>[stale &gt;12mo]</span>}
                <span className="t-tiny" style={{ marginLeft: 'auto', color: 'var(--ink-3)' }}>
                  {pack._source === 'user' ? '本地' : '内置'}
                </span>
              </div>
              <div className="t-tiny mono" style={{ color: 'var(--ink-3)' }}>
                curator: {pack.curator || '未知'} · ratified: {ratifiedCount}
                {pack.ratified_at && ` · ${pack.ratified_at}`}
              </div>
              <div className="t-small" style={{ color: 'var(--ink-2)' }}>
                {syllabusN} 章节 / {sourcesN} 推荐源 / {contestedN} 争议问题
              </div>

              {/* W6.5 — 4 indicators: safety badge / trust score+spark / license / recommendation reason */}
              {(() => {
                const safety = _safetyStyle(pack._safety_level);
                const trust = pack._trust;
                const license = pack._license;
                const trustScore = trust && Number.isFinite(trust.score) ? trust.score : null;
                return (
                  <div className="col gap-4" style={{
                    marginTop: 2,
                    paddingTop: 6,
                    borderTop: '1px dashed var(--rule-soft)',
                    ...(safety.border ? { boxShadow: 'inset 0 0 0 1px #7A2E1F' } : {}),
                  }}>
                    <div className="row gap-12" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                      <span className="t-tiny mono" title={`safety_level=${pack._safety_level || 'unscanned'}`}
                        style={{ color: safety.color, letterSpacing: '.06em' }}>
                        {'⏵ 安全 · '}{safety.label}
                      </span>
                      {trustScore != null && (
                        <span className="t-tiny mono"
                          title={'信任源 5 因子加权 0-100'}
                          style={{ color: 'var(--ink-2)' }}>
                          {'⏵ 信任 · '}{trustScore}
                          <TrustSpark signals={trust.signals} />
                        </span>
                      )}
                      <span className="t-tiny mono"
                        title={license && license.summary}
                        style={{ color: 'var(--ink-2)' }}>
                        {'⏵ 许可 · '}{_licenseHint(license)}
                      </span>
                    </div>
                    {/* Recommendation reason — 1 sentence */}
                    {cardsByPack[pack.id] && cardsByPack[pack.id].why_for_you && (
                      <div className="t-tiny" style={{ color: 'var(--ink-3)', fontStyle: 'italic' }}>
                        {cardsByPack[pack.id].why_for_you}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* 15-field Pack Intelligence Card — lazy load */}
              <details onToggle={(e) => { if (e.currentTarget.open) _loadCard(pack); }}>
                <summary className="t-tiny mono" style={{ color: '#8B6A4D', cursor: 'pointer', letterSpacing: '.06em' }}>
                  展开 Pack Intelligence Card · 15 字段
                </summary>
                {(() => {
                  const card = cardsByPack[pack.id];
                  if (!card) {
                    return <div className="t-tiny" style={{ color: 'var(--ink-3)', paddingLeft: 12, marginTop: 6, fontStyle: 'italic' }}>载入中...</div>;
                  }
                  const row = (label, value) => (
                    <div key={label} className="col gap-2" style={{ paddingBottom: 4 }}>
                      <div className="t-tiny mono" style={{ color: '#8B6A4D', letterSpacing: '.06em' }}>{label}</div>
                      <div className="t-small" style={{ color: 'var(--ink-2)' }}>
                        {Array.isArray(value) ? (
                          <ul style={{ margin: 0, paddingLeft: 18 }}>
                            {value.map((v, vi) => <li key={vi}>{v}</li>)}
                          </ul>
                        ) : String(value)}
                      </div>
                    </div>
                  );
                  return (
                    <div className="col gap-4" style={{ paddingLeft: 12, marginTop: 6 }}>
                      {row('推荐科目', card.recommended_subject)}
                      {row('适合人群', card.audience)}
                      {row('推荐场景', card.recommended_scenes)}
                      {row('主要价值', card.primary_value)}
                      {row('不适合谁', card.not_for)}
                      {row('前置知识', card.prerequisites)}
                      {row('难度等级', card.difficulty_level)}
                      {row('认知负荷', card.cognitive_load)}
                      {row('稳定性', card.stability_tag)}
                      {row('风险与缺陷', card.risks_and_defects)}
                      {row('使用方式', card.usage_method)}
                      {row('质量评分', `${card.quality_score} / 100`)}
                      {row('安全等级', card.safety_level)}
                      {row('为什么推荐', card.why_for_you)}
                      {row('可迁移到', card.transferable_to)}
                    </div>
                  );
                })()}
              </details>

              <details>
                <summary className="t-tiny mono" style={{ color: 'var(--ink-3)', cursor: 'pointer', letterSpacing: '.06em' }}>
                  展开 内容
                </summary>
                <div className="col gap-8" style={{ paddingLeft: 12, marginTop: 6 }}>
                  {syllabusN > 0 && (
                    <div className="col gap-4">
                      <div className="t-tiny mono" style={{ color: '#8B6A4D' }}>章节</div>
                      <ul className="col gap-2" style={{ paddingLeft: 18, margin: 0 }}>
                        {pack.syllabus_skeleton.map((c, ci) => (
                          <li key={ci} className="t-small" style={{ color: 'var(--ink-2)' }}>
                            {c.chapter}
                            {Array.isArray(c.kp_candidates) && c.kp_candidates.length > 0 && (
                              <span className="t-tiny" style={{ marginLeft: 6, color: 'var(--ink-3)' }}>· {c.kp_candidates.join(', ')}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {sourcesN > 0 && (
                    <div className="col gap-4">
                      <div className="t-tiny mono" style={{ color: '#8B6A4D' }}>推荐源</div>
                      <ul className="col gap-2" style={{ paddingLeft: 18, margin: 0 }}>
                        {pack.recommended_sources.map((s, si) => (
                          <li key={si} className="t-small" style={{ color: 'var(--ink-2)' }}>
                            <span>{s.title || s.url}</span>
                            <span className="t-tiny mono" style={{ marginLeft: 6, color: 'var(--ink-3)' }}>[{s.type}]</span>
                            {s.reason && <span className="t-tiny" style={{ marginLeft: 6, color: 'var(--ink-3)', fontStyle: 'italic' }}>· {s.reason}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {contestedN > 0 && (
                    <div className="col gap-4">
                      <div className="t-tiny mono" style={{ color: '#8B6A4D' }}>争议问题 (CHALLENGE seed)</div>
                      <ul className="col gap-2" style={{ paddingLeft: 18, margin: 0 }}>
                        {pack.contested_questions.map((q, qi) => (
                          <li key={qi} className="t-small" style={{ color: 'var(--ink-2)' }}>{q}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </details>
            </div>
          );
        })}
      </div>

      {/* v2.0 roadmap — preserved 6-item spec sketch */}
      <details style={{ marginTop: 18 }}>
        <summary className="t-tiny mono" style={{ color: 'var(--ink-3)', cursor: 'pointer', letterSpacing: '.06em' }}>
          v2.0 路线 · BLUEPRINT System 6 (6-item spec)
        </summary>
        <div className="col gap-12" style={{
          padding: '22px 26px',
          marginTop: 8,
          background: 'var(--cream)',
          border: '1px solid var(--rule-soft)',
          borderLeft: '2px solid #A66D2C',
          borderRadius: 2,
          fontFamily: 'EB Garamond, "Noto Serif SC", serif',
        }}>
          <h3 className="serif" style={{ fontSize: 18, margin: 0, fontWeight: 400 }}>
            知识包将含 6 件事
          </h3>
          <ul style={{ margin: 0, paddingLeft: 22, fontSize: 14, lineHeight: 1.65, color: 'var(--ink)' }}>
            <li><strong>Pack Intelligence Card</strong> — 这个包教什么 / 用谁的视角 / 多深</li>
            <li><strong>Pack Learning Mode</strong> — 与本地 vault 融合还是隔离学习</li>
            <li><strong>Pack Security Layer</strong> — 不允包内 prompt 越权改你 vault</li>
            <li><strong>Pack Distiller</strong> — 蒸馏 corpus 不直接搬原文 (版权 + 信号密度)</li>
            <li><strong>Source Trust</strong> — 引用源是否 1 手 / 是否被反驳过</li>
            <li><strong>License</strong> — 包作者的署名 + 商业条款</li>
          </ul>
          <div className="t-body" style={{ color: 'var(--ink-2)' }}>
            v0.1 (今) = 只读 bundled + GitHub PR 投稿. v2.0 (未) = pack distiller + security layer + license enforcement.
          </div>
        </div>
      </details>
    </div>
  );
};

window.LibraryScreen = LibraryScreen;
