/* global React */
// HYPHA · LibraryGateScreen — Phase E.0/E.1 (2026-05-18)
//
// 创课前 GATE: 用户填完 onboarding, 路由 (single/chain) 已定, 但 chain:create /
// curriculumCreate 调用之前. main.js library:coverage IPC 返回:
//   - has_coverage = true  → 直接跳过 gate, 进 chain:create
//   - has_coverage = false → 显本屏: recommended books + 上传/跳过 fork
//
// 用户决定:
//   - 跳过 → 走原 chain:create / curriculumCreate (LLM 走 training-cutoff, AMD-MEOW-P7 警告)
//   - 上传 → libraryPickAndAdd (复用现 IPC) → onLibraryUploadProgress → 完成后
//            主动 re-coverage 一次 (或就让 user 点"继续"信任), 进 chain:create
//
// Register: italic Garamond + brass hairlines + cream paper. ! SaaS gushing.
// 文案 ! gamification ("3 本上传, 解锁高品质!" 等禁).

const { useState, useEffect, useCallback } = React;

window.LibraryGateScreen = function LibraryGateScreen({
  goal,
  archetype,
  coverage,
  recommended,
  onSkip,
  onContinueAfterUpload,
  onCancel,
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [uploadedBooks, setUploadedBooks] = useState([]);
  const [uploadErr, setUploadErr] = useState('');

  // Subscribe to upload progress stream for the visible activity feedback.
  useEffect(() => {
    if (!window.ptor || !window.ptor.hypha || typeof window.ptor.hypha.onLibraryUploadProgress !== 'function') return;
    const off = window.ptor.hypha.onLibraryUploadProgress((p) => {
      setUploadProgress(p || null);
    });
    return () => { try { off && off(); } catch (_) {} };
  }, []);

  const handlePick = useCallback(async () => {
    setUploadErr('');
    if (!window.ptor || !window.ptor.hypha || typeof window.ptor.hypha.libraryPickAndAdd !== 'function') {
      setUploadErr('library 上传通道未连接 — 重启 HYPHA 后重试');
      return;
    }
    setUploading(true);
    try {
      const r = await window.ptor.hypha.libraryPickAndAdd();
      // Bug A fix 2026-05-18: user cancelling the file picker returns
      // {ok:false, cancelled:true} — should NOT surface as "上传失败" toast.
      if (r && r.cancelled) {
        return; // silent abort
      }
      if (r && r.ok && Array.isArray(r.books)) {
        setUploadedBooks((prev) => [...prev, ...r.books]);
      } else if (r && !r.ok) {
        setUploadErr(r.error || '上传失败');
      }
    } catch (err) {
      setUploadErr((err && err.message) || String(err));
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  }, []);

  const books = (recommended && Array.isArray(recommended.books)) ? recommended.books : [];
  const confidence = (recommended && Number.isFinite(recommended.confidence)) ? recommended.confidence : 0;
  const notes = (recommended && typeof recommended.notes === 'string') ? recommended.notes : '';
  const hitCount = (coverage && Number.isFinite(coverage.hit_count)) ? coverage.hit_count : 0;
  const totalBooks = (coverage && Number.isFinite(coverage.total_library_books)) ? coverage.total_library_books : 0;

  // 千金 register inline styles (sparing — most styling via .card-quiet / .serif)
  const wrapStyle = {
    maxWidth: 760,
    margin: '0 auto',
    padding: '48px 32px',
    display: 'flex',
    flexDirection: 'column',
    gap: 28,
  };

  const eyebrowStyle = {
    fontSize: 11,
    letterSpacing: '.14em',
    color: 'var(--ink-3)',
    textTransform: 'uppercase',
    fontFamily: 'var(--mono)',
  };

  const headerStyle = {
    fontFamily: 'var(--serif)',
    fontStyle: 'italic',
    fontSize: 28,
    fontWeight: 400,
    color: 'var(--ink)',
    lineHeight: 1.3,
  };

  const goalQuoteStyle = {
    fontFamily: 'var(--serif)',
    fontStyle: 'italic',
    fontSize: 18,
    color: 'var(--ink-2)',
    paddingLeft: 16,
    borderLeft: '2px solid var(--ochre-2)',
    margin: '4px 0',
  };

  return (
    <div style={wrapStyle}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={eyebrowStyle}>Library Gate</div>
        <div style={headerStyle}>Your Library is light on this goal.</div>
        <div style={goalQuoteStyle}>{goal || '(no goal)'}</div>
        <div style={{ fontSize: 13, color: 'var(--ink-3)', fontFamily: 'var(--sans)', marginTop: 4 }}>
          检索: <strong>{hitCount}</strong> 个相关 chunk · 共 {totalBooks} 本书在你的 Library。
          {hitCount === 0 && totalBooks === 0
            ? ' Library 是空的, 先放几本上去会让课程结构稳很多。'
            : ' 数量不足以稳住生成 (建议 ≥ 2 本 + 5 chunks)。'}
        </div>
      </div>

      <div className="card-quiet" style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <div style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 19 }}>
            推荐的几本基准书
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)', letterSpacing: '.08em' }}>
            confidence: {confidence ? confidence.toFixed(2) : '—'}
          </div>
        </div>

        {books.length === 0 ? (
          <div style={{ fontSize: 13.5, color: 'var(--ink-3)', fontFamily: 'var(--serif)', fontStyle: 'italic' }}>
            {notes || '目标对应的 canonical 书目暂时无法 confident 推荐 — 你可以自己上传任何相关材料。'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {books.map((b, i) => (
              <BookCard key={`${b.title}-${i}`} book={b} />
            ))}
          </div>
        )}

        {notes && books.length > 0 && (
          <div style={{ fontSize: 12, color: 'var(--ink-3)', fontFamily: 'var(--serif)', fontStyle: 'italic', borderTop: '1px solid var(--rule-soft, var(--rule))', paddingTop: 12 }}>
            {notes}
          </div>
        )}
      </div>

      <div className="card-quiet" style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 19 }}>
          上传到 Library
        </div>
        <div style={{ fontSize: 13, color: 'var(--ink-3)', fontFamily: 'var(--sans)' }}>
          PDF / EPUB / DOCX / TXT / MD / HTML — 自动转 Markdown 索引。需 Python 3.10+ 与 markitdown (一次性: <code style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>pip install "markitdown[all]"</code>)。
        </div>

        {uploadedBooks.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
            <div style={{ fontSize: 11, color: 'var(--ink-3)', fontFamily: 'var(--mono)', letterSpacing: '.06em' }}>
              本次已上传 · {uploadedBooks.length} · <span style={{ color: 'var(--ochre-2)' }}>已写入 Library 持久化</span>
            </div>
            {uploadedBooks.map((b, i) => (
              <div key={`${b.id || b.title}-${i}`} style={{ fontSize: 13, fontFamily: 'var(--serif)', color: 'var(--ink)' }}>
                · {b.title || b.source_file_name || '(untitled)'}
                {b.author ? <span style={{ color: 'var(--ink-3)' }}> · {b.author}</span> : null}
                {b.parsed_level ? (
                  <span style={{
                    marginLeft: 10,
                    fontSize: 10.5,
                    fontFamily: 'var(--mono)',
                    color: b.parsed_level === 'native' ? 'var(--ochre-2)' : b.parsed_level === 'markitdown' ? 'var(--ink-2)' : 'var(--ink-3)',
                    letterSpacing: '.06em',
                  }}>
                    · {b.parsed_level === 'native' ? '原生快路径'
                       : b.parsed_level === 'ocr' ? 'OCR 扫描提取'
                       : b.parsed_level === 'markitdown' ? 'markitdown'
                       : b.parsed_level === 'raw-extract' ? '降级文字提取'
                       : b.parsed_level === 'raw-stash' ? '原文件 stash · 暂无 chunks'
                       : b.parsed_level === 'cached' ? '已缓存 (此前转换过)'
                       : b.parsed_level === 'unknown' ? '已存档'
                       : b.parsed_level}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {uploadProgress && uploadProgress.file && (
          <div style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--ink-2)', marginTop: 4 }}>
            {_stageLabel(uploadProgress.stage)} · {uploadProgress.file}
            {Number.isFinite(uploadProgress.percent) ? ` · ${Math.round(uploadProgress.percent)}%` : ''}
          </div>
        )}

        {uploadErr && (
          <div style={{ fontSize: 12.5, color: 'var(--err, #b54)', fontFamily: 'var(--serif)', fontStyle: 'italic' }}>
            {uploadErr}
          </div>
        )}

        <button
          type="button"
          onClick={handlePick}
          disabled={uploading}
          style={{
            marginTop: 8,
            padding: '10px 22px',
            border: '1px solid var(--ochre-2)',
            background: uploading ? 'rgba(180,140,80,.08)' : 'rgba(180,140,80,.12)',
            color: 'var(--ink)',
            fontFamily: 'var(--serif)',
            fontStyle: 'italic',
            fontSize: 15,
            borderRadius: 6,
            cursor: uploading ? 'progress' : 'pointer',
            alignSelf: 'flex-start',
          }}
        >
          {uploading ? '上传中…' : '选文件上传'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', flexWrap: 'wrap', marginTop: 4 }}>
        <button
          type="button"
          onClick={onCancel}
          style={{
            padding: '8px 18px',
            background: 'transparent',
            border: '1px solid var(--rule-soft, var(--rule))',
            color: 'var(--ink-3)',
            fontFamily: 'var(--serif)',
            fontStyle: 'italic',
            fontSize: 14,
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          返回修改目标
        </button>

        {/* G.1 (2026-05-18) — user lock: 删 "跳过, 直接生成" 按钮, 与 0-本继续语义重叠.
            "继续生成" always enabled, 3 态 label: 0 本 / 1 本 / N 本. 0 本走 onSkip
            (后端 ! 改, 仅 UI 收敛). */}
        <button
          type="button"
          onClick={() => {
            if (uploadedBooks.length === 0) {
              onSkip();
            } else {
              onContinueAfterUpload(uploadedBooks);
            }
          }}
          style={{
            padding: '10px 22px',
            background: 'var(--ink)',
            color: 'var(--paper)',
            border: '1px solid var(--ink)',
            fontFamily: 'var(--serif)',
            fontStyle: 'italic',
            fontSize: 15,
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          {uploadedBooks.length === 0
            ? '继续生成 · 用现有 Library'
            : uploadedBooks.length === 1
              ? '继续, 加上这 1 本'
              : `继续, 加上这 ${uploadedBooks.length} 本`}
        </button>
      </div>
    </div>
  );
};

function BookCard({ book }) {
  const isPrimary = book.category === 'primary';
  return (
    <div style={{
      padding: '14px 16px',
      borderLeft: `3px solid ${isPrimary ? 'var(--ochre-2)' : 'var(--rule)'}`,
      background: isPrimary ? 'rgba(180,140,80,.05)' : 'transparent',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontFamily: 'var(--serif)', fontSize: 16, color: 'var(--ink)' }}>
          {book.title}
          {book.title_pinyin_or_romaji ? (
            <span style={{ fontStyle: 'italic', color: 'var(--ink-3)', marginLeft: 8, fontSize: 13 }}>
              {book.title_pinyin_or_romaji}
            </span>
          ) : null}
        </div>
        <div style={{ fontSize: 11, fontFamily: 'var(--mono)', letterSpacing: '.06em', color: 'var(--ink-3)' }}>
          {isPrimary ? '原作' : '注疏'} · {book.language}{book.year ? ` · ${book.year}` : ''}
        </div>
      </div>
      <div style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 13.5, color: 'var(--ink-2)' }}>
        {book.author}
      </div>
      <RatingBar score={book.personal_fit_score} popularity={book.popularity_score} />
      <div style={{
        fontFamily: 'var(--serif)',
        fontSize: 13.5,
        color: 'var(--ink-2)',
        marginTop: 2,
        maxWidth: 580,
        lineHeight: 1.6,
      }}>
        {book.why_canonical}
      </div>
      {book.tradeoff_note ? (
        <div style={{
          fontFamily: 'var(--serif)',
          fontStyle: 'italic',
          fontSize: 12,
          color: 'var(--ink-3)',
          marginTop: 2,
          paddingLeft: 8,
          borderLeft: '1px solid var(--rule-soft, var(--rule))',
        }}>
          {book.tradeoff_note}
        </div>
      ) : null}
      <div style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', letterSpacing: '.05em', marginTop: 2 }}>
        建议格式: {book.suggested_format}
      </div>
    </div>
  );
}

// G.0 RatingBar — 5 brass dot, fill count = round(score × 5).
// user 2026-05-18 lock: register-aligned 5-dot, ! star ! emoji ! gauge.
// popularity 字段单独 mono 文字附加 (小字, ! 视觉重心).
function RatingBar({ score, popularity }) {
  const safe = Math.max(0, Math.min(1, Number(score) || 0));
  const filled = Math.round(safe * 5);
  const dotStyle = (isFilled) => ({
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: isFilled ? 'var(--ochre-2)' : 'transparent',
    border: `1px solid ${isFilled ? 'var(--ochre-2)' : 'var(--rule-soft, var(--rule))'}`,
    marginRight: 4,
  });
  const safePop = Number.isFinite(popularity) ? Math.max(0, Math.min(1, popularity)) : null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 }}>
      <span style={{ fontSize: 10.5, fontFamily: 'var(--mono)', letterSpacing: '.08em', color: 'var(--ink-3)', textTransform: 'uppercase' }}>
        推荐度
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center' }}>
        {[0, 1, 2, 3, 4].map(i => (
          <span key={i} style={dotStyle(i < filled)} />
        ))}
      </span>
      <span style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)' }}>
        {safe.toFixed(2)}
      </span>
      {safePop !== null ? (
        <span style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)', marginLeft: 8 }}>
          · 知名度 {safePop.toFixed(2)}
        </span>
      ) : null}
    </div>
  );
}

// 2026-05-18 Bug D fix — friendly Chinese label for raw orchestrator stages.
// Without this, UI shows "正在 level-try · file.epub" / "正在 native-epub-chapter".
const STAGE_LABEL_MAP = {
  'start':                 '开始',
  'level-try':             '尝试转换',
  'native-epub-start':     'EPUB → MD',
  'native-epub-chapter':   '解析章节',
  'native-epub-done':      'EPUB 完成',
  'native-pdf-start':      'PDF → 文本',
  'native-pdf-done':       'PDF 完成',
  'native-pdf-ocr-start':  'PDF 无文字层, 启 OCR',
  'native-pdf-ocr-page':   'OCR 进行中',
  'native-pdf-ocr-done':   'OCR 完成',
  'markitdown-start':      'markitdown 启动',
  'markitdown-done':       'markitdown 完成',
  'raw-extract-done':      '降级提取完成',
  'dedup-hit':             '指纹命中, 复用现有',
  'done':                  '入库完成',
  'error':                 '失败',
};
function _stageLabel(stage) {
  if (!stage) return '处理中';
  return STAGE_LABEL_MAP[stage] || `正在 ${stage}`;
}
