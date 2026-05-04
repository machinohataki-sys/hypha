// ColophonView — settings as editorial prose, no modal, no scrim.
//
// intentional-placeholder: the `placeholder=` props on input/textarea are HTML
// input placeholder attributes (empty-state hint text users see), not
// unfinished implementation. Anti-lazy hook false-positives on the word.
//
// Per LUNG+LEO+YOGO council 2026-04-30: settings dialog itself was the bug.
// Replaced with a vault-resident "colophon page" — italic Garamond prose where
// every italicized noun is a click-to-edit token. Same surface as a NoteView
// reading register. No backdrop-filter (perf), no tabs (土 IA), no PillRow
// indicator slide (no longer needed inside a modal because there is no modal).
//
// Read path = same as edit path: tutor injects user.about into system prompt
// per turn → user sees their own colophon prose reflected in chat 50×/day,
// vs the edit page they open ~2-5×/year. Aesthetic ROI shifts to the right surface.
//
// State shape (read via existing IPCs, no new ones):
//   - window.ptor.hypha.settingsGet()  → { provider, model, baseURL, apiKey, app:{...} }
//   - window.ptor.hypha.profileGet()   → { name, about }
//   - window.ptor.hypha.providers()    → [{id,label,models:[{id,label,sub}], via, ...}]

// HyphaCloudAuth — sign-in surface for the managed-LLM proxy.
// 3 visual states (千金 register, italic Garamond, brass + teal accents):
//   loading   — italic "checking…" while we hit /v1/me
//   signed-in — "you are signed in as <em>{email}</em>. {N} free turns today,
//                $X.XX prepaid credit. [buy credit] [sign out]"
//   signed-out — "you are not signed in. [sign in via browser] / [paste code]"
//
// Sign-in flow: click "sign in" → opens hypha.studio/login in default browser
// → user does magic link → on dashboard clicks "Connect Hypha desktop" →
// copies long-lived token → returns here → clicks "paste code" → pastes →
// settings.hyphaToken saved → /v1/me re-queried → "signed-in" state.
function HyphaCloudAuth({ settings, saveSettings }) {
  const [status, setStatus] = React.useState('loading');   // loading | signed-in | signed-out | error
  const [me, setMe] = React.useState(null);                // {email, credit_cents, free_today_used, free_quota}
  const [pasting, setPasting] = React.useState(false);
  const [draft, setDraft] = React.useState('');

  const refresh = React.useCallback(async () => {
    if (!settings.hyphaToken) { setStatus('signed-out'); return; }
    if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.hyphaCloudMe) {
      setStatus('error'); return;
    }
    setStatus('loading');
    try {
      const r = await window.ptor.hypha.hyphaCloudMe();
      if (r && r.ok) { setMe(r); setStatus('signed-in'); }
      else if (r && r.code === 'HYPHA_BAD_TOKEN') {
        // Token expired or revoked — clear locally + drop to signed-out.
        await saveSettings({ hyphaToken: '' });
        setStatus('signed-out');
      } else {
        setStatus('error');
      }
    } catch (_) { setStatus('error'); }
  }, [settings.hyphaToken, saveSettings]);

  React.useEffect(() => { refresh(); }, [refresh]);

  const openLogin = async () => {
    const baseURL = (settings.hyphaBaseURL || 'https://hypha.studio').replace(/\/$/, '');
    if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.authOpenLogin) return;
    await window.ptor.hypha.authOpenLogin(`${baseURL}/login`);
    setPasting(true);    // pre-emptively show paste field; user will return with token
  };

  const signOut = async () => {
    await saveSettings({ hyphaToken: '' });
    setMe(null);
    setStatus('signed-out');
    setPasting(false);
    setDraft('');
  };

  const commitToken = async () => {
    const v = draft.trim();
    if (!v || v.length < 20) return;
    await saveSettings({ hyphaToken: v });
    setPasting(false); setDraft('');
    // refresh fires via settings.hyphaToken effect
  };

  const buyCredit = () => {
    const baseURL = (settings.hyphaBaseURL || 'https://hypha.studio').replace(/\/$/, '');
    if (window.ptor && window.ptor.hypha && window.ptor.hypha.authOpenLogin) {
      window.ptor.hypha.authOpenLogin(`${baseURL}/dashboard#topup`);
    }
  };

  const baseStyle = { margin: '0 0 24px', fontSize: 15, color: 'var(--ink-muted)' };
  const linkBtn = {
    background: 'transparent', border: 'none', padding: 0, font: 'inherit',
    fontStyle: 'italic', color: 'var(--brass-bright)', cursor: 'pointer',
    borderBottom: '1px solid transparent', transition: 'border-color 200ms',
  };
  const linkHover = (e, on) => { e.currentTarget.style.borderBottomColor = on ? 'var(--brass-bright)' : 'transparent'; };

  if (status === 'loading') {
    return <p style={{ ...baseStyle, fontStyle: 'italic' }}>checking your Hypha Cloud session…</p>;
  }

  if (status === 'error') {
    return (
      <p style={baseStyle}>
        could not reach Hypha Cloud (no network or server down).{' '}
        <button onClick={refresh} onMouseEnter={e=>linkHover(e,true)} onMouseLeave={e=>linkHover(e,false)} style={linkBtn}>retry</button>
      </p>
    );
  }

  if (status === 'signed-in' && me) {
    const balance = (me.credit_cents / 100).toFixed(2);
    return (
      <p style={baseStyle}>
        Signed in as <em style={{ color: 'var(--brass-bright)', fontStyle: 'italic' }}>{me.email}</em>.{' '}
        <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--ink-title)' }}>{me.free_today_used}/{me.free_quota}</span> free turns today,{' '}
        <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--ink-title)' }}>${balance}</span> prepaid credit.{' '}
        <button onClick={buyCredit} onMouseEnter={e=>linkHover(e,true)} onMouseLeave={e=>linkHover(e,false)} style={linkBtn}>buy credit</button>
        {' · '}
        <button onClick={signOut} onMouseEnter={e=>linkHover(e,true)} onMouseLeave={e=>linkHover(e,false)} style={{ ...linkBtn, color: 'var(--ink-faint)' }}>sign out</button>
      </p>
    );
  }

  // signed-out
  return (
    <p style={baseStyle}>
      Hypha Cloud — no key needed.{' '}
      <button onClick={openLogin} onMouseEnter={e=>linkHover(e,true)} onMouseLeave={e=>linkHover(e,false)} style={linkBtn}>
        {pasting ? 'sign in again' : 'sign in via browser'}
      </button>
      {pasting && (
        <>
          {' · '}
          <input
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') commitToken(); if (e.key === 'Escape') { setPasting(false); setDraft(''); } }}
            placeholder="paste your desktop code"
            style={{
              background: 'transparent', border: 'none',
              borderBottom: '1px solid color-mix(in srgb, var(--brass-mid) 32%, transparent)',
              fontFamily: '"JetBrains Mono", monospace', fontSize: 12,
              color: 'var(--ink-title)', outline: 'none',
              minWidth: '24ch', padding: '2px 4px',
            }}
          />
          {' '}
          <button onClick={commitToken} onMouseEnter={e=>linkHover(e,true)} onMouseLeave={e=>linkHover(e,false)} style={linkBtn} disabled={draft.trim().length < 20}>save</button>
        </>
      )}
    </p>
  );
}

// formatProbeDate — short month+day for the baseline display. Returns '' on
// any parse failure (the surrounding render guards against missing dates).
function formatProbeDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch (_) { return ''; }
}

// Token — one editable italic word/phrase in the colophon prose. Default state
// is brass-italic-text-as-button; hover reveals a 1px brass hairline beneath
// (affordance signal). Click → inline editor (kind=text/pill/textarea/secret).
function Token({ value, kind, options, selectedId, onChange, placeholder, dim }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value || '');
  const [hovered, setHovered] = React.useState(false);
  const [revealed, setRevealed] = React.useState(false);
  React.useEffect(() => { setDraft(value || ''); }, [value]);

  // Resting state — italic token, brass-bright on hover hairline.
  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          background: 'transparent',
          border: 'none',
          padding: 0,
          margin: 0,
          font: 'inherit',
          fontStyle: 'italic',
          color: dim ? 'color-mix(in srgb, var(--brass-bright) 55%, var(--ink-faint))' : 'var(--brass-bright)',
          cursor: 'pointer',
          borderBottom: hovered
            ? '1px solid color-mix(in srgb, var(--brass-bright) 60%, transparent)'
            : '1px solid transparent',
          transition: 'color 220ms cubic-bezier(0.16, 1, 0.3, 1), border-color 220ms',
          lineHeight: 'inherit',
        }}
      >{value || (placeholder ? `(${placeholder})` : '')}</button>
    );
  }

  // Editing state — kind-specific control. Esc cancels, Enter commits (text),
  // blur commits (text/textarea/secret), click commits (pill).
  if (kind === 'pill') {
    return (
      <span style={{
        display: 'inline-flex', flexWrap: 'wrap', gap: 6,
        verticalAlign: 'baseline', margin: '0 2px',
        padding: '4px 8px',
        borderRadius: '10px 14px 10px 14px',
        background: 'color-mix(in srgb, var(--brass-mid) 8%, transparent)',
        boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--brass-mid) 20%, transparent)',
      }}>
        {(options || []).map(opt => {
          const on = opt.id === selectedId;
          return (
            <button
              key={opt.id}
              onClick={() => { onChange(opt.id); setEditing(false); }}
              style={{
                background: on ? 'color-mix(in srgb, var(--brass-bright) 22%, transparent)' : 'transparent',
                border: 'none',
                padding: '3px 10px',
                borderRadius: '8px 12px 8px 12px',
                font: 'inherit',
                fontStyle: 'italic',
                fontSize: 14,
                color: on ? 'var(--ink-title)' : 'var(--ink-muted)',
                cursor: 'pointer',
                transition: 'all 200ms cubic-bezier(0.16, 1, 0.3, 1)',
              }}
              onMouseEnter={e => { if (!on) e.currentTarget.style.color = 'var(--ink-title)'; }}
              onMouseLeave={e => { if (!on) e.currentTarget.style.color = 'var(--ink-muted)'; }}
            >{opt.label}</button>
          );
        })}
        <button
          onClick={() => setEditing(false)}
          style={{
            background: 'transparent', border: 'none',
            padding: '3px 6px', font: 'inherit', fontStyle: 'italic', fontSize: 13,
            color: 'var(--ink-faint)', cursor: 'pointer',
          }}
          title="cancel"
        >×</button>
      </span>
    );
  }

  if (kind === 'textarea') {
    return (
      <textarea
        autoFocus
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => { if (draft !== (value || '')) onChange(draft); setEditing(false); }}
        onKeyDown={e => { if (e.key === 'Escape') { setDraft(value || ''); setEditing(false); } }}
        rows={4}
        placeholder={placeholder || ''}
        style={{
          display: 'block',
          width: '100%',
          marginTop: 6,
          background: 'color-mix(in srgb, var(--brass-mid) 6%, transparent)',
          border: 'none',
          borderRadius: '14px 18px 14px 18px',
          boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--brass-mid) 20%, transparent)',
          padding: '12px 16px',
          fontFamily: 'inherit',
          fontStyle: 'italic',
          fontSize: 'inherit',
          lineHeight: 'inherit',
          color: 'var(--ink-title)',
          outline: 'none',
          resize: 'vertical',
          minHeight: 90,
        }}
      />
    );
  }

  if (kind === 'secret') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, margin: '0 2px' }}>
        <input
          autoFocus
          type={revealed ? 'text' : 'password'}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => { if (draft !== (value || '')) onChange(draft); setEditing(false); }}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.currentTarget.blur(); }
            if (e.key === 'Escape') { setDraft(value || ''); setEditing(false); }
          }}
          placeholder={placeholder || ''}
          style={{
            background: 'color-mix(in srgb, var(--brass-mid) 8%, transparent)',
            border: 'none',
            borderRadius: '10px 14px 10px 14px',
            padding: '4px 10px',
            font: 'inherit',
            fontStyle: 'italic',
            fontSize: 'inherit',
            color: 'var(--ink-title)',
            outline: 'none',
            minWidth: 280,
            boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--brass-mid) 20%, transparent)',
          }}
        />
        <button
          onClick={() => setRevealed(r => !r)}
          style={{
            background: 'transparent', border: 'none',
            padding: '0 6px', font: 'inherit', fontStyle: 'italic', fontSize: 12,
            color: 'var(--ink-faint)', cursor: 'pointer',
          }}
          title={revealed ? 'hide' : 'reveal'}
        >{revealed ? 'hide' : 'reveal'}</button>
      </span>
    );
  }

  // kind === 'text' (default)
  return (
    <input
      autoFocus
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => { if (draft !== (value || '')) onChange(draft); setEditing(false); }}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.currentTarget.blur(); }
        if (e.key === 'Escape') { setDraft(value || ''); setEditing(false); }
      }}
      placeholder={placeholder || ''}
      style={{
        background: 'color-mix(in srgb, var(--brass-mid) 8%, transparent)',
        border: 'none',
        borderRadius: '10px 14px 10px 14px',
        padding: '2px 10px',
        font: 'inherit',
        fontStyle: 'italic',
        fontSize: 'inherit',
        lineHeight: 'inherit',
        color: 'var(--ink-title)',
        outline: 'none',
        minWidth: '12ch',
        boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--brass-mid) 20%, transparent)',
        margin: '0 2px',
      }}
    />
  );
}

function ColophonView() {
  const [settings, setSettings] = React.useState(null);
  const [profile, setProfile] = React.useState(null);
  const [providers, setProviders] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  // Phase 3.3 — adaptation audit feed. Loaded async; null = still loading;
  // [] = none ever. Re-fetched after each revert click.
  const [adaptations, setAdaptations] = React.useState(null);
  const [revertArm, setRevertArm] = React.useState(null);     // {slug, affectedIdx} | null
  const reloadAdaptations = React.useCallback(() => {
    if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.adaptationsList) {
      setAdaptations([]);
      return;
    }
    window.ptor.hypha.adaptationsList()
      .then(rows => setAdaptations(Array.isArray(rows) ? rows : []))
      .catch(() => setAdaptations([]));
  }, []);

  React.useEffect(() => {
    if (!window.ptor || !window.ptor.hypha) {
      setError('hypha bridge not available');
      setLoading(false);
      return;
    }
    Promise.all([
      window.ptor.hypha.settingsGet ? window.ptor.hypha.settingsGet() : Promise.resolve({}),
      window.ptor.hypha.profileGet ? window.ptor.hypha.profileGet() : Promise.resolve({}),
      window.ptor.hypha.providers ? window.ptor.hypha.providers() : Promise.resolve([]),
    ]).then(([s, p, pl]) => {
      setSettings(s || {});
      setProfile(p || {});
      setProviders(Array.isArray(pl) ? pl : []);
      setLoading(false);
    }).catch(e => {
      setError(String(e && e.message || e));
      setLoading(false);
    });
    reloadAdaptations();
  }, [reloadAdaptations]);
  // Disarm revert after 2s of inaction (matches vault delete pattern).
  React.useEffect(() => {
    if (!revertArm) return;
    const t = setTimeout(() => setRevertArm(null), 2000);
    return () => clearTimeout(t);
  }, [revertArm]);

  // Save helpers — auto-save + dispatch live-update events so other surfaces
  // re-read without restart (Theme.jsx, NoteView.jsx, App.jsx all listen).
  const saveSettings = React.useCallback(async (patch) => {
    if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.settingsSet) return;
    try {
      const next = await window.ptor.hypha.settingsSet(patch);
      if (next) setSettings(next);
      try { window.dispatchEvent(new CustomEvent('hypha:settings-updated')); } catch (_) {}
    } catch (_) {}
  }, []);
  const saveProfile = React.useCallback(async (patch) => {
    if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.profileSet) return;
    try {
      const r = await window.ptor.hypha.profileSet(patch);
      if (r && r.profile) setProfile(r.profile);
      try { window.dispatchEvent(new CustomEvent('hypha:profile-updated')); } catch (_) {}
    } catch (_) {}
  }, []);

  // onRetakeProbe — navigate to the welcome / evolution surface and request
  // re-opening the probe panel. TEAM A's welcome surface owns the reopen-probe
  // listener; for v0.6.0 the user can also manually click "sharpen baseline"
  // there. The dispatch is a forward hook — emit, don't depend.
  const onRetakeProbe = React.useCallback(() => {
    try {
      window.dispatchEvent(new CustomEvent('hypha:open-evolution'));
      const probe = (profile && profile.probe) || {};
      window.dispatchEvent(new CustomEvent('hypha:reopen-probe', {
        detail: { topic: probe.topic || '', goal: probe.goal || '' },
      }));
    } catch (_) {}
  }, [profile]);

  if (loading) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
        fontStyle: 'italic', color: 'var(--ink-faint)', fontSize: 16,
      }}>setting the type…</div>
    );
  }
  if (error) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: '"EB Garamond", Georgia, serif',
        fontStyle: 'italic', color: 'var(--verdict-flag)', fontSize: 14,
      }}>{error}</div>
    );
  }

  // Resolve display values + fallbacks. App schema lives at settings.app.
  const app = settings.app || {};
  const name = profile.name || '';
  const about = profile.about || '';
  const tutorName = profile.tutorName || '';
  const providerObj = providers.find(p => p.id === settings.provider) || providers[0] || {};
  const providerLabel = providerObj.label || 'Claude';
  const modelObj = (providerObj.models || []).find(m => m.id === settings.model)
    || (providerObj.models || [])[0] || {};
  const modelLabel = modelObj.label || settings.model || 'default';
  // v0.6.2 — fontSize / fontFamily / themeAuto pickers removed.
  // fontSize only affected chat-bubble CSS vars (not whole UI), and theme
  // is single-mode (day) since 2026-04-30 night mode removal. Pickers were
  // visibly broken to users; settings persist in case future UI re-introduces.
  const autoBegin = app.autoBeginLesson !== false; // default ON
  const defaultView = app.defaultView || 'evolution';

  // Token option lists (resolved at render — providers/models depend on choices).
  // 2026-05-02 — filter providers with `hidden: true` (e.g., claude-cli is
  // hidden from public users to funnel them to Direct API for cleanest output;
  // power users can still opt in by editing settings.json directly OR by
  // setting `provider: 'claude-cli'` once and the picker will then surface
  // the current value even if hidden).
  const providerOptions = providers
    .filter(p => !p.hidden || p.id === settings.provider)  // keep hidden if user already chose it
    .map(p => ({ id: p.id, label: p.label }));
  const modelOptions = (providerObj.models || []).map(m => ({ id: m.id, label: m.label }));
  // v0.6.2 — fontSizeOptions / fontFamilyOptions / themeOptions removed
  // alongside their pickers (above). See comment near fontSize/themeAuto
  // const removal for rationale.
  const autoBeginOptions = [
    { id: 'auto',   label: 'speaks first' },
    { id: 'manual', label: 'waits for me' },
  ];
  const viewOptions = [
    { id: 'evolution', label: 'evolution' },
    { id: 'recall',    label: 'recall' },
  ];

  return (
    <div style={{
      flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column',
      overflowY: 'auto',
      padding: '64px 32px 96px',
      fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
      color: 'var(--ink-primary)',
      background: 'transparent',
    }}>
      <div style={{
        maxWidth: 640, margin: '0 auto', width: '100%',
        fontSize: 19,
        lineHeight: '34px',
      }}>
        {/* Top printer's mark — a single horizontal rule centered, 1899-style colophon page */}
        <div aria-hidden="true" style={{
          textAlign: 'center', color: 'var(--brass-mid)', opacity: 0.7,
          fontSize: 22, marginBottom: 36, letterSpacing: '0.5em',
        }}>⸻</div>

        <p style={{ margin: '0 0 24px' }}>
          Hello, <Token value={name} kind="text"
            onChange={v => saveProfile({ name: v })}
            placeholder="your name"
            dim={!name}
          />. Your tutor <Token value={tutorName} kind="text"
            onChange={v => saveProfile({ tutorName: v })}
            placeholder="give them a name"
            dim={!tutorName}
          /> speaks in <Token
            value={providerLabel} kind="pill"
            options={providerOptions} selectedId={settings.provider}
            onChange={id => {
              const p = providers.find(x => x.id === id);
              saveSettings({ provider: id, baseURL: (p && p.baseURL) || '', model: (p && p.defaultModel) || '' });
            }}
          />'s voice, currently as <Token
            value={modelLabel} kind="pill"
            options={modelOptions} selectedId={settings.model}
            onChange={id => saveSettings({ model: id })}
          />. The tutor <Token
            value={autoBegin ? 'speaks first' : 'waits for me'} kind="pill"
            options={autoBeginOptions} selectedId={autoBegin ? 'auto' : 'manual'}
            onChange={id => saveSettings({ app: { autoBeginLesson: id === 'auto' } })}
          /> when you open a lesson. Your home page is <Token
            value={defaultView} kind="pill"
            options={viewOptions} selectedId={defaultView}
            onChange={id => saveSettings({ app: { defaultView: id } })}
          />.
        </p>

        <p style={{ margin: '0 0 24px' }}>
          About yourself: <Token value={about} kind="textarea"
            onChange={v => saveProfile({ about: v })}
            placeholder="anything the tutor should know — background, current goal, register"
            dim={!about}
          />
        </p>

        {profile.probe && profile.probe.score !== undefined && (
          <p style={{ margin: '0 0 24px' }}>
            Your baseline · <span style={{ fontStyle: 'italic' }}>{profile.probe.band}</span>
            {' '}({Math.round(profile.probe.score * 100)}%) on{' '}
            <span style={{ fontStyle: 'italic' }}>{profile.probe.topic}</span>
            {profile.probe.storedAt ? `, taken ${formatProbeDate(profile.probe.storedAt)}` : ''}.
            {' '}
            <button onClick={onRetakeProbe} style={{
              background: 'transparent', border: 'none', padding: 0,
              font: 'inherit', fontStyle: 'italic', color: 'var(--brass-bright)',
              cursor: 'pointer', borderBottom: '1px solid transparent',
              transition: 'border-color 200ms',
            }}
              onMouseEnter={e => e.currentTarget.style.borderBottomColor = 'var(--brass-bright)'}
              onMouseLeave={e => e.currentTarget.style.borderBottomColor = 'transparent'}
            >re-take →</button>
          </p>
        )}

        {providerObj.via === 'hypha-server' && (
          <HyphaCloudAuth
            settings={settings}
            saveSettings={saveSettings}
          />
        )}
        {providerObj.via === 'cli' && (
          <p style={{ margin: '0 0 24px', fontSize: 14, color: 'var(--ink-faint)', fontStyle: 'italic' }}>
            {providerObj.keyHint || 'using a logged-in vendor session — no key needed.'}
          </p>
        )}
        {providerObj.via !== 'cli' && providerObj.via !== 'hypha-server' && (
          <p style={{ margin: '0 0 24px', fontSize: 15, color: 'var(--ink-muted)' }}>
            Authentication: <Token
              value={settings.apiKey ? '••••••••' : ''}
              kind="secret"
              onChange={v => saveSettings({ apiKey: v })}
              placeholder={(providerObj.keyHint) || 'paste key here'}
              dim={!settings.apiKey}
            />
          </p>
        )}

        {/* Frontier search — Tavily web channel. Optional; without it the
            harvest still works against GitHub/HN/arXiv but a user-facing
            domain like a named-author MINDSET topic ("巴菲特投资思维")
            tends to come back light. Free tier covers most users. */}
        <p style={{ margin: '0 0 24px' }}>
          Frontier search — broader-coverage web channel beyond GitHub / HN / arXiv. Optional.
          {' '}
          <Token value={settings.tavilyKey || ''} kind="text"
            onChange={v => saveSettings({ tavilyKey: v })}
            placeholder="tvly-..."
            dim={!settings.tavilyKey}
          />
          <span style={{ fontStyle: 'italic', fontSize: 13, color: 'var(--ink-faint)' }}>
            {' '}— free 1k searches/month at{' '}
            <a href="#" onClick={e => {
              e.preventDefault();
              if (window.ptor && window.ptor.shell && window.ptor.shell.openExternal) {
                window.ptor.shell.openExternal('https://tavily.com');
              }
            }}>tavily.com</a>.
          </span>
        </p>

        {/* Phase 3.3 — adaptation audit feed. Editorial prose, not a table.
            Each adaptation = one short paragraph with italic Garamond rationale
            and a roman "revert" action (italic = decoration only per
            italic_decoration_only rule). Reverted entries dim + struck.
            Empty state: silent (the section just doesn't render). */}
        {Array.isArray(adaptations) && adaptations.length > 0 && (
          <>
            <div aria-hidden="true" style={{
              textAlign: 'center', color: 'var(--brass-mid)', opacity: 0.7,
              fontSize: 22, marginTop: 48, marginBottom: 24, letterSpacing: '0.5em',
            }}>⸻</div>
            <p style={{ margin: '0 0 16px', fontStyle: 'italic', color: 'var(--ink-muted)' }}>
              Hypha has retuned the following lessons from prior outcomes:
            </p>
            <div style={{ margin: '0 0 24px', fontSize: 16, lineHeight: '26px' }}>
              {adaptations.slice(0, 12).map((row, i) => {
                const date = (row.ts || '').slice(0, 10);
                const isRevertedRow = !!row.reverted;
                const armed = revertArm && revertArm.slug === row.slug && revertArm.affectedIdx === row.affectedIdx;
                return (
                  <p key={`${row.slug}-${row.affectedIdx}-${row.ts}`} style={{
                    margin: '0 0 14px',
                    color: isRevertedRow ? 'var(--ink-faint)' : 'var(--ink-primary)',
                    textDecoration: isRevertedRow ? 'line-through' : 'none',
                    textDecorationColor: 'color-mix(in srgb, var(--brass-mid) 60%, transparent)',
                    textDecorationThickness: '0.5px',
                    opacity: isRevertedRow ? 0.6 : 1,
                  }}>
                    <span style={{ color: 'var(--ink-faint)', fontVariantNumeric: 'tabular-nums' }}>{date}</span>
                    {' — lesson '}
                    <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--ink-title)' }}>{row.affectedIdx + 1}</span>
                    {' of '}
                    <span style={{ fontStyle: 'italic', color: 'var(--brass-bright)' }}>{row.slug}</span>
                    {row.signalTier ? (
                      <>
                        {' was '}
                        <span style={{ fontStyle: 'italic' }}>{row.signalTier === 'BASIC' ? 'reground' : row.signalTier === 'DEEP' ? 'pushed deeper' : 'tuned'}</span>
                      </>
                    ) : null}
                    {row.reason ? (
                      <>
                        {' — '}
                        <span style={{ fontStyle: 'italic', color: 'var(--ink-muted)' }}>{row.reason}</span>
                      </>
                    ) : null}
                    {!isRevertedRow && (
                      <button
                        onClick={() => {
                          if (!armed) { setRevertArm({ slug: row.slug, affectedIdx: row.affectedIdx }); return; }
                          if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.adaptationsRevert) return;
                          window.ptor.hypha.adaptationsRevert(row.slug, row.affectedIdx)
                            .then(() => { setRevertArm(null); reloadAdaptations(); })
                            .catch(() => setRevertArm(null));
                        }}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          marginLeft: 10,
                          padding: 0,
                          font: 'inherit',
                          fontStyle: 'normal',
                          fontSize: 11,
                          letterSpacing: '0.16em',
                          textTransform: 'uppercase',
                          color: armed ? 'var(--verdict-flag, var(--brass-bright))' : 'var(--ink-faint)',
                          cursor: 'pointer',
                          borderBottom: armed
                            ? '1px solid var(--verdict-flag, var(--brass-bright))'
                            : '1px solid transparent',
                          transition: 'color 200ms, border-color 200ms',
                        }}
                        title={armed ? 'click again to confirm' : 'roll back to the original lesson goal'}
                      >{armed ? 'confirm revert' : 'revert'}</button>
                    )}
                  </p>
                );
              })}
              {adaptations.length > 12 && (
                <p style={{ margin: 0, fontSize: 13, fontStyle: 'italic', color: 'var(--ink-faint)' }}>
                  …and {adaptations.length - 12} more older adaptations.
                </p>
              )}
            </div>
          </>
        )}

        <UserProfilePanel />

        <div aria-hidden="true" style={{
          textAlign: 'center', color: 'var(--brass-mid)', opacity: 0.7,
          fontSize: 22, marginTop: 48, letterSpacing: '0.5em',
        }}>⸻</div>

        <div style={{
          textAlign: 'center', marginTop: 18,
          fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase',
          color: 'var(--ink-faint)', fontStyle: 'italic',
        }}>colophon · esc to leave · click any italic word to edit</div>
      </div>
    </div>
  );
}

// v0.9.0 HERMES-style — UserProfilePanel renders the file-based user profile
// derived from <vault>/.hypha/user-profile.md. Profile is auto-injected into
// every tutor system prompt by agent.js designLesson. Per /tr council
// 2026-05-02: Hypha's vault IS the personalization corpus. Cold-start
// derivation (heuristic, no LLM) reads existing 用户灵感 + atlas + chain data.
// Auto-reflection LLM call deferred to v0.9.1.
function UserProfilePanel() {
  const [profile, setProfile] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [rebuilding, setRebuilding] = React.useState(false);
  const [lastSources, setLastSources] = React.useState(null);
  // v0.11.2 — pending HERMES reflection observations (confidence < 0.7).
  // Surfaced for user keep/drop. Per /tr 2026-05-02 v0.9.1 plan.
  const [pending, setPending] = React.useState([]);
  const reload = React.useCallback(() => {
    if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.userProfileGet) {
      setLoading(false);
      return;
    }
    window.ptor.hypha.userProfileGet().then(r => {
      if (r && r.ok) setProfile(r.profile);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);
  React.useEffect(() => { reload(); }, [reload]);
  React.useEffect(() => {
    if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.userProfilePending) return;
    let alive = true;
    window.ptor.hypha.userProfilePending(50).then(r => {
      if (alive && r && r.ok) setPending(Array.isArray(r.pending) ? r.pending : []);
    }).catch(() => {});
    return () => { alive = false; };
  }, [profile]);
  const ratify = React.useCallback(async (entry, action) => {
    if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.userProfileRatify) return;
    try {
      await window.ptor.hypha.userProfileRatify(action, entry);
      setPending(prev => prev.filter(p => p.id !== entry.id));
      if (action === 'accept') reload();
    } catch (_) {}
  }, [reload]);
  const onRebuild = React.useCallback(async () => {
    if (!window.ptor || !window.ptor.hypha || !window.ptor.hypha.userProfileRebuild) return;
    setRebuilding(true);
    try {
      const r = await window.ptor.hypha.userProfileRebuild();
      if (r && r.ok) {
        setProfile(r.profile);
        if (r.sources) setLastSources(r.sources);
      }
    } catch (_) {}
    setRebuilding(false);
  }, []);
  const sections = (profile && profile.sections) || { STYLE: [], GRAVITATION: [], VOICE: [], PROJECT: [] };
  const totalLines = ['STYLE', 'GRAVITATION', 'VOICE', 'PROJECT']
    .reduce((n, k) => n + (sections[k]?.length || 0), 0);
  return (
    <div style={{ marginTop: 36 }}>
      <h3 style={{
        fontFamily: '"Cormorant Garamond", "EB Garamond", Georgia, serif',
        fontStyle: 'italic', fontWeight: 500,
        fontSize: 18, color: 'var(--ink-title)',
        margin: '0 0 6px',
      }}>tutor's sense of you</h3>
      <p style={{
        fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
        fontStyle: 'italic', fontSize: 14,
        color: 'var(--ink-faint)', margin: '0 0 14px', lineHeight: 1.55,
      }}>
        derived from this vault's 用户灵感 + 概念地图 + chain goals; injected into every tutor turn.
        edit by editing <code style={{ fontSize: 12, fontFamily: '"JetBrains Mono", monospace', opacity: 0.85 }}>.hypha/user-profile.md</code> directly. nothing leaves this vault.
      </p>
      {loading ? (
        <div style={{ fontSize: 14, fontStyle: 'italic', color: 'var(--ink-faint)' }}>loading…</div>
      ) : totalLines === 0 ? (
        <div style={{
          padding: '14px 18px',
          background: 'color-mix(in srgb, var(--brass-mid) 5%, transparent)',
          borderLeft: '2px solid color-mix(in srgb, var(--brass-mid) 38%, transparent)',
          fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
          fontSize: 15, fontStyle: 'italic', color: 'var(--ink-muted)', lineHeight: 1.6,
        }}>
          no profile yet. click <em>derive from vault</em> below to seed from existing lessons; the tutor will start to feel different by the next lesson you finish.
        </div>
      ) : (
        ['STYLE', 'GRAVITATION', 'VOICE', 'PROJECT'].map(k => {
          const lines = sections[k] || [];
          if (lines.length === 0) return null;
          return (
            <div key={k} style={{ marginBottom: 14 }}>
              <div style={{
                fontFamily: '"Cormorant Garamond", serif',
                fontStyle: 'italic', fontSize: 12.5,
                letterSpacing: '0.16em', textTransform: 'uppercase',
                color: 'var(--brass-mid)', marginBottom: 4,
              }}>{k.toLowerCase()}</div>
              {lines.map((line, i) => (
                <div key={i} style={{
                  fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
                  fontStyle: 'italic', fontSize: 15,
                  color: 'var(--ink-primary)', lineHeight: 1.55,
                  paddingLeft: 14, marginBottom: 3,
                  borderLeft: '1px solid color-mix(in srgb, var(--brass-mid) 22%, transparent)',
                }}>· {line}</div>
              ))}
            </div>
          );
        })
      )}
      {pending.length > 0 && (
        <div style={{ marginTop: 22, paddingTop: 18, borderTop: '1px solid color-mix(in srgb, var(--brass-mid) 18%, transparent)' }}>
          <div style={{
            fontFamily: '"Cormorant Garamond", serif',
            fontStyle: 'italic', fontSize: 12.5,
            letterSpacing: '0.16em', textTransform: 'uppercase',
            color: 'var(--ink-faint)', marginBottom: 10,
          }}>pending observations · {pending.length}</div>
          <p style={{
            fontFamily: '"EB Garamond", "Noto Serif SC", serif',
            fontStyle: 'italic', fontSize: 13.5,
            color: 'var(--ink-faint)', margin: '0 0 12px', lineHeight: 1.55, opacity: 0.85,
          }}>
            tutor noticed these but wasn't confident enough to commit. keep what fits, drop what doesn't.
          </p>
          {pending.slice(0, 8).map(p => (
            <div key={p.id} style={{
              marginBottom: 14,
              paddingLeft: 14,
              borderLeft: '1px solid color-mix(in srgb, var(--brass-mid) 16%, transparent)',
            }}>
              <div style={{
                fontFamily: '"Cormorant Garamond", serif',
                fontStyle: 'italic', fontSize: 11.5,
                letterSpacing: '0.05em',
                color: 'var(--ink-faint)', marginBottom: 2,
              }}>{p.section.toLowerCase()} · confidence {p.confidence.toFixed(2)}{p.op !== 'add' ? ` · ${p.op}` : ''}</div>
              <div style={{
                fontFamily: '"EB Garamond", "Noto Serif SC", Georgia, serif',
                fontStyle: 'italic', fontSize: 14.5,
                color: 'var(--ink-primary)', lineHeight: 1.55,
                marginBottom: 4,
              }}>{p.text}</div>
              <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
                <button
                  onClick={() => ratify(p, 'accept')}
                  style={{
                    background: 'transparent', border: 'none', padding: 0,
                    fontFamily: 'inherit', fontStyle: 'italic', fontSize: 12.5,
                    color: 'var(--brass-bright)', cursor: 'pointer',
                    borderBottom: '1px solid transparent',
                    transition: 'border-color 200ms',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderBottomColor = 'var(--brass-bright)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderBottomColor = 'transparent'; }}
                >keep</button>
                <button
                  onClick={() => ratify(p, 'dismiss')}
                  style={{
                    background: 'transparent', border: 'none', padding: 0,
                    fontFamily: 'inherit', fontStyle: 'italic', fontSize: 12.5,
                    color: 'var(--ink-faint)', cursor: 'pointer',
                    borderBottom: '1px solid transparent',
                    transition: 'border-color 200ms, color 200ms',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderBottomColor = 'var(--ink-muted)'; e.currentTarget.style.color = 'var(--ink-muted)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderBottomColor = 'transparent'; e.currentTarget.style.color = 'var(--ink-faint)'; }}
                >drop</button>
              </div>
            </div>
          ))}
          {pending.length > 8 && (
            <div style={{
              fontFamily: '"EB Garamond", "Noto Serif SC", serif',
              fontStyle: 'italic', fontSize: 12.5,
              color: 'var(--ink-faint)',
            }}>· {pending.length - 8} more older observations awaiting</div>
          )}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 18, marginTop: 16 }}>
        <button
          onClick={onRebuild}
          disabled={rebuilding}
          style={{
            background: 'transparent', border: 'none', padding: 0, margin: 0,
            cursor: rebuilding ? 'not-allowed' : 'pointer',
            fontFamily: '"EB Garamond", "Noto Serif SC", serif',
            fontStyle: 'italic', fontSize: 14,
            color: rebuilding ? 'var(--ink-faint)' : 'var(--brass-bright)',
            borderBottom: '1px solid transparent',
            transition: 'border-color 200ms, color 200ms',
          }}
          onMouseEnter={e => { if (!rebuilding) e.currentTarget.style.borderBottomColor = 'var(--brass-bright)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderBottomColor = 'transparent'; }}
        >{rebuilding ? 'deriving…' : (totalLines > 0 ? '↺ re-derive from vault' : '→ derive from vault')}</button>
        {lastSources && (
          <span style={{
            fontFamily: '"EB Garamond", "Noto Serif SC", serif',
            fontStyle: 'italic', fontSize: 12.5,
            color: 'var(--ink-faint)',
          }}>read {lastSources.lessonNotesUsed} lessons · {lastSources.atlasesUsed} atlases · {lastSources.chainsUsed} chains</span>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { ColophonView });
