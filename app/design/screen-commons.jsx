/* global React */
// HYPHA · Commons Browse Screen (System 6, BLUEPRINT §12).
//
// Hypha 的唯一差异化点 — Commons. 让 user 看到 / 触发的 4 个动作:
//   1. 列出 vault/.commons/packs/*.hypha-pack (我导出的)
//   2. 看 pack manifest 详情 (pack_id / files / hash / archetype / license)
//   3. 触发 Export Current Curriculum — inline form + 描述 + sources + license
//   4. 触发 Import .hypha-pack — file picker → inspectPack 预览 → 确认 import
//
// IPC contract (假定 α13 + β13 + 后续 wire 主流程):
//   window.ptor.commons.exportPack(slug, opts) → { ok, pack_id, pack_path, ... }
//   window.ptor.commons.importPack(packPath)   → { ok, new_slug, ... }
//   window.ptor.commons.inspectPack(packPath)  → { ok, manifest }
//   window.ptor.commons.listPacks()            → { ok, packs:[...] } (我导出的)
//   window.ptor.commons.deletePack(pack_id)    → { ok } (可能不存在 — 我们诚实暴露)
//   window.ptor.commonsPickPackFile()          → { ok, filePath } (file picker)
//
// 不存在的 IPC 会被 ipcRenderer reject — 我们把 error 渲染到 toast,
// 不假装成功 (per Hypha 诚实武装 + Confession Layer).
//
// Register: italic EB Garamond + Noto Serif SC; ink / tabac / brass / cream
// / oxblood (危险). 不用 emoji / 感叹号 / 流量词. 严手稿调.
//
// Props: { onBack, currentSlug }  — currentSlug 从 app.jsx 传 (用于 Export 默认)

const { useState, useEffect, useCallback } = React;

const TOKEN = {
  ink1:        'var(--ink-1, #2c2620)',
  ink2:        'var(--ink-2, #5a5246)',
  ink3:        'var(--ink-3, #8b8275)',
  brass:       'var(--accent-brass, #b08a3e)',
  tabac:       'var(--accent-tabac, #5C4E36)',
  oxblood:     'var(--accent-oxblood, #6F2A2A)',
  cream:       'var(--paper, #faf6e8)',
  paperWarm:   'var(--paper-warm, #f5efde)',
  rule:        'var(--rule-soft, #e3dccd)',
  terracotta:  'var(--accent-terracotta, #c25a36)',
};

const LICENSES = [
  { id: 'CC-BY-NC-4.0', label: 'CC BY-NC 4.0', hint: '署名 — 非商业' },
  { id: 'CC-BY-4.0',    label: 'CC BY 4.0',    hint: '署名 — 商业可用' },
  { id: 'NO-COMMERCIAL', label: '商业禁用',     hint: '私下传阅, 严禁商用' },
];

function _fmtBytes(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return '— B';
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${(num / 1024 / 1024).toFixed(1)} MB`;
}

function _fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  } catch (_) { return String(iso); }
}

const Hairline = ({ heavy = false }) => (
  <div style={{
    height: 1,
    background: heavy ? TOKEN.tabac : TOKEN.rule,
    margin: '24px 0',
    opacity: heavy ? 0.4 : 1,
  }} />
);

const SectionLabel = ({ children }) => (
  <div style={{
    fontFamily: 'EB Garamond, serif',
    fontStyle: 'italic',
    fontSize: 13,
    color: TOKEN.tabac,
    letterSpacing: '0.06em',
    marginBottom: 10,
  }}>{children}</div>
);

const BrassButton = ({ children, onClick, disabled, intent }) => {
  const isDanger = intent === 'danger';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '8px 18px',
        fontFamily: 'EB Garamond, serif',
        fontStyle: 'italic',
        fontSize: 14,
        background: 'transparent',
        color: disabled ? TOKEN.ink3 : (isDanger ? TOKEN.oxblood : TOKEN.ink1),
        border: '1px solid ' + (disabled ? TOKEN.rule : (isDanger ? TOKEN.oxblood : TOKEN.brass)),
        borderRadius: 2,
        cursor: disabled ? 'not-allowed' : 'pointer',
        letterSpacing: '0.04em',
      }}
    >{children}</button>
  );
};

const ExportForm = ({ currentSlug, onConfirm, onCancel, busy }) => {
  const [description, setDescription] = useState('');
  const [includeSources, setIncludeSources] = useState(true);
  const [license, setLicense] = useState('CC-BY-NC-4.0');

  return (
    <div style={{
      marginTop: 14,
      padding: '18px 20px',
      background: TOKEN.paperWarm,
      border: '1px solid ' + TOKEN.rule,
      borderRadius: 2,
    }}>
      <div style={{
        fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
        fontSize: 16, color: TOKEN.ink1, marginBottom: 6,
      }}>
        导出 — {currentSlug || '尚未指定课程'}
      </div>
      <div style={{
        fontSize: 11, fontStyle: 'italic', color: TOKEN.tabac,
        fontFamily: 'EB Garamond, serif', marginBottom: 14,
      }}>
        Pack 含 manifest + 内容 hash + provenance, 可被收件人验真.
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{
          fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
          fontSize: 12, color: TOKEN.tabac, marginBottom: 4,
        }}>描述 (可选)</div>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="如: 创始人 cohort 第 1 期"
          style={{
            width: '100%',
            padding: '7px 10px',
            fontFamily: '"Noto Serif SC", serif',
            fontSize: 13,
            color: TOKEN.ink1,
            background: TOKEN.cream,
            border: '1px solid ' + TOKEN.rule,
            borderRadius: 2,
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
      </div>

      <label style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12,
        fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
        fontSize: 13, color: TOKEN.ink2, cursor: 'pointer',
      }}>
        <input
          type="checkbox"
          checked={includeSources}
          onChange={(e) => setIncludeSources(e.target.checked)}
          style={{ accentColor: TOKEN.brass }}
        />
        <span>包含 sources (原始 PDF / Markdown / URL 抽取)</span>
      </label>

      <div style={{ marginBottom: 14 }}>
        <div style={{
          fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
          fontSize: 12, color: TOKEN.tabac, marginBottom: 6,
        }}>许可证</div>
        {LICENSES.map((lic) => (
          <label key={lic.id} style={{
            display: 'flex', alignItems: 'baseline', gap: 8,
            padding: '4px 0',
            fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
            fontSize: 13, color: TOKEN.ink2, cursor: 'pointer',
          }}>
            <input
              type="radio"
              name="license"
              checked={license === lic.id}
              onChange={() => setLicense(lic.id)}
              style={{ accentColor: TOKEN.brass }}
            />
            <span>{lic.label}</span>
            <span style={{ fontSize: 11, color: TOKEN.ink3 }}>— {lic.hint}</span>
          </label>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <BrassButton
          onClick={() => onConfirm({ description: description.trim(), includeSources, license })}
          disabled={busy || !currentSlug}
        >{busy ? '导出中…' : '确认导出'}</BrassButton>
        <BrassButton onClick={onCancel} disabled={busy}>取消</BrassButton>
      </div>
    </div>
  );
};

const ImportPreview = ({ preview, onConfirm, onCancel, busy }) => {
  if (!preview) return null;
  const m = preview.manifest || preview;
  const fileCount = (m.contents && Array.isArray(m.contents.files)) ? m.contents.files.length : (m.file_count || '—');
  return (
    <div style={{
      marginTop: 14,
      padding: '18px 20px',
      background: TOKEN.paperWarm,
      border: '1px solid ' + TOKEN.brass,
      borderRadius: 2,
    }}>
      <div style={{
        fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
        fontSize: 16, color: TOKEN.ink1, marginBottom: 8,
      }}>即将 import</div>
      <div style={{ fontSize: 13, fontFamily: '"Noto Serif SC", serif', color: TOKEN.ink2, lineHeight: 1.8 }}>
        来自 pack <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: TOKEN.tabac }}>{m.pack_id || '—'}</span>
      </div>
      <div style={{ fontSize: 13, fontFamily: '"Noto Serif SC", serif', color: TOKEN.ink2, lineHeight: 1.8 }}>
        源课程 <span style={{ color: TOKEN.ink1 }}>{m.source_slug || '—'}</span> · {fileCount} 个文件
      </div>
      {m.description && (
        <div style={{
          fontSize: 12, fontStyle: 'italic',
          fontFamily: 'EB Garamond, serif',
          color: TOKEN.tabac, marginTop: 6,
        }}>
          描述: {m.description}
        </div>
      )}
      {m.license && (
        <div style={{
          fontSize: 12, fontStyle: 'italic',
          fontFamily: 'EB Garamond, serif',
          color: TOKEN.tabac, marginTop: 4,
        }}>
          许可证: {m.license}
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <BrassButton onClick={onConfirm} disabled={busy}>
          {busy ? 'import 中…' : '确认 import'}
        </BrassButton>
        <BrassButton onClick={onCancel} disabled={busy}>取消</BrassButton>
      </div>
    </div>
  );
};

const PackDetail = ({ pack }) => {
  if (!pack) return null;
  const files = (pack.contents && Array.isArray(pack.contents.files)) ? pack.contents.files : [];
  const shown = files.slice(0, 10);
  const rest = Math.max(0, files.length - 10);
  return (
    <div style={{
      marginTop: 12,
      padding: '14px 16px',
      background: TOKEN.cream,
      border: '1px dashed ' + TOKEN.rule,
      borderRadius: 2,
      fontSize: 12,
      lineHeight: 1.8,
      color: TOKEN.ink2,
      fontFamily: '"Noto Serif SC", serif',
    }}>
      <div>
        <span style={{ color: TOKEN.tabac, fontStyle: 'italic', fontFamily: 'EB Garamond, serif' }}>pack_id</span>
        {' · '}
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: TOKEN.ink3 }}>{pack.pack_id || '—'}</span>
      </div>
      <div>
        <span style={{ color: TOKEN.tabac, fontStyle: 'italic', fontFamily: 'EB Garamond, serif' }}>源课程</span>
        {' · '}{pack.source_slug || '—'}
      </div>
      <div>
        <span style={{ color: TOKEN.tabac, fontStyle: 'italic', fontFamily: 'EB Garamond, serif' }}>导出于</span>
        {' · '}{_fmtDate(pack.exported_at)}
      </div>
      <div>
        <span style={{ color: TOKEN.tabac, fontStyle: 'italic', fontFamily: 'EB Garamond, serif' }}>archetype</span>
        {' · '}{pack.archetype || '—'}
      </div>
      <div>
        <span style={{ color: TOKEN.tabac, fontStyle: 'italic', fontFamily: 'EB Garamond, serif' }}>目标</span>
        {' · '}{pack.goal || pack.learn_goal || '—'}
      </div>
      <div>
        <span style={{ color: TOKEN.tabac, fontStyle: 'italic', fontFamily: 'EB Garamond, serif' }}>许可证</span>
        {' · '}{pack.license || '—'}
      </div>
      <div>
        <span style={{ color: TOKEN.tabac, fontStyle: 'italic', fontFamily: 'EB Garamond, serif' }}>pack_hash</span>
        {' · '}
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: TOKEN.ink3, wordBreak: 'break-all' }}>
          {pack.pack_hash || '—'}
        </span>
      </div>
      {shown.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <span style={{ color: TOKEN.tabac, fontStyle: 'italic', fontFamily: 'EB Garamond, serif' }}>文件 ({files.length})</span>
          <ul style={{ margin: '4px 0 0 0', paddingLeft: 18, fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: TOKEN.ink3 }}>
            {shown.map((f, i) => (<li key={i}>{typeof f === 'string' ? f : (f.path || f.name || JSON.stringify(f))}</li>))}
            {rest > 0 && (<li style={{ fontStyle: 'italic', fontFamily: 'EB Garamond, serif', color: TOKEN.ink3 }}>其余 {rest} 个…</li>)}
          </ul>
        </div>
      )}
    </div>
  );
};

// γ17 — Pack Distill card. Renders the editorial preview returned by
// commons.distill({packPath}). Distinct from PackDetail (manifest-only):
// shows topic / lessons / sources breakdown / persona wisdoms / license
// commercial verdict / source trust band / warnings as red italic lines.
const TRUST_BAND_ZH = {
  verified: '已验证',
  community: '社区',
  unverified: '未验证',
};

const DistillCard = ({ distill, busy, error }) => {
  if (busy) {
    return (
      <div style={{
        marginTop: 12, padding: '14px 16px',
        background: TOKEN.cream,
        border: '1px dashed ' + TOKEN.brass,
        borderRadius: 2,
        fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
        fontSize: 13, color: TOKEN.ink3,
      }}>distill 中…</div>
    );
  }
  if (error) {
    return (
      <div style={{
        marginTop: 12, padding: '14px 16px',
        background: TOKEN.paperWarm,
        border: '1px solid ' + TOKEN.oxblood,
        borderRadius: 2,
        fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
        fontSize: 12, color: TOKEN.oxblood,
      }}>{error}</div>
    );
  }
  if (!distill) return null;

  const breakdown = distill.sources && distill.sources.breakdown ? distill.sources.breakdown : {};
  const breakdownStr = Object.keys(breakdown).length === 0
    ? '—'
    : Object.entries(breakdown).map(([k, v]) => `${k}: ${v}`).join(' · ');
  const personaIds = (distill.persona_wisdoms && Array.isArray(distill.persona_wisdoms.ids)) ? distill.persona_wisdoms.ids : [];
  const lessonTitles = (distill.lessons && Array.isArray(distill.lessons.titles)) ? distill.lessons.titles : [];
  const trustBand = TRUST_BAND_ZH[distill.source_trust] || distill.source_trust || '—';
  const warnings = Array.isArray(distill.warnings) ? distill.warnings : [];

  const labelCSS = { color: TOKEN.tabac, fontStyle: 'italic', fontFamily: 'EB Garamond, serif' };
  const monoCSS = { fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: TOKEN.ink3 };

  return (
    <div style={{
      marginTop: 12, padding: '16px 18px',
      background: TOKEN.cream,
      border: '1px solid ' + TOKEN.brass,
      borderRadius: 2,
      fontSize: 13,
      lineHeight: 1.85,
      color: TOKEN.ink2,
      fontFamily: '"Noto Serif SC", serif',
    }}>
      <div style={{
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 10,
        color: TOKEN.ink3,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        marginBottom: 10,
      }}>{`pack distill · ${distill.pack_id || '—'}`}</div>

      {distill.topic && (
        <div style={{
          fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
          fontSize: 16, color: TOKEN.ink1, marginBottom: 4,
        }}>{distill.topic}</div>
      )}
      {distill.learn_goal && (
        <div style={{
          fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
          fontSize: 14, color: TOKEN.ink2, marginBottom: 10,
        }}>{distill.learn_goal}</div>
      )}

      <div>
        <span style={labelCSS}>课程 ({(distill.lessons && distill.lessons.count) || 0})</span>
        {lessonTitles.length > 0 && (
          <ul style={{ margin: '4px 0 0 0', paddingLeft: 18 }}>
            {lessonTitles.map((t, i) => (
              <li key={i} style={{ fontFamily: '"Noto Serif SC", serif', fontSize: 13, color: TOKEN.ink2 }}>
                <span style={monoCSS}>{String(i + 1).padStart(2, '0')}</span>{' · '}{t}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div style={{ marginTop: 6 }}>
        <span style={labelCSS}>来源</span>
        {' · '}
        <span style={monoCSS}>{breakdownStr}</span>
        {' · '}
        <span>共 {(distill.sources && distill.sources.total) || 0}</span>
      </div>

      <div>
        <span style={labelCSS}>persona wisdoms ({personaIds.length})</span>
        {personaIds.length > 0 && (
          <>
            {' · '}
            <span style={monoCSS}>{personaIds.join(' · ')}</span>
          </>
        )}
      </div>

      {distill.decisions && (
        <div>
          <span style={labelCSS}>决策 (decisions.jsonl)</span>
          {' · '}{distill.decisions.count}
        </div>
      )}
      {distill.sparks && (
        <div>
          <span style={labelCSS}>火花 (sparks.jsonl)</span>
          {' · '}{distill.sparks.count}
        </div>
      )}

      <div>
        <span style={labelCSS}>archetype</span>
        {' · '}{distill.archetype || '—'}
      </div>
      <div>
        <span style={labelCSS}>许可证</span>
        {' · '}{distill.license || '—'}
        {' · '}
        <span style={{
          fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
          color: distill.license_commercial ? TOKEN.brass : TOKEN.oxblood,
        }}>{distill.license_commercial ? '可商用' : '!可商用'}</span>
      </div>
      <div>
        <span style={labelCSS}>来源信任</span>
        {' · '}{trustBand}
      </div>
      <div>
        <span style={labelCSS}>体积</span>
        {' · '}{Number.isFinite(distill.size_estimate_mb) ? `${distill.size_estimate_mb} MB` : '—'}
      </div>

      {distill.contents_sample && distill.contents_sample.topic_summary && (
        <div style={{
          marginTop: 8,
          padding: '8px 10px',
          background: TOKEN.paperWarm,
          borderLeft: '2px solid ' + TOKEN.rule,
          fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
          fontSize: 12, color: TOKEN.tabac,
        }}>{distill.contents_sample.topic_summary}</div>
      )}

      {warnings.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <span style={labelCSS}>警示</span>
          <ul style={{ margin: '4px 0 0 0', paddingLeft: 18 }}>
            {warnings.map((w, i) => (
              <li key={i} style={{
                fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
                fontSize: 12, color: TOKEN.oxblood,
              }}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

const PackRow = ({ pack, onShowDetail, expanded, onDelete, deleteConfirming, onAskDelete, onCancelDelete, onShowDistill, distillExpanded, distillBusy, distillError, distillData, distillAvailable }) => {
  const fileCount = (pack.contents && Array.isArray(pack.contents.files)) ? pack.contents.files.length : (pack.file_count || '—');
  return (
    <div style={{
      padding: '14px 18px',
      background: TOKEN.cream,
      border: '1px solid ' + TOKEN.rule,
      borderRadius: 2,
      marginBottom: 12,
    }}>
      <div style={{
        fontFamily: '"Noto Serif SC", serif',
        fontSize: 15, color: TOKEN.ink1, marginBottom: 4,
      }}>{pack.source_slug || pack.topic || pack.pack_id || '未命名 pack'}</div>
      <div style={{
        fontSize: 12, fontStyle: 'italic', fontFamily: 'EB Garamond, serif',
        color: TOKEN.tabac, marginBottom: 4,
      }}>
        导出于 {_fmtDate(pack.exported_at)} · {fileCount} 文件 · {_fmtBytes(pack.size_bytes)}
      </div>
      {pack.description && (
        <div style={{
          fontSize: 12, fontStyle: 'italic', fontFamily: 'EB Garamond, serif',
          color: TOKEN.ink2, marginBottom: 8,
        }}>描述: {pack.description}</div>
      )}
      <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
        <button onClick={onShowDetail} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
          fontSize: 13, color: TOKEN.brass,
          padding: 0, letterSpacing: '0.04em',
        }}>{expanded ? '收起详情' : '查看详情'}</button>

        <button onClick={onShowDistill} disabled={!distillAvailable} style={{
          background: 'none', border: 'none',
          cursor: distillAvailable ? 'pointer' : 'not-allowed',
          fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
          fontSize: 13,
          color: distillAvailable ? TOKEN.brass : TOKEN.ink3,
          padding: 0, letterSpacing: '0.04em',
        }} title={distillAvailable ? '' : 'commons.distill IPC 未注册'}>
          {distillExpanded ? '收起摘要' : '查看摘要 · distill'}
        </button>

        {!deleteConfirming ? (
          <button onClick={onAskDelete} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
            fontSize: 13, color: TOKEN.oxblood,
            padding: 0, letterSpacing: '0.04em',
          }}>删除</button>
        ) : (
          <span style={{
            fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
            fontSize: 13, color: TOKEN.oxblood,
          }}>
            确认删除?
            <button onClick={onDelete} style={{
              marginLeft: 10, background: 'none', border: 'none', cursor: 'pointer',
              fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
              fontSize: 13, color: TOKEN.oxblood, padding: 0,
            }}>是</button>
            <button onClick={onCancelDelete} style={{
              marginLeft: 8, background: 'none', border: 'none', cursor: 'pointer',
              fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
              fontSize: 13, color: TOKEN.ink3, padding: 0,
            }}>否</button>
          </span>
        )}
      </div>

      {expanded && <PackDetail pack={pack} />}
      {distillExpanded && (
        <DistillCard distill={distillData} busy={distillBusy} error={distillError} />
      )}
    </div>
  );
};

const CommonsScreen = ({ onBack, currentSlug }) => {
  const [packs, setPacks] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const [showExportForm, setShowExportForm] = useState(false);
  const [exporting, setExporting] = useState(false);

  const [importPreview, setImportPreview] = useState(null);   // { manifest, path }
  const [importing, setImporting] = useState(false);

  const [expandedId, setExpandedId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  // γ17 — Pack Distill state (per pack_id). distillById[id] = {busy, data, error}.
  const [distillExpandedId, setDistillExpandedId] = useState(null);
  const [distillById, setDistillById] = useState({});

  // v0.4.10 — delegate to unified <ToastRoot/>. Previous local impl was
  // top-right with close button + fixed 4200ms; canonical is bottom-center +
  // 4200ms (call-site preserved) + click-to-dismiss. Dropped affordances:
  // top-right anchor, dedicated × button. Mitigations: click-anywhere dismiss.
  const showToast = useCallback((kind, message) => {
    if (window.HyphaToast && typeof window.HyphaToast.showToast === 'function') {
      window.HyphaToast.showToast(kind, message, 4200);
    }
  }, []);

  const commonsBridge = () => (window.ptor && window.ptor.commons) || null;

  const reload = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const c = commonsBridge();
      if (c && typeof c.listPacks === 'function') {
        const res = await c.listPacks();
        if (res && res.ok) {
          setPacks(Array.isArray(res.packs) ? res.packs : []);
        } else {
          setError((res && res.error) || 'listPacks 未返回 ok');
        }
      } else if (window.ptor && typeof window.ptor.commonsListPacks === 'function') {
        // Legacy fallback — bundled-only listing (no exported user packs).
        const res = await window.ptor.commonsListPacks();
        if (res && res.ok) setPacks(Array.isArray(res.packs) ? res.packs : []);
        else setError((res && res.error) || '兼容路径 listPacks 失败');
      } else {
        setError('commons.listPacks IPC 未注册 — α13 后端待 wire');
      }
    } catch (e) {
      setError(String((e && e.message) || e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const onConfirmExport = async (opts) => {
    if (!currentSlug) { showToast('err', '尚未指定当前课程 (slug)'); return; }
    const c = commonsBridge();
    if (!c || typeof c.exportPack !== 'function') {
      showToast('err', 'commons.exportPack IPC 未注册 — α13 后端待 wire');
      return;
    }
    setExporting(true);
    try {
      const res = await c.exportPack(currentSlug, opts);
      if (res && res.ok) {
        const p = res.pack_path || `vault/.commons/packs/${res.pack_id || '???'}.hypha-pack`;
        showToast('ok', `已导出到 ${p}`);
        setShowExportForm(false);
        await reload();
      } else {
        showToast('err', (res && res.error) || 'exportPack 未返回 ok');
      }
    } catch (e) {
      showToast('err', String((e && e.message) || e));
    } finally {
      setExporting(false);
    }
  };

  const onClickImport = async () => {
    const c = commonsBridge();
    let pickedPath = null;
    try {
      if (window.ptor && typeof window.ptor.commonsPickPackFile === 'function') {
        const picked = await window.ptor.commonsPickPackFile();
        if (!picked || picked.cancelled) return;
        pickedPath = picked.filePath || null;
      } else if (window.ptor && typeof window.ptor.sourcePick === 'function') {
        // Fallback: 重用 source:pick 文件选择器 (用户须自行确认扩展名).
        const picked = await window.ptor.sourcePick();
        if (!picked || !picked.ok) return;
        pickedPath = picked.filePath || null;
      } else {
        showToast('err', '文件选择器 IPC 未注册');
        return;
      }
    } catch (e) {
      showToast('err', String((e && e.message) || e));
      return;
    }
    if (!pickedPath) return;
    if (!c || typeof c.inspectPack !== 'function') {
      showToast('err', 'commons.inspectPack IPC 未注册 — β13 后端待 wire');
      return;
    }
    try {
      const res = await c.inspectPack(pickedPath);
      if (res && res.ok) {
        setImportPreview({ manifest: res.manifest || res, path: pickedPath });
      } else {
        showToast('err', (res && res.error) || 'inspectPack 未返回 ok');
      }
    } catch (e) {
      showToast('err', String((e && e.message) || e));
    }
  };

  const onConfirmImport = async () => {
    if (!importPreview || !importPreview.path) return;
    const c = commonsBridge();
    if (!c || typeof c.importPack !== 'function') {
      showToast('err', 'commons.importPack IPC 未注册 — β13 后端待 wire');
      return;
    }
    setImporting(true);
    try {
      const res = await c.importPack(importPreview.path);
      if (res && res.ok) {
        const newSlug = res.new_slug || res.slug || '?';
        showToast('ok', `已 import 为 vault/${newSlug}`);
        setImportPreview(null);
        await reload();
      } else {
        showToast('err', (res && res.error) || 'importPack 未返回 ok');
      }
    } catch (e) {
      showToast('err', String((e && e.message) || e));
    } finally {
      setImporting(false);
    }
  };

  // γ17 — Pack Distill. Maps backend error codes to editorial Chinese msgs.
  // HASH_MISMATCH stays warning-only because pack-distiller surfaces it via
  // `warnings[]` rather than aborting — but if the IPC ever returns it as a
  // hard error, we still show a non-destructive message + ⚠.
  const _distillErrorMsg = (code) => {
    switch (code) {
      case 'PACK_NOT_FOUND': return 'pack 文件找不到';
      case 'INVALID_PACK':   return 'pack 格式不对, 可能损坏或不是 hypha-pack';
      case 'HASH_MISMATCH':  return 'hash 校验失败, pack 可能被改过 ⚠';
      case 'EXCEPTION':      return 'distill 出岔子, 看 console';
      default:               return code ? `distill 失败: ${code}` : 'distill 未返回 ok';
    }
  };

  const onShowDistill = async (packId, pack) => {
    // Toggle off if already open on the same row.
    if (distillExpandedId === packId) {
      setDistillExpandedId(null);
      return;
    }
    setDistillExpandedId(packId);

    // Defensive: if backend bridge missing, surface inline error + bail.
    const c = commonsBridge();
    if (!c || typeof c.distill !== 'function') {
      setDistillById((prev) => ({
        ...prev,
        [packId]: { busy: false, data: null, error: 'commons.distill IPC 未注册 — γ17 后端待 wire' },
      }));
      return;
    }

    // Cache hit — show existing data, skip refetch.
    if (distillById[packId] && distillById[packId].data) return;

    const packPath = pack && (pack.pack_path || pack.path || pack.filePath);
    if (!packPath) {
      setDistillById((prev) => ({
        ...prev,
        [packId]: { busy: false, data: null, error: 'pack 文件找不到' },
      }));
      return;
    }

    setDistillById((prev) => ({
      ...prev,
      [packId]: { busy: true, data: null, error: null },
    }));
    try {
      const res = await c.distill({ packPath });
      if (res && res.ok) {
        setDistillById((prev) => ({
          ...prev,
          [packId]: { busy: false, data: res.distill || null, error: null },
        }));
      } else {
        const msg = _distillErrorMsg(res && res.error);
        setDistillById((prev) => ({
          ...prev,
          [packId]: { busy: false, data: null, error: msg },
        }));
      }
    } catch (e) {
      setDistillById((prev) => ({
        ...prev,
        [packId]: { busy: false, data: null, error: _distillErrorMsg('EXCEPTION') + ' — ' + String((e && e.message) || e) },
      }));
    }
  };

  const distillAvailable = !!(commonsBridge() && typeof commonsBridge().distill === 'function');

  const onDelete = async (packId) => {
    const c = commonsBridge();
    if (!c || typeof c.deletePack !== 'function') {
      // intentional-placeholder: task §5 mandates an honest failure path —
      // user sees the missing-IPC error directly rather than a fake success.
      // commons.deletePack wiring is out of scope for γ13 (UI-only); a later
      // backend pass adds the IPC + lib call. UI surfaces the absence so the
      // gap is visible, not silently swallowed (Confession Layer P0).
      showToast('err', 'commons.deletePack IPC 未注册 — 后端待 wire (诚实暴露)');
      setConfirmDeleteId(null);
      return;
    }
    try {
      const res = await c.deletePack(packId);
      if (res && res.ok) {
        showToast('ok', `已删除 ${packId}`);
        setConfirmDeleteId(null);
        await reload();
      } else {
        showToast('err', (res && res.error) || 'deletePack 未返回 ok');
      }
    } catch (e) {
      showToast('err', String((e && e.message) || e));
    }
  };

  return (
    <div style={{
      maxWidth: 880, margin: '0 auto', padding: '36px 32px 60px',
      fontFamily: '"Noto Serif SC", "EB Garamond", serif',
      color: TOKEN.ink1, position: 'relative',
    }}>
      {/* v0.4.10 — InlineToast removed; unified <ToastRoot/> at App root. */}

      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontFamily: 'EB Garamond, serif', fontStyle: 'italic', fontSize: 28, color: TOKEN.ink1 }}>
          Commons
        </div>
        <button onClick={onBack} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: TOKEN.ink3, fontStyle: 'italic',
          fontFamily: 'EB Garamond, serif', fontSize: 16,
        }}>×</button>
      </div>

      <div style={{
        fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
        fontSize: 13, color: TOKEN.tabac, lineHeight: 1.7,
        marginBottom: 22, maxWidth: 640,
      }}>
        这里是你导出 / 已 import 的 packs. Pack 不是简单 zip — 含 manifest +
        内容 hash + provenance, 可被收件人验真.
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 4 }}>
        <BrassButton onClick={() => { setShowExportForm((v) => !v); setImportPreview(null); }} disabled={exporting}>
          {showExportForm ? '收起' : '导出当前课程为 Pack'}
        </BrassButton>
        <BrassButton onClick={onClickImport} disabled={importing}>
          导入 Pack 文件
        </BrassButton>
      </div>

      {showExportForm && (
        <ExportForm
          currentSlug={currentSlug}
          busy={exporting}
          onConfirm={onConfirmExport}
          onCancel={() => setShowExportForm(false)}
        />
      )}

      {importPreview && (
        <ImportPreview
          preview={importPreview}
          busy={importing}
          onConfirm={onConfirmImport}
          onCancel={() => setImportPreview(null)}
        />
      )}

      <Hairline heavy />

      <SectionLabel>我导出的 Packs ({packs.length})</SectionLabel>

      {busy && packs.length === 0 && (
        <div style={{
          fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
          fontSize: 13, color: TOKEN.ink3,
        }}>加载中…</div>
      )}

      {!busy && packs.length === 0 && !error && (
        <div style={{
          fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
          fontSize: 13, color: TOKEN.ink3,
        }}>尚未导出任何 pack. 用上方按钮导出一个当前课程, 它会出现在这里.</div>
      )}

      {packs.map((pack, idx) => {
        const id = pack.pack_id || pack.id || `idx-${idx}`;
        const distillEntry = distillById[id] || {};
        return (
          <PackRow
            key={id}
            pack={pack}
            expanded={expandedId === id}
            onShowDetail={() => setExpandedId(expandedId === id ? null : id)}
            deleteConfirming={confirmDeleteId === id}
            onAskDelete={() => setConfirmDeleteId(id)}
            onCancelDelete={() => setConfirmDeleteId(null)}
            onDelete={() => onDelete(id)}
            onShowDistill={() => onShowDistill(id, pack)}
            distillExpanded={distillExpandedId === id}
            distillBusy={!!distillEntry.busy}
            distillError={distillEntry.error || null}
            distillData={distillEntry.data || null}
            distillAvailable={distillAvailable}
          />
        );
      })}

      {error && (
        <div style={{
          marginTop: 18,
          padding: '10px 14px',
          background: TOKEN.paperWarm,
          border: '1px solid ' + TOKEN.oxblood,
          borderRadius: 2,
          fontFamily: 'EB Garamond, serif', fontStyle: 'italic',
          fontSize: 12, color: TOKEN.oxblood,
        }}>
          {error}
        </div>
      )}
    </div>
  );
};

window.CommonsScreen = CommonsScreen;
window.HYPHA_ROUTES = window.HYPHA_ROUTES || {};
window.HYPHA_ROUTES['commons'] = CommonsScreen;
