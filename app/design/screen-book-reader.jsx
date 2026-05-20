/* global React */
// HYPHA · Book Reader — MD render + chapter sidebar.
//
// Renders an uploaded MD book chapter-by-chapter in the manuscript register.
// Left column: chapter outline (clickable, sticky). Right column: rendered
// markdown of the active chapter.
//
// The MD renderer is a pure-JSX walk over a hand-rolled tokenizer — no
// runtime deps. Handles the 80% subset the HYPHA Library cares about:
//   #/##/### headings · paragraphs · ul/ol lists · blockquotes ·
//   fenced code (```) · inline code (`x`) · bold (**x**) · italic (*x*) ·
//   links [text](url) · hr (---) · soft line breaks.
// Anything else falls back to plain text (escaped). No raw HTML pass-through
// → no XSS surface for user-uploaded books.

const { useState, useEffect, useMemo, useCallback } = React;

const BookReaderScreen = ({ bookId, bookTitle, onBack }) => {
  const [book, setBook] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!bookId || !window.ptor || !window.ptor.hypha || !window.ptor.hypha.libraryGetBook) {
      setError('bridge missing: libraryGetBook');
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    (async () => {
      try {
        const r = await window.ptor.hypha.libraryGetBook(bookId);
        if (cancelled) return;
        if (!r || !r.ok) { setError((r && r.error) || 'fetch failed'); return; }
        setBook(r.book || null);
        setActiveIdx(0);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [bookId]);

  const chunks = useMemo(() => (book && Array.isArray(book.chunks)) ? book.chunks : [], [book]);
  const activeChunk = chunks[activeIdx] || null;

  if (loading) {
    return <div className="col gap-12" style={{ padding: 40, color: 'var(--ink-2)' }}>
      <span className="italic">Loading book…</span>
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
  if (!book) {
    return <div className="col gap-12" style={{ padding: 40 }}>
      <div className="italic" style={{ color: 'var(--ink-2)' }}>书不存在或已删除.</div>
      <button onClick={onBack} className="btn btn-ghost" style={{ alignSelf: 'flex-start' }}>返回</button>
    </div>;
  }

  return (
    <div className="fade-in" style={{ display: 'flex', maxWidth: 1320, margin: '0 auto', padding: '24px 24px 60px', gap: 28 }}>
      {/* Left: chapter outline */}
      <aside style={{
        width: 280, flexShrink: 0,
        position: 'sticky', top: 24, alignSelf: 'flex-start',
        maxHeight: 'calc(100vh - 64px)', overflowY: 'auto',
        padding: '12px 4px 12px 8px',
        borderRight: '1px solid var(--rule-soft)',
      }}>
        <div className="col gap-8" style={{ paddingRight: 12 }}>
          <div className="eyebrow" style={{ fontSize: 10, color: 'var(--ink-3)' }}>Chapters</div>
          <h2 className="serif italic" style={{ fontSize: 18, margin: 0, fontWeight: 400, color: 'var(--ink-1)', lineHeight: 1.3 }}>
            {book.title || bookTitle || '(untitled)'}
          </h2>
          {book.author && (
            <span className="t-small italic" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{book.author}</span>
          )}
          <button onClick={onBack} className="btn btn-ghost"
            style={{ alignSelf: 'flex-start', fontSize: 11, color: 'var(--ink-2)', marginTop: 4 }}>
            ← 返回 Library
          </button>
        </div>
        <ol style={{ listStyle: 'none', padding: '14px 0 0', margin: 0 }}>
          {chunks.map((c, i) => (
            <li key={c.idx ?? i}>
              <button onClick={() => setActiveIdx(i)} style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '7px 10px', background: i === activeIdx ? 'rgba(184,153,104,0.12)' : 'transparent',
                border: 'none', borderLeft: i === activeIdx ? '2px solid #B89968' : '2px solid transparent',
                cursor: 'pointer', fontFamily: 'EB Garamond, "Noto Serif SC", serif',
                fontSize: 13, color: i === activeIdx ? 'var(--ink)' : 'var(--ink-2)',
                lineHeight: 1.5,
              }}>
                <span style={{ opacity: 0.6, marginRight: 6 }}>{i + 1}.</span>
                {c.title || '(untitled)'}
              </button>
            </li>
          ))}
        </ol>
      </aside>

      {/* Right: rendered chapter MD */}
      <article style={{ flex: 1, minWidth: 0, maxWidth: 760, padding: '8px 12px 40px' }}>
        {activeChunk ? (
          <>
            <header style={{ borderBottom: '1px solid var(--rule-soft)', paddingBottom: 14, marginBottom: 22 }}>
              <span className="eyebrow" style={{ fontSize: 10, color: 'var(--ink-3)' }}>
                Chapter {activeIdx + 1} / {chunks.length}
              </span>
              <h1 className="serif" style={{ fontSize: 28, margin: '6px 0 0', fontWeight: 400, color: 'var(--ink)' }}>
                {activeChunk.title || '(untitled)'}
              </h1>
            </header>
            <div className="serif" style={{ fontSize: 15, lineHeight: 1.85, color: 'var(--ink)' }}>
              <MarkdownRender source={activeChunk.text || ''} skipTitle={activeChunk.title} />
            </div>
            <ChapterNav idx={activeIdx} total={chunks.length} onChange={setActiveIdx} chunks={chunks} />
          </>
        ) : (
          <div className="italic" style={{ color: 'var(--ink-2)', padding: 32 }}>
            这本书没有章节内容. 可能上传后扩展抽取失败 — 撤销重传 MD 源文件试试.
          </div>
        )}
      </article>
    </div>
  );
};

const ChapterNav = ({ idx, total, onChange, chunks }) => {
  const prev = idx > 0 ? chunks[idx - 1] : null;
  const next = idx + 1 < total ? chunks[idx + 1] : null;
  return (
    <nav style={{ display: 'flex', gap: 16, marginTop: 36, paddingTop: 18, borderTop: '1px solid var(--rule-soft)' }}>
      <button onClick={() => prev && onChange(idx - 1)} disabled={!prev} className="btn btn-ghost"
        style={{ flex: 1, textAlign: 'left', opacity: prev ? 1 : 0.3, padding: '12px 14px' }}>
        <span className="eyebrow" style={{ fontSize: 10, color: 'var(--ink-3)' }}>← 上一章</span>
        {prev && <div className="serif italic" style={{ fontSize: 13, color: 'var(--ink-1)', marginTop: 4 }}>{prev.title}</div>}
      </button>
      <button onClick={() => next && onChange(idx + 1)} disabled={!next} className="btn btn-ghost"
        style={{ flex: 1, textAlign: 'right', opacity: next ? 1 : 0.3, padding: '12px 14px' }}>
        <span className="eyebrow" style={{ fontSize: 10, color: 'var(--ink-3)' }}>下一章 →</span>
        {next && <div className="serif italic" style={{ fontSize: 13, color: 'var(--ink-1)', marginTop: 4 }}>{next.title}</div>}
      </button>
    </nav>
  );
};

// ──────────────────────────────────────────────────────────────────────────
// Minimal MD → React. Block-level tokens first, then inline within each.

const MarkdownRender = ({ source, skipTitle }) => {
  const blocks = useMemo(() => _tokenizeBlocks(source, skipTitle), [source, skipTitle]);
  return <>{blocks.map((b, i) => _renderBlock(b, i))}</>;
};

function _tokenizeBlocks(src, skipTitle) {
  const text = String(src || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;
  // The first chunk often re-prints the chapter heading (segment includes its
  // own `# Title` line). Skip the leading heading that matches the sidebar
  // title, so we don't render it twice.
  if (skipTitle && lines.length > 0) {
    const first = lines[0].replace(/^#{1,6}\s+/, '').trim();
    if (first && first === String(skipTitle).trim()) i = 1;
    while (i < lines.length && lines[i].trim() === '') i++;
  }
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    if (/^\s*```/.test(line)) {
      const fenceMatch = line.match(/^\s*```(\w*)/);
      const lang = fenceMatch ? fenceMatch[1] || '' : '';
      const codeLines = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ type: 'code', lang, text: codeLines.join('\n') });
      continue;
    }
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, text: headingMatch[2] });
      i++;
      continue;
    }
    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }
    if (/^\s*>\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s+/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', text: buf.join(' ') });
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }
    // paragraph: collect contiguous non-blank lines
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^(?:#{1,6}\s|\s*```|\s*>\s|\s*[-*+]\s|\s*\d+\.\s|\s*(?:---|\*\*\*|___)\s*$)/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'p', text: buf.join(' ') });
  }
  return blocks;
}

function _renderBlock(b, key) {
  switch (b.type) {
    case 'heading': {
      const Tag = `h${Math.min(b.level + 1, 6)}`; // bump down — chapter title is already h1
      return <Tag key={key} className="serif" style={{
        fontSize: b.level === 1 ? 22 : b.level === 2 ? 19 : 17,
        fontWeight: b.level === 1 ? 500 : 400,
        margin: '24px 0 10px', color: 'var(--ink)', lineHeight: 1.3,
      }}>{_renderInline(b.text)}</Tag>;
    }
    case 'hr':
      return <hr key={key} style={{ border: 'none', borderTop: '1px solid var(--rule-soft)', margin: '24px 0' }} />;
    case 'blockquote':
      return (
        <blockquote key={key} className="serif italic" style={{
          margin: '14px 0', padding: '8px 16px',
          borderLeft: '3px solid #B89968', color: 'var(--ink-1)',
          background: 'rgba(184,153,104,0.06)',
        }}>{_renderInline(b.text)}</blockquote>
      );
    case 'ul':
      return (
        <ul key={key} style={{ margin: '10px 0 10px 22px', padding: 0 }}>
          {b.items.map((it, i) => <li key={i} style={{ marginBottom: 4 }}>{_renderInline(it)}</li>)}
        </ul>
      );
    case 'ol':
      return (
        <ol key={key} style={{ margin: '10px 0 10px 22px', padding: 0 }}>
          {b.items.map((it, i) => <li key={i} style={{ marginBottom: 4 }}>{_renderInline(it)}</li>)}
        </ol>
      );
    case 'code':
      return (
        <pre key={key} style={{
          margin: '14px 0', padding: '12px 16px',
          background: 'var(--cream)', border: '1px solid var(--rule-soft)',
          borderRadius: 2, fontSize: 13, lineHeight: 1.6,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          color: 'var(--ink-1)', overflowX: 'auto', whiteSpace: 'pre',
        }}>{b.text}</pre>
      );
    case 'p':
    default:
      return <p key={key} style={{ margin: '0 0 14px', textIndent: 0 }}>{_renderInline(b.text)}</p>;
  }
}

// Inline pass: code spans first (literal), then bold/italic/link/escape.
function _renderInline(text) {
  if (!text) return null;
  // tokenize by code spans first to protect their content
  const segments = [];
  const codeRe = /`([^`]+)`/g;
  let last = 0; let m;
  while ((m = codeRe.exec(text)) !== null) {
    if (m.index > last) segments.push({ kind: 'text', value: text.slice(last, m.index) });
    segments.push({ kind: 'code', value: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ kind: 'text', value: text.slice(last) });

  const out = [];
  segments.forEach((seg, i) => {
    if (seg.kind === 'code') {
      out.push(<code key={i} style={{
        fontFamily: 'ui-monospace, monospace',
        fontSize: '0.92em', padding: '1px 5px',
        background: 'rgba(0,0,0,0.05)', borderRadius: 2,
      }}>{seg.value}</code>);
    } else {
      out.push(..._renderTextWithEmphasis(seg.value, i));
    }
  });
  return out;
}

// Emphasis + links pass. Tokens: **bold**, *italic*, _italic_, [text](url).
// Implementation: regex split-and-walk. Not full CommonMark, but good enough
// for authored MD books / academic notes / blog posts.
function _renderTextWithEmphasis(text, seedKey) {
  const out = [];
  let key = 0;
  const pushText = (s) => { if (s) out.push(<span key={`${seedKey}-${key++}`}>{s}</span>); };
  // alternating split: ** → bold, * or _ → italic, [..](..) → link
  const tokenRe = /(\*\*[^*]+\*\*|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^\)]+\))/g;
  let last = 0; let m;
  while ((m = tokenRe.exec(text)) !== null) {
    if (m.index > last) pushText(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) {
      out.push(<strong key={`${seedKey}-${key++}`}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('[')) {
      const lk = tok.match(/^\[([^\]]+)\]\(([^\)]+)\)$/);
      if (lk) {
        out.push(<a key={`${seedKey}-${key++}`} href={lk[2]} style={{ color: '#2F5762', textDecoration: 'underline' }} target="_blank" rel="noreferrer">{lk[1]}</a>);
      } else {
        pushText(tok);
      }
    } else {
      // *italic* or _italic_
      out.push(<em key={`${seedKey}-${key++}`} className="italic">{tok.slice(1, -1)}</em>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) pushText(text.slice(last));
  return out;
}

window.BookReaderScreen = BookReaderScreen;
