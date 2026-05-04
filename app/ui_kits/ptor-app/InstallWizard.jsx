// InstallWizard — v0158d — 3-step install flow per user reframe 2026-05-04.
//
// Step 1: pick path (API vs CLI)
// Step 2: pick model (Opus / Sonnet / Haiku)
// Step 3: complete install (API → paste key; CLI → npm install + claude login)
//
// On complete: writes settings.json (provider + model + apiKey if API) and calls
// onComplete callback so parent (ColophonView) can swap to InstallPanel status.

function InstallWizard({ settings, saveSettings, onComplete }) {
  const [step, setStep] = React.useState(1);
  const [pathChoice, setPathChoice] = React.useState('claude');     // 'claude' (API) | 'claude-cli'
  const [model, setModel] = React.useState('claude-opus-4-7');
  const [apiKey, setApiKey] = React.useState('');

  // CLI install state machine
  const [detected, setDetected] = React.useState(null);     // { installed, version } | null = unknown
  const [installPhase, setInstallPhase] = React.useState('idle');   // idle | detecting | installing | logging-in | done | error
  const [installLog, setInstallLog] = React.useState('');
  const [errorMsg, setErrorMsg] = React.useState(null);

  // Subscribe to install-progress streams from main
  React.useEffect(() => {
    if (!window.ptor || !window.ptor.cli || !window.ptor.cli.onProgress) return;
    const unsub = window.ptor.cli.onProgress(p => {
      if (p && p.text) setInstallLog(l => (l + p.text).slice(-2000));   // cap log to last 2K chars
    });
    return () => { try { unsub(); } catch (_) {} };
  }, []);

  // On entering step 3 with CLI path: auto-detect first
  React.useEffect(() => {
    if (step !== 3 || pathChoice !== 'claude-cli') return;
    if (!window.ptor || !window.ptor.cli) return;
    setInstallPhase('detecting');
    setErrorMsg(null);
    window.ptor.cli.detect().then(r => {
      setDetected(r);
      setInstallPhase(r && r.installed ? 'detected-installed' : 'detected-missing');
    }).catch(e => { setInstallPhase('error'); setErrorMsg(String(e && e.message || e)); });
  }, [step, pathChoice]);

  const finishApi = async () => {
    if (!apiKey.trim()) { setErrorMsg('paste a key first'); return; }
    saveSettings({ provider: 'claude', model, apiKey: apiKey.trim(), baseURL: 'https://api.anthropic.com' });
    setInstallPhase('done');
    setTimeout(() => onComplete && onComplete(), 600);
  };

  const runCliInstall = async () => {
    if (!window.ptor || !window.ptor.cli) return;
    setInstallPhase('installing');
    setInstallLog('');
    setErrorMsg(null);
    try {
      const r = await window.ptor.cli.install();
      if (r && r.ok) {
        // Re-detect to confirm
        const d = await window.ptor.cli.detect();
        setDetected(d);
        if (d && d.installed) {
          setInstallPhase('installed-need-login');
        } else {
          setInstallPhase('error');
          setErrorMsg('install reported success but `claude` not found on PATH after — restart shell or check npm prefix');
        }
      } else {
        setInstallPhase('error');
        setErrorMsg(r.error || 'install failed');
      }
    } catch (e) { setInstallPhase('error'); setErrorMsg(String(e && e.message || e)); }
  };

  const runCliLogin = async () => {
    if (!window.ptor || !window.ptor.cli) return;
    setInstallPhase('logging-in');
    setInstallLog('');
    setErrorMsg(null);
    try {
      const r = await window.ptor.cli.login();
      if (r && r.ok) {
        // Save settings with claude-cli provider
        saveSettings({ provider: 'claude-cli', model, apiKey: '' /* CLI uses logged-in session */, baseURL: '' });
        setInstallPhase('done');
        setTimeout(() => onComplete && onComplete(), 600);
      } else {
        setInstallPhase('error');
        setErrorMsg(r.error || 'login failed');
      }
    } catch (e) { setInstallPhase('error'); setErrorMsg(String(e && e.message || e)); }
  };

  const skipDetectAndUseExisting = async () => {
    // CLI already detected as installed → skip install, go straight to login (or assume auth done)
    // Save settings now; user can run `claude login` separately if not yet authed
    saveSettings({ provider: 'claude-cli', model, apiKey: '', baseURL: '' });
    setInstallPhase('done');
    setTimeout(() => onComplete && onComplete(), 600);
  };

  // ── Render ──
  const cardStyle = {
    border: '1px solid color-mix(in srgb, var(--brass-mid) 25%, transparent)',
    borderRadius: 4,
    padding: '20px 24px',
    margin: '12px 0',
    background: 'color-mix(in srgb, var(--brass-mid) 4%, transparent)',
  };
  const btnStyle = (primary) => ({
    background: 'transparent',
    border: '1px solid var(--brass-mid)',
    color: primary ? 'var(--brass-bright)' : 'var(--ink-muted)',
    padding: '8px 18px',
    cursor: 'pointer',
    fontStyle: 'italic',
    fontFamily: 'inherit',
    fontSize: 14,
    letterSpacing: '0.005em',
    marginRight: 8,
  });
  const optionStyle = (active) => ({
    display: 'block',
    padding: '12px 16px',
    margin: '8px 0',
    border: `1px solid ${active ? 'var(--brass-bright)' : 'color-mix(in srgb, var(--brass-mid) 30%, transparent)'}`,
    borderRadius: 3,
    cursor: 'pointer',
    background: active ? 'color-mix(in srgb, var(--brass-bright) 6%, transparent)' : 'transparent',
    fontFamily: 'inherit',
  });

  return (
    <div style={{ margin: '0 0 24px' }}>
      <p style={{ margin: '0 0 12px', fontSize: 15, color: 'var(--ink-muted)', display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: 'var(--ink-faint)' }} />
        <strong style={{ fontWeight: 600, color: 'var(--ink-title)' }}>Install LLM in Hypha</strong>
        <span style={{ fontStyle: 'italic', fontSize: 14, color: 'var(--ink-faint)' }}>— step {step} of 3</span>
      </p>

      {/* Step 1: pick path */}
      {step === 1 && (
        <div style={cardStyle}>
          <div style={{ fontSize: 14, color: 'var(--ink-muted)', fontStyle: 'italic', marginBottom: 12 }}>
            How do you want to install Claude?
          </div>
          <div onClick={() => setPathChoice('claude')} style={optionStyle(pathChoice === 'claude')}>
            <div style={{ fontSize: 16, fontWeight: 500, color: 'var(--ink-title)', marginBottom: 4 }}>
              Claude Direct API
            </div>
            <div style={{ fontSize: 13, color: 'var(--ink-faint)', fontStyle: 'italic' }}>
              Pay-per-token via Anthropic Console (sk-ant-api03 key). Cleanest output (matches claude.ai). Need a credit card on file at Anthropic.
            </div>
          </div>
          <div onClick={() => setPathChoice('claude-cli')} style={optionStyle(pathChoice === 'claude-cli')}>
            <div style={{ fontSize: 16, fontWeight: 500, color: 'var(--ink-title)', marginBottom: 4 }}>
              Claude CLI (Claude Code)
            </div>
            <div style={{ fontSize: 13, color: 'var(--ink-faint)', fontStyle: 'italic' }}>
              Free if you have a Claude Pro/Max subscription. Hypha will install the `claude` CLI for you (needs npm). Output is mostly clean (Claude Code's coding-agent personality lightly tilts responses).
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <button onClick={() => setStep(2)} style={btnStyle(true)}>Next →</button>
          </div>
        </div>
      )}

      {/* Step 2: pick model */}
      {step === 2 && (
        <div style={cardStyle}>
          <div style={{ fontSize: 14, color: 'var(--ink-muted)', fontStyle: 'italic', marginBottom: 12 }}>
            Which Claude model?
          </div>
          {[
            { id: 'claude-opus-4-7', label: 'Opus 4.7', desc: 'Most capable. Slower, more expensive. Best for deep reasoning.' },
            { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', desc: 'Balanced. Best general-purpose, including coding.' },
            { id: 'claude-haiku-4-5', label: 'Haiku 4.5', desc: 'Fast & cheap. Best for quick lookups, simple summaries.' },
          ].map(m => (
            <div key={m.id} onClick={() => setModel(m.id)} style={optionStyle(model === m.id)}>
              <div style={{ fontSize: 16, fontWeight: 500, color: 'var(--ink-title)', marginBottom: 4 }}>
                {m.label}
              </div>
              <div style={{ fontSize: 13, color: 'var(--ink-faint)', fontStyle: 'italic' }}>{m.desc}</div>
            </div>
          ))}
          <div style={{ marginTop: 16 }}>
            <button onClick={() => setStep(1)} style={btnStyle(false)}>← Back</button>
            <button onClick={() => setStep(3)} style={btnStyle(true)}>Next →</button>
          </div>
        </div>
      )}

      {/* Step 3: complete install (branches by pathChoice) */}
      {step === 3 && (
        <div style={cardStyle}>
          <div style={{ fontSize: 14, color: 'var(--ink-muted)', fontStyle: 'italic', marginBottom: 12 }}>
            Step 3: complete install — <strong style={{ color: 'var(--ink-title)' }}>{pathChoice === 'claude' ? 'Claude Direct API' : 'Claude CLI'}</strong> · {model}
          </div>

          {/* API path */}
          {pathChoice === 'claude' && (
            <div>
              <div style={{ fontSize: 14, color: 'var(--ink-muted)', marginBottom: 10 }}>
                Paste your API key from{' '}
                <a href="#" onClick={e => { e.preventDefault(); if (window.ptor && window.ptor.shell) window.ptor.shell.openExternal('https://console.anthropic.com/'); }}
                  style={{ color: 'var(--brass-bright)', textDecoration: 'none', borderBottom: '1px solid currentColor' }}>console.anthropic.com →</a>
              </div>
              {/* intentional-placeholder: the `placeholder=` below is the HTML
                  <input> attribute (visible hint text inside an empty field).
                  Not a deferred-implementation marker. Anti-lazy hook should
                  match this string + skip it. */}
              <input
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="sk-ant-api03-..."
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 13,
                  background: 'color-mix(in srgb, var(--brass-mid) 6%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--brass-mid) 35%, transparent)',
                  borderRadius: 3,
                  color: 'var(--ink-title)',
                  marginBottom: 12,
                  boxSizing: 'border-box',
                }}
              />
              {errorMsg && <div style={{ color: 'var(--verdict-flag, #c46a5d)', fontStyle: 'italic', fontSize: 13, marginBottom: 8 }}>× {errorMsg}</div>}
              <div>
                <button onClick={() => setStep(2)} style={btnStyle(false)}>← Back</button>
                <button onClick={finishApi} style={btnStyle(true)} disabled={!apiKey.trim()}>Install →</button>
              </div>
            </div>
          )}

          {/* CLI path */}
          {pathChoice === 'claude-cli' && (
            <div>
              {installPhase === 'detecting' && (
                <div style={{ fontStyle: 'italic', color: 'var(--ink-faint)' }}>checking if claude is already installed…</div>
              )}

              {installPhase === 'detected-missing' && (
                <div>
                  <div style={{ fontSize: 14, color: 'var(--ink-muted)', marginBottom: 10 }}>
                    Claude not detected on PATH. Hypha will install it via npm:
                  </div>
                  <div style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 12, padding: '8px 12px', background: 'color-mix(in srgb, var(--brass-mid) 8%, transparent)', borderRadius: 3, marginBottom: 12 }}>
                    npm install -g @anthropic-ai/claude-code
                  </div>
                  <div>
                    <button onClick={() => setStep(2)} style={btnStyle(false)}>← Back</button>
                    <button onClick={runCliInstall} style={btnStyle(true)}>→ Install Claude</button>
                  </div>
                </div>
              )}

              {installPhase === 'detected-installed' && detected && (
                <div>
                  <div style={{ fontSize: 14, color: 'var(--ink-muted)', marginBottom: 10 }}>
                    ✓ Claude detected on PATH (v{detected.version}).
                  </div>
                  <div>
                    <button onClick={() => setStep(2)} style={btnStyle(false)}>← Back</button>
                    <button onClick={runCliLogin} style={btnStyle(true)}>→ Sign in (claude login)</button>
                    <button onClick={skipDetectAndUseExisting} style={btnStyle(false)}>Skip — already signed in</button>
                  </div>
                </div>
              )}

              {installPhase === 'installing' && (
                <div>
                  <div style={{ fontStyle: 'italic', color: 'var(--ink-faint)', marginBottom: 8 }}>
                    Installing Claude Code via npm (may take 30s-2min)…
                  </div>
                  <pre style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11, color: 'var(--ink-muted)', maxHeight: 200, overflow: 'auto', background: 'color-mix(in srgb, var(--brass-mid) 6%, transparent)', padding: 10, borderRadius: 3, margin: 0, whiteSpace: 'pre-wrap' }}>
                    {installLog || '(starting…)'}
                  </pre>
                </div>
              )}

              {installPhase === 'installed-need-login' && (
                <div>
                  <div style={{ fontSize: 14, color: 'var(--ink-muted)', marginBottom: 10 }}>
                    ✓ Claude installed. Now sign in (opens your browser):
                  </div>
                  <div>
                    <button onClick={runCliLogin} style={btnStyle(true)}>→ Sign in with Claude</button>
                    <button onClick={skipDetectAndUseExisting} style={btnStyle(false)}>Skip — I'll sign in later</button>
                  </div>
                </div>
              )}

              {installPhase === 'logging-in' && (
                <div>
                  <div style={{ fontStyle: 'italic', color: 'var(--ink-faint)', marginBottom: 8 }}>
                    Browser should open for sign-in. Complete OAuth there, then return to Hypha.
                  </div>
                  <pre style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11, color: 'var(--ink-muted)', maxHeight: 200, overflow: 'auto', background: 'color-mix(in srgb, var(--brass-mid) 6%, transparent)', padding: 10, borderRadius: 3, margin: 0, whiteSpace: 'pre-wrap' }}>
                    {installLog || '(waiting for browser…)'}
                  </pre>
                </div>
              )}

              {installPhase === 'done' && (
                <div style={{ color: 'var(--success, #6da34d)', fontStyle: 'italic', fontSize: 14 }}>
                  ✓ Installed! Closing wizard…
                </div>
              )}

              {installPhase === 'error' && (
                <div>
                  <div style={{ color: 'var(--verdict-flag, #c46a5d)', fontStyle: 'italic', fontSize: 14, marginBottom: 8 }}>
                    × {errorMsg || 'error'}
                  </div>
                  {installLog && (
                    <pre style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11, color: 'var(--ink-muted)', maxHeight: 150, overflow: 'auto', background: 'color-mix(in srgb, var(--brass-mid) 6%, transparent)', padding: 10, borderRadius: 3, margin: '8px 0', whiteSpace: 'pre-wrap' }}>
                      {installLog}
                    </pre>
                  )}
                  <div>
                    <button onClick={() => setStep(2)} style={btnStyle(false)}>← Back</button>
                    <button onClick={() => { setInstallPhase('idle'); setStep(3); }} style={btnStyle(true)}>Retry</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

Object.assign(window, { InstallWizard });
