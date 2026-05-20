/* global React, Icon, Watercolor */
// HYPHA · Wave 6.1 Grounding Review screen (BLUEPRINT §4 Bibliography Grounding)
//
// Shows the user the Book Grounding Profile (per book) + Grounding Synthesis
// (multi-book) BEFORE the course skeleton lands. User can review, edit
// fit_to_goal, adjust role assignments. All changes write back to the cache
// (vault/<slug>/grounding/*.json) so the next skeleton regen consumes the
// edited version.
//
// Register: 千金 / EB Garamond / cream paper / brass hairlines / quiet.
// No marketing copy. No emoji. No 流量词.

const { useState, useEffect, useMemo } = React;

const ROLE_OPTIONS = [
  { id: 'primary',    label: '主地基' },
  { id: 'secondary',  label: '辅' },
  { id: 'supplement', label: '补' },
];

const GroundingReviewScreen = ({ slug, goalContract, bookIds, onBack, onContinue }) => {
  const [loading, setLoading] = useState(true);
  const [profiles, setProfiles] = useState([]);
  const [synthesis, setSynthesis] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [progressStage, setProgressStage] = useState('');

  // Initial load: read cached profiles + synthesis. If missing, fire
  // runForCourse to build them (UI streams progress events).
  useEffect(() => {
    let cancelled = false;
    let unsub = null;
    (async () => {
      const g = window.ptor && window.ptor.grounding;
      if (!g) {
        if (!cancelled) { setError('grounding bridge missing'); setLoading(false); }
        return;
      }
      // Subscribe to progress events so the user sees visible labor.
      try { unsub = g.onProgress(p => { if (p && p.stage) setProgressStage(p.stage); }); } catch (_) {}
      try {
        // Try cache first.
        const sRes = await g.getSynthesis(slug);
        const hasCache = sRes && sRes.synthesis && Array.isArray(sRes.synthesis.books_with_roles) && sRes.synthesis.books_with_roles.length > 0;
        if (hasCache && !cancelled) {
          setSynthesis(sRes.synthesis);
          // Fetch per-book profiles via getProfile (cached on disk).
          const profs = await Promise.all((bookIds || []).map(async (id) => {
            try { const r = await g.getProfile(id, slug); return (r && r.profile) || null; }
            catch (_) { return null; }
          }));
          if (!cancelled) setProfiles(profs.filter(Boolean));
          if (!cancelled) setLoading(false);
          return;
        }
        // No cache → run full pipeline. Streams grounding:progress.
        const built = await g.runForCourse(slug, goalContract || null, bookIds || [], false);
        if (cancelled) return;
        if (!built || built.ok === false) {
          setError((built && built.error) || 'grounding build failed');
        } else {
          setProfiles(Array.isArray(built.profiles) ? built.profiles : []);
          setSynthesis(built.synthesis || null);
        }
      } catch (err) {
        if (!cancelled) setError((err && err.message) || String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; if (typeof unsub === 'function') unsub(); };
  }, [slug, bookIds, goalContract]);

  const profileById = useMemo(() => {
    const m = {};
    for (const p of profiles) if (p && p.book_id) m[p.book_id] = p;
    return m;
  }, [profiles]);

  // Local-state edits — patched to profile.fit_to_goal + synthesis role.
  const updateProfileFit = (bookId, newFit) => {
    setProfiles(prev => prev.map(p => p.book_id === bookId ? { ...p, fit_to_goal: newFit } : p));
  };
  const updateRole = (bookId, newRole) => {
    setSynthesis(prev => prev ? {
      ...prev,
      books_with_roles: prev.books_with_roles.map(r => r.book_id === bookId ? { ...r, role: newRole } : r),
    } : prev);
  };

  const refresh = async () => {
    const g = window.ptor && window.ptor.grounding;
    if (!g) return;
    setBusy(true);
    setError(null);
    try {
      const built = await g.runForCourse(slug, goalContract || null, bookIds || [], true);
      if (built && built.ok !== false) {
        setProfiles(built.profiles || []);
        setSynthesis(built.synthesis || null);
      } else {
        setError((built && built.error) || 'refresh failed');
      }
    } catch (err) {
      setError((err && err.message) || String(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="col gap-12 fade-in" style={{ padding: '40px 60px', maxWidth: 900, margin: '0 auto' }}>
        <div className="eyebrow">Bibliography Grounding</div>
        <h1 className="serif" style={{ fontSize: 36, fontWeight: 400, margin: '4px 0 8px' }}>
          地基 <span className="italic">建造中</span>
        </h1>
        <div className="t-body" style={{ color: 'var(--ink-2)' }}>
          HYPHA 正在把每本参考书消化成结构化地基, 再让地基约束课程结构. 不是预读, 是地基.
        </div>
        {progressStage && (
          <div className="t-tiny mono" style={{ color: 'var(--ink-3)', marginTop: 8 }}>
            {progressStage}
          </div>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="col gap-12" style={{ padding: '40px 60px', maxWidth: 900, margin: '0 auto' }}>
        <div className="eyebrow">Bibliography Grounding</div>
        <div className="t-body" style={{ color: 'var(--terracotta)' }}>地基建造失败: {error}</div>
        <div className="row gap-12">
          <button className="btn btn-ghost" onClick={onBack}>返回</button>
          <button className="btn btn-primary" onClick={refresh} disabled={busy}>重试</button>
        </div>
      </div>
    );
  }

  const rolesList = (synthesis && Array.isArray(synthesis.books_with_roles)) ? synthesis.books_with_roles : [];

  return (
    <div className="col gap-24 fade-in" style={{ padding: '40px 60px 80px', maxWidth: 980, margin: '0 auto' }}>
      <div className="col gap-6">
        <div className="eyebrow">Bibliography Grounding · §4</div>
        <h1 className="serif" style={{ fontSize: 38, fontWeight: 400, margin: '4px 0 0' }}>
          地基 <span className="italic">复审</span>
        </h1>
        <div className="t-quote" style={{ marginTop: 4 }}>
          参考书不是课后阅读材料, 而是课程生成前的地基.
        </div>
      </div>

      {/* ===== Synthesis card — overall plan ===== */}
      {synthesis && (
        <div className="card-quiet" style={{ padding: '24px 28px' }}>
          <div className="col gap-12">
            <div className="row gap-16" style={{ alignItems: 'baseline' }}>
              <div className="eyebrow">Synthesis</div>
              <div className="t-tiny mono" style={{ color: 'var(--ink-3)' }}>
                v{synthesis.version} · {synthesis.books_with_roles.length} 本 · {(synthesis.conflicts || []).length} 处冲突
              </div>
            </div>
            <div className="serif" style={{ fontSize: 16, fontStyle: 'italic', color: 'var(--ink-2)', lineHeight: 1.6 }}>
              {synthesis.synthesis_notes || '(synthesis notes pending)'}
            </div>
            {/* Roles editable list */}
            <div className="col gap-8">
              <div className="t-small mono" style={{ color: 'var(--ink-2)', letterSpacing: '.06em' }}>每本书的责任</div>
              {rolesList.map(r => {
                const p = profileById[r.book_id];
                const title = (p && p.title) || r.book_id;
                return (
                  <div key={r.book_id} className="row gap-12" style={{
                    alignItems: 'center',
                    padding: '8px 0',
                    borderTop: '1px solid var(--rule-soft)',
                  }}>
                    <div className="col" style={{ flex: 1, minWidth: 0 }}>
                      <div className="serif" style={{ fontSize: 15 }}>{title}</div>
                      <div className="t-tiny" style={{ color: 'var(--ink-3)' }}>{r.responsibility}</div>
                    </div>
                    <select
                      value={r.role}
                      onChange={(e) => updateRole(r.book_id, e.target.value)}
                      style={{
                        padding: '4px 8px',
                        fontSize: 13,
                        fontFamily: 'EB Garamond, "Noto Serif SC", serif',
                        fontStyle: 'italic',
                        border: '1px solid var(--rule)',
                        borderRadius: 4,
                        background: 'rgba(255,255,255,.5)',
                        color: 'var(--ink)',
                      }}>
                      {ROLE_OPTIONS.map(opt => (
                        <option key={opt.id} value={opt.id}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
            {/* Conflicts */}
            {Array.isArray(synthesis.conflicts) && synthesis.conflicts.length > 0 && (
              <div className="col gap-6">
                <div className="t-small mono" style={{ color: 'var(--ink-2)', letterSpacing: '.06em' }}>分歧 · 课程取舍</div>
                {synthesis.conflicts.slice(0, 8).map((c, i) => (
                  <div key={i} className="col gap-2" style={{ padding: '6px 0', borderTop: '1px solid var(--rule-soft)' }}>
                    <div className="t-small" style={{ color: 'var(--ink)' }}>
                      {c.book_a} <span style={{ color: 'var(--ink-3)' }}>vs</span> {c.book_b} — {c.conflict_topic}
                    </div>
                    <div className="t-tiny" style={{ color: 'var(--ink-2)', fontStyle: 'italic' }}>
                      取舍: {c.resolution}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {/* Excluded content */}
            {Array.isArray(synthesis.excluded_content) && synthesis.excluded_content.length > 0 && (
              <div className="col gap-6">
                <div className="t-small mono" style={{ color: 'var(--ink-2)', letterSpacing: '.06em' }}>不进入本次课程</div>
                {synthesis.excluded_content.slice(0, 8).map((e, i) => (
                  <div key={i} className="t-tiny" style={{ color: 'var(--ink-3)', padding: '2px 0' }}>
                    {e.book_id}: {e.topic}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== Per-book profiles ===== */}
      <div className="col gap-16">
        <div className="eyebrow">Per-Book Grounding Profile · §4.1</div>
        {profiles.map(p => (
          <div key={p.book_id} className="card-quiet" style={{ padding: '20px 24px' }}>
            <div className="col gap-10">
              <div className="row gap-12" style={{ alignItems: 'baseline' }}>
                <div className="serif" style={{ fontSize: 20 }}>{p.title}</div>
                {p._cached && (
                  <div className="t-tiny mono" style={{ color: 'var(--ink-3)' }}>cached</div>
                )}
              </div>

              <div className="col gap-4">
                <div className="t-small mono" style={{ color: 'var(--ink-2)', letterSpacing: '.06em' }}>这本书能给当前目标什么</div>
                <textarea
                  value={p.fit_to_goal || ''}
                  onChange={(e) => updateProfileFit(p.book_id, e.target.value)}
                  rows={3}
                  style={{
                    padding: '8px 10px',
                    border: '1px solid var(--rule)',
                    borderRadius: 6,
                    background: 'rgba(255,255,255,.5)',
                    fontSize: 14,
                    fontFamily: 'EB Garamond, "Noto Serif SC", serif',
                    lineHeight: 1.5,
                    color: 'var(--ink)',
                    resize: 'vertical',
                  }}
                />
              </div>

              <div className="col gap-2">
                <div className="t-small mono" style={{ color: 'var(--ink-2)', letterSpacing: '.06em' }}>与目标的关系</div>
                <div className="t-small" style={{ color: 'var(--ink)', lineHeight: 1.5 }}>{p.goal_relevance}</div>
              </div>

              {Array.isArray(p.core_sparks) && p.core_sparks.length > 0 && (
                <div className="col gap-2">
                  <div className="t-small mono" style={{ color: 'var(--ink-2)', letterSpacing: '.06em' }}>可进入课程的核心 Sparks</div>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                    {p.core_sparks.map((s, i) => (
                      <li key={i} className="t-small" style={{ color: 'var(--ink)', lineHeight: 1.5 }}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}

              {Array.isArray(p.unfit_content) && p.unfit_content.length > 0 && (
                <div className="col gap-2">
                  <div className="t-small mono" style={{ color: 'var(--ink-2)', letterSpacing: '.06em' }}>不适合当前目标</div>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                    {p.unfit_content.map((s, i) => (
                      <li key={i} className="t-small" style={{ color: 'var(--ink-3)', fontStyle: 'italic', lineHeight: 1.5 }}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}

              {Array.isArray(p.risks_and_outdated) && p.risks_and_outdated.length > 0 && (
                <div className="col gap-2">
                  <div className="t-small mono" style={{ color: 'var(--ink-2)', letterSpacing: '.06em' }}>风险与过时</div>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                    {p.risks_and_outdated.map((s, i) => (
                      <li key={i} className="t-small" style={{ color: 'var(--terracotta)', lineHeight: 1.5 }}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}

              {Array.isArray(p.transferable_methodology) && p.transferable_methodology.length > 0 && (
                <div className="col gap-2">
                  <div className="t-small mono" style={{ color: 'var(--ink-2)', letterSpacing: '.06em' }}>可迁移方法论</div>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                    {p.transferable_methodology.map((s, i) => (
                      <li key={i} className="t-small" style={{ color: 'var(--ink)', lineHeight: 1.5 }}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}

              {Array.isArray(p.productizable_inspiration) && p.productizable_inspiration.length > 0 && (
                <div className="col gap-2">
                  <div className="t-small mono" style={{ color: 'var(--ink-2)', letterSpacing: '.06em' }}>可产品化启发</div>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                    {p.productizable_inspiration.map((s, i) => (
                      <li key={i} className="t-small" style={{ color: 'var(--ink)', fontStyle: 'italic', lineHeight: 1.5 }}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* ===== Actions ===== */}
      <div className="row gap-12" style={{ alignItems: 'center' }}>
        <button className="btn btn-ghost" onClick={onBack}>返回</button>
        <button className="btn btn-ghost" onClick={refresh} disabled={busy}>
          {busy ? '重建中…' : '重建地基 (--force)'}
        </button>
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary" onClick={() => onContinue && onContinue({ profiles, synthesis })}>
          继续生成课程 <Icon name="chevronRight" size={14} />
        </button>
      </div>
    </div>
  );
};

Object.assign(window, { GroundingReviewScreen });
