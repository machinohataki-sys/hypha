/* global React, Icon */
// HYPHA · DeadNotesScreen — W5.3 Living Note Reactivation audit panel.
// Surfaces notes flagged by detectDeadNotes() (Dormant > 90d + utility < 20
// + zero outgoing edges). User decision is archive-or-keep; archive = move
// to vault/<slug>/.archive/, NOT delete. Restoration runs through the state
// machine's Archived → Active path on user demand.
//
// Props: { slug, onBack, onJump }. Mirrors NotebookScreen's prop contract.

const { useState, useEffect, useCallback } = React;

// =====================================================================
// Helpers
// =====================================================================

function _basename(p) {
  if (!p) return '';
  const s = String(p).replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function _deadnessTint(score) {
  // 0..100 → brass→oxblood. Subtle, not alarming.
  if (score >= 80) return '#8B3A3A';
  if (score >= 60) return '#A66D2C';
  if (score >= 40) return '#8B7355';
  return 'var(--ink-3)';
}

// =====================================================================
// Row — single dead-suspect entry
// =====================================================================

const DeadRow = ({ row, selected, onToggle, onArchiveOne }) => {
  const tint = _deadnessTint(row.deadness_score);
  return (
    <div
      className="row gap-12"
      style={{
        padding: '12px 14px',
        borderBottom: '1px solid var(--rule-soft)',
        alignItems: 'baseline',
      }}
    >
      <input
        type="checkbox"
        checked={!!selected}
        onChange={() => onToggle(row.path)}
        style={{ marginTop: 4 }}
        aria-label="选择此条以批量归档"
      />
      <div className="col gap-2" style={{ flex: 1, minWidth: 0 }}>
        <div className="row gap-8" style={{ alignItems: 'baseline' }}>
          <span className="serif" style={{ fontSize: 15, color: 'var(--ink)' }}>
            {_basename(row.path)}
          </span>
          <span className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.06em' }}>
            {row.state} · 工具 {row.utility}/100 · {row.ageDays}d
          </span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--ink-2)', fontStyle: 'italic' }}>
          {row.reason}
        </div>
      </div>
      <div className="col" style={{ alignItems: 'flex-end', minWidth: 80 }}>
        <div className="t-tiny mono" style={{ color: tint, letterSpacing: '.06em' }}>
          deadness {row.deadness_score}
        </div>
        <button
          onClick={() => onArchiveOne(row.path)}
          className="btn btn-ghost"
          style={{ fontSize: 12, marginTop: 4 }}
          title="归档此条 (移入 .archive/, 不删除)"
        >
          归档
        </button>
      </div>
    </div>
  );
};

// =====================================================================
// Main screen
// =====================================================================

const DeadNotesScreen = ({ slug, onBack, onJump }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [resultMsg, setResultMsg] = useState(null);

  const reload = useCallback(async () => {
    if (!slug) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const bridge = window.ptor && window.ptor.livingnote;
      if (!bridge || typeof bridge.detectDead !== 'function') {
        setError('livingnote bridge 未加载');
        setRows([]);
        setLoading(false);
        return;
      }
      const r = await bridge.detectDead(slug);
      if (r && r.ok && Array.isArray(r.dead)) {
        setRows(r.dead);
      } else {
        setError((r && r.message) || '读取死亡笔记失败');
        setRows([]);
      }
    } catch (e) {
      setError(e && e.message ? e.message : String(e));
      setRows([]);
    }
    setLoading(false);
  }, [slug]);

  useEffect(() => {
    reload();
  }, [reload]);

  const toggleOne = useCallback((p) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (selected.size === rows.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(rows.map(r => r.path)));
    }
  }, [selected, rows]);

  const archiveSelected = useCallback(async (dryRun) => {
    const bridge = window.ptor && window.ptor.livingnote;
    if (!bridge || typeof bridge.archive !== 'function') {
      setResultMsg('archive bridge 未加载');
      return;
    }
    const paths = Array.from(selected);
    if (paths.length === 0) {
      setResultMsg('没有选中任何笔记');
      return;
    }
    try {
      const r = await bridge.archive(slug, dryRun, paths);
      if (r && r.ok) {
        const verb = r.dryRun ? '预览' : '已归档';
        setResultMsg(`${verb} ${r.archived.length} 条; 跳过 ${r.skipped.length} 条.`);
        if (!r.dryRun) {
          setSelected(new Set());
          await reload();
        }
      } else {
        setResultMsg((r && r.message) || '归档失败');
      }
    } catch (e) {
      setResultMsg(e && e.message ? e.message : String(e));
    }
  }, [selected, slug, reload]);

  const archiveOne = useCallback(async (p) => {
    const bridge = window.ptor && window.ptor.livingnote;
    if (!bridge || typeof bridge.archive !== 'function') {
      setResultMsg('archive bridge 未加载');
      return;
    }
    try {
      const r = await bridge.archive(slug, false, [p]);
      if (r && r.ok) {
        setResultMsg(`已归档 ${_basename(p)}.`);
        await reload();
      } else {
        setResultMsg((r && r.message) || '归档失败');
      }
    } catch (e) {
      setResultMsg(e && e.message ? e.message : String(e));
    }
  }, [slug, reload]);

  if (!slug) {
    return (
      <div className="col gap-16 fade-in" style={{
        padding: '48px 60px 60px', maxWidth: 720, margin: '0 auto',
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      }}>
        <div className="eyebrow">Dead Notes</div>
        <h1 className="serif" style={{ fontSize: 28, fontWeight: 400 }}>没有选中课程</h1>
        <div style={{ fontSize: 14, color: 'var(--ink-2)', fontStyle: 'italic' }}>
          从一个具体的课程笔记进入死亡笔记审查.
        </div>
        {typeof onBack === 'function' && (
          <button onClick={onBack} className="btn btn-ghost" style={{ alignSelf: 'flex-start', fontSize: 13 }}>
            返回
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="fade-in" style={{ minHeight: '100vh', position: 'relative' }}>
      <div className="row gap-12" style={{
        padding: '20px 40px', alignItems: 'baseline',
        borderBottom: '1px solid var(--rule-soft)',
        background: 'linear-gradient(180deg, rgba(244,239,228,.92), rgba(244,239,228,.5))',
        position: 'sticky', top: 0, zIndex: 5,
        backdropFilter: 'blur(6px)',
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      }}>
        {typeof onBack === 'function' && (
          <button onClick={onBack} className="row gap-8 btn btn-ghost" style={{ fontSize: 13 }}>
            {typeof Icon === 'function' ? <Icon name="arrowL" size={13} /> : <span>‹</span>}
            <span>返回</span>
          </button>
        )}
        <div className="col gap-2" style={{ marginLeft: 8 }}>
          <span className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.08em' }}>
            DEAD NOTES · {slug}
          </span>
          <h1 className="serif" style={{
            fontSize: 22, lineHeight: 1.25, margin: 0,
            fontWeight: 400, color: 'var(--ink)',
          }}>
            死亡笔记审查
          </h1>
        </div>
        <span className="spacer" style={{ flex: 1 }} />
        <button onClick={reload} className="btn btn-ghost" style={{ fontSize: 12 }} title="重新扫描">
          刷新
        </button>
      </div>

      <div className="col gap-16" style={{
        padding: '24px 40px 80px', maxWidth: 880, margin: '0 auto',
        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
      }}>
        <div style={{
          padding: '12px 16px',
          background: 'rgba(166, 109, 44, 0.06)',
          borderLeft: '2px solid #A66D2C',
          fontSize: 13.5, lineHeight: 1.6, color: 'var(--ink-2)',
          fontStyle: 'italic',
        }}>
          死亡笔记: 状态 Dormant · 超 90 天未触碰 · 工具分 &lt; 20 · 零出链.
          归档 = 移入 <code>.archive/</code> 子目录, 不删除, 可随时恢复.
        </div>

        {loading && (
          <div className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.08em' }}>
            扫描中…
          </div>
        )}
        {error && (
          <div style={{ fontSize: 13, color: '#8B3A3A', fontStyle: 'italic' }}>
            {error}
          </div>
        )}

        {!loading && !error && rows.length === 0 && (
          <div style={{ fontSize: 14, color: 'var(--ink-2)', fontStyle: 'italic', padding: '20px 0' }}>
            没有发现死亡笔记. 你的笔记还活着.
          </div>
        )}

        {!loading && rows.length > 0 && (
          <div className="col" style={{ border: '1px solid var(--rule-soft)' }}>
            <div className="row gap-12" style={{
              padding: '10px 14px',
              borderBottom: '1px solid var(--rule-soft)',
              background: 'rgba(0,0,0,0.02)',
              alignItems: 'baseline',
            }}>
              <input
                type="checkbox"
                checked={selected.size > 0 && selected.size === rows.length}
                onChange={toggleAll}
                aria-label="全选"
              />
              <span className="t-tiny mono" style={{ color: 'var(--ink-3)', letterSpacing: '.08em' }}>
                {selected.size > 0 ? `已选 ${selected.size} / ${rows.length}` : `共 ${rows.length} 条`}
              </span>
              <span className="spacer" style={{ flex: 1 }} />
              <button
                onClick={() => archiveSelected(true)}
                className="btn btn-ghost"
                style={{ fontSize: 12 }}
                disabled={selected.size === 0}
                title="预览归档 (不真改文件)"
              >
                预览
              </button>
              <button
                onClick={() => archiveSelected(false)}
                className="btn btn-ghost"
                style={{ fontSize: 12, color: '#8B3A3A' }}
                disabled={selected.size === 0}
                title="批量归档选中项"
              >
                归档选中
              </button>
            </div>
            {rows.map((row, i) => (
              <DeadRow
                key={row.path || i}
                row={row}
                selected={selected.has(row.path)}
                onToggle={toggleOne}
                onArchiveOne={archiveOne}
              />
            ))}
          </div>
        )}

        {resultMsg && (
          <div style={{
            padding: '10px 14px',
            background: 'rgba(166, 109, 44, 0.06)',
            borderLeft: '2px solid #8B7355',
            fontSize: 13, color: 'var(--ink-2)', fontStyle: 'italic',
          }}>
            {resultMsg}
          </div>
        )}
      </div>
    </div>
  );
};

window.DeadNotesScreen = DeadNotesScreen;
