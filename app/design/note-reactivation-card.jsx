/* global React */
//
// HYPHA · Note Reactivation Card (α11 Living Note Reactivation surface, 2026-05-15)
//
// Mounts at the top of the lesson screen as a slim banner. Listens for the
// main-process `note:reactivation-found` broadcast (emitted by main.js after
// the post-body auto-scan locates 1-3 prior notes whose transfer_point is
// re-activated by this lesson). User can open the prior lesson or dismiss
// the banner per (slug, lessonIdx) — dismissal does not persist across runs.
//
// Bridge: window.notes.onReactivationFound(cb) (canonical, shipped α11) with
// defensive fallback to window.ptor.notes.onReactivationFound (forward-compat
// nesting if the bridge gets re-homed under ptor namespace later).
//
// Payload shape:
//   { slug, candidates: [{ note_idx, reason, transfer_point, rank, age_days,
//                          file_path, preview }] }
//
// Surface contract:
//   - Italic 11pt header: "复习提醒 · 来自旧 note"
//   - 1-3 candidate rows, each: title line + 7 天前 · lesson-N · preview ≤120
//     chars + 迁移点 · <transfer_point> + 打开旧 note button
//   - × dismiss button collapses the card for the current (slug, lessonIdx)
//   - No 5-second auto-fade (advisory, not toast)
//   - Cream background, brass hairline, ink primary text, tabac secondary
//   - No emoji, no exclamation, no marketing slang

const REACT_PALETTE = {
  ink:    '#2A1F12',
  tabac:  '#5C4E36',
  brass:  '#B8A372',
  cream:  '#F4EBD9',
  faded:  '#8A7F6E',
};

const _baseFont = '"EB Garamond", "Noto Serif SC", serif';

// Defensive preview truncation — 120 char cap with ellipsis, strips control
// chars + collapses whitespace. Returns '' for non-string input so the row
// renders without a body line rather than surfacing raw JSON.
function _previewText(preview) {
  if (typeof preview !== 'string') return '';
  const clean = preview.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= 120) return clean;
  return clean.slice(0, 119).trim() + '…';
}

// Age formatter — N 天前 / 今天 / 昨天 / N 月前. Defensive: returns '' for
// non-finite input.
function _ageText(ageDays) {
  if (typeof ageDays !== 'number' || !Number.isFinite(ageDays)) return '';
  const d = Math.max(0, Math.round(ageDays));
  if (d === 0) return '今天';
  if (d === 1) return '昨天';
  if (d < 30) return `${d} 天前`;
  const m = Math.floor(d / 30);
  return `${m} 月前`;
}

// Derive lesson-N label from file_path (vault/<slug>/lesson-NN.md) or fall
// back to note_idx. Returns null if neither is parseable so the row hides
// the label gracefully.
function _lessonLabel(filePath, noteIdx) {
  if (typeof filePath === 'string') {
    const m = filePath.match(/lesson-(\d+)\.md$/);
    if (m) return `lesson-${Number(m[1])}`;
  }
  if (typeof noteIdx === 'number' && Number.isFinite(noteIdx)) {
    return `lesson-${noteIdx}`;
  }
  return null;
}

// Dispatch the canonical open-lesson event so app.jsx (or any host) can
// route without prop-drilling setRoute through every card.
function _openLesson(slug, noteIdx, filePath) {
  try {
    window.dispatchEvent(new CustomEvent('hypha:open-lesson', {
      detail: { slug, lessonIdx: noteIdx, filePath },
    }));
  } catch (_) { /* no-op when CustomEvent unsupported */ }
}

const CandidateRow = ({ c, slug }) => {
  const preview = _previewText(c && c.preview);
  const age = _ageText(c && c.age_days);
  const lessonLbl = _lessonLabel(c && c.file_path, c && c.note_idx);
  const transferPoint = (c && typeof c.transfer_point === 'string') ? c.transfer_point.trim() : '';
  const reason = (c && typeof c.reason === 'string') ? c.reason.trim() : '';
  const headline = reason || (transferPoint ? `上次学的 ${transferPoint} 现在用得上` : '上次学的内容现在用得上');
  return (
    <div style={{
      padding: '10px 0',
      borderBottom: `1px solid ${REACT_PALETTE.brass}40`,
    }}>
      <div style={{
        fontFamily: _baseFont,
        fontStyle: 'italic',
        fontSize: 14.5,
        lineHeight: 1.65,
        color: REACT_PALETTE.ink,
      }}>
        {headline}
      </div>
      <div style={{
        fontFamily: _baseFont,
        fontSize: 10.5,
        lineHeight: 1.55,
        color: REACT_PALETTE.tabac,
        letterSpacing: '0.04em',
        marginTop: 3,
      }}>
        {age ? <span style={{ marginRight: 6 }}>{age}</span> : null}
        {lessonLbl ? <span style={{ marginRight: 6 }}>· {lessonLbl}</span> : null}
        {preview ? <span style={{ opacity: 0.85 }}>· {preview}</span> : null}
      </div>
      {transferPoint ? (
        <div style={{
          fontFamily: _baseFont,
          fontStyle: 'italic',
          fontSize: 11,
          lineHeight: 1.55,
          color: REACT_PALETTE.tabac,
          marginTop: 4,
        }}>
          <span style={{ marginRight: 6 }}>迁移点 ·</span>
          <span>{transferPoint}</span>
        </div>
      ) : null}
      <div style={{ marginTop: 6 }}>
        <button
          type="button"
          onClick={() => _openLesson(slug, c && c.note_idx, c && c.file_path)}
          className="btn btn-ghost"
          style={{
            fontFamily: _baseFont,
            fontSize: 11,
            fontStyle: 'italic',
            letterSpacing: '0.04em',
            color: REACT_PALETTE.tabac,
            padding: '4px 10px',
            background: 'transparent',
            border: `1px solid ${REACT_PALETTE.brass}80`,
            borderRadius: 0,
            cursor: 'pointer',
          }}
          title={`打开 ${lessonLbl || 'note'}`}
        >
          打开旧 note
        </button>
      </div>
    </div>
  );
};

const NoteReactivationCard = ({ slug, lessonIdx }) => {
  const { useState, useEffect } = React;
  const [candidates, setCandidates] = useState([]);
  const [dismissed, setDismissed] = useState(false);

  // Reset dismissal whenever the (slug, lessonIdx) pair changes — a fresh
  // lesson should re-show its reactivation banner if one fires.
  useEffect(() => {
    setDismissed(false);
    setCandidates([]);
  }, [slug, lessonIdx]);

  useEffect(() => {
    if (!slug) return undefined;
    // Bridge resolution — canonical surface lives at window.notes; defensive
    // fallback to window.ptor.notes for forward-compat nesting.
    const top = (typeof window !== 'undefined' && window.notes) || null;
    const nested = (typeof window !== 'undefined' && window.ptor && window.ptor.notes) || null;
    const subscribe = (top && typeof top.onReactivationFound === 'function')
      ? top.onReactivationFound
      : (nested && typeof nested.onReactivationFound === 'function')
        ? nested.onReactivationFound
        : null;
    if (!subscribe) return undefined;
    let alive = true;
    const off = subscribe((payload) => {
      if (!alive || !payload || payload.slug !== slug) return;
      const list = Array.isArray(payload.candidates) ? payload.candidates : [];
      if (list.length === 0) return;
      // Cap at top 3 for the slim banner register.
      setCandidates(list.slice(0, 3));
    });
    return () => {
      alive = false;
      try { if (typeof off === 'function') off(); } catch (_) {}
    };
  }, [slug]);

  if (!slug || dismissed || candidates.length === 0) return null;

  return (
    <div
      className="note-reactivation-card"
      style={{
        marginTop: 14,
        marginBottom: 18,
        padding: '14px 20px',
        background: REACT_PALETTE.cream,
        borderTop: `1px solid ${REACT_PALETTE.brass}`,
        borderBottom: `1px solid ${REACT_PALETTE.brass}`,
        position: 'relative',
        fontFamily: _baseFont,
      }}
    >
      <button
        type="button"
        onClick={() => setDismissed(true)}
        title="关闭复习提醒"
        aria-label="关闭复习提醒"
        style={{
          position: 'absolute',
          top: 8,
          right: 10,
          background: 'transparent',
          border: 'none',
          fontFamily: _baseFont,
          fontSize: 14,
          lineHeight: 1,
          color: REACT_PALETTE.faded,
          cursor: 'pointer',
          padding: 4,
        }}
      >
        ×
      </button>
      <div style={{
        fontStyle: 'italic',
        fontSize: 11,
        letterSpacing: '0.06em',
        color: REACT_PALETTE.tabac,
        marginBottom: 8,
        paddingBottom: 4,
        borderBottom: `1px solid ${REACT_PALETTE.brass}60`,
      }}>
        复习提醒 · 来自旧 note
      </div>
      {candidates.map((c, i) => (
        <CandidateRow key={(c && c.note_idx != null) ? `r-${c.note_idx}` : `r-i-${i}`} c={c} slug={slug} />
      ))}
    </div>
  );
};

if (typeof window !== 'undefined') {
  window.NoteReactivationCard = NoteReactivationCard;
}
